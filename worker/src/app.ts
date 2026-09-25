import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bytesToHex, getAddress, isAddress, isHex, parseUnits, size, zeroAddress, type Address, type Hex } from "viem";
import { findBenefit, listBenefits, minAgeOf } from "./benefits";
import { GATE_ORDER_DURATION, GATE_MIN_AGE, computeClaimHash, publicInputs } from "./claim-hash";
import { getClaim, insertClaim, recordPendingTxHash, compareAndSetStatus, type ClaimRow } from "./claims";
import { agentRoutes, type Llm } from "./agent";
import { AlreadyPaidError, type Payout } from "./payout";
import type { Verifier } from "./verify";

export type Deps = {
  verifier: Verifier;
  payout: Payout;
  now: () => number;
  receiptWaitMs: number;
  /** null when ANTHROPIC_API_KEY is not configured; the agent route then answers 503. */
  llm: Llm | null;
  agentModel: string;
};

type Env = { Bindings: Cloudflare.Env };

const UINT = /^(0|[1-9][0-9]*)$/;

function originMatches(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) return origin === pattern;
  const [prefix, suffix] = pattern.split("*");
  return origin.startsWith(prefix) && origin.endsWith(suffix) && origin.length > prefix.length + suffix.length;
}

function apiError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function isBytes(value: unknown, bytes: number): value is Hex {
  return typeof value === "string" && isHex(value, { strict: true }) && size(value) === bytes;
}

function address(value: string): Address {
  return value ? getAddress(value) : zeroAddress;
}

function explorerUrl(txHash: Hex): string {
  return `https://amoy.polygonscan.com/tx/${txHash}`;
}

function claimView(env: Cloudflare.Env, row: ClaimRow, now: number) {
  const expired = row.status === "pending_proof" && now >= row.expires_at;
  return {
    id: row.id,
    benefit_id: row.benefit_id,
    wallet_address: row.wallet_address,
    status: expired ? "expired" : row.status,
    chain_id: Number(env.CHAIN_ID),
    gate_address: address(env.BENEFIT_AGE_GATE_ADDRESS),
    office_address: address(env.BENEFIT_OFFICE_ADDRESS),
    challenge: {
      claimHash: row.claim_hash,
      nonce: row.nonce,
      referenceTime: row.reference_time,
      expiresAt: row.expires_at,
    },
    claim: { type: "age_over", minAge: GATE_MIN_AGE },
    expires_at: new Date(row.expires_at * 1000).toISOString(),
    tx_hash: row.tx_hash,
    explorer_url: row.tx_hash ? explorerUrl(row.tx_hash) : null,
  };
}

