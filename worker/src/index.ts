import { Hono } from "hono";
import { cors } from "hono/cors";
import { listBenefits } from "./benefits";

const app = new Hono<{ Bindings: Env }>();

function originMatches(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) return origin === pattern;
  const [prefix, suffix] = pattern.split("*");
  return origin.startsWith(prefix) && origin.endsWith(suffix) && origin.length > prefix.length + suffix.length;
}

app.use("*", (c, next) =>
  cors({
    origin: (origin) => {
      const allowed = c.env.CORS_ORIGINS.split(",").map((s) => s.trim());
      return allowed.some((p) => originMatches(origin, p)) ? origin : null;
    },
  })(c, next),
);

app.get("/health", (c) => c.json({ ok: true }));

app.get("/benefit-office/v1/benefits", (c) =>
  c.json({ data: { items: listBenefits(Number(c.env.CHAIN_ID)) } }),
);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404));

export default app;
