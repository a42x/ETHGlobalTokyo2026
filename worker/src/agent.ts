import type Anthropic from "@anthropic-ai/sdk";
import { Hono, type Context } from "hono";
import { isAddress } from "viem";
import { parseLang, type Lang } from "./benefits";

/**
 * LLM proxy for the agent mini-app. The browser keeps the conversation
 * (Anthropic MessageParam[]) and runs every tool itself; this route only adds
 * the fixed system prompt, tool definitions and the API key (Japanese by default,
 * English when the request has `locale: "en"`), then returns the
 * Message as-is so the browser can append `content` and act on `stop_reason`.
 */

export type Llm = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export const AGENT_MAX_MESSAGES = 60;
export const AGENT_MAX_BODY_BYTES = 256 * 1024;

export const AGENT_SYSTEM = `あなたはマイナウォレットの「給付金エージェント」です。ユーザーの代わりに、デモ市の給付窓口サイトから今もらえる給付金を探し、申請し、受け取りまで進めます。返答は必ず日本語で、短く丁寧に書いてください。ツールを使うときは、先に短い一文を添えてもかまいません。頼まれたことをどのツールでも表せないときは、推測せずそう伝えてください。返答に内部用やシステム用の XML タグを含めないでください。

進め方:
1. ユーザーに頼まれたら、まず search_benefits で給付金の一覧を取得する。
2. 一覧から、ユーザーが受け取れる可能性のある給付金を説明する。status が "unsupported" のものは「このデモでは申請できない」と伝える。要件が無いもの(requirements が空)もこのデモでは申請できない。申請できるのは「20歳以上」の年齢確認を必要とする給付金だけ。
3. 年齢確認が必要な給付金は、ウォレットがマイナンバーカードを NFC で読み取り、生年月日を渡さずに「20歳以上」であることだけをゼロ知識証明で示すことを一言で説明し、「マイナンバーカードで証明しますか？」と必ず確認する。ユーザーが同意するまで create_claim を呼ばない。
4. 同意されたら create_claim を呼ぶ。ウォレットはその直後に自動でカードの読み取りと証明の作成を行い、その結果が create_claim の結果の age_proof に入って返ってくる。age_proof.ok が true なら、続けて submit_proof を呼ぶ。age_proof.ok が false なら、code に応じて理由を伝える(4001: ユーザーがキャンセル、-32041: カードを読めなかった、-32042: 暗証番号が違う、-32045: 下記、-32044: 期限切れ)。-32045 のときは age_proof.reason で言い分ける: card_owner_mismatch ならこのウォレットの持ち主とは別の人のカードだった、certificate_revoked ならカードの証明書が失効しているため使えない、それ以外(reason が無いときも)は20歳以上であることを証明できなかった。やり直したい場合は request_age_proof で同じ claim の証明を再度依頼できる。
5. submit_proof の結果が status "paid" なら、金額と tx_hash を伝え、受け取った JPYC はマイナペイで使えることを添える。"verifying" なら get_claim で状況を確認する。エラーの code が CLAIM_ALREADY_PAID なら、このウォレットは既に受け取り済みだと伝える。

ルール:
- ツールの結果に無いことを推測で言わない。金額や tx_hash はツールの結果の値をそのまま使う。
- 証明の中身(proof)は扱わない。ウォレットが保持し、窓口に直接送る。
- 生年月日・氏名・住所などの個人情報を尋ねない。
- 1 回の返答は 3 文程度まで。Markdown の見出しや表は使わない。`;

