"""chronozarr reader: open a store, return raw or physical values."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np
import xarray as xr
import zarr
from zarr.errors import GroupNotFoundError
from zarr.storage import LocalStore

from chronozarr import schema
from chronozarr.schema import Chronozarr, SchemaError, Transform
from chronozarr.store import HttpStore as HttpStore
from chronozarr.store import IndexStore
from chronozarr.store import as_store as as_store


@dataclass(frozen=True)
class Level:
    """One pyramid level of a store."""

    index: int
    shape: tuple[int, int, int, int]  # (time, band, y, x)
    transform: Transform
    resolution: float
    chunk_size: int
    grid: tuple[int, int]  # (rows, cols) of cells
    data: zarr.Array
    mask: zarr.Array | None = None
    coverage: zarr.Array | None = None

    @property
    def shard_time(self) -> int | None:
        """Timesteps per shard along time; None for an unsharded array."""
        return None if self.data.shards is None else int(self.data.shards[0])


class ChronoStore:
    """A chronozarr store opened for reading. Use `open_store` to create one."""

    def __init__(self, group: zarr.Group, source: str) -> None:
        root = schema.parse_root_attrs(group.attrs.asdict())
        self._group = group
        self.source = source
        self.attrs: Chronozarr = root.chronozarr
        self.times: np.ndarray = np.array(
            [schema.parse_time(t) for t in root.chronozarr.times], dtype="datetime64[ms]"
        )
        self.bands: tuple[str, ...] = root.chronozarr.band_names
        levels = []
        for index, dataset in enumerate(root.datasets):
            where = f"level {dataset.path}"
            level_group = schema.get_group(group, dataset.path, "store")
            data = schema.get_array(level_group, root.chronozarr.variable, where)
            level_attrs = schema.canonical_level(data, where)
            mirrors = level_group.attrs.asdict()
            for key, expected in level_attrs.to_attrs().items():
                if key in mirrors and mirrors[key] != expected:
                    raise SchemaError(f"{where}: {key} mirror differs from canonical geometry")
            if level_attrs.crs != root.chronozarr.crs:
                raise SchemaError(f"{where}: CRS differs from root")
            schema.check_codecs(data, where)
            if data.dtype.name not in schema.DTYPES:
                raise SchemaError(f"{where}: unsupported data_type {data.dtype.name}")
            cs = schema.cell_size(data, f"{where}/data")
            shape = (data.shape[0], data.shape[1], data.shape[2], data.shape[3])
            levels.append(
                Level(
                    index=index,
                    shape=shape,
                    transform=level_attrs.transform,
                    resolution=level_attrs.resolution,
                    chunk_size=cs,
                    grid=schema.grid_shape(shape[2], shape[3], cs),
                    data=data,
                    mask=_plane(level_group, root.chronozarr.mask_variable, where),
                    coverage=_plane(level_group, root.chronozarr.coverage_variable, where),
                )
            )
        self.levels: tuple[Level, ...] = tuple(levels)
        problems: list[str] = []
        state = schema._LevelState()
        for level in levels:
            shape = schema._check_data_array(
                level.data,
                f"level {level.index}/data",
                self.attrs,
                state.shape,
                level.index,
                state,
                problems,
            )
            if level.index == 0:
                state.shape = shape
            expected_transform = schema.scale_transform(levels[0].transform, level.index)
            if level.transform != expected_transform:
                problems.append(f"level {level.index}: transform is not scaled from level 0")
            if self.attrs.levels is not None:
                if len(self.attrs.levels) != len(levels):
                    problems.append("chronozarr.levels: length differs from multiscales layout")
                else:
                    mirror = self.attrs.levels[level.index]
                    if (
                        mirror.shape != level.shape
                        or mirror.grid != level.grid
                        or mirror.transform != level.transform
                        or mirror.resolution != level.resolution
                    ):
                        problems.append(f"level {level.index}: chronozarr.levels mirror mismatch")
            for plane in (level.mask, level.coverage):
                if plane is not None:
                    schema._check_spatial(
                        plane,
                        self.attrs.crs,
                        level.transform,
                        level.shape[2],
                        level.shape[3],
                        plane.path,
                        problems,
                    )
                    schema._check_dims(plane, schema.PLANE_DIMENSIONS, plane.path, problems)
                    if plane.shape != (
                        level.shape[0],
                        *level.shape[2:],
                    ) or plane.dtype != np.dtype("uint8"):
                        problems.append(f"{plane.path}: incompatible shape or dtype")
        if problems:
            raise SchemaError("; ".join(problems))
        if isinstance(group.store, IndexStore):
            for level in levels:
                for array in (level.data, level.mask, level.coverage):
                    if array is None or array.shards is None:
                        continue
                    codec = cast("Any", array.metadata).codecs[0]
                    counts = tuple(s // c for s, c in zip(array.shards, array.chunks, strict=True))
                    index_size = codec._shard_index_size(counts)
                    interval = array.shards[0]
                    mutable = array.shape[0] // interval if array.shape[0] % interval else -1
                    inventory = (
                        (self.attrs.shard_bytes or {}).get(str(level.index), {})
                        if array is level.data
                        else {}
                    )
                    lengths = {
                        f"{array.path}/c/{key.split('/')[0]}/0/{'/'.join(key.split('/')[1:])}": n
                        for key, n in inventory.items()
                    }
                    group.store.configure(
                        f"{array.path}/c/",
                        index_size,
                        codec.index_location.value,
                        mutable,
                        lengths,
                    )
        self.dtype: np.dtype = levels[0].data.dtype
        self.nodata: int | float | None = self.attrs.nodata
        self._scale = np.array(
            [1.0 if b.scale is None else b.scale for b in self.attrs.bands], dtype=np.float32
        )
        self._offset = np.array(
            [0.0 if b.offset is None else b.offset for b in self.attrs.bands], dtype=np.float32
        )

    def _level(self, lod: int) -> Level:
        if not 0 <= lod < len(self.levels):
            raise IndexError(f"lod {lod} out of range: store has levels 0..{len(self.levels) - 1}")
        return self.levels[lod]

    def _check_time(self, t: int) -> int:
        if not 0 <= t < len(self.times):
            raise IndexError(f"timestep {t} out of range: store has {len(self.times)} timesteps")
        return int(t)

    def _window(self, level: Level, row: int, col: int, lod: int) -> tuple[slice, slice]:
        rows, cols = level.grid
        if not (0 <= row < rows and 0 <= col < cols):
            raise IndexError(
                f"cell ({row}, {col}) out of range: level {lod} has a {rows} x {cols} cell grid"
            )
        cs = level.chunk_size
        return (
            slice(row * cs, min((row + 1) * cs, level.shape[2])),
            slice(col * cs, min((col + 1) * cs, level.shape[3])),
        )

    def _read_region(
        self, level: Level, timesteps: Sequence[int], ys: slice, xs: slice
    ) -> np.ndarray:
        """Read ordinary stored values, with no cross-timestep reconstruction."""
        try:
            return np.asarray(level.data.oindex[np.asarray(timesteps, dtype=np.int64), :, ys, xs])
        except (ValueError, OSError, IndexError):
            if level.data.shards is None or not isinstance(self._group.store, IndexStore):
                raise
            self._group.store.invalidate_indices()
            return np.asarray(level.data.oindex[np.asarray(timesteps, dtype=np.int64), :, ys, xs])

    def _read_plane(
        self, array: zarr.Array, timesteps: Sequence[int], ys: slice, xs: slice
    ) -> np.ndarray:
        """Mask or coverage over a window: (len(timesteps), y, x) uint8."""
        return np.asarray(array.oindex[np.asarray(list(timesteps)), ys, xs])

    def _physical_region(
        self, level: Level, timesteps: Sequence[int], ys: slice, xs: slice
    ) -> np.ndarray:
        """Physical values over a window as float32 (time, band, y, x), NaN where invalid."""
        raw = self._read_region(level, timesteps, ys, xs)
        if level.mask is not None:
            valid = self._read_plane(level.mask, timesteps, ys, xs).astype(bool)[:, None]
        elif self.nodata is not None:
            valid = raw != self.dtype.type(self.nodata)
        else:
            valid = None
        values = raw.astype(np.float32)
        values *= self._scale[None, :, None, None]
        values += self._offset[None, :, None, None]
        if valid is not None:
            np.putmask(values, ~np.broadcast_to(valid, values.shape), np.float32(np.nan))
        return values

    def read(self, t: int, lod: int = 0) -> np.ndarray:
        """Decode timestep `t` of level `lod` as a (band, y, x) array of the stored dtype."""
        level = self._level(lod)
        window = slice(None)
        return self._read_region(level, [self._check_time(t)], window, window)[0]

    def read_cell(self, t: int, row: int, col: int, lod: int = 0) -> np.ndarray:
        """Decode one cell of timestep `t`: a (band, y, x) array of the stored dtype.

        Costs one data chunk read after metadata/index discovery. Edge cells are smaller than
        `chunk_size`; padding beyond the level shape is never returned.
        """
        level = self._level(lod)
        ys, xs = self._window(level, row, col, lod)
        return self._read_region(level, [self._check_time(t)], ys, xs)[0]

    def physical(self, t: int, lod: int = 0) -> np.ndarray:
        """Timestep `t` of level `lod` as float32 (band, y, x) physical values.

        value = stored * scale + offset per band; NaN where the pixel is invalid (mask is 0,
        or without a mask the stored value equals nodata).
        """
        level = self._level(lod)
        window = slice(None)
        return self._physical_region(level, [self._check_time(t)], window, window)[0]

    def read_mask(self, t: int, lod: int = 0) -> np.ndarray | None:
        """The (y, x) uint8 validity plane of timestep `t` (1 = valid), or None if absent."""
        level = self._level(lod)
        if level.mask is None:
            return None
        window = slice(None)
        return self._read_plane(level.mask, [self._check_time(t)], window, window)[0]

    def read_coverage(self, t: int, lod: int = 0) -> np.ndarray | None:
        """The (y, x) uint8 observation count of timestep `t`, or None if absent."""
        level = self._level(lod)
        if level.coverage is None:
            return None
        window = slice(None)
        return self._read_plane(level.coverage, [self._check_time(t)], window, window)[0]

    def _band_metadata(self, *, physical: bool) -> tuple[dict[str, Any], dict[str, Any]]:
        coords: dict[str, Any] = {}
        attrs: dict[str, Any] = {}
        bands = self.attrs.bands
        if any(b.units for b in bands):
            coords["band_units"] = ("band", [b.units or "" for b in bands])
            units = {b.units for b in bands}
            unscaled = all(b.scale in (None, 1) and b.offset in (None, 0) for b in bands)
            if len(units) == 1 and (physical or unscaled):
                attrs["units"] = bands[0].units
        return coords, attrs

    def to_xarray(
        self, lod: int = 0, times: Sequence[int] | None = None, *, physical: bool = False
    ) -> xr.DataArray:
        """Decode a level into a DataArray with dims (time, band, y, x) and full coordinates.

        `times` selects timestep indices (default: all). Values are the stored dtype, or float32
        physical values with NaN for invalid pixels when `physical` is true. The result is
        loaded into memory. When the store has a mask, validity is carried by a `mask` coordinate
        (uint8, dims time/y/x, 1 = valid) and no `nodata` attribute is set.
        """
        level = self._level(lod)
        selected = (
            list(range(len(self.times))) if times is None else [self._check_time(t) for t in times]
        )
        window = slice(None)
        read = self._physical_region if physical else self._read_region
        values = read(level, selected, window, window)
        y, x = schema.pixel_centers(level.transform, level.shape[2], level.shape[3])
        attrs: dict[str, Any] = {"crs": self.attrs.crs, "transform": list(level.transform)}
        coords: dict[str, Any] = {
            "time": self.times[selected].astype("datetime64[ns]"),
            "band": list(self.bands),
            "y": y,
            "x": x,
        }
        band_coords, band_attrs = self._band_metadata(physical=physical)
        coords.update(band_coords)
        attrs.update(band_attrs)
        if level.mask is not None:
            coords["mask"] = (
                schema.PLANE_DIMENSIONS,
                self._read_plane(level.mask, selected, window, window),
            )
        elif self.nodata is not None and not physical:
            attrs["nodata"] = self.nodata
        return xr.DataArray(
            values,
            dims=schema.DIMENSIONS,
            coords=coords,
            name=self.attrs.variable,
            attrs=attrs,
        )


def _plane(group: zarr.Group, name: str | None, where: str) -> zarr.Array | None:
    return None if name is None else schema.get_array(group, name, where)


def open_store(path_or_url: Any) -> ChronoStore:
    """Open a chronozarr store from a path, http(s) URL, or zarr Store.

    Raises SchemaError if the store is not a conforming chronozarr store (v0.3.0). An
    http(s) URL is read with `HttpStore` (Range requests, no fsspec needed).
    """
    try:
        transport = as_store(path_or_url)
        if isinstance(transport, str | Path):
            transport = LocalStore(transport, read_only=True)
        group = zarr.open_group(IndexStore(transport), mode="r", zarr_format=3)
    except (GroupNotFoundError, FileNotFoundError) as exc:
        raise SchemaError(
            f"{path_or_url}: no Zarr v3 group found; is this a chronozarr store?"
        ) from exc
    try:
        return ChronoStore(group, str(path_or_url))
    except ValueError as exc:
        raise SchemaError(str(exc)) from exc
