// @ts-check
import { createFinancialContext } from './repository.mjs';
import { BankingError, assertFen, assertId, canonical } from './errors.mjs';
import { OperationStore } from './operation-store.mjs';
import { canTransitionAction, transitionAction } from './action-machine.mjs';
import { createWealthMockPorts } from '../skills/wealth/mock-ports.mjs';

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

const cardActions = new Set(['card.set_budget', 'card.freeze', 'card.unfreeze']);
const wealthActions = new Set(['wealth.subscribe', 'wealth.redeem']);
/** @param {string} action @param {unknown} input @returns {import('./contracts').CardInput} */
function validateCardInput(action, input) {
  if (!cardActions.has(action) || !input || typeof input !== 'object' || Array.isArray(input)) throw new BankingError('VALIDATION_ERROR', '卡片操作参数无效');
  const body = /** @type {Record<string, unknown>} */ (input);
  const fields = action === 'card.set_budget' ? ['cardId', 'monthlyBudgetFen'] : ['cardId'];
  if (Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(body, key))) throw new BankingError('VALIDATION_ERROR', '卡片操作包含缺失或未注册字段');
  assertId(body.cardId, '卡片');
  if (action === 'card.set_budget' && (!Number.isSafeInteger(body.monthlyBudgetFen) || Number(body.monthlyBudgetFen) < 0 || Number(body.monthlyBudgetFen) > 10_000_000)) throw new BankingError('VALIDATION_ERROR', '月预算必须是 0 到 10000000 的整数分');
  return /** @type {import('./contracts').CardInput} */ (body);
}

/** One isolated Mock banking session. Never feed model output to decide()/execute().
 * Future write actions must use this engine and a transaction adapter, not per-Skill Maps.
 * @param {{source?: Parameters<typeof createFinancialContext>[0], now?: () => number, store?: import('./contracts').BankingOperationStore, repository?: import('./contracts').FinancialContextRepository, wealthPorts?: ReturnType<typeof createWealthMockPorts>, ownerId?: string, policy?: {version: string, maxTransferFen: number, previewTtlMs: number}}} [options] */
