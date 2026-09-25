import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

async function allowOrigin(origin: string) {
  const res = await app.fetch(new Request("http://worker/health", { headers: { Origin: origin } }), env);
  return res.headers.get("access-control-allow-origin");
}

describe("cors", () => {
  it("allows the playground and its preview channels", async () => {
    expect(await allowOrigin("https://miniapp-playground.web.app")).toBe("https://miniapp-playground.web.app");
    expect(await allowOrigin("https://miniapp-playground--pr12.web.app")).toBe("https://miniapp-playground--pr12.web.app");
  });

  it("refuses other origins", async () => {
    expect(await allowOrigin("https://evil.example")).toBeNull();
    expect(await allowOrigin("https://miniapp-playground--.web.app")).toBeNull();
  });
});
