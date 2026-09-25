import { describe, expect, it } from "vitest";
import { CLAIM_DURATION, publicInputs } from "../src/claim-hash";

// ZeroKeyMate services/shop/src/age.mjs ageArguments (Apache-2.0), kept verbatim as the
// reference the gate's input checks were written against.
function ageArguments(order: {
  orderHash: string;
  paymentNonce: string;
  ageRootKeyHash: string;
  createdAt: number;
  expiresAt: number;
}) {
  const split = (value: string) => [BigInt("0x" + value.slice(2, 34)), BigInt("0x" + value.slice(34))];
  return [
    ...split(order.orderHash),
    ...split(order.paymentNonce),
    ...split(order.ageRootKeyHash),
    BigInt(order.createdAt),
    BigInt(order.expiresAt),
  ];
}

describe("publicInputs", () => {
  it("matches ZeroKeyMate ageArguments", () => {
    const claimHash = "0x0123456789abcdef0123456789abcdeffedcba9876543210fedcba9876543210" as const;
    const nonce = "0xffffffffffffffffffffffffffffffff00000000000000000000000000000001" as const;
    const rootKeyHash = "0xa5fad04a2d6cbb52ce03a55106a6e23be4fa4a771bb0bf81401833afc410b15e" as const;
    const referenceTime = 1_790_000_000;
    const expiresAt = referenceTime + CLAIM_DURATION;

    expect(publicInputs({ claimHash, nonce, rootKeyHash, referenceTime, expiresAt })).toEqual(
      ageArguments({ orderHash: claimHash, paymentNonce: nonce, ageRootKeyHash: rootKeyHash, createdAt: referenceTime, expiresAt }),
    );
  });
});
