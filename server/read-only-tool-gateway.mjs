import { randomUUID } from 'node:crypto';
import { handleBillSummary, handleSubscriptionList } from '../src/agent/runtime.mjs';
import { createWealthSkill } from '../src/skills/wealth/wealth-skill.mjs';
import { buildFinancialAnalysisContext } from './financial-analysis-context.mjs';
import { validateAgentProposalV2 } from './agent-proposal-v2.mjs';

const safe = value => JSON.parse(JSON.stringify(value));

function evidence(context, ids = []) {
  if (!context || typeof context.asOf !== 'string' || typeof context.dataSource !== 'string') throw new Error('READ_ONLY_EVIDENCE_INVALID');
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('READ_ONLY_EVIDENCE_INVALID');
  return [{ source: context.dataSource, asOf: context.asOf, entityIds: [...new Set(ids)] }];
}

function publicCards(cards) {
  return cards.map(card => ({ name: card.name, status: card.status, monthlyBudgetFen: card.monthlyBudgetFen, monthlySpentFen: card.monthlySpentFen, onlinePaymentsEnabled: card.onlinePaymentsEnabled, blockedCategories: card.blockedCategories }));
}

function publicProducts(products) {
  return products.map(product => ({ name: product.name, riskLevel: product.riskLevel, expectedYield: product.expectedYield, liquidity: product.liquidity, minimumAmountFen: product.minimumAmountFen, durationDays: product.durationDays, currency: product.currency }));
}

const expectedKinds = { 'bill.summary': 'bill_result', 'subscription.list': 'subscription_result', 'card.get': 'card_result', 'product.list': 'product_result', 'wealth.recommend': 'wealth_recommendation', 'wealth.compare': 'wealth_comparison' };
function validateResult(result, tool, context) {
  if (!result || typeof result !== 'object' || result.ok !== true || result.action !== tool || result.kind !== expectedKinds[tool] || JSON.stringify(result).length > 100000 ||
      !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('READ_ONLY_RESULT_INVALID');
  const item = result.evidence?.[0];
  const source = tool.startsWith('wealth.') ? 'financial_context.investment_products' : context.dataSource;
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1 || item?.source !== source || item?.asOf !== context.asOf ||
      !Array.isArray(item.entityIds) || item.entityIds.some(id => typeof id !== 'string' || !id) || new Set(item.entityIds).size !== item.entityIds.length) throw new Error('READ_ONLY_RESULT_INVALID');
  if (tool === 'bill.summary' && (!Number.isSafeInteger(result.data.transactionCount) || !Number.isSafeInteger(result.data.totalExpenseFen) || !Number.isSafeInteger(result.data.totalIncomeFen) || !result.data.coverage)) throw new Error('READ_ONLY_RESULT_INVALID');
  if (tool === 'subscription.list' && (!Array.isArray(result.data.subscriptions) || !result.data.summary)) throw new Error('READ_ONLY_RESULT_INVALID');
  if (tool === 'card.get' && !Array.isArray(result.data.cards)) throw new Error('READ_ONLY_RESULT_INVALID');
  if (['product.list', 'wealth.recommend', 'wealth.compare'].includes(tool) && !Array.isArray(result.data.products)) throw new Error('READ_ONLY_RESULT_INVALID');
  return safe(result);
}

export const READ_ONLY_TOOL_NAMES = Object.freeze(['bill.summary', 'subscription.list', 'card.get', 'product.list', 'wealth.recommend', 'wealth.compare']);

export function createReadOnlyToolGateway({ repository, constraints = {}, now = Date.now, timezone = 'Asia/Shanghai' }) {
  if (!repository) throw new TypeError('read-only gateway requires repository');
  return Object.freeze({
    async execute(tool, args, meta = {}) {
      const proposal = validateAgentProposalV2({ schemaVersion: '2.0.0', kind: 'plan_request', goal: 'server tool call', plan_request: { tool, arguments: args }, constraints: undefined, task_control: undefined, clarify: undefined, unsupported: undefined, business_intent: undefined });
      const input = proposal.plan_request.arguments;
      if (tool === 'wealth.recommend' && (
        constraints.max_risk_level !== input.max_risk_level || constraints.horizon_days !== input.horizon_days ||
        constraints.liquidity_requirement !== input.liquidity_requirement ||
        (constraints.amount?.amount_minor ?? null) !== (input.amount?.amount_minor ?? null) ||
        (constraints.amount?.currency ?? null) !== (input.amount?.currency ?? null))) throw Object.assign(new Error('READ_ONLY_USER_CONSTRAINT_REQUIRED'), { code: 'READ_ONLY_USER_CONSTRAINT_REQUIRED' });
      const context = await repository.getContextInfo();
      let result;
      if (tool === 'bill.summary') {
        const intent = { schemaVersion: '1.0.0', action: 'bill.summary', slots: input, missingSlots: [], status: 'ready_for_resolution' };
        result = await handleBillSummary(intent, repository);
      } else if (tool === 'subscription.list') {
        result = await handleSubscriptionList({ action: 'subscription.list', slots: {}, missingSlots: [], status: 'ready_for_resolution' }, repository);
      } else if (tool === 'card.get') {
        const cards = await repository.getCards();
        const selected = input.card_ref ? cards.filter(card => card.name === input.card_ref) : cards;
        result = { ok: true, kind: 'card_result', action: 'card.get', data: { cards: publicCards(selected), ...(input.card_ref && selected.length !== 1 ? { clarification: '未找到唯一匹配的卡片称谓。' } : {}) }, evidence: evidence(context, selected.map(card => card.id)) };
      } else if (tool === 'product.list') {
        const products = await repository.getInvestmentProducts();
        result = { ok: true, kind: 'product_result', action: 'product.list', data: { products: publicProducts(products) }, evidence: evidence(context, products.map(product => product.id)) };
      } else if (tool === 'wealth.recommend' || tool === 'wealth.compare') {
        const skill = createWealthSkill(repository);
        const financialContext = tool === 'wealth.recommend' ? await buildFinancialAnalysisContext(repository, { now, timezone }) : undefined;
        result = await skill({ action: tool, ...input }, financialContext ? { financialContext } : {});
        if (result?.data?.products) result.data.products = result.data.products.map(item => { const copy = { ...item }; delete copy.product_ref; return copy; });
        if (result?.evidence?.[0]?.as_of) result.evidence = result.evidence.map(item => ({ source: item.source, asOf: item.as_of, entityIds: item.entity_ids ?? [] }));
      }
      if (!result) throw new Error('READ_ONLY_TOOL_NOT_IMPLEMENTED');
      const checked = validateResult(result, tool, context);
      return { toolCallId: `plan_call_${randomUUID()}`, tool, args: safe(input), result: checked, source: meta.source ?? 'formal_repository' };
    },
  });
}
