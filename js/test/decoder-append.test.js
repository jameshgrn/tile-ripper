// A reader opened before an append (spec section 14): the trailing time shard of each cell is replaced by a longer
// object, so the shard_bytes length the reader holds for it is stale. The reader must heal itself: re-read the root
// past the HTTP cache, adopt the new lengths, retry the index read, and fall back to a suffix read when the lengths
// stay wrong, without changing what any chunk it already knew decodes to.
//
// Stores are the synthetic sharded ones, written to a temp directory and served over real HTTP (byte ranges and
// 416 included) by js/support/static-server.js. An append is built the way the Python writer leaves a store: the
// longer store is built with the same values and shard_time, so the old chunks keep their bytes and offsets and only
// the shard, its index and the root change; the files of the longer store are written over the served ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../chronozarr/decoder.js';
import { startStaticServer } from '../support/static-server.js';
import { filesFetch } from '../support/files-fetch.js';
import { buildSyntheticStore, defaultValues } from '../support/synthetic-store.js';

const SPEC = { nBand: 2, height: 40, width: 33, chunk: 32,  sharded: true, shardTime: 4, specVersion: '0.3.0', shardBytes: true };
/** t 0-3 in shard 0, t 4-5 in the trailing shard 1; a 2 x 2 grid of cells. */
const OLD = { ...SPEC, nTime: 6 };
/** The same store after appending t=6: shard 1 holds t 4-6. */
const NEW = { ...SPEC, nTime: 7 };
const CELLS = [[0, 0], [0, 1], [1, 0], [1, 1]];
const INDEX_BYTES = 16 * SPEC.shardTime + 4;
const CHUNK_BYTES = SPEC.nBand * SPEC.chunk * SPEC.chunk * 2;
const MINUTE = 60000;

const values = defaultValues('uint16');
const shardKey = (row, col, ts = 1) => `/0/data/c/${ts}/0/${row}/${col}`;
const enc = (object) => new TextEncoder().encode(JSON.stringify(object));
const readJson = (files, key) => JSON.parse(new TextDecoder().decode(files.get(key)));
const quiet = (t) => t.mock.method(console, 'warn', () => {});

/** A store directory served over HTTP; `publish(files)` writes objects over it the way an append does, root last. */
async function served(t, spec, { patchRoot } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'chronozarr-append-'));
  const server = await startStaticServer(dir);
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const publish = async (files) => {
    const order = [...files.keys()].sort((a, b) => Number(a === '/zarr.json') - Number(b === '/zarr.json') || Number(a.endsWith('zarr.json')) - Number(b.endsWith('zarr.json')));
    for (const key of order) {
      const file = path.join(dir, 'store', key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, files.get(key));
    }
  };
  const files = buildSyntheticStore(spec).files;
  if (patchRoot) {
    const root = readJson(files, '/zarr.json');
    patchRoot(root.attributes.chronozarr);
    files.set('/zarr.json', enc(root));
  }
  await publish(files);
  return { url: `${server.url}/store/`, requests: server.requests, publish, files };
}

/** Requests the server saw for one object. */
const forObject = (site, key) => site.requests.filter((r) => r.path === `/store${key}`);

async function assertCell(store, row, col, t) {
  const cell = await store.getCell(0, row, col, t);
  for (let b = 0; b < store.levels[0].nBand; b++) {
    for (let y = 0; y < cell.height; y++) {
      for (let x = 0; x < cell.width; x++) {
        assert.equal(cell.data[(b * cell.chunkHeight + y) * cell.chunkWidth + x], values(t, b, row * 32 + y, col * 32 + x, 0), `t${t} r${row} c${col} b${b} y${y} x${x}`);
      }
    }
  }
}

const RECOVERIES_NONE = { rootRefetches: 0, retried: 0, suffixFallbacks: 0, suppressed: 0 };

// ---- an append under a running reader ----

