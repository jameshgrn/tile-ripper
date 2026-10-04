import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore } from '../support/synthetic-store.js';

const spec = { nTime: 12, nBand: 1, height: 32, width: 32, chunk: 32,  sharded: true, mask: true, coverage: true };

test('close releases data, compressed bytes and auxiliary arrays even when the store remains referenced', async () => {
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://closed-cache', { store: readable, workers: 0 });
  await Promise.all([store.getRaw(0, 0, 0, 0), store.getMask(0, 0, 0, 0), store.getCoverage(0, 0, 0, 0)]);
  assert.ok(store.cacheInfo().bytes > 0 && store.cacheInfo().compressedBytes > 0);
  store.close(); store.close();
  assert.equal(store.cacheInfo().bytes, 0);
  assert.equal(store.cacheInfo().compressedBytes, 0);
  assert.equal(store.peekMask(0, 0, 0, 0), undefined);
  assert.equal(store.peekCoverage(0, 0, 0, 0), undefined);
  const calls = readable.log.length;
  await assert.rejects(store.getRaw(0, 0, 0, 0), /closed/);
  await assert.rejects(store.getMask(0, 0, 0, 1), /closed/);
  await assert.rejects(store.prefetch({ lod: 0, cells: [[0, 0]], t: 0 }), /closed/);
  assert.equal(readable.log.length, calls);
});

test('completed prefetches detach every owner listener without requiring an abort', async (t) => {
  const observed = new Set();
  const add = AbortSignal.prototype.addEventListener;
  t.mock.method(AbortSignal.prototype, 'addEventListener', function(event, ...args) {
    if (event === 'abort') observed.add(this);
    return add.call(this, event, ...args);
  });
  const store = await openStore('memory://owner-listeners', { store: buildSyntheticStore(spec), workers: 0 });
  const owner = new AbortController();
  await store.prefetch({ lod: 0, cells: [[0, 0]], t: 0, playing: true, masks: true, signal: owner.signal });
  for (const signal of observed) assert.equal(getEventListeners(signal, 'abort').length, 0);
  store.close();
});

test('close prevents a late decode from repopulating caches', async () => {
  let decode;
  let started;
  const decoding = new Promise(resolve => { started = resolve; });
  const worker = {
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => worker.onmessage({ data: { type: 'ready' } }));
      if (message.type === 'decode') { decode = message; started(); }
    },
    terminate() {},
  };
  const store = await openStore('memory://late-decode', { store: buildSyntheticStore(spec), workers: 1, spawnWorker: () => worker });
  const pending = store.getRaw(0, 0, 0, 0);
  const result = pending.catch(error => error.name);
  await decoding;
  const onmessage = worker.onmessage;
  store.close();
  // A worker message already in transit may arrive after terminate().
  onmessage({ data: { type: 'decoded', id: decode.id, data: new Uint16Array(1024) } });
  assert.equal(await result, 'AbortError');
  assert.equal(store.cacheInfo().bytes, 0);
});
