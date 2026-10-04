import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore, defaultValues, maskValue } from '../support/synthetic-store.js';

const SMALL = { nTime: 12, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
const SMALL_CHUNK = 32 * 32 * 2;
/** Chunks of 128 KB decoded: big enough for the bandwidth estimator to take notice. */
const LARGE = { nTime: 12, nBand: 4, height: 128, width: 128, chunk: 128,  sharded: true };
const LARGE_CHUNK = 4 * 128 * 128 * 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunkReads = (readable, from = 0) => readable.log.slice(from).filter((c) => c.range && 'offset' in c.range);

// ---- compressed tier ----

test('a chunk demoted from the decoded tier is decoded again from its compressed bytes, with no request', async () => {
  const readable = buildSyntheticStore(SMALL);
  const store = await openStore('memory://tiers', { store: readable, workers: 0, maxCacheBytes: SMALL_CHUNK * 2, compressedBytes: SMALL_CHUNK * 50 });
  store.evictionScore = (entry) => entry.t;
  for (const t of [0, 1, 2, 3]) await store.getRaw(0, 0, 0, t);
  assert.ok(store.peekRaw(0, 0, 0, 0) && store.peekRaw(0, 0, 0, 3), 'the nearest chunks stay decoded');
  assert.equal(store.peekRaw(0, 0, 0, 1), undefined);
  assert.equal(store.peekRaw(0, 0, 0, 2), undefined);
  const info = store.cacheInfo();
  assert.equal(info.entries, 2);
  assert.equal(info.compressedEntries, 4, 'every fetched chunk is also held compressed');
  assert.equal(store.stats.cache.decodedBytes, info.bytes);
  assert.equal(store.stats.cache.compressedBytes, info.compressedBytes);
  assert.equal(store.stats.cache.evictions, 2);

  const before = readable.log.length;
  const hits = store.stats.cache.compressedHits;
  const cell = await store.getCell(0, 0, 0, 1);
  assert.equal(readable.log.length, before, 'no request: the compressed copy was decoded');
  assert.equal(store.stats.cache.compressedHits, hits + 1);
  assert.equal(cell.data[5], defaultValues('uint16')(1, 0, 0, 5, 0), 'and it decodes to the right values');
  assert.ok(store.peekRaw(0, 0, 0, 1), 'decoded again, so resident');
});

test('with the compressed tier off, a demoted chunk is fetched again', async () => {
  const readable = buildSyntheticStore(SMALL);
  const store = await openStore('memory://no-compressed', { store: readable, workers: 0, maxCacheBytes: SMALL_CHUNK * 2, compressedBytes: 0 });
  store.evictionScore = (entry) => entry.t;
  for (const t of [0, 1, 2, 3]) await store.getRaw(0, 0, 0, t);
  assert.equal(store.cacheInfo().compressedEntries, 0);
  assert.equal(store.peekRaw(0, 0, 0, 1), undefined);
  const before = chunkReads(readable).length;
  await store.getRaw(0, 0, 0, 1);
  assert.equal(chunkReads(readable).length, before + 1);
});

test('prefetch keeps far timesteps as compressed bytes only and reaches further along time than the decoded tier could', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 24 });
  const store = await openStore('memory://far', { store: readable, workers: 0, maxCacheBytes: SMALL_CHUNK * 4, compressedBytes: SMALL_CHUNK * 100, speculativeBytesInitial: 1e9 });
  store.evictionScore = (entry) => Math.abs(entry.t - 10);
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 10, playing: true, concurrency: 1 });
  assert.equal(result.planned, 24, 'the whole axis fits the compressed tier');
  assert.equal(result.fetched, 24);
  assert.ok(result.compressedOnly >= 18, `most chunks are far from t=10 and were not decoded (${result.compressedOnly})`);
  const info = store.cacheInfo();
  assert.ok(info.entries <= 4 + 1, `decoded tier holds only the nearest chunks (${info.entries})`);
  assert.equal(info.compressedEntries, 24);
  const before = chunkReads(readable).length;
  const far = await store.getRaw(0, 0, 0, 23);
  assert.ok(far instanceof Uint16Array);
  assert.equal(chunkReads(readable).length, before, 'served from the compressed tier');
  assert.equal(store.peekRaw(0, 0, 0, 10) instanceof Uint16Array, true, 'the timestep being viewed is decoded');
});

test('budgets can be read and changed at any time', async () => {
  const readable = buildSyntheticStore(SMALL);
  const store = await openStore('memory://budgets', { store: readable, workers: 0, maxCacheBytes: SMALL_CHUNK * 8, compressedBytes: SMALL_CHUNK * 8, speculativeBytesInitial: 1234 });
  assert.deepEqual(store.budgets(), { totalBytes: SMALL_CHUNK * 16, decodedBytes: SMALL_CHUNK * 8, compressedBytes: SMALL_CHUNK * 8, auxBytes: 64 * 1024 * 1024, speculativeBytesInitial: 1234 });
  assert.equal(store.maxCacheBytes, SMALL_CHUNK * 8);
  for (let t = 0; t < 8; t++) await store.getRaw(0, 0, 0, t);
  assert.equal(store.cacheInfo().entries, 8);
  store.setBudgets({ decodedBytes: SMALL_CHUNK * 3 });
  assert.equal(store.cacheInfo().entries, 3);
  assert.equal(store.cacheInfo().compressedEntries, 8, 'the other tier is untouched');
  store.setBudgets({ compressedBytes: SMALL_CHUNK * 2 });
  assert.ok(store.cacheInfo().compressedEntries <= 2);
  assert.deepEqual(store.budgets(), { totalBytes: SMALL_CHUNK * 16, decodedBytes: SMALL_CHUNK * 3, compressedBytes: SMALL_CHUNK * 2, auxBytes: 64 * 1024 * 1024, speculativeBytesInitial: 1234 });
  assert.equal(store.maxCacheBytes, SMALL_CHUNK * 3);
  assert.throws(() => store.setBudgets({ decodedBytes: -1 }), /decodedBytes must be a number of bytes >= 0/);
  assert.throws(() => store.setBudgets({ compressedBytes: NaN }), /compressedBytes/);
});

