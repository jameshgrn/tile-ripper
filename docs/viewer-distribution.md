# Self-host the packaged viewer

The locally packed npm build contains the full reference viewer, its reader, workers, codecs, GIF encoder,
and other static assets. The viewer runs entirely in the browser; the host serves files only.
Node.js is needed to copy the package assets, but is not needed on the hosting service.

The v0.3 npm package prepared in this checkout, `chronozarr` 0.3.0, contains the reader and MapLibre layer,
but does not include the standalone viewer or `chronozarr-viewer` copy command.
Those additions are currently available only from a locally packed checkout build.
To prepare a build from the repository:

```sh
cd js
npm pack
```

On a separate machine or in a new directory, install that tarball, then copy the viewer:

```sh
npm install /path/to/chronozarr-0.3.0.tgz
./node_modules/.bin/chronozarr-viewer published --store ./store
cp -R /path/to/your/store published/store
```

Upload `published/` to any static host and open `index.html`. The same directory works
at a domain root or under a subpath. Serve over HTTP or HTTPS, rather than opening the
HTML directly from disk. Sharded stores need a host that supports byte ranges.
For local preview, a range-capable server can serve `published/`:

```sh
uv run --with rangehttpserver python -m RangeHTTPServer 8000 --directory published
```

Alternatively, use an absolute store URL with `--store https://example.org/my-store`.
Cross-origin stores must permit CORS; see [hosting](hosting.md).
The copy command refuses to overwrite an existing output directory.
It does not validate or copy data, and creates an empty catalog so a failed store never
falls back to the project's public sample data.

Without `--store`, the landing page displays "No store selected"; open
`demo/index.html?store=<URL>` in the copied directory to supply one.
For an iframe, use the same URL with `&embed=1`; see [embedding](embedding.md) for controls
and the origin restriction. The distributed reader imports continue to work independently
of the viewer. No package release or site deployment is performed by this command.

The reusable verification is `npm run test:package` from `js/`. It packs and installs
the package in a fresh temporary directory, checks overwrite refusal, then renders a
synthetic store from the copied viewer under a URL subpath. It checks time controls,
the pixel inspector, embedded rendering, and absence of outside requests and browser errors.
The test runner uses the development Playwright installation; the copied application
loads only the installed package's assets. This is packaging verification, not a speed benchmark.
