// chronozarr viewer: renders a chronozarr store with WebGL2, scrubs through time, switches
// products on the GPU and shows decoded values on click. Opens ?store=<base url>.

import { chunkKey, openStore, samplePixelFrom, scrubCost, windowOrder } from '../chronozarr/decoder.js';
import { buildSeries, chartRange, gapFilledTimes, seriesPath, seriesSpecs, timeFromX, validAt, windowPixels, xFromTime } from './chart.js';
import { ASSUMED_BANDWIDTH, ancestorCells, planCoarseStages, stageLeadMs } from './coarse.js';
import { chooseFrame } from './frames.js';
import { DEFAULT_STEPS_PER_SECOND, Playback, SPEEDS, chooseMovieLevel, describeReason, linkAllows, snapSpeed, wireRatio } from './playback.js';
import { applyEmbedAttributes, connectEmbed, parseEmbedParams } from './embed.js';
import { DRAWER_BELOW, inspectorLayout } from './layout.js';
import { decodeView, encodeView } from './permalink.js';
import { toggleExportPanel } from './export.js';
import { FrameMonitor, formatBytes, formatMs, formatRate, hitRate, readStats } from './perf.js';
import { Renderer } from './renderer.js';
import { MAX_SCALE, bindViewerInput } from './input.js';
import { formatValue, sidebarHtml } from './inspector.js';
import {
  computeStretchLo,
  describePixel,
  displayMode,
  findBand,
  inputConversion,
  inputIndices,
  makeTimeFormatter,
  nodataToCompare,
  normalizeBands,
  percentileRange,
  resolveProducts,
  toPhysical,
} from '../shared/products.js';

const PREFETCH_SETTLE_MS = 30;
const PREFETCH_PLAYBACK_RESTART_MS = 250;
const BEHIND_FACTOR = 2;
const BEHIND_FACTOR_PLAYING = 8;
const GPU_SLICE_FRACTION_OF_FRAME = 0.25;
const POOL_BUDGET_BYTES = 384 * 1024 * 1024;
const GPU_FILL_FRACTION = 0.9;
const GPU_UPLOAD_SLICE_MS = 4;
// Pick the coarsest level that still has at least ~0.7 texels per canvas pixel; a bias of 0 would pick
// the finest level whenever it is even slightly denser than the screen, at 4x the bytes per level.
const LOD_BIAS = 0.5;
const CELL_RETRY_DELAY_MS = 4000;
const MAX_CELL_RETRIES = 3;
const TOAST_MS = 12000;
const SPEED_KEY = 'chronozarr.stepsPerSecond';
const STRETCH_SAMPLES_PER_CELL = 300;
const URL_SYNC_MS = 300;
const CHART_BATCH = 4;
const CHART_RENDER_MS = 120;
// A time change of more than this many steps is a jump: the speculative fetches around the old position are dropped.
const SEEK_DISTANCE = 4;
const PERF_UPDATE_MS = 250;
const GAP_HATCH_PX = 8;
const GAP_MASK_CACHE = 48;
// Timesteps the playback buffer loads at once, at demand priority.
const BUFFER_BATCH = 3;
// Eviction rank of the chunks of the coarse loop: after what the view shows, before everything else.
const COARSE_LOOP_RANK = 5e5;
// Chart geometry in SVG units (the svg scales to the sidebar width).
const CHART = { width: 264, height: 124, left: 34, right: 256, top: 8, bottom: 104 };

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Resolves after `ms`, or as soon as `signal` aborts. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** The last playback speed, if localStorage has a usable one (it can be missing or blocked). */
function loadSpeed() {
  try {
    const stored = localStorage.getItem(SPEED_KEY);
    if (stored !== null && Number.isFinite(Number(stored))) return snapSpeed(Number(stored));
  } catch (error) {
    console.warn('could not read the saved playback speed:', error);
  }
  return DEFAULT_STEPS_PER_SECOND;
}

function saveSpeed(stepsPerSecond) {
  try {
    localStorage.setItem(SPEED_KEY, String(stepsPerSecond));
  } catch (error) {
    console.warn('could not save the playback speed:', error);
  }
}

/** `?a&b` from the non-empty query parts, or the bare path when there are none. */
function composeQuery(...parts) {
  const query = parts.filter(Boolean).join('&');
  return query ? `?${query}` : location.pathname;
}

class Viewer {
  canvas = $('gl-canvas');
  renderer;
  store = null;
  products = [];
  productIndex = 0;
  bandChoice = 0;
  /** The store's bands as {name, common_name?, scale, offset, divisor, units?}. */
  bands = [];
  /** Data type of the store: uint8, uint16, int16 or float32. */
  dtype = 'uint16';
  t = 0;
  camera = { cx: 0, cy: 0, scale: 1 };
  /** Force one LOD regardless of zoom (benchmarks). */
  lodOverride = null;
  /** Benchmarks set this to receive timestamped events: input, load-start, cell-ready, paint. */
  probe = null;
  /**
   * What the embed bridge listens to (embed.js): ready() when a store has opened, time({t}) on a timestep change,
   * view() on a camera change, click({pixel, t, lod, info}) on a click inside the store, error({code, title, message}).
   * Empty outside an embed.
   */
  hooks = {};
  /** The viewer runs in an iframe of another page (?embed=1): the inspector is always a drawer. */
  embedded = false;
  /** Whether a click opens the inspector (the sidebar and the chart of the clicked pixel); off for an embed with controls=0. */
  inspectorUi = true;
  /** The embed parameters to keep in the address bar next to the store and the view (embed.js parseEmbedParams().query). */
  extraQuery = '';

  /** Timestep of the last complete frame. */
  paintedT = -1;

  #formatTime = (t) => String(t);
  #direction = 1;
  #stretchLo = null;
  /** Linear stretch of a single band that is not reflectance: the [lo, hi] range (null until measured) and whether the user set it. */
  #linear = { range: null, manual: false };
  /** The canvas must be painted again even if the frame to show is the one already on it (the camera, product or size changed). */
  #dirty = true;
  /** The frame on the canvas: {lod, t, cells (a Set of "row/col"), kind}; null until the first one. */
  #shown = null;
  /** Whether the frame at the level and timestep that were asked for is not the one on screen yet. */
  #loading = false;
  #keptKey = null;
  /** The whole-loop prefetch at the coarsest useful level, {key, controller}, and that level (-1: none). */
  #coarseLoop = null;
  #coarseLoopLod = -1;
  /** Fills the playback buffer: {wanted, running, controller}. */
  #bufferPump = null;
  #frameStats = { painted: 0, fallback: 0, kept: 0 };
  #view = { lod: 0, cells: new Set() };
  #maxVisibleCells = 0;
  #rafId = 0;
  #prefetchTimer = 0;
  #prefetchStartedAt = -Infinity;
  #gpuFillTimer = 0;
  #prefetchAbort = null;
  #painted = [];
  #storeGeneration = 0;
  #tickElements = [];
  #wave = null;
  #toastTimer = 0;
  #playback = null;
  #exportHold = null;
  #speed = loadSpeed();
  #movie = { baseLod: 0, lod: 0, reason: null, detail: null };
  #wasPlaying = false;
  #chart = null;
  #chartTimer = 0;
  #urlTimer = 0;
  #viewTiming = null;
  #movieMemo = null;
  #playEpoch = 0;
  #seekPending = false;
  /** How long the store's metadata took to fetch: one round trip to the store, more or less. */
  #roundTripMs = 0;
  #perf = { monitor: new FrameMonitor(), timer: 0 };
  #gaps = { visible: false, masks: new Map(), requested: new Set() };
  #hatch = null;
  #storeSummary = '';
  #paintMs = null;
  /** The store URL to keep in the address bar (?store=), or null for a catalog store. Set by the page. */
  pinnedStore = null;

  constructor() {
    this.renderer = new Renderer(this.canvas);
    this.renderer.evictionScore = (meta) => this.#chunkScore(meta);
    this.#resizeCanvas();
    new ResizeObserver(() => {
      // A fitted view stays fitted when the canvas changes size (the first layout of an embedded pane can be 1 px wide).
      const refit = Boolean(this.store) && this.#atFit();
      this.#resizeCanvas();
      if (refit) {
        this.fit();
        return;
      }
      this.#beginView('camera');
      this.#dirty = true;
      this.requestRender();
    }).observe(this.canvas.parentElement);
    this.#bindInput();
    this.#bindChart();
    this.#bindWordmark();
    this.#trackTimelineHeight();
    // Crossing the breakpoint either way starts the drawer closed rather than reopening one left open at the other width.
    window.matchMedia(`(width < ${DRAWER_BELOW}px)`).addEventListener('change', () => this.closeInspector());
  }

  /**
   * Open a store and resolve after the first complete frame is painted. The result has the time to open the
   * metadata (`openMs`), to the first frame that covers the whole view at some level (`coarseMs`, from the call;
   * `coarseAfterMetadataMs`) and to the first complete frame at the target level (`firstPaintMs`).
   * @param {string} url
   * @param {{lod?:number, fetch?:typeof fetch, maxCacheBytes?:number, workers?:number, camera?:{cx:number,cy:number,scale:number},
   *   viewSearch?:string}} [options]  `viewSearch`: a query string whose t, p, b, z, c parameters restore the view (see permalink.js)
   */
  async loadStore(url, options = {}) {
    this.#playback?.pause();
    this.#clearChart();
    this.#abortBackground();
    this.store?.close();
    const generation = ++this.#storeGeneration;
    this.#hideError();
    this.#setProgress(0.02);
    const started = performance.now();
    let store;
    try {
      store = await openStore(url, { fetch: options.fetch, maxCacheBytes: options.maxCacheBytes, workers: options.workers });
      this.#checkUniformChunks(store);
    } catch (error) {
      this.#showError('Could not open store', error.message, { code: 'store_open_failed' });
      this.#setProgress(0);
      throw error;
    }
    if (generation !== this.#storeGeneration) {
      store.close();
      return null;
    }
    const openMs = performance.now() - started;
    this.#roundTripMs = openMs;

    this.store = store;
    store.evictionScore = (entry) => this.#storeScore(entry);
    this.bands = normalizeBands(store.attrs.bands);
    this.dtype = store.dtype;
    this.#configurePool();
    this.#playback = this.#createPlayback();
    this.#movieMemo = null;
    this.#linear = { range: null, manual: false };
    this.#gaps = { visible: false, masks: new Map(), requested: new Set() };
    this.#drawGapOverlay();
    this.products = resolveProducts(this.bands);
    this.productIndex = this.products.findIndex((p) => p.available);
    this.bandChoice = 0;
    this.t = 0;
    this.paintedT = -1;
    this.#shown = null;
    this.#loading = false;
    this.#keptKey = null;
    this.#frameStats = { painted: 0, fallback: 0, kept: 0 };
    this.#direction = 1;
    this.#stretchLo = null;
    this.lodOverride = options.lod ?? null;
    this.#formatTime = makeTimeFormatter(store.times);
    this.#dirty = true;
    const bandNames = this.bands.map((band) => band.name);
    const view = options.viewSearch
      ? decodeView(options.viewSearch, { count: store.times.length, productIds: this.products.filter((p) => p.available).map((p) => p.id), bands: bandNames, transform: store.transform })
      : {};
    if (view.t !== undefined) this.t = view.t;
    if (view.productId !== undefined) this.productIndex = this.products.findIndex((p) => p.id === view.productId);
    if (view.bandName !== undefined) this.bandChoice = bandNames.indexOf(view.bandName);
    if (options.camera) this.camera = { ...options.camera };
    else if (view.zoom !== undefined || view.center !== undefined) this.#restoreCamera(view);
    else this.fit();
    this.#buildProducts();
    this.#buildTimeline();
    this.#updateTimeUi();
    this.#updatePlayUi();
    this.#updateMeta();
    this.#updateSidebar(null);
    this.closeInspector();
    $('click-hint').classList.remove('hidden');
    this.#updateGapToggle();
    this.#hook('ready');

    const painted = this.whenPainted();
    this.#beginView('open');
    this.renderNow();
    await painted;
    this.#setProgress(1);
    this.syncUrl();
    const { startedAt, coarseAt } = this.#viewTiming;
    return {
      openMs,
      firstPaintMs: performance.now() - started,
      coarseMs: coarseAt === null ? null : coarseAt - started,
      coarseAfterMetadataMs: coarseAt === null ? null : coarseAt - startedAt,
    };
  }

