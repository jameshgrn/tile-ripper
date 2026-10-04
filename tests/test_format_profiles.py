"""Dtype profiles, nodata, mask, band metadata and physical values."""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr
import zarr

import chronozarr
from chronozarr import schema
from chronozarr.schema import Band
from tests.synthetic import CRS, TRANSFORM, make_da, make_truth, reference_reduce

pytestmark = pytest.mark.unit

CS = 8  # tiny cells keep the tests fast; 2 x 2 cells of a 13 x 11 raster


def _encode(tmp_path, truth, **kwargs):
    kwargs.setdefault("chunk_size", CS)
    bands = kwargs.pop("bands", [f"b{i}" for i in range(truth.shape[1])])
    names = [b if isinstance(b, str) else getattr(b, "name", None) or b["name"] for b in bands]
    da = make_da(truth, names)
    report = chronozarr.encode(da, tmp_path / "s", bands=bands, **kwargs)
    return report, chronozarr.open_store(tmp_path / "s")


def _scene(dtype: str, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    shape = (3, 2, 13, 11)
    if dtype == "float32":
        return rng.normal(10, 50, shape).astype(np.float32)
    info = np.iinfo(dtype)
    return rng.integers(max(info.min, -30000), min(info.max, 30000), shape, dtype=dtype)


# --- dtype profiles ---------------------------------------------------------------------------


def test_unsupported_dtype_is_rejected(tmp_path):
    truth = make_truth(2, 1, 8, 8).astype(np.int32)
    with pytest.raises(ValueError, match="unsupported dtype int32"):
        chronozarr.encode(make_da(truth), tmp_path / "s", chunk_size=CS)


# --- nodata -----------------------------------------------------------------------------------


def test_default_nodata_is_zero_for_unsigned_and_null_otherwise(tmp_path):
    _, unsigned = _encode(tmp_path, _scene("uint16"))
    assert unsigned.attrs.nodata == 0
    other = tmp_path / "other"
    other.mkdir()
    _, signed = _encode(other, _scene("int16"))
    assert signed.attrs.nodata is None


def test_explicit_nodata_is_fill_value_attr_and_excluded_from_means(tmp_path):
    truth = np.full((2, 1, 4, 4), 100, dtype=np.uint16)
    truth[:, :, 0, 0] = 65535
    truth[:, :, 2:, 2:] = 65535  # a fully nodata block
    _, store = _encode(tmp_path, truth, chunk_size=4, nodata=65535, n_lods=2)
    data = zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"]
    assert data.fill_value == 65535
    assert data.attrs["nodata"] == 65535
    assert store.attrs.nodata == 65535
    coarse = store.read(0, lod=1)[0]
    assert coarse.tolist() == [[100, 100], [100, 65535]]
    assert chronozarr.validate(tmp_path / "s") == []


def test_nodata_null_treats_zero_as_a_value(tmp_path):
    truth = np.zeros((1, 1, 2, 2), dtype=np.uint16)
    truth[0, 0, 0, 0] = 8
    _, store = _encode(tmp_path, truth, chunk_size=2, nodata=None, n_lods=2)
    assert store.read(0, lod=1)[0, 0, 0] == 2  # (8 + 0 + 0 + 0) // 4: zeros count
    assert zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"].fill_value == 0


def test_star_delta_with_a_nonzero_nodata_roundtrips(tmp_path):
    truth = make_truth(4, 1, 13, 11)
    truth[:, :, 0, :] = 65535
    _, store = _encode(tmp_path, truth, nodata=65535)
    assert np.array_equal(store.to_xarray().values, truth)
    assert chronozarr.validate(tmp_path / "s") == []


@pytest.mark.parametrize(
    ("dtype", "nodata", "message"),
    [
        ("uint16", 70000, "within uint16 range"),
        ("uint16", -1, "within uint16 range"),
        ("uint8", 1.5, "not an integer"),
        ("uint16", float("nan"), "must be finite"),
        ("float32", float("inf"), "must be finite"),
        ("uint16", "zero", "number or None"),
    ],
)
def test_invalid_nodata_is_rejected(tmp_path, dtype, nodata, message):
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(make_da(_scene(dtype)), tmp_path / "s", chunk_size=CS, nodata=nodata)


# --- physical values --------------------------------------------------------------------------


def test_physical_applies_scale_offset_and_nan_for_nodata(tmp_path):
    truth = np.array([[[[0, 1000]], [[5000, 10000]]]], dtype=np.uint16)  # (1 t, 2 b, 1 y, 2 x)
    bands = [
        {"name": "B04", "common_name": "red", "scale": 0.0001},
        {"name": "T", "scale": 0.5, "offset": -10.0, "units": "K"},
    ]
    _, store = _encode(tmp_path, truth, chunk_size=2, bands=bands, n_lods=1)
    physical = store.physical(0)
    assert physical.dtype == np.float32
    assert np.isnan(physical[0, 0, 0])  # stored 0 is nodata
    assert physical[0, 0, 1] == pytest.approx(0.1)
    assert physical[1, 0, 0] == pytest.approx(2490.0)
    assert physical[1, 0, 1] == pytest.approx(4990.0)
    assert np.array_equal(store.read(0), truth[0])  # raw values are untouched
    physical_da = store.to_xarray(physical=True)
    assert physical_da.dtype == np.float32
    assert np.isnan(physical_da.values[0, 0, 0, 0])


def test_physical_uses_the_mask_over_nodata(tmp_path):
    truth = np.array([[[[0, 7]]]], dtype=np.uint16)
    mask = np.array([[[1, 0]]], dtype=np.uint8)  # pixel 0 valid despite value 0; pixel 1 invalid
    _, store = _encode(tmp_path, truth, chunk_size=2, mask=mask, n_lods=1)
    physical = store.physical(0)
    assert physical[0, 0, 0] == 0.0
    assert np.isnan(physical[0, 0, 1])


def test_physical_defaults_to_identity_scale(tmp_path):
    truth = _scene("int16")
    _, store = _encode(tmp_path, truth)
    assert np.array_equal(store.physical(1, lod=0), truth[1].astype(np.float32))


# --- mask -------------------------------------------------------------------------------------


def _masked_scene():
    truth = make_truth(3, 2, 13, 11)
    truth[truth == 0] = 1  # no nodata-valued pixels: validity comes from the mask alone
    rng = np.random.default_rng(5)
    mask = (rng.random((3, 13, 11)) > 0.35).astype(np.uint8)
    mask[:, 8:, 8:] = 0  # a corner with no valid pixels at any timestep
    return truth, mask


@pytest.mark.parametrize("shard", [True, False], ids=["sharded", "unsharded"])
def test_mask_is_stored_reduced_and_drives_the_data_means(tmp_path, shard):
    truth, mask = _masked_scene()
    _, store = _encode(tmp_path, truth, mask=mask, shard=shard)
    assert store.attrs.mask_variable == "mask"
    level, level_mask = truth, mask
    for lod in range(len(store.levels)):
        if lod:
            level, level_mask, _ = reference_reduce(level, nodata=0, mask=level_mask)
        assert np.array_equal(store.to_xarray(lod=lod).values, level), f"data level {lod}"
        for t in range(3):
            assert np.array_equal(store.read_mask(t, lod), level_mask[t]), f"mask {lod} t={t}"
    assert chronozarr.validate(tmp_path / "s") == []
    assert store.read_coverage(0) is None


def test_mask_layout_matches_the_data_array(tmp_path):
    truth, mask = _masked_scene()
    _encode(tmp_path, truth, mask=mask, shard=True, shard_time=2)
    root = zarr.open_group(str(tmp_path / "s"), mode="r")
    for lod in ("0", "1"):
        data, plane = root[lod]["data"], root[lod]["mask"]
        assert plane.dtype == np.uint8
        assert plane.metadata.dimension_names == ("time", "y", "x")
        assert plane.attrs["_ARRAY_DIMENSIONS"] == ["time", "y", "x"]
        assert plane.chunks == (1, CS, CS)
        assert plane.shards == (2, CS, CS)
        assert plane.shape == (3, *data.shape[2:])
    attrs = root.attrs["chronozarr"]
    assert attrs["mask_variable"] == "mask"
    assert "coverage_variable" not in attrs


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda m: m.astype(np.int16), "mask must be uint8"),
        (lambda m: m * 2, "only 0 .* and 1"),
        (lambda m: m[:, :5], "differs from the data"),
    ],
)
def test_bad_mask_is_rejected(tmp_path, mutate, message):
    truth, mask = _masked_scene()
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(
            make_da(truth),
            tmp_path / "s",
            chunk_size=CS,
            mask=xr.DataArray(mutate(mask), dims=("time", "y", "x")),
        )
    assert not (tmp_path / "s").exists()


