"""`convert`: COG manifests, PNG frames, Zarr and NetCDF sources, resampling, resume, estimates."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import xarray as xr

import chronozarr
from chronozarr.convert import (
    CogManifestSource,
    _gdal_env,
    convert,
    plan_conversion,
    read_manifest,
)
from tests.fixtures import cog_sources as fx
from tests.fixtures import png_frames as pf
from tests.synthetic import CRS, TRANSFORM, make_times, make_truth

pytestmark = pytest.mark.unit

rasterio = pytest.importorskip("rasterio")
from rasterio.transform import Affine  # noqa: E402  (after importorskip)

N_TIME, N_BAND, HEIGHT, WIDTH = 5, 2, 40, 50
OPTIONS: dict[str, Any] = {"chunk_size": 16}
DATES = ["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01", "2024-05-01"]


def write_tif(
    path: Path,
    array: np.ndarray,
    *,
    transform=TRANSFORM,
    crs: str | None = CRS,
    nodata: float | None = 0,
    descriptions: list[str] | None = None,
    scales: list[float] | None = None,
    offsets: list[float] | None = None,
    units: list[str] | None = None,
) -> Path:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=array.shape[1],
        width=array.shape[2],
        count=array.shape[0],
        dtype=array.dtype,
        crs=crs,
        transform=Affine(*transform),
        nodata=nodata,
    ) as dst:
        dst.write(array)
        if descriptions:
            dst.descriptions = descriptions
        if scales:
            dst.scales = scales
        if offsets:
            dst.offsets = offsets
        if units:
            dst.units = units
    return path


@pytest.fixture
def truth() -> np.ndarray:
    return make_truth(N_TIME, N_BAND, HEIGHT, WIDTH)


@pytest.fixture
def tifs(tmp_path, truth) -> list[Path]:
    folder = tmp_path / "cogs"
    folder.mkdir()
    return [write_tif(folder / f"scene_{t}.tif", truth[t]) for t in range(N_TIME)]


def write_csv(path: Path, tifs: list[Path], dates=DATES, bands: str | None = None) -> Path:
    header = "uri,datetime" + (",bands" if bands else "")
    rows = [
        f"{tif},{date}" + (f",{bands}" if bands else "")
        for tif, date in zip(tifs, dates, strict=True)
    ]
    path.write_text("\n".join([header, *rows[::-1]]) + "\n")  # reversed: the manifest is unsorted
    return path


def stored(store_path: Path) -> np.ndarray:
    return chronozarr.open_store(store_path).to_xarray().values


# --- manifest parsing -----------------------------------------------------------------------


def test_read_manifest_sorts_resolves_relative_uris_and_converts_offsets(tmp_path):
    manifest = tmp_path / "m.csv"
    manifest.write_text(
        "uri,datetime,bands\n"
        "b.tif,2024-03-01T02:00:00+02:00,red;nir\n"
        "a.tif,2024-01-15,red;nir\n"
        "https://example.org/c.tif,2024-02-01T00:00:00Z,\n"
    )
    parsed = read_manifest(manifest)
    entries, bands = parsed.entries, parsed.bands
    assert parsed.bounds is None
    assert [str(e.time) for e in entries] == [
        "2024-01-15T00:00:00.000",
        "2024-02-01T00:00:00.000",
        "2024-03-01T00:00:00.000",
    ]
    assert entries[0].uri == str(tmp_path / "a.tif")
    assert entries[1].uri == "https://example.org/c.tif"
    assert bands == ("red", "nir")


def test_read_manifest_json_forms(tmp_path):
    items = [
        {"uri": "a.tif", "datetime": "2024-01-01"},
        {"uri": "b.tif", "datetime": "2024-02-01"},
    ]
    as_list = tmp_path / "list.json"
    as_list.write_text(json.dumps(items))
    as_object = tmp_path / "object.json"
    as_object.write_text(json.dumps({"bands": ["r", "g"], "items": items}))
    with_bounds = tmp_path / "bounds.json"
    with_bounds.write_text(json.dumps({"bounds": [1, 2.5, 3, 4], "items": items}))
    assert read_manifest(as_list).bands is None
    assert read_manifest(as_list).bounds is None
    assert read_manifest(as_object).bands == ("r", "g")
    assert read_manifest(with_bounds).bounds == (1.0, 2.5, 3.0, 4.0)


@pytest.mark.parametrize(
    ("content", "suffix", "message"),
    [
        ("uri,when\na.tif,2024-01-01\n", ".csv", "missing \\['datetime'\\]"),
        ("uri,datetime\na.tif,yesterday\n", ".csv", "cannot parse datetime 'yesterday'"),
        ("uri,datetime\na.tif,2024-01-01\nb.tif,2024-01-01\n", ".csv", "share the datetime"),
        ("uri,datetime,bands\na,2024-01-01,r;g\nb,2024-02-01,r;n\n", ".csv", "differ from"),
        ("uri,datetime\n", ".csv", "no rows"),
        ('[{"uri": "a.tif"}]', ".json", "needs both 'uri' and 'datetime'"),
        (
            '{"bounds": [1, 2, 3], "items": [{"uri": "a", "datetime": "2024-01-01"}]}',
            ".json",
            "four",
        ),
        (
            '{"bounds": [5, 2, 3, 4], "items": [{"uri": "a", "datetime": "2024-01-01"}]}',
            ".json",
            "west < east",
        ),
        (
            '{"bounds": [1, 2, "x", 4], "items": [{"uri": "a", "datetime": "2024-01-01"}]}',
            ".json",
            "four numbers",
        ),
        ("x", ".txt", "must be .csv or .json"),
    ],
)
def test_read_manifest_rejects_bad_manifests(tmp_path, content, suffix, message):
    path = tmp_path / f"m{suffix}"
    path.write_text(content)
    with pytest.raises(ValueError, match=message):
        read_manifest(path)


# --- COG manifests --------------------------------------------------------------------------


def test_manifest_roundtrip_is_bit_exact(tmp_path, tifs, truth):
    manifest = write_csv(tmp_path / "m.csv", tifs, bands="B04;B08")
    out = tmp_path / "store"
    report = convert(manifest, out, **OPTIONS)

    assert np.array_equal(stored(out), truth)
    store = chronozarr.open_store(out)
    assert store.bands == ("B04", "B08")
    assert store.attrs.times[0] == "2024-01-01T00:00:00Z"
    assert store.attrs.crs == CRS
    assert store.levels[0].transform == TRANSFORM
    assert store.attrs.nodata == 0
    assert chronozarr.validate(out) == []
    assert (report.n_staged, report.n_reused) == (N_TIME, 0)
    assert report.encode is not None
    assert report.encode is not None
    assert report.total_s == report.read_s + report.encode_s
    assert not (tmp_path / "store.convert-work").exists()  # removed on success


def test_band_names_fall_back_to_descriptions_then_indexes(tmp_path, truth):
    described = tmp_path / "described"
    described.mkdir()
    files = [
        write_tif(described / f"{t}.tif", truth[t], descriptions=["red", "nir"]) for t in range(3)
    ]
    out = tmp_path / "a"
    convert(write_csv(tmp_path / "a.csv", files, DATES[:3]), out, **OPTIONS)
    assert chronozarr.open_store(out).bands == ("red", "nir")

    plain = tmp_path / "plain"
    plain.mkdir()
    files = [write_tif(plain / f"{t}.tif", truth[t]) for t in range(3)]
    out = tmp_path / "b"
    convert(write_csv(tmp_path / "b.csv", files, DATES[:3]), out, **OPTIONS)
    assert chronozarr.open_store(out).bands == ("1", "2")


def test_int16_sources_keep_dtype_and_their_own_nodata(tmp_path):
    rng = np.random.default_rng(3)
    data = rng.integers(-2000, 2000, size=(3, 1, 24, 30)).astype(np.int16)
    data[:, :, :4, :4] = -9999
    folder = tmp_path / "i16"
    folder.mkdir()
    files = [write_tif(folder / f"{t}.tif", data[t], nodata=-9999) for t in range(3)]
    out = tmp_path / "store"
    convert(write_csv(tmp_path / "m.csv", files, DATES[:3]), out, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.attrs.nodata == -9999
    assert store.attrs.spec_version == "0.3.0"
    assert np.array_equal(store.to_xarray().values, data)
    assert store.levels[0].data.dtype == np.int16


def test_source_nodata_can_be_overridden_or_removed(tmp_path, tifs):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    out = tmp_path / "none"
    convert(manifest, out, nodata=None, **OPTIONS)
    assert chronozarr.open_store(out).attrs.nodata is None
    out = tmp_path / "seven"
    convert(manifest, out, nodata=7, **OPTIONS)
    assert chronozarr.open_store(out).attrs.nodata == 7


def test_grid_mismatch_needs_explicit_resampling_and_then_warps(tmp_path, tifs, truth):
    shifted = list(TRANSFORM)
    shifted[2] += 5 * 10.0  # five pixels east: same size, different extent
    write_tif(tifs[2], truth[2], transform=tuple(shifted))
    manifest = write_csv(tmp_path / "m.csv", tifs)

    with pytest.raises(ValueError, match=r"1 of 5 sources are not on the target grid") as error:
        convert(manifest, tmp_path / "refused", **OPTIONS)
    assert tifs[2].name in str(error.value)
    assert "--resampling" in str(error.value)
    assert "transform" in str(error.value)
    assert not (tmp_path / "refused").exists()

    out = tmp_path / "warped"
    report = convert(manifest, out, resampling="nearest", **OPTIONS)
    assert report.plan.warped == 1
    result = stored(out)
    for t in (0, 1, 3, 4):
        assert np.array_equal(result[t], truth[t])
    # source column j of the shifted scene lands at target column j + 5; the rest is nodata
    assert np.array_equal(result[2][:, :, 5:], truth[2][:, :, :-5])
    assert not result[2][:, :, :5].any()


def test_crs_override_warps_every_timestep_into_the_new_crs(tmp_path, tifs):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    out = tmp_path / "store"
    report = convert(manifest, out, crs="EPSG:32632", resampling="bilinear", **OPTIONS)
    assert report.plan.warped == N_TIME
    store = chronozarr.open_store(out)
    assert store.attrs.crs == "EPSG:32632"
    assert store.read(0).any()
    grid = report.plan.source.info.grid
    assert (grid.height, grid.width) == store.levels[0].shape[2:]
    assert chronozarr.validate(out) == []


def test_explicit_transform_and_shape_crop_the_grid(tmp_path, tifs, truth):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    left = TRANSFORM[2] + 4 * 10.0
    top = TRANSFORM[5] - 3 * 10.0
    out = tmp_path / "store"
    convert(
        manifest,
        out,
        crs=CRS,
        transform=(10.0, 0.0, left, 0.0, -10.0, top),
        shape=(20, 30),
        resampling="nearest",
        **OPTIONS,
    )
    assert np.array_equal(stored(out), truth[:, :, 3:23, 4:34])


def test_grid_override_options_are_validated(tmp_path, tifs):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    with pytest.raises(ValueError, match="needs --shape and --crs"):
        plan_conversion(manifest, transform=TRANSFORM, sample=False)
    with pytest.raises(ValueError, match="only meaningful together with --transform"):
        plan_conversion(manifest, shape=(10, 10), sample=False)
    with pytest.raises(ValueError, match="unknown resampling"):
        plan_conversion(manifest, crs="EPSG:32632", resampling="magic", sample=False)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        ("dtype", "All sources must share one dtype"),
        ("bands", "has 1 bands"),
        ("scales", r"has scales \[0.5, 1.0\]; .* has \[1.0, 1.0\]"),
        ("offsets", r"has offsets \[0.0, 2.0\]; .* has \[0.0, 0.0\]"),
        ("units", r"has units \['K', None\]; .* has \[None, None\]"),
        ("int32", "chronozarr stores hold"),
        ("nocrs", "cannot open source"),
    ],
)
def test_inconsistent_or_unsupported_sources_are_rejected_up_front(
    tmp_path, tifs, truth, mutate, message
):
    bad = tifs[3]
    if mutate == "dtype":
        write_tif(bad, truth[3].astype(np.uint8))
    elif mutate == "bands":
        write_tif(bad, truth[3][:1])
    elif mutate == "scales":
        write_tif(bad, truth[3], scales=[0.5, 1.0])
    elif mutate == "offsets":
        write_tif(bad, truth[3], offsets=[0.0, 2.0])
    elif mutate == "units":
        write_tif(bad, truth[3], units=["K", ""])
    elif mutate == "int32":
        tifs = [write_tif(t, truth[i].astype(np.int32)) for i, t in enumerate(tifs)]
    else:
        write_tif(bad, truth[3], crs=None)
    with pytest.raises(ValueError, match=message):
        plan_conversion(write_csv(tmp_path / "m.csv", tifs), sample=False)


def test_missing_source_file_is_named(tmp_path, tifs):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    tifs[1].rename(tmp_path / "moved.tif")
    with pytest.raises(ValueError, match=f"cannot open source .*{tifs[1].name}"):
        plan_conversion(manifest, sample=False)


# --- PNG frames -----------------------------------------------------------------------------


def convert_frames(tmp_path, frames, *, bands=None, name="store", **kwargs):
    out = tmp_path / name
    manifest = pf.write_manifest(tmp_path / f"{name}.csv", frames, bands)
    convert(manifest, out, **{**OPTIONS, **kwargs})
    return chronozarr.open_store(out)


def assert_frames_stored(store, frames: pf.FrameSet) -> None:
    """The bands are the frames' colours, the mask is alpha, the grid is the fixture's."""
    assert store.bands == ("red", "green", "blue")
    assert [b.common_name for b in store.attrs.bands] == ["red", "green", "blue"]
    assert store.dtype == np.uint8
    assert band_attrs(store) == [(1.0, 0.0, None)] * 3
    assert store.attrs.nodata is None
    assert store.attrs.mask_variable == "mask"
    assert store.attrs.crs == CRS
    assert store.levels[0].transform == TRANSFORM
    assert np.array_equal(stored_mask(store), frames.alpha)
    for t in range(pf.N_TIME):
        assert np.array_equal(store.read(t), frames.rgb[t])  # values under alpha 0 are kept
    assert store.read_mask(0)[2, 2] == 1  # alpha 128: partly transparent, still valid
    assert store.read_mask(0)[3, 4] == 0  # alpha 0 over the colour 200
    assert store.read_mask(0)[5, 6] == 1  # colour 0 with alpha 255 is a valid zero
    assert store.read(0)[0, 5, 6] == 0


def test_png_frames_with_world_files_and_crs_become_a_masked_rgb_store(tmp_path):
    frames = pf.rgba_frames(tmp_path, "pgw")
    store = convert_frames(tmp_path, frames, crs=CRS)
    assert_frames_stored(store, frames)
    assert chronozarr.validate(tmp_path / "store") == []


def test_a_world_file_has_no_crs_so_it_is_asked_for(tmp_path):
    manifest = pf.write_manifest(tmp_path / "m.csv", pf.rgba_frames(tmp_path, "pgw"))
    with pytest.raises(ValueError, match=r"geotransform but no CRS.*--crs EPSG:xxxxx") as error:
        plan_conversion(manifest, sample=False)
    assert "frame_0.png" in str(error.value)  # the first frame, named


def test_png_frames_with_aux_xml_carry_their_crs_and_transform(tmp_path):
    frames = pf.rgba_frames(tmp_path, "aux")
    store = convert_frames(tmp_path, frames)  # no --crs
    assert_frames_stored(store, frames)
    assert chronozarr.validate(tmp_path / "store") == []


def test_aux_xml_with_a_crs_only_still_needs_a_transform(tmp_path):
    frames = pf.rgba_frames(tmp_path, "pgw")
    for png in frames.paths:
        pf.write_aux_xml(png, transform=None)  # SRS from the .aux.xml, transform from the .pgw
    store = convert_frames(tmp_path, frames)
    assert_frames_stored(store, frames)


def test_a_world_file_wins_over_the_aux_xml_transform_which_supplies_only_the_crs(tmp_path):
    frames = pf.rgba_frames(tmp_path, "pgw")
    for png in frames.paths:
        pf.write_aux_xml(png, crs=CRS, transform=(20.0, 0.0, 1000.0, 0.0, -20.0, 2000.0))
    store = convert_frames(tmp_path, frames)  # no --crs: the .aux.xml has it
    assert_frames_stored(store, frames)  # the grid is the world file's, not the .aux.xml's


def test_a_wld_world_file_is_read_like_a_pgw(tmp_path):
    frames = pf.rgba_frames(tmp_path, "pgw")
    for png in frames.paths:
        png.with_suffix(".pgw").rename(png.with_suffix(".wld"))
    assert_frames_stored(convert_frames(tmp_path, frames, crs=CRS), frames)


def test_frames_without_a_sidecar_name_the_ways_to_locate_them(tmp_path):
    manifest = pf.write_manifest(tmp_path / "m.csv", pf.rgba_frames(tmp_path, "none"))
    with pytest.raises(
        ValueError, match=r"no georeferencing.*\.pgw.*\.aux\.xml.*--bounds"
    ) as error:
        plan_conversion(manifest, crs=CRS, sample=False)
    assert "frame_0.png" in str(error.value)


def test_bounds_give_frames_without_a_sidecar_their_grid(tmp_path):
    frames = pf.rgba_frames(tmp_path, "none")
    store = convert_frames(tmp_path, frames, crs=CRS, bounds=pf.bounds_of())
    assert_frames_stored(store, frames)
    assert chronozarr.validate(tmp_path / "store") == []


def test_bounds_can_sit_in_a_json_manifest_and_must_not_be_given_twice(tmp_path):
    frames = pf.rgba_frames(tmp_path, "none")
    items = [
        {"uri": str(png), "datetime": date}
        for png, date in zip(frames.paths, frames.dates(), strict=True)
    ]
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"bounds": list(pf.bounds_of()), "items": items}))
    out = tmp_path / "store"
    convert(manifest, out, crs=CRS, **OPTIONS)
    assert_frames_stored(chronozarr.open_store(out), frames)
    with pytest.raises(ValueError, match="give them once"):
        plan_conversion(manifest, crs=CRS, bounds=pf.bounds_of(), sample=False)
    with pytest.raises(ValueError, match="bounds need crs"):
        plan_conversion(manifest, sample=False)


def test_bounds_with_non_square_pixels_derive_each_axis_from_the_image_size(tmp_path):
    frames = pf.rgba_frames(tmp_path, "none")
    west, south, east, north = pf.bounds_of()
    plan = plan_conversion(
        pf.write_manifest(tmp_path / "m.csv", frames),
        crs=CRS,
        bounds=(west, south, east + pf.WIDTH * 5.0, north),
        sample=False,
    )
    grid = plan.source.info.grid
    assert grid.transform == (15.0, 0.0, west, 0.0, -10.0, north)
    assert (grid.height, grid.width) == (pf.HEIGHT, pf.WIDTH)


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("bad bounds", "west < east"),
        ("size", r"frame_2.png is 12 x 32 px; .*frame_0.png is 24 x 32 px.*same size"),
        ("own transform", "carries its own geotransform"),
        ("other crs", "declares EPSG:32632 but --crs is EPSG:32631"),
    ],
)
def test_bounds_refuse_what_they_cannot_locate(tmp_path, case, message):
    frames = pf.rgba_frames(tmp_path, "none")
    bounds = pf.bounds_of()
    if case == "bad bounds":
        bounds = (bounds[2], bounds[1], bounds[0], bounds[3])
    elif case == "size":
        pf.write_png(frames.paths[2], frames.pixels[2][:12])
    elif case == "own transform":
        pf.write_world_file(frames.paths[1])
    else:
        pf.write_aux_xml(frames.paths[0], crs="EPSG:32632", transform=None)
    manifest = pf.write_manifest(tmp_path / "m.csv", frames)
    with pytest.raises(ValueError, match=message):
        plan_conversion(manifest, crs=CRS, bounds=bounds, sample=False)


def test_png_frames_on_another_grid_are_warped_like_cogs(tmp_path):
    frames = pf.rgba_frames(tmp_path, "pgw")
    shifted = list(TRANSFORM)
    shifted[2] += 5 * 10.0  # five pixels east: same size, different extent
    pf.write_world_file(frames.paths[2], tuple(shifted))
    manifest = pf.write_manifest(tmp_path / "m.csv", frames)
    with pytest.raises(ValueError, match=r"1 of 4 sources are not on the target grid") as error:
        plan_conversion(manifest, crs=CRS, sample=False)
    assert "frame_2.png" in str(error.value)

    out = tmp_path / "store"
    report = convert(manifest, out, crs=CRS, resampling="nearest", **OPTIONS)
    store = chronozarr.open_store(out)
    assert report.plan.warped == 1
    for t in (0, 1, 3):
        assert np.array_equal(store.read(t), frames.rgb[t])
    # source column j of the shifted frame lands at column j + 5; the rest is outside its footprint
    assert np.array_equal(store.read(2)[:, :, 5:], frames.rgb[2][:, :, :-5])
    expected = np.zeros((pf.HEIGHT, pf.WIDTH), dtype=bool)
    expected[:, 5:] = frames.alpha[2][:, :-5]
    assert np.array_equal(stored_mask(store)[2], expected)


def test_png_frames_with_their_own_crs_warp_into_another_crs(tmp_path):
    frames = pf.rgba_frames(tmp_path, "aux")
    out = tmp_path / "store"
    report = convert(
        pf.write_manifest(tmp_path / "m.csv", frames),
        out,
        crs="EPSG:32632",
        resampling="nearest",
        **OPTIONS,
    )
    assert report.plan.warped == pf.N_TIME
    store = chronozarr.open_store(out)
    assert store.attrs.crs == "EPSG:32632"
    assert store.attrs.mask_variable == "mask"
    assert chronozarr.validate(out) == []


def test_frames_located_by_bounds_can_be_cropped_onto_an_explicit_grid(tmp_path):
    frames = pf.rgba_frames(tmp_path, "none")
    left = TRANSFORM[2] + 4 * 10.0
    top = TRANSFORM[5] - 3 * 10.0
    out = tmp_path / "store"
    convert(
        pf.write_manifest(tmp_path / "m.csv", frames),
        out,
        crs=CRS,
        bounds=pf.bounds_of(),
        transform=(10.0, 0.0, left, 0.0, -10.0, top),
        shape=(20, 24),
        resampling="nearest",
        **OPTIONS,
    )
    store = chronozarr.open_store(out)
    assert np.array_equal(
        np.stack([store.read(t) for t in range(pf.N_TIME)]), frames.rgb[:, :, 3:23, 4:28]
    )
    assert np.array_equal(stored_mask(store), frames.alpha[:, 3:23, 4:28])


def test_bounds_apply_to_manifests_only(tmp_path, truth):
    source = tmp_path / "in.zarr"
    dataset_from(truth).to_zarr(source, zarr_format=2, consolidated=True)
    with pytest.raises(ValueError, match="apply to manifests"):
        plan_conversion(source, crs=CRS, bounds=pf.bounds_of(), sample=False)


def test_png_bands_follow_the_colour_interpretation_unless_named(tmp_path):
    rng = np.random.default_rng(5)

    def stack(channels: int, name: str):
        folder = tmp_path / f"frames_{name}"
        folder.mkdir()
        pixels = rng.integers(
            0, 256, size=(pf.N_TIME, pf.HEIGHT, pf.WIDTH, channels), dtype=np.uint8
        )
        paths = []
        for t in range(pf.N_TIME):
            png = pf.write_png(folder / f"f{t}.png", pixels[t])
            pf.write_world_file(png)
            paths.append(png)
        return pf.FrameSet(paths, pixels)

    rgb = convert_frames(tmp_path, stack(3, "rgb"), crs=CRS, name="rgb")
    assert rgb.bands == ("red", "green", "blue")
    assert rgb.attrs.mask_variable is None  # no alpha, no mask
    assert rgb.attrs.nodata is None

    named = convert_frames(tmp_path, stack(3, "named"), crs=CRS, bands="B04;B03;B02", name="named")
    assert named.bands == ("B04", "B03", "B02")
    assert [b.common_name for b in named.attrs.bands] == [None, None, None]

    one = convert_frames(tmp_path, stack(1, "gray"), crs=CRS, name="gray")
    assert one.bands == ("1",)
    assert one.attrs.mask_variable is None

    gray_alpha = stack(2, "ga")
    ga = convert_frames(tmp_path, gray_alpha, crs=CRS, name="ga")
    assert ga.bands == ("1",)
    assert ga.attrs.mask_variable == "mask"
    assert np.array_equal(ga.read_mask(0).astype(bool), gray_alpha.pixels[0, :, :, 1] != 0)


def test_a_palette_png_is_refused_with_the_way_to_expand_it(tmp_path):
    folder = tmp_path / "palette"
    folder.mkdir()
    palette = np.array([[255, 0, 0], [0, 255, 0], [0, 0, 255]], dtype=np.uint8)
    indexes = np.arange(pf.HEIGHT * pf.WIDTH, dtype=np.uint8).reshape(pf.HEIGHT, pf.WIDTH) % 3
    paths = []
    for t in range(2):
        png = pf.write_png(folder / f"p{t}.png", indexes, palette=palette)
        pf.write_world_file(png)
        paths.append(png)
    manifest = pf.write_manifest(tmp_path / "m.csv", pf.FrameSet(paths, np.zeros((2, 1, 1, 4))))
    with pytest.raises(
        ValueError, match=r"palette \(indexed colour\) PNG.*gdal_translate -expand"
    ):
        plan_conversion(manifest, crs=CRS, sample=False)


def test_a_palette_geotiff_keeps_its_indexes_as_data(tmp_path):
    """Only PNG frames are display images; a GeoTIFF colour table usually labels class codes."""
    classes = (np.arange(HEIGHT * WIDTH, dtype=np.uint8).reshape(1, HEIGHT, WIDTH)) % 3
    files = []
    for t in range(2):
        path = tmp_path / f"class_{t}.tif"
        write_tif(path, classes, nodata=None)
        with rasterio.open(path, "r+") as dst:
            dst.write_colormap(1, {0: (255, 0, 0, 255), 1: (0, 255, 0, 255), 2: (0, 0, 255, 255)})
        files.append(path)
    out = tmp_path / "store"
    convert(write_csv(tmp_path / "m.csv", files, DATES[:2]), out, **OPTIONS)
    assert np.array_equal(stored(out)[0], classes)


def test_sidecars_are_probed_for_png_sources_only():
    assert _gdal_env("/data/frame.png")["GDAL_DISABLE_READDIR_ON_OPEN"] == "TRUE"
    assert _gdal_env("https://host/a/frame.PNG?sig=1")["GDAL_DISABLE_READDIR_ON_OPEN"] == "TRUE"
    assert _gdal_env("/data/scene.tif")["GDAL_DISABLE_READDIR_ON_OPEN"] == "EMPTY_DIR"
    assert _gdal_env("https://host/scene.tif?sig=1")["GDAL_DISABLE_READDIR_ON_OPEN"] == "EMPTY_DIR"


def test_a_png_frame_set_resumes_and_plans_like_any_manifest(tmp_path):
    frames = pf.rgba_frames(tmp_path, "none")
    manifest = pf.write_manifest(tmp_path / "m.csv", frames)
    plan = plan_conversion(manifest, crs=CRS, bounds=pf.bounds_of(), chunk_size=16)
    text = "\n".join(plan.lines())
    assert "data:       3 bands (red, green, blue), uint8" in text
    assert "validity:   mask (alpha band)" in text
    assert plan.raw_bytes == pf.N_TIME * 3 * pf.HEIGHT * pf.WIDTH
    assert plan.sample_ratio is not None


# --- Zarr and NetCDF sources ----------------------------------------------------------------


def dataset_from(truth: np.ndarray, *, band: bool = True, flip_y: bool = False) -> xr.Dataset:
    a, _, c, _, e, f = TRANSFORM
    x = c + a * (np.arange(WIDTH) + 0.5)
    y = f + e * (np.arange(HEIGHT) + 0.5)
    values = truth if band else truth[:, 0]
    dims = ("time", "band", "y", "x") if band else ("time", "y", "x")
    coords: dict = {"time": make_times(len(truth)), "y": y, "x": x}
    if band:
        coords["band"] = ["red", "nir"]
    da = xr.DataArray(values, dims=dims, coords=coords, name="reflectance")
    if flip_y:
        da = da.isel(y=slice(None, None, -1))
    return da.to_dataset()


def test_zarr_source_with_band_dimension(tmp_path, truth):
    source = tmp_path / "in.zarr"
    ds = dataset_from(truth)
    ds["reflectance"].attrs.update({"crs": CRS, "scale_factor": 0.0001, "units": "1"})
    ds.to_zarr(source, zarr_format=2, consolidated=True)
    out = tmp_path / "store"
    report = convert(source, out, **OPTIONS)
    assert np.array_equal(stored(out), truth)
    store = chronozarr.open_store(out)
    assert store.bands == ("red", "nir")
    assert store.attrs.bands[0].scale == 0.0001
    assert store.attrs.bands[0].units == "1"
    assert store.levels[0].transform == TRANSFORM
    assert report.plan.source.kind == "Zarr store"


def test_zarr_source_without_band_dimension_flipped_y_and_crs_flag(tmp_path, truth):
    source = tmp_path / "in.zarr"
    dataset_from(truth, band=False, flip_y=True).to_zarr(source, zarr_format=2, consolidated=False)
    with pytest.raises(ValueError, match="does not declare a CRS"):
        plan_conversion(source, sample=False)
    out = tmp_path / "store"
    convert(source, out, crs=CRS, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.bands == ("reflectance",)
    assert np.array_equal(store.to_xarray().values[:, 0], truth[:, 0])
    assert store.levels[0].transform == TRANSFORM


def test_zarr_source_dimension_names_and_errors(tmp_path, truth):
    source = tmp_path / "in.zarr"
    ds = dataset_from(truth).rename({"x": "lon", "y": "lat", "band": "channel"})
    ds.attrs["crs"] = CRS
    ds.to_zarr(source, zarr_format=2, consolidated=True)
    out = tmp_path / "store"
    convert(source, out, **OPTIONS)  # lat/lon/channel are recognised aliases
    assert np.array_equal(stored(out), truth)

    odd = tmp_path / "odd.zarr"
    dataset_from(truth).rename({"x": "col"}).to_zarr(odd, zarr_format=2, consolidated=True)
    with pytest.raises(ValueError, match="cannot find the x dimension"):
        plan_conversion(odd, crs=CRS, sample=False)
    plan = plan_conversion(odd, crs=CRS, dims="x=col", sample=False)
    assert plan.source.info.grid.width == WIDTH
    with pytest.raises(ValueError, match="bad --dims entry"):
        plan_conversion(odd, crs=CRS, dims="x", sample=False)
    with pytest.raises(ValueError, match="choose one with --variable"):
        two = dataset_from(truth).assign(other=lambda d: d["reflectance"])
        two_path = tmp_path / "two.zarr"
        two.to_zarr(two_path, zarr_format=2, consolidated=True)
        plan_conversion(two_path, crs=CRS, sample=False)
    with pytest.raises(ValueError, match="apply to manifests of COGs or image frames"):
        plan_conversion(source, resampling="nearest", sample=False)


def test_netcdf_source(tmp_path, truth):
    pytest.importorskip("h5netcdf")
    source = tmp_path / "in.nc"
    ds = dataset_from(truth)
    ds["reflectance"].attrs["crs"] = CRS
    ds.to_netcdf(source, engine="h5netcdf")
    out = tmp_path / "store"
    report = convert(source, out, **OPTIONS)
    assert report.plan.source.kind == "NetCDF file"
    assert np.array_equal(stored(out), truth)


def test_missing_xarray_sources_are_named(tmp_path):
    with pytest.raises(FileNotFoundError, match="does not exist"):
        plan_conversion(tmp_path / "nope.zarr", sample=False)
    with pytest.raises(FileNotFoundError, match=r"NetCDF file .* does not exist"):
        plan_conversion(tmp_path / "nope.nc", sample=False)


# --- estimates, dry run, resume -------------------------------------------------------------


def test_dry_run_reports_estimates_and_writes_nothing(tmp_path, tifs):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    out = tmp_path / "store"
    seen = []
    report = convert(manifest, out, dry_run=True, on_plan=seen.append, **OPTIONS)
    assert report.encode is None
    assert not out.exists()
    assert not (tmp_path / "store.convert-work").exists()
    plan = seen[0]
    assert plan.raw_bytes == N_TIME * N_BAND * HEIGHT * WIDTH * 2
    assert plan.timestep_bytes == N_BAND * HEIGHT * WIDTH * 2
    assert plan.est_output_bytes is not None and plan.sample_ratio is not None
    assert 0 < plan.sample_ratio < 1.0
    text = "\n".join(plan.lines())
    for expected in ("source:     manifest of COGs, 5 timesteps", "grid:", "raw size:", "output:"):
        assert expected in text
    assert "resampling: none needed" in text
    assert "time:       read about" in text

    actual = convert(manifest, out, **OPTIONS).encode
    assert actual is not None
    assert 0.25 < plan.est_output_bytes / actual.total_bytes < 4.0


def test_progress_reports_every_staged_timestep(tmp_path, tifs):
    calls = []
    convert(
        write_csv(tmp_path / "m.csv", tifs),
        tmp_path / "store",
        progress=lambda done, total: calls.append((done, total)),
        **OPTIONS,
    )
    assert calls[0] == (0, N_TIME)
    assert calls[-1] == (N_TIME, N_TIME)
    assert [done for done, _ in calls] == sorted(done for done, _ in calls)


def test_resume_reads_only_what_the_interrupted_run_did_not_stage(
    tmp_path, tifs, truth, monkeypatch
):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    out = tmp_path / "store"
    original = CogManifestSource.read
    state = {"fail": True}

    def flaky(self, t):
        if t == 3 and state["fail"]:
            raise OSError("connection reset")
        return original(self, t)

    monkeypatch.setattr(CogManifestSource, "read", flaky)
    with pytest.raises(OSError, match="connection reset") as error:
        convert(manifest, out, read_ahead=1, **OPTIONS)
    assert "rerun with --resume" in "\n".join(error.value.__notes__)
    work = tmp_path / "store.convert-work"
    assert sorted(p.name for p in work.glob("t*.npy")) == [
        "t000000.npy",
        "t000001.npy",
        "t000002.npy",
    ]
    assert not out.exists()

    with pytest.raises(FileExistsError, match="Pass --resume"):
        convert(manifest, out, **OPTIONS)

    state["fail"] = False
    report = convert(manifest, out, resume=True, **OPTIONS)
    assert (report.n_reused, report.n_staged) == (3, 2)
    assert np.array_equal(stored(out), truth)
    assert not work.exists()


def test_resume_refuses_a_work_dir_staged_for_a_different_plan(tmp_path, tifs, truth, monkeypatch):
    manifest = write_csv(tmp_path / "m.csv", tifs)
    out = tmp_path / "store"
    original = CogManifestSource.read

    def failing(self, t):
        if t == 1:  # timesteps 0, 2 and 4 are read while planning, so the failure comes later
            raise OSError("boom")
        return original(self, t)

    monkeypatch.setattr(CogManifestSource, "read", failing)
    with pytest.raises(OSError, match="boom"):
        convert(manifest, out, read_ahead=1, **OPTIONS)
    monkeypatch.undo()
    other = write_csv(tmp_path / "other.csv", tifs, bands="X;Y")
    with pytest.raises(ValueError, match="different input or options"):
        convert(other, out, resume=True, **OPTIONS)


def test_existing_output_is_refused_before_anything_is_read(tmp_path, tifs):
    out = tmp_path / "store"
    out.mkdir()
    (out / "file").write_text("x")
    with pytest.raises(FileExistsError, match="stores are immutable"):
        convert(write_csv(tmp_path / "m.csv", tifs), out, **OPTIONS)
    assert not (tmp_path / "store.convert-work").exists()


def test_custom_work_dir_is_used_and_cleaned(tmp_path, tifs):
    work = tmp_path / "scratch" / "stage"
    convert(write_csv(tmp_path / "m.csv", tifs), tmp_path / "store", work_dir=work, **OPTIONS)
    assert not work.exists()


def test_plan_lines_mention_warped_timesteps(tmp_path, tifs, truth):
    shifted = list(TRANSFORM)
    shifted[2] += 10.0
    write_tif(tifs[1], truth[1], transform=tuple(shifted))
    plan = plan_conversion(write_csv(tmp_path / "m.csv", tifs), resampling="average")
    assert "resampling: 1 of 5 timesteps are warped" in "\n".join(plan.lines())


# --- fidelity: scale, offset, units and validity of COG sources -----------------------------


def convert_cogs(tmp_path, cogs, *, bands=None, name="store", **kwargs):
    out = tmp_path / name
    manifest = fx.write_manifest(tmp_path / f"{name}.csv", cogs, bands)
    convert(manifest, out, **{**OPTIONS, **kwargs})
    return chronozarr.open_store(out)


def stored_mask(store) -> np.ndarray:
    return np.stack([store.read_mask(t) for t in range(len(store.times))]).astype(bool)


def physical_nan(store) -> np.ndarray:
    return np.stack([np.isnan(store.physical(t)) for t in range(len(store.times))])


def band_attrs(store) -> list[tuple]:
    return [(b.scale, b.offset, b.units) for b in store.attrs.bands]


def test_internal_mask_and_band_scaling_survive_conversion(tmp_path):
    """The reviewer's case: scaled reflectance whose invalid pixel carries a value."""
    cogs = fx.scaled_masked(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.bands == ("red", "nir")
    assert band_attrs(store) == [
        (0.0001, -0.1, "reflectance"),
        (0.0002, 0.05, "reflectance"),
    ]
    assert store.attrs.nodata is None  # a mask carries validity; the encoder's 0 is not used
    assert store.attrs.mask_variable == "mask"
    assert np.array_equal(stored_mask(store), cogs.shared_valid)
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])  # the 777 under the mask is kept
    assert np.array_equal(physical_nan(store), ~cogs.valid)
    scale = np.array(cogs.scales, dtype=np.float32)[:, None, None]
    offset = np.array(cogs.offsets, dtype=np.float32)[:, None, None]
    expected = cogs.data[0].astype(np.float32) * scale + offset
    keep = cogs.valid[0]
    assert np.allclose(store.physical(0)[keep], expected[keep], rtol=1e-6)
    assert store.levels[1].mask is not None
    assert chronozarr.validate(tmp_path / "store") == []


