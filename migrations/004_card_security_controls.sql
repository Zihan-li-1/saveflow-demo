ALTER TABLE banking_cards
  ADD COLUMN IF NOT EXISTS online_payments_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS blocked_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS alert_threshold_fen bigint;

ALTER TABLE banking_cards
  DROP CONSTRAINT IF EXISTS banking_cards_blocked_categories_array,
  ADD CONSTRAINT banking_cards_blocked_categories_array CHECK (jsonb_typeof(blocked_categories) = 'array'),
  DROP CONSTRAINT IF EXISTS banking_cards_alert_threshold_nonnegative,
  ADD CONSTRAINT banking_cards_alert_threshold_nonnegative CHECK (alert_threshold_fen IS NULL OR alert_threshold_fen > 0);
