# chronozarr

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

Browser and Node reader for [chronozarr](https://github.com/chronozarr/chronozarr) stores, plus a MapLibre GL JS custom layer that draws one.

A chronozarr store is a Zarr v3 time series of rasters with a multiscale pyramid, written one object per chunk by default and optionally sharded, laid out so a client reads one timestep of one map cell with one HTTP request (a plain `GET` of one chunk; for a sharded store one range read of a shard once its index is cached). The reader turns `(lod, row, col, t)` into a typed array: it caches shard indexes (sharded stores), decodes in a worker pool, prefetches a window of the time axis around the current timestep. It reads spec 0.3 stores ([spec](https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md)). The Python package `chronozarr` writes them.

The package is plain ES modules. There is no build step and no runtime dependency: zarrita and numcodecs are vendored (see [Licenses](#licenses)).

The v0.3 CDN URLs below become available after npm publication.

## Install

```bash
npm install chronozarr
```

```js
import { openStore } from 'chronozarr';
import { ChronozarrLayer } from 'chronozarr/maplibre';
```

Without a bundler, map the names in an import map. Either point them into `node_modules`:

```html
<script type="importmap">
{ "imports": {
  "chronozarr": "/node_modules/chronozarr/chronozarr/decoder.js",
  "chronozarr/maplibre": "/node_modules/chronozarr/maplibre/layer.js"
} }
</script>
```

or at a CDN:

```html
<script type="importmap">
{ "imports": {
  "chronozarr": "https://cdn.jsdelivr.net/npm/chronozarr@0.3.0/chronozarr/decoder.js",
  "chronozarr/maplibre": "https://cdn.jsdelivr.net/npm/chronozarr@0.3.0/maplibre/layer.js"
} }
</script>
```

| Import | Provides |
|---|---|
| `chronozarr` | `openStore(url, options)`, the `ChronoStore` it resolves to, and helpers (`applyDelta`, `chunkKey`, `scrubCost`, `windowOrder`, `samplePixelFrom`, `FetchError`) |
| `chronozarr/maplibre` | `ChronozarrLayer`, a MapLibre GL JS custom layer |
| `chronozarr/decode-worker` | the module worker that `openStore` starts for decoding; `import.meta.resolve('chronozarr/decode-worker')` finds it, for example for the `spawnWorker` option |

The decode worker is found relative to `decoder.js` (`new URL('./decode-worker.js', import.meta.url)`), so it loads wherever the package files are served from: `node_modules`, a static host, or a CDN. A cross-origin worker script, which is what a CDN is, is started through a same-origin `blob:` URL that imports it; the CDN has to send CORS headers (jsDelivr and unpkg do), and a page with a Content Security Policy needs `worker-src blob:`. In Node, and with `{ workers: 0 }`, chunks decode on the calling thread.

## Read a store

```js
import { openStore } from 'chronozarr';

const store = await openStore('https://your-host/v03-store');
console.log(store.times.length, store.bands, store.dtype, store.crs);
// 117 [ 'B02', 'B03', 'B04', 'B08' ] 'uint16' 'EPSG:32718'

const lod = store.levels.length - 1; // the coarsest pyramid level
const { data, chunkWidth, chunkHeight } = await store.getCell(lod, 0, 0, 5); // row 0, col 0, timestep 5
// data: typed array of the store's dtype, laid out [band][y][x] over the padded chunk. Read-only.
const stored = (band, y, x) => data[band * chunkHeight * chunkWidth + y * chunkWidth + x];
const { scale, offset } = store.attrs.bands[2]; // B04
console.log(stored(2, 100, 100) * scale + offset); // reflectance

store.close(); // aborts in-flight requests and releases the decode workers
```

`getCell` returns exact stored values at every timestep. `store.levels[lod]` describes each pyramid level (`gridRows`, `gridCols`, `width`, `height`, `resolution`, `transform`), `store.prefetch({ lod, cells, t })` fills the caches around a timestep, and `store.stats()` reports requests, bytes and cache hits. `openStore` options include `fetch`, `workers`, `totalBytes` (the joint cap for the decoded and compressed tiers, 1.5 GiB on machines reporting 8 GB or more, else 768 MiB), `horizonSteps`, `idleBytes` and `idleMs` (how far and how much idle prefetch reaches: 12 timesteps either side and 64 MiB per view by default), `maxRequests` and `retryDelaysMs`; they are documented in `chronozarr/decoder.js`. `prefetch` takes `playing: true` to extend to the whole loop and `masks: true` to fetch masks alongside chunks. The host must serve the store with byte ranges and CORS; `chronozarr doctor <url>` from the Python package checks that.

## Draw a store on a MapLibre map

```js
import * as maplibregl from 'maplibre-gl';
import { ChronozarrLayer } from 'chronozarr/maplibre';

const map = new maplibregl.Map({ container: 'map', style: 'https://demotiles.maplibre.org/style.json' });
const layer = new ChronozarrLayer({
  url: 'https://your-host/v03-store', // store root (holds zarr.json)
  product: 'true_color', // layer.products lists what the store's bands support
  t: 0, // timestep index
  prefetch: true, // fill the reader's caches around t in the background
});
layer.on('open', () => map.fitBounds(layer.bounds, { padding: 40, duration: 0 }));
layer.on('error', (event) => console.error(event.error));
map.on('load', () => map.addLayer(layer));

slider.oninput = () => layer.setTime(Number(slider.value)); // no refetch when the timestep is cached
button.onclick = () => layer.setProduct('ndvi');
map.on('click', async (event) => console.log(await layer.getValueAt(event.lngLat))); // stored values of the pixel
```

The layer needs MapLibre GL JS 5 or later (tested with 6.10.0), which is the host page's to load; it is not a dependency of this package. It draws on the Web Mercator projection and supports stores in UTM, EPSG:3857 and EPSG:4326. Options, events, limits and the level-of-detail rule are in [js/maplibre/README.md](https://github.com/chronozarr/chronozarr/blob/main/js/maplibre/README.md).

## Licenses

chronozarr is Apache-2.0 (`LICENSE`). Three MIT-licensed packages by Trevor Manz are vendored unmodified apart from a header comment, with their licenses beside them; each file's header records the package version and the SHA-256 of the published file.

| Path | Package | Version | License |
|---|---|---|---|
| `vendor/zarrita/` | [zarrita](https://github.com/manzt/zarrita.js) | 0.7.5 | MIT |
| `vendor/zarrita-storage/` | [@zarrita/storage](https://github.com/manzt/zarrita.js) | 0.2.0 | MIT |
| `vendor/numcodecs/` | [numcodecs](https://github.com/manzt/numcodecs.js) | 0.3.2 | MIT |

`vendor/numcodecs/blosc.js`, `lz4.js` and `zstd.js` embed WebAssembly builds of Blosc (with its bundled zlib and snappy), LZ4 and Zstandard. Those C libraries carry their own permissive upstream licenses (BSD-style, zlib), and numcodecs ships no separate notice for them.
