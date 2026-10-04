"""The xarray backend (engine="chronozarr") and the stdlib HTTP reader."""

from __future__ import annotations

import http.server
import importlib.metadata
import re
import threading
from pathlib import Path

import numpy as np
import pytest
import xarray as xr
from zarr.storage import LocalStore

import chronozarr
from chronozarr import store as store_module
from chronozarr.backend import ChronozarrBackendEntrypoint
from chronozarr.decode import HttpStore
from tests.synthetic import make_da, make_truth
from tests.test_reads import CountingStore

pytestmark = pytest.mark.unit

CS = 16
BANDS = [
    {"name": "B04", "common_name": "red", "scale": 0.0001},
    {"name": "B08", "common_name": "nir", "scale": 0.0001, "offset": 0.05},
]


def _open(path, **kwargs) -> xr.Dataset:
    return xr.open_dataset(path, engine=ChronozarrBackendEntrypoint, **kwargs)


@pytest.fixture(scope="module", params=[True, False], ids=["sharded", "unsharded"])
def store_path(request, tmp_path_factory):
    path = tmp_path_factory.mktemp("backend") / "store"
    truth = make_truth(5, 2, 40, 50)
    mask = (truth[:, 0] > 0).astype(np.uint8)
    coverage = (mask * 3).astype(np.uint8)
    chronozarr.encode(
        make_da(truth, ["B04", "B08"]),
        path,
        bands=BANDS,
        chunk_size=CS,
        shard=request.param,
        shard_time=2 if request.param else None,
        mask=mask,
        coverage=coverage,
    )
    return path, truth, mask, coverage


def test_open_reads_metadata_only(store_path, tmp_path):
    path, *_ = store_path
    counting = CountingStore(LocalStore(path, read_only=True))
    ds = xr.open_dataset(counting, engine=ChronozarrBackendEntrypoint)  # ty: ignore[invalid-argument-type]
    assert not [k for k, _ in counting.reads if "/data/c/" in k or "/mask/c/" in k]
    assert ds["data"].shape == (5, 2, 40, 50)


def test_dataset_structure(store_path):
    path, _, _, _ = store_path
    ds = _open(path)
    assert set(ds.data_vars) == {"data", "mask", "coverage"}
    assert ds["data"].dims == ("time", "band", "y", "x")
    assert ds["mask"].dims == ("time", "y", "x")
    assert ds["data"].dtype == np.float32
    assert ds["mask"].dtype == np.uint8
    assert list(ds["band"].values) == ["B04", "B08"]
    assert list(ds["common_name"].values) == ["red", "nir"]
    assert np.issubdtype(ds["time"].dtype, np.datetime64)
    assert ds.attrs["crs"] == "EPSG:32631"
    assert ds.attrs["chronozarr_spec_version"] == "0.3.0"
    assert "nodata" not in ds.attrs  # this store has a mask, which carries validity
    store = chronozarr.open_store(path)
    y, x = chronozarr.schema.pixel_centers(store.levels[0].transform, 40, 50)
    assert np.array_equal(ds["y"].values, y)
    assert np.array_equal(ds["x"].values, x)


def test_physical_values_match_the_reader(store_path):
    path, truth, mask, coverage = store_path
    ds = _open(path)
    store = chronozarr.open_store(path)
    for t in range(5):
        assert np.array_equal(ds["data"].isel(time=t).values, store.physical(t), equal_nan=True)
    expected = truth.astype(np.float32) * np.array([1e-4, 1e-4], np.float32)[None, :, None, None]
    expected[:, 1] += np.float32(0.05)
    expected[np.broadcast_to(~mask.astype(bool)[:, None], expected.shape)] = np.nan
    assert np.allclose(ds["data"].values, expected, equal_nan=True, rtol=1e-6)
    assert np.array_equal(ds["mask"].values, mask)
    assert np.array_equal(ds["coverage"].values, coverage)


def test_raw_values_with_physical_false(store_path):
    path, truth, _, _ = store_path
    ds = _open(path, physical=False)
    assert ds["data"].dtype == np.uint16
    assert np.array_equal(ds["data"].values, truth)


