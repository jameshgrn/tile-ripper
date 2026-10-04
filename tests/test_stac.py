"""Static STAC Collection and Item for a store."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import chronozarr
from chronozarr import schema
from chronozarr.stac import EXT_DATACUBE, ZARR_MEDIA_TYPE, build_stac, default_id, write_stac
from tests.synthetic import BANDS, CRS, TRANSFORM, build_store, make_truth

pytestmark = pytest.mark.unit

rasterio = pytest.importorskip("rasterio")


@pytest.fixture(scope="module")
def store_path(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("stac") / "aoi_one" / "chronozarr-2"
    path.parent.mkdir()
    build_store(path, make_truth(5, 2, 40, 50), shard=True, chunk_size=16)
    return path


def documents(store_path: Path, **kwargs):
    store = chronozarr.open_store(str(store_path))
    return store, build_stac(store, href="s3://bucket/aoi_one/chronozarr-2", id="aoi", **kwargs)


def test_item_describes_extent_asset_and_projection(store_path):
    store, (_, item) = documents(store_path)
    assert item["type"] == "Feature"
    assert item["stac_version"] == "1.1.0"
    assert EXT_DATACUBE in item["stac_extensions"]
    props = item["properties"]
    assert props["datetime"] is None
    assert props["start_datetime"] == store.attrs.times[0]
    assert props["end_datetime"] == store.attrs.times[-1]
    assert props["proj:code"] == CRS
    assert props["proj:shape"] == [40, 50]
    assert props["proj:transform"][:6] == list(TRANSFORM)
    left, top = TRANSFORM[2], TRANSFORM[5]
    assert props["proj:bbox"] == [left, top - 400.0, left + 500.0, top]
    asset = item["assets"]["zarr"]
    assert asset == {
        "href": "s3://bucket/aoi_one/chronozarr-2",
        "type": ZARR_MEDIA_TYPE,
        "title": "chronozarr Zarr v3 store",
        "description": asset["description"],
        "roles": ["data"],
    }


def test_footprint_is_a_closed_wgs84_polygon_containing_the_bbox_corners(store_path):
    _, (collection, item) = documents(store_path)
    ring = item["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    lons, lats = zip(*ring, strict=True)
    assert item["bbox"] == [min(lons), min(lats), max(lons), max(lats)]
    assert collection["extent"]["spatial"]["bbox"] == [item["bbox"]]
    # UTM 31N has its central meridian at 3E; easting 746090 is ~2.4 degrees east of it, at ~23N
    assert 5.2 < item["bbox"][0] < 5.6
    assert 22.0 < item["bbox"][1] < 24.0


def test_datacube_dimensions_and_variables(store_path):
    store, (collection, item) = documents(store_path)
    dims = item["properties"]["cube:dimensions"]
    assert collection["cube:dimensions"] == dims
    assert dims["x"] == {
        "type": "spatial",
        "axis": "x",
        "extent": [746090.0, 746590.0],
        "step": 10.0,
        "reference_system": 32631,
    }
    assert dims["y"]["step"] == -10.0
    assert dims["y"]["extent"] == [2540040.0, 2540440.0]
    assert dims["time"]["extent"] == [store.attrs.times[0], store.attrs.times[-1]]
    assert dims["time"]["values"] == list(store.attrs.times)
    assert dims["band"] == {"type": "bands", "values": BANDS}
    variable = item["properties"]["cube:variables"]["data"]
    assert variable["dimensions"] == ["time", "band", "y", "x"]
    assert variable["type"] == "data"
    assert variable["data_type"] == "uint16"
    assert variable["nodata"] == 0
    assert "residuals" not in variable["description"]


def test_bands_and_chronozarr_fields(store_path):
    _, (_, item) = documents(store_path)
    props = item["properties"]
    assert [b["name"] for b in props["bands"]] == BANDS
    assert all(b["data_type"] == "uint16" and b["nodata"] == 0 for b in props["bands"])
    assert props["chronozarr:spec_version"].startswith("0.")
    assert "chronozarr:anchor_interval" not in props
    assert props["chronozarr:zarr_conventions"] == [
        schema.registration(n) for n in ("multiscales", "proj", "spatial")
    ]
    assert props["chronozarr:levels"][0] == {
        "path": "0",
        "resolution": 10.0,
        "shape": [5, 2, 40, 50],
        "grid": [3, 4],
    }
    assert len(props["chronozarr:levels"]) >= 2


def test_write_stac_makes_files_with_relative_href_for_local_stores(store_path, tmp_path):
    collection_path, item_path = write_stac(store_path, tmp_path / "catalog", title="Sahara")
    assert collection_path == tmp_path / "catalog" / "collection.json"
    assert item_path == tmp_path / "catalog" / "aoi_one-chronozarr-2" / "aoi_one-chronozarr-2.json"
    collection = json.loads(collection_path.read_text())
    item = json.loads(item_path.read_text())
    assert collection["title"] == "Sahara"
    href = item["assets"]["zarr"]["href"]
    assert not Path(href).is_absolute()
    assert (item_path.parent / href).resolve() == store_path.resolve()
    assert collection["id"] == item["id"] == "aoi_one-chronozarr-2"


def test_explicit_href_id_and_license(store_path, tmp_path):
    _, item_path = write_stac(
        store_path,
        tmp_path,
        href="https://data.example.org/aoi_one/chronozarr-2",
        id="custom",
        license="CC-BY-4.0",
        description="A test store.",
    )
    item = json.loads(item_path.read_text())
    assert item_path.name == "custom.json"
    assert item["assets"]["zarr"]["href"] == "https://data.example.org/aoi_one/chronozarr-2"
    collection = json.loads((tmp_path / "collection.json").read_text())
    assert collection["license"] == "CC-BY-4.0"
    assert collection["description"] == "A test store."


def test_default_id_from_paths_and_urls():
    assert default_id("https://data.tileripper.com/ucayali_santa_maria/chronozarr-2") == (
        "ucayali_santa_maria-chronozarr-2"
    )
    assert default_id("/tmp/stores/sahara/chronozarr") == "sahara-chronozarr"


def test_pystac_can_read_the_documents(store_path, tmp_path):
    pystac = pytest.importorskip("pystac")
    collection_path, item_path = write_stac(store_path, tmp_path / "catalog")
    collection = pystac.Collection.from_file(str(collection_path))
    (item,) = list(collection.get_items())
    assert item.id == collection.id
    assert item.assets["zarr"].media_type == ZARR_MEDIA_TYPE
    assert item.common_metadata.start_datetime is not None
    assert collection.extent.spatial.bboxes[0] == item.bbox
    assert np.isclose(item.properties["proj:transform"][0], 10.0)
    assert pystac.read_file(str(item_path)).id == item.id
