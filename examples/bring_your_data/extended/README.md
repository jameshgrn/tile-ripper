# Twelve real dates and append/reopen

Historical v0.2 results and artifacts below are preserved as recorded. They do not describe v0.3 writer options; use explicit conversion before reading the stores with v0.3.

This bounded extension uses twelve independently fetched Sentinel-2 L2A acquisitions near
Lake Mead, one per month in 2020, on a common 227 × 186, four-band, 10 m EPSG:32611 grid.
It uses the same catalog and raster preparation helpers as the original recipe. Acquisition
selection is recorded in `results/source.json`; resampling and SCL validity are preparation
steps, so numeric fidelity means fidelity to the prepared COGs.

From the repository root, choose a new output path:

```sh
uv run --extra ingest --extra geo python examples/bring_your_data/extended/fetch.py /tmp/extended-input/input
uv run --extra geo python examples/bring_your_data/extended/validate.py /tmp/extended-input
uv run python examples/bring_your_data/bundle.py /tmp/extended-input/series /tmp/extended-input/published
uv run python examples/bring_your_data/serve.py /tmp/extended-input/published --port 8123
# With the preview running and repository Playwright installed:
node examples/bring_your_data/extended/check.mjs http://127.0.0.1:8123/published/
```

The fetcher refuses an existing directory. Validation converts the first eleven dates and a
separate final-date store, opens an old reader, appends the final store, then opens a new
reader. It refuses existing conversion outputs. It compares every level-0 value and validity
mask against all twelve COGs locally and over localhost HTTP, checks physical scaling,
checks that the twelve frames have distinct hashes, and checks that existing data and mask
chunks retain their bytes. Time-coordinate chunks and metadata are expected to change.

The recorded run passed: all twelve dates and frames are distinct; validity ranges from
87.6% to 100%; the old Python handle retains eleven dates and rejects index 11, and a reopened
handle sees twelve. Append wrote eight objects totaling 269,752 bytes. Combined conversion,
GDAL and verification process peak RSS was 248,020,992 bytes on macOS; this is a measured
small-run peak, not proof of a memory bound at larger scale. See `results/verification.json`.

The browser script waits for a complete rendered frame at each of the twelve dates, records
reader cache counters, and retains the original recipe's embed time/product/pixel/playback
checks and prohibition on external requests. Browser cache bytes describe reader caches,
not total browser or GPU memory. The test samples completion and cache bytes every 10 ms while stepping. It does not inject
failed requests or prove absence of transient partial frames between samples. This grid is
smaller than the original 905 × 741 sample; the subsequent
[larger-source check](../large/README.md) uses a 1136 × 1107 grid.

During twelve-date stepping, 32 requested-frame readiness samples included one not-ready
sample; every date subsequently reached a complete rendered frame. This signal does not
mean that a partial frame was visible: the viewer can retain a whole previous/coarser frame.
The later [stress check](../http_stress/README.md) samples actual painted framebuffer colors.
Peak sampled reader-cache use was
28,090,372 bytes, below its 1,610,612,736-byte budget. This small sequence never stressed
eviction and does not validate the budget under large workloads.

These are same-machine small-footprint adoption checks. They do not establish independent
outside-user adoption, cold CDN performance, a compression advantage, larger-footprint
behavior, large-series memory bounds, or browser numeric pixel fidelity. No data was uploaded.
