"""Re-encode one AOI's monthly mosaics as a chronozarr store, streaming one month at a time.

Reads data/mosaics/<aoi>/YYYY-MM.npz (bands, transform, epsg, band_names) and writes
data/stores/<aoi>/<store-name>/. Months are read lazily and handed to `chronozarr.encode` as an
iterable, so peak memory does not grow with the number of months. Prints wall time per phase.

Usage:
    uv run python scripts/reencode_aoi.py --aoi ucayali_santa_maria --store-name chronozarr-4
    uv run python scripts/reencode_aoi.py --aoi sahara_tamanrasset \
        --codec blosc-zstd-shuffle
"""

from __future__ import annotations

import argparse
import shutil
import time
from collections import deque
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import chronozarr
from chronozarr.schema import Band

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Sentinel-2 L2A band names (STAC eo:common_name). Stored values are digital numbers with the
# processing-baseline offset already removed by the ingest, so reflectance = DN * 1e-4.
S2_COMMON_NAMES = {
    "B01": "coastal",
    "B02": "blue",
    "B03": "green",
    "B04": "red",
    "B05": "rededge",
    "B06": "rededge",
    "B07": "rededge",
    "B08": "nir",
    "B8A": "nir08",
    "B09": "nir09",
    "B11": "swir16",
    "B12": "swir22",
}
S2_SCALE = 1e-4
PROVENANCE = {
    "sources": ["sentinel-2-l2a"],
    "composite": "monthly median",
    "gap_fill": "carry-forward",
    "notes": "Planetary Computer STAC; SCL cloud mask; gaps filled from the previous month",
}


@dataclass(frozen=True)
class Grid:
    """What every monthly mosaic of an AOI must share."""

    shape: tuple[int, int, int]  # (band, y, x)
    transform: tuple[float, ...]
    epsg: int
    band_names: tuple[str, ...]


def mosaic_paths(mosaic_dir: Path, months: int | None = None) -> list[Path]:
    """Sorted YYYY-MM.npz files of an AOI, optionally only the first `months`."""
    paths = sorted(mosaic_dir.glob("*.npz"))
    if not paths:
        raise SystemExit(f"no .npz mosaics in {mosaic_dir}; run the ingest first")
    return paths[:months] if months else paths


def read_grid(path: Path) -> Grid:
    with np.load(path, allow_pickle=False) as npz:
        return Grid(
            shape=tuple(int(n) for n in npz["bands"].shape),
            transform=tuple(float(v) for v in npz["transform"]),
            epsg=int(npz["epsg"]),
            band_names=tuple(str(b) for b in npz["band_names"]),
        )


def mosaic_times(paths: list[Path]) -> np.ndarray:
    return np.array([np.datetime64(f"{p.stem}-01", "s") for p in paths])


def s2_bands(names: tuple[str, ...]) -> list[Band]:
    return [
        Band(
            name,
            common_name=S2_COMMON_NAMES.get(name),
            scale=S2_SCALE,
            offset=0.0,
            units="reflectance",
        )
        for name in names
    ]


