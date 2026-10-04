// The viewer's product and chart logic against stores opened by the real reader, not hand-made band lists: the
// metadata a store declares is what decides the products, the conversion to physical values and how it is shown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, samplePixelFrom } from '../chronozarr/decoder.js';
import { buildSyntheticStore, coverageValue, maskValue } from '../support/synthetic-store.js';
import { buildSeries, gapFilledTimes, seriesSpecs, validAt, windowPixels } from '../demo/chart.js';
import { describePixel, displayMode, inputConversion, nodataToCompare, normalizeBands, percentileRange, resolveProducts, toPhysical } from '../shared/products.js';

const base = { nTime: 6, height: 40, width: 40, chunk: 32,  sharded: true };

async function open(spec) {
  const store = await openStore('memory://store', { store: buildSyntheticStore(spec), workers: 0 });
  const bands = normalizeBands(store.attrs.bands);
  return { store, bands, products: Object.fromEntries(resolveProducts(bands).map((p) => [p.id, p])) };
}

test('an 8-bit RGB store: true color from the common names, shown as it is, values unconverted', async () => {
  const values = (t, b, y, x) => [200 - x, 100 + y, 30 + t][b];
  const { store, bands, products } = await open({
    ...base,
    nBand: 3,
    dtype: 'uint8',
    encoding: 'none',
    nodata: null,
    specVersion: '0.3.0',
    values,
    bandObjects: [{ name: 'r', common_name: 'red', scale: 1 }, { name: 'g', common_name: 'green', scale: 1 }, { name: 'b', common_name: 'blue', scale: 1 }],
  });
  assert.equal(store.dtype, 'uint8');
  assert.equal(products.true_color.available, true);
  assert.deepEqual(products.true_color.indices, [0, 1, 2]);
  for (const id of ['false_color', 'ndvi', 'ndwi', 'water']) assert.equal(products[id].available, false, id);
  assert.deepEqual(products.ndvi.missing, ['nir']);
  assert.deepEqual(displayMode(products.true_color, bands, 0, store.dtype), { mode: 'linear', fixed: true, range: [0, 255] });
  assert.deepEqual(inputConversion(products.true_color, bands, 0), { unitScale: [1, 1, 1], unitDivisor: [0, 0, 0], unitOffset: [0, 0, 0] });

  await store.getRaw(0, 0, 0, 2);
  const pixel = store.samplePixel(0, 0, 0, 2, 5, 7);
  assert.deepEqual([...pixel], [195, 107, 32], 'the stored bytes are the display values');
  const described = describePixel(pixel, bands, store.nodata);
  assert.deepEqual(described.bands.map((b) => b.value), [195, 107, 32], 'scale 1: physical equals stored');
  assert.equal(described.hasNdvi, false);
});

test('a float32 single-band store: only the single band, with an adjustable linear stretch measured from the data', async () => {
  const values = (t, b, y, x) => (x < 4 ? NaN : x + y / 100 + t);
  const { store, bands, products } = await open({
    ...base,
    nBand: 1,
    dtype: 'float32',
    encoding: 'none',
    nodata: null,
    specVersion: '0.3.0',
    values,
    bandObjects: [{ name: 'depth', scale: 2, offset: -1, units: 'm' }],
  });
  assert.deepEqual(resolveProducts(bands).filter((p) => p.available).map((p) => p.id), ['band']);
  assert.deepEqual(displayMode(products.band, bands, 0, store.dtype), { mode: 'linear', fixed: false, range: null });
  const cell = await store.getCell(0, 0, 0, 1);
  const physical = [];
  for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) physical.push(toPhysical(cell.data[y * cell.chunkWidth + x], bands[0]));
  assert.ok(physical.some(Number.isNaN), 'the NaN pixels are in the data');
  const [lo, hi] = percentileRange(physical);
  // Valid pixels (x from 4 to 31) at t = 1 are 2 * (x + y / 100 + 1) - 1, between 9 and 63.62.
  assert.ok(lo >= 9 - 1e-6 && hi <= 63.63 && lo < hi, `range ${lo}..${hi} comes from the valid pixels only`);
  const [series] = buildSeries(seriesSpecs(products.band, bands, 0), [{ pixels: [store.samplePixel(0, 0, 0, 1, 10, 3)] }, { pixels: [Float32Array.of(NaN)] }], store.nodata);
  assert.equal(series.label, 'depth (m)');
  assert.ok(Math.abs(series.values[0] - (2 * (10 + 0.03 + 1) - 1)) < 1e-5);
  assert.equal(series.values[1], null, 'NaN is a gap');
});

test('a v0.3 store with explicit reflectance scales supports every product', async () => {
  const { store, bands, products } = await open({ ...base, nBand: 4, bands: ['B02', 'B03', 'B04', 'B08'], values: (t, b, y, x) => 1000 + 100 * b + x + t });
  assert.equal(store.attrs.spec_version, '0.3.0');
  assert.ok(Object.values(products).every((p) => p.available));
  assert.deepEqual(products.true_color.indices, [2, 1, 0]);
  assert.deepEqual(products.ndvi.indices.slice(0, 2), [3, 2]);
  const conversion = inputConversion(products.ndvi, bands, 0);
  assert.deepEqual(conversion.unitDivisor, [10000, 10000, 0]);
  assert.equal(displayMode(products.true_color, bands, 0, store.dtype).mode, 'reflectance');
  await store.getRaw(0, 0, 0, 0);
  const described = describePixel(store.samplePixel(0, 0, 0, 0, 3, 0), bands, store.nodata);
  assert.equal(described.bands[2].value, 1203 / 10000);
  assert.equal(described.bands[2].reflectance, true);
  assert.ok(Math.abs(described.ndvi - (0.1303 - 0.1203) / (0.1303 + 0.1203)) < 1e-12);
});