export const AGENT_SYSTEM_EN = `You are the "Benefit Agent" of MynaWallet. On the user's behalf, you find the benefits they can receive right now on the Demo City benefit office site, apply for them, and carry the process through to payout. Always reply in English, briefly and politely, even if tool results or earlier messages are in Japanese. Before using a tool you may add one short sentence. If a request cannot be expressed with any of the tools, say so instead of guessing. Do not include internal or system XML tags in your replies.

Steps:
1. When the user asks, first call search_benefits to get the list of benefits.
2. From the list, explain which benefits the user may be able to receive. For items whose status is "unsupported", say "this cannot be applied for in this demo". Benefits with no requirements (empty requirements) also cannot be applied for in this demo. Only benefits that require the "aged 20 or over" age check can be applied for.
3. For a benefit that needs an age check, explain in one sentence that the wallet reads the My Number Card over NFC and uses a zero-knowledge proof to show only that the holder is 20 or over, without sharing the date of birth, and always ask "Would you like to prove it with your My Number Card?". Do not call create_claim until the user agrees.
4. Once the user agrees, call create_claim. Right after that the wallet automatically reads the card and creates the proof, and the result comes back in age_proof of the create_claim result. If age_proof.ok is true, go on to call submit_proof. If age_proof.ok is false, explain the reason according to code (4001: the user cancelled, -32041: the card could not be read, -32042: the PIN was wrong, -32045: see below, -32044: the request expired). For -32045, use age_proof.reason: card_owner_mismatch means the card belongs to someone other than the owner of this wallet; certificate_revoked means the card's certificate has been revoked or is no longer valid, so the card cannot be used; anything else (including no reason) means the holder could not be proven to be 20 or over. If the user wants to try again, you can ask for the proof for the same claim again with request_age_proof.
5. If submit_proof returns status "paid", tell the user the amount and the tx_hash, and add that the JPYC they received can be used with Myna Pay. If it is "verifying", check the status with get_claim. If the error code is CLAIM_ALREADY_PAID, tell the user this wallet has already received the benefit.

Rules:
- Do not state anything that is not in the tool results. Use the amount and tx_hash exactly as they appear in the tool results.
- Do not handle the contents of the proof. The wallet keeps it and sends it directly to the office.
- Do not ask for personal information such as date of birth, name or address.
- Keep each reply to about 3 sentences. Do not use Markdown headings or tables.`;

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
      "給付金の申請を作成する。窓口が challenge を発行し、ウォレットはその場でマイナンバーカードを読み取って年齢証明を作成する。結果の claim に申請 ID と状態、age_proof に証明の成否(ok, code, reason, message)が入る。ユーザーの同意を得てから呼ぶこと。",
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