test('the fixture append keeps old chunks where they were and only grows the trailing shards', () => {
  const before = buildSyntheticStore(OLD).files;
  const after = buildSyntheticStore(NEW).files;
  for (const [row, col] of CELLS) {
    const old = before.get(shardKey(row, col));
    const grown = after.get(shardKey(row, col));
    assert.equal(grown.length, old.length + CHUNK_BYTES, 'one more chunk');
    assert.deepEqual(grown.subarray(0, old.length - INDEX_BYTES), old.subarray(0, old.length - INDEX_BYTES), 'existing chunks: same bytes, same offsets');
    assert.deepEqual(after.get(shardKey(row, col, 0)), before.get(shardKey(row, col, 0)), 'a shard that receives no timestep is identical');
  }
});

test('a stale reader reads the grown trailing shard: one root refetch past the cache, then the right bytes', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  assert.equal(store.times.length, 6);
  await assertCell(store, 0, 0, 1);
  assert.deepEqual(store.stats.recoveries, RECOVERIES_NONE, 'shard 0 did not change: nothing to recover from');

  const old = buildSyntheticStore(OLD).files.get(shardKey(0, 0));
  const grown = buildSyntheticStore(NEW).files.get(shardKey(0, 0));
  await site.publish(buildSyntheticStore(NEW).files);

  await assertCell(store, 0, 0, 5);
  await assertCell(store, 0, 0, 4);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 });

  const root = forObject(site, '/zarr.json');
  assert.equal(root.length, 2, 'open, then one refetch');
  assert.equal(root[0].cacheControl, null);
  assert.equal(root[1].cacheControl, 'no-cache', 'cache: "reload" goes to the wire as Cache-Control: no-cache');
  const shard = forObject(site, shardKey(0, 0));
  assert.equal(shard[0].range, `bytes=${old.length - INDEX_BYTES}-${old.length - 1}`, 'the stale hint');
  assert.equal(shard[1].range, `bytes=${grown.length - INDEX_BYTES}-${grown.length - 1}`, 'the refreshed hint: a bounded range, not a HEAD or a suffix');
  assert.ok(shard.every((r) => r.method === 'GET' && /^bytes=\d+-\d+$/.test(r.range)), 'only bounded ranges (no preflight on a cross-origin host)');
  assert.equal(shard.length, 4, 'stale index, fresh index, then the chunks of t=5 and t=4 (the index is shared)');
  assert.deepEqual(shard.slice(2).map((r) => r.range).sort(), [`bytes=0-${CHUNK_BYTES - 1}`, `bytes=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}`], 'timesteps 4 and 5, at the offsets they always had');
  assert.equal(site.requests.filter((r) => r.cacheControl !== null).length, 1, 'only the root refetch bypassed the cache');
});

test('the other cells of the stale reader use the refreshed lengths at once: no second refetch', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  await assertCell(store, 1, 0, 1);
  await site.publish(buildSyntheticStore(NEW).files);
  await assertCell(store, 0, 0, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 });
  const length = buildSyntheticStore(NEW).files.get(shardKey(1, 1)).length;
  await assertCell(store, 1, 1, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 }, 'a cell not read before has the new length from the start');
  assert.deepEqual(forObject(site, shardKey(1, 1)).map((r) => r.range).slice(0, 1), [`bytes=${length - INDEX_BYTES}-${length - 1}`], 'one index read, no failed one');
  await assertCell(store, 1, 0, 1);
  await assertCell(store, 0, 0, 2);
  assert.equal(forObject(site, '/zarr.json').length, 2, 'cached indexes and chunks stay valid: reading them again costs nothing');
});

test('shards that fail together share one root refetch', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  await site.publish(buildSyntheticStore(NEW).files);
  await Promise.all(CELLS.map(([row, col]) => assertCell(store, row, col, 5)));
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 4, suffixFallbacks: 0, suppressed: 0 });
  assert.equal(forObject(site, '/zarr.json').length, 2);
});