def test_alpha_band_becomes_the_mask_and_is_not_stored_as_data(tmp_path):
    cogs = fx.rgba(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.bands == ("red", "green", "blue")
    assert store.dtype == np.uint8
    assert store.attrs.nodata is None
    assert np.array_equal(stored_mask(store), cogs.shared_valid)
    assert store.read_mask(0)[2, 2] == 1  # alpha 128 is partly transparent, still valid
    assert store.read_mask(0)[3, 4] == 0  # alpha 0
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])
    with pytest.raises(ValueError, match="has 3 bands but 4 band names"):
        plan_conversion(
            fx.write_manifest(tmp_path / "four.csv", cogs, bands="r;g;b;a"), sample=False
        )


def test_a_nodata_sentinel_is_kept_when_it_is_faithful(tmp_path):
    cogs = fx.nodata_zero(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.attrs.nodata == 0
    assert store.attrs.mask_variable is None
    assert band_attrs(store) == [(0.0001, -0.1, "reflectance")] * 2
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])
    # validity stays per band: (9, 9+t) is invalid in band 0 only
    assert np.array_equal(physical_nan(store), ~cogs.valid)
    assert not physical_nan(store)[0, 1, 9, 9]


def test_no_declared_nodata_means_no_nodata_and_a_zero_is_data(tmp_path):
    cogs = fx.valid_zero(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.attrs.nodata is None
    assert store.attrs.mask_variable is None
    assert band_attrs(store) == [(1.0, 0.0, None)] * 2
    assert np.array_equal(store.read(1), cogs.data[1])
    assert store.read(1)[0, 5, 7] == 0
    assert not physical_nan(store).any()


def test_int16_negative_values_keep_their_sentinel_scale_and_units(tmp_path):
    cogs = fx.int16_negative(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.dtype == np.int16
    assert store.attrs.nodata == -9999
    assert store.attrs.mask_variable is None
    assert store.attrs.spec_version == "0.3.0"
    assert band_attrs(store) == [(0.5, -10.0, "degC")] * 2
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])
    assert (cogs.data < 0).any()
    physical = store.physical(2)
    assert np.allclose(physical[cogs.valid[2]], (cogs.data[2] * 0.5 - 10.0)[cogs.valid[2]])
    assert np.isnan(physical[~cogs.valid[2]]).all()


