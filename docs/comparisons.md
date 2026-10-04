# Measured comparisons: zarr-layer, and one COG per date

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

The measurements below describe historical v0.2 artifacts, not current writer options. Convert those stores before opening them with v0.3 libraries.

> Historical benchmark: the results below were measured on sharded dataset revision `chronozarr-3` on 2026-10-01. The current demo catalog uses unsharded `chronozarr-4`; these suffixes are store-prefix revisions, not format versions. Historical results and procedures are retained as measured. See the README for the subsequent unsharded cold-open measurement.

For the matched three-date level-0 sample measured on 2026-10-03, see the
[retrieval comparison](../bench/adoption/README.md) and
[shared-renderer comparison](../bench/rendered/README.md). The latter checks exact
data, masks and rendered pixels; its controlled network profile is page-target
emulation with unobserved worker traffic, not a CDN experiment.

Two comparisons of a chronozarr store, measured on 2026-10-01 on one machine (Apple M3 Max, macOS, Node 24.16.0, Chromium 153 through Playwright 1.63.0 with the Metal GPU backend). All code, raw results and a lockfile are in `bench/`; the exact commands are in the last section.

- **A. CarbonPlan zarr-layer** (`@carbonplan/zarr-layer` 0.10.0, `maplibre-gl` 6.11.2): does it open the published Ucayali store, and how does it compare with the chronozarr viewer on the same store, view and level.
- **B. One COG per date**: the same imagery as 117 Cloud Optimized GeoTIFFs, against the chronozarr store, for the delivery cost of one session.

Store used in both: `https://data.tileripper.com/ucayali_santa_maria/chronozarr-3` (spec 0.2.0, `temporal.encoding: none`, 117 monthly timesteps, 4 bands B02/B03/B04/B08 as uint16, 4 levels in UTM 18S, level 0 = 2759 x 2765 px at 10 m, shards of (117, 4, 512, 512) holding one zstd-5 chunk of (1, 4, 512, 512) per timestep, consolidated metadata, `shard_bytes` hints). Level 1 is 1380 x 1383 px at 20 m, a 3 x 3 grid of cells. A local copy is `data/stores/ucayali_santa_maria/chronozarr-3` (6.45 GB).

## Summary

- **zarr-layer does not open the published store with its default options.** The map stays blank and zarr-layer says nothing: the `pixels_per_tile` key in `multiscales[0].datasets[*]` makes it treat the store as a global slippy-map pyramid, so it places a UTM raster on the whole Web Mercator world and finds no cell in view (section 1.1). It opens the store, drawn in the right place with the same values as the store, either with two constructor options (`crs`, `bounds`) or with `pixels_per_tile` removed from the store's attributes (section 1.2). The second was adopted as the format rule afterwards (note in section 1.2).
- **Per step the two renderers move the same chunks** (9 chunks, 10.7 MB for the 3 x 3 view). chronozarr's speculative prefetch adds 10 to 64 % bytes to a 20-step scrub (14 to 17 % on a saturated local link). On a saturated link with a stable origin (local 50 and 10 Mbit/s, remote 10 Mbit/s) a chronozarr step is 15 to 19 % slower than zarr-layer's (10.2 s against 8.6 s at 10 Mbit/s); on an idle local link the same prefetch makes steps cost 0 ms against zarr-layer's 80 ms. chronozarr never shows a frame that mixes timesteps; zarr-layer does for 22 to 70 % of the time of a stepped scrub.
- **Cold open on the published store is dominated by the CDN, not by either tool**: the nine shard-index reads at the end of 83 to 174 MB shard objects are cache misses that take 1.7 to 11 s, for both tools alike (section 1.5).
- **One COG per date costs about the same bytes (+0 to +4 % per phase, +1.4 % over the 20-step scrub, +3.2 % on disk) and differs in requests.** Per new date a COG needs a header read before its tiles; chronozarr reads a shard index once and then only chunks. With geotiff.js 3.0.5's defaults a header is 7 chained requests; with 64 KB blocks it is 1. The modelled delivery time of the 20-step scrub is 1.75x (defaults) or 1.13x (64 KB blocks) of chronozarr on a 90 Mbit/s, 112 ms link, 1.18x / 1.05x at 50 Mbit/s + 40 ms and 1.10x / 1.04x at 10 Mbit/s + 100 ms. On slow links both are bandwidth-bound and the formats converge.
- **Reading one pixel's complete history costs 164 MB in both layouts** (117 chunks or tiles of 512 x 512 x 4), because neither chunks along time; the two readers return identical values.
- Local wall-clock is 3 to 5x longer for the COGs, almost all of it JavaScript decoding of DEFLATE in geotiff.js (257 ms for one 9-tile view against 37 ms for the chronozarr reader, 116 ms for a ZSTD COG), not the format.

What these numbers do not show is in sections 1.7 and 2.4.

## 1. zarr-layer

### 1.1 Does it open the store? No, not as published

`bench/zarr-layer/page.html` + `page.js` (bundled by `build.mjs`) put a MapLibre map at a fixed view (centre of the AOI, zoom 12, 1500 x 1500 px, black background, no interaction) and add a `ZarrLayer` with `source` = the store URL, `variable: 'data'`, selector `{ band: ['B04','B03','B02'], time: { selected: 60, type: 'index' } }` and a natural-colour fragment shader. `bench/zarr-layer/probe.mjs` runs it headless and reports what zarr-layer made of the store (`describe()`), whether every visible region loaded, and where the drawn pixels are against where the store's `spatial:bbox` puts the AOI (columns 21 to 1479, rows 15 to 1485 at that zoom).

| configuration | result | what zarr-layer did |
|---|---|---|
| unmodified store, default options | **FAIL**, silently | level 3 chosen, 0 visible regions, 0 chunk requests (6 requests, 0.1 MB: `zarr.json`, three 404 probes for Zarr v2 files, two coordinate arrays). `describe()`: crs `EPSG:3857` with proj4 `EPSG:32718`, extent = the whole Web Mercator world (+-20,037,508 m), `latIsAscending: false`. No warning in the console. Blank map. |
| unmodified store, options `crs: 'EPSG:32718'`, `bounds: [485650, 9142230, 513240, 9169880]` | PASS | level 1, 9 of 9 regions, drawn box (21,15)-(1478,1484), 33 requests, 10.3 MB |
| store root attributes rewritten in the browser: `pixels_per_tile` removed | PASS | level 1, 9 of 9 regions, same box and the same 2,142,525 lit pixels as the options variant, 32 requests, 10.3 MB |

