import { dispatchParsedIntent, handleBillSummary, handleCard, handleTransfer, prepareTransferPreview, transferRepository } from '../src/agent/runtime.mjs';
import { issueContinuationToken, verifyContinuationToken } from '../src/agent/clarification/continuation-token.mjs';
import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';
import { buildParsedIntent, mergeSlots } from '../src/agent/clarification/merge-intent.mjs';
import { isBillTask, isCardTask, isTransferTask, parseClarificationAnswer } from './banking-clarification-parser.mjs';
import { billClarificationQuestion } from '../src/lib/trueforge-routing.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { dispatchBanking } from '../src/banking-core/dispatch.mjs';

function errorData(code, message) {
  return { status: 'error', error: { code, message } };
}

function inputError(code, message, status) {
  return Object.assign(new Error(message), { code, status, userMessage: message });
}

export function statusFor(code) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'CARD_NOT_FOUND') return 404;
  if (code === 'CARD_AMBIGUOUS' || code === 'INVALID_STATE') return 409;
  if (code === 'LIMIT_EXCEEDED') return 422;
  if (code === 'MODEL_TIMEOUT') return 504;
  if (code === 'MODEL_RATE_LIMIT') return 429;
  if (['MODEL_AUTH_ERROR', 'MODEL_UPSTREAM_ERROR', 'MODEL_UNAVAILABLE', 'SKILL_ERROR'].includes(code)) return 502;
  if (['ACCESS_NOT_CONFIGURED', 'MODEL_NOT_CONFIGURED', 'MODEL_CONFIG_ERROR', 'CONTINUATION_CONFIG_ERROR'].includes(code)) return 503;
  return 400;
}

const clarificationQuestions = {
  amount: '要转多少钱？例如 500 元。',
  source_account_ref: '要从哪个账户转出？',
  payee_ref: '要转给谁？',
  card_ref: '请选择要查看或操作的卡片。',
};

function questionFor(action, slot, message, slots = {}) {
  if (slot === 'month' && action === 'bill.summary') return billClarificationQuestion(slots.year ? `${slots.year}年账单` : slots.monthNumber ? `${slots.monthNumber}月账单` : message);
  return slot === 'amount' && action === 'card.set_budget'
    ? '新的月消费预算是多少元？例如 1000 元。'
    : clarificationQuestions[slot] || '请补充必要信息。';
}

function continuationSecret(env) {
  return env.CONTINUATION_TOKEN_SECRET;
}

function tokenError(error) {
  return Object.assign(new Error(error instanceof Error ? error.message : '续接凭据无效'), { code: 'CONTINUATION_INVALID', status: 400 });
}

function issueState({ action, slots, pendingSlot, choices = [], selections = {}, env, now }) {
  return issueContinuationToken({ action, slots, pendingSlot, choices, selections }, continuationSecret(env), now());
}

async function accountChoices(repository) {
  return (await repository.getAccounts()).filter(account => account.status === 'active').map(account => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${account.name}（可用 ¥${(account.availableBalanceFen / 100).toFixed(2)}）`,
    entityId: account.id,
    rawValue: account.name,
  }));
}

function payeeChoices(candidates) {
  return candidates.map(candidate => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${candidate.name}（${candidate.accountNoMasked || '账户信息已脱敏'}）`,
    entityId: candidate.id,
    rawValue: candidate.name,
  }));
}

function cardChoices(cards) {
  return cards.map((card, index) => ({
    optionId: `opt_${crypto.randomUUID()}`,
    label: `${card.name}（卡片 ${index + 1}）`,
    entityId: card.id,
    rawValue: card.name,
  }));
}

function clarificationResponse(reply, { action, slot, question, choices = [], slots, selections = {}, env, now, message, source }) {
  const token = issueState({ action, slots, pendingSlot: slot, choices, selections, env, now });
  return reply(200, 'NEEDS_CLARIFICATION', question, {
    kind: 'clarification', status: 'needs_clarification', action, question, slot, ...(source ? { source } : {}), choices: choices.map(({ optionId, label }) => ({ optionId, label })), continuationToken: token,
    ...(message ? { message } : {}),
  });
}

function nextMissingSlot(intent) {
  const order = intent.action === 'transfer.create'
    ? ['source_account_ref', 'payee_ref', 'amount']
    : intent.action.startsWith('card.') ? ['card_ref', 'amount'] : ['month'];
  return order.find(slot => intent.missingSlots?.includes(slot)) || intent.missingSlots?.[0];
}

