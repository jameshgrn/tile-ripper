// The embedded viewer (?embed=1) in headless Chromium: the compact layout, controls=0, the light theme, and the
// postMessage contract between a host page and the viewer in its iframe (docs/embedding.md).
//
// The host page is a small page the test writes next to the synthetic stores, so it is served by the stores' server
// (http://127.0.0.1:<store port>) while the viewer is on the site's server (http://127.0.0.1:<site port>): another origin,
// as for a real embedder, so the origin rules are the real ones. (A page that Playwright fulfils itself or a made-up public
// name would be a "public" page, and Chrome refuses an iframe of a local address in one: Local Network Access.)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProjection } from '../maplibre/projection.js';
import { STORES, storedValue } from './stores.js';
import { expect, test as base } from './fixtures.js';
import { captureFrame, expectFrameMatchesStore } from './viewer-helpers.js';

// The fixtures fail a test on any console error. The test about a store that is not there is about a failure the
// browser itself reports as errors; it lists the ones it expects.
const test = base.extend({
  // A RegExp that the console errors a test expects match (an array would be read by Playwright as [value, options]).
  expectedErrors: [null, { option: true }],
  consoleErrors: [
    async ({ page, expectedErrors }, use) => {
      const errors = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`uncaught: ${error.stack || error.message}`));
      await use(errors);
      expect(
        errors.filter((error) => !expectedErrors?.test(error)),
        'the page logged errors',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

const STORE = 'u16_sharded';
const PROJECTION = createProjection('EPSG:32631');
const TRANSFORM = STORES[STORE].spec.transform;

/** The origin of the page that embeds the viewer. */
const hostOf = (servers) => servers.dataUrl;
/** Another origin that is not the host: the same server under its other loopback name. */
const strangerOf = (servers) => servers.dataUrl.replace('127.0.0.1', 'localhost');

/** The viewer URL with the embed parameters; `params` are added as they are (`origin` too: pass it as `origin: hostOf(servers)`). */
function viewerUrl(servers, storeUrl, params = {}) {
  const query = new URLSearchParams({ embed: '1', store: storeUrl, ...params });
  return `${servers.appUrl}/demo/index.html?${query}`;
}

/**
 * Open a page on `hostOrigin` (the host, unless a test says another) that embeds the viewer and records every message it
 * gets from it in `window.messages` ({origin, data}). `window.send(message)` posts a message to the iframe. Returns the
 * iframe's frame once its store is open.
 */
async function openHost(page, servers, stores, src, { hostOrigin = hostOf(servers), waitForStore = true } = {}) {
  await mkdir(path.join(stores.dir, 'embed-host'), { recursive: true });
  await writeFile(
    path.join(stores.dir, 'embed-host', 'host.html'),
    `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="v" src="${src.replaceAll('&', '&amp;')}" style="display:block;width:100vw;height:100vh;border:0"></iframe>
<script>
  window.messages = [];
  const frame = document.getElementById('v');
  window.addEventListener('message', (e) => { if (e.source === frame.contentWindow) window.messages.push({ origin: e.origin, data: e.data }); });
  window.send = (message) => frame.contentWindow.postMessage(message, ${JSON.stringify(new URL(src).origin)});
</script>`,
  );
  await page.goto(`${hostOrigin}/embed-host/host.html`);
  const frame = await waitForViewerFrame(page, servers);
  if (waitForStore) await frame.waitForFunction(() => window.chronozarr?.ready);
  return frame;
}

async function waitForViewerFrame(page, servers) {
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(`${servers.appUrl}/demo/`))).toBe(true);
  return page.frames().find((f) => f.url().startsWith(`${servers.appUrl}/demo/`));
}

/** What the host has received so far, optionally of one type. */
const received = (page, type = null) => page.evaluate((type) => window.messages.filter((m) => type === null || m.data.type === type), type);

/** The first message of `type` that matches `where` (field values compared as JSON), waiting for it. */
async function waitForMessage(page, type, where = {}) {
  const handle = await page.waitForFunction(
    ([type, where]) => window.messages.find((m) => m.data.type === type && Object.entries(where).every(([key, value]) => JSON.stringify(m.data[key]) === JSON.stringify(value)))?.data,
    [type, where],
  );
  return handle.jsonValue();
}

const send = (page, message) => page.evaluate((message) => window.send(message), message);

/** Click the centre of a level-0 pixel of the store in the iframe (the iframe fills the page). */
async function clickPixel(page, frame, X, Y) {
  const point = await frame.evaluate(
    ([X, Y]) => {
      const { canvas, camera } = window.chronozarr.viewer;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (((X + 0.5 - camera.cx) * camera.scale + canvas.width / 2) * rect.width) / canvas.width,
        y: rect.top + (((Y + 0.5 - camera.cy) * camera.scale + canvas.height / 2) * rect.height) / canvas.height,
      };
    },
    [X, Y],
  );
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.click(box.x + point.x, box.y + point.y);
}

