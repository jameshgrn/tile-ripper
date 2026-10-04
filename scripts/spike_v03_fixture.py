"""Hand-built ordinary-value v0.3 reader fixture; no chronozarr writer imports.

Run: uv run python scripts/spike_v03_fixture.py
The output is disposable and gitignored. Existing output is never overwritten.
"""

import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import zarr
from zarr.codecs import ZstdCodec

PINS = {
    "multiscales": (
        "9b78efa75fef0fed302d9cf880037c569354d860",
        "d35379db-88df-4056-af3a-620245f8e347",
    ),
    "proj": ("5ca5b2f92e5c7245f957d9128b289ee535f0720d", "f17cb550-5864-4468-aeb7-f3180cfb622f"),
    "spatial": (
        "54d81b7ced0376e63ee10f34db31db7d08dcc28d",
        "689b58e2-cf7b-45e0-9fff-9cfc0883d6b4",
    ),
}
TIMES = ["2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z"]


def registration(name):
    _, uuid = PINS[name]
    return dict(
        name=name,
        uuid=uuid,
        schema_url=f"https://raw.githubusercontent.com/zarr-conventions/{name}/refs/tags/v0.1/schema.json",
        spec_url=f"https://github.com/zarr-conventions/{name}/blob/v0.1/README.md",
    )


def build(path):
    if path.exists():
        raise FileExistsError(f"{path} already exists; choose --output for another fixture")
    root = zarr.open_group(path, mode="w", zarr_format=3)
    # Each 2x2 block is constant, making the independently known overview exact.
    base = (np.arange(16).reshape(4, 4) + 1).astype("uint16")
    coarse = np.stack([np.stack([base + t * 1000 + b * 100 for b in range(2)]) for t in range(3)])
    fine = coarse.repeat(2, -2).repeat(2, -1)
    masks = np.ones((3, 8, 8), dtype="uint8")
    masks[:, 6:, 6:] = 0
    fine[:, :, 6:, 6:] = 0
    coarse[:, :, 3, 3] = 0
    levels = []
    for k, data in enumerate([fine, coarse]):
        size = data.shape[-1]
        res = 10 * 2**k
        transform = [res, 0, 500000, 0, -res, 4500000]
        group = root.create_group(str(k))
        group.attrs.update(dict(resolution=res, transform=transform, crs="EPSG:32618"))
        geo = {
            "zarr_conventions": [registration("proj"), registration("spatial")],
            "proj:code": "EPSG:32618",
            "spatial:dimensions": ["y", "x"],
            "spatial:transform_type": "affine",
            "spatial:registration": "pixel",
            "spatial:transform": transform,
            "spatial:shape": [size, size],
            "spatial:bbox": [500000, 4499920, 500080, 4500000],
        }
        mask = masks if k == 0 else masks.reshape(3, 4, 2, 4, 2).max(axis=(2, 4))
        for name, values, dims, chunks in [
            ("data", data, ["time", "band", "y", "x"], (1, 2, 8, 8)),
            ("mask", mask, ["time", "y", "x"], (1, 8, 8)),
        ]:
            arr = group.create_array(
                name,
                data=values,
                chunks=chunks,
                dimension_names=dims,
                compressors=[ZstdCodec(level=5)],
                fill_value=0,
            )
            arr.attrs.update({**geo, "_ARRAY_DIMENSIONS": dims})
        coords = {
            "time": np.array([t.removesuffix("Z") for t in TIMES], dtype="datetime64[ms]").astype(
                "int64"
            ),
            "band": np.array([0, 1], dtype="int32"),
            "x": 500000 + (np.arange(size) + 0.5) * res,
            "y": 4500000 - (np.arange(size) + 0.5) * res,
        }
        for name, values in coords.items():
            arr = group.create_array(
                name,
                data=values,
                chunks=values.shape,
                dimension_names=[name],
                compressors=[ZstdCodec(level=5)],
            )
            arr.attrs["_ARRAY_DIMENSIONS"] = [name]
            if name == "time":
                arr.attrs.update(
                    units="milliseconds since 1970-01-01T00:00:00", calendar="proleptic_gregorian"
                )
            if name in ("x", "y"):
                arr.attrs.update(
                    axis=name.upper(), standard_name=f"projection_{name}_coordinate", units="m"
                )
        levels.append(
            dict(
                path=str(k),
                resolution=res,
                transform=transform,
                shape=list(data.shape),
                grid=[1, 1],
            )
        )
    root.attrs.update(
        {
            "zarr_conventions": [
                registration("multiscales"),
                {
                    "name": "chronozarr",
                    "spec_url": "https://github.com/chronozarr/chronozarr/blob/main/spec/CHRONOZARR.md",
                    "description": (
                        "Experimental v0.3 profile; not a published normative specification"
                    ),
                },
            ],
            "multiscales": {
                "layout": [
                    {"asset": "0"},
                    {
                        "asset": "1",
                        "derived_from": "0",
                        "transform": {"scale": [2, 2], "translation": [0, 0]},
                    },
                ],
                "resampling_method": "average",
            },
            "chronozarr": {
                "spec_version": "0.3.0",
                "variable": "data",
                "times": TIMES,
                "bands": [
                    {"name": name, "scale": 1, "offset": 0, "units": "1"}
                    for name in ["red", "nir"]
                ],
                "band_names": ["red", "nir"],
                "crs": "EPSG:32618",
                "nodata": None,
                "mask_variable": "mask",
                "levels": levels,
            },
        }
    )
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", message="Consolidated metadata is currently")
        zarr.consolidate_metadata(path)
    print(
        json.dumps(
            {
                "store": str(path),
                "zarr": zarr.__version__,
                "known": {
                    "0/data[0,0,0,0]": 1,
                    "0/data[1,1,2,4]": 1107,
                    "0/data[2,0,5,1]": 2009,
                    "1/data[2,1,2,0]": 2109,
                    "0/mask[2,7,7]": 0,
                    "1/mask[2,3,3]": 0,
                },
            },
            indent=2,
        )
    )