test('a chunk the reader knew before the append decodes to the same bytes after it', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  const reference = await openStore('memory://old', { store: buildSyntheticStore(OLD), workers: 0 });
  const seen = new Map();
  for (const [row, col] of CELLS) for (const tt of [0, 3, 4]) seen.set(`${row}/${col}/${tt}`, [...(await store.getRaw(0, row, col, tt))]);
  await site.publish(buildSyntheticStore(NEW).files);
  for (const [row, col] of CELLS) {
    for (let tt = 0; tt < 6; tt++) {
      const got = [...(await store.getRaw(0, row, col, tt))];
      assert.deepEqual(got, [...(await reference.getRaw(0, row, col, tt))], `r${row} c${col} t${tt} is what the old store holds`);
      if (seen.has(`${row}/${col}/${tt}`)) assert.deepEqual(got, seen.get(`${row}/${col}/${tt}`), `r${row} c${col} t${tt} did not change`);
    }
  }
});

test('the open store does not grow: the new timestep is a reload, not a surprise', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  await site.publish(buildSyntheticStore(NEW).files);
  await assertCell(store, 0, 0, 5);
  assert.equal(store.times.length, 6);
  assert.equal(store.levels[0].nTime, 6);
  assert.deepEqual(store.attrs.levels[0].shape, [6, 2, 40, 33]);
  await assert.rejects(store.getRaw(0, 0, 0, 6), /timestep 6 out of range 0\.\.5/);

  const reopened = await openStore(site.url, { workers: 0, retryDelaysMs: [] });
  assert.equal(reopened.times.length, 7, 'openStore again sees it');
  await assertCell(reopened, 0, 0, 6);
  assert.deepEqual(reopened.stats.recoveries, RECOVERIES_NONE, 'a reader opened after the append has nothing to heal');
});

test('a shard that got shorter (a re-upload) answers 416 for the old length and heals the same way', async (t) => {
  const site = await served(t, NEW);
  const store = await openStore(site.url, { workers: 0 });
  await site.publish(buildSyntheticStore(OLD).files);
  const old = buildSyntheticStore(OLD).files.get(shardKey(1, 1));
  await assertCell(store, 1, 1, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 });
  const shard = forObject(site, shardKey(1, 1));
  assert.equal(shard[1].range, `bytes=${old.length - INDEX_BYTES}-${old.length - 1}`);
});

// ---- the hint is wrong and the root has no fix ----

test('wrong lengths the root cannot fix: a suffix read gets the right index, once per shard', async (t) => {
  const warn = quiet(t);
  const lengths = Object.fromEntries(CELLS.map(([row, col]) => [`${row}/${col}`, buildSyntheticStore(OLD).files.get(shardKey(row, col)).length]));
  const wrong = { '1/0/0': lengths['0/0'] + 7, '1/0/1': lengths['0/1'] - 100, '1/1/0': lengths['1/0'] + 5000 };
  const site = await served(t, OLD, { patchRoot: (cz) => Object.assign(cz.shard_bytes['0'], wrong) });
  const store = await openStore(site.url, { workers: 0 });

  // Too long by 7 bytes: a short answer. 100 too short: bytes from inside the data. 5000 too long: 416.
  for (const [row, col] of [[0, 0], [0, 1], [1, 0]]) await assertCell(store, row, col, 4);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 0, suffixFallbacks: 3, suppressed: 2 }, 'a root that lists the same lengths is asked once, not once per shard');
  assert.equal(forObject(site, '/zarr.json').length, 2);

  const first = forObject(site, shardKey(0, 0));
  const length = lengths['0/0'];
  assert.deepEqual(
    first.map((r) => [r.method, r.range]),
    [
      ['GET', `bytes=${length + 7 - INDEX_BYTES}-${length + 6}`],
      ['HEAD', null],
      ['GET', `bytes=${length - INDEX_BYTES}-${length - 1}`],
      ['GET', `bytes=0-${CHUNK_BYTES - 1}`],
    ],
    'the hinted read, then HEAD and the exact range of the real shard, then the chunk',
  );
  assert.equal(warn.mock.calls.length, 3, 'one warning per shard that needed the fallback');
  assert.match(warn.mock.calls[0].arguments[0], /shard_bytes \(\d+\) does not match the shard object/);

  await assertCell(store, 1, 1, 5);
  assert.equal(store.stats.recoveries.suffixFallbacks, 3, 'a correct hint is used as before');
});