// ---- bandwidth and the speculative allowance ----

/** A readable whose transfers take bytes / rate of *simulated* time, on a clock the test owns. */
function simulatedLink(readable, rate) {
  const link = { now: 0, clock: () => link.now };
  const pass = (read) => async (...args) => {
    const bytes = await read(...args);
    if (bytes) link.now += (bytes.length / rate) * 1000;
    return bytes;
  };
  link.store = { get: pass((key, o) => readable.get(key, o)), getRange: pass((key, r, o) => readable.getRange(key, r, o)) };
  return link;
}

test('bandwidthEstimate is null at first, then follows the measured transfers', async () => {
  const readable = buildSyntheticStore(LARGE);
  const link = simulatedLink(readable, 2_000_000);
  const store = await openStore('memory://bw', { store: link.store, workers: 0, clock: link.clock });
  assert.equal(store.bandwidthEstimate(), null);
  for (let t = 0; t < 4; t++) await store.getRaw(0, 0, 0, t);
  const estimate = store.bandwidthEstimate();
  assert.ok(Math.abs(estimate - 2_000_000) / 2_000_000 < 0.1, `estimate ${estimate} B/s for a 2 MB/s link`);
});

test('speculative fetching starts with its initial allowance and waits for a bandwidth measurement after that', async () => {
  const readable = buildSyntheticStore(LARGE);
  const initial = LARGE_CHUNK * 0.7 * 2.5;
  // A frozen clock: transfers take no measured time, so no bandwidth estimate ever forms, however fast or slow the machine is.
  const store = await openStore('memory://allowance', { store: readable, workers: 0, speculativeBytesInitial: initial, clock: () => 0 });
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 1, signal: abort.signal });
  await sleep(80);
  abort.abort();
  const result = await done;
  assert.ok(result.fetched >= 2 && result.fetched <= 3, `2 or 3 chunks fit an allowance of 2.5 estimates (${result.fetched})`);
  assert.ok(store.stats.cache.speculativeBytes <= initial + LARGE_CHUNK, `speculative bytes ${store.stats.cache.speculativeBytes}`);
  assert.ok(result.planned > result.fetched, 'the rest of the window is waiting');
});

test('with no allowance and no measured bandwidth nothing speculative is fetched; demand reads are unaffected', async () => {
  const readable = buildSyntheticStore(LARGE);
  const store = await openStore('memory://none-allowed', { store: readable, workers: 0, speculativeBytesInitial: 0, clock: () => 0 });
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 2, signal: abort.signal });
  await sleep(60);
  assert.equal(chunkReads(readable).length, 0, 'no speculative chunk requested');
  assert.ok((await store.getRaw(0, 0, 0, 2)) instanceof Uint16Array, 'a demand read goes through');
  abort.abort();
  assert.equal((await done).fetched, 0);
});

/** Prefetch `cells` of a simulated link for `steps` steps of fake time (setTimeout faked, the store's clock is the link's), after `warmup` demand reads. */
async function prefetchOnFakeLink(t, { rate, steps, warmup, nTime = 200 }) {
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const readable = buildSyntheticStore({ ...LARGE, nTime });
  const link = simulatedLink(readable, rate);
  const store = await openStore('memory://fake-link', { store: link.store, workers: 0, clock: link.clock, speculativeBytesInitial: 0, maxCacheBytes: 1e9, compressedBytes: 1e9 });
  const opened = link.now;
  for (let read = 0; read < warmup; read++) await store.getRaw(0, 0, 0, read);
  const shareBefore = store.stats.cache.speculativeShare;
  store.resetStats();
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, playing: true, concurrency: 1, signal: abort.signal });
  await settle();
  for (let step = 0; step < steps; step++) {
    link.now += 100;
    t.mock.timers.tick(100);
    await settle();
  }
  abort.abort();
  const result = await done;
  return { store, bytes: store.stats.cache.speculativeBytes, elapsedS: (link.now - opened) / 1000, fetched: result.fetched, planned: result.planned, shareBefore, shareAfter: store.stats.cache.speculativeShare };
}

test('while the estimate is young the allowance grows with the measured bandwidth: half the link, spent at estimated size', async (t) => {
  // Nothing here waits on real time: setTimeout is faked and the link's clock advances only when the test says so.
  // 20 and 80 MB/s links move a 128 KB chunk in 6.5 and 1.6 ms, so the few dozen chunks fetched stay far below
  // the second of transfer time after which the estimate counts as established.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** The allowance is spent at the *estimated* compressed size of a chunk (0.7 of decoded until chunks have been seen, rising toward the observed ratio), so real bytes can exceed what was earned by at most 1 / 0.7. */
  const MIN_ESTIMATE_RATIO = 0.7;
  const runs = [];
  for (const rate of [20_000_000, 80_000_000]) {
    const run = await prefetchOnFakeLink(t, { rate, steps: 1, warmup: 2 });
    assert.equal(run.shareBefore, 0.5);
    assert.equal(run.shareAfter, 0.5, 'still young at the end');
    const earned = 0.5 * rate * run.elapsedS;
    assert.ok(run.bytes > 0, 'a measured link earns allowance even though it started with none');
    assert.ok(run.bytes <= earned / MIN_ESTIMATE_RATIO, `${rate / 1e6} MB/s link stays within what it earned: ${run.bytes} <= ${earned} / ${MIN_ESTIMATE_RATIO}`);
    assert.ok(run.fetched < run.planned - 2, `${rate / 1e6} MB/s link is throttled (${run.fetched} of ${run.planned})`);
    runs.push(run);
  }
  assert.ok(runs[1].bytes > 2 * runs[0].bytes, `the faster link prefetched more: ${runs[1].bytes} vs ${runs[0].bytes}`);
});

