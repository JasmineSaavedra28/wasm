# Informe · ANALISIS_WASM-02

## Procesamiento de imágenes RGBA en WebAssembly: C, C++ y Rust frente a la ABI canónica y la ABI de Ethereum

---

## Resumen

Se implementó el ejemplo **ANALISIS_WASM-02** —conversión de un frame RGBA a escala de grises y
otros filtros— en tres lenguajes compilados a WebAssembly: **C**, **C++** y **Rust**. Sobre esa
base se construyeron dos demostraciones de frontera de datos:

1. La **ABI canónica** del Component Model, que traduce `list<u8>`, `string` y `record` a
   punteros y longitudes sobre la memoria lineal.
2. La **ABI de Ethereum**, que serializa metadatos en palabras de 32 bytes con selector de
   4 bytes, cabecera/cola y un costo medible en gas.

El trabajo incluye una demo web ejecutable, 23 tests automatizados, un benchmark de kernels y un
contrato Solidity compilado con `solc`. La conclusión central es que WebAssembly funciona como
un **microservicio funcional**: recibe bytes, devuelve bytes y no conoce el DOM, la red ni el
lenguaje del host. La ventaja no es siempre la velocidad bruta —V8 es muy competitivo en un lazo
simple— sino la predictibilidad, la ausencia de GC, el aislamiento y la reutilización de código
nativo existente.

---

## 1. Introducción y objetivos

### 1.1 Contexto

El procesamiento de imágenes en el navegador suele escribirse en JavaScript. Para frames RGBA
grandes, el costo dominante es recorrer millones de bytes y aplicar una transformación por píxel.
WebAssembly permite mover ese lazo a código compilado, pero introduce una pregunta de diseño:
**¿cómo cruzan los datos la frontera?**

La respuesta depende del contrato. No es lo mismo pasar un `Uint8ClampedArray` a una función
generada por `wasm-bindgen` —que puede copiarlo— que pasar un offset y un largo a un módulo que
procesa in-place. Tampoco es lo mismo serializar píxeles para Ethereum que registrar únicamente
el hash de sus parámetros.

### 1.2 Objetivos

- Implementar el filtro en C, C++ y Rust, con un contrato común y resultados idénticos.
- Aplicar principios SOLID en el diseño de los filtros y del motor.
- Mostrar WebAssembly como microservicio funcional, sin *glue code* obligatorio.
- Explicar y ejecutar la **ABI canónica** del Component Model.
- Explicar y ejecutar la **ABI de Ethereum**, incluyendo selector, palabras, cabecera/cola y gas.
- Verificar todo con tests y un benchmark reproducible.

### 1.3 Alcance

La demo usa módulos WebAssembly **core** (no componentes empaquetados) y los carga con
`WebAssembly.instantiate`. La ABI canónica se implementa a mano en JavaScript para hacer visible
el mecanismo que normalmente generaría `wit-bindgen` o `jco`. Rust se entrega como fuente y
manifiesto de compilación; el entorno de desarrollo no incluye `rustc`.

---

## 2. WebAssembly como microservicio funcional

### 2.1 El módulo como función pura sobre bytes

Un módulo WASM no tiene acceso ambiente al DOM, al sistema de archivos ni a la red. Solo puede
usar su memoria lineal y las funciones que el host le importe. En este trabajo el módulo no
importa nada: su lista de imports está vacía.

```text
        host JS                         módulo WASM
┌──────────────────────┐        ┌──────────────────────────┐
│ ImageData RGBA       │        │ memoria lineal           │
│  ── copia a ptr ──▶  │───────▶│ [R G B A][R G B A]...    │
│                      │        │                          │
│ apply_grayscale(ptr) │───────▶│ process_image(...)       │
│                      │        │   filtro por píxel       │
│  ◀── mismo ptr ───   │◀───────│ in-place, sin alloc      │
└──────────────────────┘        └──────────────────────────┘
```

El contrato es mínimo:

```c
void apply_grayscale(uint8_t *pixels, int num_pixels);
```

No hay objetos, ni excepciones, ni ownership transferido. Hay un puntero, un largo y una
convención: **RGBA de 4 bytes por píxel**. Esa convención es la interfaz.

### 2.2 Ventajas y límites

