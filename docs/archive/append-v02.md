# Appending: what one new date costs

`chronozarr append STORE INPUT` adds timesteps to the end of a store in place (spec section 14, publishing in [hosting.md](../hosting.md) section 7). Before it existed the only way to add a date was a re-encode under a new prefix: rewrite and re-upload every object. This page measures the append against that and against the layout choices that decide its cost.

## Which layout to append to

The encoder default, unsharded, is the right layout for appends. Measured on the Ucayali mosaics: an unsharded append writes 55 MB per month and rewrites nothing but metadata. A store sharded at `shard_time` 12 writes 4389 MB over a 12-month cycle against 686 MB unsharded (6.4x). The whole-axis shard layout (`--shard`, `shard_time` = the timesteps at creation) rewrites a growing second shard every month (116.9 MB for the second append to a 115-month store, and up to 115 chunks per cell by the end). An unsharded store has no shard index for an open viewer to hold stale, and costs the same chunk reads per timestep with no index read.

The price of unsharded is object count: about 5,900 objects for the 117 Ucayali months against 93 for the whole-axis shard, which is one object per cell and level for the whole time axis. Shard an appendable store (`--shard --shard-time 12` for monthly data) only when object count matters more than the rewrite cost, and use the whole-axis `--shard` for archives that are not appended to. The first batch of a sharded store may be a single timestep, because `shard_time` may exceed the timesteps present. (The tables below were measured when whole-axis sharding was still the encoder default; they are kept because they are the cost of the sharded layouts.)

## What an append writes

- the objects that gain data: for each level and cell, the chunk of an unsharded store, or the time shard holding the new timestep (a shard that already has earlier timesteps is rewritten whole, its old chunks at their old offsets);
- per level, the array `zarr.json` files, `time/zarr.json` and `time/c/0`, then `volatility/c/0/0` when it changes, then the root `zarr.json` with the consolidated metadata.

Nothing else is opened. Star-delta references already recorded are never changed (section 4.2): an appended timestep references the nearest anchor that exists after the append.

## Method

Data: `data/mosaics/ucayali_santa_maria/*.npz`, 117 monthly Sentinel-2 mosaics, 4 bands uint16, 2765 x 2759 px, chunk 512, four levels, 50 cells (36 at level 0). Stores are built from the first months, then months 13 and 14 are appended one at a time. Every operation runs in its own process (`scripts/bench_append.py`), so peak RSS is per operation. After every step `chronozarr validate` passes and every timestep decodes equal to its source mosaic, bit for bit (level 0, all timesteps). Objects written come from file size, mtime and sha256 before and after. The machine is a 16-core Mac with 128 GB shared with other jobs (load average about 10), so wall seconds are the median of three runs of the whole matrix and carry roughly 20 % noise. Object counts and bytes come from the last two runs, which were identical; the first run also rewrote the unchanged `volatility` chunk at month 13, which `append` now skips.

Three layouts: whole-axis shard (`shard=True`, `shard_time` = the timesteps at creation; the encoder default when these were measured), `shard_time=12`, and unsharded (the encoder default now). At 12 months the first two are the same store, and the table shows identical numbers for them. Two encodings: `auto`, which chose `none` at 12 months (star-delta/plain 0.89 on the sample), and a forced `star-delta` with anchor interval 6.

## Results: 12-month stores, month 13 and 14 appended

Store size after the 12 months: 653 MB `none`, 584 MB star-delta; 93 objects sharded, 643 / 614 unsharded. Building it takes 3.9 s with 1.3 GB peak RSS.

"Objects written" counts files that are new or whose size or mtime changed (new + rewritten). `aws s3 sync` uploads exactly that set, because a rewritten file is newer than its remote copy; `sync --size-only` uploads fewer (last column).

| layout | encoding | append | wall s | peak RSS MB | objects written (new + rewritten) | MB written = MB `sync` uploads | `sync --size-only`: objects / MB |
|---|---|---|---|---|---|---|---|
| whole-axis = shard_time 12 | none | month 13 | 0.60 | 329 | 63 (50 + 13) | 55.3 | 55 / 55.3 |
| | | month 14 | 0.70 | 381 | 64 (0 + 64) | 110.7 | 55 / 110.7 |
| unsharded | none | month 13 | 0.62 | 325 | 63 (50 + 13) | 55.3 | 55 / 55.3 |
| | | month 14 | 0.68 | 368 | 64 (50 + 14) | 55.4 | 55 / 55.4 |
| whole-axis = shard_time 12 | star-delta | month 13 | 0.60 | 330 | 63 (50 + 13) | 55.3 | 55 / 55.3 |
| | | month 14 | 0.67 | 381 | 64 (0 + 64) | 55.7 | 34 / 29.1 |
| unsharded | star-delta | month 13 | 0.64 | 340 | 63 (50 + 13) | 55.3 | 55 / 55.3 |
| | | month 14 | 0.60 | 338 | 43 (29 + 14) | 0.4 | 34 / 0.4 |

