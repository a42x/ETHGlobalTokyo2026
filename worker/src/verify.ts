import type { Hex } from "viem";

export type AgeCheck = {
  claimHash: Hex;
  nonce: Hex;
  expiresAt: number;
  proof: Hex;
  inputs: bigint[];
};

export interface Verifier {
  verifyClaimAge(check: AgeCheck): Promise<boolean>;
}

export const mockVerifier: Verifier = {
  verifyClaimAge: async () => true,
};
