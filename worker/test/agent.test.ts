import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  AGENT_SYSTEM,
  AGENT_SYSTEM_EN,
  AGENT_TOOLS,
  AGENT_TOOLS_EN,
  ONCHAIN_STEPS,
  ONCHAIN_STEPS_EN,
  ONCHAIN_TOOLS,
  ONCHAIN_TOOLS_EN,
  type Llm,
} from "../src/agent";
import { createApp, type Deps } from "../src/app";
import { mockPayout } from "../src/payout";

const WALLET = "0x1111111111111111111111111111111111111111";

function setup(llm: Llm | null, extra: Partial<Deps> = {}) {
  const deps: Deps = {
    verifier: { verifyClaimAge: async () => true },
    payout: mockPayout,
    now: () => 1_790_000_000,
    receiptWaitMs: 50,
    llm,
    agentModel: "test-model",
    ...extra,
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

  describe("locale", () => {
    const systemTexts = (params: Anthropic.MessageCreateParamsNonStreaming | undefined) =>
      (params?.system as Anthropic.TextBlockParam[]).map((b) => b.text);
    const toolDescriptions = (params: Anthropic.MessageCreateParamsNonStreaming | undefined) =>
      params?.tools?.map((t) => (t as Anthropic.Tool).description);

    async function send(extra: Record<string, unknown>) {
      let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
      const call = setup(async (params) => {
        seen = params;
        return reply;
      });
      const { status } = await call({ messages: [{ role: "user", content: "hi" }], wallet_address: WALLET, ...extra });
      expect(status).toBe(200);
      return seen;
    }

    it("sends the English system prompt and tool descriptions for locale 'en'", async () => {
      const seen = await send({ locale: "en" });
      const system = seen?.system as Anthropic.TextBlockParam[];
      expect(system[0].text).toBe(AGENT_SYSTEM_EN);
      expect(system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(system[1].text).toBe(`User's wallet address: ${WALLET}`);
      expect(system[1].cache_control).toBeUndefined();
      expect(seen?.tools).toEqual(AGENT_TOOLS_EN);
      expect(toolDescriptions(seen)?.join("\n")).not.toMatch(/[\u3040-\u30ff]/);
      expect(AGENT_SYSTEM_EN).not.toMatch(/[\u3040-\u30ff]/);
    });

    it.each([
      ["missing", {}],
      ["ja", { locale: "ja" }],
      ["unknown", { locale: "fr" }],
      ["non-string", { locale: 1 }],
    ])("keeps the Japanese prompt when locale is %s", async (_label, extra) => {
      const seen = await send(extra);
      const system = seen?.system as Anthropic.TextBlockParam[];
      expect(systemTexts(seen)).toEqual([AGENT_SYSTEM, `ユーザーのウォレットアドレス: ${WALLET}`]);
      expect(system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(seen?.tools).toEqual(AGENT_TOOLS);
    });

    it("offers the same tools with the same schemas in both languages", () => {
      expect(AGENT_TOOLS_EN.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
      expect(AGENT_TOOLS_EN.map((t) => t.input_schema.required)).toEqual(AGENT_TOOLS.map((t) => t.input_schema.required));
      expect(AGENT_TOOLS_EN.map((t) => Object.keys(t.input_schema.properties ?? {}))).toEqual(
        AGENT_TOOLS.map((t) => Object.keys(t.input_schema.properties ?? {})),
      );
    });

    it("explains every age proof error, including the -32045 reasons, in both prompts", () => {
      for (const prompt of [AGENT_SYSTEM, AGENT_SYSTEM_EN]) {
        for (const code of ["4001", "-32041", "-32042", "-32044", "-32045", "CLAIM_ALREADY_PAID", "card_owner_mismatch", "certificate_revoked"]) {
          expect(prompt).toContain(code);
        }
      }
      expect(AGENT_SYSTEM).toContain("返答は必ず日本語で");
      expect(AGENT_SYSTEM_EN).toContain("Always reply in English");
      expect(AGENT_SYSTEM_EN).toContain("Would you like to prove it with your My Number Card?");
      expect(AGENT_SYSTEM_EN).toContain("card belongs to someone other than the owner of this wallet");
      expect(AGENT_SYSTEM_EN).toContain("certificate has been revoked");
      expect(AGENT_SYSTEM).toContain("別の人のカード");
      expect(AGENT_SYSTEM).toContain("証明書が失効");
    });
  });
});

describe("on-chain tools (#24)", () => {
  async function send(extra: Record<string, unknown>, onchainTools: boolean) {
    let seen: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const call = setup(
      async (params) => {
        seen = params;
        return reply;
      },
      { agentOnchainTools: onchainTools },
    );
    const { status } = await call({ messages: [{ role: "user", content: "hi" }], wallet_address: WALLET, ...extra });
    expect(status).toBe(200);
    return seen;
  }
  const names = (params: Anthropic.MessageCreateParamsNonStreaming | undefined) =>
    params?.tools?.map((t) => (t as Anthropic.Tool).name);
  const texts = (params: Anthropic.MessageCreateParamsNonStreaming | undefined) =>
    (params?.system as Anthropic.TextBlockParam[]).map((b) => b.text);

  it("hides check_eligibility and verify_payment unless the flag is on", async () => {
    for (const locale of ["ja", "en"]) {
      const seen = await send({ locale }, false);
      expect(names(seen)).not.toContain("check_eligibility");
      expect(names(seen)).not.toContain("verify_payment");
      expect(texts(seen).join("\n")).not.toContain("check_eligibility");
    }
  });

  it.each([
    ["ja", AGENT_TOOLS, ONCHAIN_TOOLS, ONCHAIN_STEPS],
    ["en", AGENT_TOOLS_EN, ONCHAIN_TOOLS_EN, ONCHAIN_STEPS_EN],
  ])("offers them with their instructions in %s when the flag is on", async (locale, base, onchain, steps) => {
    const seen = await send({ locale }, true);
    expect(seen?.tools).toEqual([...base, ...onchain]);
    const system = seen?.system as Anthropic.TextBlockParam[];
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[1].text).toBe(steps);
  });

  it("describes the same schemas in both languages, and English without Japanese", () => {
    expect(ONCHAIN_TOOLS_EN.map((t) => [t.name, t.input_schema.required])).toEqual(
      ONCHAIN_TOOLS.map((t) => [t.name, t.input_schema.required]),
    );
    expect(ONCHAIN_STEPS_EN + ONCHAIN_TOOLS_EN.map((t) => t.description).join("")).not.toMatch(/[\u3040-\u30ff]/);
  });
});