def test_float32_nan_nodata_becomes_a_mask_and_nan_is_never_stored(tmp_path):
    cogs = fx.float32_nan(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.dtype == np.float32
    assert store.attrs.nodata is None
    assert store.attrs.mask_variable == "mask"
    assert band_attrs(store) == [(0.5, 1.0, "m")] * 2
    # one plane for both bands: invalid where any band is NaN, so band 1 at (9, 9+t) is hidden
    assert np.array_equal(stored_mask(store), cogs.shared_valid)
    for t in range(fx.N_TIME):
        stored = store.read(t)
        assert not np.isnan(stored).any()
        assert np.array_equal(stored, np.where(np.isnan(cogs.data[t]), 0, cogs.data[t]))
    assert store.read(0)[1, 9, 9] == cogs.data[0, 1, 9, 9]  # the valid band keeps its value
    assert (cogs.data < 0).any()


def test_float32_finite_nodata_is_a_sentinel(tmp_path):
    cogs = fx.float32_finite_nodata(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.attrs.nodata == -9999.0
    assert store.attrs.mask_variable is None
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])
    assert np.array_equal(physical_nan(store), ~cogs.valid)


def test_nodata_that_differs_between_sources_becomes_a_mask(tmp_path):
    cogs = fx.nodata_changes(tmp_path)
    store = convert_cogs(tmp_path, cogs)
    assert store.attrs.nodata is None
    assert np.array_equal(stored_mask(store), cogs.shared_valid)
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), cogs.data[t])
    assert store.read_mask(0)[5, 6] == 1  # holds 7, valid where nodata is 0
    assert store.read_mask(3)[5, 6] == 1  # holds 0, valid where nodata is 7


