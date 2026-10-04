"""Synthetic inputs and independent reference implementations for chronozarr tests."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import xarray as xr

import chronozarr
from chronozarr.encode import EncodeReport

CRS = "EPSG:32631"
TRANSFORM = (10.0, 0.0, 746090.0, 0.0, -10.0, 2540440.0)
BANDS = ["B04", "B08"]


def make_truth(n_time: int, n_band: int, height: int, width: int, seed: int = 7) -> np.ndarray:
    """Smooth field plus noise, a drifting mean per timestep, and a nodata (0) corner."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    base = 2000 + 1500 * np.sin(yy / 90) * np.cos(xx / 70)
    truth = np.zeros((n_time, n_band, height, width), dtype=np.uint16)
    for t in range(n_time):
        for b in range(n_band):
            field = base * (1.0 + 0.8 * b) + 120 * t + rng.normal(0, 60, size=(height, width))
            truth[t, b] = np.clip(field, 1, 65535).astype(np.uint16)
    truth[:, :, height * 9 // 10 :, width * 9 // 10 :] = 0
    return truth


def make_times(n_time: int) -> np.ndarray:
    months = np.arange(n_time).astype("timedelta64[M]")
    return (np.datetime64("2024-01", "M") + months).astype("datetime64[ns]")


def make_da(truth: np.ndarray, bands: list[str] | None = None) -> xr.DataArray:
    n_time, n_band = truth.shape[:2]
    names = bands if bands is not None else [f"B{i:02d}" for i in range(n_band)]
    return xr.DataArray(
        truth,
        dims=("time", "band", "y", "x"),
        coords={"time": make_times(n_time), "band": names},
        attrs={"crs": CRS, "transform": TRANSFORM},
    )


def build_store(
    path: Path,
    truth: np.ndarray,
    *,
    shard: bool,
    chunk_size: int = 512,
    n_lods: int | None = None,
    **kwargs,
) -> EncodeReport:
    """Encode an ordinary-value v0.3 store."""
    kwargs.setdefault("volatility", True)
    return chronozarr.encode(
        make_da(truth, BANDS[: truth.shape[1]] if truth.shape[1] <= len(BANDS) else None),
        path,
        chunk_size=chunk_size,
        n_lods=n_lods,
        shard=shard,
        **kwargs,
    )


def reference_downsample(level: np.ndarray) -> np.ndarray:
    """Independent 2x block average of (time, band, y, x): loops, no shared code with encode."""
    n_time, n_band, height, width = level.shape
    out_h, out_w = -(-height // 2), -(-width // 2)
    out = np.zeros((n_time, n_band, out_h, out_w), dtype=np.uint16)
    for t in range(n_time):
        for b in range(n_band):
            for i in range(out_h):
                for j in range(out_w):
                    values = []
                    for di in (0, 1):
                        for dj in (0, 1):
                            y = min(2 * i + di, height - 1)  # edge replication for odd sizes
                            x = min(2 * j + dj, width - 1)
                            values.append(int(level[t, b, y, x]))
                    valid = [v for v in values if v != 0]
                    out[t, b, i, j] = sum(valid) // len(valid) if valid else 0
    return out


def reference_anchor_schedule(n_time: int, interval: int) -> dict[int, int]:
    """Brute force nearest anchor per non-anchor timestep; ties to the earlier anchor."""
    anchors = list(range(0, n_time, interval))
    return {
        t: min(anchors, key=lambda a: (abs(a - t), a)) for t in range(n_time) if t not in anchors
    }


def make_correlated(
    n_time: int, n_band: int, height: int, width: int, seed: int = 11
) -> np.ndarray:
    """A smooth scene that barely changes between timesteps."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    base = 3000 + 1200 * np.sin(yy / 40) * np.cos(xx / 30) + rng.normal(0, 150, (height, width))
    truth = np.empty((n_time, n_band, height, width), dtype=np.uint16)
    for t in range(n_time):
        for b in range(n_band):
            noise = rng.normal(0, 2, (height, width))
            truth[t, b] = np.clip(base * (1 + 0.3 * b) + 5 * t + noise, 1, 65535).astype(np.uint16)
    return truth


def make_independent(
    n_time: int, n_band: int, height: int, width: int, seed: int = 13
) -> np.ndarray:
    """Independent uniform noise per timestep: differencing cannot help."""
    rng = np.random.default_rng(seed)
    return rng.integers(1, 65535, size=(n_time, n_band, height, width), dtype=np.uint16)


def reference_reduce(
    level: np.ndarray,
    *,
    nodata: float | None,
    mask: np.ndarray | None = None,
    coverage: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Independent one-level reduction with per-pixel loops (no shared code with encode).

    `level` is (time, band, y, x); mask and coverage are (time, y, x). Data is the mean of the
    valid pixels of each 2x2 block (valid: mask == 1, else value != nodata, else all), integers
    floor-divided; mask is 1 if any pixel is valid; coverage is the rounded mean (sum + 2) // 4.
    Odd sizes replicate the last row and column.
    """
    n_time, n_band, height, width = level.shape
    out_h, out_w = -(-height // 2), -(-width // 2)
    is_float = level.dtype.kind == "f"
    data = np.zeros((n_time, n_band, out_h, out_w), dtype=level.dtype)
    out_mask = None if mask is None else np.zeros((n_time, out_h, out_w), dtype=np.uint8)
    out_cov = None if coverage is None else np.zeros((n_time, out_h, out_w), dtype=np.uint8)
    for t in range(n_time):
        for i in range(out_h):
            for j in range(out_w):
                ys = [min(2 * i + d, height - 1) for d in (0, 1)]
                xs = [min(2 * j + d, width - 1) for d in (0, 1)]
                pixels = [(y, x) for y in ys for x in xs]
                if out_mask is not None:
                    assert mask is not None
                    out_mask[t, i, j] = int(any(mask[t, y, x] for y, x in pixels))
                if out_cov is not None:
                    assert coverage is not None
                    out_cov[t, i, j] = (sum(int(coverage[t, y, x]) for y, x in pixels) + 2) // 4
                for b in range(n_band):
                    values = [level[t, b, y, x].item() for y, x in pixels]
                    if mask is not None:
                        ok = [bool(mask[t, y, x]) for y, x in pixels]
                    elif nodata is not None:
                        ok = [v != nodata for v in values]
                    else:
                        ok = [True] * 4
                    good = [v for v, keep in zip(values, ok, strict=True) if keep]
                    if not good:
                        data[t, b, i, j] = nodata if nodata is not None else 0
                    elif is_float:
                        data[t, b, i, j] = np.float32(sum(good) / len(good))
                    else:
                        data[t, b, i, j] = sum(good) // len(good)
    return data, out_mask, out_cov
