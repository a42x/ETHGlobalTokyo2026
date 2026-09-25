import type { Hex } from "viem";

export type AgeCheck = {
  claimHash: Hex;
  nonce: Hex;
  expiresAt: number;
  proof: Hex;
  inputs: bigint[];
};

// BenefitAgeGate.verifyClaimAge via eth_call. The on-chain version replaces the mock
// once the gate is deployed on Amoy.
export interface Verifier {
  verifyClaimAge(check: AgeCheck): Promise<boolean>;
}

export const mockVerifier: Verifier = {
  verifyClaimAge: async () => true,
};
