# contracts

給付金デモのコントラクトです (Foundry、Polygon Amoy)。

- `src/BenefitAgeGate.sol`: 年齢証明を申請に結びつけて検証する gate です (#5)。
- `src/BenefitOffice.sol`: gate が証明を受理したときだけ JPYC を給付するコントラクトです (#6)。

## デプロイ済みのアドレス (Polygon Amoy, 80002)

| コントラクト | アドレス |
| --- | --- |
| `BenefitAgeGate` (J-LIS) | [`0x44a0c9187cacfd2211d6e36e662b81e21950fdee`](https://amoy.polygonscan.com/address/0x44a0c9187cacfd2211d6e36e662b81e21950fdee) |
| `BenefitAgeGateTestRoot` (合成データのルート) | [`0x5cc9a5b5779e81fedb1bb8ecceb94aa553f254a6`](https://amoy.polygonscan.com/address/0x5cc9a5b5779e81fedb1bb8ecceb94aa553f254a6) |
| `BenefitAgeGateJpkiTest` (テスト用 J-LIS、試験カード) | [`0x70bc454c84536f05934051ba7b7bb91e3c368588`](https://amoy.polygonscan.com/address/0x70bc454c84536f05934051ba7b7bb91e3c368588) |
| `BenefitOffice` (J-LIS の gate を使う) | [`0x946105a8d563c70be8d6b8682047e9064878c885`](https://amoy.polygonscan.com/address/0x946105a8d563c70be8d6b8682047e9064878c885) |
| `BenefitOffice` (試験カード用の gate を使う。Worker はこちら) | [`0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2`](https://amoy.polygonscan.com/address/0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2) |

gate はどれも Verifier v2 `0x8b87ccb35a5f90f4ff963bf4b1bd6551a0aac078` を参照します。v2 の回路は、本番 (1.2.392.200149.8.5.1.1.20) と試験 (1.2.392.200149.8.5.1.0.20) の署名用ポリシーの両方を受け付けます。本番か試験かは、gate が固定するルート鍵で分かれます。
2 つの `BenefitOffice` には、どちらも `youth-support-2026` (500 JPYC) を登録し、J-LIS 用に 2,500 JPYC、試験カード用に 5,000 JPYC 入れています。operator は Worker の EOA `0x71B5…17B3` (`claim()` しか呼べない)、owner はデプロイしたアドレスです。記録は [deployments/amoy.json](deployments/amoy.json) にあります。

前の Verifier (`0xb89d8e0c…596c`、本番のポリシーだけ) を使っていた gate と office、`resetPaid` のない最初の office は、JPYC を引き出して使うのをやめました (`deployments/amoy.json` の `deprecated`)。

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
| `BenefitAgeGateTestRoot` | デプロイ時に指定したルート 1 つ | デモ専用。合成データの fixture |
| `BenefitAgeGateJpkiTest` | テスト用 J-LIS の署名用ルート 4 つ (`a42x/jpki-api` の `certificates/development` の `sig_ca_8`、`sig_ca_1`、`sig_ca_14`、`sig_ca_10`) | デモ専用。マイナウォレット dev 環境の試験カード |

`BenefitAgeGateTestRoot` と `BenefitAgeGateJpkiTest` が受理した証明は、実際のマイナンバーカードについては何も示しません。

ロジックは ZeroKeyMate の `contracts/src/MateAgeGate.sol` (Apache-2.0) から持ってきています。変えたのは、chain id (80002 と 31337)、関数名、テストルート版の追加の 3 点です。

## BenefitOffice

`claim(benefitId, recipient, nonce, expiresAt, proof, inputs)` は operator (給付窓口の Worker) だけが呼べます。
次の順に確かめてから給付します。

1. 給付金が登録されている。
2. 受取人が 0 アドレスでない。
3. その受取人がその給付金をまだ受け取っていない (`paid[benefitId][recipient]`)。
4. `claimHashOf(benefitId, recipient)` を自分で計算し、gate の `verifyClaimAge` が受理する。
5. 受け取り済みにしてから、JPYC を送金する。

`resetPaid(benefitId, recipient)` は、デモを撮り直すために受け取り済みの印を消します。owner だけが呼べます。
owner が同じ受取人にもう一度給付できるようになるので、本番の給付窓口には入れてはいけません。

```sh
cast send 0xe83485cb12bc6e6ed4a5b4b016afe119da5a55b2 'resetPaid(bytes32,address)' \
  "$(cast keccak youth-support-2026)" 0x… --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --priority-gas-price 30gwei
```

`claimHash` は `keccak256(abi.encode(chainid, office, benefitId, recipient, amount, 20))` です。
Worker の `worker/src/claim-hash.ts` と同じ値になることをテストで確かめています。
証明はこの `claimHash` に結びついているので、別の受取人や別の給付金には使い回せません。

`registerBenefit` は、回路が 20 歳に固定されているため `minAge == 20` しか受け付けません。
gate は constructor で固定します。gate を替えるときは `BenefitOffice` もデプロイし直します。

```sh
BENEFIT_AGE_GATE=0x… BENEFIT_OPERATOR=0x… BENEFIT_FUNDING=5000000000000000000000 \
  forge script script/DeployBenefitOffice.s.sol --rpc-url https://polygon-amoy-bor-rpc.publicnode.com \
  --private-key "$AMOY_DEPLOYER_PRIVATE_KEY" --broadcast --priority-gas-price 30gwei --gas-estimate-multiplier 150
```

forge の gas の見積もりは JPYC の送金には足りないことがあるので、`--gas-estimate-multiplier` で余裕を持たせます。
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
