// Writes the fixture stores that ten of the node tests read from data/spike/ (a gitignored directory a clean checkout
// does not have, so those tests skip in CI): decoder.test.js (the synthetic_* stores), codec.test.js (synthetic_sharded
// and synthetic_gzip) and codec-v02.test.js (codec_bench). They are generated from js/support/synthetic-store.js with
// real compressors (zstd and gzip from node:zlib, blosc from the vendored numcodecs), so the decoders are tested
// against bytes that another implementation wrote. A fixture that already exists is left alone, so running this on a
// machine that has the real ones changes nothing.
//
//   node e2e/make-node-fixtures.mjs [directory]     (default: <repo>/data/spike)
//
// `npm test` runs it first (the pretest script). The tests hard-code data/spike, so the directory cannot be a temp one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';
import Blosc from '../vendor/numcodecs/blosc.js';
import { buildSyntheticStore, crc32c, defaultValues } from '../support/synthetic-store.js';

const DEFAULT_ROOT = path.resolve(import.meta.dirname, '../../data/spike');
const EMPTY_ENTRY = 0xffffffffffffffffn;
const text = new TextEncoder();
const json = (value) => text.encode(JSON.stringify(value, null, 1));

const COMPRESSORS = {
  zstd: {
    codec: { name: 'zstd', configuration: { level: 5, checksum: false } },
    compress: (bytes) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 5 } }),
  },
  gzip: {
    codec: { name: 'gzip', configuration: { level: 5 } },
    compress: (bytes) => gzipSync(bytes, { level: 5 }),
  },
};

// 3 true-value timesteps x 2 bands x 700 x 600 pixels in 512 chunks, two levels: the shape of the original fixtures.
const SYNTHETIC = { nTime: 3, nBand: 2, height: 700, width: 600, chunk: 512, nLevels: 2, bands: ['B04', 'B08'], consolidated: true, transform: [10, 0, 746090, 0, -10, 2540440] };

/** The shard with every inner chunk compressed and the index (at the end, with its crc32c) rewritten for the new sizes. */
function repackShard(shard, nTime, compress) {
  const indexBytes = 16 * nTime + 4;
  const view = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
  const chunks = [];
  for (let i = 0; i < nTime; i++) {
    const offset = view.getBigUint64(shard.length - indexBytes + 16 * i, true);
    const length = view.getBigUint64(shard.length - indexBytes + 16 * i + 8, true);
    chunks.push(offset === EMPTY_ENTRY ? null : compress(shard.subarray(Number(offset), Number(offset + length))));
  }
  const index = new DataView(new ArrayBuffer(16 * nTime));
  let offset = 0;
  chunks.forEach((chunk, i) => {
    index.setBigUint64(16 * i, chunk ? BigInt(offset) : EMPTY_ENTRY, true);
    index.setBigUint64(16 * i + 8, chunk ? BigInt(chunk.length) : EMPTY_ENTRY, true);
    offset += chunk?.length ?? 0;
  });
  const out = new Uint8Array(offset + indexBytes);
  let at = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    out.set(chunk, at);
    at += chunk.length;
  }
  const raw = new Uint8Array(index.buffer);
  out.set(raw, at);
  new DataView(out.buffer).setUint32(at + raw.length, crc32c(raw), true);
  return out;
}

/** A synthetic store as { path: bytes } with the data chunks compressed and the codec chain of the data arrays extended. */
function compressedStore(spec, compressor) {
  const files = buildSyntheticStore(spec).files;
  const arrays = {};
  for (const [key, bytes] of files) {
    if (key.endsWith('/data/zarr.json')) {
      const meta = JSON.parse(new TextDecoder().decode(bytes));
      (spec.sharded ? meta.codecs[0].configuration.codecs : meta.codecs).push(compressor.codec);
      arrays[key.slice(1, -'/zarr.json'.length)] = meta;
      files.set(key, json(meta));
    } else if (key.includes('/data/c/')) {
      files.set(key, spec.sharded ? repackShard(bytes, spec.nTime, compressor.compress) : compressor.compress(bytes));
    }
  }
  const root = JSON.parse(new TextDecoder().decode(files.get('/zarr.json')));
  Object.assign(root.consolidated_metadata.metadata, arrays);
  files.set('/zarr.json', json(root));
  return files;
}

