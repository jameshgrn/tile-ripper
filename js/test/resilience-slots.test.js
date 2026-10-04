import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FetchError, openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore } from '../support/synthetic-store.js';
import { filesFetch } from '../support/files-fetch.js';

const SPEC = { nTime: 6, nBand: 1, height: 40, width: 40, chunk: 32,  sharded: false };
const URL_BASE = 'https://example.test/store';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isChunk = (key, t, cell = '0/0') => key.endsWith(`/c/${t}/0/${cell}`);

test('a request waiting to retry holds no slot: healthy requests run at full speed beside a permanently failing one', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const files = buildSyntheticStore(SPEC).files;
  const log = [];
  const fetch = filesFetch(files, { log, fail: ({ key }) => (isChunk(key, 1) ? 503 : null), delayMs: 5 });
  const store = await openStore(URL_BASE, { fetch, workers: 0, maxRequests: 1, retryDelaysMs: [300, 300, 300] });

  const failing = store.getRaw(0, 0, 0, 1).catch((error) => error);
  await sleep(40);
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 1, 'the failing chunk is now waiting out its first backoff');

  const started = performance.now();
  for (const tt of [0, 2, 3, 4, 5]) await store.getRaw(0, 0, 0, tt);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `five healthy chunks took ${Math.round(elapsed)} ms through a single slot while the failing one backed off for 300 ms`);
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 1, 'still backing off');

  const error = await failing;
  assert.ok(error instanceof FetchError);
  assert.equal(error.attempts, 4);
  assert.equal(log.filter((c) => isChunk(c.key, 1)).length, 4);
});

test('a retried request takes a slot only for each attempt', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const files = buildSyntheticStore(SPEC).files;
  const fetch = filesFetch(files, { fail: ({ key, attempt }) => (isChunk(key, 1) && attempt < 3 ? 503 : null), delayMs: 5 });
  const store = await openStore(URL_BASE, { fetch, workers: 0, maxRequests: 2, retryDelaysMs: [60, 60, 60] });
  const [flaky] = await Promise.all([store.getRaw(0, 0, 0, 1), store.getRaw(0, 0, 0, 0), store.getRaw(0, 0, 0, 2)]);
  assert.ok(flaky instanceof Uint16Array);
  assert.ok(fetch.stats.peak <= 2, `never more than maxRequests on the wire (${fetch.stats.peak})`);
  assert.equal(store.stats.network.inflight, 0);
});

test('a shard index that keeps failing does not block other cells', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const files = buildSyntheticStore({ ...SPEC, sharded: true }).files;
  const log = [];
  const fetch = filesFetch(files, { log, fail: ({ key }) => (key.endsWith('/c/0/0/0/0') ? 500 : null), delayMs: 5 });
  const store = await openStore(URL_BASE, { fetch, workers: 0, maxRequests: 1, retryDelaysMs: [400, 400, 400] });
  const bad = store.getRaw(0, 0, 0, 0).catch((error) => error);
  await sleep(30);
  const started = performance.now();
  await store.getRaw(0, 1, 1, 0);
  assert.ok(performance.now() - started < 250, 'another cell loaded while the broken shard waited to retry');
  const error = await bad;
  assert.match(error.message, /HTTP 500/);
});

test('the wait between retries is cancelled by an abort, releasing nothing it held', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const files = buildSyntheticStore(SPEC).files;
  const log = [];
  const fetch = filesFetch(files, { log, fail: ({ key }) => (isChunk(key, 1) ? 'network' : null) });
  const store = await openStore(URL_BASE, { fetch, workers: 0, maxRequests: 1, retryDelaysMs: [500, 500, 500] });
  const abort = new AbortController();
  const pending = store.getRaw(0, 0, 0, 1, { signal: abort.signal });
  await sleep(30);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(store.stats.network.inflight, 0);
  assert.ok((await store.getRaw(0, 0, 0, 2)) instanceof Uint16Array, 'the single slot is free');
});

test('a server that ignores Range (200 with the whole shard) still yields the right bytes', async () => {
  const readable = buildSyntheticStore({ ...SPEC, sharded: true });
  const plain = filesFetch(readable.files);
  const noRange = async (request) => {
    const stripped = new Request(request.url, { method: request.method, signal: request.signal });
    return plain(stripped);
  };
  const store = await openStore(URL_BASE, { fetch: noRange, workers: 0 });
  const reference = await openStore('memory://ref', { store: readable, workers: 0 });
  for (const tt of [0, 1, 4]) {
    const got = await store.getRaw(0, 0, 0, tt);
    assert.deepEqual([...got], [...(await reference.getRaw(0, 0, 0, tt))]);
  }
});

test('with suffixRequests the shard index is one request; the bytes are still the last N', async () => {
  const readable = buildSyntheticStore({ ...SPEC, sharded: true });
  const log = [];
  const store = await openStore(URL_BASE, { fetch: filesFetch(readable.files, { log }), workers: 0, suffixRequests: true });
  await store.getRaw(0, 0, 0, 1);
  const shard = log.filter((c) => c.key.includes('/c/0/0/0/0'));
  assert.deepEqual(shard.map((c) => [c.method, /^bytes=-\d+$/.test(c.range ?? '')]), [['GET', true], ['GET', false]]);
});
