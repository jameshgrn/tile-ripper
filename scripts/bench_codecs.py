"""Compare chronozarr codecs on an AOI's monthly mosaics: bytes and encode time per setting.

Each setting encodes the same months into a temporary store (deleted afterwards) with
`chronozarr.encode`, streaming the mosaics with the loader from scripts/reencode_aoi.py.

Usage:
    uv run python scripts/bench_codecs.py                       # Ucayali, all months, 4 settings
    uv run python scripts/bench_codecs.py --months 24
    uv run python scripts/bench_codecs.py --codecs zstd:1,zstd:5,blosc-zstd-shuffle:1
"""

from __future__ import annotations

import argparse
import shutil
import tempfile
import time
from pathlib import Path

import numpy as np
from reencode_aoi import DATA, iter_mosaics, mosaic_paths, mosaic_times, read_grid, s2_bands

import chronozarr


def parse_codecs(text: str) -> list[tuple[str, int]]:
    """'zstd:5,blosc-zstd-shuffle:1' -> [('zstd', 5), ('blosc-zstd-shuffle', 1)]."""
    settings = []
    for item in text.split(","):
        name, _, level = item.partition(":")
        if name not in ("zstd", "blosc-zstd-shuffle") or not level.isdigit():
            raise SystemExit(
                f"bad codec setting {item!r}; expected zstd:5 or blosc-zstd-shuffle:1"
            )
        settings.append((name, int(level)))
    return settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--aoi", default="ucayali_santa_maria")
    parser.add_argument("--months", type=int, default=None, help="use only the first N months")
    parser.add_argument("--encodings", default="none", help="comma separated")
    parser.add_argument("--codecs", default="zstd:5,blosc-zstd-shuffle:1")
    parser.add_argument("--workers", type=int, default=None, help="cells encoded concurrently")
    parser.add_argument("--tmp-dir", type=Path, default=None, help="where the temp stores go")
    args = parser.parse_args()

    encodings = args.encodings.split(",")
    if encodings != ["none"]:
        parser.error("v0.3 supports only true values (--encodings none)")
    settings = parse_codecs(args.codecs)
    paths = mosaic_paths(DATA / "mosaics" / args.aoi, args.months)
    grid = read_grid(paths[0])
    raw_bytes = len(paths) * int(np.prod(grid.shape)) * 2
    print(f"{args.aoi}: {len(paths)} months {grid.shape} uint16, {raw_bytes / 1e9:.2f} GB raw")
    print(f"{'encoding':<11} {'codec':<20} {'level':>5} {'MB':>9} {'vs raw':>7} {'encode s':>9}")

    results: list[tuple[str, str, int, int, float]] = []
    for encoding in encodings:
        for codec, level in settings:
            scratch = Path(tempfile.mkdtemp(prefix="bench-codecs-", dir=args.tmp_dir))
            try:
                started = time.perf_counter()
                report = chronozarr.encode(
                    iter_mosaics(paths, grid),
                    scratch / "store",
                    times=mosaic_times(paths),
                    bands=s2_bands(grid.band_names),
                    crs=f"EPSG:{grid.epsg}",
                    transform=grid.transform,
                    codec=codec,
                    level=level,
                    workers=args.workers,
                )
                seconds = time.perf_counter() - started
            finally:
                shutil.rmtree(scratch, ignore_errors=True)
            results.append((encoding, codec, level, report.total_bytes, seconds))
            print(
                f"{encoding:<11} {codec:<20} {level:>5} {report.total_bytes / 1e6:>9.1f} "
                f"{raw_bytes / report.total_bytes:>6.2f}x {seconds:>9.1f}",
                flush=True,
            )

    baselines: dict[str, int] = {}
    for encoding, codec, _, size, _ in results:
        if codec == "zstd":
            baselines.setdefault(encoding, size)
    print("\nrelative to the first zstd setting of the same encoding:")
    for encoding, codec, level, size, seconds in results:
        base = baselines.get(encoding)
        if base:
            print(
                f"  {encoding:<11} {codec}:{level:<3} bytes {size / base:>6.3f}x  ({seconds:.1f}s)"
            )


if __name__ == "__main__":
    main()
