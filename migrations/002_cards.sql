CREATE TABLE IF NOT EXISTS banking_cards (
  owner_id text NOT NULL,
  card_id text NOT NULL,
  name text NOT NULL,
  account_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'frozen')),
  monthly_budget_fen bigint NOT NULL CHECK (monthly_budget_fen >= 0),
  monthly_spent_fen bigint NOT NULL CHECK (monthly_spent_fen >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  preview_generation integer NOT NULL DEFAULT 0 CHECK (preview_generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, card_id),
  FOREIGN KEY (owner_id, account_id) REFERENCES banking_accounts (owner_id, account_id)
);
