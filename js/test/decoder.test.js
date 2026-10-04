import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openStore, chunkKey, defaultTotalBytes, samplePixelFrom, scrubCost, windowOrder } from '../chronozarr/decoder.js';
import { buildSyntheticStore, sourceValue } from '../support/synthetic-store.js';
import { startStaticServer } from '../support/static-server.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = ['synthetic_sharded', 'synthetic_unsharded', 'synthetic_gzip'];
const fixtureDir = (name) => path.join(REPO_ROOT, 'data/spike', name);
const haveFixtures = FIXTURES.every((name) => existsSync(fixtureDir(name)));
const skipFixtures = haveFixtures ? false : 'data/spike fixtures not present';

async function bandSums(store, lod, t) {
  const level = store.levels[lod];
  const sums = new Array(level.nBand).fill(0);
  for (let row = 0; row < level.gridRows; row++) {
    for (let col = 0; col < level.gridCols; col++) {
      const cell = await store.getCell(lod, row, col, t);
      for (let b = 0; b < cell.bands; b++) {
        for (let y = 0; y < cell.height; y++) {
          for (let x = 0; x < cell.width; x++) sums[b] += cell.data[(b * cell.chunkHeight + y) * cell.chunkWidth + x];
        }
      }
    }
  }
  return sums;
}

test('chunkKey identifies one true-value chunk', () => {
  assert.equal(chunkKey(1, 2, 3, 4), '1/2/3/4');
});

for (const name of FIXTURES) {
  test(`fixture ${name}: every level and timestep matches expected.json`, { skip: skipFixtures }, async (t) => {
    const server = await startStaticServer(REPO_ROOT);
    t.after(() => server.close());
    const expected = JSON.parse(readFileSync(path.join(fixtureDir(name), 'expected.json'), 'utf8'));
    const store = await openStore(`${server.url}/data/spike/${name}/`);
    assert.deepEqual(store.bands, ['B04', 'B08']);
    assert.equal(store.times.length, 3);
    assert.equal(store.levels.length, 2);

    for (const [lodKey, exp] of Object.entries(expected)) {
      const lod = Number(lodKey);
      for (let tt = 0; tt < exp.sum_per_t_b.length; tt++) {
        assert.deepEqual(await bandSums(store, lod, tt), exp.sum_per_t_b[tt], `${name} lod ${lod} t ${tt} band sums`);
      }
      const { t: st, b, y, x, value } = exp.sample;
      const row = Math.floor(y / 512);
      const col = Math.floor(x / 512);
      const cell = await store.getCell(lod, row, col, st);
      const ly = y - row * 512;
      const lx = x - col * 512;
      assert.equal(cell.data[(b * 512 + ly) * 512 + lx], value, `${name} lod ${lod} sample pixel`);
      assert.equal(store.samplePixel(lod, row, col, st, lx, ly)[b], value, `${name} lod ${lod} samplePixel`);
    }
  });
}

test('fixture sharded: one shard index read per cell, then one range request per timestep', { skip: skipFixtures }, async (t) => {
  const server = await startStaticServer(REPO_ROOT);
  t.after(() => server.close());
  const base = `${server.url}/data/spike/synthetic_sharded/`;
  const shardPath = '/data/spike/synthetic_sharded/0/data/c/0/0/0/0';
  const shardRequests = () => server.requests.filter((r) => r.path === shardPath);

  const store = await openStore(base);
  assert.equal(server.requests.length, 1, 'cold open is one request (consolidated metadata in root zarr.json)');
  assert.equal(store.stats.network.requests, 1);

  for (const tt of [0, 1, 2]) await store.getRaw(0, 0, 0, tt);
  const first = shardRequests();
  assert.deepEqual(
    first.map((r) => r.method),
    ['HEAD', 'GET', 'GET', 'GET', 'GET'],
    'index = HEAD + suffix range once, then exactly 3 chunk ranges',
  );
  for (const r of first.slice(2)) assert.match(r.range, /^bytes=\d+-\d+$/);

  for (const tt of [2, 1, 0]) await store.getRaw(0, 0, 0, tt);
  assert.equal(shardRequests().length, 5, 'cached chunks are never refetched');

  const stats = store.stats;
  assert.equal(stats.cache.hits, 3);
  assert.equal(stats.cache.misses, 3);
  assert.equal(stats.network.requests, 1 + 5);
});

