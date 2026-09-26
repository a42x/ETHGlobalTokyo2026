// Secrets are not in wrangler.toml, so `wrangler types` does not generate them.
declare namespace Cloudflare {
  interface Env {
    // Operator EOA of BenefitOffice. Set with `wrangler secret put OPERATOR_PRIVATE_KEY`.
    OPERATOR_PRIVATE_KEY?: string;
  }
}
