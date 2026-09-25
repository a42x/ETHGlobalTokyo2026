import { bytesToHex, type Address, type Hex } from "viem";

export type PayoutRequest = {
  benefitId: string;
  recipient: Address;
  nonce: Hex;
  expiresAt: number;
  proof: Hex;
  inputs: bigint[];
};

export interface Payout {
  send(req: PayoutRequest): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<"success" | "reverted">;
}

export const mockPayout: Payout = {
  send: async () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  waitForReceipt: async () => "success",
};
