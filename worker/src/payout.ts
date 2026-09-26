import {
  BaseError,
  bytesToHex,
  ContractFunctionRevertedError,
  parseAbi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { benefitKey } from "./claim-hash";
import type { Inputs8 } from "./verify";

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

// The office has already paid this benefit to this recipient.
export class AlreadyPaidError extends Error {}

export const mockPayout: Payout = {
  send: async () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  waitForReceipt: async () => "success",
};

const OFFICE_ABI = parseAbi([
  "function claim(bytes32 benefitId, address recipient, bytes32 nonce, uint256 expiresAt, bytes proof, uint256[8] inputs) external",
  "error NotOperator()",
  "error UnknownBenefit()",
  "error ZeroAddress()",
  "error AlreadyPaid()",
  "error ProofRejected()",
  "error TransferFailed()",
]);

// A verified claim used 669,349 gas on Amoy.
const CLAIM_GAS = 1_000_000n;

export function benefitOfficePayout(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  office: Address,
): Payout {
  return {
    async send(req) {
      const args = [
        benefitKey(req.benefitId),
        req.recipient,
        req.nonce,
        BigInt(req.expiresAt),
        req.proof,
        req.inputs as unknown as Inputs8,
      ] as const;
      // Simulate first so a claim that would revert is never sent.
      try {
        await publicClient.simulateContract({
          account: walletClient.account,
          address: office,
          abi: OFFICE_ABI,
          functionName: "claim",
          args,
        });
      } catch (err) {
        const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
        if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "AlreadyPaid") {
          throw new AlreadyPaidError("the recipient has already received this benefit");
        }
        throw err;
      }
      return walletClient.writeContract({
        address: office,
        abi: OFFICE_ABI,
        functionName: "claim",
        args,
        gas: CLAIM_GAS,
      });
    },
    async waitForReceipt(txHash) {
      return (await publicClient.waitForTransactionReceipt({ hash: txHash })).status;
    },
  };
}

// Without an office and an operator key nothing is paid, and the claim fails.
export function unconfiguredPayout(missing: string): Payout {
  const fail = async (): Promise<never> => {
    throw new Error(`payout is not configured: ${missing}`);
  };
  return { send: fail, waitForReceipt: fail };
}
