//! ANALISIS_WASM-02 — Implementación en Rust
//! ------------------------------------------
//! El contrato del filtro es un trait (el equivalente a una interfaz).
//! La iteración usa `chunks_exact_mut(4)`: el compilador sabe que cada
//! bloque mide exactamente 4 bytes, no hay comprobaciones por píxel y el
//! préstamo mutable impide dos referencias simultáneas al mismo píxel.
//!
//! Se corrigió el pseudocódigo original, que hacía:
//!     filter.apply(&mut chunk, &mut chunk[3], &mut chunk[7])
//! Eso no compila (chunk es `&mut [u8]`, no `u8`) y además se salía del
//! bloque de 4 bytes. La versión correcta pasa el bloque completo.

use wasm_bindgen::prelude::*;

/// Contrato (SRP + DIP): cada filtro decide cómo transformar un píxel RGBA.
pub trait ImageFilter {
    fn apply(&self, px: &mut [u8]);
}

pub struct GrayscaleFilter;

impl ImageFilter for GrayscaleFilter {
    fn apply(&self, px: &mut [u8]) {
        let gray = (px[0] as f32 * 0.30 + px[1] as f32 * 0.59 + px[2] as f32 * 0.11 + 0.5) as u8;
        px[0] = gray;
        px[1] = gray;
        px[2] = gray;
        // px[3] (alfa) se preserva
    }
}

pub struct InvertFilter;

impl ImageFilter for InvertFilter {
    fn apply(&self, px: &mut [u8]) {
        px[0] = 255 - px[0];
        px[1] = 255 - px[1];
        px[2] = 255 - px[2];
    }
}

pub struct SepiaFilter;

impl ImageFilter for SepiaFilter {
    fn apply(&self, px: &mut [u8]) {
        let (r, g, b) = (px[0] as f32, px[1] as f32, px[2] as f32);
        px[0] = clamp(0.393 * r + 0.769 * g + 0.189 * b);
        px[1] = clamp(0.349 * r + 0.686 * g + 0.168 * b);
        px[2] = clamp(0.272 * r + 0.534 * g + 0.131 * b);
    }
}

fn clamp(v: f32) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        (v + 0.5) as u8
    }
}

/// Motor genérico: no conoce ninguna implementación concreta (DIP).
pub fn process(pixels: &mut [u8], filter: &dyn ImageFilter) -> usize {
    let mut count = 0;
    for chunk in pixels.chunks_exact_mut(4) {
        filter.apply(chunk);
        count += 1;
    }
    count
}

fn filter_for_mode(mode: u8) -> Option<&'static dyn ImageFilter> {
    match mode {
        0 => Some(&GrayscaleFilter),
        1 => Some(&InvertFilter),
        2 => Some(&SepiaFilter),
        _ => None,
    }
}

/// Versión idiomática con wasm-bindgen.
///
/// OJO: `&mut [u8]` hace que el glue code copie el búfer de JS a la memoria
/// wasm antes de llamar y lo copie de vuelta después. Es cómodo, pero no es
/// zero-copy. Para el camino caliente está `apply_grayscale_ptr`.
#[wasm_bindgen]
pub fn apply_grayscale(pixels: &mut [u8]) -> usize {
    process(pixels, &GrayscaleFilter)
}

#[wasm_bindgen]
pub fn apply_invert(pixels: &mut [u8]) -> usize {
    process(pixels, &InvertFilter)
}

/// Versión zero-copy: JS pasa un offset dentro de la memoria lineal y el
/// largo en bytes. Es la forma que usa la ABI canónica para `list<u8>`.
///
/// # Safety
/// `ptr` debe apuntar a `len_bytes` bytes válidos dentro de la memoria wasm
/// y no debe haber otra referencia viva a esa región.
#[wasm_bindgen]
pub fn apply_grayscale_ptr(ptr: usize, len_bytes: usize) -> usize {
    if len_bytes % 4 != 0 {
        return 0;
    }
    let pixels = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, len_bytes) };
    process(pixels, &GrayscaleFilter)
}

/// Equivalente a `process_rgba` de C: record aplanado (ptr, len, width,
/// height, mode) y validación de la forma del frame.
#[wasm_bindgen]
pub fn process_rgba(ptr: usize, len_bytes: usize, width: u32, height: u32, mode: u8) -> i32 {
    if ptr == 0 || width == 0 || height == 0 {
        return -1;
    }
    if width as u64 * height as u64 * 4 != len_bytes as u64 {
        return -2;
    }
    let Some(filter) = filter_for_mode(mode) else {
        return -3;
    };
    let pixels = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, len_bytes) };
    process(pixels, filter) as i32
}