Raw output: `bench/results/zarr-layer-probe-as-published.json`, `...-crs-and-bounds-options.json`, `...-without-pixels-per-tile.json`.

**Cause.** In `@carbonplan/zarr-layer` 0.10.0 (`dist/index.js`), `_getPyramidMetadata` (line 1819 to 1822) reads `multiscales[0].datasets[0].pixels_per_tile` and sets `_usesSlippyMapDefaults = Boolean(pixelsPerTile)`, and takes the CRS from `datasets[0].crs` only to tell `EPSG:4326` from "everything else is `EPSG:3857`". `_loadSpatialMetadata` (line 1634) then returns early for a slippy-map store: extent is the whole world, rows run north to south, and the store's own `proj:code`, `spatial:transform` and `spatial:bbox` are never consulted. The `proj:code` is still applied as `proj4`, so the raster is stretched over a ±20,037,508 m square read as UTM metres, which projects nowhere near the view, and no region intersects the view. The same store with the key removed goes through the self-describing path (`proj:code` `EPSG:32718` is one of the UTM codes proj4 ships, `spatial:transform`/`spatial:bbox` give the extent), and the constructor options `crs` and `bounds` bypass the slippy-map branch the same way. Level order is not a problem: zarr-layer chooses the level by size, not by position in `datasets`, so the finest-first order of chronozarr works.

### 1.2 Change to the store attributes

**Status (2026-10-01).** Adopted, in a follow-up to the measurement below (which tested it without touching the published store). `spec/CHRONOZARR.md` sections 2.1, 3.4 and 13 now say writers MUST NOT write `pixels_per_tile` and readers MUST ignore it; the historical `spec_version` stayed 0.2.0. The writer (`encode`, `append` leaves an existing `multiscales` alone), the Python reader (the cell size is the chunk shape of the data array) and the validator (accepts a store with or without the key) follow it, and `chronozarr doctor` prints one info line for a remote store that still carries the key. Stores written earlier stay valid and open in zarr-layer with the `crs` and `bounds` options. The root `zarr.json` of `ucayali_santa_maria/chronozarr-3` and `ucayali_santa_maria/water-1` was rewritten locally without the key (the only difference from the published roots is the four removed keys per store); the published copies carry it until those two files are uploaded. The JS reader (`js/chronozarr/decoder.js` line 408) still rejects a `pixels_per_tile` that disagrees with the chunk shape, which is stricter than "readers MUST ignore it"; not changed here.

The text below is the proposal as measured.

Smallest change that makes zarr-layer 0.10.0 open the store without constructor options: in the root `zarr.json`, `attributes.multiscales[0].datasets[i]` for i = 0..3, delete `pixels_per_tile`:

```diff
 "multiscales": [{ "datasets": [
-  { "path": "0", "pixels_per_tile": 512, "crs": "EPSG:32718" },
+  { "path": "0", "crs": "EPSG:32718" },
-  { "path": "1", "pixels_per_tile": 512, "crs": "EPSG:32718" },
+  { "path": "1", "crs": "EPSG:32718" },
   ...
```

It occurs only there (the level groups and arrays carry no copy; the consolidated metadata does not repeat root attributes). Tested without touching the published store, by rewriting the root `zarr.json` in the browser (`--patch no-pixels-per-tile` of `probe.mjs`): the row above.

What the change touches in this repository, as found when it was measured (all of it except the JS reader has since been edited, see the status note):

- `spec/CHRONOZARR.md` section 2.1 (line 69: "Readers MUST take `cs` from `multiscales[0].datasets[].pixels_per_tile`") and section 3.4 (line 167: "`pixels_per_tile` equals `cs`"). The chunk size is also the inner `chunk_shape` of the `data` array's sharding codec, which every reader already parses.
- Python: `chronozarr validate` rejects an edited store (`multiscales[0].datasets[0]: missing required key 'pixels_per_tile'`, `src/chronozarr/schema.py` around lines 697 to 705; `schema.py` 1030 and 1138 and `decode.py` 77 use the value).
- The JS reader opens the edited store and reads a cell (`js/chronozarr/decoder.js:379` already treats the key as optional and only cross-checks it against the chunk shape).
- Claims that a `none` store opens in zarr-layer unchanged: `spec/CHRONOZARR.md` line 170 and section 12 (line 554); `README.md` line 11 and `docs/format-comparison.md` line 12 say the same with "not yet tested". They hold only with the constructor options or after this change.

Alternatives: the constructor options above (no store change; `zarrVersion: 3` additionally skips three sequential 404 probes for Zarr v2 files); an upstream change in zarr-layer so that `pixels_per_tile` only implies slippy-map defaults when the dataset CRS is `EPSG:4326` or `EPSG:3857` (not tested); the zarr-conventions `multiscales` layout form (not tested; the spec keeps the ndpyramid list form on purpose).

### 1.3 Values

With the options variant, `layer.queryData` at level `finest` for pixel (row 1388, col 1380) at 11 timesteps (0, 2, 3, 40, 41, 60, 80, 100, 101, 102, 116) returns the same 44 band values as a read straight from the Zarr arrays with no chronozarr code (`bench/results/zarr-layer-values.json`); the four values of timestep 0 are nodata (0 in the store), which zarr-layer leaves out as NaN.

### 1.4 Method of the comparison

