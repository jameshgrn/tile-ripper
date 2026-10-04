import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../chronozarr/decoder.js';
import { buildSyntheticStore, coverageValue, defaultValues, maskValue } from '../support/synthetic-store.js';
import { filesFetch } from '../support/files-fetch.js';

const URL_BASE = 'https://example.test/store';

function openHttp(spec, options = {}, fetchOptions = {}) {
  const readable = buildSyntheticStore(spec);
  const log = [];
  const fetch = filesFetch(readable.files, { log, ...fetchOptions });
  return openStore(URL_BASE, { fetch, workers: 0, ...options }).then((store) => ({ store, log, files: readable.files }));
}

/** Compare every pixel of every cell of a level at timestep t with the source values. */
async function assertLossless(store, spec, t, lod = 0) {
  const values = spec.values ?? defaultValues(spec.dtype ?? 'uint16');
  const level = store.levels[lod];
  for (let row = 0; row < level.gridRows; row++) {
    for (let col = 0; col < level.gridCols; col++) {
      const cell = await store.getCell(lod, row, col, t);
      assert.ok(cell.data instanceof { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array }[store.dtype]);
      for (let b = 0; b < level.nBand; b++) {
        for (let y = 0; y < cell.height; y++) {
          for (let x = 0; x < cell.width; x++) {
            const want = values(t, b, row * level.chunkHeight + y, col * level.chunkWidth + x, lod);
            assert.equal(cell.data[(b * cell.chunkHeight + y) * cell.chunkWidth + x], want, `lod ${lod} t${t} r${row} c${col} b${b} y${y} x${x}`);
          }
        }
      }
    }
  }
}

const base = { nTime: 5, nBand: 2, height: 40, width: 33, chunk: 32,  sharded: true };

// ---- dtypes and modular residuals ----

test('uint16 full-range values remain exact without reconstruction', async () => {
  // Adjacent timesteps span nearly the full uint16 range.
  const values = (t, b, y, x) => (t % 2 === 0 ? 100 + b + x : 60000 + b + x + y);
  const spec = { ...base, nTime: 5, values };
  const store = await openStore('memory://wrap', { store: buildSyntheticStore(spec), workers: 0 });
  assert.equal(store.dtype, 'uint16');
  assert.equal(store.attrs.dtype, 'uint16');
  for (let t = 0; t < 5; t++) await assertLossless(store, spec, t);
  const raw = await store.getRaw(0, 0, 0, 1);
  assert.equal(raw[0], 60000, 'the raw chunk holds true values');
  assert.equal(store.samplePixel(0, 0, 0, 1, 3, 2)[1], 60000 + 1 + 2 + 3 - 0, 'samplePixel adds modulo 2^16 as well');
});

test('uint8 stores return true values in Uint8Array', async () => {
  const values = (t, b, y, x) => (t % 2 === 0 ? 5 + x : 250 - x + b);
  const spec = { ...base, dtype: 'uint8', values };
  const store = await openStore('memory://u8', { store: buildSyntheticStore(spec), workers: 0 });
  assert.equal(store.dtype, 'uint8');
  assert.equal(store.levels[0].chunkBytes, 2 * 32 * 32, 'one byte per element');
  for (let t = 0; t < 5; t++) await assertLossless(store, spec, t);
  assert.ok(store.peekRaw(0, 0, 0, 3) instanceof Uint8Array);
  assert.ok(store.samplePixel(0, 0, 0, 3, 4, 0) instanceof Uint8Array);
});

test('int16 and float32 stores are read as stored (no temporal encoding)', async () => {
  for (const dtype of ['int16', 'float32']) {
    const spec = { ...base, dtype, nodata: dtype === 'int16' ? -32768 : null };
    const store = await openStore('memory://typed', { store: buildSyntheticStore(spec), workers: 0 });
    assert.equal(store.dtype, dtype);
    for (let t = 0; t < 5; t++) await assertLossless(store, spec, t);
    assert.equal(store.levels[0].chunkBytes, 2 * 32 * 32 * (dtype === 'int16' ? 2 : 4));
  }
});

test('the fill value of a missing chunk is the array fill_value, typed', async () => {
  const spec = { ...base, dtype: 'int16', nodata: -9999, sharded: false };
  const readable = buildSyntheticStore(spec);
  readable.files.delete('/0/data/c/2/0/1/0');
  const store = await openStore('memory://fill', { store: readable, workers: 0 });
  const raw = await store.getRaw(0, 1, 0, 2);
  assert.ok(raw instanceof Int16Array);
  assert.ok(raw.every((v) => v === -9999));
  assert.equal(store.nodata, -9999);
});

