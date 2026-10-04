"""Command line interface: `chronozarr encode | append | validate | info | doctor` and more."""

from __future__ import annotations

import glob
import re
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import click
import numpy as np
import xarray as xr

from chronozarr import schema
from chronozarr.append import append, is_store
from chronozarr.convert import FIDELITY_HELP, RESAMPLING_METHODS, Plan, convert
from chronozarr.decode import open_store
from chronozarr.doctor import DEFAULT_ORIGIN, diagnose
from chronozarr.encode import EncodeReport, encode
from chronozarr.export import export_cog, select_times
from chronozarr.schema import SchemaError, validate
from chronozarr.stac import write_stac

_DATE_IN_NAME = re.compile(r"(?<!\d)(\d{4})-?(\d{2})(?:-?(\d{2}))?(?!\d)")
_GLOB_CHARS = "*?["


def _time_from_name(path: str) -> np.datetime64:
    match = _DATE_IN_NAME.search(Path(path).stem)
    if match is None:
        raise click.ClickException(
            f"cannot find a date (YYYY-MM, YYYY-MM-DD or YYYYMMDD) in file name '{path}'"
        )
    year, month, day = match.groups()
    try:
        return np.datetime64(f"{year}-{month}-{day or '01'}", "s")
    except ValueError as exc:
        raise click.ClickException(f"invalid date in file name '{path}': {exc}") from exc


def _read_geotiffs(pattern: str) -> xr.DataArray:
    """One GeoTIFF per timestep (date parsed from the file name), bands stacked."""
    try:
        import rasterio
    except ImportError as exc:
        raise click.ClickException(
            "GeoTIFF input needs rasterio: run `uv sync --extra ingest`"
        ) from exc
    paths = glob.glob(pattern)
    if not paths:
        raise click.ClickException(f"no files match '{pattern}'")
    entries = sorted((_time_from_name(p), p) for p in paths)

    frames = []
    reference: tuple | None = None
    band_names: list[str] = []
    for _, path in entries:
        with rasterio.open(path) as src:
            signature = (src.crs, src.transform, src.shape, src.count)
            if reference is None:
                reference = signature
                if src.crs is None:
                    raise click.ClickException(f"'{path}' has no CRS")
                band_names = [d or str(i + 1) for i, d in enumerate(src.descriptions)]
            elif signature != reference:
                raise click.ClickException(
                    f"'{path}' differs from '{entries[0][1]}' in CRS, transform, shape or bands"
                )
            if src.dtypes[0] != "uint16":
                raise click.ClickException(
                    f"'{path}' is {src.dtypes[0]}; only uint16 is supported"
                )
            frames.append(src.read())
    assert reference is not None
    crs, affine, _, _ = reference
    return xr.DataArray(
        np.stack(frames),
        dims=schema.DIMENSIONS,
        coords={"time": np.array([t for t, _ in entries]), "band": band_names},
        attrs={"crs": crs.to_string(), "transform": list(affine)[:6]},
    )


def _read_xarray(path: str, variable: str | None) -> xr.DataArray:
    source = Path(path)
    if not source.exists():
        raise click.ClickException(f"input '{path}' does not exist")
    dataset = (
        xr.open_dataset(source)
        if source.suffix == ".nc"
        else xr.open_zarr(source, chunks=None, consolidated=False)
    )
    if variable is None:
        names = list(dataset.data_vars)
        if len(names) != 1:
            raise click.ClickException(f"input has variables {names}; choose one with --variable")
        variable = str(names[0])
    if variable not in dataset.data_vars:
        raise click.ClickException(
            f"variable '{variable}' not in input: {list(dataset.data_vars)}"
        )
    da = dataset[variable]
    if set(da.dims) != set(schema.DIMENSIONS):
        raise click.ClickException(
            f"variable '{variable}' has dims {da.dims}; need {schema.DIMENSIONS}"
        )
    da = da.transpose(*schema.DIMENSIONS)
    for key in ("crs", "transform"):
        if key not in da.attrs and key in dataset.attrs:
            da.attrs[key] = dataset.attrs[key]
    return da


@contextmanager
def _command_errors() -> Iterator[None]:
    """Turn expected failures into one-line CLI errors, with an install hint for rasterio."""
    try:
        yield
    except ImportError as exc:
        if exc.name == "rasterio":
            raise click.ClickException(
                "this command needs rasterio: run `uv sync --extra geo` "
                "(or `pip install 'chronozarr[geo]'`)"
            ) from exc
        raise
    except (ValueError, OSError, SchemaError) as exc:
        notes = getattr(exc, "__notes__", [])
        raise click.ClickException("\n".join([str(exc), *notes])) from exc