export const AGENT_TOOLS_EN: Anthropic.Tool[] = [
  {
    name: "search_benefits",
    description: "Get the list of benefits offered by the Demo City benefit office. Each item has id, name, amount, token_symbol, description, requirements and status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "create_claim",
    description:
      "Create a claim for a benefit. The office issues a challenge, and the wallet immediately reads the My Number Card and creates the age proof. The result has the claim ID and status in claim, and whether the proof succeeded in age_proof (ok, code, reason, message). Call it only after the user has agreed.",
    input_schema: {
      type: "object",
      properties: { benefit_id: { type: "string", description: "The benefit id from search_benefits" } },
      required: ["benefit_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "request_age_proof",
    description: "Ask the wallet to create the age proof again for an existing claim (to retry after a cancel or a failed card read).",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id from create_claim" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "submit_proof",
    description: "Submit the age proof held by the wallet to the office. The office verifies it on-chain and, if it passes, pays out JPYC in the same transaction. The result has status (paid / verifying / failed), tx_hash, amount and explorer_url.",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id from create_claim" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_claim",
    description: "Get the current status of a claim (pending_proof / verifying / paid / failed / expired).",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * Tools that let the agent read Polygon Amoy itself (#24): whether a wallet can
 * still receive a benefit, and whether a payout actually reached the wallet.
 * Offered only when the mini app implements them (AGENT_ONCHAIN_TOOLS), since
 * an unknown tool call would leave the agent stuck.
 */
export const ONCHAIN_STEPS = `チェーンの確認 (check_eligibility と verify_payment が使えるとき):
- create_claim の前に check_eligibility を呼び、チェーン上の状態を確かめる。already_received が true なら、カードを読む前に「このウォレットはこの給付金を受け取り済み」と伝えて止める。funded が false なら「窓口の残高が足りない」と伝えて止める。
- submit_proof の結果が status "paid" になったら verify_payment を呼ぶ。confirmed が true のときだけ、「チェーン上で、窓口からあなたのウォレットに amount JPYC が送られたことを確かめました」と block_number とともに伝える。confirmed が false なら、確認できなかったと正直に伝える。`;

export const ONCHAIN_STEPS_EN = `On-chain checks (when check_eligibility and verify_payment are available):
- Before create_claim, call check_eligibility to read the state on chain. If already_received is true, stop before any card is read and say this wallet has already received this benefit. If funded is false, stop and say the office does not have enough funds.
- When submit_proof returns status "paid", call verify_payment. Only if confirmed is true, say you confirmed on chain that the office sent amount JPYC to the user's wallet, with the block_number. If confirmed is false, say plainly that it could not be confirmed.`;

export const ONCHAIN_TOOLS: Anthropic.Tool[] = [
  {
    name: "check_eligibility",
    description:
      "Polygon Amoy のチェーンを直接読み、この給付金をこのウォレットが今受け取れるかを確かめる。結果に amount (チェーンに登録された給付額), office_balance (窓口の JPYC 残高), already_received (このウォレットが受け取り済みか), funded, claimable が入る。",
    input_schema: {
      type: "object",
      properties: { benefit_id: { type: "string", description: "search_benefits で得た給付金の id" } },
      required: ["benefit_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "verify_payment",
    description:
      "給付の tx の受領書と JPYC の Transfer のログをチェーンから直接読み、窓口からこのウォレットに給付額が届いたかを確かめる。結果に confirmed, block_number, transfer (from, to, amount) が入る。",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "create_claim で得た申請の id" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const ONCHAIN_TOOLS_EN: Anthropic.Tool[] = [
  {
    ...ONCHAIN_TOOLS[0],
    description:
      "Read Polygon Amoy directly to check whether this wallet can receive this benefit now. The result has amount (the amount registered on chain), office_balance (the office's JPYC balance), already_received (whether this wallet has already received it), funded and claimable.",
    input_schema: {
      type: "object",
      properties: { benefit_id: { type: "string", description: "The benefit id from search_benefits" } },
      required: ["benefit_id"],
      additionalProperties: false,
    },
  },
  {
    ...ONCHAIN_TOOLS[1],
    description:
      "Read the payout transaction's receipt and its JPYC Transfer log directly from the chain, and check that the benefit amount reached this wallet from the office. The result has confirmed, block_number and transfer (from, to, amount).",
    input_schema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id from create_claim" } },
      required: ["claim_id"],
      additionalProperties: false,
    },
  },
];

type Prompt = {
  system: string;
  tools: Anthropic.Tool[];
  wallet: (address: string) => string;
  onchain: { steps: string; tools: Anthropic.Tool[] };
};

const PROMPTS: Record<Lang, Prompt> = {
  ja: {
    system: AGENT_SYSTEM,
    tools: AGENT_TOOLS,
    wallet: (a) => `ユーザーのウォレットアドレス: ${a}`,
    onchain: { steps: ONCHAIN_STEPS, tools: ONCHAIN_TOOLS },
  },
  en: {
    system: AGENT_SYSTEM_EN,
    tools: AGENT_TOOLS_EN,
    wallet: (a) => `User's wallet address: ${a}`,
    onchain: { steps: ONCHAIN_STEPS_EN, tools: ONCHAIN_TOOLS_EN },
  },
};

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

const LEAKED_TOOL_CALL = /<\/?(invoke|function_calls|parameter)\b/;

/** Occasionally the model writes the tool call as text and stops. One retry is enough in practice. */
async function createWithRetry(llm: Llm, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  let message = await llm(params);
  const leaked = message.content.some((b) => b.type === "text" && LEAKED_TOOL_CALL.test(b.text));
  if (leaked) {
    console.warn("agent: tool call leaked into text, retrying once");
    message = await llm(params);
  }
  return message;
}

export function agentRoutes(llm: Llm | null, model: string, { onchainTools = false }: { onchainTools?: boolean } = {}) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.post("/agent/v1/messages", async (c) => {
    if (!llm) return apiError(c, 503, "AGENT_UNAVAILABLE", "ANTHROPIC_API_KEY is not set");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > AGENT_MAX_BODY_BYTES) return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Conversation is too long");

    const body = await c.req.json().catch(() => null);
    if (!validMessages(body?.messages) || typeof body?.wallet_address !== "string" || !isAddress(body.wallet_address)) {
      return apiError(c, 400, "INVALID_REQUEST", "messages (starting with a user turn) and a valid wallet_address are required");
    }

    // Optional; "en" switches the prompt and tool descriptions to English, anything else keeps Japanese.
    const prompt = PROMPTS[parseLang(body.locale)];

    let message: Anthropic.Message;
    try {
      message = await createWithRetry(llm, {
        model,
        max_tokens: 4096,
        output_config: { effort: "medium" },
        system: [
          { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
          ...(onchainTools ? [{ type: "text" as const, text: prompt.onchain.steps }] : []),
          { type: "text", text: prompt.wallet(body.wallet_address) },
        ],
        tools: onchainTools ? [...prompt.tools, ...prompt.onchain.tools] : prompt.tools,
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