test('temporal interpretation attributes are refused before returning measurements', async () => {
  const readable = buildSyntheticStore(base);
  const root = JSON.parse(new TextDecoder().decode(readable.files.get('/zarr.json')));
  root.attributes.chronozarr.temporal = { encoding: 'star-delta' };
  readable.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
  await assert.rejects(openStore('memory://bad', { store: readable, workers: 0 }), /outside the v0.3 baseline.*chronozarr convert/);
});

test('an unsupported dtype names itself', async () => {
  const readable = buildSyntheticStore(base);
  const meta = JSON.parse(new TextDecoder().decode(readable.files.get('/0/data/zarr.json')));
  meta.data_type = 'float64';
  readable.files.set('/0/data/zarr.json', new TextEncoder().encode(JSON.stringify(meta)));
  await assert.rejects(openStore('memory://f64', { store: readable, workers: 0 }), /dtype is float64, expected one of uint8,uint16,int16,float32/);
});

// ---- temporal encoding "none" ----

test('every v0.3 timestep is one data-chunk read', async () => {
  const spec = { ...base, specVersion: '0.3.0' };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://none', { store: readable, workers: 0 });
  assert.equal(store.attrs.spec_version, '0.3.0');
  const before = readable.log.length;
  await store.getCell(0, 0, 0, 3);
  assert.equal(readable.log.slice(before).filter((c) => c.range && 'offset' in c.range).length, 1, 'one inner-chunk read (plus the shard index), no anchor');
  const cell = await store.getCell(0, 0, 0, 3);
  assert.equal(cell.data, store.peekRaw(0, 0, 0, 3), 'the cached array itself');
  for (let t = 0; t < 5; t++) await assertLossless(store, spec, t);
});

test('only numeric v0.3.x versions are accepted; every rejection points to conversion', async () => {
  for (const version of ['0.1.0', '0.2.0', '1.0.0', '0.4.0', '0.3.x', '0.3.0-extra', undefined]) {
    const readable = buildSyntheticStore(base);
    const root = JSON.parse(new TextDecoder().decode(readable.files.get('/zarr.json')));
    root.attributes.chronozarr.spec_version = version;
    readable.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
    await assert.rejects(openStore('memory://version', { store: readable, workers: 0 }), /unsupported spec_version.*chronozarr convert/);
    assert.equal(readable.log.length, 1, 'reject before fetching arrays');
  }
  assert.ok(await openStore('memory://patch', { store: buildSyntheticStore({...base, specVersion: '0.3.7'}), workers: 0 }));
});

test('pixels_per_tile is ignored whatever its value; the cell size is the chunk shape', async () => {
  const readable = buildSyntheticStore({ ...base, chunk: 32 });
  const root = JSON.parse(new TextDecoder().decode(readable.files.get('/zarr.json')));
  root.attributes.multiscales.layout[0].pixels_per_tile = 256;
  readable.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
  const store = await openStore('memory://tile', { store: readable, workers: 0 });
  assert.equal(store.levels[0].chunkWidth, 32);
  assert.equal(store.levels[0].chunkHeight, 32);
});

// ---- bands ----

test('v0.3 rejects string band descriptions', async () => {
  const readable = buildSyntheticStore(base);
  const root = JSON.parse(new TextDecoder().decode(readable.files.get('/zarr.json')));
  root.attributes.chronozarr.bands = ['B04', 'B08'];
  readable.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
  await assert.rejects(openStore('memory://bands', {store: readable, workers: 0}), /bands must contain objects/);
});

test('v0.3 band objects keep their fields and default scale 1 and offset 0', async () => {
  const bandObjects = [
    { name: 'red', common_name: 'red', units: 'DN' },
    { name: 'nir', common_name: 'nir', scale: 0.0001, offset: -0.1, units: 'reflectance' },
  ];
  const store = await openStore('memory://v02', { store: buildSyntheticStore({ ...base, specVersion: '0.3.0', bandObjects }), workers: 0 });
  assert.deepEqual(store.bands, ['red', 'nir'], 'store.bands stays the list of names');
  assert.deepEqual(store.attrs.band_names, ['red', 'nir']);
  assert.deepEqual(store.attrs.bands, [
    { name: 'red', common_name: 'red', units: 'DN', scale: 1, offset: 0 },
    { name: 'nir', common_name: 'nir', scale: 0.0001, offset: -0.1, units: 'reflectance' },
  ]);
  assert.equal(store.attrs.spec_version, '0.3.0');
});