def _encode_options(command: Any) -> Any:
    """Options shared by `encode` and `convert`; they map one-to-one onto `encode()` keywords."""
    options = [
        click.option(
            "--chunk-size",
            type=int,
            default=512,
            show_default=True,
            help="Spatial chunk edge in pixels (256 or 512 per the spec).",
        ),
        click.option(
            "--volatility", is_flag=True, help="Write the optional cell volatility metric."
        ),
        click.option(
            "--codec",
            type=click.Choice(["zstd", "blosc-zstd-shuffle"]),
            default="zstd",
            show_default=True,
            help="Chunk compression codec.",
        ),
        click.option(
            "--level",
            "compression_level",
            type=int,
            default=None,
            help="Compression level (default 5 for zstd, 1 for blosc).",
        ),
        click.option(
            "--shard/--no-shard",
            default=False,
            show_default=True,
            help="One shard object per (time shard, cell) instead of one chunk object per "
            "(timestep, cell). Fewer objects, but a CDN miss costs a whole shard and an append "
            "rewrites the trailing one.",
        ),
        click.option(
            "--shard-time",
            type=int,
            default=None,
            help="Timesteps per shard along time; needs --shard (default: all; may exceed the "
            "timesteps given).",
        ),
        click.option(
            "--lods", "n_lods", type=int, default=None, help="Pyramid levels including level 0."
        ),
        click.option(
            "--workers", type=int, default=None, help="Cells encoded concurrently (default 4)."
        ),
    ]
    for option in reversed(options):
        command = option(command)
    return command


def _encode_kwargs(options: dict[str, Any]) -> dict[str, Any]:
    """`encode()` keywords from the parsed `_encode_options` values."""
    if options["shard_time"] is not None and not options["shard"]:
        raise click.UsageError("--shard-time needs --shard")
    return {
        "chunk_size": options["chunk_size"],
        "volatility": options["volatility"],
        "codec": options["codec"],
        "level": options["compression_level"],
        "shard": options["shard"],
        "shard_time": options["shard_time"],
        "n_lods": options["n_lods"],
        "workers": options["workers"],
    }


def _encode_summary(out: Path, report: EncodeReport) -> str:
    return (
        f"wrote {out}: {len(report.levels)} levels, {report.n_files} files, "
        f"{report.total_bytes / 1e6:.1f} MB, "
        f"{report.codec} level {report.level}"
    )


@click.group()
@click.version_option(package_name="chronozarr")
def main() -> None:
    """Zarr v3 stores for raster time series with true stored values."""


@main.command("encode")
@click.argument("input", metavar="INPUT")
@click.argument("out", type=click.Path(path_type=Path))
@_encode_options
@click.option("--crs", default=None, help="CRS such as EPSG:32631 (default: from the input).")
@click.option("--variable", default=None, help="Variable to encode from a Zarr/NetCDF input.")
def encode_command(
    input: str,
    out: Path,
    crs: str | None,
    variable: str | None,
    **options: Any,
) -> None:
    """Encode INPUT into a chronozarr store at OUT.

    INPUT is a Zarr store or NetCDF file with dims (time, band, y, x), or a quoted glob of
    GeoTIFFs, one per timestep, with the date in the file name.
    """
    if any(ch in input for ch in _GLOB_CHARS):
        da = _read_geotiffs(input)
    else:
        da = _read_xarray(input, variable)
    with _command_errors():
        report = encode(da, out, crs=crs, **_encode_kwargs(options))
    click.echo(_encode_summary(out, report))


