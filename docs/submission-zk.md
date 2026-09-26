# Submission notes: the ZK age proof and the contracts

This covers the zero-knowledge and on-chain part of the demo. The agent mini app and its conversation are described separately.

Status as of 2026-09-26 09:30 JST. Update the "What we ran" section before submitting if the agent path has been run end to end.

## Summary

A MynaWallet user proves "I am 20 or older" with their physical My Number card, without revealing their birth date. The iPhone reads the card over NFC and generates a Groth16 proof on the device. A benefit office contract on Polygon Amoy verifies the proof, binds it to this claim, and pays 500 JPYC to the user's wallet in the same transaction. A second claim from the same wallet is refused.

## What we ran

With a real My Number card (issued under the production J-LIS roots) on an iPhone 16 Pro:

1. The MynaWallet development build read the card's signing certificate over NFC. The card signed a message containing the claim hash and a nonce issued by the benefit office.
2. The phone generated the proof locally. The birth date, the certificate and the card signature did not leave the device.
3. `BenefitOffice.claim()` on Amoy had `BenefitAgeGate` check the proof, then transferred 500 JPYC to the wallet in the same transaction.
4. A second claim for the same wallet was refused with `AlreadyPaid()`. The server that plays the benefit office simulates each claim before sending it, so no transaction was sent.

The claim transactions are listed on the `BenefitOffice` page on Polygonscan (address below).

We also replayed a recorded proof on an Amoy fork, with the clock set back to its validity window:

| Input | Gate result |
| --- | --- |
| The proof as recorded | true |
| One bit of the proof flipped | false |
| The claim hash of another wallet | false |
| The gate for test cards (JPKI-TEST roots) | false |
| After `expiresAt` | false |

These runs were driven by a local test page and a local server that played the benefit office. The same flow through the agent mini app and the Cloudflare Worker was tested on an Amoy fork only: the gate was replaced with a stub, and the fork used a test operator key.

## How the proof works

The circuit is `jpki_age` from ZeroKeyMate, written in Noir. It proves all of the following:

- The card's signing certificate is signed (RSA-2048, SHA-256) by a root key. The SHA-256 of that key's modulus is the public `rootKeyHash`.
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
  - `rootKeyHash` is one of the two pinned J-LIS signing roots, and the claim window falls inside that root's validity period.
  - The Verifier's code hash equals the one fixed at deployment.
  - The Verifier accepts the proof.
- **`BenefitOffice`**: `claim()` recomputes `claimHash = keccak256(abi.encode(chainId, office, benefitId, recipient, amount, 20))` itself, so a proof made for one wallet or one benefit cannot be used for another. It then asks the gate, marks the recipient as paid, and transfers JPYC.

| Contract | Address |
| --- | --- |
| Groth16 Verifier | [`0xb89d8e0c4a345ead852ab919548734c4f506596c`](https://amoy.polygonscan.com/address/0xb89d8e0c4a345ead852ab919548734c4f506596c) |
| `BenefitAgeGate` (J-LIS roots) | [`0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803`](https://amoy.polygonscan.com/address/0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803) |
| `BenefitOffice` (real cards) | [`0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104`](https://amoy.polygonscan.com/address/0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104) |
| JPYC | [`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`](https://amoy.polygonscan.com/address/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29) |

We checked that the deployed `BenefitOffice` and `BenefitAgeGate` bytecode matches this repository's source at the deploy commits. All deployments, including the gates for test cards, are in `contracts/deployments/amoy.json`.

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
- **No revocation check.** A revoked certificate still produces a valid proof.
- **What the proof does not show.** It does not show identity. It shows only that the holder of a card chaining to a pinned J-LIS root, who signed this claim with that card, is 20 or older. It does not encrypt anything.
- **Once per wallet, not once per person.** The office records `paid[benefitId][recipient]`. The circuit has no nullifier, so the same card could claim again for a different wallet. MynaWallet issues one wallet per card, but the contract does not check this.
- **Operator and owner powers.** Only the office's operator can call `claim()`, and the operator pays the gas. The owner can withdraw the JPYC.
  - The owner can also clear a paid flag with `resetPaid`, which exists only for retaking the demo and must not be in a real office.
- **Scope.** iOS only, Polygon Amoy testnet only. The 653 MiB proving key is copied onto the phone by hand. The app does not download the key or check its hash.
- **Test gates.** The gates for JPKI-TEST cards and synthetic certificates accept proofs that say nothing about a real card. They are not wired to the real-card office.

## Attribution

- **ZeroKeyMate** ([susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate), Apache-2.0) provided three parts:
  - the `jpki_age` circuit
  - the age-gate design, adapted here as `BenefitAgeGate`
  - the native prover runtime, from commit `0ea7aca`, `native/age-proof`
- **ProveKit** ([worldfnd/provekit](https://github.com/worldfnd/provekit), MIT): PR #447, revision `dd237e542403302186c8de4bd10df6e5c9b6725a`. The license is in `zk-age-verifier/PROVEKIT-LICENSE.md`.
  - The branch did not mask private witnesses. ZeroKeyMate's masking patch adds a per-proof random mask, following the method in [gnark advisory GHSA-9xcg-3q8v-7fq6](https://github.com/Consensys/gnark/security/advisories/GHSA-9xcg-3q8v-7fq6).
- **Noir libraries** (Apache-2.0): zkpassport/noir_rsa v0.11.0, noir-lang/noir-bignum v0.10.0, noir-lang/poseidon v0.3.0.
