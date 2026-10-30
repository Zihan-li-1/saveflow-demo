import { writeFile, mkdir } from 'node:fs/promises';
import { createBankingCore } from '../src/banking-core/core.mjs';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { handleBankingAgent } from '../server/banking-agent.mjs';
import { createPlanningRuntimeClient } from '../server/planning-runtime.mjs';

const required = ['TRUEFORGE_BASE_URL', 'TRUEFORGE_MODEL', 'SAVEFLOW_ACCESS_CODE', 'CONTINUATION_TOKEN_SECRET'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`真实模型验证未执行：缺少 ${missing.join(', ')}。`);
  process.exitCode = 2;
} else {
  const core = createBankingCore({ source: seed });
  const live = createPlanningRuntimeClient({ env: process.env });
  const events = [];
  const client = {
    createSession: signal => live.createSession(signal),
    cancel: sessionId => live.cancel(sessionId),
    async runTurn(sessionId, message, signal) {
      const input = JSON.parse(message);
      const output = await live.runTurn(sessionId, message, signal);
      let proposal;
      try { proposal = JSON.parse(output); } catch { proposal = { kind: 'invalid_json' }; }
      events.push({ turn: events.length + 1,
        observed: input.observations.map(item => ({ tool: item.tool, status: item.status, hasResult: !!item.result })),
        proposal: { kind: proposal.kind, tool: proposal.plan_request?.tool,
          command: proposal.task_control?.command, evidenceTools: proposal.task_control?.evidence_tools } });
      return output;
    },
  };
  const request = new Request('http://localhost/api/banking-agent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saveflow-access': process.env.SAVEFLOW_ACCESS_CODE },
    body: JSON.stringify({ message: '8月支出增加是不是订阅造成的？不要执行任何修改。', planning: true }),
  });
  const response = await handleBankingAgent(request, { env: process.env, core, planningRuntimeClient: client });
  const payload = await response.json();
  const report = { mode: 'real_trueforge', recordedAt: new Date().toISOString(), httpStatus: response.status,
    resultStatus: payload.data?.status, events,
    steps: payload.data?.plan?.steps?.map(step => ({ stepId: step.stepId, tool: step.tool, dependsOn: step.depends_on,
      status: step.status, evidence: step.result?.result?.evidence?.map(item => ({ source: item.source, asOf: item.asOf, entityCount: item.entityIds?.length })) })),
    audit: payload.data?.plan?.audit, errorCode: response.ok ? undefined : payload.code };
  await mkdir('docs/evidence', { recursive: true });
  const path = `docs/evidence/planning-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(path);
  if (!response.ok) process.exitCode = 1;
}
