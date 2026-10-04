# User zero: monthly water-mask stacks

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

The measurements below describe historical v0.2 artifacts, not current writer options. Convert those stores before opening them with v0.3 libraries.

Two derived chronozarr stores, built from the Sentinel-2 monthly mosaics that already sit in
`data/mosaics/`, to see what a fluvial geomorphologist can do with the viewer: scrub months, click a
pixel, chart it. Nothing was downloaded.

| | Ucayali (Santa María reach, Peru) | Lake Mead (NV/AZ) |
|---|---|---|
| Store | `data/stores/ucayali_santa_maria/water-1` | `data/stores/lake_mead/water-1` |
| Months in the store | 117 (2015-11 to 2026-02) | 94 (2015-08 to 2023-06) |
| Mosaics skipped | none | 33 (2023-07 to 2026-03, see "Problems in the mosaics") |
| Grid | 2765 x 2759 px, 10 m, EPSG:32718 | 2827 x 2316 px, 10 m, EPSG:32611 |
| Size | 1730.8 MB, 201 files | 1260.6 MB, 183 files |
| Raw int16 bands | 3570 MB (2.06x) | 2462 MB (1.95x) |
| Levels (MB) | L0 1286.7, L1 332.8, L2 87.6, L3 23.7 | L0 933.0, L1 246.6, L2 64.0, L3 16.9 |
| Derive + encode | 62.9 s (69 s wall with the scan) | 33.2 s (38 s wall) |
| Temporal encoding (`auto`) | `none` | `none` |
| Threshold floor | -0.15 | 0.0 |
| Floor binding | 116 of 117 months | 9 of 94 months |

`auto` did not measure anything: for `int16` data the writer always uses `none` (spec 4.3), so there
is no temporal compression ratio to report. Codec zstd level 5, 4 pyramid levels. Both `water-1` stores are sharded, (T, 2, 512, 512), the encoder default when they were built. `ucayali_santa_maria/water-2` is the Ucayali store rebuilt unsharded, the default now: 17,088 files, 1730.5 MB, and every value, mask plane and coverage plane identical to `water-1` at every level, timestep and cell. Lake Mead has no `water-2`.
The table records the original sharded build. Ucayali was subsequently rebuilt and uploaded as `water-2` on 2026-10-01; Lake Mead remained local. The current demo catalog lists imagery (`chronozarr-4`) and PNG frames (`png-1`), not either water store. The water suffixes identify dataset revisions, not spec or package versions. The historical bucket budget is not a current capacity check.

To preview the upload of an existing unsharded Ucayali build, the script takes its store name from `STORE`:

```bash
STORE=water-2 scripts/upload_stores.sh --dry-run ucayali_santa_maria   # 17,088 objects
```

## How they were built

```bash
uv run python examples/water_masks/build_water_stack.py --aoi ucayali_santa_maria --floor -0.15
uv run python examples/water_masks/build_water_stack.py --aoi lake_mead --boa-offset-from 2022-02
```

Those commands wrote `water-1` sharded because that was the encoder default. The default is now unsharded, so add `--shard` to reproduce `water-1`, or `--store-name water-2` for the unsharded layout.

Per month, from `B03` (green) and `B08` (nir) of the monthly median mosaic:

- `ndwi` = (green - nir) / (green + nir), computed in float64, stored x10000 as `int16`
  (`scale` 1e-4, `units` "index"). Masked pixels hold 0.
- `water` = 1 where `ndwi` is above the month's threshold, else 0, stored as a fraction: 0 or 10000
  (`int16`, `scale` 1e-4, `units` "fraction"), so the physical value is 0 or 1 at level 0 and the
  water fraction of the block at coarser levels (see "Categorical bands"). Masked pixels hold 0.
- `mask` = 0 where the mosaic's `coverage` is 0, that is where no scene was valid that month and the
  mosaic holds a carry-forward copy of an earlier month (or nothing). Gaps are not filled
  (`provenance.gap_fill` is "none").