- **View and level.** The whole AOI (3 x 3 cells of level 1) in a 1800 x 1700 px window at device pixel ratio 1, AOI 1457.6 px wide, centred. zarr-layer chooses level 1 by itself at map zoom 12 (every run reports level 1). chronozarr is pinned to level 1 (`viewer.loadStore(url, { lod: 1, viewSearch })`, `viewSearch` = `?t=40&z=<0.5283>&c=<AOI centre>`), which also switches off its coarse-first staging; its canvas (1500 x 1592) shows the whole AOI. `chronozarr.interactionBench` was not used because it opens at the viewer's own fit camera with the adaptive level and takes neither; the page script replays its scrub with the same probe events and the same `analyzeLatency` from `js/demo/perf.js`.
- **zarr-layer configuration.** Unmodified store; options `crs: 'EPSG:32718'`, `bounds`, `zarrVersion: 3`; one `setSelector` per step with `time` by index. A frame counts as complete when every visible region of the active level holds the current selector and has its textures uploaded (read from `layer.regionRenderer`'s region cache at each MapLibre render).
- **Open.** From the call that opens the store (`loadStore` / `map.addLayer`, both include reading the metadata) to the first frame that shows all 9 cells at level 1.
- **Scrub forward 20**, from timestep 40 (steps 41 to 60), in two modes. *Burst*: one input every 100 ms (chronozarr's `ArrowRight`, zarr-layer's `setSelector`), as in `interactionBench`; a step the tool skipped is satisfied by the later frame that shows a later step. *Paced*: the next input 100 ms after the frame of the previous step is complete, so every step is shown and its latency is the time to load and draw it.
- **Network.** A fresh Chromium per run (empty caches; HTTP cache also disabled over CDP). CDP `Network.emulateNetworkConditions` is applied after the page has loaded, so only the data requests are throttled (checked once with 10 MB range reads: 1.66 s at 50 Mbit/s and 8.1 s at 10 Mbit/s). Requests and bytes are counted from CDP events of the page, identically for both tools: `encodedDataLength` (headers and body) of finished requests, and the body bytes received so far for aborted ones, which is a lower bound of what crossed the wire. The count was checked against chronozarr's own reader statistics (19 requests, 10.03 MB against 19 and 10.04 MB at open; the reader counts only completed requests).
- **Two sources.** *remote*: the published store; `natural` is then the real link from this machine to Cloudflare (HTTP/2). *local*: the same files from this repository's range server (`js/support/static-server.js`, HTTP/1.1, so at most 6 connections per origin for either tool); `natural` is then unthrottled localhost, and CDP throttling defines the whole link. The local runs exist because the CDN adds stalls that are not the tools' (section 1.5).
- **Repetitions.** remote: natural 3, 50 Mbit/s 2, 10 Mbit/s 2 (natural and 50 Mbit/s after one unrecorded warm-up per tool); local: 3, 2, 2. The two tools and two modes are interleaved, the tool order alternates by repetition. Tables show the median and the range. The machine was shared (load average 10 to 20) and the remote link varied by an order of magnitude between probes (27 to 964 Mbit/s).

### 1.5 Results: the published store

#### Cold open, level 1, 9 cells: published store (data.tileripper.com)

Median over repetitions, range in parentheses. Burst and paced runs both open the store the same way and are pooled.

| link | tool | runs | time to first complete frame | of which until the shard-index reads are done | requests | MB |
|---|---|---|---|---|---|---|
| natural | chronozarr | 6 | 6.79 s (3.08 s-9.92 s) | 6.58 s (3.01 s-9.61 s) | 19 (19-19) | 10.0 (10.0-10.0) |
| natural | zarr-layer | 6 | 6.72 s (4.84 s-7.91 s) | 6.51 s (4.46 s-7.54 s) | 30 (30-30) | 10.0 (10.0-10.0) |
| 50Mbit-40ms | chronozarr | 4 | 7.69 s (3.76 s-10.1 s) | 7.42 s (3.38 s-9.85 s) | 19 (19-19) | 10.0 (10.0-10.0) |
| 50Mbit-40ms | zarr-layer | 4 | 5.76 s (3.04 s-6.80 s) | 5.49 s (2.22 s-6.52 s) | 30 (30-30) | 10.0 (10.0-10.0) |
| 10Mbit-100ms | chronozarr | 4 | 14.8 s (14.7 s-16.8 s) | 9.34 s (2.97 s-15.7 s) | 19 (19-19) | 10.0 (10.0-10.0) |
| 10Mbit-100ms | zarr-layer | 4 | 16.9 s (9.36 s-21.3 s) | 15.8 s (3.88 s-20.1 s) | 30 (30-30) | 10.0 (10.0-10.0) |

#### Scrub forward 20 timesteps, paced: published store (data.tileripper.com)

| link | tool | runs | requests | of which aborted | MB transferred | scrub duration | steps shown exactly | step latency median / p95 | time showing mixed-timestep frames | MB in the next 3 s |
|---|---|---|---|---|---|---|---|---|---|---|
| natural | chronozarr | 3 | 227 (219-235) | 36 (28-50) | 235 (234-235) | 14.6 s (10.5 s-16.3 s) | 20 (20-20) of 20 | 424 ms / 1.45 s | 0 ms (0 ms-0 ms) | 49 (29-59) |
| natural | zarr-layer | 3 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 17.2 s (16.6 s-19.6 s) | 20 (20-20) of 20 | 451 ms / 1.77 s | 9.71 s (9.42 s-12.7 s) | 0 (0-0) |
| 50Mbit-40ms | chronozarr | 2 | 257 (255-257) | 77 (75-77) | 297 (263-297) | 50.2 s (44.0 s-50.2 s) | 20 (20-20) of 20 | 2.12 s / 4.62 s | 0 ms (0 ms-0 ms) | 15 (15-15) |
| 50Mbit-40ms | zarr-layer | 2 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 65.1 s (38.9 s-65.1 s) | 20 (20-20) of 20 | 2.27 s / 7.70 s | 45.7 s (13.6 s-45.7 s) | 0 (0-0) |
| 10Mbit-100ms | chronozarr | 2 | 275 (273-275) | 94 (93-94) | 270 (269-270) | 207.9 s (207.8 s-207.9 s) | 20 (20-20) of 20 | 10.3 s / 12.2 s | 0 ms (0 ms-0 ms) | 3 (2-3) |
| 10Mbit-100ms | zarr-layer | 2 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 175.8 s (175.7 s-175.8 s) | 20 (20-20) of 20 | 8.64 s / 9.73 s | 59.2 s (56.7 s-59.2 s) | 0 (0-0) |

#### Scrub forward 20 timesteps, burst (one step every 100 ms): published store (data.tileripper.com)

| link | tool | runs | requests | of which aborted | MB transferred | scrub duration | steps shown exactly | step latency median / p95 | time showing mixed-timestep frames | MB in the next 3 s |
|---|---|---|---|---|---|---|---|---|---|---|
| natural | chronozarr | 3 | 192 (192-192) | 177 (175-177) | 11 (11-21) | 2.91 s (2.33 s-3.11 s) | 1 (1-1) of 20 | 2.01 s / 2.91 s | 0 ms (0 ms-0 ms) | 29 (16-52) |
| natural | zarr-layer | 3 | 180 (180-180) | 169 (169-171) | 28 (11-30) | 3.23 s (2.33 s-3.50 s) | 1 (1-1) of 20 | 2.33 s / 3.23 s | 661 ms (219 ms-1.11 s) | 0 (0-0) |
| 50Mbit-40ms | chronozarr | 2 | 192 (192-192) | 177 (177-177) | 22 (12-22) | 4.14 s (3.60 s-4.14 s) | 1 (1-1) of 20 | 3.24 s / 4.14 s | 0 ms (0 ms-0 ms) | 20 (20-20) |
| 50Mbit-40ms | zarr-layer | 2 | 180 (180-180) | 171 (171-171) | 19 (13-19) | 5.86 s (3.66 s-5.86 s) | 1 (1-1) of 20 | 4.96 s / 5.86 s | 2.40 s (377 ms-2.40 s) | 0 (0-0) |
| 10Mbit-100ms | chronozarr | 2 | 192 (192-192) | 177 (177-177) | 10 (10-10) | 10.3 s (10.2 s-10.3 s) | 1 (1-1) of 20 | 9.35 s / 10.3 s | 0 ms (0 ms-0 ms) | 6 (5-6) |
| 10Mbit-100ms | zarr-layer | 2 | 180 (180-180) | 171 (171-171) | 10 (10-10) | 10.2 s (10.2 s-10.2 s) | 1 (1-1) of 20 | 9.35 s / 10.2 s | 2.64 s (2.53 s-2.64 s) | 0 (0-0) |

Paced scrub: both tools show every step. zarr-layer transfers exactly the 180 chunks it needs (214 MB, 10.7 MB a step) and aborts nothing; chronozarr transfers 235 to 297 MB: speculative requests for later steps (28 to 94 of its 219 to 275 requests are aborted when the user moves on) and, on the faster links, data that keeps arriving after the last step (up to 59 MB in the next 3 s). The median step takes 0.42 s (chronozarr) against 0.45 s (zarr-layer) on the natural link, 2.1 against 2.3 s at 50 Mbit/s and 10.3 against 8.6 s at 10 Mbit/s, where the link is the limit (10.7 MB need 8.6 s) and chronozarr's prefetch is on it while the next step is requested. The remote runs at 50 Mbit/s vary with the CDN (zarr-layer's scrub took 38.9 s in one run and 65.1 s in the other). zarr-layer replaces the nine regions of a step one by one as their chunks arrive, so the canvas showed a mixture of old and new timestep for 9.7 s of its 17 s scrub (natural) and 59 s of 176 s (10 Mbit/s); chronozarr draws a step only when all nine cells are there (no mixed frame).

