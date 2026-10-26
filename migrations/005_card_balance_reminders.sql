ALTER TABLE banking_cards
  ADD COLUMN IF NOT EXISTS balance_reminder_amount_fen bigint,
  ADD COLUMN IF NOT EXISTS balance_reminder_percent integer;

ALTER TABLE banking_cards
  DROP CONSTRAINT IF EXISTS banking_cards_balance_reminder_amount_check,
  DROP CONSTRAINT IF EXISTS banking_cards_balance_reminder_percent_check,
  DROP CONSTRAINT IF EXISTS banking_cards_balance_reminder_one_kind_check;

ALTER TABLE banking_cards
  ADD CONSTRAINT banking_cards_balance_reminder_amount_check CHECK (balance_reminder_amount_fen IS NULL OR balance_reminder_amount_fen BETWEEN 0 AND 10000000),
  ADD CONSTRAINT banking_cards_balance_reminder_percent_check CHECK (balance_reminder_percent IS NULL OR balance_reminder_percent BETWEEN 1 AND 100),
  ADD CONSTRAINT banking_cards_balance_reminder_one_kind_check CHECK (balance_reminder_amount_fen IS NULL OR balance_reminder_percent IS NULL);
