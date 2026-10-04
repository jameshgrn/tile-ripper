// Whole level-0 browser raster hashes, then completed renderer frames, on a local bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../../js/node_modules/playwright/index.mjs';
const root = process.argv[2] ?? 'http://127.0.0.1:8767/published/';
const expected = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
const rssSamples = [];
// Process command attribution includes this run's browser process and its children by unique profile.
const sampleRss = () => {
  const lines = execFileSync('ps', ['-axo', 'pid,ppid,rss,command'], { encoding: 'utf8' }).trim().split('\n').slice(1);
  const processes = lines.map(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], parent: +m[2], rss: +m[3] * 1024, command: m[4] }; }).filter(Boolean);
  const roots = processes.filter(p => p.command.includes('playwright_chromiumdev_profile-'));
  const ids = new Set(roots.map(p => p.pid));
  let changed = true;
  while (changed) { changed = false; for (const p of processes) if (ids.has(p.parent) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; } }
  rssSamples.push({ at: Date.now(), bytes: processes.filter(p => ids.has(p.pid)).reduce((s, p) => s + p.rss, 0), processes: ids.size });
};
const timer = setInterval(sampleRss, 100);
try {
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (['http:', 'https:'].includes(u.protocol) && u.origin !== new URL(root).origin) { external.push(u.href); return route.abort(); }
    return route.continue();
  });
  await page.goto(new URL('index.html', root).href);
  await page.waitForFunction(() => window.chronozarr?.ready);
  await page.evaluate(() => window.chronozarr.ready);
  const numeric = await page.evaluate(async ({ root, expected }) => {
    const { openStore } = await import(new URL('chronozarr/decoder.js', root).href);
    const store = await openStore(new URL('store', root).href);
    const [, B, H, W] = expected.shape;
    const digest = async a => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', a))).map(v => v.toString(16).padStart(2, '0')).join('');
    const frames = [];
    let peakReaderBytes = 0;
    for (let t = 0; t < expected.dates.length; t++) {
      const data = new Uint16Array(B * H * W), mask = new Uint8Array(H * W);
      for (let row = 0; row < Math.ceil(H / 512); row++) for (let col = 0; col < Math.ceil(W / 512); col++) {
        const [cell, cm] = await Promise.all([store.getCell(0, row, col, t), store.getMask(0, row, col, t)]);
        for (let y = 0; y < cell.height; y++) {
          const dst = (row * 512 + y) * W + col * 512;
          mask.set(cm.subarray(y * 512, y * 512 + cell.width), dst);
          for (let b = 0; b < B; b++) data.set(cell.data.subarray(b * 512 * 512 + y * 512, b * 512 * 512 + y * 512 + cell.width), b * H * W + dst);
        }
        peakReaderBytes = Math.max(peakReaderBytes, store.stats().cache.usedBytes);
      }
      frames.push({ t, data: await digest(data.buffer), mask: await digest(mask.buffer), cache: store.stats().cache });
    }
    const stats = store.stats();
    store.close();
    return { frames, peakReaderBytes, stats, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null };
  }, { root, expected });
  for (const frame of numeric.frames) {
    assert.equal(frame.data, expected.frame_sha256[frame.t]);
    assert.equal(frame.mask, expected.mask_sha256[frame.t]);
  }
  const rendered = [];
  for (let t = 0; t < expected.dates.length; t++) {
    await page.evaluate(t => window.chronozarr.viewer.goToTime(t), t);
    await page.waitForFunction(t => window.chronozarr.viewer.paintedT === t && window.chronozarr.viewer.renderNow().complete, t);
    rendered.push(await page.evaluate(() => ({ t: window.chronozarr.viewer.paintedT, cache: window.chronozarr.viewer.store.stats().cache })));
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  sampleRss();
  console.log(JSON.stringify({ numeric, rendered, browserVersion: browser.version(), browserErrors: errors, externalRequests: external, memory: { sampledWholeBrowserRssBytes: Math.max(...rssSamples.map(s => s.bytes)), sampleIntervalMs: 100, samples: rssSamples, attribution: 'All Playwright Chromium profile roots and descendants; includes browser/GPU/renderer processes; summed RSS can double count shared pages; sampled peak, not true peak. Run without other Playwright Chromium sessions.', limits: 'Numeric assembly temporarily retains one full frame; viewer and second reader run together. No isolated reader or GPU memory peak.' }, limits: 'Localhost and host caches; full level-0 decoded numeric fidelity, not shader/colour output hashes. Completed render waits do not prove absence of transient incomplete frames.' }, null, 2));
} finally { clearInterval(timer); await browser.close(); }
