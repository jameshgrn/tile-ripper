import { CONVENTIONS } from '../chronozarr/metadata.js';
// Independent in-memory v0.3 true-value fixture. Sharded or unsharded, with optional validity planes.
// Implements zarrita AsyncReadable and logs every call. Bytes-only chunks isolate reader mechanics.

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC32C_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const json = (obj) => new TextEncoder().encode(JSON.stringify(obj));

const ARRAYS = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array };

/** Deterministic source value for (t, band, y, x): smooth in t. */
export function sourceValue(t, b, y, x) {
  return 1000 + b * 500 + ((y * 7 + x * 13) % 2000) + t * 37 + (x % 5 === 0 ? t * 3 : 0);
}

/** Default value function per dtype, in the dtype's own range. `lod` subsamples the finest level. */
export function defaultValues(dtype) {
  const at = (t, b, y, x, lod) => sourceValue(t, b, y * 2 ** lod, x * 2 ** lod);
  if (dtype === 'uint8') return (t, b, y, x, lod = 0) => at(t, b, y, x, lod) % 256;
  if (dtype === 'int16') return (t, b, y, x, lod = 0) => at(t, b, y, x, lod) - 2000;
  if (dtype === 'float32') return (t, b, y, x, lod = 0) => at(t, b, y, x, lod) * 0.25;
  return (t, b, y, x, lod = 0) => at(t, b, y, x, lod);
}

/** Deterministic mask (1 valid, 0 invalid) and coverage (0..6) values. */
export const maskValue = (t, y, x, lod = 0) => ((t + y * 3 + x * 5 + lod) % 4 === 0 ? 0 : 1);
export const coverageValue = (t, y, x, lod = 0) => (t * 3 + y + x * 2 + lod) % 7;

/**
 * @param {object} spec
 * @param {number} spec.nTime @param {number} spec.nBand @param {number} spec.height @param {number} spec.width
 * @param {number} spec.chunk @param {boolean} spec.sharded
 * @param {'start'|'end'} [spec.indexLocation]
 * @param {number} [spec.nLevels=1]        levels, each half the size of the previous (ceil)
 * @param {'uint8'|'uint16'|'int16'|'float32'} [spec.dtype='uint16']
 * @param {number} [spec.shardTime]        timesteps per shard (default nTime); several shards along time when smaller
 * @param {string} [spec.specVersion='0.3.0']
 * @param {string[]} [spec.bands]          band names (default B0, B1, ...)
 * @param {object[]} [spec.bandObjects]    band objects; writes `bands` as objects plus `band_names`
 * @param {number|null} [spec.nodata=0]
 * @param {number[]} [spec.transform]      level-0 affine; written to each level group with its resolution
 * @param {boolean} [spec.levelsMirror]    write chronozarr.levels
 * @param {boolean} [spec.shardBytes]      write chronozarr.shard_bytes (data array only)
 * @param {boolean} [spec.consolidated]    put every array and group in the root's consolidated_metadata
 * @param {boolean} [spec.mask] @param {boolean} [spec.coverage]   write these variables at every level
 * @param {object} [spec.provenance]
 * @param {(t:number,b:number,y:number,x:number,lod:number)=>number} [spec.values]
 * @param {string[]} [spec.omitShards]     data shard keys ("lod/tShard/row/col") to leave out (answered with 404)
 * @param {number} [spec.delayMs]
 */
