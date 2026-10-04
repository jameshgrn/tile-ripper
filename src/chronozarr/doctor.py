"""`chronozarr doctor`: diagnose a store the way a browser and a plain Zarr reader see it.

For an https URL it probes the HTTP surface a browser viewer depends on (CORS, byte ranges,
HEAD, caching headers), then opens the store and decodes one cell per pyramid level. For a local
path it validates the layout and runs the same decode checks.

Remote stores are read with `chronozarr.decode.HttpStore` (standard library, no fsspec).
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import zarr

from chronozarr.decode import ChronoStore, as_store, open_store
from chronozarr.schema import parse_root_attrs, validate

DEFAULT_ORIGIN = "https://chronozarr.org"
USER_AGENT = "chronozarr-doctor"
Status = Literal["ok", "info", "warn", "fail"]


def is_url(target: str) -> bool:
    return target.startswith(("http://", "https://"))


@dataclass(frozen=True)
class Check:
    """One diagnosis line.

    `fail` is reserved for what breaks readers: CORS, byte ranges, Content-Range exposure,
    layout and decode correctness. `warn` is advice (a spec SHOULD or a measurable cost) and
    `info` is a plain observation; neither changes the exit status.
    """

    name: str
    status: Status
    detail: str
    hint: str = ""


@dataclass(frozen=True)
class Probe:
    """Result of one HTTP request made with browser-like headers."""

    status: int  # 0 when the request itself failed
    headers: dict[str, str]  # lower-case names
    body: bytes
    seconds: float
    error: str = ""


def _probe(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    read_limit: int = 0,
    timeout: float = 30.0,
) -> Probe:
    """Issue one request and read at most `read_limit` body bytes, then close the connection.

    Closing early matters: a server that ignores `Range` would otherwise stream a whole shard.
    """
    request = urllib.request.Request(
        url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})}
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(read_limit) if read_limit else b""
            return Probe(
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                body,
                time.perf_counter() - started,
            )
    except urllib.error.HTTPError as exc:
        with exc:
            body = exc.read(read_limit) if read_limit else b""
        return Probe(
            exc.code,
            {k.lower(): v for k, v in exc.headers.items()},
            body,
            time.perf_counter() - started,
        )
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        return Probe(0, {}, b"", time.perf_counter() - started, error=str(exc))


def _allows_origin(probe: Probe, origin: str) -> bool:
    return probe.headers.get("access-control-allow-origin", "") in ("*", origin)


def _header_tokens(probe: Probe, name: str) -> set[str]:
    return {t.strip().lower() for t in probe.headers.get(name, "").split(",") if t.strip()}


def _cors_check(label: str, probe: Probe, origin: str) -> Check | None:
    if _allows_origin(probe, origin):
        return None
    got = probe.headers.get("access-control-allow-origin")
    return Check(
        f"CORS on {label}",
        "fail",
        f"Access-Control-Allow-Origin is {got!r} for Origin {origin}",
        "Allow the viewer origin: set `Access-Control-Allow-Origin: *` on the bucket or CDN "
        "(R2: `npx wrangler r2 bucket cors set <bucket> --file deploy/r2-cors.json`). "
        "Browsers block every read of this store until this is fixed.",
    )


def _request_failed(name: str, url: str, probe: Probe) -> Check:
    return Check(
        name,
        "fail",
        f"request to {url} failed: {probe.error}",
        "Check the URL, DNS and TLS certificate, and that the host is reachable.",
    )


def _http_checks(base: str, origin: str) -> tuple[list[Check], dict[str, Any] | None]:
    """HTTP-surface checks. Returns the checks and the parsed root zarr.json (None if unusable)."""
    checks: list[Check] = []
    browser = {"Origin": origin}

    root = _probe(f"{base}/zarr.json", headers=browser, read_limit=16_000_000)
    if root.status == 0:
        return [_request_failed("root zarr.json", f"{base}/zarr.json", root)], None
    if root.status != 200:
        return [
            Check(
                "root zarr.json",
                "fail",
                f"GET {base}/zarr.json returned HTTP {root.status}",
                "The store URL must be the directory that contains the root zarr.json, without "
                "a trailing file name. Check the prefix and that objects are publicly readable.",
            )
        ], None
    try:
        document = json.loads(root.body)
        parsed = parse_root_attrs(document["attributes"])
        meta = document["attributes"]["chronozarr"]
        first_level = parsed.datasets[0].path
        variable = meta.get("variable", "data")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        return [
            Check(
                "root zarr.json",
                "fail",
                f"not a chronozarr root group ({type(exc).__name__}: {exc})",
                "Expected Zarr v3 group metadata with attributes.chronozarr and "
                "attributes.multiscales.",
            )
        ], None
    checks.append(
        Check(
            "root zarr.json",
            "ok",
            f"200, {len(root.body):,} bytes in {root.seconds * 1000:.0f} ms, "
            f"chronozarr {meta.get('spec_version', '?')}",
        )
    )
    cors = _cors_check("zarr.json", root, origin)
    checks.append(
        cors or Check("CORS on zarr.json", "ok", f"Access-Control-Allow-Origin allows {origin}")
    )
    if "consolidated_metadata" in document:
        checks.append(Check("consolidated metadata", "ok", "present in the root zarr.json"))
    else:
        checks.append(
            Check(
                "consolidated metadata",
                "warn",
                "absent: a reader needs one GET per array to open the store",
                "Write the store with consolidated metadata (chronozarr encode does this); cold "
                "opens are 1 to 3 s slower without it on a remote host.",
            )
        )

    array_meta = _probe(f"{base}/{first_level}/{variable}/zarr.json", read_limit=1_000_000)
    sharded = b"sharding_indexed" in array_meta.body
    has_shard_bytes = "shard_bytes" in meta

    key = f"{first_level}/{variable}/c/0/0/0/0"
    target = f"{base}/{key}"
    ranged = _probe(target, headers={**browser, "Range": "bytes=0-99"}, read_limit=100)
    used = key
    if ranged.status == 404:  # an unsharded store may omit an all-fill chunk
        used = f"{first_level}/{variable}/zarr.json"
        target = f"{base}/{used}"
        ranged = _probe(target, headers={**browser, "Range": "bytes=0-9"}, read_limit=10)
    layout = "sharded" if sharded else "unsharded"
    ranged_label = f"byte range on {used}"
    if ranged.status == 0:
        checks.append(_request_failed(ranged_label, target, ranged))
        return checks, document
    content_range = ranged.headers.get("content-range", "")
    if ranged.status == 206 and content_range:
        checks.append(
            Check(
                ranged_label,
                "ok",
                f"206, Content-Range {content_range} ({layout} store, "
                f"{ranged.seconds * 1000:.0f} ms)",
            )
        )
    elif ranged.status == 206:
        checks.append(
            Check(
                ranged_label,
                "fail",
                "206 without a Content-Range header",
                "The host must return Content-Range on partial responses.",
            )
        )
    elif ranged.status == 200:
        checks.append(
            Check(
                ranged_label,
                "fail" if sharded else "warn",
                "server ignored the Range header and answered 200 with the whole object",
                "Enable byte-range support (S3, R2 and most CDNs have it; plain `python -m "
                "http.server` does not: use RangeHTTPServer or chronozarr.view.serve_store). "
                "Sharded stores need it: without it every timestep downloads a whole shard."
                if sharded
                else "Enable byte-range support; unsharded stores work without it but it is "
                "required for sharded stores.",
            )
        )
    else:
        checks.append(
            Check(
                ranged_label,
                "fail",
                f"HTTP {ranged.status} for a bounded Range request",
                "The store must answer `Range: bytes=a-b` with 206 and Content-Range.",
            )
        )
    cors = _cors_check(ranged_label, ranged, origin)
    if cors:
        checks.append(cors)
    exposed = _header_tokens(ranged, "access-control-expose-headers")
    if "content-range" in exposed or "*" in exposed:
        checks.append(
            Check("CORS expose Content-Range", "ok", "Access-Control-Expose-Headers lists it")
        )
    else:
        checks.append(
            Check(
                "CORS expose Content-Range",
                "fail",
                "Access-Control-Expose-Headers does not list Content-Range "
                f"(got {sorted(exposed) or 'none'})",
                "Browser code cannot read Content-Range, so it cannot size ranged objects. Set "
                "`Access-Control-Expose-Headers: Content-Range, Content-Length`.",
            )
        )

    suffix = _probe(target, headers={**browser, "Range": "bytes=-16"}, read_limit=16)
    suffix_range = suffix.headers.get("content-range", "")
    suffix_works = suffix.status == 206 and suffix_range.startswith("bytes ")
    if not sharded:
        # Readers fetch an unsharded chunk with a plain GET; only shard indexes need `bytes=-N`.
        outcome = (
            f"206, Content-Range {suffix_range}"
            if suffix_works
            else f"`Range: bytes=-16` returned HTTP {suffix.status or suffix.error}"
        )
        checks.append(
            Check(
                "suffix range",
                "info",
                f"{outcome}; not used by an unsharded store (it has no shard index)",
            )
        )
    elif suffix_works:
        checks.append(
            Check("suffix range", "ok", f"206, Content-Range {suffix_range} (shard index reads)")
        )
    else:
        checks.append(
            Check(
                "suffix range",
                "fail",
                f"`Range: bytes=-16` returned HTTP {suffix.status or suffix.error}",
                "Sharded stores keep their shard index at the end of each shard and readers fetch "
                "it with a suffix range; the host must support `bytes=-N`.",
            )
        )

    preflight = _probe(
        target,
        method="OPTIONS",
        headers={
            **browser,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "range",
        },
    )
    allowed = _header_tokens(preflight, "access-control-allow-headers")
    if (
        preflight.status in (200, 204)
        and _allows_origin(preflight, origin)
        and ("range" in allowed or "*" in allowed)
    ):
        checks.append(
            Check("CORS preflight", "ok", f"OPTIONS {preflight.status}, Range header allowed")
        )
    else:
        checks.append(
            Check(
                "CORS preflight",
                "warn" if sharded else "info",
                f"OPTIONS returned HTTP {preflight.status or preflight.error}, "
                f"Access-Control-Allow-Headers {sorted(allowed) or 'none'}"
                + ("" if sharded else "; an unsharded store is read with plain GETs"),
                "Browsers send a preflight for suffix ranges (`bytes=-N`). Allow the Range "
                "header: `Access-Control-Allow-Headers: Range` and answer OPTIONS with 200 or "
                "204.",
            )
        )

    head = _probe(target, method="HEAD", headers=browser)
    length = head.headers.get("content-length", "")
    if head.status == 200 and length.isdigit() and _allows_origin(head, origin):
        checks.append(Check("HEAD", "ok", f"200, Content-Length {int(length):,}"))
    else:
        checks.append(
            Check(
                "HEAD",
                "warn" if has_shard_bytes or not sharded else "fail",
                f"HEAD returned HTTP {head.status or head.error}, "
                f"Content-Length {length or 'none'}"
                f", CORS {'ok' if _allows_origin(head, origin) else 'blocked'}",
                "Stock Zarr readers issue a HEAD before reading a shard index. Allow HEAD with "
                "CORS headers (R2 CORS `methods` must include HEAD).",
            )
        )

    repeat = None
    if "cf-cache-status" in ranged.headers:
        repeat = _probe(target, headers={**browser, "Range": "bytes=0-99"}, read_limit=100)
    host = urllib.parse.urlsplit(base).hostname or "<host>"
    checks.extend(_cache_checks(ranged, _looks_versioned(base), repeat=repeat, host=host))
    return checks, document


def _looks_versioned(base: str) -> bool:
    """True when the last path segment ends in a version or date, e.g. `chronozarr-2`."""
    return re.search(r"(^|[-_.])v?\d+(\.\d+)*$", base.rstrip("/").rsplit("/", 1)[-1]) is not None


def _cache_checks(
    probe: Probe, versioned: bool, *, repeat: Probe | None = None, host: str = "<host>"
) -> list[Check]:
    """Caching observations and advice for one data object. None of them is a failure."""
    checks: list[Check] = []
    cf_status = probe.headers.get("cf-cache-status", "")
    age = probe.headers.get("age")
    second = repeat.headers.get("cf-cache-status", "") if repeat is not None else ""
    observed = f"{cf_status} then {second}" if second else cf_status
    if cf_status.upper() in ("DYNAMIC", "BYPASS"):
        edge = (
            f"not caching (cf-cache-status {observed}); reads go to the bucket on every request. "
            f"Add a Cache Rule matching the hostname (Field Hostname equals {host}) with "
            "Eligible for cache and an Edge TTL override; a rule pasted into a URI wildcard "
            "value matches nothing"
        )
    elif cf_status:
        edge = f"cf-cache-status {observed}" + (f", age {age} s" if age else "")
        if second.upper() != "HIT":
            edge += " (a cached object answers the second request with HIT)"
    else:
        edge = "no CDN cache status header on the response"
    checks.append(Check("edge cache", "info", edge))

    tao = probe.headers.get("timing-allow-origin")
    checks.append(
        Check(
            "timing-allow-origin",
            "info",
            tao
            if tao
            else "absent; cross-origin transfer sizes read as 0 in the browser, so in-page "
            "bandwidth benchmarks under-report bytes",
        )
    )

    control = probe.headers.get("cache-control", "")
    max_age = re.search(r"max-age=(\d+)", control)
    long_lived = "immutable" in control or (max_age is not None and int(max_age.group(1)) >= 86400)
    if long_lived:
        checks.append(Check("cache-control", "ok", control))
    elif versioned:
        checks.append(
            Check(
                "cache-control",
                "warn",
                f"{control or 'absent'} on an object of a versioned store prefix",
                "Stores are immutable, so serve versioned prefixes with "
                "`Cache-Control: public, max-age=31536000, immutable`; without it browsers "
                "revalidate on reload.",
            )
        )
    else:
        checks.append(
            Check(
                "cache-control",
                "info",
                f"{control or 'absent'}; the prefix does not look versioned, so a long "
                "max-age would be unsafe if the store is ever re-encoded in place",
            )
        )
    return checks


def _level_bytes(store: ChronoStore, lod: int) -> int:
    _, n_band, height, width = store.levels[lod].shape
    return n_band * height * width * 2


def _plain_pixel(source: Any, store: ChronoStore, lod: int, t: int, y: int, x: int):
    """One pixel across bands read straight from the Zarr array, bypassing chronozarr decoding."""
    array = zarr.open_array(source, path=f"{lod}/{store.attrs.variable}", mode="r", zarr_format=3)
    return np.asarray(array[t, :, y, x])


def _decode_level(source: Any, store: ChronoStore, lod: int, full_read_limit: int) -> Check:
    level = store.levels[lod]
    name = f"decode level {lod}"
    rows, cols = level.grid
    row, col = rows // 2, cols // 2
    cs = level.chunk_size
    height, width = level.shape[2:]
    ys = slice(row * cs, min((row + 1) * cs, height))
    xs = slice(col * cs, min((col + 1) * cs, width))
    y, x = (ys.start + ys.stop) // 2, (xs.start + xs.stop) // 2
    t_last = len(store.times) - 1
    started = time.perf_counter()
    first = store.read_cell(0, row, col, lod)
    last = store.read_cell(t_last, row, col, lod)
    decode_s = time.perf_counter() - started

    problems: list[str] = []
    notes = [f"cell ({row},{col}) t=0 and t={t_last} in {decode_s * 1000:.0f} ms"]
    plain = _plain_pixel(source, store, lod, 0, y, x)
    if not np.array_equal(plain, first[:, y - ys.start, x - xs.start]):
        problems.append(f"pixel (y={y}, x={x}) at t=0 differs between chronozarr and plain Zarr")
    else:
        notes.append("plain-Zarr pixel at t=0 matches")
    if _level_bytes(store, lod) <= full_read_limit:
        for t, cell in ((0, first), (t_last, last)):
            full = store.read(t, lod)[:, ys, xs]
            if not np.array_equal(full, cell):
                n_bad = int(np.count_nonzero(full != cell))
                problems.append(f"t={t}: cell read differs from full read in {n_bad} value(s)")
        notes.append(f"full read ({_level_bytes(store, lod) / 1e6:.1f} MB/timestep) matches")
    else:
        notes.append(
            f"full read skipped ({_level_bytes(store, lod) / 1e6:.0f} MB/timestep > limit)"
        )
    if problems:
        return Check(
            name,
            "fail",
            "; ".join(problems),
            "The stored chunks do not reconstruct consistently. Re-encode the store and compare "
            "with `chronozarr validate`; do not serve it.",
        )
    return Check(name, "ok", "; ".join(notes))


def _decode_checks(source: Any, full_read_limit: int) -> list[Check]:
    checks: list[Check] = []
    try:
        problems = validate(source)
    except Exception as exc:  # unreadable metadata or chunks is itself the diagnosis
        return [
            Check(
                "validate",
                "fail",
                f"{type(exc).__name__}: {exc}",
                "A metadata object could not be read or decoded. Check the store is complete "
                "and, for a remote store, that the HTTP checks above pass.",
            )
        ]
    if problems:
        shown = "; ".join(problems[:5]) + (
            f"; ... {len(problems) - 5} more" if len(problems) > 5 else ""
        )
        checks.append(
            Check(
                "validate",
                "fail",
                f"{len(problems)} problem(s): {shown}",
                "Fix the listed layout problems or re-encode; `chronozarr validate` prints all of "
                "them.",
            )
        )
        return checks
    checks.append(Check("validate", "ok", "layout conforms to the chronozarr spec"))

    try:
        store = open_store(source)
    except Exception as exc:  # report any open failure as a diagnosis, not a traceback
        checks.append(
            Check(
                "open store", "fail", f"{type(exc).__name__}: {exc}", "Run `chronozarr validate`."
            )
        )
        return checks
    for lod in range(len(store.levels)):
        try:
            checks.append(_decode_level(source, store, lod, full_read_limit))
        except Exception as exc:  # a failed read is the finding; keep checking other levels
            checks.append(
                Check(
                    f"decode level {lod}",
                    "fail",
                    f"{type(exc).__name__}: {exc}",
                    "A chunk could not be read or decoded. For a remote store check the shard "
                    "object exists and Range requests work (see the HTTP checks above).",
                )
            )
    return checks


def diagnose(
    target: str, *, origin: str = DEFAULT_ORIGIN, full_read_limit_mb: float = 16.0
) -> list[Check]:
    """Run every applicable check against `target` (https URL or local path)."""
    limit = int(full_read_limit_mb * 1e6)
    if is_url(target):
        base = target.rstrip("/")
        checks, document = _http_checks(base, origin)
        if document is None:
            return checks
        checks.extend(_decode_checks(as_store(base), limit))
        return checks
    path = Path(target)
    if not path.is_dir():
        return [
            Check(
                "store path",
                "fail",
                f"{target} is not a directory",
                "Pass the store directory (the one containing zarr.json) or an https URL.",
            )
        ]
    return _decode_checks(str(path), limit)
