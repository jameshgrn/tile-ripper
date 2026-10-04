"""Coverage, provenance, shard_time, shard_bytes, levels, chunk sizes and codecs."""

from __future__ import annotations

import json

import numpy as np
import pytest
import xarray as xr
import zarr
from zarr.abc.store import SuffixByteRequest
from zarr.storage import LocalStore

import chronozarr
from chronozarr import schema
from tests.synthetic import make_da, make_truth, reference_reduce
from tests.test_reads import CountingStore

pytestmark = pytest.mark.unit

CS = 8


def _encode(tmp_path, truth, **kwargs):
    kwargs.setdefault("chunk_size", CS)
    chronozarr.encode(make_da(truth), tmp_path / "s", **kwargs)
    return chronozarr.open_store(tmp_path / "s")


PROVENANCE = {
    "sources": ["sentinel-2-l2a"],
    "composite": "monthly median",
    "gap_fill": "carry-forward",
    "notes": "clouds masked with SCL",
}


# --- coverage ---------------------------------------------------------------------------------


def test_coverage_is_stored_and_mean_reduced_with_rounding(tmp_path):
    truth = make_truth(3, 1, 13, 11)
    rng = np.random.default_rng(9)
    coverage = rng.integers(0, 9, (3, 13, 11)).astype(np.uint8)
    store = _encode(tmp_path, truth, coverage=coverage)
    assert store.attrs.coverage_variable == "coverage"
    assert store.attrs.mask_variable is None
    level, level_cov = truth, coverage
    for lod in range(len(store.levels)):
        if lod:
            level, _, level_cov = reference_reduce(level, nodata=0, coverage=level_cov)
        for t in range(3):
            assert np.array_equal(store.read_coverage(t, lod), level_cov[t]), f"{lod} t={t}"
    assert chronozarr.validate(tmp_path / "s") == []
    assert store.read_mask(0) is None


def test_coverage_rounds_half_up():
    from chronozarr.encode import _downsample_plane_pair

    plane = np.array([[1, 1], [0, 0]], dtype=np.uint8)  # mean 0.5 -> 1
    assert _downsample_plane_pair(None, plane)[1].tolist() == [[1]]
    plane = np.array([[1, 0], [0, 0]], dtype=np.uint8)  # mean 0.25 -> 0
    assert _downsample_plane_pair(None, plane)[1].tolist() == [[0]]
    plane = np.array([[255, 255], [255, 255]], dtype=np.uint8)
    assert _downsample_plane_pair(None, plane)[1].tolist() == [[255]]


def test_mask_and_coverage_together(tmp_path):
    truth = make_truth(2, 1, 13, 11)
    mask = (truth[:, 0] != 0).astype(np.uint8)
    coverage = np.where(mask, 3, 0).astype(np.uint8)
    store = _encode(tmp_path, truth, mask=mask, coverage=coverage, shard=True, shard_time=1)
    assert store.attrs.mask_variable == "mask"
    assert store.attrs.coverage_variable == "coverage"
    assert np.array_equal(store.read_coverage(1), coverage[1])
    assert chronozarr.validate(tmp_path / "s") == []


def test_bad_coverage_is_rejected(tmp_path):
    truth = make_truth(2, 1, 8, 8)
    with pytest.raises(ValueError, match="coverage must be uint8"):
        chronozarr.encode(
            make_da(truth),
            tmp_path / "s",
            chunk_size=CS,
            coverage=xr.DataArray(np.zeros((2, 8, 8), dtype=np.float32), dims=("time", "y", "x")),
        )


# --- provenance -------------------------------------------------------------------------------


def test_provenance_roundtrips_through_the_root_attrs(tmp_path):
    store = _encode(tmp_path, make_truth(2, 1, 13, 11), provenance=PROVENANCE)
    assert dict(store.attrs.provenance or {}) == PROVENANCE
    block = zarr.open_group(str(tmp_path / "s"), mode="r").attrs["chronozarr"]
    assert block["provenance"] == PROVENANCE
    assert chronozarr.validate(tmp_path / "s") == []


