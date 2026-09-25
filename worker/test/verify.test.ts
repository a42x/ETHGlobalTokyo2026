import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { groth16Verifier } from "../src/verify";
import proofHex from "./fixtures/proof.hex?raw";
import secondProofHex from "./fixtures/second-proof.hex?raw";
import inputsTxt from "./fixtures/inputs.txt?raw";

// Real deployment from teammate PR #3 (origin/feat/zk-age-verifier-amoy), Polygon Amoy.
const VERIFIER_ADDRESS = "0xb89d8e0c4a345ead852ab919548734c4f506596c";
const AMOY_RPC = "https://polygon-amoy-bor-rpc.publicnode.com";

const proof = proofHex.trim() as `0x${string}`;
const secondProof = secondProofHex.trim() as `0x${string}`;
const inputs = inputsTxt.trim().split(/\s+/).map(BigInt);

function flipByte(hex: `0x${string}`): `0x${string}` {
  const byte = parseInt(hex.slice(2, 4), 16) ^ 1;
  return `0x${byte.toString(16).padStart(2, "0")}${hex.slice(4)}` as `0x${string}`;
}

function verifierAt(rpcUrl: string) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return groth16Verifier(client, VERIFIER_ADDRESS);
}

const ZERO_HASH = `0x${"00".repeat(32)}` as `0x${string}`;

const check = (overrides: Partial<{ proof: `0x${string}`; inputs: bigint[] }> = {}) => ({
  claimHash: ZERO_HASH,
  nonce: ZERO_HASH,
  expiresAt: 0,
  proof: overrides.proof ?? proof,
  inputs: overrides.inputs ?? inputs,
});

describe("groth16Verifier against the real Amoy deployment", () => {
  it("accepts the fixture proof", async () => {
    expect(await verifierAt(AMOY_RPC).verifyClaimAge(check())).toBe(true);
  });

  it("accepts a second randomized proof of the same witness", async () => {
    expect(await verifierAt(AMOY_RPC).verifyClaimAge(check({ proof: secondProof }))).toBe(true);
  });

  it("rejects a proof with one byte flipped", async () => {
    expect(await verifierAt(AMOY_RPC).verifyClaimAge(check({ proof: flipByte(proof) }))).toBe(false);
  });

  it("rejects a proof whose public input was incremented", async () => {
    const tampered = inputs.slice();
    tampered[0] = tampered[0] + 1n;
    expect(await verifierAt(AMOY_RPC).verifyClaimAge(check({ inputs: tampered }))).toBe(false);
  });

  it("throws, rather than rejecting, when the RPC is unreachable", async () => {
    await expect(verifierAt("http://127.0.0.1:1").verifyClaimAge(check())).rejects.toThrow();
  });
});
