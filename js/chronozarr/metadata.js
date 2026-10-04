// Parsing of chronozarr root attributes and Zarr v3 array metadata into the shapes the reader uses.
// No I/O: openStore fetches the JSON, this module validates and normalizes it.

export const DTYPES = {
  uint8: { Array: Uint8Array, bytes: 1 },
  uint16: { Array: Uint16Array, bytes: 2 },
  int16: { Array: Int16Array, bytes: 2 },
  float32: { Array: Float32Array, bytes: 4 },
};

const SUPPORTED_SPEC = /^0\.3\.\d+$/;
export const CONVENTIONS = Object.fromEntries([
  ['multiscales', 'd35379db-88df-4056-af3a-620245f8e347'],
  ['proj', 'f17cb550-5864-4468-aeb7-f3180cfb622f'],
  ['spatial', '689b58e2-cf7b-45e0-9fff-9cfc0883d6b4'],
].map(([name, uuid]) => [name, { name, uuid,
  schema_url: `https://raw.githubusercontent.com/zarr-conventions/${name}/refs/tags/v0.1/schema.json`,
  spec_url: `https://github.com/zarr-conventions/${name}/blob/v0.1/README.md`,
}]));

export function requireStore(condition, baseUrl, message) {
  if (!condition) throw new Error(`${baseUrl}: not a valid chronozarr store: ${message}`);
}

export function checkExtensions(meta, baseUrl) {
  const known = new Set(['zarr_format', 'node_type', 'attributes', 'consolidated_metadata', 'shape', 'data_type', 'chunk_grid', 'chunk_key_encoding', 'fill_value', 'codecs', 'dimension_names', 'storage_transformers']);
  for (const [key, value] of Object.entries(meta)) {
    requireStore(known.has(key) || value?.must_understand === false, baseUrl, `unsupported required Zarr extension ${key}`);
  }
  requireStore(!meta.storage_transformers?.length, baseUrl, 'unsupported storage_transformers; use chronozarr convert');
}

function registration(attrs, name, baseUrl) {
  const declared = attrs?.zarr_conventions?.find((c) => c.name === name);
  const expected = CONVENTIONS[name];
  requireStore(declared && Object.entries(expected).every(([key, value]) => declared[key] === value), baseUrl, `${name} registration must use the literal v0.1 UUID and URLs`);
}

/** Validate root discovery metadata before reading any measurements. */
export function parseRoot(root, baseUrl) {
  checkExtensions(root, baseUrl);
  requireStore(root.zarr_format === 3 && root.node_type === 'group', baseUrl, 'root must be a Zarr v3 group');
  const attrs = root.attributes;
  const cz = attrs?.chronozarr;
  requireStore(cz, baseUrl, 'root attributes have no "chronozarr" entry; use chronozarr convert');
  requireStore(typeof cz.spec_version === 'string' && SUPPORTED_SPEC.test(cz.spec_version), baseUrl, `unsupported spec_version ${cz.spec_version}; use chronozarr convert to convert this store to v0.3`);
  requireStore(!('temporal' in cz), baseUrl, 'temporal encoding is outside the v0.3 baseline; use chronozarr convert');
  requireStore(Array.isArray(cz.times) && cz.times.length > 0 && cz.times.every((t, i) => typeof t === 'string' && Number.isFinite(Date.parse(t)) && (i === 0 || Date.parse(t) > Date.parse(cz.times[i - 1]))), baseUrl, 'chronozarr.times must contain increasing ISO timestamps');
  requireStore(/^EPSG:[1-9]\d*$/.test(cz.crs), baseUrl, 'chronozarr.crs must be an EPSG code');
  requireStore(cz.nodata === null || Number.isFinite(cz.nodata), baseUrl, 'chronozarr.nodata must be a number or null');
  requireStore(cz.volatility_path === undefined || cz.volatility_path === 'volatility', baseUrl, 'volatility_path must equal volatility');
  for (const name of ['mask', 'coverage']) requireStore(cz[`${name}_variable`] === undefined || cz[`${name}_variable`] === name, baseUrl, `${name}_variable must equal ${name}`);
  registration(attrs, 'multiscales', baseUrl);
  requireStore(attrs.zarr_conventions.some((c) => c.name === 'chronozarr' && c.spec_url === 'https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md'), baseUrl, 'chronozarr registration is missing');
  const ms = attrs.multiscales;
  requireStore(ms && !Array.isArray(ms) && Array.isArray(ms.layout) && ms.layout.length > 0, baseUrl, 'multiscales.layout is missing');
  requireStore(ms.resampling_method === 'average', baseUrl, 'multiscales resampling_method must be average');
  const datasets = ms.layout.map((entry, lod) => {
    requireStore(entry.asset === String(lod), baseUrl, 'multiscales assets must be consecutive level groups');
    if (lod > 0) requireStore(entry.derived_from === String(lod - 1) && JSON.stringify(entry.transform?.scale) === '[2,2]' && JSON.stringify(entry.transform?.translation) === '[0,0]', baseUrl, `multiscales level ${lod} must derive from its predecessor with scale [2,2] and translation [0,0]`);
    return { ...entry, path: entry.asset };
  });
  return { cz, datasets };
}