def test_provenance_is_optional_and_notes_are_optional(tmp_path):
    store = _encode(tmp_path, make_truth(2, 1, 13, 11))
    assert store.attrs.provenance is None
    other = tmp_path / "other"
    other.mkdir()
    without_notes = {k: v for k, v in PROVENANCE.items() if k != "notes"}
    assert (
        dict(
            _encode(other, make_truth(2, 1, 13, 11), provenance=without_notes).attrs.provenance
            or {}
        )
        == without_notes
    )


@pytest.mark.parametrize(
    ("provenance", "message"),
    [
        ({"composite": "x", "gap_fill": "none"}, "missing required key 'sources'"),
        ({"sources": [], "composite": "x", "gap_fill": "none"}, "non-empty list of strings"),
        ({"sources": ["a"], "gap_fill": "none"}, "missing required key 'composite'"),
        ({"sources": ["a"], "composite": "x", "gap_fill": "fill"}, "expected one of"),
        (
            {"sources": ["a"], "composite": "x", "gap_fill": "none", "notes": 3},
            "expected a string",
        ),
    ],
)
def test_bad_provenance_is_rejected(tmp_path, provenance, message):
    with pytest.raises(schema.SchemaError, match=message):
        chronozarr.encode(
            make_da(make_truth(2, 1, 8, 8)), tmp_path / "s", chunk_size=CS, provenance=provenance
        )
    assert not (tmp_path / "s").exists()


# --- chunk size -------------------------------------------------------------------------------


@pytest.mark.parametrize("chunk_size", [256, 512])
def test_spec_chunk_sizes_write_a_conforming_store(tmp_path, chunk_size):
    truth = make_truth(2, 1, 300, 270)
    store = _encode(tmp_path, truth, chunk_size=chunk_size)
    expected_grid = (2, 2) if chunk_size == 256 else (1, 1)
    assert store.levels[0].grid == expected_grid
    assert store.levels[0].data.chunks == (1, 1, chunk_size, chunk_size)
    assert np.array_equal(store.to_xarray().values, truth)
    assert chronozarr.validate(tmp_path / "s") == []
    assert {level.chunk_size for level in store.levels} == {chunk_size}
    multiscale = zarr.open_group(str(tmp_path / "s"), mode="r").attrs["multiscales"]
    assert all("pixels_per_tile" not in d for d in multiscale["layout"])


@pytest.mark.parametrize("chunk_size", [0, 1, 7, -4])
def test_chunk_size_must_be_even(tmp_path, chunk_size):
    with pytest.raises(ValueError, match="chunk_size must be an even number"):
        chronozarr.encode(make_da(make_truth(2, 1, 8, 8)), tmp_path / "s", chunk_size=chunk_size)


# --- shard_time and shard_bytes ---------------------------------------------------------------


def test_shard_time_splits_the_time_axis_into_several_shards(tmp_path):
    truth = make_truth(7, 2, 13, 11)
    store = _encode(tmp_path, truth, shard=True, shard_time=3)
    data = zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"]
    assert data.shards == (3, 2, CS, CS)
    assert data.chunks == (1, 2, CS, CS)
    assert store.levels[0].shard_time == 3
    shard_files = sorted(
        p.relative_to(tmp_path / "s" / "0" / "data" / "c")
        for p in (tmp_path / "s" / "0" / "data" / "c").glob("*/0/*/*")
    )
    assert {p.parts[0] for p in shard_files} == {"0", "1", "2"}  # ceil(7 / 3) time shards
    assert len(shard_files) == 3 * 4  # 2 x 2 cells each
    assert np.array_equal(store.to_xarray().values, truth)
    for t in range(7):
        assert np.array_equal(store.read_cell(t, 1, 0), truth[t, :, 8:, 0:8])
    assert chronozarr.validate(tmp_path / "s") == []


