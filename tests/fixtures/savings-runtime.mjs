import { savingsAdviceAgentSpec } from '../../server/trueforge-savings-runtime.mjs';

// Offline model/SDK fixture only. Production always requires model generation.
export function savingsAdviceFixture(facts) {
  const observations = Object.keys(facts.recent.category_expenses_minor).flatMap(category => {
    const previous = facts.history.filter(month => Object.hasOwn(month.category_expenses_minor, category));
    if (!previous.length) return [];
    const average = previous.reduce((sum, month) => sum + month.category_expenses_minor[category], 0) / previous.length;
    const delta = facts.recent.category_expenses_minor[category] - average;
    const threshold = Math.max(1000, average * .1);
    return [{ category, trend: delta > threshold ? 'up' : delta < -threshold ? 'down' : 'flat',
      evidence_refs: [`recent:${category}`, `history:${previous[0].month}:${category}`], reason: '近期与历史分类支出对比仍有不确定性', uncertain: true }];
  });
  return { observations,
    category_budgets: Object.entries(facts.recent.category_expenses_minor).map(([category, suggested_minor]) => ({ category, suggested_minor, reason: '按近期支出暂作参考', evidence_refs: [`recent:${category}`] })),
    caveats: ['历史记录有限，未来收支可能变化，预算不保证达标'],
    self_review: { passed: true, data_coverage: true, category_evidence: true, fixed_costs: true, budget_totals: true, uncertainty: true, failed_items: [] },
  };
}

export function savingsSdkFixture({ env, output, mutateSpec = () => {}, mutateEvents = () => {}, beforeGet = () => {} }) {
  const seen = { creates: [], inputs: [], cancels: [], gets: [] };
  const sessions = new Map();
  return { seen, sessions: {
    create: async request => {
      seen.creates.push(structuredClone(request));
      const spec = savingsAdviceAgentSpec(env); mutateSpec(spec);
      const session = { id: `savings-${sessions.size + 1}`, shared: false, agent: { spec } };
      sessions.set(session.id, session); return { data: session };
    },
    get: async id => { seen.gets.push(id); beforeGet(sessions.get(id)); return { data: sessions.get(id) }; },
    cancel: async id => { seen.cancels.push(id); },
    createTurnStream: async (id, request) => {
      seen.inputs.push({ id, request });
      const content = typeof output === 'function' ? output(JSON.parse(request.input[0].content)) : output;
      const message = { type: 'model.message', id: 'message', threadId: 'main', finishReason: 'stop', content };
      const events = [{ type: 'turn.created', id: 'created', turnId: 'turn' }, message,
        { type: 'turn.done', id: 'done', state: { status: 'done', requiredActions: [], output: structuredClone(message) } }];
      mutateEvents(events);
      return { withMetadata: async function* () { for (const data of events) yield { data }; } };
    },
  } };
}