test('once the estimate is established and nothing is pending, speculation is not throttled below the link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A 400 KB/s link takes 0.33 s a chunk: after four demand reads (over a second of transfer) it is established.
  const run = await prefetchOnFakeLink(t, { rate: 400_000, steps: 1, warmup: 4, nTime: 60 });
  assert.equal(run.shareBefore, 1.0);
  assert.equal(run.fetched, run.planned - 4, 'the whole window within one step (the four chunks the warm-up reads already cached are skipped)');
  // The same link while young would have been held to half of it by the allowance:
  const young = await prefetchOnFakeLink(t, { rate: 400_000, steps: 1, warmup: 2, nTime: 60 });
  assert.equal(young.shareBefore, 0.5);
  assert.ok(young.fetched < run.fetched, `young: ${young.fetched} chunks, established: ${run.fetched}`);
});

test('the speculative share is 0.5 while the estimate is young or a demand read is pending, 1.0 when idle and established', async () => {
  const readable = buildSyntheticStore({ ...LARGE, nTime: 24 });
  const link = simulatedLink(readable, 500_000);
  let gate = null;
  const gated = {
    get: link.store.get,
    async getRange(key, range, options) {
      if (gate && range.offset !== undefined) await gate.promise;
      return link.store.getRange(key, range, options);
    },
  };
  const store = await openStore('memory://share', { store: gated, workers: 0, clock: link.clock, speculativeBytesInitial: 0, maxCacheBytes: 1e9, compressedBytes: 1e9 });
  const share = () => store.stats.cache.speculativeShare;
  assert.equal(share(), 0.5, 'nothing measured yet');
  await store.getRaw(0, 0, 0, 0);
  await store.getRaw(0, 0, 0, 1);
  assert.equal(share(), 0.5, 'two chunks at 0.5 MB/s are half a second of transfer: still young');
  for (const t of [2, 3, 4]) await store.getRaw(0, 0, 0, t);
  assert.ok(store.bandwidthEstimate() > 0);
  assert.equal(share(), 1.0, 'over a second of transfer and nothing pending: established');

  let release;
  gate = { promise: new Promise((resolve) => (release = resolve)) };
  const pending = store.getRaw(0, 0, 0, 5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(share(), 0.5, 'a demand read is waiting: back to the lower share');
  release();
  await pending;
  gate = null;
  assert.equal(share(), 1.0, 'and up again once it has been served');
});

// ---- demand is never starved; stale work is cancelled ----

test('speculative fetches leave the last request slots to demand', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40, delayMs: 30 });
  let inflight = 0;
  let peak = 0;
  const counting = {
    get: readable.get.bind(readable),
    async getRange(key, range, options) {
      inflight++;
      peak = Math.max(peak, inflight);
      try {
        return await readable.getRange(key, range, options);
      } finally {
        inflight--;
      }
    },
  };
  const store = await openStore('memory://reserve', { store: counting, workers: 0, maxRequests: 4, speculativeBytesInitial: 1e9 });
  const abort = new AbortController();
  const prefetching = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 8, signal: abort.signal });
  await sleep(100);
  assert.ok(peak <= 3, `background requests peaked at ${peak} of 4 slots`);
  abort.abort();
  await prefetching;
});

test('a demand read issued during prefetch starts at once', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40, delayMs: 40 });
  const store = await openStore('memory://demand-first', { store: readable, workers: 0, maxRequests: 4, speculativeBytesInitial: 1e9 });
  const abort = new AbortController();
  const prefetching = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 8, signal: abort.signal });
  await sleep(60);
  const before = readable.log.length;
  const demand = store.getRaw(0, 0, 0, 37);
  // One turn of the event loop (all microtasks, no timers): no slot or queue stands between a demand read and the store while only background requests are in flight.
  await new Promise((resolve) => setImmediate(resolve));
  const started = readable.log.slice(before).find((c) => c.range?.offset !== undefined || c.range?.suffixLength !== undefined);
  assert.ok(started, 'the demand request was sent at once although prefetch was running');
  await demand;
  abort.abort();
  await prefetching;
});

test('aborting a prefetch cancels its in-flight fetches that nobody else waits for', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40, delayMs: 60 });
  const store = await openStore('memory://stale', { store: readable, workers: 0, speculativeBytesInitial: 1e9 });
  await store.getRaw(0, 0, 0, 0);
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 3, signal: abort.signal });
  await sleep(20);
  const inFlight = chunkReads(readable).filter((c) => c.signal && !c.signal.aborted);
  assert.ok(inFlight.length >= 2, 'fetches are in flight');
  abort.abort();
  const result = await done;
  assert.ok(chunkReads(readable).slice(1).every((c) => c.signal.aborted), 'every speculative fetch of this job was cancelled');
  assert.equal(result.errors.length, 0, 'cancellation is not an error');
  assert.equal(store.cacheInfo().entries, 1, 'only the demand chunk is cached');
});

test('a speculative fetch that a demand read joined survives the abort of its prefetch', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40, delayMs: 50 });
  const store = await openStore('memory://joined', { store: readable, workers: 0, speculativeBytesInitial: 1e9 });
  await store.getRaw(0, 0, 0, 0);
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 1, signal: abort.signal });
  await sleep(20);
  assert.equal(store.peekRaw(0, 0, 0, 1), undefined, 'the prefetch is still fetching t=1');
  const joined = store.getRaw(0, 0, 0, 1);
  abort.abort();
  await done;
  const raw = await joined;
  assert.ok(raw instanceof Uint16Array, 'the demand caller still gets its chunk');
  assert.ok(store.peekRaw(0, 0, 0, 1));
  assert.equal(store.stats.network.deduped, 1);
});

