# Plan: 給付窓口 Worker（benefit-office）+ Amoy コントラクト + エージェント LLM プロキシ

> 作成日: 2026-09-25（21:50 JST レビュー反映版）/ ステータス: Draft
> 全体設計: a42x/api `plans/2026-09-25-ethglobal-agent-benefit-demo.md`（https://github.com/a42x/api/pull/2969、WS-A, WS-E に相当）
> 実装先: この repo（ハッカソン限りのコードを置く public repo）。a42x/api への変更はなし

## TL;DR

- **やること**: (1) ZeroKeyMate の Groth16 Verifier + AgeGate を Polygon Amoy 向けに `contracts/` に置きデプロイ、(2) 証明を検証して JPYC を給付する `BenefitOffice` コントラクト、(3) デモ用給付窓口 API（benefits / claims / proof）を Cloudflare Worker で、(4) ブラウザのエージェントが使う Anthropic Messages API プロキシを同じ Worker で
- **やらないこと**: a42x/api の変更、Push 通知、認証付き API、Android、多重受給の完全防止
- **進め方**: WS-A（コントラクト）と WS-E（Worker）は別担当で並列。Worker は最初 `MockVerifier`（常に true）+ `MockPayout` で作り、A のアドレスが出たら vars を差し替える

## 機密情報の扱い（public repo のため最優先）

- コミットしてよいもの: コード、コントラクト、生成 Verifier、**合成証明書**の fixture、Amoy のコントラクトアドレス、公開 RPC URL
- コミットしてはいけないもの: `ANTHROPIC_API_KEY`、operator EOA の秘密鍵、Alchemy 等のキー付き RPC URL、実カード由来のデータ（証明書・署名・生年月日）、実カードで作った proof、社内のサーバ設定
- 置き場所: Cloudflare は `wrangler secret put`、ローカルは `.dev.vars`（`.gitignore` 済み）。Foundry のデプロイ鍵は `PRIVATE_KEY` 環境変数のみ（`.env` は `.gitignore`）
- operator EOA は **このデモ専用の使い捨て**（Amoy faucet の POL と少額 JPYC のみ）。既存の KMS 鍵や運用アカウントは使わない
- push 前に `git diff --cached | grep -iE 'sk-ant|PRIVATE_KEY=|0x[0-9a-f]{64}'` で確認する。GitHub の secret scanning も有効にする

## リポジトリ構成（a42x/ETHGlobalTokyo2026）

```
README.md                 # デモ概要、ZeroKeyMate への帰属（Apache-2.0）、機密情報ルール
.gitignore                # .env, .dev.vars, node_modules, out/, cache/, .build/
worker/
  package.json            # hono, viem, @anthropic-ai/sdk, wrangler
  wrangler.toml           # name, D1 binding CLAIMS, vars（アドレス・chain id・CORS_ORIGINS・AGENT_MODEL）
  migrations/0001_claims.sql
  src/index.ts            # Hono app + CORS + ルート
  src/benefits.ts         # 給付金 3 件（静的）
  src/claims.ts           # D1 CRUD、状態遷移、期限
  src/claim-hash.ts       # claimHash / publicInputs（viem encodeAbiParameters + keccak256）
  src/verify.ts           # eth_call BenefitAgeGate.verifyClaimAge（DI: MockVerifier）
  src/payout.ts           # operator EOA で BenefitOffice.claim()、receipt 待ち（DI: MockPayout）
  src/agent.ts            # Anthropic Messages API プロキシ（system / tools 固定）
  src/abis/               # BenefitOffice / BenefitAgeGate の ABI（forge の生成物から抜粋）
  test/                   # vitest（claim-hash が ZeroKeyMate の ageArguments と一致、状態遷移、CORS）
contracts/
  foundry.toml
  src/ProvekitGroth16Verifier.sol   # 生成物（手で編集しない）
  src/BenefitAgeGate.sol            # MateAgeGate の chainid 80002 版
  src/BenefitOffice.sol
  test/BenefitOffice.t.sol
  script/DeployBenefit.s.sol
  fixtures/                          # 合成証明書の proof / inputs（実カード由来は置かない）
docs/
  2026-09-25-benefit-office-worker-and-contracts.md   # 本ファイル
```

## G1. コントラクト（`contracts/`）

`BenefitOffice.sol` 仕様:

