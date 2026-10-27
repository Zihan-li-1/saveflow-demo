-- One transfer operation may create one ledger entry for each of its two accounts.
-- The operation row remains the idempotency boundary; account-scoped entry IDs prevent
-- duplicate debit/credit rows while allowing both entries to share operation_id.
ALTER TABLE banking_transactions
  DROP CONSTRAINT IF EXISTS banking_transactions_owner_id_operation_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS banking_transactions_owner_operation_account_key
  ON banking_transactions (owner_id, operation_id, account_id)
  WHERE operation_id IS NOT NULL;
