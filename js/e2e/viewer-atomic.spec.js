// Frames are always whole. Resolution may drop, completeness never does: while the cells of a timestep arrive one
// by one over a slow store, the canvas shows the last whole frame (or a whole frame of a coarser level), never some
// cells of the new timestep next to cells of the old one.
//
// The store is a 3 x 3 grid of cells at level 0 where each timestep is one flat colour, different from every other
// timestep's, so a frame can be checked from nine pixels, one in each cell: they must all have the colour of the
// timestep the frame claims to show. Every response of the store is delayed by a different amount, so the cells of
// a timestep arrive staggered.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSyntheticStore } from '../support/synthetic-store.js';
import { expect, test } from './fixtures.js';

const N_TIME = 8;
const SIZE = 384;
const CHUNK = 128;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The colour of the whole frame of timestep t: RGB bytes, at least 24 apart from the colour of any other timestep. */
const colorOf = (t) => [40 + 24 * t, 220 - 24 * t, 60 + 30 * (t % 4)];

const SPEC = {
  nTime: N_TIME,
  nBand: 3,
  height: SIZE,
  width: SIZE,
  chunk: CHUNK,
  sharded: true,
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
const delayFor = (url) => 150 + ([...url].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 9973, 7) % 300);

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

test.describe('whole frames over a slow store', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page, servers, stores }) => {
    await writeAtomicStore(stores.dir);
    await page.route(`${servers.dataUrl}/**`, async (route) => {
      await sleep(delayFor(route.request().url()));
      await route.continue();
    });
  });

  test('scrubbing: every painted frame is whole, the marker shows loading, and the last frame is the complete one', async ({ page, servers }) => {
    await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(`${servers.dataUrl}/atomic/`)}`);
    await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0, null, { timeout: 30_000 });
    await page.evaluate(installRecorder);

    // Seven steps, 90 ms apart: much faster than the store delivers the nine cells of a timestep.
    for (let step = 1; step < N_TIME; step++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(90);
    }
    await page.waitForFunction((last) => window.chronozarr.viewer.paintedT === last, N_TIME - 1, { timeout: 45_000 });
    const { frames, sawLoading } = await page.evaluate(() => window.__recorded);

    expect(frames.length, 'frames painted during the scrub').toBeGreaterThan(0);
    expectWholeFrames(frames);
    expect(sawLoading, 'the timeline marker showed its loading state while the requested frame was incomplete').toBe(true);
    expect(await page.locator('.timeline-tick.loading').count(), 'and not any more once the frame is complete').toBe(0);
    const last = frames.at(-1);
    expect([last.t, last.lod, last.kind], 'the last frame is the complete frame of the last timestep at the level asked for').toEqual([N_TIME - 1, 0, 'target']);
    expect(await page.evaluate(() => window.chronozarr.viewer.frameStats.kept >= 0), 'the viewer counts the frames it kept back').toBe(true);
  });

  test('playback: it buffers with an indicator before it starts, and every frame it shows is whole', async ({ page, servers }) => {
    await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(`${servers.dataUrl}/atomic/`)}`);
    await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0, null, { timeout: 30_000 });
    await page.evaluate(installRecorder);

    await page.keyboard.press('Space');
    await expect(page.locator('#play-btn'), 'the button shows that playback is waiting for frames').toHaveClass(/buffering/);
    await expect(page.locator('#buffer-hint')).toContainText('buffering');
    const stepsWhileBuffering = await page.evaluate(() => window.chronozarr.viewer.playback.stats.steps);
    expect(stepsWhileBuffering, 'no frame is shown before the buffer is full').toBe(0);

    await page.waitForFunction(() => window.chronozarr.viewer.playback.stats.steps >= 4, null, { timeout: 45_000 });
    await expect(page.locator('#play-btn'), 'the indicator is gone once it plays').not.toHaveClass(/buffering/);
    await page.keyboard.press('Space');
    const { frames } = await page.evaluate(() => window.__recorded);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expectWholeFrames(frames);
  });
});