/** The physical values of the store at a pixel and timestep, by band name (the bands of this store scale by 1e-4). */
function expectedValues(t, X, Y) {
  return Object.fromEntries(STORES[STORE].spec.bands.map((name, band) => [name, storedValue(STORE, t, band, Y, X) / 10000]));
}

// ---- layout ----

for (const width of [400, 900]) {
  test.describe(`${width} px wide`, () => {
    test.use({ viewport: { width, height: 700 } });

    test('embed layout: no catalog selector, no export, wordmark, inspector only after a click', async ({ page, servers, storeUrl }) => {
      const store = await storeUrl(STORE);
      // The full viewer on the same page size, to show the assertions below can fail: it has all of these.
      await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(store)}`);
      await page.waitForFunction(() => window.chronozarr?.ready);
      await expect(page.locator('#catalog-select'), 'the full viewer shows the catalog selector').toBeVisible();
      await expect(page.locator('#export-btn'), 'the full viewer shows export').toBeVisible();
      await expect(page.locator('.brand')).toBeVisible();
      await expect(page.locator('#embed-wordmark')).toBeHidden();

      servers.app.requests.length = 0;
      await page.goto(`${servers.appUrl}/demo/index.html?embed=1&store=${encodeURIComponent(store)}`);
      await page.waitForFunction(() => window.chronozarr?.ready);
      expect(await page.evaluate(() => window.chronozarr.ready), 'the store opened').toBeTruthy();

      await expect(page.locator('#catalog-select')).toBeHidden();
      await expect(page.locator('#export-btn')).toBeHidden();
      await expect(page.locator('#export-panel')).toBeHidden();
      await expect(page.locator('.brand')).toBeHidden();
      expect(servers.app.requests.filter((r) => r.path.endsWith('catalog.json')), 'an embed does not fetch the catalog').toEqual([]);

      const wordmark = page.locator('#embed-wordmark');
      await expect(wordmark).toBeVisible();
      await expect(wordmark).toHaveText('chronozarr');
      await expect(wordmark).toHaveAttribute('target', '_blank');
      await expect(wordmark).toHaveAttribute('rel', /noopener/);

      // The product control (buttons from 700 px, a select below) and the timeline stay.
      if (width >= 700) await expect(page.locator('#products button')).toHaveCount(6);
      else await expect(page.locator('#product-select')).toBeVisible();
      for (const id of ['play-btn', 'prev-btn', 'next-btn', 'time-label', 'timeline-track']) await expect(page.locator(`#${id}`), id).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll').toBe(true);

      // The inspector is closed, at 900 px too (the full viewer shows it as a side panel from 900 px); a click opens the drawer, Escape closes it.
      await expect(page.locator('#sidebar')).toBeHidden();
      await clickPixelOnPage(page, 50, 40);
      await expect(page.locator('#sidebar')).toBeVisible();
      await expect(page.locator('#sidebar')).toHaveClass(/open/);
      await expect(page.locator('#sidebar-content')).toContainText('50, 40');
      await page.keyboard.press('Escape');
      await expect(page.locator('#sidebar')).toBeHidden();
    });
  });
}

async function clickPixelOnPage(page, X, Y) {
  const point = await page.evaluate(
    ([X, Y]) => {
      const { canvas, camera } = window.chronozarr.viewer;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (((X + 0.5 - camera.cx) * camera.scale + canvas.width / 2) * rect.width) / canvas.width,
        y: rect.top + (((Y + 0.5 - camera.cy) * camera.scale + canvas.height / 2) * rect.height) / canvas.height,
      };
    },
    [X, Y],
  );
  await page.mouse.click(point.x, point.y);
}

