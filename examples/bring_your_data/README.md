# Bring your own raster time series

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

Convert your observations, read their numeric values in Python, and publish a viewer and an
embed example alongside the data. The output is an independent static directory: no requests
to chronozarr.org or its demo stores are needed to view it. JavaScript dependencies, including
the GIF encoder, are copied into the bundle.

This is an adoption recipe, not a continental benchmark. It uses your input and makes no claim
about compression, scientific accuracy, or production-scale performance.

## 1. Install from a checkout

Run these commands from the repository root. Python 3.11 or newer is required.

```sh
uv sync --extra geo
```

uv selects an installed Python automatically. To choose a specific version, use
`uv sync --python 3.13 --extra geo` (add `--extra ingest` for the sample download).
The locked codec dependency may need a source build on Python 3.14. The
[clean-checkout reproduction](results/clean-checkout-20261002/README.md) verified the full
recipe with Python 3.13, a fresh environment and newly downloaded observations.

The Python converter and reader are also available as `chronozarr[geo]` on PyPI. The bundle
script currently needs this checkout because it copies the complete viewer and vendored
JavaScript dependencies. It does not need an npm install or a JavaScript build.
The v0.3 npm package prepared in this checkout, `chronozarr` 0.3.0, contains the reader and MapLibre layer.
The standalone viewer copy command is available only from a locally packed checkout
build; see [self-host the packaged viewer](../../docs/viewer-distribution.md) for that
checkout-independent workflow.

## Optional: start with independently downloaded real observations

If you do not have a raster series ready, fetch three Sentinel-2 acquisitions near Lake Mead
(May–July 2020) directly from Microsoft Planetary Computer:

```sh
uv sync --extra geo --extra ingest
uv run python examples/bring_your_data/fetch_sample.py /tmp/lake-mead-input
uv run chronozarr convert /tmp/lake-mead-input/observations.csv /tmp/lake-mead-series
uv run chronozarr convert /tmp/lake-mead-input/observations.csv /tmp/lake-mead-plain
uv run python examples/bring_your_data/verify.py /tmp/lake-mead-input/observations.csv \
  /tmp/lake-mead-series /tmp/lake-mead-plain /tmp/lake-mead-verification.json
uv run python examples/bring_your_data/compare_local.py /tmp/lake-mead-input/observations.csv \
  /tmp/lake-mead-series /tmp/lake-mead-plain /tmp/lake-mead-comparison.json
uv run python examples/bring_your_data/bundle.py /tmp/lake-mead-series /tmp/lake-mead-published
uv run python examples/bring_your_data/serve.py /tmp/lake-mead-published --port 8000
```

This requires network access, but no API key. The fetcher checks tile footprint coverage,
chooses one low-cloud acquisition per month on a common tile, crops/resamples four bands to
one 10 m UTM grid, applies the existing SCL validity rule, and records the source scene IDs
and actual acquisition dates in `source.json`. It refuses observations with less than 50%
valid coverage. It does not make monthly composites, fill gaps, or infer reservoir change.
The manifest dates are acquisition dates, not the first day of each month. Signed credentials
are not written into the provenance file. Selection can change if the source catalog is
reprocessed; `source.json` identifies what your run used.

The verification checks every level-0 value and mask against the prepared COGs, physical
scaling, and an ordinary xarray/Zarr read. Fidelity is to those prepared COGs, not a claim that
resampling preserves the original satellite grid's values. The local comparison reads all
three full-resolution frames and masks with fresh handles and warm filesystem caches, rotating
reader order. It measures Python read pipelines, not browser or CDN performance.

See [the recorded run](results/lake-mead-2020/README.md) for results and limitations.

## 2. Describe your observations

For GeoTIFFs or COGs, write `observations.csv` next to your files:

```csv
uri,datetime
january.tif,2024-01-01
february.tif,2024-02-01
march.tif,2024-03-01
```

URIs may be local relative paths or HTTP URLs. For the first run, use observations on the same
north-up grid with the same CRS, bands, dtype, scales and offsets. Set band descriptions and
scale/offset metadata in the source rasters; the converter preserves them. For multispectral
imagery, names such as `red`, `green`, `blue`, and `nir` allow the viewer to offer matching
products. The data can also be a single measured variable; RGB is not required.