Burst scrub: neither tool keeps up with one step every 100 ms (a step is 9 chunk reads and at least one round trip). Both skip to the last step (1 of 20 shown exactly) and abort nearly every request (zarr-layer 169 to 171 of 180, chronozarr 175 to 177 of 192); the bytes that count are those of the final step plus what was already in flight (10 to 30 MB). From the first input to the last frame: 2.9 s (chronozarr) against 3.2 s (zarr-layer) on the natural link, 4.1 against 5.9 s at 50 Mbit/s, 10.3 against 10.2 s at 10 Mbit/s.

How the cold open divides: of the 6.8 s (natural link) both tools need, 6.5 to 6.6 s is the wait for the nine shard-index reads, the last request before any chunk can be asked for. Each is a 1,876-byte range read at the end of a shard object of 83 to 174 MB; at the CDN they are `cf-cache-status: MISS` and the body arrives 1.7 to 11 s after the headers (`curl` for one of them: 2.4, 4.5 and 5.2 s on a miss, 0.34 s on a hit). Both tools make the same nine reads, so the open times on the published store do not separate them; the spread is the CDN's. zarr-layer reads the shard sizes with 9 `HEAD` requests first and chronozarr takes them from the `shard_bytes` attribute, which is why it needs 19 requests at open and zarr-layer 30 (33 with its defaults).

This measurement is why the encoder default became unsharded (spec section 13): an unsharded store has no shard index and its largest object is one 1.8 MB chunk. The cold-open numbers for the unsharded layout will be measured on the live store after its upload; every number in this document is for the sharded `chronozarr-3` unless it says otherwise.

### 1.6 Results: the same files from the local range server

#### Cold open, level 1, 9 cells: same files, local range server

Median over repetitions, range in parentheses. Burst and paced runs both open the store the same way and are pooled.

| link | tool | runs | time to first complete frame | of which until the shard-index reads are done | requests | MB |
|---|---|---|---|---|---|---|
| natural | chronozarr | 6 | 101 ms (95 ms-108 ms) | 9 ms (9 ms-12 ms) | 19 (19-19) | 10.0 (10.0-10.0) |
| natural | zarr-layer | 6 | 127 ms (122 ms-130 ms) | 33 ms (30 ms-34 ms) | 30 (30-30) | 10.0 (10.0-10.0) |
| 50Mbit-40ms | chronozarr | 4 | 2.12 s (2.11 s-2.12 s) | 191 ms (190 ms-193 ms) | 19 (19-19) | 10.0 (10.0-10.0) |
| 50Mbit-40ms | zarr-layer | 4 | 1.89 s (1.89 s-1.89 s) | 287 ms (280 ms-288 ms) | 30 (30-30) | 10.0 (10.0-10.0) |
| 10Mbit-100ms | chronozarr | 4 | 9.69 s (9.69 s-9.69 s) | 476 ms (475 ms-477 ms) | 19 (19-19) | 10.0 (10.0-10.0) |
| 10Mbit-100ms | zarr-layer | 4 | 8.67 s (8.67 s-8.67 s) | 680 ms (678 ms-682 ms) | 30 (30-30) | 10.0 (10.0-10.0) |

#### Scrub forward 20 timesteps, paced: same files, local range server