def test_bool_mask_is_accepted(tmp_path):
    truth, mask = _masked_scene()
    _, store = _encode(tmp_path, truth, mask=mask.astype(bool))
    assert np.array_equal(store.read_mask(1), mask[1])


# --- band metadata ----------------------------------------------------------------------------


def test_bands_are_objects_with_a_names_mirror(tmp_path):
    bands = [
        Band("B04", common_name="red", scale=0.0001, offset=0.0, units="reflectance"),
        Band("B08", common_name="nir"),
    ]
    _, store = _encode(tmp_path, make_truth(2, 2, 13, 11), bands=bands)
    block = zarr.open_group(str(tmp_path / "s"), mode="r").attrs["chronozarr"]
    assert block["bands"] == [
        {
            "name": "B04",
            "common_name": "red",
            "scale": 0.0001,
            "offset": 0.0,
            "units": "reflectance",
        },
        {"name": "B08", "common_name": "nir", "scale": 1.0, "offset": 0.0},
    ]
    assert block["band_names"] == ["B04", "B08"]
    assert store.bands == ("B04", "B08")
    assert store.attrs.bands == (bands[0], Band("B08", common_name="nir", scale=1.0, offset=0.0))
    assert list(zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["band"][:]) == ["B04", "B08"]


def test_band_names_come_from_the_coordinate_by_default(tmp_path):
    truth = make_truth(2, 2, 13, 11)
    chronozarr.encode(make_da(truth, ["red", "green"]), tmp_path / "s", chunk_size=CS)
    assert chronozarr.open_store(tmp_path / "s").bands == ("red", "green")


