import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp, type Deps } from "../src/app";
import { publicInputs } from "../src/claim-hash";
import { AlreadyPaidError, mockPayout } from "../src/payout";
import type { OnchainReader } from "../src/onchain";
import type { Verifier } from "../src/verify";

const WALLET = "0x1111111111111111111111111111111111111111";
const ROOT = "0xa5fad04a2d6cbb52ce03a55106a6e23be4fa4a771bb0bf81401833afc410b15e";
const PROOF = "0x" + "ab".repeat(384);
const acceptVerifier: Verifier = { verifyClaimAge: async () => true };

function setup(overrides: Partial<Deps> = {}) {
  let clock = 1_790_000_000;
  const app = createApp({
    verifier: acceptVerifier,
    payout: mockPayout,
    now: () => clock,
    receiptWaitMs: 50,
    llm: null,
    agentModel: "test-model",
    ...overrides,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`http://worker${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, advance: (s: number) => (clock += s) };
}

function proofFor(claim: any, inputs?: string[]) {
  return {
    proof_type: "groth16",
    proof: PROOF,
    root_key_hash: ROOT,
    public_inputs:
      inputs ??
      publicInputs({
        claimHash: claim.challenge.claimHash,
        nonce: claim.challenge.nonce,
        rootKeyHash: ROOT,
        referenceTime: claim.challenge.referenceTime,
        expiresAt: claim.challenge.expiresAt,
      }).map(String),
  };
}

async function createClaim(call: ReturnType<typeof setup>["call"]) {
  const res = await call("POST", "/benefit-office/v1/claims", { benefit_id: "youth-support-2026", wallet_address: WALLET });
  expect(res.status).toBe(201);
  return res.json.data;
}

describe("claims", () => {
  it("creates a claim with a 900 second challenge", async () => {
    const { call } = setup();
    const claim = await createClaim(call);
    expect(claim.status).toBe("pending_proof");
    expect(claim.claim).toEqual({ type: "age_over", minAge: 20 });
    expect(claim.challenge.expiresAt - claim.challenge.referenceTime).toBe(900);
    expect(claim.id).toMatch(/^clm_/);
  });

  it("pays out a valid proof and refuses a second one", async () => {
    const { call } = setup();
    const claim = await createClaim(call);

    const paid = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(paid.status).toBe(200);
    expect(paid.json.data).toMatchObject({ status: "paid", amount: "500", token_symbol: "JPYC" });
    expect(paid.json.data.explorer_url).toContain(paid.json.data.tx_hash);

    const fetched = await call("GET", `/benefit-office/v1/claims/${claim.id}`);
    expect(fetched.json.data).toMatchObject({ status: "paid", tx_hash: paid.json.data.tx_hash });

    const again = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("CLAIM_ALREADY_PAID");
  });

  it("rejects public_inputs bound to a different claim", async () => {
    const { call } = setup();
    const claim = await createClaim(call);
    const other = await createClaim(call);

    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim, proofFor(other).public_inputs));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("PROOF_REJECTED");
    expect((await call("GET", `/benefit-office/v1/claims/${claim.id}`)).json.data.status).toBe("pending_proof");
  });

  it("rejects a proof the gate refuses", async () => {
    const { call } = setup({ verifier: { verifyClaimAge: async () => false } });
    const claim = await createClaim(call);
    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("PROOF_REJECTED");
  });

  it("returns 502 and keeps the claim pending when the verifier throws", async () => {
    const { call } = setup({
      verifier: {
        verifyClaimAge: async () => {
          throw new Error("RPC unreachable");
        },
      },
    });
    const claim = await createClaim(call);
    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe("VERIFIER_UNAVAILABLE");
    expect((await call("GET", `/benefit-office/v1/claims/${claim.id}`)).json.data.status).toBe("pending_proof");
  });

  it("rejects malformed proofs", async () => {
    const { call } = setup();
    const claim = await createClaim(call);
    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, { ...proofFor(claim), proof: "0x1234" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_PROOF_FORMAT");
  });

  it("expires claims after 900 seconds", async () => {
    const { call, advance } = setup();
    const claim = await createClaim(call);
    advance(900);
    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(res.status).toBe(410);
    expect((await call("GET", `/benefit-office/v1/claims/${claim.id}`)).json.data.status).toBe("expired");
  });

  it("returns 202 when the receipt is slow and finishes in the background", async () => {
    const { call } = setup({
      payout: { ...mockPayout, waitForReceipt: () => new Promise((r) => setTimeout(() => r("success"), 200)) },
    });
    const claim = await createClaim(call);
    const res = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(res.status).toBe(202);
    expect(res.json.data.status).toBe("verifying");
    expect((await call("GET", `/benefit-office/v1/claims/${claim.id}`)).json.data.status).toBe("paid");
  });

  it("marks the claim failed when the payout reverts, and allows a retry", async () => {
    let receipt: "success" | "reverted" = "reverted";
    const { call } = setup({ payout: { ...mockPayout, waitForReceipt: async () => receipt } });
    const claim = await createClaim(call);

    const failed = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe("PAYOUT_FAILED");

    receipt = "success";
    const retried = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(retried.status).toBe(200);
  });

  it("returns 409 when the office has already paid this wallet, and allows a retry after a reset", async () => {
    let alreadyPaid = true;
    const { call } = setup({
      payout: {
        ...mockPayout,
        send: async (req) => {
          if (alreadyPaid) throw new AlreadyPaidError("paid");
          return mockPayout.send(req);
        },
      },
    });
    const claim = await createClaim(call);

    const refused = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("CLAIM_ALREADY_PAID");
    expect((await call("GET", `/benefit-office/v1/claims/${claim.id}`)).json.data.status).toBe("failed");

    alreadyPaid = false;
    const retried = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(retried.status).toBe(200);
  });

  it.each([
    ["senior-2026", 400, "BENEFIT_UNSUPPORTED"],
    ["welcome-2026", 400, "BENEFIT_UNSUPPORTED"],
    ["nope", 404, "BENEFIT_NOT_FOUND"],
  ])("refuses %s", async (benefitId, status, code) => {
    const { call } = setup();
    const res = await call("POST", "/benefit-office/v1/claims", { benefit_id: benefitId, wallet_address: WALLET });
    expect(res.status).toBe(status);
    expect(res.json.error.code).toBe(code);
  });

  it("returns 404 for unknown claims", async () => {
    const { call } = setup();
    const res = await call("GET", "/benefit-office/v1/claims/clm_missing");
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("CLAIM_NOT_FOUND");
  });
});

describe("chain reads (#24)", () => {
  const eligibility = {
    chain_id: 80002,
    office_address: "0x00000000000000000000000000000000000000Aa",
    token_address: "0x00000000000000000000000000000000000000Bb",
    amount: "500",
    office_balance: "3000",
    already_received: false,
    funded: true,
    claimable: true,
  } as const;

  function reader(overrides: Partial<OnchainReader> = {}): OnchainReader {
    return {
      eligibility: async () => ({ ...eligibility }),
      isPaid: async () => false,
      checkPayment: async (txHash) => ({
        tx_hash: txHash,
        status: "success",
        block_number: "123",
        transfer: { from: eligibility.office_address, to: WALLET, amount: "500" },
        confirmed: true,
      }),
      ...overrides,
    };
  }

  it("refuses a claim before any card is read when the chain records a payout", async () => {
    const { call } = setup({ onchain: reader({ isPaid: async () => true }) });
    const res = await call("POST", "/benefit-office/v1/claims", { benefit_id: "youth-support-2026", wallet_address: WALLET });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("CLAIM_ALREADY_PAID");
  });

  it("still creates the claim when the chain cannot be read, since the contract enforces it", async () => {
    const { call } = setup({ onchain: reader({ isPaid: async () => Promise.reject(new Error("RPC down")) }) });
    const res = await call("POST", "/benefit-office/v1/claims", { benefit_id: "youth-support-2026", wallet_address: WALLET });
    expect(res.status).toBe(201);
  });

  it("returns eligibility read from the chain", async () => {
    const { call } = setup({ onchain: reader() });
    const res = await call("GET", `/benefit-office/v1/onchain/eligibility?benefit_id=youth-support-2026&wallet_address=${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ benefit_id: "youth-support-2026", ...eligibility });
  });

  it.each([
    ["no wallet", "?benefit_id=youth-support-2026", 400, "INVALID_REQUEST"],
    ["bad wallet", "?benefit_id=youth-support-2026&wallet_address=0x12", 400, "INVALID_REQUEST"],
    ["unknown benefit", `?benefit_id=nope&wallet_address=${WALLET}`, 404, "BENEFIT_NOT_FOUND"],
  ])("rejects eligibility requests with %s", async (_label, query, status, code) => {
    const { call } = setup({ onchain: reader() });
    const res = await call("GET", `/benefit-office/v1/onchain/eligibility${query}`);
    expect(res.status).toBe(status);
    expect(res.json.error.code).toBe(code);
  });

  it("answers 503 without an office and 502 when the chain cannot be read", async () => {
    const q = `?benefit_id=youth-support-2026&wallet_address=${WALLET}`;
    expect((await setup().call("GET", `/benefit-office/v1/onchain/eligibility${q}`)).status).toBe(503);
    const failing = setup({ onchain: reader({ eligibility: () => Promise.reject(new Error("RPC down")) }) });
    const res = await failing.call("GET", `/benefit-office/v1/onchain/eligibility${q}`);
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("reports no payout before the claim has a transaction", async () => {
    const { call } = setup({ onchain: reader() });
    const claim = await createClaim(call);
    const res = await call("GET", `/benefit-office/v1/claims/${claim.id}/onchain`);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ claim_id: claim.id, tx_hash: null, confirmed: false });
  });

  it("checks the payout transaction on chain for this claim's benefit and wallet", async () => {
    const seen: unknown[] = [];
    const { call } = setup({
      onchain: reader({
        checkPayment: async (txHash, benefitId, wallet) => {
          seen.push([txHash, benefitId, wallet]);
          return reader().checkPayment(txHash, benefitId, wallet);
        },
      }),
    });
    const claim = await createClaim(call);
    const paid = await call("POST", `/benefit-office/v1/claims/${claim.id}/proof`, proofFor(claim));
    expect(paid.status).toBe(200);

    const res = await call("GET", `/benefit-office/v1/claims/${claim.id}/onchain`);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ claim_id: claim.id, tx_hash: paid.json.data.tx_hash, confirmed: true, block_number: "123" });
    expect(res.json.data.explorer_url).toContain(paid.json.data.tx_hash);
    expect(seen).toEqual([[paid.json.data.tx_hash, "youth-support-2026", WALLET]]);
  });
});