| link | tool | runs | requests | of which aborted | MB transferred | scrub duration | steps shown exactly | step latency median / p95 | time showing mixed-timestep frames | MB in the next 3 s |
|---|---|---|---|---|---|---|---|---|---|---|
| natural | chronozarr | 3 | 305 (305-314) | 7 (3-11) | 351 (350-355) | 2.18 s (2.18 s-2.19 s) | 20 (20-20) of 20 | 0 ms / 4 ms | 0 ms (0 ms-0 ms) | 2 (1-2) |
| natural | zarr-layer | 3 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 3.79 s (3.78 s-3.85 s) | 20 (20-20) of 20 | 80 ms / 100 ms | 824 ms (805 ms-839 ms) | 0 (0-0) |
| 50Mbit-40ms | chronozarr | 2 | 250 (249-250) | 70 (68-70) | 250 (249-250) | 43.0 s (42.9 s-43.0 s) | 20 (20-20) of 20 | 2.03 s / 2.82 s | 0 ms (0 ms-0 ms) | 16 (16-16) |
| 50Mbit-40ms | zarr-layer | 2 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 37.6 s (37.6 s-37.6 s) | 20 (20-20) of 20 | 1.76 s / 1.98 s | 14.6 s (14.6 s-14.6 s) | 0 (0-0) |
| 10Mbit-100ms | chronozarr | 2 | 251 (251-251) | 71 (71-71) | 245 (244-245) | 204.7 s (204.2 s-204.7 s) | 20 (20-20) of 20 | 10.2 s / 14.1 s | 0 ms (0 ms-0 ms) | 4 (2-4) |
| 10Mbit-100ms | zarr-layer | 2 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 175.6 s (175.4 s-175.6 s) | 20 (20-20) of 20 | 8.63 s / 9.73 s | 72.6 s (72.5 s-72.6 s) | 0 (0-0) |

#### Scrub forward 20 timesteps, burst (one step every 100 ms): same files, local range server

| link | tool | runs | requests | of which aborted | MB transferred | scrub duration | steps shown exactly | step latency median / p95 | time showing mixed-timestep frames | MB in the next 3 s |
|---|---|---|---|---|---|---|---|---|---|---|
| natural | chronozarr | 3 | 306 (301-311) | 9 (7-10) | 346 (344-352) | 1.90 s (1.90 s-1.90 s) | 20 (20-20) of 20 | 0 ms / 53 ms | 0 ms (0 ms-0 ms) | 3 (2-3) |
| natural | zarr-layer | 3 | 180 (180-180) | 0 (0-0) | 214 (214-214) | 1.98 s (1.98 s-1.98 s) | 20 (20-20) of 20 | 79 ms / 84 ms | 863 ms (789 ms-900 ms) | 0 (0-0) |
| 50Mbit-40ms | chronozarr | 2 | 192 (192-192) | 177 (177-177) | 14 (14-14) | 3.62 s (3.61 s-3.62 s) | 1 (1-1) of 20 | 2.72 s / 3.62 s | 0 ms (0 ms-0 ms) | 17 (17-17) |
| 50Mbit-40ms | zarr-layer | 2 | 180 (180-180) | 171 (171-171) | 16 (16-16) | 3.60 s (3.59 s-3.60 s) | 1 (1-1) of 20 | 2.70 s / 3.60 s | 681 ms (680 ms-681 ms) | 0 (0-0) |
| 10Mbit-100ms | chronozarr | 2 | 192 (192-192) | 177 (177-177) | 10 (10-10) | 12.1 s (12.1 s-12.1 s) | 1 (1-1) of 20 | 11.2 s / 12.1 s | 0 ms (0 ms-0 ms) | 3 (3-3) |
| 10Mbit-100ms | zarr-layer | 2 | 180 (180-180) | 171 (171-171) | 10 (10-10) | 10.2 s (10.2 s-10.2 s) | 1 (1-1) of 20 | 9.30 s / 10.2 s | 3.42 s (3.41 s-3.42 s) | 0 (0-0) |

Paced scrub: zarr-layer transfers 214 MB exactly; chronozarr 245 MB at 10 Mbit/s (+14 %), 250 MB at 50 Mbit/s (+17 %) and 351 MB unthrottled (+64 %), where its prefetch fills what the link can carry. The median step is 2.03 s (chronozarr) against 1.76 s (zarr-layer) at 50 Mbit/s (+15 %), 10.2 against 8.63 s at 10 Mbit/s (+18 %), and 0 ms against 80 ms unthrottled, where chronozarr has already loaded the next steps. zarr-layer showed mixed-timestep frames for 0.8 s of 3.8 s unthrottled, 14.6 s of 37.6 s at 50 Mbit/s and 72.6 s of 175.6 s at 10 Mbit/s; chronozarr never did. Burst scrub: unthrottled both keep up (20 of 20 steps shown, 1.9 s against 2.0 s); at 50 and 10 Mbit/s both skip to the last step, as on the published store.

With the CDN out of the picture the open is transfer-bound (10 MB: 1.6 s at 50 Mbit/s, 8.0 s at 10 Mbit/s plus round trips). zarr-layer reaches its first complete frame 0.23 s (11 %) and 1.0 s (10 %) sooner than chronozarr at 50 and 10 Mbit/s and 26 ms later unthrottled. chronozarr's last byte arrives 0.01 s (50 Mbit/s) and 0.41 s (10 Mbit/s) after zarr-layer's (1.89 s against 1.90 s, 8.66 s against 9.08 s); the rest of the difference is what happens afterwards: chronozarr takes 0.07 s (unthrottled), 0.23 s and 0.61 s after the last byte to paint, zarr-layer 0.01 to 0.08 s. The sequential round trips before the chunk reads are 3 for chronozarr (`zarr.json`, shard index, chunk) and 5 for zarr-layer with `zarrVersion: 3` (`zarr.json`, the `band` and `time` coordinate arrays, `HEAD`, shard index, chunk; 8 with its defaults).

### 1.7 What the zarr-layer numbers show and do not show

They show the cost of a step at a fixed level for the two designs on this store: the same 9 chunk reads, and what each does around them (chronozarr: prefetch and whole frames; zarr-layer: nothing speculative, per-region replacement, abort and re-request on every new selector). They show that the viewer's speculation is a trade: it takes the idle link (steps cost nothing) and loses to a tool that fetches only what is on screen when the link is already full.

They do not show:

- anything about zarr-layer's design goals: arbitrary variables and dimensions, any CRS reprojected on the GPU to Web Mercator and globe projections, queries, other basemaps. chronozarr draws in the store's native projection in its own canvas and decodes a single dtype layout; the render cost of the two is not isolated and zarr-layer's reprojection is not charged to chronozarr.
- cold open of the published store (CDN-bound, same for both) or the CDN at all beyond the stalls above; one machine, one Chromium, one store.
- chronozarr's default behaviour: with the level pinned its coarse-first staging, adaptive movie level and playback buffering are off, as asked. The first frame a user sees with the viewer's defaults is earlier than the numbers here.
- zarr-layer with a debounced selector (its README advises one; the burst runs deliberately do not), with `renderingMode '2d'`, or with its decoded-chunk cache warm (all runs are cold).
- Bytes of aborted requests beyond what Chromium reported (data in flight when a stream is reset is not seen); the aborted counts are exact.

