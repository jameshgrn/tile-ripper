// Install a real tarball outside the checkout, copy the viewer, and exercise it over HTTP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.js';
import { buildSyntheticStore } from './synthetic-store.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'chronozarr-package-'));
let server, browser;
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: packageRoot, encoding: 'utf8' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed[0].filename)], { cwd: temporary, stdio: 'pipe' });
  const cli = path.join(temporary, 'node_modules/.bin/chronozarr-viewer');
  const output = path.join(temporary, 'published');
  execFileSync(cli, [output, '--store', './store'], { cwd: temporary });
  assert.throws(() => execFileSync(cli, [output], { stdio: 'pipe' }), 'existing output refused');
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'demo/catalog.json'), 'utf8')), []);
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e', "const {openStore}=await import('chronozarr'); if(typeof openStore!=='function') throw Error('missing reader')"], { cwd: temporary });
  assert.equal(imported.length, 0);
  const files = buildSyntheticStore({ nTime: 3, nBand: 4, height: 64, width: 64, chunk: 64, sharded: false, consolidated: true, bands: ['B02', 'B03', 'B04', 'B08'] }).files;
  for (const [key, bytes] of files) {
    const file = path.join(output, 'store', key.replace(/^\//, ''));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  server = await startStaticServer(temporary);
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== server.url) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${server.url}/published/index.html`);
  await page.waitForFunction(() => window.chronozarr?.viewer?.renderNow().complete);
  await page.locator('#next-btn').click();
  await page.waitForFunction(() => window.chronozarr.viewer.paintedT === 1 && window.chronozarr.viewer.renderNow().complete);
  await page.locator('#gl-canvas').click();
  await page.waitForFunction(() => document.querySelector('#sidebar-content').textContent.includes('Stored value'));
  await page.goto(`${server.url}/published/demo/index.html?store=${encodeURIComponent('../store')}&embed=1`);
  await page.waitForFunction(() => window.chronozarr?.viewer?.renderNow().complete);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await page.goto(`${server.url}/published/demo/index.html`);
  await page.waitForFunction(() => document.querySelector('#error-title').textContent === 'No store selected');
  assert.deepEqual(external, []);
  const report = { packageFiles: packed[0].entryCount, packageBytes: packed[0].size, node: process.version, independentInstall: true, readerImport: true, overwriteRefused: true, subpathRendering: true, timeControl: true, pixelInspector: true, embedRendering: true, missingStoreError: true, externalRequests: external.length, browserErrors: errors.length };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
