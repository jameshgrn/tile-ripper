"""`chronozarr doctor`, the HTTP store, and the local range server behind `chronozarr.view`."""

from __future__ import annotations

import asyncio
import importlib
import json
import shutil
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from functools import partial
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
from zarr.abc.store import OffsetByteRequest, RangeByteRequest, SuffixByteRequest
from zarr.core.buffer import default_buffer_prototype

import chronozarr
import chronozarr.store as store_module
from chronozarr.decode import HttpStore
from chronozarr.doctor import Check, diagnose
from chronozarr.view import StoreRequestHandler, serve_store, view
from tests.synthetic import build_store, make_truth

pytestmark = pytest.mark.unit

# `chronozarr.view` is the notebook function once the package exports it; the module lives in
# sys.modules either way.
view_module = importlib.import_module("chronozarr.view")


def with_headers(name: str, **changes: str | None) -> type[StoreRequestHandler]:
    """A handler whose response headers are the defaults with `changes` applied (None removes)."""
    headers = dict(StoreRequestHandler.response_headers)
    for key, value in changes.items():
        header = key.replace("_", "-")
        headers.pop(header, None)
        if value is not None:
            headers[header] = value
    return type(name, (StoreRequestHandler,), {"response_headers": headers})


NoCorsHandler = type("NoCorsHandler", (StoreRequestHandler,), {"response_headers": {}})
NoExposeHandler = with_headers("NoExposeHandler", Access_Control_Expose_Headers=None)
NoTimingHandler = with_headers("NoTimingHandler", Timing_Allow_Origin=None)
NoRangePreflightHandler = with_headers(
    "NoRangePreflightHandler", Access_Control_Allow_Headers=None
)
ImmutableHandler = with_headers(
    "ImmutableHandler",
    Cache_Control="public, max-age=31536000, immutable",
    CF_Cache_Status="DYNAMIC",
)


class IgnoreRangeHandler(StoreRequestHandler):
    def send_head(self):
        del self.headers["Range"]
        return super().send_head()


class FlakyHandler(StoreRequestHandler):
    """Answers 503 to the first request for every distinct key."""

    seen: set[str]

    def send_head(self):
        if self.path not in self.seen:
            self.seen.add(self.path)
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE)
            return None
        return super().send_head()


