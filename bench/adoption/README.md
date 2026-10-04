# Bounded browser delivery comparison

Historical v0.2 results and artifacts below are preserved as recorded. They do not describe v0.3 writer options; use explicit conversion before reading the stores with v0.3.

Run from the repository root after preparing the documented `examples/bring_your_data`
Lake Mead sample and installing the existing bench dependencies:

```sh
node bench/adoption/run.mjs
```

The runner builds the geotiff browser bundle locally, starts the existing range-capable
static server, launches installed Playwright Chromium, runs five rotated interleaved
repetitions in fresh browser contexts, checks complete raster and mask hashes outside
timing, and writes `results.json`. No external browser requests or new dependencies are
needed. Data remain in gitignored `data/adoption/lake-mead-2020`.

Measured 2026-10-03 on this machine (milliseconds, medians):

| Path | Cold open plus frame 0 | Uncached date step | Native reader repeat | Repeat requests / wire bytes |
|---|---:|---:|---:|---|
| chronozarr reader | 49.4 | 23.95 | 1.0 | 0 / 0 |
| native zarrita plain Zarr | 45.7 | 24.85 | 25.8 | 8 / 3.72–3.78 MB |
| geotiff.js COG per date | 168.1 | 139.15 | 122.1 | 0 / 0 |

Cold opens issued respectively 9, 12, and 5 requests and transferred 3,801,256,
3,801,140, and 4,267,419 bytes including HTTP headers, as counted by Chromium CDP.
Metadata lookup is included. Plain zarrita uses consolidated metadata and the unmodified
native reader without an extra byte or decoded-chunk cache. geotiff.js retains its
range/block cache but raster decode is repeated; chronozarr retains decoded chunks.
These are the libraries' configured default behaviors, not equally sized cache policies.

All paths read all four uint16 bands and the full-resolution validity mask for all three
dates over the entire 905×741 raster at level 0. geotiff.js explicitly reads the internal
mask IFD and normalizes its 0/255 samples to 0/1. Complete SHA256 values and masks agree
for every frame in every run. Auto encoding selected `none` in this sample: this does
not test star-delta savings. COG uses DEFLATE; Zarr uses zstd level 5.

Two warm workloads are included: application-cached frame retrieval (timer resolution
rounds medians to zero, equal for all paths), and native-reader repeats bypassing that
frame cache while reusing reader handles. Per-phase requests and bytes are recorded for
cold open, uncached steps, and native repeats. Warm cached-frame operations issue no
reads by construction. Complete frames are assembled before each operation resolves.

Limits:

- Fresh browser contexts and disabled HTTP cache are **cold reader sessions**. OS caches,
  the browser executable, modules, and local static-server storage are warm/shared. This
  is a localhost measurement, with no CDN miss, remote latency, or bandwidth model.
- Timing is retrieval, decode and raster assembly combined. No isolated codec-only decode
  timing, shader products, GPU upload, rendered-frame latency, or interactive scrubbing
  is measured. Sequential repeat order is 0, 2, 1; application cache order is 0, 2, 1, 0, 1, 2.
- Returned frame buffers retain 18,106,335 bytes in every path. `usedJSHeapSize` is only a
  point sample; it excludes some workers/native/WASM/GPU allocations and is not peak
  process memory. chronozarr cache statistics are included, but no equal peak-memory
  claim is supported.
- Only three dates and four spatial chunks are measured. Browser timers and concurrent
  work on this machine affect results. Five runs do not support a universal ranking or
  read-path speed-gate claim. The implementation of readers was unchanged.

`dist/` is generated and ignored. `results.json` records raw timings, complete hashes,
network request details, retained buffers and cache statistics; reruns replace it.

The runner intentionally targets the bounded sample paths and dates above. To recreate
the prepared data, follow `examples/bring_your_data/README.md`: download with
`fetch_sample.py` into `data/adoption/lake-mead-2020/input-full`, convert into `series`
and into `plain-zarr` using `--encoding none`, then run `verify.py`. The source catalog
can change; compare the recorded `inputHashes` and `source.json` before interpreting a
new run as the same input. Recorded Chromium is 153.0.8010.12. Exact dependency pins,
Node version, source/manifest/COG/root metadata hashes are embedded in results.
`summary.json` supplies compact numerical medians.
Even-sized samples now average the two central values; the uncached-step medians
were corrected from the original upper-middle selection using the unchanged raw timings.
