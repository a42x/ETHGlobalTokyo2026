import { createPublicClient, http, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { onchainReader } from "../src/onchain";

// The test-card office on Polygon Amoy (contracts/deployments/amoy.json) and a payout
// the agent made through the Worker on 2026-09-26 (500 JPYC to a demo wallet).
const OFFICE = "0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2";
const JPYC = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const PAYOUT_TX = "0x8287b5fd955ab2ad4cd5e894595a9cfebdb4bd27e4bd873327bc46a8e8708d33";
const PAID_WALLET: Address = "0x2Bd1bc8bdaC984E595a0bdeFd692fE254f33328C";
const OTHER_WALLET: Address = "0x1111111111111111111111111111111111111111";

const reader = onchainReader(
  createPublicClient({ transport: http("https://polygon-amoy-bor-rpc.publicnode.com") }),
  80002,
  OFFICE,
  JPYC,
);

describe("onchainReader against the real Amoy office", () => {
  it("reads the registered amount, the office balance and the paid flag", async () => {
    const e = await reader.eligibility("youth-support-2026", OTHER_WALLET);
    expect(e).toMatchObject({ chain_id: 80002, amount: "500", already_received: false });
    expect(Number(e.office_balance)).toBeGreaterThanOrEqual(0);
    expect(e.claimable).toBe(e.funded);
  });

  it("reports an unregistered benefit as unfunded", async () => {
    const e = await reader.eligibility("not-registered", OTHER_WALLET);
    expect(e).toMatchObject({ amount: "0", funded: false, claimable: false });
  });

  it("confirms the payout transfer to the wallet it paid", async () => {
    const check = await reader.checkPayment(PAYOUT_TX, "youth-support-2026", PAID_WALLET);
    expect(check).toMatchObject({ status: "success", confirmed: true });
    expect(check.transfer).toMatchObject({ to: PAID_WALLET, amount: "500" });
    expect(BigInt(check.block_number)).toBeGreaterThan(0n);
  });

  it("does not confirm the same transaction for another wallet", async () => {
    const check = await reader.checkPayment(PAYOUT_TX, "youth-support-2026", OTHER_WALLET);
    expect(check).toMatchObject({ transfer: null, confirmed: false });
  });

  it("does not confirm it for a benefit with no registered amount", async () => {
    const check = await reader.checkPayment(PAYOUT_TX, "not-registered", PAID_WALLET);
    expect(check.confirmed).toBe(false);
  });
});
