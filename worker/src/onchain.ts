import { formatUnits, getAddress, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { benefitKey } from "./claim-hash";

const OFFICE_ABI = parseAbi([
  "function benefitAmount(bytes32 benefitId) view returns (uint256)",
  "function paid(bytes32 benefitId, address recipient) view returns (bool)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const JPYC_DECIMALS = 18;

/** What the chain says about one wallet and one benefit, read without any key. */
export type Eligibility = {
  chain_id: number;
  office_address: Address;
  token_address: Address;
  /** Benefit amount registered in the office, in JPYC. "0" when not registered. */
  amount: string;
  /** The office's JPYC balance. */
  office_balance: string;
  already_received: boolean;
  funded: boolean;
  claimable: boolean;
};

/** What the chain says about a payout transaction. */
export type PaymentCheck = {
  tx_hash: Hex;
  status: "success" | "reverted";
  block_number: string;
  /** The JPYC transfer from the office to the wallet in this transaction, if any. */
  transfer: { from: Address; to: Address; amount: string } | null;
  /** True only if the transaction succeeded and moved exactly the benefit amount from the office to the wallet. */
  confirmed: boolean;
};

export interface OnchainReader {
  eligibility(benefitId: string, wallet: Address): Promise<Eligibility>;
  isPaid(benefitId: string, wallet: Address): Promise<boolean>;
  checkPayment(txHash: Hex, benefitId: string, wallet: Address): Promise<PaymentCheck>;
}

export function onchainReader(client: PublicClient, chainId: number, office: Address, token: Address): OnchainReader {
  const amountOf = (benefitId: string) =>
    client.readContract({ address: office, abi: OFFICE_ABI, functionName: "benefitAmount", args: [benefitKey(benefitId)] });
  const isPaid = (benefitId: string, wallet: Address) =>
    client.readContract({ address: office, abi: OFFICE_ABI, functionName: "paid", args: [benefitKey(benefitId), wallet] });

  return {
    isPaid,

    async eligibility(benefitId, wallet) {
      const [amount, paid, balance] = await Promise.all([
        amountOf(benefitId),
        isPaid(benefitId, wallet),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [office] }),
      ]);
      const funded = amount > 0n && balance >= amount;
      return {
        chain_id: chainId,
        office_address: office,
        token_address: token,
        amount: formatUnits(amount, JPYC_DECIMALS),
        office_balance: formatUnits(balance, JPYC_DECIMALS),
        already_received: paid,
        funded,
        claimable: funded && !paid,
      };
    },

    async checkPayment(txHash, benefitId, wallet) {
      const [receipt, amount] = await Promise.all([client.getTransactionReceipt({ hash: txHash }), amountOf(benefitId)]);
      const transfers = parseEventLogs({ abi: ERC20_ABI, eventName: "Transfer", logs: receipt.logs }).filter(
        (log) =>
          getAddress(log.address) === getAddress(token)
          && getAddress(log.args.from) === getAddress(office)
          && getAddress(log.args.to) === getAddress(wallet),
      );
      const transfer = transfers[0];
      return {
        tx_hash: txHash,
        status: receipt.status,
        block_number: receipt.blockNumber.toString(),
        transfer: transfer
          ? {
              from: getAddress(transfer.args.from),
              to: getAddress(transfer.args.to),
              amount: formatUnits(transfer.args.value, JPYC_DECIMALS),
            }
          : null,
        confirmed: receipt.status === "success" && transfers.length === 1 && transfer.args.value === amount && amount > 0n,
      };
    },
  };
}
