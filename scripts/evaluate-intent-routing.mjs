// --mock-regressions records explicit fixtures; --live evaluates the reviewed corpus using the configured real model.
import { writeFile } from 'node:fs/promises';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { createInMemoryScenarioStore } from '../src/skills/scenario/scenario-skill.mjs';
import { registerExistingSkills } from '../server/agent-framework/adapters.mjs';
import { IntentUnderstanding } from '../server/intent-routing/service.mjs';
import { routingExamples } from '../server/intent-routing/examples.mjs';
import { MockSemanticModel, regressionCases } from '../tests/fixtures/intent-routing-cases.mjs';

const live = process.argv.includes('--live');
if (!live && !process.argv.includes('--mock-regressions')) throw new Error('Use --live or --mock-regressions explicitly');
if (live && (!process.env.TRUEFORGE_MODEL || !process.env.TRUEFORGE_BASE_URL)) throw new Error('Live model is not configured; no accuracy metric can be produced');
const registry = registerExistingSkills(createBankingCore().repository, createInMemoryScenarioStore());
const results = [];
const cases = live ? [...routingExamples, ...regressionCases] : regressionCases;
for (const item of cases) {
  const service = new IntentUnderstanding({ registry, ...(live ? {} : { model: new MockSemanticModel(item.stages) }) });
  const result = await service.route(item.query);
  const acceptable = item.expected ? result.decision === item.expected
    : item.kind === 'counter' ? !result.selected_skills.includes(item.skill)
      : item.kind === 'ambiguous' ? ['CLARIFICATION_REQUIRED', 'PARTIALLY_SUPPORTED'].includes(result.decision)
        : result.selected_skills.includes(item.skill) && ['MATCHED', 'CLARIFICATION_REQUIRED'].includes(result.decision);
  results.push({ case_id: item.id, passed: acceptable && !result.failure_stage, query: item.query,
    intent_analysis: result.intent_analysis, capability_matches: result.capability_matches,
    selected_skills: result.selected_skills, extracted_arguments: result.execution_plan.steps.map(step => step.arguments), missing_fields: result.missing_fields,
    unsupported_parts: result.unsupported_parts, execution_plan: result.execution_plan, final_route_decision: result.decision, failure_stage: result.failure_stage });
}
const report = { mode: live ? 'live_model' : 'explicit_model_response_mock', live_accuracy_verified: live, total: results.length, passed: results.filter(item => item.passed).length, results };
await writeFile(new URL(`../docs/verification/intent-routing-${live ? 'live' : 'mock'}-report.json`, import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ mode: report.mode, total: report.total, passed: report.passed }));
if (report.passed !== report.total) process.exitCode = 1;
