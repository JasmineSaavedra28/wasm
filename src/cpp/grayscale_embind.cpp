/*
 * ANALISIS_WASM-02 — Implementación en C++ con Emscripten + embind
 * ----------------------------------------------------------------
 * Esta es la versión "de cátedra" (clases abstractas + glue code generado).
 * Se corrigieron dos problemas del pseudocódigo original:
 *
 *   1. emscripten::vecFromJSArray<uint8_t>() NO acepta un Uint8ClampedArray
 *      de forma eficiente: recorre elemento por elemento. Para un búfer de
 *      60 fps eso es justamente el cuello de botella que queríamos evitar.
 *   2. Devolver un typed_memory_view() de un std::vector local deja un
 *      puntero colgante. Hay que copiar a un Uint8Array propiedad de JS.
 *
 * La lección arquitectónica: en el borde conviene pasar (ptr, len) y
 * procesar in-place. La ABI canónica hace exactamente eso.
 *
 * Compilación:
 *   em++ -O3 -std=c++17 src/cpp/grayscale_embind.cpp \
 *     -o web/assets/grayscale_embind.js \
 *     -lembind -sMODULARIZE=1 -sEXPORT_ES6=1 \
 *     -sEXPORTED_RUNTIME_METHODS=HEAPU8
 *
 * (Requiere Emscripten; no está incluido en este repo.)
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <memory>
#include <vector>

class IImageFilter {
public:
    virtual ~IImageFilter() = default;
    virtual void apply(uint8_t &r, uint8_t &g, uint8_t &b) const = 0;
};

class GrayscaleFilter final : public IImageFilter {
public:
    void apply(uint8_t &r, uint8_t &g, uint8_t &b) const override {
        const uint8_t gray = to_u8(r * 0.30 + g * 0.59 + b * 0.11);
        r = g = b = gray;
    }
private:
    static uint8_t to_u8(double v) {
        if (v <= 0.0) return 0;
        if (v >= 255.0) return 255;
        return static_cast<uint8_t>(v + 0.5);
    }
};

class InvertFilter final : public IImageFilter {
public:
    void apply(uint8_t &r, uint8_t &g, uint8_t &b) const override {
        r = static_cast<uint8_t>(255 - r);
        g = static_cast<uint8_t>(255 - g);
        b = static_cast<uint8_t>(255 - b);
    }
};

static std::unique_ptr<IImageFilter> make_filter(int mode) {
    switch (mode) {
        case 0: return std::make_unique<GrayscaleFilter>();
        case 1: return std::make_unique<InvertFilter>();
        default: return nullptr;
    }
}

class ImageProcessor {
public:
    /* Camino recomendado: cero copias. JS pasa el offset dentro de la
     * memoria wasm y el largo en bytes. */
    bool process_ptr(uintptr_t ptr, int len_bytes, int mode) {
        if (ptr == 0 || len_bytes <= 0 || len_bytes % 4 != 0) return false;
        auto filter = make_filter(mode);
        if (!filter) return false;

        auto *pixels = reinterpret_cast<uint8_t *>(ptr);
        const int num_pixels = len_bytes / 4;
        for (int i = 0; i < num_pixels * 4; i += 4) {
            filter->apply(pixels[i], pixels[i + 1], pixels[i + 2]);
        }
        return true;
    }

    /* Camino "didáctico": copia JS -> C++ -> JS. Se conserva para mostrar
     * por qué el glue code de embind es costoso en bucles calientes. */
    emscripten::val process_copy(emscripten::val input, int mode) {
        std::vector<uint8_t> pixels =
            emscripten::convertJSArrayToNumberVector<uint8_t>(input);
        auto filter = make_filter(mode);
        if (!filter) return emscripten::val::null();

        const int num_pixels = static_cast<int>(pixels.size() / 4);
        for (int i = 0; i < num_pixels * 4; i += 4) {
            filter->apply(pixels[i], pixels[i + 1], pixels[i + 2]);
        }

        emscripten::val out = emscripten::val::global("Uint8Array").new_(pixels.size());
        out.call<void>("set",
            emscripten::val(emscripten::typed_memory_view(pixels.size(), pixels.data())));
        return out;
    }
};

using namespace emscripten;

EMSCRIPTEN_BINDINGS(image_module) {
    class_<ImageProcessor>("ImageProcessor")
        .constructor<>()
        .function("processPtr", &ImageProcessor::process_ptr)
        .function("processCopy", &ImageProcessor::process_copy);
}