@pytest.mark.parametrize(
    ("bands", "message"),
    [
        (["a", "b", "c"], "3 band names for 2 bands"),
        (["x", "y"], "differ from the band coordinate"),
        ([{"name": "a", "scale": "big"}, "b"], "expected a finite number"),
        ([{"common_name": "red"}, "b"], "missing required key 'name'"),
    ],
)
def test_bad_bands_are_rejected(tmp_path, bands, message):
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(
            make_da(make_truth(2, 2, 8, 8), ["a", "b"]), tmp_path / "s", chunk_size=CS, bands=bands
        )


def test_band_mismatch_between_attrs_and_band_names_is_flagged(tmp_path):
    _encode(tmp_path, make_truth(2, 2, 13, 11))
    root = zarr.open_group(str(tmp_path / "s"), mode="r+", use_consolidated=False)
    block = dict(root.attrs["chronozarr"])
    block["band_names"] = ["wrong", "names"]
    root.attrs["chronozarr"] = block
    assert any("band_names" in p for p in chronozarr.validate(tmp_path / "s"))


def test_iterable_bands_need_names(tmp_path):
    steps = iter(make_truth(2, 1, 8, 8))
    with pytest.raises(ValueError, match="no band names"):
        chronozarr.encode(
            steps,
            tmp_path / "s",
            times=make_da(make_truth(2, 1, 8, 8)).time.values,
            crs=CRS,
            transform=TRANSFORM,
            chunk_size=CS,
        )


