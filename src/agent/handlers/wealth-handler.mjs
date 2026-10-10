import { randomUUID } from 'node:crypto';
import { runResolvedWealthIntent, validateWealthIntent } from '../../skills/wealth/wealth-skill.mjs';

function match(ref, items, label) {
  const raw = ref.trim().replace(/^模拟/, '');
  const candidates = items.filter(item => item.name === ref || item.name.replace(/^模拟/, '') === raw || item.name.includes(raw));
  if (candidates.length !== 1) return {
    ok: false, kind: 'needs_clarification', source: 'resolver', slot: label,
    question: candidates.length ? '找到多个符合描述的对象，请明确名称。' : '没有找到符合描述的对象，请从列表中选择。',
    candidates: items.map(item => ({ id: item.id, name: item.name })),
  };
  return { ok: true, item: candidates[0] };
}

/** The model supplies only raw wording. All entity IDs are obtained from trusted repository/ports. */
export async function handleWealth(intent, repository, ports, selections = {}) {
  try {
    validateWealthIntent({ action: intent.action, slots: intent.slots });
    if (!ports || typeof ports.getHoldings !== 'function') return { ok: false, kind: 'wealth_error', action: intent.action, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Wealth Mock 服务未配置', uncertain: false } };
    const slots = intent.slots;
    const resolved = {};
    const references = [];
    const products = await repository.getInvestmentProducts();
    const holdings = await ports.getHoldings();
    const accounts = await repository.getAccounts();
    const resolve = (slot, raw, items, type) => {
      const selected = selections[slot]?.entityId;
      const result = selected ? { ok: true, item: items.find(item => item.id === selected) } : match(raw, items, slot);
      if (!result.ok) return result;
      if (!result.item) return { ok: false, kind: 'wealth_error', action: intent.action, error: { code: 'VALIDATION_ERROR', message: '选择的对象已失效', uncertain: false } };
      references.push({ slot, entity_type: type, entity_id: result.item.id, source: selected ? 'user_selection' : 'financial_context' });
      return result;
    };
    if (intent.action === 'wealth.recommend') {
      resolved.goal = slots.goal;
      if (slots.constraints !== undefined) resolved.constraints = slots.constraints;
    } else if (intent.action === 'wealth.assess_risk') resolved.assessment_scope = slots.assessment_scope;
    else if (intent.action === 'wealth.compare') {
      const ids = [];
      for (const raw of slots.product_refs) {
        const result = resolve('product_refs', raw, products, 'investment_product');
        if (!result.ok) return { ...result, action: intent.action };
        ids.push(result.item.id);
      }
      if (new Set(ids).size !== ids.length) return { ok: false, kind: 'wealth_error', action: intent.action, error: { code: 'VALIDATION_ERROR', message: '比较产品不可重复', uncertain: false } };
      resolved.product_ids = ids;
    } else if (intent.action === 'wealth.subscribe') {
      const product = resolve('product_ref', slots.product_ref, products, 'investment_product');
      if (!product.ok) return { ...product, action: intent.action };
      const account = resolve('source_account_ref', slots.source_account_ref, accounts.filter(item => item.status === 'active'), 'account');
      if (!account.ok) return { ...account, action: intent.action };
      resolved.product_id = product.item.id;
      resolved.source_account_id = account.item.id;
      resolved.amount = slots.amount;
    } else {
      const namedHoldings = holdings.map(item => ({ ...item, name: products.find(product => product.id === item.product_id)?.name ?? item.id }));
      const holding = resolve('holding_ref', slots.holding_ref, namedHoldings, 'investment_holding');
      if (!holding.ok) return { ...holding, action: intent.action };
      resolved.holding_id = holding.item.id;
      resolved.quantity_or_amount = slots.quantity_or_amount;
    }
    const result = await runResolvedWealthIntent(repository, ports, {
      intent_id: `intent_${randomUUID()}`, action: intent.action, state: 'ready_for_planning',
      resolved_slots: resolved, references, missing_slots: [],
    });
    if (!result.ok) return { ok: false, kind: 'wealth_error', action: intent.action, error: result.error };
    return { ok: true, kind: result.data.kind === 'action_request' ? 'wealth_action_request' : 'wealth_result', action: intent.action, data: result.data };
  } catch (error) {
    return { ok: false, kind: 'wealth_error', action: intent.action, error: { code: error?.code ?? 'VALIDATION_ERROR', message: error?.message ?? 'Wealth 解析失败', uncertain: false } };
  }
}
