"""Command line: encode from Zarr and GeoTIFF inputs, validate, info."""

from __future__ import annotations

import numpy as np
import pytest
from click.testing import CliRunner

import chronozarr
from chronozarr import schema
from chronozarr.cli import main
from tests.synthetic import make_da, make_truth

pytestmark = pytest.mark.unit


def _run(*args: str):
    return CliRunner().invoke(main, list(args), catch_exceptions=False)


@pytest.fixture
def zarr_input(tmp_path):
    truth = make_truth(4, 2, 40, 50)
    path = tmp_path / "input.zarr"
    make_da(truth).to_dataset(name="reflectance").to_zarr(path, zarr_format=2, consolidated=False)
    return path, truth


def test_encode_validate_info_from_zarr(tmp_path, zarr_input):
    source, truth = zarr_input
    out = tmp_path / "out"
    result = _run(
        "encode",
        str(source),
        str(out),
        "--chunk-size",
        "16",
    )
    assert result.exit_code == 0, result.output
    assert "wrote" in result.output
    assert np.array_equal(chronozarr.open_store(out).to_xarray().values, truth)

    ok = _run("validate", str(out))
    assert ok.exit_code == 0
    assert f"conforms to chronozarr {schema.SPEC_VERSION}" in ok.output

    info = _run("info", str(out))
    assert info.exit_code == 0
    for expected in (
        f"chronozarr {schema.SPEC_VERSION}",
        "EPSG:32631",
        "times:     4",
        "grid 3x4",
    ):
        assert expected in info.output


def test_encode_is_unsharded_unless_shard_is_given(tmp_path, zarr_input):
    source, _ = zarr_input
    default, sharded = tmp_path / "default", tmp_path / "sharded"
    assert _run("encode", str(source), str(default), "--chunk-size", "16").exit_code == 0
    assert (
        _run("encode", str(source), str(sharded), "--chunk-size", "16", "--shard").exit_code == 0
    )
    assert chronozarr.open_store(default).levels[0].data.shards is None
    assert chronozarr.open_store(sharded).levels[0].data.shards is not None


def test_shard_time_without_shard_is_a_click_error(tmp_path, zarr_input):
    source, _ = zarr_input
    result = CliRunner().invoke(
        main, ["encode", str(source), str(tmp_path / "out"), "--shard-time", "2"]
    )
    assert result.exit_code == 2
    assert "--shard-time needs --shard" in result.output
    assert not (tmp_path / "out").exists()


def test_no_shard_and_lods_options(tmp_path, zarr_input):
    source, _ = zarr_input
    out = tmp_path / "out"
    result = _run(
        "encode", str(source), str(out), "--chunk-size", "16", "--no-shard", "--lods", "2"
    )
    assert result.exit_code == 0, result.output
    store = chronozarr.open_store(out)
    assert len(store.levels) == 2
    assert store.levels[0].data.shards is None


def test_encode_reports_errors_as_click_errors(tmp_path, zarr_input):
    source, _ = zarr_input
    (tmp_path / "taken").mkdir()
    (tmp_path / "taken" / "file").write_text("x")
    result = CliRunner().invoke(main, ["encode", str(source), str(tmp_path / "taken")])
    assert result.exit_code == 1
    assert "not empty" in result.output

    missing = CliRunner().invoke(
        main, ["encode", str(tmp_path / "nope.zarr"), str(tmp_path / "o")]
    )
    assert missing.exit_code == 1
    assert "does not exist" in missing.output


def test_validate_fails_with_problem_list(tmp_path):
    (tmp_path / "empty").mkdir()
    result = CliRunner().invoke(main, ["validate", str(tmp_path / "empty")])
    assert result.exit_code == 1
    assert "no Zarr v3 group found" in result.output


