"""Static STAC Collection and Item for a chronozarr store.

The Item carries the Zarr asset, spatial and temporal extent, band metadata, the datacube
extension (`cube:dimensions`, `cube:variables`) and whatever provenance the store records, so a
STAC client can find and describe the store without opening it. Output is plain JSON files that
can sit next to the store in a bucket. Needs rasterio (`chronozarr[geo]`) to express the extent in
WGS84.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from pathlib import Path
from typing import Any

import numpy as np

from chronozarr import schema
from chronozarr.decode import ChronoStore, open_store
from chronozarr.doctor import is_url

STAC_VERSION = "1.1.0"
EXT_DATACUBE = "https://stac-extensions.github.io/datacube/v2.3.0/schema.json"
EXT_PROJECTION = "https://stac-extensions.github.io/projection/v2.0.0/schema.json"
EXT_EO = "https://stac-extensions.github.io/eo/v2.0.0/schema.json"
EXT_RASTER = "https://stac-extensions.github.io/raster/v2.0.0/schema.json"
ZARR_MEDIA_TYPE = "application/vnd+zarr"
_EDGE_POINTS = 21


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", text).strip("-") or "chronozarr-store"


def default_id(source: str) -> str:
    """`<parent>-<name>` of a store path or URL, e.g. `ucayali_santa_maria-chronozarr-2`."""
    if is_url(source):
        parts = [p for p in urllib.parse.urlsplit(source).path.split("/") if p]
    else:
        parts = list(Path(source).resolve().parts)
    return _slug("-".join(parts[-2:]))


def _epsg_number(crs: str) -> int | str:
    match = re.fullmatch(r"EPSG:(\d+)", crs)
    return int(match.group(1)) if match else crs


def _footprint(
    crs: str, bounds: tuple[float, float, float, float]
) -> tuple[list[list[float]], list[float]]:
    """WGS84 polygon ring and bbox of a native-CRS rectangle, with densified edges."""
    from rasterio.warp import transform

    left, bottom, right, top = bounds
    t = np.linspace(0.0, 1.0, _EDGE_POINTS)
    xs = np.concatenate([left + t * (right - left), np.full_like(t, right)])
    ys = np.concatenate([np.full_like(t, top), top + t * (bottom - top)])
    xs = np.concatenate([xs, right + t * (left - right), np.full_like(t, left)])
    ys = np.concatenate([ys, np.full_like(t, bottom), bottom + t * (top - bottom)])
    lon, lat = transform(crs, "EPSG:4326", xs.tolist(), ys.tolist())
    ring = [[round(x, 6), round(y, 6)] for x, y in zip(lon, lat, strict=True)]
    ring.append(ring[0])
    bbox = [
        round(min(lon), 6),
        round(min(lat), 6),
        round(max(lon), 6),
        round(max(lat), 6),
    ]
    return ring, bbox


def _band_objects(store: ChronoStore) -> list[dict[str, Any]]:
    data_type = str(store.levels[0].data.dtype)
    nodata = store.attrs.nodata
    out = []
    for band in store.attrs.bands:
        entry: dict[str, Any] = {"name": band if isinstance(band, str) else str(band.name)}
        if not isinstance(band, str):
            if getattr(band, "common_name", None):
                entry["eo:common_name"] = band.common_name
            if getattr(band, "scale", None) is not None:
                entry["raster:scale"] = band.scale
            if getattr(band, "offset", None) is not None:
                entry["raster:offset"] = band.offset
            if getattr(band, "units", None):
                entry["unit"] = band.units
        entry["data_type"] = data_type
        if nodata is not None:
            entry["nodata"] = nodata
        out.append(entry)
    return out


def _cube(store: ChronoStore, bounds: tuple[float, float, float, float]) -> tuple[dict, dict]:
    level = store.levels[0]
    left, bottom, right, top = bounds
    crs = _epsg_number(store.attrs.crs)
    times = list(store.attrs.times)
    dimensions = {
        "x": {
            "type": "spatial",
            "axis": "x",
            "extent": [left, right],
            "step": level.transform[0],
            "reference_system": crs,
        },
        "y": {
            "type": "spatial",
            "axis": "y",
            "extent": [bottom, top],
            "step": level.transform[4],
            "reference_system": crs,
        },
        "time": {
            "type": "temporal",
            "extent": [times[0], times[-1]],
            "values": times,
            "step": None,
        },
        "band": {"type": "bands", "values": list(store.bands)},
    }
    data_variable: dict[str, Any] = {
        "type": "data",
        "dimensions": ["time", "band", "y", "x"],
        "data_type": str(level.data.dtype),
        "description": "Pixel values of the store at pyramid level 0 (stored at the native "
        "resolution, 2x coarser per level).",
    }
    if store.attrs.nodata is not None:
        data_variable["nodata"] = store.attrs.nodata
    variables = {"data": data_variable}
    return dimensions, variables


def _source_links(provenance: Any) -> list[dict[str, str]]:
    sources = provenance.get("sources", []) if isinstance(provenance, dict) else []
    return [
        {"rel": "derived_from", "href": s, "type": "application/json"}
        for s in sources
        if isinstance(s, str) and s.startswith(("http://", "https://"))
    ]


def build_stac(
    store: ChronoStore,
    *,
    href: str,
    id: str,
    title: str | None = None,
    description: str | None = None,
    license: str = "proprietary",
    collection_href: str = "../collection.json",
    item_href: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The Collection and Item documents for `store`, whose Zarr root is at `href`."""
    level = store.levels[0]
    a, _, c, _, e, f = level.transform
    height, width = level.shape[2:]
    bounds = (c, f + e * height, c + a * width, f)  # left, bottom, right, top
    ring, bbox = _footprint(store.attrs.crs, bounds)
    times = list(store.attrs.times)
    dimensions, variables = _cube(store, bounds)
    bands = _band_objects(store)
    provenance = getattr(store.attrs, "provenance", None)
    provenance = provenance if isinstance(provenance, dict) else None
    text = description or (
        f"chronozarr time series: {len(times)} timesteps, {len(bands)} bands, "
        f"{abs(a):g} m pixels in {store.attrs.crs}, {len(store.levels)} pyramid levels."
    )
    asset = {
        "href": href,
        "type": ZARR_MEDIA_TYPE,
        "title": "chronozarr Zarr v3 store",
        "description": "Root of the store. Levels are the groups 0, 1, 2, ...; open it with "
        "chronozarr.open_store or the chronozarr viewer.",
        "roles": ["data"],
    }
    properties: dict[str, Any] = {
        "datetime": None,
        "start_datetime": times[0],
        "end_datetime": times[-1],
        "title": title or id,
        "proj:code": store.attrs.crs,
        "proj:shape": [height, width],
        "proj:transform": [a, 0.0, c, 0.0, e, f, 0.0, 0.0, 1.0],
        "proj:bbox": list(bounds),
        "bands": bands,
        "cube:dimensions": dimensions,
        "cube:variables": variables,
        "chronozarr:spec_version": store.attrs.spec_version,
        "chronozarr:zarr_conventions": [
            schema.registration(n) for n in ("multiscales", "proj", "spatial")
        ],
        "chronozarr:levels": [
            {
                "path": str(lv.index),
                "resolution": lv.resolution,
                "shape": list(lv.shape),
                "grid": list(lv.grid),
            }
            for lv in store.levels
        ],
    }
    if provenance is not None:
        properties["chronozarr:provenance"] = provenance

    extensions = [EXT_DATACUBE, EXT_PROJECTION]
    if any("eo:common_name" in b for b in bands):
        extensions.append(EXT_EO)
    if any("raster:scale" in b for b in bands):
        extensions.append(EXT_RASTER)

    item_name = item_href or f"./{id}.json"
    item: dict[str, Any] = {
        "type": "Feature",
        "stac_version": STAC_VERSION,
        "stac_extensions": extensions,
        "id": id,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "bbox": bbox,
        "properties": properties,
        "links": [
            {"rel": "self", "href": item_name, "type": "application/geo+json"},
            {"rel": "root", "href": collection_href, "type": "application/json"},
            {"rel": "parent", "href": collection_href, "type": "application/json"},
            {"rel": "collection", "href": collection_href, "type": "application/json"},
            *_source_links(provenance),
        ],
        "assets": {"zarr": asset},
        "collection": id,
    }
    collection: dict[str, Any] = {
        "type": "Collection",
        "stac_version": STAC_VERSION,
        "stac_extensions": [EXT_DATACUBE],
        "id": id,
        "title": title or id,
        "description": text,
        "license": license,
        "extent": {
            "spatial": {"bbox": [bbox]},
            "temporal": {"interval": [[times[0], times[-1]]]},
        },
        "summaries": {"proj:code": [store.attrs.crs]},
        "cube:dimensions": dimensions,
        "cube:variables": variables,
        "links": [
            {"rel": "self", "href": "./collection.json", "type": "application/json"},
            {"rel": "root", "href": "./collection.json", "type": "application/json"},
            {"rel": "item", "href": f"./{id}/{id}.json", "type": "application/geo+json"},
            *_source_links(provenance),
        ],
    }
    return collection, item