CHECKS = [
    ("0/data", (0, 0, 0, 0), 1),
    ("0/data", (1, 1, 2, 4), 1107),
    ("0/data", (2, 0, 5, 1), 2009),
    ("1/data", (2, 1, 2, 0), 2109),
    ("0/mask", (2, 7, 7), 0),
    ("1/mask", (2, 3, 3), 0),
]


def verify(path, node_project=None):
    """Force numeric reads; CRS metadata retention is not semantic recognition."""
    import shutil
    import subprocess
    import tempfile

    import xarray as xr

    print("xarray", xr.__version__)
    root = zarr.open_group(path, mode="r")
    assert sorted(root.group_keys()) == ["0", "1"]
    assert not xr.open_zarr(path, chunks=None).data_vars
    for k in ("0", "1"):
        ds = xr.open_zarr(path, group=k, chunks=None)
        res = 10 * 2 ** int(k)
        np.testing.assert_array_equal(ds.x, 500000 + (np.arange(ds.sizes["x"]) + 0.5) * res)
        np.testing.assert_array_equal(ds.y, 4500000 - (np.arange(ds.sizes["y"]) + 0.5) * res)
        for name, index, expected in CHECKS:
            if name.startswith(k + "/"):
                assert int(root[name][index]) == expected
                assert int(ds[name.split("/")[1]].values[index]) == expected
        ds.close()
    print("zarr / xarray: all six samples and both coordinate grids match")
    if shutil.which("gdalinfo"):
        print(subprocess.check_output(["gdalinfo", "--version"], text=True).strip())
        for name, index, expected in CHECKS:
            selection = ":".join(map(str, index[:-2]))
            dataset = f'ZARR:"{path}":/{name}:{selection}'
            got = subprocess.check_output(
                [
                    "gdal_translate",
                    "-q",
                    "-srcwin",
                    str(index[-1]),
                    str(index[-2]),
                    "1",
                    "1",
                    "-of",
                    "XYZ",
                    dataset,
                    "/vsistdout/",
                ],
                text=True,
            )
            assert float(got.split()[-1]) == expected
        for k in (0, 1):
            info = json.loads(
                subprocess.check_output(
                    ["gdalinfo", "-json", f'ZARR:"{path}":/{k}/data:0:0'], text=True
                )
            )
            assert info["geoTransform"] == [500000, 10 * 2**k, 0, 4500000, 0, -10 * 2**k]
            print(
                "GDAL level",
                k,
                "CRS",
                info.get("coordinateSystem"),
                "overviews",
                info["bands"][0].get("overviews"),
            )
    if node_project:
        # Place the temporary harness beside its external npm dependencies.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".mjs", dir=node_project) as harness:
            harness.write(NODE_CHECK)
            harness.flush()
            subprocess.run(["node", harness.name, str(path.resolve())], check=True)


NODE_CHECK = r"""
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as zarr from 'zarrita';
import {ZarrLayer} from '@carbonplan/zarr-layer';
import proj4 from 'proj4';
const dir = process.argv[2];
const store = {async get(key) {
  try { return new Uint8Array(await readFile(dir + key)); }
  catch(e) { if(e.code === 'ENOENT') return undefined; throw e; }
}};
const checks = [
  ['0/data', [0,0,0,0], 1], ['0/data', [1,1,2,4], 1107],
  ['0/data', [2,0,5,1], 2009], ['1/data', [2,1,2,0], 2109],
  ['0/mask', [2,7,7], 0], ['1/mask', [2,3,3], 0]
];
for(const [path,index,want] of checks) {
  const a = await zarr.open(zarr.root(store).resolve(path), {kind:'array'});
  assert.equal(await zarr.get(a,index), want);
}
const layer = new ZarrLayer({
  id:'spike', store, variable:'data', zarrVersion:3,
  spatialDimensions:{lat:'y',lon:'x'}, colormap:[[0,0,0],[255,255,255]],
  clim:[0,2200], selector:{time:1,band:1}
});
await layer.initialize();
const desc = layer.zarrStore.describe();
assert.deepEqual(desc.levelAssets, ['0','1']);
assert.equal(desc.proj4, 'EPSG:32618');
assert.equal(desc.latIsAscending, false);
assert.deepEqual(desc.xyLimits,
  {xMin:500000,xMax:500080,yMin:4499920,yMax:4500000});
const origin = proj4(desc.proj4, 'EPSG:4326', [500000,4500000]);
assert.ok(Math.abs(origin[0] + 75) < 1e-9);
assert.ok(Math.abs(origin[1] - 40.65085651557158) < 1e-9);
for(const [path,index,want] of checks.filter(c => c[0].endsWith('data'))) {
  const a = await layer.zarrStore.getLevelArray(path.split('/')[0]);
  assert.equal(await zarr.get(a,index), want);
}
console.log('zarrita: six samples match; zarr-layer: four data samples match');
console.log('layer CRS/extent/levels', desc.crs, desc.proj4, desc.xyLimits,
  desc.levelAssets, 'UTM origin lonlat', origin);
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/spike/v03"
    )
    parser.add_argument(
        "--verify", action="store_true", help="Check an existing fixture instead of building"
    )
    parser.add_argument(
        "--node-project", type=Path, help="External npm project containing the pinned readers"
    )
    args = parser.parse_args()
    if args.verify:
        verify(args.output, args.node_project)
    else:
        build(args.output)
