// Benchmarks for the chronozarr decoder and the chronozarr viewer, run against the store that is
// currently open. From the page console: `await chronozarr.bench()`.
//
//   cold open       loadStore -> first complete frame at LOD 0, HTTP cache bypassed, with and without
//                   consolidated metadata in the root zarr.json.
//   warm switch     goToTime -> frame finished on the GPU, with every chunk already decoded in the cache:
//                   stepping one timestep at a time with pauses (the GPU window keeps neighbours resident,
//                   so a step is a uniform change), jumping several timesteps at once, and with the
//                   texture pool emptied so every switch uploads from the decoded cache.
//   product switch  setProduct -> frame finished.
//   decode          per-chunk zarrita decode time, replayed from recorded bytes (no network).
//
// `await chronozarr.scrubBench()` measures what a user feels while stepping and dragging the time
// slider; see runScrubBenchmarks. `await chronozarr.playBench({ stepsPerSecond: 4 })` plays one movie
// loop and reports the achieved rate and the holds; see playBench. `await chronozarr.interactionBench()`
// replays one scripted sequence (scrub, jump, pan, zoom, play) and reports the performance overlay's numbers
// per phase, for before/after comparisons; see interactionBench.

import * as zarr from '../vendor/zarrita/index.js';
import { openStore } from '../chronozarr/decoder.js';
import { FrameMonitor, analyzeLatency, emptyStats, formatPhaseTable, frameCompleteness, isWholeFrame, readStats, statsDelta } from './perf.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const round = (x) => Math.round(x * 100) / 100;
const noStoreFetch = (request) => fetch(new Request(request, { cache: 'no-store' }));

function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * A fetch that behaves like a remote bucket behind HTTP/2: every request pays `rttMs` before its first byte,
 * request concurrency is unlimited, and response bodies share one link of `mbps` megabits per second
 * (first come, first served). A request aborted mid-transfer still occupies the link, as the bytes are in flight.
 */