def test_reads_span_shards_along_time(tmp_path):
    # Read ordinary timesteps from three distinct time shards.
    truth = make_truth(9, 1, 13, 11)
    _encode(tmp_path, truth, shard=True, shard_time=3)
    counting = CountingStore(LocalStore(tmp_path / "s", read_only=True))
    store = chronozarr.open_store(counting)
    counting.reads.clear()
    cell = store.read_cell(7, 0, 0)
    assert np.array_equal(cell, truth[7, :, :8, :8])
    keys = {k for k, _ in counting.reads if "/data/c/" in k}
    assert keys == {"0/data/c/2/0/0/0"}  # t=7 is in time shard 2
    counting.reads.clear()
    store.read_cell(5, 0, 0)  # t=5 is in time shard 1
    assert {k for k, _ in counting.reads if "/data/c/" in k} == {"0/data/c/1/0/0/0"}
    counting.reads.clear()
    cell = store.read_cell(6, 0, 0)  # t=6 is in time shard 2
    assert np.array_equal(cell, truth[6, :, :8, :8])
    assert {k for k, _ in counting.reads if "/data/c/" in k} == {
        "0/data/c/2/0/0/0",
    }


def test_shard_index_has_shard_time_entries_even_in_a_partial_last_shard(tmp_path):
    truth = make_truth(7, 1, 13, 11)
    _encode(tmp_path, truth, shard=True, shard_time=3)
    counting = CountingStore(LocalStore(tmp_path / "s", read_only=True))
    store = chronozarr.open_store(counting)
    counting.reads.clear()
    store.read_cell(6, 0, 0)  # the last shard holds one timestep
    suffixes = [r for _, r in counting.reads if isinstance(r, SuffixByteRequest)]
    assert suffixes
    assert all(r.suffix == 16 * 3 + 4 for r in suffixes)


def test_default_writes_plain_chunk_keys(tmp_path):
    truth = make_truth(3, 2, 13, 11)
    store = _encode(tmp_path, truth)  # shard is not passed: the default
    data = zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"]
    assert data.shards is None
    assert store.levels[0].shard_time is None
    assert store.attrs.shard_bytes is None
    base = tmp_path / "s" / "0" / "data" / "c"
    keys = {"/".join(p.relative_to(base).parts) for p in base.rglob("*") if p.is_file()}
    # c/<time>/<band chunk>/<row>/<col>: one object per timestep and cell, the bands in one chunk
    assert keys == {f"{t}/0/{r}/{c}" for t in range(3) for r in range(2) for c in range(2)}
    assert np.array_equal(store.to_xarray().values, truth)
    assert chronozarr.validate(tmp_path / "s") == []


def test_shard_true_writes_one_object_per_time_shard_and_cell(tmp_path):
    store = _encode(tmp_path, make_truth(3, 2, 13, 11), shard=True)
    base = tmp_path / "s" / "0" / "data" / "c"
    keys = {"/".join(p.relative_to(base).parts) for p in base.rglob("*") if p.is_file()}
    assert keys == {f"0/0/{r}/{c}" for r in range(2) for c in range(2)}  # all 3 timesteps in 1
    assert store.levels[0].shard_time == 3
    assert store.attrs.shard_bytes is not None


def test_shard_time_defaults_to_all_timesteps(tmp_path):
    store = _encode(tmp_path, make_truth(5, 1, 13, 11), shard=True)
    assert store.levels[0].shard_time == 5


@pytest.mark.parametrize("shard_time", [0, -1])
def test_shard_time_must_be_positive(tmp_path, shard_time):
    with pytest.raises(ValueError, match="shard_time must be at least 1"):
        chronozarr.encode(
            make_da(make_truth(5, 1, 8, 8)), tmp_path / "s", chunk_size=CS, shard_time=shard_time
        )


def test_shard_time_needs_shard(tmp_path):
    with pytest.raises(
        ValueError, match=r"shard_time=3 applies to sharded stores; pass shard=True"
    ):
        chronozarr.encode(
            make_da(make_truth(5, 1, 8, 8)), tmp_path / "s", chunk_size=CS, shard_time=3
        )
    assert not (tmp_path / "s").exists()


