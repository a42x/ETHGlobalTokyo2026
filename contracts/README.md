# contracts

The contracts for the benefit demo (Foundry, Polygon Amoy).

- `src/BenefitAgeGate.sol`: the gate that binds an age proof to a claim and verifies it (#5).
- `src/BenefitOffice.sol`: pays JPYC only when the gate accepts the proof (#6).

## Deployed addresses (Polygon Amoy, 80002)

| Contract | Address |
| --- | --- |
| `BenefitAgeGate` (J-LIS) | [`0x44a0c9187cacfd2211d6e36e662b81e21950fdee`](https://amoy.polygonscan.com/address/0x44a0c9187cacfd2211d6e36e662b81e21950fdee) |
| `BenefitAgeGateTestRoot` (synthetic root) | [`0x5cc9a5b5779e81fedb1bb8ecceb94aa553f254a6`](https://amoy.polygonscan.com/address/0x5cc9a5b5779e81fedb1bb8ecceb94aa553f254a6) |
| `BenefitAgeGateJpkiTest` (test J-LIS roots, test cards) | [`0x70bc454c84536f05934051ba7b7bb91e3c368588`](https://amoy.polygonscan.com/address/0x70bc454c84536f05934051ba7b7bb91e3c368588) |
| `BenefitOffice` (uses the J-LIS gate) | [`0x946105a8d563c70be8d6b8682047e9064878c885`](https://amoy.polygonscan.com/address/0x946105a8d563c70be8d6b8682047e9064878c885) |
| `BenefitOffice` (uses the test-card gate; the Worker uses this one) | [`0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2`](https://amoy.polygonscan.com/address/0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2) |

Every gate points at Verifier v2 `0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078`. The v2 circuit accepts both the production (1.2.392.200149.8.5.1.1.20) and the test (1.2.392.200149.8.5.1.0.20) signing policies. The root key each gate pins decides whether it accepts production or test cards.

Both `BenefitOffice`s have `youth-support-2026` (500 JPYC) registered. We funded the J-LIS office with 2,500 JPYC and the test-card office with 5,000 JPYC.
- The operator is the Worker's EOA `0x71B5…17B3`, which can only call `claim()`.
- The owner is the deploying address.
- The records are in [deployments/amoy.json](deployments/amoy.json).

We retired these contracts and withdrew their JPYC (listed under `deprecated` in `deployments/amoy.json`):
- the gates and offices that used the previous verifier (`0xb89d8e0c…596c`, production policy only);
- the first office, which had no `resetPaid`.

## Gate

`verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs)` returns `true` only when all of the following hold:

- The order-hash slots of the public inputs match `claimHash`. The caller computes `claimHash` itself and passes it in.
- The nonce and expiry in the public inputs match the arguments, and the reference time is `expiresAt - 900`.
- The current time is at or after the reference time and before `expiresAt`.
- The signing root key is allowed.
- The deployed verifier (`zk-age-verifier/`) accepts the proof. The verifier's code hash is fixed in the constructor.

There are three gates:

| Contract | Roots it accepts | Use |
| --- | --- | --- |
| `BenefitAgeGate` | The two production J-LIS roots (same as ZeroKeyMate's `MateAgeGate`) | Real cards |
| `BenefitAgeGateTestRoot` | One root chosen at deployment | Demo only. Synthetic fixtures |
| `BenefitAgeGateJpkiTest` | Four test J-LIS signing roots (`sig_ca_8`, `sig_ca_1`, `sig_ca_14` and `sig_ca_10` from `certificates/development` in `a42x/jpki-api`) | Demo only. Test cards in MynaWallet's development environment |

A proof accepted by `BenefitAgeGateTestRoot` or `BenefitAgeGateJpkiTest` says nothing about a real My Number Card.

The logic comes from ZeroKeyMate's `contracts/src/MateAgeGate.sol` (Apache-2.0). We changed three things:
- the chain ids (80002 and 31337);
- the function names;
- a test-root variant, which we added.

## BenefitOffice

Only the operator (the benefit office Worker) can call `claim(benefitId, recipient, nonce, expiresAt, proof, inputs)`.
It checks the following, in order, before paying:

1. The benefit is registered.
2. The recipient is not the zero address.
3. The recipient has not received this benefit yet (`paid[benefitId][recipient]`).
4. The office computes `claimHashOf(benefitId, recipient)` itself, and the gate's `verifyClaimAge` accepts the proof for it.
5. The office marks the recipient as paid, then transfers JPYC.

`resetPaid(benefitId, recipient)` clears the paid flag so the demo can be filmed again. Only the owner can call it.
It lets the owner pay the same recipient again, so a real benefit office must not have it.

```sh
cast send 0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2 'resetPaid(bytes32,address)' \
  "$(cast keccak youth-support-2026)" 0x… --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --priority-gas-price 30gwei
```

`claimHash` is `keccak256(abi.encode(chainid, office, benefitId, recipient, amount, 20))`.
A test checks that it matches the Worker's `worker/src/claim-hash.ts`.
The proof is bound to this `claimHash`, so it cannot be reused for another recipient or another benefit.

`registerBenefit` accepts only `minAge == 20`, because the circuit is fixed at 20.
The gate is fixed in the constructor. To change the gate, deploy a new `BenefitOffice` too.

```sh
BENEFIT_AGE_GATE=0x… BENEFIT_OPERATOR=0x… BENEFIT_FUNDING=5000000000000000000000 \
  forge script script/DeployBenefitOffice.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --broadcast --priority-gas-price 30gwei --gas-estimate-multiplier 150
```

Forge's gas estimate is sometimes too low for the JPYC transfer, so `--gas-estimate-multiplier` adds headroom.
Without `BENEFIT_OPERATOR`, the deploying address becomes the operator. The owner can change it later with `setOperator`.
`BENEFIT_FUNDING` is the amount of JPYC (in wei) sent from the deploying address.

## Caveats

- A tampered proof makes the verifier's pairing check fail and use up all the gas it was given. The gate returns `false`, but before sending `BenefitOffice.claim()`, run an `eth_call` with the same arguments and make sure it succeeds.
- The trust assumptions are the same as in `zk-age-verifier/README.md`. The setup was run by a single party, nothing is audited, and certificate revocation is not checked.

## Usage

```sh
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge test
AMOY_RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com forge test --match-contract AmoyFork
```

The second test forks Amoy and calls the deployed verifier through the gates.
The synthetic fixture's reference time is in 2027, so the test moves the fork's clock forward.

Deploy with a disposable key used only on the testnet.

```sh
forge script script/DeployGates.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --broadcast --priority-gas-price 30gwei
```
