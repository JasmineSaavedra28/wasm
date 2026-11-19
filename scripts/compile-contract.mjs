#!/usr/bin/env node
/* Compila el contrato con solc y guarda ABI + bytecode en build/. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(import.meta.dirname, '..');
const contractPath = path.join(root, 'contracts', 'PixelFilterRegistry.sol');
const source = readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'PixelFilterRegistry.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

const contract = output.contracts['PixelFilterRegistry.sol'].PixelFilterRegistry;
mkdirSync(path.join(root, 'build'), { recursive: true });
const artifact = {
  contractName: 'PixelFilterRegistry',
  compiler: solc.version(),
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
  deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
  warnings: (output.errors ?? []).filter((e) => e.severity !== 'error').map((e) => e.formattedMessage),
};

const outFile = path.join(root, 'build', 'PixelFilterRegistry.json');
writeFileSync(outFile, JSON.stringify(artifact, null, 2));

console.log(`solc ${solc.version()}`);
console.log(`ABI: ${contract.abi.length} entradas`);
console.log(`bytecode: ${(artifact.bytecode.length - 2) / 2} bytes`);
console.log(`Artefacto: ${path.relative(root, outFile)}`);
for (const warning of artifact.warnings) console.warn(warning);
