/*
 * Codificador/decodificador de la ABI de Ethereum, escrito a mano.
 *
 * Reglas que se muestran:
 *   - El selector son los primeros 4 bytes de keccak256(firma).
 *   - Cada valor ocupa una palabra de 32 bytes, big-endian, alineada a la
 *     derecha (los enteros se rellenan con ceros a la izquierda).
 *   - Los tipos dinámicos (string, bytes, arrays) van en la "cola": en la
 *     cabecera queda un offset de 32 bits (relativo al inicio de los
 *     argumentos) y en la cola, largo + datos rellenados a 32 bytes.
 *   - Los valores de retorno múltiples se codifican como una tupla.
 *
 * Se verificó contra viem en test/ethereum-abi.test.mjs.
 */

import { keccak256, bytesToHex, hexToBytes } from './keccak.js';

export const WORD_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function selector(signature) {
  return bytesToHex(keccak256(signature)).slice(0, 10);
}

export function utf8Bytes(text) {
  return encoder.encode(text);
}

function toWord(value) {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new RangeError(`uint256 fuera de rango: ${value}`);
  return n.toString(16).padStart(64, '0');
}

function padRight(hex, multiple = WORD_BYTES * 2) {
  const remainder = hex.length % multiple;
  return remainder === 0 ? hex : hex + '0'.repeat(multiple - remainder);
}

function isDynamic(type) {
  return type === 'string' || type === 'bytes' || type.endsWith('[]');
}

function encodeStatic(type, value) {
  if (type === 'bool') return toWord(value ? 1n : 0n);
  if (type === 'address') {
    const clean = String(value).toLowerCase().replace(/^0x/, '');
    if (clean.length !== 40) throw new Error(`address inválida: ${value}`);
    return clean.padStart(64, '0');
  }
  if (type === 'bytes32') {
    const clean = String(value).toLowerCase().replace(/^0x/, '');
    if (clean.length > 64) throw new Error('bytes32 demasiado largo');
    return clean.padEnd(64, '0');
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    const bits = type === 'uint' || type === 'int' ? 256 : Number(type.replace(/\D/g, ''));
    const n = BigInt(value);
    if (type.startsWith('uint') && (n < 0n || n >= 1n << BigInt(bits))) {
      throw new RangeError(`${type} fuera de rango: ${value}`);
    }
    return toWord(n);
  }
  throw new Error(`tipo no soportado: ${type}`);
}

function encodeDynamic(type, value) {
  let bytes;
  if (type === 'string') bytes = encoder.encode(String(value));
  else if (type === 'bytes') bytes = typeof value === 'string' ? hexToBytes(value) : value;
  else throw new Error(`tipo dinámico no soportado: ${type}`);
  return toWord(bytes.length) + padRight(bytesToHex(bytes).slice(2));
}

/**
 * @param {Array<{type: string, name?: string, value: unknown}>} params
 * @returns {{hex: string, words: Array<object>, headSize: number, tailSize: number}}
 */
export function encodeParams(params) {
  const head = [];
  const tail = [];
  let tailSize = 0;
  const headSize = params.length * WORD_BYTES;

  for (const param of params) {
    if (isDynamic(param.type)) {
      head.push({ hex: toWord(headSize + tailSize), dynamic: true, offset: headSize + tailSize });
      const encoded = encodeDynamic(param.type, param.value);
      tail.push(encoded);
      tailSize += encoded.length / 2;
    } else {
      head.push({ hex: encodeStatic(param.type, param.value), dynamic: false });
    }
  }

  const words = [];
  let wordIndex = 0;
  params.forEach((param, i) => {
    const entry = head[i];
    words.push({
      index: wordIndex++,
      offset: i * WORD_BYTES,
      hex: '0x' + entry.hex,
      kind: entry.dynamic ? 'offset' : 'valor',
      label: entry.dynamic
        ? `${param.name ?? `arg${i}`} (${param.type}): offset de la cola`
        : `${param.name ?? `arg${i}`} (${param.type})`,
      display: entry.dynamic
        ? `${entry.offset} bytes (0x${entry.offset.toString(16)})`
        : String(param.value),
    });
  });

  let tailOffset = headSize;
  params.forEach((param, i) => {
    if (!head[i].dynamic) return;
    const encoded = tail[params.slice(0, i).filter((p) => isDynamic(p.type)).length];
    const length = Number(BigInt('0x' + encoded.slice(0, 64)));
    words.push({
      index: wordIndex++,
      offset: tailOffset,
      hex: '0x' + encoded.slice(0, 64),
      kind: 'longitud',
      label: `${param.name ?? `arg${i}`} (${param.type}): largo`,
      display: `${length} bytes`,
    });
    for (let pos = 64; pos < encoded.length; pos += 64) {
      words.push({
        index: wordIndex++,
        offset: tailOffset + pos / 2,
        hex: '0x' + encoded.slice(pos, pos + 64),
        kind: 'datos',
        label: `${param.name ?? `arg${i}`}: datos UTF-8/bytes`,
        display: printable(encoded.slice(pos, pos + 64)),
      });
    }
    tailOffset += encoded.length / 2;
  });

  return {
    hex: '0x' + head.map((h) => h.hex).join('') + tail.join(''),
    words,
    headSize,
    tailSize,
    paramsHex: head.map((h) => h.hex).join('') + tail.join(''),
  };
}

