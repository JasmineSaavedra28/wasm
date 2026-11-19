import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CanonicalHost, WIT_CONTRACT } from '../web/lib/canonical-abi.js';
import { syntheticFrame } from '../web/lib/filters.js';

const root = path.resolve(import.meta.dirname, '..');

async function makeHost() {
  const bytes = readFileSync(path.join(root, 'web', 'assets', 'grayscale.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new CanonicalHost(instance);
}

test('string se baja como UTF-8 (largo en bytes, no en code units)', async () => {
  const host = await makeHost();
  const lowered = host.lowerString('ñandú 🌵');

  assert.equal(lowered.utf16Length, 8);
  assert.equal(lowered.utf8Length, 12);
  assert.equal(lowered.len, 12);
  assert.equal(host.liftString(lowered.ptr, lowered.len), 'ñandú 🌵');
});

test('list<u8> se baja como (ptr, len) y se sube sin perder bytes', async () => {
  const host = await makeHost();
  const bytes = Uint8Array.from({ length: 37 }, (_, i) => (i * 7) & 0xff);
  const lowered = host.lowerListU8(bytes);

  assert.equal(lowered.len, 37);
  assert.equal(lowered.alignment, 1);
  assert.ok(lowered.ptr >= host.arenaBase);
  assert.deepEqual(host.liftListU8(lowered.ptr, lowered.len), bytes);
});

test('record aplanado: (ptr, len, width, height, mode) procesa in-place', async () => {
  const host = await makeHost();
  const width = 16;
  const height = 8;
  const pixels = syntheticFrame(width, height, 5);
  const original = Uint8Array.from(pixels);

  const { result, pixels: processed, lowered } = host.processImage({
    pixels,
    width,
    height,
    mode: 0,
  });

  assert.equal(result, width * height);
  assert.deepEqual(lowered.params, [
    lowered.list.ptr,
    width * height * 4,
    width,
    height,
    0,
  ]);
  assert.equal(processed.length, original.length);

  let changed = 0;
  for (let i = 0; i < processed.length; i += 4) {
    assert.equal(processed[i], processed[i + 1]);
    assert.equal(processed[i], processed[i + 2]);
    assert.equal(processed[i + 3], 255);
    if (processed[i] !== original[i]) changed++;
  }
  assert.ok(changed > 0);
});

test('el modo invert viaja como discriminante u8', async () => {
  const host = await makeHost();
  const pixels = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 255]);
  const { pixels: out, result } = host.processImage({ pixels, width: 2, height: 1, mode: 1 });
  assert.equal(result, 2);
  assert.deepEqual([...out], [245, 235, 225, 255, 255, 255, 255, 255]);
});

test('valida que data.len() == width * height * 4', async () => {
  const host = await makeHost();
  assert.throws(
    () => host.processImage({ pixels: new Uint8Array(10), width: 2, height: 2 }),
    /no coincide/,
  );
});

test('hexdump muestra offsets y ASCII del búfer', async () => {
  const host = await makeHost();
  const { ptr, len } = host.lowerString('AB');
  const lines = host.hexdump(ptr, len);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].offset, ptr);
  assert.match(lines[0].hex, /^41 42/);
  assert.match(lines[0].ascii, /^AB/);
});

test('reset reutiliza el arena sin crecer indefinidamente', async () => {
  const host = await makeHost();
  const before = host.arenaBase;
  host.lowerListU8(new Uint8Array(1024));
  const after = host.offset;
  host.reset();
  assert.equal(host.offset, before);
  assert.ok(after >= before + 1024);
});

test('el contrato WIT declara los tipos de la ABI canónica', () => {
  assert.match(WIT_CONTRACT, /record image/);
  assert.match(WIT_CONTRACT, /list<u8>/);
  assert.match(WIT_CONTRACT, /result<u32, string>/);
  assert.match(WIT_CONTRACT, /world grayscale-world/);
});
