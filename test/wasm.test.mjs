import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  grayscaleJS,
  invertJS,
  maxChannelDiff,
  sepiaJS,
  syntheticFrame,
} from '../web/lib/filters.js';

const root = path.resolve(import.meta.dirname, '..');

async function load(file) {
  const bytes = readFileSync(path.join(root, 'web', 'assets', file));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance;
}

function allocate(instance, bytes) {
  const memory = instance.exports.memory;
  const ptr = memory.buffer.byteLength;
  memory.grow(Math.ceil(bytes / 65536));
  return ptr;
}

test('los módulos exportan memoria y las funciones esperadas', async () => {
  const c = await load('grayscale.wasm');
  const cpp = await load('grayscale_cpp.wasm');

  assert.ok(c.exports.memory instanceof WebAssembly.Memory);
  assert.equal(typeof c.exports.apply_grayscale, 'function');
  assert.equal(typeof c.exports.apply_grayscale_direct, 'function');
  assert.equal(typeof c.exports.process_rgba, 'function');

  assert.ok(cpp.exports.memory instanceof WebAssembly.Memory);
  assert.equal(typeof cpp.exports.apply_grayscale_cpp, 'function');

  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(
    readFileSync(path.join(root, 'web', 'assets', 'grayscale.wasm')),
  )), []);
});

test('C coincide con la referencia JS en varios tamaños', async () => {
  const c = await load('grayscale.wasm');

  for (const [width, height] of [[1, 1], [7, 5], [64, 48], [320, 180]]) {
    const source = syntheticFrame(width, height, width);
    const expected = grayscaleJS(Uint8ClampedArray.from(source));
    const ptr = allocate(c, source.length);
    new Uint8Array(c.exports.memory.buffer, ptr, source.length).set(source);
    c.exports.apply_grayscale(ptr, width * height);
    const actual = new Uint8Array(c.exports.memory.buffer, ptr, source.length);
    assert.equal(maxChannelDiff(actual, expected), 0, `${width}x${height}`);
  }
});

test('C++ virtual coincide con la referencia JS', async () => {
  const cpp = await load('grayscale_cpp.wasm');
  const source = syntheticFrame(128, 96, 42);
  const expected = grayscaleJS(Uint8ClampedArray.from(source));
  const ptr = allocate(cpp, source.length);
  new Uint8Array(cpp.exports.memory.buffer, ptr, source.length).set(source);
  cpp.exports.apply_grayscale_cpp(ptr, (128 * 96));
  const actual = new Uint8Array(cpp.exports.memory.buffer, ptr, source.length);
  assert.equal(maxChannelDiff(actual, expected), 0);
});

test('la variante directa y la de puntero a función dan lo mismo', async () => {
  const c = await load('grayscale.wasm');
  const source = syntheticFrame(96, 64, 7);
  const bytes = source.length;

  const p1 = allocate(c, bytes);
  new Uint8Array(c.exports.memory.buffer, p1, bytes).set(source);
  c.exports.apply_grayscale(p1, 96 * 64);
  const indirect = Uint8Array.from(new Uint8Array(c.exports.memory.buffer, p1, bytes));

  const p2 = allocate(c, bytes);
  new Uint8Array(c.exports.memory.buffer, p2, bytes).set(source);
  c.exports.apply_grayscale_direct(p2, 96 * 64);
  const direct = new Uint8Array(c.exports.memory.buffer, p2, bytes);

  assert.equal(maxChannelDiff(indirect, direct), 0);
});

test('grayscale es idempotente (redondeo, no truncamiento)', async () => {
  const c = await load('grayscale.wasm');
  const source = syntheticFrame(32, 32, 1);
  const ptr = allocate(c, source.length);
  new Uint8Array(c.exports.memory.buffer, ptr, source.length).set(source);

  c.exports.apply_grayscale(ptr, 32 * 32);
  const once = Uint8Array.from(new Uint8Array(c.exports.memory.buffer, ptr, source.length));
  c.exports.apply_grayscale(ptr, 32 * 32);
  const twice = new Uint8Array(c.exports.memory.buffer, ptr, source.length);

  assert.equal(maxChannelDiff(once, twice), 0);
});

test('process_rgba aplica los tres modos y valida el frame', async () => {
  const c = await load('grayscale.wasm');
  const width = 40;
  const height = 30;
  const source = syntheticFrame(width, height, 3);

  const cases = [
    { mode: 0, expected: grayscaleJS(Uint8ClampedArray.from(source)) },
    { mode: 1, expected: invertJS(Uint8ClampedArray.from(source)) },
    { mode: 2, expected: sepiaJS(Uint8ClampedArray.from(source)) },
  ];

  for (const { mode, expected } of cases) {
    const ptr = allocate(c, source.length);
    new Uint8Array(c.exports.memory.buffer, ptr, source.length).set(source);
    const result = c.exports.process_rgba(ptr, source.length, width, height, mode);
    assert.equal(result, width * height);
    const actual = new Uint8Array(c.exports.memory.buffer, ptr, source.length);
    assert.equal(maxChannelDiff(actual, expected), 0, `modo ${mode}`);
  }

  const ptr = allocate(c, source.length);
  assert.equal(c.exports.process_rgba(ptr, source.length - 4, width, height, 0), -2);
  assert.equal(c.exports.process_rgba(ptr, source.length, width, height, 9), -3);
  assert.equal(c.exports.process_rgba(ptr, source.length, 0, height, 0), -1);
});

test('el canal alfa se preserva', async () => {
  const c = await load('grayscale.wasm');
  const source = new Uint8Array([10, 20, 30, 0, 200, 100, 50, 255, 1, 2, 3, 77]);
  const ptr = allocate(c, source.length);
  new Uint8Array(c.exports.memory.buffer, ptr, source.length).set(source);
  c.exports.apply_grayscale(ptr, 3);
  const actual = new Uint8Array(c.exports.memory.buffer, ptr, source.length);
  assert.equal(actual[3], 0);
  assert.equal(actual[7], 255);
  assert.equal(actual[11], 77);
});