test('fixture sharded: suffixRequests reads the index in one request', { skip: skipFixtures }, async (t) => {
  const server = await startStaticServer(REPO_ROOT);
  t.after(() => server.close());
  const store = await openStore(`${server.url}/data/spike/synthetic_sharded/`, { suffixRequests: true });
  await store.getRaw(0, 0, 0, 1);
  const shard = server.requests.filter((r) => r.path.endsWith('0/data/c/0/0/0/0'));
  assert.deepEqual(
    shard.map((r) => [r.method, r.range?.startsWith('bytes=-') ?? false]),
    [['GET', true], ['GET', false]],
  );
});

test('fixture unsharded: one plain GET per chunk, no HEAD, no range', { skip: skipFixtures }, async (t) => {
  const server = await startStaticServer(REPO_ROOT);
  t.after(() => server.close());
  const store = await openStore(`${server.url}/data/spike/synthetic_unsharded/`);
  for (const tt of [0, 1, 2]) await store.getRaw(0, 0, 0, tt);
  const chunkRequests = server.requests.filter((r) => r.path.includes('/0/data/c/'));
  assert.equal(chunkRequests.length, 3);
  assert.ok(chunkRequests.every((r) => r.method === 'GET' && r.range === null));
});

for (const indexLocation of ['end', 'start']) {
  test(`synthetic sharded store (index at ${indexLocation}): lossless true-value roundtrip`, async () => {
    const spec = { nTime: 7, nBand: 3, height: 70, width: 45, chunk: 32,  sharded: true, indexLocation };
    const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
    const level = store.levels[0];
    assert.equal(level.gridRows, 3);
    assert.equal(level.gridCols, 2);
    for (let tt = 0; tt < spec.nTime; tt++) {
      for (let row = 0; row < level.gridRows; row++) {
        for (let col = 0; col < level.gridCols; col++) {
          const cell = await store.getCell(0, row, col, tt);
          const { width, height } = store.cellExtent(0, row, col);
          assert.equal(cell.width, width);
          assert.equal(cell.height, height);
          for (let b = 0; b < spec.nBand; b++) {
            for (let y = 0; y < height; y += 5) {
              for (let x = 0; x < width; x += 3) {
                const want = sourceValue(tt, b, row * 32 + y, col * 32 + x);
                assert.equal(cell.data[(b * 32 + y) * 32 + x], want, `t${tt} r${row} c${col} b${b} y${y} x${x}`);
                assert.equal(store.samplePixel(0, row, col, tt, x, y)[b], want);
              }
            }
          }
        }
      }
    }
  });
}

test('start-indexed shard: index read is a prefix range, not a suffix range', async () => {
  const readable = buildSyntheticStore({ nTime: 4, nBand: 1, height: 20, width: 20, chunk: 32,  sharded: true, indexLocation: 'start' });
  const store = await openStore('memory://synthetic', { store: readable });
  await store.getRaw(0, 0, 0, 1);
  const shardCalls = readable.log.filter((c) => c.key === '/0/data/c/0/0/0/0');
  assert.deepEqual(shardCalls[0].range, { offset: 0, length: 16 * 4 + 4 });
  assert.equal(shardCalls.length, 2, 'index prefix read, then the one requested chunk');
});

test('unsharded synthetic store decodes', async () => {
  const spec = { nTime: 4, nBand: 2, height: 40, width: 33, chunk: 32,  sharded: false };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  const cell = await store.getCell(0, 1, 1, 3);
  assert.equal(cell.data[(1 * 32 + 2) * 32 + 0], sourceValue(3, 1, 34, 32));
});

test('getCell returns the cached true-value array at every timestep', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  const firstCell = await store.getCell(0, 0, 0, 2);
  assert.equal(firstCell.data, store.peekRaw(0, 0, 0, 2));
  const nextCell = await store.getCell(0, 0, 0, 3);
  assert.equal(nextCell.data, store.peekRaw(0, 0, 0, 3));
});

test('samplePixel returns null until the requested data chunk is cached', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  assert.equal(store.samplePixel(0, 0, 0, 3, 1, 1), null);
  await store.getRaw(0, 0, 0, 2);
  assert.equal(store.samplePixel(0, 0, 0, 3, 1, 1), null, 'another timestep does not satisfy the requested chunk');
  await store.getRaw(0, 0, 0, 3);
  assert.equal(store.samplePixel(0, 0, 0, 3, 1, 1)[0], sourceValue(3, 0, 1, 1));
});