test('the fallback is a real suffix range with suffixRequests', async (t) => {
  quiet(t);
  const length = buildSyntheticStore(OLD).files.get(shardKey(0, 0)).length;
  const site = await served(t, OLD, { patchRoot: (cz) => (cz.shard_bytes['0']['1/0/0'] = length - 100) });
  const store = await openStore(site.url, { workers: 0, suffixRequests: true });
  await assertCell(store, 0, 0, 5);
  const ranges = forObject(site, shardKey(0, 0)).map((r) => r.range);
  assert.equal(ranges.length, 3);
  assert.equal(ranges[0], `bytes=${length - 100 - INDEX_BYTES}-${length - 101}`, 'the wrong hint');
  assert.equal(ranges[1], `bytes=-${INDEX_BYTES}`, 'then one suffix request, no HEAD');
  assert.equal(forObject(site, shardKey(0, 0)).filter((r) => r.method === 'HEAD').length, 0);
  assert.equal(store.stats.recoveries.suffixFallbacks, 1);
});

test('a root that lists no shard_bytes any more leaves a stale reader on the suffix read', async (t) => {
  quiet(t);
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  const files = buildSyntheticStore(NEW).files;
  const root = readJson(files, '/zarr.json');
  delete root.attributes.chronozarr.shard_bytes;
  files.set('/zarr.json', enc(root));
  await site.publish(files);
  await assertCell(store, 0, 1, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 0, suffixFallbacks: 1, suppressed: 0 });
  await assertCell(store, 1, 1, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 0, suffixFallbacks: 1, suppressed: 0 }, 'no hint left to go stale: the plain unhinted read, not a recovery');
  assert.deepEqual(forObject(site, shardKey(1, 1)).map((r) => r.method).slice(0, 2), ['HEAD', 'GET']);
});

// ---- the cap: one root refetch per shard per minute ----

/** A readable over the synthetic store whose root, from its second read on, lists one more made-up shard length each time (so the root "changes"). */
function churningRoot(readable) {
  let reads = 0;
  return {
    get: async (key, options) => {
      const bytes = await readable.get(key, options);
      if (key !== '/zarr.json' || ++reads < 2) return bytes;
      const root = JSON.parse(new TextDecoder().decode(bytes));
      root.attributes.chronozarr.shard_bytes['0']['9/9/9'] = reads;
      return enc(root);
    },
    getRange: (key, range, options) => readable.getRange(key, range, options),
  };
}

function corruptIndex(readable, row, col) {
  const shard = readable.files.get(shardKey(row, col));
  shard[shard.length - 10] ^= 0xff;
}

test('a shard whose index cannot be read at all re-reads the root at most once a minute (fake clock)', async (t) => {
  quiet(t);
  const readable = buildSyntheticStore(OLD);
  corruptIndex(readable, 0, 0);
  let now = 1000;
  const store = await openStore('memory://cap', { store: readable, workers: 0, clock: () => now });
  const rootReads = () => readable.log.filter((c) => c.key === '/zarr.json').length;
  const attempt = async () => {
    await assert.rejects(store.getRaw(0, 0, 0, 4), /shard index checksum mismatch/, 'the corrupt shard is reported, not hidden');
    return store.stats.recoveries;
  };

  assert.deepEqual(await attempt(), { rootRefetches: 1, retried: 0, suffixFallbacks: 1, suppressed: 0 });
  assert.equal(rootReads(), 2);
  now += 30000;
  assert.deepEqual(await attempt(), { rootRefetches: 1, retried: 0, suffixFallbacks: 2, suppressed: 1 }, 'half a minute later: no refetch');
  now = 1000 + MINUTE - 1;
  assert.deepEqual(await attempt(), { rootRefetches: 1, retried: 0, suffixFallbacks: 3, suppressed: 2 }, 'a millisecond short of a minute: no refetch');
  now = 1000 + MINUTE;
  assert.deepEqual(await attempt(), { rootRefetches: 2, retried: 0, suffixFallbacks: 4, suppressed: 2 }, 'a minute after the last one: refetch');
  assert.equal(rootReads(), 3);
  assert.deepEqual(await attempt(), { rootRefetches: 2, retried: 0, suffixFallbacks: 5, suppressed: 3 }, 'and the minute starts over');
  assert.equal(rootReads(), 3);
});

