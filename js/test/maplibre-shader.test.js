import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERTEX_SHADER, fragmentShader } from '../maplibre/shader.js';
import { PRODUCT_GLSL } from '../shared/products-glsl.js';

const DTYPES = { uint8: { sampler: 'usampler2DArray', modulus: '255u' }, uint16: { sampler: 'usampler2DArray', modulus: '65535u' }, int16: { sampler: 'isampler2DArray', modulus: null }, float32: { sampler: 'sampler2DArray', modulus: null } };

test('the fragment shader is built per dtype: sampler and direct true-value reads', () => {
  for (const [dtype, { sampler, modulus }] of Object.entries(DTYPES)) {
    const source = fragmentShader({ dtype, hasMask: false });
    assert.ok(source.startsWith('#version 300 es\n'), dtype);
    assert.ok(!source.includes('${') && !source.includes('undefined'), `${dtype}: unexpanded template text`);
    assert.ok(source.includes(`uniform ${sampler} u_data;`), `${dtype}: sampler`);
    assert.ok(source.includes('u_dataBase + band'));
    assert.doesNotMatch(source, /u_deltaBase|u_anchorBase|a \+ d/);
    assert.equal(source.includes('isnan(v)'), dtype === 'float32', `${dtype}: NaN counts as no data only for floats`);
  }
});

test('the product colors are the shared PRODUCT_GLSL, once; conversion and display mode are wired to the same uniforms as the viewer', () => {
  const source = fragmentShader({ dtype: 'uint16', hasMask: false });
  assert.equal(source.split(PRODUCT_GLSL).length - 1, 1);
  for (const name of ['u_scale', 'u_divisor', 'u_offset', 'u_display', 'u_range', 'u_hasNodata', 'u_nodata', 'u_stretchLo']) assert.match(source, new RegExp(`uniform \\w+ ${name};`), name);
  assert.ok(source.includes('u_display == 1 ? shadeLinear(u_product, x, u_range) : shade(u_product, x, u_stretchLo)'));
  assert.ok(source.includes('if (empty) discard;'), 'no data is transparent, not a background color');
});

test('a mask adds its sampler and discards masked texels; without one there is no mask sampler', () => {
  const masked = fragmentShader({ dtype: 'uint16', hasMask: true });
  assert.ok(masked.includes('uniform usampler2DArray u_mask;'));
  assert.ok(masked.includes('texelFetch(u_mask, ivec3(texel, u_maskLayer), 0).r == 0u) discard;'));
  const plain = fragmentShader({ dtype: 'uint16', hasMask: false });
  assert.ok(!plain.includes('u_mask;') && !plain.includes('texelFetch(u_mask'));
});

test('unknown dtypes are refused naming the supported ones; the vertex shader takes the origin-relative matrix and texel attributes', () => {
  assert.throws(() => fragmentShader({ dtype: 'float64', hasMask: false }), /no shader for data type float64.*uint8, uint16, int16, float32/);
  assert.ok(VERTEX_SHADER.includes('uniform mat4 u_matrix;') && VERTEX_SHADER.includes('in vec2 a_pos;') && VERTEX_SHADER.includes('in vec2 a_texel;'));
});
