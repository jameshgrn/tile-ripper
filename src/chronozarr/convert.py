"""Streaming conversion of COG manifests, Zarr variables and NetCDF files to a chronozarr store.

The source is read one timestep at a time and staged as a raw `.npy` per timestep in a work
directory, then handed to `encode()` as an iterable of timesteps, which spills and encodes cell
by cell. Peak memory is about one timestep times `read_ahead`; disk is the raw stack once in the
work directory, once more in `encode`'s cell-major spill, plus the output. Staged timesteps are
the unit of `resume`: an interrupted run keeps them, and a rerun reads only the missing ones.

Three input kinds are recognised from SOURCE:

* a manifest (`.csv` or `.json`) of COG or image-frame (PNG) URIs with timestamps, one URI per
  timestep;
* a Zarr store (local path or http(s) URL) with a chosen variable;
* a NetCDF file (`.nc`, `.nc4`, `.cdf`) with a chosen variable (needs an xarray NetCDF engine).

Needs rasterio (`chronozarr[geo]`) for COG manifests and for the CRS handling of all kinds.

Fidelity rules. The store carries the source's scale, offset, units and validity, or the
conversion fails; nothing is guessed.

Scale, offset and units:

1. COG: rasterio's per-band `scales`, `offsets`, `units` and `descriptions` become the band
   objects. Scale and offset are always written (1 and 0 when the source sets none). A store
   holds one value per band for every timestep, so each must be identical in all sources, band by
   band; the first source that differs fails the conversion and is named. Descriptions name the
   bands unless the manifest does, and must agree too. An alpha band (colour interpretation
   alpha) is not a data band: it is not stored as data and becomes the mask (rule 4).
2. Zarr and NetCDF: the variable's CF `scale_factor`, `add_offset` and `units` apply to every
   band (1 and 0 when absent); a scale that is zero or not finite fails.

Validity. A store marks invalid pixels either with one `nodata` sentinel, judged per band with no
mask, or with a `mask` variable shared by all bands (spec 2.3, 2.4).

3. Sentinel, only when faithful: every source declares the same nodata value (representable in
   the dtype and finite) on every data band and has no mask or alpha band, and no timestep is
   warped. The store's nodata is that value and there is no `mask`. A source that declares no
   nodata and has no mask yields a store with no nodata (every pixel valid, a stored 0 is data),
   not the encoder default of 0.
4. Mask otherwise: the store gets a `mask` variable when any source has an alpha band, an
   internal or per-dataset mask, or a nodata value that cannot be the store's (NaN, infinite,
   differing between sources or bands, or declared on only some of them); when a timestep is
   warped and the store has no nodata sentinel (pixels outside the source footprint are invalid);
   or when a Zarr/NetCDF variable names its mask with `--mask-var`. A store with a mask has no
   nodata (so a valid value equal to the old sentinel stays valid), unless `--nodata` gives one.
5. Mask content, 1 = valid. COG: the alpha band is nonzero (alpha wins over everything else, as
   in GDAL; a partly transparent pixel is valid), else the pixel is valid in every data band
   under GDAL's band masks (internal mask, per-dataset mask or nodata value). One plane cannot say
   that bands disagree, so a pixel invalid in any band is invalid for all of them; the stored
   values of the other bands are kept. Zarr/NetCDF: the `--mask-var` variable is nonzero (it must
   be boolean or integer with dims time, y, x; invert a "1 = bad" flag first) and no band
   holds a declared `_FillValue` or `missing_value`. valid_min, valid_max and valid_range are not
   applied; fold them into a `--mask-var`.
6. Values under a zero mask keep the source values, so the store loses no bytes, except NaN
   (never stored; spec 2.3), which becomes the fill value (the nodata, else 0), and except in a
   warped timestep, where the warper does not copy masked source pixels (they take the fill
   value). A float source
   with NaN in a sentinel store fails and names the timestep: declare NaN as the source nodata or
   pass `--nodata nan`, which writes a mask.
7. `--nodata N` replaces the nodata the sources declare: pixels equal to N are invalid and the
   sources' own nodata values are ordinary data (alpha and mask bands still apply). `--nodata none`
   ignores declared nodata values and stores none; `--nodata nan` (float data) marks NaN invalid
   through a mask.
8. Warped COG timesteps use the nearest-neighbour resampling of their validity plane, whatever
   `--resampling` says for the values.

Image frames. A sequence of rendered, georeferenced PNGs (Earth Engine thumbnails, QGIS and
matplotlib exports, drone pipelines) converts like COGs, with no GeoTIFF step; GDAL reads the
frames, so every rule above applies to them. A frame is display values, not measurements: nothing
is rescaled and the store holds exactly the 8-bit (or 16-bit) values of the file.

9. Georeferencing comes from the frame: a `.png.aux.xml` sidecar (CRS and geotransform), or a world
   file (`.pgw`, else `.wld`) beside it, which holds the transform and no CRS. Sidecars are found
   next to local and remote PNGs alike; for other formats they are not looked for. A frame whose
   CRS is missing takes `crs` (`--crs`), which is then both its CRS and the target CRS, so nothing
   is warped; a frame with a geotransform and no CRS and no `crs` fails.
10. A frame with no georeferencing at all fails, unless `bounds` (`--bounds west,south,east,north`,
   in the units of `crs`; or a `"bounds"` entry in a JSON manifest) gives the extent of every
   frame. The north-up transform is then derived from each frame's pixel size, so all frames must
   have the same size, and a frame that carries its own geotransform is refused (drop `bounds`, or
   remove the sidecar). `bounds` needs `crs` and applies to manifests only.
11. Bands. Red, green and blue colour bands are named red, green and blue and get those common
   names, so the viewer's True color product works; a band the manifest or the file's band
   description names keeps that name and gets no common name. Other bands are named by their
   1-based index. An alpha band is the mask (rule 5): an RGBA frame becomes three bands plus
   `mask`, 0 where alpha is 0.
12. A palette (indexed colour) PNG fails: its stored values are palette indices, not colours.
   Expand it first (`gdal_translate -expand rgba in.png out.png`) or save the frames as RGB.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import time
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from numcodecs import Zstd

from chronozarr import schema
from chronozarr._convert_cog import (
    GDAL_ENV as GDAL_ENV,
)
from chronozarr._convert_cog import (
    RESAMPLING_METHODS as RESAMPLING_METHODS,
)
from chronozarr._convert_cog import (
    SIDECAR_SUFFIXES as SIDECAR_SUFFIXES,
)
from chronozarr._convert_cog import (
    CogManifestSource as CogManifestSource,
)
from chronozarr._convert_cog import (
    _gdal_env as _gdal_env,
)
from chronozarr._convert_cog import (
    _tolerate_unlocated_frames,
)
from chronozarr._convert_manifest import (
    Entry as Entry,
)
from chronozarr._convert_manifest import (
    Manifest as Manifest,
)
from chronozarr._convert_manifest import (
    parse_time as parse_time,
)
from chronozarr._convert_manifest import (
    read_manifest as read_manifest,
)
from chronozarr._convert_source import (
    Bounds as Bounds,
)
from chronozarr._convert_source import (
    Grid as Grid,
)
from chronozarr._convert_source import (
    Source as Source,
)
from chronozarr._convert_source import (
    SourceInfo as SourceInfo,
)
from chronozarr._convert_source import (
    Step as Step,
)
from chronozarr._convert_source import (
    Validity as Validity,
)
from chronozarr._convert_source import (
    _check_north_up,
)
from chronozarr._convert_source import (
    check_bounds as check_bounds,
)
from chronozarr._convert_xarray import (
    NETCDF_SUFFIXES as NETCDF_SUFFIXES,
)
from chronozarr._convert_xarray import (
    XarraySource as XarraySource,
)
from chronozarr._convert_xarray import (
    _parse_dims,
)
from chronozarr.encode import EncodeReport, encode

# Raw input bytes per second through `encode()` (spill, pyramid, zstd level 5, write). Measured
# 230 to 260 MB/s on the 117-month Ucayali stack (7.1 GB in 27 to 31 s) on a 16-thread M3 Max
# laptop with other work running, 2026-09-30; set lower so estimates err on the long side.
ENCODE_BYTES_PER_S = 150e6
SAMPLE_TIMESTEPS = 3
# The fidelity rules in the module docstring, as `chronozarr convert --help` text (click
# paragraphs: a backspace line keeps the lines of the block that follows).
FIDELITY_HELP = """\
Scale, offset, units and validity are carried over from the source, or the conversion fails.

