/* Carga y envoltura de los módulos WASM (sin glue code de Emscripten). */

export async function loadInstance(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${response.status})`);

  if (WebAssembly.instantiateStreaming) {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
      return instance;
    } catch {
      /* El servidor puede no enviar Content-Type: application/wasm. */
    }
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance;
}

/**
 * Procesa búferes RGBA in-place dentro de la memoria lineal del módulo.
 * Mantiene un único búfer reservado y lo reutiliza entre frames: no hay
 * asignaciones por frame (ese es justamente el punto frente a JS/GC).
 */
export class WasmImageProcessor {
  /**
   * @param {WebAssembly.Instance} instance
   * @param {string} exportName nombre de la función exportada
   */
  constructor(instance, exportName) {
    this.exports = instance.exports;
    this.exportName = exportName;
    this.memory = this.exports.memory;
    if (!(this.memory instanceof WebAssembly.Memory)) {
      throw new Error('El módulo no exporta memoria');
    }
    const heapBase = this.exports.__heap_base;
    this.heapBase = heapBase ? Number(heapBase.value) : 65536;
    /* La pila del módulo vive al final de la memoria inicial y crece hacia
     * abajo. Para no pisarla, el arena de JS empieza en el byteLength actual
     * (es decir, por encima de la pila) y crece hacia arriba con memory.grow. */
    this.arenaBase = this.memory.buffer.byteLength;
    this.ptr = this.arenaBase;
    this.capacity = 0;
  }

  /** Asegura capacidad y devuelve un puntero dentro de la memoria wasm. */
  ensureCapacity(bytes) {
    if (bytes <= this.capacity) return this.ptr;
    const start = Math.ceil(this.memory.buffer.byteLength / 16) * 16;
    const end = start + bytes;
    if (end > this.memory.buffer.byteLength) {
      const missing = end - this.memory.buffer.byteLength;
      this.memory.grow(Math.ceil(missing / 65536));
    }
    this.ptr = start;
    this.capacity = bytes;
    return this.ptr;
  }

  /**
   * @param {Uint8Array | Uint8ClampedArray} data RGBA, len múltiplo de 4
   * @returns {Uint8Array} vista sobre la memoria del módulo (no copiar de más)
   */
  process(data) {
    if (data.length % 4 !== 0) throw new RangeError('El búfer debe ser RGBA');
    const ptr = this.ensureCapacity(data.length);
    new Uint8Array(this.memory.buffer, ptr, data.length).set(data);
    this.exports[this.exportName](ptr, data.length / 4);
    return new Uint8Array(this.memory.buffer, ptr, data.length);
  }
}

/** Lista de exports/imports, útil para mostrar en la UI. */
export function describeModule(instance) {
  const exports = Object.entries(instance.exports).map(([name, value]) => ({
    name,
    kind:
      value instanceof WebAssembly.Memory
        ? 'memory'
        : value instanceof WebAssembly.Global
          ? 'global'
          : value instanceof WebAssembly.Table
            ? 'table'
            : 'function',
  }));
  return { exports };
}