export function simulatedRemoteFetch({ rttMs, mbps }) {
  const bytesPerMs = (mbps * 1e6) / 8 / 1000;
  let linkFreeAt = 0;
  return async (request) => {
    await sleepUnlessAborted(rttMs, request.signal);
    const response = await noStoreFetch(request);
    if (request.method === 'HEAD') return response;
    const body = await response.arrayBuffer();
    linkFreeAt = Math.max(performance.now(), linkFreeAt) + body.byteLength / bytesPerMs;
    await sleepUnlessAborted(linkFreeAt - performance.now(), request.signal);
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

function withoutConsolidatedMetadata(rootUrl) {
  return async (request) => {
    const response = await noStoreFetch(request);
    if (request.url !== `${rootUrl}/zarr.json`) return response;
    const root = await response.json();
    delete root.consolidated_metadata;
    return new Response(JSON.stringify(root), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  };
}

async function coldOpen(viewer, url, fetchImpl, runs) {
  const rows = [];
  for (let run = 0; run < runs; run++) {
    await sleep(300);
    performance.clearResourceTimings();
    const { openMs, firstPaintMs } = await viewer.loadStore(url, { lod: 0, fetch: fetchImpl });
    const { requests, bytes } = viewer.store.stats.network;
    rows.push({
      run,
      openMs: round(openMs),
      firstPaintMs: round(firstPaintMs),
      httpRequests: requests,
      wireBytes: bytes,
      resourceEntries: performance.getEntriesByType('resource').length,
    });
  }
  return rows;
}

async function switchTimings(viewer, sequence, { emptyPool = false, pauseMs = 0 } = {}) {
  const { renderer, store } = viewer;
  const rows = [];
  for (const t of sequence) {
    if (pauseMs) await sleep(pauseMs);
    if (emptyPool) renderer.clearResident();
    const before = { requests: store.stats.network.requests, bytes: store.stats.network.bytes, uploads: renderer.stats.uploads, misses: store.stats.cache.misses };
    const started = performance.now();
    viewer.goToTime(t);
    const frame = viewer.renderNow();
    renderer.finish();
    const ms = performance.now() - started;
    rows.push({
      t,
      ms,
      complete: frame.complete,
      requests: store.stats.network.requests - before.requests,
      bytes: store.stats.network.bytes - before.bytes,
      uploads: renderer.stats.uploads - before.uploads,
      misses: store.stats.cache.misses - before.misses,
    });
  }
  return rows;
}

function describeSwitches(rows) {
  return {
    ...Object.fromEntries(Object.entries(summarize(rows.map((r) => r.ms))).map(([k, v]) => [k, round(v)])),
    incomplete: rows.filter((r) => !r.complete).length,
    networkRequests: rows.reduce((n, r) => n + r.requests, 0),
    wireBytes: rows.reduce((n, r) => n + r.bytes, 0),
    uploadsPerSwitch: rows.reduce((n, r) => n + r.uploads, 0) / rows.length,
    cacheMisses: rows.reduce((n, r) => n + r.misses, 0),
  };
}

/** 0,1,...,T-1,T-2,...,1,0,... (one step at a time) for `count` steps starting after `current`. */
function pingPongSequence(nTime, current, count) {
  const sequence = [];
  let t = current;
  let direction = current === nTime - 1 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    if (t + direction < 0 || t + direction >= nTime) direction = -direction;
    t += direction;
    sequence.push(t);
  }
  return sequence;
}

function jumpSequence(nTime, current, count) {
  const sequence = [];
  let t = current;
  for (let i = 0; i < count; i++) {
    t = (t + 1 + (i % 3)) % nTime;
    if (t === (sequence.at(-1) ?? current)) t = (t + 1) % nTime;
    sequence.push(t);
  }
  return sequence;
}

function recordingStore(inner, records) {
  return {
    async get(key, options) {
      const bytes = await inner.get(key, options);
      records.set(key, bytes);
      return bytes;
    },
    async getRange(key, range, options) {
      const bytes = await inner.getRange(key, range, options);
      records.set(`${key}|${JSON.stringify(range)}`, bytes);
      return bytes;
    },
  };
}

/** Like a real store, hands out fresh bytes on every read (the decode pool takes ownership of what it is given). */
function replayStore(records) {
  return {
    get: async (key) => records.get(key)?.slice(),
    getRange: async (key, range) => records.get(`${key}|${JSON.stringify(range)}`)?.slice(),
  };
}

/** Per-chunk decode (zstd/gzip + bytes codec) replayed from recorded bytes, so the network is out of the loop. */
async function decodeTimings(url, repeats) {
  const records = new Map();
  const recorder = await openStore(url, { store: recordingStore(new zarr.FetchStore(url, { fetch: noStoreFetch }), records), workers: 0 });
  const timesteps = Math.min(recorder.times.length, 8);
  for (let t = 0; t < timesteps; t++) await recorder.getRaw(0, 0, 0, t);
  const replayer = await openStore(url, { store: replayStore(records), workers: 0 });
  await replayer.getRaw(0, 0, 0, 0);

  const chunks = [];
  for (let t = 0; t < timesteps; t++) {
    for (let i = 0; i < repeats; i++) {
      replayer.clearCache();
      const started = performance.now();
      await replayer.getRaw(0, 0, 0, t);
      chunks.push(performance.now() - started);
    }
  }
  const level = replayer.levels[0];

  // The same chunks decoded in parallel by the worker pool versus one after another on this thread.
  const chunkTimes = Array.from({ length: timesteps }, (_, t) => t);
  replayer.clearCache();
  let started = performance.now();
  for (const t of chunkTimes) await replayer.getRaw(0, 0, 0, t);
  const mainThreadMs = performance.now() - started;
  const pooled = await openStore(url, { store: replayStore(records) });
  await pooled.getRaw(0, 0, 0, 0);
  await sleep(200);
  pooled.clearCache();
  started = performance.now();
  await Promise.all(chunkTimes.map((t) => pooled.getRaw(0, 0, 0, t)));
  const poolMs = performance.now() - started;
  pooled.close();

  const format = (values) => (values.length ? Object.fromEntries(Object.entries(summarize(values)).map(([k, v]) => [k, round(v)])) : null);
  return { chunkRawBytes: level.chunkBytes, chunk: format(chunks), parallel: { chunks: timesteps, mainThreadMs: round(mainThreadMs), workerPoolMs: round(poolMs) } };
}

const cellCount = (store) => store.levels[0].gridRows * store.levels[0].gridCols;

export async function runBenchmarks(viewer, { coldRuns = 5, switches = 30 } = {}) {
  const url = viewer.store.url.replace(/\/$/, '');
  const results = { store: url, userAgent: navigator.userAgent };

  results.coldOpenConsolidated = await coldOpen(viewer, url, noStoreFetch, coldRuns);
  results.coldOpenPerArrayMetadata = await coldOpen(viewer, url, withoutConsolidatedMetadata(url), coldRuns);
  await coldOpen(viewer, url, noStoreFetch, 1);

  const prefetch = await viewer.prefetchNow();
  results.prefetch = { fetched: prefetch.fetched, skipped: prefetch.skipped, budgetReached: prefetch.budgetReached, errors: prefetch.errors.length };
  results.cache = { ...viewer.store.cacheInfo(), gpuSlots: viewer.renderer.slots };

  const nTime = viewer.store.times.length;
  viewer.goToTime(0);
  viewer.renderNow();
  await sleep(300);
  results.warmSwitchStepping = describeSwitches(await switchTimings(viewer, pingPongSequence(nTime, viewer.t, switches), { pauseMs: 120 }));
  results.warmSwitchJumping = describeSwitches(await switchTimings(viewer, jumpSequence(nTime, viewer.t, switches)));
  results.warmSwitchUploadFromCache = describeSwitches(await switchTimings(viewer, jumpSequence(nTime, viewer.t, switches), { emptyPool: true }));

  const productRows = [];
  for (let i = 0; i < viewer.products.length; i++) {
    if (!viewer.products[i].available) continue;
    for (let rep = 0; rep < 5; rep++) {
      const started = performance.now();
      viewer.setProduct(i);
      viewer.renderNow();
      viewer.renderer.finish();
      productRows.push({ product: viewer.products[i].id, ms: performance.now() - started });
    }
  }
  results.productSwitch = Object.fromEntries(
    [...new Set(productRows.map((r) => r.product))].map((id) => [id, round(summarize(productRows.filter((r) => r.product === id).map((r) => r.ms)).median)]),
  );

  results.decodePerChunk = await decodeTimings(url, 10);

  console.log(JSON.stringify(results, null, 2));
  window.__benchResults = results;
  return results;
}

// ---- perceived scrub latency ----

const TIMEOUT_MS = 6000;
const OPEN_TIMEOUT_MS = 60000;

/** loadStore with a deadline, so a run that can never paint fails instead of hanging the benchmark. */
function openWithin(viewer, url, options) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no complete first frame within ${OPEN_TIMEOUT_MS / 1000} s`)), OPEN_TIMEOUT_MS);
  });
  return Promise.race([viewer.loadStore(url, options), deadline]).finally(() => clearTimeout(timer));
}

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1) ?? null) };
}

function timelinePoint(viewer, t) {
  const rect = document.getElementById('timeline-track').getBoundingClientRect();
  const frac = viewer.store.times.length > 1 ? t / (viewer.store.times.length - 1) : 0;
  return { x: rect.left + 8 + frac * (rect.width - 16), y: rect.top + rect.height / 2 };
}

function pointer(target, type, point) {
  target.dispatchEvent(new PointerEvent(type, { clientX: point.x, clientY: point.y, bubbles: true, pointerId: 1 }));
}

async function waitUntil(predicate, timeoutMs) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

/** Records long tasks and the gaps between animation frames until stop() is called. */
function observeMainThread() {
  const longTasks = [];
  const frameGaps = [];
  const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration)));
  observer.observe({ type: 'longtask' });
  let running = true;
  let last = performance.now();
  const onFrame = (now) => {
    frameGaps.push(now - last);
    last = now;
    if (running) requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  return {
    stop() {
      running = false;
      observer.disconnect();
      return { longTasks, frameGaps };
    },
  };
}

/** Camera that shows about nine LOD 0 cells (3x3) centred on a cell near the middle of the mosaic. */
function nineCellCamera(viewer) {
  const level = viewer.store.levels[0];
  const row = Math.min(2, level.gridRows - 1);
  const col = Math.min(2, level.gridCols - 1);
  return {
    cx: (col + 0.5) * level.chunkWidth,
    cy: (row + 0.5) * level.chunkHeight,
    scale: viewer.canvas.width / (2.9 * level.chunkWidth),
  };
}

/** Runs the input script and returns the raw inputs and viewer events. */
async function driveScrub(viewer, { mode, steps, cadenceMs, startT }) {
  const events = [];
  const inputs = [];
  const monitor = observeMainThread();
  viewer.probe = (event) => events.push(event);
  const network = viewer.store.stats.network;
  const before = { requests: network.requests, bytes: network.bytes, misses: viewer.store.stats.cache.misses };
  const track = document.getElementById('timeline-track');
  const begin = performance.now();
  for (let i = 0; i < steps; i++) {
    const due = begin + i * cadenceMs;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    const t = startT + 1 + i;
    inputs.push({ at: performance.now(), t });
    if (mode === 'keys') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    } else if (i === 0) {
      pointer(track, 'pointerdown', timelinePoint(viewer, t));
    } else {
      pointer(window, 'pointermove', timelinePoint(viewer, t));
    }
  }
  if (mode === 'drag') pointer(window, 'pointerup', timelinePoint(viewer, startT + steps));
  const finalT = startT + steps;
  const settled = await waitUntil(() => events.some((e) => e.type === 'paint' && e.complete && e.t === finalT), TIMEOUT_MS);
  await sleep(50);
  viewer.probe = null;
  const { longTasks, frameGaps } = monitor.stop();
  return {
    events, inputs, longTasks, frameGaps, settled,
    network: { requests: network.requests - before.requests, bytes: network.bytes - before.bytes, misses: viewer.store.stats.cache.misses - before.misses },
  };
}

/**
 * Per-step lag and phase breakdown from the raw events. The lag of a step is the time from its input
 * event to the first paint that shows that timestep or a later one (a step the viewer skipped over is
 * satisfied by the later frame that replaced it), so a viewer that falls behind is not flattered by
 * only counting the frames it managed to show. The phase breakdown covers steps shown exactly.
 */
function analyzeScrub(run) {
  const { events, inputs } = run;
  const paints = events.filter((e) => e.type === 'paint');
  const steps = inputs.map((input) => {
    const later = (p) => p.at >= input.at && p.t >= input.t;
    const caughtUp = paints.find((p) => later(p) && p.complete);
    const firstCell = paints.find((p) => later(p) && p.ready > 0);
    const exact = paints.find((p) => p.at >= input.at && p.t === input.t && p.complete);
    const row = { t: input.t, shownExactly: Boolean(exact), lagMs: caughtUp ? caughtUp.at - input.at : null, firstCellMs: firstCell ? firstCell.at - input.at : null };
    if (exact) {
      const loadStart = events.find((e) => e.type === 'load-start' && e.t === input.t && e.at >= input.at);
      const lastReady = events.filter((e) => e.type === 'cell-ready' && e.t === input.t && e.at >= input.at).at(-1);
      row.queueMs = loadStart ? loadStart.at - input.at : 0;
      row.loadMs = loadStart && lastReady ? lastReady.at - loadStart.at : 0;
      row.uploadMs = exact.uploadMs;
      row.renderMs = exact.renderMs;
      row.otherMs = exact.at - input.at - row.queueMs - row.loadMs - row.uploadMs - row.renderMs;
    }
    return row;
  });
  const exact = steps.filter((s) => s.shownExactly);
  const mean = (key) => (exact.length ? round(exact.reduce((n, s) => n + s[key], 0) / exact.length) : null);
  const lastPaint = paints.at(-1);
  const finalPaint = paints.findLast((p) => p.complete && p.t === inputs.at(-1).t);
  const gaps = [...run.frameGaps].sort((a, b) => a - b);
  return {
    lod: lastPaint?.lod,
    visibleCells: lastPaint?.cells,
    stepsShownExactly: exact.length,
    stepsNeverCaughtUp: steps.filter((s) => s.lagMs === null).length,
    settled: run.settled,
    settleMs: finalPaint ? round(finalPaint.at - inputs.at(-1).at) : null,
    lagMs: distribution(steps.filter((s) => s.lagMs !== null).map((s) => s.lagMs)),
    firstCellMs: distribution(steps.filter((s) => s.firstCellMs !== null).map((s) => s.firstCellMs)),
    meanPhaseMsOfShownSteps: { queue: mean('queueMs'), load: mean('loadMs'), upload: mean('uploadMs'), render: mean('renderMs'), other: mean('otherMs') },
    mainThread: {
      longTasks: run.longTasks.length,
      longTaskMaxMs: round(Math.max(0, ...run.longTasks)),
      framesOver33ms: run.frameGaps.filter((g) => g > 33).length,
      maxFrameGapMs: round(gaps.at(-1)),
    },
    network: run.network,
  };
}

/**
 * Perceived latency while stepping (ArrowRight every 100 ms) and dragging the timeline slider (one
 * timestep every 40 ms): input event -> first paint that shows the new timestep (first cell / all
 * visible cells), with a breakdown and main-thread stall counts. Each run opens the store from
 * scratch, either scrubs immediately after the first frame ("cold") or after 5 s of idle prefetch,
 * at the overview zoom fit() picks and zoomed to about nine LOD 0 cells.
 */
export async function runScrubBenchmarks(viewer, { steps = 20, startT = 40, idleMs = 5000, network = null, only = null } = {}) {
  const fetchImpl = network ? simulatedRemoteFetch(network) : noStoreFetch;
  const url = viewer.store.url.replace(/\/$/, '');
  await openWithin(viewer, url, { fetch: fetchImpl });
  const zoomed = nineCellCamera(viewer);
  const results = { store: url, network: network ?? 'as configured by the page', steps, startT, runs: {} };
  const zooms = { overview: undefined, zoomed9cells: zoomed };

  for (const [zoomName, camera] of Object.entries(zooms)) {
    for (const state of ['cold', 'idle']) {
      for (const [mode, cadenceMs] of [['keys', 100], ['drag', 40]]) {
        const name = `${zoomName}/${state}/${mode}`;
        if (only && !only.includes(name)) continue;
        await openWithin(viewer, url, { fetch: fetchImpl, camera });
        viewer.goToTime(startT);
        await waitUntil(() => viewer.paintedT === startT, TIMEOUT_MS);
        if (state === 'idle') await sleep(idleMs);
        const run = await driveScrub(viewer, { mode, steps, cadenceMs, startT });
        results.runs[name] = analyzeScrub(run);
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
  window.__scrubResults = results;
  return results;
}

// ---- movie playback ----

/** Wait for the prefetch for playback (at the movie level) to finish and the network to stay quiet for `quietMs`. */
async function settleNetwork(viewer, { timeoutMs = 900000, quietMs = 2000 } = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`prefetch did not finish within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  const prefetch = await Promise.race([viewer.prefetchNow({ movie: true }), deadline]).finally(() => clearTimeout(timer));
  const network = viewer.store.stats.network;
  let seen = network.requests;
  let quietSince = performance.now();
  while (performance.now() - quietSince < quietMs) {
    await sleep(100);
    if (network.requests !== seen) {
      seen = network.requests;
      quietSince = performance.now();
    }
  }
  return prefetch;
}

// Gaps between animation frames above this count as a missed 60 Hz frame (16.7 ms plus timestamp noise).
const SIXTY_HZ_FRAME_MS = 17;

/**
 * What playback's statistics say about waiting for frames, whichever viewer produced them: a viewer from before
 * buffering held on a single frame (`held`), the current one pauses and refills its buffer (`bufferingPauses`).
 */
function stallStats(stats) {
  return {
    initialBufferMs: stats.initialBufferMs === undefined || stats.initialBufferMs === null ? null : round(stats.initialBufferMs),
    bufferingPauses: stats.bufferingPauses ?? 0,
    bufferingMs: round(stats.bufferingMs ?? 0),
    longestBufferingMs: round(stats.longestBufferingMs ?? 0),
    wrapPauses: stats.wrapPauses ?? 0,
    holds: stats.held ?? 0,
    holdMs: round(stats.totalHoldMs ?? 0),
    longestHoldMs: round(stats.longestHoldMs ?? 0),
    wrapHolds: stats.wrapHeld ?? 0,
  };
}

/**
 * Plays `loops` consecutive full loops (every timestep, wrapping from the last back to the first; two by
 * default so the second one shows the loop in steady state) at `stepsPerSecond` on the open store and
 * reports what playback actually delivered: the achieved rate between the first and last step, the display
 * rate it measured and the effective speed it clamped to, the time it buffered before starting and how often it
 * ran dry and paused to refill (`bufferingPauses`, with the wrap's apart; a viewer from before buffering reports
 * the steps it had to hold instead), how late frames appeared after each step, the completeness of the frames painted
 * (`frameCompleteness`: how many were partial, drawn from a coarser level, or kept back), time spent uploading
 * textures inside the frames that painted (uploads that the GPU window did not manage to do ahead of time), and
 * main-thread stalls. `cold` reopens the store first (empty caches, HTTP cache bypassed); `warm: 'prefetch'` waits for
 * the window prefetch to finish and the network to go quiet first; `idleMs` just waits. `lod` pins a level
 * (2 = four cells on the test stores).
 */
export async function playBench(viewer, { stepsPerSecond = 4, loops = 2, cold = false, warm = null, idleMs = 0, lod = null } = {}) {
  const url = viewer.store.url.replace(/\/$/, '');
  if (cold) await openWithin(viewer, url, { fetch: noStoreFetch, lod: lod ?? undefined });
  viewer.pause();
  if (!cold && viewer.lodOverride !== lod) {
    viewer.lodOverride = lod;
    const repainted = viewer.whenPainted();
    viewer.renderNow();
    await repainted;
  }
  viewer.goToTime(0);
  await waitUntil(() => viewer.paintedT === 0, TIMEOUT_MS);
  if (warm === 'prefetch') await settleNetwork(viewer);
  if (idleMs) await sleep(idleMs);

  const count = viewer.store.times.length;
  viewer.playback.setSpeed(stepsPerSecond);
  const events = [];
  viewer.probe = (event) => events.push(event);
  const monitor = observeMainThread();
  const network = viewer.store.stats.network;
  const before = { requests: network.requests, bytes: network.bytes };
  viewer.play();
  const stepsWanted = count * loops;
  const expectedMs = (stepsWanted / stepsPerSecond) * 1000;
  const finished = await waitUntil(() => viewer.playback.stats.steps >= stepsWanted, expectedMs * 5 + 60000);
  const { refreshHz, effectiveStepsPerSecond } = viewer.playback;
  const movie = viewer.movieInfo;
  const eventsWhilePlaying = events.length;
  viewer.pause();
  await sleep(100);
  viewer.probe = null;
  const { longTasks, frameGaps } = monitor.stop();

  const { stats } = viewer.playback;
  const loopMs = stats.lastStepAt - stats.firstStepAt;
  const paints = events.filter((e) => e.type === 'paint' && e.complete);
  const lags = [];
  for (const input of events.filter((e) => e.type === 'input')) {
    const paint = paints.find((p) => p.at >= input.at && p.t === input.t);
    if (paint) lags.push(paint.at - input.at);
  }
  const uploadMs = paints.map((p) => p.uploadMs);
  const lastPaint = events.slice(0, eventsWhilePlaying).findLast((e) => e.type === 'paint' && e.complete);

  // The wrap: steps whose timestep is 0. How long each took to arrive after the step before it, against the
  // typical gap, and the achieved rate of each loop (first loop: t=1 .. first wrap; then wrap to wrap).
  const steps = events.filter((e) => e.type === 'input');
  const gaps = steps.slice(1).map((s, i) => s.at - steps[i].at);
  const typicalGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const wrapIndexes = steps.map((s, i) => (s.t === 0 && i > 0 ? i : -1)).filter((i) => i > 0);
  const wrapGapsMs = wrapIndexes.map((i) => round(steps[i].at - steps[i - 1].at));
  const loopBoundaries = [0, ...wrapIndexes];
  const perLoopStepsPerSecond = loopBoundaries.slice(1).map((end, k) => {
    const start = loopBoundaries[k];
    return round(((end - start) / (steps[end].at - steps[start].at)) * 1000);
  });
  const results = {
    store: url,
    mode: cold ? 'cold' : warm === 'prefetch' ? 'warm (after prefetch)' : idleMs ? `warm after ${idleMs} ms idle` : 'warm',
    lod: lastPaint?.lod,
    normalLod: movie.baseLod,
    resolution: movie.lod > movie.baseLod ? `1/${2 ** (movie.lod - movie.baseLod)}` : 'full',
    visibleCells: lastPaint?.cells,
    requestedStepsPerSecond: stepsPerSecond,
    loops,
    measuredRefreshHz: refreshHz === null ? null : round(refreshHz),
    effectiveStepsPerSecond: round(effectiveStepsPerSecond),
    timesteps: count,
    finishedLoops: finished,
    stepsTaken: stats.steps,
    achievedStepsPerSecond: round(((stats.steps - 1) / loopMs) * 1000),
    loopMs: round(loopMs),
    idealLoopMs: round(((stepsWanted - 1) / Math.min(stepsPerSecond, refreshHz ?? stepsPerSecond)) * 1000),
    perLoopStepsPerSecond,
    frameCompleteness: frameCompleteness(events),
    ...stallStats(stats),
    wrapGapsMs,
    typicalStepGapMs: round(typicalGap),
    displayLagMs: distribution(lags),
    renderUploadMs: { total: round(uploadMs.reduce((n, ms) => n + ms, 0)), max: round(Math.max(0, ...uploadMs)), framesWithUploads: uploadMs.filter((ms) => ms > 0.05).length },
    framesOver33ms: frameGaps.filter((g) => g > 33).length,
    framesOver16_7ms: frameGaps.filter((g) => g > SIXTY_HZ_FRAME_MS).length,
    frames: frameGaps.length,
    maxFrameGapMs: round(Math.max(0, ...frameGaps)),
    longTasks: longTasks.length,
    network: { requests: network.requests - before.requests, MB: round((network.bytes - before.bytes) / 1048576) },
  };
  viewer.lodOverride = null;
  console.log(JSON.stringify(results, null, 2));
  return results;
}

// ---- interaction benchmark ----

function canvasPoint(viewer, fx = 0.5, fy = 0.5) {
  const rect = viewer.canvas.getBoundingClientRect();
  return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
}

/** A drag on the canvas through the viewer's own pointer handlers; resolves with the time of the last event. */
async function drag(viewer, { dx, dy, moves = 4, everyMs = 16 }) {
  const { canvas } = viewer;
  // Synthetic pointer ids are not active pointers, so setPointerCapture would throw NotFoundError; capture is irrelevant here.
  canvas.setPointerCapture = () => {};
  try {
    const start = canvasPoint(viewer);
    pointer(canvas, 'pointerdown', start);
    for (let i = 1; i <= moves; i++) {
      await sleep(everyMs);
      pointer(canvas, 'pointermove', { x: start.x + (dx * i) / moves, y: start.y + (dy * i) / moves });
    }
    const at = performance.now();
    pointer(canvas, 'pointerup', { x: start.x + dx, y: start.y + dy });
    return at;
  } finally {
    delete canvas.setPointerCapture;
  }
}

/** Wheel ticks at the canvas center through the viewer's own wheel handler; resolves with the time of the last tick. */
async function wheel(viewer, { ticks, deltaY, everyMs = 30 }) {
  const at = canvasPoint(viewer);
  let lastAt = 0;
  for (let i = 0; i < ticks; i++) {
    lastAt = performance.now();
    viewer.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    if (i < ticks - 1) await sleep(everyMs);
  }
  return lastAt;
}

/**
 * Replays one scripted sequence on a cold store and reports, per phase, the numbers of the performance overlay
 * (key "d"): time to the first complete coarse frame and to the complete frame at the target level, cache hits and
 * misses, bytes in the decoded and compressed caches, peak in-flight and deduped requests, bytes transferred, the
 * bandwidth estimate, and frames over 16.7 and 33 ms. Fields the store's reader does not have are null ("–").
 *
 *   open                 loadStore from empty caches (HTTP cache bypassed) to the first complete frame
 *   scrub forward 20     ArrowRight every 100 ms
 *   scrub reverse 10     ArrowLeft every 100 ms
 *   big jump             a timeline click about half the time axis away
 *   pan                  a fast drag of 40 % of the canvas width (at the overview nothing new comes into view)
 *   zoom in              one wheel event of about 8x, at the canvas center
 *   pan (zoomed in)      the same drag, now with cells coming into view
 *   zoom out             one wheel event of about 1/8x
 *   play                 `loops` loops at `stepsPerSecond`
 *
 * "Coarse" is the first whole frame at any level, "full" the complete frame at the level asked for; both are measured from
 * the last input of a phase (for the scrub phases, per step). Every phase also reports the completeness of the frames
 * it painted (`frameCompleteness`): how many were partial (none, for a viewer that draws only whole frames), how many
 * came from a coarser level than asked for, and how often it kept the canvas as it was because no whole frame was ready.
 * From the page console: `await chronozarr.interactionBench()`; `network: {rttMs, mbps}` simulates a remote link;
 * `only: ['open', 'scrub forward 20', 'play']` runs just those phases.
 */
export async function interactionBench(viewer, { network = null, stepsPerSecond = 10, loops = 2, cadenceMs = 100, playCapMs = 180000, settleMs = 60000, only = null } = {}) {
  const fetchImpl = network ? simulatedRemoteFetch(network) : noStoreFetch;
  const url = viewer.store.url.replace(/\/$/, '');
  const events = [];
  const phases = [];
  const results = { store: url, network: network ?? 'as configured by the page', userAgent: navigator.userAgent, canvas: null, stepsPerSecond, loops };

  // A running phase: stats and frame counters from its start, peak in-flight requests sampled every 50 ms.
  // `fresh`: the phase opens the store, so its counters start from zero on the new store.
  const beginPhase = (name, { fresh = false } = {}) => {
    const frames = new FrameMonitor();
    const before = fresh ? emptyStats() : readStats(viewer.store);
    let peakInflight = before.inflight;
    const sampler = setInterval(() => {
      const { inflight } = readStats(viewer.store);
      if (inflight !== null) peakInflight = Math.max(peakInflight ?? 0, inflight);
    }, 50);
    frames.start();
    const first = events.length;
    return {
      first,
      end(extra = {}) {
        frames.stop();
        clearInterval(sampler);
        const phase = { name, stats: statsDelta(before, readStats(viewer.store)), frames: frames.snapshot(), peakInflight, frameCompleteness: frameCompleteness(events.slice(first)), ...extra };
        phases.push(phase);
        return phase;
      },
    };
  };
  const reachedAfter = (direction) => (paint, input) => (direction > 0 ? paint.t >= input.t : direction < 0 ? paint.t <= input.t : paint.t === input.t);
  const completePaint = (from, predicate) => waitUntil(() => events.slice(from).some((e) => e.type === 'paint' && e.complete && predicate(e)), settleMs);
  const press = (name) => document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

  viewer.probe = (event) => events.push(event);
  try {
    {
      const phase = beginPhase('open', { fresh: true });
      const started = performance.now();
      const { openMs, firstPaintMs } = await openWithin(viewer, url, { fetch: fetchImpl });
      await sleep(50);
      const paints = events.slice(phase.first).filter((e) => e.type === 'paint');
      const reportsFrames = paints.some((p) => p.covered !== undefined || p.partial !== undefined);
      const covered = reportsFrames ? paints.find(isWholeFrame) : null;
      const full = paints.find((p) => p.complete);
      const firstCell = paints.find((p) => p.ready > 0);
      results.open = {
        metadataMs: Math.round(openMs),
        firstCellMs: firstCell ? Math.round(firstCell.at - started) : null,
        firstCompleteFrameMs: covered ? Math.round(covered.at - started) : null,
        coarseMs: covered ? Math.round(covered.at - started) : null,
        coarseAfterMetadataMs: covered ? Math.round(covered.at - started - openMs) : null,
        fullMs: Math.round(firstPaintMs),
        fullAfterMetadataMs: full ? Math.round(full.at - started - openMs) : null,
        lod: full?.lod ?? null,
        cells: full?.cells ?? null,
      };
      results.canvas = { width: viewer.canvas.width, height: viewer.canvas.height };
      const single = (ms) => ({ n: 1, median: ms, p95: ms, max: ms });
      phase.end({ coarse: results.open.coarseMs === null ? null : single(results.open.coarseMs), full: single(results.open.fullMs) });
    }

    const count = viewer.store.times.length;
    const scrub = async (name, keyName, steps, direction) => {
      const phase = beginPhase(name);
      const begin = performance.now();
      const inputs = [];
      const from = viewer.t;
      for (let i = 0; i < steps; i++) {
        const wait = begin + i * cadenceMs - performance.now();
        if (wait > 0) await sleep(wait);
        inputs.push({ at: performance.now(), t: clamp01(from + direction * (i + 1), count) });
        press(keyName);
      }
      const finalT = inputs.at(-1).t;
      const settled = await completePaint(phase.first, (e) => e.t === finalT);
      await sleep(50);
      const latency = analyzeLatency(events.slice(phase.first), inputs, reachedAfter(direction));
      phase.end({ coarse: latency.coarse, full: latency.full, settled, neverCompleted: latency.neverCompleted });
    };
    // `run` performs the gesture and resolves with the time of its last input event; `restore` (not measured, and
    // finished before the next phase starts) puts the camera back.
    const gesture = async (name, run, restore = null) => {
      const phase = beginPhase(name);
      const last = { at: await run(), t: viewer.t };
      const settled = await completePaint(phase.first, (e) => e.at >= last.at);
      await sleep(50);
      const latency = analyzeLatency(events.slice(phase.first), [last], reachedAfter(0));
      phase.end({ coarse: latency.coarse, full: latency.full, settled, neverCompleted: latency.neverCompleted });
      if (restore) {
        const from = events.length;
        const at = await restore();
        await completePaint(from, (e) => e.at >= at);
        await sleep(50);
      }
    };

    const wants = (name) => !only || only.includes(name);
    await waitUntil(() => viewer.paintedT === viewer.t, settleMs);
    if (wants('scrub forward 20')) await scrub('scrub forward 20', 'ArrowRight', Math.min(20, count - 1 - viewer.t), 1);
    if (wants('scrub reverse 10')) await scrub('scrub reverse 10', 'ArrowLeft', Math.min(10, viewer.t), -1);
    if (wants('big jump')) {
      await gesture('big jump', async () => {
        const point = timelinePoint(viewer, (viewer.t + Math.round(count / 2)) % count);
        const at = performance.now();
        pointer(document.getElementById('timeline-track'), 'pointerdown', point);
        pointer(window, 'pointerup', point);
        return at;
      });
    }
    const panDx = -0.4 * viewer.canvas.getBoundingClientRect().width;
    if (wants('pan')) await gesture('pan', () => drag(viewer, { dx: panDx, dy: 0 }), () => drag(viewer, { dx: -panDx, dy: 0 }));
    if (wants('zoom in')) await gesture('zoom in', () => wheel(viewer, { ticks: 1, deltaY: -ZOOM_STEP_DELTA }));
    if (wants('pan (zoomed in)')) await gesture('pan (zoomed in)', () => drag(viewer, { dx: panDx, dy: 0 }), () => drag(viewer, { dx: -panDx, dy: 0 }));
    if (wants('zoom out')) await gesture('zoom out', () => wheel(viewer, { ticks: 1, deltaY: ZOOM_STEP_DELTA }));

    if (wants('play')) {
      const phase = beginPhase('play');
      viewer.playback.setSpeed(stepsPerSecond);
      viewer.play();
      const finished = await waitUntil(() => viewer.playback.stats.steps >= count * loops, playCapMs);
      const { stats } = viewer.playback;
      const movie = viewer.movieInfo;
      const achieved = stats.lastStepAt > stats.firstStepAt ? ((stats.steps - 1) / (stats.lastStepAt - stats.firstStepAt)) * 1000 : null;
      viewer.pause();
      await sleep(100);
      results.play = {
        requestedStepsPerSecond: stepsPerSecond,
        achievedStepsPerSecond: achieved === null ? null : round(achieved),
        finished,
        steps: stats.steps,
        ...stallStats(stats),
        normalLod: movie.baseLod,
        movieLod: movie.lod,
        movieReason: movie.reason ?? null,
        movieDetail: movie.detail ?? null,
      };
      phase.end({ coarse: null, full: null });
    }
  } finally {
    viewer.probe = null;
  }

  results.frameCompleteness = frameCompleteness(events);
  results.phases = phases;
  results.table = formatPhaseTable(phases);
  console.log(`${JSON.stringify({ ...results, phases: undefined, table: undefined }, null, 2)}\n${results.table}`);
  window.__interactionResults = results;
  return results;
}

// The viewer zooms by exp(-deltaY * 0.0015): 1400 is a factor of about 8.2.
const ZOOM_STEP_DELTA = 1400;
const clamp01 = (t, count) => Math.max(0, Math.min(count - 1, t));
