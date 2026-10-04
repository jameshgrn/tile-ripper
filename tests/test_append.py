"""`chronozarr append`: what an append writes, what it leaves alone, and what it refuses."""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest
import xarray as xr
from click.testing import CliRunner

import chronozarr
from chronozarr import schema
from chronozarr.append import AppendReport, append, is_store
from chronozarr.cli import main
from chronozarr.convert import convert
from chronozarr.doctor import diagnose
from chronozarr.encode import VOLATILITY_SCALE
from tests.synthetic import (
    BANDS,
    CRS,
    TRANSFORM,
    make_da,
    make_times,
    make_truth,
    reference_anchor_schedule,
)

pytestmark = pytest.mark.unit

CHUNK = 16
HEIGHT, WIDTH = 50, 70  # a 4 x 5 cell grid at chunk 16, four levels
N_TIME = 16


@pytest.fixture(scope="module")
def truth() -> np.ndarray:
    return make_truth(N_TIME, 2, HEIGHT, WIDTH)


def window(truth: np.ndarray, lo: int, hi: int) -> xr.DataArray:
    """Timesteps lo..hi of `truth` with the times they have in the full series."""
    return make_da(truth, BANDS).isel(time=slice(lo, hi))


def encode_head(truth: np.ndarray, out: Path, n: int, **options) -> None:
    options.setdefault("volatility", True)
    chronozarr.encode(make_da(truth[:n], BANDS), out, chunk_size=CHUNK, **options)


def digests(path: Path) -> dict[str, str]:
    return {
        str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(path.rglob("*"))
        if p.is_file()
    }


def mtimes(path: Path) -> dict[str, int]:
    return {str(p.relative_to(path)): p.stat().st_mtime_ns for p in path.rglob("*") if p.is_file()}


def changed(before: dict[str, str], after: dict[str, str]) -> set[str]:
    """Keys that are new or have different bytes."""
    return {key for key, digest in after.items() if before.get(key) != digest}


def decoded(path: Path, lod: int = 0) -> np.ndarray:
    return chronozarr.open_store(path).to_xarray(lod=lod).values


LAYOUTS = {
    "shard-time-4": {"shard": True, "shard_time": 4},
    "whole-axis": {"shard": True},
    "unsharded": {},  # the encoder default
}


# --- Exactness ----------------------------------------------------------------------------------


@pytest.mark.parametrize("layout", LAYOUTS)
def test_appended_store_validates_and_decodes_every_timestep_and_level(tmp_path, truth, layout):
    store, fresh = tmp_path / "store", tmp_path / "fresh"
    encode_head(truth, store, 8, **LAYOUTS[layout])
    first = append(store, window(truth, 8, 9))
    second = append(store, window(truth, 9, 13))  # crosses a shard boundary
    assert (first.n_appended, first.n_time, second.n_appended, second.n_time) == (1, 9, 4, 13)

    assert chronozarr.validate(store) == []
    assert np.array_equal(decoded(store), truth[:13])

    encode_head(truth, fresh, 13, **LAYOUTS[layout])
    for lod in range(1, len(chronozarr.open_store(store).levels)):
        assert np.array_equal(decoded(store, lod), decoded(fresh, lod)), f"level {lod}"
    appended = chronozarr.open_store(store)
    assert appended.attrs.times == chronozarr.open_store(fresh).attrs.times
    assert appended.levels[0].data.shape[0] == 13
    for level in appended.levels:
        assert level.data.shape[0] == len(appended.times)


