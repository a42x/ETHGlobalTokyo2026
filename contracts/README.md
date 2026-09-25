# contracts

給付金デモのコントラクトです (Foundry、Polygon Amoy)。

- `src/BenefitAgeGate.sol`: 年齢証明を申請に結びつけて検証する gate です (#5)。
- `src/BenefitOffice.sol`: gate が証明を受理したときだけ JPYC を給付するコントラクトです (#6)。

## デプロイ済みのアドレス (Polygon Amoy, 80002)

| コントラクト | アドレス |
| --- | --- |
| `BenefitAgeGate` (J-LIS) | [`0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803`](https://amoy.polygonscan.com/address/0x176d7299c1a118356fdd8Ed0D15A68B8FCf45803) |
| `BenefitAgeGateTestRoot` (合成データのルート) | [`0x1eFB38FD54146806129A1090D1d4F7d2668BBfD8`](https://amoy.polygonscan.com/address/0x1eFB38FD54146806129A1090D1d4F7d2668BBfD8) |

どちらも Verifier `0xb89d8e0c4a345ead852ab919548734c4f506596c` を参照します。記録は [deployments/amoy.json](deployments/amoy.json) にあります。

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

## BenefitOffice

`claim(benefitId, recipient, nonce, expiresAt, proof, inputs)` は operator (給付窓口の Worker) だけが呼べます。
次の順に確かめてから給付します。

1. 給付金が登録されている。
2. 受取人が 0 アドレスでない。
3. その受取人がその給付金をまだ受け取っていない (`paid[benefitId][recipient]`)。
4. `claimHashOf(benefitId, recipient)` を自分で計算し、gate の `verifyClaimAge` が受理する。
5. 受け取り済みにしてから、JPYC を送金する。

`claimHash` は `keccak256(abi.encode(chainid, office, benefitId, recipient, amount, 20))` です。
Worker の `worker/src/claim-hash.ts` と同じ値になることをテストで確かめています。
証明はこの `claimHash` に結びついているので、別の受取人や別の給付金には使い回せません。

`registerBenefit` は、回路が 20 歳に固定されているため `minAge == 20` しか受け付けません。
gate は constructor で固定します。gate を替えるときは `BenefitOffice` もデプロイし直します。

```sh
BENEFIT_AGE_GATE=0x… BENEFIT_OPERATOR=0x… BENEFIT_FUNDING=5000000000000000000000 \
  forge script script/DeployBenefitOffice.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --broadcast --priority-gas-price 30gwei
```

`BENEFIT_OPERATOR` を省くと、デプロイしたアドレスが operator になります。あとで owner が `setOperator` で替えられます。
`BENEFIT_FUNDING` は、デプロイしたアドレスの JPYC から送る額 (wei) です。

## 注意

- 改ざんした証明を渡すと、Verifier のペアリング計算が失敗して、渡された gas を使い切ります。gate は `false` を返しますが、`BenefitOffice.claim()` を送る前に、同じ引数で `eth_call` して成功することを確かめてください。
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
