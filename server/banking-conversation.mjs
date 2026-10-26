import { createHash } from 'node:crypto';
import { createConversationStore } from './conversation-state.mjs';
import { verifyContinuationToken, issueContinuationToken } from '../src/agent/clarification/continuation-token.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { buildParsedIntent } from '../src/agent/clarification/merge-intent.mjs';
import { canonical } from '../src/banking-core/errors.mjs';

const stores = new WeakMap();
const active = task => task && ['ready', 'awaiting_input', 'awaiting_confirmation'].includes(task.status);
const protectedStates = new Set(['confirmed', 'executing', 'unknown', 'checking', 'preparing', 'risk_check']);
const writeAction = action => action === 'transfer.create' || ['card.set_budget', 'card.set_controls', 'card.freeze', 'card.unfreeze', 'wealth.subscribe', 'wealth.redeem', 'scenario.create_rule', 'scenario.update_rule', 'scenario.disable_rule'].includes(action);
function error(code, message = '会话状态不匹配，请重新选择或开始当前业务。', extra = {}) {
  return Object.assign(new Error(code), { code, status: 409, userMessage: message, ...extra });
}
function hostStore(core, env, now) {
  let entries = stores.get(core);
  if (!entries) { entries = new Map(); stores.set(core, entries); }
  const scope = createHash('sha256').update(`${env.SAVEFLOW_ACCESS_CODE}:${env.CONTINUATION_TOKEN_SECRET}`).digest('hex');
  let host = entries.get(scope);
  if (!host) {
    host = { now, busy: new Set() };
    host.store = createConversationStore({ now: () => host.now(), readCoreOperation: id => core.getOperation(id) });
    entries.set(scope, host);
  }
  host.now = now;
  return host;
}

