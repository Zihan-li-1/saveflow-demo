-- A single locked document per owner keeps budgets, operations and due events
-- atomic. Bank ledger tables are not touched by this application budget store.
CREATE TABLE IF NOT EXISTS purchase_owners (
  owner_ref TEXT PRIMARY KEY CHECK (length(owner_ref) BETWEEN 1 AND 128),
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
