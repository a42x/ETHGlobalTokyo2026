import { BaseError, ContractFunctionRevertedError, parseAbi, type Address, type Hex, type PublicClient } from "viem";

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

const VERIFIER_ABI = parseAbi([
  "function verifyProof(bytes calldata proof, uint256[8] calldata inputs) external view",
]);

const GATE_ABI = parseAbi([
  "function verifyClaimAge(bytes32 claimHash, bytes32 nonce, uint256 expiresAt, bytes proof, uint256[8] inputs) external view returns (bool)",
]);

export type Inputs8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

// BenefitAgeGate also checks the claim binding, the time window and the root key.
// It returns false for a rejected proof, so a revert here is a fault, not a verdict.
export function gateVerifier(client: PublicClient, address: Address, blockOverrides?: { time: bigint }): Verifier {
  return {
    verifyClaimAge: (check) =>
      client.readContract({
        address,
        abi: GATE_ABI,
        functionName: "verifyClaimAge",
        args: [check.claimHash, check.nonce, BigInt(check.expiresAt), check.proof, check.inputs as unknown as Inputs8],
        blockOverrides,
      }),
  };
}

export function groth16Verifier(client: PublicClient, address: Address): Verifier {
  return {
    async verifyClaimAge(check) {
      try {
        await client.readContract({
          address,
          abi: VERIFIER_ABI,
          functionName: "verifyProof",
          args: [check.proof, check.inputs as unknown as Inputs8],
        });
        return true;
      } catch (err) {
        // A rejected proof reverts; anything else (bad RPC, timeout) is not a verdict.
        if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) {
          return false;
        }
        throw err;
      }
    },
  };
}