- `coverage` = 1 where at least one scene was valid, else 0. The mosaics keep the valid fraction of
  scenes (multiples of 1/n), not a count, and the number of scenes is not stored, so this is the same
  0/1 flag as in the `sentinel2_pc` example. It equals `mask` here; the viewer shows it as
  "Observed by 1 scene".
- Threshold = max(Otsu, floor). Otsu is computed in numpy on the histogram of the month's valid
  `ndwi` values, one bin per stored integer, so the threshold is a stored value and the check below
  can reproduce it exactly. Ties inside an empty gap between two modes take the middle.
- Dark pixels: a valid pixel with green and nir both at or below 5 DN is water and is left out of the
  Otsu histogram. L2A clips reflectance at DN 1, and in many pre-2022 winter months the whole of Lake
  Mead is DN 1 in every band (2021-11, interior of the lake: 1, 1, 1, 1; 2021-09: 216, 240, 71, 25).
  `ndwi` of two floor values is 0 or noise, so NDWI cannot see that water. Without the rule Lake Mead
  water fell to 1.7 % of valid pixels in 2021-11 (15.1 % with it), 3.9 % to 16.7 % in 2015-12, 1.5 %
  to 16.4 % in 2016-02, 2.6 % to 16.9 % in 2020-01. 24 of 94 Lake Mead months have 1 % or more dark
  pixels. Ucayali has none. The stored `ndwi` at a dark pixel stays what the clipped DNs give, so
  at level 0 `water == 10000 * (ndwi > threshold)` holds everywhere except at dark pixels.
- `--boa-offset-from 2022-02` (Lake Mead only): subtracts 1000 DN from every valid pixel of the months
  from 2022-02 on (clipped to 1), the Sentinel-2 processing-baseline 04.00 offset the Ucayali mosaics
  were corrected for at ingest and the Lake Mead mosaics were not (see below).
- Months with no valid pixel are not written (Lake Mead, 33 of them). Months with few valid pixels are
  written; their row in the CSV says how few.

### Per-month record

`data/stores/<aoi>/water-1.months.csv`, one row per mosaic, in store order:

| Column | Meaning |
|---|---|
| `valid_px`, `valid_frac` | pixels with `mask` 1, and their share of the grid |
| `dark_frac` | share of valid pixels at the DN floor, counted as water |
| `otsu_threshold`, `threshold`, `floored` | raw Otsu, applied threshold (NDWI units), 1 when the floor replaced Otsu |
| `eta` | Otsu separability: between-class variance over total variance (0.5 to 0.97; low = the split cuts through one mode) |
| `water_frac`, `water_frac_otsu` | water share of valid pixels at the applied threshold and at the raw Otsu threshold (floor off) |
| `water_km2` | water pixels x 100 m² |
| `blue_median_dn` | median B02 DN of valid pixels, a haze screen |

`blue_median_dn` separates hazy months: clear Ucayali months sit at 190 to 500 DN, hazy ones at 550
to 2300; Lake Mead desert is 535 to 1500 and the screen does not apply there.

### Why the Ucayali floor is -0.15, not 0

Otsu on the Ucayali never finds water: the median threshold is -0.29 and it is below the floor in
116 of 117 months, because the AOI is dense forest (NDWI about -0.75) and Otsu separates forest from
everything else (bare bars, pasture, wet soil), labelling about 14 % of valid pixels as water against 9.6 %
with the floor. So the floor is the threshold on this reach, and its value matters. At 0.0 (the
usual NDWI convention) the main channel drops out of turbid months: sediment-laden water has green
close to nir. 2020-04 gave 4.4 % water against 8.1 % the month before and 8.6 % the month after
while the quicklook shows the main stem at NDWI near 0.

A sweep of the floor over the 83 Ucayali months with at least 90 % valid pixels (hazy ones included;
65 pairs of adjacent months) shows month-to-month noise in the water fraction at its minimum near
-0.15 to -0.2:

