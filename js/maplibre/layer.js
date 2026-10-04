// ChronozarrLayer: a MapLibre GL JS custom layer that draws a chronozarr store on a Web Mercator map.
//
// Data path: the store reader (js/chronozarr/decoder.js) fetches and decodes raw chunks of the store's data type
// (uint8, uint16, int16 or float32); this layer uploads them unchanged into one texture array and the fragment
// shader reads true values and runs the product band math (see shader.js). Each cell is drawn as a
// small mesh whose vertices were projected from the store CRS to Web Mercator in float64 (mesh.js), so the warp
// costs nothing per pixel.
//
// Needs a MapLibre GL JS that passes `defaultProjectionData.mainMatrix` (5 and later; tested with 6.10.0) and the
// mercator projection.

import { openStore } from '../chronozarr/decoder.js';
import { computeStretchLo, describePixel, displayMode, findBand, inputConversion, inputIndices, normalizeBands, percentileRange, resolveProducts, toPhysical } from '../shared/products.js';
import { TEXTURE_FORMATS } from '../shared/texture-formats.js';
import { buildMesh, FLOATS_PER_VERTEX, MAX_DIVISIONS, originMatrix } from './mesh.js';
import { createProjection, crsToPixel, footprintBounds, levelTransform, lonLatToMercator, mercatorPerTexel, pixelToCrs } from './projection.js';
import { VERTEX_SHADER, fragmentShader } from './shader.js';
import { SlotPool } from './slots.js';
import { centreDistance2, coarseFootprint, overlapsView, selectLod } from './view.js';

const MIB = 1024 * 1024;
const DEFAULT_GPU_BUDGET_BYTES = 256 * MIB;
const UPLOAD_BYTES_PER_FRAME = 16 * MIB; // GPU uploads per frame; the rest wait for the next frame
const VIEW_MARGIN = 0.15; // load cells up to 15% of the screen beyond the edge (clip space)
const FAILURE_COOLDOWN_MS = 5000; // a cell whose fetch failed is left alone this long (the reader already retried)
const MESH_CACHE_LIMIT = 512;
const STRETCH_SAMPLES_PER_CELL = 300;
const PREFETCH_DELAY_MS = 250;
const SEEK_DISTANCE = 4; // a time change of more than this many steps drops queued speculative fetches (as the viewer does)
const EVENTS = ['open', 'loading', 'ready', 'error'];


const chunkId = (lod, row, col, t) => `${lod}/${row}/${col}/${t}`;
const isAbort = (error) => error?.name === 'AbortError';

