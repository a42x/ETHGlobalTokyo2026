import { createApp } from "./app";
import { mockPayout } from "./payout";
import { mockVerifier } from "./verify";

export default createApp({
  verifier: mockVerifier,
  payout: mockPayout,
  now: () => Math.floor(Date.now() / 1000),
  receiptWaitMs: 8000,
});
