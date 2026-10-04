import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../chronozarr/decoder.js';
import { CONVENTIONS } from '../chronozarr/metadata.js';
import { buildSyntheticStore } from '../support/synthetic-store.js';

const spec = { nTime: 3, nBand: 2, height: 40, width: 33, chunk: 32, nLevels: 2, sharded: false, mask: true, coverage: true, levelsMirror: true };
const text = new TextEncoder();
function edit(readable, path, change) {
  const meta = JSON.parse(new TextDecoder().decode(readable.files.get(path)));
  change(meta);
  readable.files.set(path, text.encode(JSON.stringify(meta)));
}
const open = (readable) => openStore('memory://metadata', { store: readable, workers: 0 });

test('literal convention registrations and canonical geometry open without coordinate or group reads', async () => {
  const readable = buildSyntheticStore(spec);
  const store = await open(readable);
  assert.equal(store.crs, 'EPSG:32631');
  assert.deepEqual(store.transform, [10, 0, 0, 0, -10, 0]);
  assert.deepEqual(store.levels[1].transform, [20, 0, 0, 0, -20, 0]);
  assert.equal(store.hasMask, true);
  assert.equal(store.hasCoverage, true);
  assert.ok(readable.log.every(({key}) => key === '/zarr.json' || /\/(data|mask|coverage)\/zarr.json$/.test(key)));
  assert.equal(store.attrs.volatility_path, undefined);
  for (const [name, registration] of Object.entries(CONVENTIONS)) {
    assert.equal(registration.schema_url, `https://raw.githubusercontent.com/zarr-conventions/${name}/refs/tags/v0.1/schema.json`);
    assert.equal(registration.spec_url, `https://github.com/zarr-conventions/${name}/blob/v0.1/README.md`);
  }
});

for (const [label, path, mutate, reason] of [
  ['missing multiscales registration', '/zarr.json', m => m.attributes.zarr_conventions.pop(), /multiscales registration/],
  ['commit registration URL', '/0/data/zarr.json', m => m.attributes.zarr_conventions[0].spec_url = 'https://github.com/zarr-conventions/proj/blob/deadbeef/README.md', /literal v0.1/],
  ['legacy discovery', '/zarr.json', m => m.attributes.multiscales = [{datasets:[{path:'0'}]}], /multiscales.layout/],
  ['level gap', '/zarr.json', m => m.attributes.multiscales.layout[1].asset = '2', /consecutive level groups/],
  ['wrong relative scale', '/zarr.json', m => m.attributes.multiscales.layout[1].transform.scale = [3,3], /scale \[2,2\]/],
  ['rotated grid', '/0/data/zarr.json', m => m.attributes['spatial:transform'][1] = 1, /north-up/],
  ['non EPSG', '/zarr.json', m => m.attributes.chronozarr.crs = 'PROJ:+proj=utm', /EPSG/],
  ['CRS disagreement', '/0/data/zarr.json', m => m.attributes['proj:code'] = 'EPSG:32718', /proj:code disagrees/],
  ['point registration', '/0/data/zarr.json', m => m.attributes['spatial:registration'] = 'point', /pixel-registered/],
  ['mirror geometry disagreement', '/zarr.json', m => m.attributes.chronozarr.levels[0].transform[2] = 42, /mirror transform/],
  ['band-name disagreement', '/zarr.json', m => m.attributes.chronozarr.band_names.reverse(), /band_names disagrees/],
  ['grid disagreement', '/zarr.json', m => m.attributes.chronozarr.levels[0].grid = [99,99], /grid mirror/],
  ['plane geometry disagreement', '/0/mask/zarr.json', m => m.attributes['spatial:transform'][2] = 1, /auxiliary geometry/],
  ['missing dimension names', '/0/data/zarr.json', m => delete m.dimension_names, /dimension names/],
  ['non-square chunks', '/0/data/zarr.json', m => m.chunk_grid.configuration.chunk_shape[3] = 16, /square/],
  ['wrong key encoding', '/0/data/zarr.json', m => m.chunk_key_encoding.name = 'v2', /chunk_key_encoding/],
  ['unknown storage extension', '/0/data/zarr.json', m => m.storage_transformers = [{name:'encoded_measurements'}], /unsupported storage_transformers/],
  ['unknown mandatory field', '/zarr.json', m => m.future_encoding = {must_understand:true}, /unsupported required Zarr extension/],
]) {
  test(`v0.3 refuses ${label}`, async () => {
    const readable = buildSyntheticStore(spec);
    edit(readable, path, mutate);
    await assert.rejects(open(readable), reason);
    assert.ok(readable.log.every(({key}) => key.endsWith('/zarr.json')), 'no measurements returned or fetched');
  });
}

test('ignorable Zarr extensions leave ordinary values unchanged', async () => {
  const readable = buildSyntheticStore(spec);
  edit(readable, '/zarr.json', m => m.future_display = {must_understand:false});
  const store = await open(readable);
  assert.equal((await store.getCell(0, 0, 0, 1)).data[0], 1040);
});

test('canonical metadata discovers levels and names with the optional reader mirrors absent', async () => {
  const readable = buildSyntheticStore({...spec, levelsMirror:false, consolidated:true});
  edit(readable, '/zarr.json', m => delete m.attributes.chronozarr.band_names);
  const store = await open(readable);
  assert.equal(readable.log.length, 1);
  assert.deepEqual(store.bands, ['B0', 'B1']);
  assert.equal(store.levels[1].resolution, 20);
});
