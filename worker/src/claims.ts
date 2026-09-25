import type { Address, Hex } from "viem";

export type ClaimStatus = "pending_proof" | "verifying" | "paid" | "failed";

export type ClaimRow = {
  id: string;
  benefit_id: string;
  wallet_address: Address;
  status: ClaimStatus;
  claim_hash: Hex;
  nonce: Hex;
  reference_time: number;
  expires_at: number;
  proof_type: string | null;
  tx_hash: Hex | null;
  created_at: number;
  updated_at: number;
};

export async function insertClaim(db: D1Database, row: ClaimRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO claims (id, benefit_id, wallet_address, status, claim_hash, nonce, reference_time,
         expires_at, proof_type, tx_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.benefit_id,
      row.wallet_address,
      row.status,
      row.claim_hash,
      row.nonce,
      row.reference_time,
      row.expires_at,
      row.proof_type,
      row.tx_hash,
      row.created_at,
      row.updated_at,
    )
    .run();
}

export async function getClaim(db: D1Database, id: string): Promise<ClaimRow | null> {
  return db.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first<ClaimRow>();
}

// Compare-and-set on status so two concurrent proof submissions cannot both pay out.
export async function transition(
  db: D1Database,
  id: string,
  from: ClaimStatus[],
  to: ClaimStatus,
  now: number,
  fields: { proof_type?: string; tx_hash?: Hex } = {},
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE claims
         SET status = ?, updated_at = ?,
             proof_type = COALESCE(?, proof_type), tx_hash = COALESCE(?, tx_hash)
       WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
    )
    .bind(to, now, fields.proof_type ?? null, fields.tx_hash ?? null, id, ...from)
    .run();
  return result.meta.changes === 1;
}