test('seek: other speculative requests are cancelled and the target timestep is fetched first, outside the allowance', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40, delayMs: 40 });
  const store = await openStore('memory://seek', { store: readable, workers: 0, speculativeBytesInitial: 0 });
  const a = new AbortController();
  const aWork = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 4, signal: a.signal });
  // With no allowance nothing speculative starts; give it some so there is something in flight to cancel.
  store.setBudgets({ speculativeBytesInitial: 1e9 });
  await sleep(80);
  const inFlightBefore = chunkReads(readable).filter((c) => !c.signal.aborted);
  assert.ok(inFlightBefore.length >= 1, 'speculative fetches are in flight');
  const mark = readable.log.length;
  const b = store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, seek: true, concurrency: 4 });
  assert.ok(inFlightBefore.every((c) => c.signal.aborted), 'the stale speculative requests were cancelled at once');
  await sleep(1);
  a.abort();
  await aWork;
  const bFirst = chunkReads(readable, mark).slice(0, 2).map((c) => c.range.offset);
  assert.equal(bFirst.length, 1);
  store.setBudgets({ speculativeBytesInitial: 1e9 });
  await b;
  assert.ok(store.peekRaw(0, 0, 0, 30), 'the target timestep is resident');
  assert.ok(store.peekRaw(0, 0, 0, 30), 'without a second timestep dependency');
});

test('seek targets are fetched even when the allowance is empty', async () => {
  const readable = buildSyntheticStore({ ...SMALL, nTime: 40 });
  const store = await openStore('memory://seek-free', { store: readable, workers: 0, speculativeBytesInitial: 0 });
  const abort = new AbortController();
  const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, seek: true, concurrency: 2, signal: abort.signal });
  await sleep(40);
  abort.abort();
  const result = await done;
  assert.equal(result.fetched, 1, 'exactly the data chunk of t=30');
  assert.ok(store.peekRaw(0, 0, 0, 30));
  assert.equal(store.stats.cache.speculativeBytes, 0, 'nothing was charged to the allowance');
});

// ---- deduplication ----

test('concurrent requests for one chunk share a fetch and are counted as deduplicated', async () => {
  const readable = buildSyntheticStore({ ...SMALL, delayMs: 10 });
  const store = await openStore('memory://dedupe', { store: readable, workers: 0 });
  const [a, b, c] = await Promise.all([store.getRaw(0, 0, 0, 1), store.getRaw(0, 0, 0, 1), store.getRaw(0, 0, 0, 1)]);
  assert.ok(a === b && b === c);
  assert.equal(store.stats.cache.joins, 2);
  assert.equal(store.stats().network.deduped, 2, 'two requests were saved');
  store.resetStats();
  assert.equal(store.stats.network.deduped, 0);
});

test('two chunks of one cold shard share one index read, and the second is counted as deduplicated', async () => {
  const readable = buildSyntheticStore({ ...SMALL, delayMs: 10 });
  const store = await openStore('memory://index-dedupe', { store: readable, workers: 0 });
  await Promise.all([store.getRaw(0, 0, 0, 1), store.getRaw(0, 0, 0, 2)]);
  const indexReads = readable.log.filter((c) => c.range && 'suffixLength' in c.range);
  assert.equal(indexReads.length, 1);
  assert.equal(store.stats.network.deduped, 1);
});

// ---- coarse frame ----

const PYRAMID = { nTime: 8, nBand: 2, height: 96, width: 96, chunk: 32,  sharded: true, nLevels: 3 };

test('getCoarseFrame loads one true-value chunk per cell at demand priority', async () => {
  const readable = buildSyntheticStore(PYRAMID);
  const store = await openStore('memory://coarse', { store: readable, workers: 0 });
  const events = [];
  store.probe = (event) => events.push(event);
  assert.deepEqual([store.levels[2].gridRows, store.levels[2].gridCols], [1, 1]);
  const frame = await store.getCoarseFrame(1, [[0, 0], [0, 1], [1, 0], [1, 1]], 6);
  assert.equal(frame.lod, 1);
  assert.equal(frame.t, 6);
  assert.equal(frame.cells.length, 4);
  assert.equal(events.length, 4, 'one true-value chunk per cell');
  assert.ok(events.every((e) => e.background === false), 'all at demand priority');
  const values = defaultValues('uint16');
  for (const { row, col, data } of frame.cells) {
    assert.equal(data, store.peekRaw(1, row, col, 6));
    assert.equal(data[3], values(6, 0, row * 32, col * 32 + 3, 1), `cell ${row},${col} pixel`);
  }
});

test('getCoarseFrame returns true values at every timestep', async () => {
  const store = await openStore('memory://coarse-anchor', { store: buildSyntheticStore(PYRAMID), workers: 0 });
  const frame = await store.getCoarseFrame(2, [[0, 0]], 4);
  assert.equal(frame.cells[0].data, store.peekRaw(2, 0, 0, 4));
  const none = await openStore('memory://coarse-none', { store: buildSyntheticStore({ ...PYRAMID }), workers: 0 });
  const plain = await none.getCoarseFrame(2, [[0, 0]], 5);
  assert.equal(plain.cells[0].data, none.peekRaw(2, 0, 0, 5));
  assert.equal(plain.t, 5);
});

test('getCoarseFrame holds its chunks against eviction until it resolves, even with a tiny cache', async () => {
  const store = await openStore('memory://coarse-pinned', { store: buildSyntheticStore(PYRAMID), workers: 0, maxCacheBytes: 2 * 2 * 32 * 32 * 2, compressedBytes: 0 });
  const cells = [[0, 0], [0, 1], [1, 0]];
  const frame = await store.getCoarseFrame(1, cells, 6);
  for (const [row, col] of cells) {
    assert.ok(store.peekRaw(1, row, col, 6), `cell ${row},${col} resident although the budget holds 2 chunks`);
  }
  assert.equal(frame.cells.length, 3);
});

test('getCoarseFrame rejects when its signal aborts, and on bad cells', async () => {
  const readable = buildSyntheticStore({ ...PYRAMID, delayMs: 30 });
  const store = await openStore('memory://coarse-abort', { store: readable, workers: 0 });
  const abort = new AbortController();
  const pending = store.getCoarseFrame(0, [[0, 0], [1, 1]], 6, { signal: abort.signal });
  await sleep(5);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(store.getCoarseFrame(0, [[7, 7]], 0), /cell \(7, 7\) outside 3x3 grid at lod 0/);
  await assert.rejects(store.getCoarseFrame(9, [[0, 0]], 0), /lod 9 out of range/);
});

