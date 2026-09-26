import {
  BaseError,
  bytesToHex,
  ContractFunctionRevertedError,
  InsufficientFundsError,
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

export type PayoutFailureCode = "OPERATOR_FUNDS_LOW" | "OFFICE_FUNDS_LOW" | "PAYOUT_MISCONFIGURED" | "PAYOUT_FAILED";

/** A payout that could not be sent, with a code the mini app and the agent can explain. */
export class PayoutError extends Error {
  constructor(
    readonly code: PayoutFailureCode,
    message: string,
  ) {
    super(message);
  }
}

const shortReason = (err: unknown): string =>
  (err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Maps a reverted claim() simulation to a failure the caller can act on. */
function simulationFailure(err: unknown): Error {
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
  switch (name) {
    case "AlreadyPaid":
      return new AlreadyPaidError("the recipient has already received this benefit");
    case "TransferFailed":
      return new PayoutError("OFFICE_FUNDS_LOW", "The benefit office does not have enough JPYC to pay this benefit");
    case "NotOperator":
    case "UnknownBenefit":
    case "ZeroAddress":
      return new PayoutError("PAYOUT_MISCONFIGURED", `The benefit office is not set up for this payout (${name})`);
    default:
      return new PayoutError("PAYOUT_FAILED", `The payout would fail on chain: ${name ?? shortReason(err)}`);
  }
}

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
        throw simulationFailure(err);
      }
      try {
        return await walletClient.writeContract({
          address: office,
          abi: OFFICE_ABI,
          functionName: "claim",
          args,
          gas: CLAIM_GAS,
        });
      } catch (err) {
        // The node reserves gas limit x max fee up front, so a nearly empty operator fails here.
        if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) {
          throw new PayoutError(
            "OPERATOR_FUNDS_LOW",
            "The benefit office's operator does not have enough POL to pay the network fee",
          );
        }
        throw new PayoutError("PAYOUT_FAILED", `The payout transaction could not be sent: ${shortReason(err)}`);
      }
    },
    async waitForReceipt(txHash) {
      return (await publicClient.waitForTransactionReceipt({ hash: txHash })).status;
    },
  };
}

// Without an office and an operator key nothing is paid, and the claim fails.
export function unconfiguredPayout(missing: string): Payout {
  const fail = async (): Promise<never> => {
    throw new PayoutError("PAYOUT_MISCONFIGURED", `The payout is not configured: ${missing}`);
  };
  return { send: fail, waitForReceipt: fail };
}
