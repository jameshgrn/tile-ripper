"""xarray backend: `xr.open_dataset(path_or_url, engine="chronozarr", chunks=...)`.

Opening reads metadata only. The data variable is a lazily indexed array: selecting a window,
or computing one dask chunk, reads exactly the Zarr chunks it needs (one chunk per timestep,
ordinary stored values) and returns decoded values. With
`physical=True` (default) values are float32 physical values (stored * scale + offset) with NaN
where the pixel is invalid; with `physical=False` they are the stored values.

Register with the entry point (pyproject.toml):

    [project.entry-points."xarray.backends"]
    chronozarr = "chronozarr.backend:ChronozarrBackendEntrypoint"

`chunks=` needs dask. Without it the dataset still opens and indexes lazily.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr
from xarray.backends import BackendArray, BackendEntrypoint
from xarray.core import indexing

from chronozarr import schema
from chronozarr.decode import ChronoStore, Level, open_store


def _axis_index(key: int | slice | np.ndarray, size: int) -> tuple[np.ndarray, bool]:
    """One outer-indexing key as a 1-D index array, plus whether the axis is dropped (an int)."""
    if isinstance(key, slice):
        return np.arange(size)[key], False
    if isinstance(key, int | np.integer):
        index = int(key) + size if key < 0 else int(key)
        if not 0 <= index < size:
            raise IndexError(f"index {key} is out of bounds for axis of size {size}")
        return np.array([index]), True
    index = np.asarray(key)
    return np.where(index < 0, index + size, index), False


def _window(index: np.ndarray) -> slice:
    """Smallest slice covering a non-empty 1-D index array."""
    return slice(int(index.min()), int(index.max()) + 1)


class _ChronoArray(BackendArray):
    """A (time, [band,] y, x) variable of one level, decoded on demand."""

    def __init__(self, store: ChronoStore, level: Level, kind: str, *, physical: bool) -> None:
        self.store, self.level, self.kind, self.physical = store, level, kind, physical
        n_time, n_band, height, width = level.shape
        if kind == "data":
            self.shape = (n_time, n_band, height, width)
            self.dtype = np.dtype(np.float32) if physical else store.dtype
        else:
            self.shape = (n_time, height, width)
            self.dtype = np.dtype(np.uint8)

    def __getitem__(self, key: indexing.ExplicitIndexer) -> Any:
        return indexing.explicit_indexing_adapter(
            key, self.shape, indexing.IndexingSupport.OUTER, self._getitem
        )

    def _getitem(self, key: tuple) -> np.ndarray:
        indexes = [_axis_index(k, n) for k, n in zip(key, self.shape, strict=True)]
        if any(index.size == 0 for index, _ in indexes):
            shape = tuple(index.size for index, scalar in indexes if not scalar)
            return np.empty(shape, dtype=self.dtype)
        times = [int(t) for t in indexes[0][0]]
        ys, xs = _window(indexes[-2][0]), _window(indexes[-1][0])
        if self.kind == "data":
            read = self.store._physical_region if self.physical else self.store._read_region
            values = read(self.level, times, ys, xs)
        else:
            array = self.level.mask if self.kind == "mask" else self.level.coverage
            assert array is not None
            values = self.store._read_plane(array, times, ys, xs)
        # Outer-index the window: bands pick from the full axis; y and x are window-relative.
        for axis in range(1, values.ndim):
            index = indexes[axis][0]
            if axis >= values.ndim - 2:
                index = index - (ys.start if axis == values.ndim - 2 else xs.start)
            if not (index.size == values.shape[axis] and (index == np.arange(index.size)).all()):
                values = np.take(values, index, axis=axis)
        dropped = tuple(axis for axis, (_, scalar) in enumerate(indexes) if scalar)
        return values.squeeze(axis=dropped) if dropped else values


def _variable(array: _ChronoArray, dims: tuple[str, ...], level: Level) -> xr.Variable:
    cs = level.chunk_size
    chunks = {"time": 1, "band": level.shape[1], "y": cs, "x": cs}
    encoding = {"preferred_chunks": {d: chunks[d] for d in dims}}
    return xr.Variable(dims, indexing.LazilyIndexedArray(array), encoding=encoding)


def _as_store(filename_or_obj: Any) -> ChronoStore:
    if isinstance(filename_or_obj, ChronoStore):
        return filename_or_obj
    if isinstance(filename_or_obj, os.PathLike):
        filename_or_obj = os.fspath(filename_or_obj)
    return open_store(filename_or_obj)


def open_dataset(
    filename_or_obj: Any,
    *,
    drop_variables: str | Iterable[str] | None = None,
    lod: int = 0,
    physical: bool = True,
) -> xr.Dataset:
    """Open pyramid level `lod` of a chronozarr store as a lazily loaded Dataset.

    Variables: the data variable (time, band, y, x), plus `mask` and `coverage` (time, y, x)
    when the store has them. Coordinates: time (datetime64), band, y, x (projected pixel
    centres), and `common_name` along band when any band declares one.
    """
    store = _as_store(filename_or_obj)
    level = store._level(lod)
    y, x = schema.pixel_centers(level.transform, level.shape[2], level.shape[3])
    coords: dict[str, Any] = {
        "time": store.times.astype("datetime64[ns]"),
        "band": list(store.bands),
        "y": y,
        "x": x,
    }
    if any(b.common_name for b in store.attrs.bands):
        coords["common_name"] = ("band", [b.common_name or "" for b in store.attrs.bands])

    band_coords, band_attrs = store._band_metadata(physical=physical)
    coords.update(band_coords)

    variables: dict[str, xr.Variable] = {
        store.attrs.variable: _variable(
            _ChronoArray(store, level, "data", physical=physical), schema.DIMENSIONS, level
        )
    }
    variables[store.attrs.variable].attrs.update(band_attrs)
    for name, array in (
        (store.attrs.mask_variable, level.mask),
        (store.attrs.coverage_variable, level.coverage),
    ):
        if name is not None and array is not None:
            kind = "mask" if name == store.attrs.mask_variable else "coverage"
            variables[name] = _variable(
                _ChronoArray(store, level, kind, physical=False), schema.PLANE_DIMENSIONS, level
            )

    attrs: dict[str, Any] = {
        "crs": store.attrs.crs,
        "transform": list(level.transform),
        "resolution": level.resolution,
        "lod": lod,
        "chronozarr_spec_version": store.attrs.spec_version,
    }
    if store.nodata is not None and level.mask is None:  # a mask carries validity instead
        attrs["nodata"] = store.nodata
    dropped = {drop_variables} if isinstance(drop_variables, str) else set(drop_variables or ())
    return xr.Dataset(
        {k: v for k, v in variables.items() if k not in dropped}, coords=coords, attrs=attrs
    )


class ChronozarrBackendEntrypoint(BackendEntrypoint):
    """xarray entry point for engine="chronozarr"."""

    description = "Open chronozarr stores (Zarr v3 raster time-series pyramids) lazily"
    url = "https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md"

    def open_dataset(
        self,
        filename_or_obj: Any,
        *,
        drop_variables: str | Iterable[str] | None = None,
        lod: int = 0,
        physical: bool = True,
    ) -> xr.Dataset:
        return open_dataset(
            filename_or_obj, drop_variables=drop_variables, lod=lod, physical=physical
        )

    def guess_can_open(self, filename_or_obj: Any) -> bool:
        """True for a local directory whose root zarr.json carries a chronozarr block."""
        if not isinstance(filename_or_obj, str | os.PathLike):
            return False
        root = Path(os.fspath(filename_or_obj)) / "zarr.json"
        try:
            return b'"chronozarr"' in root.read_bytes()
        except OSError:
            return False
