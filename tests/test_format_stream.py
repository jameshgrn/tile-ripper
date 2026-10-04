"""Streaming encode: iterable and dask input, bounded memory, temp file hygiene."""

from __future__ import annotations

import tracemalloc
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

import chronozarr
from tests.synthetic import CRS, TRANSFORM, make_da, make_times, make_truth

pytestmark = pytest.mark.unit

CS = 8


def _tree(path: Path) -> dict[str, bytes]:
    return {
        str(p.relative_to(path)): p.read_bytes() for p in sorted(path.rglob("*")) if p.is_file()
    }


def _stream_kwargs(truth: np.ndarray) -> dict:
    return {
        "times": make_times(truth.shape[0]),
        "bands": [f"b{i}" for i in range(truth.shape[1])],
        "crs": CRS,
        "transform": TRANSFORM,
    }


def _spill_dirs(parent: Path) -> list[Path]:
    return [p for p in parent.iterdir() if "spill" in p.name]


@pytest.mark.parametrize("shard", [True, False], ids=["sharded", "unsharded"])
def test_iterable_input_writes_the_same_store_as_a_dataarray(tmp_path, shard):
    truth = make_truth(5, 2, 29, 21)
    mask = (truth[:, 0] > 0).astype(np.uint8)
    coverage = (mask * 4).astype(np.uint8)
    kwargs = {
        "chunk_size": CS,
        "shard": shard,
        "shard_time": 2 if shard else None,
        "provenance": {"sources": ["x"], "composite": "median", "gap_fill": "none"},
    }
    da = make_da(truth, ["b0", "b1"])
    chronozarr.encode(da, tmp_path / "array", mask=mask, coverage=coverage, **kwargs)
    chronozarr.encode(
        iter(truth),
        tmp_path / "iter",
        mask=iter(mask),
        coverage=iter(coverage),
        **_stream_kwargs(truth),
        **kwargs,
    )
    assert _tree(tmp_path / "iter") == _tree(tmp_path / "array")
    assert chronozarr.validate(tmp_path / "iter") == []
    store = chronozarr.open_store(tmp_path / "iter")
    assert np.array_equal(store.to_xarray().values, truth)
    assert np.array_equal(store.read_mask(3), mask[3])


def test_generator_timesteps_are_consumed_once_in_order(tmp_path):
    truth = make_truth(4, 1, 20, 20)
    pulled: list[int] = []

    def steps():
        for t in range(4):
            pulled.append(t)
            yield truth[t].copy()

    chronozarr.encode(steps(), tmp_path / "s", chunk_size=CS, **_stream_kwargs(truth))
    assert pulled == [0, 1, 2, 3]
    assert np.array_equal(chronozarr.open_store(tmp_path / "s").to_xarray().values, truth)


def test_dask_backed_input_is_encoded_cell_by_cell(tmp_path):
    da_dask = pytest.importorskip("dask.array")
    truth = make_truth(4, 2, 29, 21)
    da = make_da(truth, ["b0", "b1"])
    lazy = da.copy(data=da_dask.from_array(truth, chunks=(1, 2, CS, CS)))
    chronozarr.encode(lazy, tmp_path / "lazy", chunk_size=CS)
    chronozarr.encode(da, tmp_path / "eager", chunk_size=CS)
    assert _tree(tmp_path / "lazy") == _tree(tmp_path / "eager")


def test_workers_does_not_change_the_output(tmp_path):
    truth = make_truth(4, 1, 29, 21)
    trees = []
    for workers in (1, 3):
        out = tmp_path / f"w{workers}"
        chronozarr.encode(make_da(truth), out, chunk_size=CS, workers=workers)
        trees.append(_tree(out))
    assert trees[0] == trees[1]


# --- temp files and failures ------------------------------------------------------------------


def test_spill_files_are_removed_after_success(tmp_path):
    truth = make_truth(3, 1, 20, 20)
    chronozarr.encode(iter(truth), tmp_path / "s", chunk_size=CS, **_stream_kwargs(truth))
    assert _spill_dirs(tmp_path) == []


def test_spill_dir_is_used_and_cleaned(tmp_path):
    truth = make_truth(3, 1, 20, 20)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    seen: list[int] = []

    def steps():
        for t in range(3):
            seen.append(len(list(scratch.iterdir())))
            yield truth[t]

    chronozarr.encode(
        steps(), tmp_path / "s", chunk_size=CS, spill_dir=scratch, **_stream_kwargs(truth)
    )
    assert seen[1:] == [1, 1]  # timestep 0 is peeked before the spill directory is made
    assert list(scratch.iterdir()) == []
    assert _spill_dirs(tmp_path) == []