test('explicit reflectance bands retain their scales', async () => {
  const store = await openStore('memory://v02s', { store: buildSyntheticStore({ ...base, specVersion: '0.3.0' }), workers: 0 });
  assert.deepEqual(store.attrs.bands.map((b) => [b.name, b.scale, b.offset]), [['B0', 1e-4, 0], ['B1', 1e-4, 0]]);
});

test('nodata is a number or null; provenance and flags are exposed', async () => {
  const provenance = { sources: ['sentinel-2-l2a'], composite: 'monthly median', gap_fill: 'none' };
  const withNull = await openStore('memory://null', { store: buildSyntheticStore({ ...base, specVersion: '0.3.0', nodata: null, provenance }), workers: 0 });
  assert.equal(withNull.nodata, null);
  assert.equal(withNull.attrs.nodata, null);
  assert.deepEqual(withNull.attrs.provenance, provenance);
  assert.equal(withNull.hasMask, false);
  assert.equal(withNull.hasCoverage, false);
  assert.equal(withNull.attrs.hasMask, false);
  const plain = await openStore('memory://plain', { store: buildSyntheticStore(base), workers: 0 });
  assert.equal(plain.nodata, 0);
  assert.equal(plain.attrs.provenance, null);
});

// ---- mask and coverage ----

test('mask and coverage chunks are read per level, typed uint8 over the padded chunk', async () => {
  const spec = { ...base, specVersion: '0.3.0', mask: true, coverage: true, nLevels: 2 };
  const store = await openStore('memory://aux', { store: buildSyntheticStore(spec), workers: 0 });
  assert.equal(store.hasMask, true);
  assert.equal(store.hasCoverage, true);
  assert.equal(store.attrs.hasMask, true);
  assert.equal(store.peekMask(0, 0, 0, 1), undefined, 'not loaded yet');
  for (const lod of [0, 1]) {
    const level = store.levels[lod];
    for (let t = 0; t < 5; t += 2) {
      for (let row = 0; row < level.gridRows; row++) {
        for (let col = 0; col < level.gridCols; col++) {
          const mask = await store.getMask(lod, row, col, t);
          const coverage = await store.getCoverage(lod, row, col, t);
          assert.ok(mask instanceof Uint8Array && coverage instanceof Uint8Array);
          assert.equal(mask.length, 32 * 32);
          const { width, height } = store.cellExtent(lod, row, col);
          for (let y = 0; y < height; y += 3) {
            for (let x = 0; x < width; x += 4) {
              assert.equal(mask[y * 32 + x], maskValue(t, row * 32 + y, col * 32 + x, lod));
              assert.equal(coverage[y * 32 + x], coverageValue(t, row * 32 + y, col * 32 + x, lod));
            }
          }
          assert.equal(store.peekMask(lod, row, col, t), mask);
          assert.equal(store.peekCoverage(lod, row, col, t), coverage);
        }
      }
    }
  }
});

test('stores without mask or coverage answer null everywhere', async () => {
  const store = await openStore('memory://noaux', { store: buildSyntheticStore({ ...base, specVersion: '0.3.0', coverage: true }), workers: 0 });
  assert.equal(store.hasMask, false);
  assert.equal(await store.getMask(0, 0, 0, 0), null);
  assert.equal(store.peekMask(0, 0, 0, 0), null);
  assert.equal(store.hasCoverage, true);
  assert.ok((await store.getCoverage(0, 0, 0, 0)) instanceof Uint8Array);
});

test('mask and coverage are found in consolidated metadata even without the root attributes', async () => {
  const readable = buildSyntheticStore({ ...base, specVersion: '0.3.0', mask: true, consolidated: true });
  const root = JSON.parse(new TextDecoder().decode(readable.files.get('/zarr.json')));
  delete root.attributes.chronozarr.mask_variable;
  readable.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
  const store = await openStore('memory://consolidated-aux', { store: readable, workers: 0 });
  assert.equal(store.hasMask, true);
  assert.equal(readable.log.length, 1, 'one GET opens the store: everything came from consolidated metadata');
  assert.ok((await store.getMask(0, 0, 0, 2)) instanceof Uint8Array);
});