def test_encode_from_geotiff_glob(tmp_path):
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import Affine

    truth = make_truth(3, 2, 20, 30)
    tif_dir = tmp_path / "tifs"
    tif_dir.mkdir()
    transform = Affine(10.0, 0.0, 746090.0, 0.0, -10.0, 2540440.0)
    for t, name in enumerate(["S2_20240315", "S2_20240115", "S2_20240215"]):
        with rasterio.open(
            tif_dir / f"{name}.tif",
            "w",
            driver="GTiff",
            height=20,
            width=30,
            count=2,
            dtype="uint16",
            crs="EPSG:32631",
            transform=transform,
        ) as dst:
            dst.write(truth[t])
    out = tmp_path / "out"
    result = _run("encode", str(tif_dir / "*.tif"), str(out), "--chunk-size", "16")
    assert result.exit_code == 0, result.output

    store = chronozarr.open_store(out)
    assert store.attrs.times == (
        "2024-01-15T00:00:00Z",
        "2024-02-15T00:00:00Z",
        "2024-03-15T00:00:00Z",
    )
    assert store.attrs.crs == "EPSG:32631"
    assert store.levels[0].transform == (10.0, 0.0, 746090.0, 0.0, -10.0, 2540440.0)
    expected = truth[[1, 2, 0]]  # file order was 03-15, 01-15, 02-15; store is time-sorted
    assert np.array_equal(store.to_xarray().values, expected)
    assert store.bands == ("1", "2")


def test_geotiff_without_date_in_name_fails(tmp_path):
    pytest.importorskip("rasterio")
    (tmp_path / "scene.tif").write_bytes(b"")
    result = CliRunner().invoke(main, ["encode", str(tmp_path / "*.tif"), str(tmp_path / "o")])
    assert result.exit_code == 1
    assert "cannot find a date" in result.output


def test_doctor_passes_on_a_local_store(tmp_path, zarr_input):
    source, _ = zarr_input
    out = tmp_path / "out"
    assert _run("encode", str(source), str(out), "--chunk-size", "16").exit_code == 0
    result = _run("doctor", str(out))
    assert result.exit_code == 0, result.output
    assert "[ ok ] validate" in result.output
    assert "[ ok ] decode level 0" in result.output
    assert "0 failure(s)" in result.output


def test_doctor_exits_nonzero_with_a_fix_line(tmp_path):
    result = CliRunner().invoke(main, ["doctor", str(tmp_path / "missing")])
    assert result.exit_code == 1
    assert "[FAIL] store path" in result.output
    assert "fix: Pass the store directory" in result.output
    assert "1 failure(s)" in result.output


def test_export_cog_selects_levels_and_times(tmp_path, zarr_input):
    rasterio = pytest.importorskip("rasterio")
    source, truth = zarr_input
    store_dir = tmp_path / "store"
    assert _run("encode", str(source), str(store_dir), "--chunk-size", "16").exit_code == 0
    out = tmp_path / "cogs"
    result = _run("export-cog", str(store_dir), str(out), "--times", "1:3", "--times", "-1")
    assert result.exit_code == 0, result.output
    assert "wrote 3 COG(s)" in result.output
    assert sorted(p.name for p in out.iterdir()) == [
        "L0_2024-02-01.tif",
        "L0_2024-03-01.tif",
        "L0_2024-04-01.tif",
    ]
    with rasterio.open(out / "L0_2024-03-01.tif") as src:
        assert np.array_equal(src.read(), truth[2])

    coarse = _run("export-cog", str(store_dir), str(tmp_path / "coarse"), "--level", "1")
    assert coarse.exit_code == 0, coarse.output
    assert "wrote 4 COG(s)" in coarse.output


def test_export_cog_reports_bad_input_as_click_errors(tmp_path, zarr_input):
    pytest.importorskip("rasterio")
    source, _ = zarr_input
    store_dir = tmp_path / "store"
    assert _run("encode", str(source), str(store_dir), "--chunk-size", "16").exit_code == 0
    bad_time = CliRunner().invoke(
        main, ["export-cog", str(store_dir), str(tmp_path / "o"), "--times", "2030-01"]
    )
    assert bad_time.exit_code == 1
    assert "no timestep matches" in bad_time.output
    bad_level = CliRunner().invoke(
        main, ["export-cog", str(store_dir), str(tmp_path / "o"), "--level", "9"]
    )
    assert bad_level.exit_code == 1
    assert "level 9 out of range" in bad_level.output


