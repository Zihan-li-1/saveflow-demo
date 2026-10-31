import { IntentAnalysis, ParameterExtraction, RoutingError, validateStage } from './contracts.mjs';
import { SemanticModel } from './runtime.mjs';
import { CapabilityMatcher } from './matcher.mjs';
import { TaskPlanner, validateTaskGraph } from './planner.mjs';
import { routingContext } from './context.mjs';
import { emitRoutingTrace } from './trace.mjs';
import { understandingContext } from '../understanding-context.mjs';
import { understandingExamples } from './examples.mjs';

export class IntentUnderstanding {
  constructor({ registry, model = new SemanticModel(), now = Date.now, timezone = 'Asia/Shanghai', traceOptions = {} }) {
    Object.assign(this, { registry, model, now, timezone, traceOptions }); this.matcher = new CapabilityMatcher(model); this.planner = new TaskPlanner(registry);
  }
  async route(message, { run, trustedContext, signal, context = routingContext(run, trustedContext) } = {}) {
    const definitions = this.registry.list(); const calendar = understandingContext({ now: this.now, timezone: this.timezone });
    const trace = { user_query: message }; let stage = 'understanding';
    const finish = result => {
      Object.assign(trace, { selected_skills: result.selected_skills, missing_fields: result.missing_fields, execution_plan: result.execution_plan, final_route_decision: result.decision });
      emitRoutingTrace(trace, this.traceOptions);
      return { ...result, intent_analysis: trace.intent_analysis ?? null, capability_matches: trace.capability_matches ?? null, failure_stage: trace.failure_stage ?? null };
    };
    try {
      const analysis = validateStage(IntentAnalysis, await this.model.complete('understanding', { user_message: message, conversation_context: context, calendar, examples: understandingExamples }, IntentAnalysis, signal), 'understanding');
      validateTaskGraph(analysis); trace.intent_analysis = analysis;
      if (!analysis.tasks.length) return finish({ decision: analysis.unsupported_parts.length && !analysis.missing_information.length ? 'UNSUPPORTED' : 'CLARIFICATION_REQUIRED', selected_skills: [], missing_fields: analysis.missing_information.length ? analysis.missing_information : analysis.unsupported_parts.length ? [] : [{ task_id: null, field: 'goal', question: '请说明希望查询的信息或完成的目标。' }], unsupported_parts: analysis.unsupported_parts, execution_plan: { steps: [] } });
      stage = 'matching';
      const matching = await this.matcher.match(analysis, definitions, signal); trace.capability_matches = matching;
      const unsupported = [...analysis.unsupported_parts, ...matching.unmatched_tasks.filter(item => !item.clarification_required).map(item => ({ capability: item.capability, reason: item.reason }))];
      const ambiguous = matching.unmatched_tasks.filter(item => item.clarification_required).map(item => ({ task_id: item.task_id, field: 'goal', question: item.reason }));
      const selected = [...new Set(matching.matches.map(item => item.skill_name))];
      stage = 'extraction';
      const targets = matching.matches.map(match => ({ ...match, task: analysis.tasks.find(task => task.task_id === match.task_id), capability_definition: definitions.find(item => item.name === match.skill_name).capabilities.find(item => item.id === match.capability) }));
      const extracted = targets.length ? validateStage(ParameterExtraction, await this.model.complete('extraction', { user_message: message, conversation_context: context, calendar, matched_tasks: targets }, ParameterExtraction, signal), 'extraction') : { tasks: [] };
      trace.extracted_arguments = extracted;
      stage = 'planning'; const plan = this.planner.build(analysis, matching, extracted, definitions, { message, context, calendar });
      const missing = [...analysis.missing_information, ...ambiguous, ...plan.missing,
        ...matching.matches.filter(item => item.confidence < 0.8).map(item => ({ task_id: item.task_id, field: 'goal', question: '请确认这一步具体希望完成什么目标。' }))];
      // Missing input takes priority, but unsupported subgoals are always returned too.
      const decision = missing.length ? 'CLARIFICATION_REQUIRED' : unsupported.length ? selected.length ? 'PARTIALLY_SUPPORTED' : 'UNSUPPORTED' : selected.length ? 'MATCHED' : 'UNSUPPORTED';
      return finish({ decision, selected_skills: selected, missing_fields: missing, unsupported_parts: unsupported, execution_plan: { steps: plan.steps } });
    } catch (error) {
      trace.failure_stage = error instanceof RoutingError ? error.stage : stage; trace.failure_code = error instanceof RoutingError ? error.code : 'ROUTING_VALIDATION_FAILED';
      return finish({ decision: 'CLARIFICATION_REQUIRED', selected_skills: [], missing_fields: [{ task_id: null, field: 'understanding', question: trace.failure_code === 'MODEL_NOT_CONFIGURED' || trace.failure_code === 'MODEL_UNAVAILABLE' ? '语义理解服务暂不可用；请稍后重试，或使用明确的结构化动作参数。' : '尚未可靠理解请求，请明确目标和必要信息；未执行任何操作。' }], unsupported_parts: [], execution_plan: { steps: [] }, reason_code: trace.failure_code });
    }
  }
}
