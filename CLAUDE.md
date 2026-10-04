# chronozarr

chronozarr is the open format, libraries, and browser demo (chronozarr.org/demo):
a Zarr v3 layout convention for raster time series with true stored values and a
multiscale pyramid, readable by xarray and any Zarr client, decoded in the browser and rendered
on the GPU from raw uint16 bands. No server, no pricing, no auth. Static hosting only.

Read `.napkin.md` first every session.

## Layout

```
spec/CHRONOZARR.md        normative format spec (v0.3.0); spec/CHANGES-0.2.md only points to its section 13
src/chronozarr/           Python package; CLI `chronozarr` (commands: append | encode | validate | info | doctor | export-cog | stac | convert)
  schema.py               attribute dataclasses, layout helpers, validate()
  encode.py               encode(): pyramid, true values, optional volatility, optional sharding (default off), shard_bytes, mask/coverage
  decode.py               open_store() / ChronoStore: lazy reads, to_xarray(); HttpStore (stdlib HTTP range store)
  backend.py              xarray backend: xr.open_dataset(path_or_url, engine="chronozarr")
  convert.py              streaming conversion of COG manifests, Zarr variables and NetCDF into a store
  stac.py                 static STAC Collection and Item JSON for a store (datacube extension)
  export.py               export_cog(): true-value Cloud Optimized GeoTIFFs for GDAL and QGIS
  doctor.py               `chronozarr doctor`: CORS, byte range, caching and decode checks against a URL or path
  view.py                 serve_store(), view(): local range server and notebook viewer iframe
  cli.py                  CLI entry point
js/chronozarr/            DOM-free reader on zarrita (spec 0.3): decoder.js (openStore, getCell, prefetch), metadata.js,
                          http.js, cache.js, bandwidth.js, limiter.js, pool.js + decode-worker.js, codec.js, shard.js
js/maplibre/              MapLibre custom layer on the reader: layer.js, mesh.js, projection.js, shader.js, slots.js, view.js; demo.js + index.html
js/demo/                 viewer: index.html?store=<url>, viewer.js, renderer.js (WebGL2), products.js, playback.js, chart.js, export.js, permalink.js, bench.js
js/test/                  node --test suites (fixtures skip if data/spike is absent)
js/support/               static-server.js (byte ranges), synthetic-store.js, test fixtures
tests/                    pytest, marker `unit`
docs/                     hosting.md (S3 + CloudFront, R2, GCS, Source Cooperative; doctor checklist), format-comparison.md
deploy/                   README.md (R2 bucket + Worker publishing), r2-cors.json
scripts/reencode_aoi.py   monthly mosaics in data/mosaics/<aoi> -> chronozarr store
examples/sentinel2_pc/    Sentinel-2 monthly median ingest from Planetary Computer (optional extra `ingest`)
data/                     gitignored: mosaics/, stores/, spike/ (P0 fixtures)
```

## Run

```bash
uv sync --extra dev                # add --extra ingest for the Sentinel-2 example
uv run pytest -q -m unit
cd js && node --test
# dev server with byte ranges (needed for sharded stores), from .claude/launch.json "spike":
uv run --with rangehttpserver python -m RangeHTTPServer 8000
# then: http://localhost:8000/js/demo/index.html?store=http://localhost:8000/data/spike/synthetic_sharded
```

Always `uv run python`, never bare `python`. Never override uv's 7-day release-age quarantine (global uv.toml).

## Format decisions (do not relitigate without a measurement)

- Zarr v3 group; levels are groups "0", "1", ... each with `data` (time, band, y, x) uint16 and coords `time` (int64 ms, CF attrs), `band` (str), `x`, `y`. Every array carries `dimension_names` or xarray refuses the store.
- Unsharded by default (2026-10-01): one object per chunk (1, B, 512, 512), key `c/t/0/r/c`; about 5,900 objects for the 117-month imagery store. Why: a CDN miss on the 2 KB shard-index range at the end of an 83 to 174 MB shard pulls the whole object (2 to 11 s each; 6.5 of a 6.8 s cold open), and an append to a sharded store rewrites the trailing shard. Sharding stays valid and opt-in (`shard=True` / `--shard`, `shard_time`): shard (shard_time, B, 512, 512), inner chunk (1, B, 512, 512), `index_location: "end"` (zarrita 0.7.5 mis-decodes "start"); 93 objects and one range read per timestep once the index is cached, miss cost proportional to shard size. `shard_time` without `shard` is an error.
- zstd level 5. Measured 4.5 ms per 2 MB chunk via zarrita's WASM codec, vs 6.7 ms native gzip and 14 ms fzstd.
- v0.3 baseline stores true values in every array; one data chunk per timestep and cell. No temporal reconstruction. Volatility is optional.
- Root attrs: zarr-conventions registrations and multiscales/proj/spatial v0.1 metadata, plus chronozarr v0.3 time/band/validity metadata and optional volatility. Consolidated metadata written.
- Native projection (UTM per AOI), never Web Mercator for stored data. Lossless. No server-side rendering; products are band math in the fragment shader.

## Speed gates (measure before and after any change to the read path)

Cold open ≤ 500 ms at LOD 0 for 36 cells; warm timestep switch ≤ 16 ms; decode ≤ 5 ms per chunk; 0 wire bytes on a warm switch. `await chronozarr.bench()` in the viewer console. Numbers live in the README and `.napkin.md`.
