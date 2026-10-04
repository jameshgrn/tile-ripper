# Notebook player

chronozarr v0.3 is a raster time-series profile built on Zarr v3 and zarr-conventions multiscales, proj and spatial v0.1. Every data array contains true stored values; physical units use per-band scale and offset. Volatility is optional. v0.3 readers require explicit migration of v0.2 stores: `chronozarr convert OLD_STORE NEW_STORE`.

The notebook player is included in the `chronozarr` 0.3.0 release prepared here. Install the notebook
extra with `uv add 'chronozarr[notebook]'`; for this checkout use
`uv sync --extra notebook`. Open `demo.ipynb`
in a trusted local Jupyter notebook, VS Code notebook or compatible anywidget host.

```python
import chronozarr

movie = chronozarr.player("https://data.tileripper.com/ucayali_santa_maria/png-1")
movie
```

The widget adds a time slider, product selection, play/pause and playback speed.
Python controls are synchronized:

```python
movie.t = 9
movie.product = "band"
movie.speed = 10
movie.playing = True
movie.playing = False
movie.click   # most recent clicked pixel, physical band values and validity
movie.state   # acknowledged viewer state, including camera and date
movie.error   # last viewer error; {} until one occurs
movie.close()
```

`movie.times`, `products`, `bands` and `ready` arrive after metadata opens.
`ready` does not mean all image chunks have painted. During playback `t` is the
requested timestep; clicked values belong to the painted timestep in `click`.
Browser state is sent to the kernel at most ten times per second. Browser controls
and rendering still update immediately.

The viewer remains in an iframe and uses the existing v1 embed contract. Incoming
messages require both its exact origin and its window as sender. Python/JavaScript
changes are acknowledged with `chronozarr:get`; invalid commands produce `error`
and restore the accepted state. No raster server is needed for hosted stores.

`store` can also be a local path: the same range/CORS server used by
`chronozarr.view` serves it. A browser must be able to reach that server; remote
kernels need forwarding, and browsers may ask for local-network permission.
Set `viewer=` to use a self-hosted viewer. Store requests need CORS permitting
that viewer origin. The notebook host must allow its iframe. Closing the widget
removes its iframe, listeners and timers; the shared local store server retains
the lifecycle used by `view()`.

Browser checks (local PNG fixture, then deployed viewer/store):

```sh
node examples/anywidget/browser_check.mjs
node examples/anywidget/browser_check.mjs --live
```

These exercise the anywidget frontend's model interface and real iframe protocol:
metadata, kernel-style trait changes, controls, playback, click values, errors,
sender rejection and cleanup. They do not emulate Jupyter kernel transport.

A separate JupyterLab smoke test also passed with the actual anywidget extensions:
the notebook displayed the live PNG player, a slider change arrived in the Python
kernel (`movie.t == 12`), metadata arrived (`len(movie.times) == 36`), and setting
`movie.t = 9` in Python changed the live iframe to that timestep.