@contextmanager
def serving(handler: type[StoreRequestHandler], root: Path) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, root=root, prefix=root.name))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/{root.name}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(scope="module")
def sharded_store(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("doctor") / "sharded"
    build_store(path, make_truth(5, 2, 40, 50), shard=True, chunk_size=16)
    return path


@pytest.fixture(scope="module")
def unsharded_store(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("doctor") / "unsharded"
    build_store(path, make_truth(5, 2, 40, 50), shard=False, chunk_size=16)
    return path


def by_name(checks: list[Check]) -> dict[str, Check]:
    return {c.name: c for c in checks}


def failures(checks: list[Check]) -> list[Check]:
    return [c for c in checks if c.status == "fail"]


# --- diagnose -------------------------------------------------------------------------------


def test_local_store_passes_and_full_reads_match(sharded_store):
    checks = diagnose(str(sharded_store))
    assert not failures(checks), failures(checks)
    levels = [c for c in checks if c.name.startswith("decode level")]
    assert len(levels) >= 2
    assert all("full read" in c.detail and "matches" in c.detail for c in levels)
    assert all("plain-Zarr pixel at t=0 matches" in c.detail for c in levels)


def test_local_unsharded_store_passes(unsharded_store):
    assert not failures(diagnose(str(unsharded_store)))


def test_full_read_limit_skips_large_levels(sharded_store):
    checks = diagnose(str(sharded_store), full_read_limit_mb=0.0)
    level0 = by_name(checks)["decode level 0"]
    assert level0.status == "ok"
    assert "full read skipped" in level0.detail


def test_http_store_passes_browser_checks(sharded_store):
    with serving(StoreRequestHandler, sharded_store) as url:
        checks = by_name(diagnose(url))
    failed = [c for c in checks.values() if c.status == "fail"]
    assert not failed, failed
    for name in ("root zarr.json", "CORS on zarr.json", "suffix range", "CORS preflight", "HEAD"):
        assert checks[name].status == "ok", checks[name]
    range_check = next(c for n, c in checks.items() if n.startswith("byte range"))
    assert range_check.status == "ok"
    assert "206" in range_check.detail
    assert "sharded" in range_check.detail
    assert checks["edge cache"].status == "info"
    assert checks["timing-allow-origin"].status == "info"
    assert checks["timing-allow-origin"].detail == "*"
    assert checks["cache-control"].status == "info"  # no-cache, and the prefix is unversioned
    assert checks["decode level 0"].status == "ok"


def test_doctor_reports_version_rejection_with_conversion_guidance(sharded_store, tmp_path):
    old = tmp_path / "old"
    shutil.copytree(sharded_store, old)
    document = json.loads((old / "zarr.json").read_text())
    document["attributes"]["chronozarr"]["spec_version"] = "0.2.0"
    (old / "zarr.json").write_text(json.dumps(document))
    with serving(StoreRequestHandler, old) as url:
        checks = diagnose(url)
    assert any("chronozarr convert" in c.detail for c in failures(checks))


def test_missing_content_range_exposure_fails(sharded_store):
    with serving(NoExposeHandler, sharded_store) as url:
        checks = by_name(diagnose(url))
    assert checks["CORS expose Content-Range"].status == "fail"
    assert "Access-Control-Expose-Headers" in checks["CORS expose Content-Range"].hint


def test_cache_observations_are_never_failures(tmp_path):
    versioned = tmp_path / "chronozarr-2"
    build_store(versioned, make_truth(3, 2, 20, 20), shard=True, chunk_size=16)
    with serving(StoreRequestHandler, versioned) as url:
        advice = by_name(diagnose(url))
    assert advice["cache-control"].status == "warn"
    assert "versioned" in advice["cache-control"].detail
    assert "immutable" in advice["cache-control"].hint
    with serving(ImmutableHandler, versioned) as url:
        checks = by_name(diagnose(url))
    assert checks["cache-control"].status == "ok"
    assert checks["edge cache"].status == "info"
    edge = checks["edge cache"].detail
    assert "not caching (cf-cache-status DYNAMIC then DYNAMIC)" in edge
    assert "reads go to the bucket on every request" in edge
    assert "Field Hostname equals 127.0.0.1" in edge
    assert "Edge TTL override" in edge
    assert not failures(list(checks.values()))


def test_timing_allow_origin_absence_is_advice(sharded_store):
    with serving(StoreRequestHandler, sharded_store) as url:
        base = diagnose(url)
    assert by_name(base)["timing-allow-origin"].detail == "*"
    with serving(NoTimingHandler, sharded_store) as url:
        checks = by_name(diagnose(url))
    assert checks["timing-allow-origin"].status == "info"
    assert "transfer sizes read as 0" in checks["timing-allow-origin"].detail


def test_origin_is_sent_and_reported(sharded_store):
    with serving(StoreRequestHandler, sharded_store) as url:
        checks = by_name(diagnose(url, origin="https://example.org"))
    assert "https://example.org" in checks["CORS on zarr.json"].detail


def test_missing_cors_headers_fail_with_a_fix(sharded_store):
    with serving(NoCorsHandler, sharded_store) as url:
        checks = diagnose(url)
    cors = [c for c in failures(checks) if c.name.startswith("CORS on")]
    assert {c.name for c in cors} >= {"CORS on zarr.json"}
    assert "Access-Control-Allow-Origin" in cors[0].hint
    assert any(c.name == "CORS preflight" and c.status == "warn" for c in checks)


def test_ignored_range_fails_a_sharded_store(sharded_store):
    with serving(IgnoreRangeHandler, sharded_store) as url:
        checks = diagnose(url)
    bad = [c for c in failures(checks) if c.name.startswith("byte range")]
    assert len(bad) == 1
    assert "ignored the Range header" in bad[0].detail
    assert "Sharded stores need it" in bad[0].hint
    assert any(c.name == "suffix range" and c.status == "fail" for c in checks)


def test_ignored_range_only_warns_for_an_unsharded_store(unsharded_store):
    with serving(IgnoreRangeHandler, unsharded_store) as url:
        checks = diagnose(url)
    ranged = next(c for c in checks if c.name.startswith("byte range"))
    assert ranged.status == "warn"
    assert not failures(checks), failures(checks)
    suffix = by_name(checks)["suffix range"]
    assert suffix.status == "info"
    assert "not used by an unsharded store" in suffix.detail


def test_http_unsharded_store_passes_and_the_suffix_range_is_an_info_line(unsharded_store):
    with serving(StoreRequestHandler, unsharded_store) as url:
        checks = by_name(diagnose(url))
    assert not [c for c in checks.values() if c.status == "fail"], checks
    range_check = next(c for n, c in checks.items() if n.startswith("byte range"))
    assert range_check.status == "ok"
    assert "unsharded store" in range_check.detail
    assert checks["suffix range"].status == "info"
    assert checks["suffix range"].detail.startswith("206, Content-Range bytes ")
    assert "no shard index" in checks["suffix range"].detail
    levels = [c for n, c in checks.items() if n.startswith("decode level")]
    assert len(levels) >= 2
    assert all(c.status == "ok" for c in levels), levels
    assert all("plain-Zarr pixel at t=0 matches" in c.detail for c in levels)


def test_unsharded_store_does_not_need_the_range_header_allowed(unsharded_store):
    with serving(NoRangePreflightHandler, unsharded_store) as url:
        checks = by_name(diagnose(url))
    assert checks["CORS preflight"].status == "info"
    assert not [c for c in checks.values() if c.status == "fail"]


def test_sharded_store_warns_when_the_range_header_is_not_allowed(sharded_store):
    with serving(NoRangePreflightHandler, sharded_store) as url:
        checks = by_name(diagnose(url))
    assert checks["CORS preflight"].status == "warn"


def test_missing_root_group_fails_early(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with serving(StoreRequestHandler, empty) as url:
        checks = diagnose(url)
    assert [c.name for c in checks] == ["root zarr.json"]
    assert checks[0].status == "fail"
    assert "404" in checks[0].detail


def test_unreachable_host_fails_with_network_hint():
    checks = diagnose("http://127.0.0.1:9/nothing")
    assert len(checks) == 1
    assert checks[0].status == "fail"
    assert "failed" in checks[0].detail
    assert "reachable" in checks[0].hint


def test_local_path_that_is_not_a_directory_fails(tmp_path):
    checks = diagnose(str(tmp_path / "nope"))
    assert checks[0].status == "fail"
    assert "not a directory" in checks[0].detail


def test_corrupt_chunk_data_is_reported_per_level(tmp_path):
    path = tmp_path / "corrupt"
    build_store(path, make_truth(5, 2, 40, 50), shard=True, chunk_size=16)
    shard = sorted((path / "0" / "data" / "c").rglob("*"))
    target = next(p for p in shard if p.is_file())
    blob = bytearray(target.read_bytes())
    blob[: len(blob) - 64] = bytes(len(blob) - 64)
    target.write_bytes(bytes(blob))
    checks = by_name(diagnose(str(path)))
    assert checks["validate"].status == "ok"
    assert any(c.status == "fail" for n, c in checks.items() if n.startswith("decode level"))


def test_layout_problems_fail_validate(tmp_path):
    path = tmp_path / "broken"
    build_store(path, make_truth(3, 2, 20, 20), shard=True, chunk_size=16)
    (path / "0" / "time" / "c" / "0").write_bytes(b"")
    checks = diagnose(str(path))
    assert any(c.name == "validate" and c.status == "fail" for c in checks)


# --- chronozarr.decode.HttpStore against the local range server -----------------------------


def test_http_store_reads_ranges_and_reports_missing_keys(sharded_store):
    async def read(store: HttpStore, key: str, rng=None):
        return await store.get(key, default_buffer_prototype(), rng)

    with serving(StoreRequestHandler, sharded_store) as url:
        store = HttpStore(url)
        whole = (sharded_store / "zarr.json").read_bytes()
        assert asyncio.run(read(store, "zarr.json")).to_bytes() == whole
        assert (
            asyncio.run(read(store, "zarr.json", RangeByteRequest(3, 10))).to_bytes()
            == whole[3:10]
        )
        assert (
            asyncio.run(read(store, "zarr.json", OffsetByteRequest(20))).to_bytes() == whole[20:]
        )
        assert asyncio.run(read(store, "zarr.json", SuffixByteRequest(7))).to_bytes() == whole[-7:]
        assert asyncio.run(read(store, "no/such/key")) is None
        assert asyncio.run(store.exists("zarr.json")) is True
        assert asyncio.run(store.exists("no/such/key")) is False


def test_http_store_slices_locally_when_the_server_ignores_range(sharded_store):
    with serving(IgnoreRangeHandler, sharded_store) as url:
        store = HttpStore(url)
        got = asyncio.run(
            store.get("zarr.json", default_buffer_prototype(), RangeByteRequest(2, 9))
        )
    assert got is not None
    assert got.to_bytes() == (sharded_store / "zarr.json").read_bytes()[2:9]


def test_http_store_retries_transient_server_errors(sharded_store, monkeypatch):
    monkeypatch.setattr(store_module, "_RETRY_DELAYS_S", (0.0, 0.0, 0.0))
    handler = type("Flaky", (FlakyHandler,), {"seen": set()})
    with serving(handler, sharded_store) as url:
        store = HttpStore(url)
        got = asyncio.run(store.get("zarr.json", default_buffer_prototype()))
    assert got is not None
    assert got.to_bytes() == (sharded_store / "zarr.json").read_bytes()


def test_http_store_names_the_url_when_the_host_is_unreachable(monkeypatch):
    monkeypatch.setattr(store_module, "_RETRY_DELAYS_S", (0.0,))
    store = HttpStore("http://127.0.0.1:9/x")
    with pytest.raises(OSError, match=r"GET http://127\.0\.0\.1:9/x/zarr\.json"):
        asyncio.run(store.get("zarr.json", default_buffer_prototype()))


def test_chronozarr_opens_over_http_with_the_standard_library_store(sharded_store):
    truth = chronozarr.open_store(str(sharded_store)).read(3)
    with serving(StoreRequestHandler, sharded_store) as url:
        remote = chronozarr.open_store(HttpStore(url))
        assert np.array_equal(remote.read(3), truth)


# --- local range server (chronozarr.view) ---------------------------------------------------


def _get(url: str, headers: dict[str, str] | None = None, method: str = "GET"):
    request = urllib.request.Request(url, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, dict(exc.headers.items()), exc.read()


def test_range_server_semantics(sharded_store):
    blob = (sharded_store / "zarr.json").read_bytes()
    size = len(blob)
    with serving(StoreRequestHandler, sharded_store) as url:
        key = f"{url}/zarr.json"
        status, headers, body = _get(key)
        assert (status, body) == (200, blob)
        assert headers["Accept-Ranges"] == "bytes"
        assert headers["Access-Control-Allow-Origin"] == "*"

        status, headers, body = _get(key, {"Range": "bytes=2-9"})
        assert (status, body) == (206, blob[2:10])
        assert headers["Content-Range"] == f"bytes 2-9/{size}"

        status, headers, body = _get(key, {"Range": "bytes=-5"})
        assert (status, body) == (206, blob[-5:])
        assert headers["Content-Range"] == f"bytes {size - 5}-{size - 1}/{size}"

        status, _, body = _get(key, {"Range": f"bytes={size - 3}-"})
        assert (status, body) == (206, blob[-3:])

        status, _, body = _get(key, {"Range": f"bytes=0-{size * 10}"})
        assert (status, body) == (206, blob)

        status, headers, _ = _get(key, {"Range": f"bytes={size}-"})
        assert status == 416
        assert headers["Content-Range"] == f"bytes */{size}"

        status, headers, body = _get(key, method="HEAD")
        assert (status, body) == (200, b"")
        assert headers["Content-Length"] == str(size)

        status, headers, _ = _get(
            key,
            {
                "Origin": "https://chronozarr.org",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "range",
            },
            method="OPTIONS",
        )
        assert status == 204
        assert "Range" in headers["Access-Control-Allow-Headers"]
        assert headers["Access-Control-Allow-Private-Network"] == "true"


def test_range_server_only_serves_files_under_its_prefix(sharded_store):
    with serving(StoreRequestHandler, sharded_store) as url:
        base = url.rsplit("/", 1)[0]
        assert _get(f"{base}/zarr.json")[0] == 404
        assert _get(f"{url}/0")[0] == 404  # a directory, not a file
        assert _get(f"{url}/nope.json")[0] == 404
        assert _get(f"{url}/../{sharded_store.name}/zarr.json")[0] in (200, 404)
        outside = sharded_store.parent / "secret.txt"
        outside.write_text("secret")
        assert _get(f"{url}/%2e%2e/secret.txt")[0] == 404


def test_serve_store_reuses_the_server_and_rejects_non_stores(sharded_store, tmp_path):
    first = serve_store(sharded_store)
    try:
        assert serve_store(sharded_store) is first
        assert first.url.startswith("http://127.0.0.1:")
        assert first.url.endswith(f"/{sharded_store.name}")
        assert _get(f"{first.url}/zarr.json")[0] == 200
    finally:
        first.close()
        view_module._servers.clear()
    with pytest.raises(FileNotFoundError, match=r"no zarr\.json"):
        serve_store(tmp_path)


def test_serve_store_restarts_after_close(sharded_store):
    first = serve_store(sharded_store)
    try:
        assert _get(f"{first.url}/zarr.json")[0] == 200
    finally:
        first.close()

    restarted = serve_store(sharded_store, port=first.port)
    try:
        assert restarted is not first
        assert restarted.port == first.port
        assert _get(f"{restarted.url}/zarr.json")[0] == 200
        # Closing the old handle again must not evict the replacement.
        first.close()
        assert serve_store(sharded_store) is restarted
        assert _get(f"{restarted.url}/zarr.json")[0] == 200
    finally:
        restarted.close()


def test_view_returns_an_iframe_pointing_the_viewer_at_the_local_store(sharded_store):
    pytest.importorskip("IPython")
    try:
        shown = view(sharded_store, height=480)
        page = shown.data
        assert "<iframe" in page
        assert 'height="480"' in page
        assert "https://chronozarr.org/demo/?store=http%3A%2F%2F127.0.0.1%3A" in page
        assert f"%2F{sharded_store.name}" in page
    finally:
        for server in list(view_module._servers.values()):
            server.close()
        view_module._servers.clear()


def test_view_passes_remote_urls_through_without_a_server():
    pytest.importorskip("IPython")
    shown = view("https://data.example.org/a/store", viewer="https://viewer.example/v/")
    assert (
        "https://viewer.example/v/?store=https%3A%2F%2Fdata.example.org%2Fa%2Fstore" in shown.data
    )
    assert not view_module._servers
