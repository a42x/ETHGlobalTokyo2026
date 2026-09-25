// Deploys to a throwaway anvil chain that reports Amoy's chain id, with a fresh
// in-memory key. No RPC, wallet or .env is read.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {createPublicClient, createWalletClient, defineChain, http, keccak256} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {AMOY_CHAIN_ID, acceptanceChecks, checker, compileVerifier} from './lib.mjs';

const verifier = compileVerifier();
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const url = `http://127.0.0.1:${port}`;
const chain = defineChain({id: AMOY_CHAIN_ID, name: 'anvil-amoy-id', nativeCurrency: {name: 'POL', symbol: 'POL', decimals: 18}, rpcUrls: {default: {http: [url]}}});
const client = createPublicClient({chain, transport: http(url, {retryCount: 0})});
const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({chain, transport: http(url), account});
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(AMOY_CHAIN_ID), '--silent'], {stdio: 'ignore'});
try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await client.getChainId()) === AMOY_CHAIN_ID; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'local anvil started');
  await client.request({method: 'anvil_setBalance', params: [account.address, '0x56BC75E2D63100000']});
  const hash = await wallet.deployContract({abi: verifier.abi, bytecode: verifier.bytecode});
  const receipt = await client.waitForTransactionReceipt({hash});
  assert.equal(receipt.status, 'success');
  const code = await client.getCode({address: receipt.contractAddress});
  assert.equal(code, verifier.runtime, 'deployed runtime equals compiled runtime');
  const accepts = checker(verifier.abi, data => client.call({to: receipt.contractAddress, data}));
  const result = await acceptanceChecks(accepts);
  console.log(JSON.stringify({chain: 'local anvil, chain id 80002', syntheticOnly: true, ...result,
    deployGas: receipt.gasUsed.toString(), runtimeCodeHash: keccak256(code), compiler: verifier.compiler}, null, 2));
} finally {
  anvil.kill('SIGTERM');
}