test('the per-shard cap holds when the root keeps changing: a changed root does not reset a shard\'s minute', async (t) => {
  quiet(t);
  const readable = buildSyntheticStore(OLD);
  corruptIndex(readable, 0, 0);
  let now = 0;
  const store = await openStore('memory://cap-changing', { store: churningRoot(readable), workers: 0, clock: () => now });
  const attempt = async () => {
    await assert.rejects(store.getRaw(0, 0, 0, 4), /checksum mismatch/);
    return store.stats.recoveries.rootRefetches;
  };
  assert.equal(await attempt(), 1);
  now = 59999;
  assert.equal(await attempt(), 1, 'the root differs each time, but this shard asked 59.999 s ago');
  now = MINUTE;
  assert.equal(await attempt(), 2);
  now = MINUTE + 1;
  assert.equal(await attempt(), 2);
  now = 2 * MINUTE;
  assert.equal(await attempt(), 3);
});

test('another shard may refetch within the minute when the first one brought new lengths', async (t) => {
  quiet(t);
  const readable = buildSyntheticStore(OLD);
  corruptIndex(readable, 0, 0);
  corruptIndex(readable, 1, 1);
  const now = 0;
  const store = await openStore('memory://cap-two', { store: churningRoot(readable), workers: 0, clock: () => now });
  await assert.rejects(store.getRaw(0, 0, 0, 4), /checksum mismatch/);
  await assert.rejects(store.getRaw(0, 1, 1, 4), /checksum mismatch/);
  assert.equal(store.stats.recoveries.rootRefetches, 2, 'the cap is per shard');
  assert.equal(store.stats.recoveries.suppressed, 0);
});

test('a root that brought nothing new is not asked again by other shards for a minute', async (t) => {
  quiet(t);
  const readable = buildSyntheticStore(OLD);
  corruptIndex(readable, 0, 0);
  corruptIndex(readable, 1, 1);
  let now = 0;
  const store = await openStore('memory://cap-quiet', { store: readable, workers: 0, clock: () => now });
  await assert.rejects(store.getRaw(0, 0, 0, 4), /checksum mismatch/);
  await assert.rejects(store.getRaw(0, 1, 1, 4), /checksum mismatch/);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 0, suffixFallbacks: 2, suppressed: 1 });
  now = MINUTE;
  await assert.rejects(store.getRaw(0, 1, 1, 4), /checksum mismatch/);
  assert.equal(store.stats.recoveries.rootRefetches, 2, 'a minute later it may be asked again');
});

test('an unreadable root costs one attempt per minute and the index is still read', async (t) => {
  const warn = quiet(t);
  const readable = buildSyntheticStore({ ...OLD });
  const broken = { get: async (key, options) => (key === '/zarr.json' && readable.log.some((c) => c.key === key) ? Promise.reject(new TypeError('Failed to fetch')) : readable.get(key, options)), getRange: (...args) => readable.getRange(...args) };
  const length = readable.files.get(shardKey(0, 0)).length;
  const root = readJson(readable.files, '/zarr.json');
  root.attributes.chronozarr.shard_bytes['0']['1/0/0'] = length - 100;
  readable.files.set('/zarr.json', enc(root));
  let now = 0;
  const store = await openStore('memory://unreadable', { store: broken, workers: 0, clock: () => now });
  await assertCell(store, 0, 0, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 0, suffixFallbacks: 1, suppressed: 0 });
  assert.ok(warn.mock.calls.some((c) => /cannot reload zarr\.json.*Failed to fetch/.test(c.arguments[0])));
});

// ---- what does not start a recovery ----

