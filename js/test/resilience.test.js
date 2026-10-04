import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FetchError, openStore } from '../chronozarr/decoder.js';
import { RequestLimiter } from '../chronozarr/limiter.js';
import { buildSyntheticStore } from '../support/synthetic-store.js';
import { filesFetch } from '../support/files-fetch.js';

const SPEC = { nTime: 4, nBand: 1, height: 40, width: 40, chunk: 32,  sharded: false };
const URL_BASE = 'https://example.test/store';
const isChunk = (key, t) => key.includes(`/c/${t}/0/0/0`);

function open(options = {}, spec = SPEC, fetchOptions = {}) {
  const files = buildSyntheticStore(spec).files;
  const log = [];
  const fetchImpl = filesFetch(files, { log, ...fetchOptions });
  return openStore(URL_BASE, { fetch: fetchImpl, retryDelaysMs: [1, 1, 1], ...options }).then((store) => ({ store, log, fetchImpl }));
}

test('network errors, 5xx and 429 are retried and the chunk then loads', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { store, log } = await open({}, SPEC, {
    fail: ({ key, attempt }) => (isChunk(key, 1) && attempt === 1 ? 'network' : isChunk(key, 3) && attempt <= 2 ? [503, 429][attempt - 1] : null),
  });
  assert.ok((await store.getRaw(0, 0, 0, 1)) instanceof Uint16Array);
  assert.ok((await store.getRaw(0, 0, 0, 3)) instanceof Uint16Array);
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 2);
  assert.equal(log.filter((c) => isChunk(c.key, 3)).length, 3);
  assert.equal(store.stats.network.requests, 1 + 1 + 2 + 3, 'root + array metadata + every attempt of both chunks');
  assert.equal(warn.mock.callCount(), 3);
  const [message, details] = warn.mock.calls[0].arguments;
  assert.match(message, /retrying/);
  assert.equal(details.url, `${URL_BASE}/0/data/c/1/0/0/0`);
  assert.match(details.error, /TypeError: Failed to fetch/);
  assert.equal(details.attempt, 1);
  assert.equal(details.of, 4);
});

test('a chunk that fails every attempt is reported with URL, status and attempts, then retried on the next request', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  let broken = true;
  const { store, log } = await open({}, SPEC, { fail: ({ key }) => (broken && isChunk(key, 1) ? 503 : null) });
  await assert.rejects(store.getRaw(0, 0, 0, 1), (e) => {
    assert.ok(e instanceof FetchError);
    assert.equal(e.name, 'FetchError');
    assert.equal(e.status, 503);
    assert.equal(e.attempts, 4);
    assert.equal(e.url, `${URL_BASE}/0/data/c/1/0/0/0`);
    assert.match(e.message, /GET https:\/\/example\.test\/store\/0\/data\/c\/1\/0\/0\/0: HTTP 503 scripted \(4 attempts\)/);
    return true;
  });
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 4);
  assert.equal(error.mock.callCount(), 1);
  assert.match(error.mock.calls[0].arguments[0], /giving up/);
  assert.equal(store.peekRaw(0, 0, 0, 1), undefined);
  broken = false;
  assert.ok((await store.getRaw(0, 0, 0, 1)) instanceof Uint16Array, 'a failure is not cached');
});

test('a network error that never recovers names the error, not just "Failed to fetch"', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const { store } = await open({}, SPEC, { fail: ({ key }) => (isChunk(key, 1) ? 'network' : null) });
  await assert.rejects(store.getRaw(0, 0, 0, 1), (e) => {
    assert.equal(e.status, undefined);
    assert.equal(e.cause.name, 'TypeError');
    assert.match(e.message, /example\.test\/store\/0\/data\/c\/1\/0\/0\/0: TypeError: Failed to fetch \(4 attempts\)/);
    return true;
  });
});

