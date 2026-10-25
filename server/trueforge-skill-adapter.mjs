import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// Retired MCP pilot adapter: retained for standalone MCP/bridge verification.
// /api/banking-agent never routes here; use trueforge-banking-runtime instead.
import { canonical } from '../src/banking-core/errors.mjs';
import { parseClarificationAnswer } from './banking-clarification-parser.mjs';
import { createTrueforgeClient, trueforgeError } from './trueforge-client.mjs';
import { isObject, nonnegativeInteger as integer, linkedToolResult, invalidToolResult, validateEvidence, withTrueforgeDeadline } from './trueforge-tool-result.mjs';

import { routeTrueforgeSkill, skillPolicies, matchBillQuery } from '../src/lib/trueforge-routing.mjs';
export { routeTrueforgeSkill, skillPolicies };
export const isSkillContinuation = token => typeof token === 'string' && token.startsWith('tfm1.');
const text = v => typeof v === 'string' && v.trim().length > 0;
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

function contextValid(context, evidence) {
  return isObject(context) && context.dataSource === 'synthetic_demo_only' && context.currency === 'CNY' &&
    text(context.datasetId) && text(context.snapshotId) && context.asOf === evidence[0].asOf;
}

export function validateSkillResult(turn, { tool, serverName, expectedArgs }) {
  const policy = skillPolicies[tool];
  if (!policy) throw invalidToolResult();
  const r = linkedToolResult(turn, { tool, serverName, expectedArgs });
  if (r.ok === false) {
    if (tool === 'transfer_preview' && r.kind === 'core_error' && r.status === 'core_error' && r.action === policy.action && r.code === 'INSUFFICIENT_BALANCE' && r.error?.code === r.code && r.recovery !== undefined) {
      const c = r.recovery;
      if (r.currency !== 'CNY' || r.amountUnit !== 'fen' || !text(r.continuationToken) || r.continuationToken.length > 10000 ||
          !isObject(c) || c.kind !== 'clarification' || c.status !== 'needs_clarification' || c.action !== policy.action || c.slot !== 'source_account_ref' ||
          !text(c.question) || c.question.length > 1000 || !Array.isArray(c.choices) || !c.choices.length || c.choices.some(v => !isObject(v) || Object.keys(v).some(k => !['optionId', 'label'].includes(k)) || !text(v.optionId) || !text(v.label)) ||
          new Set(c.choices.map(v => v.optionId)).size !== c.choices.length || Object.keys(c).some(k => !['kind', 'status', 'action', 'slot', 'question', 'choices'].includes(k))) throw invalidToolResult();
      return { type: 'recoverable_error', privateToken: r.continuationToken, data: structuredClone(c) };
    }
    const code = ['INVALID_STATE', 'LIMIT_EXCEEDED', 'INSUFFICIENT_BALANCE', 'INVALID_REQUEST', 'CONTINUATION_INVALID', 'VALIDATION_ERROR'].includes(r.error?.code) ? r.error.code : 'TRIAL_TOOL_FAILED';
    throw trueforgeError(code, '工具拒绝了本次请求，未生成成功卡片。', code === 'TRIAL_TOOL_FAILED' ? 502 : 400);
  }
  if (r.ok !== true || r.currency !== 'CNY' || r.amountUnit !== 'fen') throw invalidToolResult();
  if (r.kind === 'needs_clarification') {
    if (r.action !== policy.action || r.status !== 'needs_clarification' || r.code !== 'NEEDS_CLARIFICATION' ||
        !text(r.question) || !(tool === 'transfer_preview' ? ['source_account_ref', 'payee_ref', 'amount'] : tool === 'card_budget_preview' ? ['card_ref', 'amount'] : ['card_ref']).includes(r.slot) || !Array.isArray(r.choices) ||
        r.choices.some(c => !isObject(c) || Object.keys(c).some(k => !['optionId', 'label'].includes(k)) || !text(c.optionId) || !text(c.label)) ||
        new Set(r.choices.map(c => c.optionId)).size !== r.choices.length || !text(r.continuationToken) || r.continuationToken.length > 10000) throw invalidToolResult();
    return { type: 'continuing', privateToken: r.continuationToken,
      data: { kind: 'clarification', status: 'needs_clarification', action: policy.action, question: r.question, slot: r.slot, choices: structuredClone(r.choices) } };
  }
  if (r.kind !== policy.kind) throw invalidToolResult();
  if (policy.preview) {
    const result = validatePreview(r, policy);
    const effect = result.data.preview.exactEffects[0];
    if (expectedArgs.amount && (tool === 'transfer_preview' ? effect.amountFen : effect.after?.monthlyBudgetFen) !== expectedArgs.amount.amount_minor) throw invalidToolResult();
    return result;
  }
  if (tool === 'card_get') {
    const c = r.data?.card;
    if (r.action !== policy.action || r.status !== policy.kind || r.code !== 'OK' || !isObject(c) || !text(c.id) || !text(c.name) || !text(c.accountId) ||
        !['active', 'frozen'].includes(c.status) || !integer(c.monthlyBudgetFen) || !integer(c.monthlySpentFen) || typeof c.onlinePaymentsEnabled !== 'boolean' ||
        !Array.isArray(c.blockedCategories) || c.blockedCategories.some(category => !text(category)) || (c.alertThresholdFen !== null && !integer(c.alertThresholdFen)) ||
        (c.balanceReminderAmountFen !== null && !integer(c.balanceReminderAmountFen)) ||
        (c.balanceReminderPercent !== null && (!integer(c.balanceReminderPercent) || c.balanceReminderPercent < 1 || c.balanceReminderPercent > 100)) ||
        (c.balanceReminderAmountFen !== null && c.balanceReminderPercent !== null) || !integer(c.version) || !integer(c.previewGeneration)) throw invalidToolResult();
    const evidence = validateEvidence(r.evidence, [c.id]);
    if (!contextValid(r.data.context, evidence)) throw invalidToolResult();
    return { type: 'done', data: { status: policy.kind, action: policy.action, data: structuredClone(r.data), evidence } };
  }
  const list = r.data;
  if (!Array.isArray(list) || list.length > 200 || list.some(item => !isObject(item) || !text(item.id) || !text(item.name)) || new Set(list.map(item => item.id)).size !== list.length) throw invalidToolResult();
  if (tool === 'subscription_list') {
    if (list.some(s => !integer(s.monthlyFeeFen) || !['active', 'cancelled'].includes(s.status) || !date(s.lastUsedDate) ||
        typeof s.isPotentiallyUnused !== 'boolean' || (s.mandateId !== null && !text(s.mandateId)))) throw invalidToolResult();
  } else if (list.some(p => !['R1', 'R2', 'R3'].includes(p.riskLevel) || !integer(p.expectedYield) ||
      !['T+0', 'T+1', 'AT_MATURITY'].includes(p.liquidity) || !integer(p.minimumAmountFen) || !integer(p.durationDays) || p.currency !== 'CNY' || p.isSynthetic !== true)) throw invalidToolResult();
  const evidence = validateEvidence(r.evidence, list.map(item => item.id));
  if (!contextValid(r.context, evidence)) throw invalidToolResult();
  return { type: 'done', data: { status: policy.kind, action: policy.action,
    data: { [tool === 'subscription_list' ? 'subscriptions' : 'products']: structuredClone(list), context: structuredClone(r.context) }, evidence } };
}

