import { createPublicClient, getAddress, http } from "viem";
import { createApp, type Deps } from "./app";
import { mockPayout } from "./payout";
import { groth16Verifier } from "./verify";

function deps(env: Cloudflare.Env): Deps {
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  return {
    verifier: groth16Verifier(client, getAddress(env.AGE_VERIFIER_ADDRESS)),
    payout: mockPayout,
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
