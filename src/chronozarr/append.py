"""Append true-value timesteps using a validated working copy before publication."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import warnings
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr
import zarr
from zarr.errors import ZarrUserWarning

from chronozarr import schema
from chronozarr._writer import (
    DEFAULT_CELLS_IN_FLIGHT,
    VOLATILITY_SCALE,
    Block,
    _ArraySource,
    _CellWriter,
    _Input,
    _iso_times,
    _LevelArrays,
    _mean_comparison,
    _prepare_input,
    _Pyramid,
    _resolve_bands,
    _resolve_transform,
    _shard_bytes,
    _Source,
    _spill_timesteps,
    _write_time_coord,
)
from chronozarr.decode import ChronoStore, open_store
from chronozarr.schema import Band, Chronozarr, LevelRef, SchemaError, Transform

# A `none` store does not record the nominal schedule its volatility was computed against
# (spec 5); appended timesteps use the writer default.
COMPARISON_INTERVAL = 6


@dataclass(frozen=True)
class AppendReport:
    n_appended: int
    n_time: int  # timesteps in the store after the append
    objects_written: int  # files created or rewritten, metadata included
    bytes_written: int  # their total size
    seconds: float


def is_store(path: str | Path) -> bool:
    """True when `path` is a local directory whose root group carries a `chronozarr` block."""
    manifest = Path(path) / "zarr.json"
    if not manifest.is_file():
        return False
    try:
        attributes = json.loads(manifest.read_text()).get("attributes", {})
    except (OSError, ValueError):
        return False
    return isinstance(attributes, dict) and "chronozarr" in attributes


# --- The store being appended to ---------------------------------------------------------------


@dataclass
class _Target:
    path: Path
    root: zarr.Group
    meta: Chronozarr
    datasets: tuple[LevelRef, ...]
    groups: list[zarr.Group]
    arrays: list[_LevelArrays]

    @property
    def n_time(self) -> int:
        return len(self.meta.times)

    @property
    def transform(self) -> Transform:
        return schema.parse_level_attrs(self.groups[0].attrs.asdict(), "level 0").transform

    @property
    def chunk_size(self) -> int:
        return schema.cell_size(self.arrays[0].data, "level 0/data")

    @property
    def shapes(self) -> list[tuple[int, int]]:
        return [(a.data.shape[2], a.data.shape[3]) for a in self.arrays]


def _open_target(store: str | Path) -> _Target:
    path = Path(store)
    if not path.is_dir():
        raise ValueError(f"{store} is not a local directory; append works on a local store")
    problems = schema.validate(path)
    if problems:
        shown = "\n  ".join(problems[:5])
        more = f"\n  ... and {len(problems) - 5} more" if len(problems) > 5 else ""
        raise ValueError(
            f"{store} does not validate, so nothing was appended:\n  {shown}{more}\n"
            "If an earlier append was interrupted, restore the store from its published copy."
        )
    root = zarr.open_group(path, mode="r+", zarr_format=3, use_consolidated=False)
    parsed = schema.parse_root_attrs(root.attrs.asdict())
    meta = parsed.chronozarr
    groups = [schema.get_group(root, d.path, "store") for d in parsed.datasets]
    arrays = []
    for group in groups:
        data = schema.get_array(group, meta.variable, "store")
        mask = (
            None
            if meta.mask_variable is None
            else schema.get_array(group, meta.mask_variable, "store")
        )
        coverage = (
            None
            if meta.coverage_variable is None
            else schema.get_array(group, meta.coverage_variable, "store")
        )
        arrays.append(_LevelArrays(data, mask, coverage))
    return _Target(path, root, meta, parsed.datasets, groups, arrays)


# --- The new timesteps --------------------------------------------------------------------------


@dataclass
class _Request:
    """What the caller passed, reduced to one description for `_prepare_input` and the checks."""

    data: Any
    times: Any
    mask: Any
    coverage: Any
    crs: str | None
    transform: Sequence[float] | None
    bands: Sequence[str | Band | Mapping] | None
    strict_bands: bool  # compare band metadata (scale, offset, units), not just names
    nodata: Any = "unchecked"


def _request_from_store(source: str | Path | ChronoStore) -> _Request:
    """Every timestep of a chronozarr store (for example one written by `convert`), level 0."""
    store = source if isinstance(source, ChronoStore) else open_store(source)
    count = len(store.times)
    level0 = store.levels[0]
    return _Request(
        data=(store.read(t) for t in range(count)),
        times=store.times,
        mask=None if level0.mask is None else (store.read_mask(t) for t in range(count)),
        coverage=None
        if level0.coverage is None
        else (store.read_coverage(t) for t in range(count)),
        crs=store.attrs.crs,
        transform=level0.transform,
        bands=store.attrs.bands,
        strict_bands=True,
        nodata=store.nodata,
    )


def _mismatches(
    target: _Target, request: _Request, prepared: _Input, times_ms: np.ndarray
) -> list[str]:
    """Every way the new data differs from the store; empty when it can be appended."""
    meta = target.meta
    found: list[str] = []
    height, width = target.shapes[0]
    if (prepared.height, prepared.width) != (height, width):
        found.append(
            f"grid: the input is {prepared.height} x {prepared.width} pixels, the store's "
            f"level 0 is {height} x {width}"
        )
    if prepared.dtype != target.arrays[0].data.dtype:
        found.append(
            f"dtype: the input is {prepared.dtype}, the store is {target.arrays[0].data.dtype} "
            "(chronozarr never converts dtype)"
        )
    crs = request.crs if request.crs is not None else prepared.attrs.get("crs")
    if crs is not None and str(crs) != meta.crs:
        found.append(f"crs: the input is {str(crs)!r}, the store is {meta.crs!r}")

    georeferenced = request.transform is not None or (
        prepared.da is not None
        and (
            "transform" in prepared.da.attrs
            or ("x" in prepared.da.coords and "y" in prepared.da.coords)
        )
    )
    if georeferenced:
        given: Transform = _resolve_transform(request.transform, prepared.da)
        if not schema.same_numbers(given, target.transform):
            found.append(
                f"transform: the input's is {list(given)}, the store's is {list(target.transform)}"
            )

    if prepared.n_band != len(meta.bands):
        found.append(f"bands: the input has {prepared.n_band}, the store has {len(meta.bands)}")
    elif request.bands is not None or prepared.band_coords is not None:
        given_bands = _resolve_bands(request.bands, prepared.band_coords, prepared.n_band)
        for new, old in zip(given_bands, meta.bands, strict=True):
            if _band_conflict(new, old, strict=request.strict_bands):
                found.append(
                    f"bands: the input has {_band_text(new)}, the store has {_band_text(old)}"
                )
                break

    if (prepared.mask is None) != (meta.mask_variable is None):
        found.append(
            "mask: the store has a mask, so the input needs one validity plane per timestep"
            if meta.mask_variable
            else "mask: the store has no mask and append cannot add one; leave the mask out"
        )
    if (prepared.coverage is None) != (meta.coverage_variable is None):
        found.append(
            "coverage: the store has coverage, so the input needs one plane per timestep"
            if meta.coverage_variable
            else "coverage: the store has no coverage and append cannot add it; leave it out"
        )
    if not isinstance(request.nodata, str) and request.nodata != meta.nodata:
        found.append(f"nodata: the input has {request.nodata!r}, the store has {meta.nodata!r}")

    last = schema.parse_time(meta.times[-1])
    first_new = times_ms[0].astype("datetime64[ms]")
    if first_new <= last:
        found.append(
            f"times: the input starts at {np.datetime_as_string(first_new, unit='ms')}Z, "
            f"which is not after the store's last time {meta.times[-1]}"
        )
    return found


def _band_conflict(new: Band, old: Band, *, strict: bool) -> bool:
    """Whether `new` cannot continue the band `old`.

    Names must match. When `new` carries metadata (always, if `strict`), the physical meaning must
    agree: scale and offset after their defaults (1 and 0), and common name and units when both
    sides give one.
    """
    if new.name != old.name:
        return True
    if not strict and new == Band(new.name):
        return False
    scale = (1.0 if new.scale is None else new.scale, 1.0 if old.scale is None else old.scale)
    offset = (0.0 if new.offset is None else new.offset, 0.0 if old.offset is None else old.offset)
    return (
        scale[0] != scale[1]
        or offset[0] != offset[1]
        or (None not in (new.units, old.units) and new.units != old.units)
        or (None not in (new.common_name, old.common_name) and new.common_name != old.common_name)
    )


def _band_text(band: Band) -> str:
    extras = {
        k: v
        for k, v in band.to_attrs().items()
        if k != "name" and not (k == "scale" and v == 1.0) and not (k == "offset" and v == 0.0)
    }
    return f"{band.name!r}" + (f" {extras}" if extras else "")


@dataclass(frozen=True)
class _Plan:
    old_n: int
    new_n: int


def _plan(target: _Target, n_new: int) -> _Plan:
    return _Plan(target.n_time, target.n_time + n_new)


@dataclass(frozen=True)
class _CellDone:
    seconds: float


def _append_cell(
    block: Block, arrays: _LevelArrays, ys: slice, xs: slice, plan: _Plan
) -> _CellDone:
    started = time.perf_counter()
    arrays.data[plan.old_n : plan.new_n, :, ys, xs] = block.data
    if arrays.mask is not None and block.mask is not None:
        arrays.mask[plan.old_n : plan.new_n, ys, xs] = block.mask
    if arrays.coverage is not None and block.coverage is not None:
        arrays.coverage[plan.old_n : plan.new_n, ys, xs] = block.coverage
    return _CellDone(time.perf_counter() - started)


# --- Metadata ------------------------------------------------------------------------------------


def _update_volatility(target: _Target, plan: _Plan) -> None:
    if target.meta.volatility_path is None:
        return
    array = schema.get_array(target.root, target.meta.volatility_path, "store")
    cs = target.chunk_size
    updated = np.zeros(array.shape, dtype=np.float32)
    reference = schema.comparison_schedule(plan.new_n, COMPARISON_INTERVAL)
    for row in range(array.shape[0]):
        for col in range(array.shape[1]):
            block = np.asarray(
                target.arrays[0].data[:, :, row * cs : (row + 1) * cs, col * cs : (col + 1) * cs]
            )
            total, count = _mean_comparison(block, reference)
            updated[row, col] = np.clip(total / count / VOLATILITY_SCALE, 0, 1) if count else 0
    array[:] = updated


def _commit_metadata(
    target: _Target, plan: _Plan, times_iso: list[str], times_ms: np.ndarray
) -> None:
    """Time arrays, root attributes and consolidated metadata for the longer axis."""
    meta = target.meta
    all_ms = np.concatenate(
        [
            np.array([schema.parse_time(t) for t in meta.times], dtype="datetime64[ms]").astype(
                np.int64
            ),
            times_ms,
        ]
    )
    for group in target.groups:
        _write_time_coord(group, all_ms, overwrite=True)

    levels = (
        None
        if meta.levels is None
        else tuple(replace(lv, shape=(plan.new_n, *lv.shape[1:])) for lv in meta.levels)
    )
    shard_bytes = (
        None
        if meta.shard_bytes is None
        else _shard_bytes(target.path, len(target.datasets), target.meta.variable)
    )
    updated = replace(
        meta,
        times=(*meta.times, *times_iso),
        levels=levels,
        shard_bytes=shard_bytes,
    )
    # `multiscales` is not rewritten: it stays byte-identical (spec 14), so a store published
    # with `pixels_per_tile` keeps it.
    target.root.attrs.update({"chronozarr": updated.to_attrs()})
    with warnings.catch_warnings():
        # Consolidated metadata is deliberate (spec 3.1); see encode._write_store.
        warnings.simplefilter("ignore", ZarrUserWarning)
        zarr.consolidate_metadata(str(target.path))


# --- Entry point ---------------------------------------------------------------------------------


def _snapshot(path: Path) -> dict[str, tuple[int, int]]:
    """(size, mtime_ns) of every file under `path`, by relative path."""
    entries = {}
    for root, _, files in os.walk(path):
        for name in files:
            full = Path(root, name)
            stat = full.stat()
            entries[str(full.relative_to(path))] = (stat.st_size, stat.st_mtime_ns)
    return entries


def _append_in_place(
    store: str | Path,
    data: xr.DataArray | Iterable[np.ndarray] | str | Path | ChronoStore,
    *,
    times: Sequence | np.ndarray | None = None,
    crs: str | None = None,
    transform: Sequence[float] | None = None,
    bands: Sequence[str | Band | Mapping] | None = None,
    mask: object = None,
    coverage: object = None,
    workers: int | None = None,
    spill_dir: str | Path | None = None,
) -> AppendReport:
    """Append timesteps to the end of the chronozarr v0.3 store at `store`, in place.

    Args:
        store: A local store directory that validates.
        data: Either a DataArray with dims (time, band, y, x) like `encode` takes, an iterable of
            per-timestep (band, y, x) arrays (needs `times`), or a chronozarr store (a path or a
            `ChronoStore`, for example one month written by `convert`), whose every timestep is
            appended. A store carries its own times, mask, coverage, CRS, grid and bands, so
            none of the other arguments may be given with it.
        times: datetime64 timestamps, strictly increasing and after the store's last time
            (iterable input only).
        crs, transform, bands: Optional, and compared with the store when given or carried by a
            DataArray (attributes, coordinates, band coordinate). The store's own are used.
        mask, coverage: Required exactly when the store has them: one plane per timestep, shaped
            as for `encode`.
        workers: Cells written concurrently (default 4).
        spill_dir: Directory for the temp files of iterable input. Default: next to `store`.

    The input must match the store's grid, bands, dtype, CRS and nodata; a mismatch raises a
    ValueError listing every difference and leaves the store untouched. Only the shards (or
    chunks of an unsharded store) that gain a timestep are written; the other objects keep their
    bytes. See the module docstring for what happens when the append fails midway.
    """
    started = time.perf_counter()
    cells_in_flight = workers if workers is not None else DEFAULT_CELLS_IN_FLIGHT
    if cells_in_flight < 1:
        raise ValueError(f"workers must be >= 1, got {cells_in_flight}")
    target = _open_target(store)

    if isinstance(data, str | Path | ChronoStore):
        if any(given is not None for given in (times, crs, transform, bands, mask, coverage)):
            raise ValueError(
                "a chronozarr store carries its own times, grid, bands, mask and coverage; "
                "pass only the store"
            )
        request = _request_from_store(data)
    else:
        request = _Request(data, times, mask, coverage, crs, transform, bands, strict_bands=False)

    prepared = _prepare_input(request.data, request.times, request.mask, request.coverage)
    times_iso, times_ms = _iso_times(prepared.times)
    if len(times_iso) != prepared.n_time:
        raise ValueError(f"{len(times_iso)} times for {prepared.n_time} timesteps")
    problems = _mismatches(target, request, prepared, times_ms)
    if problems:
        listed = "\n  - ".join(problems)
        raise ValueError(f"cannot append to {store}: the input does not match it:\n  - {listed}")

    plan = _plan(target, prepared.n_time)
    spill: Path | None = None
    try:
        if prepared.da is not None:
            source: _Source = _ArraySource(
                prepared.da,
                prepared.mask if isinstance(prepared.mask, xr.DataArray) else None,
                prepared.coverage if isinstance(prepared.coverage, xr.DataArray) else None,
                target.chunk_size,
            )
        else:
            spill = Path(
                tempfile.mkdtemp(
                    prefix=f".{target.path.name}-spill-",
                    dir=str(spill_dir) if spill_dir else target.path.parent,
                )
            )
            source = _spill_timesteps(
                prepared,
                spill,
                chunk_size=target.chunk_size,
                has_mask=target.meta.mask_variable is not None,
                has_coverage=target.meta.coverage_variable is not None,
            )
        before = _snapshot(target.path)
        try:
            _write(target, plan, prepared, source, times_iso, times_ms, cells_in_flight)
        except BaseException as exc:
            exc.add_note(
                f"{target.path} may be partly modified; restore it from its published copy "
                "before appending again"
            )
            raise
    finally:
        if spill is not None:
            shutil.rmtree(spill, ignore_errors=True)

    after = _snapshot(target.path)
    written = [key for key, state in after.items() if before.get(key) != state]
    return AppendReport(
        n_appended=prepared.n_time,
        n_time=plan.new_n,
        objects_written=len(written),
        bytes_written=sum(after[key][0] for key in written),
        seconds=time.perf_counter() - started,
    )


def _write(
    target: _Target,
    plan: _Plan,
    prepared: _Input,
    source: _Source,
    times_iso: list[str],
    times_ms: np.ndarray,
    cells_in_flight: int,
) -> None:
    for level in target.arrays:
        for array in (level.data, level.mask, level.coverage):
            if array is not None:
                array.resize((plan.new_n, *array.shape[1:]))

    cs = target.chunk_size
    writer = _CellWriter[_CellDone](cells_in_flight)
    compute = ThreadPoolExecutor(max_workers=os.cpu_count() or 1)
    pyramid = _Pyramid(
        target.shapes,
        cs,
        n_time=prepared.n_time,
        n_band=prepared.n_band,
        dtype=prepared.dtype,
        nodata=target.meta.nodata,
        source=source,
        compute=compute,
    )

    def submit(k: int, row: int, col: int, block: Block) -> None:
        ys = slice(row * cs, row * cs + block.height)
        xs = slice(col * cs, col * cs + block.width)
        writer.submit(
            k,
            row,
            col,
            lambda: _append_cell(block, target.arrays[k], ys, xs, plan),
        )

    try:
        pyramid.walk(submit)
        writer.results()
    except BaseException:
        writer.shutdown()
        raise
    finally:
        compute.shutdown(wait=True)
    writer.shutdown()

    _update_volatility(target, plan)
    _commit_metadata(target, plan, times_iso, times_ms)


def append(
    store: str | Path,
    data: xr.DataArray | Iterable[np.ndarray] | str | Path | ChronoStore,
    **options: Any,
) -> AppendReport:
    """Validate append in a working copy, then publish only changed objects, root last.

    Publication is metadata-last but not transactional across multiple objects.
    """
    original = Path(store)
    _open_target(original)
    working = Path(tempfile.mkdtemp(prefix=f".{original.name}-append-", dir=original.parent))
    try:
        shutil.copytree(original, working, dirs_exist_ok=True)
        report = _append_in_place(working, data, **options)
        problems = schema.validate(working)
        if problems:
            raise SchemaError("append validation failed: " + "; ".join(problems))
        before, after = _snapshot(original), _snapshot(working)
        changed = [key for key in after if before.get(key) != after[key]]

        def order(key: str) -> tuple[int, str]:
            if key == "zarr.json":
                return 3, key
            if key.endswith("/zarr.json"):
                return 2, key
            if "/time/" in key or key.startswith("volatility/"):
                return 1, key
            return 0, key

        for key in sorted(changed, key=order):
            destination = original / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".append-part")
            shutil.copy2(working / key, temporary)
            temporary.replace(destination)
        return report
    finally:
        shutil.rmtree(working)
