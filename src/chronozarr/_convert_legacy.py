"""Explicit local v0.2 importer. Legacy interpretation never enters baseline readers."""

from __future__ import annotations

import json
import shutil
import time
import warnings
from pathlib import Path
from typing import Any, cast

import numpy as np
import zarr
from zarr.errors import ZarrUserWarning

from chronozarr import schema
from chronozarr._convert_source import Grid, Source, SourceInfo, Step
from chronozarr._writer import _mean_comparison, _shard_bytes
from chronozarr.encode import EncodeReport, LevelReport, _tree_stats


def legacy_metadata(path: str | Path) -> dict[str, Any] | None:
    """Detect chronozarr without asking the v0.3-only reader to open it."""
    manifest = Path(path) / "zarr.json"
    if not manifest.is_file():
        return None
    return json.loads(manifest.read_text()).get("attributes", {}).get("chronozarr")


class LegacySource(Source):
    kind = "chronozarr v0.2"

    def __init__(self, path: str | Path) -> None:
        self.warped: frozenset[int] = frozenset()
        self.path = Path(path)
        self.root = zarr.open_group(self.path, mode="r", use_consolidated=False)
        self.meta = cast("dict[str, Any]", self.root.attrs["chronozarr"])
        version = self.meta.get("spec_version")
        if not isinstance(version, str) or not version.startswith("0.2."):
            raise ValueError(f"legacy conversion requires v0.2, got {version!r}")
        self.times = [schema.parse_time(t) for t in self.meta["times"]]
        bands = schema.parse_bands(self.meta["bands"], "legacy bands")
        self.groups = [
            schema.get_group(self.root, d["path"], "legacy")
            for d in cast("Any", self.root.attrs["multiscales"])[0]["datasets"]
        ]
        if [g.name.removeprefix("/") for g in self.groups] != [
            str(i) for i in range(len(self.groups))
        ]:
            raise ValueError("legacy levels must be consecutive")
        self.data = [schema.get_array(g, self.meta["variable"], "legacy") for g in self.groups]
        level = schema.parse_level_attrs(self.groups[0].attrs.asdict(), "legacy level 0")
        self.info = SourceInfo(
            Grid(level.crs, level.transform, self.data[0].shape[2], self.data[0].shape[3]),
            len(bands),
            self.data[0].dtype,
            self.meta["nodata"],
            tuple(b.name for b in bands),
            bands,
            self.meta.get("mask_variable") is not None,
            "legacy validity preserved",
        )
        temporal = self.meta["temporal"]
        self.encoding = temporal["encoding"]
        self.reference: dict[int, int] = {}
        if self.encoding == "star-delta":
            if self.info.dtype.name not in ("uint8", "uint16"):
                raise ValueError("legacy star-delta requires unsigned data")
            interval = temporal["anchor_interval"]
            anchors = temporal["anchor_indices"]
            if (
                not isinstance(interval, int)
                or interval < 1
                or anchors != list(range(0, len(self.times), interval))
            ):
                raise ValueError("invalid legacy anchor schedule")
            self.reference = {int(t): int(a) for t, a in temporal["delta_reference"].items()}
            if set(self.reference) != set(range(len(self.times))) - set(anchors) or any(
                a not in anchors or abs(t - a) >= interval for t, a in self.reference.items()
            ):
                raise ValueError("invalid legacy reference map")
        elif self.encoding != "none":
            raise ValueError(f"unsupported legacy encoding {self.encoding!r}")

    def values(self, k: int, t: int, ys: slice, xs: slice) -> np.ndarray:
        raw = np.asarray(self.data[k][t, :, ys, xs])
        if t in self.reference:
            return np.add(raw, np.asarray(self.data[k][self.reference[t], :, ys, xs]))
        return raw

    def read(self, t: int) -> Step:
        mask = self.meta.get("mask_variable")
        return Step(
            self.values(0, t, slice(None), slice(None)),
            None
            if mask is None
            else np.asarray(schema.get_array(self.groups[0], mask, "legacy")[t]),
        )

    def fingerprint(self) -> dict[str, Any]:
        return {"source": str(self.path.resolve()), "metadata": self.meta}