def test_shard_time_may_exceed_the_timesteps_written(tmp_path):
    store = _encode(tmp_path, make_truth(3, 1, 13, 11), shard=True, shard_time=8)
    assert store.levels[0].shard_time == 8
    assert store.levels[0].data.shape[0] == 3
    assert chronozarr.validate(tmp_path / "s") == []


def test_shard_bytes_match_the_shard_objects(tmp_path):
    _encode(
        tmp_path,
        make_truth(5, 2, 13, 11),
        shard=True,
        shard_time=2,
        mask=np.ones((5, 13, 11), np.uint8),
    )
    block = zarr.open_group(str(tmp_path / "s"), mode="r").attrs["chronozarr"]
    sizes = block["shard_bytes"]
    assert set(sizes) == {"0", "1"}
    assert {k.split("/")[0] for k in sizes["0"]} == {"0", "1", "2"}
    for level, shards in sizes.items():
        for key, size in shards.items():
            t, r, c = key.split("/")
            path = tmp_path / "s" / level / "data" / "c" / t / "0" / r / c
            assert path.stat().st_size == size
    assert len(sizes["0"]) == 3 * 4
    assert len(sizes["1"]) == 3 * 1
    assert chronozarr.validate(tmp_path / "s") == []
    assert chronozarr.open_store(tmp_path / "s").attrs.shard_bytes == sizes


def test_shard_bytes_absent_when_unsharded(tmp_path):
    store = _encode(tmp_path, make_truth(3, 1, 13, 11))
    assert store.attrs.shard_bytes is None
    assert "shard_bytes" not in zarr.open_group(str(tmp_path / "s"), mode="r").attrs["chronozarr"]
    assert chronozarr.validate(tmp_path / "s") == []


def test_validator_flags_wrong_and_missing_shard_bytes(tmp_path):
    _encode(tmp_path, make_truth(3, 1, 13, 11), shard=True)
    root = zarr.open_group(str(tmp_path / "s"), mode="r+", zarr_format=3)
    block = json.loads(json.dumps(dict(root.attrs["chronozarr"])))
    block["shard_bytes"]["0"]["0/0/0"] += 1
    block["shard_bytes"]["0"]["0/9/9"] = 100
    root.attrs["chronozarr"] = block
    problems = chronozarr.validate(tmp_path / "s")
    assert any("shard_bytes[0][0/0/0]" in p and "bytes listed" in p for p in problems)
    assert any("shard_bytes[0][0/9/9]" in p and "is missing" in p for p in problems)


# --- levels -----------------------------------------------------------------------------------


def test_levels_attr_mirrors_the_level_groups(tmp_path):
    truth = make_truth(3, 2, 13, 11)
    store = _encode(tmp_path, truth)
    summaries = store.attrs.levels
    assert summaries is not None
    assert [s.path for s in summaries] == ["0", "1"]
    for summary, level in zip(summaries, store.levels, strict=True):
        assert summary.shape == level.shape
        assert summary.grid == level.grid
        assert summary.transform == level.transform
        assert summary.resolution == level.resolution
    assert summaries[0].shape == (3, 2, 13, 11)
    assert summaries[0].grid == (2, 2)
    assert summaries[1].shape == (3, 2, 7, 6)


def test_validator_flags_a_levels_attr_that_disagrees(tmp_path):
    _encode(tmp_path, make_truth(3, 1, 13, 11))
    root = zarr.open_group(str(tmp_path / "s"), mode="r+", zarr_format=3)
    block = json.loads(json.dumps(dict(root.attrs["chronozarr"])))
    block["levels"][0]["shape"] = [3, 1, 99, 11]
    block["levels"][1]["resolution"] = 7.0
    root.attrs["chronozarr"] = block
    problems = chronozarr.validate(tmp_path / "s")
    assert any("chronozarr.levels[0]: shape" in p for p in problems)
    assert any("chronozarr.levels[1]: resolution" in p for p in problems)


