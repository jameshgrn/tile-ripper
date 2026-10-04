"""Shared machinery for creating and extending chronozarr stores.

Input validation and cell sources, pyramid reduction, bounded cell scheduling, and
coordinate metadata live here so encode and append use the same writer contract.
This module depends on the format schema, never either write operation.
"""

from __future__ import annotations

import math
import os
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, Protocol, TypeVar, cast

import numpy as np
import xarray as xr
import zarr

from chronozarr import schema
from chronozarr.schema import Band, Transform

VOLATILITY_SCALE = 10000  # fixed normalisation for every dtype (Sentinel-2 reflectance scale)
DEFAULT_CELLS_IN_FLIGHT = 4
_R = TypeVar("_R")


# --- Pixel blocks and pyramid reduction ----------------------------------------------


@dataclass
class Block:
    """One spatial window across every timestep: data (T, B, h, w), planes (T, h, w)."""

    data: np.ndarray
    mask: np.ndarray | None = None
    coverage: np.ndarray | None = None

    @property
    def height(self) -> int:
        return self.data.shape[2]

    @property
    def width(self) -> int:
        return self.data.shape[3]


def _accumulator(dtype: np.dtype) -> type[np.generic]:
    if dtype.kind == "u":
        return np.uint32
    if dtype.kind == "i":
        return np.int32
    return np.float64


def _pad_even(array: np.ndarray) -> np.ndarray:
    """Edge-replicate the last two axes up to even sizes."""
    height, width = array.shape[-2:]
    if height % 2 == 0 and width % 2 == 0:
        return array
    pad = [(0, 0)] * (array.ndim - 2) + [(0, height % 2), (0, width % 2)]
    return np.pad(array, pad, mode="edge")


