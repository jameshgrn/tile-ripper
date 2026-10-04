// chronozarr reader (spec 0.3.x). No DOM. Runs in browsers (decode workers) and Node.
//
// Coordinates: (lod, row, col, t). One cell is one spatial chunk of one level; its stored bytes for a
// timestep are one zarr inner chunk of shape (1, n_band, chunkH, chunkW), typed by the store's dtype
// (uint8, uint16, int16 or float32). Every timestep stores true values and needs one data chunk.
//
// Reading is done here rather than through zarrita's Array so that fetching and decoding are separate
// steps: chunk bytes are fetched with one range request (shard index cached per shard, cancellable), then
// decoded in a worker pool. zarrita's codec registry (zstd, gzip, blosc) comes from js/vendor, never a CDN.
//
// Memory is tiered (cache.js): decoded arrays for chunks near the view, compressed bytes for chunks farther
// away, under one joint cap (1.5 GiB from 8 GB of device memory, 768 MiB below). Background prefetch draws from
// a speculative allowance (16 MB at open, then a share of the measured bandwidth) and never takes the last
// request slots from demand reads. It is modest while the viewer is idle (a horizon of timesteps around t and a
// byte cap per idle episode) and covers the whole axis only for playback.
//
// An open store is a snapshot of the root zarr.json it was opened with: `times` and the level shapes
// never change afterwards. When the store grows (`chronozarr append`), every
// chunk the reader knows keeps decoding, but the new timesteps stay invisible until the store is opened again: a
// reader does not extend its own `times`, so showing them is a reload (call openStore again). One thing does move
// under a running reader: the trailing time shard of each cell is replaced by a longer object, so the length
// `shard_bytes` lists for it goes stale, and an end-located index read with that length lands on the wrong bytes.
// The reader heals this itself (see #readShardIndex): it re-reads the root past the HTTP cache, adopts the new
// lengths and retries, and falls back to a suffix read when the lengths are still wrong. Old chunks keep their
// offsets, so indexes already cached stay valid and what a chunk decodes to never changes. `stats.recoveries` counts it.

import { BandwidthEstimator } from './bandwidth.js';
import { ChunkCache, SpeculativeBudget } from './cache.js';
import { FetchError, HttpStore, LimitedReadable, abortError, isAbort, sleep } from './http.js';
import { RequestLimiter } from './limiter.js';
import { DTYPES, decodeSpec, normalizeBands, parseSpatial, parseRoot, parseStorage, requireStore } from './metadata.js';
import { DecodePool, MainThreadDecoder, leaseDecodePool } from './pool.js';
import { ShardIndexError, parseShardIndex, shardIndexRange } from './shard.js';
import { registry } from '../vendor/zarrita/codecs.js';

export { FetchError };

/** The part of zarrita the reader uses: the codec registry. Workers load the same module by URL. */
const ZARRITA_CODECS = { registry };
const ZARRITA_CODECS_URL = new URL('../vendor/zarrita/codecs.js', import.meta.url).href;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_PREFETCH_CONCURRENCY = 6;
const WINDOW_BUDGET_FRACTION = 0.9;
const MAX_DEFAULT_WORKERS = 8;
const DEFAULT_MAX_REQUESTS = 12;
const PREFETCH_COOLDOWN_MS = 30000;
/**
 * A shard whose index read disagreed with `shard_bytes` may have the root zarr.json re-read for it once per this interval,
 * and once a re-read has brought no new lengths (root unchanged, or unreadable) none is started for any shard for as long.
 */
const ROOT_REFETCH_INTERVAL_MS = 60000;
const DEFAULT_RETRY_DELAYS_MS = [200, 600, 1500];
const DEFAULT_SPECULATIVE_INITIAL_BYTES = 16 * MIB;
/**
 * Fraction of the measured bandwidth that speculative fetching earns once the initial allowance is spent:
 * a half while a demand read is pending or the estimate is young (under a second of transfer time), the whole
 * link when nothing is waiting and the estimate is established. Demand requests keep their own request slots
 * and go first, and prefetch starts nothing new while one is pending, so a busy link costs them little. A
 * smaller idle share caps cold-loop playback on a fast link at that fraction of the link: on the live Ucayali
 * store (a link of about 20 MB/s, 10 steps/s asked, median of 3 runs) an idle share of 0.5 achieved 8.2 steps/s,
 * 0.9 achieved 9.1 and 1.0 achieved 9.7.
 */
const SPECULATIVE_SHARE_PENDING = 0.5;
const SPECULATIVE_SHARE_IDLE = 1.0;
/** Idle prefetch: timesteps either side of t it covers, bytes it may start per idle episode, and the quiet time after the last scrub or playback that makes the viewer idle. */
const DEFAULT_HORIZON_STEPS = 12;
const DEFAULT_IDLE_BYTES = 64 * MIB;
const DEFAULT_IDLE_MS = 3000;
/** The mask and coverage cache: a tenth of the joint cap, at least 64 MiB. It is held on top of the cap. */
const AUX_SHARE = 0.1;
const AUX_MIN_BYTES = 64 * MIB;
/** Compressed size over decoded size assumed until chunks have been seen (Sentinel-2 reflectance: 0.65 to 0.72). */
const INITIAL_COMPRESSION_RATIO = 0.7;

/**
 * The one cap on decoded plus compressed chunk bytes: 1.5 GiB on machines reporting at least 8 GB of memory
 * (navigator.deviceMemory, which browsers cap at 8 and which Firefox and Safari do not provide), otherwise
 * 768 MiB. The compressed tier takes whatever the decoded tier does not use.
 */
export function defaultTotalBytes(deviceMemoryGb) {
  return deviceMemoryGb >= 8 ? 1.5 * GIB : 768 * MIB;
}

function auxBudget(totalBytes) {
  return Math.max(AUX_MIN_BYTES, Math.round(AUX_SHARE * totalBytes));
}

/**
 * The joint cap for the budgets a caller gave: `totalBytes` itself; the sum when both tiers were sized; else
 * `fallback`, raised to a single tier budget that is larger than it.
 */
function jointCap({ totalBytes, decodedBytes, compressedBytes }, fallback) {
  if (totalBytes !== undefined) return totalBytes;
  if (decodedBytes !== undefined && compressedBytes !== undefined) return decodedBytes + compressedBytes;
  return Math.max(fallback, decodedBytes ?? 0, compressedBytes ?? 0);
}

export function chunkKey(lod, row, col, t) {
  return `${lod}/${row}/${col}/${t}`;
}

/** Whether a failed index read looks like a stale `shard_bytes` length: unreadable or inconsistent bytes, or a 416 for the range. */
function isStaleHint(error) {
  return error instanceof ShardIndexError || error?.status === 416;
}

/**
 * How expensive it is to keep or fetch a timestep at signed distance `dt` from the one being viewed:
 * behind the scrub direction counts `behindFactor` times as much (double by default; movie playback never
 * goes back, so it uses a much larger factor). Prefetch order and eviction order both use it.
 */
export function scrubCost(dt, direction, behindFactor = 2, period = null) {
  if (period === null) return dt * direction >= 0 ? Math.abs(dt) : behindFactor * Math.abs(dt);
  // Circular time (a looping movie): a timestep is ahead by `ahead` steps or behind by the rest of the loop.
  const ahead = (((dt * direction) % period) + period) % period;
  return Math.min(ahead, behindFactor * (period - ahead));
}

/**
 * Timesteps 0..nTime-1 from cheapest to most expensive to keep around `t` (see scrubCost). With `loop`, time
 * is circular, so the first timesteps come right after the last ones: what a looping movie needs ahead of it.
 */
