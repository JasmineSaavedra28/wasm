#!/usr/bin/env node
/*
 * Compila las implementaciones nativas a WebAssembly.
 *
 * Orden de preferencia:
 *   1. Zig (zig cc / zig c++) -> no necesita SDK ni Emscripten.
 *   2. clang con target wasm32 (si está instalado).
 *   3. Si no hay compilador, conserva los .wasm ya generados en web/assets.
 *
 * Uso:
 *   npm run build
 *   ZIG=/ruta/a/zig npm run build
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'web', 'assets');
mkdirSync(assets, { recursive: true });

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    ...options,
  });
}

function detectCompiler() {
  const candidates = [];
  if (process.env.ZIG) candidates.push({ cmd: process.env.ZIG, kind: 'zig' });
  candidates.push({ cmd: path.join(root, '.tools', 'zig', 'zig.exe'), kind: 'zig' });
  candidates.push({ cmd: path.join(root, '.tools', 'zig', 'zig'), kind: 'zig' });
  candidates.push({ cmd: 'zig', kind: 'zig' });

  for (const candidate of candidates) {
    const result = run(candidate.cmd, ['version']);
    if (result.status === 0) {
      return { ...candidate, version: result.stdout.trim() };
    }
  }

  for (const cmd of [process.env.CLANG, 'clang'].filter(Boolean)) {
    const result = run(cmd, ['--version']);
    if (result.status === 0) {
      return { cmd, kind: 'clang', version: result.stdout.split('\n')[0].trim() };
    }
  }
  return null;
}

function compile(compiler, language, source, output) {
  const isCpp = language === 'c++';
  const cmd = compiler.cmd;
  const args = [
    compiler.kind === 'zig'
      ? (isCpp ? 'c++' : 'cc')
      : (isCpp ? '--driver-mode=g++' : '--driver-mode=gcc'),
  ];

  args.push(
    '-target',
    'wasm32-freestanding',
    '-O3',
    '-nostdlib',
    '-fno-exceptions',
    '-fno-rtti',
    '-Wl,--no-entry',
    '-Wl,--export-memory',
    '-Wl,--export=__heap_base',
    '-Wl,--strip-all',
    '-o',
    path.relative(root, output),
    path.relative(root, source),
  );

  const result = run(cmd, args);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Falló la compilación de ${source}\n${detail}`);
  }
}

function inspect(file) {
  const bytes = readFileSync(file);
  const module = new WebAssembly.Module(bytes);
  return {
    file: path.relative(root, file).replaceAll('\\', '/'),
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    exports: WebAssembly.Module.exports(module).map((e) => `${e.name}:${e.kind}`),
    imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
  };
}

const compiler = detectCompiler();
const targets = [
  {
    id: 'c',
    language: 'c',
    source: path.join(root, 'src', 'c', 'grayscale.c'),
    output: path.join(assets, 'grayscale.wasm'),
  },
  {
    id: 'cpp',
    language: 'c++',
    source: path.join(root, 'src', 'cpp', 'grayscale_plain.cpp'),
    output: path.join(assets, 'grayscale_cpp.wasm'),
  },
];

console.log(compiler
  ? `Compilador: ${compiler.kind} ${compiler.version}`
  : 'No se encontró zig ni clang: se usan los .wasm existentes.');

const modules = {};

for (const target of targets) {
  try {
    if (!compiler) throw new Error('sin compilador');
    compile(compiler, target.language, target.source, target.output);
    console.log(`✓ ${target.id}: ${path.relative(root, target.output)}`);
  } catch (error) {
    if (!existsSync(target.output)) {
      console.error(`✗ ${target.id}: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    console.warn(`! ${target.id}: ${error.message}`);
    console.warn(`  Se conserva el binario precompilado ${path.relative(root, target.output)}`);
  }

  if (existsSync(target.output)) modules[target.id] = inspect(target.output);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  compiler: compiler ? { kind: compiler.kind, version: compiler.version } : null,
  note: 'Generado por scripts/build.mjs. Los tamaños son bytes reales del .wasm.',
  modules,
  rust: {
    source: 'src/rust',
    built: false,
    howTo:
      'rustup target add wasm32-unknown-unknown && cargo install wasm-pack && wasm-pack build src/rust --target web --release --out-dir ../../web/assets/rust',
  },
};

writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('\nMódulos:');
for (const [id, info] of Object.entries(modules)) {
  console.log(
    `  ${id.padEnd(4)} ${String(info.bytes).padStart(6)} bytes  ${info.sha256}  [${info.exports.join(', ')}]`,
  );
}
console.log(`\nManifiesto: web/assets/manifest.json`);

if (!compiler) {
  console.log(`
Para recompilar desde cero instalá Zig (https://ziglang.org/download/) y ejecutá:
  ZIG=/ruta/a/zig npm run build

Rust (opcional):
  rustup target add wasm32-unknown-unknown
  cargo install wasm-pack
  wasm-pack build src/rust --target web --release --out-dir ../../web/assets/rust
`);
}