def migrate(source: LegacySource, out: Path, progress: Any = None) -> EncodeReport:
    """Copy plain chunks; rewrite encoded data without recomputing any overview pixels.

    Compare every cell/time/band/plane and coordinate before returning success. Originals stay
    untouched. A failed destination is removed, so it cannot be mistaken for a valid migration.
    """
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f"{out} is not empty; choose a new destination")
    if out.resolve() == source.path.resolve() or source.path.resolve() in out.resolve().parents:
        raise ValueError("conversion destination must be outside the source store")
    summaries = []
    reports = []
    started = time.perf_counter()
    try:
        shutil.copytree(source.path, out, dirs_exist_ok=True)
        root = zarr.open_group(out, mode="r+", use_consolidated=False)
        for k, original in enumerate(source.data):
            group = schema.get_group(root, str(k), "destination")
            # Drop any embedded child consolidated copy before updating its arrays.
            group.update_attributes(
                schema.parse_level_attrs(source.groups[k].attrs.asdict(), "legacy").to_attrs()
            )
            attrs = schema.parse_level_attrs(group.attrs.asdict(), "destination")
            cs = schema.cell_size(original, "legacy data")
            h, w = original.shape[2:]
            grid = schema.grid_shape(h, w, cs)
            target = schema.get_array(group, source.meta["variable"], "destination")
            if source.encoding == "star-delta":
                # Read every timestep of a cell before rewriting, independent of shard boundaries.
                for r in range(grid[0]):
                    for c in range(grid[1]):
                        ys, xs = (
                            slice(r * cs, min((r + 1) * cs, h)),
                            slice(c * cs, min((c + 1) * cs, w)),
                        )
                        values = np.stack(
                            [source.values(k, t, ys, xs) for t in range(len(source.times))]
                        )
                        target[:, :, ys, xs] = values
            for name, dims in (
                (source.meta["variable"], schema.DIMENSIONS),
                (source.meta.get("mask_variable"), schema.PLANE_DIMENSIONS),
                (source.meta.get("coverage_variable"), schema.PLANE_DIMENSIONS),
            ):
                if name is not None:
                    array = schema.get_array(group, name, "destination")
                    new_attrs = schema.data_array_attrs(
                        attrs.crs,
                        attrs.transform,
                        h,
                        w,
                        source.info.nodata if name == source.meta["variable"] else None,
                        dimensions=dims,
                    )
                    array.update_attributes(new_attrs)
            summaries.append(
                schema.LevelSummary(
                    str(k),
                    attrs.resolution,
                    attrs.transform,
                    cast("tuple[int, int, int, int]", tuple(target.shape)),
                    grid,
                )
            )
            reports.append(
                LevelReport(
                    k,
                    cast("tuple[int, int, int, int]", tuple(target.shape)),
                    grid[0] * grid[1],
                    0,
                    0,
                    time.perf_counter() - started,
                    _tree_stats(out / str(k))[0],
                )
            )
        meta = schema.Chronozarr(
            times=tuple(source.meta["times"]),
            bands=source.info.bands,
            crs=source.info.grid.crs,
            variable=source.meta["variable"],
            nodata=source.info.nodata,
            mask_variable=source.meta.get("mask_variable"),
            coverage_variable=source.meta.get("coverage_variable"),
            provenance=source.meta.get("provenance"),
            levels=tuple(summaries),
            volatility_path=source.meta.get("volatility_path"),
            shard_bytes=_shard_bytes(out, len(summaries), source.meta["variable"])
            if source.data[0].shards is not None
            else None,
        )
        if meta.volatility_path is not None:
            vol = schema.get_array(root, meta.volatility_path, "destination")
            cs = schema.cell_size(source.data[0], "source")
            reference = schema.comparison_schedule(len(source.times))
            values = np.zeros(vol.shape, dtype=np.float32)
            first = schema.get_array(
                schema.get_group(root, "0", "destination"), meta.variable, "destination"
            )
            for r in range(values.shape[0]):
                for c in range(values.shape[1]):
                    total, count = _mean_comparison(
                        np.asarray(first[:, :, r * cs : (r + 1) * cs, c * cs : (c + 1) * cs]),
                        reference,
                    )
                    values[r, c] = np.clip(total / count / 10000, 0, 1) if count else 0
            vol[:] = values
        root.update_attributes(
            schema.RootAttrs(
                meta, tuple(schema.LevelRef(str(k), meta.crs) for k in range(len(summaries)))
            ).to_attrs()
        )
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ZarrUserWarning)
            zarr.consolidate_metadata(out)
        problems = schema.validate(out)
        if problems:
            raise ValueError("migration validation failed: " + "; ".join(problems))
        verify(source, root, progress)
        size, files = _tree_stats(out)
        compression = schema._compression_config(source.data[0])
        config = compression.get("configuration", {})
        return EncodeReport(
            tuple(reports),
            size,
            files,
            compression["name"],
            int(config.get("level", config.get("clevel", 0))),
        )
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        raise


def verify(source: LegacySource, destination: zarr.Group, progress: Any = None) -> None:
    """Exhaustive source/output comparison, including invalid stored pixels and overviews."""
    meta = schema.parse_root_attrs(destination.attrs.asdict()).chronozarr
    for key in (
        "times",
        "bands",
        "nodata",
        "crs",
        "mask_variable",
        "coverage_variable",
        "provenance",
    ):
        expected = source.meta.get(key)
        if meta.to_attrs().get(key) != expected:
            raise ValueError(f"migration changed {key}")
    for k, original in enumerate(source.data):
        group = schema.get_group(destination, str(k), "destination")
        target = schema.get_array(group, meta.variable, "destination")
        if original.shape != target.shape or original.dtype != target.dtype:
            raise ValueError(f"migration changed level {k} shape or dtype")
        cs = schema.cell_size(original, "legacy")
        grid = schema.grid_shape(original.shape[2], original.shape[3], cs)
        for name in ("time", "band", "x", "y"):
            before = schema.get_array(source.groups[k], name, "legacy")
            after = schema.get_array(group, name, "destination")
            if before.dtype != after.dtype or not np.array_equal(before[:], after[:]):
                raise ValueError(f"migration changed {k}/{name}")
        for t in range(len(source.times)):
            for r in range(grid[0]):
                for c in range(grid[1]):
                    ys, xs = (
                        slice(r * cs, min((r + 1) * cs, original.shape[2])),
                        slice(c * cs, min((c + 1) * cs, original.shape[3])),
                    )
                    expected = source.values(k, t, ys, xs)
                    actual = np.asarray(target[t, :, ys, xs])
                    if expected.tobytes() != actual.tobytes():
                        raise ValueError(
                            f"migration data mismatch at level={k}, t={t}, cell={r},{c}"
                        )
                    for name in (meta.mask_variable, meta.coverage_variable):
                        if name is not None:
                            before = schema.get_array(source.groups[k], name, "legacy")
                            after = schema.get_array(group, name, "destination")
                            if (
                                np.asarray(before[t, ys, xs]).tobytes()
                                != np.asarray(after[t, ys, xs]).tobytes()
                            ):
                                raise ValueError(
                                    f"migration changed {k}/{name} t={t} cell={r},{c}"
                                )
            if progress is not None:
                progress(k * len(source.times) + t + 1, len(source.data) * len(source.times))
