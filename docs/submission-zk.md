# Submission notes: the ZK age proof and the contracts

This covers the zero-knowledge and on-chain part of the demo. The agent side (the mini app, the Worker and how they fit together) is in the [README](../README.md).

Status as of 2026-09-26 17:55 JST.

## Summary

A MynaWallet user proves "I am 20 or older" with their physical My Number card, without revealing their birth date. The iPhone reads the card over NFC and generates a Groth16 proof on the device. A benefit office contract on Polygon Amoy verifies the proof, binds it to this claim, and pays the benefit in JPYC to the user's wallet in the same transaction. Each benefit's amount is registered in the contract, and the demo benefit pays 500 JPYC. A second claim for the same benefit from the same wallet is refused.

## What we ran

With a real My Number card (issued under the production J-LIS roots) on an iPhone 16 Pro:

1. The MynaWallet development build read the card's signing certificate over NFC. The card signed a message containing the claim hash and a nonce issued by the benefit office.
2. The phone generated the proof locally. The birth date, the certificate and the card signature did not leave the device. (These runs came before the card-owner check described below.)
3. `BenefitOffice.claim()` on Amoy had `BenefitAgeGate` check the proof, then transferred 500 JPYC to the wallet in the same transaction.
4. A second claim for the same wallet was refused with `AlreadyPaid()`. The server that plays the benefit office simulates each claim before sending it, so no transaction was sent.

