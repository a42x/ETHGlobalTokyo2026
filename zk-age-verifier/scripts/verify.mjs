// Read-only checks against Polygon Amoy with eth_call. No key is used.
//   node scripts/verify.mjs            checks the address in deployments/amoy.json
//   node scripts/verify.mjs --dry-run  places the compiled runtime at a scratch
//                                      address via eth_call state override and
//                                      estimates deployment gas; nothing is sent.
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {createPublicClient, http, keccak256} from 'viem';
import {polygonAmoy} from 'viem/chains';
import {AMOY_CHAIN_ID, AMOY_RPC, acceptanceChecks, checker, compileVerifier, root} from './lib.mjs';

const verifier = compileVerifier();
const client = createPublicClient({chain: polygonAmoy, transport: http(process.env.AMOY_RPC_URL ?? AMOY_RPC)});
assert.equal(await client.getChainId(), AMOY_CHAIN_ID, 'RPC is Polygon Amoy');

if (process.argv.includes('--dry-run')) {
  const address = '0x00000000000000000000000000000000000a9e00';
  const accepts = checker(verifier.abi, data =>
    client.call({to: address, data, stateOverride: [{address, code: verifier.runtime}]}));
  const result = await acceptanceChecks(accepts);
  const deployGas = await client.estimateGas({account: address, data: verifier.bytecode});
  console.log(JSON.stringify({chain: 'Polygon Amoy (state override, nothing deployed)', syntheticOnly: true, ...result,
    estimatedDeployGas: deployGas.toString(), block: (await client.getBlockNumber()).toString()}, null, 2));
} else {
  const file = path.join(root, 'deployments/amoy.json');
  assert.ok(existsSync(file), 'deployments/amoy.json not found; deploy first or use --dry-run');
  const deployment = JSON.parse(readFileSync(file, 'utf8'));
  const code = await client.getCode({address: deployment.verifier});
  assert.equal(keccak256(code), deployment.runtimeCodeHash, 'on-chain code matches the recorded deployment');
  assert.equal(code, verifier.runtime, 'on-chain code matches this source');
  const accepts = checker(verifier.abi, data => client.call({to: deployment.verifier, data}));
  console.log(JSON.stringify({chain: 'Polygon Amoy', verifier: deployment.verifier, syntheticOnly: true,
    ...(await acceptanceChecks(accepts))}, null, 2));
}
