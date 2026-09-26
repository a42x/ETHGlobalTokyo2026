export type Requirement = { type: "age_over"; min_age: number };

export type Benefit = {
  id: string;
  name: string;
  amount: string;
  token_symbol: "JPYC";
  chain_id: number;
  description: string;
  requirements: Requirement[];
  office: string;
  status?: "unsupported";
};

export type Lang = "ja" | "en";

/** "en" switches to English text; anything else (missing, "ja", unknown) keeps Japanese. */
export function parseLang(value: unknown): Lang {
  return value === "en" ? "en" : "ja";
}

type BenefitText = { name: string; description: string };

const OFFICE: Record<Lang, string> = {
  ja: "デモ市 給付窓口",
  en: "Demo City Benefit Office",
};

const TEXT: Record<string, Record<Lang, BenefitText>> = {
  "youth-support-2026": {
    ja: { name: "若者応援給付", description: "20歳以上の方に 500 JPYC を給付します。" },
    en: { name: "Youth Support Benefit", description: "500 JPYC for residents aged 20 or over." },
  },
  "welcome-2026": {
    ja: { name: "ウェルカム給付", description: "どなたでも 100 JPYC を受け取れます。" },
    en: { name: "Welcome Benefit", description: "100 JPYC for everyone." },
  },
  "senior-2026": {
    ja: { name: "シニア給付", description: "65歳以上の方に 1000 JPYC を給付します。" },
    en: { name: "Senior Benefit", description: "1,000 JPYC for residents aged 65 or over." },
  },
};

export function listBenefits(chainId: number, lang: Lang = "ja"): Benefit[] {
  return [
    {
      id: "youth-support-2026",
      name: TEXT["youth-support-2026"][lang].name,
      amount: "500",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: TEXT["youth-support-2026"][lang].description,
      requirements: [{ type: "age_over", min_age: 20 }],
      office: OFFICE[lang],
    },
    {
      id: "welcome-2026",
      name: TEXT["welcome-2026"][lang].name,
      amount: "100",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: TEXT["welcome-2026"][lang].description,
      requirements: [],
      office: OFFICE[lang],
    },
    {
      id: "senior-2026",
      name: TEXT["senior-2026"][lang].name,
      amount: "1000",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: TEXT["senior-2026"][lang].description,
      requirements: [{ type: "age_over", min_age: 65 }],
      office: OFFICE[lang],
      status: "unsupported",
    },
  ];
}

export function findBenefit(id: string, chainId: number): Benefit | undefined {
  return listBenefits(chainId).find((b) => b.id === id);
}

export function minAgeOf(benefit: Benefit): number | undefined {
  return benefit.requirements.find((r) => r.type === "age_over")?.min_age;
}