def write_stac(
    store: ChronoStore | str | Path,
    out_dir: str | Path,
    *,
    href: str | None = None,
    id: str | None = None,
    title: str | None = None,
    description: str | None = None,
    license: str = "proprietary",
) -> tuple[Path, Path]:
    """Write `collection.json` and `<id>/<id>.json` under `out_dir`; returns both paths.

    `store` is an opened store, a local path or an https URL. `href` is where the Zarr asset
    lives for consumers: default the URL itself, or for a local store the relative path from the
    Item file to the store directory. Existing STAC files are overwritten.
    """
    source = store.source if isinstance(store, ChronoStore) else str(store)
    opened = store if isinstance(store, ChronoStore) else open_store(store)
    stac_id = id or default_id(source)
    out = Path(out_dir)
    item_dir = out / stac_id
    item_dir.mkdir(parents=True, exist_ok=True)
    if href is None:
        href = (
            source
            if is_url(source)
            else Path(os.path.relpath(Path(source).resolve(), item_dir.resolve())).as_posix()
        )
    collection, item = build_stac(
        opened,
        href=href,
        id=stac_id,
        title=title,
        description=description,
        license=license,
        item_href=f"./{stac_id}.json",
    )
    collection_path = out / "collection.json"
    item_path = item_dir / f"{stac_id}.json"
    for path, document in ((collection_path, collection), (item_path, item)):
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return collection_path, item_path
