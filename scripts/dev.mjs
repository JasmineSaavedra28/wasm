#!/usr/bin/env node
/* Servidor estático mínimo, sin dependencias, con MIME correcto para .wasm. */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.sol': 'text/plain; charset=utf-8',
  '.wit': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') {
    response.writeHead(302, { Location: '/web/' }).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) && file !== root) {
    response.writeHead(403).end('403');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, () => {
  console.log(`\n  ANALISIS_WASM-02\n  http://localhost:${port}/\n`);
  console.log('  Ctrl+C para detener.\n');
});
