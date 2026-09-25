# zk-age-verifier

マイナンバーカード (JPKI) 由来の「20 歳以上」の Groth16 証明を、Polygon Amoy (chain id 80002) で検証するコントラクトです。
ETHGlobal Tokyo 2026 の給付金デモ用で、テストネット専用です。

このディレクトリは Verifier 単体だけを扱います。給付金の申請に証明を結びつける gate は別に作ります。

## デプロイ済みのアドレス

| chain | Verifier |
| --- | --- |
| Polygon Amoy (80002) | [`0xb89d8e0c4a345ead852ab919548734c4f506596c`](https://amoy.polygonscan.com/address/0xb89d8e0c4a345ead852ab919548734c4f506596c) |

デプロイの記録は [deployments/amoy.json](deployments/amoy.json) にあります。

## 使い方

Node 22 以上と [Foundry](https://getfoundry.sh/) の `anvil` が必要です。

```sh
npm ci
npm test                # ローカルの anvil (chain id 80002) に使い捨ての鍵でデプロイして検証する
npm run verify:dry-run  # Amoy の実ノードで state override を使って検証する。何もデプロイしない
```

Amoy へのデプロイは、テストネット専用の使い捨ての鍵に faucet の POL を入れて行います。gas は約 133 万です。
鍵は環境変数からだけ読み、ファイルには書きません。

```sh
AMOY_DEPLOYER_PRIVATE_KEY=0x… npm run deploy   # deployments/amoy.json に記録する。記録があれば二重デプロイを拒否する
npm run verify                                  # 記録したアドレスで検証する
```

Amoy の priority fee の推奨値は、実際に取り込まれている値よりかなり高いことがあります。
`AMOY_PRIORITY_FEE_GWEI=30` のように指定すると、その値でデプロイします。

RPC の既定値は `https://polygon-amoy-bor-rpc.publicnode.com` で、`AMOY_RPC_URL` で上書きできます。
`--dry-run` には `eth_call` の state override に対応した RPC が必要です。

## 検証していること

各コマンドで、次のすべてを確認します。

- 合成データの正しい証明 2 つ (同じ witness から作った別の乱数の証明) が通る。
- 1 バイト改ざんした証明が拒否される。
- 8 つの公開入力を 1 つずつ変えた 8 通りがすべて拒否される。
- デプロイしたコードがコンパイル結果と一致する (`test`、`deploy`、`verify`)。

拒否として数えるのは revert だけです。通信エラーは失敗として止まります。

## Verifier の関数

```solidity
function verifyProof(bytes calldata proof, uint256[8] calldata inputs) external view;
```

正しければ何も返さず、正しくなければ revert します。`proof` は 384 バイトです。
公開入力の並びは ZeroKeyMate の `jpki_age` 回路と同じです。

| index | 内容 |
| --- | --- |
| 0, 1 | 注文 (申請) ハッシュの上位 128 bit、下位 128 bit |
| 2, 3 | nonce の上位 128 bit、下位 128 bit |
| 4, 5 | 署名元ルート鍵の SHA-256 の上位 128 bit、下位 128 bit |
| 6 | 基準時刻 (unix 秒) |
| 7 | 有効期限 (unix 秒) |

Verifier は証明と公開入力の整合だけを確かめます。
ルート鍵が本物の J-LIS か、ハッシュが申請に一致するか、期限内かは確かめません。これは gate の役目です。

## 信頼の前提

- **トラステッドセットアップは単独実施です。** 1 台のマシンで 1 回だけ行ったもので、マルチパーティのセレモニーではありません。
  セットアップの乱数を持つ人は偽の証明を作れます。
- **未監査です。** ProveKit の Groth16 バックエンドと Solidity の verifier は、上流でも実験段階で監査されていません。
- **証明書の失効は確認しません。**
- **身元は証明しません。** 証明が示すのは、J-LIS の署名用証明書のプロファイルを満たすカードの持ち主が 20 歳以上であることだけです。
- **fixtures は合成データです。** `fixtures/synthetic/` の証明は、公開の合成証明書から作ったもので、実際のカードのデータは入っていません。
  実際のカードで作った証明や、カードから読んだデータは、このリポジトリに入れないでください。

## 出典

- 回路、セットアップ、Verifier の作り方は [susumutomita/ZeroKeyMate](https://github.com/susumutomita/ZeroKeyMate) (Apache-2.0) から持ってきています。
- `contracts/Verifier.sol` は [worldfnd/provekit](https://github.com/worldfnd/provekit) の revision `dd237e542403302186c8de4bd10df6e5c9b6725a` の `export-solidity` で出力したもので、MIT ライセンスです ([PROVEKIT-LICENSE.md](PROVEKIT-LICENSE.md))。
  - 出力時には ZeroKeyMate の隠蔽用パッチ `provekit-groth16-hiding.patch` (SHA-256 `6ea38e8eec3f7631955794d164fcf97052c14652e641119735d066dda8b92db5`) を当てています。
  - メモリ境界の修正 (`scripts/patch-age-verifier.py`) も当てています。
  - 元にした検証鍵は `age.pkv` (SHA-256 `5f7e9080e2e3a056efb531132e2277c9329554a74fae1c59883bba5dbda4dad2`) で、ZeroKeyMate の `config/age-runtime-pins.json` に固定されているものです。
- `contracts/Verifier.sol` の SHA-256 は `001ede90029f4186ebbe733d4ef245b8f6167680b87af08002ef176839a85aff` です。
  `scripts/lib.mjs` がコンパイル前にこの値を確認します。
- コンパイラは solc 0.8.30 で、optimizer 200、viaIR、EVM バージョン cancun です。
