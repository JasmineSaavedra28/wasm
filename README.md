# ANALISIS_WASM-02 · Procesamiento de imágenes RGBA en WebAssembly

Implementación ejecutable del ejemplo **ANALISIS_WASM-02** en **C, C++ y Rust**, con una demo
web y dos fronteras de datos bien distintas:

- **ABI canónica** del WebAssembly Component Model: `list<u8>`, `string` y `record` bajados a
  `(ptr, len)` sobre la memoria lineal.
- **ABI de Ethereum**: selector de 4 bytes, palabras de 32 bytes, cabecera/cola para tipos
  dinámicos y costo en gas.

El objetivo no es solo “pasar un filtro a WASM”, sino mostrar **dónde vive el contrato** entre
el host y el módulo, qué se copia, qué se comparte y cuánto cuesta cada decisión.

---

## Inicio rápido

Requisitos: **Node.js 20.11+**. No hace falta Emscripten, Rust ni solc para ver la demo: los
`.wasm` de C y C++ están precompilados en `web/assets/`.

```bash
npm install
npm run dev
# abrir http://localhost:8080/
```

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor estático con MIME `application/wasm`. |
| `npm test` | 23 tests: kernels, ABI canónica, Keccak/ABI Ethereum y compilación del contrato. |
| `npm run bench` | Benchmark de los kernels C, C++ y JavaScript. |
| `npm run build` | Recompila los `.wasm` con Zig o clang. |
| `npm run contract` | Compila `PixelFilterRegistry.sol` con solc y guarda ABI + bytecode. |

### Recompilar los módulos

Con **Zig** (recomendado, no requiere SDK):

```bash
# Linux / macOS
ZIG=/ruta/a/zig npm run build

# Windows PowerShell
$env:ZIG='C:\ruta\a\zig.exe'; npm run build
```

También se puede usar `clang` con target `wasm32`; el script lo detecta solo. Los binarios
generados quedan en `web/assets/` y el manifiesto con tamaños, hashes y exports en
`web/assets/manifest.json`.

---

## La demo

La página tiene cuatro pestañas:

1. **Demo WASM** — un frame RGBA animado (patrón sintético o cámara) se copia a la memoria
   lineal, se procesa *in-place* y se vuelve a pintar. Permite cambiar entre C, C++ y
   JavaScript, ver FPS, ms/frame, MP/s y comparar los tres kernels sobre el mismo frame.
2. **ABI canónica** — muestra paso a paso el *lowering* de un `string`, un `list<u8>` y un
   `record`, la llamada a `process_rgba(ptr, len, width, height, mode)`, el *lifting* del
   resultado y un volcado hexadecimal de la memoria.
3. **ABI Ethereum** — codifica y decodifica `registerFilter(bytes32,string,uint8,uint32,bytes32)`,
   explica cada palabra de 32 bytes y calcula el gas intrínseco del calldata.
4. **Arquitectura** — SOLID, tabla de implementaciones, comparación de las dos ABIs y comandos
   de reproducción.

---

## Estructura

```text
.
├── src/
│   ├── c/grayscale.c              # punteros a función + export directo
│   ├── cpp/grayscale_plain.cpp    # clases abstractas, compilable sin Emscripten
│   ├── cpp/grayscale_embind.cpp   # versión Emscripten + embind (documentada)
│   └── rust/
│       ├── src/lib.rs             # trait ImageFilter + wasm-bindgen + zero-copy
│       ├── Cargo.toml
│       └── COMPONENT.md           # flujo wit-bindgen + wasm-tools + jco
├── wit/grayscale.wit              # contrato canónico (record, list<u8>, enum, result)
├── contracts/PixelFilterRegistry.sol
├── web/
│   ├── index.html                 # UI de las cuatro pestañas
│   ├── app.js                     # demo, comparación, ABIs
│   ├── styles.css
│   ├── lib/
│   │   ├── wasm.js                # carga + arena sobre la memoria lineal
│   │   ├── canonical-abi.js       # lowering/lifting a mano
│   │   ├── ethereum-abi.js        # encoder/decoder ABI + gas
│   │   ├── keccak.js              # Keccak-256 propio
│   │   └── filters.js             # referencia JS de los filtros
│   └── assets/                    # .wasm compilados + manifest.json
├── test/                          # node:test (23 tests)
├── bench/bench.mjs
├── scripts/
│   ├── build.mjs                  # Zig/clang -> wasm32-freestanding
│   ├── dev.mjs                    # servidor estático
│   └── compile-contract.mjs       # solc -> build/PixelFilterRegistry.json
└── package.json
```

