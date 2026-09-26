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
  });

  const repository = Object.freeze({
    ...context.repository,
    async getContextInfo() {
      const [revision] = await sql.unsafe(
        `SELECT COALESCE(SUM(version), 0)::bigint + COUNT(*)::bigint AS revision FROM banking_accounts WHERE owner_id = $1`,
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
    async commitTransfer(owner, record, effect, at, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = operationRow?.record;
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== 'transfer_money' || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) {
          throw new BankingError('INVALID_STATE', '原操作未处于已确认的执行状态', true);
        }

        const [account] = await tx.unsafe(
          'SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = $2 FOR UPDATE',
          [owner, effect.fromAccountId],
        );
        if (!account || Number(account.version) !== effect.accountVersion || Number(account.balance_fen) !== effect.balanceBeforeFen) throw new BankingError('PREVIEW_STALE', '账户已变化，请重新预览并确认');
        assertFen(effect.amountFen);
        if (Number(account.available_balance_fen) < effect.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '可用余额不足');

        const balanceFen = Number(account.balance_fen) - effect.amountFen;
        const availableBalanceFen = Number(account.available_balance_fen) - effect.amountFen;
        const version = Number(account.version) + 1;
        await tx.unsafe(
          'UPDATE banking_accounts SET balance_fen = $3, available_balance_fen = $4, version = $5, updated_at = now() WHERE owner_id = $1 AND account_id = $2',
          [owner, effect.fromAccountId, balanceFen, availableBalanceFen, version],
        );
        const transaction = {
          id: `txn_${record.operationId}`, operationId: record.operationId, accountId: effect.fromAccountId,
          payeeId: effect.payeeId, occurredAt: at, type: 'transfer_out', category: '转账', merchant: effect.payeeName,
          amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution',
        };
        await tx.unsafe(
          `INSERT INTO banking_transactions (owner_id, transaction_id, account_id, operation_id, occurred_at, amount_fen, record)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [owner, transaction.id, transaction.accountId, transaction.operationId, transaction.occurredAt, transaction.amountFen, JSON.stringify(transaction)],
        );
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

export async function getConfiguredBankingCore(env = process.env) {
  if (!env.DATABASE_URL) {
    if (env.NETLIFY && env.ALLOW_EPHEMERAL_BANKING !== 'true') throw Object.assign(new Error('DATABASE_URL is required for Netlify banking persistence'), { code: 'DATABASE_NOT_CONFIGURED' });
    return bankingCore;
  }
  if (configuredCore && configuredUrl === env.DATABASE_URL) return configuredCore;
  configuredUrl = env.DATABASE_URL;
  configuredCore = createPostgresBankingCore({ connectionString: configuredUrl });
  return configuredCore;
}