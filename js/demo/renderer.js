// WebGL2 renderer for chronozarr cells.
//
// All chunks live as raw values of the store's data type in one TEXTURE_2D_ARRAY (R8UI, R16UI, R16I or R32F,
// see TEXTURE_FORMATS). A chunk (band, y, x) occupies n_band consecutive layers ("slot"), so uploading one is a
// single texSubImage3D from the decoded array. The fragment shader reads one true-value slot,
// so switching timesteps or products never runs a CPU loop
// over pixels. The product colors come from products-glsl.js.
//
// A store with a validity mask (spec 2.4) gets a second TEXTURE_2D_ARRAY (R8UI) with one layer per slot. The mask
// belongs to a timestep, so layer s holds the mask of the timestep whose data chunk sits in slot s. Where
// the mask is 0 the shader writes the background color (opaque, so painting over the previous frame cannot leave
// the previous timestep's pixel behind), and the store's nodata value is not compared (spec 2.3).

import { PRODUCT_GLSL } from '../shared/products-glsl.js';
import { TEXTURE_FORMATS } from '../shared/texture-formats.js';

export { TEXTURE_FORMATS } from '../shared/texture-formats.js';

const BACKGROUND = [0.035, 0.047, 0.071];

function valueGlsl() {
  return `
float value(ivec2 texel, int band) {
  if (band < 0) return 0.0;
  return float(texelFetch(u_data, ivec3(texel, u_dataBase + band), 0).r);
}`;
}

const VERTEX_SHADER = `#version 300 es
uniform vec2 u_canvas;
uniform vec3 u_view;        // center x, center y (world px), scale (canvas px per world px)
uniform vec4 u_cell;        // world origin x, y and world size x, y
uniform vec2 u_extent;      // valid texels in the cell
out vec2 v_texel;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 world = u_cell.xy + corner * u_cell.zw;
  vec2 px = (world - u_view.xy) * u_view.z + 0.5 * u_canvas;
  gl_Position = vec4(px.x / u_canvas.x * 2.0 - 1.0, 1.0 - px.y / u_canvas.y * 2.0, 0.0, 1.0);
  v_texel = corner * u_extent;
}`;