function printable(hex) {
  try {
    const bytes = hexToBytes('0x' + hex);
    const text = decoder.decode(bytes).replace(/\0+$/g, '');
    return JSON.stringify(text);
  } catch {
    return '…';
  }
}

/** @param {string[]} types @param {string} paramsHex sin selector */
export function decodeParams(types, paramsHex) {
  const data = paramsHex.replace(/^0x/, '');
  const view = (offset, length) => data.slice(offset * 2, (offset + length) * 2);
  const values = [];
  let dynamicIndex = 0;

  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (isDynamic(type)) {
      const offset = Number(BigInt('0x' + view(i * WORD_BYTES, WORD_BYTES)));
      const length = Number(BigInt('0x' + view(offset, WORD_BYTES)));
      const payload = '0x' + view(offset + WORD_BYTES, length);
      values.push(type === 'string' ? decoder.decode(hexToBytes(payload)) : payload);
      dynamicIndex++;
    } else {
      const word = view(i * WORD_BYTES, WORD_BYTES);
      if (type === 'bool') values.push(BigInt('0x' + word) !== 0n);
      else if (type === 'address') values.push('0x' + word.slice(24));
      else if (type === 'bytes32') values.push('0x' + word);
      else if (type.startsWith('uint') || type.startsWith('int')) values.push(BigInt('0x' + word));
      else values.push('0x' + word);
    }
  }
  return values;
}

/** Firma -> tipos de los parámetros, sin soportar tuplas anidadas. */
export function typesFromSignature(signature) {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close < 0) throw new Error(`firma inválida: ${signature}`);
  const inner = signature.slice(open + 1, close).trim();
  return inner === '' ? [] : inner.split(',').map((t) => t.trim());
}

/**
 * Codifica una llamada completa (selector + argumentos).
 * @param {string} signature
 * @param {Array<{type: string, name?: string, value: unknown}>} params
 */
export function encodeCall(signature, params) {
  const expected = typesFromSignature(signature);
  const actual = params.map((p) => p.type);
  if (expected.join(',') !== actual.join(',')) {
    throw new Error(`tipos no coinciden: firma (${expected}) vs args (${actual})`);
  }
  const encoded = encodeParams(params);
  return {
    signature,
    selector: selector(signature),
    calldata: selector(signature) + encoded.hex.slice(2),
    ...encoded,
  };
}

export function decodeCalldata(signature, calldata) {
  const expectedSelector = selector(signature);
  if (!calldata.toLowerCase().startsWith(expectedSelector)) {
    throw new Error(`selector ${calldata.slice(0, 10)} != ${expectedSelector}`);
  }
  const types = typesFromSignature(signature);
  return {
    types,
    values: decodeParams(types, calldata.slice(10)),
  };
}

/**
 * Gas intrínseco de calldata (post EIP-2028):
 *   4 gas por byte cero, 16 gas por byte distinto de cero.
 */
export function calldataGas(hex) {
  const bytes = hexToBytes(hex);
  let zeroBytes = 0;
  for (const byte of bytes) if (byte === 0) zeroBytes++;
  const nonZeroBytes = bytes.length - zeroBytes;
  return {
    totalBytes: bytes.length,
    zeroBytes,
    nonZeroBytes,
    dataGas: zeroBytes * 4 + nonZeroBytes * 16,
    totalGas: 21000 + zeroBytes * 4 + nonZeroBytes * 16,
  };
}

export function randomBytes32() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function hexToUtf8(hex) {
  return decoder.decode(hexToBytes(hex));
}