@main.command("append")
@click.argument("store", type=click.Path(path_type=Path))
@click.argument("input", metavar="INPUT")
@click.option("--crs", default=None, help="CRS of the input, checked against the store.")
@click.option("--variable", default=None, help="Variable to append from a Zarr/NetCDF input.")
@click.option("--workers", type=int, default=None, help="Cells written concurrently (default 4).")
def append_command(
    store: Path, input: str, crs: str | None, variable: str | None, workers: int | None
) -> None:
    """Append the timesteps of INPUT to the end of the chronozarr store STORE, in place.

    INPUT is a chronozarr store (for example one month written by `convert`), a Zarr store or
    NetCDF file with dims (time, band, y, x), or a quoted glob of GeoTIFFs, one per timestep with
    the date in the file name. Its grid, bands, dtype, CRS and nodata must match STORE, and its
    times must come after the store's last one.

    Only the shards (or chunks, for an unsharded store) that gain a timestep are written, plus
    the metadata; every other object keeps its bytes. An unsharded store (the encoder default)
    writes only new chunk objects; a sharded one rewrites the shard that grows. Appending is not
    atomic: run it on a working copy and publish after `chronozarr validate`.
    """
    with _command_errors():
        if is_store(input):
            if crs is not None or variable is not None:
                raise click.UsageError("--crs and --variable do not apply to a chronozarr store")
            report = append(store, Path(input), workers=workers)
        else:
            da = _read_geotiffs(input) if any(ch in input for ch in _GLOB_CHARS) else None
            if da is None:
                da = _read_xarray(input, variable)
            report = append(store, da, crs=crs, workers=workers)
    click.echo(
        f"appended {report.n_appended} timestep(s) to {store}: {report.n_time} in total, "
        f"wrote {report.objects_written} objects ({report.bytes_written / 1e6:.1f} MB) "
        f"in {report.seconds:.1f} s"
    )


@main.command("validate")
@click.argument("store")
def validate_command(store: str) -> None:
    """Check STORE against the chronozarr spec. Exit status 1 if it does not conform."""
    problems = validate(store)
    if problems:
        for problem in problems:
            click.echo(problem, err=True)
        click.echo(f"{store}: {len(problems)} problem(s)", err=True)
        sys.exit(1)
    click.echo(f"{store}: conforms to chronozarr {schema.SPEC_VERSION}")


@main.command("info")
@click.argument("store")
def info_command(store: str) -> None:
    """Summarise STORE: times, bands and pyramid levels."""
    with _command_errors():
        opened = open_store(store)
    attrs = opened.attrs
    click.echo(f"store:     {store}")
    click.echo(f"version:   chronozarr {attrs.spec_version}")
    click.echo(f"crs:       {attrs.crs}")
    click.echo(f"times:     {len(opened.times)} ({attrs.times[0]} .. {attrs.times[-1]})")
    click.echo(f"bands:     {', '.join(opened.bands)}")
    click.echo(f"nodata:    {attrs.nodata}")
    extras = [
        name
        for name, present in (
            ("mask", attrs.mask_variable),
            ("coverage", attrs.coverage_variable),
            ("provenance", attrs.provenance),
        )
        if present
    ]
    if extras:
        click.echo(f"extras:    {', '.join(extras)}")
    click.echo("levels:")
    for level in opened.levels:
        layout = f"shards {level.data.shards}" if level.data.shards else "unsharded"
        click.echo(
            f"  {level.index}: shape {level.shape}, {level.resolution:g} m/px, "
            f"grid {level.grid[0]}x{level.grid[1]}, chunks {level.data.chunks}, {layout}"
        )


_STATUS_LABEL = {"ok": "[ ok ]", "info": "[info]", "warn": "[warn]", "fail": "[FAIL]"}


@main.command("doctor")
@click.argument("target")
@click.option(
    "--origin",
    default=DEFAULT_ORIGIN,
    show_default=True,
    help="Origin header sent by the browser-style CORS checks (https URLs only).",
)
@click.option(
    "--full-read-limit-mb",
    type=float,
    default=16.0,
    show_default=True,
    help="Also compare a cell with a full-level read when one timestep is at most this big.",
)
def doctor_command(target: str, origin: str, full_read_limit_mb: float) -> None:
    """Diagnose TARGET, an https URL or a local store path.

    A URL is probed the way a browser would: root zarr.json, byte ranges, CORS, HEAD and caching
    headers. Both kinds then get the layout validated and one cell decoded per pyramid level,
    compared with a plain Zarr read and a full read. Exit status 1 if any check fails; warnings
    (advice) and info lines do not change the exit status.
    """
    checks = diagnose(target, origin=origin, full_read_limit_mb=full_read_limit_mb)
    width = max(len(c.name) for c in checks)
    click.echo(f"chronozarr doctor {target}")
    for check in checks:
        click.echo(f"{_STATUS_LABEL[check.status]} {check.name.ljust(width)}  {check.detail}")
        if check.hint and check.status in ("warn", "fail"):
            click.echo(f"       fix: {check.hint}")
    counts = {status: sum(c.status == status for c in checks) for status in _STATUS_LABEL}
    click.echo(
        f"{counts['ok']} ok, {counts['info']} info, {counts['warn']} warning(s), "
        f"{counts['fail']} failure(s)"
    )
    if counts["fail"]:
        sys.exit(1)


