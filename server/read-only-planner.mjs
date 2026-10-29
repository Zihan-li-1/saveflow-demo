import { randomUUID } from 'node:crypto';
import { withTrueforgeDeadline } from './trueforge-tool-result.mjs';
import { validateAgentProposalV2, proposalFingerprint } from './agent-proposal-v2.mjs';
import { createReadOnlyToolGateway } from './read-only-tool-gateway.mjs';

const maxSteps = 6;

function modelSafe(value) {
  if (Array.isArray(value)) return value.map(modelSafe);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:^|_)(?:id|ids|token|operation|preview_hash|entity_ids)(?:$|_)/i.test(key) && key !== 'toolCallId')
    .map(([key, item]) => [key, modelSafe(item)]));
}

function safeResult(step) {
  const raw = step.result?.result;
  return { stepId: step.stepId, tool: step.tool, status: step.status, result: modelSafe(raw?.data), evidence: raw?.evidence?.map(({ entityIds, ...entry }) => ({ ...entry, entityCount: entityIds?.length ?? 0 })) ?? [] };
}

export async function runReadOnlyPlanner({ message, history = [], constraints = {}, repository, wealthPorts, runtimeClient, env = process.env, now = Date.now, timezone = 'Asia/Shanghai', signal, requestId = randomUUID(), conversation = {}, taskId: suppliedTaskId }) {
  void env; void wealthPorts;
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw Object.assign(new Error('规划目标必须是 1-2000 字符。'), { code: 'INVALID_REQUEST', status: 400 });
  if (!runtimeClient || typeof runtimeClient.createSession !== 'function' || typeof runtimeClient.runTurn !== 'function') throw Object.assign(new Error('规划服务不可用。'), { code: 'MODEL_UNAVAILABLE', status: 502 });
  const gateway = createReadOnlyToolGateway({ repository, wealthPorts, now, timezone });
  const taskId = suppliedTaskId ?? `plan_${randomUUID()}`; const steps = []; const seen = new Set(); const audit = [];
  const input = () => JSON.stringify({ proposalVersion: '2.0.0', task: { taskId, goal: message, constraints, maxSteps, conversationRevision: conversation.revision ?? null }, userMessage: message, history: history.slice(-12), observations: steps.map(safeResult) });
  return withTrueforgeDeadline({ client: runtimeClient, signal, timeoutMs: 25000 }, async sessionId => {
    for (let iteration = 0; iteration < maxSteps; iteration++) {
      const raw = await runtimeClient.runTurn(sessionId, input(), signal);
      let proposal;
      try { proposal = validateAgentProposalV2(JSON.parse(raw)); }
      catch (error) { audit.push({ iteration, status: 'rejected', reason: error.code ?? 'PROPOSAL_INVALID' }); throw Object.assign(new Error('规划模型输出未通过校验。'), { code: 'MODEL_FORMAT_ERROR', status: 502, cause: error }); }
      audit.push({ iteration, kind: proposal.kind, tool: proposal.plan_request?.tool, status: 'accepted' });
      if (proposal.kind === 'plan_request') {
        const fingerprint = `${proposal.plan_request.tool}:${proposalFingerprint(proposal.plan_request.arguments)}`;
        if (seen.has(fingerprint)) { audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'DUPLICATE_TOOL_CALL'; return { status: 'partial', taskId, goal: message, steps, audit, reason: '模型重复请求同一只读工具，已停止循环。', conversation }; }
        if (steps.length >= maxSteps) return { status: 'partial', taskId, goal: message, steps, audit, reason: '达到规划步数上限。', conversation };
        seen.add(fingerprint);
        const dependsOn = (proposal.plan_request.depends_on ?? []).map(tool => steps.findLast(step => step.tool === tool)?.stepId).filter(Boolean);
        const step = { stepId: `step_${randomUUID()}`, tool: proposal.plan_request.tool, depends_on: dependsOn, status: 'running' };
        steps.push(step);
        try { step.result = await gateway.execute(step.tool, proposal.plan_request.arguments, { source: 'formal_repository', requestId }); step.status = step.result.result.ok === false ? 'failed' : 'completed'; }
        catch (error) { step.status = 'failed'; step.error = { code: error.code ?? 'READ_ONLY_TOOL_FAILED', message: '只读工具未返回可验证结果。' }; audit.at(-1).status = 'tool_failed'; return { status: 'partial', taskId, goal: message, steps, audit, reason: step.error.message, conversation }; }
        continue;
      }
      if (proposal.kind === 'business_intent') return { status: 'business_intent', taskId, goal: message, proposal, steps, audit, conversation };
      if (proposal.kind === 'clarify') return { status: 'needs_clarification', taskId, goal: message, question: proposal.clarify.question, steps, audit, conversation };
      if (proposal.kind === 'unsupported') return { status: 'unsupported', taskId, goal: message, reason: proposal.unsupported.reason, steps, audit, conversation };
      if (proposal.kind === 'task_control') return { status: proposal.task_control.command === 'cancel' ? 'cancelled' : 'completed', taskId, goal: message, steps, audit, conversation };
    }
    return { status: 'partial', taskId, goal: message, steps, audit, reason: '达到规划步数上限。', conversation };
  });
}