test('concurrent requests for one chunk share one fetch', async () => {
  const readable = buildSyntheticStore({ nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: false });
  const store = await openStore('memory://synthetic', { store: readable });
  const before = readable.log.length;
  const [a, b] = await Promise.all([store.getRaw(0, 0, 0, 1), store.getRaw(0, 0, 0, 1)]);
  assert.equal(a, b);
  assert.equal(readable.log.length - before, 1);
});

test('prefetch: nearest timesteps first, scrub direction reaches further, each timestep fetched once', async () => {
  const spec = { nTime: 12, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const run = async (direction) => {
    const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
    const order = [];
    const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 5, direction, concurrency: 1, onChunk: (lod, row, col, t) => order.push(t) });
    assert.equal(result.errors.length, 0);
    assert.equal(result.planned, 12);
    return order;
  };
  assert.deepEqual(await run(1), [5, 6, 4, 7, 8, 3, 9, 10, 2, 11, 1, 0], 't=5 first, then the nearest neighbours in scrub-cost order');
  assert.deepEqual(await run(-1), [5, 4, 6, 3, 2, 7, 1, 0, 8, 9, 10, 11], 'backward neighbours come first when scrubbing backward');
});

test('scrubCost: behind costs more, and with circular time the first timesteps are just ahead of the last', () => {
  assert.equal(scrubCost(3, 1), 3);
  assert.equal(scrubCost(-3, 1), 6);
  assert.equal(scrubCost(-3, 1, 8), 24);
  assert.equal(scrubCost(-3, -1), 3, 'scrubbing backward, lower timesteps are ahead');
  assert.equal(scrubCost(1 - 9, 1, 8, 10), 2, 'from t=9 of 10, t=1 is two steps ahead once time wraps');
  assert.equal(scrubCost(0 - 9, 1, 8, 10), 1);
  assert.equal(scrubCost(8 - 9, 1, 8, 10), 8, 'the step just behind stays expensive');
  assert.equal(scrubCost(0, 1, 8, 10), 0);
});

test('windowOrder with loop puts the start of the movie right after its end', () => {
  assert.deepEqual(windowOrder(10, 8, { direction: 1, behindFactor: 8, loop: true }).slice(0, 6), [8, 9, 0, 1, 2, 3]);
  assert.deepEqual(windowOrder(10, 8, { direction: 1, behindFactor: 8 }).slice(0, 4), [8, 9, 7, 6], 'without loop the wrap is not ahead');
});

test('the prefetch window plan covers the wrap: from the last timestep it fetches t=0, 1, 2 before anything behind', async () => {
  const spec = { nTime: 12, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 32 * 32 * 2;
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 8, compressedBytes: 0 });
  const order = [];
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 11, direction: 1, behindFactor: 8, loop: true, concurrency: 1, onChunk: (l, r, c, t) => order.push(t) });
  assert.equal(result.planned, 7, 'floor(0.9 x 8 chunks)');
  assert.deepEqual(order, [11, 0, 1, 2, 3, 4, 5], "t=11, then the start of the movie in order");
  assert.equal(store.peekRaw(0, 0, 0, 10), undefined, 'the step just behind is not worth keeping');
});

test('a large behindFactor makes the prefetch window run almost entirely ahead (movie playback)', async () => {
  const spec = { nTime: 40, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 32 * 32 * 2;
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 14, compressedBytes: 0 });
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 20, direction: 1, behindFactor: 50, concurrency: 1 });
  assert.equal(result.planned, 12, 'floor(0.9 x 14 chunks)');
  const cached = [];
  for (let t = 0; t < 40; t++) if (store.peekRaw(0, 0, 0, t)) cached.push(t);
  assert.deepEqual(cached, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], 'the target timestep, then everything ahead');
});

test('prefetch window is sized by the cache budget, bounded to nearby timesteps', async () => {
  const spec = { nTime: 40, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 32 * 32 * 2;
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 10, compressedBytes: 0 });
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 20, concurrency: 1 });
  assert.equal(result.planned, 9, 'floor(0.9 x 10 chunks)');
  assert.equal(result.fetched, 9);
  assert.equal(store.stats.cache.evictions, 0);
  const cached = [];
  for (let t = 0; t < 40; t++) if (store.peekRaw(0, 0, 0, t)) cached.push(t);
  assert.deepEqual(cached, [17, 18, 19, 20, 21, 22, 23, 24, 25], 'a window around t=20, reaching further ahead (25) than behind (18)');

  const everything = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 100, compressedBytes: 0 });
  const full = await everything.prefetch({ lod: 0, cells: [[0, 0]], t: 20, playing: true, concurrency: 1 });
  assert.equal(full.planned, 40, 'the whole axis when it fits and the viewer plays');
});

