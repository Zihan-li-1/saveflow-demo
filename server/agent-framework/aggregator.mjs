import { fail } from './models.mjs';
import { redact } from './safety.mjs';

export class ResultAggregator {
  aggregate(plan) {
    if (!plan.steps.length || plan.steps.some(step => step.status !== 'succeeded' || step.result?.status !== 'succeeded')) fail('SKILL_EXECUTION_FAILED');
    return redact({ steps: plan.steps.map(step => ({ step_id: step.step_id, skill_name: step.skill_name, data: step.result.data, metadata: step.result.metadata })), financial_execution: false });
  }
}
