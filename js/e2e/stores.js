// The synthetic stores the browser tests open, and the writer that puts one into a directory the static server
// can serve. Each store is generated in memory by js/support/synthetic-store.js, so the tests never depend on
// data/ and the expected values of any pixel are the `values` function that built it.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSyntheticStore, defaultValues } from '../support/synthetic-store.js';

/** Level pixels left of this column hold the store's nodata value: the viewer paints them as background. */
const NODATA_COLUMNS = 6;

const withNodataColumns = (dtype, nodataValue) => {
  const values = defaultValues(dtype);
  return (t, b, y, x, lod = 0) => (x < NODATA_COLUMNS ? nodataValue : values(t, b, y, x, lod));
};

/** Pixel values vary by up to 120 around the smooth default. */
const wobbled = (nodataValue) => {
  const values = withNodataColumns('uint16', nodataValue);
  return (t, b, y, x, lod = 0) => {
    const value = values(t, b, y, x, lod);
    return value === nodataValue ? value : value + (((x * 3 + y + t * 5) % 7) - 3) * 40;
  };
};

/** Sentinel-2 band names in file order: blue, green, red, nir. */
const S2_BANDS = ['B02', 'B03', 'B04', 'B08'];
const ALL_PRODUCTS = ['True color', 'False color', 'NDVI', 'NDWI', 'Water', 'Single band'];
const BASE = { height: 200, width: 200, chunk: 128, nTime: 6, sharded: true, nLevels: 2, consolidated: true };
const GEOREFERENCE = [10, 0, 500000, 0, -10, 4000000];

/**
 * name -> { dtype, spec, enabledProducts } where `spec` is the argument of buildSyntheticStore (its `values` is
 * the truth the tests compare the screen and the sidebar with) and `enabledProducts` the product buttons that
 * must be enabled, in button order.
 */
export const STORES = {
  // True-value sharded Sentinel-2 reflectance.
  u16_sharded: {
    dtype: 'uint16',
    spec: { ...BASE, nBand: 4, bands: S2_BANDS, nodata: 0, transform: GEOREFERENCE, values: wobbled(0) },
    enabledProducts: ALL_PRODUCTS,
  },
  // No temporal encoding, one file per chunk.
  u16_plain: {
    dtype: 'uint16',
    spec: { ...BASE, nTime: 4, sharded: false, nBand: 4, bands: S2_BANDS, nodata: 0, transform: GEOREFERENCE, values: wobbled(0) },
    enabledProducts: ALL_PRODUCTS,
  },
  // Display-ready 8-bit true-value RGB.
  u8_rgb: {
    dtype: 'uint8',
    spec: {
      ...BASE,
      nBand: 3,
      specVersion: '0.3.0',
      nodata: 0,
      bandObjects: [{ name: 'r', common_name: 'red', scale: 1 }, { name: 'g', common_name: 'green', scale: 1 }, { name: 'b', common_name: 'blue', scale: 1 }],
      values: withNodataColumns('uint8', 0),
    },
    enabledProducts: ['True color', 'Single band'],
  },
  i16_band: {
    dtype: 'int16',
    spec: {
      ...BASE,
      nBand: 1,
      specVersion: '0.3.0',
      nodata: -9999,
      bandObjects: [{ name: 'elev', units: 'm', scale: 1 }],
      values: withNodataColumns('int16', -9999),
    },
    enabledProducts: ['Single band'],
  },
  // NaN is the nodata of float data.
  f32_band: {
    dtype: 'float32',
    spec: {
      ...BASE,
      nBand: 1,
      specVersion: '0.3.0',
      nodata: null,
      bandObjects: [{ name: 'depth', units: 'm', scale: 2, offset: -1 }],
      values: withNodataColumns('float32', NaN),
    },
    enabledProducts: ['Single band'],
  },
  // A mask variable (1 valid, 0 invalid) at every level; see maskValue in synthetic-store.js for the pattern.
  u16_mask: {
    dtype: 'uint16',
    spec: { ...BASE, nBand: 4, bands: S2_BANDS, specVersion: '0.3.0', nodata: 0, mask: true, transform: GEOREFERENCE, values: wobbled(0) },
    enabledProducts: ALL_PRODUCTS,
  },
  // 1792 x 1024 pixels x 4 bands: a level-0 frame of 14.7 MB that takes over a second at the bandwidth the viewer
  // assumes before it has measured any, so the viewer stages it (a coarse level first). One file per chunk.
  coarse: {
    dtype: 'uint16',
    spec: { nTime: 2, nBand: 4, height: 1024, width: 1792, chunk: 512, sharded: false, nLevels: 3, bands: S2_BANDS, consolidated: true, nodata: 0 },
    enabledProducts: ALL_PRODUCTS,
  },
};

/** Value stored at (t, band, level pixel y, x) of a store, wrapped into the dtype the way the writer stores it. */
export function storedValue(name, t, band, y, x, lod = 0) {
  const { dtype, spec } = STORES[name];
  const values = spec.values ?? defaultValues(dtype);
  const Typed = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array }[dtype];
  return Typed.of(values(t, band, y, x, lod))[0];
}

/** Write the store `name` as a directory tree under `rootDir/name`. */
export async function writeStore(rootDir, name) {
  const { dtype, spec } = STORES[name];
  for (const [key, bytes] of buildSyntheticStore({ dtype, ...spec }).files) {
    const file = path.join(rootDir, name, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