def test_a_source_without_nodata_among_sources_with_nodata_gets_a_mask(tmp_path, tifs, truth):
    write_tif(tifs[2], truth[2], nodata=None)
    out = tmp_path / "store"
    convert(write_csv(tmp_path / "m.csv", tifs), out, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.attrs.nodata is None
    expected = (truth != 0).all(axis=1)
    expected[2] = True  # that source declares nothing, so its zeros are data
    assert np.array_equal(stored_mask(store), expected)
    assert np.array_equal(store.read(2), truth[2])


def test_explicit_nodata_replaces_the_declared_nodata(tmp_path):
    cogs = fx.nodata_zero(tmp_path)
    none = convert_cogs(tmp_path, cogs, nodata=None, name="none")
    assert none.attrs.nodata is None
    assert none.attrs.mask_variable is None
    assert not physical_nan(none).any()  # the sources' 0 is now ordinary data
    assert np.array_equal(none.read(1), cogs.data[1])

    seven = convert_cogs(tmp_path, cogs, nodata=7, name="seven")
    assert seven.attrs.nodata == 7
    assert not physical_nan(seven).any()

    masked = fx.scaled_masked(tmp_path)
    store = convert_cogs(tmp_path, masked, nodata=777, name="kept")
    assert store.attrs.nodata == 777  # asked for, so kept next to the mask
    assert store.attrs.mask_variable == "mask"
    # the explicit nodata adds to the source mask: valid pixels that hold 777 are now invalid
    expected = masked.shared_valid & (masked.data != 777).all(axis=1)
    assert np.array_equal(stored_mask(store), expected)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"nodata": "zero"}, "nodata must be a number, None or 'auto'"),
        ({"nodata": 300}, "cannot be held by uint8"),
        ({"nodata": float("inf")}, "nodata must be finite"),
        ({"nodata": float("nan")}, "needs float data"),
    ],
)
def test_bad_explicit_nodata_is_rejected_up_front(tmp_path, kwargs, message):
    cogs = fx.rgba(tmp_path)
    with pytest.raises(ValueError, match=message):
        plan_conversion(fx.write_manifest(tmp_path / "m.csv", cogs), sample=False, **kwargs)


