# chronozarr.org

Vocs 1.4.1 + React + MDX, matching the dgov docs framework. The `toml` override
pins the patched parser at 4.2.0; `npm audit` reports zero vulnerabilities.

## Develop and deploy

```sh
cd site
npm ci
npm run dev
npm run build
npm run preview
npm run deploy
```

Deployment uses the repository's pinned Wrangler binary. Install root tooling
with `npm ci` from the repository root if it is absent. The site has its own
Worker, `chronozarr-docs`; the browser demo and its shared modules are copied into this same deployment by `scripts/copy-demo.mjs`.
Build output is `docs/dist`. `worker.js` redirects www to the apex and forwards
other requests to static assets. Unknown paths return 404.

## Content and visual direction

The homepage introduces the format through a three-date Ucayali raster strip,
then routes visitors to creating, publishing, or integrating a store. The docs
use Vocs navigation, code blocks, search, light/dark themes, and mobile menus.
The format specification remains labeled v0.2 Draft.

`npm run sync-content` imports ten existing repository documents before dev/build.
The specification comes from `../spec/CHRONOZARR.md`, and the guides and JavaScript
references come from `../docs` and `../js`. Edit those source documents rather
than the ignored generated pages. The importer adapts relative links, escapes
literal MDX prose syntax, and updates obsolete public demo URLs in README examples.
It preserves code blocks. Hand-authored introduction and Python/CLI pages live in
`docs/pages`; full signatures remain linked to source.

The homepage loads three WebP previews totaling about 56 KiB. It does not load
the viewer or fetch raster chunks. `scripts/make-previews.py` records their source,
dates, band order, level, and fixed display stretch. Rebuild those images from the
local demo store with `uv run python site/scripts/make-previews.py` at repo root.
These are illustrative RGB images, not numeric exports.

## Verification and live deployment

Verified 2026-10-02 (America/New_York):

- Production build and dependency audit pass.
- All 18 routes return 200 locally with one h1, no page errors, and no horizontal
  overflow at 390 px; homepage reviewed at desktop and mobile sizes.
- Internal page/file links and fragment anchors pass.
- Synthetic quickstart roundtrip, validator, xarray backend, and plain Zarr read pass.
- Live homepage and docs load; search returns specification results (historical v0.2 deployment check).
- Unknown live paths return 404; www returns 301 to the apex while preserving path.
- PyPI and npm both report chronozarr 0.2.1.

Live: https://chronozarr.org
Fallback: https://chronozarr-docs.jake-gearon.workers.dev
Cloudflare version: bbbb7642-8bf5-45a8-9800-68f5753e6c1e

The first failed upload rejected a hostname redirect in `_redirects`. The deployed
version uses the Worker entry point instead. Some recursive DNS caches initially
retained the domain's prior absence; public DNS and the browser now resolve it.