test.describe('320 px wide', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const [name, params] of [['the embed', '?embed=1'], ['the full viewer', '?']]) {
    test(`${name} renders without horizontal scroll and keeps its timeline inside the window`, async ({ page, servers, storeUrl }) => {
      const store = await storeUrl(STORE);
      await page.goto(`${servers.appUrl}/demo/index.html${params}&store=${encodeURIComponent(store)}`);
      await page.waitForFunction(() => window.chronozarr?.ready);
      expect(await page.evaluate(() => window.chronozarr.ready)).toBeTruthy();
      const layout = await page.evaluate(() => {
        const inside = (id) => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, visible: rect.width > 0 && rect.height > 0, left: rect.left, right: rect.right, bottom: rect.bottom };
        };
        const canvas = document.getElementById('gl-canvas').getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          width: window.innerWidth,
          height: window.innerHeight,
          canvas: { width: canvas.width, height: canvas.height },
          controls: ['play-btn', 'prev-btn', 'next-btn', 'time-label', 'timeline-track', 'product-select'].map(inside),
        };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
      expect(layout.canvas.width, 'the canvas is as wide as the window').toBe(320);
      expect(layout.canvas.height, 'and has real height').toBeGreaterThan(250);
      for (const control of layout.controls) {
        expect(control.visible, `${control.id} is displayed`).toBe(true);
        expect(control.left, `${control.id} starts inside the window`).toBeGreaterThanOrEqual(0);
        expect(control.right, `${control.id} ends inside the window`).toBeLessThanOrEqual(layout.width + 0.5);
        expect(control.bottom, `${control.id} is above the bottom edge`).toBeLessThanOrEqual(layout.height + 0.5);
      }
    });
  }
});

test.describe('controls=0', () => {
  test.use({ viewport: { width: 800, height: 600 } });

  test('only the canvas and a thin time readout; a click is still reported and opens nothing', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { controls: '0', origin: hostOf(servers) }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);
    const hidden = ['nav', '#sidebar', '#click-hint', '#play-btn', '#prev-btn', '#next-btn', '#timeline-track', '.speed', '#export-btn', '#embed-wordmark', '#catalog-select'];
    for (const selector of hidden) await expect(frame.locator(selector), selector).toBeHidden();
    await expect(frame.locator('#time-label')).toBeVisible();
    await expect(frame.locator('#time-label')).toHaveText('2024-01-01');
    const sizes = await frame.evaluate(() => ({ bar: document.querySelector('.timeline-bar').getBoundingClientRect().height, canvas: document.getElementById('gl-canvas').getBoundingClientRect().height, window: window.innerHeight }));
    expect(sizes.bar, 'a thin strip').toBeLessThan(32);
    expect(sizes.canvas + sizes.bar, 'the canvas has the rest of the window').toBeGreaterThanOrEqual(sizes.window - 1);

    await clickPixel(page, frame, 50, 40);
    const click = await waitForMessage(page, 'chronozarr:click');
    expect(click.pixel).toEqual({ x: 50, y: 40 });
    await expect(frame.locator('#sidebar')).toBeHidden();
    expect(await frame.evaluate(() => document.getElementById('sidebar').classList.contains('open')), 'the drawer was not opened').toBe(false);
    expect(await frame.locator('#chart').count(), 'no chart of the pixel was started: it would load every timestep of the cell for nothing').toBe(0);
    await send(page, { v: 1, type: 'chronozarr:set', t: 2 });
    await expect(frame.locator('#time-label')).toHaveText('2024-01-03');
  });
});

// ---- theme ----

