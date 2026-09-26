# zk-age-verifier

The contract that verifies, on Polygon Amoy (chain id 80002), a Groth16 proof that a My Number Card (JPKI) holder is 20 or older.
It is for the ETHGlobal Tokyo 2026 benefit demo and is testnet only.

This directory covers only the verifier. The gate that binds a proof to a benefit claim is in `contracts/`.

## Deployed address

| Chain | Verifier |
| --- | --- |
| Polygon Amoy (80002) | [`0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078`](https://amoy.polygonscan.com/address/0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078) |

The deployment record is in [deployments/amoy.json](deployments/amoy.json).

On 2026-09-26 we rebuilt the circuit so that it can also prove test cards (JPKI-TEST). This is v2.
- A test card's signing certificate differs from a production one only in the certificate policy OID (production 1.2.392.200149.8.5.1.**1**.20, test 1.2.392.200149.8.5.1.**0**.20). The v2 circuit accepts both.
- As before, the root key each gate pins decides whether a proof counts as production or test. The production J-LIS gate does not accept the test roots.
- The record of the previous verifier, `0xb89d8e0c…596c`, is in [deployments/amoy-v1.json](deployments/amoy-v1.json).

## Usage

You need Node 22 or later and `anvil` from [Foundry](https://getfoundry.sh/).

```sh
npm ci
npm test                # deploys to a local anvil (chain id 80002) with a disposable key and verifies
npm run verify:dry-run  # verifies against a real Amoy node with a state override; deploys nothing
```

To deploy to Amoy, fund a disposable, testnet-only key with POL from a faucet. The deployment uses about 1.31 million gas (1,314,611 for v2, recorded in `deployments/amoy.json`).
The key is read only from an environment variable and is never written to a file.

```sh
AMOY_DEPLOYER_PRIVATE_KEY=0x… npm run deploy   # records to deployments/amoy.json; refuses to deploy twice if a record exists
npm run verify                                  # verifies at the recorded address
```

Amoy's suggested priority fee can be much higher than what actually gets included.
Set, for example, `AMOY_PRIORITY_FEE_GWEI=30` to deploy with that value.

The default RPC is `https://polygon-amoy-bor-rpc.publicnode.com`; override it with `AMOY_RPC_URL`.
`--dry-run` needs an RPC that supports state overrides in `eth_call`.

## What the scripts check

Each command checks all of the following:

- Two valid synthetic proofs (from the same witness, with different randomness) pass.
- A proof with one byte changed is rejected.
- All 8 variants, each changing one of the 8 public inputs, are rejected.
- The deployed code matches the compiler output (`test`, `deploy`, `verify`).

Only a revert counts as a rejection. A network error stops the run as a failure.

## The verifier function

```solidity
function verifyProof(bytes calldata proof, uint256[8] calldata inputs) external view;
```

It returns nothing when the proof is valid and reverts when it is not. `proof` is 384 bytes.
The public inputs are in the same order as in ZeroKeyMate's `jpki_age` circuit.

| Index | Content |
| --- | --- |
| 0, 1 | Order (claim) hash, high and low 128 bits |
| 2, 3 | Nonce, high and low 128 bits |
| 4, 5 | SHA-256 of the signing root key, high and low 128 bits |
| 6 | Reference time (unix seconds) |
| 7 | Expiry (unix seconds) |

The verifier checks only that the proof and the public inputs are consistent.
It does not check that the root key is a real J-LIS root, that the hash matches a claim, or that the proof is within its window. That is the gate's job.

## Trust assumptions

- **Single-party trusted setup.** The setup was run once on one machine, not in a multi-party ceremony.
  Whoever held the setup randomness could forge proofs.
- **Unaudited.** ProveKit's Groth16 backend and the Solidity verifier are experimental upstream and have not been audited.
- **No revocation check.** Certificate revocation is not checked.
- **No identity.** A proof shows only that the holder of a card whose certificate meets the J-LIS signing certificate profile is 20 or older.
- **Synthetic fixtures.** The proofs in `fixtures/synthetic/` were made from public synthetic certificates and contain no real card data.
  Do not add proofs made with a real card, or any data read from a card, to this repository.

## Sources

- The circuit, the setup and the way the verifier is built come from [susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate) (Apache-2.0).
- `contracts/Verifier.sol` was generated with `export-solidity` from [worldfnd/provekit](https://github.com/worldfnd/provekit) at revision `dd237e542403302186c8de4bd10df6e5c9b6725a`, under the MIT license ([PROVEKIT-LICENSE.md](PROVEKIT-LICENSE.md)).
  - It was generated with ZeroKeyMate's masking patch `provekit-groth16-hiding.patch` (SHA-256 `6ea38e8eec3f7631955794d164fcf97052c14652e641119735d066dda8b92db5`) applied.
  - A memory-bounds fix (`scripts/patch-age-verifier.py`) is also applied.
  - The circuit is from ZeroKeyMate's branch [`eth/jpki-test-policy`](https://github.com/susumutomita/ZeroKeyMate/tree/eth/jpki-test-policy) (commit [`d24fafc`](https://github.com/susumutomita/ZeroKeyMate/commit/d24fafc97ac11c50e46ff240fb3d08ea82143a73)), which changes only the policy check in `certificate.nr`. The pins on main (`config/age-runtime-pins.json`) are unchanged.
  - The verifying key is `age.pkv` (SHA-256 `07e6a671d3b5dfce8b28a3e1b1c3dbd465310cb3a7996ef6f97cf8f8b1c62cd2`), and the proving key is `age.pkp` (SHA-256 `71294569bfc1f0492128fa320dcd7bb97a292bd8e81940ea5de6bb16b99b3931`). The keys are not in this repository.
- The SHA-256 of `contracts/Verifier.sol` is `ef5e19327f05f19a839a2f2f1e5676a3d275051b233e856f35cb3770ededf8fe`.
  `scripts/lib.mjs` checks this value before compiling.
- The compiler is solc 0.8.30 with optimizer 200, viaIR and EVM version cancun.