def downsample_2x(
    values: np.ndarray,
    *,
    nodata: int | float | None = schema.NODATA,
    valid: np.ndarray | None = None,
) -> np.ndarray:
    """Block-mean the last two axes by 2 over valid pixels only.

    A pixel is valid where `valid` is true; without `valid`, where it differs from `nodata`
    (every pixel is valid when nodata is None). Odd sizes are padded by edge replication first,
    so the output is ceil(size / 2). Integer means floor-divide the exact sum (uint32 for
    uint8/uint16, int32 for int16); float32 accumulates in float64. A block with no valid pixel
    becomes `nodata` (0 when nodata is None). `valid` may broadcast against `values` (for
    example (1, y, x) against (band, y, x)).
    """
    values = _pad_even(values)
    if valid is not None:
        valid = _pad_even(valid)
    out_shape = (*values.shape[:-2], values.shape[-2] // 2, values.shape[-1] // 2)
    total = np.zeros(out_shape, dtype=_accumulator(values.dtype))
    count = np.zeros(out_shape, dtype=np.uint8)
    zero_is_nodata = valid is None and nodata == 0 and values.dtype.kind == "u"
    for i in (0, 1):
        for j in (0, 1):
            q = values[..., i::2, j::2]
            if valid is not None:
                ok = valid[..., i::2, j::2]
            elif nodata is not None:
                ok = q != nodata
            else:
                ok = None
            if ok is None:
                total += q
                count += 1
            elif zero_is_nodata:
                total += q  # nodata 0 adds nothing to the sum
                count += ok
            else:
                np.add(total, q, out=total, where=ok)
                count += ok
    has_valid = count > 0
    if values.dtype.kind == "f":
        mean = np.zeros_like(total)
        np.divide(total, count, out=mean, where=has_valid)
    else:
        mean = np.zeros_like(total)
        np.floor_divide(total, count, out=mean, where=has_valid)
    if nodata:
        mean[~has_valid] = nodata
    return mean.astype(values.dtype)


def _downsample_plane_pair(
    mask: np.ndarray | None, coverage: np.ndarray | None
) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Reduce one timestep of mask (any valid) and coverage (rounded mean) by 2."""
    reduced_mask = reduced_coverage = None
    if mask is not None:
        padded = _pad_even(mask)
        reduced_mask = padded[0::2, 0::2]
        for i, j in ((0, 1), (1, 0), (1, 1)):
            reduced_mask = np.maximum(reduced_mask, padded[i::2, j::2])
    if coverage is not None:
        padded = _pad_even(coverage)
        total = np.zeros((padded.shape[0] // 2, padded.shape[1] // 2), dtype=np.uint16)
        for i in (0, 1):
            for j in (0, 1):
                total += padded[i::2, j::2]
        reduced_coverage = ((total + 2) // 4).astype(np.uint8)
    return reduced_mask, reduced_coverage


def downsample_block(
    block: Block, nodata: int | float | None, pool: ThreadPoolExecutor | None = None
) -> Block:
    """The next pyramid level of a block: data, mask and coverage reduced by 2 per timestep."""
    n_time, n_band, height, width = block.data.shape
    out_h, out_w = -(-height // 2), -(-width // 2)
    data = np.empty((n_time, n_band, out_h, out_w), dtype=block.data.dtype)
    mask = None if block.mask is None else np.empty((n_time, out_h, out_w), dtype=np.uint8)
    coverage = None if block.coverage is None else np.empty((n_time, out_h, out_w), dtype=np.uint8)

    def one(t: int) -> None:
        valid = None if block.mask is None else block.mask[t].astype(bool)[None]
        data[t] = downsample_2x(block.data[t], nodata=nodata, valid=valid)
        reduced_mask, reduced_coverage = _downsample_plane_pair(
            None if block.mask is None else block.mask[t],
            None if block.coverage is None else block.coverage[t],
        )
        if mask is not None:
            mask[t] = reduced_mask
        if coverage is not None:
            coverage[t] = reduced_coverage

    if pool is None:
        for t in range(n_time):
            one(t)
    else:
        list(pool.map(one, range(n_time)))
    return Block(data, mask, coverage)


# --- Input metadata ------------------------------------------------------------------


def _transform_from_coords(da: xr.DataArray) -> Transform:
    """Affine transform from regularly spaced, north-up pixel-centre x/y coordinates."""
    if "x" not in da.coords or "y" not in da.coords or da.sizes["x"] < 2 or da.sizes["y"] < 2:
        raise ValueError(
            "no transform: pass transform=(a, b, c, d, e, f), set da.attrs['transform'], or "
            "provide x/y coordinates with at least 2 pixels per axis"
        )
    x = da["x"].values.astype(np.float64)
    y = da["y"].values.astype(np.float64)
    dx, dy = float(x[1] - x[0]), float(y[1] - y[0])
    if dx <= 0 or dy >= 0:
        raise ValueError(
            "x must increase and y must decrease (north-up); "
            "flip with da.isel(y=slice(None, None, -1))"
        )
    if not (np.allclose(np.diff(x), dx) and np.allclose(np.diff(y), dy)):
        raise ValueError("x/y coordinates are not regularly spaced; pass an explicit transform")
    return (dx, 0.0, float(x[0]) - dx / 2, 0.0, dy, float(y[0]) - dy / 2)


def _resolve_transform(raw: Sequence[float] | None, da: xr.DataArray | None) -> Transform:
    if raw is None and da is not None:
        raw = da.attrs.get("transform")
    if raw is None:
        if da is None:
            raise ValueError("no transform: pass transform=(a, b, c, d, e, f)")
        return _transform_from_coords(da)
    values = [float(v) for v in list(raw)[:6]]
    if len(values) != 6:
        raise ValueError(f"transform needs 6 coefficients (a, b, c, d, e, f), got {raw!r}")
    if not all(math.isfinite(v) for v in values):
        raise ValueError("transform coefficients must be finite")
    a, b, _, d, e, _ = values
    if b != 0 or d != 0:
        raise ValueError("rotated transforms are not supported; reproject to a north-up grid")
    if a <= 0 or e >= 0:
        raise ValueError(f"transform must be north-up (a > 0, e < 0), got a={a}, e={e}")
    return (values[0], values[1], values[2], values[3], values[4], values[5])


def _iso_times(times: np.ndarray) -> tuple[list[str], np.ndarray]:
    """ISO-8601 strings and int64 milliseconds since epoch for a datetime64 axis."""
    if not np.issubdtype(times.dtype, np.datetime64):
        raise ValueError(
            f"the time coordinate must be datetime64, got {times.dtype}; "
            "assign da['time'] = pd.to_datetime(...) or similar"
        )
    if np.isnat(times).any():
        raise ValueError("the time coordinate contains NaT")
    ms = times.astype("datetime64[ms]")
    if len(ms) > 1 and not (np.diff(ms.astype(np.int64)) > 0).all():
        raise ValueError("the time coordinate must be strictly increasing; use da.sortby('time')")
    unit = "s" if (ms.astype(np.int64) % 1000 == 0).all() else "ms"
    iso = [f"{s}Z" for s in np.datetime_as_string(ms, unit=unit)]
    return iso, ms.astype(np.int64)


def _resolve_bands(
    bands: Sequence[str | Band | Mapping] | None, coords: Sequence[str] | None, n_band: int
) -> tuple[Band, ...]:
    """Band objects from the `bands` argument and/or the DataArray band coordinate."""
    if bands is None:
        if coords is None:
            raise ValueError("no band names: pass bands=[...] (names or band objects)")
        parsed = tuple(Band(str(name)) for name in coords)
    else:
        parsed = tuple(
            b if isinstance(b, Band) else schema.parse_band(b, f"bands[{i}]")
            for i, b in enumerate(bands)
        )
    if len(parsed) != n_band:
        raise ValueError(f"{len(parsed)} band names for {n_band} bands")
    if bands is not None and coords is not None and [b.name for b in parsed] != list(coords):
        raise ValueError(
            f"bands names {[b.name for b in parsed]} differ from the band coordinate "
            f"{list(coords)}"
        )
    names = [b.name for b in parsed]
    if len(set(names)) != len(names):
        raise ValueError(f"band names must be unique, got {names}")
    return parsed


def _resolve_nodata(
    nodata: int | float | None | str, dtype: np.dtype, *, has_mask: bool
) -> int | float | None:
    """The nodata value for `dtype`.

    'default' is 0 for uint8/uint16 and None otherwise, and None whenever a mask supplies
    validity: a nodata value would then collide with valid pixels that happen to be 0.
    """
    if nodata == "default":
        if has_mask:
            return None
        return schema.NODATA if dtype.name in ("uint8", "uint16") else None
    if nodata is None:
        return None
    if isinstance(nodata, bool) or not isinstance(nodata, int | float | np.number):
        raise ValueError(f"nodata must be a number or None, got {nodata!r}")
    if not math.isfinite(float(nodata)):
        raise ValueError(
            f"nodata must be finite, got {nodata!r}; flag invalid pixels with a mask instead"
        )
    if dtype.kind == "f":
        return float(np.float32(nodata))
    info = np.iinfo(dtype)
    if float(nodata) != int(nodata) or not info.min <= int(nodata) <= info.max:
        raise ValueError(f"nodata {nodata!r} is not an integer within {dtype.name} range")
    return int(nodata)


# --- Cell sources --------------------------------------------------------------------


class _Source(Protocol):
    def read_cell(self, row: int, col: int) -> Block: ...


def _plane(array: np.ndarray, name: str, *, binary: bool) -> np.ndarray:
    if array.dtype == np.bool_:
        array = array.astype(np.uint8)
    if array.dtype != np.uint8:
        raise ValueError(f"{name} must be uint8 (or bool), got {array.dtype}")
    if binary and array.size and array.max() > 1:
        raise ValueError(f"{name} must contain only 0 (invalid) and 1 (valid)")
    return array


class _ArraySource:
    """Cells of a DataArray (numpy or dask) read one window at a time."""

    def __init__(
        self,
        data: xr.DataArray,
        mask: xr.DataArray | None,
        coverage: xr.DataArray | None,
        chunk_size: int,
    ) -> None:
        self.data, self.mask, self.coverage, self.cs = data, mask, coverage, chunk_size

    def read_cell(self, row: int, col: int) -> Block:
        window = {
            "y": slice(row * self.cs, (row + 1) * self.cs),
            "x": slice(col * self.cs, (col + 1) * self.cs),
        }
        data = np.asarray(self.data.isel(window).values)
        mask = coverage = None
        if self.mask is not None:
            mask = _plane(np.asarray(self.mask.isel(window).values), "mask", binary=True)
        if self.coverage is not None:
            coverage = _plane(
                np.asarray(self.coverage.isel(window).values), "coverage", binary=False
            )
        return Block(data, mask, coverage)


class _SpillSource:
    """Per-timestep arrays transposed to cell-major temp files, read back one cell at a time.

    Each cell has one file per variable holding its timesteps back to back, so a cell is one
    sequential read and a timestep write is one 2 MB write per cell. The page cache is not part
    of the process RSS (no mmap).
    """

    def __init__(
        self,
        directory: Path,
        *,
        n_time: int,
        n_band: int,
        height: int,
        width: int,
        dtype: np.dtype,
        chunk_size: int,
        has_mask: bool,
        has_coverage: bool,
    ) -> None:
        self.dir = directory
        self.n_time, self.n_band, self.height, self.width = n_time, n_band, height, width
        self.dtype, self.cs = dtype, chunk_size
        self.has_mask, self.has_coverage = has_mask, has_coverage
        self.rows, self.cols = schema.grid_shape(height, width, chunk_size)

    def _window(self, row: int, col: int) -> tuple[slice, slice]:
        cs = self.cs
        return (
            slice(row * cs, min((row + 1) * cs, self.height)),
            slice(col * cs, min((col + 1) * cs, self.width)),
        )

    def _path(self, kind: str, row: int, col: int) -> Path:
        return self.dir / f"{kind}_{row}_{col}.bin"

    def _put(self, kind: str, row: int, col: int, t: int, array: np.ndarray) -> None:
        contiguous = np.ascontiguousarray(array)
        path = self._path(kind, row, col)
        with open(path, "r+b" if path.exists() else "wb") as f:
            f.seek(t * contiguous.nbytes)
            contiguous.tofile(f)

    def write_timestep(
        self,
        t: int,
        data: np.ndarray,
        mask: np.ndarray | None,
        coverage: np.ndarray | None,
        pool: ThreadPoolExecutor,
    ) -> None:
        def one(cell: tuple[int, int]) -> None:
            row, col = cell
            ys, xs = self._window(row, col)
            self._put("d", row, col, t, data[:, ys, xs])
            if mask is not None:
                self._put("m", row, col, t, mask[ys, xs])
            if coverage is not None:
                self._put("v", row, col, t, coverage[ys, xs])

        cells = [(r, c) for r in range(self.rows) for c in range(self.cols)]
        list(pool.map(one, cells))

    def read_cell(self, row: int, col: int) -> Block:
        ys, xs = self._window(row, col)
        h, w = ys.stop - ys.start, xs.stop - xs.start
        data = np.fromfile(self._path("d", row, col), dtype=self.dtype)
        block = Block(data.reshape(self.n_time, self.n_band, h, w))
        if self.has_mask:
            mask = np.fromfile(self._path("m", row, col), dtype=np.uint8)
            block.mask = mask.reshape(self.n_time, h, w)
        if self.has_coverage:
            coverage = np.fromfile(self._path("v", row, col), dtype=np.uint8)
            block.coverage = coverage.reshape(self.n_time, h, w)
        return block


# --- Cell scheduling and pyramid traversal -------------------------------------------


@dataclass
class _LevelArrays:
    data: zarr.Array
    mask: zarr.Array | None
    coverage: zarr.Array | None


class _CellWriter(Generic[_R]):
    """Runs cell jobs on a pool with at most `limit` cells (and their buffers) in flight."""

    def __init__(self, limit: int) -> None:
        self.pool = ThreadPoolExecutor(max_workers=limit)
        self.slots = threading.BoundedSemaphore(limit)
        self.futures: list[tuple[int, int, int, Future[_R]]] = []

    def submit(self, level: int, row: int, col: int, run: Callable[[], _R]) -> None:
        self._raise_finished()
        self.slots.acquire()

        def job() -> _R:
            try:
                return run()
            finally:
                self.slots.release()

        self.futures.append((level, row, col, self.pool.submit(job)))

    def _raise_finished(self) -> None:
        for _, _, _, future in self.futures:
            if future.done() and (error := future.exception()) is not None:
                raise error

    def results(self) -> list[tuple[int, int, int, _R]]:
        return [(lvl, r, c, f.result()) for lvl, r, c, f in self.futures]

    def shutdown(self) -> None:
        for _, _, _, future in self.futures:
            future.cancel()
        self.pool.shutdown(wait=True)


class _Pyramid:
    """Depth-first walk of the pyramid, producing every cell of every level exactly once.

    A level-0 cell is read from `source`; a cell of level k is assembled from the four cells of
    level k-1 beneath it, so a level-0 cell is read, handed to `submit`, downsampled into its
    parent and dropped. `n_time` is the number of timesteps `source` holds.
    """

    def __init__(
        self,
        shapes: Sequence[tuple[int, int]],
        chunk_size: int,
        *,
        n_time: int,
        n_band: int,
        dtype: np.dtype,
        nodata: int | float | None,
        source: _Source,
        compute: ThreadPoolExecutor,
    ) -> None:
        self.shapes, self.cs = list(shapes), chunk_size
        self.n_time, self.n_band, self.dtype, self.nodata = n_time, n_band, dtype, nodata
        self.source, self.compute = source, compute
        self.grids = [schema.grid_shape(h, w, chunk_size) for h, w in self.shapes]
        self.downsample_s = [0.0] * len(self.shapes)  # per level, summed over cells

    def walk(self, submit: Callable[[int, int, int, Block], None]) -> None:
        """Call `submit(level, row, col, block)` for every cell, children before parents."""
        top = len(self.shapes) - 1
        for row in range(self.grids[top][0]):
            for col in range(self.grids[top][1]):
                self._produce(top, row, col, submit)

    def _produce(
        self, k: int, row: int, col: int, submit: Callable[[int, int, int, Block], None]
    ) -> Block:
        """Level-k cell (row, col): read at level 0, else assembled from its four children."""
        block = self.source.read_cell(row, col) if k == 0 else self._assemble(k, row, col, submit)
        submit(k, row, col, block)
        return block

    def _assemble(
        self, k: int, row: int, col: int, submit: Callable[[int, int, int, Block], None]
    ) -> Block:
        cs = self.cs
        height, width = self.shapes[k]
        h, w = min(cs, height - row * cs), min(cs, width - col * cs)
        parent = Block(np.empty((self.n_time, self.n_band, h, w), dtype=self.dtype))
        half = cs // 2
        filled = 0
        for i in (0, 1):
            for j in (0, 1):
                child_row, child_col = 2 * row + i, 2 * col + j
                if child_row >= self.grids[k - 1][0] or child_col >= self.grids[k - 1][1]:
                    continue
                child = self._produce(k - 1, child_row, child_col, submit)
                started = time.perf_counter()
                small = downsample_block(child, self.nodata, self.compute)
                ys = slice(i * half, i * half + small.height)
                xs = slice(j * half, j * half + small.width)
                if parent.mask is None and small.mask is not None:
                    parent.mask = np.empty((self.n_time, h, w), dtype=np.uint8)
                if parent.coverage is None and small.coverage is not None:
                    parent.coverage = np.empty((self.n_time, h, w), dtype=np.uint8)
                parent.data[:, :, ys, xs] = small.data
                if small.mask is not None and parent.mask is not None:
                    parent.mask[:, ys, xs] = small.mask
                if small.coverage is not None and parent.coverage is not None:
                    parent.coverage[:, ys, xs] = small.coverage
                filled += small.height * small.width
                self.downsample_s[k] += time.perf_counter() - started
        if filled != h * w:
            raise AssertionError(
                f"level {k} cell ({row}, {col}): children cover {filled} of {h * w} pixels"
            )
        return parent


# --- Coordinates and shard metadata --------------------------------------------------


def _put_coord(
    group: zarr.Group,
    name: str,
    values: np.ndarray,
    dtype: type | str,
    attrs: dict | None = None,
    *,
    overwrite: bool = False,
) -> None:
    """A one-chunk coordinate array named after its only dimension."""
    array = group.create_array(
        name=name,
        shape=values.shape,
        chunks=values.shape,
        dtype=dtype,
        dimension_names=(name,),
        overwrite=overwrite,
    )
    array[:] = values
    array.attrs.update({"_ARRAY_DIMENSIONS": [name], **(attrs or {})})


def _write_time_coord(group: zarr.Group, times_ms: np.ndarray, *, overwrite: bool = False) -> None:
    """The `time` coordinate: int64 milliseconds since the epoch, CF attributes, one chunk."""
    _put_coord(
        group,
        "time",
        times_ms,
        "int64",
        {"units": schema.TIME_UNITS, "calendar": schema.TIME_CALENDAR},
        overwrite=overwrite,
    )


def _shard_bytes(
    out: Path, n_levels: int, variable: str = schema.VARIABLE
) -> dict[str, dict[str, int]]:
    """Byte length of every shard object of the data array, keyed by level then t/row/col."""
    sizes: dict[str, dict[str, int]] = {}
    for k in range(n_levels):
        base = out / str(k) / variable / "c"
        entries = {}
        for path in sorted(base.glob("*/0/*/*")):
            t_shard, _, row, col = path.relative_to(base).parts
            entries[f"{t_shard}/{row}/{col}"] = path.stat().st_size
        sizes[str(k)] = entries
    return sizes


# --- Input preparation and spilling --------------------------------------------------


@dataclass
class _Input:
    """Validated description of the input plus a way to get its cells.

    A DataArray input sets `da` and DataArray planes; an iterable input sets `timesteps` and
    iterable planes.
    """

    n_time: int
    n_band: int
    height: int
    width: int
    dtype: np.dtype
    times: np.ndarray
    band_coords: list[str] | None
    attrs: Mapping
    da: xr.DataArray | None = None
    timesteps: Iterable[np.ndarray] | None = None
    mask: xr.DataArray | Iterable[np.ndarray] | None = None
    coverage: xr.DataArray | Iterable[np.ndarray] | None = None


def _as_plane_da(plane: object, name: str, da: xr.DataArray) -> xr.DataArray:
    if not isinstance(plane, xr.DataArray | np.ndarray):
        raise ValueError(
            f"{name} must be a (time, y, x) DataArray or ndarray when data is a DataArray, "
            f"got {type(plane).__name__}"
        )
    if isinstance(plane, np.ndarray):
        plane = xr.DataArray(plane, dims=schema.PLANE_DIMENSIONS)
    if plane.dims != schema.PLANE_DIMENSIONS:
        raise ValueError(f"{name} must have dims {schema.PLANE_DIMENSIONS}, got {plane.dims}")
    if plane.shape != (da.sizes["time"], da.sizes["y"], da.sizes["x"]):
        raise ValueError(f"{name} shape {plane.shape} differs from the data (time, y, x)")
    return plane


def _prepare_input(
    data: xr.DataArray | Iterable[np.ndarray],
    times: Sequence | np.ndarray | None,
    mask: object,
    coverage: object,
) -> _Input:
    if isinstance(data, xr.DataArray):
        if times is not None:
            raise ValueError("times= is only for iterable input; a DataArray carries its own")
        if data.dims != schema.DIMENSIONS:
            raise ValueError(
                f"expected dims {schema.DIMENSIONS}, got {data.dims}; use da.transpose()"
            )
        if data.dtype.name not in schema.DTYPES:
            raise ValueError(
                f"unsupported dtype {data.dtype}: expected one of {list(schema.DTYPES)}; "
                "chronozarr never converts dtype"
            )
        if 0 in data.shape:
            raise ValueError(f"empty input: shape {data.shape}")
        n_time, n_band, height, width = data.shape
        coords = [str(b) for b in data["band"].values] if "band" in data.coords else None
        return _Input(
            n_time=n_time,
            n_band=n_band,
            height=height,
            width=width,
            dtype=data.dtype,
            times=data["time"].values,
            band_coords=coords,
            attrs=data.attrs,
            da=data,
            mask=None if mask is None else _as_plane_da(mask, "mask", data),
            coverage=None if coverage is None else _as_plane_da(coverage, "coverage", data),
        )
    if times is None:
        raise ValueError("iterable input needs times= (datetime64, one per timestep)")
    iterator = iter(data)
    first = next(iterator, None)
    if first is None:
        raise ValueError("empty input: no timesteps")
    first = np.asarray(first)
    if first.ndim != 3 or 0 in first.shape:
        raise ValueError(
            f"each timestep must be a non-empty (band, y, x) array, got {first.shape}"
        )
    if first.dtype.name not in schema.DTYPES:
        raise ValueError(
            f"unsupported dtype {first.dtype}: expected one of {list(schema.DTYPES)}; "
            "chronozarr never converts dtype"
        )
    times_array = np.asarray(times)
    n_band, height, width = first.shape

    def chained() -> Iterable[np.ndarray]:
        yield first
        yield from iterator

    return _Input(
        n_time=len(times_array),
        n_band=n_band,
        height=height,
        width=width,
        dtype=first.dtype,
        times=times_array,
        band_coords=None,
        attrs={},
        timesteps=chained(),
        mask=cast("Iterable[np.ndarray] | None", mask),
        coverage=cast("Iterable[np.ndarray] | None", coverage),
    )


def _spill_timesteps(
    prepared: _Input,
    directory: Path,
    *,
    chunk_size: int,
    has_mask: bool,
    has_coverage: bool,
) -> _SpillSource:
    """Consume the per-timestep iterables of `prepared` into cell-major files."""
    assert prepared.timesteps is not None
    n_time, dtype = prepared.n_time, prepared.dtype
    spill = _SpillSource(
        directory,
        n_time=n_time,
        n_band=prepared.n_band,
        height=prepared.height,
        width=prepared.width,
        dtype=dtype,
        chunk_size=chunk_size,
        has_mask=has_mask,
        has_coverage=has_coverage,
    )
    masks = iter(prepared.mask) if prepared.mask is not None else None
    coverages = iter(prepared.coverage) if prepared.coverage is not None else None
    expected = (prepared.n_band, prepared.height, prepared.width)
    plane_shape = (prepared.height, prepared.width)
    seen = 0
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 1) as pool:
        for t, step in enumerate(prepared.timesteps):
            if t >= n_time:
                raise ValueError(f"the input has more than the {n_time} timesteps in times")
            step = np.asarray(step)
            if step.shape != expected or step.dtype != dtype:
                raise ValueError(
                    f"timestep {t} is {step.dtype}{step.shape}; expected "
                    f"{dtype}{expected} like timestep 0"
                )
            planes: list[np.ndarray | None] = []
            for name, iterator, binary in (("mask", masks, True), ("coverage", coverages, False)):
                if iterator is None:
                    planes.append(None)
                    continue
                plane = next(iterator, None)
                if plane is None:
                    raise ValueError(f"{name} ended at timestep {t}; it needs one array per step")
                plane = _plane(np.asarray(plane), name, binary=binary)
                if plane.shape != plane_shape:
                    raise ValueError(
                        f"{name} at timestep {t} is {plane.shape}; expected {plane_shape}"
                    )
                planes.append(plane)
            spill.write_timestep(t, step, planes[0], planes[1], pool)
            seen += 1
    if seen != n_time:
        raise ValueError(f"the input has {seen} timesteps but times has {n_time}")
    return spill


def _mean_comparison(block: np.ndarray, reference: Mapping[int, int]) -> tuple[float, int]:
    """Sum of exact absolute differences over the nominal comparison timesteps."""
    wide = np.float64 if block.dtype.kind == "f" else np.int32
    by_comparison: dict[int, list[int]] = {}
    for t, comparison in reference.items():
        by_comparison.setdefault(comparison, []).append(t)
    total = 0.0
    count = 0
    for comparison, steps in by_comparison.items():
        base = block[comparison].astype(wide)
        for t in steps:
            diff = block[t].astype(wide)
            diff -= base
            total += float(np.abs(diff).sum(dtype=np.float64))
            count += diff.size
    return total, count