\b
Scale and offset: COG per-band scales, offsets, units and descriptions become the band objects
and must be identical in every source; an alpha band is not data, it becomes the mask.
Zarr/NetCDF: the CF scale_factor, add_offset and units of the variable apply to every band.

\b
Validity is either one nodata sentinel (judged per band, no mask) or one mask shared by all bands:
  sentinel  every source declares the same finite nodata (or none), has no mask or alpha band,
            and no timestep is warped. No nodata declared means no nodata: a stored 0 is data.
  mask      any alpha band, internal mask or --mask-var; a nodata that cannot be the store's
            (NaN, infinite, differing between sources or bands); or warped sources with no
            nodata (pixels outside their footprint). The store then has no nodata unless
            --nodata gives one. A pixel invalid in any band is invalid for all.
  NaN is never stored: under a mask it becomes 0. A float source with undeclared NaN fails;
  --nodata nan treats NaN as invalid. --nodata N replaces the declared nodata; none ignores it.

\b
Image frames (PNG): GDAL reads them like COGs and the rules above apply; the values are stored
as the file holds them (display values, not measurements).
  georeferencing  a .png.aux.xml (CRS and transform) or a world file .pgw (transform only)
                  beside the frame. A frame without a CRS takes --crs.
  no sidecar      --bounds west,south,east,north (units of --crs) derives the north-up transform
                  from the image size; every frame must then have the same size and none may
                  carry its own transform. A JSON manifest can hold "bounds" instead.
  bands           red, green, blue (common names set); the alpha band becomes the mask.
  palette PNG     refused: expand it to RGB first (gdal_translate -expand rgba).