/** expected.json: per level the valid-pixel sum of every (timestep, band) and one sample pixel, as the decoder tests check them. */
function expectedValues(spec) {
  const values = defaultValues('uint16');
  const expected = {};
  for (let lod = 0; lod < spec.nLevels; lod++) {
    const height = Math.ceil(spec.height / 2 ** lod);
    const width = Math.ceil(spec.width / 2 ** lod);
    const sums = Array.from({ length: spec.nTime }, (_, t) =>
      Array.from({ length: spec.nBand }, (_, b) => {
        let sum = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) sum += values(t, b, y, x, lod);
        return sum;
      }),
    );
    const sample = { t: 1, b: 1, y: 333, x: lod === 0 ? 444 : 299 };
    expected[lod] = { shape: [spec.nTime, spec.nBand, height, width], sum_per_t_b: sums, sample: { ...sample, value: values(sample.t, sample.b, sample.y, sample.x, lod) } };
  }
  return json(expected);
}

function syntheticFixtures() {
  const expected = expectedValues(SYNTHETIC);
  const withExpected = (files) => files.set('/expected.json', expected);
  return {
    synthetic_sharded: () => withExpected(compressedStore({ ...SYNTHETIC, sharded: true }, COMPRESSORS.zstd)),
    synthetic_gzip: () => withExpected(compressedStore({ ...SYNTHETIC, sharded: true }, COMPRESSORS.gzip)),
    synthetic_unsharded: () => withExpected(compressedStore({ ...SYNTHETIC, sharded: false }, COMPRESSORS.zstd)),
  };
}

/**
 * codec_bench: four chunks of 4 bands x 512 x 512 uint16 as arrays with three codec chains (plain, zstd level 5,
 * blosc zstd with byte shuffle), the layout of js/support/codec-bench/make_stores.py. Chunks 0-2 are smooth values with
 * noise; chunk 3 contains signed test patterns stored as unsigned bits for codec coverage.
 */
async function codecBenchFiles() {
  const side = 512;
  let seed = 12345;
  const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 63;
  const chunks = [0, 1, 2, 3].map((c) => {
    const values = new Uint16Array(4 * side * side);
    for (let b = 0; b < 4; b++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          values[(b * side + y) * side + x] = c < 3 ? 800 + 300 * b + ((x * 5 + y * 3 + 977 * c) % 1400) + noise() : noise();
        }
      }
    }
    return new Uint8Array(values.buffer);
  });
  const blosc = new Blosc(1, 'zstd', Blosc.SHUFFLE, 0);
  const variants = {
    plain: { codecs: [], compress: (bytes) => bytes },
    zstd5: { codecs: [COMPRESSORS.zstd.codec], compress: COMPRESSORS.zstd.compress },
    blosc: { codecs: [{ name: 'blosc', configuration: { cname: 'zstd', clevel: 1, shuffle: 'shuffle', typesize: 2, blocksize: 0 } }], compress: (bytes) => blosc.encode(bytes) },
  };
  const files = new Map();
  const sizes = {};
  for (const [name, { codecs, compress }] of Object.entries(variants)) {
    files.set(`/${name}/zarr.json`, json({
      zarr_format: 3,
      node_type: 'array',
      shape: [4, 4, side, side],
      data_type: 'uint16',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 4, side, side] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, ...codecs],
      dimension_names: ['time', 'band', 'y', 'x'],
      attributes: {},
    }));
    sizes[name] = [];
    for (let c = 0; c < 4; c++) {
      const bytes = await compress(chunks[c]);
      files.set(`/${name}/c/${c}/0/0/0`, bytes);
      sizes[name].push(bytes.length);
    }
  }
  files.set('/sizes.json', json(sizes));
  return files;
}

async function writeTree(dir, files) {
  const staging = `${dir}.tmp-${process.pid}`;
  for (const [key, bytes] of files) {
    const file = path.join(staging, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await rename(staging, dir);
}

/** Write the missing fixtures under `root`; resolves with { name: 'written' | 'kept' }. */
export async function makeNodeFixtures(root = DEFAULT_ROOT) {
  await mkdir(root, { recursive: true });
  const builders = { ...syntheticFixtures(), codec_bench: codecBenchFiles };
  const result = {};
  for (const [name, build] of Object.entries(builders)) {
    const dir = path.join(root, name);
    if (existsSync(dir)) {
      const version = name.startsWith('synthetic_') ? JSON.parse(await readFile(path.join(dir, 'zarr.json'), 'utf8')).attributes?.chronozarr?.spec_version : '0.3.0';
      if (version === '0.3.0') {
        result[name] = 'kept';
        continue;
      }
      await rename(dir, `${dir}.pre-v03-${Date.now()}`);
    }
    await writeTree(dir, await build());
    result[name] = 'written';
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? DEFAULT_ROOT);
  const result = await makeNodeFixtures(root);
  console.log(`fixtures in ${root}: ${Object.entries(result).map(([name, status]) => `${name} ${status}`).join(', ')}`);
}
