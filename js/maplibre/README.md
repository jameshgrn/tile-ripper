# chronozarr on MapLibre

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

`ChronozarrLayer` draws a chronozarr store on a MapLibre GL JS map as a custom layer. It opens the store with
`js/chronozarr/decoder.js`, picks the pyramid level from the map zoom, uploads the raw chunks of the visible cells
as integer (or float) textures, and runs the product band math in the
fragment shader. Each cell is a small mesh whose vertices were projected from the store's CRS to Web Mercator, so
the raster lands on the basemap with no resampling step. No dependencies: MapLibre is the host page's.

Demo: `js/maplibre/index.html` (the live Ucayali store over MapLibre's demo tiles, with a time slider, product
buttons, opacity and a click readout). Serve the repository root and open `/js/maplibre/index.html`, for example
`uv run python -m http.server 8000`. The page loads MapLibre GL JS **6.10.0** (published 2026-09-15) from
cdn.jsdelivr.net through an import map, which is its only external script, plus the matching stylesheet. The layer
reads `defaultProjectionData.mainMatrix`, a float64 mercator-to-clip matrix that MapLibre passes from version 5 on; it was
tested with 6.10.0 only, and reports an error if the matrix is missing.

## Integration

```js
import * as maplibregl from 'maplibre-gl';
import { ChronozarrLayer } from './js/maplibre/layer.js';

const map = new maplibregl.Map({ container: 'map', style: 'https://demotiles.maplibre.org/style.json' });
const layer = new ChronozarrLayer({
  url: 'https://your-host/v03-store', // store root (holds zarr.json)
  product: 'true_color', // see layer.products; 'band' shows one band
  t: 0, // timestep index
  prefetch: true, // fill the reader's caches around t in the background (default false)
});
layer.on('open', () => map.fitBounds(layer.bounds, { padding: 40, duration: 0 }));
layer.on('error', (event) => console.error(event.error));
map.on('load', () => map.addLayer(layer)); // optional second argument: the layer to draw below

slider.oninput = () => layer.setTime(Number(slider.value)); // no refetch when the timestep is cached
button.onclick = () => layer.setProduct('ndvi');
map.on('click', async (e) => console.log(await layer.getValueAt(e.lngLat))); // stored values of the pixel
// layer.setOpacity(0.6); layer.remove() frees the GPU objects, workers and in-flight requests.
```

## API

`new ChronozarrLayer(options)`: `url` (required), `id` (`'chronozarr'`), `product` (`'true_color'`), `band` (index or
name, for the `'band'` product), `t` (0), `opacity` (1), `prefetch` (false), `meshDivisions` (8), `gpuBudgetBytes` (256 MiB),
`lodBias` (0.5), `stretchLo`, `range`, `storeOptions` (passed to `openStore`: `fetch`, `workers`, `decodedBytes`, ...).

| | |
|---|---|
| `setTime(t)` | Show timestep `t` (integer index into `layer.times`). Throws `RangeError` outside the axis. |
| `setProduct(id, band?)` | `true_color`, `false_color`, `ndvi`, `ndwi`, `water`, `band`; throws if the store lacks the bands. |
| `setOpacity(o)` | 0 to 1. |
| `getValueAt(lngLat)` | Promise of `{t, time, col, row, lngLat, x, y, valid, bands: [{name, units, reflectance, stored, value}], ndvi, ndwi, isWater}` from the finest level (exact stored values), or `null` outside the footprint. `lngLat` is `{lng, lat}` or `[lng, lat]`. Fetches the level-0 chunks if they are not cached. |
| `on(type, fn)` / `off` | `open` (store metadata read; `layer.times`, `layer.bounds`, `layer.products` are valid), `loading` (the view needs data), `ready` (everything the view needs is on the GPU; fires again after each pan, zoom or time change that had to wait), `error` (`event.error`; the layer keeps running). `on` returns an unsubscribe function. |
| `remove()` | Removes the layer from the map and releases GPU buffers, textures and the program, aborts in-flight requests and releases the decode workers (the reader ends an idle worker pool after 30 s). The layer cannot be re-added. |
| `opened`, `store`, `times`, `bounds`, `bandNames`, `products`, `t`, `product`, `opacity`, `lod`, `stats` | State. `stats` counts GPU slots, uploads, evictions, meshes, pending loads. |

A time change never refetches what the reader has cached: the GPU pool keeps recently shown chunks, and the reader
cache (`layer.store`) holds decoded chunks. While a new timestep loads, the previous one stays on screen. With
`prefetch: true` the reader also fills its caches in the background (`store.prefetch`: nearest timesteps first, within
its cache and speculative-bandwidth budgets), which is what makes scrubbing a whole time series smooth; it can move
hundreds of MB (the demo moved 260 MB in 40 s for a 4-cell view of the Ucayali store).

