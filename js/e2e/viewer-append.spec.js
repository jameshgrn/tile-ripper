import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures.js';
import { buildSyntheticStore, sourceValue } from '../support/synthetic-store.js';

for (const sharded of [false, true]) {
  test(`a live viewer keeps old dates valid during append and sees new dates on reopen (${sharded ? 'sharded' : 'unsharded'})`, async ({ page, servers, stores }) => {
    const name = `append-${sharded}`;
    const spec = { nBand: 1, height: 40, width: 33, chunk: 32, sharded, shardTime: 4, specVersion: '0.3.0', shardBytes: sharded, bands: ['wse'] };
    const publish = async nTime => {
      const files = buildSyntheticStore({ ...spec, nTime }).files;
      // Publish the root last, as the append writer does.
      const keys = [...files.keys()].sort((a, b) => Number(a === '/zarr.json') - Number(b === '/zarr.json'));
      for (const key of keys) {
        const file = path.join(stores.dir, name, key);
        await mkdir(path.dirname(file), { recursive: true });
        // Object hosting replaces a completed upload atomically; avoid exposing
        // a truncated local file to the viewer's concurrent prefetch.
        await writeFile(`${file}.upload`, files.get(key));
        await rename(`${file}.upload`, file);
      }
    };
    await publish(6);
    const url = `${servers.dataUrl}/${name}/`;
    await page.goto(`${servers.appUrl}/demo/index.html?store=${encodeURIComponent(url)}`);
    await page.waitForFunction(() => window.chronozarr?.viewer.paintedT >= 0 && window.chronozarr.viewer.renderNow().complete);
    await page.evaluate(() => { window.oldAppendStore = window.chronozarr.viewer.store; });
    await publish(7);
    expect(await page.evaluate(() => window.oldAppendStore.times.length)).toBe(6);
    await expect(page.locator('#timeline-track .timeline-tick')).toHaveCount(6);
    await page.evaluate(() => window.chronozarr.viewer.goToTime(5));
    await page.waitForFunction(() => window.chronozarr.viewer.paintedT === 5 && window.chronozarr.viewer.renderNow().complete);
    const oldValue = await page.evaluate(async () => (await window.oldAppendStore.getCell(0, 0, 0, 5)).data[5 * 32 + 7]);
    expect(oldValue).toBe(sourceValue(5, 0, 5, 7));
    await page.evaluate(async url => { await window.chronozarr.viewer.loadStore(url); }, url);
    expect(await page.evaluate(() => window.chronozarr.viewer.store.times.length)).toBe(7);
    await expect(page.locator('#timeline-track .timeline-tick')).toHaveCount(7);
    await page.evaluate(() => window.chronozarr.viewer.goToTime(6));
    await page.waitForFunction(() => window.chronozarr.viewer.paintedT === 6 && window.chronozarr.viewer.renderNow().complete);
    expect(await page.evaluate(async () => (await window.chronozarr.viewer.store.getCell(0, 0, 0, 6)).data[5 * 32 + 7])).toBe(sourceValue(6, 0, 5, 7));
    expect(await page.evaluate(() => window.oldAppendStore.cacheInfo().bytes + window.oldAppendStore.cacheInfo().compressedBytes)).toBe(0);
  });
}