def test_coarser_level_and_dropped_variables(store_path):
    path, *_ = store_path
    ds = _open(path, lod=1, drop_variables=["coverage"])
    store = chronozarr.open_store(path)
    assert set(ds.data_vars) == {"data", "mask"}
    assert ds["data"].shape == store.levels[1].shape
    assert ds.attrs["lod"] == 1
    assert ds.attrs["resolution"] == store.levels[1].resolution
    assert np.array_equal(ds["data"].isel(time=3).values, store.physical(3, lod=1), equal_nan=True)
    with pytest.raises(IndexError, match="lod 7 out of range"):
        _open(path, lod=7)


@pytest.mark.parametrize(
    "selection",
    [
        {"time": 3},
        {"time": slice(1, 4), "band": 1},
        {"time": [4, 0, 2], "x": slice(10, 45, 3)},
        {"time": -1, "y": slice(5, 30), "x": [49, 0, 17]},
        {"band": [1, 0], "y": [39, 2], "x": 7},
        {"time": slice(None, None, 2), "y": slice(33, 40), "x": slice(0, 1)},
        {"time": [], "band": 0},
    ],
    ids=lambda s: ",".join(f"{k}={v}" for k, v in s.items()),
)
def test_lazy_selection_matches_the_eager_reference(store_path, selection):
    path, *_ = store_path
    reference = chronozarr.open_store(path).to_xarray(physical=True)
    got = _open(path)["data"].isel(selection)
    want = reference.isel(selection)
    assert got.dims == want.dims
    assert np.array_equal(got.values, want.values, equal_nan=True)


def test_selection_reads_only_the_chunks_it_needs(store_path):
    path, *_ = store_path
    sharded = chronozarr.open_store(path).levels[0].data.shards is not None
    counting = CountingStore(LocalStore(path, read_only=True))
    ds = xr.open_dataset(counting, engine=ChronozarrBackendEntrypoint)  # ty: ignore[invalid-argument-type]
    counting.reads.clear()
    value = ds["data"].isel(time=1, y=slice(0, 10), x=slice(0, 10)).values
    assert value.shape == (2, 10, 10)
    data_keys = {k for k, _ in counting.reads if "/data/c/" in k}
    mask_keys = {k for k, _ in counting.reads if "/mask/c/" in k}
    assert not [k for k, _ in counting.reads if "/coverage/c/" in k]
    if sharded:  # shard_time 2: timesteps 0 and 1 share the first time shard
        assert data_keys == {"0/data/c/0/0/0/0"}
        assert mask_keys == {"0/mask/c/0/0/0"}
    else:
        assert data_keys == {"0/data/c/1/0/0/0"}
        assert mask_keys == {"0/mask/c/1/0/0"}


def test_dask_chunks_follow_the_store_chunks(store_path):
    pytest.importorskip("dask")
    path, *_ = store_path
    ds = _open(path, chunks={})
    assert ds["data"].chunks == ((1,) * 5, (2,), (16, 16, 8), (16, 16, 16, 2))
    assert ds["mask"].chunks == ((1,) * 5, (16, 16, 8), (16, 16, 16, 2))
    store = chronozarr.open_store(path)
    assert np.array_equal(
        ds["data"].isel(time=3).compute().values, store.physical(3), equal_nan=True
    )
    mean = ds["data"].mean(dim="time", skipna=True).compute()
    assert mean.shape == (2, 40, 50)


def test_guess_can_open_recognises_chronozarr_directories(store_path, tmp_path):
    path, *_ = store_path
    backend = ChronozarrBackendEntrypoint()
    assert backend.guess_can_open(path)
    assert backend.guess_can_open(str(path))
    assert not backend.guess_can_open(tmp_path)
    assert not backend.guess_can_open(tmp_path / "missing")
    assert not backend.guess_can_open(b"bytes")
    (tmp_path / "zarr.json").write_text('{"node_type": "group"}')
    assert not backend.guess_can_open(tmp_path)