```sh
# Inspect the plan before doing the conversion.
uv run chronozarr convert observations.csv /tmp/my-series --dry-run
uv run chronozarr convert observations.csv /tmp/my-series
uv run chronozarr validate /tmp/my-series
uv run chronozarr doctor /tmp/my-series
```

Use a new output directory. For an existing Zarr or NetCDF time series, replace the manifest
with its path and specify `--variable NAME` as needed. NetCDF may need `uv sync --extra geo
--extra netcdf`. The CLI's `--help` describes explicit reprojection and resampling options;
resampling changes values and should be a deliberate choice.

For rendered PNG input, use the [PNG georeferencing guide](../../docs/png-frames.md). Rendered
colors are display values, not recovered satellite measurements.

## 3. Read a pixel's history

```sh
uv run python examples/bring_your_data/read_series.py /tmp/my-series --row 20 --col 30
```

The script uses the lazy xarray backend and selects one pixel before reading values. By default,
values are physical values after scale and offset, and invalid values are NaN. Each selected
pixel still requires the spatial chunks containing it, so a pixel history is not a tiny
one-value-per-date HTTP request. Add `physical=False` to `xr.open_dataset` for stored values.

## 4. Build and preview your static bundle

```sh
uv run python examples/bring_your_data/bundle.py /tmp/my-series /tmp/my-published-series
uv run python examples/bring_your_data/serve.py /tmp/my-published-series --port 8000
```

Open the printed Viewer and Embed URLs. The full viewer opens your store; the embed host's
slider, product selection, playback buttons and pixel-click readout control a self-hosted
iframe using the documented `chronozarr:*` messages. Neither uses our hosted demo.

The bundle contains:

- `store/`: a copy of the validated store, with no data changes;
- `demo/`, `chronozarr/`, `maplibre/`, `vendor/`: viewer and shared modules;
- `index.html`: opens the viewer with the local store URL;
- `examples/embed.html`: working host application;
- `bundle.json`: reader version, stored object count and bytes (not timing results).

The script copies data, so allow disk space for a second copy. It refuses an existing output
and an output inside the input store. Source data and existing stores are left untouched.
The preview server binds to localhost and supports byte ranges; it is not a production server.

## 5. Publish to your own host

Upload the contents of `/tmp/my-published-series` to a static host, keeping the directory
structure. It works at a domain root or under a subdirectory. Open `index.html` or
`examples/embed.html` at that location. Serve JavaScript with its correct MIME type and enable
byte ranges for sharded data. If an application on another origin reads the store or imports
the modules, configure CORS. See [hosting](../../docs/hosting.md) for provider recipes and
cache settings.

```sh
uv run chronozarr doctor https://your-host.example/my-published-series/store
uv run python examples/bring_your_data/read_series.py \
  https://your-host.example/my-published-series/store --row 20 --col 30
```

This recipe covers public or same-host-readable data. Authentication and expiring tokens need
additional integration; do not expose private rasters by publishing this directory publicly.

## What to report when trying it

Record your source type, dimensions, bands, dates, browser and hosting provider; the conversion
command and any failure; and whether the viewer, embed controls and Python values work. Include
`bundle.json` and `chronozarr doctor` output. Do not include credentials or signed URLs.

The [bounded browser comparison](../../bench/adoption/README.md) checks equivalent level-0
COG/plain-Zarr values and masks; the [shared-renderer comparison](../../bench/rendered/README.md)
also reconciles rendered pixels. The [twelve-date extension](extended/README.md) and
[larger-source check](large/README.md) verify real observations, append and browser values.
[HTTP snapshot and stress checks](http_stress/README.md) exercise already-open readers,
cache eviction and transient request failures. These are same-machine checks; remote/CDN
delivery, larger-scale memory behavior and outside-user adoption remain open.
Successful local playback alone does not establish speed, savings, or scale.

## Optional browser verification from the checkout

With Node.js and the repository browser tooling installed (`npm ci --prefix js` and
`cd js && npx playwright install chromium`), leave the preview server running and use its
printed base URL (without `index.html`):

```sh
node examples/bring_your_data/check.mjs http://127.0.0.1:8000/my-published-series/
```

Use at least two observations. This checks full-viewer rendering, the host slider driving the embedded viewer to its
second observation, product selection, pixel-click reporting and playback controls. It blocks requests to other origins and fails
on browser errors. It is an integration smoke check, not a performance or pixel-fidelity test.