---

## Tres implementaciones, un mismo contrato

Las tres reciben **bytes RGBA en memoria lineal** y procesan **in-place**. Ninguna conoce el
DOM, el canvas ni Ethereum.

### C · punteros a función

```c
typedef void (*PixelFilter)(uint8_t *r, uint8_t *g, uint8_t *b);

static void process_image(uint8_t *pixels, int n, PixelFilter filter) {
    for (int i = 0; i < n * 4; i += 4)
        filter(&pixels[i], &pixels[i + 1], &pixels[i + 2]);
}

__attribute__((export_name("apply_grayscale")))
void apply_grayscale(uint8_t *pixels, int n) {
    process_image(pixels, n, grayscale_filter);
}
```

El motor depende de la **firma** `PixelFilter`, no de `grayscale_filter`. Agregar un filtro es
agregar una función y una entrada en `filter_for_mode()`, sin tocar `process_image()`.

### C++ · clase abstracta

```cpp
class IImageFilter {
public:
    virtual ~IImageFilter() = default;
    virtual void apply(uint8_t &r, uint8_t &g, uint8_t &b) const = 0;
};

static void process_image(uint8_t *pixels, int n, const IImageFilter &filter) {
    for (int i = 0; i < n * 4; i += 4)
        filter.apply(pixels[i], pixels[i + 1], pixels[i + 2]);
}
```

`grayscale_plain.cpp` se compila con `zig c++`/`clang++` en modo *freestanding*: sin
excepciones, sin RTTI y sin libc++. La variante `grayscale_embind.cpp` muestra el mismo diseño
con **Emscripten + embind** y documenta dos errores típicos: `vecFromJSArray` recorre el
`Uint8ClampedArray` elemento por elemento, y devolver un `typed_memory_view` de un `std::vector`
local deja un puntero colgante.

### Rust · trait

```rust
pub trait ImageFilter {
    fn apply(&self, px: &mut [u8]);
}

pub fn process(pixels: &mut [u8], filter: &dyn ImageFilter) -> usize {
    let mut count = 0;
    for chunk in pixels.chunks_exact_mut(4) {
        filter.apply(chunk);
        count += 1;
    }
    count
}
```

`chunks_exact_mut(4)` le dice al compilador que cada bloque mide exactamente 4 bytes y el
préstamo mutable impide dos referencias simultáneas al mismo píxel. `apply_grayscale_ptr(ptr, len)`
evita la copia que hace wasm-bindgen con `&mut [u8]`; `process_rgba(ptr, len, w, h, mode)` es el
equivalente exacto de la función C.

---

## SOLID en el borde

| Principio | Dónde se ve |
| --- | --- |
| **SRP** | Cada filtro transforma un píxel. El motor solo itera y delega. |
| **OCP** | Agregar `sepia` no modifica `process_image` ni `process_rgba`; solo se agrega la implementación y su caso. |
| **DIP** | El motor depende de `PixelFilter`, `IImageFilter` o `dyn ImageFilter`, no de una implementación concreta. |
| **Borde** | La inversión real ocurre en JS: el host elige el backend (C, C++, JS) y el módulo no sabe quién lo llama. |

La consecuencia práctica: el mismo frame puede procesarse con tres módulos distintos y el
resultado debe ser **byte a byte idéntico** (los tests y la comparación de la UI lo verifican).

---

## ABI canónica del Component Model