| Aspecto | Implicación |
| --- | --- |
| **Aislamiento** | El módulo no puede leer el DOM ni la red; solo su memoria. |
| **Predictibilidad** | Sin GC ni pausas del recolector; el costo por frame es estable. |
| **Portabilidad** | El mismo `.wasm` corre en navegador, Node, edge y runtimes embebidos. |
| **Reutilización** | C/C++/Rust existentes se compilan sin reescribir la lógica. |
| **Copia** | El host debe copiar los datos a la memoria lineal (o compartir un buffer). |
| **Arranque** | Hay un costo de instanciación y de crecimiento de memoria. |
| **Depuración** | El borde binario complica el *debug* si no se conservan nombres y mapas. |

La copia es inevitable en el modelo de memoria actual: JS y WASM no comparten objetos, solo
bytes. El diseño correcto minimiza la cantidad de copias y evita asignaciones por frame.

---

## 3. Arquitectura del ejemplo

### 3.1 Capas

```text
┌─────────────────────────────────────────────────────────────┐
│ UI (index.html + app.js + styles.css)                       │
│  canvas, telemetría, tabs, comparador, ABIs                  │
├─────────────────────────────────────────────────────────────┤
│ Adaptadores JS                                              │
│  wasm.js            → carga + arena + process(data)         │
│  canonical-abi.js   → lowering/lifting de tipos WIT         │
│  ethereum-abi.js    → encode/decode + gas                   │
│  keccak.js          → Keccak-256                            │
├─────────────────────────────────────────────────────────────┤
│ Módulos WASM core                                           │
│  grayscale.wasm (C)   grayscale_cpp.wasm (C++)              │
├─────────────────────────────────────────────────────────────┤
│ Contrato / metadatos                                        │
│  wit/grayscale.wit      contracts/PixelFilterRegistry.sol   │
└─────────────────────────────────────────────────────────────┘
```

