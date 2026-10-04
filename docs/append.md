# Appending to v0.3 stores

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

`chronozarr append STORE INPUT` adds strictly later timesteps on the existing grid. Unsharded stores write new chunks and updated metadata. Sharded stores rewrite the trailing shard; choose finite `--shard-time` when object count justifies that cost. Existing values and coordinates stay fixed. Publish data before metadata and root metadata last; invalidate cached mutable objects after publication.

Historical v0.2 measurements: [append account](archive/append-v02.md). The ordinary-value measurement wrote about 55 MB per month unsharded; a twelve-month shard cycle wrote 4389 MB against 686 MB unsharded. These are historical measurements, not a new v0.3 timing.
