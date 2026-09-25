# contracts

給付金デモのコントラクトです (Foundry、Polygon Amoy)。

- `src/BenefitAgeGate.sol`: 年齢証明を申請に結びつけて検証する gate です (#5)。
- `BenefitOffice` はまだありません (#6)。

## gate

`verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs)` は、次のすべてを満たすときだけ `true` を返します。

- 公開入力の注文ハッシュの位置が `claimHash` と一致する。`claimHash` は呼ぶ側が自分で計算した値を渡す。
- 公開入力の nonce と有効期限が引数と一致し、基準時刻は `expiresAt - 900` である。
- 今の時刻が基準時刻以上、`expiresAt` 未満である。
- 署名元のルート鍵が許可されている。
- デプロイ済みの Verifier (`zk-age-verifier/`) が証明を受理する。Verifier のコードハッシュは constructor で固定する。

gate は 2 種類あります。

| コントラクト | 受け付けるルート | 用途 |
| --- | --- | --- |
| `BenefitAgeGate` | J-LIS の本番ルート 2 つ (ZeroKeyMate の `MateAgeGate` と同じ) | 実際のカード |
| `BenefitAgeGateTestRoot` | デプロイ時に指定したルート 1 つ | デモ専用。合成データの fixture や dev の試験カード |

`BenefitAgeGateTestRoot` が受理した証明は、実際のマイナンバーカードについては何も示しません。

ロジックは ZeroKeyMate の `contracts/src/MateAgeGate.sol` (Apache-2.0) から持ってきています。変えたのは、chain id (80002 と 31337)、関数名、テストルート版の追加の 3 点です。

## 注意

- 改ざんした証明を渡すと、Verifier のペアリング計算が失敗して、渡された gas を使い切ります。gate は `false` を返しますが、トランザクションの中で呼ぶ場合は、先に `eth_call` で確認してから送ってください。
- 信頼の前提は `zk-age-verifier/README.md` と同じです。セットアップは単独実施で、未監査で、証明書の失効は確認しません。

## 使い方

```sh
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge test
AMOY_RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com forge test --match-contract AmoyFork
```

2 つめのテストは、Amoy をフォークして、デプロイ済みの Verifier を gate から呼び出します。
合成データの fixture は基準時刻が 2027 年なので、フォークの中で時刻を進めて確かめます。

デプロイは、テストネット専用の使い捨ての鍵で行います。

```sh
forge script script/DeployGates.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --broadcast --priority-gas-price 30gwei
```