def iter_mosaics(paths: list[Path], grid: Grid, lookahead: int = 4) -> Iterator[np.ndarray]:
    """Yield each month's (band, y, x) uint16 array in order, decompressing a few months ahead."""

    def load(path: Path) -> np.ndarray:
        with np.load(path, allow_pickle=False) as npz:
            here = Grid(
                shape=tuple(int(n) for n in npz["bands"].shape),
                transform=tuple(float(v) for v in npz["transform"]),
                epsg=int(npz["epsg"]),
                band_names=tuple(str(b) for b in npz["band_names"]),
            )
            if here != grid:
                raise SystemExit(f"{path} has a different grid, CRS or bands than {paths[0]}")
            return npz["bands"]

    with ThreadPoolExecutor(max_workers=lookahead) as pool:
        pending: deque[Future[np.ndarray]] = deque()
        upcoming = iter(paths)
        for path in upcoming:
            pending.append(pool.submit(load, path))
            if len(pending) >= lookahead:
                break
        while pending:
            month = pending.popleft().result()
            nxt = next(upcoming, None)
            if nxt is not None:
                pending.append(pool.submit(load, nxt))
            yield month


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--aoi", required=True)
    parser.add_argument(
        "--store-name", default="chronozarr", help="directory under data/stores/<aoi>/"
    )
    parser.add_argument("--out-root", type=Path, default=DATA / "stores", help="stores directory")
    parser.add_argument("--months", type=int, default=None, help="encode only the first N months")
    parser.add_argument("--codec", choices=["zstd", "blosc-zstd-shuffle"], default="zstd")
    parser.add_argument("--level", type=int, default=None, help="default: 5 zstd, 1 blosc")
    parser.add_argument("--chunk-size", type=int, choices=[256, 512], default=512)
    parser.add_argument(
        "--shard",
        action="store_true",
        help="one shard object per (time shard, cell) instead of one chunk object per (timestep, "
        "cell); default off",
    )
    parser.add_argument(
        "--shard-time", type=int, default=None, help="with --shard; default: all timesteps"
    )
    parser.add_argument("--n-lods", type=int, default=None, help="default: until a 1x1 cell grid")
    parser.add_argument("--workers", type=int, default=None, help="cells encoded concurrently")
    parser.add_argument("--overwrite", action="store_true", help="replace an existing store")
    args = parser.parse_args()
    if args.shard_time is not None and not args.shard:
        parser.error("--shard-time needs --shard")

    paths = mosaic_paths(DATA / "mosaics" / args.aoi, args.months)
    out = args.out_root / args.aoi / args.store_name
    if out.exists():
        if not args.overwrite:
            raise SystemExit(f"{out} exists; pass --overwrite to replace it")
        shutil.rmtree(out)
    grid = read_grid(paths[0])
    raw_bytes = len(paths) * int(np.prod(grid.shape)) * 2
    print(
        f"{len(paths)} months {grid.shape} uint16, {raw_bytes / 1e9:.2f} GB raw, EPSG:{grid.epsg}"
    )

    started = time.perf_counter()
    report = chronozarr.encode(
        iter_mosaics(paths, grid),
        out,
        times=mosaic_times(paths),
        bands=s2_bands(grid.band_names),
        crs=f"EPSG:{grid.epsg}",
        transform=grid.transform,
        codec=args.codec,
        level=args.level,
        provenance=PROVENANCE,
        chunk_size=args.chunk_size,
        shard=args.shard,
        shard_time=args.shard_time,
        n_lods=args.n_lods,
        workers=args.workers,
    )
    encode_s = time.perf_counter() - started

    print("\nper-level times are thread-seconds summed over workers, not wall time")
    print(
        f"{'lod':>3} {'shape':>18} {'cells':>5} {'downsample':>10} {'encode':>8} "
        f"{'write':>8} {'MB':>8}"
    )
    for lvl in report.levels:
        shape = "x".join(str(n) for n in lvl.shape[2:])
        print(
            f"{lvl.level:>3} {shape:>18} {lvl.n_cells:>5} {lvl.downsample_s:>10.2f} "
            f"{lvl.encode_s:>8.2f} {lvl.write_s:>8.2f} {lvl.bytes / 1e6:>8.1f}"
        )
    print(f"\nencode total: {encode_s:.1f}s wall (spill + cells + metadata + consolidation)")
    print(f"true values; codec {report.codec} level {report.level}")
    print(
        f"store: {report.total_bytes / 1e6:.1f} MB in {report.n_files} files "
        f"({raw_bytes / report.total_bytes:.2f}x vs raw)"
    )
    problems = chronozarr.validate(out)
    print("validate: " + ("conforms" if not problems else f"{len(problems)} problem(s)"))
    for problem in problems:
        print(f"  {problem}")
    print(f"wrote {out}")
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