test('mask chunks of a sharded store with several time shards', async () => {
  const spec = { ...base, nTime: 7, shardTime: 3, specVersion: '0.3.0', mask: true };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://aux-shards', { store: readable, workers: 0 });
  const mask = await store.getMask(0, 1, 0, 6);
  assert.equal(mask[5 * 32 + 2], maskValue(6, 32 + 5, 2, 0));
  assert.ok(readable.files.has('/0/mask/c/2/1/0'), 'mask shard keys have no band index');
  assert.ok(readable.log.some((c) => c.key === '/0/mask/c/2/1/0'));
});

// ---- layout: levels mirror, shard_time, shard_bytes ----

test('the levels mirror spares the level-group read and supplies transform and resolution', async () => {
  const transform = [10, 0, 500000, 0, -10, 4000000];
  const spec = { ...base, nLevels: 2, specVersion: '0.3.0', transform, levelsMirror: true };
  const withMirror = await openHttp(spec);
  assert.deepEqual(withMirror.log.map((c) => c.key), ['/zarr.json', '/0/data/zarr.json', '/1/data/zarr.json'], 'no level group GET');
  assert.deepEqual(withMirror.store.transform, transform);
  assert.deepEqual(withMirror.store.levels.map((l) => l.resolution), [10, 20]);
  assert.deepEqual(withMirror.store.levels[1].transform, [20, 0, 500000, 0, -20, 4000000]);
  assert.deepEqual(withMirror.store.attrs.levels[1], { path: '1', resolution: 20, transform: [20, 0, 500000, 0, -20, 4000000], shape: [5, 2, 20, 17], grid: [1, 1] });

  const without = await openHttp({ ...spec, levelsMirror: false });
  assert.deepEqual(without.log.map((c) => c.key).sort(), ['/0/data/zarr.json', '/1/data/zarr.json', '/zarr.json'], 'canonical P/S supplies geometry without a level group read');
  assert.deepEqual(without.store.transform, transform);
  assert.deepEqual(without.store.levels.map((l) => l.resolution), [10, 20], 'derived from the level-0 affine');
  assert.deepEqual(without.store.levels[1].transform, [20, 0, 500000, 0, -20, 4000000]);
});

test('several shards along time: each timestep reads only its own shard', async () => {
  // Three timesteps per shard over eleven timesteps.
  const spec = { ...base, nTime: 11,  shardTime: 3, specVersion: '0.3.0' };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://shards', { store: readable, workers: 0 });
  for (const t of [0, 2, 3, 5, 7, 9, 10]) await assertLossless(store, spec, t);
  const shardKeys = new Set(readable.log.filter((c) => c.key.includes('/data/c/')).map((c) => c.key.split('/').slice(4, 6).join('/')));
  assert.deepEqual([...shardKeys].sort(), ['0/0', '1/0', '2/0', '3/0'], 'shards 0 to 3 along time');
  assert.ok(readable.files.has('/0/data/c/3/0/0/0'));
  assert.equal(readable.files.has('/0/data/c/4/0/0/0'), false);
  // t=9 needs exactly one chunk from shard 3.
  const fresh = await openStore('memory://shards2', { store: readable, workers: 0 });
  const before = readable.log.length;
  await fresh.getCell(0, 0, 0, 9);
  const chunkReads = readable.log.slice(before).filter((c) => c.range && 'offset' in c.range).map((c) => c.key);
  assert.deepEqual(chunkReads.sort(), ['/0/data/c/3/0/0/0']);
});

test('the last, partial time shard has a full-size index with empty entries', async () => {
  const spec = { ...base, nTime: 5, shardTime: 4 };
  const readable = buildSyntheticStore(spec);
  const store = await openStore('memory://partial', { store: readable, workers: 0 });
  await assertLossless(store, spec, 4);
  const lastShard = readable.files.get('/0/data/c/1/0/0/0');
  const index = readable.log.find((c) => c.key === '/0/data/c/1/0/0/0');
  assert.deepEqual(index.range, { suffixLength: 16 * 4 + 4 }, 'the index always has shard_time entries');
  assert.ok(lastShard.length > 16 * 4 + 4);
});