These runs used the first verifier, which accepted only the production signing policy. The claim transactions are on the pages of the offices of that time, [`0x91F11e24…2Bd0`](https://amoy.polygonscan.com/address/0x91F11e24Fd60c654814EEF71BFB9d267B61e2Bd0) and [`0xdD042C51…d104`](https://amoy.polygonscan.com/address/0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104).

With a JPKI-TEST card (the test environment that MynaWallet's development backend uses), on the current verifier:

1. Before proving, the app had MynaWallet's backend check the card with the JPKI service against the logged-in user's identity record.
   - A test card that did not belong to the wallet's owner was stopped at this step (`card_owner_mismatch`), before any proof was made.
   - The card that did belong to the owner passed.
   - For this check, the app sends the signing certificate and a separate card signature, made over the backend's own challenge, to MynaWallet's backend. The benefit office never receives them.
2. The phone proved the claim with the new proving key. `BenefitAgeGateJpkiTest` accepted it, and `BenefitOffice` paid 500 JPYC to the wallet ([transaction](https://amoy.polygonscan.com/tx/0x6c877a40f71bc08bccb8bb9da36d1fba25512501490d6fdd4661df22df761ec9)).
3. Later, a claim for the same wallet ran through the agent. The user asked the agent in the MynaWallet mini app for benefits. The agent called `search_benefits`, `create_claim` and `submit_proof`. The Worker checked the proof with the gate and sent `claim()` from its operator key, and the office paid 500 JPYC ([transaction](https://amoy.polygonscan.com/tx/0x8287b5fd955ab2ad4cd5e894595a9cfebdb4bd27e4bd873327bc46a8e8708d33), block 48581208).

We also replayed a recorded proof on an Amoy fork, with the clock set back to its validity window. That proof came from a real card, so it is not committed (no real-card data goes into this repository), and this table cannot be rerun from the repository. The repository's fork test (`contracts/test/BenefitAgeGateAmoyFork.t.sol`) checks the deployed verifier through the gates with the synthetic fixture instead.

| Input | Gate result |
| --- | --- |
| The proof as recorded | true |
| One bit of the proof flipped | false |
| The claim hash of another wallet | false |
| The gate for test cards (JPKI-TEST roots) | false |
| After `expiresAt` | false |

The full flow also ran with the same real card through the agent mini app and the Cloudflare Worker:

- The user asked the agent in the MynaWallet mini app to find benefits they could receive now.
- The agent called `search_benefits` and `create_claim`, and the phone generated the proof.
- The agent called `submit_proof`. The Worker checked the proof with the gate and sent `claim()` from its operator key, which pays 500 JPYC in the same transaction.

The earlier runs used a local test page and a local server in place of the agent and the Worker.

## How the proof works

The circuit is `jpki_age` from ZeroKeyMate, written in Noir before the hackathon. During the hackathon we changed only its signing-policy check, so that it also accepts JPKI-TEST cards ([`d24fafc`](https://github.com/susumutomita/ZeroKeyMate/commit/d24fafc97ac11c50e46ff240fb3d08ea82143a73)). It proves all of the following:

- The card's signing certificate is signed (RSA-2048, SHA-256) by a root key. The SHA-256 of that key's modulus is the public `rootKeyHash`.
- The certificate follows the J-LIS signing certificate profile. The signing policy may be the production one (1.2.392.200149.8.5.1.1.20) or the JPKI test environment's (1.2.392.200149.8.5.1.0.20); a test card showed that nothing else differs. The gate decides which environment it accepts by the root key it pins.
- The certificate is valid from `referenceTime` to `expiresAt`.
- The key in that certificate signed `"ZeroKeyMate age authentication v1\0" || claimHash || nonce` (98 bytes).
  - This is the card's own signature, made with the user's signing PIN.
- The birth date in the certificate makes the holder 20 or older at `referenceTime`, counted in Japan time.

There are 8 public inputs: `claimHash` (high and low 128 bits), `nonce` (high and low), `rootKeyHash` (high and low), `referenceTime` and `expiresAt`.

The proving system is ProveKit's Groth16 backend. The proof is 384 bytes. The prover runs natively on the iPhone as a Rust library, called from an Expo module in the MynaWallet app.

## On-chain verification

The contracts are on Polygon Amoy (chain id 80002). The source is in `contracts/` and `zk-age-verifier/`.

- **`ProvekitGroth16Verifier`**: generated from the verifying key. It checks only the pairing equation.
- **`BenefitAgeGate`**: its `verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs)` returns true only when all of the following hold.
  - The public inputs carry this `claimHash` and `nonce`.
  - The public inputs carry `referenceTime = expiresAt - 900`, and the current block time is inside that window.
  - `rootKeyHash` is one of the roots pinned in that gate (two J-LIS signing roots in `BenefitAgeGate`, four JPKI-TEST roots in `BenefitAgeGateJpkiTest`), and the claim window falls inside that root's validity period.
  - The Verifier's code hash equals the one fixed at deployment.
  - The Verifier accepts the proof.
- **`BenefitOffice`**: `claim()` recomputes `claimHash = keccak256(abi.encode(chainId, office, benefitId, recipient, amount, 20))` itself, so a proof made for one wallet or one benefit cannot be used for another. It then asks the gate, marks the recipient as paid, and transfers JPYC.

| Contract | Address |
| --- | --- |
| Groth16 Verifier | [`0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078`](https://amoy.polygonscan.com/address/0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078) |
| `BenefitAgeGate` (J-LIS roots) | [`0x44a0c9187cacfd2211d6e36e662b81e21950fdee`](https://amoy.polygonscan.com/address/0x44a0c9187cacfd2211d6e36e662b81e21950fdee) |
| `BenefitOffice` (real cards) | [`0x946105a8d563c70be8d6b8682047e9064878c885`](https://amoy.polygonscan.com/address/0x946105a8d563c70be8d6b8682047e9064878c885) |
| `BenefitAgeGateJpkiTest` (JPKI-TEST roots) | [`0x70bc454c84536f05934051ba7b7bb91e3c368588`](https://amoy.polygonscan.com/address/0x70bc454c84536f05934051ba7b7bb91e3c368588) |
| `BenefitOffice` (test cards; used by the Worker) | [`0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2`](https://amoy.polygonscan.com/address/0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2) |
| JPYC | [`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`](https://amoy.polygonscan.com/address/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29) |

We compared the deployed bytecode of `BenefitAgeGate`, `BenefitAgeGateTestRoot`, `BenefitAgeGateJpkiTest` and both `BenefitOffice`s with this repository's source at commit `1b6d87d`, with immutable values masked: all identical. The verifier's runtime code hash is recorded in `zk-age-verifier/deployments/amoy.json` and pinned by each gate. All deployments, including the gates for test cards, are in `contracts/deployments/amoy.json`.

## Measurements

These are single observations, not benchmarks.

| What | Value |
| --- | --- |
| Proving on an iPhone 16 Pro | about 12.4 s |
| Proof size | 384 bytes |
| Proving key / verifying key | 653 MiB / 13 MiB |
| Gas for one `claim()` (verify and pay) | 669,349 |
| Gas for proof verification alone | about 370,000 (fork estimate, including the base transaction cost) |

## Trust assumptions and known limitations

- **Single-party trusted setup.** The Groth16 setup was run once on one machine, not in a multi-party ceremony. Whoever held the setup randomness could forge proofs.
- **Unaudited.** ProveKit's Groth16 backend is an open experimental branch. The masking patch and the generated Solidity verifier are not audited.
- **No revocation check in the proof.** A revoked certificate still produces a valid proof. The app's owner check asks the JPKI service, which does check revocation, but that is not enforced on-chain.
- **What the proof does not show.** It does not show identity. It shows only that the holder of a card chaining to a root pinned in the gate, who signed this claim with that card, is 20 or older. It does not encrypt anything.
- **Once per wallet, not once per person.** The office records `paid[benefitId][recipient]`. The circuit has no nullifier, so the same card could claim again for a different wallet. MynaWallet issues one wallet per person, and before proving the app now has MynaWallet's backend confirm that the card belongs to the logged-in user (JPKI check against the identity record). That check runs in the app and the backend; the contract does not check it.
- **Operator and owner powers.** Only the office's operator can call `claim()`, and the operator pays the gas. The owner can withdraw the JPYC and change the operator (`setOperator`).
  - The owner can also clear a paid flag with `resetPaid`, which exists only for retaking the demo and must not be in a real office.
- **Scope.** iOS only, Polygon Amoy testnet only. The 653 MiB proving key is copied onto the phone by hand. The app does not download the key or check its hash.
- **Nonce reuse.** The office does not record nonces on chain. A challenge is single-use only in the Worker's database; on chain, the protection is the paid flag per wallet and the 15-minute window bound into the proof.
- **What becomes public on chain.** A claim's calldata includes `rootKeyHash`, which shows which root signed the card: a real J-LIS root or a test root, and roughly which issuing period. The `BenefitPaid` event shows publicly that this wallet was proven to be 20 or older.
- **Test gates.** The gates for JPKI-TEST cards and synthetic certificates accept proofs that say nothing about a real card. They are not wired to the real-card office.

## Attribution

- **ZeroKeyMate** ([susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate), Apache-2.0) provided three parts. The circuit used here also accepts the JPKI-TEST signing policy; that change is commit [`d24fafc`](https://github.com/susumutomita/ZeroKeyMate/commit/d24fafc97ac11c50e46ff240fb3d08ea82143a73) on the branch `eth/jpki-test-policy`.
  - the `jpki_age` circuit
  - the age-gate design, adapted here as `BenefitAgeGate`
  - the native prover runtime, from commit `0ea7aca`, `native/age-proof`
- **ProveKit** ([worldfnd/provekit](https://github.com/worldfnd/provekit), MIT): PR #447, revision `dd237e542403302186c8de4bd10df6e5c9b6725a`. The license is in `zk-age-verifier/PROVEKIT-LICENSE.md`.
  - The branch did not mask private witnesses. ZeroKeyMate's masking patch adds a per-proof random mask, following the method in [gnark advisory GHSA-9xcg-3q8v-7fq6](https://github.com/Consensys/gnark/security/advisories/GHSA-9xcg-3q8v-7fq6).
- **Noir libraries** (Apache-2.0): zkpassport/noir_rsa v0.11.0, noir-lang/noir-bignum v0.10.0, noir-lang/poseidon v0.3.0.