El contrato está en `wit/grayscale.wit`:

```wit
record image {
  data: list<u8>,
  width: u32,
  height: u32,
}

process: func(img: image, mode: mode) -> result<u32, string>;
```

La ABI canónica no serializa: **traduce tipos a la memoria lineal**.

| Tipo WIT | Representación en el borde |
| --- | --- |
| `list<u8>` | `(ptr: i32, len: i32)`, alineación 1, sin copia si el dueño es el host |
| `string` | `(ptr, len)` en **UTF-8**, sin terminador; `len` son bytes, no code units |
| `record` | Campos aplanados como parámetros escalares, sin padding |
| `u8/u16/u32` | Enteros en memoria del ancho natural; `i32` al cruzar la frontera |
| `result<u32, string>` | Discriminante + carga útil (variante) |

La demo lo hace a mano en `web/lib/canonical-abi.js` para que se vea el mecanismo:

```js
const list = host.lowerListU8(pixels);          // list<u8> -> (ptr, len)
const params = [list.ptr, list.len, width, height, mode];
const result = instance.exports.process_rgba(...params);
const output = host.liftListU8(list.ptr, list.len); // mismo puntero, in-place
```

Ejemplo real de la UI: `"grayscale-ñandú"` ocupa **17 bytes UTF-8** pero **15 code units** en
JavaScript. Usar `string.length` como largo en bytes corrompería el último carácter.

En producción, `wit-bindgen` (Rust/C) o `jco` (JS) generan este *glue*. Acá se escribe a mano
para que la ABI deje de ser magia.

---

## ABI de Ethereum

El contrato `PixelFilterRegistry.sol` registra **metadatos** de filtros, no píxeles:

```solidity
function registerFilter(
    bytes32 id,
    string calldata name,
    uint8 mode,
    uint32 version,
    bytes32 paramsHash
) external;
```

La demo implementa el encoder/decoder y Keccak-256 desde cero, y los verifica contra `viem`.

### Selector

```text
keccak256("registerFilter(bytes32,string,uint8,uint32,bytes32)")
  -> 0x1646a0c2...
selector = primeros 4 bytes = 0x1646a0c2
```

### Cabecera y cola

Cada argumento estático ocupa **32 bytes**. `string` es dinámico: en la cabecera queda un
**offset** (160 = `0xa0`) y en la cola va `largo + datos` rellenados a 32 bytes.

```text
0x00  id           bytes32
0x20  offset       0xa0  -> cola
0x40  mode         uint8
0x60  version      uint32
0x80  paramsHash   bytes32
0xa0  length       17
0xc0  "grayscale-ñandú" + padding
```

Para el ejemplo de la UI: **228 bytes** de calldata, **22.968 gas** intrínsecos (21.000 de
transacción + 140 bytes cero × 4 + 88 bytes no cero × 16).

### Por qué no se procesan píxeles on-chain

Un frame RGBA de 1 MB como calldata cuesta:

```text
21.000 + 16 × 1.048.576 = 16.798.216 gas
```

Es **0,56 bloques** de 30 M de gas solo para *enviar* los bytes, sin ejecutar nada ni almacenar.
Por eso el patrón correcto es: **procesar en WASM en el cliente** y usar Ethereum para
metadatos, permisos, versiones y hashes.

---

## Resultados

### Tests

```text
23 tests, 23 pass, 0 fail
```

Cubren: igualdad C/C++/JS en varios tamaños, idempotencia del redondeo, preservación del canal
alfa, los tres modos de `process_rgba`, validación de `len == width × height × 4`, lowering/lifting
de la ABI canónica, Keccak contra `viem`, encode/decode contra `viem`, gas y compilación real
del contrato con `solc`.

### Tamaños

| Módulo | `.wasm` | Exports principales |
| --- | ---: | --- |
| C | **2.071 B** | `apply_grayscale`, `apply_grayscale_direct`, `process_rgba`, `apply_invert`, `apply_sepia` |
| C++ | **668 B** | `apply_grayscale_cpp`, `apply_invert_cpp` |
| Rust | fuente + `Cargo.toml` | build con `wasm-pack` (no incluido en `web/assets`) |