def test_stac_writes_collection_and_item(tmp_path, zarr_input):
    pytest.importorskip("rasterio")
    source, _ = zarr_input
    store_dir = tmp_path / "aoi" / "chronozarr"
    store_dir.parent.mkdir()
    assert _run("encode", str(source), str(store_dir), "--chunk-size", "16").exit_code == 0
    out = tmp_path / "catalog"
    result = _run(
        "stac", str(store_dir), "--out", str(out), "--license", "CC-BY-4.0", "--title", "AOI"
    )
    assert result.exit_code == 0, result.output
    assert f"wrote {out / 'collection.json'}" in result.output
    assert (out / "aoi-chronozarr" / "aoi-chronozarr.json").is_file()

    missing = CliRunner().invoke(main, ["stac", str(tmp_path / "nope"), "--out", str(out)])
    assert missing.exit_code == 1
    assert "no Zarr v3 group found" in missing.output


def _write_manifest(tmp_path, truth):
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import Affine

    folder = tmp_path / "cogs"
    folder.mkdir()
    lines = ["uri,datetime,bands"]
    for t in range(truth.shape[0]):
        path = folder / f"scene_{t}.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            height=truth.shape[2],
            width=truth.shape[3],
            count=truth.shape[1],
            dtype="uint16",
            crs="EPSG:32631",
            transform=Affine(10.0, 0.0, 746090.0, 0.0, -10.0, 2540440.0),
            nodata=0,
        ) as dst:
            dst.write(truth[t])
        lines.append(f"{path},2024-0{t + 1}-01,red;nir")
    manifest = tmp_path / "manifest.csv"
    manifest.write_text("\n".join(lines) + "\n")
    return manifest


def test_convert_manifest_end_to_end(tmp_path):
    truth = make_truth(4, 2, 40, 50)
    manifest = _write_manifest(tmp_path, truth)
    out = tmp_path / "store"
    result = _run("convert", str(manifest), str(out), "--chunk-size", "16")
    assert result.exit_code == 0, result.output
    for expected in (
        "source:     manifest of COGs, 4 timesteps (2024-01-01 .. 2024-04-01)",
        "resampling: none needed",
        "output:     about",
        "wrote ",
        "read 4 timesteps (0 reused)",
    ):
        assert expected in result.output
    store = chronozarr.open_store(out)
    assert store.bands == ("red", "nir")
    assert np.array_equal(store.to_xarray().values, truth)
    assert not (tmp_path / "store.convert-work").exists()


def test_convert_dry_run_writes_nothing(tmp_path):
    manifest = _write_manifest(tmp_path, make_truth(3, 2, 40, 50))
    out = tmp_path / "store"
    result = _run("convert", str(manifest), str(out), "--dry-run", "--chunk-size", "16")
    assert result.exit_code == 0, result.output
    assert "raw size:" in result.output
    assert "dry run: nothing was written" in result.output
    assert not out.exists()


def test_convert_reports_errors_as_click_errors(tmp_path):
    truth = make_truth(3, 2, 40, 50)
    manifest = _write_manifest(tmp_path, truth)
    missing = CliRunner().invoke(
        main, ["convert", str(tmp_path / "nope.csv"), str(tmp_path / "o")]
    )
    assert missing.exit_code == 1
    assert "does not exist" in missing.output

    off_grid = CliRunner().invoke(
        main,
        ["convert", str(manifest), str(tmp_path / "o"), "--crs", "EPSG:32632", "--dry-run"],
    )
    assert off_grid.exit_code == 1
    assert "not on the target grid" in off_grid.output
    assert "--resampling" in off_grid.output

    bad_shape = CliRunner().invoke(
        main, ["convert", str(manifest), str(tmp_path / "o"), "--shape", "5"]
    )
    assert bad_shape.exit_code == 2
    assert "--shape needs 2 comma-separated numbers" in bad_shape.output


def test_convert_resampling_warps_to_a_new_crs(tmp_path):
    manifest = _write_manifest(tmp_path, make_truth(3, 2, 40, 50))
    out = tmp_path / "store"
    result = _run(
        "convert",
        str(manifest),
        str(out),
        "--crs",
        "EPSG:32632",
        "--resampling",
        "nearest",
        "--chunk-size",
        "16",
    )
    assert result.exit_code == 0, result.output
    assert "resampling: 3 of 3 timesteps are warped" in result.output
    assert chronozarr.open_store(out).attrs.crs == "EPSG:32632"