## 2. One COG per date

### 2.1 Method

- **Representations.** *chronozarr*: the local store, read with the chronozarr JS reader (`js/chronozarr/decoder.js`, `openStore(url, { workers: 0 })`, `getCell`; explicit reads only, no `prefetch`). *COG*: `uv run chronozarr export-cog ... --level 0` writes one `L0_<date>.tif` per timestep from the same decoded values: GDAL COG driver, **DEFLATE with predictor 2**, 512 x 512 tiles, pixel interleave, overviews at 2, 4 and 8 (AVERAGE) written by the same call, so no separate GDAL step was needed. 117 files, 6.66 GB (56.9 MB per date) against the store's 6.45 GB. Read with geotiff.js 3.0.5 in two configurations: `fromUrl(url)` (its defaults; no block cache) and `fromUrl(url, { blockSize: 65536, cacheSize: 400 })` (64 KB aligned blocks).
- **Serving.** Both over the same local range server (`js/support/static-server.js`), reached by Node's `fetch`. A recorder wraps `fetch` and logs method, range, status, body bytes, start and end time of every request, tagged with the phase and step it belongs to.
- **Session**, fixed level 1 with a 3 x 3 cell view (the whole level) except where noted, state kept from phase to phase (opened files, shard indexes, caches):

  | phase | what is read |
  |---|---|
  | open | date 40: metadata/header, then the 9 cells |
  | scrub forward 20 | dates 41 to 60, one after the other (each step waits for the previous) |
  | jump | date 100 |
  | playback | dates 61 to 80, pipelined (no step waits for another) |
  | zoom | an uncached 2 x 2 cell area of **level 0**, rows 2 to 3, columns 2 to 3, at date 80 |
  | pixel history | one L0 pixel (row 1388, col 1380) at all 117 dates |

- **Classification.** Requests are metadata (the store's root `zarr.json`), header (a COG read that ends before the file's first tile), index (a read of the last bytes of a shard, from `shard_bytes`) or pixel (the rest).
- **Delivery time.** `bench/cog/model.mjs`: each request waits for its dependencies, then one round trip, then shares the link equally with the other requests that are transferring (processor sharing), with at most `parallel` requests in flight: **6 for COG** (HTTP/1.1 connections per origin in a browser) and **12 for the chronozarr reader** (its own cap). 500 bytes of headers are added to each request. Dependencies are inferred from the recorded local timing: a request of the same file or shard that had finished when this one started is a dependency, so a header read chain stays a chain, and a chunk read waits for its shard index; a shard index waits for the store metadata. Sequential phases (open, scrub, jump, zoom) start each step when the previous one is done; pipelined phases (playback, pixel history) are limited only by dependencies and `parallel`. The model has tests (`bench/cog/model.test.mjs`; breaking the link sharing makes two of them fail). Links: 50 Mbit/s + 40 ms and 10 Mbit/s + 100 ms as given, and `natural` = the medians of three probe rounds (start, middle, end of the run) of 1-byte and 8 MB range reads against the published store: 90 Mbit/s and 112 ms, observed 27 to 964 Mbit/s and 27 to 454 ms. The natural numbers move with that probe; compare their ratios, not the seconds.
- **Wall-clock** is measured locally for each phase, median of 3 repetitions after one unrecorded warm-up (which warms the file cache); the three representations rotate in order. It includes decoding.
- **Equality.** The pixel history (117 timesteps x 4 bands, level 0) of both readers is compared with a reference read straight from the Zarr arrays with no chronozarr code (`bench/cog/pixel_reference.py`); the run fails if any value differs.

### 2.2 Tables

#### Requests and bytes

| phase | representation | header / index / metadata requests | header / index / metadata bytes | pixel requests | pixel bytes | total requests | total bytes |
|---|---|---|---|---|---|---|---|
| open | chronozarr | 10 | 55.9 kB | 9 | 10.0 MB | 19 | 10.0 MB |
| open | COG, geotiff.js defaults | 7 | 3.2 kB | 9 | 10.4 MB | 16 | 10.4 MB |
| open | COG, 64 KB blocks | 1 | 65.5 kB | 1 | 10.5 MB | 2 | 10.6 MB |
| scrub forward 20 | chronozarr | 0 | 0.0 kB | 180 | 214 MB | 180 | 214 MB |
| scrub forward 20 | COG, geotiff.js defaults | 140 | 64.8 kB | 180 | 217 MB | 320 | 217 MB |
| scrub forward 20 | COG, 64 KB blocks | 20 | 1.3 MB | 20 | 218 MB | 40 | 220 MB |
| jump to a distant date | chronozarr | 0 | 0.0 kB | 9 | 10.0 MB | 9 | 10.0 MB |
| jump to a distant date | COG, geotiff.js defaults | 7 | 3.2 kB | 9 | 10.4 MB | 16 | 10.4 MB |
| jump to a distant date | COG, 64 KB blocks | 1 | 65.5 kB | 1 | 10.5 MB | 2 | 10.6 MB |
| playback, 20 consecutive dates | chronozarr | 0 | 0.0 kB | 180 | 204 MB | 180 | 204 MB |
| playback, 20 consecutive dates | COG, geotiff.js defaults | 140 | 64.8 kB | 180 | 211 MB | 320 | 211 MB |
| playback, 20 consecutive dates | COG, 64 KB blocks | 20 | 1.3 MB | 20 | 212 MB | 40 | 214 MB |
| zoom to 4 uncached cells, next finer level | chronozarr | 4 | 7.5 kB | 4 | 5.6 MB | 8 | 5.6 MB |
| zoom to 4 uncached cells, next finer level | COG, geotiff.js defaults | 8 | 0.0 kB | 4 | 5.7 MB | 12 | 5.7 MB |
| zoom to 4 uncached cells, next finer level | COG, 64 KB blocks | 0 | 0.0 kB | 4 | 5.8 MB | 4 | 5.8 MB |
| one pixel, complete history | chronozarr | 0 | 0.0 kB | 116 | 164 MB | 116 | 164 MB |
| one pixel, complete history | COG, geotiff.js defaults | 682 | 0.2 MB | 117 | 164 MB | 799 | 164 MB |
| one pixel, complete history | COG, 64 KB blocks | 75 | 4.9 MB | 116 | 170 MB | 191 | 175 MB |

#### Delivery time from the recorded requests