test.describe('theme', () => {
  test.use({ viewport: { width: 1000, height: 700 } });

  test('theme=light: the chrome is light, the canvas and what it draws do not change', async ({ page, servers, storeUrl }) => {
  const store = await storeUrl(STORE);
  const read = async (extra) => {
    await page.goto(`${servers.appUrl}/demo/index.html?embed=1&store=${encodeURIComponent(store)}${extra}`);
    await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0);
    const style = await page.evaluate(() => ({
      nav: getComputedStyle(document.querySelector('nav')).backgroundColor,
      timeline: getComputedStyle(document.querySelector('.timeline-bar')).backgroundColor,
      text: getComputedStyle(document.getElementById('time-label')).color,
      canvas: getComputedStyle(document.getElementById('gl-canvas')).backgroundColor,
      theme: document.documentElement.dataset.theme ?? null,
    }));
    return { style, frame: await captureFrame(page) };
  };
  const dark = await read('');
  const light = await read('&theme=light');
  expect(dark.style.theme).toBeNull();
  expect(light.style.theme).toBe('light');
  expect(dark.style.nav).toBe('rgb(17, 22, 32)');
  expect(light.style.nav).toBe('rgb(255, 255, 255)');
  expect(light.style.timeline).toBe('rgb(255, 255, 255)');
  expect(light.style.text, 'dark text on the light chrome').toBe('rgb(20, 26, 41)');
  expect(light.style.canvas, 'the canvas background is the same in both themes').toBe(dark.style.canvas);
  expect(light.frame.samples.map((s) => s.rgb), 'the pixels the GPU drew are identical').toEqual(dark.frame.samples.map((s) => s.rgb));
  expectFrameMatchesStore(light.frame, STORE, 0);
  });
});

// ---- the contract ----