export function normalizeBands(cz, baseUrl) {
  requireStore(Array.isArray(cz.bands) && cz.bands.length > 0, baseUrl, 'chronozarr.bands is missing');
  const bands = cz.bands.map((band) => {
    requireStore(typeof band === 'object' && band !== null && typeof band.name === 'string' && band.name.length > 0, baseUrl, 'bands must contain objects with names');
    const scale = band.scale ?? 1, offset = band.offset ?? 0;
    requireStore(Number.isFinite(scale) && Number.isFinite(offset), baseUrl, 'band scale and offset must be finite');
    return { ...band, scale, offset };
  });
  const names = bands.map((b) => b.name);
  requireStore(new Set(names).size === names.length, baseUrl, 'band names must be unique');
  requireStore(cz.band_names === undefined || JSON.stringify(cz.band_names) === JSON.stringify(names), baseUrl, 'band_names disagrees with bands');
  return { bands, bandNames: names };
}

/** P/S are authoritative; mirrors may only agree, never replace them. */
export function parseSpatial(meta, cz, lod, baseUrl) {
  const attrs = meta.attributes;
  registration(attrs, 'proj', baseUrl);
  registration(attrs, 'spatial', baseUrl);
  const crs = attrs['proj:code'];
  const transform = attrs['spatial:transform'];
  requireStore(crs === cz.crs && /^EPSG:[1-9]\d*$/.test(crs), baseUrl, `level ${lod} proj:code disagrees with chronozarr.crs`);
  requireStore(JSON.stringify(attrs['spatial:dimensions']) === '["y","x"]' && attrs['spatial:registration'] === 'pixel' && (attrs['spatial:transform_type'] === undefined || attrs['spatial:transform_type'] === 'affine'), baseUrl, `level ${lod} must use pixel-registered affine y/x geometry`);
  requireStore(Array.isArray(transform) && transform.length === 6 && transform.every(Number.isFinite) && transform[0] > 0 && transform[4] < 0 && transform[1] === 0 && transform[3] === 0, baseUrl, `level ${lod} must use an EPSG north-up grid`);
  const shape = meta.shape.slice(-2);
  requireStore(attrs['spatial:shape'] === undefined || JSON.stringify(attrs['spatial:shape']) === JSON.stringify(shape), baseUrl, `level ${lod} spatial:shape disagrees with array`);
  if (attrs['spatial:bbox'] !== undefined) {
    const [h, w] = shape;
    const bbox = [transform[2], transform[5] + h * transform[4], transform[2] + w * transform[0], transform[5]];
    requireStore(JSON.stringify(attrs['spatial:bbox']) === JSON.stringify(bbox), baseUrl, `level ${lod} spatial:bbox disagrees with array`);
  }
  const mirror = cz.levels?.[lod];
  if (mirror) {
    for (const [key, value] of Object.entries({path: String(lod), transform, shape: meta.shape, resolution: transform[0]})) requireStore(JSON.stringify(mirror[key]) === JSON.stringify(value), baseUrl, `level ${lod} mirror ${key} disagrees with array`);
  }
  return { crs, transform, resolution: transform[0] };
}

function parseFillValue(value, dtype) {
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  const n = Number(value ?? 0);
  requireStore(Number.isFinite(n) || dtype === 'float32', 'array', `fill_value ${value} is not a number`);
  return n;
}

