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

type Inputs8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

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
