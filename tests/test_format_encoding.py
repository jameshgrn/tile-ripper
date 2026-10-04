"""v0.3 ordinary values, version boundaries, and independent legacy migration checks."""

from __future__ import annotations

import json
import warnings

import numpy as np
import pytest
import xarray as xr
import zarr
from zarr.errors import ZarrUserWarning
from zarr.storage import LocalStore

import chronozarr
from chronozarr import schema
from chronozarr.convert import convert
from tests.synthetic import build_store, make_da, make_truth, reference_reduce
from tests.test_reads import CountingStore

pytestmark = pytest.mark.unit


def consolidate(path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ZarrUserWarning)
        zarr.consolidate_metadata(path)


@pytest.mark.parametrize("dtype", ["uint8", "uint16", "int16", "float32"])
@pytest.mark.parametrize("shard", [False, True])
def test_v03_roundtrip_every_level(tmp_path, dtype, shard):
    truth = make_truth(5, 2, 9, 11).astype(dtype)
    mask = np.ones((5, 9, 11), dtype="uint8")
    mask[:, -2:, -2:] = 0
    coverage = np.arange(5 * 9 * 11, dtype="uint16").reshape(5, 9, 11).clip(0, 255).astype("uint8")
    path = tmp_path / "s"
    chronozarr.encode(
        make_da(truth),
        path,
        mask=mask,
        coverage=coverage,
        chunk_size=4,
        shard=shard,
        shard_time=2 if shard else None,
    )
    assert chronozarr.validate(path) == []
    store = chronozarr.open_store(path)
    root = zarr.open_group(path, mode="r")
    assert "temporal" not in root.attrs["chronozarr"]
    assert "volatility" not in root
    for k in range(len(store.levels)):
        if k:
            truth, mask, coverage = reference_reduce(
                truth, nodata=None, mask=mask, coverage=coverage
            )
        assert np.array_equal(store.to_xarray(k).values, truth)
        assert np.array_equal(
            schema.get_array(schema.get_group(root, str(k), "s"), "data", "s")[:], truth
        )
        for t in range(len(truth)):
            assert np.array_equal(store.read_mask(t, k), mask[t])
            assert np.array_equal(store.read_coverage(t, k), coverage[t])


@pytest.mark.parametrize("version", ["0.2.0", "0.1.0", "0.3.1", "9.0.0", None])
def test_versions_rejected_before_values(tmp_path, version):
    path = tmp_path / "s"
    build_store(path, make_truth(2, 1, 4, 4), shard=False, chunk_size=4)
    root = zarr.open_group(path, mode="r+", use_consolidated=False)
    attrs = dict(root.attrs["chronozarr"])
    if version is None:
        attrs.pop("spec_version")
    else:
        attrs["spec_version"] = version
    root.attrs["chronozarr"] = attrs
    consolidate(path)
    with pytest.raises(schema.SchemaError, match="chronozarr convert"):
        chronozarr.open_store(path)
    assert "chronozarr convert" in ";".join(chronozarr.validate(path))


def test_one_chunk_per_timestep(tmp_path):
    path = tmp_path / "s"
    build_store(path, make_truth(5, 2, 9, 11), shard=False, chunk_size=4)
    counting = CountingStore(LocalStore(path, read_only=True))
    store = chronozarr.open_store(counting)
    counting.reads.clear()
    store.read_cell(3, 1, 1)
    assert [key for key, _ in counting.reads if "/data/c/" in key] == ["0/data/c/3/0/1/1"]


@pytest.mark.parametrize("flag,value", [("encoding", "none"), ("anchor_interval", 6)])
def test_removed_options_are_not_accepted(tmp_path, flag, value):
    with pytest.raises(TypeError, match=flag):
        chronozarr.encode(make_da(make_truth(2, 1, 4, 4)), tmp_path / "s", **{flag: value})


