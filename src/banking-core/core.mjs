// @ts-check
import { createFinancialContext } from './repository.mjs';
import { BankingError, assertFen, assertId, canonical } from './errors.mjs';
import { OperationStore } from './operation-store.mjs';
import { canTransitionAction, transitionAction } from './action-machine.mjs';

/** @param {unknown} input @returns {import('./contracts').TransferInput} */
function validateTransfer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BankingError('VALIDATION_ERROR', '转账参数无效');
  const body = /** @type {Record<string, unknown>} */ (input);
  if (Object.keys(body).some(k => !['fromAccountId', 'payeeId', 'amountFen', 'currency', 'memo'].includes(k))) throw new BankingError('VALIDATION_ERROR', '转账包含未注册字段');
  assertId(body.fromAccountId, '付款账户'); assertId(body.payeeId, '收款人'); assertFen(body.amountFen);
  if (body.currency !== 'CNY') throw new BankingError('VALIDATION_ERROR', '当前 Mock 仅支持显式 CNY 币种');
  if (body.memo !== undefined && (typeof body.memo !== 'string' || body.memo.length > 140)) throw new BankingError('VALIDATION_ERROR', '备注最多 140 字');
  return { fromAccountId: body.fromAccountId, payeeId: body.payeeId, amountFen: body.amountFen, currency: 'CNY', memo: /** @type {string} */ (body.memo ?? '') };
}

/** @param {import('./contracts').ActionKind} action @param {unknown} value @returns {import('./contracts').ActionRequest['input']} */
function validateActionInput(action, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BankingError('VALIDATION_ERROR', '操作参数无效');
  const input = /** @type {Record<string, unknown>} */ (value);
  if (action === 'transfer_money') return validateTransfer(input);
  if (action === 'card.set_limit') {
    if (Object.keys(input).some(key => !['cardId', 'monthlyLimitFen'].includes(key))) throw new BankingError('VALIDATION_ERROR', '调额包含未注册字段');
    assertId(input.cardId, '卡片'); assertFen(input.monthlyLimitFen);
    return { cardId: input.cardId, monthlyLimitFen: input.monthlyLimitFen };
  }
  if (action === 'subscription.cancel_debit') {
    if (Object.keys(input).some(key => key !== 'subscriptionId')) throw new BankingError('VALIDATION_ERROR', '解除代扣包含未注册字段');
    assertId(input.subscriptionId, '订阅');
    return { subscriptionId: input.subscriptionId };
  }
  if (action === 'wealth.subscribe') {
    if (Object.keys(input).some(key => !['fromAccountId', 'productId', 'amountFen', 'currency'].includes(key))) throw new BankingError('VALIDATION_ERROR', '理财申购包含未注册字段');
    assertId(input.fromAccountId, '付款账户'); assertId(input.productId, '理财产品'); assertFen(input.amountFen);
    if (input.currency !== 'CNY') throw new BankingError('VALIDATION_ERROR', '当前 Mock 仅支持显式 CNY 币种');
    return { fromAccountId: input.fromAccountId, productId: input.productId, amountFen: input.amountFen, currency: 'CNY' };
  }
  throw new BankingError('UNKNOWN_ACTION', '当前写操作未注册');
}

/** @typedef {Pick<OperationStore, 'get'|'put'|'fingerprint'> & {close?: () => Promise<void>, commitAction?: (owner: string, record: import('./contracts').OperationRecord, effect: import('./contracts').ActionEffect, at: string, makeReceipt: (result?: import('./contracts').Transaction) => import('./contracts').ActionReceipt) => Promise<import('./contracts').ActionReceipt>}} BankingStore */

/** One isolated Mock banking session. Never feed model output to decide()/execute().
 * Future write actions must use this engine and a transaction adapter, not per-Skill Maps.
 * @param {{source?: Parameters<typeof createFinancialContext>[0], now?: () => number, store?: BankingStore, repository?: import('./contracts').FinancialContextRepository, ownerId?: string, policy?: {version: string, maxTransferFen: number, previewTtlMs: number}}} [options] */