def test_iterable_input_is_appended_like_a_dataarray(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    steps = (truth[t] for t in range(8, 11))
    append(store, steps, times=make_times(N_TIME)[8:11])
    assert chronozarr.validate(store) == []
    assert np.array_equal(decoded(store), truth[:11])
    assert not list(tmp_path.glob(".store-spill-*"))


def test_one_timestep_store_with_a_long_shard_takes_appends_in_the_same_shard(tmp_path, truth):
    store, fresh = tmp_path / "store", tmp_path / "fresh"
    encode_head(truth, store, 1, shard=True, shard_time=12)  # shard_time > n_time
    assert chronozarr.validate(store) == []
    assert chronozarr.open_store(store).levels[0].shard_time == 12
    before = digests(store)
    shards = {k for k in before if "/data/c/" in k}
    assert shards and all("/data/c/0/0/" in k for k in shards)

    report = append(store, window(truth, 1, 3))  # timesteps 1 and 2 stay in time shard 0
    assert (report.n_appended, report.n_time) == (2, 3)
    after = digests(store)
    assert {k for k in after if "/data/c/" in k} == shards  # no new shard objects
    assert chronozarr.validate(store) == []
    assert np.array_equal(decoded(store), truth[:3])

    encode_head(truth, fresh, 3, shard=True, shard_time=12)
    for lod in range(1, len(chronozarr.open_store(store).levels)):
        assert np.array_equal(decoded(store, lod), decoded(fresh, lod))
    append(store, window(truth, 3, 12))  # fills the shard; the next append opens shard 1
    assert np.array_equal(decoded(store), truth[:12])
    assert not any("/data/c/1/" in k for k in digests(store))
    append(store, window(truth, 12, 13))
    assert any("/data/c/1/" in k for k in digests(store))
    assert np.array_equal(decoded(store), truth[:13])
    assert chronozarr.validate(store) == []


def test_edge_cells_and_odd_levels_match_a_fresh_encode(tmp_path):
    odd = make_truth(10, 2, 37, 53, seed=3)
    store, fresh = tmp_path / "store", tmp_path / "fresh"
    encode_head(odd, store, 6, shard=True, shard_time=3)
    append(store, window(odd, 6, 10))
    encode_head(odd, fresh, 10, shard=True, shard_time=3)
    assert chronozarr.validate(store) == []
    for lod in range(len(chronozarr.open_store(fresh).levels)):
        assert np.array_equal(decoded(store, lod), decoded(fresh, lod))


# --- What changes and what does not -------------------------------------------------------------


def is_metadata(key: str) -> bool:
    return (
        key.endswith("zarr.json")
        or "/time/" in key
        or key.startswith("volatility/")
        or key.endswith("/band/c/0")
    )


def test_sharded_append_writes_the_trailing_shard_and_metadata_only(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    before, stamps = digests(store), mtimes(store)
    append(store, window(truth, 8, 9))
    after = digests(store)
    touched = changed(before, after)
    old_shards = [k for k in before if "/data/c/0/" in k or "/data/c/1/" in k]
    assert old_shards and all(mtimes(store)[k] == stamps[k] for k in old_shards)  # never opened
    data_objects = {k for k in touched if not is_metadata(k)}
    assert data_objects, "the new timestep writes new shards"
    assert all("/data/c/2/0/" in key for key in data_objects), sorted(data_objects)[:5]
    fresh = tmp_path / "fresh"
    encode_head(truth, fresh, 9, shard=True, shard_time=4)
    expected = {k for k in digests(fresh) if "/data/c/2/0/" in k}  # all-fill cells have no shard
    assert data_objects == expected
    assert all(after[k] == before[k] for k in before if "/data/c/0/" in k or "/data/c/1/" in k)
    # nothing else is touched except the metadata that describes the longer axis
    assert {k for k in touched if is_metadata(k)} <= {
        k for k in after if is_metadata(k) and ("zarr.json" in k or "/time/" in k)
    } | {"volatility/c/0/0"}


def test_partial_shard_keeps_its_old_chunks_at_the_same_offsets(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 9, shard=True, shard_time=4)  # time shard 2 holds one chunk
    key = "0/data/c/2/0/1/1"
    old = (store / key).read_bytes()
    index_len = 16 * 4 + 4
    before = digests(store)
    append(store, window(truth, 9, 11))
    new = (store / key).read_bytes()
    assert new.startswith(old[:-index_len])
    assert new != old
    after = digests(store)
    assert all(after[k] == before[k] for k in before if "/data/c/0/" in k or "/data/c/1/" in k)


def test_unsharded_append_writes_only_the_new_chunks(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 8, shard=False)
    before, stamps = digests(store), mtimes(store)
    append(store, window(truth, 8, 10))
    after = digests(store)
    data_objects = {k for k in changed(before, after) if not is_metadata(k)}
    assert {k.split("/")[3] for k in data_objects} == {"8", "9"}
    old_chunks = [k for k in before if not is_metadata(k)]
    assert all(mtimes(store)[k] == stamps[k] for k in old_chunks)
    assert all(key in after for key in before)
    assert all(after[k] == before[k] for k in before if not is_metadata(k))


def test_shard_bytes_describe_the_shards_after_an_append(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 9, shard=True, shard_time=4)
    append(store, window(truth, 9, 12))
    listed = chronozarr.open_store(store).attrs.shard_bytes
    assert listed is not None
    assert {key.split("/")[0] for key in listed["0"]} == {"0", "1", "2"}
    assert chronozarr.validate(store) == []  # validate compares every listed length with disk


def test_report_counts_objects_and_bytes(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    before = digests(store)
    report = append(store, window(truth, 8, 9))
    assert isinstance(report, AppendReport)
    after = digests(store)
    assert report.objects_written >= len(changed(before, after))
    sizes = sum((store / key).stat().st_size for key in changed(before, after))
    assert report.bytes_written >= sizes
    assert report.seconds > 0


# --- Volatility ----------------------------------------------------------------------------------


def expected_volatility(truth: np.ndarray, refs: dict[int, int]) -> np.ndarray:
    rows, cols = schema.grid_shape(HEIGHT, WIDTH, CHUNK)
    out = np.zeros((rows, cols), dtype=np.float64)
    for row in range(rows):
        for col in range(cols):
            cell = truth[:, :, row * CHUNK : (row + 1) * CHUNK, col * CHUNK : (col + 1) * CHUNK]
            diffs = [
                np.abs(cell[t].astype(np.int64) - cell[a].astype(np.int64)).mean()
                for t, a in refs.items()
            ]
            out[row, col] = np.clip(np.mean(diffs) / VOLATILITY_SCALE, 0, 1) if diffs else 0.0
    return out


def read_volatility(path: Path) -> np.ndarray:
    import zarr

    root = zarr.open_group(str(path), mode="r", zarr_format=3, use_consolidated=False)
    return np.asarray(root["volatility"][:])


def test_plain_store_volatility_uses_the_nominal_schedule_for_new_steps(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    append(store, window(truth, 8, 13))
    refs = reference_anchor_schedule(13, 6)
    assert np.allclose(
        read_volatility(store), expected_volatility(truth[:13], refs), rtol=1e-4, atol=1e-7
    )


def test_single_timestep_store_gains_its_first_deltas(tmp_path, truth):
    store = tmp_path / "store"
    encode_head(truth, store, 1, shard=True, shard_time=1)
    assert not read_volatility(store).any()
    append(store, window(truth, 1, 4))
    assert read_volatility(store).max() > 0
    assert np.array_equal(decoded(store), truth[:4])


# --- Mask and coverage --------------------------------------------------------------------------


def planes(n_time: int, seed: int = 21) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    mask = (rng.random((n_time, HEIGHT, WIDTH)) > 0.2).astype(np.uint8)
    coverage = rng.integers(0, 6, size=(n_time, HEIGHT, WIDTH), dtype=np.uint8)
    return mask, coverage


def test_mask_and_coverage_are_appended_at_every_level(tmp_path, truth):
    mask, coverage = planes(N_TIME)
    store, fresh = tmp_path / "store", tmp_path / "fresh"
    head = make_da(truth[:8], BANDS)
    chronozarr.encode(
        head,
        store,
        chunk_size=CHUNK,
        shard=True,
        shard_time=4,
        mask=mask[:8],
        coverage=coverage[:8],
    )
    append(store, window(truth, 8, 12), mask=mask[8:12], coverage=coverage[8:12])
    chronozarr.encode(
        make_da(truth[:12], BANDS),
        fresh,
        chunk_size=CHUNK,
        shard=True,
        shard_time=4,
        mask=mask[:12],
        coverage=coverage[:12],
    )
    assert chronozarr.validate(store) == []
    appended, expected = chronozarr.open_store(store), chronozarr.open_store(fresh)
    assert appended.attrs.mask_variable == "mask" and appended.attrs.nodata is None
    for lod in range(len(expected.levels)):
        assert np.array_equal(appended.to_xarray(lod=lod).values, decoded(fresh, lod))
        for t in range(12):
            assert np.array_equal(appended.read_mask(t, lod), expected.read_mask(t, lod))
            assert np.array_equal(appended.read_coverage(t, lod), expected.read_coverage(t, lod))
    assert np.array_equal(appended.read_mask(9), mask[9])
    assert np.array_equal(appended.read_coverage(11), coverage[11])


def test_mask_and_coverage_must_match_what_the_store_has(tmp_path, truth):
    mask, coverage = planes(N_TIME)
    with_mask, without = tmp_path / "with", tmp_path / "without"
    chronozarr.encode(
        make_da(truth[:8], BANDS),
        with_mask,
        chunk_size=CHUNK,
        mask=mask[:8],
        coverage=coverage[:8],
    )
    encode_head(truth, without, 8)
    before_with, before_without = digests(with_mask), digests(without)
    with pytest.raises(ValueError, match="the store has a mask, so the input needs one"):
        append(with_mask, window(truth, 8, 9), coverage=coverage[8:9])
    with pytest.raises(ValueError, match="the store has no mask and append cannot add one"):
        append(without, window(truth, 8, 9), mask=mask[8:9])
    with pytest.raises(ValueError, match="the store has no coverage"):
        append(without, window(truth, 8, 9), coverage=coverage[8:9])
    assert digests(with_mask) == before_with and digests(without) == before_without


# --- Input from a store -------------------------------------------------------------------------


def test_a_store_written_by_encode_can_be_appended(tmp_path, truth):
    store, month = tmp_path / "store", tmp_path / "month"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    chronozarr.encode(window(truth, 8, 10), month, chunk_size=CHUNK)
    report = append(store, month)
    assert report.n_appended == 2
    assert chronozarr.validate(store) == []
    assert np.array_equal(decoded(store), truth[:10])
    assert is_store(month) and is_store(store)
    assert not is_store(tmp_path) and not is_store(tmp_path / "missing")


def test_a_store_input_carries_mask_and_coverage(tmp_path, truth):
    mask, coverage = planes(N_TIME)
    store, month = tmp_path / "store", tmp_path / "month"
    chronozarr.encode(
        make_da(truth[:8], BANDS), store, chunk_size=CHUNK, mask=mask[:8], coverage=coverage[:8]
    )
    chronozarr.encode(
        window(truth, 8, 9), month, chunk_size=CHUNK, mask=mask[8:9], coverage=coverage[8:9]
    )
    append(store, month)
    opened = chronozarr.open_store(store)
    assert np.array_equal(opened.read_mask(8), mask[8])
    assert np.array_equal(opened.read_coverage(8), coverage[8])
    assert np.array_equal(opened.read(8), truth[8])


def test_a_converted_month_is_appended(tmp_path, truth):
    store, source = tmp_path / "store", tmp_path / "month.zarr"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    y, x = schema.pixel_centers(TRANSFORM, HEIGHT, WIDTH)
    xr.DataArray(
        truth[8:10],
        dims=schema.DIMENSIONS,
        coords={"time": make_times(N_TIME)[8:10], "band": BANDS, "y": y, "x": x},
        name="reflectance",
        attrs={"crs": CRS},
    ).to_dataset().to_zarr(source, zarr_format=2, consolidated=False)

    undeclared = tmp_path / "undeclared"  # convert declares no nodata unless told to
    convert(source, undeclared, chunk_size=CHUNK)
    refuse(store, undeclared, "nodata: the input has None, the store has 0")

    month = tmp_path / "month"
    convert(source, month, chunk_size=CHUNK, nodata=0)
    append(store, month)
    assert chronozarr.validate(store) == []
    assert np.array_equal(decoded(store), truth[:10])


def test_store_input_refuses_other_arguments(tmp_path, truth):
    store, month = tmp_path / "store", tmp_path / "month"
    encode_head(truth, store, 8)
    chronozarr.encode(window(truth, 8, 9), month, chunk_size=CHUNK)
    with pytest.raises(ValueError, match="carries its own"):
        append(store, month, crs=CRS)


# --- Refusals -----------------------------------------------------------------------------------


@pytest.fixture
def base_store(tmp_path, truth) -> Path:
    store = tmp_path / "base"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    return store


def refuse(store: Path, data, message: str, **kwargs) -> None:
    before = digests(store)
    with pytest.raises(ValueError, match=message):
        append(store, data, **kwargs)
    assert digests(store) == before, "a refused append must leave the store untouched"


def test_grid_mismatch(base_store):
    other = make_truth(N_TIME, 2, HEIGHT + 1, WIDTH)
    refuse(base_store, window(other, 8, 9), r"grid: the input is 51 x 70 pixels, .* is 50 x 70")


def test_band_mismatches(base_store, truth):
    renamed = window(truth, 8, 9).assign_coords(band=["B04", "B03"])
    refuse(base_store, renamed, "bands: the input has 'B03', the store has 'B08'")
    three = make_truth(N_TIME, 3, HEIGHT, WIDTH)
    refuse(base_store, make_da(three, ["a", "b", "c"]).isel(time=slice(8, 9)), "the input has 3")


def test_band_metadata_must_agree_when_given(tmp_path, truth):
    store = tmp_path / "store"
    chronozarr.encode(
        make_da(truth[:8], BANDS),
        store,
        chunk_size=CHUNK,
        bands=[{"name": "B04", "scale": 0.0001}, "B08"],
    )
    refuse(
        store,
        window(truth, 8, 9),
        "bands: the input has",
        bands=[{"name": "B04", "scale": 0.5}, "B08"],
    )
    append(store, window(truth, 8, 9), bands=["B04", "B08"])  # names alone are enough
    assert chronozarr.validate(store) == []


def test_dtype_mismatch(base_store, truth):
    refuse(base_store, window(truth, 8, 9).astype(np.uint8), "dtype: the input is uint8")


def test_crs_mismatch(base_store, truth):
    other = window(truth, 8, 9)
    other.attrs["crs"] = "EPSG:32632"
    refuse(base_store, other, "crs: the input is 'EPSG:32632', the store is 'EPSG:32631'")
    refuse(base_store, window(truth, 8, 9), "crs: the input is 'EPSG:4326'", crs="EPSG:4326")


def test_transform_mismatch(base_store, truth):
    other = window(truth, 8, 9)
    shifted = (*TRANSFORM[:2], TRANSFORM[2] + 10.0, *TRANSFORM[3:])
    other.attrs["transform"] = shifted
    refuse(base_store, other, "transform: the input's is")


def test_times_must_follow_the_store(base_store, truth):
    refuse(base_store, window(truth, 7, 9), "times: the input starts at 2024-08-01.*not after")
    refuse(base_store, window(truth, 0, 2), "not after the store's last time")


def test_iterable_input_needs_times_and_consistent_steps(base_store, truth):
    with pytest.raises(ValueError, match="needs times="):
        append(base_store, [truth[8]])
    mismatched = [truth[8], truth[9][:1]]
    refuse(base_store, mismatched, "timestep 1 is", times=make_times(N_TIME)[8:10])


def test_nodata_of_a_store_input_must_match(tmp_path, truth):
    store, month = tmp_path / "store", tmp_path / "month"
    encode_head(truth, store, 8)
    chronozarr.encode(window(truth, 8, 9), month, chunk_size=CHUNK, nodata=None)
    refuse(store, month, "nodata: the input has None, the store has 0")


def test_every_mismatch_is_listed(base_store, truth):
    other = make_truth(N_TIME, 2, HEIGHT, WIDTH + 1)
    bad = window(other, 8, 9).astype(np.uint8)
    with pytest.raises(ValueError) as excinfo:
        append(base_store, bad)
    text = str(excinfo.value)
    assert "grid:" in text and "dtype:" in text


def test_a_store_that_does_not_validate_is_refused(base_store, truth):
    shard = base_store / "0" / "data" / "c" / "0" / "0" / "0" / "0"
    shard.write_bytes(shard.read_bytes() + b"x")  # no longer the length shard_bytes lists
    with pytest.raises(ValueError, match="does not validate, so nothing was appended"):
        append(base_store, window(truth, 8, 9))


def test_workers_and_location_are_checked(base_store, truth, tmp_path):
    with pytest.raises(ValueError, match="workers must be >= 1"):
        append(base_store, window(truth, 8, 9), workers=0)
    with pytest.raises(ValueError, match="not a local directory"):
        append(tmp_path / "missing", window(truth, 8, 9))


# --- CLI and neighbours -------------------------------------------------------------------------


def run(*args: str):
    return CliRunner().invoke(main, list(args), catch_exceptions=False)


def test_cli_append_from_a_store_then_validate_info_and_doctor(tmp_path, truth):
    store, month = tmp_path / "store", tmp_path / "month"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    chronozarr.encode(window(truth, 8, 9), month, chunk_size=CHUNK)
    result = run("append", str(store), str(month))
    assert result.exit_code == 0, result.output
    assert "appended 1 timestep(s)" in result.output and "9 in total" in result.output
    assert run("validate", str(store)).exit_code == 0
    assert "times:     9" in run("info", str(store)).output
    checks = diagnose(str(store))
    assert [c for c in checks if c.status == "fail"] == []
    assert np.array_equal(decoded(store), truth[:9])


def test_cli_append_from_a_zarr_input(tmp_path, truth):
    store, source = tmp_path / "store", tmp_path / "input.zarr"
    encode_head(truth, store, 8, shard=True, shard_time=4)
    window(truth, 8, 11).to_dataset(name="reflectance").to_zarr(
        source, zarr_format=2, consolidated=False
    )
    result = run("append", str(store), str(source))
    assert result.exit_code == 0, result.output
    assert np.array_equal(decoded(store), truth[:11])


def test_cli_reports_a_mismatch_as_one_error(tmp_path, truth):
    store, month = tmp_path / "store", tmp_path / "month"
    encode_head(truth, store, 8)
    other = make_truth(N_TIME, 2, HEIGHT + 2, WIDTH)
    chronozarr.encode(window(other, 8, 9), month, chunk_size=CHUNK)
    result = CliRunner().invoke(main, ["append", str(store), str(month)])
    assert result.exit_code == 1
    assert "grid: the input is 52 x 70" in result.output
    assert "Traceback" not in result.output


def test_cli_help_lists_append():
    assert "append" in run("--help").output
