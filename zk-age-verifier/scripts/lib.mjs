import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {encodeFunctionData} from 'viem';

export const root = path.resolve(import.meta.dirname, '..');
export const AMOY_CHAIN_ID = 80002;
export const AMOY_RPC = 'https://polygon-amoy-bor-rpc.publicnode.com';
export const VERIFIER_SHA256 = '001ede90029f4186ebbe733d4ef245b8f6167680b87af08002ef176839a85aff';
export const SETTINGS = {optimizer: {enabled: true, runs: 200}, evmVersion: 'cancun', viaIR: true};

const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

export function compileVerifier() {
  const source = read('contracts/Verifier.sol');
  assert.equal(createHash('sha256').update(source).digest('hex'), VERIFIER_SHA256,
    'contracts/Verifier.sol differs from the pinned ProveKit export');
  assert.equal((source.match(/uint256\[5\] memory buf/g) ?? []).length, 3, 'memory-boundary fix missing');
  const input = {language: 'Solidity', sources: {'Verifier.sol': {content: source}},
    settings: {...SETTINGS, outputSelection: {'*': {'*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object']}}}};
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const c = output.contracts['Verifier.sol'].ProvekitGroth16Verifier;
  const runtime = '0x' + c.evm.deployedBytecode.object;
  assert.ok((runtime.length - 2) / 2 <= 24576, 'EIP-170 code size');
  return {abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime, compiler: solc.version()};
}

export function syntheticFixture() {
  const inputs = read('fixtures/synthetic/inputs.txt').trim().split(/\s+/).map(BigInt);
  assert.equal(inputs.length, 8);
  const proof = read('fixtures/synthetic/proof.hex').trim();
  const second = read('fixtures/synthetic/second-proof.hex').trim();
  for (const p of [proof, second]) assert.match(p, /^0x[0-9a-f]{768}$/, '384-byte proof');
  return {proof, second, inputs};
}

// verifyProof returns nothing and reverts on any failure. Only a revert counts
// as rejection; a transport error must not make a negative check pass.
export function checker(abi, call) {
  return async (proof, inputs) => {
    const data = encodeFunctionData({abi, functionName: 'verifyProof', args: [proof, inputs]});
    try { await call(data); return true; }
    catch (error) {
      if (/revert/i.test(`${error.shortMessage ?? ''} ${error.details ?? ''} ${error.message ?? ''}`)) return false;
      throw error;
    }
  };
}

export async function acceptanceChecks(accepts) {
  const {proof, second, inputs} = syntheticFixture();
  assert.equal(await accepts(proof, inputs), true, 'valid synthetic proof accepted');
  assert.equal(await accepts(second, inputs), true, 'second randomized proof of the same witness accepted');
  const damaged = '0x' + (parseInt(proof.slice(2, 4), 16) ^ 1).toString(16).padStart(2, '0') + proof.slice(4);
  assert.equal(await accepts(damaged, inputs), false, 'tampered proof rejected');
  for (let i = 0; i < 8; i++) {
    const other = inputs.slice();
    other[i] ^= 1n;
    assert.equal(await accepts(proof, other), false, `tampered public input ${i} rejected`);
  }
  return {validProofAccepted: true, secondProofAccepted: true, tamperedProofRejected: true, tamperedPublicInputsRejected: 8};
}
