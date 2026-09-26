import type Anthropic from "@anthropic-ai/sdk";
import { Hono, type Context } from "hono";
import { isAddress } from "viem";

/**
 * LLM proxy for the agent mini-app. The browser keeps the conversation
 * (Anthropic MessageParam[]) and runs every tool itself; this route only adds
 * the fixed system prompt, tool definitions and the API key, then returns the
 * Message as-is so the browser can append `content` and act on `stop_reason`.
 */

export type Llm = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export const AGENT_MAX_MESSAGES = 60;
export const AGENT_MAX_BODY_BYTES = 256 * 1024;

export const AGENT_SYSTEM = `あなたはマイナウォレットの「給付金エージェント」です。ユーザーの代わりに、デモ市の給付窓口サイトから今もらえる給付金を探し、申請し、受け取りまで進めます。返答は必ず日本語で書いてください。ツールを呼ぶ前の一言（「給付窓口を確認します」など）も日本語にします。短く丁寧に話してください。

進め方:
1. ユーザーに頼まれたら、まず search_benefits で給付金の一覧を取得する。
2. 一覧から、ユーザーが受け取れる可能性のある給付金を説明する。status が "unsupported" のものは「このデモでは申請できない」と伝える。要件が無いもの(requirements が空)もこのデモでは申請できない。申請できるのは「20歳以上」の年齢確認を必要とする給付金だけ。
3. 年齢確認が必要な給付金は、ウォレットがマイナンバーカードを NFC で読み取り、生年月日を渡さずに「20歳以上」であることだけをゼロ知識証明で示すことを一言で説明し、「マイナンバーカードで証明しますか？」と必ず確認する。ユーザーが同意するまで create_claim を呼ばない。
4. 同意されたら create_claim を呼ぶ。ウォレットはその直後に自動でカードの読み取りと証明の作成を行い、その結果が create_claim の結果の age_proof に入って返ってくる。age_proof.ok が true なら、続けて submit_proof を呼ぶ。age_proof.ok が false なら、code に応じて理由を伝える(4001: ユーザーがキャンセル、-32041: カードを読めなかった、-32042: 暗証番号が違う、-32045: 20歳以上を証明できなかった、-32044: 期限切れ)。やり直したい場合は request_age_proof で同じ claim の証明を再度依頼できる。
5. submit_proof の結果が status "paid" なら、金額と tx_hash を伝え、受け取った JPYC はマイナペイで使えることを添える。"verifying" なら get_claim で状況を確認する。エラーの code が CLAIM_ALREADY_PAID なら、このウォレットは既に受け取り済みだと伝える。

ルール:
- ツールの結果に無いことを推測で言わない。金額や tx_hash はツールの結果の値をそのまま使う。
- 証明の中身(proof)は扱わない。ウォレットが保持し、窓口に直接送る。
- 生年月日・氏名・住所などの個人情報を尋ねない。
- 1 回の返答は 3 文程度まで。Markdown の見出しや表は使わない。`;

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_benefits",
    description: "デモ市 給付窓口の給付金一覧を取得する。各項目に id, name, amount, token_symbol, description, requirements, status が入る。",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "create_claim",
    description:
      "給付金の申請を作成する。窓口が challenge を発行し、ウォレットはその場でマイナンバーカードを読み取って年齢証明を作成する。結果の claim に申請 ID と状態、age_proof に証明の成否が入る。ユーザーの同意を得てから呼ぶこと。",
    input_schema: {
      type: "object",
      properties: { benefit_id: { type: "string", description: "search_benefits で得た給付金の id" } },
      required: ["benefit_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "request_age_proof",
    description: "作成済みの申請について、ウォレットに年齢証明の作成をもう一度依頼する(キャンセルや読み取り失敗のやり直し用)。",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "create_claim で得た申請の id" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "submit_proof",
    description: "ウォレットが保持している年齢証明を窓口に提出する。窓口はチェーン上で検証し、通れば同じトランザクションで JPYC を給付する。結果に status(paid / verifying / failed), tx_hash, amount, explorer_url が入る。",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "create_claim で得た申請の id" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_claim",
    description: "申請の現在の状態を取得する(pending_proof / verifying / paid / failed / expired)。",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "申請の id" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function apiError(c: Context, status: 400 | 413 | 502 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function validMessages(value: unknown): value is Anthropic.MessageParam[] {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.length <= AGENT_MAX_MESSAGES
    && value.every((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && m.content !== undefined)
    && value[0].role === "user"
  );
}

export function agentRoutes(llm: Llm | null, model: string) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.post("/agent/v1/messages", async (c) => {
    if (!llm) return apiError(c, 503, "AGENT_UNAVAILABLE", "ANTHROPIC_API_KEY is not set");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > AGENT_MAX_BODY_BYTES) return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Conversation is too long");

    const body = await c.req.json().catch(() => null);
    if (!validMessages(body?.messages) || typeof body?.wallet_address !== "string" || !isAddress(body.wallet_address)) {
      return apiError(c, 400, "INVALID_REQUEST", "messages (starting with a user turn) and a valid wallet_address are required");
    }

    let message: Anthropic.Message;
    try {
      message = await llm({
        model,
        max_tokens: 4096,
        output_config: { effort: "medium" },
        system: [
          { type: "text", text: AGENT_SYSTEM, cache_control: { type: "ephemeral" } },
          { type: "text", text: `ユーザーのウォレットアドレス: ${body.wallet_address}` },
        ],
        tools: AGENT_TOOLS,
        messages: body.messages,
      });
    } catch (e) {
      console.error("agent: upstream error", e instanceof Error ? e.message : e);
      return apiError(c, 502, "AGENT_UPSTREAM_ERROR", "The language model did not respond");
    }
    return c.json({
      id: message.id,
      model: message.model,
      role: message.role,
      content: message.content,
      stop_reason: message.stop_reason,
      usage: message.usage,
    });
  });

  return app;
}
