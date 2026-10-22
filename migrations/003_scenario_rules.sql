CREATE TABLE IF NOT EXISTS banking_scenario_rules (
  owner_id text NOT NULL,
  rule_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL CHECK (version >= 1),
  preview_generation integer NOT NULL DEFAULT 0 CHECK (preview_generation >= 0),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, rule_id)
);

CREATE INDEX IF NOT EXISTS banking_scenario_rules_owner_status_idx
  ON banking_scenario_rules (owner_id, status, updated_at DESC);