| NDWI floor | -0.30 | -0.20 | -0.15 | -0.10 | -0.05 | 0.00 |
|---|---|---|---|---|---|---|
| Mean water share of valid px | 10.5 % | 9.6 % | 9.2 % | 8.6 % | 8.0 % | 7.2 % |
| Std / mean over months | 0.14 | 0.11 | 0.11 | 0.13 | 0.14 | 0.19 |
| 90th percentile of the adjacent-month change | 1.8 pt | 1.2 pt | 1.1 pt | 1.3 pt | 1.7 pt | 2.1 pt |

The sweep measures stability, not accuracy: a lower floor also takes in wet sand and mixed bank
pixels (+28 % area from 0.0 to -0.15), and nothing here is ground truth. -0.15 is a choice that
removes the turbidity artifact; compare with the SWIR ensemble before using areas as numbers. The
Lake Mead default of 0.0 would be wrong for that desert land (land NDWI is about -0.2 there, so a
floor of -0.15 would label bare ground as water in a month without water); its Otsu is bimodal
(median eta 0.92) and the floor rarely binds.

## Categorical bands

Block-mean pyramids are right for continuous data and for fractions, and a 0/1 band must be stored as a
scaled fraction (0 and 10000 with scale 1e-4, units "fraction") or its coarse levels undercount,
because the integer block mean floors to 0 unless every pixel of the block is water. Stored as 0/1,
the Ucayali 2019-03 water share of valid pixels fell from 12.1 % at level 0 to 8.5 % at level 3; as a
fraction the valid-pixel-weighted share stays within 0.04 points of level 0.

## Checks

```bash
uv run chronozarr validate data/stores/ucayali_santa_maria/water-1
uv run chronozarr info data/stores/ucayali_santa_maria/water-1
uv run chronozarr doctor data/stores/ucayali_santa_maria/water-1
uv run python examples/water_masks/check_water_stack.py --aoi ucayali_santa_maria --month 2019-03
uv run python examples/water_masks/check_water_stack.py --aoi lake_mead --boa-offset-from 2022-02 --month 2021-11
```

- `validate`: both stores conform to chronozarr 0.2.0. `doctor`: 5 ok, 0 info, 0 warnings, 0 failures
  on each (one cell per level decoded and compared with a plain Zarr read).
- `xr.open_dataset(path, engine="chronozarr")`: variables `data` (time, band, y, x), `mask` and
  `coverage` (time, y, x, uint8). `mask` is a data variable here; it is a coordinate on
  `open_store(path).to_xarray()`. By default values are float32 physical values with NaN where the
  mask is 0 (NDWI in -1..1; checked: -0.92..0.99 and -1.00..1.00 over a month, NaN exactly where
  `mask` is 0). With `physical=False` the stored `int16` values appear. Scale, offset and units are
  not attributes of the xarray variable (spec 3.6: no CF `scale_factor`); they are in the store
  attributes, `open_store(path).attrs.bands` (ndwi 1e-4, 0, "index"; water 1e-4, 0, "fraction"), and
  are applied by `physical=True`, so `water` reads 0.0 or 1.0 at level 0 and a fraction at `lod` 1 to 3.
