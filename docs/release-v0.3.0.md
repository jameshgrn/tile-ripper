# v0.3.0 release preparation

Local preparation only. No store upload, catalog update, deployment, remote deletion or tag push was performed. Python (`pyproject.toml`, `uv.lock`) and JavaScript (`js/package.json`, `js/package-lock.json`) already carry 0.3.0 in the existing implementation commits; no second version bump is needed.

The interleaved local experiment establishes v0.3 = v0.2 within noise, with incomplete-frame and traffic-accounting limits described in the README. The remaining text hits are accounted for in [the audit](stale-text-v03.md). `.napkin.md` was updated locally and remains ignored as established by `.gitignore`.

## Storage accounting

Read-only Cloudflare bucket metrics at 2026-10-03T23:10:00Z: 23,016 objects, 8,295,088,016 payload bytes plus 1,969,824 metadata bytes = **8,297,057,840 bytes**. This is the latest analytics sample returned by the API, not an instantaneous per-key inventory. `npx --no-install wrangler r2 bucket info tileripper-stores` reports 8.3 GB.

| Operation/state | Object count | Bytes |
|---|---:|---:|
| Local new imagery store | 5,893 | 6,451,772,327 |
| Local old imagery store, matching catalog prefix | 5,893 | 6,451,765,726 |
| Bucket plus full new store, retaining old | 28,909 | 14,748,830,167 |
| After subsequently deleting old imagery | 23,016 | 8,297,064,441 |

Projections add/subtract local payload sizes from the sampled total; new R2 metadata overhead and any changes after the sample are additional. Object projections assume the new prefix is absent and the old remote prefix matches the local inventory. S3 credentials are not present in this shell, so a live per-key inventory and prefix collision check remain necessary before publication. The full two-store transition exceeds the user-specified 10 GB limit by at least 4,748,830,167 bytes. Deleting afterward does not prevent that excess. There is no under-limit two-store upload plan with the existing contents.

## Proposed outward actions — not executed

Run from the repository root. The S3 script needs `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; do not put secrets in commands or Git.

1. Upload to the new prefix, preserving all existing stores:

   ```sh
   uv run --with boto3 python scripts/r2_sync.py upload ucayali_santa_maria_v03
   uv run chronozarr doctor https://data.tileripper.com/ucayali_santa_maria_v03
   ```

   5,893 objects / 6,451,772,327 bytes; 31 short-lived and 5,862 immutable objects. This exceeds the 10 GB limit while v0.2 remains. Defer unless temporary overage is accepted or a different destination is chosen. Recheck bucket/prefix inventory first. The new store must be complete before publishing its catalog URL.

2. Change the first catalog entry, commit that separately, and redeploy the unified Worker:

   ```sh
   uv run python - <<'PY'
   import json
   from pathlib import Path
   path = Path('js/demo/catalog.json')
   catalog = json.loads(path.read_text())
   assert catalog[0]['url'] == 'https://data.tileripper.com/ucayali_santa_maria/chronozarr-4'
   catalog[0]['url'] = 'https://data.tileripper.com/ucayali_santa_maria_v03'
   path.write_text(json.dumps(catalog, indent=2) + '\n')
   PY
   uv run python - <<'PY'
   from pathlib import Path
   path = Path('js/maplibre/demo.js')
   old = 'https://data.tileripper.com/ucayali_santa_maria/chronozarr-4'
   assert old in path.read_text()
   path.write_text(path.read_text().replace(old, 'https://data.tileripper.com/ucayali_santa_maria_v03'))
   PY
   git add js/demo/catalog.json js/maplibre/demo.js
   git commit -m "deploy: point imagery catalog at the v0.3 store"
   npm --prefix site run deploy
   ```

   Current local site build: 150 asset files / 6,703,675 bytes, plus one Worker source module (`site/worker.js`, 404 bytes). The catalog edit changes the build sizes; rebuild and recount before deployment. Wrangler uploads only assets missing from the remote content cache, so the actual changed-object count cannot be determined from the local build alone. These assets do not add R2 bucket storage.

   **Outstanding catalog compatibility:** the second entry is `ucayali_santa_maria/png-1`, a v0.2 store (35 local objects / 112,860,722 bytes). Migrate and publish it under a new prefix, or remove that entry in the reviewed catalog change. Updating only the imagery entry leaves the PNG choice unusable with the v0.3 reader. No catalog edit was made during preparation. Explicit saved v0.2 URLs also need conversion or a pinned v0.2 viewer. The MapLibre demo has a separate default store URL and must be updated alongside the catalog before its deployment.

3. Optional deletion after verified publication and browser checks:

   ```sh
   uv run --with boto3 python scripts/r2_sync.py delete ucayali_santa_maria/chronozarr-4 --yes
   ```

   Expected 5,893 objects / 6,451,765,726 payload bytes removed. The script lists remote keys, so confirm its live inventory before authorizing deletion. Recommended after successful migration if retiring v0.2 is acceptable, but not sufficient to avoid the temporary overage. Do not delete first under this proposed sequence.

4. Publish both packages through the release tag after the final release commit is selected:

   ```sh
   git tag -a v0.3.0 -m "chronozarr v0.3.0"
   git push origin refs/tags/v0.3.0
   ```

   One annotated tag/ref; the push also transmits referenced commits and objects absent from the remote. Exact transfer count/packed size depends on the selected release commit and remote negotiation. It triggers `.github/workflows/release.yml` (PyPI) and `npm-release.yml` (npm). No tag was created or pushed. Local builds: Python wheel 126,376 bytes; source archive 1,126,590 bytes; npm archive 663,988 bytes containing 87 files. These are prepared artifact sizes; CI rebuilds them. There is no R2 storage change from the tag push.

## Local validation

`uv run pytest -q -m unit`; `cd js && node --test`; `uv run ruff check .`; `uv run ruff format --check src tests examples scripts`; `uv run ty check src` (the CI type-check scope). 547 Python unit tests and 447 Node tests passed with no skips in the requested JS suite. Ruff check and format verification and the production-source ty check passed. The architecture boundary check, site build, Python build and npm prepack/package checks also passed. Release build and test evidence is local; hosted v0.3 browser behavior remains unverified until publication.