test('without shard_bytes there is no hint to go stale: a corrupt index fails at once', async (t) => {
  const readable = buildSyntheticStore({ ...OLD, shardBytes: false });
  corruptIndex(readable, 0, 0);
  const store = await openStore('memory://nohint', { store: readable, workers: 0 });
  await assert.rejects(store.getRaw(0, 0, 0, 4), /shard index checksum mismatch/);
  assert.deepEqual(store.stats.recoveries, RECOVERIES_NONE);
  assert.equal(readable.log.filter((c) => c.key === '/zarr.json').length, 1);
});

test('a server error on the index read is retried by the HTTP layer and not mistaken for a stale length', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const files = buildSyntheticStore(OLD).files;
  const fetch = filesFetch(files, { fail: ({ key, range }) => (key === shardKey(0, 0) && range ? 503 : null) });
  const store = await openStore('https://example.test/store', { fetch, workers: 0, retryDelaysMs: [] });
  await assert.rejects(store.getRaw(0, 0, 0, 4), /HTTP 503/);
  assert.deepEqual(store.stats.recoveries, RECOVERIES_NONE);
});

// ---- readers that are not HttpStore, and stats ----

test('a readable passed as `store` gets the root refetch with cache "reload" and nothing else does', async (t) => {
  const readable = buildSyntheticStore(OLD);
  const calls = [];
  const recording = {
    get: (key, options) => (calls.push({ key, options }), readable.get(key, options)),
    getRange: (key, range, options) => readable.getRange(key, range, options),
  };
  const store = await openStore('memory://recording', { store: recording, workers: 0 });
  assert.equal(calls.find((c) => c.key === '/zarr.json').options.cache, undefined, 'the first read of the root is an ordinary one');
  calls.length = 0;
  const length = readable.files.get(shardKey(0, 0)).length;
  // Make the held length stale by growing the trailing shard in place and publishing the new root.
  for (const [key, bytes] of buildSyntheticStore(NEW).files) readable.files.set(key, bytes);
  assert.ok(length < readable.files.get(shardKey(0, 0)).length);
  await assertCell(store, 0, 0, 5);
  assert.deepEqual(store.stats.recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 });
  assert.equal(calls.length, 1, 'one get after open: the root refetch');
  assert.deepEqual([calls[0].key, calls[0].options.cache], ['/zarr.json', 'reload']);
});

test('recoveries are in the stats snapshot and the live object, and resetStats zeroes them', async (t) => {
  const site = await served(t, OLD);
  const store = await openStore(site.url, { workers: 0 });
  await site.publish(buildSyntheticStore(NEW).files);
  await assertCell(store, 0, 0, 5);
  assert.deepEqual(store.stats().recoveries, { rootRefetches: 1, retried: 1, suffixFallbacks: 0, suppressed: 0 });
  assert.deepEqual({ ...store.stats.recoveries }, store.stats().recoveries);
  const live = store.stats.recoveries;
  store.resetStats();
  assert.deepEqual(store.stats().recoveries, RECOVERIES_NONE);
  assert.equal(store.stats.recoveries, live, 'the same live object');
});

test('closing a stale reader cancels a hanging root refresh during append recovery', async () => {
  const oldFiles = buildSyntheticStore(OLD).files;
  const grownFiles = buildSyntheticStore(NEW).files;
  const plain = filesFetch(oldFiles);
  const grown = filesFetch(grownFiles);
  let appended = false;
  let refreshSignal;
  let release;
  let started;
  const refreshing = new Promise(resolve => { started = resolve; });
  const fetch = request => {
    if (request.cache === 'reload') {
      refreshSignal = request.signal;
      return new Promise((resolve, reject) => {
        release = () => resolve(new Response(grownFiles.get('/zarr.json')));
        request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        started();
      });
    }
    return (appended ? grown : plain)(request);
  };
  const store = await openStore('https://example.test/store', { fetch, workers: 0 });
  appended = true;
  const pending = store.getRaw(0, 0, 0, 5).catch(error => error.name);
  await refreshing;
  try {
    store.close();
    assert.equal(refreshSignal.aborted, true);
    assert.equal(await pending, 'AbortError');
    assert.equal(store.cacheInfo().bytes, 0);
  } finally { release(); }
});
