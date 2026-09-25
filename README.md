# ETHGlobalTokyo2026

ETHGlobal Tokyo 2026 ハッカソン向けデモ「エージェントが給付金を探し、マイナンバーカード由来の ZK 年齢証明で受け取る」の、ハッカソン限りのコードを置くリポジトリ。

ユーザーがマイナウォレット内のエージェントミニアプリに「今もらえる給付金探してきて」と頼むと、AI エージェントが給付窓口（デモ）から対象給付金を見つけ、年齢確認（20 歳以上）が必要ならウォレットに JPKI 由来のゼロ知識証明を依頼する。ウォレットは物理マイナンバーカードを NFC で読み、生年月日を渡さずに証明だけを返す。給付窓口は Polygon Amoy 上の Verifier で検証し、同一トランザクションで JPYC をウォレットに給付する。

## この repo に置くもの

```
worker/      給付窓口 API + エージェント用 LLM プロキシ（Cloudflare Workers, Hono, viem, @anthropic-ai/sdk）
contracts/   ProvekitGroth16Verifier / BenefitAgeGate / BenefitOffice（Foundry, Polygon Amoy）
docs/        SPEC
```

ウォレット側（a42x/mynawallet-mobile）、SDK（a42x/miniapp-sdk）、ミニアプリ UI（a42x/miniapp-playground）は各リポジトリで開発する。全体設計と進捗は a42x/pm#67。

## 機密情報の扱い（public repo）

このリポジトリは公開されている。次のものは **絶対にコミットしない**。

- API キー（`ANTHROPIC_API_KEY` など）、秘密鍵、キー付き RPC URL
- 実カード由来のデータ（証明書、署名、生年月日、実カードで生成した proof）
- 社内サーバの設定や内部ホスト名

secrets は Cloudflare の `wrangler secret put`、ローカルは `.dev.vars`（gitignore 済み）に置く。Foundry のデプロイ鍵は `PRIVATE_KEY` 環境変数だけを使う。operator EOA はこのデモ専用の使い捨てアカウント（Amoy faucet の POL と少額 JPYC のみ）で、既存の運用鍵は使わない。push 前に次で確認する。

```sh
git diff --cached | grep -iE 'sk-ant|PRIVATE_KEY=|0x[0-9a-f]{64}'
```

## 帰属

ZK 回路（`jpki_age`）、ProveKit Groth16 backend、Age Gate の設計は [susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate)（Apache-2.0）を流用している。派生物は同じく Apache-2.0（`LICENSE`）。証明系は単一者セットアップの実験ブランチであり、デモ用途に限る。