Links: natural = 90 Mbit/s, 112 ms; 50Mbit-40ms = 50 Mbit/s, 40 ms; 10Mbit-100ms = 10 Mbit/s, 100 ms (natural: medians of 3 probe rounds to the published store, observed 27 to 964 Mbit/s and 27 to 454 ms). Parallel requests: COG 6, chronozarr reader 12. 500 bytes of headers per request.

**natural** (90 Mbit/s, 112 ms). Time, and in parentheses the ratio to chronozarr:

| phase | chronozarr | COG, geotiff.js defaults | COG, 64 KB blocks |
|---|---|---|---|
| open | 1.23 s | 1.82 s (1.48x) | 1.16 s (0.95x) |
| scrub forward 20 | 21.2 s | 37.2 s (1.75x) | 24.0 s (1.13x) |
| jump to a distant date | 999 ms | 1.82 s (1.83x) | 1.16 s (1.16x) |
| playback, 20 consecutive dates | 18.2 s | 21.5 s (1.18x) | 19.3 s (1.06x) |
| zoom to 4 uncached cells, next finer level | 719 ms | 842 ms (1.17x) | 631 ms (0.88x) |
| one pixel, complete history | 14.7 s | 23.6 s (1.60x) | 16.1 s (1.09x) |

**50Mbit-40ms** (50 Mbit/s, 40 ms). Time, and in parentheses the ratio to chronozarr:

| phase | chronozarr | COG, geotiff.js defaults | COG, 64 KB blocks |
|---|---|---|---|
| open | 1.73 s | 1.99 s (1.15x) | 1.77 s (1.02x) |
| scrub forward 20 | 35.0 s | 41.2 s (1.18x) | 36.8 s (1.05x) |
| jump to a distant date | 1.64 s | 1.99 s (1.22x) | 1.77 s (1.08x) |
| playback, 20 consecutive dates | 32.6 s | 34.1 s (1.05x) | 34.3 s (1.05x) |
| zoom to 4 uncached cells, next finer level | 971 ms | 1.03 s (1.06x) | 974 ms (1.00x) |
| one pixel, complete history | 26.3 s | 27.5 s (1.04x) | 28.1 s (1.07x) |

**10Mbit-100ms** (10 Mbit/s, 100 ms). Time, and in parentheses the ratio to chronozarr:

| phase | chronozarr | COG, geotiff.js defaults | COG, 64 KB blocks |
|---|---|---|---|
| open | 8.33 s | 9.14 s (1.10x) | 8.64 s (1.04x) |
| scrub forward 20 | 173.0 s | 189.9 s (1.10x) | 179.8 s (1.04x) |
| jump to a distant date | 8.08 s | 9.15 s (1.13x) | 8.64 s (1.07x) |
| playback, 20 consecutive dates | 163.0 s | 169.8 s (1.04x) | 171.2 s (1.05x) |
| zoom to 4 uncached cells, next finer level | 4.65 s | 4.86 s (1.04x) | 4.77 s (1.02x) |
| one pixel, complete history | 131.6 s | 133.1 s (1.01x) | 140.3 s (1.07x) |

#### Per step (sequential phases): median step time

| phase | natural: chronozarr | natural: COG, geotiff.js defaults | natural: COG, 64 KB blocks | 50Mbit-40ms: chronozarr | 50Mbit-40ms: COG, geotiff.js defaults | 50Mbit-40ms: COG, 64 KB blocks | 10Mbit-100ms: chronozarr | 10Mbit-100ms: COG, geotiff.js defaults | 10Mbit-100ms: COG, 64 KB blocks |
|---|---|---|---|---|---|---|---|---|---|
| scrub forward 20 | 1.06 s | 1.87 s | 1.20 s | 1.74 s | 2.07 s | 1.84 s | 8.61 s | 9.53 s | 9.01 s |

#### Wall-clock on this machine, local range server (median over repetitions; includes decoding)

| phase | chronozarr | COG, geotiff.js defaults | COG, 64 KB blocks | COG, geotiff.js defaults / chronozarr | COG, 64 KB blocks / chronozarr |
|---|---|---|---|---|---|
| open | 69 ms | 284 ms | 291 ms | 4.12x | 4.22x |
| scrub forward 20 | 1.13 s | 5.58 s | 5.87 s | 4.95x | 5.21x |
| jump to a distant date | 58 ms | 275 ms | 285 ms | 4.74x | 4.91x |
| playback, 20 consecutive dates | 1.15 s | 5.45 s | 5.41 s | 4.73x | 4.70x |
| zoom to 4 uncached cells, next finer level | 33 ms | 144 ms | 147 ms | 4.32x | 4.39x |
| one pixel, complete history | 881 ms | 2.97 s | 2.95 s | 3.38x | 3.35x |

#### Checks

- Pixel history (117 timesteps x 4 bands, level 0): identical to `bench/results/pixel-reference-L0-r1388-c1380.json` for both readers: true.
- Level 1 of 2019-09-01T00:00:00Z (COG overview 1382 x 1379, store level 1383 x 1380), 7623112 values compared: 3.43 % identical, 9.99 % within 1, mean absolute difference 36.6207, maximum 5935.
- Bytes on disk: store 6.45 GB; 117 COGs 6.66 GB (56.9 MB per date).

Per-phase requests are identical across repetitions for every representation (fingerprints in the JSON). The pixel-history phase of the 64 KB-block configuration reads 4.9 MB of header blocks (64 KB for each of 75 files not opened before) and a few percent extra pixel bytes from block alignment.

### 2.3 Codec and decode checks

One date (2016-05-01, `bench/results/codec-sizes-2016-05.json`), bytes to deliver all four levels of it:

| representation | bytes |
|---|---|
| chronozarr store, zstd 5 chunks (from the shard indexes) | 56,852,283 |
| COG as exported (DEFLATE, predictor 2) | 57,876,521 (+1.8 %) |
| COG, ZSTD 5, predictor 2 | 53,843,180 (-5.3 %) |
| COG, ZSTD 5, no predictor | 62,225,767 (+9.5 %) |

The store's chunks are band-planar; a pixel-interleaved COG compresses worse with zstd unless the predictor is on. Decoding the 9-cell view of level 1 with the bytes already in memory (`bench/results/decode-bench-2016-05.json`, median of 7): COG DEFLATE + predictor in geotiff.js (pako) 257 ms; COG ZSTD + predictor in geotiff.js (WASM) 116 ms; chronozarr reader (WASM zstd, one thread) 37 ms. That is the wall-clock gap in the table: 20 steps x 257 ms is 5.1 s of the 5.6 s measured.