@pytest.mark.parametrize("shard", [False, True])
@pytest.mark.parametrize("encoding", ["none", "star-delta"])
def test_exact_legacy_conversion_preserves_existing_overviews(tmp_path, shard, encoding):
    source = tmp_path / "old"
    truth = make_truth(7, 2, 9, 11)
    mask = np.ones((7, 9, 11), dtype="uint8")
    mask[:, -2:, -2:] = 0
    coverage = np.full(mask.shape, 23, dtype="uint8")
    chronozarr.encode(
        make_da(truth),
        source,
        mask=mask,
        coverage=coverage,
        chunk_size=4,
        shard=shard,
        shard_time=3 if shard else None,
        provenance={"sources": ["synthetic"], "composite": "none", "gap_fill": "none"},
    )
    root = zarr.open_group(source, mode="r+", use_consolidated=False)
    meta = dict(root.attrs["chronozarr"])
    meta["spec_version"] = "0.2.0"
    comparisons = [0, 3, 6]
    refs = {
        t: min(comparisons, key=lambda q: (abs(t - q), q))
        for t in range(7)
        if t not in comparisons
    }
    # Valid non-nearest reference tests conversion of appended v0.2 stores.
    refs[2] = 0
    meta["temporal"] = {"encoding": encoding}
    if encoding == "star-delta":
        meta["temporal"].update(
            anchor_interval=3,
            anchor_indices=comparisons,
            delta_reference={str(t): q for t, q in refs.items()},
        )
    expected = []
    for k in range(len(meta["levels"])):
        array = schema.get_array(schema.get_group(root, str(k), "old"), "data", "old")
        values = np.asarray(array[:])
        # Perturb a legacy overview: migration must preserve it rather than recompute.
        if k:
            values[2, 1, 0, 0] += 7
        expected.append(values.copy())
        if encoding == "star-delta":
            original = values.copy()
            for t, q in refs.items():
                np.subtract(original[t], original[q], out=values[t])
        array[:] = values
    root.attrs.update(
        {
            "chronozarr": meta,
            "multiscales": [
                {"datasets": [{"path": str(k), "crs": meta["crs"]} for k in range(len(expected))]}
            ],
        }
    )
    consolidate(source)
    source_bytes = {
        str(p.relative_to(source)): p.read_bytes() for p in source.rglob("*") if p.is_file()
    }
    report = convert(source, tmp_path / "new")
    assert report.encode is not None
    assert (report.encode.codec, report.encode.level) == ("zstd", 5)
    assert chronozarr.validate(tmp_path / "new") == []
    new = chronozarr.open_store(tmp_path / "new")
    for k, values in enumerate(expected):
        assert new.to_xarray(k).values.tobytes() == values.tobytes()
        for name in ("mask", "coverage", "time", "band", "x", "y"):
            old = schema.get_array(schema.get_group(root, str(k), "old"), name, "old")
            dest = schema.get_array(
                schema.get_group(zarr.open_group(tmp_path / "new"), str(k), "new"), name, "new"
            )
            assert np.array_equal(old[:], dest[:])
    assert source_bytes == {
        str(p.relative_to(source)): p.read_bytes() for p in source.rglob("*") if p.is_file()
    }
    if encoding == "none":
        for key, value in source_bytes.items():
            if "/c/" in key:
                assert (tmp_path / "new" / key).read_bytes() == value


def test_native_xarray(tmp_path):
    truth = make_truth(3, 2, 9, 11)
    path = tmp_path / "s"
    build_store(path, truth, shard=False, chunk_size=4)
    ds = xr.open_zarr(path, group="0", chunks=None, mask_and_scale=False)
    assert np.array_equal(ds.data.values, truth)
    assert ds.time.dtype == np.dtype("datetime64[ns]")
    assert ds.data.attrs["proj:code"] == "EPSG:32631"


def test_hand_built_spike_validates(tmp_path):
    from scripts.spike_v03_fixture import build

    build(tmp_path / "spike")
    assert schema.validate(tmp_path / "spike") == []


