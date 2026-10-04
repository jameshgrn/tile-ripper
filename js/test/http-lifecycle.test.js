import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { HttpStore, sleep } from '../chronozarr/http.js';
import { RequestLimiter } from '../chronozarr/limiter.js';
import { BandwidthEstimator } from '../chronozarr/bandwidth.js';
import { openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore } from '../support/synthetic-store.js';

function http(base, fetchImpl = fetch, delays = [0]) {
  const limiter = new RequestLimiter(1);
  const network = { requests: 0, bytes: 0 };
  const store = new HttpStore(base, { fetch: fetchImpl, limiter, network, bandwidth: new BandwidthEstimator(() => performance.now()), retryDelaysMs: delays });
  return { store, limiter, network };
}

test('suffix reads reject missing or invalid HEAD lengths before sending a range', async () => {
  for (const length of [null, '', 'not-a-size', '-1', '1.5', '1e2', '9007199254740992']) {
    const methods = [];
    const { store, network } = http('https://example.test/', async request => {
      methods.push(request.method);
      return new Response(null, { headers: length === null ? {} : { 'Content-Length': length } });
    });
    await assert.rejects(store.getRange('/chunk', { suffixLength: 4 }), /missing or invalid Content-Length/);
    assert.deepEqual(methods, ['HEAD']);
    assert.equal(network.requests, 1);
  }
});

test('suffix reads use the HEAD length and clamp to the whole object for long suffixes', async () => {
  for (const status of [200, 206]) {
    for (const suffixLength of [2, 10]) {
      const ranges = [];
      const body = Uint8Array.of(1, 2, 3, 4);
      const start = Math.max(0, body.length - suffixLength);
      const { store } = http('https://example.test/', async request => {
        if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '4' } });
        ranges.push(request.headers.get('Range'));
        return new Response(status === 200 ? body : body.slice(start), { status });
      });
      assert.deepEqual(await store.getRange('/chunk', { suffixLength }), body.slice(start));
      assert.deepEqual(ranges, [`bytes=${start}-3`]);
    }
  }
});

test('suffix reads of an empty object return empty bytes without sending an invalid range', async () => {
  const { store, network } = http('https://example.test/', async () => new Response(null, { headers: { 'Content-Length': '0' } }));
  assert.deepEqual(await store.getRange('/chunk', { suffixLength: 4 }), new Uint8Array(0));
  assert.equal(network.requests, 1);
});

test('a queued cancellation settles before the occupied slot is released', async (t) => {
  const limiter = new RequestLimiter(1);
  let release;
  const running = limiter.run(0, undefined, () => new Promise(resolve => { release = resolve; }));
  t.after(async () => { release(); await running; });
  const abort = new AbortController();
  let started = false;
  const queued = limiter.run(0, abort.signal, async () => { started = true; });
  const result = queued.catch(error => error.name);
  abort.abort();
  assert.equal(await Promise.race([result, sleep(50).then(() => 'still queued')]), 'AbortError');
  assert.equal(limiter.queued, 0);
  assert.equal(started, false);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('a synchronous task failure releases its slot', async () => {
  const limiter = new RequestLimiter(1);
  await assert.rejects(limiter.run(0, undefined, () => { throw new Error('sync failure'); }), /sync failure/);
  assert.equal(limiter.active, 0);
  assert.equal(await limiter.run(0, undefined, () => Promise.resolve('healthy')), 'healthy');
});

test('completed retry delays detach their abort listeners', async () => {
  const abort = new AbortController();
  for (let i = 0; i < 12; i++) await sleep(0, abort.signal);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const pending = sleep(1000, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('HTTP failures cancel unread response bodies before retrying', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let cancelled = 0;
  let attempts = 0;
  const { store, limiter } = http('https://example.test/', async () => {
    if (++attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
    return new Response(Uint8Array.of(1, 2));
  });
  assert.deepEqual(await store.get('/chunk'), Uint8Array.of(1, 2));
  assert.equal(cancelled, 1);
  assert.equal(limiter.active, 0);
});

test('a truncated HTTP body retries over a real connection and never caches partial bytes', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let attempts = 0;
  const server = createServer((_req, res) => {
    if (++attempts === 1) {
      res.writeHead(200, { 'Content-Length': 4 });
      res.write(Uint8Array.of(1));
      setImmediate(() => res.destroy());
    } else res.end(Uint8Array.of(1, 2, 3, 4));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { store, network, limiter } = http(`http://127.0.0.1:${server.address().port}/`);
  assert.deepEqual(await store.get('/chunk'), Uint8Array.of(1, 2, 3, 4));
  assert.equal(attempts, 2);
  assert.equal(network.bytes, 4);
  assert.equal(limiter.active, 0);
});

test('cancelling openStore aborts its initial metadata request without retries', async () => {
  const abort = new AbortController();
  let signal;
  const pending = openStore('https://example.test/store', {
    signal: abort.signal,
    fetch: request => { signal = request.signal; return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); },
  });
  abort.abort();
  const result = pending.catch(error => error.name);
  assert.equal(await Promise.race([result, sleep(50).then(() => 'still opening')]), 'AbortError');
  assert.equal(signal.aborted, true);
});

test('cancelling openStore aborts all outstanding array metadata reads', async () => {
  const readable = buildSyntheticStore({ nTime: 2, nBand: 1, height: 32, width: 32, chunk: 32, sharded: false });
  const abort = new AbortController();
  const signals = [];
  let arraysStarted;
  const started = new Promise(resolve => { arraysStarted = resolve; });
  const pending = openStore('https://example.test/store', {
    workers: 0, signal: abort.signal,
    fetch: request => {
      if (new URL(request.url).pathname.endsWith('/store/zarr.json')) return Promise.resolve(new Response(readable.files.get('/zarr.json')));
      signals.push(request.signal); arraysStarted();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  });
  await started;
  abort.abort();
  const result = pending.catch(error => error.name);
  assert.equal(await Promise.race([result, sleep(50).then(() => 'still opening')]), 'AbortError');
  assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
});

test('removing a MapLibre layer cancels its opening request', async () => {
  const { ChronozarrLayer } = await import('../maplibre/layer.js');
  let signal;
  const layer = new ChronozarrLayer({ url: 'https://example.test/store', storeOptions: {
    fetch: request => { signal = request.signal; return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); },
  } });
  layer.onAdd({ triggerRepaint() {} }, {});
  layer.onRemove();
  await assert.rejects(layer.opened, /removed/);
  assert.equal(signal.aborted, true);
});
