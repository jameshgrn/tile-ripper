# PNG frames to a store

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

The measurements below describe historical v0.2 artifacts, not current writer options. Convert those stores before opening them with v0.3 libraries.

A sequence of georeferenced PNGs, one per date, becomes a scrubbable chronozarr store with
`chronozarr convert`. There is no GeoTIFF step. The frames are what exporters hand over: Earth Engine
thumbnails, QGIS "Save as image" (with its world file option), matplotlib figures, drone and
orthomosaic pipelines. `convert` reads them with GDAL, so everything it does for COGs applies:
manifest, time order, `--dry-run`, `--resume`, validity rules, the pyramid.

The store holds exactly the values in the PNGs. A rendered image is display values, not
measurements; see "Limits" before using one for anything but looking.

## Locating the frames

A PNG carries no georeferencing of its own. GDAL finds it in a sidecar file next to the frame, and
`convert` needs one of three things:

| Frame has | Holds | `convert` also needs |
|---|---|---|
| `2019-01.pgw` (or `.wld`) world file | the transform, no CRS | `--crs EPSG:xxxxx` |
| `2019-01.png.aux.xml` | the CRS and the geotransform | nothing |
| neither | nothing | `--crs EPSG:xxxxx` and `--bounds west,south,east,north` |

```bash
# a world file per frame: the transform is there, the CRS is not
uv run chronozarr convert frames/manifest.csv out --crs EPSG:32718

# an .aux.xml per frame (GDAL writes one when it copies a georeferenced raster to PNG)
uv run chronozarr convert frames/manifest.csv out

# no sidecar: say where the frames are
uv run chronozarr convert frames/manifest.csv out --crs EPSG:32718 \
    --bounds 498450,9151960,508690,9162200
```

The manifest is the usual one: `uri,datetime` rows in CSV (or JSON), relative URIs resolved against
the manifest's folder.

Details:

- With both sidecars on one frame, GDAL takes the transform from the world file and the CRS from the
  `.aux.xml`.
- A world file gives the *centre* of the upper-left pixel. GDAL accounts for that; nothing for you to
  do. `--bounds` is the other way: it takes the outer edges of the image.
- `--crs` has two jobs, as for COGs: it is the target CRS, and it is the CRS of any frame that
  declares none. If the frames carry a CRS and `--crs` names a different one, the frames are warped
  (`--resampling` required).
- The sidecars of `http(s)` PNGs are found too, at the cost of a few extra requests per frame.
- A frame with a geotransform but no CRS and no `--crs` fails and names the first such frame. A frame
  with no georeferencing at all fails and lists the three fixes above.

### `--bounds`

`--bounds west,south,east,north` (units of `--crs`: metres for UTM, degrees for EPSG:4326) is the extent
of every frame, edge to edge. `convert` derives the north-up transform from each frame's pixel size:
`(east - west) / width` by `(north - south) / height`, so pixels need not be square. In a JSON
manifest the same extent can sit at the top level:

```json
{"bounds": [498450, 9151960, 508690, 9162200], "items": [{"uri": "2019-01.png", "datetime": "2019-01-01"}]}
```

Give it once, not in both places. It is refused when:

- `--crs` is missing;
- west is not less than east, or south not less than north;
- a frame has a different size from the first (the same extent over a different pixel count would be a
  different pixel size, which would be a guess);
- a frame carries its own geotransform (a world file or `.aux.xml`): drop `--bounds` or remove the
  sidecar;
- a frame declares a CRS that is not `--crs`.

Check that the extent you pass is the extent of the rendered image. An exporter that pads or crops the
region you asked for has moved every pixel by that amount, and nothing in the PNG can tell `convert`.

## What the frames become

| In the PNG | In the store |
|---|---|
| red, green, blue channels | bands `red`, `green`, `blue` with those `common_name`s, scale 1, offset 0, no units |
| alpha channel (RGBA, gray + alpha) | the `mask` variable, 1 where alpha is nonzero; not a data band |
| gray channel | band `1` |
| 8-bit values | `uint8` data; the viewer shows them as they are |
| palette (indexed colour) | refused, see below |

The viewer picks products by band name, so the three colour bands enable True color. False color,
NDVI, NDWI and Water need a near-infrared band and stay off; Single band is available.

Alpha rule. Alpha wins over everything else, as in GDAL: a pixel is valid where alpha is nonzero. A
partly transparent pixel (alpha 128) is valid and is drawn fully opaque, because the mask is 0 or 1. The
RGB values under alpha 0 are kept in the store, hidden by the mask. Without an alpha channel the store has
no mask and no nodata: every pixel is valid, a stored 0 is data.

Palette rule. A palette PNG fails with the way to expand it:

```
cannot open source .../frame.png: it is a palette (indexed colour) PNG, so its values are palette
indices, not colours. Expand it to RGB first, for example `gdal_translate -expand rgba in.png out.png`,
or save the frames as RGB
```

Expanding silently was the alternative. It was not chosen because the indices of a classified map are
the data, and the converter cannot tell a class map from a picture. This applies to PNG only: a GeoTIFF
with a colour table is converted with its indices as the values, as before.