test('coarse-first open: the deepest level costs a handful of requests and arrives first', async () => {
  const readable = buildSyntheticStore({ ...PYRAMID, consolidated: true, shardBytes: true, specVersion: '0.3.0' });
  const store = await openStore('memory://coarse-first', { store: readable, workers: 0 });
  const before = readable.log.length;
  const frame = await store.getCoarseFrame(2, [[0, 0]], 5);
  assert.equal(frame.cells.length, 1);
  assert.equal(readable.log.length - before, 2, 'index + one true-value chunk');
});

test('the two tiers add up: decoded chunks plus chunks held only compressed', async () => {
  // Budgets for 4 decoded chunks and 14 compressed ones (estimated at 0.7 of decoded, so room for 20): a window of floor(0.9 x 24) = 21 chunks.
  const readable = buildSyntheticStore({ ...SMALL, nTime: 60 });
  const store = await openStore('memory://additive', { store: readable, workers: 0, maxCacheBytes: SMALL_CHUNK * 4, compressedBytes: SMALL_CHUNK * 14, speculativeBytesInitial: 1e9 });
  store.evictionScore = (entry) => Math.abs(entry.t - 30);
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  assert.equal(result.planned, 21);
  assert.equal(result.fetched, 18, 'until both tiers were full');
  assert.equal(result.budgetReached, true);
  assert.equal(result.compressedOnly, 14);
  const info = store.cacheInfo();
  assert.equal(info.entries, 4, 'the four nearest chunks are decoded');
  assert.equal(info.compressedEntries, 14, 'the copies of those four gave way to 14 chunks that exist nowhere else');
  const decodedTimes = [];
  for (let t = 0; t < 60; t++) if (store.peekRaw(0, 0, 0, t)) decodedTimes.push(t);
  assert.deepEqual(decodedTimes, [29, 30, 31, 32]);
  assert.equal(store.stats.cache.compressedEvictions, 4);
  const before = chunkReads(readable).length;
  for (const t of [29, 30, 31, 32]) await store.getRaw(0, 0, 0, t);
  assert.equal(chunkReads(readable).length, before, 'no refetch for the decoded ones');
});

// ---- joint budget ----