test('prefetch skips cached chunks and honours abort', async () => {
  const spec = { nTime: 10, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  await store.getRaw(0, 0, 0, 0);
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 1 });
  assert.equal(result.skipped, 1, 'the cached timestep 0 is skipped');
  assert.equal(result.fetched, 9);

  const aborted = new AbortController();
  aborted.abort();
  const fresh = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  const none = await fresh.prefetch({ lod: 0, cells: [[0, 0]], t: 0, signal: aborted.signal });
  assert.equal(none.fetched, 0);
});

test('prefetch waits for demand fetches and demand is never queued behind it', async () => {
  const spec = { nTime: 6, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true, delayMs: 15 };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  const chunks = [];
  store.probe = (event) => chunks.push(event);
  const prefetching = store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 2 });
  await new Promise((resolve) => setTimeout(resolve, 1));
  const demand = store.getRaw(0, 0, 0, 5);
  await Promise.all([demand, prefetching]);
  const demandEvent = chunks.find((c) => !c.background);
  const startedAfterDemand = chunks.filter((c) => c.background && c.requestedAt > demandEvent.requestedAt);
  assert.ok(startedAfterDemand.every((c) => c.requestedAt >= demandEvent.decodedAt), 'no new prefetch fetch starts while demand is in flight');
});

test('eviction is least recently used by default and follows evictionScore when set', async () => {
  const spec = { nTime: 10, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 32 * 32 * 2;
  const lru = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 3 });
  for (const t of [0, 1, 2]) await lru.getRaw(0, 0, 0, t);
  lru.peekRaw(0, 0, 0, 0);
  await lru.getRaw(0, 0, 0, 4);
  assert.equal(lru.peekRaw(0, 0, 0, 1), undefined, 'least recently used chunk is evicted');
  assert.ok(lru.peekRaw(0, 0, 0, 0) && lru.peekRaw(0, 0, 0, 2) && lru.peekRaw(0, 0, 0, 4));
  assert.equal(lru.stats.cache.evictions, 1);
  assert.ok(lru.cacheInfo().bytes <= chunkBytes * 3);

  const far = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 3 });
  far.evictionScore = (entry) => Math.abs(entry.t - 5);
  for (const t of [5, 9, 6]) await far.getRaw(0, 0, 0, t);
  await far.getRaw(0, 0, 0, 4);
  assert.equal(far.peekRaw(0, 0, 0, 9), undefined, 'the chunk farthest from t=5 is evicted');
});

test('a background chunk never displaces a better one', async () => {
  const spec = { nTime: 10, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 32 * 32 * 2;
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 2, compressedBytes: 0 });
  store.evictionScore = (entry) => Math.abs(entry.t - 5);
  await store.getRaw(0, 0, 0, 5);
  await store.getRaw(0, 0, 0, 6);
  const result = await store.prefetch({ lod: 0, cells: [[0, 0]], t: 9, concurrency: 1 });
  assert.equal(result.budgetReached, true);
  assert.ok(store.peekRaw(0, 0, 0, 5) && store.peekRaw(0, 0, 0, 6));
  assert.equal(store.stats.cache.evictions, 0);
});

test('a caller that aborts is released; the fetch is cancelled when nobody is left', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: false, delayMs: 30 };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://synthetic', { store: readable });
  const chunkSignals = () => readable.log.filter((c) => c.key.includes('/c/1/')).map((c) => c.signal);

  const first = new AbortController();
  const second = new AbortController();
  const a = store.getRaw(0, 0, 0, 1, { signal: first.signal });
  const b = store.getRaw(0, 0, 0, 1, { signal: second.signal });
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(chunkSignals().length, 1, 'both callers share one fetch');
  assert.equal(chunkSignals()[0].aborted, false, 'one caller is still waiting');
  assert.ok(await b instanceof Uint16Array);

  const lone = new AbortController();
  const c = store.getRaw(0, 0, 0, 3, { signal: lone.signal });
  lone.abort();
  await assert.rejects(c, { name: 'AbortError' });
  const fetchSignal = readable.log.find((entry) => entry.key.includes('/c/3/')).signal;
  assert.equal(fetchSignal.aborted, true, 'the last caller leaving cancels the request');
  assert.equal(store.peekRaw(0, 0, 0, 3), undefined);
  assert.ok((await store.getRaw(0, 0, 0, 3)) instanceof Uint16Array, 'the chunk can be requested again');
});

