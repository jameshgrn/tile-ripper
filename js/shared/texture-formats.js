/**
 * How each stored data type lives on the GPU: texture format, upload types, and the GLSL that reads a value as a
 * float. Every texture holds true stored values.
 */
export const TEXTURE_FORMATS = {
  uint8: { internal: 'R8UI', format: 'RED_INTEGER', type: 'UNSIGNED_BYTE', Array: Uint8Array, sampler: 'usampler2DArray' },
  uint16: { internal: 'R16UI', format: 'RED_INTEGER', type: 'UNSIGNED_SHORT', Array: Uint16Array, sampler: 'usampler2DArray' },
  int16: { internal: 'R16I', format: 'RED_INTEGER', type: 'SHORT', Array: Int16Array, sampler: 'isampler2DArray' },
  float32: { internal: 'R32F', format: 'RED', type: 'FLOAT', Array: Float32Array, sampler: 'sampler2DArray' },
};