Reading the table:

- **Month 13 opens a new time shard** (sharded) or adds new chunk keys (unsharded): 50 new objects, one per cell and level, plus 13 metadata files. Peak RSS is a quarter of the build's and wall time a sixth.
- **Month 14 rewrites the shard that month 13 created**, so a sharded store writes 2 chunks of data per cell (110.7 MB) while an unsharded store writes 1 (55.4 MB). The extra is old data written again.
- **Star-delta, month 14, sharded: 64 objects and 55.7 MB, of which 21 shards are byte-identical to before.** Month 14 (2017-05) has 0.2 % clear coverage and its pixels are carried forward from month 13, so in 18 of the 36 level-0 cells it equals month 13, the delta chunk is all zeros and is not stored, but the shard is still rewritten, with the same bytes and a new mtime. The unsharded store writes nothing for those cells (29 new objects, 0.4 MB). A sync that compares size and mtime still uploads the 21 identical shards; one that compares checksums skips them.
- **`sync --size-only` is not safe for appends.** It skips 8 to 9 changed objects whose size stays the same: each level's `data/zarr.json` and `time/zarr.json` (the shape goes from 12 to 13 in the same number of bytes) and, at times, `volatility/c/0/0`. Clients that read the per-array `zarr.json` instead of the consolidated metadata would see the old shape. Use size-and-mtime or checksum comparison, or `scripts/upload_stores.sh --newer-than`.

### The whole cycle of a shard

Appending months 13 to 24 to the 12-month store, `none` encoding (star-delta in brackets):

| layout | MB written, months 13-24 | objects per append | month 25 |
|---|---|---|---|
| shard_time 12 | 4389 (3978) | 63 to 64 | 60.8 MB, 50 new shards: the cycle restarts |
| unsharded | 686 (672) | 63 to 64 | 60.8 MB |

A sharded store writes the trailing shard again on each append, so month `k` of a shard writes `k` chunks per cell: the average is `(shard_time + 1) / 2` chunks, measured 6.4x (5.9x star-delta) the unsharded bytes at `shard_time` 12. The cost per append is bounded by the shard size, and `shard_time` trades object count against it: 12 gives up to 12 chunks per rewrite and 1 shard object per cell and level per year; 4 would give up to 4 and 3 per year; unsharded gives 1 and 12.

## Results: the production-sized store

The historical sharded Ucayali store (`chronozarr-3`, replaced in the demo by unsharded `chronozarr-4`) holds all its months in one shard per cell. Built the same way from the first 115 months (`--base-months 115`, `auto` chooses `none`), then months 116 and 117 appended:

