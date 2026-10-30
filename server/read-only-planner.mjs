import { randomUUID } from 'node:crypto';
import { withTrueforgeDeadline } from './trueforge-tool-result.mjs';
import { validateAgentProposalV2, proposalFingerprint } from './agent-proposal-v2.mjs';
import { createReadOnlyToolGateway } from './read-only-tool-gateway.mjs';
import { understandingContext } from './understanding-context.mjs';

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
  const gateway = createReadOnlyToolGateway({ repository, constraints, wealthPorts, now, timezone });
  const taskId = suppliedTaskId ?? `plan_${randomUUID()}`; const steps = []; const seen = new Set(); const audit = [];
  const input = () => JSON.stringify({ schemaVersion: '2.0.0', calendar: understandingContext({ now, timezone }), task: { taskId, goal: message, constraints, maxSteps, conversationRevision: conversation.revision ?? null }, userMessage: message, history: history.slice(-12), observations: steps.map(safeResult) });
  return withTrueforgeDeadline({ client: runtimeClient, signal, timeoutMs: 25000 }, async (sessionId, turnSignal) => {
    for (let iteration = 0; iteration < maxSteps; iteration++) {
      const raw = await runtimeClient.runTurn(sessionId, input(), turnSignal);
      let proposal;
      try { proposal = validateAgentProposalV2(JSON.parse(raw)); }
      catch (error) { audit.push({ iteration, status: 'rejected', reason: error.code ?? 'PROPOSAL_INVALID' });
        return { status: 'partial', taskId, goal: message, steps, audit, reason: '规划模型输出未通过只读校验。' }; }
      audit.push({ iteration, kind: proposal.kind, tool: proposal.plan_request?.tool,
        basis: steps.length ? steps.map(step => ({ stepId: step.stepId, tool: step.tool, status: step.status })) : 'user_goal', status: 'accepted' });
      if (proposal.kind === 'plan_request') {
        const fingerprint = `${proposal.plan_request.tool}:${proposalFingerprint(proposal.plan_request.arguments)}`;
        if (seen.has(fingerprint)) { audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'DUPLICATE_TOOL_CALL'; return { status: 'partial', taskId, goal: message, steps, audit, reason: '模型重复请求同一只读工具，已停止循环。' }; }
        if (steps.length >= maxSteps) return { status: 'partial', taskId, goal: message, steps, audit, reason: '达到规划步数上限。' };
        seen.add(fingerprint);
        const dependencyTools = proposal.plan_request.depends_on ?? [];
        if (dependencyTools.some(tool => !steps.some(step => step.tool === tool && step.status === 'completed'))) {
          audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'DEPENDENCY_NOT_COMPLETED';
          return { status: 'partial', taskId, goal: message, steps, audit, reason: '规划依赖的只读步骤尚未完成。' };
        }
        const dependsOn = dependencyTools.map(tool => steps.findLast(step => step.tool === tool).stepId);
        const step = { stepId: `step_${randomUUID()}`, tool: proposal.plan_request.tool, depends_on: dependsOn, status: 'running' };
        steps.push(step);
        try { step.result = await gateway.execute(step.tool, proposal.plan_request.arguments, { source: 'formal_repository', requestId }); step.status = 'completed'; audit.at(-1).resultStatus = 'completed'; }
        catch (error) {
          if (error.code === 'READ_ONLY_USER_CONSTRAINT_REQUIRED') {
            step.status = 'rejected'; audit.at(-1).status = 'rejected'; audit.at(-1).resultStatus = 'not_executed'; audit.at(-1).reason = error.code;
            return { status: 'needs_clarification', taskId, goal: message, steps, audit, question: '请明确理财风险上限、期限和流动性要求后再进行筛选。' };
          }
          step.status = 'failed'; step.error = { code: error.code ?? 'READ_ONLY_TOOL_FAILED', message: '只读工具未返回可验证结果。' }; audit.at(-1).status = 'tool_failed'; audit.at(-1).resultStatus = 'failed'; audit.at(-1).reason = step.error.code;
          return { status: 'partial', taskId, goal: message, steps, audit, reason: step.error.message };
        }
        continue;
      }
      if (proposal.kind === 'business_intent') return { status: 'business_intent', taskId, goal: message, steps, audit };
      if (proposal.kind === 'clarify') return { status: 'needs_clarification', taskId, goal: message, question: proposal.clarify.question, steps, audit };
      if (proposal.kind === 'unsupported') return { status: 'unsupported', taskId, goal: message, reason: proposal.unsupported.reason, steps, audit };
      if (proposal.kind === 'task_control') {
        const cited = proposal.task_control.evidence_tools ?? [];
        if (proposal.task_control.command === 'finish' && !steps.length) {
          audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'NO_VERIFIED_TOOL_RESULT';
          return { status: 'partial', taskId, goal: message, steps, audit, reason: '规划没有取得已验证的只读结果。' };
        }
        if (proposal.task_control.command === 'finish' && steps.length && (!proposal.task_control.analysis || !cited.length)) {
          audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'ANALYSIS_EVIDENCE_REQUIRED';
          return { status: 'partial', taskId, goal: message, steps, audit, reason: '模型未给出有依据的分析。' };
        }
        if (cited.some(tool => !steps.some(step => step.tool === tool && step.status === 'completed'))) {
          audit.at(-1).status = 'rejected'; audit.at(-1).reason = 'UNVERIFIED_EVIDENCE_REFERENCE';
          return { status: 'partial', taskId, goal: message, steps, audit, reason: '分析引用了未完成的工具结果。' };
        }
        const evidenceSteps = steps.filter(step => cited.includes(step.tool) && step.status === 'completed').map(step => step.stepId);
        return { status: proposal.task_control.command === 'cancel' ? 'cancelled' : 'completed', taskId, goal: message, steps, audit,
          analysis: proposal.task_control.analysis ?? '', evidenceSteps };
      }
    }
    return { status: 'partial', taskId, goal: message, steps, audit, reason: '达到规划步数上限。' };
  });
}
