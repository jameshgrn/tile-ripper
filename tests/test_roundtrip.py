"""Lossless roundtrip, pyramid values, volatility, encoder input checks."""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr

import chronozarr
from tests.synthetic import (
    BANDS,
    CRS,
    TRANSFORM,
    build_store,
    make_da,
    make_truth,
    reference_downsample,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("shard", [True, False], ids=["sharded", "unsharded"])
def test_lossless_roundtrip_every_timestep_and_level(tmp_path, shard):
    truth = make_truth(3, 2, 700, 600)
    report = build_store(tmp_path / "s", truth, shard=shard)
    store = chronozarr.open_store(tmp_path / "s")

    assert [lvl.shape for lvl in report.levels] == [(3, 2, 700, 600), (3, 2, 350, 300)]
    assert np.array_equal(store.to_xarray(lod=0).values, truth)
    for t in range(3):
        assert np.array_equal(store.read(t), truth[t])

    level = truth
    for lod in range(1, len(store.levels)):
        level = reference_downsample(level)
        assert np.array_equal(store.to_xarray(lod=lod).values, level), f"level {lod}"


@pytest.mark.parametrize("shard", [True, False], ids=["sharded", "unsharded"])
def test_multiple_timesteps_multi_cell_pyramid(tmp_path, shard):
    # 9 timesteps; 40x50 px with 16 px cells -> grids 3x4, 2x2, 1x1.
    truth = make_truth(9, 2, 40, 50)
    build_store(tmp_path / "s", truth, shard=shard, chunk_size=16)
    store = chronozarr.open_store(tmp_path / "s")

    assert [lvl.grid for lvl in store.levels] == [(3, 4), (2, 2), (1, 1)]
    level = truth
    for lod, lvl in enumerate(store.levels):
        if lod:
            level = reference_downsample(level)
        assert np.array_equal(store.to_xarray(lod=lod).values, level), f"level {lod}"
        assert lvl.shape[2:] == level.shape[2:]


def test_downsample_excludes_nodata_and_keeps_all_nodata_blocks():
    level = np.zeros((1, 1, 4, 4), dtype=np.uint16)
    level[0, 0, 0, :2] = [10, 0]  # block (0,0): one valid pixel -> 10
    level[0, 0, 1, :2] = [0, 0]
    level[0, 0, 0:2, 2:4] = [[5, 6], [7, 8]]  # block (0,1): mean 6 (26 // 4)
    from chronozarr.encode import downsample_2x

    out = downsample_2x(level[0])
    assert out.tolist() == [[[10, 6], [0, 0]]]
    assert np.array_equal(out[None], reference_downsample(level))


def test_encode_accepts_transform_from_coordinates(tmp_path):
    truth = make_truth(2, 1, 6, 8)
    da = make_da(truth)
    y = TRANSFORM[5] + (np.arange(6) + 0.5) * TRANSFORM[4]
    x = TRANSFORM[2] + (np.arange(8) + 0.5) * TRANSFORM[0]
    da = da.assign_coords(y=y, x=x)
    da.attrs = {"crs": CRS}
    chronozarr.encode(da, tmp_path / "s", chunk_size=4)
    assert chronozarr.open_store(tmp_path / "s").levels[0].transform == TRANSFORM


def test_encode_arguments_override_attrs(tmp_path):
    da = make_da(make_truth(2, 1, 6, 8))
    chronozarr.encode(
        da, tmp_path / "s", crs="EPSG:32632", transform=(20.0, 0, 1.0, 0, -20.0, 2.0), chunk_size=4
    )
    store = chronozarr.open_store(tmp_path / "s")
    assert store.attrs.crs == "EPSG:32632"
    assert store.levels[0].transform == (20.0, 0.0, 1.0, 0.0, -20.0, 2.0)


def _da(**overrides) -> xr.DataArray:
    return make_da(make_truth(2, len(BANDS), 8, 8)).assign_attrs(**overrides)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda da: da.transpose("band", "time", "y", "x"), "expected dims"),
        (lambda da: da.astype(np.float64), "unsupported dtype float64"),
        (lambda da: da.assign_coords(time=np.arange(2)), "must be datetime64"),
        (lambda da: da.assign_coords(time=da.time.values[::-1]), "strictly increasing"),
        (lambda da: da.assign_coords(band=["B04", "B04"]), "band names must be unique"),
        (lambda da: da.isel(time=slice(0, 0)), "empty input"),
        (lambda da: da.assign_attrs(crs=""), "no crs"),
        (lambda da: da.assign_attrs(transform=(10.0, 1.0, 0, 0, -10.0, 0)), "rotated"),
        (lambda da: da.assign_attrs(transform=(10.0, 0, 0, 0, 10.0, 0)), "north-up"),
        (lambda da: da.assign_attrs(transform=(10.0, 0, 0)), "6 coefficients"),
    ],
)
def test_encode_rejects_bad_input(tmp_path, mutate, message):
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(mutate(_da()), tmp_path / "s", chunk_size=4)
    assert not (tmp_path / "s").exists()


def test_encode_needs_transform_from_somewhere(tmp_path):
    da = _da()
    del da.attrs["transform"]
    with pytest.raises(ValueError, match="no transform"):
        chronozarr.encode(da, tmp_path / "s", chunk_size=4)


def test_encode_refuses_non_empty_output(tmp_path):
    (tmp_path / "s").mkdir()
    (tmp_path / "s" / "keep.txt").write_text("precious")
    with pytest.raises(FileExistsError, match="not empty"):
        chronozarr.encode(_da(), tmp_path / "s", chunk_size=4)
    assert (tmp_path / "s" / "keep.txt").read_text() == "precious"


def test_too_many_lods_fails(tmp_path):
    with pytest.raises(ValueError, match="n_lods=9 is too large"):
        chronozarr.encode(_da(), tmp_path / "s", chunk_size=4, n_lods=9)
