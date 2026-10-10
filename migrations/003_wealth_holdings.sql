CREATE TABLE IF NOT EXISTS banking_wealth_holdings (
  owner_id text NOT NULL,
  holding_id text NOT NULL,
  product_id text NOT NULL,
  amount_fen bigint NOT NULL CHECK (amount_fen >= 0),
  units_milli bigint NOT NULL CHECK (units_milli >= 0),
  currency text NOT NULL CHECK (currency = 'CNY'),
  lock_until timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, holding_id),
  UNIQUE (owner_id, product_id)
);
