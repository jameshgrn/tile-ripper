"""True values cover the entire dtype range without differencing or clipping."""

from __future__ import annotations

import numpy as np
import pytest
import zarr

import chronozarr
from tests.synthetic import make_da

pytestmark = pytest.mark.unit

# Two timesteps spanning large increases, decreases and int16 difference boundaries.
PREVIOUS = np.array([100, 50000, 100, 32868], dtype=np.uint16)
CURRENT = np.array([60000, 100, 32867, 100], dtype=np.uint16)


def _cube(previous: np.ndarray, current: np.ndarray) -> np.ndarray:
    return np.stack([previous, current])[:, None, None, :]  # (time, band, y, x)


def _encode(tmp_path, truth, **kwargs):
    kwargs.setdefault("chunk_size", 4)
    chronozarr.encode(make_da(truth), tmp_path / "s", **kwargs)
    return chronozarr.open_store(tmp_path / "s")


@pytest.mark.parametrize("shard", [True, False], ids=["sharded", "unsharded"])
def test_wraparound_differences_roundtrip_exactly(tmp_path, shard):
    truth = _cube(PREVIOUS, CURRENT)
    store = _encode(tmp_path, truth, shard=shard)
    assert store.read(1)[0, 0].tolist() == CURRENT.tolist()
    assert np.array_equal(store.to_xarray().values, truth)


def test_stored_values_are_the_measurements(tmp_path):
    _encode(tmp_path, _cube(PREVIOUS, CURRENT), shard=False)
    raw = zarr.open_array(str(tmp_path / "s" / "0" / "data"), mode="r")
    assert raw[0, 0, 0].tolist() == PREVIOUS.tolist()  # both timesteps store true values
    assert raw[1, 0, 0].tolist() == CURRENT.tolist()


def test_signed_boundary_values_remain_unsigned_measurements(tmp_path):
    truth = _cube(PREVIOUS[2:], CURRENT[2:])  # +32767 and -32768: the extremes of int16
    _encode(tmp_path, truth, shard=False)
    raw = zarr.open_array(str(tmp_path / "s" / "0" / "data"), mode="r")[1, 0, 0]
    assert raw.tolist() == CURRENT[2:].tolist()


def test_uint8_values_remain_unchanged(tmp_path):
    previous = np.array([5, 250, 0, 255], dtype=np.uint8)
    current = np.array([250, 5, 255, 0], dtype=np.uint8)
    truth = np.stack([previous, current])[:, None, None, :]
    store = _encode(tmp_path, truth, shard=False)
    raw = zarr.open_array(str(tmp_path / "s" / "0" / "data"), mode="r")
    assert raw.dtype == np.uint8
    assert raw[1, 0, 0].tolist() == current.tolist()
    assert np.array_equal(store.to_xarray().values, truth)


def test_full_range_uint16_roundtrips(tmp_path):
    truth = _cube(np.array([0, 65535, 1, 65534], dtype=np.uint16), CURRENT)
    store = _encode(tmp_path, truth)
    assert np.array_equal(store.to_xarray().values, truth)


@pytest.mark.parametrize("workers", [1, 4])
def test_extreme_values_in_one_of_many_cells_still_roundtrip(tmp_path, workers):
    truth = np.full((2, 1, 8, 8), 1000, dtype=np.uint16)
    truth[1, 0, 5, 6] = 50000  # cell (1, 1) of a 2 x 2 grid of 4 px cells
    truth[1, 0, 0, 0] = 0
    store = _encode(tmp_path, truth, workers=workers)
    assert np.array_equal(store.to_xarray().values, truth)