function switchesTask(message, continuation) {
  if (isBillTask(message) && continuation.action !== 'bill.summary') return true;
  if (isTransferTask(message) && continuation.action !== 'transfer.create') return true;
  if (!isCardTask(message)) return false;
  if (!continuation.action.startsWith('card.')) return true;
  if (/解冻|解除冻结/.test(message)) return continuation.action !== 'card.unfreeze';
  if (/冻结|锁卡/.test(message)) return continuation.action !== 'card.freeze';
  if (/预算/.test(message) && /调整|修改|设置|改成/.test(message)) return continuation.action !== 'card.set_budget';
  if (/查(?:询|看)?.{0,4}(?:银行卡|卡片)|卡片?信息/.test(message)) return continuation.action !== 'card.get';
  return false;
}

/** Shared clarification and preview workflow. The only Core capability used is prepare(). */
export async function runBankingConversation(body, {
  core, repository = core.repository, env = process.env, now = Date.now,
  parseIntent, initialIntent, expectedAction, fetchImpl = fetch, requestId = crypto.randomUUID(), origin = 'user_requested', understandContinuation = false,
}) {
  let replyContext = {};
  const reply = (httpStatus, code, message, data) => ({ httpStatus, code, message, data, replyContext });
  if (typeof continuationSecret(env) !== 'string' || continuationSecret(env).length < 16) {
    throw Object.assign(new Error('续接令牌密钥未配置'), { code: 'CONTINUATION_CONFIG_ERROR', status: 503 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('INVALID_REQUEST', '请求体必须是对象', 400);
  const allowed = ['message', 'history', 'consent', 'continuationToken', 'choice', 'replyStyle'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw inputError('INVALID_REQUEST', '请求包含未注册字段', 400);
  const continuing = body.continuationToken !== undefined;
  if (body.choice !== undefined && (!continuing || body.message !== undefined)) throw inputError('INVALID_REQUEST', 'choice 必须与 continuationToken 一起提交，且不能同时提交 message', 400);
  if (continuing && (typeof body.continuationToken !== 'string' || body.continuationToken.length > 10000)) throw inputError('CONTINUATION_INVALID', '续接凭据无效', 400);
  if (!continuing && !initialIntent && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) throw inputError('INVALID_REQUEST', 'message 必须是 1-2000 字符的文本', 400);
  if (continuing && body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) throw inputError('INVALID_REQUEST', 'message 格式无效', 400);
  if (continuing && body.message === undefined && (!body.choice || typeof body.choice !== 'object')) throw inputError('INVALID_REQUEST', '续接请求需要 message 或 choice', 400);
  if (body.choice !== undefined && (!body.choice || typeof body.choice !== 'object' || Array.isArray(body.choice) || typeof body.choice.optionId !== 'string' || !body.choice.optionId.trim() || Object.keys(body.choice).some(key => key !== 'optionId'))) throw inputError('INVALID_REQUEST', 'choice 只能包含非空 optionId', 400);
  if (body.consent !== undefined && body.consent !== true) throw inputError('INVALID_REQUEST', 'consent 必须明确为 true', 400);
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 12 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 2000)) throw inputError('INVALID_REQUEST', 'history 格式无效', 400);

  let parsed;
  let selections = {};
  let continuation;
  if (continuing) {
    try { continuation = verifyContinuationToken(body.continuationToken, continuationSecret(env), now()); }
    catch (error) { throw tokenError(error); }
    replyContext = { slots: continuation.slots };
    if (body.message && /^(?:确认|确认转账|确认执行|执行|同意)[。！!]?\s*$/.test(body.message.trim())) throw inputError('CONFIRMATION_REQUIRED', '聊天文字不能确认执行，请在页面核对预览并完成所需确认与验证。', 403);
    if (body.message && /^(?:取消|取消操作|取消本次操作|不用了)[。！!]?\s*$/.test(body.message.trim())) return reply(200, 'OK', '本次会话已取消，未执行资金或卡片操作。', { status: 'cancelled', action: continuation.action });
    if (expectedAction && continuation.action !== expectedAction) throw Object.assign(new Error('续接凭据与当前工具动作不一致'), { code: 'CONTINUATION_ACTION_MISMATCH', status: 400 });
    if (understandContinuation && body.message) {
      parsed = validateParsedIntent(await parseIntent(body.message, { history: [], env, fetchImpl, requestId,
        context: { action: continuation.action, slots: continuation.slots, pendingSlot: continuation.pendingSlot } }));
      // A model cannot convert an opaque candidate selection into entity IDs.
      // Keep server selections only while their raw references remain unchanged.
      if (parsed.action === continuation.action) {
        selections = { ...continuation.selections };
        for (const key of Object.keys(selections)) if (parsed.slots[key] !== continuation.slots[key]) delete selections[key];
      }
    } else if (body.message && (continuation.action === 'clarify' || switchesTask(body.message, continuation))) {
      if (expectedAction) throw Object.assign(new Error('请调用对应工具开始新任务'), { code: 'CONTINUATION_ACTION_MISMATCH', status: 400 });
      parsed = await parseIntent(body.message, { history, env, fetchImpl, requestId });
    } else {
      if (body.choice && !resolveChoice(body.choice, continuation.choices)) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
      const answer = parseClarificationAnswer(body.message || '', { action: continuation.action, slot: continuation.pendingSlot, slots: continuation.slots, choices: continuation.choices, choice: body.choice, now: now() });
      if (answer.kind === 'choice') {
        const selected = resolveChoice(body.choice || body.message, continuation.choices);
        if (!selected) throw Object.assign(new Error('选项不存在或已失效'), { code: 'INVALID_CHOICE', status: 400 });
        selections = { ...continuation.selections, [continuation.pendingSlot]: { entityId: selected.entityId, optionId: selected.optionId } };
        parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, { [continuation.pendingSlot]: selected.rawValue || selected.label }));
      } else if (answer.kind === 'slot') {
        parsed = buildParsedIntent(continuation.action, mergeSlots(continuation.slots, answer.updates));
        selections = { ...continuation.selections };
        for (const slot of Object.keys(answer.updates)) delete selections[slot];
      } else {
        return clarificationResponse(reply, {
          action: continuation.action,
          slot: continuation.pendingSlot,
          question: questionFor(continuation.action, continuation.pendingSlot, body.message, continuation.slots),
          choices: continuation.choices,
          slots: continuation.slots,
          selections: continuation.selections || {},
          env, now,
          message: '无法识别这次回答，请从候选项中选择或重新描述。',
          source: 'parser',
        });
      }
    }
  } else {
    parsed = initialIntent ?? await parseIntent(body.message, { history, env, fetchImpl, requestId });
  }
  // Apply exactly the same boundary to all configured/injected understanders.
  parsed = validateParsedIntent(parsed);
  replyContext = { slots: parsed.slots };
  if (expectedAction && parsed.action !== expectedAction) throw Object.assign(new Error('工具动作不一致'), { code: 'VALIDATION_ERROR', status: 400 });
  if (['subscription.list', 'product.list'].includes(parsed.action)) {
    const result = await dispatchBanking(parsed.action, {}, { repository });
    if (!result.ok) return reply(502, 'SKILL_ERROR', '只读查询失败，请稍后重试。', errorData('SKILL_ERROR', '只读查询失败，请稍后重试。'));
    const context = await repository.getContextInfo();
    const isSubscription = parsed.action === 'subscription.list';
    return reply(200, 'OK', '只读查询完成。', { status: isSubscription ? 'subscription_result' : 'product_result', action: parsed.action,
      data: { [isSubscription ? 'subscriptions' : 'products']: result.data, context },
      evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: result.data.map(item => item.id) }] });
  }
  const dependencies = {
    billHandler: intent => handleBillSummary(intent, repository),
    transferHandler: intent => handleTransfer(intent, transferRepository(repository, selections)),
    cardHandler: intent => handleCard(intent, repository, selections),
  };
  const dispatched = await dispatchParsedIntent(parsed, dependencies);
  const prepareTransfer = typeof core.prepare === 'function'
    ? { prepare: request => core.prepare({ ...request, origin }) }
    : { prepare: async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Banking Core prepare 未配置', uncertain: true } }) };
  const result = await prepareTransferPreview(dispatched, prepareTransfer);

  if (result.ok && result.kind === 'bill_result') return reply(200, 'OK', '账单统计已生成', { status: 'bill_result', action: result.action, data: { ...result.data, month: parsed.slots.month }, evidence: result.evidence });
  if (result.ok && result.kind === 'card_result') return reply(200, 'OK', '卡片信息已查询', { status: 'card_result', action: result.action, data: result.data, evidence: result.evidence });
  if (result.ok && result.kind === 'card_action_request') {
    const prepared = await core.prepare(result.data.request);
    if (!prepared.ok) return reply(statusFor(prepared.error.code), prepared.error.code, prepared.error.message, { status: 'core_error', action: result.action, ...(prepared.operationId ? { operationId: prepared.operationId } : {}), error: prepared.error });
    const continuationToken = issueState({ action: result.action, slots: parsed.slots, pendingSlot: result.action === 'card.set_budget' ? 'amount' : 'card_ref', selections, env, now });
    return reply(200, 'OK', '卡片正式预览已生成，等待页面确认', { status: 'awaiting_confirmation', action: result.action, operationId: prepared.data.operationId, preview: prepared.data.preview, risk: prepared.data.risk, evidence: result.data.evidence, continuationToken });
  }
  if (result.ok && result.kind === 'transfer_preview') {
    const continuationToken = issueState({ action: 'transfer.create', slots: parsed.slots, pendingSlot: 'amount', selections, env, now });
    const settings = await repository.getDemoSettings();
    const currentMonth = (await repository.getContextInfo()).currentMonth;
    const amountMinor = result.data.preview.exactEffects[0]?.amountFen ?? 0;
    const monthExpenseCount = (await repository.getTransactions({ month: currentMonth })).filter(transaction => transaction.type === 'expense' || transaction.type === 'transfer_out').length;
    const context = {
      monthlyIncomeFen: settings.monthlyIncomeFen,
      incomeRatioPercent: settings.monthlyIncomeFen > 0 ? Math.round((amountMinor / settings.monthlyIncomeFen) * 1000) / 10 : 0,
      expenseCountThisMonth: monthExpenseCount + 1,
    };
    return reply(200, 'OK', '转账正式预览已生成，等待用户确认', { status: result.data.state, action: result.action, operationId: result.data.operationId, preview: result.data.preview, risk: result.data.risk, context, continuationToken });
  }
  if (result.kind === 'needs_clarification') {
    replyContext.reason = result.reason;
    const action = result.action || parsed.action;
    const slots = parsed.slots || {};
    const slot = result.slot || nextMissingSlot(parsed) || (result.candidates ? 'payee_ref' : undefined);
    const choices = slot === 'card_ref' ? cardChoices(result.candidates?.length ? result.candidates : await repository.getCards()) : result.candidates ? payeeChoices(result.candidates) : slot === 'source_account_ref' ? await accountChoices(repository) : slot === 'payee_ref' && !slots.payee_ref ? payeeChoices((await repository.getPayees()).filter(payee => payee.status === 'active')) : [];
    return clarificationResponse(reply, {
      action,
      slot,
      question: result.question || questionFor(action, slot, body.message, slots),
      choices,
      slots,
      selections,
      env, now,
      source: result.source,
    });
  }
  if (result.kind === 'unsupported') return reply(200, 'UNSUPPORTED', '暂不支持该请求', { status: result.kind });
  if (result.kind === 'skill_error') return reply(502, 'SKILL_ERROR', 'Skill 处理失败，请稍后重试。', errorData('SKILL_ERROR', 'Skill 处理失败，请稍后重试。'));
  if (result.kind === 'card_error') return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'card_error', action: result.action, error: result.error });
  if (result.kind === 'core_error') {
    let recovery;
    let continuationToken;
    if (result.action === 'transfer.create' && result.error.code === 'INSUFFICIENT_BALANCE') {
      const resolved = await transferRepository(repository, selections).queryAccount(parsed.slots.source_account_ref);
      const account = resolved && await repository.getAccount(resolved.id);
      const choices = await accountChoices(repository);
      if (account && Number.isSafeInteger(account.availableBalanceFen) && account.availableBalanceFen >= 0 && choices.length) {
        const question = `${account.name}可用余额为 ¥${(account.availableBalanceFen / 100).toFixed(2)}，不足以转出 ¥${(parsed.slots.amount.amount_minor / 100).toFixed(2)}。请重新选择付款账户，或修改金额；已保留收款人和转账草稿。`;
        continuationToken = issueState({ action: result.action, slots: parsed.slots, pendingSlot: 'source_account_ref', choices, selections, env, now });
        recovery = { kind: 'clarification', status: 'needs_clarification', action: result.action, slot: 'source_account_ref', question,
          choices: choices.map(({ optionId, label }) => ({ optionId, label })) };
      }
    }
    return reply(statusFor(result.error.code), result.error.code, result.error.message, { status: 'core_error', action: result.action,
      ...(result.operationId ? { operationId: result.operationId } : {}), error: result.error,
      ...(recovery ? { recovery, continuationToken } : {}) });
  }
  return reply(500, 'INTERNAL_ERROR', '未取得可靠结果', errorData('INTERNAL_ERROR', '未取得可靠结果'));
}