test.describe('postMessage', () => {
  test.use({ viewport: { width: 900, height: 600 } });

  test('ready: the store, its times, bands, products and levels, and the state; get asks for it again', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    const ready = await waitForMessage(page, 'chronozarr:ready');
    expect(ready.v).toBe(1);
    expect(ready.store).toEqual({ url: store, name: STORE, crs: 'EPSG:32631' });
    expect(ready.times).toEqual(Array.from({ length: 6 }, (_, t) => `2024-01-${String(t + 1).padStart(2, '0')}T00:00:00Z`));
    expect(ready.bands.map((b) => [b.name, b.scale, b.units])).toEqual([['B02', 1e-4, null], ['B03', 1e-4, null], ['B04', 1e-4, null], ['B08', 1e-4, null]]);
    expect(ready.products.map((p) => [p.id, p.available])).toEqual([['true_color', true], ['false_color', true], ['ndvi', true], ['ndwi', true], ['water', true], ['band', true]]);
    expect(ready.levels).toEqual([{ lod: 0, width: 200, height: 200, resolution: 10 }, { lod: 1, width: 100, height: 100, resolution: 20 }]);
    expect(ready.state).toMatchObject({ t: 0, time: '2024-01-01T00:00:00Z', product: 'true_color', band: 'B02', playing: false });
    expect(ready.state.zoom).toBeGreaterThan(0);
    // The store centre: (100, 100) in level-0 pixels.
    const [x, y] = [TRANSFORM[2] + 100 * TRANSFORM[0], TRANSFORM[5] + 100 * TRANSFORM[4]];
    const [lon, lat] = PROJECTION.toLonLat(x, y);
    expect(ready.state.center.x).toBeCloseTo(x, 0);
    expect(ready.state.center.y).toBeCloseTo(y, 0);
    expect(ready.state.center.lon).toBeCloseTo(lon, 5);
    expect(ready.state.center.lat).toBeCloseTo(lat, 5);
    expect((await received(page, 'chronozarr:ready')).length).toBe(1);
    expect((await received(page)).every((m) => m.origin === servers.appUrl && m.data.v === 1), 'every message carries v: 1 and comes from the viewer origin').toBe(true);

    await send(page, { type: 'chronozarr:get' });
    await expect.poll(async () => (await received(page, 'chronozarr:ready')).length).toBe(2);
  });

  test('set changes the timestep and the viewer says so with chronozarr:time', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);

    await send(page, { v: 1, type: 'chronozarr:set', t: 3 });
    expect(await waitForMessage(page, 'chronozarr:time', { t: 3 })).toEqual({ v: 1, type: 'chronozarr:time', t: 3, time: '2024-01-04T00:00:00Z' });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 3);
    expectFrameMatchesStore(await captureFrame(frame), STORE, 3);
    await expect(frame.locator('#time-label')).toHaveText('2024-01-04');

    // A date picks the closest timestep.
    await send(page, { type: 'chronozarr:set', t: '2024-01-05T09:00:00Z' });
    expect((await waitForMessage(page, 'chronozarr:time', { t: 4 })).time).toBe('2024-01-05T00:00:00Z');

    // Stepping in the viewer is reported too.
    await frame.locator('#next-btn').click();
    expect((await waitForMessage(page, 'chronozarr:time', { t: 5 })).time).toBe('2024-01-06T00:00:00Z');
    expect((await received(page, 'chronozarr:time')).map((m) => m.data.t)).toEqual([3, 4, 5]);
  });

  test('set also changes the product, the band, the zoom and the centre; chronozarr:view reports the camera', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);

    await send(page, { type: 'chronozarr:set', product: 'band', band: 'B04' });
    await expect(frame.locator('#products button.active')).toHaveText('Single band');
    await expect(frame.locator('#band-select')).toHaveValue('2');

    const [lon, lat] = PROJECTION.toLonLat(TRANSFORM[2] + 150 * TRANSFORM[0], TRANSFORM[5] + 50 * TRANSFORM[4]);
    await send(page, { type: 'chronozarr:set', zoom: 2, center: { lon, lat } });
    const view = await waitForMessage(page, 'chronozarr:view', { zoom: 2 });
    expect(view.v).toBe(1);
    expect(view.center.lon).toBeCloseTo(lon, 5);
    expect(view.center.lat).toBeCloseTo(lat, 5);
    expect(view.center.x).toBeCloseTo(TRANSFORM[2] + 150 * TRANSFORM[0], 0);
    expect(view.center.y).toBeCloseTo(TRANSFORM[5] + 50 * TRANSFORM[4], 0);
    const camera = await frame.evaluate(() => ({ ...window.chronozarr.viewer.camera, zoom: window.chronozarr.viewer.zoom }));
    expect(camera.cx).toBeCloseTo(150, 1);
    expect(camera.cy).toBeCloseTo(50, 1);

    // The view message can be sent back as it is: x and y win over lon and lat.
    await send(page, { type: 'chronozarr:set', zoom: 4, center: { x: view.center.x, y: view.center.y, lon: 0, lat: 0 } });
    const again = await waitForMessage(page, 'chronozarr:view', { zoom: 4 });
    expect(again.center.x).toBeCloseTo(view.center.x, 0);
    expect(again.center.y).toBeCloseTo(view.center.y, 0);
  });

  test('playing and speed start and stop the movie', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);
    await send(page, { type: 'chronozarr:set', speed: 10, playing: true });
    await waitForMessage(page, 'chronozarr:time', { t: 2 });
    expect(await frame.evaluate(() => [window.chronozarr.viewer.speed, window.chronozarr.viewer.playback.playing])).toEqual([10, true]);
    await send(page, { type: 'chronozarr:set', playing: false });
    await expect.poll(() => frame.evaluate(() => window.chronozarr.viewer.playback.playing)).toBe(false);
    const stopped = (await received(page, 'chronozarr:time')).length;
    await page.waitForTimeout(400);
    expect((await received(page, 'chronozarr:time')).length, 'no more steps after the pause').toBe(stopped);
  });

  test('click reports the pixel, lon/lat, the shown timestep and the physical values of the store', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await send(page, { type: 'chronozarr:set', t: 3 });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 3);

    await clickPixel(page, frame, 50, 40);
    const click = await waitForMessage(page, 'chronozarr:click');
    expect(click.v).toBe(1);
    expect(click.pixel).toEqual({ x: 50, y: 40 });
    expect([click.t, click.time, click.level, click.valid]).toEqual([3, '2024-01-04T00:00:00Z', 0, true]);
    const [lon, lat] = PROJECTION.toLonLat(TRANSFORM[2] + 50.5 * TRANSFORM[0], TRANSFORM[5] + 40.5 * TRANSFORM[4]);
    expect(click.lon).toBeCloseTo(lon, 5);
    expect(click.lat).toBeCloseTo(lat, 5);
    const expected = expectedValues(3, 50, 40);
    expect(Object.keys(click.values)).toEqual(['B02', 'B03', 'B04', 'B08']);
    for (const [band, value] of Object.entries(expected)) expect(click.values[band], band).toBeCloseTo(value, 6);
    expect(Object.values(expected).every((value) => value > 0), 'the fixture has data at this pixel').toBe(true);
    // The inspector drawer opens as usual (the iframe is 900 px wide: the embed uses the drawer at every width).
    await expect(frame.locator('#sidebar')).toHaveClass(/open/);

    // The shown timestep, not the requested one, is what the values belong to.
    await send(page, { type: 'chronozarr:set', t: 1 });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 1);
    await clickPixel(page, frame, 120, 150);
    const second = await waitForMessage(page, 'chronozarr:click', { pixel: { x: 120, y: 150 } });
    expect([second.t, second.time]).toEqual([1, '2024-01-02T00:00:00Z']);
    for (const [band, value] of Object.entries(expectedValues(1, 120, 150))) expect(second.values[band], band).toBeCloseTo(value, 6);

    // A pixel at the store's nodata value is reported as invalid with no values.
    await clickPixel(page, frame, 2, 100);
    const empty = await waitForMessage(page, 'chronozarr:click', { pixel: { x: 2, y: 100 } });
    expect(empty.valid).toBe(false);
    expect(empty.values).toEqual({ B02: null, B03: null, B04: null, B08: null });
  });

  test('a message from another origin is ignored without side effects', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    // The viewer was told that another origin is its host, but the page that embeds it is this one.
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }), { hostOrigin: strangerOf(servers) });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);
    expect(await received(page), 'the viewer sends nothing to a page that is not its host').toEqual([]);

    for (const message of [{ v: 1, type: 'chronozarr:set', t: 3 }, { type: 'chronozarr:set', product: 'ndvi', playing: true }, { type: 'chronozarr:set', zoom: -5 }, { type: 'chronozarr:get' }]) await send(page, message);
    await page.waitForTimeout(400);
    expect(await frame.evaluate(() => ({ t: window.chronozarr.viewer.t, product: window.chronozarr.viewer.productIndex, playing: window.chronozarr.viewer.playback.playing })), 'nothing changed').toEqual({ t: 0, product: 0, playing: false });
    expect(await received(page), 'not even an error or a reply went back').toEqual([]);

    // The listener is alive: the same message from the real host window and origin is obeyed.
    await frame.evaluate((origin) => window.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'chronozarr:set', t: 3 }, origin, source: window.parent })), hostOf(servers));
    await expect.poll(() => frame.evaluate(() => window.chronozarr.viewer.t)).toBe(3);
    expect(await received(page), 'and its answer goes to the host origin only').toEqual([]);
  });

  test('without origin= the origin of the referrer is used', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store));
    await waitForMessage(page, 'chronozarr:ready');
    await send(page, { type: 'chronozarr:set', t: 2 });
    await waitForMessage(page, 'chronozarr:time', { t: 2 });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 2);
  });

  test('an invalid origin= turns the API off with a warning, and the viewer still works', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const warnings = [];
    page.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: '*' }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);
    await send(page, { type: 'chronozarr:set', t: 3 });
    await page.waitForTimeout(300);
    expect(await frame.evaluate(() => window.chronozarr.viewer.t)).toBe(0);
    expect(await received(page)).toEqual([]);
    await expect.poll(() => warnings.some((text) => /origin="\*" is not an http\(s\) origin/.test(text))).toBe(true);
  });

  test('a bad set is answered with chronozarr:error and changes nothing', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);

    await send(page, { type: 'chronozarr:set', t: 2, zoom: 'big' });
    const invalid = await waitForMessage(page, 'chronozarr:error', { code: 'bad_set' });
    expect(invalid.message).toMatch(/^zoom must be a number above 0/);

    await send(page, { type: 'chronozarr:set', t: 2, product: 'swir' });
    await expect.poll(async () => (await received(page, 'chronozarr:error')).length).toBe(2);
    expect((await received(page, 'chronozarr:error'))[1].data.message).toMatch(/"swir" is not available for this store; available: true_color, false_color, ndvi, ndwi, water, band/);

    await send(page, { v: 2, type: 'chronozarr:set', t: 2 });
    expect((await waitForMessage(page, 'chronozarr:error', { code: 'bad_message' })).message).toMatch(/v 2 is not supported/);

    await send(page, { type: 'chronozarr:set', t: 99 });
    await expect.poll(async () => (await received(page, 'chronozarr:error')).length).toBe(4);
    expect((await received(page, 'chronozarr:error'))[3].data.message).toMatch(/past the last timestep \(5\)/);

    expect(await frame.evaluate(() => window.chronozarr.viewer.t), 'the time of the first, otherwise fine, set was not applied').toBe(0);
    expect(await received(page, 'chronozarr:time')).toEqual([]);
  });

  test.describe('a store that is not there', () => {
    // The static server's 404 carries no CORS header, so the browser reports the failed read as a CORS error, and the reader its give-up.
    test.use({ expectedErrors: /Failed to load resource|blocked by CORS policy|request failed, giving up|loadStore\(.*\) failed/ });

    test('is reported with chronozarr:error, and the viewer does not fall back to another store', async ({ page, servers, stores }) => {
      servers.app.requests.length = 0;
      await openHost(page, servers, stores, viewerUrl(servers, `${servers.dataUrl}/no_such_store/`, { origin: hostOf(servers) }), { waitForStore: false });
      const error = await waitForMessage(page, 'chronozarr:error', { code: 'store_open_failed' });
      expect(error.message).toMatch(/^Could not open store: /);
      expect(await received(page, 'chronozarr:ready')).toEqual([]);
      expect(servers.app.requests.filter((r) => r.path.endsWith('catalog.json')), 'no catalog to fall back to').toEqual([]);
    });
  });
});

