"""Convert eleven real dates, append the twelfth, and verify all values over HTTP."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import resource
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np
import rasterio

import chronozarr
from chronozarr.convert import convert
from chronozarr.view import StoreServer


def run(root: Path) -> None:
    source = root / "input"
    with (source / "observations.csv").open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 12 and len({r["datetime"] for r in rows}) == 12
    for name, subset in [("first-eleven.csv", rows[:11]), ("last-date.csv", rows[11:])]:
        with (source / name).open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["uri", "datetime"])
            writer.writeheader()
            writer.writerows(subset)
    target = root / "series"
    convert(source / "first-eleven.csv", target)
    convert(source / "last-date.csv", root / "last-date", encoding="none")
    old = chronozarr.open_store(target)
    old_times = old.times.copy()
    before = {
        str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in target.rglob("*")
        if p.is_file() and ("/data/c/" in str(p) or "/mask/c/" in str(p))
    }
    live_server = StoreServer(target, port=0)
    old_remote = chronozarr.open_store(live_server.url)
    report = chronozarr.append(target, root / "last-date")
    assert len(old_remote.times) == 11
    try:
        old_remote.read(11)
        raise AssertionError("Old HTTP handle accepted new date")
    except IndexError:
        pass
    assert len(old.times) == 11
    np.testing.assert_array_equal(old.times, old_times)
    try:
        old.read(11)
        raise AssertionError("Old handle unexpectedly accepted new date")
    except IndexError:
        pass
    new = chronozarr.open_store(target)
    assert len(new.times) == 12
    assert all(
        hashlib.sha256((target / key).read_bytes()).hexdigest() == value
        for key, value in before.items()
    ), "Existing chunks changed"
    hashes, mask_hashes, coverage = [], [], []
    server = StoreServer(target, port=0)
    try:
        remote = chronozarr.open_store(server.url)
        assert len(remote.times) == 12
        for t, row in enumerate(rows):
            with rasterio.open(source / row["uri"]) as cog:
                truth, valid = cog.read(), cog.dataset_mask() > 0
                np.testing.assert_array_equal(new.read(t), truth)
                np.testing.assert_array_equal(new.read_mask(t), valid)
                np.testing.assert_array_equal(remote.read(t), truth)
                np.testing.assert_array_equal(remote.read_mask(t), valid)
                if t < 11:
                    np.testing.assert_array_equal(old.read(t), truth)
                    np.testing.assert_array_equal(old_remote.read(t), truth)
                assert str(new.times[t].astype("datetime64[D]")) == row["datetime"]
                expected = truth.astype(np.float32) * np.float32(0.0001)
                expected[:, ~valid] = np.nan
                np.testing.assert_allclose(new.physical(t), expected)
                hashes.append(hashlib.sha256(truth.tobytes()).hexdigest())
                mask_hashes.append(hashlib.sha256(valid.astype(np.uint8).tobytes()).hexdigest())
                coverage.append(float(valid.mean()))
    finally:
        server.close()
        live_server.close()
    assert len(set(hashes)) == 12, "Duplicate frames detected"
    result = {
        "dates": [r["datetime"] for r in rows],
        "shape": list(new.levels[0].shape),
        "encoding": "v0.3 true values",
        "valid_fractions": coverage,
        "frame_sha256": hashes,
        "mask_sha256": mask_hashes,
        "append": asdict(report),
        "old_reader_times": len(old.times),
        "old_http_reader_times": len(old_remote.times),
        "reopened_reader_times": len(new.times),
        "existing_chunks_unchanged": len(before),
        "checks": {
            "all_level0_values_and_masks_local_http": "exact",
            "physical_scaling": "passed",
            "old_handle_new_date": "IndexError",
            "old_http_handle_new_date": "IndexError",
            "all_frames_distinct": True,
        },
        "process_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "limits": (
            "Same-host test; RSS includes conversion and GDAL. "
            "No CDN, outside-user or isolated browser peak-memory claim."
        ),
    }
    (root / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    run(parser.parse_args().root)
