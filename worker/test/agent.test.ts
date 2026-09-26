import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, type Llm } from "../src/agent";
import { createApp, type Deps } from "../src/app";
import { mockPayout } from "../src/payout";

const WALLET = "0x1111111111111111111111111111111111111111";

function setup(llm: Llm | null) {
  const deps: Deps = {
    verifier: { verifyClaimAge: async () => true },
    payout: mockPayout,
    now: () => 1_790_000_000,
    receiptWaitMs: 50,
    llm,
    agentModel: "test-model",
  };
  const app = createApp(deps);
  return async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(
      new Request("http://worker/agent/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: res.status, json: (await res.json()) as any };
  };
}

const reply: Anthropic.Message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "tool_use", id: "toolu_1", name: "search_benefits", input: {}, caller: { type: "direct" } } as Anthropic.ToolUseBlock],
  stop_reason: "tool_use",
  stop_sequence: null,
  stop_details: null,
  container: null,
  usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
};

describe("POST /agent/v1/messages", () => {
  it("forwards the conversation with the fixed system prompt and tools", async () => {
    let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const call = setup(async (params) => {
      seen = params;
      return reply;
    });
    const messages = [{ role: "user", content: "今もらえる給付金探してきて" }];
    const { status, json } = await call({ messages, wallet_address: WALLET });

    expect(status).toBe(200);
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content[0].name).toBe("search_benefits");
    expect(seen?.model).toBe("test-model");
    expect(seen?.messages).toEqual(messages);
    expect(seen?.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    expect(JSON.stringify(seen?.system)).toContain(WALLET);
  });

  it("rejects malformed conversations", async () => {
    const call = setup(async () => reply);
    expect((await call({ messages: [], wallet_address: WALLET })).status).toBe(400);
    expect((await call({ messages: [{ role: "assistant", content: "hi" }], wallet_address: WALLET })).status).toBe(400);
    expect((await call({ messages: [{ role: "user", content: "hi" }], wallet_address: "nope" })).status).toBe(400);
    expect((await call({ messages: [{ role: "user", content: "hi" }], wallet_address: WALLET }, { "content-length": "9999999" })).status).toBe(413);
  });

  it("answers 503 without an API key and 502 when the model fails", async () => {
    const body = { messages: [{ role: "user", content: "hi" }], wallet_address: WALLET };
    const unavailable = await setup(null)(body);
    expect(unavailable.status).toBe(503);
    expect(unavailable.json.error.code).toBe("AGENT_UNAVAILABLE");

    const failing = await setup(async () => {
      throw new Error("boom");
    })(body);
    expect(failing.status).toBe(502);
    expect(failing.json.error.code).toBe("AGENT_UPSTREAM_ERROR");
  });
});