@main.command("export-cog")
@click.argument("store")
@click.argument("out_dir", type=click.Path(path_type=Path))
@click.option("--level", type=int, default=0, show_default=True, help="Pyramid level to export.")
@click.option(
    "--times",
    "times",
    multiple=True,
    help="Timesteps: all (default), indices 0,5,-1, slices 0:12:3, dates 2024-03 or 2024-03-15, "
    "ranges 2020-01..2022-06. Repeatable.",
)
@click.option(
    "--physical",
    is_flag=True,
    help="Write float32 physical values (stored * scale + offset, NaN where invalid) instead of "
    "the stored values.",
)
def export_cog_command(
    store: str, out_dir: Path, level: int, times: tuple[str, ...], physical: bool
) -> None:
    """Export timesteps of STORE as true-value Cloud Optimized GeoTIFFs in OUT_DIR.

    STORE is a local path or https URL. One file per timestep, all bands, named
    L<level>_<date>.tif, readable by GDAL and QGIS without chronozarr. One timestep of the level
    is held in memory at a time, so use --level for very large stores.

    \b
    Validity and scaling are written as GDAL metadata:
      mask store    an internal per-dataset mask; the store's nodata is also set, unless a valid
                    pixel of that timestep holds it
      nodata store  the same nodata, judged per band, and no mask
      neither       no nodata and no mask: every pixel is valid
      scale, offset, units and band names go to the band metadata (not with --physical)
    """
    with _command_errors():
        opened = open_store(store)
        chosen = select_times(times, opened.attrs.times)
        paths = export_cog(opened, out_dir, level=level, times=chosen, physical=physical)
    total = sum(p.stat().st_size for p in paths)
    click.echo(f"wrote {len(paths)} COG(s), {total / 1e6:.1f} MB, to {out_dir}")


@main.command("stac")
@click.argument("store")
@click.option(
    "--out",
    "out_dir",
    required=True,
    type=click.Path(path_type=Path),
    help="Directory for collection.json and <id>/<id>.json.",
)
@click.option("--href", default=None, help="Public location of the store (default: see below).")
@click.option("--id", "stac_id", default=None, help="STAC id (default: <parent>-<name> of STORE).")
@click.option("--title", default=None, help="Human-readable title.")
@click.option("--description", default=None, help="Collection description.")
@click.option(
    "--license",
    "license_id",
    default="proprietary",
    show_default=True,
    help="SPDX identifier, 'various' or 'proprietary'.",
)
def stac_command(
    store: str,
    out_dir: Path,
    href: str | None,
    stac_id: str | None,
    title: str | None,
    description: str | None,
    license_id: str,
) -> None:
    """Write a static STAC Collection and Item for STORE (local path or https URL).

    The Item has the Zarr asset, spatial and temporal extent, band metadata, the datacube
    extension and the provenance recorded in the store. The asset href defaults to the URL for
    a remote store, or the relative path from the Item file to a local store; pass --href to
    publish the catalog next to a store served elsewhere.
    """
    with _command_errors():
        collection_path, item_path = write_stac(
            store,
            out_dir,
            href=href,
            id=stac_id,
            title=title,
            description=description,
            license=license_id,
        )
    click.echo(f"wrote {collection_path}")
    click.echo(f"wrote {item_path}")


def _parse_numbers(text: str | None, count: int, flag: str, kind: type) -> tuple | None:
    if text is None:
        return None
    try:
        values = tuple(kind(part) for part in text.split(","))
    except ValueError as exc:
        raise click.BadParameter(f"{flag} needs {count} comma-separated numbers: {exc}") from exc
    if len(values) != count:
        raise click.BadParameter(
            f"{flag} needs {count} comma-separated numbers, got {len(values)}"
        )
    return values


def _parse_shape(text: str | None) -> tuple[int, int] | None:
    numbers = _parse_numbers(text, 2, "--shape", int)
    return None if numbers is None else (int(numbers[0]), int(numbers[1]))


def _parse_nodata(text: str | None) -> float | int | str | None:
    if text is None:
        return "auto"
    if text.lower() == "none":
        return None
    try:
        number = float(text)
    except ValueError as exc:
        raise click.BadParameter(
            f"--nodata must be a number, 'none' or 'nan', got {text!r}"
        ) from exc
    return int(number) if number.is_integer() else number