/** Fragment shader for one data type; `hasMask` adds the validity mask texture (see the top of this file). */
export function fragmentShader(dtype, hasMask = false) {
  const format = TEXTURE_FORMATS[dtype];
  const isFloat = dtype === 'float32';
  return `#version 300 es
precision highp float;
precision highp int;
precision highp ${format.sampler};
precision highp usampler2DArray;
in vec2 v_texel;
uniform ${format.sampler} u_data;
${hasMask ? 'uniform usampler2DArray u_mask;   // validity mask, one layer per slot: 1 = valid\nuniform int u_maskLayer;        // layer of the slot that holds the mask of the timestep on screen' : ''}
uniform vec2 u_extent;
uniform int u_dataBase;     // first layer of the true-value data slot
uniform ivec3 u_inputs;     // band index per product input, -1 = unused
uniform int u_product;
uniform int u_display;      // 0 = tone-mapped reflectance, 1 = linear stretch of u_range
uniform vec2 u_range;
uniform float u_stretch_lo;
uniform int u_hasNodata;    // the store declares a nodata value and has no mask
uniform float u_nodata;
uniform vec3 u_scale;       // per input: physical = stored * scale + offset ...
uniform vec3 u_divisor;     // ... or stored / divisor + offset where the divisor is above zero
uniform vec3 u_offset;
out vec4 outColor;

const vec3 BG = vec3(${BACKGROUND.join(', ')});
${valueGlsl()}

bool isNodata(float v) {
  return (u_hasNodata != 0 && v == u_nodata)${isFloat ? ' || isnan(v)' : ''};
}

vec3 toPhysical(vec3 v) {
  vec3 scaled = vec3(
    u_divisor.x > 0.0 ? v.x / u_divisor.x : v.x * u_scale.x,
    u_divisor.y > 0.0 ? v.y / u_divisor.y : v.y * u_scale.y,
    u_divisor.z > 0.0 ? v.z / u_divisor.z : v.z * u_scale.z);
  return scaled + u_offset;
}
${PRODUCT_GLSL}
void main() {
  ivec2 texel = ivec2(min(floor(v_texel), u_extent - 1.0));
${hasMask ? `  if (texelFetch(u_mask, ivec3(texel, u_maskLayer), 0).r == 0u) {   // masked out: the background shows
    outColor = vec4(BG, 1.0);
    return;
  }
` : ''}  float v0 = value(texel, u_inputs.x);
  float v1 = value(texel, u_inputs.y);
  float v2 = value(texel, u_inputs.z);
  bool empty = (u_inputs.x < 0 || isNodata(v0)) && (u_inputs.y < 0 || isNodata(v1)) && (u_inputs.z < 0 || isNodata(v2));
  if (empty) {
    outColor = vec4(BG, 1.0);
    return;
  }
  vec3 x = toPhysical(vec3(v0, v1, v2));
  outColor = u_display == 1 ? shadeLinear(u_product, x, u_range) : shade(u_product, x, u_stretch_lo);
}`;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

const UNIFORM_NAMES = ['u_canvas', 'u_view', 'u_cell', 'u_extent', 'u_data', 'u_mask', 'u_maskLayer', 'u_dataBase', 'u_inputs', 'u_product', 'u_display', 'u_range', 'u_stretch_lo', 'u_hasNodata', 'u_nodata', 'u_scale', 'u_divisor', 'u_offset'];

export class Renderer {
  #gl;
  #programs = new Map();
  #uniforms = {};
  #texture = null;
  #maskTexture = null;
  #pool = null;
  #frame = 0;
  #dtype = 'uint16';
  #hasMask = false;

  /** Called with a slot's cell metadata; the highest score is evicted first. Set by the viewer. */
  evictionScore = () => 0;
  stats = { uploads: 0, uploadMs: 0, evictions: 0 };

  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.#gl = gl;
    this.#useProgram('uint16');
    this.limits = { maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  }

  /** Select (compiling on first use) the shader program that reads textures of this data type, with the mask texture if `hasMask`. */
  #useProgram(dtype, hasMask) {
    const gl = this.#gl;
    if (!TEXTURE_FORMATS[dtype]) throw new Error(`Unsupported data type ${dtype}; the viewer shows ${Object.keys(TEXTURE_FORMATS).join(', ')}.`);
    const programKey = `${dtype}${hasMask ? '+mask' : ''}`;
    let entry = this.#programs.get(programKey);
    if (!entry) {
      const program = gl.createProgram();
      const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentShader(dtype, hasMask));
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.useProgram(program);
      const uniforms = Object.fromEntries(UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]));
      gl.uniform1i(uniforms.u_data, 0);
      gl.uniform1i(uniforms.u_mask, 1);
      entry = { program, uniforms };
      this.#programs.set(programKey, entry);
    }
    gl.useProgram(entry.program);
    this.#uniforms = entry.uniforms;
    this.#dtype = dtype;
    this.#hasMask = hasMask;
  }

  get dtype() {
    return this.#dtype;
  }

  /** Whether the pool has a validity mask layer per slot (set by `configure`). */
  get hasMask() {
    return this.#hasMask;
  }

  get slots() {
    return this.#pool?.slots ?? 0;
  }

  /**
   * Number of slots that fit `budgetBytes` and the driver's layer limit (`bytesPerSample`: 1, 2 or 4 by data type).
   * With `hasMask` each slot also carries one byte per pixel of mask.
   */
  planSlots(nBand, chunkWidth, chunkHeight, budgetBytes, wanted, bytesPerSample = 2, hasMask = false) {
    const byLayers = Math.floor(this.limits.maxLayers / nBand);
    const slotBytes = nBand * chunkWidth * chunkHeight * bytesPerSample + (hasMask ? chunkWidth * chunkHeight : 0);
    return Math.max(0, Math.min(wanted, byLayers, Math.floor(budgetBytes / slotBytes)));
  }

  /** (Re)allocate the texture pool for a data type (default uint16), with a mask layer per slot if `hasMask`. Drops every resident chunk. */
  configure({ dtype = 'uint16', nBand, chunkWidth, chunkHeight, slots, hasMask = false }) {
    const gl = this.#gl;
    this.#useProgram(dtype, hasMask);
    const format = TEXTURE_FORMATS[dtype];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, format.Array.BYTES_PER_ELEMENT);
    if (chunkWidth > this.limits.maxSize || chunkHeight > this.limits.maxSize) {
      throw new Error(`Chunk ${chunkWidth}x${chunkHeight} exceeds MAX_TEXTURE_SIZE ${this.limits.maxSize}.`);
    }
    if (slots < 1) throw new Error(`Texture pool has ${slots} slots; at least 1 is needed.`);
    if (this.#texture) gl.deleteTexture(this.#texture);
    this.#texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl[format.internal], chunkWidth, chunkHeight, slots * nBand);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.#maskTexture) gl.deleteTexture(this.#maskTexture);
    this.#maskTexture = null;
    if (hasMask) {
      this.#maskTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#maskTexture);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8UI, chunkWidth, chunkHeight, slots);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
    }
    this.#pool = {
      dtype,
      nBand,
      chunkWidth,
      chunkHeight,
      slots,
      maskResident: new Uint8Array(slots),
      meta: new Array(slots).fill(null),
      keyToSlot: new Map(),
      usedInFrame: new Uint32Array(slots),
      free: Array.from({ length: slots }, (_, i) => slots - 1 - i),
    };
    this.resetStats();
  }

  resetStats() {
    Object.assign(this.stats, { uploads: 0, uploadMs: 0, evictions: 0 });
  }

  /** Forget every resident chunk (keeps the texture allocation). */
  clearResident() {
    const pool = this.#pool;
    pool.keyToSlot.clear();
    pool.meta.fill(null);
    pool.usedInFrame.fill(0);
    pool.maskResident.fill(0);
    pool.free = Array.from({ length: pool.slots }, (_, i) => pool.slots - 1 - i);
  }

  /** Start a frame: slots touched from now on are protected from eviction until the next frame. */
  newFrame() {
    this.#frame++;
  }

  /** Resident slot for `key`, or -1. Marks it in use for this frame. */
  slotOf(key) {
    const slot = this.#pool.keyToSlot.get(key);
    if (slot === undefined) return -1;
    this.#pool.usedInFrame[slot] = this.#frame;
    return slot;
  }

  isResident(key) {
    return this.#pool.keyToSlot.has(key);
  }

  /** Resident slot for `key`, or -1, without marking it in use (unlike `slotOf`). */
  peekSlot(key) {
    return this.#pool.keyToSlot.get(key) ?? -1;
  }

  /** Whether slot `slot` holds the mask of the timestep of the chunk in it. Always false without a mask layer. */
  hasMaskAt(slot) {
    return this.#pool.maskResident[slot] === 1;
  }

  /**
   * Upload the validity mask (uint8 [y][x] over the padded chunk, 1 = valid) of the timestep whose data chunk
   * sits in `slot`. Call after `upload` returned that slot; a new chunk in the slot drops its mask.
   */
  uploadMask(slot, data) {
    const pool = this.#pool;
    if (!this.#maskTexture) throw new Error('uploadMask: the pool was configured without a mask.');
    if (data.length !== pool.chunkWidth * pool.chunkHeight) {
      throw new Error(`uploadMask: a mask of ${data.length} values does not fit a ${pool.chunkWidth}x${pool.chunkHeight} chunk.`);
    }
    const gl = this.#gl;
    const started = performance.now();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#maskTexture);
    // One byte per texel: rows are not padded to the data type's alignment.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, pool.chunkWidth, pool.chunkHeight, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, TEXTURE_FORMATS[pool.dtype].Array.BYTES_PER_ELEMENT);
    gl.activeTexture(gl.TEXTURE0);
    this.stats.uploads++;
    this.stats.uploadMs += performance.now() - started;
    pool.maskResident[slot] = 1;
  }

  /**
   * Upload a decoded chunk (uint16, [band][y][x]) into a slot and return the slot, or -1 when no
   * slot can be freed. `meta` carries {lod,row,col,t} for eviction scoring. Foreground uploads
   * (needed for the frame being drawn) evict the highest-scoring unprotected slot; `background`
   * uploads only take a free slot or replace a slot that scores worse than the incoming chunk.
   */
  upload(key, meta, data, { background = false } = {}) {
    const pool = this.#pool;
    const existing = this.slotOf(key);
    if (existing >= 0) return existing;
    let slot = pool.free.pop();
    if (slot === undefined) {
      let victim = -1;
      let victimScore = -Infinity;
      for (let s = 0; s < pool.slots; s++) {
        if (pool.usedInFrame[s] === this.#frame) continue;
        const score = this.evictionScore(pool.meta[s]);
        if (score > victimScore) {
          victim = s;
          victimScore = score;
        }
      }
      if (victim < 0) return -1;
      if (background && victimScore <= this.evictionScore(meta)) return -1;
      pool.keyToSlot.delete(pool.meta[victim].key);
      this.stats.evictions++;
      slot = victim;
    }
    const gl = this.#gl;
    const format = TEXTURE_FORMATS[pool.dtype];
    // The reader may hand over the bits of a signed type as unsigned (or the reverse); a view keeps the same buffer.
    const typed = data instanceof format.Array ? data : new format.Array(data.buffer, data.byteOffset, data.byteLength / format.Array.BYTES_PER_ELEMENT);
    const started = performance.now();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#texture);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot * pool.nBand, pool.chunkWidth, pool.chunkHeight, pool.nBand, gl[format.format], gl[format.type], typed);
    this.stats.uploads++;
    this.stats.uploadMs += performance.now() - started;
    pool.meta[slot] = { key, ...meta };
    pool.maskResident[slot] = 0;
    pool.keyToSlot.set(key, slot);
    pool.usedInFrame[slot] = background ? 0 : this.#frame;
    return slot;
  }

  /** Set the per-frame uniforms, clearing the canvas first unless `clear` is false (paint over the previous frame). */
  beginPaint(f, { clear }) {
    const gl = this.#gl;
    gl.viewport(0, 0, f.width, f.height);
    if (clear) {
      gl.clearColor(...BACKGROUND, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.uniform2f(this.#uniforms.u_canvas, f.width, f.height);
    gl.uniform3f(this.#uniforms.u_view, f.cx, f.cy, f.scale);
    gl.uniform1i(this.#uniforms.u_product, f.shader);
    gl.uniform3i(this.#uniforms.u_inputs, ...f.inputs);
    gl.uniform1f(this.#uniforms.u_stretch_lo, f.stretchLo);
    gl.uniform1i(this.#uniforms.u_display, f.display === 'linear' ? 1 : 0);
    gl.uniform2f(this.#uniforms.u_range, ...(f.range ?? [0, 1]));
    gl.uniform1i(this.#uniforms.u_hasNodata, f.nodata === null ? 0 : 1);
    gl.uniform1f(this.#uniforms.u_nodata, f.nodata ?? 0);
    gl.uniform3f(this.#uniforms.u_scale, ...f.unitScale);
    gl.uniform3f(this.#uniforms.u_divisor, ...f.unitDivisor);
    gl.uniform3f(this.#uniforms.u_offset, ...f.unitOffset);
  }

  /**
   * Draw one cell. `world` = {x, y, w, h} in level-0 pixels; `extent` = valid texels {w, h}.
   * `dataSlot` holds the true-value chunk; `maskSlot` holds its validity mask when present.
   */
  drawCell(world, extent, dataSlot, maskSlot = -1) {
    const gl = this.#gl;
    const nBand = this.#pool.nBand;
    gl.uniform4f(this.#uniforms.u_cell, world.x, world.y, world.w, world.h);
    gl.uniform2f(this.#uniforms.u_extent, extent.w, extent.h);
    gl.uniform1i(this.#uniforms.u_dataBase, dataSlot * nBand);
    if (this.#hasMask) {
      if (maskSlot < 0 || !this.hasMaskAt(maskSlot)) throw new Error(`drawCell: slot ${maskSlot} holds no validity mask; upload it with uploadMask first.`);
      gl.uniform1i(this.#uniforms.u_maskLayer, maskSlot);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The canvas as RGBA bytes, bottom row first (GL order). */
  readFrame(width, height) {
    const gl = this.#gl;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  /** Release the GL context (an offscreen renderer that is finished with). */
  dispose() {
    this.#gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Block until queued GL work has finished (reads one pixel). For timing only. */
  finish() {
    const gl = this.#gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
}