  /**
   * A new view change starts (store open, camera move, time change): the clock for "time to coarse / full frame".
   * A camera move also ends the prefetch for the old view, which would otherwise keep taking the link from the
   * cells the new view is waiting for.
   */
  #beginView(kind) {
    this.#viewTiming = { kind, startedAt: performance.now(), coarseAt: null, fullAt: null };
    if (kind === 'camera') {
      this.#dropSpeculativeFetches();
      this.#hook('view');
    }
  }

  /** How long the last view change took to show a frame covering the whole view (`coarseMs`) and a complete one (`fullMs`); null while pending. */
  get viewTiming() {
    const timing = this.#viewTiming;
    if (!timing) return null;
    return {
      kind: timing.kind,
      coarseMs: timing.coarseAt === null ? null : timing.coarseAt - timing.startedAt,
      fullMs: timing.fullAt === null ? null : timing.fullAt - timing.startedAt,
    };
  }

  fit() {
    const level = this.store.levels[0];
    const { width, height } = this.canvas;
    const scale = Math.min(width / level.width, height / level.height) * 0.94;
    this.camera = { cx: level.width / 2, cy: level.height / 2, scale };
    this.#beginView('camera');
    this.#dirty = true;
    this.requestRender();
    this.#scheduleUrlSync();
  }

  /** Camera from a decoded permalink: zoom is CSS pixels per level-0 pixel, the center is in level-0 pixels. */
  #restoreCamera({ zoom, center }) {
    const level = this.store.levels[0];
    const scale = zoom === undefined ? this.fitScale : clamp(zoom * (window.devicePixelRatio || 1), this.fitScale * 0.5, MAX_SCALE);
    this.camera = {
      cx: center ? clamp(center.col, 0, level.width) : level.width / 2,
      cy: center ? clamp(center.row, 0, level.height) : level.height / 2,
      scale,
    };
  }

  /** Zoom as the permalink states it: CSS pixels per level-0 data pixel (3 significant digits). */
  get zoom() {
    return Number((this.camera.scale / (window.devicePixelRatio || 1)).toPrecision(3));
  }

  /**
   * Move the camera: `zoom` (see the zoom getter) and `center` ({col, row} in level-0 pixels), either one alone to keep
   * the other as it is. The same limits as the mouse: zoomed out to half the fitted view at most, in to 16 canvas pixels per data pixel.
   */
  setView({ zoom, center } = {}) {
    if (!this.store) return;
    const level = this.store.levels[0];
    const scale = zoom === undefined ? this.camera.scale : clamp(zoom * (window.devicePixelRatio || 1), this.fitScale * 0.5, MAX_SCALE);
    this.camera = {
      cx: center ? clamp(center.col, 0, level.width) : this.camera.cx,
      cy: center ? clamp(center.row, 0, level.height) : this.camera.cy,
      scale,
    };
    this.#beginView('camera');
    this.#dirty = true;
    this.requestRender();
    this.#scheduleUrlSync();
  }

  get fitScale() {
    const level = this.store.levels[0];
    return Math.min(this.canvas.width / level.width, this.canvas.height / level.height) * 0.94;
  }

  /** Whether the camera shows the whole store centered at the fitted scale for the current canvas size. */
  #atFit() {
    const level = this.store.levels[0];
    const { cx, cy, scale } = this.camera;
    return Math.abs(scale / this.fitScale - 1) < 0.01 && Math.abs(cx - level.width / 2) < 1 && Math.abs(cy - level.height / 2) < 1;
  }

  /**
   * Show timestep t. A manual call (keys, buttons, the timeline) pauses playback; playback itself passes
   * `playing` and keeps its direction forward when it loops from the last timestep to the first.
   */
  goToTime(t, { playing = false, direction = null } = {}) {
    if (!this.store) return;
    if (!playing) this.#playback?.pause();
    const next = clamp(t, 0, this.store.times.length - 1);
    if (next === this.t) return;
    if (!playing) {
      this.#beginView('time');
      if (Math.abs(next - this.t) > SEEK_DISTANCE) this.#dropSpeculativeFetches({ coarseLoop: true });
    }
    this.#direction = direction ?? (next > this.t ? 1 : -1);
    this.t = next;
    this.#emit({ type: 'input', t: next });
    this.#hook('time', { t: next });
    this.#updateTimeUi();
    if (playing) this.renderNow();
    else {
      this.requestRender();
      this.#scheduleUrlSync();
    }
  }

  /**
   * After a jump in time or a camera move the prefetch window around the old view is stale: cancel what it still has
   * in flight (what the demand fetches for the new view also need stays), and have the next prefetch say so with `seek`.
   */
  #dropSpeculativeFetches({ coarseLoop = false } = {}) {
    this.#seekPending = true;
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = 0;
    this.#prefetchAbort?.abort();
    // A seek cancels every speculative request, the coarse loop's too: plan it again from the new timestep.
    if (coarseLoop) {
      this.#coarseLoop?.controller.abort();
      this.#coarseLoop = null;
    }
  }

  /** `store=<url>` when the store is not from the catalog, else nothing. */
  #storeQuery() {
    return this.pinnedStore ? `store=${encodeURIComponent(this.pinnedStore)}` : '';
  }

  /** The query of the view as it is now: the store when it is not from the catalog, then whatever differs from the default view. */
  #viewQuery() {
    const store = this.#storeQuery();
    if (!this.store) return store;
    const { cx, cy, scale } = this.camera;
    const atFit = this.#atFit();
    const product = this.products[this.productIndex];
    const view = encodeView(
      {
        t: this.t === 0 ? null : this.t,
        productId: this.productIndex === this.products.findIndex((p) => p.available) ? null : product.id,
        bandName: product.id === 'band' && this.bandChoice !== 0 ? this.bands[this.bandChoice].name : null,
        zoom: atFit ? null : scale / (window.devicePixelRatio || 1),
        center: atFit ? null : { col: cx, row: cy },
      },
      { transform: this.store.transform },
    );
    return [store, view].filter(Boolean).join('&');
  }

  /** The address bar keeps the store (when not from the catalog), whatever differs from the default view, and the embed parameters. */
  syncUrl() {
    clearTimeout(this.#urlTimer);
    this.#urlTimer = 0;
    if (!this.store || this.#playing) return;
    history.replaceState(null, '', composeQuery(this.#viewQuery(), this.extraQuery));
  }

  /** The address bar for a store that is about to open: the store (if pinned) and the embed parameters, no view. */
  resetUrl() {
    history.replaceState(null, '', composeQuery(this.#storeQuery(), this.extraQuery));
  }

  /**
   * The wordmark of an embed links to the full viewer on the same store and view. Its address is written when the link
   * is about to be used (pointer over it, focus, press), so it is current whatever happened since the last address bar sync.
   */
  #bindWordmark() {
    const link = $('embed-wordmark');
    const update = () => {
      const url = new URL(location.href);
      url.search = this.#viewQuery();
      url.hash = '';
      link.href = url.href;
    };
    for (const type of ['pointerenter', 'focus', 'pointerdown']) link.addEventListener(type, update);
    update();
  }

  #scheduleUrlSync() {
    if (this.#urlTimer) return;
    this.#urlTimer = setTimeout(() => this.syncUrl(), URL_SYNC_MS);
  }

  get speed() {
    return this.#speed;
  }

  timeLabel(t) {
    return this.#formatTime(t);
  }

  /**
   * An offscreen renderer for exporting the view on screen (same cells, camera center, product and colour
   * stretch), at `scale` times the canvas size. The level is the normal one when `timesteps` steps of the
   * visible cells fit the decoded cache, else the coarser one a movie would play at. It has its own small
   * texture pool and reads the decoded chunk cache, so the viewer keeps working while it runs. See export.js.
   */
  createExportSession({ scale = 1, timesteps = this.store.times.length } = {}) {
    const { store } = this;
    const baseLod = this.#normalLod();
    const deepestLod = Math.max(baseLod, this.#lodForScale(this.camera.scale / 4));
    const lod = this.lodOverride ?? chooseMovieLevel({ baseLod, deepestLod, fits: (candidate) => store.loopFits(candidate, this.#visibleCells(candidate).length, timesteps) }).lod;
    const cells = this.#visibleCells(lod);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(this.canvas.width * scale));
    canvas.height = Math.max(1, Math.round(this.canvas.height * scale));
    const hold = { lod, cells: new Set(cells.map(([row, col]) => `${row}/${col}`)) };
    this.#exportHold = hold;
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = 0;
    this.#prefetchAbort?.abort();
    this.#coarseLoop?.controller.abort();
    this.#coarseLoop = null;
    const renderer = new Renderer(canvas);
    const first = store.levels[0];
    renderer.configure({ dtype: this.dtype, nBand: first.nBand, chunkWidth: first.chunkWidth, chunkHeight: first.chunkHeight, slots: Math.max(4, 2 * cells.length + 4), hasMask: store.hasMask });
    const camera = { ...this.camera, scale: this.camera.scale * scale };
    const chunksFor = (t) => cells.flatMap(([row, col]) => [t].map((ct) => [row, col, ct]));
    const masksReady = (t) => !store.hasMask || cells.every(([row, col]) => store.peekMask(lod, row, col, t));
    return {
      canvas,
      lod,
      cellCount: cells.length,
      fits: (timesteps) => store.loopFits(lod, cells.length, timesteps),
      isReady: (t) => chunksFor(t).every(([row, col, ct]) => store.peekRaw(lod, row, col, ct)) && masksReady(t),
      /** Fetch timestep t for every cell, with its validity mask, at demand priority. */
      prepare: (t, signal) =>
        Promise.all([...chunksFor(t).map(([row, col, ct]) => store.getRaw(lod, row, col, ct, { signal })), ...cells.map(([row, col]) => this.#maskRead(lod, row, col, t, signal))]),
      /** Draw timestep t; false if some cell's chunks or masks are not in the cache (that cell is left empty). */
      render: (t) => {
        renderer.newFrame();
        const drawable = [];
        let complete = true;
        for (const [row, col] of cells) {
          const slots = this.#slotsFor(lod, row, col, t, renderer);
          if (slots) drawable.push({ row, col, slots });
          else complete = false;
        }
        renderer.beginPaint({ width: canvas.width, height: canvas.height, ...camera, ...this.#productUniforms(), stretchLo: this.#stretchLo ?? 0, nodata: this.#nodata }, { clear: true });
        for (const { row, col, slots } of drawable) this.#drawCell(lod, row, col, slots, renderer);
        return complete;
      },
      readPixels: () => renderer.readFrame(canvas.width, canvas.height),
      close: () => {
        renderer.dispose();
        if (this.#exportHold !== hold) return;
        this.#exportHold = null;
        this.#schedulePrefetch();
      },
    };
  }

  get playback() {
    return this.#playback;
  }

  play() {
    this.#playback?.play();
  }

  pause() {
    this.#playback?.pause();
  }

  togglePlay() {
    this.#playback?.toggle();
  }

  /** Steps per second for movie playback, kept between visits. */
  setSpeed(stepsPerSecond) {
    this.#speed = snapSpeed(stepsPerSecond);
    saveSpeed(this.#speed);
    this.#playback?.setSpeed(this.#speed);
    this.#updateSpeedUi();
  }

  /** Whether every visible cell has the chunks for timestep t in memory at the level that is drawn, so showing it needs no fetch. */
  isTimestepReady(t) {
    return this.#frameReady(this.#targetLod(), t);
  }

  setProduct(index) {
    if (!this.products[index]?.available) return;
    this.productIndex = index;
    this.#linear = { range: null, manual: false };
    this.#updateProductUi();
    this.#renderChart();
    this.#dirty = true;
    this.requestRender();
    this.#scheduleUrlSync();
  }

  setBandChoice(index) {
    this.bandChoice = index;
    $('band-select').value = String(index);
    this.#linear = { range: null, manual: false };
    this.#updateStretchUi();
    this.#renderChart();
    this.#dirty = true;
    this.requestRender();
    this.#scheduleUrlSync();
  }

  requestRender() {
    if (this.#rafId) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0;
      this.renderNow();
    });
  }

  /** Resolves after the next complete frame. */
  whenPainted() {
    return new Promise((resolve) => this.#painted.push(resolve));
  }

  /**
   * Paint the current view now and say whether the frame at the level it wants is complete. A frame is always
   * whole: the complete frame at the target level when every visible cell of it is in memory, else the complete
   * frame of the finest coarser level (the same timestep, less resolution), else the frame that is on screen already
   * if it is still complete for this view (see chooseFrame); when none is, the canvas is left as it is. Never a
   * mixture of cells, levels or timesteps. This repaints even when the frame is the one already shown; the viewer's
   * own callbacks go through #render, which leaves the canvas alone in that case. Returns {complete, ms, lod, cells}
   * for the target level.
   */
  renderNow() {
    return this.#render({ force: true });
  }

  #render({ force }) {
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
    if (!this.store) return { complete: false, ms: 0, lod: 0, cells: 0 };
    const started = performance.now();
    const { store, t } = this;
    const lod = this.#targetLod();
    this.#updateResHint();
    const cells = this.#visibleCells(lod);
    this.#view = { lod, cells: new Set(cells.map(([row, col]) => `${row}/${col}`)) };
    const missing = cells.filter(([row, col]) => !this.#cellReady(lod, row, col, t));
    const choice = chooseFrame({
      targetLod: lod,
      coarsestLod: store.levels.length - 1,
      t,
      isReady: (frameLod, frameT) => (frameLod === lod && frameT === t ? missing.length === 0 : this.#frameReady(frameLod, frameT)),
      previous: this.#shown,
    });

    const shown = this.#shown;
    const same = choice !== null && shown !== null && shown.lod === choice.lod && shown.t === choice.t;
    const painted = choice !== null && (force || this.#dirty || !same) && this.#paintFrame(choice, lod);
    const showing = choice !== null && (painted || (same && !this.#dirty)) && choice.kind === 'target';
    const timing = this.#viewTiming;
    if (timing && (painted || same) && choice.t === t) {
      const now = performance.now();
      timing.coarseAt ??= now;
      if (choice.kind === 'target') timing.fullAt ??= now;
    }
    if (choice === null) this.#noteKept(lod, t);
    else this.#keptKey = null;
    this.#setLoading(!showing);

    if (showing) {
      if ($('error-overlay').classList.contains('toast')) this.#hideError();
      this.#wave?.controller.abort();
      this.#wave = null;
      this.#setProgress(1);
      this.#scheduleGpuFill();
      this.#schedulePrefetch();
    } else if (missing.length === 0) {
      // Everything is in memory but a frame could not be drawn whole (a slot could not be had): try again next frame.
      this.requestRender();
    } else {
      this.#requestCells(lod, missing, t);
      // Cells that failed for good no longer hold anything back: keep prefetching for the ones that work.
      if (missing.every(([row, col]) => this.#wave.failures.has(`${row}/${col}`))) {
        this.#scheduleGpuFill();
        this.#schedulePrefetch();
      }
    }
    if (this.#gaps.visible) this.#drawGapOverlay();
    const ms = performance.now() - started;
    if (showing) {
      this.#paintMs = painted ? ms : this.#paintMs;
      for (const resolve of this.#painted.splice(0)) resolve();
    }
    return { complete: showing, ms, lod, cells: cells.length };
  }

  /**
   * Draw one whole frame: upload what is not on the GPU yet, clear, draw every visible cell of the level. Returns
   * false, drawing nothing, if some cell could not be had after all (the canvas keeps what it shows).
   */
  #paintFrame({ lod, t, kind }, targetLod) {
    const { renderer, canvas } = this;
    const started = performance.now();
    const cells = this.#visibleCells(lod);
    renderer.newFrame();
    const uploadBefore = renderer.stats.uploadMs;
    const drawable = [];
    for (const [row, col] of cells) {
      const slots = this.#slotsFor(lod, row, col, t);
      if (!slots) return false;
      drawable.push({ row, col, slots });
    }
    if (this.#stretchLo === null) this.#stretchLo = this.#computeStretch(lod, cells, t);
    if (this.#linear.range === null && this.#usesLinearRange()) this.#measureLinear(lod, cells, t);
    renderer.beginPaint(
      {
        width: canvas.width,
        height: canvas.height,
        ...this.camera,
        ...this.#productUniforms(),
        stretchLo: this.#stretchLo ?? 0,
        nodata: this.#nodata,
      },
      { clear: true },
    );
    for (const { row, col, slots } of drawable) this.#drawCell(lod, row, col, slots);
    this.#shown = { lod, t, cells: new Set(cells.map(([row, col]) => `${row}/${col}`)), kind };
    this.#dirty = false;
    if (kind === 'target') this.paintedT = t;
    this.#frameStats.painted++;
    if (lod > targetLod) this.#frameStats.fallback++;
    const ms = performance.now() - started;
    const uploadMs = renderer.stats.uploadMs - uploadBefore;
    this.#emit({
      type: 'paint',
      t,
      lod,
      targetLod,
      kind,
      complete: kind === 'target',
      partial: false,
      covered: true,
      fallback: lod > targetLod,
      cells: cells.length,
      ready: cells.length,
      uploadMs,
      renderMs: ms - uploadMs,
    });
    return true;
  }

  /** No whole frame is ready for what was asked for, so the canvas stays as it is; probes hear about it once per request. */
  #noteKept(lod, t) {
    const key = `${lod}/${t}/${this.camera.cx}/${this.camera.cy}/${this.camera.scale}`;
    if (this.#keptKey === key) return;
    this.#keptKey = key;
    this.#frameStats.kept++;
    this.#emit({ type: 'kept', t, targetLod: lod });
  }

  /** What the frames painted so far were like: how many, how many came from a coarser level than wanted, how often none was ready. */
  get frameStats() {
    return { ...this.#frameStats };
  }

  /** The frame on the canvas: its level, timestep and kind ('target', 'fallback' or 'previous'), or null before the first. */
  get shownFrame() {
    return this.#shown ? { lod: this.#shown.lod, t: this.#shown.t, kind: this.#shown.kind } : null;
  }

  /** Whether the chunks of timestep t (data and validity mask) of one cell are in memory, decoded or already on the GPU. */
  #cellReady(lod, row, col, t) {
    const { store, renderer } = this;
    for (const ct of [t]) {
      if (!renderer.isResident(chunkKey(lod, row, col, ct)) && !store.peekRaw(lod, row, col, ct)) return false;
    }
    if (store.hasMask) {
      const slot = renderer.peekSlot(chunkKey(lod, row, col, t));
      if (!(slot >= 0 && renderer.hasMaskAt(slot)) && !store.peekMask(lod, row, col, t)) return false;
    }
    return true;
  }

  /** Whether every cell the view needs at this level has timestep t in memory. */
  #frameReady(lod, t) {
    return this.#visibleCells(lod).every(([row, col]) => this.#cellReady(lod, row, col, t));
  }

  /** The timeline marker shows a loading state while the frame for the timestep asked for is not on screen at the level asked for. */
  #setLoading(loading) {
    if (loading === this.#loading) return;
    this.#loading = loading;
    this.#updateTimeUi();
  }

  /**
   * Start background prefetch now and resolve with its result when it finishes or is aborted. `movie` plans it
   * for playback (the movie level, time treated as a loop) even while paused; it defaults to whether a movie plays.
   */
  prefetchNow({ movie = this.#playing } = {}) {
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = 0;
    this.#prefetchStartedAt = performance.now();
    this.#prefetchAbort?.abort();
    const abort = new AbortController();
    this.#prefetchAbort = abort;
    const lod = movie ? this.#targetLod({ asPlaying: true }) : this.#view.lod;
    const cells = movie ? this.#visibleCells(lod) : [...this.#view.cells].map((k) => k.split('/').map(Number));
    const seek = !movie && this.#seekPending;
    if (!movie) this.#seekPending = false;
    return this.store
      .prefetch({
        lod,
        cells,
        t: this.t,
        direction: this.#direction,
        behindFactor: movie ? BEHIND_FACTOR_PLAYING : BEHIND_FACTOR,
        loop: movie,
        playing: movie,
        masks: this.store.hasMask,
        seek,
        signal: abort.signal,
        onChunk: (chunkLod, row, col, t) => {
          this.#scheduleGpuFill();
          this.#prefetchMask(chunkLod, row, col, t, abort.signal);
          this.#recheckFrame();
        },
      })
      .then((result) => {
        for (const { key, error } of result.errors) console.error(`prefetch failed for chunk ${key}:`, error);
        return result;
      });
  }

  /**
   * Prefetch the whole loop at the coarsest useful level (the level of a view four times further out than the more
   * zoomed-out of the camera and the fitted view; for a store a few cells wide that is its last level, one cell), so
   * that some complete frame is in memory for every timestep and a frame never has to be a partial one. It uses the
   * playing prefetch, which the store's idle limit does not apply to; the horizon prefetch of the current level goes
   * on as before. It runs once per view: again only when the level or its cells change, or after a jump in time.
   */
  #prefetchCoarseLoop() {
    const { store } = this;
    if (this.lodOverride !== null || this.#exportHold) return;
    const lod = Math.max(this.#lodForScale(Math.min(this.camera.scale, this.fitScale) / 4), this.#view.lod);
    this.#coarseLoopLod = lod;
    const cells = this.#visibleCells(lod);
    const key = `${lod}:${cells.map(([row, col]) => `${row}/${col}`).join(',')}`;
    if (this.#coarseLoop?.key === key || cells.length === 0) return;
    this.#coarseLoop?.controller.abort();
    const controller = new AbortController();
    const loop = { key, controller };
    this.#coarseLoop = loop;
    store
      .prefetch({
        lod,
        cells,
        t: this.t,
        direction: this.#direction,
        behindFactor: BEHIND_FACTOR_PLAYING,
        loop: true,
        playing: true,
        masks: store.hasMask,
        signal: controller.signal,
        onChunk: (chunkLod, row, col, t) => {
          this.#prefetchMask(chunkLod, row, col, t, controller.signal);
          this.#recheckFrame();
        },
      })
      .then((result) => {
        for (const { key: chunk, error } of result.errors) console.error(`coarse loop: prefetch failed for chunk ${chunk}:`, error);
        // Chunks that failed are planned again the next time the view settles; the store leaves a failed cell alone for a while.
        if (result.errors.length > 0 && this.#coarseLoop === loop) this.#coarseLoop = null;
      });
  }

  /** A chunk landed in memory while the frame that was asked for is not on screen: it may have made a whole frame possible. */
  #recheckFrame() {
    if (this.#loading) this.requestRender();
  }

  /** A chunk the prefetch just decoded needs its validity mask too: read it (a no-op without a mask) and refill the GPU window. */
  #prefetchMask(lod, row, col, t, signal) {
    if (!this.store.hasMask) return;
    this.store.getMask(lod, row, col, t, { signal }).then(
      () => this.#scheduleGpuFill(),
      (error) => {
        if (error.name !== 'AbortError') console.error(`prefetch failed for the mask of chunk ${chunkKey(lod, row, col, t)}:`, error);
      },
    );
  }

  #createPlayback() {
    return new Playback({
      count: this.store.times.length,
      stepsPerSecond: this.#speed,
      getIndex: () => this.t,
      goTo: (index, direction) => this.goToTime(index, { playing: true, direction }),
      isReady: (index) => this.isTimestepReady(index),
      prepare: (indices) => this.#fillBuffer(indices),
      onChange: () => this.#updatePlayUi(),
    });
  }

  /**
   * Playback wants these timesteps (the next ones, nearest first) in memory: load the ones that are not, a few at a
   * time and at demand priority, in order, until they all are or playback stops. A new request replaces the list of a
   * pump that is already running; the store shares the fetches.
   */
  #fillBuffer(indices) {
    const pump = (this.#bufferPump ??= { wanted: [], running: false, controller: null });
    pump.wanted = indices;
    if (pump.running) return;
    pump.running = true;
    pump.controller = new AbortController();
    this.#runBufferPump(pump);
  }

  async #runBufferPump(pump) {
    const { signal } = pump.controller;
    let failed = null;
    try {
      let previous = '';
      while (!signal.aborted) {
        const lod = this.#targetLod();
        const batch = pump.wanted.filter((t) => !this.#frameReady(lod, t)).slice(0, BUFFER_BATCH);
        const key = batch.join(',');
        // The same batch again means the cache cannot keep what was loaded: stop rather than load it forever.
        if (batch.length === 0 || key === previous) break;
        previous = key;
        await Promise.all(batch.map((t) => this.#loadTimestep(lod, t, signal)));
      }
    } catch (error) {
      if (error.name !== 'AbortError') failed = error;
    } finally {
      pump.running = false;
    }
    if (failed) {
      console.error('playback: could not fill the buffer:', failed);
      this.#playback?.pause();
      this.#showError('Playback paused', `${failed.name}: ${failed.message}`, { toast: true, code: 'playback_failed' });
    }
  }

  /** The chunks of timestep t of every visible cell of a level, with their masks, at demand priority. */
  #loadTimestep(lod, t, signal) {
    return Promise.all(
      this.#visibleCells(lod).map(([row, col]) =>
        Promise.all([this.store.getRaw(lod, row, col, t, { signal }), this.#maskRead(lod, row, col, t, signal)]),
      ),
    );
  }

  #emit(event) {
    this.probe?.({ at: performance.now(), ...event });
  }

  /** Tell the embed bridge (if there is one). Its failure must not break the viewer. */
  #hook(name, payload) {
    try {
      this.hooks[name]?.(payload);
    } catch (error) {
      console.error(`embed hook "${name}" failed:`, error);
    }
  }

  #abortBackground() {
    this.#bufferPump?.controller?.abort();
    this.#bufferPump = null;
    this.#coarseLoop?.controller.abort();
    this.#coarseLoop = null;
    this.#wave?.controller.abort();
    this.#wave = null;
    clearTimeout(this.#gpuFillTimer);
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = 0;
    this.#prefetchAbort?.abort();
    this.#prefetchAbort = null;
  }

  #checkUniformChunks(store) {
    const first = store.levels[0];
    for (const level of store.levels) {
      if (level.chunkWidth !== first.chunkWidth || level.chunkHeight !== first.chunkHeight) {
        throw new Error(`level ${level.lod} chunk size ${level.chunkWidth}x${level.chunkHeight} differs from level 0 (${first.chunkWidth}x${first.chunkHeight})`);
      }
    }
  }

  #configurePool() {
    const { store, renderer } = this;
    const first = store.levels[0];
    const wanted = store.levels.reduce((n, l) => n + l.gridRows * l.gridCols * l.nTime, 0);
    const bytesPerSample = first.chunkBytes / (first.nBand * first.chunkWidth * first.chunkHeight);
    const slots = renderer.planSlots(first.nBand, first.chunkWidth, first.chunkHeight, POOL_BUDGET_BYTES, wanted, bytesPerSample, store.hasMask);
    renderer.configure({ dtype: this.dtype, nBand: first.nBand, chunkWidth: first.chunkWidth, chunkHeight: first.chunkHeight, slots, hasMask: store.hasMask });
    this.#maxVisibleCells = Math.floor(slots / 2);
  }

  #resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  /** The level for a camera scale (canvas pixels per level-0 pixel), before limits on the number of cells. */
  #lodForScale(scale) {
    return clamp(Math.floor(Math.log2(1 / scale) + LOD_BIAS + 1e-9), 0, this.store.levels.length - 1);
  }

  /** The level the viewer shows while not playing: sharp enough for the screen, few enough cells for the texture pool. */
  #normalLod() {
    const maxLod = this.store.levels.length - 1;
    let lod = this.#lodForScale(this.camera.scale);
    while (lod < maxLod && this.#visibleCells(lod).length > this.#maxVisibleCells) lod++;
    return lod;
  }

  /**
   * The level to draw at. While a movie plays (or `asPlaying`), the first level from the normal one on where the
   * whole loop for the visible cells fits the decoded cache and, for a loop not in memory yet, where the link can
   * feed it (chooseMovieLevel), but never coarser than the level the viewer would pick at 4x zoom-out. A playing
   * movie keeps its level until the camera, the speed or the playback state changes. A level pinned with
   * lodOverride is left alone.
   */
  #targetLod({ asPlaying = this.#playing } = {}) {
    if (this.lodOverride !== null) return this.lodOverride;
    const baseLod = this.#normalLod();
    let choice = { lod: baseLod, reason: null, detail: null };
    if (asPlaying) {
      const deepestLod = Math.max(baseLod, this.#lodForScale(this.camera.scale / 4));
      const key = `${this.#playEpoch}|${baseLod}|${deepestLod}|${this.#visibleCells(baseLod).length}|${this.#speed}`;
      if (this.#playing && this.#movieMemo?.key === key) choice = this.#movieMemo;
      else {
        const links = new Map();
        const { lod, reason } = chooseMovieLevel({
          baseLod,
          deepestLod,
          fits: (candidate) => this.store.loopFits(candidate, this.#visibleCells(candidate).length),
          linkOk: (candidate) => {
            const link = this.#linkCheck(candidate);
            links.set(candidate, link);
            return link.ok;
          },
        });
        choice = { key, lod, reason, detail: this.#movieDetail(reason, links.get(baseLod)) };
        if (this.#playing) this.#movieMemo = choice;
      }
    }
    this.#movie = { baseLod, lod: choice.lod, reason: choice.reason, detail: choice.detail };
    return choice.lod;
  }

  /**
   * Whether the link can feed a movie at this level: the wire bytes of one step (the visible cells, at the
   * compression the caches show) times the speed, for the part of the loop not in memory yet, against the
   * measured bandwidth (see linkAllows). The numbers go in the hint's tooltip.
   */
  #linkCheck(lod) {
    const { store } = this;
    const bandwidth = store.bandwidthEstimate();
    const cells = this.#visibleCells(lod);
    const level = store.levels[lod];
    const bytesPerPixel = level.chunkBytes / (level.chunkWidth * level.chunkHeight);
    const count = store.times.length;
    let pixels = 0;
    let cold = 0;
    for (const [row, col] of cells) {
      const { width, height } = store.cellExtent(lod, row, col);
      pixels += width * height;
      for (let t = 0; t < count; t++) if (!store.peekRaw(lod, row, col, t)) cold++;
    }
    const bytesPerStep = pixels * bytesPerPixel * wireRatio(readStats(store));
    const stepsPerSecond = this.#playback?.effectiveStepsPerSecond ?? this.#speed;
    const coldFraction = cells.length === 0 ? 0 : cold / (cells.length * count);
    return { ok: linkAllows({ bytesPerStep, stepsPerSecond, coldFraction, bandwidth }), cells: cells.length, bytesPerStep, stepsPerSecond, coldFraction, bandwidth };
  }

  /** The tooltip of the resolution hint: what ruled out the normal level. */
  #movieDetail(reason, baseLink) {
    if (reason === null) return null;
    const parts = [];
    if (reason.includes('memory')) parts.push('the whole loop does not fit the decoded cache at the normal level');
    if (reason.includes('link') && baseLink?.bandwidth) {
      const need = baseLink.bytesPerStep * baseLink.stepsPerSecond * baseLink.coldFraction;
      parts.push(`the link: ${baseLink.cells} cells at about ${formatBytes(baseLink.bytesPerStep)} per step, ${Math.round(baseLink.stepsPerSecond)}/s, ${Math.round(baseLink.coldFraction * 100)} % not in memory needs ${formatRate(need)}; measured ${formatRate(baseLink.bandwidth)}, limit 70 %`);
    }
    return parts.join('; ');
  }

  /** While a movie plays: the normal level, the level it plays at (coarser when the loop would not fit the cache or the link cannot feed it), and why. */
  get movieInfo() {
    return { ...this.#movie, playing: this.#playing };
  }

  /** Cells of `lod` intersecting the canvas, as [row, col]. */
  #visibleCells(lod) {
    const level = this.store.levels[lod];
    const { cx, cy, scale } = this.camera;
    const factor = 2 ** lod;
    const x0 = (cx - this.canvas.width / 2 / scale) / factor;
    const x1 = (cx + this.canvas.width / 2 / scale) / factor;
    const y0 = (cy - this.canvas.height / 2 / scale) / factor;
    const y1 = (cy + this.canvas.height / 2 / scale) / factor;
    if (x1 < 0 || y1 < 0 || x0 >= level.width || y0 >= level.height) return [];
    const colMin = Math.max(0, Math.floor(x0 / level.chunkWidth));
    const colMax = Math.min(level.gridCols - 1, Math.floor(x1 / level.chunkWidth));
    const rowMin = Math.max(0, Math.floor(y0 / level.chunkHeight));
    const rowMax = Math.min(level.gridRows - 1, Math.floor(y1 / level.chunkHeight));
    const cells = [];
    for (let row = rowMin; row <= rowMax; row++) for (let col = colMin; col <= colMax; col++) cells.push([row, col]);
    return cells;
  }

  /**
   * GPU slots for the true-value chunk and its optional validity mask, or null while anything is missing.
   */
  #slotsFor(lod, row, col, t, renderer = this.renderer) {
    const data = this.#slotForChunk(lod, row, col, t, renderer);
    if (data < 0) return null;
    if (!this.store.hasMask) return { data, mask: -1 };
    return this.#uploadMask(lod, row, col, t, data, renderer) ? { data, mask: data } : null;
  }

  /** Whether slot `slot` holds the mask of timestep t of a cell, uploading it from the cache if it is not there yet. */
  #uploadMask(lod, row, col, t, slot, renderer) {
    if (renderer.hasMaskAt(slot)) return true;
    const mask = this.store.peekMask(lod, row, col, t);
    if (!mask) return false;
    renderer.uploadMask(slot, mask);
    return true;
  }

  /** The validity mask of a cell at t, fetched at the priority of the cell's data; resolves null for a store without a mask. */
  #maskRead(lod, row, col, t, signal) {
    return this.store.hasMask ? this.store.getMask(lod, row, col, t, { signal }) : null;
  }

  #slotForChunk(lod, row, col, t, renderer) {
    const key = chunkKey(lod, row, col, t);
    const resident = renderer.slotOf(key);
    if (resident >= 0) return resident;
    const data = this.store.peekRaw(lod, row, col, t);
    return data ? renderer.upload(key, { lod, row, col, t }, data) : -1;
  }

  #scheduleGpuFill() {
    clearTimeout(this.#gpuFillTimer);
    this.#gpuFillTimer = setTimeout(() => this.#fillGpuWindow(), 0);
  }

  /**
   * Keep a window of timesteps around t resident in the texture pool, as wide as the pool holds for the
   * visible cells and reaching further in the scrub direction (wrapping past the last timestep while a movie plays), so the next steps are uniform changes
   * instead of uploads. Uploads come from the decoded cache in slices of GPU_UPLOAD_SLICE_MS.
   */
  #fillGpuWindow() {
    const { lod, cells } = this.#view;
    const { store, renderer, t } = this;
    if (cells.size === 0) return;
    const steps = Math.max(1, Math.floor((renderer.slots * GPU_FILL_FRACTION) / (cells.size)));
    const timesteps = windowOrder(store.times.length, t, { direction: this.#direction, behindFactor: this.#behindFactor, loop: this.#playing }).slice(0, steps);
    const frameMs = this.#playback?.frameMs ?? 1000 / 60;
    const sliceMs = Math.min(GPU_UPLOAD_SLICE_MS, frameMs * GPU_SLICE_FRACTION_OF_FRAME);
    const started = performance.now();
    for (const tt of timesteps) {
      for (const ct of [tt]) {
        for (const key of cells) {
          const [row, col] = key.split('/').map(Number);
          const chunk = chunkKey(lod, row, col, ct);
          let slot = renderer.peekSlot(chunk);
          if (slot < 0) {
            const data = store.peekRaw(lod, row, col, ct);
            if (!data) continue;
            slot = renderer.upload(chunk, { lod, row, col, t: ct }, data, { background: true });
          }
          if (slot >= 0 && store.hasMask && !renderer.hasMaskAt(slot)) {
            const mask = store.peekMask(lod, row, col, ct);
            if (mask) renderer.uploadMask(slot, mask);
          }
          if (performance.now() - started > sliceMs) {
            this.#gpuFillTimer = setTimeout(() => this.#fillGpuWindow(), 0);
            return;
          }
        }
      }
    }
  }

  /** Eviction order for decoded chunks and texture slots: outside the view first, then by scrub cost from t. */
  #chunkScore(meta) {
    const cell = `${meta.row}/${meta.col}`;
    const visible = meta.lod === this.#view.lod && this.#view.cells.has(cell);
    // The frame on screen may be a coarser level or an earlier timestep than the view asks for; it must stay drawable.
    const shown = this.#shown;
    const onScreen = shown !== null && meta.lod === shown.lod && shown.cells.has(cell) && meta.t === shown.t;
    // The coarse loop is what a frame falls back to whatever the timestep: it stays ahead of everything else that is not on screen.
    const rank = visible || onScreen ? 0 : meta.lod === this.#coarseLoopLod ? COARSE_LOOP_RANK : 1e6;
    const cost = scrubCost(meta.t - this.t, this.#direction, this.#behindFactor, this.#playing ? this.store.times.length : null);
    return rank + cost;
  }

  /**
   * Eviction order for the decoded-chunk cache: like #chunkScore, except the chunks an export is recording
   * from are kept ahead of everything else, so the viewer's own prefetch cannot push them out mid-export.
   */
  #storeScore(meta) {
    const hold = this.#exportHold;
    if (hold && meta.lod === hold.lod && hold.cells.has(`${meta.row}/${meta.col}`)) return -1;
    return this.#chunkScore(meta);
  }

  #drawCell(lod, row, col, slots, renderer = this.renderer) {
    const level = this.store.levels[lod];
    const factor = 2 ** lod;
    const { width, height } = this.store.cellExtent(lod, row, col);
    renderer.drawCell(
      { x: col * level.chunkWidth * factor, y: row * level.chunkHeight * factor, w: width * factor, h: height * factor },
      { w: width, h: height },
      slots.data,
      slots.mask,
    );
  }

  /** What the shader needs to color the current product: inputs, the stored-to-physical conversion, and the display mode. */
  #productUniforms() {
    const product = this.products[this.productIndex];
    const display = this.#display(product);
    return {
      shader: product.shader,
      inputs: inputIndices(product, this.bandChoice),
      ...inputConversion(product, this.bands, this.bandChoice),
      display: display.mode,
      range: display.range,
    };
  }

  /** How the product is shown (see displayMode): a linear stretch that is not fixed uses the measured or user-set range. */
  #display(product) {
    const display = displayMode(product, this.bands, this.bandChoice, this.dtype);
    return display.mode === 'linear' && !display.fixed ? { ...display, range: this.#linear.range ?? [0, 1] } : display;
  }

  #usesLinearRange() {
    const display = displayMode(this.products[this.productIndex], this.bands, this.bandChoice, this.dtype);
    return display.mode === 'linear' && !display.fixed;
  }

  /** The range of a linear single band from the data on screen: 2nd to 98th percentile of the valid physical values. */
  #measureLinear(lod, cells, t) {
    const { store } = this;
    const level = store.levels[lod];
    const band = this.bands[this.bandChoice];
    const values = [];
    for (const [row, col] of cells) {
      const { width, height } = store.cellExtent(lod, row, col);
      const mask = this.#peekMaskOrNull(lod, row, col, t);
      const stride = Math.max(1, Math.floor((width * height) / STRETCH_SAMPLES_PER_CELL));
      for (let i = 0; i < width * height; i += stride) {
        const [x, y] = [i % width, Math.floor(i / width)];
        if (mask && mask[y * level.chunkWidth + x] === 0) continue;
        const stored = store.samplePixel(lod, row, col, t, x, y)?.[this.bandChoice];
        if (stored !== undefined && stored !== this.#nodata && Number.isFinite(stored)) values.push(toPhysical(stored, band));
      }
    }
    const range = percentileRange(values);
    if (range) this.#linear = { range, manual: false };
    this.#updateStretchUi();
  }

  get stretchRange() { return this.#linear.manual ? [...this.#linear.range] : null; }

  /** The user typed a stretch range (physical units). */
  setStretch(lo, hi) {
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) {
      this.#updateStretchUi();
      return;
    }
    this.#linear = { range: [lo, hi], manual: true };
    this.#dirty = true;
    this.requestRender();
  }

  /** Back to the range measured from the data on screen. */
  autoStretch() {
    this.#linear = { range: null, manual: false };
    this.#dirty = true;
    this.requestRender();
  }

  /** 2nd percentile of tone-mapped true-color samples (physical reflectance), kept fixed while scrubbing. 0 without red, green and blue bands. */
  #computeStretch(lod, cells, t) {
    const { store } = this;
    const idx = ['red', 'green', 'blue'].map((common) => findBand(this.bands, common));
    if (idx.some((i) => i < 0)) return 0;
    const level = store.levels[lod];
    const samples = [];
    for (const [row, col] of cells) {
      const { width, height } = store.cellExtent(lod, row, col);
      const mask = this.#peekMaskOrNull(lod, row, col, t);
      const stride = Math.max(1, Math.floor((width * height) / STRETCH_SAMPLES_PER_CELL));
      for (let i = 0; i < width * height; i += stride) {
        const [x, y] = [i % width, Math.floor(i / width)];
        if (mask && mask[y * level.chunkWidth + x] === 0) continue;
        const values = store.samplePixel(lod, row, col, t, x, y);
        if (values) samples.push(idx.map((b) => toPhysical(values[b], this.bands[b])));
      }
    }
    return computeStretchLo(samples);
  }

  /**
   * Fetch the missing cells for timestep t right away, one wave per (level, timestep). A wave for a
   * different timestep or level is stale: it is aborted after the new one has claimed the chunks they
   * share, and requests nobody wants any more are cancelled.
   */
  #requestCells(lod, missing, t) {
    let wave = this.#wave;
    const previous = wave && (wave.lod !== lod || wave.t !== t) ? wave : null;
    if (!wave || previous) wave = { lod, t, controller: new AbortController(), cells: new Set(), failures: new Map() };
    const wanted = missing.filter(([row, col]) => !wave.cells.has(`${row}/${col}`));
    this.#wave = wave;
    if (wanted.length > 0) {
      for (const [row, col] of wanted) wave.cells.add(`${row}/${col}`);
      this.#emit({ type: 'load-start', t, cells: wanted.length });
      this.#setProgress(0.02);
      this.#loadWanted(wave, wanted);
    }
    previous?.controller.abort();
  }

  /**
   * The cells a wave still needs, coarse first: the small coarse levels (see coarse.js), each shown once it is
   * complete, then the target level, which is shown when all of its cells are in. A stage starts when the previous one lands or, sooner, a
   * couple of round trips after the previous one started (stageLeadMs), so the requests of one stage wait on the
   * network while the bytes of the one before are still arriving instead of after them.
   */
  async #loadWanted(wave, wanted) {
    const { lod } = wave;
    const { signal } = wave.controller;
    const lead = stageLeadMs(this.#roundTripMs);
    let previous = null;
    for (const stage of this.#coarseStages(lod, wanted, wave.t)) {
      if (previous) await Promise.race([previous, delay(lead, signal)]);
      if (signal.aborted) return;
      previous = this.#loadStage(wave, stage);
    }
    if (previous) await Promise.race([previous, delay(lead, signal)]);
    if (!signal.aborted) this.#loadCells(wave, wanted);
  }

  /** Load one coarse stage and show it when it has landed whole. Never rejects: a stage that fails only costs the preview. */
  async #loadStage(wave, stage) {
    const { t } = wave;
    const { signal } = wave.controller;
    const started = performance.now();
    try {
      await this.#loadFrame(stage.lod, stage.cells, t, signal);
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(`coarse frame failed (level ${stage.lod}, cells ${JSON.stringify(stage.cells)}, timestep ${t}); the target level loads anyway:`, error);
      return;
    }
    if (signal.aborted) return;
    this.#emit({ type: 'coarse-frame', t, lod: stage.lod, cells: stage.cells.length, ms: performance.now() - started });
    this.#render({ force: false });
  }

  /**
   * Levels to show before `lod` for the cells about to load at timestep t, coarsest first, as {lod, cells}; none for
   * a pinned level or a movie. A stage is skipped by the plan when its frame is in memory already (the coarse loop
   * got there first) or when the frame asked for would arrive soon anyway.
   */
  #coarseStages(lod, cells, t) {
    if (this.lodOverride !== null || this.#playing) return [];
    const levels = planCoarseStages({
      targetLod: lod,
      coarsestLod: this.store.levels.length - 1,
      frameBytes: (level) => this.#frameBytes(level, ancestorCells(cells, lod, level), t),
      bandwidth: this.store.bandwidthEstimate() ?? ASSUMED_BANDWIDTH,
      wireRatio: wireRatio(readStats(this.store)),
    });
    return levels.map((level) => ({ lod: level, cells: ancestorCells(cells, lod, level) }));
  }

  /** Decoded bytes of the valid pixels of the chunks of timestep t  that these cells of one level do not have in memory yet. */
  #frameBytes(lod, cells, t) {
    const { store } = this;
    const level = store.levels[lod];
    const bytesPerPixel = level.chunkBytes / (level.chunkWidth * level.chunkHeight);
    const chunks = [t];
    let pixels = 0;
    for (const [row, col] of cells) {
      const { width, height } = store.cellExtent(lod, row, col);
      for (const ct of chunks) if (!store.peekRaw(lod, row, col, ct)) pixels += width * height;
    }
    return pixels * bytesPerPixel;
  }

  /** The chunks of timestep t for these cells of one level, and their validity masks, decoded and in the cache when this resolves. */
  async #loadFrame(lod, cells, t, signal) {
    await Promise.all([this.store.getCoarseFrame(lod, cells, t, { signal }), ...cells.map(([row, col]) => this.#maskRead(lod, row, col, t, signal))]);
  }

  /** Fetch the target-level cells of a wave; the frame is painted when the last one has arrived (earlier ones only change what is ready). */
  #loadCells(wave, wanted) {
    const { lod, t } = wave;
    const { signal } = wave.controller;
    let done = 0;
    for (const [row, col] of wanted) {
      Promise.all([this.store.getRaw(lod, row, col, t, { signal }), this.#maskRead(lod, row, col, t, signal)]).then(
        () => {
          if (signal.aborted) return;
          this.#setProgress((++done / wanted.length) * 0.98);
          this.#emit({ type: 'cell-ready', t, row, col });
          this.#render({ force: false });
        },
        (error) => {
          if (error.name === 'AbortError') return;
          this.#chunkFailed(wave, { lod, row, col, t }, error);
        },
      );
    }
  }

  /**
   * A chunk failed after the decoder's own retries. Not fatal: the cell keeps its coarser level or previous
   * timestep, the failure is shown as a toast with the URL, status and error, and the cell is requested again
   * after a growing pause, up to MAX_CELL_RETRIES times or until the view moves to another timestep.
   */
  #chunkFailed(wave, { lod, row, col, t }, error) {
    const cell = `${row}/${col}`;
    const failures = (wave.failures.get(cell) ?? 0) + 1;
    wave.failures.set(cell, failures);
    console.error(`chunk load failed (lod ${lod}, row ${row}, col ${col}, timestep ${t}, failure ${failures}):`, error);
    const outcome = failures > MAX_CELL_RETRIES ? 'Giving up on it until the timestep changes.' : 'Retrying shortly.';
    this.#showError(
      'Chunk load failed',
      `Level ${lod}, cell (${row}, ${col}), ${this.#formatTime(t)}: ${error.name}: ${error.message}. The cell keeps its previous data. ${outcome}`,
      { toast: true, code: 'chunk_load_failed' },
    );
    this.#setProgress(0);
    if (failures > MAX_CELL_RETRIES) return;
    setTimeout(() => {
      if (this.#wave !== wave) return;
      wave.cells.delete(cell);
      this.requestRender();
    }, CELL_RETRY_DELAY_MS * failures);
  }

  /**
   * Restart background prefetch shortly after a complete frame. A pending restart is kept rather than pushed
   * back, so frames arriving faster than the settle time (movie playback) cannot starve it, and while playing
   * the window is only re-planned every PREFETCH_PLAYBACK_RESTART_MS.
   */
  #schedulePrefetch() {
    if (this.#prefetchTimer || this.#exportHold) return;
    const sinceStart = performance.now() - this.#prefetchStartedAt;
    const wait = this.#playing ? Math.max(PREFETCH_SETTLE_MS, PREFETCH_PLAYBACK_RESTART_MS - sinceStart) : PREFETCH_SETTLE_MS;
    this.#prefetchTimer = setTimeout(() => {
      this.#prefetchCoarseLoop();
      this.prefetchNow();
    }, wait);
  }

  get #playing() {
    return this.#playback?.playing ?? false;
  }

  /** The nodata value to compare stored values with (none for a store with a validity mask: see nodataToCompare). */
  get #nodata() {
    return this.store ? nodataToCompare(this.store) : null;
  }

  /** The validity mask of a cell at t when the store has one and it is in memory, else null (every pixel counts as valid). */
  #peekMaskOrNull(lod, row, col, t) {
    return this.store.hasMask ? (this.store.peekMask(lod, row, col, t) ?? null) : null;
  }

  /** Behind the scrub direction costs more while a movie plays: it never goes back. */
  get #behindFactor() {
    return this.#playing ? BEHIND_FACTOR_PLAYING : BEHIND_FACTOR;
  }

  // ---- inspector: a side panel from DRAWER_BELOW wide, a drawer over the map below ----

  /** Whether the inspector is a drawer (a narrow window) that is currently shown. */
  get inspectorOpen() {
    return $('sidebar').classList.contains('open');
  }

  /** Show the drawer; the side panel of a wide window is always shown. */
  openInspector() {
    if (inspectorLayout(window.innerWidth, { embedded: this.embedded }) === 'drawer') $('sidebar').classList.add('open');
  }

  closeInspector() {
    $('sidebar').classList.remove('open');
  }

  /** The export panel sits above the timeline bar, which grows when it wraps on a narrow window: tell the stylesheet how tall it is. */
  #trackTimelineHeight() {
    const bar = document.querySelector('.timeline-bar');
    const update = () => document.documentElement.style.setProperty('--timeline-h', `${bar.getBoundingClientRect().height}px`);
    new ResizeObserver(update).observe(bar);
    update();
  }

  // ---- click to query ----

  async #inspect(clientX, clientY) {
    if (!this.store) return;
    $('click-hint').classList.add('hidden');
    const rect = this.canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) * this.canvas.width) / rect.width;
    const py = ((clientY - rect.top) * this.canvas.height) / rect.height;
    const { cx, cy, scale } = this.camera;
    const worldX = cx + (px - this.canvas.width / 2) / scale;
    const worldY = cy + (py - this.canvas.height / 2) / scale;
    const frame = this.#shown;
    if (!frame) return;
    const lod = frame.lod;
    const level = this.store.levels[lod];
    const factor = 2 ** lod;
    const x = Math.floor(worldX / factor);
    const y = Math.floor(worldY / factor);
    if (x < 0 || y < 0 || x >= level.width || y >= level.height) {
      this.#clearChart();
      this.#updateSidebar(null);
      this.closeInspector();
      return;
    }
    const row = Math.floor(y / level.chunkHeight);
    const col = Math.floor(x / level.chunkWidth);
    const { t } = frame;
    const cellX = x - col * level.chunkWidth;
    const cellY = y - row * level.chunkHeight;
    let mask = null;
    try {
      [, mask] = await Promise.all([this.store.getRaw(lod, row, col, t), this.#maskRead(lod, row, col, t)]);
    } catch (error) {
      this.#showError('Chunk load failed', error.message, { code: 'chunk_load_failed' });
      return;
    }
    const observed = await this.#observedAt(lod, row, col, t, cellX, cellY);
    const values = this.store.samplePixel(lod, row, col, t, cellX, cellY);
    const maskValue = mask ? mask[cellY * level.chunkWidth + cellX] : null;
    const info = { t, lod, pixel: { x: Math.floor(worldX), y: Math.floor(worldY) }, observed, masked: maskValue === 0, ...describePixel(values, this.bands, this.#nodata, maskValue) };
    this.#hook('click', { pixel: info.pixel, t, lod, info });
    if (!this.inspectorUi) return;
    this.#updateSidebar(info);
    this.openInspector();
    this.#startChart({ lod, row, col, x: cellX, y: cellY });
  }

  /** How many observations (scenes) stand behind the pixel at timestep t: null when the store has no coverage variable or it cannot be read. */
  async #observedAt(lod, row, col, t, x, y) {
    const { store } = this;
    if (!store.hasCoverage) return null;
    try {
      const coverage = await store.getCoverage(lod, row, col, t);
      return coverage ? coverage[y * store.levels[lod].chunkWidth + x] : null;
    } catch (error) {
      console.error(`coverage load failed (lod ${lod}, row ${row}, col ${col}, timestep ${t}):`, error);
      return null;
    }
  }

  // ---- chart of the clicked pixel over time ----

  /** A new click: forget the old chart, read what is cached, then fetch the rest of the cell's timesteps. */
  #startChart({ lod, row, col, x, y }) {
    this.#clearChart();
    const { width, height } = this.store.cellExtent(lod, row, col);
    const chart = {
      cell: { lod, row, col },
      pixel: { x, y },
      window: windowPixels(x, y, width, height, 1),
      readings: new Array(this.store.times.length).fill(undefined),
      // Observations behind the pixel per timestep (undefined = not loaded, null = unreadable); null without a coverage variable.
      coverage: this.store.hasCoverage ? new Array(this.store.times.length).fill(undefined) : null,
      controller: new AbortController(),
      failed: 0,
      done: false,
      hover: null,
    };
    this.#chart = chart;
    this.#renderChart();
    this.#fillChart(chart);
  }

  #clearChart() {
    this.#chart?.controller.abort();
    this.#chart = null;
    clearTimeout(this.#chartTimer);
    this.#chartTimer = 0;
  }

  async #fillChart(chart) {
    const { store } = this;
    const { lod, row, col } = chart.cell;
    const level = store.levels[lod];
    const sample = (data, mask) => ({
      pixels: chart.window.map(([x, y]) => samplePixelFrom(data, level, x, y)),
      ...(mask ? { valid: validAt(mask, level.chunkWidth, chart.window) } : {}),
    });
    const coverageOffset = chart.pixel.y * level.chunkWidth + chart.pixel.x;
    for (let t = 0; t < chart.readings.length; t++) {
      const data = store.peekRaw(lod, row, col, t);
      const mask = store.hasMask ? store.peekMask(lod, row, col, t) : null;
      if (data && (!store.hasMask || mask)) chart.readings[t] = sample(data, mask);
      if (chart.coverage) {
        const coverage = store.peekCoverage(lod, row, col, t);
        if (coverage) chart.coverage[t] = coverage[coverageOffset];
      }
    }
    this.#renderChart();
    // Timesteps still missing their values or (with a coverage variable) their coverage, nearest to the one on screen first.
    const missing = chart.readings
      .flatMap((reading, t) => (reading && (!chart.coverage || chart.coverage[t] !== undefined) ? [] : [t]))
      .sort((a, b) => Math.abs(a - this.t) - Math.abs(b - this.t));
    const { signal } = chart.controller;
    for (let i = 0; i < missing.length; i += CHART_BATCH) {
      await Promise.all(
        missing.slice(i, i + CHART_BATCH).map(async (t) => {
          const observed = chart.coverage && chart.coverage[t] === undefined ? this.#loadChartCoverage(chart, t, coverageOffset) : null;
          if (!chart.readings[t]) {
            try {
              const [data, mask] = await Promise.all([
                store.getRaw(lod, row, col, t, { signal }),
                this.#maskRead(lod, row, col, t, signal),
              ]);
              chart.readings[t] = sample(data, mask);
            } catch (error) {
              if (error.name === 'AbortError') return;
              chart.failed++;
              console.error(`chart: chunk load failed (lod ${lod}, row ${row}, col ${col}, timestep ${t}):`, error);
            }
          }
          await observed;
        }),
      );
      if (signal.aborted) return;
      this.#scheduleChartRender();
    }
    chart.done = true;
    this.#renderChart();
  }

  /** The coverage of the charted pixel at timestep t, into chart.coverage (null when it cannot be read). */
  async #loadChartCoverage(chart, t, offset) {
    const { lod, row, col } = chart.cell;
    try {
      const coverage = await this.store.getCoverage(lod, row, col, t, { signal: chart.controller.signal });
      chart.coverage[t] = coverage ? coverage[offset] : null;
    } catch (error) {
      if (error.name === 'AbortError') return;
      chart.coverage[t] = null;
      console.error(`chart: coverage load failed (lod ${lod}, row ${row}, col ${col}, timestep ${t}):`, error);
    }
  }

  #scheduleChartRender() {
    if (this.#chartTimer) return;
    this.#chartTimer = setTimeout(() => {
      this.#chartTimer = 0;
      this.#renderChart();
    }, CHART_RENDER_MS);
  }

  /** Draw the chart for the current product from the readings loaded so far. */
  #renderChart() {
    const target = $('chart');
    const chart = this.#chart;
    if (!chart || !target) return;
    const { store } = this;
    const specs = seriesSpecs(this.products[this.productIndex], this.bands, this.bandChoice);
    chart.series = buildSeries(specs, chart.readings, this.#nodata);
    const [lo, hi] = chartRange(chart.series);
    const n = store.times.length;
    const xOf = (t) => xFromTime(t, n, CHART.left, CHART.right);
    const yOf = (value) => CHART.bottom - ((value - lo) / (hi - lo)) * (CHART.bottom - CHART.top);
    const fmt = (value) => (Math.abs(hi - lo) >= 2 ? value.toFixed(1) : value.toFixed(2));
    const grid = [hi, (lo + hi) / 2, lo]
      .map((value) => `<line x1="${CHART.left}" x2="${CHART.right}" y1="${yOf(value)}" y2="${yOf(value)}" class="chart-grid"/><text x="${CHART.left - 4}" y="${yOf(value) + 3}" text-anchor="end" class="chart-axis">${fmt(value)}</text>`)
      .join('');
    const lines = chart.series.map((s) => `<path d="${seriesPath(s.values, xOf, yOf)}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-linejoin="round"/>`).join('');
    // Hollow points mark timesteps where nothing was observed at the pixel and the value was filled in from another month.
    const gaps = chart.series
      .flatMap((s) => gapFilledTimes(s.values, chart.coverage).map((t) => `<circle cx="${xOf(t).toFixed(1)}" cy="${yOf(s.values[t]).toFixed(1)}" r="2.6" fill="var(--surface)" stroke="${s.color}" stroke-width="1.3"/>`))
      .join('');
    const anyGap = chart.coverage?.some((c) => c === 0) ?? false;
    target.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${chart.series.map((s) => s.label).join(', ')} over time">
        ${grid}${lines}${gaps}
        <line id="chart-marker" y1="${CHART.top}" y2="${CHART.bottom}" class="chart-marker"/>
        <line id="chart-hover" y1="${CHART.top}" y2="${CHART.bottom}" class="chart-hover" visibility="hidden"/>
        <text x="${CHART.left}" y="${CHART.height - 4}" class="chart-axis">${this.#formatTime(0)}</text>
        <text x="${CHART.right}" y="${CHART.height - 4}" text-anchor="end" class="chart-axis">${this.#formatTime(n - 1)}</text>
      </svg>`;
    $('chart-legend').innerHTML =
      chart.series.map((s) => `<span style="color:${s.color}">${s.label}</span>`).join('') +
      (anyGap ? '<span class="chart-gap-key" title="No scene observed this pixel this month; its value is carried over from another month"><i></i>gap-filled</span>' : '');
    this.#updateChartMarker();
    this.#updateChartStatus();
  }

  #updateChartMarker() {
    const marker = $('chart-marker');
    if (!marker || !this.#chart) return;
    const x = xFromTime(this.t, this.store.times.length, CHART.left, CHART.right);
    marker.setAttribute('x1', x);
    marker.setAttribute('x2', x);
  }

  /** Under the chart: what the pointer is on, or how much of the series has loaded. */
  #updateChartStatus() {
    const chart = this.#chart;
    const status = $('chart-status');
    if (!chart || !status) return;
    const n = chart.readings.length;
    if (chart.hover !== null) {
      const t = chart.hover;
      const values = chart.series.map((s) => (typeof s.values[t] === 'number' ? formatValue(s.values[t]) : s.values[t] === null ? 'no data' : '…'));
      const gap = chart.coverage?.[t] === 0 ? ' · gap-filled' : '';
      status.textContent = `${this.#formatTime(t)} · ${values.join(' · ')}${gap}`;
      return;
    }
    const loaded = chart.readings.filter(Boolean).length;
    const failed = chart.failed > 0 ? ` · ${chart.failed} failed` : '';
    const gapCount = chart.coverage?.filter((c) => c === 0).length ?? 0;
    const gapNote = gapCount > 0 ? ` · ${gapCount} gap-filled` : '';
    status.textContent = chart.done ? `${loaded} of ${n} timesteps${failed}${gapNote} · click to jump` : `loading ${loaded} of ${n} timesteps…`;
  }

  #bindChart() {
    const content = $('sidebar-content');
    const timeAt = (e) => {
      const svg = e.target.closest('.chart-svg');
      if (!svg || !this.#chart) return null;
      const rect = svg.getBoundingClientRect();
      return timeFromX(((e.clientX - rect.left) * CHART.width) / rect.width, this.store.times.length, CHART.left, CHART.right);
    };
    content.addEventListener('click', (e) => {
      const t = timeAt(e);
      if (t !== null) this.goToTime(t);
    });
    content.addEventListener('pointermove', (e) => {
      const chart = this.#chart;
      const t = timeAt(e);
      if (!chart) return;
      if (t === null) {
        if (chart.hover !== null) {
          chart.hover = null;
          $('chart-hover')?.setAttribute('visibility', 'hidden');
          this.#updateChartStatus();
        }
        return;
      }
      chart.hover = t;
      const x = xFromTime(t, this.store.times.length, CHART.left, CHART.right);
      const line = $('chart-hover');
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      line.setAttribute('visibility', 'visible');
      this.#updateChartStatus();
    });
    content.addEventListener('pointerleave', () => {
      if (!this.#chart) return;
      this.#chart.hover = null;
      $('chart-hover')?.setAttribute('visibility', 'hidden');
      this.#updateChartStatus();
    });
  }

  // ---- performance overlay (key "d") ----

  /** Show or hide the performance overlay: cache, requests, transfer, time to frame and slow frames, refreshed 4 times a second while visible. */
  togglePerfOverlay() {
    const panel = $('perf-overlay');
    const show = panel.hidden;
    panel.hidden = !show;
    const perf = this.#perf;
    clearInterval(perf.timer);
    perf.timer = 0;
    if (!show) {
      perf.monitor.stop();
      return;
    }
    perf.monitor.reset();
    perf.monitor.start();
    this.#updatePerfOverlay();
    perf.timer = setInterval(() => this.#updatePerfOverlay(), PERF_UPDATE_MS);
  }

  #updatePerfOverlay() {
    if (!this.store) return;
    const stats = readStats(this.store);
    const timing = this.viewTiming;
    const frames = this.#perf.monitor.snapshot();
    const count = (value) => (value === null ? '–' : value.toLocaleString('en-US'));
    const rows = [
      ['store', this.#storeSummary],
      ['cache', `hit ${count(stats.cacheHits)} / miss ${count(stats.cacheMisses)} (${hitRate(stats.cacheHits, stats.cacheMisses)})`],
      ['decoded', `${formatBytes(stats.decodedBytes)} · compressed ${formatBytes(stats.compressedBytes)} · speculative ${formatBytes(stats.speculativeBytes)}`],
      ['GPU', `${this.renderer.slots} slots${this.store.hasMask ? ' · validity mask' : ''}`],
      ['requests', `in flight ${count(stats.inflight)} · deduped ${count(stats.dedupedRequests)} · total ${count(stats.requests)}`],
      ['transferred', `${formatBytes(stats.transferredBytes)} · ${formatRate(stats.bandwidth)}`],
      ['last view', timing ? `${timing.kind}: coarse ${formatMs(timing.coarseMs)} · full ${formatMs(timing.fullMs)}` : '–'],
      ['paint', this.#paintMs === null ? '–' : formatMs(this.#paintMs)],
      ['frames', `> 16.7 ms: ${frames.over16_7ms} · > 33 ms: ${frames.over33ms} of ${frames.frames}`],
      ['painted', `${this.#frameStats.painted} whole frames · ${this.#frameStats.fallback} at a coarser level · ${this.#frameStats.kept} kept`],
    ];
    $('perf-overlay').textContent = rows.map(([label, value]) => `${label.padEnd(12)}${value}`).join('\n');
  }

  // ---- gap-filled pixels on the map ----

  /** Hatch the pixels that no scene observed in this timestep (coverage 0) over the map, or stop. */
  toggleGaps() {
    this.#gaps.visible = !this.#gaps.visible;
    this.#updateGapToggle();
    this.#drawGapOverlay();
  }

  #updateGapToggle() {
    const button = $('gap-toggle');
    button.hidden = !this.store?.hasCoverage;
    button.classList.toggle('active', this.#gaps.visible);
    button.setAttribute('aria-pressed', String(this.#gaps.visible));
  }

  /** Redraw the hatching for the cells on screen: each cell's coverage-0 pixels as a mask, scaled like the map, filled with stripes. */
  #drawGapOverlay() {
    const overlay = $('gap-canvas');
    const { width, height } = this.canvas;
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const { store } = this;
    const frame = this.#shown;
    if (!this.#gaps.visible || !store?.hasCoverage || !frame) return;
    const { lod } = frame;
    const level = store.levels[lod];
    const factor = 2 ** lod;
    const { cx, cy, scale } = this.camera;
    ctx.imageSmoothingEnabled = false;
    for (const key of frame.cells) {
      const [row, col] = key.split('/').map(Number);
      const mask = this.#gapMask(lod, row, col, frame.t);
      if (!mask) continue;
      const x = (col * level.chunkWidth * factor - cx) * scale + width / 2;
      const y = (row * level.chunkHeight * factor - cy) * scale + height / 2;
      ctx.drawImage(mask, 0, 0, mask.width, mask.height, x, y, mask.width * factor * scale, mask.height * factor * scale);
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = this.#hatchPattern(ctx);
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** A canvas the size of the cell's valid pixels, opaque where coverage is 0; null while the coverage chunk loads (the overlay redraws when it has). */
  #gapMask(lod, row, col, t) {
    const { store } = this;
    const key = `${lod}/${row}/${col}/${t}`;
    const { masks, requested } = this.#gaps;
    const cached = masks.get(key);
    if (cached) return cached;
    const coverage = store.peekCoverage(lod, row, col, t);
    if (!coverage) {
      if (coverage === undefined && !requested.has(key)) {
        requested.add(key);
        store.getCoverage(lod, row, col, t).then(
          () => {
            requested.delete(key);
            this.#drawGapOverlay();
          },
          (error) => console.error(`gap overlay: coverage load failed (lod ${lod}, row ${row}, col ${col}, timestep ${t}):`, error),
        );
      }
      return null;
    }
    const { width, height } = store.cellExtent(lod, row, col);
    const stride = store.levels[lod].chunkWidth;
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const maskContext = mask.getContext('2d');
    const image = maskContext.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) if (coverage[y * stride + x] === 0) image.data[(y * width + x) * 4 + 3] = 255;
    }
    maskContext.putImageData(image, 0, 0);
    masks.set(key, mask);
    if (masks.size > GAP_MASK_CACHE) masks.delete(masks.keys().next().value);
    return mask;
  }

  /** Diagonal white stripes, GAP_HATCH_PX apart on screen whatever the pixel ratio. */
  #hatchPattern(ctx) {
    const size = Math.max(4, Math.round(GAP_HATCH_PX * (window.devicePixelRatio || 1)));
    if (this.#hatch?.size !== size) {
      const tile = document.createElement('canvas');
      tile.width = size;
      tile.height = size;
      const tileContext = tile.getContext('2d');
      tileContext.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      tileContext.lineWidth = Math.max(1, size / 6);
      tileContext.beginPath();
      for (const shift of [-size, 0, size]) {
        tileContext.moveTo(shift, size);
        tileContext.lineTo(shift + size, 0);
      }
      tileContext.stroke();
      this.#hatch = { size, tile };
    }
    return ctx.createPattern(this.#hatch.tile, 'repeat');
  }

  // ---- input ----

  #bindInput() {
    bindViewerInput(this, {
      inspect: (x, y) => this.#inspect(x, y),
      cameraChanged: () => {
        this.#beginView('camera');
        this.#dirty = true;
        this.requestRender();
        this.#scheduleUrlSync();
      },
    });
    this.#updateSpeedUi();
  }

  // ---- UI ----

  /** The products as buttons (wide screens) and as a select (below COMPACT_BELOW; the stylesheet shows one of them). */
  #buildProducts() {
    const container = $('products');
    container.replaceChildren();
    const productSelect = $('product-select');
    productSelect.replaceChildren();
    this.products.forEach((product, index) => {
      const button = document.createElement('button');
      button.textContent = product.name;
      button.dataset.index = index;
      button.disabled = !product.available;
      if (!product.available) button.title = `needs bands: ${product.missing.join(', ')}`;
      button.addEventListener('click', () => this.setProduct(index));
      container.appendChild(button);
      const option = new Option(product.name, index);
      option.disabled = !product.available;
      if (!product.available) option.title = `needs bands: ${product.missing.join(', ')}`;
      productSelect.add(option);
    });
    const select = $('band-select');
    select.replaceChildren(...this.bands.map((band, i) => new Option(band.name, i)));
    select.value = String(this.bandChoice);
    this.#updateProductUi();
  }

  #updateProductUi() {
    for (const button of $('products').children) button.classList.toggle('active', Number(button.dataset.index) === this.productIndex);
    $('product-select').value = String(this.productIndex);
    $('band-select').hidden = this.products[this.productIndex].id !== 'band';
    this.#updateStretchUi();
  }

  /** The min/max stretch controls show only while a band is displayed with an adjustable linear stretch. */
  #updateStretchUi() {
    const visible = Boolean(this.store) && this.#usesLinearRange();
    $('stretch').hidden = !visible;
    if (!visible) return;
    const [lo, hi] = this.#linear.range ?? [0, 1];
    for (const [id, value] of [['stretch-min', lo], ['stretch-max', hi]]) {
      const input = $(id);
      if (document.activeElement !== input) input.value = String(Number(value.toPrecision(5)));
    }
  }

  #buildTimeline() {
    const track = $('timeline-track');
    track.querySelectorAll('.timeline-tick').forEach((tick) => tick.remove());
    const n = this.store.times.length;
    this.#tickElements = this.store.times.map((_, i) => {
      const tick = document.createElement('div');
      tick.className = 'timeline-tick';
      tick.style.left = n > 1 ? `calc(8px + (100% - 16px) * ${i / (n - 1)})` : '50%';
      tick.title = this.#formatTime(i);
      track.appendChild(tick);
      return tick;
    });
  }

  #updatePlayUi() {
    const playing = this.#playback?.playing ?? false;
    if (this.#wasPlaying && !playing) {
      this.requestRender();
      this.#scheduleUrlSync();
    }
    if (playing !== this.#wasPlaying) this.#playEpoch++;
    this.#wasPlaying = playing;
    const button = $('play-btn');
    button.classList.toggle('playing', playing);
    button.title = playing ? 'Pause (Space)' : 'Play (Space)';
    button.setAttribute('aria-label', button.title);
    button.disabled = !this.store;
    $('export-btn').disabled = !this.store;
    const buffering = this.#playback?.buffering ?? false;
    button.classList.toggle('buffering', buffering);
    button.setAttribute('aria-busy', String(buffering));
    const hint = $('buffer-hint');
    const { ahead, needed } = this.#playback?.buffered ?? { ahead: 0, needed: 0 };
    const text = buffering ? `buffering ${ahead} / ${needed}` : '';
    if (hint.textContent !== text) hint.textContent = text;
    if (buffering) button.title = 'Buffering: playback starts when the next frames are loaded (Space to cancel)';
    if (!playing) {
      this.#bufferPump?.controller?.abort();
      this.#bufferPump = null;
    }
    this.#updateSpeedUi();
  }

  /** The slider shows the requested speed; when the display cannot keep up the label adds what is delivered. */
  #updateSpeedUi() {
    $('speed').value = String(SPEEDS.indexOf(this.#speed));
    const effective = this.#playback?.playing ? Math.round(this.#playback.effectiveStepsPerSecond) : this.#speed;
    $('speed-label').textContent = effective < this.#speed ? `${this.#speed} /s → ${effective}` : `${this.#speed} /s`;
  }

  /** "playing at 1/2 res · fits memory" (or "· link") while the movie level is coarser than the normal one; the tooltip has the numbers. */
  #updateResHint() {
    const { baseLod, lod, reason, detail } = this.#movie;
    const coarser = this.#playing && lod > baseLod;
    const text = coarser ? `playing at 1/${2 ** (lod - baseLod)} res · ${describeReason(reason)}` : '';
    const hint = $('res-hint');
    if (hint.textContent !== text) {
      hint.textContent = text;
      hint.title = coarser ? (detail ?? '') : '';
    }
  }

  #updateTimeUi() {
    this.#updateChartMarker();
    $('time-label').textContent = this.#formatTime(this.t);
    this.#tickElements.forEach((tick, i) => {
      tick.classList.toggle('active', i === this.t);
      tick.classList.toggle('loading', i === this.t && this.#loading);
    });
    $('timeline-track').classList.toggle('loading', this.#loading);
  }

  /** What the performance overlay says about the store: its name, bands, timesteps and size (kept out of the header). */
  #updateMeta() {
    const level = this.store.levels[0];
    const name = new URL(this.store.url, location.href).pathname.replace(/\/$/, '').split('/').pop();
    this.#storeSummary = `${name} · ${this.bands.map((band) => band.name).join(' ')} · ${this.store.times.length} steps · ${level.width}×${level.height} · ${this.dtype}`;
    this.#paintMs = null;
  }

  #setProgress(frac) {
    const fill = $('progress-fill');
    if (frac <= 0) {
      fill.style.opacity = '0';
      fill.style.width = '0';
    } else if (frac >= 1) {
      fill.style.width = '100%';
      setTimeout(() => {
        fill.style.opacity = '0';
      }, 200);
    } else {
      fill.style.width = `${frac * 100}%`;
      fill.style.opacity = '1';
    }
  }

  /** A toast is a non-blocking notice that fades on its own; otherwise the box stays until the next load. */
  #showError(title, message, { toast = false, code = 'error' } = {}) {
    this.#hook('error', { code, title, message });
    clearTimeout(this.#toastTimer);
    $('error-title').textContent = title;
    $('error-message').textContent = message;
    const overlay = $('error-overlay');
    overlay.classList.add('visible');
    overlay.classList.toggle('toast', toast);
    if (toast) this.#toastTimer = setTimeout(() => this.#hideError(), TOAST_MS);
  }

  #hideError() {
    $('error-overlay').classList.remove('visible', 'toast');
  }

  #updateSidebar(info) {
    const empty = $('sidebar-empty');
    const content = $('sidebar-content');
    empty.style.display = info ? 'none' : 'flex';
    content.style.display = info ? 'block' : 'none';
    if (!info) return;
    content.innerHTML = sidebarHtml(info, this.#formatTime(info.t));
    this.#renderChart();
  }
}

