// Deploys the verifier to Polygon Amoy. The key is read only from the
// AMOY_DEPLOYER_PRIVATE_KEY environment variable and is never written.
// Use a disposable testnet-only key funded with faucet POL.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createPublicClient, createWalletClient, http, keccak256, parseGwei} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {polygonAmoy} from 'viem/chains';
import {AMOY_CHAIN_ID, AMOY_RPC, SETTINGS, VERIFIER_SHA256, compileVerifier, root} from './lib.mjs';

const file = path.join(root, 'deployments/amoy.json');
assert.ok(!existsSync(file), 'deployments/amoy.json exists; refusing to deploy a second verifier');
const key = process.env.AMOY_DEPLOYER_PRIVATE_KEY;
assert.match(key ?? '', /^0x[0-9a-fA-F]{64}$/, 'set AMOY_DEPLOYER_PRIVATE_KEY');
const verifier = compileVerifier();
const transport = http(process.env.AMOY_RPC_URL ?? AMOY_RPC);
const client = createPublicClient({chain: polygonAmoy, transport});
assert.equal(await client.getChainId(), AMOY_CHAIN_ID, 'RPC is Polygon Amoy');
const account = privateKeyToAccount(key);
const wallet = createWalletClient({chain: polygonAmoy, transport, account});

// Amoy's suggested tip is often far above what gets included; allow a lower one.
const tipGwei = process.env.AMOY_PRIORITY_FEE_GWEI;
const fees = {};
if (tipGwei) {
  const maxPriorityFeePerGas = parseGwei(tipGwei);
  const {baseFeePerGas} = await client.getBlock();
  Object.assign(fees, {maxPriorityFeePerGas, maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas});
}
const hash = await wallet.deployContract({abi: verifier.abi, bytecode: verifier.bytecode, ...fees});
console.log(`sent ${hash}`);
const receipt = await client.waitForTransactionReceipt({hash});
assert.equal(receipt.status, 'success', 'deployment succeeded');
const code = await client.getCode({address: receipt.contractAddress});
assert.equal(code, verifier.runtime, 'on-chain runtime equals compiled runtime');
const inputs = readFileSync(path.join(root, 'fixtures/synthetic/inputs.txt'));
mkdirSync(path.dirname(file), {recursive: true});
writeFileSync(file, JSON.stringify({
  chainId: AMOY_CHAIN_ID, verifier: receipt.contractAddress, deployer: account.address,
  transaction: hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(),
  runtimeCodeHash: keccak256(code), verifierSourceSHA256: VERIFIER_SHA256,
  syntheticInputsSHA256: createHash('sha256').update(inputs).digest('hex'),
  compiler: verifier.compiler, settings: SETTINGS, setup: 'single-party test setup, not a ceremony',
  explorer: `https://amoy.polygonscan.com/address/${receipt.contractAddress}`,
}, null, 2) + '\n');
console.log(`verifier ${receipt.contractAddress}; run: node scripts/verify.mjs`);
