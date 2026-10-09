CREATE TABLE IF NOT EXISTS banking_accounts (
  owner_id text NOT NULL,
  account_id text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('checking', 'saving')),
  currency text NOT NULL CHECK (currency = 'CNY'),
  balance_fen bigint NOT NULL CHECK (balance_fen >= 0),
  available_balance_fen bigint NOT NULL CHECK (available_balance_fen >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  status text NOT NULL CHECK (status IN ('active', 'frozen')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, account_id)
);

CREATE TABLE IF NOT EXISTS banking_transactions (
  owner_id text NOT NULL,
  transaction_id text NOT NULL,
  account_id text NOT NULL,
  operation_id text,
  occurred_at timestamptz NOT NULL,
  amount_fen bigint NOT NULL CHECK (amount_fen >= 0),
  record jsonb NOT NULL,
  PRIMARY KEY (owner_id, transaction_id),
  UNIQUE (owner_id, operation_id),
  FOREIGN KEY (owner_id, account_id) REFERENCES banking_accounts (owner_id, account_id)
);

CREATE INDEX IF NOT EXISTS banking_transactions_owner_time_idx
  ON banking_transactions (owner_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS banking_operations (
  owner_id text NOT NULL,
  operation_id text NOT NULL,
  action text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation_id)
);

CREATE TABLE IF NOT EXISTS banking_cards (
  owner_id text NOT NULL,
  card_id text NOT NULL,
  monthly_limit_fen bigint NOT NULL CHECK (monthly_limit_fen >= 0),
  monthly_spent_fen bigint NOT NULL CHECK (monthly_spent_fen >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  status text NOT NULL CHECK (status IN ('active', 'frozen')),
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, card_id)
);

CREATE TABLE IF NOT EXISTS banking_subscriptions (
  owner_id text NOT NULL,
  subscription_id text NOT NULL,
  mandate_id text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  status text NOT NULL CHECK (status IN ('active', 'cancelled')),
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS banking_holdings (
  owner_id text NOT NULL,
  holding_id text NOT NULL,
  account_id text NOT NULL,
  product_id text NOT NULL,
  amount_fen bigint NOT NULL CHECK (amount_fen > 0),
  acquired_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (owner_id, holding_id),
  FOREIGN KEY (owner_id, account_id) REFERENCES banking_accounts (owner_id, account_id)
);