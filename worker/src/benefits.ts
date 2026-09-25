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

const OFFICE = "デモ市 給付窓口";

export function listBenefits(chainId: number): Benefit[] {
  return [
    {
      id: "youth-support-2026",
      name: "若者応援給付",
      amount: "500",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: "20歳以上の方に 500 JPYC を給付します。",
      requirements: [{ type: "age_over", min_age: 20 }],
      office: OFFICE,
    },
    {
      id: "welcome-2026",
      name: "ウェルカム給付",
      amount: "100",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: "どなたでも 100 JPYC を受け取れます。",
      requirements: [],
      office: OFFICE,
    },
    {
      id: "senior-2026",
      name: "シニア給付",
      amount: "1000",
      token_symbol: "JPYC",
      chain_id: chainId,
      description: "65歳以上の方に 1000 JPYC を給付します。",
      requirements: [{ type: "age_over", min_age: 65 }],
      office: OFFICE,
      status: "unsupported",
    },
  ];
}