# --- codecs -----------------------------------------------------------------------------------


def _inner_codecs(path) -> list[dict]:
    """The codec chain applied to each chunk: the inner codecs of a shard, or the array's own."""
    codecs = json.loads((path / "0" / "data" / "zarr.json").read_text())["codecs"]
    if len(codecs) == 1 and codecs[0]["name"] == "sharding_indexed":
        return codecs[0]["configuration"]["codecs"]
    return codecs


@pytest.mark.parametrize("shard", [False, True])
def test_default_codec_is_zstd_level_5(tmp_path, shard):
    _encode(tmp_path, make_truth(2, 1, 13, 11), shard=shard)
    assert _inner_codecs(tmp_path / "s")[1] == {
        "name": "zstd",
        "configuration": {"level": 5, "checksum": False},
    }


@pytest.mark.parametrize("shard", [False, True])
@pytest.mark.parametrize(("level", "expected"), [(None, 1), (3, 3)])
def test_blosc_zstd_shuffle_codec(tmp_path, level, expected, shard):
    truth = make_truth(3, 2, 13, 11)
    chronozarr.encode(
        make_da(truth),
        tmp_path / "s",
        chunk_size=CS,
        codec="blosc-zstd-shuffle",
        level=level,
        shard=shard,
    )
    codecs = _inner_codecs(tmp_path / "s")
    assert codecs[0]["name"] == "bytes"
    assert codecs[1]["name"] == "blosc"
    assert codecs[1]["configuration"]["cname"] == "zstd"
    assert codecs[1]["configuration"]["clevel"] == expected
    assert codecs[1]["configuration"]["shuffle"] == "shuffle"
    assert codecs[1]["configuration"]["typesize"] == 2
    store = chronozarr.open_store(tmp_path / "s")
    assert np.array_equal(store.to_xarray().values, truth)
    assert chronozarr.validate(tmp_path / "s") == []


def test_zstd_level_changes_the_bytes_not_the_values(tmp_path):
    truth = make_truth(3, 2, 40, 50)
    sizes = {}
    for level in (1, 19):
        out = tmp_path / f"l{level}"
        report = chronozarr.encode(make_da(truth), out, chunk_size=16, level=level, n_lods=1)
        sizes[level] = report.total_bytes
        assert report.level == level
        assert np.array_equal(chronozarr.open_store(out).to_xarray().values, truth)
    assert sizes[19] < sizes[1]


@pytest.mark.parametrize(
    ("codec", "level", "message"),
    [
        ("lz4", None, "codec must be one of"),
        ("zstd", 0, "level for zstd must be an int in 1..22"),
        ("zstd", 23, "level for zstd must be an int in 1..22"),
        ("blosc-zstd-shuffle", 10, "level for blosc-zstd-shuffle must be an int in 0..9"),
    ],
)
def test_bad_codec_or_level_is_rejected(tmp_path, codec, level, message):
    with pytest.raises(ValueError, match=message):
        chronozarr.encode(
            make_da(make_truth(2, 1, 8, 8)),
            tmp_path / "s",
            chunk_size=CS,
            codec=codec,
            level=level,
        )
    assert not (tmp_path / "s").exists()


# --- GDAL _CRS --------------------------------------------------------------------------------

EPSG_URL = "http://www.opengis.net/def/crs/EPSG/0/32631"


def _fake_pyproj(monkeypatch, *, known: bool = True):
    """Install a stand-in pyproj so the WKT branch runs without the real package."""
    import sys
    import types

    class CRSError(Exception):
        pass

    class CRS:
        def __init__(self, code: int) -> None:
            self.code = code

        @classmethod
        def from_epsg(cls, code: int) -> CRS:
            if not known:
                raise CRSError(code)
            return cls(code)

        def to_wkt(self) -> str:
            return f'PROJCRS["fake EPSG:{self.code}"]'

    pyproj = types.ModuleType("pyproj")
    pyproj.CRS = CRS  # ty: ignore[unresolved-attribute]
    exceptions = types.ModuleType("pyproj.exceptions")
    exceptions.CRSError = CRSError  # ty: ignore[unresolved-attribute]
    monkeypatch.setitem(sys.modules, "pyproj", pyproj)
    monkeypatch.setitem(sys.modules, "pyproj.exceptions", exceptions)