test('shard_bytes: the index is one bounded range, with no HEAD and no suffix range', async () => {
  const spec = { ...base, nTime: 7, shardTime: 4, specVersion: '0.3.0', shardBytes: true };
  const { store, log, files } = await openHttp(spec);
  await store.getRaw(0, 0, 0, 1);
  await store.getRaw(0, 1, 1, 6);
  const shardCalls = log.filter((c) => c.key.includes('/data/c/'));
  assert.equal(shardCalls.filter((c) => c.method === 'HEAD').length, 0, 'no HEAD');
  assert.ok(shardCalls.every((c) => /^bytes=\d+-\d+$/.test(c.range)), 'only bounded ranges (no preflight on a cross-origin host)');
  const first = files.get('/0/data/c/0/0/0/0').length;
  const indexBytes = 16 * 4 + 4;
  assert.equal(shardCalls[0].range, `bytes=${first - indexBytes}-${first - 1}`, 'exactly the last 68 bytes of the shard');
  assert.equal(shardCalls.length, 4, 'two cells x (index + chunk)');
});

test('without shard_bytes the index costs a HEAD, and a shard missing from shard_bytes falls back to it', async () => {
  const spec = { ...base, specVersion: '0.3.0', shardBytes: false };
  const plain = await openHttp(spec);
  await plain.store.getRaw(0, 0, 0, 1);
  assert.deepEqual(plain.log.filter((c) => c.key.includes('/data/c/')).map((c) => c.method), ['HEAD', 'GET', 'GET']);

  const partial = buildSyntheticStore({ ...spec, shardBytes: true });
  const root = JSON.parse(new TextDecoder().decode(partial.files.get('/zarr.json')));
  delete root.attributes.chronozarr.shard_bytes['0']['0/0/0'];
  partial.files.set('/zarr.json', new TextEncoder().encode(JSON.stringify(root)));
  const log = [];
  const fetch = filesFetch(partial.files, { log });
  const store = await openStore(URL_BASE, { fetch, workers: 0 });
  await store.getRaw(0, 0, 0, 1);
  await store.getRaw(0, 1, 0, 1);
  const byCell = (cell) => log.filter((c) => c.key.endsWith(`/data/c/0/0/${cell}`)).map((c) => c.method);
  assert.deepEqual(byCell('0/0'), ['HEAD', 'GET', 'GET'], 'unlisted shard: HEAD');
  assert.deepEqual(byCell('1/0'), ['GET', 'GET'], 'listed shard: bounded ranges only');
});

test('cold open of a grid of cells: 1 + 2 requests per cell with shard_bytes, 1 + 3 without', async () => {
  const grid = { nTime: 4, nBand: 2, height: 96, width: 96, chunk: 32,  sharded: true, consolidated: true, specVersion: '0.3.0' };
  const cells = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => [row, col]));
  const cold = async (spec) => {
    const { store } = await openHttp(spec);
    await Promise.all(cells.map(([row, col]) => store.getRaw(0, row, col, 0)));
    return store.stats.network.requests;
  };
  assert.equal(await cold({ ...grid, shardBytes: true }), 1 + 9 * 2);
  assert.equal(await cold({ ...grid, shardBytes: false }), 1 + 9 * 3);
});

test('a missing shard object decodes as fill_value, and its index read is not retried forever', async () => {
  const spec = { ...base, nTime: 6, shardTime: 3,  specVersion: '0.3.0', nodata: 7, omitShards: ['0/1/0/0'] };
  const store = await openStore('memory://omitted', { store: buildSyntheticStore(spec), workers: 0 });
  const raw = await store.getRaw(0, 0, 0, 4);
  assert.ok(raw.every((v) => v === 7));
  await assertLossless(store, spec, 1);
});

test('v0.3 exposes values and stable operational statistics: numbers, flags and stats shape', async () => {
  const spec = { ...base, nTime: 7,  bands: ['B04', 'B08'] };
  const store = await openStore('memory://v01-all', { store: buildSyntheticStore(spec), workers: 0 });
  assert.equal(store.dtype, 'uint16');
  assert.equal(store.hasMask, false);
  assert.equal(store.hasCoverage, false);
  for (let t = 0; t < 7; t++) await assertLossless(store, spec, t);
  const stats = store.stats();
  assert.deepEqual(Object.keys(stats), ['network', 'cache', 'loads', 'recoveries']);
  assert.deepEqual(Object.keys(stats.network).sort(), ['bytes', 'deduped', 'inflight', 'requests']);
  assert.deepEqual(stats.recoveries, { rootRefetches: 0, retried: 0, suffixFallbacks: 0, suppressed: 0 }, 'nothing to recover from in a store that did not change');
  for (const name of ['hits', 'misses', 'joins', 'evictions', 'decodedBytes', 'compressedBytes', 'speculativeBytes']) assert.equal(typeof stats.cache[name], 'number', name);
  assert.equal(store.stats.cache, store.stats.cache, 'stats.cache is one live object');
});
