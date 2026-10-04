# chronozarr in leafmap

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

Install `chronozarr[leafmap]` and open `demo.ipynb` in a local notebook. The helper uses
`leafmap.maplibregl.Map`, not leafmap's default ipyleaflet backend:

```python
import leafmap.maplibregl as leafmap
from chronozarr import add_chronozarr

m = leafmap.Map(style="positron", height="600px",
                add_sidebar=False, add_floating_sidebar=False)
add_chronozarr(m)
m
```

Call the helper before displaying the map. It adds the existing `ChronozarrLayer`
and a date slider, fits the map to the store, and preserves leafmap's basemaps and
controls. It reads pixels directly from static storage; no raster tile service is
involved. `url=`, `t=`, `product=`, `opacity=` and `fit_bounds=` are configurable.
Each additional layer needs a unique `name=`.

The examples disable leafmap's optional floating sidebar: leafmap 0.63.1 uses
`ipyvuetify.ExpansionPanelHeader`, which ipyvuetify 3 removed. The direct map and
chronozarr slider do not need that sidebar. If you need leafmap's sidebar, the
compatible environment is `ipyvuetify<3` and `ipyvue<3`; 1.11.3 and 1.12.0 were
checked with leafmap 0.63.1.

This is a packaged chronozarr helper, not an upstream leafmap method. Ordinary Python layer
definitions cannot serialize WebGL callbacks. The helper wraps the installed
py-maplibregl anywidget renderer's model interface and reconstructs custom layers
in the browser. It requires a browser that permits module imports from blob URLs
and the hosted reader at `https://chronozarr.org/maplibre/layer.js` (override
`reader_url=` to use your own reader). Store URLs need CORS. Local notebook kernels
can use `chronozarr.serve_store`; remote kernels need a URL the browser can reach.

Verification with an installed leafmap widget and local PNG fixture:

```sh
uv run --with leafmap python examples/leafmap/prepare_check.py
node examples/leafmap/browser_check.mjs
```

The check opens the real upstream renderer in Chromium, adds the custom GPU
layer, changes dates, saves a screenshot and runs cleanup. It exercises the
browser bridge without running a Jupyter server; notebook trust/security policy
and kernel comms still need a user notebook smoke test.