def test_undeclared_nan_in_a_float_source_is_an_error_unless_nodata_is_nan(tmp_path):
    cogs = fx.float32_undeclared_nan(tmp_path)
    manifest = fx.write_manifest(tmp_path / "m.csv", cogs)
    with pytest.raises(ValueError, match=r"holds \d+ NaN values.*pass --nodata nan"):
        convert(manifest, tmp_path / "refused", **OPTIONS)
    assert not (tmp_path / "refused").exists()

    store = convert_cogs(tmp_path, cogs, nodata=float("nan"))
    assert store.attrs.nodata is None
    assert np.array_equal(stored_mask(store), ~np.isnan(cogs.data).any(axis=1))
    assert not np.isnan(store.read(0)).any()


def test_a_warped_source_without_nodata_gets_a_footprint_mask(tmp_path):
    cogs = fx.valid_zero(tmp_path)
    shifted = list(TRANSFORM)
    shifted[2] += 5 * 10.0
    write_tif(cogs.paths[2], cogs.data[2], transform=tuple(shifted), nodata=None)
    manifest = fx.write_manifest(tmp_path / "m.csv", cogs)
    with pytest.raises(ValueError, match="not on the target grid"):
        plan_conversion(manifest, sample=False)

    out = tmp_path / "store"
    report = convert(manifest, out, resampling="nearest", **OPTIONS)
    assert "warped timesteps leave pixels outside the source footprint" in "\n".join(
        report.plan.lines()
    )
    store = chronozarr.open_store(out)
    assert store.attrs.nodata is None
    expected = np.ones((fx.N_TIME, fx.HEIGHT, fx.WIDTH), dtype=bool)
    expected[2, :, :5] = False
    assert np.array_equal(stored_mask(store), expected)
    assert np.array_equal(store.read(2)[:, :, 5:], cogs.data[2][:, :, :-5])
    assert not store.read(2)[:, :, :5].any()
    assert np.array_equal(store.read(1), cogs.data[1])
    assert store.read(1)[0, 5, 7] == 0  # a valid zero stays valid in an unwarped timestep