function validatePreview(r, policy) {
  const p = r.preview, risk = r.risk, e = p?.exactEffects?.[0];
  if (r.code !== 'OK' || r.status !== 'awaiting_confirmation' || r.action !== policy.action || r.previewOnly !== true ||
      typeof r.operationId !== 'string' || !/^op_[a-zA-Z0-9_-]+$/.test(r.operationId) || !isObject(p) ||
      !text(p.planId) || !text(p.contextSnapshotId) || !text(p.summary) || !Array.isArray(p.stepIds) || p.stepIds.length !== 1 || !text(p.stepIds[0]) ||
      !Array.isArray(p.exactEffects) || p.exactEffects.length !== 1 || !isObject(e) || !/^[a-f0-9]{64}$/.test(p.previewHash) || !date(p.expiresAt) ||
      !['L0', 'L1', 'L2', 'L3'].includes(p.riskLevel) || !Array.isArray(p.warnings) || p.warnings.some(w => !text(w)) ||
      !isObject(risk) || risk.allowed !== true || risk.riskLevel !== p.riskLevel || risk.requiredConfirmation !== 'mock_explicit' || !text(risk.policyVersion) ||
      !Array.isArray(risk.warnings) || risk.warnings.some(w => !text(w)) || !text(r.continuationToken) || r.continuationToken.length > 10000) throw invalidToolResult();
  if (policy.action === 'transfer.create') {
    if (e.kind !== 'transfer_out' || !text(e.fromAccountId) || !text(e.accountName) || !text(e.payeeId) || !text(e.payeeName) || !text(e.accountNoMasked) ||
      !integer(e.amountFen) || e.amountFen === 0 || !integer(e.feeFen) || e.currency !== 'CNY' || !integer(e.balanceBeforeFen) ||
      !integer(e.balanceAfterFen) || !integer(e.availableBalanceAfterFen) || !integer(e.accountVersion) || e.arrival !== 'mock_immediate' ||
        e.balanceBeforeFen - e.amountFen - e.feeFen !== e.balanceAfterFen || e.availableBalanceAfterFen > e.balanceAfterFen) throw invalidToolResult();
  } else {
    if (e.kind !== 'card_change' || e.action !== policy.action || !text(e.cardId) || !text(e.cardName) || !integer(e.cardVersion) ||
        !integer(e.previewGeneration) || e.previewGeneration < 1 || !integer(e.monthlySpentFen) ||
        !isObject(e.before) || !isObject(e.after) || !['active', 'frozen'].includes(e.before.status) || !['active', 'frozen'].includes(e.after.status) ||
        !integer(e.before.monthlyBudgetFen) || !integer(e.after.monthlyBudgetFen) || e.after.monthlyBudgetFen > 10000000 ||
        typeof e.before.onlinePaymentsEnabled !== 'boolean' || typeof e.after.onlinePaymentsEnabled !== 'boolean' ||
        !Array.isArray(e.before.blockedCategories) || !Array.isArray(e.after.blockedCategories) ||
        e.before.blockedCategories.some(category => !text(category)) || e.after.blockedCategories.some(category => !text(category)) ||
        (e.before.alertThresholdFen !== null && !integer(e.before.alertThresholdFen)) || (e.after.alertThresholdFen !== null && !integer(e.after.alertThresholdFen)) ||
        (e.before.balanceReminderAmountFen !== null && !integer(e.before.balanceReminderAmountFen)) || (e.after.balanceReminderAmountFen !== null && !integer(e.after.balanceReminderAmountFen)) ||
        (e.before.balanceReminderPercent !== null && (!integer(e.before.balanceReminderPercent) || e.before.balanceReminderPercent < 1 || e.before.balanceReminderPercent > 100)) ||
        (e.after.balanceReminderPercent !== null && (!integer(e.after.balanceReminderPercent) || e.after.balanceReminderPercent < 1 || e.after.balanceReminderPercent > 100)) ||
        (e.before.balanceReminderAmountFen !== null && e.before.balanceReminderPercent !== null) ||
        (e.after.balanceReminderAmountFen !== null && e.after.balanceReminderPercent !== null)) throw invalidToolResult();
    if (policy.action === 'card.set_budget') {
      if (e.before.status !== e.after.status || e.before.monthlyBudgetFen === e.after.monthlyBudgetFen) throw invalidToolResult();
    } else if (e.before.monthlyBudgetFen !== e.after.monthlyBudgetFen ||
        (policy.action === 'card.freeze' ? e.before.status !== 'active' || e.after.status !== 'frozen' : e.before.status !== 'frozen' || e.after.status !== 'active')) throw invalidToolResult();
    validateEvidence(r.evidence, [e.cardId]);
  }
  // Prefix the authentic Core ID; never invent an ID or accept a model's prose.
  return { type: 'preview', privateToken: r.continuationToken, data: { status: 'awaiting_confirmation', action: policy.action,
    operationId: `tfpreview:${r.operationId}`, preview: structuredClone(p), risk: structuredClone(risk),
    ...(r.evidence ? { evidence: structuredClone(r.evidence) } : {}), previewOnly: true, executionAllowed: false } };
}