"""


def _duration(seconds: float) -> str:
    return f"{seconds:.1f} s" if seconds < 120 else f"{seconds / 60:.1f} min"


# --- Plan ---------------------------------------------------------------------------------------


@dataclass
class Plan:
    """Everything `convert` decided before reading pixels, including size and time estimates."""

    source: Source
    n_time: int
    timestep_bytes: int
    raw_bytes: int
    n_levels: int
    sample_ratio: float | None
    est_output_bytes: int | None
    sample_read_s: float | None
    est_encode_s: float
    warped: int
    samples: dict[int, Step] = field(default_factory=dict, repr=False)

    def lines(self, read_ahead: int = 2) -> list[str]:
        info = self.source.info
        times = self.source.times
        out = [
            f"source:     {self.source.kind}, {self.n_time} timesteps "
            f"({np.datetime_as_string(times[0], unit='D')} .. "
            f"{np.datetime_as_string(times[-1], unit='D')})",
            f"grid:       {info.grid.describe()}",
            f"data:       {info.n_band} bands ({', '.join(info.band_names)}), {info.dtype.name}",
            "scaling:    "
            + ", ".join(
                f"{b.name} = stored * {1.0 if b.scale is None else b.scale:g} "
                f"{0.0 if b.offset is None else b.offset:+g}"
                + (f" [{b.units}]" if b.units else "")
                for b in info.bands
            ),
            f"validity:   {info.validity}",
        ]
        if self.warped:
            out.append(
                f"resampling: {self.warped} of {self.n_time} timesteps are warped onto the grid"
            )
        else:
            out.append("resampling: none needed, every source is on the target grid")
        out.append(
            f"raw size:   {self.raw_bytes / 1e9:.2f} GB "
            f"({self.timestep_bytes / 1e6:.0f} MB per timestep; memory about "
            f"{(1 + read_ahead) * self.timestep_bytes / 1e6:.0f} MB while staging)"
        )
        if self.est_output_bytes is not None and self.sample_ratio is not None:
            out.append(
                f"output:     about {self.est_output_bytes / 1e9:.2f} GB in "
                f"{self.n_levels} levels "
                f"(zstd 5 ratio {self.sample_ratio:.2f} on {len(self.samples) or SAMPLE_TIMESTEPS}"
                " sampled cells)"
            )
        if self.sample_read_s is not None:
            out.append(
                f"time:       read about {self.sample_read_s:.2f} s per timestep "
                f"({_duration(self.sample_read_s * self.n_time)} sequential, less with "
                f"--read-ahead), encode about {_duration(self.est_encode_s)}"
            )
        return out


def _sample_ratio(samples: Sequence[Step], chunk_size: int) -> float:
    """Mean zstd-5 compressed/raw ratio of the top-left cell of each sampled timestep."""
    codec = Zstd(level=5)
    ratios = []
    for step in samples:
        window = np.ascontiguousarray(step.data[:, :chunk_size, :chunk_size])
        ratios.append(len(codec.encode(window)) / window.nbytes)
    return float(np.mean(ratios))


def _sample_indices(n: int) -> list[int]:
    return sorted({0, n // 2, n - 1})[:SAMPLE_TIMESTEPS]


@_tolerate_unlocated_frames
def plan_conversion(
    source_path: str | Path,
    *,
    variable: str | None = None,
    dims: str | None = None,
    crs: str | None = None,
    transform: Sequence[float] | None = None,
    shape: tuple[int, int] | None = None,
    resampling: str | None = None,
    nodata: float | int | str | None = "auto",
    mask_var: str | None = None,
    bounds: Sequence[float] | None = None,
    chunk_size: int = 512,
    n_lods: int | None = None,
    sample: bool = True,
) -> Plan:
    """Open the source, check it is consistent and estimate the conversion.

    Reads `SAMPLE_TIMESTEPS` timesteps (when `sample`) to measure read time and compression.
    """
    text = str(source_path)
    suffix = Path(text).suffix.lower()
    is_manifest = suffix in (".csv", ".json")
    source: Source
    if is_manifest:
        if variable is not None or dims is not None or mask_var is not None:
            raise ValueError(
                "--variable, --dims and --mask-var apply to Zarr and NetCDF input, not manifests"
            )
        manifest = read_manifest(Path(text))
        if bounds is not None and manifest.bounds is not None:
            raise ValueError(
                f"{text} has bounds and bounds were also passed (--bounds); give them once"
            )
        frame_bounds = manifest.bounds if bounds is None else check_bounds(bounds, "--bounds")
        if frame_bounds is not None and crs is None:
            raise ValueError("bounds need crs (--crs EPSG:xxxxx), the CRS they are in")
        source = CogManifestSource(
            manifest.entries,
            manifest.bands,
            target_crs=crs,
            target_transform=None
            if transform is None
            else _check_north_up(transform, "--transform"),
            target_shape=shape,
            resampling=resampling,
            nodata=nodata,
            chunk_size=chunk_size,
            bounds=frame_bounds,
        )
    else:
        from chronozarr._convert_legacy import LegacySource, legacy_metadata

        metadata = legacy_metadata(source_path)
        if metadata is not None:
            source = LegacySource(source_path)
            if (
                any(
                    v is not None
                    for v in (variable, dims, crs, transform, shape, resampling, mask_var, bounds)
                )
                or nodata != "auto"
            ):
                raise ValueError(
                    "legacy migration preserves source metadata; input overrides are forbidden"
                )
        if transform is not None or shape is not None or resampling is not None or bounds:
            raise ValueError(
                "--transform, --shape, --bounds and --resampling apply to manifests of COGs or "
                "image frames; a Zarr or NetCDF input keeps the grid of its x/y coordinates "
                "(--crs only declares its CRS)"
            )
        if metadata is None:
            source = XarraySource(text, variable, _parse_dims(dims), crs, nodata, mask_var)

    info = source.info
    n_time = len(source.times)
    timestep_bytes = info.n_band * info.grid.height * info.grid.width * info.dtype.itemsize
    from chronozarr._convert_legacy import LegacySource

    shapes = (
        [tuple(a.shape[2:]) for a in source.data]
        if isinstance(source, LegacySource)
        else schema.level_shapes(info.grid.height, info.grid.width, chunk_size, n_lods)
    )
    pyramid = sum(h * w for h, w in shapes) / (info.grid.height * info.grid.width)
    plan = Plan(
        source=source,
        n_time=n_time,
        timestep_bytes=timestep_bytes,
        raw_bytes=timestep_bytes * n_time,
        n_levels=len(shapes),
        sample_ratio=None,
        est_output_bytes=None,
        sample_read_s=None,
        est_encode_s=timestep_bytes * n_time / ENCODE_BYTES_PER_S,
        warped=len(source.warped),
    )
    if sample:
        seconds = []
        for t in _sample_indices(n_time):
            started = time.perf_counter()
            plan.samples[t] = _read_checked(source, t)
            seconds.append(time.perf_counter() - started)
        plan.sample_read_s = float(np.mean(seconds))
        plan.sample_ratio = _sample_ratio(list(plan.samples.values()), chunk_size)
        plan.est_output_bytes = int(plan.raw_bytes * plan.sample_ratio * pyramid)
    return plan


def _read_checked(source: Source, t: int) -> Step:
    info = source.info
    step = source.read(t)
    expected = (info.n_band, info.grid.height, info.grid.width)
    if step.data.shape != expected or step.data.dtype != info.dtype:
        raise ValueError(
            f"timestep {t} came back as {step.data.dtype}{step.data.shape}; "
            f"expected {info.dtype}{expected}"
        )
    plane = (info.grid.height, info.grid.width)
    if info.mask != (step.valid is not None) or (
        step.valid is not None and (step.valid.shape != plane or step.valid.dtype != np.uint8)
    ):
        raise ValueError(
            f"timestep {t} came back with the wrong validity plane for: {info.validity}"
        )
    return step


# --- Staging and conversion ---------------------------------------------------------------


@dataclass(frozen=True)
class ConvertReport:
    plan: Plan
    encode: EncodeReport | None  # None for a dry run
    n_staged: int  # timesteps read from the source in this run
    n_reused: int  # timesteps found already staged (resume)
    read_s: float
    encode_s: float

    @property
    def total_s(self) -> float:
        return self.read_s + self.encode_s


def _staged_path(work: Path, t: int) -> Path:
    return work / f"t{t:06d}.npy"


def _staged_mask_path(work: Path, t: int) -> Path:
    return work / f"m{t:06d}.npy"


def _is_valid_file(path: Path, shape: tuple[int, ...], dtype: np.dtype) -> bool:
    if not path.is_file():
        return False
    try:
        staged = np.load(path, mmap_mode="r")
    except (ValueError, OSError):
        return False
    return staged.shape == shape and staged.dtype == dtype


def _is_staged(work: Path, t: int, plan: Plan) -> bool:
    info = plan.source.info
    plane = (info.grid.height, info.grid.width)
    return _is_valid_file(_staged_path(work, t), (info.n_band, *plane), info.dtype) and (
        not info.mask or _is_valid_file(_staged_mask_path(work, t), plane, np.dtype(np.uint8))
    )


def _check_work_dir(work: Path, plan: Plan, resume: bool) -> None:
    plan_file = work / "plan.json"
    fingerprint = json.dumps(plan.source.fingerprint(), sort_keys=True)
    digest = hashlib.sha256(fingerprint.encode()).hexdigest()
    if work.exists() and any(work.iterdir()):
        if not resume:
            raise FileExistsError(
                f"{work} holds timesteps staged by an earlier run. Pass --resume to reuse them, "
                "or delete the directory to start over"
            )
        recorded = json.loads(plan_file.read_text()) if plan_file.is_file() else {}
        if recorded.get("sha256") != digest:
            raise ValueError(
                f"{work} was staged for a different input or options (plan hash "
                f"{str(recorded.get('sha256'))[:12]} vs {digest[:12]}); delete it or rerun "
                "without --resume in a fresh work directory"
            )
    work.mkdir(parents=True, exist_ok=True)
    plan_file.write_text(json.dumps({"sha256": digest, "plan": json.loads(fingerprint)}))


def _stage(
    plan: Plan,
    work: Path,
    read_ahead: int,
    progress: Callable[[int, int], None] | None,
) -> tuple[int, int]:
    """Read every missing timestep into `work`. Returns (staged, reused)."""
    todo = [t for t in range(plan.n_time) if not _is_staged(work, t, plan)]
    reused = plan.n_time - len(todo)
    if progress is not None:
        progress(reused, plan.n_time)

    def read_one(t: int) -> Step:
        if t in plan.samples:
            return plan.samples.pop(t)
        return _read_checked(plan.source, t)

    def save(target: Path, array: np.ndarray) -> None:
        temporary = target.with_suffix(".npy.part")
        with temporary.open("wb") as handle:
            np.save(handle, array)
        temporary.replace(target)

    done = reused
    with ThreadPoolExecutor(max_workers=read_ahead) as pool:
        pending: deque[tuple[int, Future[Step]]] = deque()
        queue = iter(todo)
        for t in queue:
            pending.append((t, pool.submit(read_one, t)))
            if len(pending) >= read_ahead:
                break
        while pending:
            t, future = pending.popleft()
            step = future.result()
            if step.valid is not None:
                save(_staged_mask_path(work, t), step.valid)
            save(_staged_path(work, t), step.data)
            del step
            done += 1
            if progress is not None:
                progress(done, plan.n_time)
            following = next(queue, None)
            if following is not None:
                pending.append((following, pool.submit(read_one, following)))
    return len(todo), reused


def _staged_timesteps(plan: Plan, work: Path) -> Iterator[np.ndarray]:
    for t in range(plan.n_time):
        yield np.load(_staged_path(work, t))


def _staged_masks(plan: Plan, work: Path) -> Iterator[np.ndarray]:
    for t in range(plan.n_time):
        yield np.load(_staged_mask_path(work, t))


@_tolerate_unlocated_frames
def convert(
    source: str | Path,
    out: str | Path,
    *,
    variable: str | None = None,
    dims: str | None = None,
    crs: str | None = None,
    transform: Sequence[float] | None = None,
    shape: tuple[int, int] | None = None,
    resampling: str | None = None,
    nodata: float | int | str | None = "auto",
    mask_var: str | None = None,
    bounds: Sequence[float] | None = None,
    work_dir: str | Path | None = None,
    resume: bool = False,
    dry_run: bool = False,
    read_ahead: int = 2,
    on_plan: Callable[[Plan], None] | None = None,
    progress: Callable[[int, int], None] | None = None,
    **encode_options: Any,
) -> ConvertReport:
    """Convert `source` into a chronozarr store at `out` without holding the whole stack.

    `source` is a manifest (`.csv`/`.json`), a Zarr store (path or URL) or a NetCDF file; see the
    module docstring. The grid comes from the first source (manifests) or the x/y coordinates
    (Zarr, NetCDF) unless `crs`, `transform` and `shape` override it for a manifest, in which
    case sources off the grid are warped with the explicit `resampling`.

    Image frames (PNG) are manifest sources. `crs` names the CRS of frames that carry none (a
    world file has none). `bounds` is `(west, south, east, north)` in the units of `crs`, the
    extent of every frame, for frames with no geotransform (no world file, no `.aux.xml`): the
    transform is derived from the pixel size, all frames must have the same size, and a frame
    with its own geotransform is refused. A JSON manifest can hold `"bounds"` instead.

    Scale, offset, units and validity follow the fidelity rules of the module docstring.
    `nodata` is "auto" (what the sources declare; none declared means no nodata, not 0), a
    number that replaces the declared nodata, None (no nodata) or NaN (float data: NaN pixels are
    invalid, through a mask). `mask_var` names a boolean or integer (time, y, x) variable of a
    Zarr or NetCDF source whose nonzero values are valid; the store then gets a mask.

    `on_plan` receives the `Plan` (sizes, estimates) before any data is staged; `dry_run` stops
    there. Timesteps are staged under `work_dir` (default `<out>.convert-work` beside `out`):
    it is removed on success and kept on failure, and `resume=True` reuses its timesteps.
    `encode_options` go to `chronozarr.encode`: chunk_size, codec, level, volatility,
    shard, shard_time, n_lods, workers, provenance.
    """
    if read_ahead < 1:
        raise ValueError(f"read_ahead must be >= 1, got {read_ahead}")
    out_path = Path(out)
    if not dry_run and out_path.exists() and any(out_path.iterdir()):
        raise FileExistsError(
            f"{out_path} already exists and is not empty; stores are immutable, write to a "
            "new path"
        )
    plan = plan_conversion(
        source,
        variable=variable,
        dims=dims,
        crs=crs,
        transform=transform,
        shape=shape,
        resampling=resampling,
        nodata=nodata,
        mask_var=mask_var,
        bounds=bounds,
        chunk_size=encode_options.get("chunk_size", 512),
        n_lods=encode_options.get("n_lods"),
    )
    if on_plan is not None:
        on_plan(plan)
    if dry_run:
        return ConvertReport(plan, None, 0, 0, 0.0, 0.0)

    from chronozarr._convert_legacy import LegacySource, migrate

    if isinstance(plan.source, LegacySource):
        if encode_options:
            # CLI passes writer defaults; migrations preserve the source layout and codecs.
            defaults = {
                "chunk_size": 512,
                "codec": "zstd",
                "level": None,
                "volatility": False,
                "shard": False,
                "shard_time": None,
                "n_lods": None,
                "workers": None,
            }
            if any(k not in defaults or v != defaults[k] for k, v in encode_options.items()):
                raise ValueError(
                    "legacy migration preserves chunks; writer overrides are forbidden"
                )
        started = time.perf_counter()
        report = migrate(plan.source, out_path, progress)
        return ConvertReport(plan, report, 0, 0, 0, time.perf_counter() - started)

    work = (
        Path(work_dir)
        if work_dir is not None
        else out_path.parent / f"{out_path.name}.convert-work"
    )
    _check_work_dir(work, plan, resume)
    info = plan.source.info
    try:
        started = time.perf_counter()
        staged, reused = _stage(plan, work, read_ahead, progress)
        read_s = time.perf_counter() - started

        started = time.perf_counter()
        report = encode(
            _staged_timesteps(plan, work),
            out_path,
            times=np.array(plan.source.times, dtype="datetime64[ms]"),
            bands=list(info.bands),
            crs=info.grid.crs,
            transform=info.grid.transform,
            nodata=info.nodata,
            mask=_staged_masks(plan, work) if info.mask else None,
            **encode_options,
        )
        encode_s = time.perf_counter() - started
    except BaseException as exc:
        exc.add_note(f"staged timesteps are kept in {work}; rerun with --resume to reuse them")
        raise
    shutil.rmtree(work)
    return ConvertReport(plan, report, staged, reused, read_s, encode_s)
