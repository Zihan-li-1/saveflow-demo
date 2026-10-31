// Deterministic router. Never infers financial values or executes tools.
export class IntentRouter {
  route(request) {
    let selected = request.skill_name;
    const extracted = structuredClone(request.arguments);
    if (!selected && typeof extracted.action === 'string') selected = extracted.action.split('.')[0] === 'subscription' ? 'bill' : extracted.action.split('.')[0];
    if (!selected && !request.steps) {
      const rules = [ ['bill', /账单/, 'bill.summary'], ['card', /查询.*卡|查看.*卡/, 'card.get'], ['wealth', /比较.*理财|理财.*比较/, 'wealth.compare'] ];
      const matches = rules.filter(([, pattern]) => pattern.test(request.query));
      if (matches.length === 1) { selected = matches[0][0]; extracted.action = matches[0][2]; }
      const month = request.query.match(/\b\d{4}-(?:0[1-9]|1[0-2])\b/);
      if (selected === 'bill' && month && extracted.month === undefined) extracted.month = month[0];
    }
    return { intent: selected ?? (request.steps ? 'explicit_sequence' : 'unknown'), confidence: selected || request.steps ? 1 : 0,
      selected_skills: request.steps?.map(step => step.skill_name) ?? (selected ? [selected] : []), extracted_arguments: extracted,
      missing_fields: selected || request.steps ? [] : ['skill_name'], requires_confirmation: false };
  }
}