def test_failing_iterator_leaves_no_store_and_no_spill_files(tmp_path):
    truth = make_truth(4, 1, 20, 20)

    def steps():
        yield truth[0]
        yield truth[1]
        raise RuntimeError("download failed at timestep 2")

    with pytest.raises(RuntimeError, match="download failed at timestep 2"):
        chronozarr.encode(steps(), tmp_path / "s", chunk_size=CS, **_stream_kwargs(truth))
    assert not (tmp_path / "s").exists()
    assert _spill_dirs(tmp_path) == []


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda steps: steps[:2], "the input has 2 timesteps but times has 4"),
        (lambda steps: [*steps, steps[0]], "more than the 4 timesteps"),
        (lambda steps: [steps[0], steps[1][:, :5], *steps[2:]], "timestep 1 is uint16"),
        (lambda steps: [steps[0], steps[1].astype(np.int16), *steps[2:]], "timestep 1 is int16"),
        (lambda steps: [], "empty input"),
    ],
)
def test_iterable_shape_dtype_and_count_are_checked(tmp_path, mutate, message):
    truth = make_truth(4, 1, 20, 20)
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(
            iter(mutate(list(truth))), tmp_path / "s", chunk_size=CS, **_stream_kwargs(truth)
        )
    assert not (tmp_path / "s").exists()
    assert _spill_dirs(tmp_path) == []


def test_iterable_input_needs_times_crs_and_transform(tmp_path):
    truth = make_truth(2, 1, 8, 8)
    kwargs = _stream_kwargs(truth)
    for missing, message in (
        ("times", "needs times="),
        ("crs", "no crs"),
        ("transform", "no transform"),
    ):
        args = {k: v for k, v in kwargs.items() if k != missing}
        with pytest.raises(ValueError, match=message):
            chronozarr.encode(iter(truth), tmp_path / "s", chunk_size=CS, **args)


def test_a_dataarray_rejects_times_keyword(tmp_path):
    with pytest.raises(ValueError, match="times= is only for iterable input"):
        chronozarr.encode(
            make_da(make_truth(2, 1, 8, 8)),
            tmp_path / "s",
            chunk_size=CS,
            times=make_times(2),
        )


def test_short_mask_iterator_is_reported(tmp_path):
    truth = make_truth(3, 1, 8, 8)
    mask = np.ones((2, 8, 8), dtype=np.uint8)
    with pytest.raises(ValueError, match="mask ended at timestep 2"):
        chronozarr.encode(
            iter(truth), tmp_path / "s", chunk_size=CS, mask=iter(mask), **_stream_kwargs(truth)
        )


# --- memory -----------------------------------------------------------------------------------


def test_peak_memory_is_a_fraction_of_the_raster(tmp_path):
    n_time, n_band, size, cs = 24, 2, 1024, 128
    full_bytes = n_time * n_band * size * size * 2
    rng = np.random.default_rng(1)

    def steps():
        base = rng.integers(100, 4000, (n_band, size, size)).astype(np.uint16)
        for t in range(n_time):
            yield (base + t * 7).astype(np.uint16)

    tracemalloc.start()
    try:
        chronozarr.encode(
            steps(),
            tmp_path / "s",
            chunk_size=cs,
            workers=2,
            **{**_stream_kwargs(np.empty((n_time, n_band))), "bands": ["a", "b"]},
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < full_bytes / 3, f"peak {peak / 1e6:.1f} MB vs raster {full_bytes / 1e6:.1f} MB"
    store = chronozarr.open_store(tmp_path / "s")
    assert store.levels[0].shape == (n_time, n_band, size, size)


def test_dataarray_encode_stays_bounded_beyond_its_input(tmp_path):
    n_time, n_band, size, cs = 24, 2, 1024, 128
    full_bytes = n_time * n_band * size * size * 2
    truth = (
        np.random.default_rng(2)
        .integers(100, 4000, (n_time, n_band, size, size))
        .astype(np.uint16)
    )
    da = xr.DataArray(
        truth,
        dims=("time", "band", "y", "x"),
        coords={"time": make_times(n_time), "band": ["a", "b"]},
        attrs={"crs": CRS, "transform": TRANSFORM},
    )
    tracemalloc.start()
    try:
        chronozarr.encode(da, tmp_path / "s", chunk_size=cs, workers=2)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < full_bytes / 3, f"peak {peak / 1e6:.1f} MB vs raster {full_bytes / 1e6:.1f} MB"