// ---- the demo page ----

test.describe('the demo host page (examples/embed.html)', () => {
  test.use({ viewport: { width: 1000, height: 900 } });

  test('its slider drives the viewer and its readout shows the values of a click', async ({ page, servers, storeUrl }) => {
    const store = await storeUrl(STORE);
    await page.goto(`${servers.appUrl}/examples/embed.html?store=${encodeURIComponent(store)}`);
    await expect(page.locator('#slider')).toBeEnabled();
    await expect(page.locator('#slider')).toHaveAttribute('max', '5');
    await expect(page.locator('#date')).toHaveText('2024-01-01');
    const frame = page.frames().find((f) => f.url().startsWith(`${servers.appUrl}/demo/`));
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 0);

    await page.locator('#slider').fill('3');
    await expect(page.locator('#date')).toHaveText('2024-01-04');
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 3);
    await expect(frame.locator('#time-label')).toHaveText('2024-01-04');
    // The viewer's own timeline moves the slider back.
    await frame.locator('#next-btn').click();
    await expect(page.locator('#slider')).toHaveValue('4');
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 4);

    await page.locator('#product').selectOption('ndvi');
    await expect(frame.locator('#products button.active')).toHaveText('NDVI');

    await clickPixel(page, frame, 50, 40);
    await expect(page.locator('#click')).toContainText('2024-01-05');
    await expect(page.locator('#click')).toContainText('50, 40');
    const expected = expectedValues(4, 50, 40);
    await expect(page.locator('#click dt')).toHaveText(['Time', 'Pixel', 'Lon, lat', 'B02', 'B03', 'B04', 'B08']);
    const shown = await page.locator('#click dd').allTextContents();
    expect(Number(shown[3])).toBeCloseTo(expected.B02, 5);
    expect(Number(shown[6])).toBeCloseTo(expected.B08, 4);
  });
});

