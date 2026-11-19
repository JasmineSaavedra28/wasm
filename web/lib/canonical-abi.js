/*
 * ABI canónica del WebAssembly Component Model, a mano.
 *
 * La ABI canónica define cómo se representan los tipos del componente
 * (list<u8>, string, record, ...) cuando cruzan el borde hacia un módulo
 * core. Las reglas que se demuestran acá:
 *
 *   list<u8>  -> (ptr: i32, len: i32)      bytes en memoria lineal
 *   string    -> (ptr: i32, len: i32)      UTF-8, sin terminador
 *   record    -> parámetros aplanados      sin padding entre campos
 *   bool      -> i32 (0 o 1)
 *   u8/u16/u32-> i32 (se usa el ancho mínimo en memoria, i32 en parámetros)
 *
 * En un componente real, el adaptador generado por wit-bindgen / jco hace
 * este trabajo. Acá lo hacemos explícito para que se vea la ABI.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class CanonicalHost {
  /**
   * @param {WebAssembly.Instance} instance módulo core con "memory",
   *   "__heap_base" y "process_rgba".
   */
  constructor(instance) {
    this.instance = instance;
    this.exports = instance.exports;
    this.memory = this.exports.memory;
    if (!(this.memory instanceof WebAssembly.Memory)) {
      throw new Error('El módulo no exporta "memory"');
    }
    const heapBase = this.exports.__heap_base;
    this.heapBase = heapBase ? Number(heapBase.value) : 65536;
    /* Arena por encima de la pila del módulo (ver WasmImageProcessor). */
    this.arenaBase = this.memory.buffer.byteLength;
    this.offset = this.arenaBase;
    this.allocations = 0;
  }

  /** Bytes disponibles en la memoria lineal actual. */
  get capacity() {
    return this.memory.buffer.byteLength;
  }

  /** Alinea un offset (la ABI canónica usa la alineación natural del tipo). */
  static alignTo(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
  }

  /**
   * Equivalente manual de cabi_realloc: un bump allocator sobre la memoria
   * lineal. Si no alcanza, se pide memoria al host con memory.grow().
   * @param {number} size
   * @param {number} alignment
   */
  alloc(size, alignment = 1) {
    const start = CanonicalHost.alignTo(this.offset, alignment);
    const end = start + size;
    if (end > this.capacity) {
      const missing = end - this.capacity;
      this.memory.grow(Math.ceil(missing / 65536));
    }
    this.offset = end;
    this.allocations++;
    return start;
  }

  reset() {
    this.offset = this.arenaBase;
    this.allocations = 0;
  }

  /** @param {Uint8Array} bytes */
  lowerListU8(bytes) {
    const ptr = this.alloc(bytes.length, 1);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length, bytes: bytes.length, alignment: 1 };
  }

  /** @param {string} text */
  lowerString(text) {
    const bytes = encoder.encode(text);
    const ptr = this.alloc(bytes.length, 1);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    return {
      ptr,
      len: bytes.length,
      bytes: bytes.length,
      alignment: 1,
      utf16Length: text.length,
      utf8Length: bytes.length,
    };
  }

  liftListU8(ptr, len) {
    return Uint8Array.from(new Uint8Array(this.memory.buffer, ptr, len));
  }

  liftString(ptr, len) {
    return decoder.decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  /**
   * Aplana un record { data: list<u8>, width: u32, height: u32, mode: u8 }
   * y llama a la función core process_rgba(ptr, len, width, height, mode).
   */
  processImage({ pixels, width, height, mode = 0 }) {
    const isBytes = pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray;
    if (!isBytes) throw new TypeError('pixels debe ser Uint8Array');
    if (pixels.length !== width * height * 4) {
      throw new RangeError(`len=${pixels.length} no coincide con ${width}x${height}x4`);
    }

    const list = this.lowerListU8(pixels);
    const params = [list.ptr, list.len, width, height, mode];
    const result = this.exports.process_rgba(...params);

    return {
      result,
      pixels: this.liftListU8(list.ptr, list.len),
      lowered: { list, params },
    };
  }

  /** Volcado hexadecimal de un rango de memoria, para inspeccionar la ABI. */
  hexdump(ptr, len, maxBytes = 512) {
    const n = Math.min(len, maxBytes);
    const bytes = new Uint8Array(this.memory.buffer, ptr, n);
    const lines = [];
    for (let i = 0; i < n; i += 16) {
      const chunk = bytes.subarray(i, Math.min(i + 16, n));
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...chunk]
        .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
        .join('');
      lines.push({
        offset: ptr + i,
        hex: hex.padEnd(16 * 3 - 1, ' '),
        ascii,
      });
    }
    return lines;
  }
}

export const WIT_CONTRACT = `package demo:grayscale@1.0.0;

interface filters {
  /// Modo del filtro: el componente no conoce las implementaciones.
  enum mode {
    grayscale,
    invert,
    sepia,
  }

  /// Un frame RGBA: width * height * 4 bytes.
  record image {
    data: list<u8>,
    width: u32,
    height: u32,
  }

  /// Devuelve la cantidad de píxeles procesados o un error legible.
  process: func(img: image, mode: mode) -> result<u32, string>;
}

world grayscale-world {
  export filters;
}
`;
