# Matched level-0 rendering comparison

Historical v0.2 results and artifacts below are preserved as recorded. They do not describe v0.3 writer options; use explicit conversion before reading the stores with v0.3.

Run from the repository root with the existing bench dependencies and the three-date
Lake Mead inputs prepared by `examples/bring_your_data/README.md`:

```sh
node bench/rendered/run.mjs
```

The runner locally bundles geotiff.js, starts the existing range-capable static server,
and rotates three source orders for each of two profiles (18 fresh reader sessions).
All three paths read four uint16 bands plus the explicit full-resolution validity mask
from the same 741-column by 905-row raster on three dates. The same production
`js/demo/renderer.js` uploads the assembled full raster to R16UI textures and R8UI masks.
True color uses red/green/blue indices 2/1/0, divides by 10000, stretchLo=0, identical
camera and 741x905 canvas at deviceScaleFactor=1. Rendering always uses level 0.
This full-raster upload harness does not reproduce the demo's production chunk residency,
LOD selection, playback or prefetch orchestration.

Cold timing starts before renderer allocation and the selected source's dynamic import.
Shared renderer modules are preloaded; source modules are isolated per fresh context.
Metadata, source module import, chronozarr worker initialization, read/decode/assembly,
GPU upload, drawing and GPU completion are included. `Renderer.finish()` performs a
synchronous one-pixel readback after the draw. The endpoint is GPU work completion;
it does not measure browser compositor presentation or next animation-frame latency.
OS caches, executable, GPU shader caches and localhost storage are shared/warm.
Data-only requests count store/COG URLs; page-monitored requests also include dynamically fetched
source modules and worker startup entries, excluding the shared page and renderer loaded before the
counter was attached. CDP counts wire bytes including HTTP headers. Each phase stores
both counter deltas and raw requests. Page CDP does not provide exhaustive worker
accounting: chronozarr has eight worker-start entries without completed wire counts and
worker descendant module/WASM requests are absent. Page-monitored wire totals are a
LOWER BOUND. Data-only requests are all complete. Full data, masks and rendered RGBA SHA256 values
are checked outside each operation's reported timing, including native repeats.

`natural` is localhost. `50Mbit-40ms` is **NETWORK EMULATION**, Chromium CDP bandwidth
50 Mbit/s and latency 40 ms, starting before dynamic imports. The CDP profile is attached to the page target; local page
module assets and data are throttled, but worker descendant throttling is unconfirmed. It is no CDN, internet or production-storage experiment.
The COG bundle's single-module delivery and the native ES-module dependency trees differ;
first-opening totals include that delivery difference and do not isolate format decode.

Warm steps use an identical application frame cache and retained GPU slots. Native repeats
bypass the frame cache but retain each library's normal reader/block/decoded caches.
The scripted scrub issues [0,2,1,0,1,2] at 10 ms intervals through native reads; old complete
frames remain visible until the latest requested complete frame resolves. Stale completions
are discarded. Zero partial frames follows from this common harness policy; it establishes
no native viewer or reader advantage. Event samples record held/requested dates and final
commits; they do not claim continuous frame sampling or FPS performance.

Read/assemble and renderer/upload/finish wall times are reported separately; there is no
codec-only instrumentation. Cold module/initialization time precedes read/assemble. Concurrent
chunk tasks are included once in elapsed wall time, never added as independent CPU durations.
Memory fields report retained frame bytes, allocated texture bytes and one JS heap sample;
workers, WASM, native allocations and browser-process memory are not fully counted. No
whole-browser peak-memory claim is supported. Input, metadata and harness hashes, exact
bench dependency pins, Node, Chromium and commit provenance are stored in results.json.

Results below are bounded to this three-date sample. Auto selected temporal encoding none;
this experiment does not test star-delta compression. Zarr uses zstd5; COG uses DEFLATE.
Browser timing and fresh context initialization vary; three repetitions do not establish a
universal ranking or the production read-path speed gates.

Measured 2026-10-03T17:14:02.117Z; milliseconds, medians of three cold sessions or pooled date steps:

| Profile / source | Cold GPU-complete frame | Uncached date | Native repeat | Application warm | Render/upload/finish |
|---|---:|---:|---:|---:|---:|
| natural/chronozarr | 78.4 | 24.2 | 2.1 | 1.0 | 1.1 |
| natural/zarr | 77.1 | 28.9 | 26.1 | 0.9 | 1.2 |
| natural/cog | 181.4 | 147.1 | 126.6 | 1.1 | 1.4 |
| 50Mbit-40ms/chronozarr | 1271.0 | 1078.0 | 2.2 | 1.0 | 1.1 |
| 50Mbit-40ms/zarr | 1367.1 | 655.0 | 657.8 | 1.3 | 1.7 |
| 50Mbit-40ms/cog | 1025.7 | 857.5 | 124.4 | 1.1 | 1.3 |

Cold request counts and wire bytes (identical in both profiles):

| Source | Data requests / bytes | Page-monitored requests / bytes lower bound |
|---|---:|---:|
| chronozarr | 9 / 3,801,256 | 46 / 4,753,505 |
| zarr | 12 / 3,801,140 | 52 / 4,720,712 |
| cog | 5 / 4,267,419 | 6 / 4,831,261 |

All application-warm steps made zero data requests and transferred zero data bytes.
The six-request scrub committed six dates through the chronozarr decoded cache; native
Zarr and COG committed the final requested date and discarded five obsolete completions
in all runs. Native Zarr scrub made 48 requests and transferred 22,543,286 wire bytes;
chronozarr and COG scrub made zero data requests (COG still repeated raster decoding).
All final scrub date hashes matched. These cache/commit differences describe the selected
workload after all dates had been loaded, not cold viewer playback.

The source with lowest median cold time changed between localhost and network emulation.
The measured ordering combines source module delivery, reader initialization, metadata,
codec and request scheduling. It does not establish that any raster format is universally
faster. Shared GPU rendering medians were 1.1–1.8 ms; native-reader/cache work accounts
for most larger operation differences in this bounded setup. The first exploratory pass
was superseded by this final run with both page-monitored and data-only counters; no exploratory
figures are mixed into the committed results.

The runner median helper was corrected after measurement to average both central values
for even-length phase collections; summary.json was recomputed directly from unchanged raw
timings. The recorded runner hash identifies the script used during the measurements.

Source formatting was normalized after measurement. Original measurement hashes remain
in provenance; current hashes and the median-only correction are separately documented
in postMeasurementSourceNotes. No timing workload changed.
