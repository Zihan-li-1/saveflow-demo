// @ts-check
import seed from '../data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore, bankingCore } from './core.mjs';
import { createFinancialContext } from './repository.mjs';
import { BankingError, assertFen, assertId, canonical } from './errors.mjs';

const terminalStates = new Set(['succeeded', 'failed', 'cancelled']);
let configuredUrl;
let configuredCore;

function fromRecord(record) {
  return record ? structuredClone(record) : undefined;
}

function accountFromRow(row, sourceAccount) {
  if (!sourceAccount || !row) return undefined;
  return {
    ...sourceAccount,
    balanceFen: Number(row.balance_fen),
    availableBalanceFen: Number(row.available_balance_fen),
    version: Number(row.version),
    status: row.status,
  };
}

/** Creates an async Postgres adapter; migration 001 must be applied first. */
export async function createPostgresBankingCore({ connectionString, source = seed } = {}) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) throw new Error('DATABASE_URL is required');
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, { max: 1, idle_timeout: 20, connect_timeout: 10 });
  const context = createFinancialContext(source);
  const ownerId = context.ownerId;
  const staticAccounts = context.repository.getAccounts();
  const staticTransactions = context.repository.getTransactions();

  await sql.begin(async tx => {
    for (const account of staticAccounts) {
      await tx.unsafe(
        `INSERT INTO banking_accounts (owner_id, account_id, name, account_type, currency, balance_fen, available_balance_fen, version, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (owner_id, account_id) DO NOTHING`,
        [ownerId, account.id, account.name, account.type, account.currency, account.balanceFen, account.availableBalanceFen, account.version, account.status],
      );
    }
    for (const transaction of staticTransactions) {
      await tx.unsafe(
        `INSERT INTO banking_transactions (owner_id, transaction_id, account_id, operation_id, occurred_at, amount_fen, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (owner_id, transaction_id) DO NOTHING`,
        [ownerId, transaction.id, transaction.accountId, transaction.operationId ?? null, transaction.occurredAt, transaction.amountFen, JSON.stringify(transaction)],
      );
    }
    for (const card of context.repository.getCards()) {
      await tx.unsafe(
        `INSERT INTO banking_cards (owner_id, card_id, monthly_limit_fen, monthly_spent_fen, version, status, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (owner_id, card_id) DO NOTHING`,
        [ownerId, card.id, card.monthlyLimitFen, card.monthlySpentFen, card.version, card.status, JSON.stringify(card)],
      );
    }
    for (const subscription of context.repository.getSubscriptions()) {
      await tx.unsafe(
        `INSERT INTO banking_subscriptions (owner_id, subscription_id, mandate_id, version, status, record)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (owner_id, subscription_id) DO NOTHING`,
        [ownerId, subscription.id, subscription.mandateId, subscription.version, subscription.status, JSON.stringify(subscription)],
      );
    }
  });

  const repository = Object.freeze({
    ...context.repository,
    async getContextInfo() {
      const [revision] = await sql.unsafe(
        `SELECT (SELECT COALESCE(SUM(version), 0)::bigint + COUNT(*)::bigint FROM banking_accounts WHERE owner_id = $1)
          + (SELECT COALESCE(SUM(version), 0)::bigint FROM banking_cards WHERE owner_id = $1)
          + (SELECT COALESCE(SUM(version), 0)::bigint FROM banking_subscriptions WHERE owner_id = $1) AS revision`,
        [ownerId],
      );
      return { ...context.repository.getContextInfo(), snapshotId: `${source.datasetId}:${revision.revision}` };
    },
    async getAccounts() {
      const rows = await sql.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 ORDER BY account_id', [ownerId]);
      return rows.map(row => accountFromRow(row, staticAccounts.find(account => account.id === row.account_id))).filter(Boolean);
    },
    async getAccount(id) {
      const [row] = await sql.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = $2', [ownerId, id]);
      return accountFromRow(row, staticAccounts.find(account => account.id === id));
    },
    async getTransactions(filter = {}) {
      const clauses = ['owner_id = $1'];
      const params = [ownerId];
      if (filter.accountId) { params.push(filter.accountId); clauses.push(`account_id = $${params.length}`); }
      if (filter.month) { params.push(`${filter.month}-%`); clauses.push(`record->>'occurredAt' LIKE $${params.length}`); }
      const rows = await sql.unsafe(`SELECT record FROM banking_transactions WHERE ${clauses.join(' AND ')} ORDER BY occurred_at, transaction_id`, params);
      return rows.map(row => structuredClone(row.record));
    },
    async getCards() {
      const rows = await sql.unsafe('SELECT record FROM banking_cards WHERE owner_id = $1 ORDER BY card_id', [ownerId]);
      return rows.map(row => structuredClone(row.record));
    },
    async getSubscriptions() {
      const rows = await sql.unsafe('SELECT record FROM banking_subscriptions WHERE owner_id = $1 ORDER BY subscription_id', [ownerId]);
      return rows.map(row => structuredClone(row.record));
    },
    async getHoldings() {
      const rows = await sql.unsafe('SELECT record FROM banking_holdings WHERE owner_id = $1 ORDER BY acquired_at, holding_id', [ownerId]);
      return rows.map(row => structuredClone(row.record));
    },
  });

  const store = {
    async close() { await sql.end({ timeout: 5 }); },
    fingerprint(action, input) { return canonical({ action, input }); },
    async get(owner, operationId) {
      assertId(owner); assertId(operationId);
      const [row] = await sql.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2', [owner, operationId]);
      return fromRecord(row?.record);
    },
    async put(owner, record) {
      assertId(owner); assertId(record.operationId);
      await sql.begin(async tx => {
        const [row] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const existing = row?.record;
        if (existing && (existing.action !== record.action || existing.fingerprint !== record.fingerprint)) throw new BankingError('IDEMPOTENCY_CONFLICT', '同一操作编号不能更改动作或参数，请先查询原操作', true);
        if (existing?.decision && record.decision && canonical({ previewHash: existing.decision.previewHash, decision: existing.decision.decision, confirmedStepIds: existing.decision.confirmedStepIds }) !== canonical({ previewHash: record.decision.previewHash, decision: record.decision.decision, confirmedStepIds: record.decision.confirmedStepIds })) throw new BankingError('IDEMPOTENCY_CONFLICT', '此操作已有不同的确认决定', true);
        if (existing?.receipt && !record.receipt) return;
        if (existing && terminalStates.has(existing.state) && !terminalStates.has(record.state)) return;
        await tx.unsafe(
          `INSERT INTO banking_operations (owner_id, operation_id, action, fingerprint, state, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (owner_id, operation_id) DO UPDATE SET action = EXCLUDED.action, fingerprint = EXCLUDED.fingerprint, state = EXCLUDED.state, record = EXCLUDED.record, updated_at = now()`,
          [owner, record.operationId, record.action, record.fingerprint, record.state, JSON.stringify(record)],
        );
      });
    },
    async commitAction(owner, record, effect, at, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = operationRow?.record;
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== record.action || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) {
          throw new BankingError('INVALID_STATE', '原操作未处于已确认的执行状态', true);
        }
        let transaction;
        if (effect.kind === 'card_limit_change') {
          const [row] = await tx.unsafe('SELECT * FROM banking_cards WHERE owner_id = $1 AND card_id = $2 FOR UPDATE', [owner, effect.cardId]);
          const card = row?.record;
          if (!card || Number(row.version) !== effect.version || Number(row.monthly_limit_fen) !== effect.monthlyLimitBeforeFen || Number(row.monthly_spent_fen) !== effect.monthlySpentFen || row.status !== 'active') throw new BankingError('PREVIEW_STALE', '卡片状态已变化，请重新预览并确认');
          card.monthlyLimitFen = effect.monthlyLimitAfterFen;
          card.version = Number(row.version) + 1;
          await tx.unsafe('UPDATE banking_cards SET monthly_limit_fen = $3, version = $4, record = $5::jsonb, updated_at = now() WHERE owner_id = $1 AND card_id = $2', [owner, effect.cardId, effect.monthlyLimitAfterFen, card.version, JSON.stringify(card)]);
        } else if (effect.kind === 'subscription_cancel') {
          const [row] = await tx.unsafe('SELECT * FROM banking_subscriptions WHERE owner_id = $1 AND subscription_id = $2 FOR UPDATE', [owner, effect.subscriptionId]);
          const subscription = row?.record;
          if (!subscription || Number(row.version) !== effect.version || row.mandate_id !== effect.mandateId || row.status !== 'active') throw new BankingError('PREVIEW_STALE', '代扣授权状态已变化，请重新查询');
          subscription.status = 'cancelled';
          subscription.mandateId = null;
          subscription.version = Number(row.version) + 1;
          await tx.unsafe('UPDATE banking_subscriptions SET mandate_id = NULL, status = $3, version = $4, record = $5::jsonb, updated_at = now() WHERE owner_id = $1 AND subscription_id = $2', [owner, effect.subscriptionId, subscription.status, subscription.version, JSON.stringify(subscription)]);
        } else {
          const accountId = effect.fromAccountId;
          const [account] = await tx.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = $2 FOR UPDATE', [owner, accountId]);
          if (!account || Number(account.version) !== effect.accountVersion || Number(account.balance_fen) !== effect.balanceBeforeFen) throw new BankingError('PREVIEW_STALE', '账户已变化，请重新预览并确认');
          assertFen(effect.amountFen);
          if (Number(account.available_balance_fen) < effect.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '可用余额不足');
          const balanceFen = Number(account.balance_fen) - effect.amountFen;
          const availableBalanceFen = Number(account.available_balance_fen) - effect.amountFen;
          await tx.unsafe('UPDATE banking_accounts SET balance_fen = $3, available_balance_fen = $4, version = version + 1, updated_at = now() WHERE owner_id = $1 AND account_id = $2', [owner, accountId, balanceFen, availableBalanceFen]);
          if (effect.kind === 'investment_purchase') {
            transaction = { id: `txn_${record.operationId}`, operationId: record.operationId, accountId, occurredAt: at, type: 'investment_purchase', category: '理财申购', merchant: effect.productName, amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution' };
            const holding = { id: effect.holdingId, accountId, productId: effect.productId, amountFen: effect.amountFen, acquiredAt: at, status: 'active' };
            await tx.unsafe('INSERT INTO banking_holdings (owner_id, holding_id, account_id, product_id, amount_fen, acquired_at, record) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)', [owner, holding.id, holding.accountId, holding.productId, holding.amountFen, holding.acquiredAt, JSON.stringify(holding)]);
          } else {
            transaction = { id: `txn_${record.operationId}`, operationId: record.operationId, accountId, payeeId: effect.payeeId, occurredAt: at, type: 'transfer_out', category: '转账', merchant: effect.payeeName, amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution' };
          }
          await tx.unsafe('INSERT INTO banking_transactions (owner_id, transaction_id, account_id, operation_id, occurred_at, amount_fen, record) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)', [owner, transaction.id, transaction.accountId, transaction.operationId, transaction.occurredAt, transaction.amountFen, JSON.stringify(transaction)]);
        }
        const receipt = makeReceipt(transaction);
        persisted.receipt = receipt;
        persisted.state = 'succeeded';
        await tx.unsafe(
          'UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2',
          [owner, record.operationId, persisted.state, JSON.stringify(persisted)],
        );
        return structuredClone(receipt);
      });
    },
  };

  return createBankingCore({ source, repository, store, ownerId });
}

export async function getConfiguredBankingCore(env = process.env, createCore = createPostgresBankingCore) {
  if (!env.DATABASE_URL) {
    if (env.NETLIFY && env.ALLOW_EPHEMERAL_BANKING !== 'true') throw Object.assign(new Error('DATABASE_URL is required for Netlify banking persistence'), { code: 'DATABASE_NOT_CONFIGURED' });
    return bankingCore;
  }
  if (configuredCore && configuredUrl === env.DATABASE_URL) return configuredCore;
  const connectionString = env.DATABASE_URL;
  const pending = Promise.resolve().then(() => createCore({ connectionString }));
  configuredUrl = connectionString;
  configuredCore = pending;
  try {
    return await pending;
  } catch (error) {
    if (configuredCore === pending) {
      configuredCore = undefined;
      configuredUrl = undefined;
    }
    throw error;
  }
}