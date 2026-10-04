# Clean-checkout adoption reproduction

Historical v0.2 results and artifacts below are preserved as recorded. They do not describe v0.3 writer options; use explicit conversion before reading the stores with v0.3.

Verified 2026-10-02 from a new local clone of commit `2c04bfd`, with a new virtual
environment and freshly downloaded inputs. No existing project data or developer virtual
environment was copied. This was the project's agent on the same machine, not an outside user.
Host download caches, installed interpreters and the installed Chromium binary were reused.

## Setup and friction

The documented `uv sync --extra geo --extra ingest` selected Python 3.14.4. The locked
numcodecs 0.14.1 had no matching wheel and required a source build. uv reported approximately
39 seconds preparing packages and completed installation; an interrupt subsequently gave
the terminal exit code 130. This does not establish a failed build or working 3.14 runtime.

An explicit `uv sync --python 3.13 --extra geo --extra ingest` succeeded in about 0.8 seconds
with host caches available. All subsequent checks used Python 3.13.11. No quarantine setting
was changed. `npm ci --prefix js` succeeded, and `npx playwright install chromium` found
the browser already installed. The core conversion and bundle did not require npm.

The recipe needed no code repair or undocumented Python package. Port 8017 and new output
names replaced the recipe's example paths to avoid collisions. Per-stage end-to-end timing
was not captured, so this run does not establish time to adoption on a new computer.

## Reproduced behavior

- Fresh download selected the same three scenes as the earlier run: 2020-05-05,
  2020-06-09 and 2020-07-29, four uint16 bands, 905 × 741 pixels, EPSG:32611.
- Auto conversion selected `none`; explicit plain conversion also passed.
- Every level-0 value and mask matched prepared COGs exactly; physical scaling and native
  xarray/Zarr reads passed.
- A copied static bundle rendered in Chromium. Embedded time/product controls, pixel click,
  and playback controls passed with zero external requests and zero browser errors.
- HTTP doctor: 10 passed, 4 informational, 0 warnings, 0 failures.
- The documented lazy pixel-history script also succeeded over localhost HTTP.

Evidence: [source](source.json), [verification](verification.json),
[browser check](browser-check.json), [doctor](doctor-http.txt),
[pixel history](pixel-history.txt), [bundle inventory](bundle.json),
and [environment and script hashes](run-context.json).

## Bounded local comparison

The optional five-repeat, rotated Python comparison passed equality checks for all frames
and masks. Medians were rasterio/COG 83.2 ms, chronozarr 16.7 ms, native xarray/Zarr 14.4 ms.
See [raw results](local-comparison.json). These are warm-filesystem Python pipelines,
not browser delivery, cold storage, CDN performance or a universal format advantage.

This environment used Zarr 3.4.0 and rasterio 1.5.0; the earlier run used Zarr 3.1.6 and
rasterio 1.4.4. No implementation change was made. Do not attribute differences between the
two runs to a reader optimization. Serialized store size also differs slightly between
environments despite exact decoded values and masks.

## Restart state

The temporary clone is `/tmp/chronozarr-adoption-clean-20261002`; fresh input, auto store,
plain store and static bundle are `/tmp/chronozarr-clean-{input,series,plain,published}-20261002`.
The preview server was stopped. These temporary paths can disappear; tracked evidence here
records the result, and the recipe regenerates data. No release, deployment, push or directory
rename was performed.

The next milestone remains an interleaved browser comparison using these prepared values and
masks at level 0, followed by a longer timeline and append/reopen checks. This run completes
the clean-checkout workflow check; browser delivery and outside-user adoption remain unproven.