test('band order and names come from the store: nir listed first, common names on bands called something else', async () => {
  const { bands, products } = await open({
    ...base,
    nBand: 4,
    specVersion: '0.3.0',
    bandObjects: [
      { name: 'swir_ish', common_name: 'nir', scale: 1e-4 },
      { name: 'B02', common_name: 'red', scale: 1e-4 },
      { name: 'B03', common_name: 'green', scale: 1e-4 },
      { name: 'B04', common_name: 'blue', scale: 1e-4 },
    ],
  });
  assert.deepEqual(products.true_color.indices, [1, 2, 3], 'red is the band that says so, not B04');
  assert.deepEqual(products.false_color.indices, [0, 1, 2]);
  assert.deepEqual(inputConversion(products.ndwi, bands, 0).unitDivisor, [10000, 10000, 0]);
});

test('coverage from the store marks the gap-filled timesteps of a charted pixel', async () => {
  const { store, bands, products } = await open({
    ...base,
    nBand: 4,
    coverage: true,
    specVersion: '0.3.0',
    bandObjects: ['B02', 'B03', 'B04', 'B08'].map((name) => ({ name, scale: 1e-4 })),
    values: (t, b, y, x) => 1000 + 100 * b + t * 10 + x,
  });
  assert.equal(store.hasCoverage, true);
  const [x, y] = [5, 4];
  const readings = [];
  const coverage = [];
  for (let t = 0; t < store.times.length; t++) {
    const data = await store.getRaw(0, 0, 0, t);
    readings.push({ pixels: windowPixels(x, y, 40, 40, 0).map(([px, py]) => samplePixelFrom(data, store.levels[0], px, py)) });
    coverage.push((await store.getCoverage(0, 0, 0, t))[y * store.levels[0].chunkWidth + x]);
  }
  assert.deepEqual(coverage, Array.from({ length: 6 }, (_, t) => coverageValue(t, y, x)), 'the coverage chunk of each timestep, read at the pixel');
  const series = buildSeries(seriesSpecs(products.ndvi, bands, 0), readings, store.nodata);
  const gaps = gapFilledTimes(series[0].values, coverage);
  assert.deepEqual(gaps, coverage.flatMap((c, t) => (c === 0 ? [t] : [])));
  assert.ok(gaps.length > 0, 'the fixture has gap-filled timesteps at this pixel');
  assert.equal(store.peekCoverage(0, 0, 0, 0) instanceof Uint8Array, true, 'the viewer paints the overlay from the cached coverage chunk');
});

test('a masked store: the chart and the readout follow the mask chunk the reader returns, and the declared nodata value is ignored', async () => {
  const [x, y] = [3, 2];
  // At (3, 2) the mask is 0 where (t + 2*3 + 3*5) % 4 === 0, i.e. t = 3 of 0..5; its stored values are genuinely 0 at every other timestep.
  const values = (t, b, py, px) => (px === x && py === y ? 0 : 1000 + 100 * b + t * 10 + px);
  const { store, bands, products } = await open({
    ...base,
    nBand: 4,
    mask: true,
    nodata: 0,
    specVersion: '0.3.0',
    bandObjects: ['B02', 'B03', 'B04', 'B08'].map((name) => ({ name, scale: 1e-4 })),
    values,
  });
  assert.equal(store.hasMask, true);
  assert.equal(store.nodata, 0, 'the store declares nodata 0 as well');
  const level = store.levels[0];
  const window = windowPixels(x, y, 40, 40, 0);
  const readings = [];
  const masks = [];
  for (let t = 0; t < store.times.length; t++) {
    const [data, mask] = await Promise.all([store.getRaw(0, 0, 0, t), store.getMask(0, 0, 0, t)]);
    masks.push(mask[y * level.chunkWidth + x]);
    readings.push({ pixels: window.map(([px, py]) => samplePixelFrom(data, level, px, py)), valid: validAt(mask, level.chunkWidth, window) });
  }
  assert.deepEqual(masks, Array.from({ length: 6 }, (_, t) => maskValue(t, y, x)), 'the mask chunk of each timestep');
  assert.ok(masks.includes(0) && masks.includes(1), 'the fixture is masked at some timesteps and valid at others');
  const nodata = nodataToCompare(store);
  assert.equal(nodata, null, 'with a mask nothing is compared against nodata');
  assert.equal(nodataToCompare({ hasMask: false, nodata: 0 }), 0);
  assert.equal(nodataToCompare({ hasMask: false, nodata: null }), null);
  const [red] = buildSeries(seriesSpecs(products.true_color, bands, 0), readings, nodata);
  assert.deepEqual(red.values, masks.map((m) => (m === 0 ? null : 0)), 'a gap where masked, the stored 0 where valid');
  const [wrong] = buildSeries(seriesSpecs(products.true_color, bands, 0), readings.map(({ pixels }) => ({ pixels })), store.nodata);
  assert.ok(wrong.values.every((v) => v === null), 'comparing against nodata as well would blank every timestep');

  const at = (t) => describePixel(readings[t].pixels[0], bands, nodata, masks[t]);
  const maskedT = masks.indexOf(0);
  const validT = masks.indexOf(1);
  assert.equal(at(maskedT).valid, false);
  assert.ok(at(maskedT).bands.every((b) => b.value === null));
  assert.equal(at(validT).valid, true);
  assert.deepEqual(at(validT).bands.map((b) => b.value), [0, 0, 0, 0], 'a valid pixel holding the declared nodata value is data');
});
