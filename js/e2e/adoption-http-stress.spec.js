import { mkdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildSyntheticStore, sourceValue } from '../support/synthetic-store.js';
import { startStaticServer } from '../support/static-server.js';

const N_TIME = 12;
const SIZE = 384;
const CHUNK = 128;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The colour of the whole frame of timestep t: RGB bytes, at least 18 apart from the colour of any other timestep. */
const colorOf = (t) => [30 + 18 * t, 240 - 18 * t, 60 + 30 * (t % 4)];

const SPEC = {
  nTime: N_TIME,
  nBand: 3,
  height: SIZE,
  width: SIZE,
  chunk: CHUNK,
  sharded: false,
  nLevels: 3,
  dtype: 'uint8',
  specVersion: '0.3.0',
  encoding: 'none',
  nodata: null,
  consolidated: true,
  bandObjects: [{ name: 'r', common_name: 'red', scale: 1 }, { name: 'g', common_name: 'green', scale: 1 }, { name: 'b', common_name: 'blue', scale: 1 }],
  values: (t, band) => colorOf(t)[band],
};

async function writeAtomicStore(dir) {
  for (const [key, bytes] of buildSyntheticStore(SPEC).files) {
    const file = path.join(dir, 'atomic', key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

/** A different delay (150 to 450 ms) for every URL, the same every run. */
const delayFor = (url) => 150 + ([...new URL(url).pathname].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 9973, 7) % 300);

/**
 * In the page: record, for every frame the viewer paints, what the canvas shows right then (the colour at the centre of each
 * of the nine cells) next to what the viewer says it painted; and whether the timeline marker ever showed its loading state.
 */
function installRecorder() {
  const { viewer } = window.chronozarr;
  const recorded = { frames: [], sawLoading: false };
  const read = () => {
    const { canvas, camera, renderer } = viewer;
    const { width, height } = canvas;
    const rgba = renderer.readFrame(width, height);
    const colors = [];
    for (const fy of [1 / 6, 1 / 2, 5 / 6]) {
      for (const fx of [1 / 6, 1 / 2, 5 / 6]) {
        const x = Math.floor((fx * 384 - camera.cx) * camera.scale + width / 2);
        const y = Math.floor((fy * 384 - camera.cy) * camera.scale + height / 2);
        const i = ((height - 1 - y) * width + x) * 4;
        colors.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
      }
    }
    return colors;
  };
  viewer.probe = (event) => {
    if (event.type !== 'paint') return;
    recorded.frames.push({ t: event.t, lod: event.lod, targetLod: event.targetLod, kind: event.kind, partial: event.partial, ready: event.ready, cells: event.cells, colors: read() });
  };
  new MutationObserver(() => {
    if (document.querySelector('.timeline-tick.active.loading')) recorded.sawLoading = true;
  }).observe(document.getElementById('timeline-track'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  window.__recorded = recorded;
}

/** Every recorded frame is whole: flagged so, every cell drawn, and the nine pixels all have the colour of the timestep it shows. */
function expectWholeFrames(frames) {
  const problems = [];
  for (const frame of frames) {
    const expected = colorOf(frame.t);
    const off = frame.colors.filter((rgb) => rgb.some((c, i) => Math.abs(c - expected[i]) > 3));
    if (frame.partial !== false) problems.push(`t=${frame.t} level ${frame.lod}: the viewer flagged the frame as partial (${frame.partial})`);
    if (frame.ready !== frame.cells) problems.push(`t=${frame.t} level ${frame.lod}: ${frame.ready} of ${frame.cells} cells drawn`);
    if (off.length > 0) problems.push(`t=${frame.t} level ${frame.lod} (${frame.kind}): ${off.length} of 9 sampled pixels are not the colour of t=${frame.t} ${JSON.stringify(expected)}: ${JSON.stringify(off)}`);
  }
  expect(problems, 'frames that were not whole').toEqual([]);
}


test('visible painted frames remain whole through transient HTTP 500 retries', async ({ page }, testInfo) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chronozarr-http-stress-'));
  const app = await startStaticServer(path.resolve(import.meta.dirname, '..'));
  const data = await startStaticServer(dir);
  const attempts = new Map();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await writeAtomicStore(dir);
    await page.route(`${data.url}/**`, async route => {
      const key = route.request().url();
      if (key.includes('/data/c/')) {
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        await sleep(delayFor(key));
        if (count === 1) { await route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'injected transient failure' }); return; }
      }
      await route.continue();
    });
    await page.goto(`${app.url}/demo/index.html?store=${encodeURIComponent(`${data.url}/atomic/`)}`);
    await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0);
    await page.evaluate(installRecorder);
    for (let t = 1; t < N_TIME; t++) {
      await page.evaluate(t => window.chronozarr.viewer.goToTime(t), t);
      await page.waitForTimeout(90);
    }
    await page.waitForFunction(last => window.chronozarr.viewer.paintedT === last && window.chronozarr.viewer.renderNow().complete, N_TIME - 1, { timeout: 45_000 });
    const recorded = await page.evaluate(() => window.__recorded);
    expect(recorded.frames.length).toBeGreaterThan(0);
    expectWholeFrames(recorded.frames);
    expect([...attempts.values()].some(n => n >= 2)).toBe(true);
    expect(errors).toEqual([]);
    await testInfo.attach('painted-frame-evidence', { body: JSON.stringify({ ...recorded, injected500s: attempts.size, retriedObjects: [...attempts.values()].filter(n => n >= 2).length, limits: 'Paint-event framebuffer samples cover nine cell centers, not every screen pixel or every compositor refresh.' }, null, 2), contentType: 'application/json' });
  } finally { await app.close(); await data.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const sharded of [false, true]) {
  test(`bounded-cache HTTP reader retains old axis and exact uncached values through append (${sharded})`, async ({ page }, testInfo) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronozarr-append-pressure-'));
    const app = await startStaticServer(path.resolve(import.meta.dirname, '..'));
    const data = await startStaticServer(dir);
    const retryAttempts = new Map();
    const spec = { nBand: 1, height: 40, width: 33, chunk: 32, sharded, shardTime: 4, specVersion: '0.3.0', shardBytes: sharded };
    const publish = async nTime => {
      const files = buildSyntheticStore({ ...spec, nTime }).files;
      for (const key of [...files.keys()].sort((a, b) => Number(a === '/zarr.json') - Number(b === '/zarr.json'))) {
        const file = path.join(dir, key);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.upload`, files.get(key));
        await rename(`${file}.upload`, file);
      }
    };
    try {
      await publish(11);
      await page.route(`${data.url}/**`, async route => {
        const key = route.request().url();
        if (key.includes('/data/c/')) {
          const count = (retryAttempts.get(key) ?? 0) + 1;
          retryAttempts.set(key, count);
          if (count === 1) { await route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'injected transient failure' }); return; }
        }
        await route.continue();
      });
      await page.goto(`${app.url}/support/reader-bench/bench.html`);
      await page.evaluate(async url => {
        const { openStore } = await import('/chronozarr/decoder.js');
        window.openPressureStore = () => openStore(url, { workers: 0, totalBytes: 8192, decodedBytes: 8192, compressedBytes: 0, retryDelaysMs: [0, 0], idleMs: 0, horizonSteps: 1 });
        window.oldPressureStore = await window.openPressureStore();
        window.pressureChunks = [];
        window.oldPressureStore.probe = event => { if (event.type === 'chunk') window.pressureChunks.push({ key: event.key, background: event.background }); };
        await window.oldPressureStore.prefetch({ lod: 0, cells: [[0, 0]], t: 0, concurrency: 1 });
      }, data.url);
      await publish(12);
      const result = await page.evaluate(async () => {
        const old = window.oldPressureStore;
        const fresh = await window.openPressureStore();
        const checks = [], samples = [];
        for (const [name, store, count] of [['old', old, 11], ['fresh', fresh, 12]]) {
          for (const t of [...Array(count).keys(), 0]) {
            for (const [row, col] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
              const cell = await store.getCell(0, row, col, t);
              const values = [];
              for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) values.push([row * 32 + y, col * 32 + x, cell.data[y * 32 + x]]);
              checks.push({ name, t, values });
              samples.push(store.cacheInfo());
            }
          }
        }
        const axes = [old.times.length, fresh.times.length];
        const evicted = old.peekRaw(0, 1, 1, 9) === undefined;
        old.close(); fresh.close();
        return { checks, samples, axes, evicted, chunks: window.pressureChunks, closed: [old.cacheInfo(), fresh.cacheInfo()] };
      });
      expect(result.axes).toEqual([11, 12]);
      expect(result.chunks.some(e => e.background)).toBe(true);
      expect(result.chunks.some(e => !e.background)).toBe(true);
      expect([...retryAttempts.values()].some(n => n >= 2)).toBe(true);
      expect(result.evicted).toBe(true);
      for (const check of result.checks) for (const [y, x, value] of check.values) expect(value).toBe(sourceValue(check.t, 0, y, x));
      expect(Math.max(...result.samples.map(s => s.bytes + s.compressedBytes))).toBeLessThanOrEqual(8192);
      expect(result.closed.map(s => s.bytes + s.compressedBytes)).toEqual([0, 0]);
      await testInfo.attach('bounded-cache-evidence', { body: JSON.stringify({ axes: result.axes, successfulBackgroundChunks: result.chunks.filter(e => e.background).length, successfulDemandChunks: result.chunks.filter(e => !e.background).length, injected500s: retryAttempts.size, fullCellChecks: result.checks.length, maxReaderCacheBytes: Math.max(...result.samples.map(s => s.bytes + s.compressedBytes)), evicted: result.evicted, closedBytes: result.closed.map(s => s.bytes + s.compressedBytes), limits: 'Reader chunk cache only, not browser/GPU/process peak memory; atomic replacements and metadata-last publication, not an arbitrary partially updated host.' }, null, 2), contentType: 'application/json' });
    } finally { await app.close(); await data.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