def test_band_schema_accepts_names_and_objects():
    assert schema.parse_bands(["a", "b"], "bands") == (Band("a"), Band("b"))
    with pytest.raises(schema.SchemaError, match="must be unique"):
        schema.parse_bands(["a", {"name": "a"}], "bands")


# --- nodata with a mask -----------------------------------------------------------------------


def _zeros_that_are_valid():
    """A scene with zero-valued pixels that the mask says are valid, and masked-out pixels."""
    truth = make_truth(3, 1, 13, 11)
    truth[truth == 0] = 1
    truth[:, :, 0:2, 0:2] = 0  # real zeros: valid
    mask = np.ones((3, 13, 11), dtype=np.uint8)
    mask[:, 5:7, 5:7] = 0  # invalid whatever the value
    return truth, mask


def test_a_mask_makes_the_default_nodata_null(tmp_path):
    truth, mask = _zeros_that_are_valid()
    _, store = _encode(tmp_path, truth, mask=mask)
    assert store.attrs.nodata is None
    data = zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"]
    assert "nodata" not in data.attrs
    assert data.fill_value == 0
    assert chronozarr.validate(tmp_path / "s") == []
    physical = store.physical(0)
    assert not np.isnan(physical[0, :2, :2]).any()  # zeros under mask == 1 stay valid
    assert np.isnan(physical[0, 5:7, 5:7]).all()
    level, level_mask, _ = reference_reduce(truth, nodata=None, mask=mask)
    assert np.array_equal(store.to_xarray(lod=1).values, level)
    assert np.array_equal(store.read_mask(0, lod=1), level_mask[0])


def test_a_mask_with_iterable_input_also_defaults_nodata_to_null(tmp_path):
    truth, mask = _zeros_that_are_valid()
    chronozarr.encode(
        iter(truth),
        tmp_path / "s",
        times=make_da(truth).time.values,
        bands=["b0"],
        crs=CRS,
        transform=TRANSFORM,
        mask=iter(mask),
        chunk_size=CS,
    )
    assert chronozarr.open_store(tmp_path / "s").attrs.nodata is None


def test_an_explicit_nodata_is_kept_with_a_mask(tmp_path):
    truth, mask = _zeros_that_are_valid()
    _, store = _encode(tmp_path, truth, mask=mask, nodata=0)
    assert store.attrs.nodata == 0
    assert zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"].attrs["nodata"] == 0
    assert chronozarr.validate(tmp_path / "s") == []


def test_without_a_mask_the_default_nodata_is_still_zero(tmp_path):
    truth, _ = _zeros_that_are_valid()
    _, store = _encode(tmp_path, truth)
    assert store.attrs.nodata == 0


def test_to_xarray_carries_validity_as_a_mask_coordinate_not_a_nodata_attr(tmp_path):
    truth, mask = _zeros_that_are_valid()
    _, store = _encode(tmp_path, truth, mask=mask, nodata=0)
    da = store.to_xarray()
    assert "nodata" not in da.attrs
    assert da["mask"].dims == ("time", "y", "x")
    assert da["mask"].dtype == np.uint8
    assert np.array_equal(da["mask"].values, mask)
    subset = store.to_xarray(lod=1, times=[2, 0])
    assert subset["mask"].shape == (2, *subset.shape[2:])
    assert np.array_equal(subset["mask"].values[0], store.read_mask(2, lod=1))
    physical = store.to_xarray(physical=True)
    assert "nodata" not in physical.attrs
    assert np.isnan(physical.values[0, 0, 5, 5])
    assert not np.isnan(physical.values[0, 0, 0, 0])
    assert da.isel(time=1)["mask"].shape == mask[1].shape  # selects along with the data


def test_to_xarray_without_a_mask_keeps_the_nodata_attr_and_has_no_mask(tmp_path):
    truth, _ = _zeros_that_are_valid()
    _, store = _encode(tmp_path, truth)
    da = store.to_xarray()
    assert da.attrs["nodata"] == 0
    assert "mask" not in da.coords
