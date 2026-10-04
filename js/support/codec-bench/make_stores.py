"""Write real Ucayali chunks with three codec chains for the browser decode benchmark.

Arrays (each shape (4, 4, 512, 512) uint16, chunks (1, 4, 512, 512), i.e. four 2 MB chunks):
  plain   bytes only (reference for bit-exactness)
  zstd5   bytes + zstd level 5 (chronozarr v0.1 default)
  blosc   bytes + blosc(cname=zstd, clevel=1, shuffle=byte shuffle, typesize 2)

All four chunks contain true stored values from a v0.3 store.

Run: uv run python js/support/codec-bench/make_stores.py [--source STORE] [--out DIR]
"""

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import zarr
from zarr.codecs import BloscCodec, BloscShuffle, ZstdCodec

CS = 512
SAMPLE_T = 60
CELLS = [(2, 2), (1, 3), (3, 1)]
NEXT_SAMPLE = (SAMPLE_T + 1, (2, 2))


def read_chunks(source: Path) -> np.ndarray:
    data = zarr.open_array(source / "0" / "data", mode="r")
    chunks = []
    for row, col in CELLS:
        chunks.append(data[SAMPLE_T, :, row * CS : (row + 1) * CS, col * CS : (col + 1) * CS])
    t, (row, col) = NEXT_SAMPLE
    chunks.append(data[t, :, row * CS : (row + 1) * CS, col * CS : (col + 1) * CS])
    return np.stack(chunks).astype("<u2")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("data/stores/ucayali_santa_maria_v03"))
    parser.add_argument("--out", type=Path, default=Path("data/spike/codec_bench"))
    args = parser.parse_args()

    chunks = read_chunks(args.source)
    assert chunks.shape == (4, 4, CS, CS), chunks.shape
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)

    variants = {
        "plain": None,
        "zstd5": ZstdCodec(level=5),
        "blosc": BloscCodec(cname="zstd", clevel=1, shuffle=BloscShuffle.shuffle),
    }
    sizes: dict[str, list[int]] = {}
    for name, codec in variants.items():
        arr = zarr.create_array(
            store=args.out / name,
            shape=chunks.shape,
            chunks=(1, 4, CS, CS),
            dtype="uint16",
            compressors=codec,
            zarr_format=3,
            overwrite=True,
        )
        arr[:] = chunks
        sizes[name] = [
            (args.out / name / "c" / str(i) / "0" / "0" / "0").stat().st_size for i in range(4)
        ]
    (args.out / "sizes.json").write_text(json.dumps(sizes, indent=1))
    print(json.dumps(sizes))
    print(
        "blosc zarr.json codecs:",
        json.dumps(json.loads((args.out / "blosc" / "zarr.json").read_text())["codecs"]),
    )


if __name__ == "__main__":
    main()
