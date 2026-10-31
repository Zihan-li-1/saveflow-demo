CREATE TABLE IF NOT EXISTS agent_runs (
  run_id text PRIMARY KEY,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  body jsonb NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, idempotency_key)
);