// ---- URL parameters ----

test.describe('URL parameters', () => {
  test.use({ viewport: { width: 900, height: 600 } });

  test('the permalink view state still works in an embed, and the embed parameters survive the address bar updates', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers), theme: 'light', t: '2', p: 'ndvi', z: '2', c: '501000,3999000' }));
    const ready = await waitForMessage(page, 'chronozarr:ready');
    expect(ready.state).toMatchObject({ t: 2, product: 'ndvi', zoom: 2 });
    expect(ready.state.center.x).toBeCloseTo(501000, 0);
    expect(ready.state.center.y).toBeCloseTo(3999000, 0);
    await expect(frame.locator('#products button.active')).toHaveText('NDVI');
    expect(await frame.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    await send(page, { type: 'chronozarr:set', t: 4 });
    await expect
      .poll(async () => {
        const params = new URLSearchParams(await frame.evaluate(() => location.search));
        return Object.fromEntries(['embed', 'theme', 'origin', 'store', 't', 'p'].map((key) => [key, params.get(key)]));
      })
      .toEqual({ embed: '1', theme: 'light', origin: hostOf(servers), store, t: '4', p: 'ndvi' });
  });

  test('the wordmark opens the full viewer on the same store and view, without the embed parameters', async ({ page, servers, stores, storeUrl }) => {
    const store = await storeUrl(STORE);
    const frame = await openHost(page, servers, stores, viewerUrl(servers, store, { origin: hostOf(servers) }));
    await send(page, { type: 'chronozarr:set', t: 4, product: 'ndwi', zoom: 2, center: { x: 501000, y: 3999000 } });
    await frame.waitForFunction(() => window.chronozarr.viewer.paintedT === 4);
    const link = frame.locator('#embed-wordmark');
    await link.hover();
    const href = new URL(await link.getAttribute('href'));
    expect(`${href.origin}${href.pathname}`).toBe(`${servers.appUrl}/demo/index.html`);
    expect(Object.fromEntries(href.searchParams)).toEqual({ store, t: '4', p: 'ndwi', z: '2', c: '501000,3999000' });
  });
});

