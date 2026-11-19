//! Build del componente canónico (WIT) a partir de la implementación Rust.
//!
//! Requiere:
//!   rustup target add wasm32-unknown-unknown
//!   cargo install wasm-tools
//!
//! Este archivo NO es un binario: es documentación ejecutable del flujo
//! completo (wit-bindgen + wasm-tools). Se deja fuera del build por defecto
//! para no exigir esas herramientas en la demo del navegador.
//!
//! Flujo típico:
//!   1. Escribir la interfaz en wit/grayscale.wit
//!   2. Generar bindings:  wit-bindgen rust wit/ --out-dir src/rust/bindings
//!   3. Implementar el trait generado
//!   4. cargo build --release --target wasm32-unknown-unknown
//!   5. wasm-tools component new \
//!        target/wasm32-unknown-unknown/release/grayscale_wasm.wasm \
//!        -o build/grayscale.component.wasm
//!   6. jco transpile build/grayscale.component.wasm -o web/assets/component
//!
//! El punto pedagógico: los pasos 5 y 6 generan el "glue" de la ABI canónica
//! (lift/lower de list<u8>, string, record) sin que el lenguaje lo escriba.
