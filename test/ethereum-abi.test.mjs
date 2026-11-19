import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import solc from 'solc';
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256 as viemKeccak256,
  parseAbi,
  stringToHex,
} from 'viem';

import {
  bytesToHex,
  keccak256,
} from '../web/lib/keccak.js';
import {
  calldataGas,
  decodeCalldata,
  decodeParams,
  encodeCall,
  encodeParams,
  selector,
  typesFromSignature,
} from '../web/lib/ethereum-abi.js';

const root = path.resolve(import.meta.dirname, '..');

test('keccak256 coincide con viem y con vectores conocidos', () => {
  assert.equal(
    bytesToHex(keccak256('')),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    bytesToHex(keccak256('abc')),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );

  for (const text of ['transfer(address,uint256)', 'hola ñandú 🌵', 'x'.repeat(300)]) {
    assert.equal(
      bytesToHex(keccak256(text)),
      viemKeccak256(stringToHex(text)),
      text.slice(0, 30),
    );
  }
});

test('el selector de transfer es el vector clásico 0xa9059cbb', () => {
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(
    selector('registerFilter(bytes32,string,uint8,uint32,bytes32)'),
    '0x1646a0c2',
  );
});

test('encodeCall produce exactamente el calldata de viem (transfer)', () => {
  const args = [
    { type: 'address', name: 'to', value: '0x1111111111111111111111111111111111111111' },
    { type: 'uint256', name: 'amount', value: 123456789n },
  ];
  const ours = encodeCall('transfer(address,uint256)', args);
  const viem = encodeFunctionData({
    abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
    functionName: 'transfer',
    args: [args[0].value, args[1].value],
  });

  assert.equal(ours.calldata, viem);
  assert.equal(ours.calldata.length, 2 + 4 * 2 + 2 * 64);
  assert.deepEqual(decodeCalldata('transfer(address,uint256)', viem).values, [
    args[0].value,
    123456789n,
  ]);
});

test('string dinámico: offset en la cabecera y largo + datos en la cola', () => {
  const params = [
    { type: 'bytes32', name: 'id', value: '0x' + 'ab'.repeat(32) },
    { type: 'string', name: 'name', value: 'grayscale-ñandú' },
    { type: 'uint8', name: 'mode', value: 0 },
    { type: 'uint32', name: 'version', value: 3 },
    { type: 'bytes32', name: 'paramsHash', value: '0x' + 'cd'.repeat(32) },
  ];
  const signature = 'registerFilter(bytes32,string,uint8,uint32,bytes32)';
  const encoded = encodeCall(signature, params);

  assert.equal(encoded.headSize, 5 * 32);
  assert.equal(encoded.words[1].kind, 'offset');
  assert.equal(encoded.words[1].display, '160 bytes (0xa0)');
  assert.equal(encoded.words[5].kind, 'longitud');
  assert.equal(encoded.words[5].display, '17 bytes');

  const decoded = decodeCalldata(signature, encoded.calldata);
  assert.equal(decoded.values[1], 'grayscale-ñandú');
  assert.equal(decoded.values[2], 0n);
  assert.equal(decoded.values[3], 3n);

  const viem = encodeFunctionData({
    abi: parseAbi([
      'function registerFilter(bytes32 id, string name, uint8 mode, uint32 version, bytes32 paramsHash)',
    ]),
    functionName: 'registerFilter',
    args: [params[0].value, params[1].value, 0, 3, params[4].value],
  });
  assert.equal(encoded.calldata, viem);

  const viemDecoded = decodeFunctionData({
    abi: parseAbi([
      'function registerFilter(bytes32 id, string name, uint8 mode, uint32 version, bytes32 paramsHash)',
    ]),
    data: encoded.calldata,
  });
  assert.equal(viemDecoded.args[1], 'grayscale-ñandú');
});

test('los retornos múltiples se decodifican como una tupla', () => {
  const types = ['string', 'uint8', 'uint32', 'bytes32', 'bool'];
  const values = ['sepia', 2, 9, '0x' + 'ef'.repeat(32), true];
  const encoded = encodeParams(
    types.map((type, i) => ({ type, name: `r${i}`, value: values[i] })),
  );
  const decoded = decodeParams(types, encoded.hex);
  assert.equal(decoded[0], 'sepia');
  assert.equal(decoded[1], 2n);
  assert.equal(decoded[2], 9n);
  assert.equal(decoded[3], '0x' + 'ef'.repeat(32));
  assert.equal(decoded[4], true);
});

test('gas de calldata: 4 por byte cero y 16 por byte distinto de cero', () => {
  const encoded = encodeCall('transfer(address,uint256)', [
    { type: 'address', name: 'to', value: '0x0000000000000000000000000000000000000001' },
    { type: 'uint256', name: 'amount', value: 1 },
  ]);
  const gas = calldataGas(encoded.calldata);
  assert.equal(gas.totalBytes, encoded.calldata.length / 2 - 1);
  assert.equal(gas.dataGas, gas.zeroBytes * 4 + gas.nonZeroBytes * 16);
  assert.equal(gas.totalGas, 21000 + gas.dataGas);

  // Un frame RGBA de 1 MB como calldata: absurdo para Ethereum.
  const oneMegabyte = 1024 * 1024;
  assert.equal(21000 + 16 * oneMegabyte, 16_798_216);
});

test('tipos desde la firma', () => {
  assert.deepEqual(typesFromSignature('f()'), []);
  assert.deepEqual(typesFromSignature('f(uint256,address)'), ['uint256', 'address']);
  assert.throws(() => typesFromSignature('sin parentesis'));
});

test('el contrato compila con solc y expone la ABI esperada', () => {
  const source = readFileSync(path.join(root, 'contracts', 'PixelFilterRegistry.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'PixelFilterRegistry.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors, []);

  const contract = output.contracts['PixelFilterRegistry.sol'].PixelFilterRegistry;
  const names = contract.abi.map((entry) => entry.name).filter(Boolean);
  for (const fn of ['registerFilter', 'setEnabled', 'getFilter', 'idFor']) {
    assert.ok(names.includes(fn), fn);
  }
  assert.ok(contract.evm.bytecode.object.length > 0);

  // El selector que usa la demo existe realmente en el contrato compilado.
  const register = contract.abi.find((entry) => entry.name === 'registerFilter');
  assert.equal(
    selector(
      `registerFilter(${register.inputs.map((input) => input.type).join(',')})`,
    ),
    '0x1646a0c2',
  );
});
