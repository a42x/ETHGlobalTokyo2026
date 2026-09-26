import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { findBenefit, listBenefits } from "../src/benefits";
import { mockPayout } from "../src/payout";

const app = createApp({
  verifier: { verifyClaimAge: async () => true },
  payout: mockPayout,
  now: () => 1_790_000_000,
  receiptWaitMs: 50,
  llm: null,
  agentModel: "test-model",
});

async function list(query = "") {
  const res = await app.fetch(new Request(`http://worker/benefit-office/v1/benefits${query}`), env);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).data.items as any[];
}

const languageNeutral = (items: any[]) =>
  items.map(({ id, amount, token_symbol, chain_id, requirements, status }) => ({ id, amount, token_symbol, chain_id, requirements, status }));

describe("GET /benefit-office/v1/benefits", () => {
  it("returns Japanese by default", async () => {
    const items = await list();
    expect(items.map((b) => b.name)).toEqual(["若者応援給付", "ウェルカム給付", "シニア給付"]);
    expect(items.map((b) => b.description)).toEqual([
      "20歳以上の方に 500 JPYC を給付します。",
      "どなたでも 100 JPYC を受け取れます。",
      "65歳以上の方に 1000 JPYC を給付します。",
    ]);
    expect(items.every((b) => b.office === "デモ市 給付窓口")).toBe(true);
    expect(await list("?lang=ja")).toEqual(items);
    expect(await list("?lang=fr")).toEqual(items);
  });

  it("returns English names, descriptions and office for lang=en", async () => {
    const items = await list("?lang=en");
    expect(items.map((b) => b.name)).toEqual(["Youth Support Benefit", "Welcome Benefit", "Senior Benefit"]);
    expect(items.map((b) => b.description)).toEqual([
      "500 JPYC for residents aged 20 or over.",
      "100 JPYC for everyone.",
      "1,000 JPYC for residents aged 65 or over.",
    ]);
    expect(items.every((b) => b.office === "Demo City Benefit Office")).toBe(true);
  });

  it("keeps ids, amounts, requirements and status identical across languages", async () => {
    const ja = await list();
    const en = await list("?lang=en");
    expect(languageNeutral(en)).toEqual(languageNeutral(ja));
    expect(ja.map((b) => b.id)).toEqual(["youth-support-2026", "welcome-2026", "senior-2026"]);
    expect(ja.map((b) => b.amount)).toEqual(["500", "100", "1000"]);
    expect(ja.map((b) => b.chain_id)).toEqual(Array(3).fill(Number(env.CHAIN_ID)));
  });

  it("findBenefit still resolves the same ids", () => {
    for (const b of listBenefits(80002, "en")) {
      expect(findBenefit(b.id, 80002)?.amount).toBe(b.amount);
    }
  });
});