export function createBankingCore(options = {}) {
  const context = createFinancialContext(options.source);
  const repository = options.repository ?? context.repository;
  const commitTransfer = context.commitTransfer;
  const commitCard = context.commitCard;
  const commitWealth = context.commitWealth;
  const ownerId = options.ownerId ?? context.ownerId;
  /** @type {import('./contracts').BankingOperationStore} */
  const store = options.store ?? new OperationStore();
  const now = options.now ?? Date.now;
  // The synthetic Wealth write port is only valid for this in-memory context.
  // A configured database must supply its own transactional adapter before enabling writes.
  const wealthPorts = options.wealthPorts ?? (options.repository || options.store ? undefined : createWealthMockPorts({ getHoldings: context.getWealthHoldings, now }));
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
  /** @template T @param {() => T} run @param {string} [operationId] @returns {Promise<import('./contracts').ActionResult<Awaited<T>>>} */
  async function guard(run, operationId) {
    try { return { ok: true, data: await run() }; }
    catch (error) { return { ok: false, error: errorData(error), ...(operationId ? { operationId } : {}) }; }
  }
  /** @param {import('./contracts').TransferInput} input @returns {Promise<import('./contracts').RiskResult>} */
  async function riskCheck(input) {
    const result = await guard(async () => {
      validateTransfer(input);
      const account = await repository.getAccount(input.fromAccountId);
      const payee = await repository.getPayee(input.payeeId);
      if (!account) throw new BankingError('ACCOUNT_NOT_FOUND', '找不到可访问的付款账户');
      if (!payee) throw new BankingError('PAYEE_NOT_FOUND', '找不到收款人，请先完成实体解析');
      if (account.status !== 'active') throw new BankingError('ACCOUNT_BLOCKED', '付款账户当前不可用');
      if (payee.status !== 'active') throw new BankingError('PAYEE_BLOCKED', '收款人当前不可用');
      if (account.availableBalanceFen < input.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '付款账户可用余额不足');
      if (input.amountFen > policy.maxTransferFen) throw new BankingError('LIMIT_EXCEEDED', '超过 Mock 单笔转账限额');
      return true;
    });
    return { allowed: result.ok, riskLevel: 'L3', policyVersion: policy.version, requiredConfirmation: 'mock_explicit', warnings: ['合成数据模拟转账，不接真实银行；此确认仅用于 Mock。'], ...(!result.ok ? { error: result.error } : {}) };
  }
  /** @param {import('./contracts').TransferInput} input @returns {Promise<import('./contracts').TransferEffect>} */
  async function effectFor(input) {
    const account = await repository.getAccount(input.fromAccountId);
    const payee = await repository.getPayee(input.payeeId);
    if (!account || !payee) throw new BankingError('PREVIEW_STALE', '账户或收款人已失效');
    return { kind: 'transfer_out', fromAccountId: account.id, accountName: account.name, payeeId: payee.id, payeeName: payee.name, accountNoMasked: payee.accountNoMasked, amountFen: input.amountFen, feeFen: 0, currency: 'CNY', balanceBeforeFen: account.balanceFen, balanceAfterFen: account.balanceFen - input.amountFen, availableBalanceAfterFen: account.availableBalanceFen - input.amountFen, accountVersion: account.version, memo: input.memo ?? '', arrival: 'mock_immediate' };
  }
  /** @param {import('./contracts').CardAction} action @param {import('./contracts').CardInput} input @returns {Promise<import('./contracts').CardEffect>} */
  async function cardEffectFor(action, input) {
    const card = await repository.getCard(input.cardId);
    if (!card) throw new BankingError('CARD_NOT_FOUND', '当前用户无法访问该卡片');
    if (action === 'card.freeze' && card.status !== 'active') throw new BankingError('INVALID_STATE', '卡片已经冻结');
    if (action === 'card.unfreeze' && card.status !== 'frozen') throw new BankingError('INVALID_STATE', '卡片并未冻结');
    if (action === 'card.set_budget' && card.monthlyBudgetFen === input.monthlyBudgetFen) throw new BankingError('INVALID_STATE', '新预算与当前预算相同');
    return { kind: 'card_change', action, cardId: card.id, cardName: card.name, cardVersion: card.version, previewGeneration: card.previewGeneration, before: { status: card.status, monthlyBudgetFen: card.monthlyBudgetFen }, after: { status: action === 'card.freeze' ? 'frozen' : action === 'card.unfreeze' ? 'active' : card.status, monthlyBudgetFen: action === 'card.set_budget' ? /** @type {number} */ (input.monthlyBudgetFen) : card.monthlyBudgetFen }, monthlySpentFen: card.monthlySpentFen };
  }
  /** @param {import('./contracts').WealthAction} action @param {Record<string, any>} input @returns {Promise<import('./contracts').WealthEffect>} */
  async function wealthEffectFor(action, input) {
    if (!wealthPorts) throw new BankingError('CAPABILITY_UNAVAILABLE', '当前持久化环境未配置 Wealth 事务适配器');
    const keys = action === 'wealth.subscribe' ? ['productId', 'amountFen', 'currency', 'sourceAccountId'] : ['holdingId', 'quantityKind', 'amountFen', 'currency', 'unitsMilli'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new BankingError('VALIDATION_ERROR', 'Wealth 请求字段无效');
    if (action === 'wealth.subscribe') {
      if (Object.keys(input).sort().join() !== ['productId', 'amountFen', 'currency', 'sourceAccountId'].sort().join()) throw new BankingError('VALIDATION_ERROR', '申购字段不完整');
      assertId(input.productId); assertId(input.sourceAccountId); assertFen(input.amountFen);
      if (input.currency !== 'CNY') throw new BankingError('VALIDATION_ERROR', '当前 Mock 仅支持 CNY');
      const products = await repository.getInvestmentProducts();
      const product = products.find(item => item.id === input.productId);
      const account = await repository.getAccount(input.sourceAccountId);
      const assessment = await wealthPorts.getRiskAssessment();
      const disclosure = await wealthPorts.getDisclosure(input.productId);
      const rule = await wealthPorts.getOperationRule(input.productId);
      if (!product || !account || account.status !== 'active') throw new BankingError('VALIDATION_ERROR', '产品或来源账户不可用');
      if (!assessment || assessment.source !== 'trusted_ui' || Date.parse(assessment.expires_at) <= now() || Number(assessment.risk_level.slice(1)) < Number(product.riskLevel.slice(1))) throw new BankingError('SUITABILITY_FAILED', '风险测评不匹配或已过期');
      if (!disclosure || disclosure.status !== 'active' || Date.parse(disclosure.expires_at) <= now() || !rule?.subscription_enabled) throw new BankingError('CAPABILITY_UNAVAILABLE', '产品披露或申购规则不可用');
      if (input.amountFen < product.minimumAmountFen) throw new BankingError('BELOW_MINIMUM_AMOUNT', '申购金额低于产品最低金额');
      if (account.availableBalanceFen < input.amountFen) throw new BankingError('INSUFFICIENT_BALANCE', '账户余额不足');
      const holding = (await wealthPorts.getHoldings()).find(/** @param {any} item */ item => item.product_id === product.id);
      return { kind: 'wealth_change', action, productId: product.id, productName: product.name, holdingId: holding?.id ?? `holding_${product.id}`, holdingVersion: holding?.version ?? null, fundingAccountId: account.id, accountVersion: account.version, amountFen: input.amountFen, unitsMilli: input.amountFen, disclosureVersion: disclosure.version, assessmentId: assessment.assessment_id };
    }
    if (!['amount', 'units'].includes(input.quantityKind) || (input.quantityKind === 'amount' ? Object.keys(input).sort().join() !== ['holdingId', 'quantityKind', 'amountFen', 'currency'].sort().join() : Object.keys(input).sort().join() !== ['holdingId', 'quantityKind', 'unitsMilli'].sort().join())) throw new BankingError('VALIDATION_ERROR', '赎回数量单位无效');
    assertId(input.holdingId);
    if (input.quantityKind === 'amount') { assertFen(input.amountFen); if (input.currency !== 'CNY') throw new BankingError('VALIDATION_ERROR', '仅支持 CNY'); }
    else assertFen(input.unitsMilli);
    const holding = (await wealthPorts.getHoldings()).find(/** @param {any} item */ item => item.id === input.holdingId);
    if (!holding) throw new BankingError('HOLDING_NOT_FOUND', '持仓不存在');
    const product = (await repository.getInvestmentProducts()).find(item => item.id === holding.product_id);
    const rule = await wealthPorts.getOperationRule(holding.product_id);
    if (!product || !rule?.redemption_enabled || (holding.lock_until && Date.parse(holding.lock_until) > now())) throw new BankingError('REDEMPTION_RESTRICTED', '产品当前不能赎回');
    const amountFen = input.quantityKind === 'amount' ? input.amountFen : input.unitsMilli;
    const unitsMilli = input.quantityKind === 'units' ? input.unitsMilli : input.amountFen;
    if (holding.amount_fen < amountFen || holding.units_milli < unitsMilli) throw new BankingError('INSUFFICIENT_HOLDING', '持仓不足');
    return { kind: 'wealth_change', action, productId: product.id, productName: product.name, holdingId: holding.id, holdingVersion: holding.version, amountFen, unitsMilli, settlement: rule.settlement };
  }
  /** @param {import('./contracts').CardEffect} effect @returns {import('./contracts').RiskResult} */
  function cardRisk(effect) {
    const warnings = ['合成数据模拟卡片操作，不接真实银行。'];
    if (effect.action === 'card.set_budget' && effect.after.monthlyBudgetFen < effect.monthlySpentFen) warnings.push(`当前已超预算 ¥${((effect.monthlySpentFen - effect.after.monthlyBudgetFen) / 100).toFixed(2)}；预算不会阻止消费。`);
    return { allowed: true, riskLevel: effect.action === 'card.unfreeze' ? 'L3' : 'L2', policyVersion: policy.version, requiredConfirmation: 'mock_explicit', warnings };
  }
  /** @param {import('./contracts').OperationRecord} record @param {'succeeded'|'failed'|'cancelled'} status @param {string} message @param {string[]} [transactionIds] @returns {import('./contracts').ActionReceipt} */
  function receiptFor(record, status, message, transactionIds = []) {
    return { receiptId: `receipt_${record.operationId}`, operationId: record.operationId, action: record.action, planId: record.preview?.planId ?? record.operationId, stepId: record.preview?.stepIds[0] ?? 'legacy_plan', status, message, executedAt: new Date(now()).toISOString(), dataSource: 'synthetic_demo_only', transactionIds, effects: status === 'succeeded' ? structuredClone(record.preview?.exactEffects ?? []) : [], ...(record.error ? { error: record.error } : {}) };
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
    if (!record.preview || !record.request) throw new BankingError('INVALID_STATE', '操作尚未生成预览');
    if (now() >= Date.parse(record.preview.expiresAt)) throw new BankingError('PREVIEW_EXPIRED', '预览已过期，请重新预览并确认');
    if (cardActions.has(record.action)) {
      const request = /** @type {{action:import('./contracts').CardAction,input:import('./contracts').CardInput}} */ (record.request);
      const effect = await cardEffectFor(request.action, request.input);
      if (record.risk?.policyVersion !== policy.version || canonical(effect) !== canonical(record.preview.exactEffects[0])) throw new BankingError('PREVIEW_STALE', '卡片状态、版本或预览已变化，请重新预览并确认');
      return;
    }
    if (wealthActions.has(record.action)) {
      const request = /** @type {{action:import('./contracts').WealthAction,input:Record<string,any>}} */ (record.request);
      const effect = await wealthEffectFor(request.action, request.input);
      if (record.risk?.policyVersion !== policy.version || canonical(effect) !== canonical(record.preview.exactEffects[0])) throw new BankingError('PREVIEW_STALE', '账户、持仓或产品条件已变化，请重新预览');
      return;
    }
    const transferRequest = /** @type {{action:'transfer_money',input:import('./contracts').TransferInput}} */ (record.request);
    const risk = await riskCheck(transferRequest.input);
    if (!risk.allowed && risk.error) throw new BankingError(risk.error.code, risk.error.message);
    if (risk.policyVersion !== record.risk?.policyVersion || canonical(record.preview.exactEffects[0]) !== canonical(await effectFor(transferRequest.input))) throw new BankingError('PREVIEW_STALE', '账户、收款人或风险条件已变化，请重新预览并确认');
  }
  /** @param {import('./contracts').OperationRecord} record @returns {import('./contracts').OperationStatus} */
  function statusFor(record) {
    return { operationId: record.operationId, state: record.state, status: record.receipt?.status ?? 'pending', ...(record.receipt ? { receipt: record.receipt } : {}), ...(record.preview ? { preview: record.preview } : {}), ...(record.error ? { error: record.error } : {}) };
  }

  /** @param {import('./contracts').ActionRequest} request @param {string} operationId */
  async function prepareCard(request, operationId) {
    /** @type {import('./contracts').OperationRecord | undefined} */
    let record;
    try {
      if (!cardActions.has(request.action) || Object.keys(request).some(key => !['action', 'input'].includes(key))) throw new BankingError('VALIDATION_ERROR', '卡片请求含有未注册字段');
      const action = /** @type {import('./contracts').CardAction} */ (request.action);
      const input = validateCardInput(action, request.input);
      // Check before reserving: an invalid request must not invalidate an existing preview.
      await cardEffectFor(action, input);
      record = { operationId, action, fingerprint: store.fingerprint(action, input), state: 'preparing', request: { action, input } };
      await save(record); await move(record, 'PREPARED');
      const generation = typeof store.reserveCardPreview === 'function' ? await store.reserveCardPreview(ownerId, input.cardId) : context.reserveCardPreview(input.cardId);
      const effect = await cardEffectFor(action, input);
      if (effect.previewGeneration !== generation) throw new BankingError('PREVIEW_STALE', '卡片预览已变化，请重新尝试');
      const risk = cardRisk(effect); record.risk = risk;
      const expiresAt = new Date(now() + policy.previewTtlMs).toISOString();
      const contextSnapshotId = (await repository.getContextInfo()).snapshotId;
      const planId = `plan_${crypto.randomUUID()}`, stepId = `step_${crypto.randomUUID()}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ ownerId, operationId, planId, stepId, effect, expiresAt, contextSnapshotId, policy })));
      const previewHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const summary = action === 'card.set_budget' ? `${effect.cardName}月消费预算 ¥${(effect.before.monthlyBudgetFen / 100).toFixed(2)} → ¥${(effect.after.monthlyBudgetFen / 100).toFixed(2)}` : `${effect.cardName}${action === 'card.freeze' ? '冻结' : '解冻'}：${effect.before.status} → ${effect.after.status}`;
      record.preview = { planId, stepIds: [stepId], summary, exactEffects: [effect], riskLevel: risk.riskLevel, warnings: risk.warnings, expiresAt, previewHash, contextSnapshotId };
      await move(record, 'PREVIEWED');
      return /** @type {import('./contracts').ActionResult<import('./contracts').PreparedAction>} */ ({ ok: true, data: { operationId, state: 'awaiting_confirmation', preview: structuredClone(record.preview), risk: structuredClone(risk) } });
    } catch (error) {
      const data = errorData(error);
      if (record) await fail(record, data);
      return /** @type {import('./contracts').ActionResult<import('./contracts').PreparedAction>} */ ({ ok: false, operationId, error: data });
    }
  }

  /** @param {{action:import('./contracts').WealthAction,input:import('./contracts').WealthInput}} request @param {string} operationId */
  async function prepareWealth(request, operationId) {
    /** @type {import('./contracts').OperationRecord | undefined} */
    let record;
    try {
      if (!wealthActions.has(request.action) || Object.keys(request).some(key => !['action', 'input'].includes(key))) throw new BankingError('VALIDATION_ERROR', 'Wealth 请求含未注册字段');
      const effect = await wealthEffectFor(request.action, /** @type {Record<string,any>} */ (request.input));
      record = { operationId, action: request.action, fingerprint: store.fingerprint(request.action, request.input), state: 'preparing', request: structuredClone(request) };
      await save(record); await move(record, 'PREPARED');
      const risk = /** @type {import('./contracts').RiskResult} */ ({ allowed: true, riskLevel: 'L3', policyVersion: policy.version, requiredConfirmation: 'mock_explicit', warnings: ['仅限合成数据演示；本金与展示收益不保证；此预览不代表真实申赎。'] });
      record.risk = risk;
      const expiresAt = new Date(now() + policy.previewTtlMs).toISOString();
      const contextSnapshotId = (await repository.getContextInfo()).snapshotId;
      const planId = `plan_${crypto.randomUUID()}`, stepId = `step_${crypto.randomUUID()}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ ownerId, operationId, planId, stepId, effect, expiresAt, contextSnapshotId, policy })));
      const previewHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const summary = `${effect.productName}模拟${request.action === 'wealth.subscribe' ? '申购' : '赎回'} ¥${(effect.amountFen / 100).toFixed(2)}；需单独确认。`;
      record.preview = { planId, stepIds: [stepId], summary, exactEffects: [effect], riskLevel: 'L3', warnings: risk.warnings, expiresAt, previewHash, contextSnapshotId };
      await move(record, 'PREVIEWED');
      return /** @type {import('./contracts').ActionResult<import('./contracts').PreparedAction>} */ ({ ok: true, data: { operationId, state: 'awaiting_confirmation', preview: structuredClone(record.preview), risk: structuredClone(risk) } });
    } catch (error) {
      const data = errorData(error);
      if (record) await fail(record, data);
      return /** @type {import('./contracts').ActionResult<import('./contracts').PreparedAction>} */ ({ ok: false, operationId, error: data });
    }
  }

  return Object.freeze({
    repository,
    wealthPorts,
    close: async () => { if (typeof store.close === 'function') await store.close(); },
    riskCheck,
    /** @param {import('./contracts').ActionRequest} request @returns {Promise<import('./contracts').ActionResult<import('./contracts').PreparedAction>>} */
    async prepare(request) {
      const operationId = `op_${crypto.randomUUID()}`;
      if (request && cardActions.has(request.action)) return prepareCard(request, operationId);
      if (request && wealthActions.has(request.action)) return prepareWealth(/** @type {{action:import('./contracts').WealthAction,input:import('./contracts').WealthInput}} */ (request), operationId);
      /** @type {import('./contracts').OperationRecord | undefined} */
      let record;
      try {
        if (!request || request.action !== 'transfer_money') throw new BankingError('UNKNOWN_ACTION', '当前写操作未注册');
        if (Object.keys(request).some(k => !['action', 'input', 'planId', 'stepId', 'origin'].includes(k))) throw new BankingError('VALIDATION_ERROR', '不接受模型提供的风险等级或确认标记');
        const input = validateTransfer(request.input);
        const planId = request.planId ?? `plan_${crypto.randomUUID()}`;
        const stepId = request.stepId ?? `step_${crypto.randomUUID()}`;
        assertId(planId); assertId(stepId);
        const origin = request.origin ?? 'user_requested';
        if (!['user_requested', 'agent_suggested', 'event_triggered'].includes(origin)) throw new BankingError('VALIDATION_ERROR', '操作来源无效');
        record = { operationId, action: 'transfer_money', fingerprint: store.fingerprint('transfer_money', input), state: 'preparing', request: { action: 'transfer_money', input, planId, stepId, origin } };
        await save(record); await move(record, 'PREPARED');
        const risk = await riskCheck(input); record.risk = risk;
        if (!risk.allowed && risk.error) throw new BankingError(risk.error.code, risk.error.message);
        const effect = await effectFor(input);
        const expiresAt = new Date(now() + policy.previewTtlMs).toISOString();
        const contextSnapshotId = (await repository.getContextInfo()).snapshotId;
        const hashInput = canonical({ ownerId, operationId, planId, stepId, origin, effect, expiresAt, contextSnapshotId, policy });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
        const previewHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        record.preview = { planId, stepIds: [stepId], summary: `从${effect.accountName}向${effect.payeeName}（${effect.accountNoMasked}）模拟转账 ¥${(input.amountFen / 100).toFixed(2)}，手续费 ¥0.00，模拟即时到账。`, exactEffects: [effect], riskLevel: risk.riskLevel, warnings: risk.warnings, expiresAt, previewHash, contextSnapshotId };
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
        if (decision.decision === 'reject') record.receipt = receiptFor(record, 'cancelled', wealthActions.has(record.action) ? '已取消模拟申赎，账户与持仓未变更' : cardActions.has(record.action) ? '已取消卡片操作，卡片未变更' : '已取消模拟转账，未扣款');
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
        if (record.action !== 'transfer_money' && !cardActions.has(record.action) && !wealthActions.has(record.action)) throw new BankingError('UNKNOWN_ACTION', '此执行入口不接受该动作');
        verifyHash(record, previewHash);
        if (!record.preview) throw new BankingError('INVALID_STATE', '缺少预览');
        if (record.receipt) return record.receipt;
        if (['executing', 'unknown', 'checking'].includes(record.state)) throw new BankingError('INVALID_STATE', '操作结果待核实，只能查询原编号', true);
        if (record.state !== 'confirmed' || record.decision?.decision !== 'confirm') throw new BankingError('CONFIRMATION_REQUIRED', '需要先确认当前精确预览');
        try {
          await recheck(record); await move(record, 'EXECUTE');
          const at = new Date(now()).toISOString();
          if (wealthActions.has(record.action)) {
            if (!wealthPorts) throw new BankingError('CAPABILITY_UNAVAILABLE', '当前环境不能安全提交 Wealth Mock');
            const effect = /** @type {import('./contracts').WealthEffect} */ (record.preview.exactEffects[0]);
            if (typeof store.commitWealth === 'function') {
              record.receipt = await store.commitWealth(ownerId, record, effect, () => receiptFor(record, 'succeeded', '模拟理财操作成功；不涉及真实资产'));
              record.state = transitionAction(record.state, 'SUCCEEDED');
            } else {
              commitWealth(effect);
              record.receipt = receiptFor(record, 'succeeded', '模拟理财操作成功；不涉及真实资产');
              await move(record, 'SUCCEEDED');
            }
          } else if (cardActions.has(record.action)) {
            const effect = /** @type {import('./contracts').CardEffect} */ (record.preview.exactEffects[0]);
            if (typeof store.commitCard === 'function') {
              record.receipt = await store.commitCard(ownerId, record, effect, () => receiptFor(record, 'succeeded', '模拟卡片操作成功'));
              record.state = transitionAction(record.state, 'SUCCEEDED');
            } else {
              commitCard(effect);
              record.receipt = receiptFor(record, 'succeeded', '模拟卡片操作成功');
              await move(record, 'SUCCEEDED');
            }
          } else if (typeof store.commitTransfer === 'function') {
            record.receipt = await store.commitTransfer(ownerId, record, /** @type {import('./contracts').TransferEffect} */ (record.preview.exactEffects[0]), at, transaction => receiptFor(record, 'succeeded', '模拟转账成功', [transaction.id]));
            record.state = transitionAction(record.state, 'SUCCEEDED');
            audit.push({ operationId: record.operationId, action: record.action, state: record.state, at: new Date(now()).toISOString() });
          } else {
            const transaction = await commitTransfer(/** @type {import('./contracts').TransferEffect} */ (record.preview.exactEffects[0]), operationId, at);
            record.receipt = receiptFor(record, 'succeeded', '模拟转账成功', [transaction.id]);
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
      if ('saveRateBps' in input || 'savingRate' in input || 'category' in input) throw new BankingError('VALIDATION_ERROR', '消费比例储蓄规则已不支持');
      if (input.monthlySavingFen > (await repository.getDemoSettings()).monthlySavingCapFen) throw new BankingError('VALIDATION_ERROR', '月金额超出模拟范围');
      if (input.targetAmountFen !== undefined && input.targetAmountFen !== null) assertFen(input.targetAmountFen);
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
