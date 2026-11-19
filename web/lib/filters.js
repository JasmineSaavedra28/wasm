/* Filtros de referencia en JavaScript puro, para comparar con WASM. */

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Escala de grises Rec. 601, misma fórmula que C/C++/Rust. */
export function grayscaleJS(data) {
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11);
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
  return data;
}

export function invertJS(data) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  return data;
}

export function sepiaJS(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = clamp(0.393 * r + 0.769 * g + 0.189 * b);
    data[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b);
    data[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b);
  }
  return data;
}

export const FILTERS_JS = {
  grayscale: grayscaleJS,
  invert: invertJS,
  sepia: sepiaJS,
};

/** Diferencia máxima por canal entre dos búferes RGBA. */
export function maxChannelDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

/** Checksum rápido (FNV-1a de 32 bits) para comparar resultados. */
export function checksum(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Genera un patrón RGBA determinista para pruebas y benchmarks. */
export function syntheticFrame(width, height, t = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const wave = Math.sin((x + t) * 0.03) * Math.cos((y - t) * 0.05);
      data[i] = (x / width) * 255;
      data[i + 1] = (y / height) * 255;
      data[i + 2] = (wave * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return data;
}