function validateBody(body) {
  const continuing = isSkillContinuation(body?.continuationToken);
  if (!isObject(body) || Object.keys(body).some(k => !['message', 'history', 'consent', 'continuationToken', 'choice'].includes(k)) ||
      (body.consent !== undefined && body.consent !== true) || (body.history !== undefined && (!Array.isArray(body.history) || body.history.length)) ||
      (body.choice !== undefined && (!continuing || body.message !== undefined || !isObject(body.choice) || Object.keys(body.choice).length !== 1 || !text(body.choice.optionId))) ||
      (body.choice === undefined && (!text(body.message) || body.message.length > 2000))) throw trueforgeError('INVALID_REQUEST', '请求格式无效，请重新开始试点会话。', 400);
}
export function createTrueforgeSkillAdapter({ env = process.env, clientFactory = tool => createTrueforgeClient({ env, tool }), now = Date.now, ttlMs = 300000, timeoutMs = 25000 } = {}) {
  const states = new Map();
  const secret = env.CONTINUATION_TOKEN_SECRET;
  if (!text(secret) || secret.length < 16) throw trueforgeError('CONTINUATION_CONFIG_ERROR', '试点续接服务未配置。', 503);
  const mac = nonce => createHmac('sha256', secret).update(`saveflow-multi-skill-v1:${nonce}`).digest('base64url');
  function lookup(token, scope) {
    for (const [key, s] of states) if (s.expiresAt <= now()) states.delete(key);
    const parts = typeof token === 'string' ? token.split('.') : [];
    const tag = parts.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[1]) ? mac(parts[1]) : '';
    const bytes = Buffer.from(parts[2] || ''); const entry = states.get(token);
    if (parts[0] !== 'tfm1' || !tag || bytes.length !== tag.length || !timingSafeEqual(bytes, Buffer.from(tag)) || !entry || !scope || entry.scope !== scope) throw trueforgeError('CONTINUATION_INVALID', '试点续接凭据无效或已过期。', 400);
    return entry;
  }
  function issue(state, result) {
    for (const [key, s] of states) if (s.expiresAt <= now()) states.delete(key);
    if (states.size >= 500) throw trueforgeError('TRUEFORGE_CAPACITY', '试点会话过多，请稍后再试。', 503);
    const nonce = randomBytes(32).toString('base64url'), token = `tfm1.${nonce}.${mac(nonce)}`;
    states.set(token, { ...state, answer: undefined, promise: undefined, privateToken: result.privateToken, choices: result.data.choices ?? [],
      slot: result.data.slot, preview: result.type === 'preview', expiresAt: now() + ttlMs });
    return token;
  }
  const errorReply = error => {
    const e = error?.userMessage ? error : trueforgeError('TRUEFORGE_UNAVAILABLE', '试点服务暂时不可用。');
    return { httpStatus: e.status, code: e.code, message: e.userMessage, data: { status: 'error', error: { code: e.code, message: e.userMessage } } };
  };
  async function run(state, args, message, signal) {
    const client = clientFactory(state.tool);
    return await withTrueforgeDeadline({ client, sessionId: state.sessionId, signal, timeoutMs }, async (sessionId, turnSignal) => {
      const wireMessage = JSON.stringify({ userMessage: message, toolArguments: args });
      const turn = await client.runTurn(sessionId, wireMessage, turnSignal);
      if (state.conversation.cancelled) throw trueforgeError('CONTINUATION_STALE', '该会话已取消，未执行操作。', 409);
      const result = validateSkillResult(turn, { tool: state.tool, serverName: env.TRUEFORGE_SKILL_MCP_SERVER || env.TRUEFORGE_MCP_SERVER, expectedArgs: args });
      if (result.type === 'preview' && Date.parse(result.data.preview.expiresAt) <= now()) throw trueforgeError('PREVIEW_EXPIRED', '预览已过期，请重新开始。', 409);
      const data = { ...result.data, source: 'trueforge-mcp' };
      state.conversation.revision++;
      state.completedRevision = state.conversation.revision;
      if (result.type !== 'done') data.continuationToken = issue({ ...state, sessionId, revision: state.conversation.revision }, result);
      if (result.type === 'recoverable_error') return { httpStatus: 400, code: 'INSUFFICIENT_BALANCE', message: '所选付款账户可用余额不足，请重新选择账户或修改金额。',
        data: { status: 'error', error: { code: 'INSUFFICIENT_BALANCE', message: '所选付款账户可用余额不足。' }, recovery: data } };
      return { httpStatus: 200, code: result.type === 'continuing' ? 'NEEDS_CLARIFICATION' : 'OK', message: data.question ?? '查询完成。', data };
    });
  }
  return {
    async handle(body, { scope, signal } = {}) {
      try {
        validateBody(body);
        if (!scope) throw trueforgeError('CONTINUATION_INVALID', '试点会话来源无效。', 400);
        if (body.continuationToken !== undefined) {
          const state = lookup(body.continuationToken, scope);
          if (env[skillPolicies[state.tool].flag] !== 'true') throw trueforgeError('CONTINUATION_INVALID', '该试点已关闭，请重新开始请求。', 400);
          if ((state.completedRevision ?? state.revision) !== state.conversation.revision || state.conversation.cancelled) throw trueforgeError('CONTINUATION_STALE', '请使用最新会话，旧预览或澄清已失效。', 409);
          if (body.message && /^(?:确认|确认转账|确认执行|执行|同意)[。！!]?\s*$/.test(body.message.trim())) throw trueforgeError('PREVIEW_ONLY', '本试点仅供预览，聊天确认不会执行操作。', 403);
          if (body.message && /^(?:取消|取消操作|取消本次操作|不用了)[。！!]?\s*$/.test(body.message.trim())) {
            state.conversation.cancelled = true;
            return { httpStatus: 200, code: 'OK', message: '已结束本次预览会话，未执行资金或卡片操作。', data: { status: 'cancelled', action: skillPolicies[state.tool].action, source: 'trueforge-mcp', previewOnly: true, executionAllowed: false } };
          }
          if (body.choice && !state.choices.some(c => c.optionId === body.choice.optionId)) throw trueforgeError('INVALID_CHOICE', '请选择本次会话提供的候选。', 400);
          const route = body.message && routeTrueforgeSkill(body.message, env);
          if (body.message && matchBillQuery(body.message)) throw trueforgeError('CONTINUATION_ACTION_MISMATCH', '该续接凭据不属于账单查询，请开始新请求。', 400);
          if (route && route.tool !== state.tool) throw trueforgeError('CONTINUATION_ACTION_MISMATCH', '续接凭据不能用于其他业务，请开始新请求。', 400);
          const answer = canonical(body.choice ?? { message: body.message });
          if (state.answer !== undefined && state.answer !== answer) throw trueforgeError('CONTINUATION_CONSUMED', '续接凭据已使用，请使用最新会话。', 409);
          let args = { continuationToken: state.privateToken, ...(body.choice ? { choice: body.choice } : { message: body.message }) };
          if (body.message && skillPolicies[state.tool].preview) {
            const edit = parseClarificationAnswer(body.message, { action: skillPolicies[state.tool].action, slot: 'amount' });
            if (/^(?:金额|预算)?改(?:成|为)\s*(?:转账\s*)?[-\d]/.test(body.message.trim()) && edit.kind !== 'slot') throw trueforgeError('INVALID_AMOUNT', '请提供允许范围内、精确到分的金额。', 400);
            if (route) { state.draft = route.args; args = route.args; }
            // Slot edits stay on the signed MCP continuation, including during
            // account recovery. Never reconstruct resolved entities from labels.
          }
          state.answer = answer;
          state.promise ??= run(state, args, body.message ?? '用户选择了本次候选', signal).catch(errorReply);
          return await state.promise;
        }
        const route = routeTrueforgeSkill(body.message, env);
        if (!route) throw trueforgeError('INVALID_REQUEST', '请求不属于已授权的试点业务。', 400);
        return await run({ ...route, draft: { ...route.args }, scope, conversation: { revision: 0 }, revision: 0 }, route.args, body.message, signal);
      } catch (error) { return errorReply(error); }
    },
  };
}

const adapters = new Map();
export function getTrueforgeSkillAdapter(env) {
  const keys = ['TRUEFORGE_BASE_URL', 'TRUEFORGE_MODEL', 'TRUEFORGE_MCP_SERVER', 'TRUEFORGE_SKILL_MCP_SERVER', 'TRUEFORGE_TOKEN', 'CONTINUATION_TOKEN_SECRET', ...Object.values(skillPolicies).map(p => p.flag)];
  const key = createHash('sha256').update(JSON.stringify(keys.map(k => env[k]))).digest('hex');
  if (!adapters.has(key)) { if (adapters.size >= 8) adapters.delete(adapters.keys().next().value); adapters.set(key, createTrueforgeSkillAdapter({ env: { ...env } })); }
  return adapters.get(key);
}