def test_engine_string_resolves_when_the_entry_point_is_registered(store_path):
    names = {ep.name for ep in importlib.metadata.entry_points(group="xarray.backends")}
    if "chronozarr" not in names:
        pytest.skip("entry point not registered: add it to pyproject.toml and `uv sync`")
    path, *_ = store_path
    assert xr.open_dataset(path, engine="chronozarr")["data"].shape == (5, 2, 40, 50)


def test_no_data_variable_named_differently_is_supported(tmp_path):
    truth = make_truth(3, 1, 20, 20)
    chronozarr.encode(make_da(truth, ["b"]), tmp_path / "s", chunk_size=CS)
    ds = _open(tmp_path / "s")
    assert set(ds.data_vars) == {"data"}
    assert "common_name" not in ds.coords
    assert "temporal_encoding" not in ds.attrs


# --- HTTP -------------------------------------------------------------------------------------


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves a directory with Range support; class attributes switch on misbehaviour."""

    root: Path
    log: list[tuple[str, str, str | None]]
    ignore_range = False
    fail_with: int | None = None
    failures_left = 0

    def log_message(self, format: str, *args) -> None:
        pass

    def _serve(self, send_body: bool) -> None:
        self.log.append((self.command, self.path, self.headers.get("Range")))
        if self.fail_with is not None and self.failures_left != 0:
            type(self).failures_left -= 1
            self.send_error(self.fail_with)
            return
        target = self.root / self.path.lstrip("/")
        if not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        header = self.headers.get("Range")
        status, start, end = 200, 0, len(data)
        if header and not self.ignore_range:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
            assert match is not None, header
            first, last = match.groups()
            if first == "":
                start = max(len(data) - int(last), 0)
            else:
                start = int(first)
                end = min(int(last) + 1, len(data)) if last else len(data)
            status = 206
        self.send_response(status)
        self.send_header("Content-Length", str(end - start))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end - 1}/{len(data)}")
        self.end_headers()
        if send_body:
            self.wfile.write(data[start:end])

    def do_GET(self) -> None:
        self._serve(True)

    def do_HEAD(self) -> None:
        self._serve(False)


@pytest.fixture
def serve(monkeypatch):
    """Serve a directory over http://127.0.0.1; returns (url, handler class) for it."""
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    monkeypatch.setattr(store_module, "_RETRY_DELAYS_S", (0.0, 0.0, 0.0))
    servers: list[http.server.ThreadingHTTPServer] = []

    def start(root: Path) -> tuple[str, type[_Handler]]:
        handler = type("Handler", (_Handler,), {"root": root, "log": []})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_port}", handler

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def test_open_store_over_http_reads_exact_values_with_range_requests(store_path, serve):
    path, truth, *_ = store_path
    url, handler = serve(path)
    store = chronozarr.open_store(url)
    for t in (0, 1, 4):
        assert np.array_equal(store.read_cell(t, 1, 2), truth[t, :, 16:32, 32:48])
    data_gets = [(p, r) for m, p, r in handler.log if m == "GET" and "/data/c/" in p]
    if store.levels[0].data.shards is not None:
        assert any(r is not None for _, r in data_gets), "a lone timestep is a byte range"
    assert np.array_equal(store.to_xarray().values, truth)
    assert chronozarr.validate(url) == []


def test_xarray_backend_over_http(store_path, serve):
    path, *_ = store_path
    url, _ = serve(path)
    ds = _open(url)
    store = chronozarr.open_store(path)
    assert np.array_equal(ds["data"].isel(time=2).values, store.physical(2), equal_nan=True)


def test_reads_survive_a_server_that_ignores_range(tmp_path, serve):
    truth = make_truth(4, 1, 40, 50)
    chronozarr.encode(make_da(truth, ["b"]), tmp_path / "s", chunk_size=CS)
    url, handler = serve(tmp_path / "s")
    handler.ignore_range = True
    assert np.array_equal(chronozarr.open_store(url).to_xarray().values, truth)


def test_missing_objects_are_missing_keys_and_not_errors(tmp_path, serve):
    truth = make_truth(3, 1, 40, 50)
    truth[:, :, :16, :16] = 0  # the first cell is all fill: zarr skips empty chunks
    chronozarr.encode(make_da(truth, ["b"]), tmp_path / "s", chunk_size=CS, shard=False)
    url, handler = serve(tmp_path / "s")
    store = chronozarr.open_store(url)
    assert not store.read_cell(1, 0, 0).any()
    assert any(p.endswith("/data/c/1/0/0/0") for m, p, _ in handler.log if m == "GET")


