# Real-data adoption run: Lake Mead vicinity

Historical v0.2 results and artifacts below are preserved as recorded. They do not describe v0.3 writer options; use explicit conversion before reading the stores with v0.3.

Verified locally on 2026-10-02. This is a three-observation workflow check, not an independent
user adoption, scientific validation, continental-scale test, or CDN performance result.

## Source and scope

Sentinel-2 L2A scenes downloaded directly from Microsoft Planetary Computer, tile 11SPA,
acquired 2020-05-05, 2020-06-09 and 2020-07-29. The 905 × 741 grid holds four uint16 bands
(blue, green, red, nir), at 10 m in EPSG:32611. Prepared observations have 98.4%, 98.6% and
98.9% valid pixels. This is one acquisition per month, not monthly compositing. The source
helper resamples bands, applies SCL validity and processing-baseline offset correction, and
does not fill gaps. See [source.json](source.json) for exact scene IDs and preparation.

The first candidate tile, 11SQV, covered only a sliver of the requested area. Scene-wide cloud
percentage alone was a poor selector. The sample fetcher now requires a tile whose raster
bounds cover the whole AOI and refuses observations with less than 50% valid pixels. The
rejected inputs are not the inputs to these results. This is a fix to example selection,
not a claim to solve arbitrary multi-tile mosaicking.

## Verified behavior

- Every level-0 stored value and validity mask matches the prepared source COGs.
- Physical values apply source scale 0.0001 correctly; invalid values are NaN.
- A plain Zarr store opens in ordinary xarray and has identical level-0 values and masks.
- Both the full viewer and self-hosted embed render; the host slider changes the observation, product selection works, pixel clicks report
  values to the host, and playback can be started and stopped.
- Browser checks pass with requests to other origins blocked: zero external requests and errors.
- HTTP doctor reports 10 checks passed, four informational messages, no warnings or failures.

Evidence: [verification](verification.json), [browser check](browser-check.json),
[HTTP doctor](doctor-http.txt).

## What the comparisons show

Auto encoding chose `none`: sampled star-delta bytes were 0.92 of plain bytes, missing the
0.85 threshold. There is no demonstrated temporal-compression advantage on this sample.
The auto store and explicit plain store have the same layout and codecs; the 116-byte size
difference is metadata. Native Zarr access remains a useful path for this store.

| Representation | Stored bytes including its metadata/overviews | Data objects/files |
| --- | ---: | ---: |
| Prepared COGs, DEFLATE | 15,674,752 | 3 |
| chronozarr, auto → none, zstd 5 | 14,488,813 | 55 |
| Explicit plain Zarr, zstd 5 | 14,488,697 | 55 |

COG overview values and masks have not been reconciled with the Zarr pyramids. These byte
counts do not establish a format, transfer, or cost advantage; codecs also differ.

The local comparison reads all three complete level-0 frames and masks. It uses five rotated,
interleaved repetitions, fresh reader handles, and warm filesystem caches. Timing includes
opening metadata, reading, decoding and assembling arrays; exact equality checks are outside
the timed intervals.

| Python read pipeline | Median for all three observations | Range |
| --- | ---: | ---: |
| COGs through rasterio | 94.8 ms | 92.5–94.9 ms |
| chronozarr reader | 57.5 ms | 54.2–59.5 ms |
| Plain Zarr through xarray | 19.6 ms | 17.9–32.2 ms |

The native Zarr pipeline was fastest for this workload. This measures different Python reader
implementations, not browser delivery, rendering, cold storage, ROI reads, or continental
behavior. It supports improving and using native Zarr paths where applicable, not claiming
chronozarr is universally faster. See [raw timings and method](local-comparison.json).

## What remains

This run establishes an actual-data path from external sources to a self-hosted application
and numeric analysis. It was run by the project maintainer's agent in the development
checkout. A fresh-environment run by another person remains necessary. Fair browser delivery
comparisons, larger timelines, multi-region behavior and deployed-CDN costs remain untested
by this example. No package release, cloud publication or local project-directory rename
was performed for this run.
