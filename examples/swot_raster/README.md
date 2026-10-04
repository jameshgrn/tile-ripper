# Local SWOT raster fidelity demo

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

`demo.ipynb` opens a small store in the notebook player and in leafmap MapLibre.
The source is two existing official SWOT L2 HR Raster 100 m NetCDF files over the
Roanoke region, dated 2025-11-14 and 2026-07-12. No download or cloud upload is
needed. Data remain under the gitignored `data/` directory.

```sh
uv run python examples/swot_raster/build_demo.py
node examples/swot_raster/browser_check.mjs
```

The build expects the local files under
`~/geodata/nisar_swot_water_detection/roanoke*/` (`--source-root` overrides it).
It intersects their aligned EPSG:32618 grids, chooses a 512 × 512 native 100 m
window maximizing shared valid WSE pixels over a 64-pixel-stride search, and
stages GeoTIFF crops. No warp or interpolation occurs. `chronozarr.convert`
produces a two-date, two-level, unsharded float32 store with explicit masks,
about 1.06 MB. The source NetCDFs are read only.

WSE is in metres above the source product's geoid, with its delivered corrections.
All raw values, including negative elevations and the source fill sentinel, are
preserved at level 0. The mask marks finite, non-fill pixels. Source quality flags
are not filtered: this is a software-fidelity fixture, not quality-screened WSE or
a flood-change analysis. The two acquisitions also come from different passes.
There are no valid exact-zero elevations in the chosen window.

The build verifies complete level-0 float bit patterns and masks, xarray values
and mask coordinates, and COG-export valid values, masks, metre units and grid.
Source paths, SHA-256 hashes, windows, counts, timestamps and results are in
`data/reports/swot-roanoke-20261002.json`. Invalid COG pixels need only preserve
their invalidity, while chronozarr retains their original fill values too.

The browser check compares complete chunk/mask hashes against Python, checks
negative pixel readouts and units on both dates, and checks the MapLibre layer's
geographic `getValueAt` against a source pixel. The MapLibre demo accepts `p=band`
for this scientific single-band store; the leafmap helper uses `product="band"`.

Both xarray interfaces preserve per-band units in `band_units`, and set the data
variable units to `m` for this WSE store.

The notebook requires the notebook extra and leafmap. Its player reads a local
store via the range/CORS server, so browsers may request local-network permission.
No R2 capacity is used. Screenshot: `data/reports/swot-roanoke-viewer.png`.

## Quality-filtered comparison

`filtered.ipynb` uses `good-20261002`, built with `--quality good`, retaining only
finite/non-fill pixels with delivered `wse_qual == 0`. The raw values, native
grid and selected window are identical to the original. Valid pixels drop from
93,717 to 26,049 (2025-11-14) and 65,672 to 30,589 (2026-07-12). No value clipping,
interpolation or morphological cleanup occurs. These are water observations,
so even good-quality data have gaps; negative elevations are not automatically
invalid. The build also supports `--quality usable` (good plus suspect).

```sh
uv run python examples/swot_raster/build_demo.py --quality good
node examples/swot_raster/browser_check.mjs --good
```

The filtered store passed the same bit-exact data/mask, xarray, COG and browser
readout checks. The examples disable leafmap's optional floating sidebar to avoid
its incompatibility with ipyvuetify 3; the map and our time slider remain active.

## Requested quality threshold

`quality_le1.ipynb` retains finite, non-fill WSE where `wse_qual <= 1`
(good and suspect), excluding degraded and bad observations. It uses
`usable-20261002` and preserves the original grid and values. The two dates
retain 76,521 and 59,971 pixels.

```sh
uv run python examples/swot_raster/build_demo.py --quality usable
node examples/swot_raster/browser_check.mjs --usable
```