| operation | wall s | peak RSS MB | objects written | MB written |
|---|---|---|---|---|
| build 115 months (today's only way to add a date) | 32.1 | 4724 | 93 (all, 6335 MB store) | 6335 |
| append month 116 | 0.55 | 407 | 64 (50 new shards + 14 metadata) | 58.4 |
| append month 117 | 0.57 | 392 | 64 (all rewritten) | 116.9 |

Adding a month by re-encode writes and uploads 6.3 GB (93 whole-axis shards). Appending writes 58 MB (0.9 %). The first shard stays untouched, because its length was fixed at 115 timesteps when the store was created and the new timesteps start a second shard. The whole-axis layout therefore appends correctly, but the second shard is allowed to grow to 115 chunks per cell (the sharded 117-month store has shards of 161 MB at level 0) and is rewritten whole on every append until it fills. That is the cost of appending to a whole-axis shard: write an appendable store unsharded (the default), or with a finite `shard_time` when object count matters.

A fresh encode of 13 months (`shard_time` 12) takes 4.8 s, 557 MB, 143 objects with 1.3 GB peak RSS; the append of month 13 takes 0.6 s and writes 55 MB. For reference, a fresh unsharded encode of all 117 months (`chronozarr-4`, `encoding` `auto` chose `none`) takes 41.9 s with 3.8 GB peak RSS and writes 6,451.8 MB in 5,893 objects; the sharded `chronozarr-3` is 6,451.9 MB in 93.

## Results: requests for a view

A 3 x 3 block of level-0 cells, one timestep, read cold with the Python reader (it caches no shard index; the browser reader caches one index per shard, so after the first timestep it issues only the chunk reads). Each cell needs the shard index (one suffix range) and one range per chunk: a delta timestep reads its anchor and its delta.

| store | before (t = 5 and 11) | after two appends (t = 5, 11 and the new t = 13) |
|---|---|---|
| sharded, none | 9 index + 9 chunk = 18 | 18 for all three |
| sharded, star-delta | 9 index + 18 chunk = 27 | 27 for t = 5 and 11; 9 index + 13 chunk for t = 13 (cells whose delta is all fill have no chunk to read) |
| unsharded, none | 9 chunk | 9 for all three |
| unsharded, star-delta | 18 chunk | 18 for all three |

An append changes none of these: a shard index is `16 * shard_time + 4` bytes (196 at `shard_time` 12) whatever it holds. A fresh encode of the same 14 months with the nearest-anchor rule makes timesteps 10 and 11 reference anchor 12 in the next shard: their view costs 18 index reads instead of 9 (measured: t = 10: 18 index + 16 chunk; t = 11: 18 index + 12 chunk). Frozen references keep each delta in the same shard as its anchor.

## Frozen references: what they cost and what they avoid

The nearest-anchor rule makes the next anchor, once it exists, the reference of the last timesteps of the interval before it. With interval 6, appending timestep 12 would change the references of timesteps 10 and 11 (6 to 12), and in general `anchor_interval - 1 - floor(anchor_interval / 2)` timesteps per new anchor. Those chunks are already published; changing them changes what cached copies decode to. The spec therefore freezes recorded references (section 4.2).

**What re-referencing would have rewritten** at the month 13 append of the star-delta stores above: every time shard of every cell and level in a sharded store (50 objects, 584 MB, the whole store, because timesteps 10 and 11 sit in the only shard), or 100 chunk objects (110 MB) in an unsharded store.

**What freezing costs in size.** A timestep whose reference stays on the preceding anchor sits 4 or 5 months from it instead of 2 or 1. Compressed bytes of level-0 chunks on the 117 Ucayali months (36 cells, zstd level 5):

| anchor interval | timesteps affected | their size, nearest anchor | their size, preceding anchor | increase on them | increase of the level-0 star-delta store |
|---|---|---|---|---|---|
| 6 | 38 | 1496 MB | 1666 MB | +11.4 % | +3.6 % (of 4687 MB) |
| 12 | 45 | 1903 MB | 2009 MB | +5.6 % | +2.2 % (of 4883 MB) |

On this AOI star-delta barely beats plain storage (4687 MB against 4804 MB for the same level-0 chunks at interval 6; 4883 MB at interval 12, larger), and the affected timesteps stored against the preceding anchor (1666 MB) are larger than their plain chunks (1558 MB). That is why `auto` picks `none` here. Measured on an actual append, the first 12 months stored star-delta (584 MB) and then month 13 appended give 639.5 MB, against 556.8 MB for a fresh encode of the same 13 months: +82.7 MB (+14.9 %), all of it timesteps 10 and 11 (all levels). These early months are sparse (months 12 and 13 equal each other in 15 of 36 cells), so consecutive months are nearly equal and the distance to the anchor matters more than on dense data. For data that changes a lot between dates, use `encoding none`; for data that changes little, the nearest-anchor default still applies to every fresh encode.

## Limits found

- An unsharded store is one object per timestep, cell and level: 5,893 for the 117 Ucayali months (17,088 for the water store, which has `mask` and `coverage` too). The first upload is slow with wrangler (../hosting.md section 3.2), but each append uploads only the 63 objects it wrote.
- Append is not transactional. Inputs are checked and spilled before the store is touched; a failure after that leaves it partly modified, and `append` refuses a store that no longer validates. Work on a copy.
- `volatility` is updated incrementally. It equals the spec definition over the recorded references up to float32 rounding, except for a cell already clipped at 1.0. For a `none` store the nominal schedule is not recorded, so appended timesteps use interval 6.
- In a sharded store, a viewer open during an append keeps the old metadata until reload and can fail on the index of a trailing shard it had not read (../hosting.md section 7). An unsharded store has no shard index.

## Reproduce

```bash
uv run python scripts/bench_append.py run --work-dir /tmp/append-bench
uv run python scripts/bench_append.py run --work-dir /tmp/append-bench-115 --base-months 115 \
    --layouts whole-axis --encodings auto --view-steps 5 100
uv run python scripts/bench_append.py run --work-dir /tmp/append-cycle --appends 13 \
    --layouts shard-time-12 unsharded --view-steps 5
uv run python scripts/bench_append.py reference-cost
```

The tables above came from the first command (three runs), the second, the third, and the fourth. Each `--work-dir` must be new.