async function loadCatalog() {
  const url = new URL('catalog.json', location.href);
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  const entries = await response.json();
  return entries.map(({ name, url: storeUrl }) => ({ name, url: new URL(storeUrl, url).href }));
}

async function main() {
  // The embed layout is CSS on attributes of <html>; the inline script of index.html has set them already, this makes sure.
  const embed = parseEmbedParams(location.search, document.referrer);
  applyEmbedAttributes(document.documentElement, embed);
  const viewer = new Viewer();
  viewer.embedded = embed.embed;
  viewer.inspectorUi = embed.controls;
  viewer.extraQuery = embed.query;
  const bridge = embed.embed ? connectEmbed(viewer, embed) : null;
  window.chronozarr = {
    viewer,
    bench: () => import('./bench.js').then((m) => m.runBenchmarks(viewer)),
    scrubBench: (options) => import('./bench.js').then((m) => m.runScrubBenchmarks(viewer, options)),
    playBench: (options) => import('./bench.js').then((m) => m.playBench(viewer, options)),
    interactionBench: (options) => import('./bench.js').then((m) => m.interactionBench(viewer, options)),
  };

  $('export-btn').addEventListener('click', () => toggleExportPanel(viewer));

  // An embed has no catalog selector and must never show another store than the one asked for, so it does not fetch the catalog.
  const catalog = embed.embed
    ? []
    : await loadCatalog().catch((error) => {
        console.warn('catalog.json not usable:', error);
        return [];
      });
  const select = $('catalog-select');
  const inCatalog = (url) => catalog.some((entry) => entry.url === url);
  const initialSearch = location.search;
  const open = (url, { fallback = true, viewSearch } = {}) => {
    // A catalog store is not pinned in the URL, so an open tab follows catalog changes on reload;
    // only an external store is shareable via ?store=. The view (t, p, z, c) in the URL is restored
    // when the page first opens; opening another store starts from its default view.
    viewer.pinnedStore = inCatalog(url) ? null : url;
    viewer.resetUrl();
    select.value = url;
    // An external store earns a dropdown entry only once it has loaded, so a dead URL from an old
    // permalink never lingers as an option.
    const optionFor = (value) => [...select.options].find((option) => option.value === value);
    window.chronozarr.ready = viewer
      .loadStore(url, { viewSearch })
      .then((result) => {
        if (!inCatalog(url) && catalog.length > 0 && !optionFor(url)) {
          select.add(new Option(url.replace(/^https?:\/\//, ''), url));
          select.value = url;
        }
        return result;
      })
      .catch((error) => {
        console.error(`loadStore(${url}) failed:`, error);
        optionFor(url)?.remove();
        if (fallback && catalog.length > 0 && catalog[0].url !== url) {
          console.warn(`falling back to the catalog store ${catalog[0].url}`);
          open(catalog[0].url, { fallback: false });
        }
      });
  };
  if (catalog.length > 0) {
    select.replaceChildren(...catalog.map((entry) => new Option(entry.name, entry.url)));
    select.hidden = false;
    select.addEventListener('change', () => open(select.value));
  }

  const requested = new URLSearchParams(location.search).get('store');
  if (requested) {
    open(new URL(requested, location.href).href, { viewSearch: initialSearch });
  } else if (catalog.length > 0) open(catalog[0].url, { viewSearch: initialSearch });
  else {
    $('error-title').textContent = 'No store selected';
    $('error-message').textContent = 'Open this page with ?store=<base URL of a chronozarr store>.';
    $('error-overlay').classList.add('visible');
    bridge?.post('error', { code: 'no_store', message: 'No store selected: the iframe URL needs ?store=<base URL of a chronozarr store>.' });
  }
}

main();