// ---- dragging on the timeline ----

test.describe('dragging on the timeline', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const [name, params] of [['the full viewer', ''], ['the embed', '&embed=1']]) {
    test(`${name}: a drag that starts on the track and drifts 200 px above it moves the timestep and selects no text`, async ({ page, servers, storeUrl }) => {
      const store = await storeUrl(STORE);
      await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(store)}${params}`);
      await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0);
      const track = await page.locator('#timeline-track').boundingBox();
      const y = track.y + track.height / 2;

      await page.mouse.move(track.x + 12, y);
      await page.mouse.down();
      // Right and up across the map and the inspector: where the page has text that a selection drag would take.
      await page.mouse.move(track.x + track.width * 0.45, y - 100, { steps: 8 });
      await page.mouse.move(track.x + track.width * 0.9, y - 200, { steps: 8 });
      const mid = await page.evaluate(() => ({ t: window.chronozarr.viewer.t, selected: window.getSelection().toString() }));
      await page.mouse.up();

      expect(mid.selected, 'no text is selected while the pointer is held above the control').toBe('');
      expect(mid.t, 'the timestep followed the pointer along the track, also above it').toBe(5);
      expect(await page.evaluate(() => window.getSelection().toString()), 'and none after the release').toBe('');

      // Scrubbing has ended with the button: moving the mouse now changes nothing.
      await page.mouse.move(track.x + 12, y - 150);
      expect(await page.evaluate(() => window.chronozarr.viewer.t)).toBe(5);
    });
  }

  test('a pan that starts on the map and drifts over the page text pans the map and selects no text', async ({ page, servers, storeUrl }) => {
    const store = await storeUrl(STORE);
    await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(store)}`);
    await page.waitForFunction(() => window.chronozarr?.viewer?.paintedT === 0);
    const canvas = await page.locator('#gl-canvas').boundingBox();
    const before = await page.evaluate(() => ({ ...window.chronozarr.viewer.camera }));

    await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.6);
    await page.mouse.down();
    // Past the map's right edge, over the inspector's text, and up into the header.
    await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.3, { steps: 8 });
    await page.mouse.move(canvas.x + canvas.width + 150, canvas.y + 20, { steps: 8 });
    const during = await page.evaluate(() => window.getSelection().toString());
    await page.mouse.up();

    expect(during, 'no text is selected by a pan').toBe('');
    const after = await page.evaluate(() => ({ ...window.chronozarr.viewer.camera }));
    expect(after.cx, 'the map followed the drag').toBeLessThan(before.cx);
    expect(after.cy).toBeGreaterThan(before.cy);

    // Double click still refits the view.
    await page.mouse.dblclick(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.5);
    await expect.poll(() => page.evaluate(() => window.chronozarr.viewer.camera.cx)).toBeCloseTo(before.cx, 3);
  });
});