function lngLatOf(value) {
  const lng = Array.isArray(value) ? value[0] : (value?.lng ?? value?.lon);
  const lat = Array.isArray(value) ? value[1] : value?.lat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new TypeError(`ChronozarrLayer: expected a lng/lat ({lng, lat} or [lng, lat]), got ${JSON.stringify(value)}`);
  return [lng, lat];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`ChronozarrLayer: shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * @typedef {object} ChronozarrLayerOptions
 * @property {string} url  root URL of the chronozarr store (the directory holding zarr.json)
 * @property {string} [id='chronozarr']  MapLibre layer id
 * @property {string} [product='true_color']  product id (see `layer.products`)
 * @property {number|string} [band=0]  band index or name for the 'band' (single band) product
 * @property {number} [t=0]  timestep index
 * @property {number} [opacity=1]
 * @property {number} [meshDivisions=8]  quads per cell side in the warp mesh
 * @property {number} [gpuBudgetBytes=268435456]  size of the GPU texture pool
 * @property {number} [lodBias=0.5]  pyramid level choice, see selectLod in view.js (negative = finer)
 * @property {number|null} [stretchLo]  shadow-lift stretch of reflectance products; default: measured once from the first complete view
 * @property {[number, number]|null} [range]  [min, max] in physical units for linear single-band products; default: measured per band from the first complete view
 * @property {boolean} [prefetch=false]  fill the reader's caches around the timestep and view in the background
 *   (store.prefetch: nearest timesteps first, within its cache and speculative-bandwidth budgets)
 * @property {object} [storeOptions]  passed to openStore (fetch, workers, maxCacheBytes, ...)
 */
export class ChronozarrLayer {
  id;
  type = 'custom';
  renderingMode = '2d';

  #options;
  #listeners = new Map();
  #opened;
  #resolveOpened;
  #rejectOpened;
  #map = null;
  #gl = null;
  #gpu = null;
  #store = null;
  #disposed = false;
  #geo = null;
  #meshes = new Map();
  #t;
  #productId;
  #band;
  #opacity;
  #stretchLo;
  #ranges = new Map();
  #bandInfo = null;
  #frame = 0;
  #state = 'loading';
  #pending = new Set();
  #failed = new Map();
  #shown = new Map();
  #controller = new AbortController();
  #openController = new AbortController();
  #retired = [];
  #lastView = { lod: 0, cells: [] };
  #reported = new Set();
  #prefetchTimer = null;
  #prefetchController = null;
  #prefetchedAt = 0;
  #seeded = false;
  #seeding = false;
  #uploadedBytes = 0;
  #deferredUpload = false;
  #scratchMatrix = new Float32Array(16);
  #counters = { uploads: 0, evictions: 0, frames: 0 };

  /** @param {ChronozarrLayerOptions} options */
  constructor(options) {
    const { id = 'chronozarr', url, product = 'true_color', band = 0, t = 0, opacity = 1, meshDivisions = 8, gpuBudgetBytes = DEFAULT_GPU_BUDGET_BYTES, lodBias = 0.5, stretchLo = null, range = null, prefetch = false, storeOptions = {} } = options ?? {};
    if (typeof url !== 'string' || url === '') throw new TypeError('ChronozarrLayer: options.url (the store root URL) is required');
    if (!Number.isInteger(t) || t < 0) throw new RangeError(`ChronozarrLayer: t must be a non-negative integer timestep index, got ${t}`);
    if (!Number.isInteger(meshDivisions) || meshDivisions < 1 || meshDivisions > MAX_DIVISIONS) throw new RangeError(`ChronozarrLayer: meshDivisions must be an integer in 1..${MAX_DIVISIONS}, got ${meshDivisions}`);
    if (!(gpuBudgetBytes > 0)) throw new RangeError(`ChronozarrLayer: gpuBudgetBytes must be positive, got ${gpuBudgetBytes}`);
    if (range !== null && !(Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0])) throw new RangeError(`ChronozarrLayer: range must be [min, max] in physical units with max > min, got ${JSON.stringify(range)}`);
    if (typeof prefetch !== 'boolean') throw new TypeError(`ChronozarrLayer: prefetch must be true or false, got ${JSON.stringify(prefetch)}`);
    this.id = id;
    this.#options = { url, meshDivisions, gpuBudgetBytes, lodBias, range, prefetch, storeOptions };
    this.#t = t;
    this.#productId = product;
    this.#band = band;
    this.#opacity = ChronozarrLayer.#checkOpacity(opacity);
    this.#stretchLo = stretchLo;
    this.#opened = new Promise((resolve, reject) => {
      this.#resolveOpened = resolve;
      this.#rejectOpened = reject;
    });
    this.#opened.catch(() => {}); // failures are reported through the 'error' event and this promise; no unhandled rejection
  }

  // ---- public API ----

  /** Resolves with the ChronoStore once it is open (after the layer was added to a map); rejects if it cannot be used. */
  get opened() {
    return this.#opened;
  }

  get store() {
    return this.#store;
  }

  get t() {
    return this.#t;
  }

  get product() {
    return this.#productId;
  }

  /** Timestamps of the store (ISO-8601), or null before it is open. */
  get times() {
    return this.#store?.times ?? null;
  }

  get bandNames() {
    return this.#bandInfo?.names ?? null;
  }

  /** Products resolved against the store's bands ({id, name, available, missing, ...}), or null before it is open. */
  get products() {
    return this.#bandInfo?.products ?? null;
  }

  /** Footprint of the store as [[west, south], [east, north]] in degrees, or null before it is open. */
  get bounds() {
    return this.#geo?.bounds ?? null;
  }

  get opacity() {
    return this.#opacity;
  }

  /** Pyramid level chosen for the last drawn frame. */
  get lod() {
    return this.#lastView.lod;
  }

  /** Counters for diagnostics: GPU slots, uploads, evictions, cached meshes, pending cell loads. */
  get stats() {
    return {
      ...this.#counters,
      lod: this.#lastView.lod,
      slots: this.#gpu?.pool?.slots ?? 0,
      residentSlots: this.#gpu?.pool?.size ?? 0,
      meshes: this.#meshes.size,
      pending: this.#pending.size,
      state: this.#state,
    };
  }

  /**
   * Listen for 'open' (store metadata read), 'loading' (the view needs data), 'ready' (everything the view needs is
   * on the GPU; fires again after every pan, zoom or time change that had to wait for data) and 'error'
   * (`event.error`; the layer keeps running). Returns a function that removes the listener.
   */
  on(type, listener) {
    if (!EVENTS.includes(type)) throw new RangeError(`ChronozarrLayer: unknown event "${type}"; use one of ${EVENTS.join(', ')}`);
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
    return () => this.off(type, listener);
  }

  off(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  setTime(t) {
    if (!Number.isInteger(t) || t < 0 || (this.#store && t >= this.#store.times.length)) {
      throw new RangeError(`ChronozarrLayer.setTime: timestep must be an integer in 0..${this.#store ? this.#store.times.length - 1 : 'n-1'}, got ${t}`);
    }
    if (t === this.#t) return;
    this.#t = t;
    this.#retired.push(this.#controller);
    this.#controller = new AbortController();
    this.#repaint();
    this.#schedulePrefetch();
  }

  /** `band` (index or name) only matters for the 'band' product. */
  setProduct(id, band = this.#band) {
    if (this.#bandInfo) this.#resolveProduct(id, band);
    this.#productId = id;
    this.#band = band;
    this.#repaint();
  }

  setOpacity(opacity) {
    this.#opacity = ChronozarrLayer.#checkOpacity(opacity);
    this.#repaint();
  }

  /**
   * Stored values at a map position for the current (or given) timestep, from the store's finest level:
   * {t, time, col, row, lngLat (pixel centre), x, y (store CRS), valid, bands: [{name, units, reflectance, stored, value}], ndvi, ndwi, isWater}.
   * `stored` is the stored number and `value` is stored * scale + offset; `valid` follows the mask when the store has one, else the nodata value.
   * Resolves null outside the store's footprint.
   * Fetches the level-0 chunks when they are not cached (one data chunk per cell).
   */
  async getValueAt(lngLat, { t = this.#t } = {}) {
    const store = await this.#opened;
    if (this.#disposed) throw new Error('ChronozarrLayer.getValueAt: the layer was removed');
    if (!Number.isInteger(t) || t < 0 || t >= store.times.length) throw new RangeError(`ChronozarrLayer.getValueAt: timestep must be an integer in 0..${store.times.length - 1}, got ${t}`);
    const [lng, lat] = lngLatOf(lngLat);
    const [x, y] = this.#geo.projection.fromLonLat(lng, lat);
    const [colF, rowF] = crsToPixel(this.#geo.transforms[0], x, y);
    const level = store.levels[0];
    const col = Math.floor(colF);
    const row = Math.floor(rowF);
    if (!(col >= 0 && row >= 0 && col < level.width && row < level.height)) return null;
    const cellRow = Math.floor(row / level.chunkHeight);
    const cellCol = Math.floor(col / level.chunkWidth);
    await store.getRaw(0, cellRow, cellCol, t);
    const offsetX = col - cellCol * level.chunkWidth;
    const offsetY = row - cellRow * level.chunkHeight;
    let values = store.samplePixel(0, cellRow, cellCol, t, offsetX, offsetY);
    if (!values) {
      // Evicted between the fetch and the read (a tiny cache): reconstruct the cell instead.
      const cell = await store.getCell(0, cellRow, cellCol, t);
      values = Array.from({ length: level.nBand }, (_, b) => cell.data[b * level.chunkHeight * level.chunkWidth + offsetY * level.chunkWidth + offsetX]);
    }
    const { nodata } = this.#bandInfo;
    let valid = nodata === null || values.some((value) => value !== nodata);
    if (store.hasMask) {
      const mask = await store.getMask(0, cellRow, cellCol, t);
      valid = mask[offsetY * level.chunkWidth + offsetX] !== 0;
    }
    const described = describePixel(values, store.attrs.bands, nodata);
    const [centreX, centreY] = pixelToCrs(this.#geo.transforms[0], col + 0.5, row + 0.5);
    const [centreLng, centreLat] = this.#geo.projection.toLonLat(centreX, centreY);
    return {
      t,
      time: store.times[t],
      col,
      row,
      lngLat: { lng: centreLng, lat: centreLat },
      x: centreX,
      y: centreY,
      valid,
      bands: described.bands,
      ndvi: described.ndvi,
      ndwi: described.ndwi,
      isWater: described.isWater,
    };
  }

  /** Remove the layer from its map and release the GPU objects, the store's workers and its in-flight requests. The layer cannot be reused. */
  remove() {
    if (this.#map?.getLayer(this.id)) this.#map.removeLayer(this.id);
    else this.#dispose();
  }

  // ---- MapLibre CustomLayerInterface ----

  onAdd(map, gl) {
    if (this.#disposed) throw new Error(`ChronozarrLayer "${this.id}" was removed; create a new layer instead of re-adding it`);
    this.#map = map;
    this.#gl = gl;
    if (!this.#store) {
      this.#open();
      return;
    }
    try {
      this.#initGpu();
    } catch (error) {
      this.#fail(error);
    }
  }

  onRemove() {
    this.#dispose();
  }

  render(glOrOptions, maybeOptions) {
    const options = maybeOptions ?? glOrOptions;
    if (!this.#gpu?.pool || this.#disposed) return;
    const matrix = options?.defaultProjectionData?.mainMatrix;
    if (!matrix) {
      this.#reportOnce('no-matrix', new Error('ChronozarrLayer needs MapLibre GL JS >= 5 (render options carry no defaultProjectionData.mainMatrix)'));
      return;
    }
    const variant = options.shaderData?.variantName;
    if (variant !== undefined && variant !== 'mercator') {
      this.#reportOnce('projection', new Error(`ChronozarrLayer only draws in the mercator projection, the map uses "${variant}"`));
      return;
    }
    this.#renderFrame(matrix);
  }

  // ---- opening ----

  async #open() {
    let store;
    try {
      const options = this.#options.storeOptions ?? {};
      const signal = options.signal ? AbortSignal.any([options.signal, this.#openController.signal]) : this.#openController.signal;
      store = await openStore(this.#options.url, { ...options, signal });
      if (this.#disposed) {
        store.close();
        return;
      }
      this.#configure(store);
    } catch (error) {
      store?.close();
      this.#fail(error);
      return;
    }
    this.#store = store;
    try {
      if (this.#gl) this.#initGpu();
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#resolveOpened(store);
    this.#emit('open', { store });
    this.#repaint();
  }

  /** Validates the store for map use and derives everything that does not depend on the GL context. */
  #configure(store) {
    const { url } = this.#options;
    if (!Array.isArray(store.transform)) throw new Error(`${url}: level 0 declares no affine "transform", so the store cannot be placed on a map. Re-encode it with the current chronozarr writer.`);
    if (!TEXTURE_FORMATS[store.dtype]) throw new Error(`${url}: data type ${store.dtype} is not supported by the MapLibre layer (supported: ${Object.keys(TEXTURE_FORMATS).join(', ')})`);
    const projection = createProjection(store.crs);

    const bands = normalizeBands(store.attrs.bands);
    this.#bandInfo = { bands, names: bands.map((band) => band.name), nodata: typeof store.nodata === 'number' ? store.nodata : null, products: resolveProducts(store.attrs.bands) };
    if (this.#t >= store.times.length) throw new RangeError(`${url}: timestep ${this.#t} is outside 0..${store.times.length - 1}`);
    this.#resolveProduct(this.#productId, this.#band);

    const transforms = store.levels.map((_, lod) => levelTransform(store.transform, lod));
    const { width, height } = store.levels[0];
    this.#geo = {
      projection,
      transforms,
      mercatorPerTexel0: mercatorPerTexel(projection, transforms[0], width, height),
      bounds: footprintBounds(projection, transforms[0], width, height),
      cells: store.levels.map(() => null),
    };
  }

  #resolveProduct(id, band) {
    const { names, products } = this.#bandInfo;
    const product = products.find((p) => p.id === id);
    if (!product) throw new RangeError(`ChronozarrLayer: unknown product "${id}"; available: ${products.filter((p) => p.available).map((p) => p.id).join(', ')}`);
    if (!product.available) throw new RangeError(`ChronozarrLayer: product "${id}" needs ${product.missing.join(', ')} bands, which this store lacks (it has ${names.join(', ')})`);
    const bandIndex = typeof band === 'string' ? names.indexOf(band) : band;
    if (id === 'band' && !(Number.isInteger(bandIndex) && bandIndex >= 0 && bandIndex < names.length)) throw new RangeError(`ChronozarrLayer: band ${JSON.stringify(band)} is not one of ${names.join(', ')}`);
    return { product, bandIndex };
  }

  #fail(error) {
    if (this.#disposed) return;
    this.#rejectOpened(error);
    this.#emit('error', { error });
    console.error('ChronozarrLayer:', error);
  }

  #reportOnce(key, error) {
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#emit('error', { error });
    console.error('ChronozarrLayer:', error);
  }

  // ---- GL resources ----

  #createProgram() {
    const gl = this.#gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentShader({ dtype: this.#store.dtype, hasMask: this.#store.hasMask }));
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`ChronozarrLayer: shader link failed: ${log}`);
    }
    const uniforms = {};
    for (const name of ['u_matrix', 'u_data', 'u_mask', 'u_extent', 'u_dataBase', 'u_maskLayer', 'u_inputs', 'u_product', 'u_display', 'u_range', 'u_stretchLo', 'u_hasNodata', 'u_nodata', 'u_opacity', 'u_scale', 'u_divisor', 'u_offset']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms, attributes: { pos: gl.getAttribLocation(program, 'a_pos'), texel: gl.getAttribLocation(program, 'a_texel') }, texture: null, maskTexture: null, pool: null, maskPool: null, indexBuffer: null };
  }

  #allocateTexture(internalFormat, width, height, layers) {
    const gl = this.#gl;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFormat, width, height, layers);
    for (const [parameter, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, parameter, value);
    }
    return texture;
  }

  /** Allocates the texture pool once both the store and the GL context exist. */
  #initGpu() {
    const gl = this.#gl;
    if (this.#gpu?.texture) return;
    const store = this.#store;
    const format = TEXTURE_FORMATS[store.dtype];
    const gpu = this.#createProgram();
    this.#gpu = gpu;
    const { nBand, chunkWidth, chunkHeight } = store.levels[0];
    const slotBytes = nBand * chunkWidth * chunkHeight * format.Array.BYTES_PER_ELEMENT;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    const slots = Math.min(Math.floor(this.#options.gpuBudgetBytes / slotBytes), Math.floor(maxLayers / nBand));
    if (slots < 1) throw new Error(`ChronozarrLayer: the GPU budget (${this.#options.gpuBudgetBytes} bytes, ${maxLayers} array layers available) holds ${slots} chunk slots of ${slotBytes} bytes; at least 1 is needed. Raise gpuBudgetBytes.`);
    if (chunkWidth > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error(`ChronozarrLayer: chunks are ${chunkWidth} px wide, more than this GPU's MAX_TEXTURE_SIZE`);
    gl.getError(); // clears one error left by earlier code, so the check below reports our own
    gpu.texture = this.#allocateTexture(gl[format.internal], chunkWidth, chunkHeight, slots * nBand);
    if (store.hasMask) gpu.maskTexture = this.#allocateTexture(gl.R8UI, chunkWidth, chunkHeight, slots);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`ChronozarrLayer: allocating ${slots} texture slots (${(slots * slotBytes) / MIB} MiB) failed with GL error ${error}. Lower gpuBudgetBytes.`);
    gpu.pool = new SlotPool(slots);
    if (store.hasMask) gpu.maskPool = new SlotPool(slots);
    gpu.format = format;
    gpu.slotLayers = nBand;
    gpu.chunk = { width: chunkWidth, height: chunkHeight };
  }

  #disposeGl() {
    const gl = this.#gl;
    const gpu = this.#gpu;
    if (!gl || !gpu) return;
    for (const mesh of this.#meshes.values()) this.#deleteMesh(mesh);
    this.#meshes.clear();
    if (gpu.indexBuffer) gl.deleteBuffer(gpu.indexBuffer);
    if (gpu.texture) gl.deleteTexture(gpu.texture);
    if (gpu.maskTexture) gl.deleteTexture(gpu.maskTexture);
    gl.deleteProgram(gpu.program);
    this.#gpu = null;
  }

  #deleteMesh(mesh) {
    this.#gl.deleteVertexArray(mesh.vao);
    this.#gl.deleteBuffer(mesh.vbo);
  }

  #dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#prefetchTimer);
    this.#prefetchController?.abort();
    this.#controller.abort();
    this.#openController.abort();
    for (const controller of this.#retired) controller.abort();
    this.#disposeGl();
    this.#store?.close();
    this.#rejectOpened(new Error(`ChronozarrLayer "${this.id}" was removed`));
    this.#map = null;
    this.#gl = null;
    this.#listeners.clear();
  }

  #repaint() {
    this.#map?.triggerRepaint();
  }

  #emit(type, detail = {}) {
    const listeners = this.#listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      queueMicrotask(() => {
        try {
          listener({ type, target: this, ...detail });
        } catch (error) {
          console.error(`ChronozarrLayer: a "${type}" listener threw`, error);
        }
      });
    }
  }

  static #checkOpacity(opacity) {
    if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`ChronozarrLayer: opacity must be between 0 and 1, got ${opacity}`);
    return opacity;
  }

  // ---- geometry ----

  /**
   * The part of a cell that lies inside the level-0 footprint, in texels of its level (fractional). The last texel of a
   * coarse level can overhang the store by up to 2^lod - 1 level-0 pixels; drawing only this part keeps the outline
   * identical at every level.
   */
  #footprint(lod, row, col) {
    const store = this.#store;
    const level = store.levels[lod];
    const scale = 2 ** lod;
    return {
      width: Math.min(level.chunkWidth, store.levels[0].width / scale - col * level.chunkWidth),
      height: Math.min(level.chunkHeight, store.levels[0].height / scale - row * level.chunkHeight),
    };
  }

  /** Cells of one level with their mercator footprints (for culling), built once per level. */
  #levelCells(lod) {
    if (this.#geo.cells[lod]) return this.#geo.cells[lod];
    const store = this.#store;
    const level = store.levels[lod];
    const transform = this.#geo.transforms[lod];
    const cells = [];
    for (let row = 0; row < level.gridRows; row++) {
      for (let col = 0; col < level.gridCols; col++) {
        const extent = store.cellExtent(lod, row, col);
        const footprint = this.#footprint(lod, row, col);
        const x0 = col * level.chunkWidth;
        const y0 = row * level.chunkHeight;
        const polygon = [[x0, y0], [x0 + footprint.width, y0], [x0 + footprint.width, y0 + footprint.height], [x0, y0 + footprint.height]].flatMap(([c, r]) => lonLatToMercator(...this.#geo.projection.toLonLat(...pixelToCrs(transform, c, r))));
        cells.push({ lod, row, col, extent, footprint, polygon });
      }
    }
    this.#geo.cells[lod] = cells;
    return cells;
  }

  /** Visible cells of a level, nearest the screen centre first, truncated to what the GPU pool can hold. */
  #visibleCells(lod, matrix) {
    const candidates = [];
    for (const cell of this.#levelCells(lod)) {
      if (overlapsView(matrix, cell.polygon, VIEW_MARGIN)) candidates.push({ cell, distance: centreDistance2(matrix, cell.polygon) });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const capacity = Math.max(1, Math.floor(this.#gpu.pool.slots / 2));
    if (candidates.length > capacity) {
      this.#reportOnce(`capacity-${lod}`, new Error(`ChronozarrLayer: the view needs ${candidates.length} cells at level ${lod} but the GPU budget holds ${capacity}; the outermost are not drawn. Raise gpuBudgetBytes or zoom in.`));
      candidates.length = capacity;
    }
    return candidates.map((c) => c.cell);
  }

  /** GPU mesh for a rectangle (chunk texels) of one cell, cached. */
  #mesh(lod, row, col, rect) {
    const key = `${lod}/${row}/${col}/${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
    const cached = this.#meshes.get(key);
    if (cached) {
      this.#meshes.delete(key);
      this.#meshes.set(key, cached);
      return cached;
    }
    const gl = this.#gl;
    const gpu = this.#gpu;
    const level = this.#store.levels[lod];
    const built = buildMesh({
      projection: this.#geo.projection,
      transform: this.#geo.transforms[lod],
      chunkOrigin: { col: col * level.chunkWidth, row: row * level.chunkHeight },
      rect,
      divisions: this.#options.meshDivisions,
    });
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, built.vertices, gl.STATIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(gpu.attributes.pos);
    gl.vertexAttribPointer(gpu.attributes.pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(gpu.attributes.texel);
    gl.vertexAttribPointer(gpu.attributes.texel, 2, gl.FLOAT, false, stride, 8);
    if (!gpu.indexBuffer) {
      gpu.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.indices, gl.STATIC_DRAW);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.indexBuffer);
    gl.bindVertexArray(null);
    const mesh = { origin: built.origin, vao, vbo, indexCount: built.indices.length };
    this.#meshes.set(key, mesh);
    if (this.#meshes.size > MESH_CACHE_LIMIT) {
      const [oldestKey, oldest] = this.#meshes.entries().next().value;
      this.#meshes.delete(oldestKey);
      this.#deleteMesh(oldest);
    }
    return mesh;
  }

  // ---- frame ----

  #renderFrame(matrix) {
    const store = this.#store;
    const gl = this.#gl;
    const t = this.#t;
    this.#frame++;
    this.#counters.frames++;
    this.#uploadedBytes = 0;
    this.#deferredUpload = false;

    const lod = selectLod({ mercatorPerTexel0: this.#geo.mercatorPerTexel0, levelCount: store.levels.length, zoom: this.#map.getZoom(), bias: this.#options.lodBias });
    const visible = this.#visibleCells(lod, matrix);
    this.#lastView = { lod, cells: visible.map((c) => [c.row, c.col]) };
    if (!this.#seeded) this.#seeded = this.#seedCoarse(lod, matrix);

    const fine = [];
    const fallback = [];
    let allResident = true;
    for (const cell of visible) {
      const slots = this.#slotsFor(lod, cell.row, cell.col, t, true);
      if (slots) {
        fine.push({ lod, row: cell.row, col: cell.col, extent: cell.extent, rect: { x0: 0, y0: 0, x1: cell.footprint.width, y1: cell.footprint.height }, slots });
        this.#shown.set(`${lod}/${cell.row}/${cell.col}`, t);
        continue;
      }
      allResident = false;
      if (!this.#seeding) this.#request(lod, cell.row, cell.col, t);
      const stand = this.#standIn(cell, lod, t);
      if (stand) fallback.push(stand);
    }
    fallback.sort((a, b) => b.lod - a.lod);

    const view = this.#productView();
    if (allResident && fine.length > 0) {
      if (this.#stretchLo === null) this.#stretchLo = this.#measureStretch(lod, fine, t);
      if (view.linear && view.range === null) this.#ranges.set(view.bandIndex, this.#measureRange(lod, fine, t, view.bandIndex));
    }

    if (fine.length + fallback.length > 0) this.#draw(gl, matrix, [...fallback, ...fine], this.#productView());

    for (const controller of this.#retired.splice(0)) controller.abort();
    if (this.#deferredUpload) this.#repaint();
    this.#settle();
  }

  /**
   * First paint: fetch the few cells of the coarsest level that cover the view and only then the cells of the level
   * the zoom asks for, so there is something to show (see #standIn) long before a slow link has delivered the rest.
   * Returns false while the store is off screen.
   */
  #seedCoarse(lod, matrix) {
    const store = this.#store;
    const coarsest = store.levels.length - 1;
    if (lod >= coarsest) return true;
    const cells = this.#levelCells(coarsest).filter((cell) => overlapsView(matrix, cell.polygon, VIEW_MARGIN)).map((cell) => [cell.row, cell.col]);
    if (cells.length === 0) return false;
    if (cells.length > 4) return true;
    const { signal } = this.#controller;
    const reads = [store.getCoarseFrame(coarsest, cells, this.#t, { signal })];
    if (store.hasMask) for (const [row, col] of cells) reads.push(store.getMask(coarsest, row, col, this.#t, { signal }));
    this.#seeding = true;
    Promise.all(reads).then(
      () => {
        this.#seeding = false;
        this.#repaint();
      },
      (error) => {
        this.#seeding = false;
        this.#repaint();
        if (isAbort(error)) return;
        this.#emit('error', { error });
        console.error('ChronozarrLayer: the coarse first paint failed to load', error);
      },
    );
    return true;
  }

  /** The 'loading' / 'ready' transitions: ready means no cell loads in flight and no upload waiting. */
  #settle() {
    const idle = this.#pending.size === 0 && !this.#deferredUpload && !this.#seeding;
    if (idle && this.#state === 'loading') {
      this.#state = 'ready';
      this.#emit('ready', { lod: this.#lastView.lod, t: this.#t });
      this.#schedulePrefetch();
    } else if (!idle && this.#state === 'ready') {
      this.#state = 'loading';
      this.#emit('loading', { pending: this.#pending.size });
    }
  }

  /**
   * Data and (when the store has one) mask slots for a cell at timestep t, or null while any is missing.
   * `load` uploads chunks that the reader has cached but the GPU does not hold.
   */
  #slotsFor(lod, row, col, t, load) {
    const data = this.#resident(lod, row, col, t, load);
    if (data < 0) return null;
    let mask = -1;
    if (this.#store.hasMask) {
      mask = this.#residentMask(lod, row, col, t, load);
      if (mask < 0) return null;
    }
    return { data, mask };
  }

  /** Whether this frame may upload another chunk; if not, another frame is scheduled for the rest. */
  #uploadAllowed() {
    if (this.#uploadedBytes < UPLOAD_BYTES_PER_FRAME) return true;
    this.#deferredUpload = true;
    return false;
  }

  #residentMask(lod, row, col, t, load) {
    const gpu = this.#gpu;
    const key = chunkId(lod, row, col, t);
    const slot = gpu.maskPool.slotOf(key, this.#frame);
    if (slot >= 0 || !load) return slot;
    const data = this.#store.peekMask(lod, row, col, t);
    if (!data || !this.#uploadAllowed()) return -1;
    const allocation = gpu.maskPool.allocate(key, this.#frame);
    if (!allocation) return -1;
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.maskTexture);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, allocation.slot, gpu.chunk.width, gpu.chunk.height, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    this.#uploadedBytes += data.byteLength;
    this.#counters.uploads++;
    return allocation.slot;
  }

  #resident(lod, row, col, t, load) {
    const gpu = this.#gpu;
    const key = chunkId(lod, row, col, t);
    const slot = gpu.pool.slotOf(key, this.#frame);
    if (slot >= 0 || !load) return slot;
    const data = this.#store.peekRaw(lod, row, col, t);
    if (!data || !this.#uploadAllowed()) return -1;
    const allocation = gpu.pool.allocate(key, this.#frame);
    if (!allocation) return -1;
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, allocation.slot * gpu.slotLayers, gpu.chunk.width, gpu.chunk.height, gpu.slotLayers, gl[gpu.format.format], gl[gpu.format.type], data);
    this.#uploadedBytes += data.byteLength;
    this.#counters.uploads++;
    if (allocation.evicted !== null) this.#counters.evictions++;
    return allocation.slot;
  }

  /**
   * What to paint for a cell whose data for timestep t is not on the GPU yet: the last timestep shown there (time
   * changes hold the previous frame), else the same area from a coarser level.
   */
  #standIn(cell, lod, t) {
    const shownT = this.#shown.get(`${lod}/${cell.row}/${cell.col}`);
    if (shownT !== undefined && shownT !== t) {
      const slots = this.#slotsFor(lod, cell.row, cell.col, shownT, false);
      if (slots) return { lod, row: cell.row, col: cell.col, extent: cell.extent, rect: { x0: 0, y0: 0, x1: cell.footprint.width, y1: cell.footprint.height }, slots };
    }
    const store = this.#store;
    const level = store.levels[lod];
    for (let coarse = lod + 1; coarse < store.levels.length; coarse++) {
      const footprint = coarseFootprint({ lod, row: cell.row, col: cell.col, extent: cell.footprint }, coarse, { width: level.chunkWidth, height: level.chunkHeight }, (r, c) => this.#footprint(coarse, r, c));
      const slots = this.#slotsFor(coarse, footprint.row, footprint.col, t, true);
      if (slots) return { lod: coarse, row: footprint.row, col: footprint.col, extent: store.cellExtent(coarse, footprint.row, footprint.col), rect: footprint.rect, slots };
    }
    return null;
  }

  /** What the shader needs for the current product: inputs, stored-to-physical conversion, and how the values reach the screen. */
  #productView() {
    const { product, bandIndex } = this.#resolveProduct(this.#productId, this.#band);
    const { bands } = this.#bandInfo;
    const display = displayMode(product, bands, bandIndex, this.#store.dtype);
    const linear = display.mode === 'linear';
    // A fixed range comes from the data type; otherwise the caller's range, else the one measured for this band (null until measured).
    const range = !linear ? null : display.fixed ? display.range : (this.#options.range ?? this.#ranges.get(bandIndex) ?? null);
    return { product, bandIndex, inputs: inputIndices(product, bandIndex), conversion: inputConversion(product, bands, bandIndex), linear, range };
  }

  /** 2nd percentile of tone-mapped true-color reflectance, measured once from the first complete view and then kept, so scrubbing does not shift the tone mapping. */
  #measureStretch(lod, items, t) {
    const { bands } = this.#bandInfo;
    const indices = ['red', 'green', 'blue'].map((common) => findBand(bands, common));
    if (indices.some((i) => i < 0)) return 0;
    const samples = [];
    this.#sample(lod, items, t, (values) => samples.push(indices.map((b) => toPhysical(values[b], bands[b]))));
    return computeStretchLo(samples);
  }

  /** Range of a linear single band: 2nd to 98th percentile of the valid physical values on screen, measured once per band. */
  #measureRange(lod, items, t, bandIndex) {
    const band = this.#bandInfo.bands[bandIndex];
    const { nodata } = this.#bandInfo;
    const values = [];
    this.#sample(lod, items, t, (stored) => {
      const value = stored[bandIndex];
      if (value !== nodata && Number.isFinite(value)) values.push(toPhysical(value, band));
    });
    return percentileRange(values) ?? [0, 1];
  }

  /** Calls `visit` with the stored values of about STRETCH_SAMPLES_PER_CELL pixels of each cell. */
  #sample(lod, items, t, visit) {
    for (const { row, col, extent } of items) {
      const stride = Math.max(1, Math.floor((extent.width * extent.height) / STRETCH_SAMPLES_PER_CELL));
      for (let i = 0; i < extent.width * extent.height; i += stride) {
        const values = this.#store.samplePixel(lod, row, col, t, i % extent.width, Math.floor(i / extent.width));
        if (values) visit(values);
      }
    }
  }

  #draw(gl, matrix, items, view) {
    const gpu = this.#gpu;
    const { uniforms } = gpu;
    const { nodata } = this.#bandInfo;

    gl.useProgram(gpu.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
    gl.uniform1i(uniforms.u_data, 0);
    if (gpu.maskTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.maskTexture);
      gl.uniform1i(uniforms.u_mask, 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform1i(uniforms.u_product, view.product.shader);
    gl.uniform3i(uniforms.u_inputs, ...view.inputs);
    gl.uniform1i(uniforms.u_display, view.linear ? 1 : 0);
    gl.uniform2f(uniforms.u_range, ...(view.range ?? [0, 1]));
    gl.uniform1f(uniforms.u_stretchLo, this.#stretchLo ?? 0);
    // With a mask the mask decides; otherwise the declared nodata value (if any).
    gl.uniform1i(uniforms.u_hasNodata, nodata !== null && !this.#store.hasMask ? 1 : 0);
    gl.uniform1f(uniforms.u_nodata, nodata ?? 0);
    gl.uniform1f(uniforms.u_opacity, this.#opacity);
    gl.uniform3f(uniforms.u_scale, ...view.conversion.unitScale);
    gl.uniform3f(uniforms.u_divisor, ...view.conversion.unitDivisor);
    gl.uniform3f(uniforms.u_offset, ...view.conversion.unitOffset);
    for (const item of items) {
      const mesh = this.#mesh(item.lod, item.row, item.col, item.rect);
      originMatrix(matrix, mesh.origin, this.#scratchMatrix);
      gl.uniformMatrix4fv(uniforms.u_matrix, false, this.#scratchMatrix);
      gl.uniform2f(uniforms.u_extent, item.extent.width, item.extent.height);
      gl.uniform1i(uniforms.u_dataBase, item.slots.data * gpu.slotLayers);
      gl.uniform1i(uniforms.u_maskLayer, item.slots.mask);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  // ---- loading ----

  /** Start fetching the chunks a cell needs at timestep t (once), repainting when they arrive. */
  #request(lod, row, col, t) {
    const key = chunkId(lod, row, col, t);
    if (this.#pending.has(key)) return;
    const failedAt = this.#failed.get(key);
    if (failedAt !== undefined && performance.now() - failedAt < FAILURE_COOLDOWN_MS) return;
    const store = this.#store;
    const { signal } = this.#controller;
    const reads = [store.getRaw(lod, row, col, t, { signal })];
    if (store.hasMask) reads.push(store.getMask(lod, row, col, t, { signal }));
    this.#pending.add(key);
    Promise.all(reads).then(
      () => {
        this.#pending.delete(key);
        this.#repaint();
      },
      (error) => {
        this.#pending.delete(key);
        if (isAbort(error)) {
          this.#repaint();
          return;
        }
        this.#failed.set(key, performance.now());
        this.#emit('error', { error, lod, row, col, t });
        console.error(`ChronozarrLayer: cell ${key} failed to load`, error);
        this.#repaint();
      },
    );
  }

  /** Once the view has settled, let the reader fill its caches around t for the visible cells (store.prefetch). */
  #schedulePrefetch() {
    if (!this.#options.prefetch || this.#disposed) return;
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = setTimeout(() => this.#runPrefetch(), PREFETCH_DELAY_MS);
  }

  #runPrefetch() {
    const store = this.#store;
    const { lod, cells } = this.#lastView;
    if (!store || this.#disposed || cells.length === 0) return;
    this.#prefetchController?.abort();
    const controller = new AbortController();
    this.#prefetchController = controller;
    const seek = Math.abs(this.#t - this.#prefetchedAt) > SEEK_DISTANCE;
    this.#prefetchedAt = this.#t;
    const report = (error) => {
      if (!isAbort(error)) this.#emit('error', { error, prefetch: true });
    };
    store
      .prefetch({
        lod,
        cells,
        t: this.#t,
        seek,
        signal: controller.signal,
        onChunk: (chunkLod, row, col, t) => {
          if (store.hasMask) store.getMask(chunkLod, row, col, t, { signal: controller.signal }).catch(report);
        },
      })
      .then((result) => {
        if (result.errors.length > 0) this.#emit('error', { error: result.errors[0].error, prefetch: true, errors: result.errors });
      }, report);
  }
}
