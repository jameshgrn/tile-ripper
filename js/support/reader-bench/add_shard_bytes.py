"""Make a copy of a chronozarr store whose root zarr.json also lists `chronozarr.shard_bytes`.

The copy links the source objects and has its own root zarr.json, so a reader can be
measured with and without the length hint on identical data.

Run: uv run python js/support/reader-bench/add_shard_bytes.py SOURCE TARGET
"""

import json
import os
import sys
from pathlib import Path


def main(source: Path, dest: Path) -> None:
    source = source.resolve()
    root = json.loads((source / "zarr.json").read_text())
    cz = root["attributes"]["chronozarr"]
    variable = cz.get("variable", "data")
    shard_bytes: dict[str, dict[str, int]] = {}
    for dataset in root["attributes"]["multiscales"]["layout"]:
        level = dataset["asset"]
        shard_dir = source / level / variable / "c"
        sizes: dict[str, int] = {}
        for shard in sorted(shard_dir.rglob("*")):
            if not shard.is_file():
                continue
            t_shard, _band, row, col = shard.relative_to(shard_dir).parts
            sizes[f"{t_shard}/{row}/{col}"] = shard.stat().st_size
        shard_bytes[level] = sizes
    cz["shard_bytes"] = shard_bytes
    dest.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        if child.name == "zarr.json":
            continue
        link = dest / child.name
        if not link.exists():
            os.symlink(child, link)
    (dest / "zarr.json").write_text(json.dumps(root))
    print(f"{dest}: shard_bytes for {sum(len(v) for v in shard_bytes.values())} shards")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
