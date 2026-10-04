import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXTURE_FORMATS, fragmentShader } from '../demo/renderer.js';
import { PRODUCT_GLSL } from '../shared/products-glsl.js';
import { GAIN, PRODUCTS } from '../shared/products.js';

test('the product GLSL defines shade() and shadeLinear() with stable signatures, and the tone map gain of products.js', () => {
  assert.match(PRODUCT_GLSL, /vec4 shade\(int product, vec3 x, float stretchLo\)/);
  assert.match(PRODUCT_GLSL, /vec4 shadeLinear\(int product, vec3 x, vec2 range\)/);
  assert.match(PRODUCT_GLSL, new RegExp(`const float GAIN = ${GAIN.toFixed(1)};`));
  assert.ok(PRODUCTS.every((p, i) => p.shader === i), 'shader numbers are the product positions the GLSL branches on');
});

test('each data type gets a fragment shader with its sampler, the shared product code, and direct true-value reads', () => {
  for (const [dtype, format] of Object.entries(TEXTURE_FORMATS)) {
    const source = fragmentShader(dtype);
    assert.ok(source.startsWith('#version 300 es'), dtype);
    assert.ok(source.includes(`uniform ${format.sampler} u_data;`), dtype);
    assert.ok(source.includes(PRODUCT_GLSL), `${dtype} includes the product code unchanged`);
    assert.match(source, /shade\(u_product, x, u_stretch_lo\)/);
    assert.doesNotMatch(source, /u_deltaBase|u_anchorBase|a \+ d/);
    assert.match(source, /u_dataBase \+ band/);
  }
  assert.match(fragmentShader('float32'), /isnan\(v\)/, 'NaN is nodata in float data');
  assert.doesNotMatch(fragmentShader('uint16'), /isnan/);
});

test('texture formats pair the GL internal format with upload types and a typed array of the same width', () => {
  assert.deepEqual(Object.keys(TEXTURE_FORMATS), ['uint8', 'uint16', 'int16', 'float32']);
  const widths = { uint8: 1, uint16: 2, int16: 2, float32: 4 };
  for (const [dtype, format] of Object.entries(TEXTURE_FORMATS)) {
    assert.equal(format.Array.BYTES_PER_ELEMENT, widths[dtype], dtype);
    assert.ok(format.internal.includes(String(widths[dtype] * 8)), `${dtype}: ${format.internal}`);
  }
});

test('the mask variant of each shader reads one mask layer per slot, writes the background where it is 0, and leaves the rest alone', () => {
  for (const dtype of Object.keys(TEXTURE_FORMATS)) {
    const plain = fragmentShader(dtype);
    const masked = fragmentShader(dtype, true);
    assert.doesNotMatch(plain, /u_mask/, `${dtype}: the plain shader has no mask`);
    assert.match(masked, /uniform usampler2DArray u_mask;/, dtype);
    assert.match(masked, /uniform int u_maskLayer;/, dtype);
    assert.match(masked, /texelFetch\(u_mask, ivec3\(texel, u_maskLayer\), 0\)\.r == 0u\)/, `${dtype}: mask 0 is invalid`);
    assert.match(masked, /outColor = vec4\(BG, 1\.0\);\s*return;\s*\}\s*float v0/, `${dtype}: invalid pixels get the opaque background before any data is read`);
    const withoutMask = masked.replace(/  if \(texelFetch\(u_mask[\s\S]*?\n  \}\n/, '').split('\n').filter((line) => !/u_mask/.test(line));
    assert.deepEqual(withoutMask.filter(Boolean), plain.split('\n').filter(Boolean), `${dtype}: apart from the mask lines the two programs are the same`);
  }
});
