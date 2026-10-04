# Sentinel-2 ingest example

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

Builds a chronozarr store from Sentinel-2 L2A scenes on Microsoft Planetary Computer. It is an
example of producing input for `chronozarr.encode`; it is not part of the `chronozarr` package.

## What it does

`ingest.py` runs two phases for one AOI from `aois.yaml`:

1. **Download.** STAC search (`eo:cloud_cover < 80`), then for each calendar month a median
   composite of B02, B03, B04, B08 at 10 m in the AOI's UTM zone. Pixels whose SCL class is not
   4, 5, 6, 7 or 11, or where any band is 0, are excluded from the median. Pixels with no valid
   scene are filled from the previous month's composite (`carry_forward` in `mosaic.py`); a
   pixel with no earlier valid month stays 0 (nodata). Months that already have an `.npz` are
   skipped, so an interrupted download resumes.
2. **Encode.** Stacks the monthly `.npz` files into a `(time, band, y, x)` uint16 array (the
   whole stack is held in memory) and writes it with `chronozarr.encode` using default options
   (v0.3 writes true stored values). The store also
   records:
   - band metadata: name, `common_name` (blue, green, red, nir) and `scale` 0.0001, so
     reflectance = stored value * 0.0001;
   - a `coverage` plane, uint8 per pixel and month: 1 where at least one scene was valid, 0 where
     the value is carried forward from the previous month or missing. The monthly files store
     the valid fraction, not the scene count, so this is a flag, not a count;
   - `provenance`: the Planetary Computer collection, `composite` "monthly median", `gap_fill`
     "carry-forward", and notes on the cloud mask and the baseline 04.00 offset correction.
3. **STAC (optional, `--stac`).** Writes a static STAC Collection and Item next to the store, the
   same output as `chronozarr stac`: extent, Zarr asset, bands, the datacube extension and the
   provenance above.

Planetary Computer asset URLs are signed by `planetary-computer` without an API key.

## Layout

```
<out-dir>/                      default: <repo>/data
  mosaics/<aoi>/YYYY-MM.npz     one file per month
  stores/<aoi>/chronozarr/      chronozarr store
  stores/<aoi>/stac/            with --stac: collection.json and <aoi>-sentinel-2-monthly/*.json
```

Each `YYYY-MM.npz` holds:

| key          | dtype   | shape        | content                                        |
| ------------ | ------- | ------------ | ---------------------------------------------- |
| `bands`      | uint16  | (4, H, W)    | monthly median reflectance, 0 = nodata         |
| `coverage`   | float32 | (H, W)       | fraction of the month's scenes valid per pixel |
| `transform`  | float64 | (6,)         | affine coefficients (a, b, c, d, e, f)         |
| `epsg`       | int     | scalar       | EPSG code of the UTM grid                      |
| `band_names` | str     | (4,)         | `B02 B03 B04 B08`                              |

The file name gives the time coordinate (`2024-01.npz` becomes 2024-01-01). All months of an
AOI must share the same grid, CRS and bands; the encode phase raises if they do not.

## Commands

Run from the repository root.

```bash
uv sync --extra ingest

# full archive (2015-07 to 2026-04) for one AOI, download + encode
uv run python examples/sentinel2_pc/ingest.py --aoi sahara_tamanrasset

# one month into a scratch directory
uv run python examples/sentinel2_pc/ingest.py --aoi sahara_tamanrasset \
    --start 2024-01-01 --end 2024-01-31 --out-dir /tmp/ingest_smoke

# encode existing mosaics only
uv run python examples/sentinel2_pc/ingest.py --aoi sahara_tamanrasset --skip-download

# encode existing mosaics and write the STAC catalog beside the store
uv run python examples/sentinel2_pc/ingest.py --aoi sahara_tamanrasset --skip-download --stac

# check the result
uv run chronozarr doctor data/stores/sahara_tamanrasset/chronozarr
```

AOI names are the keys under `aois:` in `aois.yaml`. A chronozarr store is immutable: if
`stores/<aoi>/chronozarr` already exists the script exits before downloading; delete the
directory to re-encode.