### Benchmark (1280×720, 3,69 MB por frame, solo kernel)

Una corrida representativa con `npm run bench`:

| Implementación | ms/frame | FPS equivalentes | vs JS |
| --- | ---: | ---: | ---: |
| JavaScript | 3,55–3,80 | ~264–282 | 1,00× |
| C · función ptr | 5,06–5,54 | ~180–198 | 0,67–0,75× |
| C · directo | 4,94–5,17 | ~194–203 | 0,72–0,77× |
| C++ · virtual | 8,22–9,09 | ~110–122 | 0,42–0,46× |

Los checksums de los cuatro caminos son idénticos (`0x74a0e38f` en la corrida de referencia).

**Lectura honesta:** en un lazo tan simple y con memoria ya caliente, el JIT de V8 es muy
competitivo. WASM no gana por velocidad bruta acá; gana en **predictibilidad**, ausencia de GC,
aislamiento y, sobre todo, en poder reutilizar módulos C/C++/Rust ya existentes. El costo del
polimorfismo dinámico se ve en C++ (`call_indirect` por píxel), y la diferencia entre
`apply_grayscale` y `apply_grayscale_direct` permite medir esa indirección.

---

## Decisiones y correcciones al pseudocódigo original

1. **Rust**: el pseudocódigo hacía `filter.apply(&mut chunk, &mut chunk[3], &mut chunk[7])`.
   No compila (`chunk` es `&mut [u8]`, no `u8`) y se salía del bloque de 4 bytes. La versión
   correcta pasa el bloque completo y usa `chunks_exact_mut(4)`.
2. **embind**: `vecFromJSArray` recorre el array elemento por elemento y devolver un
   `typed_memory_view` de un `std::vector` local deja un puntero colgante. Se corrigió con
   `convertJSArrayToNumberVector` + copia explícita a un `Uint8Array` de JS, y se agregó el
   camino `processPtr(ptr, len, mode)` zero-copy.
3. **Redondeo**: el truncamiento hacía que aplicar grayscale dos veces oscureciera un nivel.
   Se usa `+ 0.5` en C/C++/Rust y `Math.round` en JS; el test de idempotencia lo verifica.
4. **Arena**: el host reserva por encima de la pila del módulo (`memory.buffer.byteLength` al
   arrancar) y crece con `memory.grow`. Así no pisa el stack ni asigna por frame.
5. **Pestañas ocultas**: la comparación espera un *paint* con `requestAnimationFrame`, pero con
   un *fallback* a `setTimeout` para no quedar colgada cuando el documento no es visible.

---

## Limitaciones

- La demo usa **JS puro** y módulos core; no requiere bundler ni framework.
- La ABI canónica se implementa a mano sobre un módulo core. Un componente real necesita
  `wit-bindgen`/`jco` y un runtime con soporte de componentes.
- Rust no se compila en este entorno (no hay `rustc`); el código y el flujo están documentados
  en `src/rust/`.
- El contrato es educativo: no tiene control de acceso ni almacenamiento optimizado.
- El benchmark mide **solo el kernel**, no la copia hacia/desde el canvas ni el dibujado.

---

## Referencias

- WebAssembly Core Specification — <https://webassembly.github.io/spec/>
- WebAssembly Component Model — <https://github.com/WebAssembly/component-model>
- Canonical ABI — <https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md>
- WIT — <https://component-model.bytecodealliance.org/design/wit.html>
- Solidity ABI spec — <https://docs.soliditylang.org/en/latest/abi-spec.html>
- Ethereum Yellow Paper (gas) — <https://ethereum.github.io/yellowpaper/paper.pdf>
- Zig — <https://ziglang.org/download/>
- wasm-bindgen — <https://rustwasm.github.io/wasm-bindgen/>
- viem — <https://viem.sh/>
