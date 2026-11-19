/*
 * ANALISIS_WASM-02 — Implementación en C
 * ---------------------------------------
 * Objetivo: convertir un búfer RGBA a escala de grises (y otros filtros)
 * iterando directamente sobre memoria lineal, sin asignaciones ni GC.
 *
 * Principios SOLID aplicados:
 *   SRP  -> cada filtro hace una sola cosa (grayscale_filter, invert_filter...).
 *   OCP  -> agregar un filtro nuevo no obliga a tocar process_image().
 *   DIP  -> process_image() depende de la interfaz PixelFilter (puntero a
 *           función), no de una implementación concreta.
 *
 * Compilación (sin Emscripten, sin libc):
 *   zig cc -target wasm32-freestanding -O3 -nostdlib \
 *     -Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base \
 *     -o web/assets/grayscale.wasm src/c/grayscale.c
 *
 *   (también funciona con clang --target=wasm32 ...)
 *
 * La memoria la exporta el linker como "memory". JS escribe los píxeles en
 * esa memoria y llama a apply_grayscale(ptr, num_pixels). No hay copias
 * intermedias ni "glue code".
 */

#include <stdint.h>

/* ------------------------------------------------------------------ */
/* Interfaz (contrato)                                                 */
/* ------------------------------------------------------------------ */

/* Un filtro recibe los canales R, G y B por referencia.
 * El canal alfa (A) no se toca: se preserva la transparencia. */
typedef void (*PixelFilter)(uint8_t *r, uint8_t *g, uint8_t *b);

/* ------------------------------------------------------------------ */
/* Implementaciones concretas (SRP)                                    */
/* ------------------------------------------------------------------ */

static uint8_t clamp_u8(double v) {
    if (v <= 0.0) return 0;
    if (v >= 255.0) return 255;
    /* Redondeo, no truncamiento: así aplicar el filtro dos veces no oscurece
     * la imagen un nivel (0.3 + 0.59 + 0.11 no es exactamente 1.0 en binario). */
    return (uint8_t)(v + 0.5);
}

/* Luminosidad perceptual (Rec. 601): 0.30 R + 0.59 G + 0.11 B */
static void grayscale_filter(uint8_t *r, uint8_t *g, uint8_t *b) {
    uint8_t gray = clamp_u8(*r * 0.30 + *g * 0.59 + *b * 0.11);
    *r = gray;
    *g = gray;
    *b = gray;
}

static void invert_filter(uint8_t *r, uint8_t *g, uint8_t *b) {
    *r = (uint8_t)(255 - *r);
    *g = (uint8_t)(255 - *g);
    *b = (uint8_t)(255 - *b);
}

static void sepia_filter(uint8_t *r, uint8_t *g, uint8_t *b) {
    double rr = (double)*r, gg = (double)*g, bb = (double)*b;
    *r = clamp_u8(0.393 * rr + 0.769 * gg + 0.189 * bb);
    *g = clamp_u8(0.349 * rr + 0.686 * gg + 0.168 * bb);
    *b = clamp_u8(0.272 * rr + 0.534 * gg + 0.131 * bb);
}

/* Tabla de filtros: el "registro" de implementaciones disponibles. */
static PixelFilter filter_for_mode(int mode) {
    switch (mode) {
        case 0: return grayscale_filter;
        case 1: return invert_filter;
        case 2: return sepia_filter;
        default: return 0; /* 0 == NULL */
    }
}

/* ------------------------------------------------------------------ */
/* Motor (DIP): recibe la interfaz, no una implementación              */
/* ------------------------------------------------------------------ */

static void process_image(uint8_t *pixels, int num_pixels, PixelFilter filter) {
    /* Cada píxel ocupa 4 bytes: R, G, B, A. Se recorre de a 4. */
    for (int i = 0; i < num_pixels * 4; i += 4) {
        filter(&pixels[i], &pixels[i + 1], &pixels[i + 2]);
    }
}

/* ------------------------------------------------------------------ */
/* Superficie exportada a WebAssembly                                  */
/* ------------------------------------------------------------------ */

/* Entrada mínima, la que usa el benchmark del canvas:
 *   apply_grayscale(ptr, num_pixels)
 * "ptr" es un offset dentro de la memoria lineal exportada. */
__attribute__((export_name("apply_grayscale")))
void apply_grayscale(uint8_t *pixels, int num_pixels) {
    process_image(pixels, num_pixels, grayscale_filter);
}

/* Variante sin indirección: el compilador inlinea la fórmula en el bucle.
 * Sirve para medir cuánto cuesta el polimorfismo por píxel (call_indirect). */
__attribute__((export_name("apply_grayscale_direct")))
void apply_grayscale_direct(uint8_t *pixels, int num_pixels) {
    for (int i = 0; i < num_pixels * 4; i += 4) {
        uint8_t gray = clamp_u8(pixels[i] * 0.30 + pixels[i + 1] * 0.59 + pixels[i + 2] * 0.11);
        pixels[i] = gray;
        pixels[i + 1] = gray;
        pixels[i + 2] = gray;
    }
}

/* Entrada con forma de ABI canónica: un record { data, width, height, mode }
 * aplanado en parámetros escalares (ptr, len_bytes, width, height, mode).
 * Devuelve la cantidad de píxeles procesados o un código negativo de error. */
__attribute__((export_name("process_rgba")))
int process_rgba(uint8_t *pixels, int len_bytes, int width, int height, int mode) {
    if (pixels == 0 || width <= 0 || height <= 0) return -1;

    /* Validación: el largo declarado debe coincidir con width * height * 4.
     * Se usa int64 para no desbordar con imágenes grandes. */
    if ((int64_t)width * (int64_t)height * 4 != (int64_t)len_bytes) return -2;

    PixelFilter filter = filter_for_mode(mode);
    if (filter == 0) return -3;

    process_image(pixels, width * height, filter);
    return width * height;
}

/* Variante tipada de la anterior, útil para comparar desde JS. */
__attribute__((export_name("apply_invert")))
void apply_invert(uint8_t *pixels, int num_pixels) {
    process_image(pixels, num_pixels, invert_filter);
}

__attribute__((export_name("apply_sepia")))
void apply_sepia(uint8_t *pixels, int num_pixels) {
    process_image(pixels, num_pixels, sepia_filter);
}
