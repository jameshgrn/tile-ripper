"""Export decoded timesteps of a store as Cloud Optimized GeoTIFFs for GDAL and QGIS.

Each file holds every band of one timestep at one pyramid level, with true stored values,
so the values are the stored true values in the store's dtype (or, with `physical`, float32
physical values). Validity, scale, offset, units and band names become GeoTIFF metadata that GDAL
and QGIS read without chronozarr. `coverage` is not exported. Needs rasterio (`chronozarr[geo]`).

Rules, which keep every pixel's validity and value exactly as the store reads it:

1. Stored values (default). Dtype, values, `scales`, `offsets`, `units` and `descriptions`
   (band names) are written per band. A GDAL reader applies scale and offset itself.
2. A store with a `mask` gets a per-dataset internal GeoTIFF mask, 255 where the mask is 1, so a
   valid pixel is valid whatever its value and an invalid pixel is invalid whatever its value.
   The store's nodata is also written, but only when no valid pixel of that timestep holds that
   value; otherwise it is left out, because GDAL readers that look at nodata would hide valid
   data.
3. A store without a mask whose nodata is a number keeps nodata: the GeoTIFF nodata is that
   value, no mask is written, and GDAL judges each band as the store does. A store with neither
   writes neither (every pixel is valid; a stored 0 is data).
4. `physical`: float32 values `stored * scale + offset`, NaN where the pixel is invalid, written
   with nodata NaN. Scale and offset are not written again (the values already include them);
   `units` and `descriptions` are. A store's mask is written as in rule 2.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from chronozarr.decode import ChronoStore, open_store

_DATE_PREFIX = re.compile(r"^\d{4}-\d{2}(-\d{2}([T ][\d:.]*Z?)?)?$")


def select_times(spec: Sequence[str], times: Sequence[str]) -> list[int]:
    """Timestep indices picked by `spec`; all of them when `spec` is empty.

    Tokens (comma separated inside one item, or several items) are any of: `all`; an integer
    index (negative counts from the end); an index slice `start:stop[:step]` (stop exclusive);
    an ISO date prefix of at least year and month, `2024-03` or `2024-03-15`, selecting every
    timestep inside that period; or an inclusive range of such prefixes, `2020-01..2022-06`.
    `times` are the store's ISO-8601 timestamps. Raises ValueError naming the bad token.
    """
    n = len(times)
    tokens = [t.strip() for item in spec for t in item.split(",") if t.strip()]
    if not tokens:
        return list(range(n))
    chosen: set[int] = set()
    for token in tokens:
        if token == "all":
            chosen.update(range(n))
        elif ".." in token:
            start, _, end = token.partition("..")
            if not (_DATE_PREFIX.match(start) and _DATE_PREFIX.match(end)):
                raise ValueError(
                    f"bad time range '{token}': use ISO date prefixes like 2020-01..2022-06"
                )
            start, end = start.replace(" ", "T"), end.replace(" ", "T")
            chosen.update(
                i for i, t in enumerate(times) if t[: len(start)] >= start and t[: len(end)] <= end
            )
        elif _DATE_PREFIX.match(token):
            matches = [i for i, t in enumerate(times) if t.startswith(token.replace(" ", "T"))]
            if not matches:
                raise ValueError(
                    f"no timestep matches '{token}' (store spans {times[0]} to {times[-1]})"
                )
            chosen.update(matches)
        elif ":" in token:
            try:
                parts = [int(p) if p else None for p in token.split(":")]
                chosen.update(range(n)[slice(*parts)])
            except (ValueError, TypeError) as exc:
                raise ValueError(
                    f"bad index slice '{token}': use start:stop[:step] with integers"
                ) from exc
        elif re.fullmatch(r"-?\d+", token):
            index = int(token)
            if not -n <= index < n:
                raise ValueError(f"time index {index} out of range: the store has {n} timesteps")
            chosen.add(index % n)
        else:
            raise ValueError(
                f"cannot parse time selector '{token}': use an index, start:stop[:step], "
                "an ISO date prefix such as 2024-03, a range A..B, or all"
            )
    if not chosen:
        raise ValueError(f"no timesteps selected by {list(spec)}")
    return sorted(chosen)


def _file_stem(iso: str) -> str:
    """`2024-03-01` for midnight timestamps, `2024-03-01T120000Z` otherwise."""
    date, _, clock = iso.partition("T")
    if not clock or clock.rstrip("Z").replace(":", "").strip("0.") == "":
        return date
    return f"{date}T{clock.rstrip('Z').replace(':', '')}Z"


def _band_metadata(store: ChronoStore) -> list[tuple[str, float, float, str | None]]:
    """(name, scale, offset, units) per band, for v0.1 string bands and v0.2 band objects."""
    out = []
    for band in store.attrs.bands:
        if isinstance(band, str):
            out.append((band, 1.0, 0.0, None))
        else:
            scale = getattr(band, "scale", None)
            out.append(
                (
                    str(band.name),
                    float(1.0 if scale is None else scale),
                    float(getattr(band, "offset", None) or 0.0),
                    getattr(band, "units", None),
                )
            )
    return out


def _nodata_tag(
    nodata: int | float | None, values: np.ndarray, plane: np.ndarray | None
) -> int | float | None:
    """The GeoTIFF nodata for stored `values` (band, y, x): the store's nodata, unless the store
    has a mask `plane` (y, x) and a valid pixel holds that value."""
    if nodata is None:
        return None
    if plane is not None and (values[:, plane > 0] == nodata).any():
        return None
    return nodata


def export_cog(
    store: ChronoStore | str | Path,
    out_dir: str | Path,
    *,
    level: int = 0,
    times: Sequence[int] | None = None,
    physical: bool = False,
) -> list[Path]:
    """Write one COG per timestep into `out_dir` and return the paths, in time order.

    `store` is an opened store, a local path or an https URL. Files are named
    `L<level>_<date>.tif`. One timestep of the level is held in memory at a time, so pick a
    coarser `level` for very large stores. An existing file of the same name is an error.
    `physical` writes float32 physical values instead of the stored values; see the module
    docstring for how validity, scale and offset are written.
    """
    import rasterio
    import rasterio.shutil  # ty: ignore[unresolved-import]  # compiled module, no stub
    from rasterio.io import MemoryFile
    from rasterio.transform import Affine

    opened = store if isinstance(store, ChronoStore) else open_store(store)
    if not 0 <= level < len(opened.levels):
        raise ValueError(
            f"level {level} out of range: store has levels 0..{len(opened.levels) - 1}"
        )
    selected = list(range(len(opened.times))) if times is None else [int(t) for t in times]
    lod = opened.levels[level]
    bands = _band_metadata(opened)
    iso_times = opened.attrs.times
    out = Path(out_dir)
    targets = [out / f"L{level}_{_file_stem(iso_times[t])}.tif" for t in selected]
    clashes = [p for p in targets if p.exists()]
    if clashes:
        raise FileExistsError(
            f"{len(clashes)} output file(s) already exist, for example {clashes[0]}; "
            "choose an empty out_dir"
        )
    out.mkdir(parents=True, exist_ok=True)

    for t, target in zip(selected, targets, strict=True):
        plane = opened.read_mask(t, level)
        tag: Any
        if physical:
            values = np.asarray(opened.physical(t, level))
            tag = float("nan")
        else:
            values = np.asarray(opened.read(t, level))
            tag = _nodata_tag(opened.attrs.nodata, values, plane)
        n_band, height, width = values.shape
        with MemoryFile() as memory:
            with memory.open(
                driver="GTiff",
                width=width,
                height=height,
                count=n_band,
                dtype=values.dtype,
                crs=opened.attrs.crs,
                transform=Affine(*lod.transform),
                nodata=tag,
                tiled=True,
                blockxsize=512,
                blockysize=512,
            ) as dst:
                dst.write(values)
                if plane is not None:
                    dst.write_mask(np.where(plane > 0, 255, 0).astype(np.uint8))
                dst.descriptions = [name for name, *_ in bands]
                if not physical:
                    dst.scales = [scale for _, scale, _, _ in bands]
                    dst.offsets = [offset for _, _, offset, _ in bands]
                if any(units for *_, units in bands):
                    dst.units = [units or "" for *_, units in bands]
                dst.update_tags(
                    CHRONOZARR_TIME=iso_times[t],
                    CHRONOZARR_LEVEL=str(level),
                    CHRONOZARR_TIMESTEP=str(t),
                )
            with memory.open() as src:
                rasterio.shutil.copy(
                    src,
                    target,
                    driver="COG",
                    compress="DEFLATE",
                    predictor="YES",
                    blocksize=512,
                    overview_resampling="AVERAGE",
                )
    return targets