Band names can still be given in the manifest (`bands` column or key); they replace `red`, `green`,
`blue` and drop the common names.

## Worked example: Ucayali, 36 months

`examples/png_frames/` turns the Sentinel-2 monthly mosaics already in `data/mosaics/` into frames, the
way an exporter would, then converts them:

```bash
uv run python examples/png_frames/render_frames.py      # 36 PNGs + world files + manifest
examples/png_frames/convert.sh                          # convert --crs EPSG:32718, then validate
uv run python examples/png_frames/check_store.py        # every frame bit-exact in the store
cd js && node ../examples/png_frames/viewer_check.mjs   # headless viewer, repo served on :8000
```

The convert step is one command:

```bash
uv run chronozarr convert data/png_frames/ucayali/manifest.csv \
    data/stores/ucayali_santa_maria/png-1 --crs EPSG:32718
```

What the frames are:

- 2019-01 to 2021-12, a 1024 x 1024 pixel window (row 768, column 1280) of the 2765 x 2759 mosaic,
  10 m pixels, EPSG:32718, 8-bit RGBA: red = B04, green = B03, blue = B02.
- Alpha 0 where the mosaic's `coverage` is 0 (no valid scene that month), with RGB set to 0 there.
  The masked share of a frame runs from 0 to 76.8 %; 6 of the 36 frames are over 3 % masked.
- One fixed linear stretch for all frames: DN 185 to 1758 mapped to 0 to 255, the 2nd and 98th
  percentile of the valid red, green and blue values of the whole series. It is not the viewer's tone
  mapping, which works on reflectance. Because it is the same for every month, brightness compares
  across months.

Sizes and times (M3 Max laptop, other work running):

| | |
|---|---|
| Frames on disk | 74.7 MB for 36 PNGs (2.08 MB each; raw RGBA is 4.19 MB), GDAL's default PNG compression |
| Raw in the store | 113.2 MB bands + 37.7 MB mask |
| Store | 112.9 MB in 35 files: level 0 89.6 MB, level 1 23.2 MB (the masks, 0.23 MB, are inside those) |
| `convert` | read 0.5 s, encode 1.0 s, 1.5 s in all |
| Storage | True-value arrays; v0.3 does not select temporal encoding |

The store is 1.5 times the size of the PNGs: level 1 is a quarter of level 0, and PNG's row filters
compress rendered imagery better than zstd on the raw bytes (level 0 alone is 1.2 times the PNGs). What
the store adds is random access and a pyramid, not compression.

Checks that were run on `png-1`:

- `chronozarr validate`: conforms to chronozarr 0.2.0. `chronozarr doctor` on the local path: 3 ok,
  0 info, 0 warning, 0 failure.
- `check_store.py`: for all 36 frames the store's red, green, blue and mask equal the PNG's red, green,
  blue and alpha != 0, bit for bit.
- The same frames without world files, converted with `--crs EPSG:32718 --bounds
  498450,9151960,508690,9162200`, and with an `.aux.xml` per frame and no `--crs`, give stores identical to
  `png-1` in data, mask and transform.
- Headless viewer (software WebGL): True color is the active product and the only colour product enabled
  (False color, NDVI, NDWI and Water are disabled); a masked pixel is drawn as the background colour
  (9, 12, 18) and the valid pixel six pixels to its right is drawn as the stored colour; a click reads
  the stored `red`, `green`, `blue` values (200, 238, 184 at pixel 154, 43 of 2019-10, which is what the
  PNG holds there); playback buffers, steps through six timesteps and stops. No console errors.
  Screenshots: `data/reports/viewer_ucayali_png_truecolor.png` (2019-10, 38 % masked) and
  `data/reports/viewer_ucayali_png_edge.png` (the masked edge at 8x with the inspector open).

## Limits

- Display values. A rendered PNG is not reflectance: the store has no units and scale 1, so the index
  products stay off and no value in it is a measurement. If the data behind the picture matters, convert
  the data (COGs, Zarr), not its rendering.
- Eight bits. Each channel has 256 levels. The exporter's stretch is baked in: whatever it clipped or
  compressed is gone, and the viewer does not stretch 8-bit colour, it shows it as it is.
- Pyramid levels are block means of the stored values, an average of display values, which is fine for
  browsing and wrong for radiometry.
- The mask is binary. Soft alpha (anti-aliased edges, a feathered mosaic seam) becomes opaque wherever
  alpha is above 0.
- One grid for the series. `--bounds` needs every frame the same size. Frames with different world files
  or sizes are warped onto the first frame's grid with `--resampling`, as COGs are, and warped pixels
  with no source are masked.
- PNG is read whole, top to bottom, with no tiles or overviews. A 1024 x 1024 frame reads in about
  0.03 s; memory during staging is a few frames, so a very large PNG costs its raw size times
  `1 + --read-ahead`.
- Sidecar probing is on for `.png` URIs only. Other image formats (JPEG with `.jgw`) are not covered,
  and 16-bit and 1 to 4-bit PNGs are not tested; only 8-bit gray, gray + alpha, RGB and RGBA are.
- World files and `.aux.xml` next to `http(s)` PNGs were checked against a local range server, not a CDN.
