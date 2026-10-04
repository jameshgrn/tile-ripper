"""A plain xarray/zarr reader sees a chronozarr store without knowing the convention."""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr

from chronozarr import schema
from tests.synthetic import build_store, make_truth

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module", params=[True, False], ids=["sharded", "unsharded"])
def store_and_truth(request, tmp_path_factory):
    truth = make_truth(3, 2, 700, 600)
    path = tmp_path_factory.mktemp("xr") / "store"
    build_store(path, truth, shard=request.param)
    return path, truth


def _open(path, level: str = "0", **kwargs) -> xr.Dataset:
    return xr.open_zarr(str(path), group=level, zarr_format=3, chunks=None, **kwargs)


def test_open_zarr_without_consolidated_metadata(store_and_truth):
    path, _ = store_and_truth
    ds = _open(path, consolidated=False)
    assert ds["data"].dims == ("time", "band", "y", "x")
    assert dict(ds.sizes) == {"time": 3, "band": 2, "y": 700, "x": 600}
    assert ds["data"].dtype == np.uint16


def test_open_zarr_with_consolidated_metadata(store_and_truth):
    path, _ = store_and_truth
    ds = _open(path)
    assert ds["data"].shape == (3, 2, 700, 600)


def test_time_decodes_to_datetime64(store_and_truth):
    path, _ = store_and_truth
    ds = _open(path, consolidated=False)
    assert np.issubdtype(ds["time"].dtype, np.datetime64)
    assert ds["time"].values.astype("datetime64[D]").tolist() == [
        np.datetime64("2024-01-01").item(),
        np.datetime64("2024-02-01").item(),
        np.datetime64("2024-03-01").item(),
    ]


def test_coordinates_and_pyramid_levels(store_and_truth):
    path, _ = store_and_truth
    for level, (height, width, pixel) in {"0": (700, 600, 10.0), "1": (350, 300, 20.0)}.items():
        ds = _open(path, level, consolidated=False)
        assert list(ds["band"].values) == ["B04", "B08"]
        assert ds["x"].size == width
        assert ds["y"].size == height
        assert float(ds["x"][1] - ds["x"][0]) == pixel
        assert float(ds["y"][1] - ds["y"][0]) == -pixel
        assert float(ds["x"][0]) == 746090.0 + pixel / 2
        assert float(ds["y"][0]) == 2540440.0 - pixel / 2


def test_all_timesteps_are_true_values(store_and_truth):
    path, truth = store_and_truth
    data = xr.open_zarr(path, group="0", chunks=None, mask_and_scale=False)["data"]
    assert np.array_equal(data.values, truth)


def test_level_attrs_visible_to_plain_readers(store_and_truth):
    path, _ = store_and_truth
    ds = _open(path, "1", consolidated=False)
    assert ds.attrs["crs"] == "EPSG:32631"
    assert ds.attrs["transform"] == list(
        schema.scale_transform((10.0, 0, 746090.0, 0, -10.0, 2540440.0), 1)
    )