/** Run `body` with navigator.deviceMemory reporting `gb` (Node has no such property: browsers do). */
async function withDeviceMemory(gb, body) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { deviceMemory: gb, hardwareConcurrency: 4 }, configurable: true, writable: true });
  try {
    return await body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

test('one joint cap by default: 1.5 GiB from 8 GB of device memory, 768 MiB below, split reported in stats', async () => {
  const MIB = 1024 * 1024;
  const readable = buildSyntheticStore(SMALL);
  const big = await withDeviceMemory(8, () => openStore('memory://big', { store: readable, workers: 0 }));
  assert.deepEqual(big.budgets(), { totalBytes: 1536 * MIB, decodedBytes: 1536 * MIB, compressedBytes: 1536 * MIB, auxBytes: Math.round(153.6 * MIB), speculativeBytesInitial: 16 * MIB });
  assert.equal(big.maxCacheBytes, 1536 * MIB, 'the decoded tier may use all of it');
  const small = await withDeviceMemory(4, () => openStore('memory://small', { store: readable, workers: 0 }));
  assert.equal(small.budgets().totalBytes, 768 * MIB);
  const unknown = await openStore('memory://unknown', { store: readable, workers: 0 });
  assert.equal(unknown.budgets().totalBytes, 768 * MIB, 'no navigator.deviceMemory');

  for (let t = 0; t < 6; t++) await unknown.getRaw(0, 0, 0, t);
  const { cache } = unknown.stats();
  assert.equal(cache.budgetBytes, 768 * MIB);
  assert.equal(cache.usedBytes, cache.decodedBytes + cache.compressedBytes);
  assert.equal(cache.decodedBytes, 6 * SMALL_CHUNK);
  assert.ok(cache.compressedBytes > 0, 'compressed copies of what was fetched');
  assert.equal(unknown.estimatedBytes(), cache.usedBytes, 'no mask or coverage here: the estimate is the two tiers');
});

test('tier budgets are overrides: naming both makes their sum the cap, naming one raises the default cap to it', async () => {
  const MIB = 1024 * 1024;
  const readable = buildSyntheticStore(SMALL);
  const both = await openStore('memory://both', { store: readable, workers: 0, maxCacheBytes: 3000 * MIB, compressedBytes: 500 * MIB });
  assert.equal(both.budgets().totalBytes, 3500 * MIB);
  const one = await openStore('memory://one', { store: readable, workers: 0, decodedBytes: 2000 * MIB });
  assert.deepEqual([one.budgets().totalBytes, one.maxCacheBytes], [2000 * MIB, 2000 * MIB]);
  const below = await openStore('memory://below', { store: readable, workers: 0, decodedBytes: 100 * MIB });
  assert.deepEqual([below.budgets().totalBytes, below.maxCacheBytes], [768 * MIB, 100 * MIB], 'a ceiling under the default cap leaves the cap alone');
  const explicit = await openStore('memory://explicit', { store: readable, workers: 0, totalBytes: 50 * MIB, decodedBytes: 100 * MIB });
  assert.deepEqual([explicit.budgets().totalBytes, explicit.maxCacheBytes], [50 * MIB, 50 * MIB], 'the cap wins over a larger ceiling');
  explicit.setBudgets({ totalBytes: 10 * MIB });
  assert.equal(explicit.budgets().totalBytes, 10 * MIB);
  assert.throws(() => explicit.setBudgets({ totalBytes: -1 }), /totalBytes must be a number of bytes >= 0/);
});

test('joint cap: decoded plus compressed never exceeds it, and the compressed tier holds what the decoded tier leaves', async () => {
  // Synthetic chunks do not compress, so a compressed chunk costs as much as a decoded one: a cap of 10 chunks.
  const spec = { nTime: 24, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const cached = (store) => {
    const decoded = [];
    for (let t = 0; t < 24; t++) if (store.peekRaw(0, 0, 0, t)) decoded.push(t);
    return decoded;
  };
  const fetchAll = async (store) => {
    store.evictionScore = (entry) => Math.abs(entry.t - 11);
    let peak = 0;
    for (let t = 0; t < 24; t++) {
      await store.getRaw(0, 0, 0, t);
      peak = Math.max(peak, store.stats.cache.usedBytes);
      assert.equal(store.stats.cache.usedBytes, store.stats.cache.decodedBytes + store.stats.cache.compressedBytes);
    }
    return peak;
  };

  const readable = buildSyntheticStore(spec);
  const open = (options) => openStore('memory://joint', { store: readable, workers: 0, ...options });
  const alone = await open({ totalBytes: SMALL_CHUNK * 10 });
  assert.ok((await fetchAll(alone)) <= SMALL_CHUNK * 10, 'never over the cap');
  assert.equal(alone.cacheInfo().entries, 9, 'with no decoded ceiling the decoded tier takes the cap (the newest chunk also holds its copy)');
  assert.equal(alone.cacheInfo().compressedEntries, 1);

  const split = await open({ totalBytes: SMALL_CHUNK * 10, decodedBytes: SMALL_CHUNK * 4 });
  assert.ok((await fetchAll(split)) <= SMALL_CHUNK * 10);
  const info = split.cacheInfo();
  assert.equal(info.entries, 4, 'four decoded, at the ceiling');
  assert.equal(info.compressedEntries, 6, 'the compressed tier holds the other six chunks of the cap: 4 + 6 chunks cached in the memory of 10');
  assert.deepEqual(cached(split), [10, 11, 12, 23], 'the decoded ones are those nearest t=11, and the newest demand chunk');
  const reads = chunkReads(readable).length;
  // Fetched in ascending order, so what the cap kept besides the decoded four is 13..17 as compressed bytes.
  for (const t of [13, 14]) assert.equal(split.peekRaw(0, 0, 0, t), undefined, 'held compressed only');
  for (const t of [13, 14]) assert.ok((await split.getRaw(0, 0, 0, t)) instanceof Uint16Array);
  assert.equal(chunkReads(readable).length, reads, 'a compressed-only chunk decodes again without a request');
  assert.ok(split.stats.cache.usedBytes <= SMALL_CHUNK * 10);
});

// ---- idle horizon and expansion ----

const AXIS = { nTime: 60, nBand: 1, height: 64, width: 64, chunk: 32,  sharded: true };

/** A store on a clock the test owns (the speculative allowance and the idle timer both read it), with an allowance that never limits. */
async function openOnFakeClock(options = {}) {
  const readable = buildSyntheticStore(AXIS);
  const time = { now: 0 };
  const store = await openStore('memory://horizon', { store: readable, workers: 0, clock: () => time.now, speculativeBytesInitial: 1e12, ...options });
  return { store, readable, time };
}

/** Timesteps of cell (0, 0) with a decoded chunk. */
function decodedTimes(store) {
  const times = [];
  for (let t = 0; t < AXIS.nTime; t++) if (store.peekRaw(0, 0, 0, t)) times.push(t);
  return times;
}

/** The chunks a window of timesteps lo..hi needs: each timestep once. */
function windowChunks(store, lo, hi) {
  const chunks = new Set();
  for (let t = lo; t <= hi; t++) chunks.add(t);
  return [...chunks].sort((a, b) => a - b);
}

test('idle: the window stops at the horizon, 12 timesteps either side of t', async () => {
  const { store } = await openOnFakeClock({ idleBytes: 1e12 });
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  const expected = windowChunks(store, 18, 42);
  assert.equal(result.planned, expected.length);
  assert.equal(result.fetched, expected.length);
  assert.equal(result.budgetReached, false);
  assert.deepEqual(decodedTimes(store), expected, 'nothing beyond the horizon');
  assert.equal(expected[0], 18, 'the earliest timestep is exactly the horizon boundary');
  assert.equal(store.peekRaw(0, 0, 0, 59), undefined);
  assert.equal(store.peekRaw(0, 0, 0, 0), undefined);
});

test('the horizon is an option, and it is not centred past the ends of the axis', async () => {
  const { store } = await openOnFakeClock({ horizonSteps: 2, idleBytes: 1e12 });
  await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  assert.deepEqual(decodedTimes(store), windowChunks(store, 28, 32));
  const edge = await openOnFakeClock({ horizonSteps: 3, idleBytes: 1e12 });
  const result = await edge.store.prefetch({ lod: 0, cells: [[0, 0]], t: 58, concurrency: 1 });
  assert.deepEqual(decodedTimes(edge.store), windowChunks(edge.store, 55, 59));
  assert.equal(result.planned, windowChunks(edge.store, 55, 59).length);
});

test('idle: at most idleBytes of speculative traffic per view, then it stops and stays stopped', async () => {
  const { store, time } = await openOnFakeClock({ idleBytes: SMALL_CHUNK * 3.5 });
  const first = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  assert.equal(first.budgetReached, true);
  assert.ok(first.fetched >= 3 && first.fetched <= 4, `3.5 chunks of allowance start 3 or 4 chunks (${first.fetched})`);
  assert.ok(first.fetched < first.planned);
  assert.ok(store.peekRaw(0, 0, 0, 30), 'nearest first: the target timestep');
  assert.equal(store.peekRaw(0, 0, 0, 18), undefined);

  time.now += 60_000;
  const later = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  assert.equal(later.fetched, 0, 'a minute later, same view and timestep: nothing more');
  assert.equal(later.budgetReached, true);
  assert.equal(decodedTimes(store).length, first.fetched);

  const otherView = await store.prefetch({ lod: 0, cells: [[0, 0], [0, 1]], t: 30, concurrency: 1 });
  assert.ok(otherView.fetched >= 3, 'a different set of visible cells is a new view with a new allowance');
});

test('scrubbing is held to the horizon but not to the idle allowance; the viewer is idle again idleMs after the last move', async () => {
  const { store, time } = await openOnFakeClock({ idleBytes: SMALL_CHUNK * 3.5, idleMs: 3000 });
  await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  const idleChunks = decodedTimes(store).length;

  time.now += 500;
  const scrub = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 31, direction: 1, concurrency: 1 });
  assert.equal(scrub.budgetReached, false, 'a moved timestep is a scrub: no idle cap');
  const expected = windowChunks(store, 19, 43);
  assert.deepEqual(decodedTimes(store), expected, 'the whole horizon around the new t, no further');
  assert.ok(expected.length > idleChunks + 10);

  time.now += 2900;
  const stillScrubbing = await store.prefetch({ lod: 0, cells: [[0, 0], [0, 1]], t: 31, concurrency: 1 });
  assert.equal(stillScrubbing.budgetReached, false, '2.9 s after the last move is still within idleMs');

  time.now += 100;
  const idle = await store.prefetch({ lod: 0, cells: [[1, 0]], t: 31, concurrency: 1 });
  assert.equal(idle.budgetReached, true, '3 s of quiet: idle, with the idle allowance of a new view');
  assert.ok(idle.fetched >= 3 && idle.fetched < idle.planned);
});