| 項目 | 内容 |
| --- | --- |
| 状態 | `IERC20 jpyc`, `BenefitAgeGate gate`, `address operator`, `mapping(bytes32=>Benefit) benefits`, `mapping(bytes32=>bool) claimed`, `mapping(bytes32=>mapping(address=>bool)) paid` |
| `registerBenefit(bytes32 id, uint256 amountWei, uint256 minAge)` | owner のみ。`minAge == 20` 必須（回路固定） |
| `claim(bytes32 benefitId, address recipient, bytes32 nonce, uint256 expiresAt, bytes proof, uint256[8] inputs)` | operator のみ。`claimHash` を再計算 → `claimed` / `paid` 検査 → `gate.verifyClaimAge` → 状態更新 → `jpyc.transfer` → `BenefitPaid` |
| `claimHash` | `keccak256(abi.encode(block.chainid, address(this), benefitId, recipient, amountWei, minAge))` |
| `withdraw(uint256)` | owner が JPYC を回収 |
| イベント | `BenefitPaid(bytes32 indexed benefitId, address indexed recipient, bytes32 claimHash, uint256 amountWei)` |

`BenefitAgeGate.sol` は ZeroKeyMate `MateAgeGate.sol` と同一ロジックで、`block.chainid` の許可を 80002 / 31337 に変える。J-LIS ルート hash 2 件と有効期間の pin はそのまま。

デプロイ手順:

1. Apple Silicon Mac で ZeroKeyMate を clone し `python3 scripts/build-age-evm.py`（Rust nightly-2026-03-04、Node、Anvil、Python cryptography）→ `.build/age-proof-engine/artifacts/` に `age.pkp` / `age.pkv` / `Verifier.sol` / provenance
2. `Verifier.sol` を `ProvekitGroth16Verifier.sol` としてコピー。`BenefitAgeGate` の `expectedCodeHash` に verifier runtime の keccak
3. `PRIVATE_KEY=<使い捨て deployer> forge script script/DeployBenefit.s.sol --rpc-url https://rpc-amoy.polygon.technology --broadcast`
4. `registerBenefit(keccak256("youth-support-2026"), 500e18, 20)`、`BenefitOffice` に JPYC 入金、`operator` を Worker の EOA に設定
5. `age.pkp` / `age.pkv` は mobile の開発用同梱に渡す（Git には入れない。サイズが大きいので GitHub Release か GCS）
6. アドレスを `wrangler.toml` の vars と mobile の env に共有

## G2. 給付窓口 API（Worker）

エンドポイント（認証なし、CORS は `CORS_ORIGINS` のオリジンのみ、IP あたり 30 req/min）:

```jsonc
// GET /benefit-office/v1/benefits
{ "data": { "items": [
  { "id": "youth-support-2026", "name": "若者応援給付", "amount": "500", "token_symbol": "JPYC", "chain_id": 80002,
    "description": "20歳以上の方に 500 JPYC を給付します。", "requirements": [ { "type": "age_over", "min_age": 20 } ], "office": "デモ市 給付窓口" },
  { "id": "welcome-2026", "name": "ウェルカム給付", "amount": "100", "requirements": [], ... },
  { "id": "senior-2026", "name": "シニア給付", "amount": "1000", "requirements": [ { "type": "age_over", "min_age": 65 } ], "status": "unsupported", ... }
] } }

// POST /benefit-office/v1/claims  body: { "benefit_id", "wallet_address" }
{ "data": { "id": "clm_<uuid>", "benefit_id", "wallet_address", "status": "pending_proof",
  "chain_id": 80002, "gate_address": "0x..", "office_address": "0x..",
  "challenge": { "claimHash": "0x..", "nonce": "0x..", "referenceTime": 1790000000, "expiresAt": 1790000900 },
  "claim": { "type": "age_over", "minAge": 20 }, "expires_at": "..." } }

// POST /benefit-office/v1/claims/{id}/proof
//   body: { "proof_type": "groth16", "proof": "0x<768hex>", "public_inputs": ["..."x8], "root_key_hash": "0x.." }
//   200: { "data": { "id", "status": "paid", "tx_hash", "amount": "500", "token_symbol": "JPYC", "explorer_url" } }
//   202: { "data": { "id", "status": "verifying" } }   // GET /claims/{id} で polling
// GET  /benefit-office/v1/claims/{id}
```

エラー（`{ "error": { "code", "message" } }`）: `BENEFIT_NOT_FOUND` 404、`BENEFIT_UNSUPPORTED` 400、`CLAIM_NOT_FOUND` 404、`CLAIM_EXPIRED` 410、`CLAIM_ALREADY_PAID` 409、`INVALID_PROOF_FORMAT` 400、`PROOF_REJECTED` 403、`PAYOUT_FAILED` 502。

処理（`POST /claims/{id}/proof`）:

1. D1 から claim を取得、状態と期限を検査
2. `public_inputs` を challenge + `root_key_hash` から再計算して一致確認
3. `verify.ts`: eth_call `BenefitAgeGate.verifyClaimAge` → false は `PROOF_REJECTED`
4. 状態を `verifying` にして `payout.ts`: operator EOA（viem `walletClient`）で `BenefitOffice.claim()` を送信、receipt を最大 8 秒待つ。取れたら `paid` + `tx_hash` で 200、取れなければ 202（`ctx.waitUntil` で polling 継続）
5. 保険（`proof_type: "attestation"`）: `message` を再構築し、`wallet_address` に ERC-1271 `isValidSignature` を eth_call。true なら operator EOA から JPYC `transfer` を直接送る

D1 `claims` テーブル: `id, benefit_id, wallet_address, status, claim_hash, nonce, reference_time, expires_at, proof_type, tx_hash, created_at, updated_at`。

## G3. エージェント LLM プロキシ（同じ Worker）

- `POST /agent/v1/messages`、body `{ messages: Anthropic.MessageParam[], wallet_address }`（ブラウザが会話履歴と tool_result を全て持つ。Worker は stateless）
- Worker は `model`（`AGENT_MODEL`、既定 `claude-opus-5`）/ `system` / `tools` / `max_tokens` を固定し、`@anthropic-ai/sdk` の `client.messages.create({ model, max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], tools, messages })` を呼ぶ。`ANTHROPIC_API_KEY` は wrangler secret
- レスポンスは Anthropic の `Message` をそのまま返す。`tool_use` があればブラウザがツールを実行して `tool_result` を付けて再送
- ツール定義（すべてクライアント実行）: `search_benefits` / `create_claim` / `request_age_proof` / `submit_proof` / `get_claim`
- 制限: `messages` 40 件 / 64 KB、IP あたり 20 req/min。`stop_reason === 'refusal'` はそのまま返す
- system prompt の要点: 給付金エージェント。`search_benefits` で対象を提示。年齢要件がある給付は、ユーザーに年齢確認を依頼する文を出してから `create_claim` → 直後に `request_age_proof`（生年月日や個人情報は絶対に聞かない）→ `submit_proof` → 結果（金額、tx リンク）を日本語で簡潔に。一度に 1 ツール。ユーザー確認なしに `create_claim` を呼ばない

## 設定

`wrangler.toml` vars: `CHAIN_ID=80002`, `RPC_URL=https://rpc-amoy.polygon.technology`, `BENEFIT_OFFICE_ADDRESS`, `BENEFIT_AGE_GATE_ADDRESS`, `JPYC_ADDRESS=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`, `CORS_ORIGINS=https://miniapp-playground.web.app,https://miniapp-playground--*.web.app`, `AGENT_MODEL=claude-opus-5`
secrets: `ANTHROPIC_API_KEY`, `OPERATOR_PRIVATE_KEY`（任意で `RPC_URL_SECRET` にキー付き RPC）

## Implementation Order

1. repo 初期化（.gitignore、README の機密情報ルール、secret scanning）
2. G1-a: `BenefitOffice.sol` + `BenefitAgeGate.sol` + Foundry テスト（gate は `MockGate` で先に）
3. G1-b: ZeroKeyMate ビルドで Verifier / fixture 生成、実 gate でテスト、Amoy デプロイ
4. G2-a: claim-hash / claims / benefits + vitest
5. G2-b: routes + Mock で結合、`wrangler dev` で playground（`?mock=0`）から疎通
6. G2-c: 実 verify / payout を Amoy で確認（`scripts/smoke.ts` で fixture proof → paid）
7. G3: agent プロキシ + system prompt + tools（playground F と早めに結合）
8. `wrangler deploy`、playground の `agent.apiBase` を Worker URL に

## Testing

- vitest: `claim-hash`（ZeroKeyMate `services/shop/src/age.mjs` の `ageArguments` と同じ値）、claims 状態遷移、CORS、agent ルート（Anthropic client を DI）
- Foundry: claim 成功 / 二重 claim / 期限切れ / 別 recipient の proof 流用 / `minAge != 20` 拒否
- Smoke: fixture proof を Amoy に投げて `paid`

## Open Questions

- Q1: 給付金 3 件で足りるか
- Q2: LLM モデル（`claude-opus-5` / `claude-sonnet-5`）
- Q3: D1 か Durable Object か（D1 で十分と判断。強整合で 1 テーブル）

## References

- 全体設計: https://github.com/a42x/api/pull/2969（`plans/2026-09-25-ethglobal-agent-benefit-demo.md`）
- ZeroKeyMate: `contracts/src/MateAgeGate.sol`, `services/shop/src/age.mjs`, `services/shop/src/worker.mjs`, `scripts/build-age-evm.py`, `scripts/patch-age-verifier.py`
