"""True-value chronozarr v0.3 writer with a bounded-memory block-mean pyramid."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
import warnings
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

import numpy as np
import xarray as xr
import zarr
from zarr.codecs import BloscCodec, ZstdCodec
from zarr.errors import ZarrUserWarning

from chronozarr import schema
from chronozarr._writer import (
    DEFAULT_CELLS_IN_FLIGHT as DEFAULT_CELLS_IN_FLIGHT,
)
from chronozarr._writer import (
    VOLATILITY_SCALE as VOLATILITY_SCALE,
)
from chronozarr._writer import (
    Block as Block,
)
from chronozarr._writer import (
    _ArraySource,
    _CellWriter,
    _iso_times,
    _LevelArrays,
    _mean_comparison,
    _prepare_input,
    _put_coord,
    _Pyramid,
    _resolve_bands,
    _resolve_nodata,
    _resolve_transform,
    _shard_bytes,
    _Source,
    _spill_timesteps,
    _write_time_coord,
)
from chronozarr._writer import (
    _downsample_plane_pair as _downsample_plane_pair,
)
from chronozarr._writer import (
    downsample_2x as downsample_2x,
)
from chronozarr._writer import (
    downsample_block as downsample_block,
)
from chronozarr.schema import (
    Band,
    Chronozarr,
    LevelRef,
    LevelSummary,
    RootAttrs,
    Transform,
)

DEFAULT_LEVEL = {"zstd": 5, "blosc-zstd-shuffle": 1}
LEVEL_RANGE = {"zstd": (1, 22), "blosc-zstd-shuffle": (0, 9)}


Codec = Literal["zstd", "blosc-zstd-shuffle"]


@dataclass(frozen=True)
class LevelReport:
    level: int
    shape: tuple[int, int, int, int]
    n_cells: int
    downsample_s: float  # producing this level from the one below, summed over threads
    encode_s: float  # optional volatility, summed over threads
    write_s: float  # zarr write incl. compression, summed over threads
    bytes: int


@dataclass(frozen=True)
class EncodeReport:
    levels: tuple[LevelReport, ...]
    total_bytes: int
    n_files: int
    codec: str
    level: int  # compression level


# --- Cell encode and write --------------------------------------------------------------------


@dataclass(frozen=True)
class _CellResult:
    encode_s: float
    write_s: float
    abs_delta_sum: float
    n_delta_values: int


def _encode_cell(
    block: Block,
    arrays: _LevelArrays,
    ys: slice,
    xs: slice,
    *,
    reference: Mapping[int, int],
    shard_time: int,
    want_volatility: bool,
) -> _CellResult:
    """Encode one cell (every timestep) and write it, one time shard at a time."""
    started = time.perf_counter()
    out = block.data
    total, count = _mean_comparison(block.data, reference) if want_volatility else (0.0, 0)
    encoded = time.perf_counter()

    n_time = block.data.shape[0]
    for t0 in range(0, n_time, shard_time):
        window = slice(t0, min(t0 + shard_time, n_time))
        arrays.data[window, :, ys, xs] = out[window]
        if arrays.mask is not None and block.mask is not None:
            arrays.mask[window, ys, xs] = block.mask[window]
        if arrays.coverage is not None and block.coverage is not None:
            arrays.coverage[window, ys, xs] = block.coverage[window]
    written = time.perf_counter()
    return _CellResult(encoded - started, written - encoded, total, count)


# --- Store writing ----------------------------------------------------------------------------


def _tree_stats(path: Path) -> tuple[int, int]:
    files = [p for p in path.rglob("*") if p.is_file()]
    return sum(p.stat().st_size for p in files), len(files)


def _write_coords(
    group: zarr.Group,
    transform: Transform,
    height: int,
    width: int,
    times_ms: np.ndarray,
    bands: Sequence[str],
) -> None:
    _write_time_coord(group, times_ms)
    _put_coord(group, "band", np.array(bands, dtype=object), str)
    y, x = schema.pixel_centers(transform, height, width)
    _put_coord(group, "x", x, "float64")
    _put_coord(group, "y", y, "float64")


def _compressors(codec: str, level: int) -> ZstdCodec | BloscCodec:
    if codec == "zstd":
        return ZstdCodec(level=level)
    return BloscCodec(cname="zstd", clevel=level, shuffle="shuffle")


@dataclass(frozen=True)
class _Layout:
    """Everything fixed before the first cell is written."""

    n_time: int
    n_band: int
    dtype: np.dtype
    nodata: int | float | None
    shapes: list[tuple[int, int]]
    chunk_size: int
    shard: bool
    shard_time: int
    crs: str
    transform: Transform
    times_iso: list[str]
    times_ms: np.ndarray
    bands: tuple[Band, ...]
    has_mask: bool
    has_coverage: bool
    codec: str
    level: int
    volatility: bool

    @property
    def fill_value(self) -> int | float:
        return self.nodata if self.nodata is not None else 0


def _create_level(root: zarr.Group, k: int, layout: _Layout) -> _LevelArrays:
    """Create level group `k` with its data, optional mask/coverage, and coordinate arrays."""
    height, width = layout.shapes[k]
    cs = layout.chunk_size
    transform = schema.scale_transform(layout.transform, k)
    group = root.create_group(str(k))
    group.attrs.update(schema.LevelAttrs(layout.crs, transform, transform[0]).to_attrs())
    compressor = _compressors(layout.codec, layout.level)

    def create(name: str, lead: tuple[int, ...], dtype: np.dtype, fill: int | float, dims: tuple):
        shape = (layout.n_time, *lead, height, width)
        array = group.create_array(
            name=name,
            shape=shape,
            dtype=dtype,
            fill_value=fill,
            dimension_names=dims,
            chunks=(1, *lead, cs, cs),
            shards=(layout.shard_time, *lead, cs, cs) if layout.shard else None,
            compressors=compressor,
            filters=None,
        )
        attrs = schema.data_array_attrs(
            layout.crs, transform, height, width, layout.nodata, dimensions=dims
        )
        return array, attrs

    data, attrs = create(
        schema.VARIABLE, (layout.n_band,), layout.dtype, layout.fill_value, schema.DIMENSIONS
    )
    if layout.nodata is not None:
        attrs["nodata"] = layout.nodata
    data.attrs.update(attrs)
    planes: list[zarr.Array | None] = []
    for name, wanted in (
        (schema.MASK_VARIABLE, layout.has_mask),
        (schema.COVERAGE_VARIABLE, layout.has_coverage),
    ):
        if not wanted:
            planes.append(None)
            continue
        array, attrs = create(name, (), np.dtype("uint8"), 0, schema.PLANE_DIMENSIONS)
        attrs.pop("nodata", None)
        array.attrs.update(attrs)
        planes.append(array)
    _write_coords(group, transform, height, width, layout.times_ms, [b.name for b in layout.bands])
    return _LevelArrays(data, planes[0], planes[1])


def _write_store(
    out: Path,
    layout: _Layout,
    source: _Source,
    *,
    provenance: dict | None,
    cells_in_flight: int,
) -> EncodeReport:
    cs = layout.chunk_size
    reference = schema.comparison_schedule(layout.n_time)
    root = zarr.open_group(str(out), mode="w", zarr_format=3)
    arrays = [_create_level(root, k, layout) for k in range(len(layout.shapes))]
    grids = [schema.grid_shape(h, w, cs) for h, w in layout.shapes]
    volatility = np.zeros(grids[0], dtype=np.float32)
    writer = _CellWriter[_CellResult](cells_in_flight)
    compute = ThreadPoolExecutor(max_workers=os.cpu_count() or 1)
    pyramid = _Pyramid(
        layout.shapes,
        cs,
        n_time=layout.n_time,
        n_band=layout.n_band,
        dtype=layout.dtype,
        nodata=layout.nodata,
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
            lambda: _encode_cell(
                block,
                arrays[k],
                ys,
                xs,
                reference=reference,
                shard_time=layout.shard_time,
                want_volatility=layout.volatility and k == 0,
            ),
        )

    try:
        pyramid.walk(submit)
        results = writer.results()
    except BaseException:
        writer.shutdown()
        raise
    finally:
        compute.shutdown(wait=True)
    writer.shutdown()
    downsample_s = pyramid.downsample_s

    per_level: dict[int, list[_CellResult]] = {k: [] for k in range(len(layout.shapes))}
    for k, row, col, result in results:
        per_level[k].append(result)
        if k == 0 and result.n_delta_values:
            mean_abs = result.abs_delta_sum / result.n_delta_values
            volatility[row, col] = min(max(mean_abs / VOLATILITY_SCALE, 0.0), 1.0)

    if layout.volatility:
        vol = root.create_array(
            name=schema.VOLATILITY_PATH,
            shape=volatility.shape,
            chunks=volatility.shape,
            dtype="float32",
            fill_value=0.0,
            dimension_names=("row", "col"),
        )
        vol[:] = volatility
        vol.attrs["_ARRAY_DIMENSIONS"] = ["row", "col"]

    summaries = tuple(
        LevelSummary(
            path=str(k),
            resolution=schema.scale_transform(layout.transform, k)[0],
            transform=schema.scale_transform(layout.transform, k),
            shape=(layout.n_time, layout.n_band, layout.shapes[k][0], layout.shapes[k][1]),
            grid=grids[k],
        )
        for k in range(len(layout.shapes))
    )
    meta = Chronozarr(
        times=tuple(layout.times_iso),
        bands=layout.bands,
        crs=layout.crs,
        volatility_path=schema.VOLATILITY_PATH if layout.volatility else None,
        nodata=layout.nodata,
        mask_variable=schema.MASK_VARIABLE if layout.has_mask else None,
        coverage_variable=schema.COVERAGE_VARIABLE if layout.has_coverage else None,
        provenance=provenance,
        levels=summaries,
        shard_bytes=_shard_bytes(out, len(layout.shapes)) if layout.shard else None,
    )
    datasets = tuple(LevelRef(str(k), layout.crs) for k in range(len(layout.shapes)))
    root.attrs.update(RootAttrs(meta, datasets).to_attrs())
    with warnings.catch_warnings():
        # zarr-python warns that consolidated metadata is outside the Zarr v3 spec. chronozarr
        # writes it deliberately (spec 3.1) so a reader learns every array in one GET.
        warnings.simplefilter("ignore", ZarrUserWarning)
        zarr.consolidate_metadata(str(out))

    total_bytes, n_files = _tree_stats(out)
    return EncodeReport(
        levels=tuple(
            LevelReport(
                level=k,
                shape=summaries[k].shape,
                n_cells=len(per_level[k]),
                downsample_s=downsample_s[k],
                encode_s=sum(r.encode_s for r in per_level[k]),
                write_s=sum(r.write_s for r in per_level[k]),
                bytes=_tree_stats(out / str(k))[0],
            )
            for k in range(len(layout.shapes))
        ),
        total_bytes=total_bytes,
        n_files=n_files,
        codec=layout.codec,
        level=layout.level,
    )


# --- Public entry point -----------------------------------------------------------------------


def _check_codec(codec: str, level: int | None) -> int:
    if codec not in DEFAULT_LEVEL:
        raise ValueError(f"codec must be one of {list(DEFAULT_LEVEL)}, got {codec!r}")
    resolved = DEFAULT_LEVEL[codec] if level is None else level
    low, high = LEVEL_RANGE[codec]
    if not isinstance(resolved, int) or not low <= resolved <= high:
        raise ValueError(f"level for {codec} must be an int in {low}..{high}, got {level!r}")
    return resolved


def encode(
    data: xr.DataArray | Iterable[np.ndarray],
    out: str | Path,
    *,
    crs: str | None = None,
    transform: Sequence[float] | None = None,
    times: Sequence | np.ndarray | None = None,
    bands: Sequence[str | Band | Mapping] | None = None,
    volatility: bool = False,
    codec: Codec = "zstd",
    level: int | None = None,
    nodata: int | float | str | None = "default",
    mask: object = None,
    coverage: object = None,
    provenance: Mapping | None = None,
    chunk_size: int = 512,
    shard: bool = False,
    shard_time: int | None = None,
    n_lods: int | None = None,
    workers: int | None = None,
    spill_dir: str | Path | None = None,
) -> EncodeReport:
    """Write `data` as a chronozarr v0.3 store at `out`.

    Args:
        data: Either a DataArray with dims (time, band, y, x) whose dtype is uint8, uint16,
            int16 or float32 (numpy, or dask/lazy: one spatial cell is read at a time), or an
            iterable of per-timestep (band, y, x) arrays in time order, which needs `times`,
            `crs`, `transform` and `bands`. An iterable is written once to cell-major temp
            files, then encoded cell by cell, so memory does not grow with the raster.
        out: Directory to create. Must not exist or must be empty (stores are immutable).
        crs: CRS string such as "EPSG:32631". Falls back to `data.attrs["crs"]`.
        transform: Affine coefficients (a, b, c, d, e, f) of the north-up level-0 grid. Falls
            back to `data.attrs["transform"]`, then to the x/y pixel-centre coordinates.
        times: datetime64 timestamps, strictly increasing (iterable input only).
        bands: Band names, or Band objects / dicts {name, common_name, scale, offset, units}.
            Default: the DataArray band coordinate.
        volatility: Opt in to the optional cell-ordering metric (nominal interval 6).
        codec: "zstd" (default) or "blosc-zstd-shuffle" (blosc, zstd inside, byte shuffle).
        level: Compression level. Default 5 for zstd (1..22), 1 for blosc (0..9).
        nodata: Value marking invalid pixels, or None for none. "default" is 0 for uint8 and
            uint16 and None for int16 and float32, and None whenever `mask` is given.
        mask: Optional uint8 validity plane (1 = valid), (time, y, x) DataArray, or an iterable
            of per-timestep (y, x) arrays when `data` is an iterable. Overrides nodata for
            pyramid means and readers.
        coverage: Optional uint8 count of valid observations per pixel, same shape rules.
        provenance: Optional {"sources": [...], "composite": str, "gap_fill": "carry-forward" |
            "none", "notes": str}.
        chunk_size: Spatial chunk (and cell) edge in pixels; even. 512 (default) and 256 are
            the spec values; smaller even sizes exist for tests.
        shard: False (default): one object per (timestep, cell, level), no shard index, a CDN
            miss costs one chunk and an append writes only new objects. True: one object per
            (time shard, cell, level), far fewer objects, but a miss costs a whole shard and an
            append rewrites the trailing one.
        shard_time: Timesteps per shard along time; needs `shard=True`. Default: all of them. A
            value larger than the timesteps given is allowed: the first shard then holds them
            and any appended later.
        n_lods: Number of pyramid levels including level 0. Default: stop at the first level
            whose cell grid is 1 x 1.
        workers: Cells encoded concurrently (each holds about two copies of a cell in memory;
            zarr compresses a cell's chunks in parallel). Default 4.
        spill_dir: Directory for the temp files of iterable input. Default: next to `out`.

    Removes the partially written store if encoding fails.
    """
    if chunk_size < 2 or chunk_size % 2:
        raise ValueError(f"chunk_size must be an even number, got {chunk_size}")
    resolved_level = _check_codec(codec, level)
    cells_in_flight = workers if workers is not None else DEFAULT_CELLS_IN_FLIGHT
    if cells_in_flight < 1:
        raise ValueError(f"workers must be >= 1, got {cells_in_flight}")

    prepared = _prepare_input(data, times, mask, coverage)
    resolved_crs = crs if crs is not None else prepared.attrs.get("crs")
    if not resolved_crs:
        raise ValueError("no crs: pass crs='EPSG:xxxxx' or set da.attrs['crs']")
    if schema._EPSG_RE.fullmatch(str(resolved_crs)) is None:
        raise ValueError("only EPSG north-up grids are supported")
    base_transform = _resolve_transform(transform, prepared.da)
    times_iso, times_ms = _iso_times(prepared.times)
    if len(times_iso) != prepared.n_time:
        raise ValueError(f"{len(times_iso)} times for {prepared.n_time} timesteps")
    resolved_bands = tuple(
        replace(
            b,
            scale=1.0 if b.scale is None else b.scale,
            offset=0.0 if b.offset is None else b.offset,
        )
        for b in _resolve_bands(bands, prepared.band_coords, prepared.n_band)
    )
    resolved_nodata = _resolve_nodata(nodata, prepared.dtype, has_mask=prepared.mask is not None)
    resolved_provenance = None if provenance is None else schema.parse_provenance(provenance)
    if shard_time is not None and shard_time < 1:
        raise ValueError(f"shard_time must be at least 1, got {shard_time}")
    if shard_time is not None and not shard:
        raise ValueError(f"shard_time={shard_time} applies to sharded stores; pass shard=True")

    layout = _Layout(
        n_time=prepared.n_time,
        n_band=prepared.n_band,
        dtype=prepared.dtype,
        nodata=resolved_nodata,
        shapes=schema.level_shapes(prepared.height, prepared.width, chunk_size, n_lods),
        chunk_size=chunk_size,
        shard=shard,
        shard_time=shard_time if shard_time is not None else prepared.n_time,
        crs=str(resolved_crs),
        transform=base_transform,
        times_iso=times_iso,
        times_ms=times_ms,
        bands=resolved_bands,
        has_mask=prepared.mask is not None,
        has_coverage=prepared.coverage is not None,
        codec=codec,
        level=resolved_level,
        volatility=volatility,
    )

    out = Path(out)
    existed = out.exists()
    if existed and any(out.iterdir()):
        raise FileExistsError(
            f"{out} already exists and is not empty; stores are immutable, write to a new path"
        )

    spill: Path | None = None
    try:
        if prepared.da is not None:
            source: _Source = _ArraySource(
                prepared.da,
                prepared.mask if isinstance(prepared.mask, xr.DataArray) else None,
                prepared.coverage if isinstance(prepared.coverage, xr.DataArray) else None,
                chunk_size,
            )
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            spill = Path(
                tempfile.mkdtemp(
                    prefix=f".{out.name}-spill-", dir=str(spill_dir) if spill_dir else out.parent
                )
            )
            source = _spill_timesteps(
                prepared,
                spill,
                chunk_size=chunk_size,
                has_mask=layout.has_mask,
                has_coverage=layout.has_coverage,
            )
        return _write_store(
            out, layout, source, cells_in_flight=cells_in_flight, provenance=resolved_provenance
        )
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        if existed:
            out.mkdir()
        raise
    finally:
        if spill is not None:
            shutil.rmtree(spill, ignore_errors=True)