@main.command("convert")
@click.argument("source")
@click.argument("out", type=click.Path(path_type=Path))
@_encode_options
@click.option("--variable", default=None, help="Variable to convert from a Zarr or NetCDF source.")
@click.option(
    "--dims",
    default=None,
    help="Dimension names when they are not time/y/x/band or common aliases: "
    "time=NAME,y=NAME,x=NAME[,band=NAME].",
)
@click.option(
    "--crs",
    default=None,
    help="EPSG:xxxxx. Manifest: the target CRS (default: the first source's) and the CRS of "
    "sources that declare none (a PNG with a world file). Zarr/NetCDF: the CRS of the data "
    "when the file does not declare one.",
)
@click.option(
    "--transform",
    default=None,
    help="Manifest only: target grid transform a,b,c,d,e,f (north-up). Needs --crs and --shape.",
)
@click.option("--shape", default=None, help="Manifest only: target grid height,width in pixels.")
@click.option(
    "--bounds",
    default=None,
    help="Manifest only: west,south,east,north of every frame in the units of --crs, for PNG "
    "frames with no world file or .aux.xml. Needs --crs; all frames must have one size.",
)
@click.option(
    "--resampling",
    type=click.Choice(RESAMPLING_METHODS),
    default=None,
    help="Warp COGs that are not on the target grid with this method (required when any are not).",
)
@click.option(
    "--nodata",
    default=None,
    help="Nodata value, 'none', or 'nan' (float data). Default: what the sources declare; none "
    "declared means no nodata, not 0. An explicit value replaces the declared one.",
)
@click.option(
    "--mask-var",
    default=None,
    help="Zarr/NetCDF only: a boolean or integer (time, y, x) variable whose nonzero values are "
    "valid. The store gets a mask.",
)
@click.option(
    "--work-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Where timesteps are staged (default: OUT.convert-work beside OUT).",
)
@click.option("--resume", is_flag=True, help="Reuse timesteps staged by an interrupted run.")
@click.option(
    "--dry-run", is_flag=True, help="Check the source and print size and time estimates."
)
@click.option(
    "--read-ahead",
    type=int,
    default=2,
    show_default=True,
    help="Timesteps read concurrently while staging; memory is about this many timesteps.",
)
def convert_command(
    source: str,
    out: Path,
    variable: str | None,
    dims: str | None,
    crs: str | None,
    transform: str | None,
    shape: str | None,
    bounds: str | None,
    resampling: str | None,
    nodata: str | None,
    mask_var: str | None,
    work_dir: Path | None,
    resume: bool,
    dry_run: bool,
    read_ahead: int,
    **options: Any,
) -> None:
    """Convert SOURCE into a chronozarr store at OUT without loading the whole stack.

    SOURCE is a manifest (.csv with columns uri,datetime[,bands] or .json) of COG or PNG frame
    URIs, a Zarr store (path or URL) or a NetCDF file, the last two with --variable. Each
    timestep is read, resampled if needed, staged under the work directory and then encoded
    cell by cell. The size and time estimate is printed first; --dry-run stops there.
    """
    last_report = 0.0
    migration = False

    def show_plan(plan: Plan) -> None:
        nonlocal migration
        migration = plan.source.kind == "chronozarr v0.2"
        for line in plan.lines(read_ahead):
            click.echo(line)

    def show_progress(done: int, total: int) -> None:
        nonlocal last_report
        now = time.monotonic()
        if done == total or now - last_report >= 2.0:
            last_report = now
            label = "verified level/timestep pairs" if migration else "staged timesteps"
            click.echo(f"{label}: {done}/{total}", err=True)

    with _command_errors():
        report = convert(
            source,
            out,
            variable=variable,
            dims=dims,
            crs=crs,
            transform=_parse_numbers(transform, 6, "--transform", float),
            shape=_parse_shape(shape),
            bounds=_parse_numbers(bounds, 4, "--bounds", float),
            resampling=resampling,
            nodata=_parse_nodata(nodata),
            mask_var=mask_var,
            work_dir=work_dir,
            resume=resume,
            dry_run=dry_run,
            read_ahead=read_ahead,
            on_plan=show_plan,
            progress=show_progress,
            **_encode_kwargs(options),
        )
    if report.encode is None:
        click.echo("dry run: nothing was written")
        return
    click.echo(_encode_summary(out, report.encode))
    if migration:
        click.echo(
            f"verified every value in {len(report.encode.levels)} levels, "
            f"{report.plan.n_time} timesteps; total {report.total_s:.1f} s"
        )
        return
    click.echo(
        f"read {report.n_staged} timesteps ({report.n_reused} reused) in {report.read_s:.1f} s, "
        f"encoded in {report.encode_s:.1f} s, total {report.total_s:.1f} s"
    )


convert_command.help = f"{convert_command.help}\n\n{FIDELITY_HELP}"