Stores written to spec v0.3 work as they are: `uint8`, `uint16`, `int16` and `float32` true stored data, per-band `scale` and `offset`, `nodata` or a validity `mask`. The product colors
are `PRODUCT_GLSL` from `js/shared/products-glsl.js`, the same shader code as the viewer, and `displayMode` decides
between the tone-mapped reflectance look and a linear stretch (an 8-bit RGB store is shown as stored; other single
bands get the 2nd to 98th percentile of the valid values on screen, or `range: [min, max]` in physical units).

## Limits

- **One projection per store.** The store's CRS is fixed; the layer supports WGS84 UTM (EPSG:326zz and 327zz), EPSG:3857
  and EPSG:4326 and throws naming the supported set for anything else. A store that crosses the antimeridian or a
  UTM zone boundary is out of scope. The store must declare its level-0 `transform`.
- **Mercator maps only.** In globe projection the layer draws nothing and emits an `error` once.
- **LOD selection rule.** Level = `clamp(floor(log2(1 / p) + lodBias), 0, levels - 1)` with
  `p = mercatorPerTexel0 * 512 * 2^zoom`, the size of a level-0 texel in CSS pixels at the store's centre (UTM scale
  and mercator stretch included). `lodBias` 0.5 picks the level whose texels are closest to one CSS pixel; 0 is the
  spec's reader rule (largest level whose texels are no bigger than a pixel); negative values pick finer levels
  (crisper on high-density screens, more data). The level comes from the map centre's zoom, so a pitched view
  undersamples its far half and loads more cells. Zooming in past level 0 magnifies texels; nothing is interpolated
  (values are exact, edges are square).
- **Footprint.** Coarse levels are padded to whole texels; the layer draws only the part inside the level-0 footprint,
  so the outline does not move when the level changes.
- **Memory budget.** GPU: `gpuBudgetBytes` (default 256 MiB) sets the texture pool, in slots of one chunk
  (`n_band * chunk^2 * bytes`; 2 MiB for 4 bands of uint16 at 512 px, so 128 slots); a cell on screen needs one data slot, plus one per chunk of a mask. A view that needs more cells than the available
  slots draws the cells nearest the centre and emits an `error`. Uploads are capped at 16 MiB per frame. CPU: the reader
  caches (`storeOptions.totalBytes`, 1.5 GiB on machines reporting 8 GB or more and 768 MiB below, shared by the decoded and compressed tiers) are separate and are what make
  a warm time change a zero-request operation; `prefetch` fills them within those budgets.
- **Precision.** Vertex positions are float32 offsets from each mesh's centre, the matrix is composed in float64: the
  error is under 0.01 px at zoom 22. Adjacent cells share edge vertices to 1e-11 of the world.
- **Mesh.** 8 x 8 quads per cell (`meshDivisions`): the warp error over a 512 px cell of a 10 m UTM store is below
  0.01 px at zoom 22. A store with much larger cells (kilometres per pixel) needs more divisions.
- Stand-ins: while a cell loads, the layer paints the last timestep shown there, else the same area from a coarser
  level that is already loaded. The first view fetches the coarsest level's cells first and the level the zoom asks for
  after them: on a 3 MB/s link with 120 ms latency (Ucayali, 4 cells at level 0, 12 MB) the first pixels appear after
  2.5 s instead of 5.5 s, and the full-detail view is ready after 7.6 s instead of 5.8 s. On a fast link neither differs.

## Checking alignment

`verify/` holds the check used to validate the placement against pyproj (not MapLibre's own tiles: the demo tiles have
no linework near the Ucayali store). `truth.py` writes pyproj positions of the store outline and of texel boundaries;
`align.js` runs in the demo page and compares them with what the GPU drew, from screenshots taken with the layer at
opacity 1 and 0. Results for the Ucayali store, Chromium on an M-series Mac, 1280 x 800, bearing 0 unless noted:

| Check | Result |
|---|---|
| Footprint outline, zoom 9.5 (level 3), 11 (2), 12.5 (0), 15.5 (0), plus bearing 30, pitch 45, bearing -50 with pitch 40 | pixels drawn outside the pyproj outline: 0 to 8 per view, none more than 0.001 px beyond it; of about 400 unlit pixels per view sampled evenly within 8 px inside the outline, every one is a nodata gap at level 0 |
| Interior texel boundaries, levels 0 to 3 at about 4 px per texel | 60 to 84 boundaries per level (wherever neighbouring texels differ), all within 0.496 px of pyproj (0.5 px is the limit of pixel-centre sampling), mean offset below 0.03 px, no stray boundaries |
| Colors vs `js/demo/viewer.js`, same store, timestep and texel | 20 of 20 texel and product pairs identical in 8 bits (NDVI, NDWI, water, true and false color) |

Steps: `uv run --with pyproj python3 js/maplibre/verify/truth.py --epsg 32718 --x0 485650 --y0 9169880 --res 10 --width 2759 --height 2765 > truth.json`;
open the demo page, hide its panel, add `verify/align.js` as a script, `jumpTo` a view, take a screenshot with
`layer.setOpacity(1)` and another with `setOpacity(0)`, and pass them with `truth.outline` to `__align.mask`.