/** HTTP adapter only. No task IDs, model text or browser snapshots grant Core execution. */
export function openBankingConversation(body, { core, env, now, parseIntent, conversationHost }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('INVALID_REQUEST', '请求体必须为对象。', { status: 400 });
  const invalidFields = Object.keys(body).some(key =>
    !['message', 'history', 'consent', 'continuationToken', 'choice', 'replyStyle', 'planInputs', 'conversationToken', 'conversationRevision', 'taskId', 'taskMode'].includes(key));
  const mode = body.taskMode ?? 'auto';
  const invalidAssociation = !['auto', 'new', 'continue', 'resume', 'sync'].includes(mode) ||
      (body.taskId !== undefined && (typeof body.taskId !== 'string' || !/^task_[a-f0-9-]{36}$/.test(body.taskId))) ||
      (body.conversationRevision !== undefined && (!Number.isSafeInteger(body.conversationRevision) || body.conversationRevision < 0));
  let continuation;
  let continuationError;
  // Explicit new requests do not consume a stale draft sent by an older UI.
  if (body.continuationToken !== undefined && !(mode === 'new' && body.conversationToken)) {
    try { continuation = verifyContinuationToken(body.continuationToken, env.CONTINUATION_TOKEN_SECRET, now()); }
    catch { continuationError = error('CONTINUATION_INVALID', '续接凭据已过期或无效，请重新开始当前业务。', { status: 400 }); }
    if (continuation && !continuation.conversation) continuationError = error('CONTINUATION_INVALID', '旧续接凭据未关联服务端会话，请重新开始当前业务。', { status: 400 });
    if (continuationError && body.conversationToken === undefined) throw continuationError;
  }
  const host = conversationHost ?? hostStore(core, env, now);
  const store = host.store;
  // One completed response per session, bounded by the Store's session lifetime
  // and capacity. A fingerprint is a retry selector, never execution authority.
  host.completed ??= new Map();
  for (const [key, value] of host.completed) if (value.expiresAt <= now()) host.completed.delete(key);
  // Compatibility: a bound encrypted continuation also carries its opaque session
  // selector. This never accepts an internal ID or an unbound stateless token.
  let token = body.conversationToken ?? continuation?.conversation?.token;
  let state;
  if (token !== undefined) state = store.read(token);
  else {
    if (mode === 'resume' || mode === 'continue' || mode === 'sync' || body.taskId || body.conversationRevision !== undefined) throw error('CONVERSATION_NOT_FOUND');
    const created = store.create(); token = created.conversationToken; state = created.state;
  }
  const originalRevision = state.revision;
  let ownsLock = false;
  let accepted = false;
  const fingerprint = body.conversationRevision !== undefined || continuation
    ? createHash('sha256').update(canonical(body)).digest('hex') : undefined;
  const workflowBody = Object.fromEntries(Object.entries(body).filter(([key]) =>
    ['message', 'history', 'consent', 'continuationToken', 'choice', 'replyStyle', 'planInputs'].includes(key)));
  if (mode === 'new') { delete workflowBody.continuationToken; continuation = undefined; }
  // Old chat history can explain language, but cannot donate another task's slots.
  if (!continuation) workflowBody.history = [];
  const commit = async command => { state = await store.transition(token, state.revision, command); return state; };
  const taskById = id => state.currentTask?.taskId === id ? state.currentTask : state.suspendedTasks.find(task => task.taskId === id);
  const intentWithoutChoice = intent => { const draft = { ...intent }; delete draft.choice; return draft; };
  const refresh = async references => {
    for (const ref of references) await commit({ type: 'observe_operation', operationId: ref.operationId });
  };
  const locked = ref => { throw error('CONVERSATION_OPERATION_LOCKED', '原操作已确认、正在执行或结果待核实，已查询原操作状态，请保留原编号继续核实，不能修改或重复提交。',
    { operationId: ref.operationId, action: ref.action, uncertain: true }); };
  const guardTask = async id => {
    await refresh(state.operationReferences.filter(ref => ref.taskId === id));
    const blocked = state.operationReferences.find(ref => ref.taskId === id && protectedStates.has(ref.coreState));
    if (blocked) locked(blocked);
    if (state.operationReferences.some(ref => ref.taskId === id && ref.coreState === 'succeeded')) throw error('CONVERSATION_TASK_FINISHED', '原任务已有成功操作，请查询原回执；新的业务需要另建任务。');
    const task = taskById(id);
    if (!task || (!active(task) && task.status !== 'suspended')) throw error('CONVERSATION_TASK_FINISHED', '原任务已结束或过期，请发起新的业务。');
  };
  const guardWrites = async () => {
    await refresh(state.operationReferences.filter(ref => !['succeeded', 'failed', 'cancelled'].includes(ref.coreState)));
    const blocked = state.operationReferences.find(ref => protectedStates.has(ref.coreState));
    if (blocked) locked(blocked);
  };
  return {
    body: workflowBody,
    syncOnly: mode === 'sync',
    resumeOnly: mode === 'resume' && body.message === undefined && body.choice === undefined && body.planInputs === undefined,
    async begin() {
      if (host.busy.has(token)) throw error('CONVERSATION_BUSY', '同一会话正在处理请求，请等待当前请求完成。');
      host.busy.add(token); ownsLock = true;
      if (invalidFields || invalidAssociation) throw error('INVALID_REQUEST', '请求包含无效或未注册的会话字段。', { status: 400 });
      if (continuationError) throw continuationError;
      const previous = host.completed.get(token);
      if (fingerprint && previous?.fingerprint === fingerprint && previous.revision === state.revision && previous.expiresAt > now()) {
        // A Core decision may have happened outside chat since this response.
        // Never replay an apparently actionable preview over a changed result.
        if (previous.operationId) {
          for (const ref of state.operationReferences.filter(ref => ref.taskId === previous.taskId)) {
            const operation = await core.getOperation(ref.operationId);
            if (!operation.ok || operation.data.state !== ref.coreState ||
                (ref.operationId === previous.operationId && !(Date.parse(operation.data.preview?.expiresAt) > now()))) {
              await guardTask(previous.taskId);
              throw error('CONVERSATION_REVISION_CONFLICT');
            }
          }
        }
        return new Response(previous.body, { status: previous.status, headers: previous.headers });
      }
      if (body.conversationRevision !== undefined && body.conversationRevision !== originalRevision) throw error('CONVERSATION_REVISION_CONFLICT', '会话已更新，请使用最新任务和续接凭据。');
      if (mode === 'sync') {
        if (body.message !== undefined || body.choice !== undefined || body.planInputs !== undefined || body.continuationToken !== undefined || body.taskId !== undefined) throw error('INVALID_REQUEST', '会话核验不能提交业务参数。', { status: 400 });
        await refresh(state.operationReferences.filter(ref => !['succeeded', 'failed', 'cancelled'].includes(ref.coreState)));
        return;
      }
      if (continuation) {
        if (continuation.conversation.token !== token || (body.taskId && body.taskId !== continuation.conversation.taskId)) throw error('CONVERSATION_TASK_MISMATCH');
        const task = taskById(continuation.conversation.taskId);
        if (!task || task.action !== continuation.action || task.continuationExpiresAt <= now() ||
            task.latestContinuationId !== continuation.tokenId) throw error('CONTINUATION_STALE', '该续接凭据已被更新或已失效，请使用最新选项。');
        if (mode === 'resume') {
          if (body.taskId !== task.taskId || (task.status !== 'suspended' && !(state.currentTask?.taskId === task.taskId && active(task)))) throw error('CONVERSATION_TASK_MISMATCH');
          await guardTask(task.taskId);
          if (task.status === 'suspended') await commit({ type: 'resume_task', taskId: task.taskId, suspendCurrent: true });
        } else {
          if (state.currentTask?.taskId !== task.taskId || !active(task)) throw error('CONVERSATION_TASK_MISMATCH', '该任务已挂起，请明确选择恢复原任务。');
          await guardTask(task.taskId);
        }
      } else if (mode === 'continue' || mode === 'resume' || body.choice || body.planInputs || body.taskId) {
        throw error('CONTINUATION_INVALID', '补充、选择或恢复任务需要有效的原任务续接凭据。', { status: 400 });
      }
    },
    async acceptIntent(proposal, modelOptions) {
      let intent = proposal;
      if (intent.action === 'unsupported') return intent;
      let same = continuation && intent.action === continuation.action;
      if (continuation && !same && intent.action !== 'clarify') {
        if (mode === 'continue' || mode === 'resume') throw error('CONVERSATION_ACTION_MISMATCH');
        // A switch suggested by the model must be understood independently before
        // it can become another task. No old slots, selections or token are passed.
        intent = validateParsedIntent(await parseIntent(body.message, { ...modelOptions, history: [] }));
        if (intent.action !== proposal.action) throw error('CONVERSATION_ACTION_MISMATCH');
        same = false;
      }
      const draft = intentWithoutChoice(intent);
      if (same) {
        await guardTask(continuation.conversation.taskId);
        await commit({ type: 'update_task', taskId: continuation.conversation.taskId, intent: draft });
      } else {
        if (writeAction(intent.action)) await guardWrites();
        if (state.currentTask?.action === 'clarify' && active(state.currentTask)) await commit({ type: 'end_task', taskId: state.currentTask.taskId, outcome: 'cancelled' });
        await commit({ type: 'start_task', intent: draft, suspendCurrent: true });
      }
      accepted = true;
      return intent;
    },
    async prepare(request) {
      if (!accepted || !active(state.currentTask)) throw error('CONVERSATION_INVALID_TRANSITION');
      await guardWrites();
      return core.prepare(request);
    },
    async finish(result) {
      const data = result.data;
      if (!data) return result;
      const target = data.recovery ?? data;
      const raw = target.continuationToken ?? data.continuationToken;
      let payload;
      if (raw) payload = verifyContinuationToken(raw, env.CONTINUATION_TOKEN_SECRET, now());
      if (payload) {
        const draft = buildParsedIntent(payload.action, payload.slots);
        if (!accepted || JSON.stringify(state.currentTask?.verifiedSlots) !== JSON.stringify(payload.slots)) {
          if (active(state.currentTask) && state.currentTask.action === payload.action) await commit({ type: 'update_task', taskId: state.currentTask.taskId, intent: draft });
          else await commit({ type: 'start_task', intent: draft, suspendCurrent: true });
        }
      }
      if (['awaiting_confirmation', 'scenario_rule_preview'].includes(data.status) && data.operationId) {
        await commit({ type: 'attach_preview', taskId: state.currentTask.taskId, operationId: data.operationId });
      }
      if (payload) {
        const expiresAt = Math.min(payload.expiresAt, state.expiresAt);
        const bound = issueContinuationToken({ ...payload, conversation: { token, taskId: state.currentTask.taskId } }, env.CONTINUATION_TOKEN_SECRET, now(), expiresAt - now());
        const issued = verifyContinuationToken(bound, env.CONTINUATION_TOKEN_SECRET, now());
        await commit({ type: 'set_continuation', taskId: state.currentTask.taskId, tokenId: issued.tokenId, expiresAt: issued.expiresAt,
          ...(payload.pendingSlot ? { pendingSlot: payload.pendingSlot } : {}), awaitingInput: ['needs_clarification', 'needs_plan_inputs'].includes(target.status) });
        target.continuationToken = bound;
        if (data.continuationToken) data.continuationToken = bound;
      } else if (data.status === 'cancelled' && active(state.currentTask)) {
        await commit({ type: 'end_task', taskId: state.currentTask.taskId, outcome: 'cancelled' });
      } else if (result.code === 'OK' && !['awaiting_confirmation', 'scenario_rule_preview'].includes(data.status) && active(state.currentTask)) {
        // Plan input submission bypasses language understanding, but still ends the
        // matching authenticated goal rather than leaving __plan_inputs pending.
        if (continuation && !accepted) await commit({ type: 'update_task', taskId: state.currentTask.taskId, intent: buildParsedIntent(continuation.action, continuation.slots) });
        await commit({ type: 'end_task', taskId: state.currentTask.taskId, outcome: 'completed' });
      }
      return result;
    },
    metadata() {
      try { state = store.read(token); } catch { return undefined; }
      const task = value => value ? { taskId: value.taskId, action: value.action, status: value.status, expiresAt: value.continuationExpiresAt } : null;
      return { token, revision: state.revision, expiresAt: state.expiresAt, currentTask: task(state.currentTask),
        suspendedTasks: state.suspendedTasks.map(task), operationReferences: state.operationReferences.map(ref => ({ operationId: ref.operationId, taskId: ref.taskId, coreState: ref.coreState })) };
    },
    remember(response, envelope) {
      if (!ownsLock || !accepted || !fingerprint || !response.ok) return;
      host.completed.set(token, { fingerprint, revision: state.revision,
        expiresAt: Math.min(state.expiresAt, state.currentTask?.continuationExpiresAt ?? state.expiresAt),
        taskId: state.currentTask?.taskId, operationId: envelope.data?.operationId,
        body: JSON.stringify(envelope), status: response.status, headers: Object.fromEntries(response.headers) });
    },
    release() { if (ownsLock) { host.busy.delete(token); ownsLock = false; } },
  };
}