def _no_pyproj(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "pyproj", None)  # makes `from pyproj import ...` fail


def test_every_array_carries_the_gdal_crs_url(tmp_path, monkeypatch):
    _no_pyproj(monkeypatch)
    truth = make_truth(3, 1, 13, 11)
    mask = (truth[:, 0] > 0).astype(np.uint8)
    _encode(tmp_path, truth, mask=mask, coverage=mask)
    root = zarr.open_group(str(tmp_path / "s"), mode="r")
    for level in ("0", "1"):
        for name in ("data", "mask", "coverage"):
            attrs = root[level][name].attrs.asdict()
            assert attrs["_CRS"] == {"url": EPSG_URL}, f"{level}/{name}"
            assert attrs["proj:code"] == "EPSG:32631"  # the other CRS attributes are unchanged
            assert attrs["crs"] == "EPSG:32631"
    assert chronozarr.validate(tmp_path / "s") == []


def test_gdal_crs_adds_wkt_when_pyproj_is_available(tmp_path, monkeypatch):
    _fake_pyproj(monkeypatch)
    _encode(tmp_path, make_truth(2, 1, 13, 11))
    crs = zarr.open_group(str(tmp_path / "s"), mode="r")["1"]["data"].attrs["_CRS"]
    assert crs == {"url": EPSG_URL, "wkt": 'PROJCRS["fake EPSG:32631"]'}
    assert chronozarr.validate(tmp_path / "s") == []


def test_gdal_crs_is_url_only_for_an_epsg_code_pyproj_does_not_know(tmp_path, monkeypatch):
    _fake_pyproj(monkeypatch, known=False)
    _encode(tmp_path, make_truth(2, 1, 13, 11))
    crs = zarr.open_group(str(tmp_path / "s"), mode="r")["0"]["data"].attrs["_CRS"]
    assert crs == {"url": EPSG_URL}


def test_validator_flags_a_gdal_crs_that_names_another_crs(tmp_path, monkeypatch):
    _no_pyproj(monkeypatch)
    _encode(tmp_path, make_truth(2, 1, 13, 11))
    root = zarr.open_group(str(tmp_path / "s"), mode="r+", zarr_format=3)
    root["0"]["data"].attrs["_CRS"] = {"url": "http://www.opengis.net/def/crs/EPSG/0/4326"}
    problems = chronozarr.validate(tmp_path / "s")
    assert any("level 0/data: attribute _CRS url must be" in p for p in problems)


def test_gdal_crs_changes_metadata_only_never_data_bytes(tmp_path, monkeypatch):
    _no_pyproj(monkeypatch)
    truth = make_truth(4, 2, 29, 21)
    mask = (truth[:, 0] > 0).astype(np.uint8)
    (tmp_path / "with").mkdir()
    _encode(tmp_path / "with", truth, mask=mask)
    (tmp_path / "without").mkdir()
    monkeypatch.setattr(schema, "crs_attr", lambda crs: None)
    _encode(tmp_path / "without", truth, mask=mask)

    def tree(path):
        return {
            str(p.relative_to(path)): p.read_bytes()
            for p in sorted(path.rglob("*"))
            if p.is_file()
        }

    with_crs, without_crs = tree(tmp_path / "with" / "s"), tree(tmp_path / "without" / "s")
    assert with_crs.keys() == without_crs.keys()
    chunk_files = [k for k in with_crs if "/c/" in k]
    assert chunk_files
    assert all(with_crs[k] == without_crs[k] for k in chunk_files)
    json_files = [k for k in with_crs if k.endswith("zarr.json")]
    assert any(with_crs[k] != without_crs[k] for k in json_files)