def test_transient_server_errors_are_retried_then_raise_with_the_url(tmp_path, serve):
    chronozarr.encode(make_da(make_truth(2, 1, 20, 20), ["b"]), tmp_path / "s", chunk_size=CS)
    url, handler = serve(tmp_path / "s")
    handler.fail_with, handler.failures_left = 503, 2
    assert chronozarr.open_store(url).levels[0].shape == (2, 1, 20, 20)  # 2 failures, then fine
    handler.fail_with, handler.failures_left = 503, -1
    with pytest.raises(OSError, match=r"GET http://127\.0\.0\.1:\d+/zarr\.json: HTTP 503"):
        chronozarr.open_store(url)


def test_unreachable_server_raises_with_the_url(serve, monkeypatch):
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    with pytest.raises(OSError, match=r"GET http://127\.0\.0\.1:9/zarr\.json"):
        chronozarr.open_store("http://127.0.0.1:9")


def test_http_store_is_read_only_and_unlistable():
    import asyncio

    store = HttpStore("http://example.invalid/store/")
    assert store.url == "http://example.invalid/store"
    assert store.read_only
    assert store == HttpStore("http://example.invalid/store")
    with pytest.raises(PermissionError, match="read-only"):
        asyncio.run(store.set("k", None))  # ty: ignore[invalid-argument-type]
    with pytest.raises(NotImplementedError, match="cannot list"):
        asyncio.run(_drain(store.list()))


async def _drain(iterator):
    return [item async for item in iterator]


def test_backend_nodata_attr_follows_the_mask(tmp_path):
    truth = make_truth(3, 1, 20, 20)
    mask = (truth[:, 0] > 0).astype(np.uint8)
    chronozarr.encode(
        make_da(truth, ["b"]), tmp_path / "masked", chunk_size=CS, mask=mask, nodata=0
    )
    chronozarr.encode(make_da(truth, ["b"]), tmp_path / "plain", chunk_size=CS)
    masked, plain = _open(tmp_path / "masked"), _open(tmp_path / "plain")
    assert "nodata" not in masked.attrs
    assert masked["mask"].dtype == np.uint8
    assert np.array_equal(masked["mask"].values, mask)
    assert plain.attrs["nodata"] == 0
    assert "mask" not in plain
    store = chronozarr.open_store(tmp_path / "masked")
    assert np.array_equal(masked["data"].isel(time=1).values, store.physical(1), equal_nan=True)


@pytest.mark.parametrize("units", [["m", "m"], ["m", "dB"], ["m", None]])
@pytest.mark.parametrize("physical", [True, False])
def test_band_units_survive_both_xarray_interfaces(tmp_path, units, physical):
    path = tmp_path / "units"
    chronozarr.encode(
        make_da(make_truth(2, 2, 16, 16), ["a", "b"]),
        path,
        bands=[
            {"name": name, "units": unit} for name, unit in zip(["a", "b"], units, strict=True)
        ],
        chunk_size=16,
    )
    eager = chronozarr.open_store(path).to_xarray(physical=physical)
    lazy = _open(path, physical=physical)["data"]
    for array in (eager, lazy):
        assert array.band_units.values.tolist() == [unit or "" for unit in units]
        if units == ["m", "m"]:
            assert array.attrs["units"] == "m"
        else:
            assert "units" not in array.attrs
        assert array.sel(band="a").band_units.item() == "m"


def test_http_store_compatibility_exports():
    """Existing decoder imports share the neutral transport used by validation."""
    from chronozarr.decode import as_store
    from chronozarr.store import HttpStore as NeutralHttpStore

    assert HttpStore is NeutralHttpStore
    assert as_store is store_module.as_store
    assert isinstance(as_store("https://example.invalid/store"), NeutralHttpStore)
    local = LocalStore("unused")
    assert as_store(local) is local