Overview equivalence (date 2019-09-01, level 1): the COG overview is 1382 x 1379 px, the store's level 1 is 1383 x 1380; the store's level 1 is exactly the floor of the 2 x 2 block mean of level 0 over the 1382 x 1379 complete blocks (checked), GDAL resamples by 2765/1382 = 2.0007 for an odd size, so the two grids drift apart by up to one source pixel at the far edge. 3.4 % of the 7.6 million values are identical, 10 % are within 1, the mean absolute difference is 36.6 DN on a mean of 1126 (mean difference 22 DN in the first 50 columns, 50 DN in the last), the maximum 5935. The overviews have the same ground footprint and resolution; they are not the same pixels.

### 2.4 What these numbers show and do not show

They show, for imagery that is the same at level 0 (one pixel's history over all 117 dates identical in both readers and the Zarr reference; the whole COG level 0 equals the store's for the one date checked, 2019-09-01), at compression equal to within 2 % for the date checked, and with equivalent but not identical overviews:

- bytes are not the difference (+0 to +4 % per phase for the exported COGs, +1.4 % over the 20-step scrub, +3.2 % on disk); requests and their dependencies are. A new COG costs a header first: 7 chained reads with geotiff.js defaults, 1 (64 KB) with blocks. chronozarr pays a shard index once per shard (9 at open, 4 at zoom), then only chunks.
- the gap in delivery time is a latency effect and closes as the link becomes bandwidth-bound: scrub forward 20 is 1.75x / 1.13x (defaults / 64 KB blocks) at the natural link, 1.18x / 1.05x at 50 Mbit/s + 40 ms, 1.10x / 1.04x at 10 Mbit/s + 100 ms; pixel history 1.60x / 1.09x, 1.04x / 1.07x, 1.01x / 1.07x. Blocks cost bytes where reads are small: the pixel-history phase reads 175 MB instead of 164 MB.
- reading a pixel's history needs the whole 512 x 512 x 4 tile of every date in both layouts (164 MB for 116 or 117 reads); neither is a time-series format. A layout chunked along time would make that one small read.
- local wall-clock is decoder-bound (section 2.3).

They do not show:

- anything about a real CDN or the browser: both are served by a local HTTP/1.1 server to Node. Request count matters differently behind HTTP/2 or HTTP/3, TLS and slow start, and edge caches treat 117 files of 57 MB and a few shard objects of up to 174 MB differently; section 1.5 found 2 to 11 s for a shard-tail read on a cache miss, which one COG per date does not have (its header read is 3 to 64 KB at the start of a 57 MB file). This comparison does not measure that, and it would count against the shard layout.
- a COG reader better than geotiff.js's two configurations. A COG client that reads the header in one request and then exactly the tiles would sit between the two columns on requests and below both on bytes; the floor per new date is two sequential round trips (header, tiles) against one for chronozarr with its index cached.
- other COG layouts (ZSTD with predictor is 7 % smaller than the exported files; band-sequential; larger tiles), imagery with more or fewer dates (headers matter more for daily data), writing or appending, or the ecosystem: GDAL and QGIS read COGs natively and chronozarr needs its readers or `export-cog`.
- the model's assumptions: one bottleneck link shared equally, no slow start, dependencies inferred from local timing, 500 bytes of headers per request, `natural` taken from a probe that varied by an order of magnitude.

## 3. Commands

Everything from the repository root unless noted. `bench/.npmrc` keeps `min-release-age=7` (every locked package is at least 7.1 days old: the youngest, `maplibre-gl` 6.11.2, was 7.16 days old when installed).

```bash
# setup
cd bench && npm ci && node zarr-layer/build.mjs && cd ..

# A. compatibility
cd bench
node zarr-layer/probe.mjs --out results/zarr-layer-probe-as-published.json
node zarr-layer/probe.mjs --extra '{"crs":"EPSG:32718","bounds":[485650,9142230,513240,9169880]}' --out results/zarr-layer-probe-crs-and-bounds-options.json
node zarr-layer/probe.mjs --patch no-pixels-per-tile --out results/zarr-layer-probe-without-pixels-per-tile.json
node zarr-layer/values.mjs

# A. comparison (tool order alternates; --warmup adds an unrecorded run of each tool first)
node zarr-layer/run-all.mjs --source remote --profile natural --reps 3 --warmup
node zarr-layer/run-all.mjs --source remote --profile 50Mbit-40ms --reps 2 --warmup
node zarr-layer/run-all.mjs --source remote --profile 10Mbit-100ms --reps 2
node zarr-layer/run-all.mjs --source local --profile natural --reps 3
node zarr-layer/run-all.mjs --source local --profile 50Mbit-40ms --reps 2
node zarr-layer/run-all.mjs --source local --profile 10Mbit-100ms --reps 2
node zarr-layer/summarize.mjs            # the tables of sections 1.5 and 1.6
cd ..

# B. data
uv run chronozarr export-cog data/stores/ucayali_santa_maria/chronozarr-3 data/cogs/ucayali_santa_maria --level 0
uv run python bench/cog/pixel_reference.py data/stores/ucayali_santa_maria/chronozarr-3 0 1388 1380 bench/results/pixel-reference-L0-r1388-c1380.json
uv run python bench/cog/codec_sizes.py data/stores/ucayali_santa_maria/chronozarr-3 data/cogs/ucayali_santa_maria/L0_2016-05-01.tif 2 data/cogs-variants/2016-05 bench/results/codec-sizes-2016-05.json

# B. session, tables, decode, model tests
cd bench
node cog/session.mjs --reps 3            # writes results/cog-vs-chronozarr.json
node cog/report.mjs                      # the tables of section 2.2
node cog/decode-bench.mjs 2 7 > results/decode-bench-2016-05.json
node --test cog/model.test.mjs
```

Files: `bench/package.json`, `bench/package-lock.json`, `bench/.npmrc`, `bench/.gitignore`; `bench/lib/harness.mjs` (server, browser, CDP throttling and accounting); `bench/zarr-layer/{page.html,page.js,build.mjs,probe.mjs,values.mjs,compare.mjs,run-all.mjs,summarize.mjs}`; `bench/cog/{session.mjs,recorder.mjs,model.mjs,model.test.mjs,report.mjs,decode-bench.mjs,pixel_reference.py,codec_sizes.py}`; raw results in `bench/results/*.json`. `data/cogs/` and `data/cogs-variants/` are under the ignored `data/`.
