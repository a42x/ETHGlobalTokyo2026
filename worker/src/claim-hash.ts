import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";

export const GATE_ORDER_DURATION = 900;

export const GATE_MIN_AGE = 20;

const U128_MASK = (1n << 128n) - 1n;

export function benefitKey(benefitId: string): Hex {
  return keccak256(toBytes(benefitId));
}

export function computeClaimHash(p: {
  chainId: number;
  office: Address;
  benefitId: string;
  recipient: Address;
  amountWei: bigint;
  minAge: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [BigInt(p.chainId), p.office, benefitKey(p.benefitId), p.recipient, p.amountWei, BigInt(p.minAge)],
    ),
  );
}

function split(value: Hex): [bigint, bigint] {
  const n = BigInt(value);
  return [n >> 128n, n & U128_MASK];
}

export function publicInputs(p: {
  claimHash: Hex;
  nonce: Hex;
  rootKeyHash: Hex;
  referenceTime: number;
  expiresAt: number;
}): bigint[] {
  return [
    ...split(p.claimHash),
    ...split(p.nonce),
    ...split(p.rootKeyHash),
    BigInt(p.referenceTime),
    BigInt(p.expiresAt),
  ];
}