def test_a_warped_source_with_an_internal_mask_keeps_its_validity(tmp_path):
    cogs = fx.scaled_masked(tmp_path, shift={2: 5})
    manifest = fx.write_manifest(tmp_path / "m.csv", cogs)
    out = tmp_path / "store"
    convert(manifest, out, resampling="nearest", **OPTIONS)
    store = chronozarr.open_store(out)
    mask = stored_mask(store)
    expected = cogs.shared_valid.copy()
    expected[2] = False
    expected[2, :, 5:] = cogs.shared_valid[2][:, :-5]
    assert np.array_equal(mask, expected)
    moved = store.read(2)[:, :, 5:]
    valid = cogs.shared_valid[2][:, :-5]
    assert np.array_equal(moved[:, valid], cogs.data[2][:, :, :-5][:, valid])
    assert band_attrs(store)[0] == (0.0001, -0.1, "reflectance")


def test_band_descriptions_must_agree_unless_the_manifest_names_the_bands(tmp_path, truth):
    files = [
        write_tif(
            tmp_path / f"d{t}.tif", truth[t], descriptions=["red", "swir" if t == 2 else "nir"]
        )
        for t in range(3)
    ]
    with pytest.raises(ValueError, match=r"band descriptions \['red', 'swir'\]"):
        plan_conversion(write_csv(tmp_path / "a.csv", files, DATES[:3]), sample=False)
    named = plan_conversion(write_csv(tmp_path / "b.csv", files, DATES[:3], "r;n"), sample=False)
    assert named.source.info.band_names == ("r", "n")


