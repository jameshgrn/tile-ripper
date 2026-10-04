import { expect, test } from './fixtures.js';
import { STORES, storedValue } from './stores.js';
import { captureFrame, clickStorePixel, expectFrameMatchesStore, openViewer, readProductButtons, readSidebar, waitForPaintedTime } from './viewer-helpers.js';

const isoDate = (t) => `2024-01-0${t + 1}`;

/** What the sidebar shows for a pixel of a Sentinel-2 style store (bands B02 B03 B04 B08, stored / 10000). */
function expectedSidebar(storeName, t, X, Y) {
  const stored = [0, 1, 2, 3].map((band) => storedValue(storeName, t, band, Y, X));
  const [blue, green, red, nir] = stored.map((v) => v / 10000);
  const ndvi = (nir - red) / (nir + red);
  const ndwi = (green - nir) / (green + nir);
  return {
    Location: [['Time', isoDate(t)], ['Pixel (x, y)', `${X}, ${Y}`], ['Level', '0 (full resolution)']],
    Indices: [['NDVI', ndvi.toFixed(3)], ['NDWI', ndwi.toFixed(3)], ['Water', ndwi > 0 ? 'Detected' : 'None']],
    Reflectance: [['B02', blue.toFixed(4)], ['B03', green.toFixed(4)], ['B04', red.toFixed(4)], ['B08', nir.toFixed(4)]],
    'Stored value': [['B02', String(stored[0])], ['B03', String(stored[1])], ['B04', String(stored[2])], ['B08', String(stored[3])]],
  };
}

async function clickAndExpectSidebar(page, storeName, t, X, Y) {
  await clickStorePixel(page, X, Y);
  await expect(page.locator('#sidebar-content')).toContainText(`${X}, ${Y}`);
  const sidebar = await readSidebar(page);
  const expected = expectedSidebar(storeName, t, X, Y);
  for (const [section, rows] of Object.entries(expected)) expect(sidebar[section], `sidebar section "${section}" at t=${t}, pixel (${X}, ${Y})`).toEqual(rows);
}

for (const storeName of ['u16_sharded', 'u16_plain']) {
  test(`${storeName}: first paint, three scrub steps, a click, and the GPU frame equals the CPU render`, async ({ page, servers, storeUrl }) => {
    const nTime = STORES[storeName].spec.nTime;
    const timings = await openViewer(page, servers, await storeUrl(storeName));
    expect(timings.firstPaintMs).toBeGreaterThan(0);
    expect(Number.isFinite(timings.openMs)).toBe(true);
    await expect(page.locator('#time-label')).toHaveText(isoDate(0));
    expect(await page.evaluate(() => ({ steps: window.chronozarr.viewer.store.times.length, ...window.chronozarr.viewer.store.levels[0] }))).toMatchObject({ steps: nTime, width: 200, height: 200 });

    // First paint: t = 0 contains true stored values.
    expect(await page.evaluate(() => window.chronozarr.viewer.paintedT)).toBe(0);
    expectFrameMatchesStore(await captureFrame(page), storeName, 0);

    await clickAndExpectSidebar(page, storeName, 0, 50, 40);

    // Scrub three steps with the next button, arrow key and timeline click.
    await page.locator('#next-btn').click();
    await waitForPaintedTime(page, 1);
    await expect(page.locator('#time-label')).toHaveText(isoDate(1));
    expectFrameMatchesStore(await captureFrame(page), storeName, 1);

    await page.keyboard.press('ArrowRight');
    await waitForPaintedTime(page, 2);
    await expect(page.locator('#time-label')).toHaveText(isoDate(2));
    expectFrameMatchesStore(await captureFrame(page), storeName, 2);
    await clickAndExpectSidebar(page, storeName, 2, 150, 120);

    const tick = await page.locator('.timeline-tick').nth(3).boundingBox();
    await page.mouse.click(tick.x + tick.width / 2, tick.y + tick.height / 2);
    await waitForPaintedTime(page, 3);
    await expect(page.locator('#time-label')).toHaveText(isoDate(3));
    await expect(page.locator('.timeline-tick.active')).toHaveCount(1);
    expect(await page.locator('.timeline-tick').evaluateAll((ticks) => ticks.findIndex((el) => el.classList.contains('active')))).toBe(3);
    expectFrameMatchesStore(await captureFrame(page), storeName, 3);
  });
}

// The four data types the texture pool holds, each with the product buttons its bands allow.
for (const storeName of ['u8_rgb', 'u16_sharded', 'i16_band', 'f32_band']) {
  const { dtype, enabledProducts } = STORES[storeName];
  test(`${dtype} (${storeName}): renders every enabled product without errors and enables only the products its bands allow`, async ({ page, servers, storeUrl }) => {
    await openViewer(page, servers, await storeUrl(storeName));
    expect(await page.evaluate(() => window.chronozarr.viewer.dtype)).toBe(dtype);

    const buttons = await readProductButtons(page);
    expect(buttons.filter(([, enabled]) => enabled).map(([name]) => name), 'enabled product buttons').toEqual(enabledProducts);
    expect(buttons.filter(([, , active]) => active).map(([name]) => name), 'the first enabled product is shown').toEqual([enabledProducts[0]]);

    // Every enabled product on the first frame, then one more timestep (true stored values).
    for (const name of enabledProducts) {
      await page.locator('#products button', { hasText: new RegExp(`^${name}$`) }).click();
      await expect(page.locator('#products button.active')).toHaveText(name);
      expectFrameMatchesStore(await captureFrame(page), storeName, 0);
    }
    await page.keyboard.press('ArrowRight');
    await waitForPaintedTime(page, 1);
    expectFrameMatchesStore(await captureFrame(page), storeName, 1);
  });
}
