# Myna Agent

<!-- The project name is still being decided (a42x/pm#76). Change it here and in the summary below. -->

**An AI agent in MynaWallet that finds government benefits you can receive and claims them for you, proving with your My Number Card that you are 20 or older without revealing your birth date, and receiving the payout in JPYC after the proof is verified on-chain.**

This repository holds the hackathon code for ETHGlobal Tokyo 2026: the benefit office contracts, the Groth16 verifier, and the Cloudflare Worker that serves the agent and the benefit office API.

## What it does

1. In the MynaWallet app, the user opens the agent mini app and asks: "Find benefits I can receive now."
2. The agent (Claude, through tools) searches a demo benefit office and finds a benefit that requires the recipient to be 20 or older.
3. The agent explains what will be proven and asks for consent. The user agrees.
4. The agent creates a claim. The benefit office issues a challenge bound to this benefit, this wallet and this office.
5. MynaWallet reads the user's physical My Number Card over NFC. The card signs the challenge after the user enters their signing PIN. The phone then generates a zero-knowledge proof of "20 or older" locally. The birth date, the certificate and the card signature never leave the phone.
6. The agent submits the proof. The benefit office contract on Polygon Amoy verifies it and pays 500 JPYC to the user's wallet in the same transaction.
7. A second claim from the same wallet is refused by the contract.

Japan's government plans to let people use AI agents with the My Number Card, connecting AI to administrative systems (priority plan approved by the Cabinet on 2026-07-21, [CNET Japan](https://japan.cnet.com/article/35250805/)). This demo shows what such an agent can do while disclosing only what the office needs.

## How the agent acts on-chain

```
MynaWallet app (iPhone, development build)
  agent mini app (WebView) ── tools ──> Worker  POST /agent/v1/messages   (Claude, system prompt and tools fixed on the server)
        │                          └──> Worker  /benefit-office/v1/*       (benefits, claims, proof)
        │ Myna.jpki.prove                          │
        v                                          v
  wallet: NFC + on-device Groth16 prover     eth_call BenefitAgeGate.verifyClaimAge
                                             operator sends BenefitOffice.claim()  ──> Polygon Amoy
                                                verify the proof + transfer JPYC in one transaction
```

- **Reading chain state.** Before paying, the Worker asks `BenefitAgeGate` on Amoy, with `eth_call`, whether the proof is valid for this claim. It then simulates `claim()` and does not send it if it would revert, for example with `AlreadyPaid()`.
- **Acting on-chain.** The agent's `submit_proof` tool makes the Worker send `BenefitOffice.claim()` from an operator key. That key can only call `claim()`. The contract checks everything again and pays in the same transaction.
- **Staying within policy.** The agent never sees the proof or any personal data; the mini app passes the proof straight to the office. The wallet asks the user for consent before reading the card. The contract, not the agent, decides whether to pay:
  - Each wallet can be paid once.
  - The proof must be bound to this claim.
  - The proof must be inside its 15-minute window.
  - The certificate must chain to a pinned J-LIS root.

Details of the proof and the contracts, including measurements and trust assumptions: [docs/submission-zk.md](docs/submission-zk.md).

## Components

| Part | Where | What |
| --- | --- | --- |
| Contracts | [`contracts/`](contracts/) | `BenefitAgeGate` (binds the proof to the claim, checks time and root key) and `BenefitOffice` (verifies through the gate, pays JPYC once per wallet). Foundry. |
| Verifier | [`zk-age-verifier/`](zk-age-verifier/) | Groth16 verifier generated from the age circuit's verifying key, with deployment and verification scripts. |
| Worker | [`worker/`](worker/) | Cloudflare Worker (Hono, viem, D1). Benefit office API, the proof check and payout, and the LLM proxy for the agent. |
| Agent mini app | a42x/miniapp-playground, deployed at <https://miniapp-playground.web.app/agent/> | Chat UI and the browser-side agent loop that runs the tools. |
| Wallet | MynaWallet app (a42x/mynawallet-mobile, private; development build) | `Myna.jpki.prove`: consent sheet, NFC, certificate checks and the native prover. |

## Deployed on Polygon Amoy (chain id 80002)

| Contract | Address |
| --- | --- |
| `BenefitOffice` (real My Number Cards) | [`0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104`](https://amoy.polygonscan.com/address/0xdD042C51Ae39902C1C49b9c1D28BA1B0Ce74d104) |
| `BenefitAgeGate` (J-LIS roots) | [`0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803`](https://amoy.polygonscan.com/address/0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803) |
| Groth16 Verifier | [`0xb89d8e0c4a345ead852ab919548734c4f506596c`](https://amoy.polygonscan.com/address/0xb89d8e0c4a345ead852ab919548734c4f506596c) |
| JPYC | [`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`](https://amoy.polygonscan.com/address/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29) |

The claim transactions made with a real card are listed on the `BenefitOffice` page. All deployments, including the gates for test cards, are in [`contracts/deployments/amoy.json`](contracts/deployments/amoy.json).

The Worker is deployed at <https://benefit-office.ethglobal2026.workers.dev> (for example, `GET /benefit-office/v1/benefits`).

## Setup and testing

You need Node.js 22 or later and [Foundry](https://getfoundry.sh/) (`forge` and `anvil`).

**Contracts**

```sh
cd contracts
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge test
```

**Verifier**

```sh
cd zk-age-verifier
npm ci
npm test                 # deploys to a local anvil with a throwaway key and checks valid and tampered proofs
npm run verify:dry-run   # checks against Amoy with an eth_call state override; deploys nothing
```

**Worker**

```sh
cd worker
npm ci
npm run typecheck
npm test                 # some tests call the public Amoy RPC
```

To run it locally, create `worker/.dev.vars` (git-ignored) with `ANTHROPIC_API_KEY` and `OPERATOR_PRIVATE_KEY`, then:

```sh
npm run db:migrate:local
npx wrangler dev
```

Without `OPERATOR_PRIVATE_KEY` the Worker refuses to pay (`PAYOUT_FAILED`). Without `ANTHROPIC_API_KEY` the agent route answers `503`, and the mini app falls back to a scripted agent.

## MultiBaas

We did not use MultiBaas. The Worker reads from and writes to Polygon Amoy with viem over a public RPC.

## Known limitations

- The Groth16 setup was run by a single party and is not audited. Certificate revocation is not checked by the proof.
- One payout per wallet, not per person. The contract cannot tell whether the card belongs to the wallet's owner. A wallet-side check for this is in review (a42x/mynawallet-mobile#812); it is not enforced on-chain.
- iOS only, Polygon Amoy testnet only. The owner can clear a paid flag (`resetPaid`) to retake the demo.

See [docs/submission-zk.md](docs/submission-zk.md) for the full list.

## Team

We are the team behind [MynaWallet](https://x.com/MynaWallet) ([@MynaWallet](https://x.com/MynaWallet)).

| Member | Role | Handles |
| --- | --- | --- |
| Yoshitaka Shindo | Product manager. Worker, agent and agent mini app | GitHub [@shindyu](https://github.com/shindyu) |
| Susumu Tomita | ZK age proof, contracts and verifier | GitHub [@susumutomita](https://github.com/susumutomita), X [@tonitoni415](https://x.com/tonitoni415) |
| Hiroyuki Tachibana | Developer | X [@7pastelblackcat](https://x.com/7pastelblackcat) |
| Wataru Shinohara | Developer | — |

## Secrets (this repository is public)

Never commit:

- API keys (such as `ANTHROPIC_API_KEY`), private keys, or RPC URLs that contain keys.
- Anything from a real card: certificates, signatures, birth dates, or proofs made with a real card.
- Internal server settings or host names.

Put secrets in Cloudflare with `wrangler secret put`, and locally in `.dev.vars`. The Foundry deploy key is read only from an environment variable. The operator is a demo-only account. Before pushing, check:

```sh
git diff --cached | grep -iE 'sk-ant|PRIVATE_KEY=|0x[0-9a-f]{64}'
```

## Attribution and license

The age circuit (`jpki_age`), the ProveKit Groth16 backend setup and the age gate design come from [susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate) (Apache-2.0). ProveKit is by the World Foundation (MIT, see `zk-age-verifier/PROVEKIT-LICENSE.md`). This repository is Apache-2.0 ([`LICENSE`](LICENSE)). The proving system is an experimental branch with a single-party setup; use it for demos only.