def test_plan_lines_state_scaling_and_the_validity_rule(tmp_path):
    cogs = fx.scaled_masked(tmp_path)
    text = "\n".join(plan_conversion(fx.write_manifest(tmp_path / "m.csv", cogs)).lines())
    assert (
        "scaling:    red = stored * 0.0001 -0.1 [reflectance], nir = stored * 0.0002 +0.05" in text
    )
    assert "validity:   mask (internal mask), no nodata" in text
    plain = "\n".join(
        plan_conversion(fx.write_manifest(tmp_path / "p.csv", fx.nodata_zero(tmp_path))).lines()
    )
    assert "validity:   nodata 0 sentinel, no mask" in plain


def test_resume_reuses_staged_masks(tmp_path, monkeypatch):
    cogs = fx.scaled_masked(tmp_path)
    manifest = fx.write_manifest(tmp_path / "m.csv", cogs)
    out = tmp_path / "store"
    original = CogManifestSource.read
    state = {"fail": True}

    def flaky(self, t):
        if t == 1 and state["fail"]:  # timesteps 0, 2 and 3 are read while planning
            raise OSError("connection reset")
        return original(self, t)

    monkeypatch.setattr(CogManifestSource, "read", flaky)
    with pytest.raises(OSError, match="connection reset"):
        convert(manifest, out, read_ahead=1, **OPTIONS)
    work = tmp_path / "store.convert-work"
    assert (work / "t000000.npy").is_file()
    assert (work / "m000000.npy").is_file()

    (work / "m000000.npy").unlink()  # a staged timestep without its mask is read again
    state["fail"] = False
    report = convert(manifest, out, resume=True, **OPTIONS)
    assert (report.n_reused, report.n_staged) == (0, 4)
    store = chronozarr.open_store(out)
    assert np.array_equal(stored_mask(store), cogs.shared_valid)
    assert not work.exists()


