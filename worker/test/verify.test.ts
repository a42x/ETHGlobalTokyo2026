import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { gateVerifier, groth16Verifier } from "../src/verify";
import proofHex from "./fixtures/proof.hex?raw";
import secondProofHex from "./fixtures/second-proof.hex?raw";
import inputsTxt from "./fixtures/inputs.txt?raw";

// Real deployment on Polygon Amoy (zk-age-verifier/deployments/amoy.json).
const VERIFIER_ADDRESS = "0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078";
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

// Real gates on Amoy (contracts/deployments/amoy.json). The fixture is synthetic:
// its root is the one pinned in BenefitAgeGateTestRoot, and it is valid from
// referenceTime 1800000000 to expiresAt 1800000900, so the tests move block time there.
const TEST_ROOT_GATE = "0x5cc9a5b5779e81fedb1bb8ecceb94aa553f254a6";
const JLIS_GATE = "0x44a0c9187cacfd2211d6e36e662b81e21950fdee";
const IN_WINDOW = { time: 1_800_000_100n };

const join = (hi: bigint, lo: bigint) => `0x${((hi << 128n) | lo).toString(16).padStart(64, "0")}` as `0x${string}`;

const bound = (overrides: Partial<{ claimHash: `0x${string}`; proof: `0x${string}` }> = {}) => ({
  claimHash: overrides.claimHash ?? join(inputs[0], inputs[1]),
  nonce: join(inputs[2], inputs[3]),
  expiresAt: Number(inputs[7]),
  proof: overrides.proof ?? proof,
  inputs,
});

function gateAt(address: `0x${string}`, blockOverrides?: { time: bigint }, rpcUrl = AMOY_RPC) {
  return gateVerifier(createPublicClient({ transport: http(rpcUrl) }), address, blockOverrides);
}

describe("gateVerifier against the real Amoy gates", () => {
  it("accepts the fixture inside its time window on the gate that pins its root", async () => {
    expect(await gateAt(TEST_ROOT_GATE, IN_WINDOW).verifyClaimAge(bound())).toBe(true);
  });

  it("rejects the fixture on the J-LIS gate, whose roots do not include it", async () => {
    expect(await gateAt(JLIS_GATE, IN_WINDOW).verifyClaimAge(bound())).toBe(false);
  });

  it("rejects the fixture outside its time window", async () => {
    expect(await gateAt(TEST_ROOT_GATE).verifyClaimAge(bound())).toBe(false);
  });

  it("rejects the fixture for another claim", async () => {
    expect(await gateAt(TEST_ROOT_GATE, IN_WINDOW).verifyClaimAge(bound({ claimHash: ZERO_HASH }))).toBe(false);
  });

  it("rejects a tampered proof", async () => {
    expect(await gateAt(TEST_ROOT_GATE, IN_WINDOW).verifyClaimAge(bound({ proof: flipByte(proof) }))).toBe(false);
  });

  it("throws, rather than rejecting, when the RPC is unreachable", async () => {
    await expect(gateAt(TEST_ROOT_GATE, IN_WINDOW, "http://127.0.0.1:1").verifyClaimAge(bound())).rejects.toThrow();
  });
});
