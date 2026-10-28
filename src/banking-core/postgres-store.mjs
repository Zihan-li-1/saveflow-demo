// @ts-check
import seed from '../data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore, bankingCore } from './core.mjs';
import { createFinancialContext } from './repository.mjs';
import { BankingError, assertFen, assertId, canonical } from './errors.mjs';
import { createWealthMockPorts } from '../skills/wealth/mock-ports.mjs';
import { DEMO_OTP_CODE } from '../lib/demo-otp.mjs';

const terminalStates = new Set(['succeeded', 'failed', 'cancelled']);
let configuredUrl;
let configuredCore;
let demoCore;
let demoCoreCode;

function fromRecord(record) {
  if (record === undefined) return undefined;
  // postgres parses JSONB itself. Older releases stored a JSON string inside
  // JSONB; decode that one legacy layer without weakening conflict checks.
  try {
    const decoded = typeof record === 'string' ? JSON.parse(record) : record;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid record');
    return structuredClone(decoded);
  } catch {
    throw new BankingError('VALIDATION_ERROR', '持久化记录格式无效，请核查数据库');
  }
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

function cardFromRow(row) {
  if (!row) return undefined;
  return { id: row.card_id, name: row.name, accountId: row.account_id, status: row.status, monthlyBudgetFen: Number(row.monthly_budget_fen), monthlySpentFen: Number(row.monthly_spent_fen), onlinePaymentsEnabled: row.online_payments_enabled !== false, blockedCategories: Array.isArray(row.blocked_categories) ? row.blocked_categories : [], alertThresholdFen: row.alert_threshold_fen === null ? null : Number(row.alert_threshold_fen), balanceReminderAmountFen: row.balance_reminder_amount_fen === null ? null : Number(row.balance_reminder_amount_fen), balanceReminderPercent: row.balance_reminder_percent === null ? null : Number(row.balance_reminder_percent), version: Number(row.version), previewGeneration: Number(row.preview_generation) };
}

/** Creates an async Postgres adapter; migrations 001 through 005 must be applied first. */
export async function createPostgresBankingCore({ connectionString, source = seed, demoOtpCode } = {}) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) throw new Error('DATABASE_URL is required');
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, { max: 1, idle_timeout: 20, connect_timeout: 10 });
  const context = createFinancialContext(source);
  const ownerId = context.ownerId;
  const staticAccounts = context.repository.getAccounts();
  const staticTransactions = context.repository.getTransactions();
  const staticCards = context.repository.getCards();
  const staticHoldings = context.getWealthHoldings();

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
        [ownerId, transaction.id, transaction.accountId, transaction.operationId ?? null, transaction.occurredAt, transaction.amountFen, tx.json(transaction)],
      );
    }
    for (const card of staticCards) {
      await tx.unsafe(
        `INSERT INTO banking_cards (owner_id, card_id, name, account_id, status, monthly_budget_fen, monthly_spent_fen, online_payments_enabled, blocked_categories, alert_threshold_fen, balance_reminder_amount_fen, balance_reminder_percent, version, preview_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14) ON CONFLICT (owner_id, card_id) DO NOTHING`,
        [ownerId, card.id, card.name, card.accountId, card.status, card.monthlyBudgetFen, card.monthlySpentFen, card.onlinePaymentsEnabled, tx.json(card.blockedCategories), card.alertThresholdFen, card.balanceReminderAmountFen, card.balanceReminderPercent, card.version, card.previewGeneration],
      );
    }
    for (const holding of staticHoldings) {
      await tx.unsafe(
        `INSERT INTO banking_wealth_holdings (owner_id, holding_id, product_id, amount_fen, units_milli, currency, lock_until, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (owner_id, holding_id) DO NOTHING`,
        [ownerId, holding.id, holding.product_id, holding.amount_fen, holding.units_milli, holding.currency, holding.lock_until, holding.version],
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
      const [cards] = await sql.unsafe('SELECT COALESCE(SUM(version), 0)::bigint AS revision FROM banking_cards WHERE owner_id = $1', [ownerId]);
      return { ...context.repository.getContextInfo(), snapshotId: `${source.datasetId}:${BigInt(revision.revision) + BigInt(cards.revision)}` };
    },
    async getAccounts() {
      const rows = await sql.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 ORDER BY account_id', [ownerId]);
      return rows.map(row => accountFromRow(row, staticAccounts.find(account => account.id === row.account_id))).filter(Boolean);
    },
    async getAccount(id) {
      const [row] = await sql.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = $2', [ownerId, id]);
      return accountFromRow(row, staticAccounts.find(account => account.id === id));
    },
    async getCards() {
      const rows = await sql.unsafe('SELECT * FROM banking_cards WHERE owner_id = $1 ORDER BY card_id', [ownerId]);
      return rows.map(cardFromRow);
    },
    async getCard(id) {
      const [row] = await sql.unsafe('SELECT * FROM banking_cards WHERE owner_id = $1 AND card_id = $2', [ownerId, id]);
      return cardFromRow(row);
    },
    async getTransactions(filter = {}) {
      const clauses = ['owner_id = $1'];
      const params = [ownerId];
      if (filter.accountId) { params.push(filter.accountId); clauses.push(`account_id = $${params.length}`); }
      if (filter.month || filter.startDate || filter.endDate) {
        params.push(filter.timezone ?? 'Asia/Shanghai');
        const localDay = `(occurred_at AT TIME ZONE $${params.length})::date`;
        if (filter.month) { params.push(filter.month); clauses.push(`to_char(${localDay}, 'YYYY-MM') = $${params.length}`); }
        if (filter.startDate) { params.push(filter.startDate); clauses.push(`${localDay} >= $${params.length}::date`); }
        if (filter.endDate) { params.push(filter.endDate); clauses.push(`${localDay} <= $${params.length}::date`); }
      }
      const rows = await sql.unsafe(`SELECT record FROM banking_transactions WHERE ${clauses.join(' AND ')} ORDER BY occurred_at, transaction_id`, params);
      return rows.map(row => fromRecord(row.record));
    },
  });

  const wealthPorts = createWealthMockPorts({
    getHoldings: async () => {
      const rows = await sql.unsafe('SELECT * FROM banking_wealth_holdings WHERE owner_id = $1 ORDER BY holding_id', [ownerId]);
      return rows.map(row => ({ id: row.holding_id, product_id: row.product_id, amount_fen: Number(row.amount_fen), units_milli: Number(row.units_milli), currency: row.currency, lock_until: row.lock_until ? new Date(row.lock_until).toISOString() : null, version: Number(row.version) }));
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
        const existing = fromRecord(row?.record);
        if (existing && (existing.action !== record.action || existing.fingerprint !== record.fingerprint)) throw new BankingError('IDEMPOTENCY_CONFLICT', '同一操作编号不能更改动作或参数，请先查询原操作', true);
        if (existing?.decision && record.decision && canonical({ previewHash: existing.decision.previewHash, decision: existing.decision.decision, confirmedStepIds: existing.decision.confirmedStepIds }) !== canonical({ previewHash: record.decision.previewHash, decision: record.decision.decision, confirmedStepIds: record.decision.confirmedStepIds })) throw new BankingError('IDEMPOTENCY_CONFLICT', '此操作已有不同的确认决定', true);
        if (existing?.receipt && !record.receipt) return;
        if (existing && terminalStates.has(existing.state) && !terminalStates.has(record.state)) return;
        await tx.unsafe(
          `INSERT INTO banking_operations (owner_id, operation_id, action, fingerprint, state, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (owner_id, operation_id) DO UPDATE SET action = EXCLUDED.action, fingerprint = EXCLUDED.fingerprint, state = EXCLUDED.state, record = EXCLUDED.record, updated_at = now()`,
          [owner, record.operationId, record.action, record.fingerprint, record.state, tx.json(record)],
        );
      });
    },
    async getScenarioRule(owner, ruleId) {
      assertId(owner); assertId(ruleId);
      const [row] = await sql.unsafe('SELECT record, preview_generation FROM banking_scenario_rules WHERE owner_id = $1 AND rule_id = $2', [owner, ruleId]);
      const rule = fromRecord(row?.record);
      return rule ? { ...rule, previewGeneration: Number(row.preview_generation) } : undefined;
    },
    async mutateVerification(owner, operationId, apply) {
      assertId(owner); assertId(operationId);
      return sql.begin(async tx => {
        const [row] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, operationId]);
        const existing = fromRecord(row?.record);
        if (!existing) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
        // 行锁内基于新鲜记录消费一次尝试，并发校验不会丢失 attempts 计数。
        const { error } = apply(existing);
        await tx.unsafe(
          `INSERT INTO banking_operations (owner_id, operation_id, action, fingerprint, state, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (owner_id, operation_id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
          [owner, existing.operationId, existing.action, existing.fingerprint, existing.state, tx.json(existing)],
        );
        return { error };
      });
    },
    async reserveScenarioPreview(owner, ruleId) {
      assertId(owner); assertId(ruleId);
      const [row] = await sql.unsafe('UPDATE banking_scenario_rules SET preview_generation = preview_generation + 1, updated_at = now() WHERE owner_id = $1 AND rule_id = $2 RETURNING preview_generation', [owner, ruleId]);
      if (!row) throw new BankingError('OPERATION_NOT_FOUND', '找不到可访问的场景规则');
      return Number(row.preview_generation);
    },
    async commitScenario(owner, record, effect, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = fromRecord(operationRow?.record);
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== effect.action || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) throw new BankingError('INVALID_STATE', '场景规则操作未处于已确认的执行状态', true);
        const [row] = await tx.unsafe('SELECT record, version, preview_generation FROM banking_scenario_rules WHERE owner_id = $1 AND rule_id = $2 FOR UPDATE', [owner, effect.ruleId]);
        if (effect.action === 'scenario.create_rule') {
          if (row) throw new BankingError('PREVIEW_STALE', '规则编号已存在，请重新预览');
          await tx.unsafe(
            `INSERT INTO banking_scenario_rules (owner_id, rule_id, status, version, preview_generation, record, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
            [owner, effect.ruleId, effect.after.status, effect.after.version, effect.after.previewGeneration, tx.json(effect.after), effect.after.created_at, effect.after.updated_at],
          );
        } else {
          if (!row || Number(row.version) !== effect.ruleVersion || Number(row.preview_generation) !== effect.previewGeneration) throw new BankingError('PREVIEW_STALE', '规则已变化，请重新预览并确认');
          await tx.unsafe(
            `UPDATE banking_scenario_rules SET status = $3, version = $4, preview_generation = $5, record = $6::jsonb, updated_at = $7
             WHERE owner_id = $1 AND rule_id = $2`,
            [owner, effect.ruleId, effect.after.status, effect.after.version, effect.after.previewGeneration, tx.json(effect.after), effect.after.updated_at],
          );
        }
        const receipt = makeReceipt(); persisted.receipt = receipt; persisted.state = 'succeeded';
        await tx.unsafe('UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2', [owner, record.operationId, persisted.state, tx.json(persisted)]);
        return structuredClone(receipt);
      });
    },
    async reserveCardPreview(owner, cardId) {
      return sql.begin(async tx => {
        const [row] = await tx.unsafe('UPDATE banking_cards SET preview_generation = preview_generation + 1, updated_at = now() WHERE owner_id = $1 AND card_id = $2 RETURNING preview_generation', [owner, cardId]);
        if (!row) throw new BankingError('CARD_NOT_FOUND', '当前用户无法访问该卡片');
        return Number(row.preview_generation);
      });
    },
    async commitCard(owner, record, effect, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = fromRecord(operationRow?.record);
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== effect.action || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) throw new BankingError('INVALID_STATE', '卡片操作未处于已确认的执行状态', true);
        const [card] = await tx.unsafe('SELECT * FROM banking_cards WHERE owner_id = $1 AND card_id = $2 FOR UPDATE', [owner, effect.cardId]);
        if (!card || Number(card.version) !== effect.cardVersion || Number(card.preview_generation) !== effect.previewGeneration || card.status !== effect.before.status || Number(card.monthly_budget_fen) !== effect.before.monthlyBudgetFen || card.online_payments_enabled !== effect.before.onlinePaymentsEnabled || JSON.stringify(card.blocked_categories ?? []) !== JSON.stringify(effect.before.blockedCategories) || (card.alert_threshold_fen === null ? null : Number(card.alert_threshold_fen)) !== effect.before.alertThresholdFen || (card.balance_reminder_amount_fen === null ? null : Number(card.balance_reminder_amount_fen)) !== effect.before.balanceReminderAmountFen || (card.balance_reminder_percent === null ? null : Number(card.balance_reminder_percent)) !== effect.before.balanceReminderPercent) throw new BankingError('PREVIEW_STALE', '卡片已变化，请重新预览并确认');
        await tx.unsafe('UPDATE banking_cards SET status = $3, monthly_budget_fen = $4, online_payments_enabled = $5, blocked_categories = $6::jsonb, alert_threshold_fen = $7, balance_reminder_amount_fen = $8, balance_reminder_percent = $9, version = version + 1, updated_at = now() WHERE owner_id = $1 AND card_id = $2', [owner, effect.cardId, effect.after.status, effect.after.monthlyBudgetFen, effect.after.onlinePaymentsEnabled, tx.json(effect.after.blockedCategories), effect.after.alertThresholdFen, effect.after.balanceReminderAmountFen, effect.after.balanceReminderPercent]);
        const receipt = makeReceipt();
        persisted.receipt = receipt;
        persisted.state = 'succeeded';
        await tx.unsafe('UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2', [owner, record.operationId, persisted.state, tx.json(persisted)]);
        return structuredClone(receipt);
      });
    },
    async commitWealth(owner, record, effect, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = operationRow?.record;
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== effect.action || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) throw new BankingError('INVALID_STATE', '理财操作未处于已确认的执行状态', true);
        if (effect.action === 'wealth.subscribe') {
          const [account] = await tx.unsafe('SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = $2 FOR UPDATE', [owner, effect.fundingAccountId]);
          if (!account || Number(account.version) !== effect.accountVersion || Number(account.available_balance_fen) < effect.amountFen) throw new BankingError('PREVIEW_STALE', '账户已变化，请重新预览');
          const [holding] = await tx.unsafe('SELECT * FROM banking_wealth_holdings WHERE owner_id = $1 AND product_id = $2 FOR UPDATE', [owner, effect.productId]);
          if (holding && (holding.holding_id !== effect.holdingId || Number(holding.version) !== effect.holdingVersion)) throw new BankingError('PREVIEW_STALE', '持仓已变化，请重新预览');
          if (!holding && effect.holdingVersion !== null) throw new BankingError('PREVIEW_STALE', '持仓已变化，请重新预览');
          await tx.unsafe('UPDATE banking_accounts SET balance_fen = balance_fen - $3, available_balance_fen = available_balance_fen - $3, version = version + 1, updated_at = now() WHERE owner_id = $1 AND account_id = $2', [owner, effect.fundingAccountId, effect.amountFen]);
          if (holding) await tx.unsafe('UPDATE banking_wealth_holdings SET amount_fen = amount_fen + $3, units_milli = units_milli + $4, version = version + 1, updated_at = now() WHERE owner_id = $1 AND holding_id = $2', [owner, effect.holdingId, effect.amountFen, effect.unitsMilli]);
          else await tx.unsafe('INSERT INTO banking_wealth_holdings (owner_id, holding_id, product_id, amount_fen, units_milli, currency) VALUES ($1, $2, $3, $4, $5, $6)', [owner, effect.holdingId, effect.productId, effect.amountFen, effect.unitsMilli, 'CNY']);
        } else {
          const [holding] = await tx.unsafe('SELECT * FROM banking_wealth_holdings WHERE owner_id = $1 AND holding_id = $2 FOR UPDATE', [owner, effect.holdingId]);
          if (!holding || Number(holding.version) !== effect.holdingVersion || Number(holding.amount_fen) < effect.amountFen || Number(holding.units_milli) < effect.unitsMilli) throw new BankingError('PREVIEW_STALE', '持仓已变化，请重新预览');
          await tx.unsafe('UPDATE banking_wealth_holdings SET amount_fen = amount_fen - $3, units_milli = units_milli - $4, version = version + 1, updated_at = now() WHERE owner_id = $1 AND holding_id = $2', [owner, effect.holdingId, effect.amountFen, effect.unitsMilli]);
        }
        const receipt = makeReceipt();
        persisted.receipt = receipt;
        persisted.state = 'succeeded';
        await tx.unsafe('UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2', [owner, record.operationId, persisted.state, JSON.stringify(persisted)]);
        return structuredClone(receipt);
      });
    },
    async commitTransfer(owner, record, effect, at, makeReceipt) {
      return sql.begin(async tx => {
        const [operationRow] = await tx.unsafe('SELECT record FROM banking_operations WHERE owner_id = $1 AND operation_id = $2 FOR UPDATE', [owner, record.operationId]);
        const persisted = fromRecord(operationRow?.record);
        if (!persisted) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
        if (persisted.receipt) return structuredClone(persisted.receipt);
        if (persisted.action !== 'transfer_money' || persisted.state !== 'executing' || persisted.decision?.decision !== 'confirm' || persisted.preview?.previewHash !== record.preview?.previewHash) {
          throw new BankingError('INVALID_STATE', '原操作未处于已确认的执行状态', true);
        }

        const internal = effect.kind === 'transfer_internal';
        const accountIds = internal ? [effect.fromAccountId, effect.toAccountId].sort() : [effect.fromAccountId];
        const lockedAccounts = await tx.unsafe(
          'SELECT * FROM banking_accounts WHERE owner_id = $1 AND account_id = ANY($2::text[]) ORDER BY account_id FOR UPDATE',
          [owner, accountIds],
        );
        const account = lockedAccounts.find(row => row.account_id === effect.fromAccountId);
        const target = internal ? lockedAccounts.find(row => row.account_id === effect.toAccountId) : undefined;
        if (!account || (internal ? Number(account.version) !== effect.sourceAccountVersion || Number(account.balance_fen) !== effect.sourceBalanceBeforeFen : Number(account.version) !== effect.accountVersion || Number(account.balance_fen) !== effect.balanceBeforeFen)) throw new BankingError('PREVIEW_STALE', '账户已变化，请重新预览并确认');
        if (internal && (!target || target.account_id === account.account_id || target.status !== 'active' || Number(target.version) !== effect.targetAccountVersion || Number(target.balance_fen) !== effect.targetBalanceBeforeFen)) throw new BankingError('PREVIEW_STALE', '本人转入账户已变化，请重新预览并确认');
        assertFen(effect.amountFen);
        if (Number(account.available_balance_fen) < effect.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '可用余额不足');

        const balanceFen = Number(account.balance_fen) - effect.amountFen;
        const availableBalanceFen = Number(account.available_balance_fen) - effect.amountFen;
        const version = Number(account.version) + 1;
        await tx.unsafe(
          'UPDATE banking_accounts SET balance_fen = $3, available_balance_fen = $4, version = $5, updated_at = now() WHERE owner_id = $1 AND account_id = $2',
          [owner, effect.fromAccountId, balanceFen, availableBalanceFen, version],
        );
        if (internal) {
          const targetBalanceFen = Number(target.balance_fen) + effect.amountFen;
          const targetAvailableBalanceFen = Number(target.available_balance_fen) + effect.amountFen;
          if (!Number.isSafeInteger(targetBalanceFen) || !Number.isSafeInteger(targetAvailableBalanceFen)) throw new BankingError('LIMIT_EXCEEDED', '转入后账户金额超出安全范围');
          await tx.unsafe(
            'UPDATE banking_accounts SET balance_fen = $3, available_balance_fen = $4, version = version + 1, updated_at = now() WHERE owner_id = $1 AND account_id = $2',
            [owner, effect.toAccountId, targetBalanceFen, targetAvailableBalanceFen],
          );
          const debit = { id: `txn_${record.operationId}_out`, operationId: record.operationId, accountId: effect.fromAccountId, counterpartyAccountId: effect.toAccountId, occurredAt: at, type: 'internal_transfer_out', category: '本人账户互转', merchant: effect.targetAccountName, amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution' };
          const credit = { id: `txn_${record.operationId}_in`, operationId: record.operationId, accountId: effect.toAccountId, counterpartyAccountId: effect.fromAccountId, occurredAt: at, type: 'internal_transfer_in', category: '本人账户互转', merchant: effect.accountName, amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution' };
          for (const transaction of [debit, credit]) await tx.unsafe(
            `INSERT INTO banking_transactions (owner_id, transaction_id, account_id, operation_id, occurred_at, amount_fen, record)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [owner, transaction.id, transaction.accountId, transaction.operationId, transaction.occurredAt, transaction.amountFen, tx.json(transaction)],
          );
          const receipt = makeReceipt([debit, credit]);
          persisted.receipt = receipt;
          persisted.state = 'succeeded';
          await tx.unsafe('UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2', [owner, record.operationId, persisted.state, tx.json(persisted)]);
          return structuredClone(receipt);
        }
        const transaction = {
          id: `txn_${record.operationId}`, operationId: record.operationId, accountId: effect.fromAccountId,
          payeeId: effect.payeeId, occurredAt: at, type: 'transfer_out', category: '转账', merchant: effect.payeeName,
          amountFen: effect.amountFen, currency: 'CNY', status: 'posted', source: 'mock_execution',
        };
        await tx.unsafe(
          `INSERT INTO banking_transactions (owner_id, transaction_id, account_id, operation_id, occurred_at, amount_fen, record)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [owner, transaction.id, transaction.accountId, transaction.operationId, transaction.occurredAt, transaction.amountFen, tx.json(transaction)],
        );
        const receipt = makeReceipt(transaction);
        persisted.receipt = receipt;
        persisted.state = 'succeeded';
        await tx.unsafe(
          'UPDATE banking_operations SET state = $3, record = $4::jsonb, updated_at = now() WHERE owner_id = $1 AND operation_id = $2',
          [owner, record.operationId, persisted.state, tx.json(persisted)],
        );
        return structuredClone(receipt);
      });
    },
  };

  return createBankingCore({ source, repository, store, wealthPorts, ownerId, demoOtpCode });
}

export async function getConfiguredBankingCore(env = process.env) {
  // 演示固定验证码只在本项目「本地演示」环境启用：
  //  - 本地（非 Netlify）默认允许固定码（DEMO_OTP_CODE，口头告知），无论是否连接 Core 库；
  //  - Netlify（线上）必须显式 SAVEFLOW_DEMO_OTP_ENABLED=true 才允许固定码，
  //    否则不注入固定码 → OTP 使用随机码且无投递渠道 → 校验不可能成功 → 执行能力保持关闭（安全失败）。
  const explicitDemoOtp = env.SAVEFLOW_DEMO_OTP_ENABLED === 'true';
  const localDemo = !env.NETLIFY;
  const demoOtpCode = (explicitDemoOtp || localDemo) ? (env.SAVEFLOW_DEMO_OTP_CODE || DEMO_OTP_CODE) : undefined;
  if (!env.DATABASE_URL) {
    if (env.NETLIFY && env.ALLOW_EPHEMERAL_BANKING !== 'true') throw Object.assign(new Error('DATABASE_URL is required for Netlify banking persistence'), { code: 'DATABASE_NOT_CONFIGURED' });
    if (demoOtpCode) {
      if (demoCore && demoCoreCode === demoOtpCode) return demoCore;
      demoCoreCode = demoOtpCode;
      demoCore = createBankingCore({ demoOtpCode });
      return demoCore;
    }
    return bankingCore;
  }
  if (configuredCore && configuredUrl === env.DATABASE_URL) return configuredCore;
  configuredUrl = env.DATABASE_URL;
  configuredCore = createPostgresBankingCore({ connectionString: configuredUrl, demoOtpCode });
  return configuredCore;
}