export function windowOrder(nTime, t, { direction = 1, behindFactor = 2, loop = false } = {}) {
  const period = loop ? nTime : null;
  const cost = (step) => scrubCost(step - t, direction, behindFactor, period);
  return Array.from({ length: nTime }, (_, i) => i).sort((a, b) => cost(a) - cost(b) || Math.abs(a - t) - Math.abs(b - t));
}

/** Stored values of one pixel per band, sampled directly from a true-value chunk. */
export function samplePixelFrom(data, { nBand, chunkWidth, chunkHeight }, x, y) {
  const plane = chunkHeight * chunkWidth;
  const offset = y * chunkWidth + x;
  const values = new data.constructor(nBand);
  for (let b = 0; b < nBand; b++) values[b] = data[b * plane + offset];
  return values;
}

function defaultWorkerCount() {
  if (typeof Worker === 'undefined') return 0;
  return Math.max(1, Math.min(MAX_DEFAULT_WORKERS, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
}

let crossOriginBootstrapUrl = null;

/**
 * A module Worker running decode-worker.js. A page cannot start a worker from another origin (this package loaded
 * from a CDN): the constructor throws SecurityError, and the worker is started through a same-origin blob that
 * imports the real script instead. The `new Worker(new URL(...))` form stays literal so bundlers find the script.
 */
function spawnDecodeWorker() {
  if (crossOriginBootstrapUrl === null) {
    try {
      return new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      if (error?.name !== 'SecurityError') throw error;
      const script = `import ${JSON.stringify(new URL('./decode-worker.js', import.meta.url).href)};`;
      crossOriginBootstrapUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    }
  }
  return new Worker(crossOriginBootstrapUrl, { type: 'module' });
}

/**
 * Open a chronozarr store.
 *
 * @param {string} baseUrl  URL of the store root (the directory holding zarr.json).
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]   fetch implementation (default: globalThis.fetch at call time).
 * @param {AbortSignal} [options.signal] cancels opening metadata reads; after opening, use per-read signals or close().
 * @param {object} [options.store]         a zarrita AsyncReadable to use instead of HTTP.
 * @param {number} [options.totalBytes]    cap on decoded plus compressed chunk bytes (default: see defaultTotalBytes). Naming both
 *   tier budgets below without this makes their sum the cap; naming one raises the default cap to it if it is larger.
 * @param {number} [options.decodedBytes]  ceiling on the decoded tier (default: none beyond the cap). `maxCacheBytes` is the same setting.
 * @param {number} [options.compressedBytes] ceiling on the compressed tier (default: none beyond the cap; 0 turns the tier off).
 * @param {number} [options.horizonSteps]  timesteps either side of t that idle prefetch covers (default 12).
 * @param {number} [options.idleBytes]     bytes of speculative traffic idle prefetch may start per idle episode (default 64 MiB).
 * @param {number} [options.idleMs]        quiet time after the last scrub or playback after which the viewer counts as idle (default 3000).
 * @param {number} [options.speculativeBytesInitial] bytes of prefetch allowed before bandwidth is measured (default 16 MB).
 * @param {number} [options.maxRequests]   cap on concurrent requests to the store (default 12).
 * @param {number[]} [options.retryDelaysMs] delays before each retry of a failed request (default [200, 600, 1500]).
 * @param {number} [options.workers]       decode workers (default: cores - 1, at most 8, none without Worker).
 * @param {() => object} [options.spawnWorker] creates a worker (tests); default: js/chronozarr/decode-worker.js. Workers that cannot
 *   be started (not even through the cross-origin bootstrap) are logged once and decoding happens on the main thread.
 * @param {boolean} [options.suffixRequests] send `Range: bytes=-N` for shard indexes when the shard's size is not
 *   known (one request, but a CORS preflight on cross-origin hosts) instead of HEAD + range (two simple requests).
 * @param {() => number} [options.clock]   millisecond clock for bandwidth and the speculative allowance (default performance.now).
 */
export async function openStore(baseUrl, options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const network = { requests: 0, bytes: 0, deduped: 0 };
  const bandwidth = new BandwidthEstimator(clock);
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const limiter = new RequestLimiter(maxRequests, { reserve: Math.floor(maxRequests / 4) });
  const io = { limiter, network, bandwidth };
  const readable = options.store
    ? new LimitedReadable(options.store, io)
    : new HttpStore(baseUrl, {
        ...io,
        fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
        retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
        suffixRequests: options.suffixRequests ?? false,
      });

  const rootBytes = await readable.get('/zarr.json', { signal: options.signal });
  requireStore(rootBytes, baseUrl, 'root zarr.json not found');
  const root = JSON.parse(new TextDecoder().decode(rootBytes));
  const { cz, datasets } = parseRoot(root, baseUrl);
  normalizeBands(cz, baseUrl);
  const variable = cz.variable ?? 'data';

  // One GET for everything when the root carries consolidated metadata, else one GET per array.
  const consolidated = root.consolidated_metadata?.metadata ?? {};
  const readMeta = async (path, { required }) => {
    if (consolidated[path]) return consolidated[path];
    const bytes = await readable.get(`/${path}/zarr.json`, { signal: options.signal });
    requireStore(bytes || !required, baseUrl, `${path}/zarr.json not found`);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  };
  const auxName = (declared, fallback) => declared ?? (consolidated[`${datasets[0].path}/${fallback}`] ? fallback : null);
  const names = { data: variable, mask: auxName(cz.mask_variable, 'mask'), coverage: auxName(cz.coverage_variable, 'coverage') };
  const readArrays = (name) => Promise.all(datasets.map((ds) => readMeta(`${ds.path}/${name}`, { required: true })));
  const [dataMetas, maskMetas, coverageMetas] = await Promise.all([
    readArrays(names.data),
    names.mask ? readArrays(names.mask) : null,
    names.coverage ? readArrays(names.coverage) : null,
  ]);
  if (options.signal?.aborted) throw abortError();

  const storage = {
    data: dataMetas.map((meta, lod) => parseStorage(meta, { path: `${datasets[lod].path}/${names.data}`, rank: 4, baseUrl })),
    mask: maskMetas?.map((meta, lod) => parseStorage(meta, { path: `${datasets[lod].path}/${names.mask}`, rank: 3, baseUrl })) ?? null,
    coverage: coverageMetas?.map((meta, lod) => parseStorage(meta, { path: `${datasets[lod].path}/${names.coverage}`, rank: 3, baseUrl })) ?? null,
  };
  const specs = {};
  for (const kind of ['data', 'mask', 'coverage']) {
    if (!storage[kind]) continue;
    specs[kind] = decodeSpec(storage[kind][0]);
    requireStore(storage[kind].every((s) => decodeSpec(s).key === specs[kind].key), baseUrl, `levels use different chunk codecs or shapes in ${names[kind]}`);
  }
  for (const kind of ['mask', 'coverage']) {
    requireStore(!storage[kind] || storage[kind][0].dtype === 'uint8', baseUrl, `${names[kind]} must be uint8, got ${storage[kind]?.[0].dtype}`);
  }

  const mem = globalThis.navigator?.deviceMemory;
  const decodedBytes = options.decodedBytes ?? options.maxCacheBytes;
  const budgets = {
    totalBytes: jointCap({ totalBytes: options.totalBytes, decodedBytes, compressedBytes: options.compressedBytes }, defaultTotalBytes(mem)),
    decodedBytes,
    compressedBytes: options.compressedBytes,
    speculativeBytesInitial: options.speculativeBytesInitial ?? DEFAULT_SPECULATIVE_INITIAL_BYTES,
  };
  const policy = {
    horizonSteps: options.horizonSteps ?? DEFAULT_HORIZON_STEPS,
    idleBytes: options.idleBytes ?? DEFAULT_IDLE_BYTES,
    idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
  };

  const geometry = dataMetas.map((meta, lod) => parseSpatial(meta, cz, lod, baseUrl));
  const transform = geometry[0].transform;
  for (let lod = 0; lod < geometry.length; lod++) {
    const expected = [transform[0] * 2 ** lod, 0, transform[2], 0, transform[4] * 2 ** lod, transform[5]];
    requireStore(JSON.stringify(geometry[lod].transform) === JSON.stringify(expected), baseUrl, `level ${lod} is not a factor-two north-up overview`);
    const shape = dataMetas[lod].shape;
    requireStore(shape[2] === Math.ceil(dataMetas[0].shape[2] / 2 ** lod) && shape[3] === Math.ceil(dataMetas[0].shape[3] / 2 ** lod), baseUrl, `level ${lod} shape does not match factor-two pyramid`);
    for (const metas of [maskMetas, coverageMetas]) if (metas) {
      const aux = parseSpatial(metas[lod], { ...cz, levels: undefined }, lod, baseUrl);
      requireStore(JSON.stringify(aux.transform) === JSON.stringify(expected) && JSON.stringify(metas[lod].shape) === JSON.stringify([shape[0], shape[2], shape[3]]), baseUrl, `level ${lod} auxiliary geometry or shape disagrees with data`);
    }
  }

  const workers = options.workers ?? defaultWorkerCount();
  let decoder;
  if (workers > 0) {
    const fallback = new MainThreadDecoder(ZARRITA_CODECS);
    const init = { type: 'init', zarritaUrl: ZARRITA_CODECS_URL };
    try {
      decoder = options.spawnWorker
        ? new DecodePool({ size: workers, spawn: options.spawnWorker, init, fallback })
        : leaseDecodePool({ key: `${ZARRITA_CODECS_URL}|${workers}`, size: workers, spawn: spawnDecodeWorker, init, fallback });
    } catch (error) {
      console.warn(`chronozarr: cannot start decode workers (${error.name}: ${error.message}); decoding on the main thread`);
      decoder = fallback;
    }
  } else {
    decoder = new MainThreadDecoder(ZARRITA_CODECS);
  }
  for (const spec of Object.values(specs)) decoder.warm?.(spec);

  return new ChronoStore({
    url: baseUrl,
    cz,
    datasets,
    names,
    levelMirror: cz.levels ?? null,
    transform: Array.isArray(transform) && transform.length === 6 && transform.every(Number.isFinite) ? transform : null,
    dataMetas,
    storage,
    specs,
    readable,
    decoder,
    network,
    bandwidth,
    limiter,
    clock,
    budgets,
    policy,
  });
}

export class ChronoStore {
  #readable;
  #decoder;
  #storage;
  #specs;
  #names;
  #cache;
  #auxCache;
  #clock;
  #now;
  #inflight = new Map();
  #closeController = new AbortController();
  #shardIndexes = new Map();
  #shardBytes;
  /** Bumped each time a re-read root replaces `#shardBytes`; an index read compares it with the value it started under. */
  #hintEpoch = 0;
  /** The root re-read in flight (never rejects), shared by every shard that fails while it runs. */
  #rootRefresh = null;
  /** Clock time of the last root re-read started for each shard (by its cache key). */
  #recoveredAt = new Map();
  /** Clock time of the last root re-read that brought no new `shard_bytes`, or null. */
  #noNewHintsAt = null;
  #recoveries = { rootRefetches: 0, retried: 0, suffixFallbacks: 0, suppressed: 0 };
  #demandInflight = 0;
  #demandIdleWaiters = [];
  #limiter;
  #bandwidth;
  #speculative;
  #compressionRatio = INITIAL_COMPRESSION_RATIO;
  #cellFailures = new Map();
  #network;
  #counters;
  #policy;
  /** What the last prefetch call saw: its timestep and view, until when the viewer counts as scrubbing or playing, and the idle bytes started in this view since. */
  #activity = { t: null, viewKey: null, activeUntil: -Infinity, idleSpent: 0 };

  /**
   * Eviction order: called with {lod,row,col,t,used}; the highest score is evicted first, in both cache
   * tiers. The default is least recently used. A viewer sets this to "farthest from what is on screen".
   */
  evictionScore = (entry) => -entry.used;
  /** Called with {type:'chunk', key, background, requestedAt, fetchedAt, decodedAt, bytes} per loaded chunk. */
  probe = null;

  constructor({ url, cz, datasets, names, levelMirror, transform, dataMetas, storage, specs, readable, decoder, network, bandwidth, limiter, clock, budgets, policy }) {
    this.url = url;
    this.variable = names.data;
    this.times = cz.times;
    this.crs = cz.crs;
    /** Affine [a, b, c, d, e, f] from level-0 pixel (col, row) to projected x, y; null if the store declares none. */
    this.transform = transform;
    this.#readable = readable;
    this.#decoder = decoder;
    this.#limiter = limiter;
    this.#bandwidth = bandwidth;
    this.#clock = clock;
    this.#now = () => performance.now();
    this.#network = network;
    this.#storage = storage;
    this.#specs = specs;
    this.#names = names;
    this.#shardBytes = cz.shard_bytes ?? null;
    this.#policy = policy;
    this.#cache = new ChunkCache({ totalBytes: budgets.totalBytes, decodedBytes: budgets.decodedBytes, compressedBytes: budgets.compressedBytes, score: (entry) => this.evictionScore(entry) });
    this.#auxCache = new ChunkCache({ decodedBytes: auxBudget(budgets.totalBytes), compressedBytes: 0, score: (entry) => this.evictionScore(entry) });
    this.#speculative = new SpeculativeBudget({ initial: budgets.speculativeBytesInitial, share: SPECULATIVE_SHARE_PENDING, clock });

    const { bands, bandNames } = normalizeBands(cz, url);
    this.bands = bandNames;
    const nTime = this.times.length;
    this.dtype = storage.data[0].dtype;
    const bytesPerElement = DTYPES[this.dtype].bytes;

    this.levels = dataMetas.map((meta, lod) => {
      const [levelTime, nBand, height, width] = meta.shape;
      const [, chunkB, chunkHeight, chunkWidth] = storage.data[lod].innerShape;
      requireStore(levelTime === nTime, url, `level ${lod} has ${levelTime} timesteps, times attr has ${nTime}`);
      requireStore(nBand === bands.length, url, `level ${lod} has ${nBand} bands, bands attr has ${bands.length}`);
      requireStore(chunkB === nBand, url, `level ${lod} chunks must hold all ${nBand} bands, got ${chunkB}`);
      requireStore(chunkHeight === chunkWidth && chunkHeight > 0 && chunkHeight % 2 === 0, url, `level ${lod} chunks must be square with a positive even size`);
      requireStore(lod === 0 || chunkWidth === storage.data[0].innerShape[3], url, 'chunk size must be identical at every level');
      const declaredGrid = levelMirror?.[lod]?.grid;
      requireStore(!declaredGrid || JSON.stringify(declaredGrid) === JSON.stringify([Math.ceil(height / chunkHeight), Math.ceil(width / chunkWidth)]), url, `level ${lod} grid mirror disagrees with array`);
      for (const kind of ['mask', 'coverage']) {
        const aux = storage[kind]?.[lod];
        if (aux) requireStore(aux.innerShape[1] === chunkHeight && aux.innerShape[2] === chunkWidth, url, `level ${lod} ${names[kind]} chunks are ${aux.innerShape.slice(1)}, data chunks are ${chunkHeight}x${chunkWidth}`);
      }
      const mirror = levelMirror?.[lod];
      const a = transform?.[0];
      return {
        lod,
        path: datasets[lod].path,
        nTime,
        nBand,
        height,
        width,
        chunkHeight,
        chunkWidth,
        gridRows: Math.ceil(height / chunkHeight),
        gridCols: Math.ceil(width / chunkWidth),
        chunkBytes: nBand * chunkHeight * chunkWidth * bytesPerElement,
        resolution: mirror?.resolution ?? (a === undefined ? null : Math.abs(a) * 2 ** lod),
        transform: mirror?.transform ?? (transform ? [transform[0] * 2 ** lod, transform[1], transform[2], transform[3], transform[4] * 2 ** lod, transform[5]] : null),
      };
    });

    this.hasMask = storage.mask !== null;
    this.hasCoverage = storage.coverage !== null;
    this.nodata = typeof cz.nodata === 'number' ? cz.nodata : null;
    /** The chronozarr block of the root, normalized: band objects with scale and offset, names, levels, flags. */
    this.attrs = {
      ...cz,
      spec_version: String(cz.spec_version),
      bands,
      band_names: bandNames,
      bandNames,
      nodata: this.nodata,
      dtype: this.dtype,
      levels: this.levels.map((l) => ({ path: l.path, resolution: l.resolution, transform: l.transform, shape: [l.nTime, l.nBand, l.height, l.width], grid: [l.gridRows, l.gridCols] })),
      hasMask: this.hasMask,
      hasCoverage: this.hasCoverage,
      provenance: cz.provenance ?? null,
    };

    this.#counters = {
      cache: { hits: 0, misses: 0, joins: 0, compressedHits: 0, speculativeBytes: 0 },
      loads: { count: 0, fetchMs: 0, decodeMs: 0 },
    };
    Object.defineProperty(network, 'inflight', { get: () => limiter.active, enumerable: true });
    const cacheStats = this.#counters.cache;
    Object.defineProperties(cacheStats, {
      decodedBytes: { get: () => this.#cache.decodedBytes, enumerable: true },
      speculativeShare: { get: () => this.#speculative.share, enumerable: true },
      compressedBytes: { get: () => this.#cache.compressedBytes, enumerable: true },
      usedBytes: { get: () => this.#cache.usedBytes, enumerable: true },
      budgetBytes: { get: () => this.#cache.maxTotal, enumerable: true },
      evictions: { get: () => this.#cache.evictions.decoded, enumerable: true },
      compressedEvictions: { get: () => this.#cache.evictions.compressed, enumerable: true },
    });
    const snapshot = () => ({ network: { ...network }, cache: { ...cacheStats }, loads: { ...this.#counters.loads }, recoveries: { ...this.#recoveries } });
    /**
     * `stats()` is a snapshot; `stats.network`, `stats.cache`, `stats.loads` and `stats.recoveries` are live objects.
     * `recoveries` counts what the reader did when a shard index read disagreed with `shard_bytes` (a store that was appended
     * to since it was opened): `rootRefetches` root zarr.json re-reads, `retried` index reads that then succeeded with the
     * refreshed length, `suffixFallbacks` index reads that fell back to a suffix read, `suppressed` recoveries that skipped the
     * re-read because of the once-a-minute cap.
     */
    this.stats = Object.assign(snapshot, { network, cache: cacheStats, loads: this.#counters.loads, recoveries: this.#recoveries });
  }

  /** The most decoded bytes the cache can hold (what `loopFits` and the prefetch window are sized by). */
  get maxCacheBytes() {
    return this.#cache.decodedLimit;
  }

  /**
   * The cap on decoded plus compressed bytes, the most each tier can hold within it, the mask and coverage cache
   * (held on top of the cap: a tenth of it, at least 64 MiB) and the prefetch allowance. The compressed tier holds
   * what the decoded tier leaves of the cap, so the two tier limits overlap; see `stats.cache` for what each holds now.
   */
  budgets() {
    return {
      totalBytes: this.#cache.maxTotal,
      decodedBytes: this.#cache.decodedLimit,
      compressedBytes: this.#cache.compressedLimit,
      auxBytes: this.#auxCache.maxDecoded,
      speculativeBytesInitial: this.#speculative.initial,
    };
  }

  /**
   * Change any of the budgets; the cache evicts down to smaller ones at once. Naming both tiers without
   * `totalBytes` makes their sum the cap, naming one raises the cap to it if it is larger (as openStore does).
   */
  setBudgets({ totalBytes, decodedBytes, compressedBytes, speculativeBytesInitial } = {}) {
    for (const [name, value] of Object.entries({ totalBytes, decodedBytes, compressedBytes, speculativeBytesInitial })) {
      if (value !== undefined && !(Number.isFinite(value) && value >= 0)) throw new RangeError(`${name} must be a number of bytes >= 0, got ${value}`);
    }
    this.#cache.setBudgets({ totalBytes: jointCap({ totalBytes, decodedBytes, compressedBytes }, this.#cache.maxTotal), decodedBytes, compressedBytes });
    const aux = auxBudget(this.#cache.maxTotal);
    this.#auxCache.setBudgets({ totalBytes: aux, decodedBytes: aux, compressedBytes: 0 });
    if (speculativeBytesInitial !== undefined) this.#speculative.setInitial(speculativeBytesInitial);
  }

  /** Bytes the reader holds for chunks: decoded arrays, compressed bytes and the mask and coverage cache. GPU memory is the viewer's to add. */
  estimatedBytes() {
    return this.#cache.usedBytes + this.#auxCache.usedBytes;
  }

  /** Download rate in bytes per second (smoothed over recent transfers), or null before anything was measured. */
  bandwidthEstimate() {
    return this.#bandwidth.estimate;
  }

  level(lod) {
    const level = this.levels[lod];
    if (!level) throw new RangeError(`lod ${lod} out of range 0..${this.levels.length - 1}`);
    return level;
  }

  /** Valid (unpadded) pixel extent of a cell. Edge cells are smaller than the chunk. */
  cellExtent(lod, row, col) {
    const level = this.level(lod);
    this.#checkCell(level, row, col);
    return {
      width: Math.min(level.chunkWidth, level.width - col * level.chunkWidth),
      height: Math.min(level.chunkHeight, level.height - row * level.chunkHeight),
    };
  }

  resetStats() {
    const { cache, loads } = this.#counters;
    for (const name of ['hits', 'misses', 'joins', 'compressedHits', 'speculativeBytes']) cache[name] = 0;
    Object.assign(loads, { count: 0, fetchMs: 0, decodeMs: 0 });
    Object.assign(this.#network, { requests: 0, bytes: 0, deduped: 0 });
    Object.assign(this.#recoveries, { rootRefetches: 0, retried: 0, suffixFallbacks: 0, suppressed: 0 });
    this.#cache.evictions.decoded = 0;
    this.#cache.evictions.compressed = 0;
  }

  clearCache() {
    this.#cache.clear();
    this.#auxCache.clear();
  }

  /** Abort every in-flight fetch and release the decode workers. The store cannot be used afterwards. */
  close() {
    if (this.#closeController.signal.aborted) return;
    this.#closeController.abort();
    for (const entry of this.#inflight.values()) this.#abortEntry(entry);
    this.#decoder.close();
    this.clearCache();
    this.#shardIndexes.clear();
    this.#cellFailures.clear();
    this.#recoveredAt.clear();
    this.evictionScore = (entry) => -entry.used;
    this.probe = null;
  }

  cacheInfo() {
    return this.#cache.info();
  }

  /** Decoded true-value chunk or undefined. Never fetches. */
  peekRaw(lod, row, col, t) {
    return this.#cache.decoded(chunkKey(lod, row, col, t));
  }

  /**
   * Raw stored chunk for (lod,row,col,t) as a typed array of the store's dtype laid out [band][y][x] over the
   * full (padded) chunk. Cached; concurrent requests for one key share one fetch. Treat as read-only. A chunk
   * that is only in the compressed tier is decoded without touching the network.
   *
   * With a `signal`, aborting rejects this call with an AbortError, and the network request is
   * cancelled once no caller wants it any more (a caller without a signal keeps it alive).
   */
  async getRaw(lod, row, col, t, { signal } = {}) {
    if (this.#closeController.signal.aborted) throw new Error('ChronoStore is closed');
    const level = this.level(lod);
    this.#checkCell(level, row, col);
    if (!Number.isInteger(t) || t < 0 || t >= level.nTime) {
      throw new RangeError(`timestep ${t} out of range 0..${level.nTime - 1}`);
    }
    const key = chunkKey(lod, row, col, t);
    const counters = this.#counters.cache;
    const decoded = this.#cache.decoded(key);
    if (decoded) {
      counters.hits++;
      return decoded;
    }
    const meta = { kind: 'data', lod, row, col, t };
    let entry = this.#inflight.get(key);
    if (entry && !entry.controller.signal.aborted) {
      this.#join(entry);
    } else if (this.#cache.get(key)?.compressed) {
      counters.hits++;
      counters.compressedHits++;
      entry = this.#start(key, meta, { background: false });
    } else {
      counters.misses++;
      entry = this.#start(key, meta, { background: false });
    }
    const data = await this.#subscribe(entry, signal);
    // A prefetch that joined above kept only compressed bytes: decode them now.
    return data ?? this.getRaw(lod, row, col, t, { signal });
  }

  /**
   * Decoded values for (lod,row,col,t) as `{ data, bands, chunkWidth, chunkHeight, width, height }`: `data` is a typed
   * array [band][y][x] over the padded chunk (the cached array itself), `width` and `height` the valid
   * (unpadded) extent of the cell. Fetches one data chunk.
   */
  async getCell(lod, row, col, t) {
    const level = this.level(lod);
    const data = await this.getRaw(lod, row, col, t);
    const { width, height } = this.cellExtent(lod, row, col);
    return {
      data,
      bands: level.nBand,
      chunkWidth: level.chunkWidth,
      chunkHeight: level.chunkHeight,
      width,
      height,
    };
  }

  /**
   * Decoded per-band values of one pixel from cached chunks only (no fetch, no whole-chunk pass).
   * Returns null when the data chunk is not cached. (x, y) are pixel offsets inside the cell.
   */
  samplePixel(lod, row, col, t, x, y) {
    const level = this.level(lod);
    const data = this.peekRaw(lod, row, col, t);
    return data ? samplePixelFrom(data, level, x, y) : null;
  }

  /**
   * The visible cells of one level for timestep `t`, at demand priority: resolves when the data
   * chunk of every cell is decoded, with `peekRaw` returning them (they are held in the cache until then).
   * Rejects when `signal` aborts or a chunk cannot be loaded. Meant for a coarse-first cold open: ask for the
   * deepest level's few cells, paint, then refine.
   *
   * @param {number} lod
   * @param {Array<[number, number]>} cells  [row, col] pairs, loaded in this order
   * @param {number} t
   * @returns {Promise<{lod:number, t:number, cells:Array<{row:number, col:number, data:ArrayBufferView}>}>}
   */
  async getCoarseFrame(lod, cells, t, { signal } = {}) {
    const level = this.level(lod);
    for (const [row, col] of cells) this.#checkCell(level, row, col);
    const keys = cells.map(([row, col]) => chunkKey(lod, row, col, t));
    this.#cache.pin(keys);
    try {
      const loaded = await Promise.all(
        cells.map(async ([row, col]) => {
          const data = await this.getRaw(lod, row, col, t, { signal });
          return { row, col, data };
        }),
      );
      return { lod, t, cells: loaded };
    } finally {
      this.#cache.unpin(keys);
    }
  }

  /** The validity mask chunk of a cell (uint8 [y][x] over the padded chunk, 1 = valid), or null when the store has no mask. */
  getMask(lod, row, col, t, { signal } = {}) {
    return this.#getAux('mask', lod, row, col, t, signal);
  }

  /** The coverage chunk of a cell (uint8 [y][x], observations behind each pixel, 0 = gap-filled), or null when the store has none. */
  getCoverage(lod, row, col, t, { signal } = {}) {
    return this.#getAux('coverage', lod, row, col, t, signal);
  }

  /** Cached mask chunk, undefined when not loaded yet, null when the store has no mask. Never fetches. */
  peekMask(lod, row, col, t) {
    return this.hasMask ? this.#peekAux('mask', lod, row, col, t) : null;
  }

  peekCoverage(lod, row, col, t) {
    return this.hasCoverage ? this.#peekAux('coverage', lod, row, col, t) : null;
  }

  /** Whether `timesteps` timesteps (default: the whole axis) of `cellCount` cells at `lod` fit the window budget of the decoded cache. */
  loopFits(lod, cellCount, timesteps = this.level(lod).nTime) {
    return cellCount * timesteps * this.level(lod).chunkBytes <= this.maxCacheBytes * WINDOW_BUDGET_FRACTION;
  }

  /**
   * Background fetch of a time window around t for the given cells at one level, nearest first
   * (scrubCost order, so the scrub direction reaches further). Chunks near t are decoded; chunks the decoded tier cannot hold are kept as compressed
   * bytes when the cache has room. A new chunk only displaces cached ones that score worse (see `evictionScore`).
   *
   * How far the window reaches depends on what the viewer is doing. While it plays (`playing`, or `loop`, which
   * plans a looping movie) the window is as wide as the cache allows for these cells: the whole time axis when it
   * fits. Otherwise it stops at the horizon, `horizonSteps` timesteps either side of t (12 by default); when scrubbing it reaches further in the scrub direction within that. If nothing has
   * moved t for `idleMs` (3 s), the viewer is idle, and prefetch also stops once it has started `idleBytes` (64 MiB)
   * of speculative traffic for this view and timestep; a scrub, playback or new view starts a new allowance. A
   * `seek` (the view just jumped) does not widen anything: it only cancels the other speculative requests.
   *
   * Speculative traffic is metered: 16 MB may start at once, after that half the measured bandwidth. Prefetch
   * waits while any demand fetch is in flight and never takes the last request slots. A cell whose chunk
   * failed is left alone for PREFETCH_COOLDOWN_MS. Aborting `signal` cancels this job's fetches that nobody else
   * waits for. With `seek`, the chunks of timestep `t` itself (its data) are fetched at demand
   * priority outside the allowance before the rest of the window. Resolves with counts and per-chunk errors
   * (nothing is thrown or hidden); `budgetReached` says the cache or the idle allowance stopped it early.
   *
   * With `masks`, the validity mask of every chunk of the window is fetched alongside it (same priority, same
   * allowances; a mask is cached under its own budget and `peekMask` returns it once it is in). `onChunk` fires when
   * the chunk and its mask are both loaded.
   *
   * @param {{lod:number, cells:Array<[number, number]>, t:number, direction?:1|-1, behindFactor?:number, loop?:boolean, playing?:boolean,
   *   seek?:boolean, masks?:boolean, concurrency?:number, signal?:AbortSignal, onChunk?:(lod,row,col,t)=>void}} job
   */
  async prefetch({ lod, cells, t, direction = 1, behindFactor = 2, loop = false, playing = false, seek = false, masks = false, concurrency = DEFAULT_PREFETCH_CONCURRENCY, signal, onChunk }) {
    if (this.#closeController.signal.aborted) throw new Error('ChronoStore is closed');
    signal = signal ? AbortSignal.any([signal, this.#closeController.signal]) : this.#closeController.signal;
    const level = this.level(lod);
    const wholeAxis = playing || loop;
    const withMasks = masks && this.hasMask;
    this.#noteActivity({ lod, cells, t, wholeAxis });
    if (seek) this.#cancelSpeculative();
    const targets = new Set([t]);
    const horizon = wholeAxis ? null : this.#policy.horizonSteps;
    const queue = this.#windowPlan(level, cells, t, { direction, behindFactor, loop }, horizon).map(([row, col, ct]) => ({ row, col, t: ct, free: seek && targets.has(ct) }));
    const result = { planned: queue.length, fetched: 0, skipped: 0, compressedOnly: 0, masks: 0, budgetReached: false, errors: [] };
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !signal?.aborted && !result.budgetReached) {
        const { row, col, t: tt, free } = queue[next++];
        const key = chunkKey(lod, row, col, tt);
        const failedAt = this.#cellFailures.get(`${lod}/${row}/${col}`);
        const failed = failedAt !== undefined && this.#now() - failedAt < PREFETCH_COOLDOWN_MS;
        let idleCharge = 0;
        try {
          if (this.#cache.has(key) || this.#inflight.has(key) || failed) {
            result.skipped++;
            // A chunk that is already here may have lost its mask to eviction; a failed cell is left alone.
            if (withMasks && !failed && this.#maskAllowed(wholeAxis)) {
              const maskEntry = this.#prefetchMask(lod, row, col, tt, signal);
              if (maskEntry) {
                await this.#settle([maskEntry.promise]);
                this.#chargeMask(maskEntry, wholeAxis);
                result.masks++;
              }
            }
            continue;
          }
          if (!free) await this.#demandIdle(signal);
          if (signal?.aborted) return;
          const meta = { kind: 'data', lod, row, col, t: tt };
          if (!this.#canPlace(meta, level.chunkBytes)) {
            result.budgetReached = true;
            return;
          }
          if (!free) {
            const estimate = level.chunkBytes * this.#compressionRatio;
            await this.#awaitSpeculative(estimate, signal);
            if (signal?.aborted) return;
            idleCharge = wholeAxis ? 0 : this.#chargeIdle(estimate);
            if (idleCharge === null) {
              this.#speculative.spend(-estimate);
              result.budgetReached = true;
              return;
            }
          }
          // The mask of the chunk is fetched alongside it, charged to the same allowances once its size is known.
          const maskEntry = withMasks ? this.#prefetchMask(lod, row, col, tt, signal) : null;
          const dataEntry = this.#start(key, meta, { background: !free, owner: signal ?? true });
          const [data] = await this.#settle([dataEntry.promise, maskEntry?.promise]);
          if (maskEntry) {
            this.#chargeMask(maskEntry, wholeAxis);
            result.masks++;
          }
          result.fetched++;
          if (data) onChunk?.(lod, row, col, tt);
          else result.compressedOnly++;
        } catch (error) {
          this.#refundIdle(idleCharge);
          if (isAbort(error)) continue;
          result.errors.push({ key, error });
          this.#cellFailures.set(`${lod}/${row}/${col}`, this.#now());
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return result;
  }

  /** Wait for every promise (absent ones count as resolved with undefined), then throw the first rejection or return the values. */
  async #settle(promises) {
    const outcomes = await Promise.allSettled(promises);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason;
    return outcomes.map((outcome) => outcome.value);
  }

  /** Start the mask of a chunk at speculative priority, unless it is cached, in flight, or would not be kept. Returns the in-flight entry or null. */
  #prefetchMask(lod, row, col, t, owner) {
    const key = this.#auxKey('mask', lod, row, col, t);
    const level = this.levels[lod];
    const meta = { kind: 'mask', lod, row, col, t };
    if (this.#auxCache.has(key) || this.#inflight.has(key) || !this.#auxCache.canHoldDecoded(meta, level.chunkHeight * level.chunkWidth)) return null;
    return this.#start(key, meta, { background: true, owner: owner ?? true });
  }

  /** A mask on its own (its chunk is already cached) starts only while the speculative allowance and the idle allowance have room. */
  #maskAllowed(wholeAxis) {
    const idleLeft = wholeAxis || this.#clock() < this.#activity.activeUntil || this.#activity.idleSpent < this.#policy.idleBytes;
    return idleLeft && this.#speculative.waitMs(1, this.#bandwidth.estimate) === 0;
  }

  /** What a mask turned out to cost goes against the speculative allowance and, while idle, the idle allowance. */
  #chargeMask(entry, wholeAxis) {
    const bytes = entry.fetchedBytes ?? 0;
    this.#speculative.spend(bytes);
    if (!wholeAxis && this.#clock() >= this.#activity.activeUntil) this.#activity.idleSpent += bytes;
  }

  /**
   * What the viewer is doing, from the prefetch calls it makes: a timestep that differs from the last call's is a
   * scrub, playback is playback; both keep the store out of idle for `idleMs` and give the next idle episode a new
   * byte allowance, as does a different view (level or cells). The first call after open is not activity.
   */
  #noteActivity({ lod, cells, t, wholeAxis }) {
    const activity = this.#activity;
    const viewKey = `${lod}:${cells.map(([row, col]) => `${row}/${col}`).sort().join(',')}`;
    const moved = activity.t !== null && activity.t !== t;
    if (moved || wholeAxis) activity.activeUntil = this.#clock() + this.#policy.idleMs;
    if (moved || wholeAxis || viewKey !== activity.viewKey) activity.idleSpent = 0;
    activity.t = t;
    activity.viewKey = viewKey;
  }

  /** Idle prefetch may start `idleBytes` per episode. Returns the bytes charged (0 while scrubbing), or null when the allowance is used up. */
  #chargeIdle(bytes) {
    const activity = this.#activity;
    if (this.#clock() < activity.activeUntil) return 0;
    if (activity.idleSpent + bytes > this.#policy.idleBytes) return null;
    activity.idleSpent += bytes;
    return bytes;
  }

  #refundIdle(bytes) {
    this.#activity.idleSpent = Math.max(0, this.#activity.idleSpent - bytes);
  }

  /** Chunks [row, col, t] to prefetch, in fetch order; with a `horizon`, only timesteps within that many of t . */
  #windowPlan(level, cells, t, order, horizon) {
    const decodedChunks = this.#cache.decodedLimit / level.chunkBytes;
    const compressedChunks = this.#cache.compressedLimit / (level.chunkBytes * this.#compressionRatio);
    // Decoded chunks plus chunks held only compressed (copies of decoded chunks give way when the cache fills), at most
    // as many as the joint cap holds when every one of them is compressed.
    const capacity = this.#cache.compressedLimit > 0 ? Math.min(decodedChunks + compressedChunks, this.#cache.maxTotal / (level.chunkBytes * this.#compressionRatio)) : decodedChunks;
    const perCellLimit = Math.max(1, Math.floor((capacity * WINDOW_BUDGET_FRACTION) / Math.max(1, cells.length)));
    const timesteps = windowOrder(level.nTime, t, order).filter((tt) => horizon === null || Math.abs(tt - t) <= horizon);
    const chosen = timesteps.slice(0, perCellLimit);
    return chosen.flatMap((ct) => cells.map(([row, col]) => [row, col, ct]));
  }

  /** Whether a background chunk of this cell would be kept by either cache tier. */
  #canPlace(meta, decodedSize) {
    return this.#cache.canHoldDecoded(meta, decodedSize) || this.#cache.canHoldCompressed(meta, decodedSize * this.#compressionRatio);
  }

  /** Wait until `bytes` of speculative traffic may start, then spend them. */
  async #awaitSpeculative(bytes, signal) {
    for (;;) {
      this.#updateSpeculativeShare();
      const waitMs = this.#speculative.waitMs(bytes, this.#bandwidth.estimate);
      if (waitMs === 0) break;
      // Unknown bandwidth: look again soon, since demand traffic or a new budget can change that.
      await sleep(Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 10), 250) : 50, signal);
    }
    this.#speculative.spend(bytes);
  }

  /** The allowance earns at the idle share only while no demand read is pending and the bandwidth estimate is established. */
  #updateSpeculativeShare() {
    const idle = this.#demandInflight === 0 && this.#bandwidth.mature;
    this.#speculative.setShare(idle ? SPECULATIVE_SHARE_IDLE : SPECULATIVE_SHARE_PENDING, this.#bandwidth.estimate);
  }

  #checkCell(level, row, col) {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= level.gridRows || col >= level.gridCols) {
      throw new RangeError(`cell (${row}, ${col}) outside ${level.gridRows}x${level.gridCols} grid at lod ${level.lod}`);
    }
  }

  // ---- mask and coverage ----

  #auxKey(kind, lod, row, col, t) {
    return `${kind}/${chunkKey(lod, row, col, t)}`;
  }

  #peekAux(kind, lod, row, col, t) {
    return this.#auxCache.decoded(this.#auxKey(kind, lod, row, col, t));
  }

  async #getAux(kind, lod, row, col, t, signal) {
    if (this.#closeController.signal.aborted) throw new Error('ChronoStore is closed');
    if (this.#storage[kind] === null) return null;
    const level = this.level(lod);
    this.#checkCell(level, row, col);
    if (!Number.isInteger(t) || t < 0 || t >= level.nTime) throw new RangeError(`timestep ${t} out of range 0..${level.nTime - 1}`);
    const key = this.#auxKey(kind, lod, row, col, t);
    const cached = this.#peekAux(kind, lod, row, col, t);
    if (cached) return cached;
    let entry = this.#inflight.get(key);
    if (entry && !entry.controller.signal.aborted) this.#join(entry);
    else entry = this.#start(key, { kind, lod, row, col, t }, { background: false });
    return this.#subscribe(entry, signal);
  }

  // ---- loading ----

  /** A demand caller joins a fetch that is already running: count it, and move it to demand priority. */
  #join(entry) {
    this.#counters.cache.joins++;
    this.#network.deduped++;
    if (entry.priority.value !== 0) {
      entry.priority.value = 0;
      const index = this.#shardIndexes.get(entry.indexKey);
      if (index) index.priority.value = 0;
      this.#limiter.reprioritize();
      this.#decoder.reprioritize?.();
    }
  }

  /**
   * Begin loading a chunk (fetch then decode, or decode alone for a chunk held compressed) and register it as in
   * flight. `owner` is the prefetch signal (or true) that wants a background chunk; the fetch is cancelled when
   * its owner aborts and no caller is waiting on it.
   */
  #start(key, meta, { background, owner = null }) {
    const controller = new AbortController();
    const entry = { controller, waiters: 0, sticky: false, owned: owner !== null, background, priority: { value: background ? 1 : 0 }, promise: null };
    const onOwnerAbort = () => {
      entry.owned = false;
      this.#cancelIfUnwanted(entry);
    };
    if (owner && owner !== true) {
      owner.addEventListener('abort', onOwnerAbort, { once: true });
    }
    if (!background) {
      this.#demandInflight++;
      this.#updateSpeculativeShare();
    }
    entry.promise = this.#load(key, meta, entry)
      .finally(() => {
        if (owner && owner !== true) owner.removeEventListener('abort', onOwnerAbort);
        if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
        if (!background && --this.#demandInflight === 0) {
          this.#updateSpeculativeShare();
          for (const wake of this.#demandIdleWaiters.splice(0)) wake();
        }
      });
    this.#inflight.set(key, entry);
    return entry;
  }

  #cancelIfUnwanted(entry) {
    if (entry.waiters === 0 && !entry.sticky && !entry.owned) this.#abortEntry(entry);
  }

  /** Abort a fetch that nobody wants any more. Its rejection (an AbortError) has no one left to handle it, so it is marked handled here. */
  #abortEntry(entry) {
    entry.promise.catch(() => {});
    entry.controller.abort();
  }

  /** The view jumped: cancel every speculative fetch nobody is waiting for. */
  #cancelSpeculative() {
    for (const entry of this.#inflight.values()) {
      if (!entry.background) continue;
      entry.owned = false;
      this.#cancelIfUnwanted(entry);
    }
  }

  async #load(key, meta, entry) {
    const { kind, lod } = meta;
    const signal = entry.controller.signal;
    const spec = this.#specs[kind];
    const requestedAt = performance.now();
    const held = kind === 'data' ? this.#cache.get(key)?.compressed : null;
    const bytes = held ?? (await this.#fetchBytes(meta, signal, entry));
    const fetchedAt = performance.now();
    const level = this.levels[lod];
    const storage = this.#storage[kind][lod];
    const TypedArray = DTYPES[storage.dtype].Array;
    const size = kind === 'data' ? level.chunkBytes : level.chunkHeight * level.chunkWidth;
    let data = null;
    let retained = null;
    if (bytes === undefined) {
      data = new TypedArray(size / DTYPES[storage.dtype].bytes).fill(storage.fillValue);
    } else {
      const keepCompressed = kind === 'data' && this.#cache.maxCompressed > 0;
      if (!held) {
        entry.fetchedBytes = bytes.length;
        if (kind === 'data') this.#compressionRatio = 0.9 * this.#compressionRatio + 0.1 * (bytes.length / size);
        if (entry.background) this.#counters.cache.speculativeBytes += bytes.length;
      }
      // The pool takes ownership of what it decodes, so a copy goes in when the bytes are also being kept.
      retained = held ?? (keepCompressed ? (bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength ? bytes : bytes.slice()) : null);
      const decodeNow = !entry.background || kind !== 'data' || !keepCompressed || this.#cache.canHoldDecoded(meta, size);
      if (decodeNow) data = await this.#decoder.decode(retained ? retained.slice() : bytes, entry.priority, signal, spec);
    }
    const decodedAt = performance.now();
    if (signal.aborted) throw abortError();
    this.#counters.loads.count++;
    if (!held) this.#counters.loads.fetchMs += fetchedAt - requestedAt;
    this.#counters.loads.decodeMs += decodedAt - fetchedAt;
    this.probe?.({ type: 'chunk', key, t: meta.t, background: entry.background, requestedAt, fetchedAt, decodedAt, bytes: held ? 0 : (bytes?.length ?? 0), decoded: data !== null });
    if (kind === 'data') {
      this.#cache.insert(key, { kind, lod, row: meta.row, col: meta.col, t: meta.t }, { data, compressed: held ? null : retained }, { background: entry.background && entry.priority.value !== 0 });
    } else {
      this.#auxCache.insert(key, { kind, lod, row: meta.row, col: meta.col, t: meta.t }, { data }, { background: entry.background && entry.priority.value !== 0 });
    }
    return data ?? undefined;
  }

  /** Compressed bytes of one chunk, or undefined when the store has no such chunk (fill value). */
  async #fetchBytes({ kind, lod, row, col, t }, signal, entry) {
    const priority = entry.priority;
    const storage = this.#storage[kind][lod];
    const base = `/${this.levels[lod].path}/${this.#names[kind]}/`;
    const coords = (time) => (kind === 'data' ? [time, 0, row, col] : [time, row, col]);
    if (!storage.sharded) return this.#readable.get(base + storage.keyOf(coords(t)), { signal, priority });
    const shardIndex = Math.floor(t / storage.shardTime);
    const shardKey = base + storage.keyOf(coords(shardIndex));
    entry.indexKey = `${lod}/${shardKey}`;
    const index = await this.#shardIndex(kind, lod, row, col, shardIndex, shardKey, storage, priority);
    if (index === undefined) return undefined;
    const at = t % storage.shardTime;
    const offset = index[2 * at];
    if (offset < 0) return undefined;
    return this.#readable.getRange(shardKey, { offset, length: index[2 * at + 1] }, { signal, priority });
  }

  /** Shard index: read once, shared by every chunk of the shard, never tied to one caller's signal (see #readShardIndex). */
  #shardIndex(kind, lod, row, col, shardIndex, shardKey, storage, priority) {
    const cacheKey = `${lod}/${shardKey}`;
    const cached = this.#shardIndexes.get(cacheKey);
    if (cached) {
      if (!cached.settled) {
        this.#network.deduped++;
        if (priority.value === 0 && cached.priority.value !== 0) {
          cached.priority.value = 0;
          this.#limiter.reprioritize();
        }
      }
      return cached.promise;
    }
    const handle = { value: priority.value };
    // shard_bytes covers the data array only.
    const hintAt = kind === 'data' ? { path: this.levels[lod].path, key: `${shardIndex}/${row}/${col}` } : null;
    const promise = this.#readShardIndex({ cacheKey, shardKey, storage, handle, hintAt });
    const cacheEntry = { promise, priority: handle, settled: false };
    promise.then(
      () => (cacheEntry.settled = true),
      () => this.#shardIndexes.delete(cacheKey),
    );
    this.#shardIndexes.set(cacheKey, cacheEntry);
    return promise;
  }

  /**
   * Read one shard index. With a `shard_bytes` length (end-located index) it is the bounded range for that length;
   * otherwise a suffix read (HEAD then range, or `bytes=-N` with suffixRequests). The length is a hint that goes
   * stale when the store is appended to (the trailing shard grows), and then the read lands on chunk bytes: the
   * checksum or length check fails, or the server answers 416. That, and only that, starts a recovery:
   *
   * 1. If a re-read root has replaced the lengths since this read started (or one is in flight), use those; else
   *    re-read the root zarr.json once (past the HTTP cache, `cache: 'reload'`) and adopt its `shard_bytes`. At most once
   *    per shard per minute, and not at all for a minute after a re-read that brought no new lengths (ROOT_REFETCH_INTERVAL_MS),
   *    so a broken store costs a bounded number of reads.
   * 2. Retry the index read with the length for this shard, if the root gave a different one.
   * 3. Still failing, or nothing new to try: read the index with a suffix range, which needs no hint.
   *
   * Chunks the reader already holds an index for are untouched: appends keep old chunks at their offsets. A failure
   * of another kind (network, 5xx, a shard without hint whose checksum fails) is not a stale length and is thrown as is.
   */
  async #readShardIndex({ cacheKey, shardKey, storage, handle, hintAt }) {
    const where = `${this.url}${shardKey}`;
    const lookup = () => (hintAt ? this.#shardBytes?.[hintAt.path]?.[hintAt.key] : undefined);
    const rangeFor = (shardBytes) => shardIndexRange(storage.shardTime, storage.indexHasCrc, storage.indexAtStart, shardBytes);
    // Only an end-located index read with a known shard length can go stale.
    const hinted = (range) => !storage.indexAtStart && 'offset' in range;
    const read = async (shardBytes) => {
      const range = rangeFor(shardBytes);
      const bytes = await this.#readable.getRange(shardKey, range, { priority: handle, rangeMiss: hinted(range) });
      if (bytes === null) throw new ShardIndexError(`${where}: HTTP 416 for shard index range bytes=${range.offset}-${range.offset + range.length - 1}, the shard is shorter than shard_bytes says (${shardBytes})`);
      return bytes && parseShardIndex(bytes, storage.shardTime, storage.indexHasCrc, where, hinted(range) ? shardBytes : undefined);
    };

    const hint = lookup();
    if (!hinted(rangeFor(hint))) return read(hint);
    const epoch = this.#hintEpoch;
    try {
      return await read(hint);
    } catch (error) {
      if (!isStaleHint(error)) throw error;
    }

    const recoveries = this.#recoveries;
    if (this.#hintEpoch === epoch) {
      if (this.#rootRefresh) await this.#rootRefresh;
      else if (this.#mayRefetchRoot(cacheKey)) await this.#refetchRoot();
      else recoveries.suppressed++;
    }
    const fresh = lookup();
    if (this.#hintEpoch !== epoch && fresh !== hint && hinted(rangeFor(fresh))) {
      try {
        const index = await read(fresh);
        recoveries.retried++;
        return index;
      } catch (error) {
        if (!isStaleHint(error)) throw error;
      }
    }
    recoveries.suffixFallbacks++;
    console.warn(`chronozarr: ${where}: shard_bytes (${hint}) does not match the shard object; reading its index with a suffix range instead`);
    return read(undefined);
  }

  /**
   * True, and recorded, when the root may be re-read on behalf of this shard: once per shard per ROOT_REFETCH_INTERVAL_MS,
   * and not at all for that long after a re-read that found nothing new (a root that stays stale, or cannot be read,
   * would otherwise be asked once for every shard that disagrees with it).
   */
  #mayRefetchRoot(cacheKey) {
    const now = this.#clock();
    if (this.#noNewHintsAt !== null && now - this.#noNewHintsAt < ROOT_REFETCH_INTERVAL_MS) return false;
    const last = this.#recoveredAt.get(cacheKey);
    if (last !== undefined && now - last < ROOT_REFETCH_INTERVAL_MS) return false;
    this.#recoveredAt.set(cacheKey, now);
    return true;
  }

  /**
   * Re-read the root zarr.json past the browser's HTTP cache and adopt its `shard_bytes` (nothing else of it: an index
   * read needs no time axis length, since a shard index always has shard_time entries, and `times` stays as opened).
   * Demand priority: a read is waiting. Never rejects; when the root cannot be read, has no chronozarr block or lists
   * the same lengths as before, they stay as they were and the caller falls back to a suffix read. Shards that fail
   * meanwhile share this read.
   */
  #refetchRoot() {
    this.#recoveries.rootRefetches++;
    const refresh = (async () => {
      try {
        const bytes = await this.#readable.get('/zarr.json', { priority: 0, reload: true, signal: this.#closeController.signal });
        if (this.#closeController.signal.aborted) return;
        if (!bytes) throw new Error('root zarr.json not found');
        const cz = JSON.parse(new TextDecoder().decode(bytes)).attributes?.chronozarr;
        if (!cz) throw new Error('the root has no chronozarr attributes');
        const hints = cz.shard_bytes ?? null;
        if (JSON.stringify(hints) !== JSON.stringify(this.#shardBytes)) {
          this.#shardBytes = hints;
          this.#hintEpoch++;
          this.#noNewHintsAt = null;
          return;
        }
      } catch (error) {
        if (isAbort(error)) return;
        console.warn(`chronozarr: ${this.url}: cannot reload zarr.json to refresh shard_bytes (${error.name}: ${error.message})`);
      }
      this.#noNewHintsAt = this.#clock();
    })();
    this.#rootRefresh = refresh;
    refresh.then(() => {
      if (this.#rootRefresh === refresh) this.#rootRefresh = null;
    });
    return refresh;
  }

  /** Each caller gets its own promise; a caller that aborts is released, and the last one out cancels the fetch. */
  #subscribe(entry, signal) {
    if (!signal) {
      entry.sticky = true;
      return entry.promise;
    }
    return new Promise((resolve, reject) => {
      entry.waiters++;
      let done = false;
      const finish = () => {
        done = true;
        signal.removeEventListener('abort', onAbort);
        entry.waiters--;
      };
      const onAbort = () => {
        if (done) return;
        finish();
        reject(abortError());
        this.#cancelIfUnwanted(entry);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (data) => {
          if (done) return;
          finish();
          resolve(data);
        },
        (error) => {
          if (done) return;
          finish();
          reject(error);
        },
      );
    });
  }

  #demandIdle(signal) {
    if (this.#demandInflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        signal?.removeEventListener('abort', finish);
        const at = this.#demandIdleWaiters.indexOf(finish);
        if (at >= 0) this.#demandIdleWaiters.splice(at, 1);
        resolve();
      };
      this.#demandIdleWaiters.push(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