export function createApp(deps: Deps) {
  const app = new Hono<Env>();

  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        const allowed = (c.env as Cloudflare.Env).CORS_ORIGINS.split(",").map((s) => s.trim());
        return allowed.some((p) => originMatches(origin, p)) ? origin : null;
      },
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/benefit-office/v1/benefits", (c) =>
    c.json({ data: { items: listBenefits(Number(c.env.CHAIN_ID)) } }),
  );

  app.post("/benefit-office/v1/claims", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.benefit_id !== "string" || typeof body?.wallet_address !== "string"
        || !isAddress(body.wallet_address)) {
      return apiError(c, 400, "INVALID_REQUEST", "benefit_id and a valid wallet_address are required");
    }
    const chainId = Number(c.env.CHAIN_ID);
    const benefit = findBenefit(body.benefit_id, chainId);
    if (!benefit) return apiError(c, 404, "BENEFIT_NOT_FOUND", "Benefit not found");
    if (minAgeOf(benefit) !== GATE_MIN_AGE) {
      return apiError(c, 400, "BENEFIT_UNSUPPORTED", "This benefit cannot be claimed in the demo");
    }

    const now = deps.now();
    const recipient = getAddress(body.wallet_address);
    const row: ClaimRow = {
      id: `clm_${crypto.randomUUID()}`,
      benefit_id: benefit.id,
      wallet_address: recipient,
      status: "pending_proof",
      claim_hash: computeClaimHash({
        chainId,
        office: address(c.env.BENEFIT_OFFICE_ADDRESS),
        benefitId: benefit.id,
        recipient,
        amountWei: parseUnits(benefit.amount, 18),
        minAge: GATE_MIN_AGE,
      }),
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      reference_time: now,
      expires_at: now + GATE_ORDER_DURATION,
      proof_type: null,
      tx_hash: null,
      created_at: now,
      updated_at: now,
    };
    await insertClaim(c.env.CLAIMS, row);
    return c.json({ data: claimView(c.env, row, now) }, 201);
  });

  app.get("/benefit-office/v1/claims/:id", async (c) => {
    const row = await getClaim(c.env.CLAIMS, c.req.param("id"));
    if (!row) return apiError(c, 404, "CLAIM_NOT_FOUND", "Claim not found");
    return c.json({ data: claimView(c.env, row, deps.now()) });
  });

  app.post("/benefit-office/v1/claims/:id/proof", async (c) => {
    const id = c.req.param("id");
    const row = await getClaim(c.env.CLAIMS, id);
    if (!row) return apiError(c, 404, "CLAIM_NOT_FOUND", "Claim not found");
    if (row.status === "paid") return apiError(c, 409, "CLAIM_ALREADY_PAID", "Claim is already paid");
    if (row.status === "verifying") return c.json({ data: { id, status: "verifying" } }, 202);
    if (deps.now() >= row.expires_at) return apiError(c, 410, "CLAIM_EXPIRED", "Claim has expired");

    const body = await c.req.json().catch(() => null);
    if (body?.proof_type !== "groth16" || !isBytes(body.proof, 384)
        || !isBytes(body.root_key_hash, 32)
        || !Array.isArray(body.public_inputs) || body.public_inputs.length !== 8
        || !body.public_inputs.every((v: unknown) => typeof v === "string" && UINT.test(v))) {
      return apiError(c, 400, "INVALID_PROOF_FORMAT", "Expected a groth16 proof, root_key_hash and 8 public_inputs");
    }

    const proof = body.proof.toLowerCase() as Hex;
    const inputs = publicInputs({
      claimHash: row.claim_hash,
      nonce: row.nonce,
      rootKeyHash: body.root_key_hash as Hex,
      referenceTime: row.reference_time,
      expiresAt: row.expires_at,
    });
    if (inputs.some((v, i) => v !== BigInt(body.public_inputs[i]))) {
      return apiError(c, 403, "PROOF_REJECTED", "public_inputs do not match this claim");
    }
    let ok: boolean;
    try {
      ok = await deps.verifier.verifyClaimAge({
        claimHash: row.claim_hash,
        nonce: row.nonce,
        expiresAt: row.expires_at,
        proof,
        inputs,
      });
    } catch {
      return apiError(c, 502, "VERIFIER_UNAVAILABLE", "Could not reach the age verifier");
    }
    if (!ok) return apiError(c, 403, "PROOF_REJECTED", "Age proof was rejected");

    if (!(await compareAndSetStatus(c.env.CLAIMS, id, ["pending_proof", "failed"], "verifying", deps.now(), { proof_type: "groth16" }))) {
      return c.json({ data: { id, status: "verifying" } }, 202);
    }

    let txHash: Hex;
    try {
      txHash = await deps.payout.send({
        benefitId: row.benefit_id,
        recipient: row.wallet_address,
        nonce: row.nonce,
        expiresAt: row.expires_at,
        proof,
        inputs,
      });
    } catch (err) {
      await compareAndSetStatus(c.env.CLAIMS, id, ["verifying"], "failed", deps.now());
      if (err instanceof AlreadyPaidError) {
        return apiError(c, 409, "CLAIM_ALREADY_PAID", "This wallet has already received this benefit");
      }
      return apiError(c, 502, "PAYOUT_FAILED", "Failed to send the payout transaction");
    }
    await recordPendingTxHash(c.env.CLAIMS, id, txHash, deps.now());

    const settled = deps.payout
      .waitForReceipt(txHash)
      .catch(() => "reverted" as const)
      .then(async (result) => {
        await compareAndSetStatus(c.env.CLAIMS, id, ["verifying"], result === "success" ? "paid" : "failed", deps.now());
        return result;
      });
    let timer = 0;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), deps.receiptWaitMs)));
    const result = await Promise.race([settled, timeout]);
    clearTimeout(timer);

    if (result === null) {
      c.executionCtx.waitUntil(settled);
      return c.json({ data: { id, status: "verifying" } }, 202);
    }
    if (result === "reverted") {
      return apiError(c, 502, "PAYOUT_FAILED", "Payout transaction reverted");
    }
    const benefit = findBenefit(row.benefit_id, Number(c.env.CHAIN_ID))!;
    return c.json({
      data: {
        id,
        status: "paid",
        tx_hash: txHash,
        amount: benefit.amount,
        token_symbol: benefit.token_symbol,
        explorer_url: explorerUrl(txHash),
      },
    });
  });

  app.route("/", agentRoutes(deps.llm, deps.agentModel));

  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Not found"));

  return app;
}