@pytest.mark.parametrize("volatility", [False, True])
def test_append_matches_fresh_values_and_metric(tmp_path, volatility):
    truth = make_truth(9, 2, 9, 11)
    path = tmp_path / "s"
    da = make_da(truth)
    chronozarr.encode(da[:5], path, chunk_size=4, volatility=volatility, shard=True, shard_time=3)
    chronozarr.append(path, da[5:])
    fresh = tmp_path / "fresh"
    chronozarr.encode(da, fresh, chunk_size=4, volatility=volatility, shard=True, shard_time=3)
    assert schema.validate(path) == []
    a, b = chronozarr.open_store(path), chronozarr.open_store(fresh)
    for k in range(len(a.levels)):
        assert np.array_equal(a.to_xarray(k).values, b.to_xarray(k).values)
    if volatility:
        assert np.array_equal(
            zarr.open_group(path)["volatility"][:], zarr.open_group(fresh)["volatility"][:]
        )


@pytest.mark.parametrize("name", ["multiscales", "proj", "spatial"])
def test_literal_registrations_required(tmp_path, name):
    path = tmp_path / "s"
    build_store(path, make_truth(2, 1, 4, 4), shard=False, chunk_size=4)
    root = zarr.open_group(path, mode="r+", use_consolidated=False)
    node = (
        root
        if name == "multiscales"
        else schema.get_array(schema.get_group(root, "0", "s"), "data", "s")
    )
    registrations = list(node.attrs["zarr_conventions"])
    for entry in registrations:
        if entry["name"] == name:
            entry["schema_url"] = entry["schema_url"].replace("refs/tags/v0.1", "main")
    node.attrs["zarr_conventions"] = registrations
    consolidate(path)
    assert any("registration" in p for p in schema.validate(path))
    with pytest.raises(ValueError, match="registration"):
        chronozarr.open_store(path)


def test_unknown_mandatory_extension_is_fail_closed(tmp_path):
    path = tmp_path / "s"
    build_store(path, make_truth(2, 1, 4, 4), shard=False, chunk_size=4)
    manifest = path / "zarr.json"
    metadata = json.loads(manifest.read_text())
    metadata["future_storage"] = {"must_understand": True}
    manifest.write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="future_storage"):
        chronozarr.open_store(path)
    assert any("future_storage" in p for p in schema.validate(path))


def test_cached_indices_and_immutable_root_use_one_metadata_read(tmp_path):
    path = tmp_path / "s"
    build_store(path, make_truth(6, 1, 8, 8), shard=True, shard_time=3, chunk_size=4)
    counting = CountingStore(LocalStore(path, read_only=True))
    store = chronozarr.open_store(counting)
    assert [k for k, _ in counting.reads if k == "zarr.json"] == ["zarr.json"]
    counting.reads.clear()
    store.read_cell(0, 0, 0)
    first = [r for k, r in counting.reads if "/data/c/" in k]
    counting.reads.clear()
    store.read_cell(1, 0, 0)
    second = [r for k, r in counting.reads if "/data/c/" in k]
    assert len(first) == 2  # index plus data
    assert len(second) == 1  # cached index


def test_reader_falls_back_without_mirrors_or_consolidation(tmp_path):
    path = tmp_path / "s"
    truth = make_truth(3, 2, 9, 11)
    build_store(path, truth, shard=False, chunk_size=4)
    manifest = path / "zarr.json"
    metadata = json.loads(manifest.read_text())
    metadata.pop("consolidated_metadata")
    for key in ("levels", "band_names"):
        metadata["attributes"]["chronozarr"].pop(key)
    manifest.write_text(json.dumps(metadata))
    assert np.array_equal(chronozarr.open_store(path).read(2), truth[2])
    problems = schema.validate(path)
    assert len(problems) == 2 and all("writer must emit" in p for p in problems)


def test_unknown_ignorable_extension_does_not_block_reader(tmp_path):
    path = tmp_path / "s"
    truth = make_truth(2, 1, 4, 4)
    build_store(path, truth, shard=False, chunk_size=4)
    manifest = path / "zarr.json"
    metadata = json.loads(manifest.read_text())
    metadata["optional_future"] = {"must_understand": False}
    manifest.write_text(json.dumps(metadata))
    assert np.array_equal(chronozarr.open_store(path).read(1), truth[1])
    assert schema.validate(path) == []