test('client errors other than 404 and 429 fail at once, and 404 is a missing chunk', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const { store, log } = await open({}, SPEC, { fail: ({ key }) => (isChunk(key, 1) ? 403 : null) });
  await assert.rejects(store.getRaw(0, 0, 0, 1), (e) => e.status === 403 && e.attempts === 1);
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 1, 'not retried');

  const files = buildSyntheticStore(SPEC).files;
  files.delete('/0/data/c/2/0/0/0');
  const fetchImpl = filesFetch(files);
  const missing = await openStore(URL_BASE, { fetch: fetchImpl, retryDelaysMs: [1] });
  const data = await missing.getRaw(0, 0, 0, 2);
  assert.ok(data.every((v) => v === 0));
});

test('aborting during a retry backoff stops retrying', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { store, log } = await open({ retryDelaysMs: [200, 200, 200] }, SPEC, { fail: ({ key }) => (isChunk(key, 1) ? 'network' : null) });
  const abort = new AbortController();
  const pending = store.getRaw(0, 0, 0, 1, { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 60));
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 1, 'no attempt after the abort');
});

test('wire bytes come from Content-Length of GET/range responses, not HEAD', async () => {
  const { store } = await open({}, { ...SPEC, sharded: true });
  const before = store.stats.network.bytes;
  const data = await store.getRaw(0, 0, 0, 1);
  assert.ok(data.length > 0);
  const chunkFile = buildSyntheticStore({ ...SPEC, sharded: true }).files.get('/0/data/c/0/0/0/0');
  const indexBytes = 16 * SPEC.nTime + 4;
  assert.ok(store.stats.network.bytes - before >= indexBytes);
  assert.ok(store.stats.network.bytes - before < chunkFile.length, 'only the index and one inner chunk were transferred');
});

test('at most maxRequests fetches are in flight', async () => {
  const spec = { nTime: 30, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: false };
  const { store, fetchImpl, log } = await open({ maxRequests: 3 }, spec, { delayMs: 5 });
  await Promise.all(Array.from({ length: 30 }, (_, t) => store.getRaw(0, 0, 0, t)));
  assert.equal(fetchImpl.stats.peak, 3);
  assert.equal(log.length, 32, 'root, array metadata and 30 chunks');
});

test('limiter: priority order, abort before start, failures free the slot', async () => {
  const limiter = new RequestLimiter(1);
  const order = [];
  const task = (name, ms = 2) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(name);
    return name;
  };
  const running = limiter.run(1, undefined, task('first', 10));
  const background = limiter.run(1, undefined, task('background'));
  const demand = limiter.run(0, undefined, task('demand'));
  const abort = new AbortController();
  const dropped = limiter.run(0, abort.signal, task('dropped'));
  abort.abort();
  await assert.rejects(dropped, { name: 'AbortError' });
  await Promise.all([running, background, demand]);
  assert.deepEqual(order, ['first', 'demand', 'background']);

  await assert.rejects(limiter.run(0, undefined, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limiter.run(0, undefined, async () => 'after'), 'after');
  assert.equal(limiter.active, 0);
});

test('prefetch leaves a cell alone after one of its chunks failed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const spec = { nTime: 6, nBand: 1, height: 40, width: 40, chunk: 32,  sharded: false };
  const { store, log } = await open({}, spec, { fail: ({ key }) => (key.endsWith('/0/1') ? 503 : null) });
  const first = await store.prefetch({ lod: 0, cells: [[0, 0], [0, 1]], t: 0, concurrency: 1 });
  assert.equal(first.errors.length, 1, 'one failure is reported, not one per chunk');
  assert.match(first.errors[0].error.message, /HTTP 503/);
  assert.equal(log.filter((c) => c.key.endsWith('/0/1')).length, 4, 'the failing chunk was tried once with its retries');
  assert.equal(store.cacheInfo().entries, 6, 'the healthy cell was fully prefetched');
  const second = await store.prefetch({ lod: 0, cells: [[0, 0], [0, 1]], t: 0, concurrency: 1 });
  assert.equal(second.errors.length, 0);
  assert.equal(log.filter((c) => c.key.endsWith('/0/1')).length, 4, 'not retried during the cooldown');
});
