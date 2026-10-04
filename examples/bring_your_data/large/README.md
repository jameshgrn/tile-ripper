# Larger real-source append and browser fidelity check

This expands the earlier twelve-date adoption sample to a **1136 × 1107** common
10 m UTM grid (EPSG:32611), with four numeric bands and twelve actual Sentinel-2
acquisitions. The area is larger than the three-date 905 × 741 baseline. Each COG
was freshly prepared from the pinned Planetary Computer source assets over the
larger window. No small array was duplicated or upscaled to manufacture coverage.

From the repository root:

```bash
uv run --extra geo --extra ingest python examples/bring_your_data/large/fetch.py data/adoption/large-20261003/input
uv run --extra geo --extra ingest python examples/bring_your_data/large/validate.py data/adoption/large-20261003
uv run --extra geo --extra ingest python examples/bring_your_data/bundle.py data/adoption/large-20261003/series data/adoption/large-20261003/published
uv run --extra geo --extra ingest python examples/bring_your_data/serve.py data/adoption/large-20261003/published --port 8767
# In another terminal, while no other Playwright Chromium is running:
node examples/bring_your_data/large/check.mjs http://127.0.0.1:8767/published/ data/adoption/large-20261003/verification.json
```

Use a fresh output root for reruns: conversion and bundle creation refuse existing
outputs. Browser requires the repository's installed Playwright Chromium. The
fetcher pins the exact scene IDs from `extended/results/source.json`, signs asset
URLs immediately before reading, uses bilinear band resampling and nearest-neighbor
SCL masking, and applies the documented processing-baseline offset correction.
Scene IDs, unsigned asset URLs, processing baseline, grid transform, prepared COG
file hashes and validity fractions are recorded in `results/source.json`. Hashes
refer to complete prepared COG files; the remote full Sentinel-2 assets were not
fully downloaded or hashed. This is an adoption exercise, not a validated scientific
change-detection product.

The v0.3 validator writes true values. It converts eleven dates and
appends the actual December acquisition. It reconciles every level-0 value and mask
locally and through HTTP, physical scaling and NaNs, unchanged existing chunks,
and old local/HTTP handle snapshot behavior. The browser assembles complete
level-0 frames from all nine cells and compares data/mask SHA256 to the Python COG
goldens. This covers all bands, dates, true values, padded edge cells and masked
pixels, beyond a few inspector samples. It separately waits for completed viewer
frames for all twelve dates; numeric raster hashes do not validate shader colours.

Memory evidence records a sampled reader cache, JavaScript heap where available,
and summed RSS for Playwright browser/profile process descendants. RSS sampling
can miss short peaks and double count shared pages; the viewer and a second numeric
reader run together. It is not an isolated reader, GPU, true peak or production
memory bound. The source preparation and all checks are on the same machine with
host caches, localhost HTTP, and no CDN or outside-user validation. No transient
frame completeness claim is made from completed-frame waits.

Measured on 2026-10-03: all twelve local/HTTP frames and browser full-frame hashes
passed; all twelve requested frames eventually rendered completely. The appended
December date left **308 existing data/mask chunks unchanged**. The final static
store contains **372 objects / 103.7 MB**. HTTP doctor reported 11 OK, 4 informational,
zero warnings or failures. No library/read-path changes were needed.

The browser numeric reader's sampled cache maximum was **304.2 MB**; the reported
JavaScript heap was **533.7 MB** at the end of the numeric loop. Summed Chromium RSS
reached **1.89 GB** across four processes, with 49 samples at 100 ms. The viewer and
full-frame numeric reader were both open, and no other Playwright workload ran
during this pass. These measurements should guide further scale work; they do not
establish a low browser-memory bound. Cache eviction and failure injection belong
to the separate HTTP stress run; this run did not force eviction. Python process
peak RSS was 955.4 MB and includes conversion, GDAL and multiple open handles.

Evidence: [source](results/source.json), [numeric and append checks](results/verification.json),
[browser values, rendered frames and memory](results/browser.json),
[HTTP doctor](results/doctor-http.txt), [runtime provenance](results/run-context.json).
Append/conversion timings were collected during concurrent correctness work and
are not comparative performance measurements. The initial validation attempt
finished its numeric assertions but failed at a cleanup call; its stores were
preserved under `attempt1-*` locally and the recorded successful pass used freshly
converted stores.

The checked-in results describe the historical v0.2 run; regenerate them to obtain v0.3 evidence.