test('a caller without a signal keeps a fetch alive when other callers abort', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: false, delayMs: 20 };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://synthetic', { store: readable });
  const abort = new AbortController();
  const patient = store.getRaw(0, 0, 0, 1);
  const impatient = store.getRaw(0, 0, 0, 1, { signal: abort.signal });
  abort.abort();
  await assert.rejects(impatient, { name: 'AbortError' });
  assert.ok((await patient) instanceof Uint16Array);
});

test('close() aborts in-flight requests', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: false, delayMs: 50 };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://synthetic', { store: readable });
  const pending = store.getRaw(0, 0, 0, 1);
  store.close();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('chunk probe events carry fetch and decode timestamps', async () => {
  const spec = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec) });
  const events = [];
  store.probe = (event) => events.push(event);
  await store.getRaw(0, 0, 0, 1);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.key, '0/0/0/1');
  assert.equal(event.background, false);
  assert.ok(event.requestedAt <= event.fetchedAt && event.fetchedAt <= event.decodedAt);
  assert.ok(event.bytes > 0);
});

test('a corrupt shard index fails with an actionable message', async () => {
  const readable = buildSyntheticStore({ nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true });
  const shard = readable.files.get('/0/data/c/0/0/0/0');
  shard[shard.length - 10] ^= 0xff;
  const store = await openStore('memory://synthetic', { store: readable });
  await assert.rejects(store.getRaw(0, 0, 0, 1), /shard index checksum mismatch.*index_location/);
  await assert.rejects(store.getRaw(0, 0, 0, 1), /checksum mismatch/, 'a failed index read is retried, not cached');
});

test('missing chunks and empty shard entries decode as the fill value', async () => {
  const readable = buildSyntheticStore({ nTime: 2, nBand: 1, height: 40, width: 40, chunk: 32,  sharded: false });
  readable.files.delete('/0/data/c/0/0/1/1');
  const store = await openStore('memory://synthetic', { store: readable });
  const data = await store.getRaw(0, 1, 1, 0);
  assert.equal(data.length, 32 * 32);
  assert.ok(data.every((v) => v === 0));
});

test('errors carry the store URL and the reason', async () => {
  await assert.rejects(openStore('memory://empty', { store: { get: async () => undefined, getRange: async () => undefined } }), /memory:\/\/empty.*root zarr\.json not found/);
  const readable = buildSyntheticStore({ nTime: 2, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true });
  const store = await openStore('memory://synthetic', { store: readable });
  await assert.rejects(store.getRaw(0, 5, 0, 0), /cell \(5, 0\) outside 1x1 grid at lod 0/);
  await assert.rejects(store.getRaw(0, 0, 0, 9), /timestep 9 out of range 0\.\.1/);
  await assert.rejects(store.getRaw(3, 0, 0, 0), /lod 3 out of range/);
});

test('joint cache budget: 1.5 GiB from 8 GB of device memory, else 768 MiB', () => {
  const MIB = 1024 ** 2;
  assert.equal(defaultTotalBytes(8), 1536 * MIB);
  assert.equal(defaultTotalBytes(16), 1536 * MIB);
  assert.equal(defaultTotalBytes(4), 768 * MIB);
  assert.equal(defaultTotalBytes(0.5), 768 * MIB);
  assert.equal(defaultTotalBytes(undefined), 768 * MIB, 'browsers without navigator.deviceMemory');
});

test('loopFits: whether the whole time axis of some cells fits 90% of the cache budget', async () => {
  const spec = { nTime: 20, nBand: 2, height: 16, width: 16, chunk: 32,  sharded: true };
  const chunkBytes = 2 * 32 * 32 * 2;
  const store = await openStore('memory://synthetic', { store: buildSyntheticStore(spec), maxCacheBytes: chunkBytes * 100 });
  assert.equal(store.loopFits(0, 4), true, '4 cells x 20 timesteps = 80 chunks <= 90');
  assert.equal(store.loopFits(0, 5), false, '100 chunks > 90');
  assert.equal(store.loopFits(0, 0), true);
});

test('samplePixelFrom samples true values in every supported dtype', () => {
  const geometry = { nBand: 2, chunkWidth: 2, chunkHeight: 1 };
  for (const Typed of [Uint8Array, Uint16Array, Int16Array, Float32Array]) {
    const data = Typed.of(100, 200, 7, 9);
    const pixel = samplePixelFrom(data, geometry, 1, 0);
    assert.ok(pixel instanceof Typed);
    assert.deepEqual([...pixel], [200, 9]);
  }
});
