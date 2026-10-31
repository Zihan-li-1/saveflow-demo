import { digest } from '../agent-framework/safety.mjs';
// Arbitrary user/model strings may contain secrets. Log structure + fingerprints, never free text or financial values.
export function safeRoutingTrace(trace) {
  const fingerprint = value => ({ redacted: true, digest: digest(value ?? null) });
  return {
    event: 'intent_routing', user_query: fingerprint(trace.user_query),
    intent_analysis: fingerprint(trace.intent_analysis),
    decomposed_tasks: (trace.intent_analysis?.tasks ?? []).map((task, index) => ({ task_index: index, goal: fingerprint(task.goal), required_capability: fingerprint(task.required_capability), dependency_count: task.depends_on.length })),
    capability_matches: (trace.capability_matches?.matches ?? []).map(item => ({ task_index: trace.intent_analysis.tasks.findIndex(task => task.task_id === item.task_id), skill_name: item.skill_name, capability: item.capability, confidence: item.confidence, reason: fingerprint(item.reason) })),
    selected_skills: trace.selected_skills ?? [], extracted_arguments: fingerprint(trace.extracted_arguments), missing_fields: fingerprint(trace.missing_fields), execution_plan: fingerprint(trace.execution_plan),
    final_route_decision: trace.final_route_decision, failure_stage: trace.failure_stage ?? null, failure_code: trace.failure_code ?? null,
  };
}
export function emitRoutingTrace(trace, { env = process.env, sink = console.info } = {}) {
  if (env.NODE_ENV === 'production' || env.SAVEFLOW_ROUTING_TRACE !== 'true') return;
  try { sink(safeRoutingTrace(trace)); } catch { /* diagnostics cannot change routing */ }
}