test('playing or looping covers the whole axis whatever the idle allowance and horizon', async () => {
  for (const flag of [{ playing: true }, { loop: true }]) {
    const { store } = await openOnFakeClock({ idleBytes: SMALL_CHUNK, horizonSteps: 2 });
    const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1, ...flag });
    assert.equal(result.planned, AXIS.nTime, `${JSON.stringify(flag)}: all 60 timesteps`);
    assert.equal(result.fetched, AXIS.nTime);
    assert.equal(result.budgetReached, false);
    assert.equal(decodedTimes(store).length, AXIS.nTime);
  }
});

test('seek does not widen the window: it only cancels stale speculative requests and fetches the target first', async () => {
  const { store, readable } = await openOnFakeClock({ idleBytes: 1e12 });
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 40, seek: true, concurrency: 1 });
  assert.equal(result.planned, windowChunks(store, 28, 52).length);
  assert.deepEqual(decodedTimes(store), windowChunks(store, 28, 52));
  const firstReads = chunkReads(readable).slice(0, 2).map((c) => c.range.offset);
  assert.equal(firstReads.length, 2);
  assert.ok(store.peekRaw(0, 0, 0, 40));
});

test('after playback the viewer stays out of idle for idleMs, then a new allowance applies', async () => {
  const { store, time } = await openOnFakeClock({ idleBytes: SMALL_CHUNK * 3.5, idleMs: 3000 });
  await store.prefetch({ lod: 0, cells: [[0, 0]], t: 10, playing: true, concurrency: 1 });
  time.now += 1000;
  const justStopped = await store.prefetch({ lod: 0, cells: [[0, 0], [0, 1]], t: 10, concurrency: 1 });
  assert.equal(justStopped.budgetReached, false, 'one second after playback: no idle cap (the horizon of the new cell is fetched)');
  time.now += 3000;
  const idle = await store.prefetch({ lod: 0, cells: [[1, 1]], t: 10, concurrency: 1 });
  assert.equal(idle.budgetReached, true);
});

test('aborted idle fetches give their allowance back', async () => {
  const readable = buildSyntheticStore({ ...AXIS, delayMs: 30 });
  const store = await openStore('memory://refund', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, idleBytes: SMALL_CHUNK * 3.5 });
  const abort = new AbortController();
  const pending = store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 3, signal: abort.signal });
  await sleep(10);
  abort.abort();
  await pending;
  const retry = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, concurrency: 1 });
  assert.ok(retry.fetched >= 3, `the cancelled requests did not use up the allowance (${retry.fetched} fetched)`);
});

test('a window larger than the joint cap stops when the cap holds nothing worse, and never goes over it', async () => {
  const readable = buildSyntheticStore({ ...AXIS, nTime: 60 });
  const store = await openStore('memory://cap-stop', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, totalBytes: SMALL_CHUNK * 20 });
  store.evictionScore = (entry) => Math.abs(entry.t - 30);
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 30, playing: true, concurrency: 1 });
  assert.equal(result.budgetReached, true);
  assert.ok(result.fetched >= 18 && result.fetched < result.planned, `about the cap's worth of chunks, not the whole window (${result.fetched} of ${result.planned})`);
  assert.ok(store.stats.cache.usedBytes <= SMALL_CHUNK * 20);
  assert.ok(store.peekRaw(0, 0, 0, 30) && store.peekRaw(0, 0, 0, 29) && store.peekRaw(0, 0, 0, 31), 'the nearest chunks are the ones kept');
  assert.equal(store.peekRaw(0, 0, 0, 59), undefined);
});

// ---- cancelled entries ----

/** Collect unhandled promise rejections while `body` runs and the event loop settles. */
async function unhandledRejectionsDuring(body) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await body();
    for (let i = 0; i < 5; i++) await sleep(30);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return reasons;
}

test('cancelling an entry nobody waits for leaves no unhandled rejection', async () => {
  const readable = buildSyntheticStore({ ...AXIS, delayMs: 20 });
  const store = await openStore('memory://unhandled', { store: readable, workers: 0, speculativeBytesInitial: 1e12 });
  const reasons = await unhandledRejectionsDuring(async () => {
    // A caller whose signal is already aborted starts the fetch and gives it up at once: no waiter, no owner.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(store.getRaw(0, 0, 0, 3, { signal: aborted.signal }), { name: 'AbortError' });
    // A speculative fetch cancelled by a seek while in flight.
    const prefetch = store.prefetch({ lod: 0, cells: [[0, 0]], t: 20, concurrency: 4 });
    await sleep(5);
    store.prefetch({ lod: 0, cells: [[0, 0]], t: 40, seek: true, concurrency: 1, signal: AbortSignal.abort() });
    await prefetch;
    // A masked-style read with a signal that aborts while the fetch is queued.
    const late = new AbortController();
    const read = store.getRaw(0, 0, 0, 55, { signal: late.signal });
    late.abort();
    await assert.rejects(read, { name: 'AbortError' });
  });
  assert.deepEqual(reasons.map(String), [], 'no AbortError (or anything else) escaped');
});

// ---- masks ----

const MASKED = { nTime: 24, nBand: 1, height: 64, width: 64, chunk: 32,  sharded: true, specVersion: '0.3.0', mask: true };