- Pixels against a direct numpy computation from the npz (month 2019-03 for Ucayali, 2021-11 for Lake
  Mead, using the month's threshold from the CSV): a water, a land and a masked pixel agree in
  `water`, stored `ndwi` and `mask`, for example Ucayali (1415, 1471): water 10000, ndwi 760, mask 1;
  Lake Mead (1764, 1304), a dark-water pixel: water 10000, ndwi 0, mask 1. The whole month agrees at
  every pixel (7.6 and 6.5 million), masked pixels hold 0.
- Level 1 `water` equals the floor mean of level 0 over valid pixels at every block (1.9 and 1.6
  million blocks), and fractions do occur: 40,238 blocks of Ucayali 2019-03 hold a value strictly
  between 0 and 1 at level 1, and 7,452 of Lake Mead 2017-03.

Water share of valid pixels by pyramid level, from the stored `water` at each `lod`. "Weighted" weights
each block by its valid level-0 pixels; "valid blocks" is the plain mean over the level's valid blocks,
which is what a click on an overview shows on average:

| | Level 0 | Level 1 | Level 2 | Level 3 |
|---|---|---|---|---|
| Ucayali 2019-03, weighted | 12.135 % | 12.133 % | 12.150 % | 12.171 % |
| Ucayali 2019-03, valid blocks | 12.135 % | 12.237 % | 12.341 % | 12.419 % |
| Lake Mead 2017-03, weighted | 16.310 % | 16.316 % | 16.298 % | 16.254 % |
| Lake Mead 2017-03, valid blocks | 16.310 % | 15.713 % | 15.461 % | 15.303 % |

The weighted share is the level-0 share up to the floor division of the integer mean (0.04 and 0.06
points at most). The plain mean over valid blocks drifts, +0.28 points (Ucayali) and -1.0 points (Lake
Mead) by level 3, and that is not rounding: a level's mask is the maximum over a block, so a block with
one valid pixel counts as a whole block and the edges of masked areas get more weight at coarse levels.
Weight by valid pixels, or measure areas at level 0 or from the CSV.

### Viewer

```bash
uv run --with rangehttpserver python -m RangeHTTPServer 8000      # from the repo root
cd js && node ../examples/water_masks/viewer_check.mjs --aoi ucayali_santa_maria --month 2019-03
cd js && node ../examples/water_masks/viewer_check.mjs --aoi lake_mead
```

Headless Chromium with software WebGL, `index.html?store=http://localhost:8000/data/stores/<aoi>/water-1`.
All checks pass on both stores:

- Opens with first paint between 55 and 700 ms over the runs; `int16`, mask present, 117 and 94
  timesteps (as in the CSV).
- Only "Single band" is enabled among the products (no red, green or nir band); the band selector offers
  `ndwi` and `water`.
- A masked pixel at level 0 draws the background colour (9, 12, 18); a valid pixel six pixels to its right
  does not.
- Click on a river pixel at level 0 (Ucayali 1035, 1035, Mar 2019): "ndwi 0.828 index, water 1
  fraction", stored 8279 and 10000; the same values come out of xarray. Lake Mead (1275, 1200,
  Mar 2017): 0.890, stored 8903, "water 1 fraction". A land pixel (Ucayali 1069, 1027) reads "water 0
  fraction", stored 0.
- A click on level 2 (the viewer at zoom 0.25; the inspector shows "Level 2 (4× coarser)") reads a
  fraction: Ucayali Mar 2019 "water 0.500 fraction", stored 5000; Lake Mead Mar 2017 "water 0.555
  fraction", stored 5555. Both equal the stored values at that level pixel read with xarray
  (`lod=2`) and with the reader.
- The chart of the level-0 pixel with the `water` band on screen is "water (fraction) over time": 92
  charted months, 90 of them at 1 (Ucayali), 25 gap months drawn as breaks. The chart of the level-2
  pixel plots fractions: 97 charted months, 68 of them strictly between 0 and 1.
- No console errors.

Screenshots in `data/reports/`: `viewer_ucayali_santa_maria_ndwi.png` (ndwi, May 2024, 40 % masked),
`viewer_ucayali_santa_maria_water_chart.png` (water, Mar 2019, inspector and chart),
`viewer_ucayali_santa_maria_water_coarse.png` (water, level 2 click reading 0.500 fraction),
`viewer_lake_mead_ndwi.png`, `viewer_lake_mead_water_chart.png`, `viewer_lake_mead_water_coarse.png`. Quicklooks of true colour, ndwi and
water for 9 months are `data/reports/water_<aoi>_<YYYY-MM>.png` (Ucayali 2016-04, 2017-05, 2019-11,
2019-12; Lake Mead 2016-01, 2017-02, 2017-03, 2018-04, 2022-01).

## Water fraction by year

Share of valid pixels that are water, yearly minimum and maximum over the well-observed months
(Ucayali: 90 % valid pixels and blue median at most 500 DN, 78 of 117 months; Lake Mead: 90 % valid
pixels, minus the mixed-baseline months 2021-12 and 2022-01, 82 of 94). Area in km² is the same
months' `water_km2`.

