import { createPublicClient, createWalletClient, defineChain, getAddress, http, isHex, size } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, type Deps } from "./app";
import { benefitOfficePayout, unconfiguredPayout, type Payout } from "./payout";
import { gateVerifier, type Verifier } from "./verify";

const unconfiguredVerifier: Verifier = {
  verifyClaimAge: async () => {
    throw new Error("BENEFIT_AGE_GATE_ADDRESS is not set");
  },
};

function deps(env: Cloudflare.Env): Deps {
  const chain = defineChain({
    id: Number(env.CHAIN_ID),
    name: `chain ${env.CHAIN_ID}`,
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: { default: { http: [env.RPC_URL] } },
  });
  // Poll receipts often enough to settle inside receiptWaitMs.
  const client = createPublicClient({ chain, transport: http(env.RPC_URL), pollingInterval: 1_000 });

  let payout: Payout;
  const key = env.OPERATOR_PRIVATE_KEY;
  if (!env.BENEFIT_OFFICE_ADDRESS) {
    payout = unconfiguredPayout("BENEFIT_OFFICE_ADDRESS is not set");
  } else if (!key || !isHex(key, { strict: true }) || size(key) !== 32) {
    payout = unconfiguredPayout("OPERATOR_PRIVATE_KEY is not a 32-byte hex secret");
  } else {
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(env.RPC_URL) });
    payout = benefitOfficePayout(client, wallet, getAddress(env.BENEFIT_OFFICE_ADDRESS));
  }

  return {
    verifier: env.BENEFIT_AGE_GATE_ADDRESS
      ? gateVerifier(client, getAddress(env.BENEFIT_AGE_GATE_ADDRESS))
      : unconfiguredVerifier,
    payout,
    now: () => Math.floor(Date.now() / 1000),
    receiptWaitMs: 8000,
  };
}

let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx?: ExecutionContext) {
    app ??= createApp(deps(env));
    return app.fetch(request, env, ctx);
  },
};