# --- fidelity: CF attributes and mask variables of Zarr sources -----------------------------


def test_zarr_cf_fill_value_scale_offset_and_units(tmp_path):
    zarr_set = fx.cf_zarr(tmp_path / "in.zarr")
    out = tmp_path / "store"
    report = convert(zarr_set.path, out, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.bands == zarr_set.bands
    assert band_attrs(store) == [(0.01, 1.5, "m")] * 2
    assert store.attrs.nodata == -9999  # the _FillValue, faithful as a sentinel
    assert store.attrs.mask_variable is None
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), zarr_set.data[t])
    assert np.array_equal(physical_nan(store), ~zarr_set.valid)
    assert report.plan.source.info.validity == "nodata -9999 sentinel, no mask"
    physical = store.physical(1)
    keep = zarr_set.valid[1]
    assert np.allclose(physical[keep], (zarr_set.data[1].astype(np.float64) * 0.01 + 1.5)[keep])


def test_zarr_fill_value_and_missing_value_together_need_a_mask(tmp_path):
    zarr_set = fx.cf_zarr(tmp_path / "in.zarr", missing=-8888)
    out = tmp_path / "store"
    convert(zarr_set.path, out, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.attrs.nodata is None
    assert store.attrs.mask_variable == "mask"
    assert np.array_equal(stored_mask(store), zarr_set.shared_valid)
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), zarr_set.data[t])
    assert band_attrs(store) == [(0.01, 1.5, "m")] * 2


@pytest.mark.parametrize("flip_y", [False, True])
def test_zarr_mask_variable_combines_with_the_cf_fill_value(tmp_path, flip_y):
    zarr_set = fx.cf_zarr(tmp_path / "in.zarr", flag_var=True, flip_y=flip_y)
    with pytest.raises(ValueError, match="choose one with --variable"):
        plan_conversion(zarr_set.path, sample=False)
    out = tmp_path / "store"
    convert(zarr_set.path, out, mask_var="ok", **OPTIONS)  # `ok` is not a candidate variable
    store = chronozarr.open_store(out)
    assert store.attrs.nodata is None
    assert np.array_equal(stored_mask(store), zarr_set.shared_valid)
    for t in range(fx.N_TIME):
        assert np.array_equal(store.read(t), zarr_set.data[t])  # north-up, whatever the file


def test_zarr_float_nan_fill_value_becomes_a_mask(tmp_path, truth):
    values = truth.astype(np.float32)
    values[:, :, 3, 4] = np.nan
    source = tmp_path / "f.zarr"
    dataset_from(values).to_zarr(source, zarr_format=2, consolidated=True)
    out = tmp_path / "store"
    convert(source, out, crs=CRS, **OPTIONS)
    store = chronozarr.open_store(out)
    assert store.attrs.nodata is None
    assert store.attrs.mask_variable == "mask"
    expected = ~np.isnan(values).any(axis=1)
    assert np.array_equal(stored_mask(store), expected)
    assert not np.isnan(store.read(0)).any()


def test_zarr_undeclared_nan_is_an_error_unless_nodata_is_nan(tmp_path, truth):
    values = truth.astype(np.float32)
    values[:, :, 3, 4] = np.nan
    source = tmp_path / "f.zarr"
    dataset_from(values).to_zarr(
        source, zarr_format=2, consolidated=True, encoding={"reflectance": {"_FillValue": None}}
    )
    with pytest.raises(ValueError, match=r"holds \d+ NaN values.*pass --nodata nan"):
        convert(source, tmp_path / "refused", crs=CRS, **OPTIONS)
    out = tmp_path / "store"
    convert(source, out, crs=CRS, nodata=float("nan"), **OPTIONS)
    assert np.array_equal(stored_mask(chronozarr.open_store(out)), ~np.isnan(values).any(axis=1))


def test_zarr_mask_variable_is_validated(tmp_path, truth):
    zarr_set = fx.cf_zarr(tmp_path / "in.zarr", flag_var=True)
    with pytest.raises(ValueError, match=r"mask variable 'nope' is not in"):
        plan_conversion(zarr_set.path, variable="v", mask_var="nope", sample=False)
    with pytest.raises(ValueError, match="mask variable 'v' is the data variable"):
        plan_conversion(zarr_set.path, variable="v", mask_var="v", sample=False)

    ds = dataset_from(truth)
    ds["columns"] = (("time", "x"), np.ones((N_TIME, WIDTH), dtype=np.uint8))
    ds["real"] = (("time", "y", "x"), np.ones((N_TIME, HEIGHT, WIDTH), dtype=np.float32))
    odd = tmp_path / "odd.zarr"
    ds.to_zarr(odd, zarr_format=2, consolidated=True)
    with pytest.raises(ValueError, match="must have exactly"):
        plan_conversion(odd, crs=CRS, variable="reflectance", mask_var="columns", sample=False)
    with pytest.raises(ValueError, match="use a boolean or integer variable"):
        plan_conversion(odd, crs=CRS, variable="reflectance", mask_var="real", sample=False)


def test_mask_variable_does_not_apply_to_manifests(tmp_path):
    cogs = fx.valid_zero(tmp_path)
    with pytest.raises(ValueError, match="apply to Zarr and NetCDF input, not manifests"):
        plan_conversion(fx.write_manifest(tmp_path / "m.csv", cogs), mask_var="ok", sample=False)


@pytest.mark.parametrize(
    ("attrs", "message"),
    [
        ({"scale_factor": 0.0}, "scale must be finite and non-zero"),
        ({"scale_factor": float("inf")}, "scale must be finite and non-zero"),
        ({"add_offset": float("nan")}, "offset finite"),
        ({"scale_factor": [0.1, 0.2]}, "must be one number"),
    ],
)
def test_zarr_bad_cf_scaling_is_rejected(tmp_path, truth, attrs, message):
    ds = dataset_from(truth)
    ds["reflectance"].attrs.update({"crs": CRS, **attrs})
    source = tmp_path / "in.zarr"
    ds.to_zarr(source, zarr_format=2, consolidated=True)
    with pytest.raises(ValueError, match=message):
        plan_conversion(source, sample=False)


def test_zarr_without_cf_attributes_writes_explicit_unit_scaling(tmp_path, truth):
    source = tmp_path / "in.zarr"
    ds = dataset_from(truth)
    ds["reflectance"].attrs["crs"] = CRS
    ds.to_zarr(source, zarr_format=2, consolidated=True)
    out = tmp_path / "store"
    convert(source, out, **OPTIONS)
    store = chronozarr.open_store(out)
    assert band_attrs(store) == [(1.0, 0.0, None)] * 2
    assert store.attrs.nodata is None  # no _FillValue declared, so a stored 0 is data