| Year | Ucayali months | Ucayali min % (month) | Ucayali max % (month) | km² |
|---|---|---|---|---|
| 2015 | 1 | 8.27 (11) | 8.27 (11) | 57.2 |
| 2016 | 5 | 6.74 (09) | 8.97 (06) | 50.9 to 68.0 |
| 2017 | 5 | 8.40 (10) | 9.53 (12) | 63.0 to 71.6 |
| 2018 | 7 | 8.16 (10) | 9.66 (07) | 62.1 to 73.3 |
| 2019 | 7 | 8.22 (08) | 12.13 (03) | 62.6 to 90.8 |
| 2020 | 10 | 7.96 (10) | 10.58 (03) | 60.7 to 80.6 |
| 2021 | 10 | 8.37 (10) | 10.90 (04) | 63.6 to 83.0 |
| 2022 | 9 | 8.49 (09) | 10.18 (05) | 63.5 to 77.7 |
| 2023 | 9 | 7.96 (10) | 9.93 (01) | 60.6 to 75.6 |
| 2024 | 6 | 8.01 (10) | 11.94 (03) | 61.1 to 83.1 |
| 2025 | 9 | 8.74 (01) | 11.20 (05) | 65.7 to 82.1 |

| Year | Lake Mead months | Lake Mead min % (month) | Lake Mead max % (month) | km² |
|---|---|---|---|---|
| 2015 | 2 | 14.99 (08) | 15.68 (09) | 97.1 to 102.6 |
| 2016 | 9 | 13.85 (06) | 15.06 (11) | 89.4 to 96.7 |
| 2017 | 10 | 14.67 (07) | 16.31 (03) | 95.0 to 99.8 |
| 2018 | 12 | 14.63 (07) | 16.16 (01) | 94.9 to 99.9 |
| 2019 | 11 | 13.64 (03) | 16.16 (02) | 87.4 to 100.4 |
| 2020 | 11 | 15.07 (03) | 16.19 (12) | 94.0 to 102.7 |
| 2021 | 11 | 14.31 (09) | 15.70 (01) | 92.7 to 97.8 |
| 2022 | 11 | 13.23 (08) | 14.29 (02) | 85.7 to 92.3 |
| 2023 | 5 | 13.21 (04) | 13.83 (01) | 86.2 to 89.4 |

The Ucayali series has a seasonal cycle (highest March to May, lowest August to October, 8 % to 12 %).
Lake Mead's share is higher in winter than its area in km² is, because winter shadow pixels are masked
and leave the lake a larger share of what is valid; prefer `water_km2` there.

## Candidate observations

Starting points to look at in the viewer, not conclusions.

**Ucayali**

1. Persistent bend migration. Compare the dry seasons (August to October) of 2016 and 2025 with the
   `water` band. Pixels that are water in more than half of the valid dry-season observations: 30.3 km²
   gained and 15.3 km² lost between the two (all pixels valid in both). The change is coherent, not
   speckle: crescents of gain on one bank and of loss on the other bank of the large bends (the
   lower-right bend and the central loop; a gain/loss map of 2016 to 2025 shows it). Gross change
   between consecutive dry seasons is 5 to 13 km², largest 2016 to 2017 (13.4 gained, 4.8 lost) and
   2024 to 2025 (12.7 gained, 2.8 lost); 2018 to 2019 and 2019 to 2020 lose more than they gain
   (10.0 and 9.5 lost).
2. When it happens. For the 455,661 pixels whose dry-season state differs between 2016 and 2025, a
   step fit of the monthly `water` series (at least 12 valid months on each side, at most 5 % misfit)
   dates 200,685 of them. Land-to-water steps run at 1.2 to 3.3 km² per year in 2017 to 2024 with no single
   dominant event; the largest month is 2022-03 (1.5 km², and 2022-02 has no mosaic, so it spans 2022-01 to
   2022-03), then 2024-11 (0.8), 2024-02 (0.7), 2021-02 (0.7), 2019-02 (0.6). Water-to-land steps
   cluster in June and July of 2018 to 2021 (0.2 km² in each of 2019-06 and 2019-07), which a falling
   dry-season stage would explain.
