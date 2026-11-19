#!/usr/bin/env node
/*
 * Benchmark del kernel puro: mismo frame RGBA, tres implementaciones.
 * Se precalienta la JIT y se mide el tiempo medio por frame.
 *
 *   npm run bench
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { checksum, grayscaleJS } from '../web/lib/filters.js';

const root = path.resolve(import.meta.dirname, '..');

const WIDTH = 1280;
const HEIGHT = 720;
const BYTES = WIDTH * HEIGHT * 4;
const ITERATIONS = Number(process.env.ITERATIONS ?? 60);
const WARMUP = 10;

function makeFrame() {
  const data = new Uint8ClampedArray(BYTES);
  let seed = 0x12345678;
  for (let i = 0; i < data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed & 0xff;
    data[i + 1] = (seed >>> 8) & 0xff;
    data[i + 2] = (seed >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return data;
}

async function load(file) {
  const bytes = readFileSync(file);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance;
}

function stats(label, fn, size) {
  for (let i = 0; i < WARMUP; i++) fn();
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const ms = (performance.now() - start) / ITERATIONS;
  return {
    label,
    ms,
    fps: 1000 / ms,
    mpix: WIDTH * HEIGHT / 1e6 / (ms / 1000),
    size,
  };
}

const source = makeFrame();
const jsBuffer = Uint8ClampedArray.from(source);

const cInstance = await load(path.join(root, 'web', 'assets', 'grayscale.wasm'));
const cppInstance = await load(path.join(root, 'web', 'assets', 'grayscale_cpp.wasm'));

function prepare(instance, bytes) {
  const memory = instance.exports.memory;
  const ptr = memory.buffer.byteLength;
  memory.grow(Math.ceil(bytes / 65536));
  const view = new Uint8Array(memory.buffer);
  view.set(source, ptr);
  return { ptr };
}

const cPrepared = prepare(cInstance, BYTES);
const cPtr = cPrepared.ptr;
const cppPrepared = prepare(cppInstance, BYTES);
const cppPtr = cppPrepared.ptr;

const results = [
  stats(
    'C (función ptr)',
    () => cInstance.exports.apply_grayscale(cPtr, WIDTH * HEIGHT),
    statSync(path.join(root, 'web', 'assets', 'grayscale.wasm')).size,
  ),
  stats(
    'C (directo)',
    () => cInstance.exports.apply_grayscale_direct(cPtr, WIDTH * HEIGHT),
    statSync(path.join(root, 'web', 'assets', 'grayscale.wasm')).size,
  ),
  stats(
    'C++ (virtual)',
    () => cppInstance.exports.apply_grayscale_cpp(cppPtr, WIDTH * HEIGHT),
    statSync(path.join(root, 'web', 'assets', 'grayscale_cpp.wasm')).size,
  ),
  stats('JavaScript', () => grayscaleJS(jsBuffer), 0),
];

const baseline = results.at(-1).ms;

console.log(`\nFrame ${WIDTH}x${HEIGHT} (${(BYTES / 1e6).toFixed(2)} MB), ${ITERATIONS} iteraciones\n`);
console.log('Implementación     ms/frame    fps      MP/s    vs JS    .wasm');
console.log('─'.repeat(68));
for (const r of results) {
  const speedup = baseline / r.ms;
  console.log(
    `${r.label.padEnd(18)} ${r.ms.toFixed(3).padStart(8)} ${r.fps.toFixed(0).padStart(7)} ${r.mpix
      .toFixed(0)
      .padStart(9)} ${speedup.toFixed(2).padStart(7)}x ${r.size ? `${(r.size / 1024).toFixed(1)} KB` : '—'}`,
  );
}

const ref = new Uint8ClampedArray(source);
grayscaleJS(ref);
console.log(`\nChecksum JS:        0x${checksum(ref).toString(16).padStart(8, '0')}`);
console.log(
  `Checksum C (ptr):   0x${checksum(new Uint8Array(cInstance.exports.memory.buffer, cPtr, BYTES)).toString(16).padStart(8, '0')}`,
);
console.log(
  `Checksum C++:       0x${checksum(new Uint8Array(cppInstance.exports.memory.buffer, cppPtr, BYTES)).toString(16).padStart(8, '0')}`,
);