La UI no habla directamente con `memory`; usa `WasmImageProcessor`, que encapsula la reserva
del arena, la copia y la llamada. La ABI canónica usa `CanonicalHost`, que encapsula el
*allocator* de *bump* y las operaciones de *lowering*/*lifting*.

### 3.2 Memoria y arena

El módulo exporta `memory` y `__heap_base`. La pila del módulo vive al final de la memoria
inicial y crece hacia abajo. Para no pisarla, el host reserva a partir de
`memory.buffer.byteLength` (por encima de la pila) y crece con `memory.grow`:

```js
this.arenaBase = this.memory.buffer.byteLength;
this.ptr = this.arenaBase;
```

`ensureCapacity(bytes)` reutiliza el mismo bloque entre frames. No hay asignaciones por frame:
ese es el punto frente a un enfoque con objetos temporales y GC.

---

## 4. Implementaciones y SOLID

### 4.1 C · punteros a función

```c
typedef void (*PixelFilter)(uint8_t *r, uint8_t *g, uint8_t *b);

static void process_image(uint8_t *pixels, int num_pixels, PixelFilter filter) {
    for (int i = 0; i < num_pixels * 4; i += 4) {
        filter(&pixels[i], &pixels[i + 1], &pixels[i + 2]);
    }
}

__attribute__((export_name("apply_grayscale")))
void apply_grayscale(uint8_t *pixels, int num_pixels) {
    process_image(pixels, num_pixels, grayscale_filter);
}
```

- **SRP**: `grayscale_filter`, `invert_filter` y `sepia_filter` hacen una sola cosa.
- **OCP**: agregar un filtro no modifica `process_image`; se agrega la función y su caso en
  `filter_for_mode`.
- **DIP**: `process_image` depende de la firma `PixelFilter`, no de una implementación.

Se agregó `apply_grayscale_direct` para medir el costo de la indirección (`call_indirect`) frente
a una versión con la fórmula inlineada.

### 4.2 C++ · clase abstracta

```cpp
class IImageFilter {
public:
    virtual ~IImageFilter() = default;
    virtual void apply(uint8_t &r, uint8_t &g, uint8_t &b) const = 0;
};

static void process_image(uint8_t *pixels, int num_pixels, const IImageFilter &filter) {
    for (int i = 0; i < num_pixels * 4; i += 4) {
        filter.apply(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
}
```

La variante `grayscale_plain.cpp` se compila en modo *freestanding* (`-nostdlib`,
`-fno-exceptions`, `-fno-rtti`). La variante `grayscale_embind.cpp` conserva el diseño con
Emscripten y embind, pero documenta dos problemas:

1. `vecFromJSArray<uint8_t>` recorre el array elemento por elemento; para 60 fps es el cuello de
   botella que se quería evitar.
2. Devolver un `typed_memory_view` de un `std::vector` local deja un puntero colgante.

La versión corregida usa `convertJSArrayToNumberVector` y copia explícitamente a un `Uint8Array`
de JS, además de ofrecer `processPtr(ptr, len, mode)` zero-copy.

### 4.3 Rust · trait

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

`chunks_exact_mut(4)` permite al compilador eliminar comprobaciones por píxel y el préstamo
mutable impide dos referencias simultáneas. `apply_grayscale_ptr(ptr, len)` evita la copia de
wasm-bindgen; `process_rgba(ptr, len, width, height, mode)` replica la firma C.

### 4.4 Tabla SOLID

| Principio | C | C++ | Rust |
| --- | --- | --- | --- |
| **SRP** | una función por filtro | una clase por filtro | un `impl` por filtro |
| **OCP** | nueva función + caso | nueva clase + caso | nuevo `impl` + caso |
| **DIP** | `PixelFilter` | `IImageFilter&` | `&dyn ImageFilter` |
| **Borde** | JS elige el export | JS elige el export | JS elige el export |

La inversión de dependencias real está en el host: la UI decide qué backend usar y todos
respetan el mismo contrato de bytes. El módulo no sabe si lo llama una demo, un test o un
servicio.

---

## 5. ABI canónica del Component Model

### 5.1 Qué resuelve

El Component Model separa la **interfaz** (WIT) de la **representación** (ABI canónica). WIT
describe tipos de alto nivel; la ABI canónica define cómo se traducen a la memoria lineal del
módulo core. El objetivo es que dos lenguajes distintos puedan interoperar sin acordar un
formato ad hoc.

### 5.2 Contrato WIT

```wit
package demo:grayscale@1.0.0;

interface filters {
  enum mode { grayscale, invert, sepia }

  record image {
    data: list<u8>,
    width: u32,
    height: u32,
  }

  process: func(img: image, mode: mode) -> result<u32, string>;
}

world grayscale-world {
  export filters;
}
```

### 5.3 Reglas de representación

| Tipo WIT | Representación canónica |
| --- | --- |
| `list<u8>` | `(ptr: i32, len: i32)`; bytes en memoria, alineación 1 |
| `string` | `(ptr, len)` en UTF-8, sin terminador |
| `record` | campos aplanados como parámetros, sin padding |
| `u8`, `u16`, `u32` | ancho natural en memoria; `i32` en la frontera |
| `bool` | `i32` con valor 0 o 1 |
| `result<T, E>` | discriminante + carga útil |
| `enum` | discriminante entero |

### 5.4 Lowering y lifting en la demo

```js
// lowering: string -> UTF-8 -> (ptr, len)
const string = host.lowerString('grayscale-ñandú');

// lowering: list<u8> -> (ptr, len)
const list = host.lowerListU8(pixels);

// record aplanado: [ptr, len, width, height, mode]
const result = instance.exports.process_rgba(list.ptr, list.len, width, height, mode);

// lifting: se lee del mismo puntero, in-place
const output = host.liftListU8(list.ptr, list.len);
```

El caso del `string` es pedagógico: `"grayscale-ñandú"` tiene **17 bytes UTF-8** y **15 code
units UTF-16**. Si el host usara `string.length` como largo, el módulo leería dos bytes de menos
y corrompería el carácter final. La ABI canónica exige el largo en bytes.

### 5.5 Costo

El *lowering* de `list<u8>` no serializa: copia una vez al arena y pasa dos enteros. El
*lifting* puede ser zero-copy si el consumidor acepta una vista sobre la memoria del módulo. En
la demo se copia a un `Uint8Array` para desacoplar el ciclo de vida, pero el camino de la ABI es
`(ptr, len)`.

---

## 6. ABI de Ethereum

### 6.1 Qué resuelve

La ABI de Ethereum define cómo se codifican llamadas y retornos para la EVM. No es una ABI de
memoria compartida: es una **serialización binaria** que viaja en `calldata` y `returndata`. Cada
byte se paga en gas.

### 6.2 Contrato

```solidity
struct Filter {
    string name;
    uint8 mode;
    uint32 version;
    bytes32 paramsHash;
    bool enabled;
}

function registerFilter(
    bytes32 id,
    string calldata name,
    uint8 mode,
    uint32 version,
    bytes32 paramsHash
) external;

function getFilter(bytes32 id)
    external view
    returns (string memory, uint8, uint32, bytes32, bool);
```

El contrato registra **metadatos**, no píxeles. El procesamiento real ocurre en el cliente, en
WASM. Esa separación es la decisión de arquitectura más importante del ejemplo.

### 6.3 Selector

```text
firma = "registerFilter(bytes32,string,uint8,uint32,bytes32)"
hash  = keccak256(firma)
sel   = primeros 4 bytes = 0x1646a0c2
```

El selector permite a la EVM despachar la llamada. La demo lo calcula con una implementación
propia de Keccak-256 y lo verifica contra `viem` y contra la ABI compilada por `solc`.

### 6.4 Palabras, cabecera y cola

Cada argumento ocupa una palabra de 32 bytes, big-endian, alineada a la derecha. Los tipos
dinámicos (`string`, `bytes`, arrays) no caben en la cabecera: en su lugar va un **offset** y el
contenido se ubica en la **cola**.

Para el ejemplo de la UI:

```text
offset  contenido
0x00    id           bytes32
0x20    0x00...a0    offset a la cola
0x40    mode         uint8 = 0
0x60    version      uint32 = 3
0x80    paramsHash   bytes32
0xa0    length       17
0xc0    "grayscale-ñandú" + padding
```

Tamaño total: **228 bytes** (4 de selector + 160 de cabecera + 32 de largo + 32 de datos).

### 6.5 Gas

Costo intrínseco del calldata:

```text
21.000            base de transacción
+ 140 × 4         bytes cero
+  88 × 16        bytes distintos de cero
= 22.968 gas
```

Un frame RGBA de 1 MB:

```text
21.000 + 16 × 1.048.576 = 16.798.216 gas
```

Con un límite de bloque de 30 M de gas, eso es **0,56 bloques solo para enviar los bytes**, sin
ejecución ni almacenamiento. La conclusión es inmediata: los píxeles no van on-chain. Ethereum
se usa para registrar el filtro, su versión y el hash de sus parámetros; el frame se procesa en
el cliente.

---

## 7. Resultados

### 7.1 Verificación funcional

```text
23 tests · 23 pass · 0 fail
```

| Suite | Qué verifica |
| --- | --- |
| `wasm.test.mjs` | C/C++ vs JS, idempotencia, alfa, modos, validación, exports |
| `canonical-abi.test.mjs` | UTF-8 vs UTF-16, `(ptr, len)`, record aplanado, hexdump, arena |
| `ethereum-abi.test.mjs` | Keccak vs `viem`, selector, encode/decode, gas, `solc` |

Los checksums de C, C++ y JS son idénticos en el benchmark (`0x74a0e38f` en la corrida de
referencia), lo que confirma que las tres implementaciones aplican exactamente la misma
transformación.

### 7.2 Tamaños

| Módulo | Bytes | Observación |
| --- | ---: | --- |
| `grayscale.wasm` (C) | 2.071 | 5 exports de filtros + `process_rgba` |
| `grayscale_cpp.wasm` (C++) | 668 | 2 exports, sin libc++ |
| Rust | — | build con `wasm-pack`, no incluido |

Los binarios se generaron con `--strip-all`, sin Emscripten ni runtime intermedio.

### 7.3 Benchmark

Frame 1280×720 (3,69 MB), solo kernel, 60–120 iteraciones tras *warmup*:

| Implementación | ms/frame | FPS equivalentes | vs JS |
| --- | ---: | ---: | ---: |
| JavaScript | 3,55–3,80 | ~264–282 | 1,00× |
| C · función ptr | 5,06–5,54 | ~180–198 | 0,67–0,75× |
| C · directo | 4,94–5,17 | ~194–203 | 0,72–0,77× |
| C++ · virtual | 8,22–9,09 | ~110–122 | 0,42–0,46× |

Lectura:

- **V8 es muy bueno** en un lazo numérico simple con memoria caliente. WASM no gana
  automáticamente.
- **C++ virtual** paga `call_indirect` por píxel; la brecha frente a C muestra el costo del
  polimorfismo dinámico en este lazo.
- **C directo vs C con puntero** permite aislar parte de ese costo.
- La ventaja de WASM aparece en **predictibilidad**, ausencia de GC, aislamiento y reutilización
  de módulos nativos, no necesariamente en el *throughput* de un microbenchmark.

### 7.4 Demo en navegador

Verificado sin errores de consola:

- La demo corre a ~60 FPS con ~1–2 ms por frame en 640×480 (medido en el navegador).
- “Verificar píxeles” reporta diferencia máxima **0** entre C y JavaScript.
- La ABI canónica muestra los 4 pasos, el hexdump y el tamaño en páginas.
- La ABI Ethereum muestra las 7 palabras, decodifica, simula `getFilter` y calcula el gas.
- “Comparar backends” muestra las tres filas con checksums idénticos.

---

## 8. Correcciones al pseudocódigo original

| Problema | Corrección |
| --- | --- |
| Rust: `filter.apply(&mut chunk, &mut chunk[3], &mut chunk[7])` no compila y se sale del bloque | Pasar el bloque completo con `chunks_exact_mut(4)` |
| embind: `vecFromJSArray` copia elemento por elemento | `convertJSArrayToNumberVector` + copia explícita |
| embind: `typed_memory_view` de un `vector` local deja puntero colgante | Copiar a un `Uint8Array` propiedad de JS |
| Truncamiento no idempotente en grayscale | Redondeo `+ 0.5` / `Math.round` |
| Arena podía pisar la pila | Reservar por encima de `memory.buffer.byteLength` |
| Comparación colgada en pestaña oculta | `requestAnimationFrame` con *fallback* a `setTimeout` |

---

## 9. Conclusiones

1. **El contrato importa más que el lenguaje.** C, C++ y Rust producen el mismo resultado porque
   comparten la misma interfaz de bytes y la misma convención RGBA.
2. **La ABI canónica es una herramienta de diseño, no solo de serialización.** `(ptr, len)` y el
   aplanado de records eliminan copias y ambigüedades; el caso UTF-8 vs UTF-16 lo demuestra.
3. **La ABI de Ethereum tiene otro objetivo.** No sirve para mover píxeles: sirve para registrar
   metadatos de forma verificable. El costo de gas hace inviable cualquier otra cosa.
4. **WASM como microservicio funcional** permite aislar la lógica de imagen del host y
   reutilizarla en navegador, Node o edge sin reescribirla.
5. **El benchmark debe interpretarse con honestidad.** En este lazo, JS es más rápido; el valor
   de WASM está en la estabilidad, el aislamiento y el código existente.
6. **SOLID se aplica igual en el borde.** SRP en los filtros, OCP en el registro de modos y DIP
   en el motor producen código que se extiende sin recompilar la lógica central.

---

## 10. Reproducción

```bash
npm install
npm run dev        # http://localhost:8080/
npm test           # 23 tests
npm run bench      # C vs C++ vs JS
npm run contract   # solc -> build/PixelFilterRegistry.json
```

Recompilar WASM:

```bash
# Zig
ZIG=/ruta/a/zig npm run build

# clang (alternativa)
clang --target=wasm32-freestanding -O3 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base \
  -Wl,--strip-all -o web/assets/grayscale.wasm src/c/grayscale.c
```

Rust (opcional):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build src/rust --target web --release --out-dir ../../web/assets/rust
```

Componente canónico (opcional):

```bash
cargo install wasm-tools
wasm-tools component new \
  src/rust/target/wasm32-unknown-unknown/release/grayscale_wasm.wasm \
  -o build/grayscale.component.wasm
jco transpile build/grayscale.component.wasm -o web/assets/component
```

---

## Referencias

1. WebAssembly Core Specification. <https://webassembly.github.io/spec/>
2. WebAssembly Component Model. <https://github.com/WebAssembly/component-model>
3. Canonical ABI. <https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md>
4. WIT. <https://component-model.bytecodealliance.org/design/wit.html>
5. Solidity ABI Specification. <https://docs.soliditylang.org/en/latest/abi-spec.html>
6. Ethereum Yellow Paper. <https://ethereum.github.io/yellowpaper/paper.pdf>
7. Zig. <https://ziglang.org/download/>
8. wasm-bindgen. <https://rustwasm.github.io/wasm-bindgen/>
9. viem. <https://viem.sh/>
10. Emscripten embind. <https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html>