3. Largest month-to-month change in water area, well-observed adjacent months: 2023-01 to 2023-02
   (-13.6 km²), 2019-04 to 2019-05 (-12.7), 2020-12 to 2021-01 (+12.3), 2022-12 to 2023-01 (+11.8),
   2023-04 to 2023-05 (-11.4), 2016-08 to 2016-09 (-10.0). They are 14 to 18 % of the water area and
   probably stage (floodplain lakes and the tributary at the left filling and emptying), not planform;
   2023-02 has 92 % valid pixels, so part of that drop may be mask holes on the channel.
   Area differences are the wrong statistic for cutoffs: an abandoned channel stays water as an oxbow.
4. Months that look like events and are not: 2019-11 (6.1 %) then 2019-12 (12.2 %): cloud and shadow
   holes over the channel in November, haze and cloud edges counted as water in December (blue medians
   568 and 716 DN). 22 of 117 months have a blue median above 500 DN.

**Lake Mead**

1. Drawdown. The lake area in the AOI is flat from 2016 to 2021 (yearly means 93.8 to 98.5 km²) and
   then falls: 97.8 km² in 2021-03, 92.3 in 2022-02, 88.2 in 2022-06, 86.5 in 2022-08, about 86 through
   2023-04. The decline is smooth between 2022-02 and 2022-08, which uses the offset-corrected months.
2. Reversal. 86.2 km² in 2023-04 to 89.4 in 2023-05 (+3.2 km², 13.2 % to 13.7 %); 2023-06 has 72 %
   valid pixels and a share of 17.3 % that is not comparable, and the mosaics after it are dead.
3. Winter months with dark water (2015-12, 2016-01, 2016-02, 2020-01, 2021-11, 2021-12): the lake is
   DN 1 in every band and is carried by the dark rule. Look at their ndwi (about 0 over the lake) and
   `water` side by side.
4. Not events: 2022-01 (71.2 km², -20 km² from 2021-12) is a mix of processing baselines, with patches
   at NDWI near 0 and scene-boundary rectangles; 2019-03 (87.4 km², against 95.3 and 97.9 around it) has
   a pale haze or cloud patch over the lake that NDWI reads as land.

## What this stack cannot show

- **NDWI only.** No SWIR band (the mosaics are B02, B03, B04, B08). NDWI is high for clear water and
  near 0 for turbid water, shallow water over sand, and dark pixels at the DN floor; it is also raised
  by haze and thin cloud. The Ucayali floor and the Lake Mead dark rule are patches over those cases,
  not fixes.
- **Cloud gaps.** The mask marks only pixels where no scene was valid. SCL classes 4, 5, 6, 7 and 11
  pass, and class 7 (unclassified) lets haze and thin cloud through, so hazy months carry false water
  and missed water (2019-12, 2019-03 Lake Mead). Ucayali has 14 months with fewer than half the pixels
  observed, 6 with fewer than 20 %. Water fractions are shares of valid pixels, so a cloud over the
  channel changes them.
- **Composite blur.** Each month is a per-pixel median of the month's valid scenes. A pixel that
  changed during the month takes the majority state; the stack has no sub-monthly timing, and a bar or
  bank that moves between scenes can appear as a mixture.
- **Mosaic problems you inherit** (below), and `coverage` as a flag, not a scene count.
- **Overview levels of `water` are block fractions, not a mask.** A zoomed-out click reads the
  fraction of the block's valid pixels that are water, and averaging a level over its valid blocks
  differs from the level-0 share where blocks are partly valid (table under "Checks"). Measure areas
  at level 0 or from the CSV.
- **Ground truth.** Nothing was compared with an independent water map.

### What the sword-water-masks ensemble adds

