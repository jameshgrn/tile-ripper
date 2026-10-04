"""Already-open HTTP readers retain their axis after metadata-last publication."""

from __future__ import annotations

import os
import shutil

import numpy as np
import pytest
import xarray as xr

import chronozarr
from chronozarr.view import StoreServer
from tests.synthetic import make_da, make_truth

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("sharded", [False, True])
def test_http_append_snapshot_with_uncached_older_frames(tmp_path, sharded):
    truth = make_truth(12, 2, 35, 41)
    data = make_da(truth)
    published, staging = tmp_path / "published", tmp_path / "staging"
    chronozarr.encode(
        data.isel(time=slice(0, 11)),
        published,
        chunk_size=16,
        n_lods=1,
        shard=sharded,
        **({"shard_time": 4} if sharded else {}),
    )
    server = StoreServer(published, port=0)
    try:
        old = chronozarr.open_store(server.url)
        backend = xr.open_dataset(server.url, engine="chronozarr", physical=False)
        times = old.times.copy()
        # Do not materialize old frames before replacement: this checks uncached reads.
        shutil.copytree(published, staging)
        chronozarr.append(staging, data.isel(time=slice(11, 12)))
        files = sorted(staging.rglob("*"), key=lambda p: p == staging / "zarr.json")
        for source in files:
            if not source.is_file():
                continue
            target = published / source.relative_to(staging)
            target.parent.mkdir(parents=True, exist_ok=True)
            upload = target.with_name(target.name + ".upload")
            shutil.copyfile(source, upload)
            os.replace(upload, target)
        np.testing.assert_array_equal(old.times, times)
        assert backend.sizes["time"] == len(old.times) == 11
        with pytest.raises(IndexError):
            old.read(11)
        with pytest.raises(IndexError):
            backend.isel(time=11)
        variable = next(iter(backend.data_vars))
        for t in range(11):
            np.testing.assert_array_equal(old.read(t), truth[t])
            np.testing.assert_array_equal(backend[variable].isel(time=t).values, truth[t])
        reopened = chronozarr.open_store(server.url)
        assert len(reopened.times) == 12
        for t in range(12):
            np.testing.assert_array_equal(reopened.read(t), truth[t])
        backend.close()
        with xr.open_dataset(server.url, engine="chronozarr", physical=False) as fresh:
            assert fresh.sizes["time"] == 12
            np.testing.assert_array_equal(fresh[variable].values, truth)
    finally:
        server.close()
