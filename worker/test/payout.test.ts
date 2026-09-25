import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  keccak256,
  parseAbi,
  parseTransaction,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { benefitKey } from "../src/claim-hash";
import { AlreadyPaidError, benefitOfficePayout, type PayoutRequest } from "../src/payout";

// Anvil's public test account #0. It holds nothing on Amoy.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OFFICE = "0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104";
const CLAIM_ABI = parseAbi([
  "function claim(bytes32 benefitId, address recipient, bytes32 nonce, uint256 expiresAt, bytes proof, uint256[8] inputs) external",
]);

const req: PayoutRequest = {
  benefitId: "youth-support-2026",
  recipient: "0x1111111111111111111111111111111111111111",
  nonce: `0x${"22".repeat(32)}`,
  expiresAt: 1_790_000_900,
  proof: `0x${"ab".repeat(384)}`,
  inputs: [1n, 2n, 3n, 4n, 5n, 6n, 1_790_000_000n, 1_790_000_900n],
};

// A fake Amoy node: eth_call either succeeds or reverts with `revertData`.
function fakeNode(revertData?: Hex) {
  const methods: string[] = [];
  const sent: Hex[] = [];
  const transport = custom({
    async request({ method, params }) {
      methods.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x13882";
        case "eth_call":
          if (revertData) throw Object.assign(new Error("execution reverted"), { code: 3, data: revertData });
          return "0x";
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_getBlockByNumber":
          return { number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x0", transactions: [] };
        case "eth_maxPriorityFeePerGas":
          return "0x6fc23ac00";
        case "eth_sendRawTransaction":
          sent.push(params[0]);
          return keccak256(params[0]);
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  const chain = defineChain({
    id: 80002,
    name: "amoy",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
  const payout = benefitOfficePayout(
    createPublicClient({ chain, transport }),
    createWalletClient({ account: privateKeyToAccount(TEST_KEY), chain, transport }),
    OFFICE,
  );
  return { payout, methods, sent };
}

describe("benefitOfficePayout", () => {
  it("sends claim() to the office on Amoy after a successful simulation", async () => {
    const { payout, methods, sent } = fakeNode();
    const hash = await payout.send(req);

    expect(methods.indexOf("eth_call")).toBeLessThan(methods.indexOf("eth_sendRawTransaction"));
    expect(sent).toHaveLength(1);
    expect(hash).toBe(keccak256(sent[0]));
    const tx = parseTransaction(sent[0]);
    expect(tx.chainId).toBe(80002);
    expect(tx.to?.toLowerCase()).toBe(OFFICE.toLowerCase());
    const { functionName, args } = decodeFunctionData({ abi: CLAIM_ABI, data: tx.data! });
    expect(functionName).toBe("claim");
    expect(args).toEqual([
      benefitKey("youth-support-2026"),
      req.recipient,
      req.nonce,
      BigInt(req.expiresAt),
      req.proof,
      req.inputs,
    ]);
  });

  it("throws AlreadyPaidError and sends nothing when the office reports AlreadyPaid", async () => {
    const { payout, sent } = fakeNode("0xd70a0e30");
    await expect(payout.send(req)).rejects.toBeInstanceOf(AlreadyPaidError);
    expect(sent).toHaveLength(0);
  });

  it("rethrows other reverts without sending", async () => {
    // ProofRejected()
    const { payout, sent } = fakeNode("0xc3b0d8cd");
    const err = await payout.send(req).catch((e) => e);
    expect(err).not.toBeInstanceOf(AlreadyPaidError);
    expect(err).toBeInstanceOf(Error);
    expect(sent).toHaveLength(0);
  });
});