export function buildSyntheticStore(spec) {
  const { nTime, nBand, height, width, chunk, sharded, indexLocation = 'end' } = spec;
  const dtype = spec.dtype ?? 'uint16';
  const Typed = ARRAYS[dtype];
  const nLevels = spec.nLevels ?? 1;
  const shardTime = sharded ? (spec.shardTime ?? nTime) : 1;
  const values = spec.values ?? defaultValues(dtype);
  const nodata = spec.nodata === undefined ? 0 : spec.nodata;
  const bandNames = spec.bands ?? spec.bandObjects?.map((b) => b.name) ?? Array.from({ length: nBand }, (_, i) => `B${i}`);
  const files = new Map();
  const bytesCodec = { name: 'bytes', configuration: { endian: 'little' } };
  const auxBytesCodec = { name: 'bytes' };
  const indexCodecs = () => [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }];

  const levels = Array.from({ length: nLevels }, (_, lod) => {
    const h = Math.ceil(height / 2 ** lod);
    const w = Math.ceil(width / 2 ** lod);
    return { lod, height: h, width: w, rows: Math.ceil(h / chunk), cols: Math.ceil(w / chunk) };
  });

  const arrayMeta = (level, kind) => {
    const isData = kind === 'data';
    const shape = isData ? [nTime, nBand, level.height, level.width] : [nTime, level.height, level.width];
    const inner = isData ? [1, nBand, chunk, chunk] : [1, chunk, chunk];
    const shardShape = [shardTime, ...inner.slice(1)];
    const dims = isData ? ['time', 'band', 'y', 'x'] : ['time', 'y', 'x'];
    const codecs = [isData ? bytesCodec : auxBytesCodec];
    return {
      zarr_format: 3,
      node_type: 'array',
      shape,
      data_type: isData ? dtype : 'uint8',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: sharded ? shardShape : inner } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: isData ? (nodata ?? 0) : 0,
      codecs: sharded
        ? [{ name: 'sharding_indexed', configuration: { chunk_shape: inner, codecs, index_codecs: indexCodecs(), index_location: indexLocation } }]
        : codecs,
      dimension_names: dims,
      attributes: { _ARRAY_DIMENSIONS: dims, zarr_conventions: [CONVENTIONS.proj, CONVENTIONS.spatial],
        'proj:code': 'EPSG:32631', 'spatial:dimensions': ['y', 'x'], 'spatial:registration': 'pixel',
        'spatial:transform': groupAttrs(level).transform },
    };
  };

  const dataChunk = (level, t, row, col) => {
    const out = new Typed(nBand * chunk * chunk).fill(nodata ?? 0);
    for (let b = 0; b < nBand; b++) {
      for (let y = 0; y < chunk; y++) {
        for (let x = 0; x < chunk; x++) {
          const gy = row * chunk + y;
          const gx = col * chunk + x;
          if (gy >= level.height || gx >= level.width) continue;
          const value = values(t, b, gy, gx, level.lod);
          out[(b * chunk + y) * chunk + x] = value;
        }
      }
    }
    return new Uint8Array(out.buffer);
  };

  const auxChunk = (level, t, row, col, fn) => {
    const out = new Uint8Array(chunk * chunk);
    for (let y = 0; y < chunk; y++) {
      for (let x = 0; x < chunk; x++) {
        const gy = row * chunk + y;
        const gx = col * chunk + x;
        if (gy < level.height && gx < level.width) out[y * chunk + x] = fn(t, gy, gx, level.lod);
      }
    }
    return out;
  };

  /** Shard bytes from the inner chunks of one shard (missing trailing chunks are empty index entries). */
  const packShard = (chunks) => {
    const indexBytes = 16 * shardTime + 4;
    const view = new DataView(new ArrayBuffer(16 * shardTime));
    let offset = indexLocation === 'start' ? indexBytes : 0;
    for (let i = 0; i < shardTime; i++) {
      const bytes = chunks[i];
      if (!bytes) {
        view.setBigUint64(16 * i, 0xffffffffffffffffn, true);
        view.setBigUint64(16 * i + 8, 0xffffffffffffffffn, true);
        continue;
      }
      view.setBigUint64(16 * i, BigInt(offset), true);
      view.setBigUint64(16 * i + 8, BigInt(bytes.length), true);
      offset += bytes.length;
    }
    const raw = new Uint8Array(view.buffer);
    const withCrc = new Uint8Array(indexBytes);
    withCrc.set(raw);
    new DataView(withCrc.buffer).setUint32(raw.length, crc32c(raw), true);
    const parts = indexLocation === 'start' ? [withCrc, ...chunks.filter(Boolean)] : [...chunks.filter(Boolean), withCrc];
    const shard = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      shard.set(part, at);
      at += part.length;
    }
    return shard;
  };

  const shardBytes = {};
  const omitted = new Set(spec.omitShards ?? []);
  const writeArray = (level, kind, name, chunkOf) => {
    files.set(`/${level.lod}/${name}/zarr.json`, json(arrayMeta(level, kind)));
    const shardCount = Math.ceil(nTime / shardTime);
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) {
        if (!sharded) {
          for (let t = 0; t < nTime; t++) files.set(`/${level.lod}/${name}/c/${t}/${kind === 'data' ? '0/' : ''}${row}/${col}`, chunkOf(level, t, row, col));
          continue;
        }
        for (let ts = 0; ts < shardCount; ts++) {
          if (kind === 'data' && omitted.has(`${level.lod}/${ts}/${row}/${col}`)) continue;
          const chunks = Array.from({ length: Math.min(shardTime, nTime - ts * shardTime) }, (_, i) => chunkOf(level, ts * shardTime + i, row, col));
          const shard = packShard(chunks);
          files.set(`/${level.lod}/${name}/c/${ts}/${kind === 'data' ? '0/' : ''}${row}/${col}`, shard);
          if (kind === 'data') (shardBytes[level.lod] ??= {})[`${ts}/${row}/${col}`] = shard.length;
        }
      }
    }
  };

  const transform = spec.transform ?? [10, 0, 0, 0, -10, 0];
  const groupAttrs = (level) => ({ crs: 'EPSG:32631',
    transform: [transform[0] * 2 ** level.lod, transform[1], transform[2], transform[3], transform[4] * 2 ** level.lod, transform[5]],
    resolution: transform[0] * 2 ** level.lod });
  for (const level of levels) {
    writeArray(level, 'data', 'data', (l, t, row, col) => dataChunk(l, t, row, col));
    if (spec.mask) writeArray(level, 'aux', 'mask', (l, t, row, col) => auxChunk(l, t, row, col, maskValue));
    if (spec.coverage) writeArray(level, 'aux', 'coverage', (l, t, row, col) => auxChunk(l, t, row, col, coverageValue));
    files.set(`/${level.lod}/zarr.json`, json({ zarr_format: 3, node_type: 'group', attributes: groupAttrs(level) }));
  }

  const specVersion = spec.specVersion ?? '0.3.0';
  const chronozarr = {
    spec_version: specVersion,
    variable: 'data',
    times: Array.from({ length: nTime }, (_, t) => new Date(Date.UTC(2024, 0, 1 + t)).toISOString().replace('.000Z', 'Z')),
    bands: spec.bandObjects ?? bandNames.map((name) => ({ name, scale: 1e-4, offset: 0 })),
    band_names: bandNames,
    nodata,
    crs: 'EPSG:32631',
    ...(spec.mask ? { mask_variable: 'mask' } : {}),
    ...(spec.coverage ? { coverage_variable: 'coverage' } : {}),
    ...(spec.provenance ? { provenance: spec.provenance } : {}),
    ...(spec.levelsMirror
      ? {
          levels: levels.map((l) => ({
            path: String(l.lod),
            resolution: groupAttrs(l).resolution,
            transform: groupAttrs(l).transform ?? [10 * 2 ** l.lod, 0, 0, 0, -10 * 2 ** l.lod, 0],
            shape: [nTime, nBand, l.height, l.width],
            grid: [l.rows, l.cols],
          })),
        }
      : {}),
    ...(spec.shardBytes && sharded ? { shard_bytes: Object.fromEntries(Object.entries(shardBytes).map(([lod, m]) => [String(lod), m])) } : {}),
  };
  const root = {
    zarr_format: 3,
    node_type: 'group',
    attributes: {
      zarr_conventions: [{ name: 'chronozarr', spec_url: 'https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md' }, CONVENTIONS.multiscales],
      multiscales: { layout: levels.map((l) => ({ asset: String(l.lod), ...(l.lod ? { derived_from: String(l.lod - 1), transform: { scale: [2, 2], translation: [0, 0] } } : {}) })), resampling_method: 'average' },
      chronozarr,
    },
  };
  if (spec.consolidated) {
    const metadata = {};
    for (const [key, bytes] of files) if (key.endsWith('/zarr.json')) metadata[key.slice(1, -'/zarr.json'.length)] = JSON.parse(new TextDecoder().decode(bytes));
    root.consolidated_metadata = { kind: 'inline', must_understand: false, metadata };
  }
  files.set('/zarr.json', json(root));

  return new SyntheticReadable(files, spec.delayMs ?? 0);
}

class SyntheticReadable {
  constructor(files, delayMs) {
    this.files = files;
    this.delayMs = delayMs;
    this.log = [];
  }

  async #respond(key, range, options, read) {
    this.log.push({ key, range, signal: options?.signal ?? null });
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return read(this.files.get(key));
  }

  get(key, options) {
    return this.#respond(key, null, options, (file) => file);
  }

  getRange(key, range, options) {
    return this.#respond(key, range, options, (file) => {
      if (!file) return undefined;
      if ('suffixLength' in range) return file.slice(file.length - range.suffixLength);
      return file.slice(range.offset, range.offset + range.length);
    });
  }
}
