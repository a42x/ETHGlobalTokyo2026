CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  benefit_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL,
  claim_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  reference_time INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  proof_type TEXT,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_claims_wallet ON claims (wallet_address);