/**
 * How one array (the data array, or a mask/coverage variable) is laid out, from its zarr.json.
 * `rank` is 4 for (time, band, y, x) and 3 for (time, y, x). Inner chunks always span one timestep.
 */
export function parseStorage(meta, { path, rank, baseUrl }) {
  checkExtensions(meta, baseUrl);
  const where = `${baseUrl}: ${path}`;
  requireStore(meta.zarr_format === 3 && meta.node_type === 'array', baseUrl, `${path}/zarr.json is not a Zarr v3 array`);
  requireStore(DTYPES[meta.data_type], baseUrl, `${where} dtype is ${meta.data_type}, expected one of ${Object.keys(DTYPES)}`);
  requireStore(meta.shape?.length === rank && meta.shape.every((n) => Number.isInteger(n) && n > 0), baseUrl, `${where} has ${meta.shape?.length} dimensions, expected ${rank}`);
  requireStore(meta.chunk_grid?.name === 'regular', baseUrl, `${where} chunk grid ${meta.chunk_grid?.name} is not supported`);
  const dims = rank === 4 ? ['time', 'band', 'y', 'x'] : ['time', 'y', 'x'];
  requireStore(JSON.stringify(meta.dimension_names) === JSON.stringify(dims) && JSON.stringify(meta.attributes?._ARRAY_DIMENSIONS) === JSON.stringify(dims), baseUrl, `${where} dimension names must be ${dims}`);
  const encoding = meta.chunk_key_encoding ?? { name: 'default' };
  requireStore(encoding.name === 'default' && (encoding.configuration?.separator ?? '/') === '/', baseUrl, `${where} chunk_key_encoding ${encoding.name} is not supported`);
  const separator = encoding.configuration?.separator ?? (encoding.name === 'v2' ? '.' : '/');
  const storage = {
    dtype: meta.data_type,
    fillValue: parseFillValue(meta.fill_value, meta.data_type),
    keyOf: (coords) => (encoding.name === 'default' ? ['c', ...coords] : coords).join(separator),
  };
  const gridShape = meta.chunk_grid.configuration.chunk_shape;
  requireStore(Array.isArray(gridShape) && gridShape.length === rank && gridShape.every((n) => Number.isInteger(n) && n > 0), baseUrl, `${where} has invalid chunk shape`);
  const checkCellShape = (shape) => requireStore(shape.at(-1) === shape.at(-2) && shape.at(-1) % 2 === 0, baseUrl, `${where} chunks must be square with a positive even size`);
  const sharding = meta.codecs.find((c) => c.name === 'sharding_indexed');
  if (!sharding) {
    checkCellShape(gridShape);
    requireStore(gridShape[0] === 1, baseUrl, `${where} unsharded chunks must span one timestep, got ${gridShape}`);
    return { ...storage, sharded: false, shardTime: 1, innerShape: gridShape, innerCodecs: meta.codecs };
  }
  const cfg = sharding.configuration;
  const indexCodecs = cfg.index_codecs.map((c) => c.name);
  requireStore(
    (indexCodecs.length === 1 && indexCodecs[0] === 'bytes') || (indexCodecs.length === 2 && indexCodecs[0] === 'bytes' && indexCodecs[1] === 'crc32c'),
    baseUrl,
    `${where} index_codecs [${indexCodecs}] are not supported`,
  );
  const inner = cfg.chunk_shape;
  checkCellShape(inner);
  const sameSpace = gridShape.slice(1).every((n, i) => n === inner[i + 1]);
  requireStore(inner[0] === 1 && sameSpace, baseUrl, `${where} shard shape (${gridShape}) must be (shard_time, ...) over inner chunks (${inner}) that span one timestep`);
  return {
    ...storage,
    sharded: true,
    shardTime: gridShape[0],
    innerShape: inner,
    innerCodecs: cfg.codecs,
    indexAtStart: (cfg.index_location ?? 'end') === 'start',
    indexHasCrc: indexCodecs.includes('crc32c'),
  };
}

/** What `decode` needs for one array: the typed inner chunk and its compression chain. `key` identifies it to workers. */
export function decodeSpec(storage) {
  const spec = { dtype: storage.dtype, shape: storage.innerShape, codecs: storage.innerCodecs };
  return { key: JSON.stringify(spec), ...spec };
}
