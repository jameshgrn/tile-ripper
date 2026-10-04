"""Build the small illustrative homepage RGB images from the local demo store.

Run from the repository root: uv run python site/scripts/make-previews.py
Requires Pillow in the environment. Does not modify the source store.
"""
from pathlib import Path

import numpy as np
from PIL import Image

import chronozarr

ROOT = Path(__file__).resolve().parents[2]
store = chronozarr.open_store(ROOT / "data/stores/ucayali_santa_maria/chronozarr-4")
for date, name in [("2016-08", "2016"), ("2020-08", "2020"), ("2025-08", "2025")]:
    t = next(i for i, value in enumerate(store.times) if str(value).startswith(date))
    # R, G, B = B04, B03, B02. Level 3 is a block-mean overview.
    bands = [list(store.bands).index(band) for band in ["B04", "B03", "B02"]]
    rgb = store.read(t, lod=3)[bands].transpose(1, 2, 0)
    # Fixed display stretch for all dates; these images are not numeric exports.
    rgb = np.uint8(np.clip(np.power(np.clip(rgb / 3000.0, 0, 1), 1 / 1.6) * 255, 0, 255))
    image = Image.fromarray(rgb)
    image.thumbnail((520, 520))
    image.save(ROOT / f"site/docs/public/ucayali-{name}.webp", quality=85)