test('the mask cache is a tenth of the joint cap, at least 64 MiB, and follows setBudgets', async () => {
  const MIB = 1024 * 1024;
  const readable = buildSyntheticStore(MASKED);
  const small = await openStore('memory://aux-small', { store: readable, workers: 0, totalBytes: 100 * MIB });
  assert.equal(small.budgets().auxBytes, 64 * MIB, 'a tenth would be 10 MiB: the minimum applies');
  const big = await openStore('memory://aux-big', { store: readable, workers: 0, totalBytes: 3000 * MIB });
  assert.equal(big.budgets().auxBytes, 300 * MIB);
  big.setBudgets({ totalBytes: 1000 * MIB });
  assert.equal(big.budgets().auxBytes, 100 * MIB);
  big.setBudgets({ totalBytes: 200 * MIB });
  assert.equal(big.budgets().auxBytes, 64 * MIB);
});

test('prefetch with masks fetches every chunk\'s mask alongside it, at speculative priority', async () => {
  const readable = buildSyntheticStore(MASKED);
  const store = await openStore('memory://masks', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, idleBytes: 1e12 });
  const events = [];
  store.probe = (event) => events.push(event);
  const seen = [];
  const result = await store.prefetch({
    lod: 0,
    cells: [[0, 0], [1, 1]],
    t: 12,
    masks: true,
    concurrency: 3,
    onChunk: (lod, row, col, t) => seen.push({ row, col, t, mask: store.peekMask(lod, row, col, t) }),
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.masks, result.fetched, 'one mask per chunk fetched');
  assert.ok(result.fetched > 20);
  assert.equal(events.filter((e) => e.key.startsWith('mask/')).length, result.masks);
  assert.ok(events.every((e) => e.background === true), 'masks never took a demand slot: prefetch workers did not wait for them');
  assert.equal(seen.length, result.fetched);
  for (const { row, col, t, mask } of seen) {
    assert.ok(mask instanceof Uint8Array, `mask of ${row}/${col}/${t} was in when onChunk fired`);
    assert.equal(mask[5 * 32 + 3], maskValue(t, row * 32 + 5, col * 32 + 3, 0));
  }
});

test('masks: true on a store without a mask changes nothing, and without it no mask is fetched', async () => {
  const plain = await openStore('memory://no-mask', { store: buildSyntheticStore({ ...MASKED, mask: false }), workers: 0, clock: () => 0, speculativeBytesInitial: 1e12 });
  const result = await plain.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks: true, concurrency: 2 });
  assert.equal(result.masks, 0);
  assert.ok(result.fetched > 5);

  const readable = buildSyntheticStore(MASKED);
  const without = await openStore('memory://masks-off', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12 });
  const off = await without.prefetch({ lod: 0, cells: [[0, 0]], t: 12, concurrency: 2 });
  assert.equal(off.masks, 0);
  assert.equal(without.peekMask(0, 0, 0, 12), undefined);
  assert.equal(chunkReads(readable).filter((c) => c.key.includes('/mask/')).length, 0, 'no mask chunk was read');
});

test('masks are charged to the speculative allowance, and a chunk that is already cached gets its missing mask', async () => {
  const readable = buildSyntheticStore(MASKED);
  const open = () => openStore('memory://mask-budget', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, idleBytes: 1e12 });
  const plain = await open();
  await plain.prefetch({ lod: 0, cells: [[0, 0]], t: 12, concurrency: 1 });
  const masked = await open();
  await masked.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks: true, concurrency: 1 });
  assert.ok(masked.stats.cache.speculativeBytes > plain.stats.cache.speculativeBytes, 'the mask bytes are counted as speculative traffic');

  const second = await plain.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks: true, concurrency: 1 });
  assert.equal(second.fetched, 0, 'every chunk was cached already');
  assert.equal(second.skipped, second.planned);
  assert.equal(second.masks, second.planned, 'but the masks were missing: fetched now');
  assert.ok(plain.peekMask(0, 0, 0, 12) instanceof Uint8Array);
  const again = await plain.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks: true, concurrency: 1 });
  assert.equal(again.masks, 0, 'and not fetched twice');
});

test('masks are paid for from the speculative allowance: the same allowance buys fewer chunks', async () => {
  const readable = buildSyntheticStore(MASKED);
  const initial = SMALL_CHUNK * 0.7 * 8.5;
  const fetchedWith = async (masks) => {
    // A frozen clock: no bandwidth is ever measured, so the initial allowance is all there is.
    const store = await openStore('memory://allowance-masks', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: initial, idleBytes: 1e12 });
    const abort = new AbortController();
    const done = store.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks, concurrency: 1, signal: abort.signal });
    await sleep(80);
    abort.abort();
    return (await done).fetched;
  };
  const plain = await fetchedWith(false);
  const masked = await fetchedWith(true);
  assert.ok(plain >= 6, `the allowance buys 6 to 8 chunks (${plain})`);
  assert.ok(masked < plain, `each mask took some of it: ${masked} chunks with masks, ${plain} without`);
});

test('masks count against the idle allowance too', async () => {
  const readable = buildSyntheticStore(MASKED);
  const budget = SMALL_CHUNK * 3.5;
  const plain = await openStore('memory://idle-plain', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, idleBytes: budget });
  const withoutMasks = await plain.prefetch({ lod: 0, cells: [[0, 0]], t: 12, concurrency: 1 });
  const masked = await openStore('memory://idle-masked', { store: readable, workers: 0, clock: () => 0, speculativeBytesInitial: 1e12, idleBytes: budget });
  const withMasks = await masked.prefetch({ lod: 0, cells: [[0, 0]], t: 12, masks: true, concurrency: 1 });
  assert.equal(withMasks.budgetReached, true);
  assert.ok(withMasks.fetched <= withoutMasks.fetched, 'masks used part of the same allowance');
  assert.ok(masked.stats.cache.speculativeBytes <= budget + SMALL_CHUNK * 2, `speculative bytes stay near the cap (${masked.stats.cache.speculativeBytes})`);
});