export function createBankingCore(options = {}) {
  const context = createFinancialContext(options.source);
  const repository = options.repository ?? context.repository;
  const commitAction = context.commitAction;
  const ownerId = options.ownerId ?? context.ownerId;
  const store = /** @type {BankingStore} */ (options.store ?? new OperationStore());
  const now = options.now ?? Date.now;
  const policy = Object.freeze({ version: 'mock-transfer-v1', maxTransferFen: 10000000, previewTtlMs: 300000, ...options.policy });
  assertFen(policy.maxTransferFen); assertFen(policy.previewTtlMs);
  /** @type {import('./contracts').AuditEvent[]} */
  const audit = [];
  /** @type {Map<string, Promise<import('./contracts').ActionResult<import('./contracts').ActionReceipt>>>} */
  const executions = new Map();
  /** @param {import('./contracts').OperationRecord} record */
  async function save(record) {
    await store.put(ownerId, record);
    audit.push({ operationId: record.operationId, action: record.action, state: record.state, at: new Date(now()).toISOString(), ...(record.error ? { errorCode: record.error.code } : {}) });
  }
  /** @param {import('./contracts').OperationRecord} record @param {string} event */
  async function move(record, event) {
    if (!canTransitionAction(record.state, event)) throw new BankingError('INVALID_STATE', '当前状态不允许此操作');
    record.state = transitionAction(record.state, event); await save(record);
  }
  /** @param {string} id */
  async function lookup(id) {
    const record = await store.get(ownerId, id);
    if (!record) throw new BankingError('OPERATION_NOT_FOUND', '未取得此操作的记录，请保留原编号继续核实', true);
    return record;
  }
  /** @param {unknown} error @returns {import('./contracts').ActionError} */
  function errorData(error) {
    return error instanceof BankingError ? error.toJSON() : new BankingError('INTERNAL_ERROR', '未取得可靠结果，请查询原操作', true).toJSON();
  }
  /** @template T @param {() => T | Promise<T>} run @param {string} [operationId] @returns {Promise<import('./contracts').ActionResult<T>>} */
  async function guard(run, operationId) {
    try { return { ok: true, data: await run() }; }
    catch (error) { return { ok: false, error: errorData(error), ...(operationId ? { operationId } : {}) }; }
  }
  /** @param {import('./contracts').ActionKind} action @param {unknown} value @returns {Promise<import('./contracts').RiskResult>} */
  async function riskCheck(action, value) {
    const result = await guard(async () => {
      const input = validateActionInput(action, value);
      if (action === 'transfer_money') {
        const transfer = /** @type {import('./contracts').TransferInput} */ (input);
        const account = await repository.getAccount(transfer.fromAccountId);
        const payee = await repository.getPayee(transfer.payeeId);
        if (!account) throw new BankingError('ACCOUNT_NOT_FOUND', '找不到可访问的付款账户');
        if (!payee) throw new BankingError('PAYEE_NOT_FOUND', '找不到收款人，请先完成实体解析');
        if (account.status !== 'active') throw new BankingError('ACCOUNT_BLOCKED', '付款账户当前不可用');
        if (payee.status !== 'active') throw new BankingError('PAYEE_BLOCKED', '收款人当前不可用');
        if (account.availableBalanceFen < transfer.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '付款账户可用余额不足');
        if (transfer.amountFen > policy.maxTransferFen) throw new BankingError('LIMIT_EXCEEDED', '超过 Mock 单笔转账限额');
      } else if (action === 'card.set_limit') {
        const cardInput = /** @type {import('./contracts').CardLimitInput} */ (input);
        const card = (await repository.getCards()).find(item => item.id === cardInput.cardId);
        if (!card) throw new BankingError('CARD_NOT_FOUND', '找不到卡片');
        if (card.status !== 'active') throw new BankingError('CARD_BLOCKED', '卡片当前不可用');
        if (cardInput.monthlyLimitFen < card.monthlySpentFen) throw new BankingError('LIMIT_EXCEEDED', '新额度不能低于本月已用金额');
      } else if (action === 'subscription.cancel_debit') {
        const cancelInput = /** @type {import('./contracts').CancelSubscriptionInput} */ (input);
        const subscription = (await repository.getSubscriptions()).find(item => item.id === cancelInput.subscriptionId);
        if (!subscription) throw new BankingError('SUBSCRIPTION_NOT_FOUND', '找不到订阅');
        if (subscription.status !== 'active' || !subscription.mandateId) throw new BankingError('INVALID_STATE', '此订阅没有可解除的模拟代扣授权');
      } else if (action === 'wealth.subscribe') {
        const purchase = /** @type {import('./contracts').InvestmentPurchaseInput} */ (input);
        const account = await repository.getAccount(purchase.fromAccountId);
        const product = (await repository.getInvestmentProducts()).find(item => item.id === purchase.productId);
        if (!account) throw new BankingError('ACCOUNT_NOT_FOUND', '找不到可访问的付款账户');
        if (account.status !== 'active') throw new BankingError('ACCOUNT_BLOCKED', '付款账户当前不可用');
        if (!product) throw new BankingError('PRODUCT_NOT_FOUND', '找不到理财产品');
        if (!product.isSynthetic || product.currency !== 'CNY') throw new BankingError('ACTION_UNSUPPORTED', '仅支持明确标记的合成演示产品');
        if (purchase.amountFen < product.minimumAmountFen) throw new BankingError('LIMIT_EXCEEDED', '申购金额低于产品起购金额');
        if (account.availableBalanceFen < purchase.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '可用余额不足');
      }
      return true;
    });
    const riskLevel = action === 'card.set_limit' || action === 'subscription.cancel_debit' ? 'L2' : 'L3';
    return { allowed: result.ok, riskLevel, policyVersion: `${policy.version}:${action}`, requiredConfirmation: 'mock_explicit', warnings: [action === 'wealth.subscribe' ? '合成理财产品模拟申购，不构成投资建议或真实交易。' : '合成数据模拟操作，不接真实银行；此确认仅用于 Mock。'], ...(!result.ok ? { error: result.error } : {}) };
  }
  /** @param {import('./contracts').ActionKind} action @param {unknown} value @param {string} operationId @returns {Promise<import('./contracts').ActionEffect>} */
  async function effectFor(action, value, operationId) {
    const input = validateActionInput(action, value);
    if (action === 'transfer_money') {
      const transfer = /** @type {import('./contracts').TransferInput} */ (input);
      const account = await repository.getAccount(transfer.fromAccountId);
      const payee = await repository.getPayee(transfer.payeeId);
      if (!account || !payee) throw new BankingError('PREVIEW_STALE', '账户或收款人已失效');
      return { kind: 'transfer_out', fromAccountId: account.id, accountName: account.name, payeeId: payee.id, payeeName: payee.name, accountNoMasked: payee.accountNoMasked, amountFen: transfer.amountFen, feeFen: 0, currency: 'CNY', balanceBeforeFen: account.balanceFen, balanceAfterFen: account.balanceFen - transfer.amountFen, availableBalanceAfterFen: account.availableBalanceFen - transfer.amountFen, accountVersion: account.version, memo: transfer.memo ?? '', arrival: 'mock_immediate' };
    }
    if (action === 'card.set_limit') {
      const cardInput = /** @type {import('./contracts').CardLimitInput} */ (input);
      const card = (await repository.getCards()).find(item => item.id === cardInput.cardId);
      if (!card) throw new BankingError('PREVIEW_STALE', '卡片已不可用');
      return { kind: 'card_limit_change', cardId: card.id, cardName: card.name, monthlyLimitBeforeFen: card.monthlyLimitFen, monthlyLimitAfterFen: cardInput.monthlyLimitFen, monthlySpentFen: card.monthlySpentFen, version: card.version };
    }
    if (action === 'subscription.cancel_debit') {
      const cancelInput = /** @type {import('./contracts').CancelSubscriptionInput} */ (input);
      const subscription = (await repository.getSubscriptions()).find(item => item.id === cancelInput.subscriptionId);
      if (!subscription?.mandateId) throw new BankingError('PREVIEW_STALE', '模拟代扣授权已不可用');
      return { kind: 'subscription_cancel', subscriptionId: subscription.id, subscriptionName: subscription.name, mandateId: subscription.mandateId, monthlyFeeFen: subscription.monthlyFeeFen, version: subscription.version };
    }
    const purchase = /** @type {import('./contracts').InvestmentPurchaseInput} */ (input);
    const account = await repository.getAccount(purchase.fromAccountId);
    const product = (await repository.getInvestmentProducts()).find(item => item.id === purchase.productId);
    if (!account || !product) throw new BankingError('PREVIEW_STALE', '账户或理财产品已不可用');
    return { kind: 'investment_purchase', fromAccountId: account.id, accountName: account.name, productId: product.id, productName: product.name, amountFen: purchase.amountFen, currency: 'CNY', balanceBeforeFen: account.balanceFen, balanceAfterFen: account.balanceFen - purchase.amountFen, availableBalanceAfterFen: account.availableBalanceFen - purchase.amountFen, accountVersion: account.version, riskLevel: product.riskLevel, liquidity: product.liquidity, holdingId: `holding_${operationId}` };
  }
  /** @param {import('./contracts').OperationRecord} record @param {'succeeded'|'failed'|'cancelled'} status @param {string} message @param {string[]} [transactionIds] @returns {import('./contracts').ActionReceipt} */
  function receiptFor(record, status, message, transactionIds = []) {
    return { receiptId: `receipt_${record.operationId}`, operationId: record.operationId, action: record.action, planId: record.request?.planId ?? record.operationId, stepId: record.request?.stepId ?? 'legacy_plan', status, message, executedAt: new Date(now()).toISOString(), dataSource: 'synthetic_demo_only', transactionIds, effects: status === 'succeeded' ? structuredClone(record.preview?.exactEffects ?? []) : [], ...(record.error ? { error: record.error } : {}) };
  }
  /** @param {import('./contracts').OperationRecord} record @param {import('./contracts').ActionError} error */
  async function fail(record, error) {
    record.error = error;
    if (error.uncertain) { record.state = 'unknown'; await save(record); }
    else { record.receipt = receiptFor(record, 'failed', error.message); await move(record, 'FAILED'); }
  }
  /** @param {import('./contracts').OperationRecord} record @param {string} hash */
  function verifyHash(record, hash) {
    if (!record.preview || hash !== record.preview.previewHash) throw new BankingError('CONFIRMATION_INVALID', '确认内容与原预览不匹配');
  }
  /** Recheck at confirmation AND immediately before execution. @param {import('./contracts').OperationRecord} record */
  async function recheck(record) {
    if (record.action === 'legacy.create-plan' || !record.preview || !record.request) throw new BankingError('INVALID_STATE', '操作尚未生成预览');
    const action = record.action;
    if (now() >= Date.parse(record.preview.expiresAt)) throw new BankingError('PREVIEW_EXPIRED', '预览已过期，请重新预览并确认');
    const risk = await riskCheck(action, record.request.input);
    if (!risk.allowed && risk.error) throw new BankingError(risk.error.code, risk.error.message);
    if (risk.policyVersion !== record.risk?.policyVersion || canonical(record.preview.exactEffects[0]) !== canonical(await effectFor(action, record.request.input, record.operationId))) throw new BankingError('PREVIEW_STALE', '账户、业务对象或风险条件已变化，请重新预览并确认');
  }
  /** @param {import('./contracts').OperationRecord} record @returns {import('./contracts').OperationStatus} */
  function statusFor(record) {
    return { operationId: record.operationId, state: record.state, status: record.receipt?.status ?? 'pending', ...(record.receipt ? { receipt: record.receipt } : {}), ...(record.preview ? { preview: record.preview } : {}), ...(record.error ? { error: record.error } : {}) };
  }

  return Object.freeze({
    repository,
    close: async () => { if (typeof store.close === 'function') await store.close(); },
    riskCheck,
    /** @param {import('./contracts').ActionRequest} request @returns {Promise<import('./contracts').ActionResult<import('./contracts').PreparedAction>>} */
    async prepare(request) {
      const operationId = `op_${crypto.randomUUID()}`;
      /** @type {import('./contracts').OperationRecord | undefined} */
      let record;
      try {
        if (!request || !['transfer_money', 'card.set_limit', 'subscription.cancel_debit', 'wealth.subscribe'].includes(request.action)) throw new BankingError('UNKNOWN_ACTION', '当前写操作未注册');
        if (Object.keys(request).some(k => !['action', 'input', 'planId', 'stepId', 'origin'].includes(k))) throw new BankingError('VALIDATION_ERROR', '不接受模型提供的风险等级或确认标记');
        const action = /** @type {import('./contracts').ActionKind} */ (request.action);
        const input = validateActionInput(action, request.input);
        const planId = request.planId ?? `plan_${crypto.randomUUID()}`;
        const stepId = request.stepId ?? `step_${crypto.randomUUID()}`;
        assertId(planId); assertId(stepId);
        const origin = request.origin ?? 'user_requested';
        if (!['user_requested', 'agent_suggested', 'event_triggered'].includes(origin)) throw new BankingError('VALIDATION_ERROR', '操作来源无效');
        const actionRequest = /** @type {import('./contracts').ActionRequest} */ ({ action, input, planId, stepId, origin });
        record = { operationId, action, fingerprint: store.fingerprint(action, input), state: 'preparing', request: actionRequest };
        await save(record); await move(record, 'PREPARED');
        const risk = await riskCheck(action, input); record.risk = risk;
        if (!risk.allowed && risk.error) throw new BankingError(risk.error.code, risk.error.message);
        const effect = await effectFor(action, input, operationId);
        const expiresAt = new Date(now() + policy.previewTtlMs).toISOString();
        const contextSnapshotId = (await repository.getContextInfo()).snapshotId;
        const hashInput = canonical({ ownerId, operationId, planId, stepId, origin, effect, expiresAt, contextSnapshotId, policy });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
        const previewHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        const summary = effect.kind === 'transfer_out'
          ? `从${effect.accountName}向${effect.payeeName}（${effect.accountNoMasked}）模拟转账 ¥${(effect.amountFen / 100).toFixed(2)}，手续费 ¥0.00，模拟即时到账。`
          : effect.kind === 'card_limit_change'
            ? `将${effect.cardName}月度限额从 ¥${(effect.monthlyLimitBeforeFen / 100).toFixed(2)} 调整为 ¥${(effect.monthlyLimitAfterFen / 100).toFixed(2)}。`
            : effect.kind === 'subscription_cancel'
              ? `解除「${effect.subscriptionName}」模拟银行代扣授权，预计停止后续每月 ¥${(effect.monthlyFeeFen / 100).toFixed(2)} 的模拟扣款；不代表商户会员已取消。`
              : `从${effect.accountName}模拟申购「${effect.productName}」¥${(effect.amountFen / 100).toFixed(2)}；风险等级 ${effect.riskLevel}，流动性 ${effect.liquidity}。`;
        record.preview = { planId, stepIds: [stepId], summary, exactEffects: [effect], riskLevel: risk.riskLevel, warnings: risk.warnings, expiresAt, previewHash, contextSnapshotId };
        await move(record, 'PREVIEWED');
        return { ok: true, data: { operationId, state: 'awaiting_confirmation', preview: structuredClone(record.preview), risk: structuredClone(risk) } };
      } catch (error) {
        const data = errorData(error);
        if (record) await fail(record, data);
        return { ok: false, operationId, error: data };
      }
    },
    /** Authenticated UI adapter only; a bare confirmed:true is never accepted.
     * @param {string} operationId @param {import('./contracts').DecisionInput} decision */
    async decide(operationId, decision) {
      return guard(async () => {
        const record = await lookup(operationId);
        if (!decision || Object.keys(decision).some(k => !['previewHash', 'decision', 'confirmedStepIds'].includes(k))) throw new BankingError('CONFIRMATION_INVALID', '需要针对具体预览进行确认');
        verifyHash(record, decision.previewHash);
        if (!record.preview) throw new BankingError('INVALID_STATE', '缺少预览');
        if (!['confirm', 'reject'].includes(decision.decision) || !Array.isArray(decision.confirmedStepIds) || canonical(decision.confirmedStepIds) !== canonical(decision.decision === 'confirm' ? record.preview?.stepIds : [])) throw new BankingError('CONFIRMATION_INVALID', '确认必须覆盖预览中的精确步骤；取消时步骤列表须为空');
        if (record.decision && canonical({ previewHash: record.decision.previewHash, decision: record.decision.decision, confirmedStepIds: record.decision.confirmedStepIds }) === canonical(decision)) return statusFor(record);
        if (!['awaiting_confirmation', 'confirmed'].includes(record.state)) throw new BankingError('INVALID_STATE', '操作不能再次确认或取消，请查询原结果');
        if (decision.decision === 'confirm') {
          try { await recheck(record); } catch (error) { await fail(record, errorData(error)); throw error; }
        }
        record.decision = { ...structuredClone(decision), planId: record.preview.planId, confirmationMethod: 'mock_explicit', idempotencyKey: operationId, decidedAt: new Date(now()).toISOString() };
        if (decision.decision === 'reject') record.receipt = receiptFor(record, 'cancelled', '已取消模拟转账，未扣款');
        await move(record, decision.decision === 'confirm' ? 'CONFIRM' : 'CANCEL');
        return statusFor(record);
      }, operationId);
    },
    /** Only stored, confirmed parameters execute. There is deliberately no input/amount argument.
     * @param {string} operationId @param {string} previewHash */
    execute(operationId, previewHash) {
      const running = executions.get(operationId);
      if (running) return running;
      const execution = guard(async () => {
        const record = await lookup(operationId);
        if (!['transfer_money', 'card.set_limit', 'subscription.cancel_debit', 'wealth.subscribe'].includes(record.action)) throw new BankingError('UNKNOWN_ACTION', '此执行入口不支持该动作');
        verifyHash(record, previewHash);
        if (!record.preview) throw new BankingError('INVALID_STATE', '缺少预览');
        if (record.receipt) return record.receipt;
        if (['executing', 'unknown', 'checking'].includes(record.state)) throw new BankingError('INVALID_STATE', '操作结果待核实，只能查询原编号', true);
        if (record.state !== 'confirmed' || record.decision?.decision !== 'confirm') throw new BankingError('CONFIRMATION_REQUIRED', '需要先确认当前精确预览');
        try {
          await recheck(record); await move(record, 'EXECUTE');
          const at = new Date(now()).toISOString();
          if (typeof store.commitAction === 'function') {
            record.receipt = await store.commitAction(ownerId, record, record.preview.exactEffects[0], at, result => receiptFor(record, 'succeeded', '模拟操作成功', result ? [result.id] : []));
            record.state = transitionAction(record.state, 'SUCCEEDED');
            audit.push({ operationId: record.operationId, action: record.action, state: record.state, at: new Date(now()).toISOString() });
          } else {
            const result = await commitAction(record.preview.exactEffects[0], operationId, at);
            record.receipt = receiptFor(record, 'succeeded', '模拟操作成功', result ? [result.id] : []);
            await move(record, 'SUCCEEDED');
          }
          return record.receipt;
        } catch (error) { await fail(record, errorData(error)); throw error; }
      }, operationId);
      executions.set(operationId, execution);
      return execution.finally(() => executions.delete(operationId));
    },
    /** Missing records stay pending; never infer that no debit happened. @param {string} operationId */
    getOperation(operationId) {
      return guard(async () => {
        assertId(operationId);
        const record = await store.get(ownerId, operationId);
        return record ? statusFor(record) : /** @type {import('./contracts').OperationStatus} */ ({ operationId, state: 'unknown', status: 'pending' });
      }, operationId);
    },
    getAuditEvents: () => structuredClone(audit),
    /** Compatibility ONLY: validated old plan, no balance or card rule mutation.
     * @param {string} operationId @param {Record<string, unknown>} input */
    async createLegacyPlan(operationId, input) {
      assertId(operationId);
      if (input.confirmed !== true) throw new BankingError('CONFIRMATION_REQUIRED', '操作前需要明确确认');
      assertFen(input.monthlySavingFen);
      if (input.monthlySavingFen > (await repository.getDemoSettings()).monthlySavingCapFen || !Number.isInteger(input.saveRateBps) || Number(input.saveRateBps) < 0 || Number(input.saveRateBps) > 10000) throw new BankingError('VALIDATION_ERROR', '月金额或储蓄比例超出模拟范围');
      const fingerprint = store.fingerprint('legacy.create-plan', input);
      const existing = await store.get(ownerId, operationId);
      if (existing) {
        if (existing.action !== 'legacy.create-plan' || existing.fingerprint !== fingerprint) throw new BankingError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同操作或参数', true);
        if (!existing.receipt) throw new BankingError('INVALID_STATE', '原操作待核实', true);
        return existing.receipt;
      }
      /** @type {import('./contracts').OperationRecord} */
      const record = { operationId, action: 'legacy.create-plan', fingerprint, state: 'succeeded' };
      record.receipt = receiptFor(record, 'succeeded', '模拟储蓄计划已生效；本次未发起支付。');
      await save(record); return structuredClone(record.receipt);
    },
  });
}

/** Shared per browser tab or server process; factories provide isolated test/demo sessions. */
export const bankingCore = createBankingCore();
