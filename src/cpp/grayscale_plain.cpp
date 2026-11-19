/*
 * ANALISIS_WASM-02 — Implementación en C++ (sin Emscripten)
 * ---------------------------------------------------------
 * Misma arquitectura que la versión embind, pero compilable a wasm32
 * "freestanding" con clang/zig. Sirve para medir el costo real del
 * polimorfismo dinámico (llamada virtual por píxel) frente a C.
 *
 * Compilación:
 *   zig c++ -target wasm32-freestanding -O3 -nostdlib -fno-exceptions -fno-rtti \
 *     -Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base \
 *     -o web/assets/grayscale_cpp.wasm src/cpp/grayscale_plain.cpp
 */

#include <stdint.h>
#include <stddef.h>

/* En un target freestanding no hay libc++ que aporte operator delete.
 * El destructor virtual lo referencia aunque nunca borremos por puntero
 * base; aportamos las definiciones mínimas para poder enlazar. */
void operator delete(void *p) noexcept { (void)p; }
void operator delete(void *p, size_t) noexcept { (void)p; }

/* DIP: contrato abstracto para cualquier filtro. */
class IImageFilter {
public:
    virtual ~IImageFilter() = default;
    virtual void apply(uint8_t &r, uint8_t &g, uint8_t &b) const = 0;
};

/* OCP: agregar un filtro = agregar una clase, sin tocar el motor. */
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

/* SRP: el motor solo itera y delega. */
static void process_image(uint8_t *pixels, int num_pixels, const IImageFilter &filter) {
    for (int i = 0; i < num_pixels * 4; i += 4) {
        filter.apply(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
}

extern "C" {

__attribute__((export_name("apply_grayscale_cpp")))
void apply_grayscale_cpp(uint8_t *pixels, int num_pixels) {
    GrayscaleFilter filter;
    process_image(pixels, num_pixels, filter);
}

__attribute__((export_name("apply_invert_cpp")))
void apply_invert_cpp(uint8_t *pixels, int num_pixels) {
    InvertFilter filter;
    process_image(pixels, num_pixels, filter);
}

} // extern "C"