`/Users/jakegearon/projects/sword-water-masks` (`water_ensemble.py`) votes six methods per pixel,
`min_votes` 4 of 6: NDWI, MNDWI (green and SWIR1), AWEI_nsh and AWEI_sh (SWIR1 and SWIR2, the second with
a shadow correction), ML4Floods and DeepWaterMap (which also read SWIR). The SWIR indices are what
separate turbid river water, which is near NDWI 0, from bare sand and wet soil, and AWEI_sh keeps
shadow from reading as water; the two networks need more bands than B02 to B08. Its SCL bad-pixel set
also masks cloud shadow and thin cirrus, which the mosaics let through, and it has centerline
extraction and stable/new/abandoned change classes, which is the bend-migration question above done
properly. Its NDWI member uses a fixed threshold of 0, which is the floor used here for Lake Mead. To
run it on these reaches the ingest would need B11 and B12 (20 m, resampled to 10 m) added to the monthly
mosaics, about 1.5 times the stored bytes for six bands instead of four, and a rerun of the download.

## Problems in the mosaics

Found while building; the mosaics were not modified.

- **Lake Mead 2023-07 to 2026-03 are copies of 2023-06.** Each of the 33 files matches its
  predecessor (compared at every seventh pixel) and has coverage 0 everywhere. The ingest wrote them on
  2026-04-19, before the signed-URL fix of a21e68f, which is the failure `.napkin.md` describes for
  Ucayali (later months carried forward after the token expired). 2023-06 itself is only 72 % valid
  and its mean coverage is 0.04 against 0.3 to 0.5 in other months, so it is probably cut short too.
  To recover: move `2023-06.npz` to `2026-03.npz` out of `data/mosaics/lake_mead/`, rerun
  `examples/sentinel2_pc/ingest.py --aoi lake_mead` (it skips months whose file exists), then rebuild.
  Until then the store ends in 2023-06. Appending the recovered months to this store would rewrite
  its single whole-axis shard per cell (spec 14); a store built to grow should be unsharded,
  which is the encoder default now.
- **Lake Mead from 2022-02 still carries the +1000 DN processing-baseline offset.** Band medians jump
  by about 1100 DN between 2022-01 and 2022-02 (B02 1166 to 2122) in every band; Ucayali, corrected,
  does not. NDWI is not invariant to an additive offset: the 99th percentile of NDWI went from 0.89 to
  0.99 before 2022 to 0.09 to 0.10 after. The build corrects it with `--boa-offset-from 2022-02`. 2021-12 and 2022-01 are mixed months (scenes from both
  baselines under one per-pixel median) and cannot be corrected; they are in the store, and 2022-01
  has a water fraction of 11.2 % against 14 to 15 % around it.
- **Lake Mead mosaics have DN 1 over dark winter water** (see dark pixels above). Not a mosaic fault;
  the L2A floor.
- **Ucayali has 7 months without a mosaic inside its range** (2015-12 to 2016-03, 2017-04, 2017-06,
  2022-02), so the time axis has gaps; the viewer labels each step by its month.

## Findings about the tools

- By the viewer's code (`isReflectance` in `products.js`), a band with `scale` 1e-4 and no `units` is
  reflectance (tone mapped, four decimals), so these bands carry `units` "index" and "fraction". The
  sidebar prints them after the value ("0.828 index", "1 fraction").
- Only "Single band" is enabled for a store without red, green and nir bands, so there is no
  water-coloured product; `water` is drawn as a grey ramp, black and white at level 0, grey where an
  overview block is part water.
- With a linear stretch, forest at the low end of the ndwi stretch draws near black (7, 7, 7) next to
  masked pixels at the background (9, 12, 18); in the screenshots masked areas are hard to tell from
  low values except at their outlines.
- `coverage` of 0/1 is shown as "Observed by 1 scene", a count label for a flag. At coarse levels
  coverage is the rounded mean of the flag, so a valid block with fewer than half its pixels
  observed reads "no scene (gap-filled)" (Lake Mead level 2, 2017-03, with water 0.555).
- `xr.open_dataset(engine="chronozarr")` returns both bands as one float32 `data` variable, so `water`
  is 0.0 or 1.0 at level 0 (a fraction at `lod` 1 to 3) and NaN where masked; `physical=False` gives
  the stored integers.
