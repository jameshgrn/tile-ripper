import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore, defaultValues } from '../support/synthetic-store.js';

const SPEC = { nTime: 4, nBand: 1, height: 16, width: 16, chunk: 32,  sharded: true };

/**
 * Install a stand-in for the Worker constructor for the duration of `body`. `onConstruct(call)` may throw; the
 * workers it hands out never answer, so every demand read is decoded on the main thread by the pool's fallback.
 */
async function withWorkerConstructor(onConstruct, body) {
  const calls = [];
  class FakeWorker {
    constructor(url, options) {
      calls.push({ url: String(url), options });
      onConstruct(calls.length);
    }
    postMessage() {}
    terminate() {}
  }
  const had = Object.hasOwn(globalThis, 'Worker');
  const before = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    await body(calls);
  } finally {
    if (had) globalThis.Worker = before;
    else delete globalThis.Worker;
  }
}

test('a SecurityError from the Worker constructor (package loaded from a CDN) is retried through a same-origin blob', async () => {
  const securityError = () => new DOMException('Failed to construct Worker: Script at a cross-origin URL cannot be loaded', 'SecurityError');
  await withWorkerConstructor(
    (n) => {
      if (n === 1) throw securityError();
    },
    async (calls) => {
      const store = await openStore('memory://cross-origin', { store: buildSyntheticStore(SPEC), workers: 3 });
      assert.equal(calls.length, 4, 'one direct attempt that threw, then three workers through the blob');
      assert.match(calls[0].url, /\/chronozarr\/decode-worker\.js$/);
      assert.ok(calls.slice(1).every((c) => c.url.startsWith('blob:') && c.options.type === 'module'), 'module workers started from a blob URL');
      assert.equal(new Set(calls.slice(1).map((c) => c.url)).size, 1, 'one bootstrap blob for all of them');
      const script = await resolveObjectURL(calls[1].url).text();
      assert.equal(script, `import ${JSON.stringify(calls[0].url)};`, 'the blob imports the real worker script');
      const cell = await store.getCell(0, 0, 0, 1);
      assert.equal(cell.data[5], defaultValues('uint16')(1, 0, 0, 5, 0), 'decodes (on the main thread: the stand-in workers never answer)');
      store.close();
    },
  );
});

test('a Worker constructor that fails for another reason is logged once and openStore falls back to the main thread', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await withWorkerConstructor(
      (n) => {
        if (n === 2) throw new TypeError('worker-src blocks this');
      },
      async (calls) => {
        const store = await openStore('memory://no-workers', { store: buildSyntheticStore(SPEC), workers: 4 });
        assert.equal(calls.length, 2, 'the pool gave up at the second worker');
        assert.equal(warnings.length, 1, 'one warning');
        assert.match(warnings[0], /cannot start decode workers \(TypeError: worker-src blocks this\); decoding on the main thread/);
        const raw = await store.getRaw(0, 0, 0, 0);
        assert.ok(raw instanceof Uint16Array);
        assert.equal(raw[5], defaultValues('uint16')(0, 0, 0, 5, 0));
        store.close();
      },
    );
  } finally {
    console.warn = warn;
  }
});
