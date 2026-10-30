// The only framework module importing existing business entry points.
import { z } from 'zod';
import { handleBillSummary, handleSubscriptionList, handleCard, handleTransfer, transferRepository } from '../../src/agent/runtime.mjs';
import { validateCardIntent } from '../../src/skills/card/card-skill.mjs';
import { createWealthSkill, validateWealthAction } from '../../src/skills/wealth/wealth-skill.mjs';
import { createScenarioSkill, validateScenarioAction } from '../../src/skills/scenario/scenario-skill.mjs';
import { SkillAdapter } from './adapter.mjs';
import { SkillRegistry } from './registry.mjs';

const text = z.string().trim().min(1).max(256);
const money = z.object({ amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.literal('CNY') }).strict();
const object = fields => z.object(fields).strict();
const action = value => z.literal(value);
const billSchema = z.discriminatedUnion('action', [object({ action: action('bill.summary'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), object({ action: action('subscription.list') })]);
const cardSchema = z.discriminatedUnion('action', [
  ...['card.get', 'card.freeze', 'card.unfreeze'].map(value => object({ action: action(value), card_ref: text })),
  object({ action: action('card.set_budget'), card_ref: text, amount: money.extend({ amount_minor: z.number().int().min(0).max(10000000) }) }),
]);
const wealthSchema = z.discriminatedUnion('action', [
  object({ action: action('wealth.compare'), product_refs: z.array(text).min(2).max(10) }),
  object({ action: action('wealth.recommend'), goal: text, max_risk_level: z.enum(['R1', 'R2', 'R3']), horizon_days: z.number().int().min(0).max(3650), liquidity_requirement: z.enum(['T+0', 'T+1', 'AT_MATURITY']), amount: money.optional() }),
  object({ action: action('wealth.assess_risk'), assessment_scope: action('investment_suitability') }),
]);
const scenarioSchema = z.discriminatedUnion('action', [
  object({ action: action('scenario.review_event'), event_ref: text }),
  object({ action: action('scenario.create_rule'), trigger: object({ type: z.enum(['manual', 'date', 'financial_event']), value: text }), conditions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), proposed_steps: z.array(object({ action: text, parameters: z.record(z.string(), z.unknown()) })).min(1).max(10), authorization_scope: action('suggest_only') }),
]);
const transferSchema = object({ action: action('transfer.create'), source_account_ref: text, payee_ref: text, amount: money });

export class BillAdapter extends SkillAdapter {
  constructor(repository) { super({ name: 'bill', description: '现有账单摘要及订阅查询', schema: billSchema,
    health: () => repository.getContextInfo(), invoke: input => input.action === 'bill.summary' ? handleBillSummary({ slots: { month: input.month } }, repository) : handleSubscriptionList({ slots: {} }, repository) }); }
}
export class CardAdapter extends SkillAdapter {
  constructor(repository) { super({ name: 'card', description: '卡片查询及操作请求生成；不执行卡片变更', schema: cardSchema,
    operation: input => input.action === 'card.get' ? 'READ_ONLY' : 'WRITE', validate: ({ action, ...slots }) => validateCardIntent({ action, slots }),
    health: () => repository.getCards(), invoke: ({ action, ...slots }) => handleCard({ action, slots }, repository) }); this.operation_type = 'WRITE'; }
}
export class WealthAdapter extends SkillAdapter {
  constructor(repository) { super({ name: 'wealth', description: '理财比较、建议及测评需求；不申购赎回', schema: wealthSchema,
    validate: validateWealthAction, health: () => repository.getInvestmentProducts(), invoke: createWealthSkill(repository) }); }
}
export class ScenarioAdapter extends SkillAdapter {
  constructor(repository, store) { super({ name: 'scenario', description: '场景规则提案及可信事件复核；不提交规则变更', schema: scenarioSchema,
    // Event review may persist its review, so both supported actions are conservatively WRITE.
    operation: () => 'WRITE', validate: validateScenarioAction,
    health: async () => { await repository.getContextInfo(); await store.getEvent('__health__'); }, invoke: createScenarioSkill({ store, contextProvider: () => repository.getContextInfo() }) }); this.operation_type = 'WRITE'; }
}
export class TransferAdapter extends SkillAdapter {
  constructor(repository) { super({ name: 'transfer', description: '现有生产转账解析，生成 transfer_resolution；不扣款', schema: transferSchema,
    operation: () => 'SENSITIVE_WRITE', health: () => repository.getAccounts(),
    invoke: ({ action, ...slots }) => handleTransfer({ action, slots }, transferRepository(repository)) }); this.operation_type = 'SENSITIVE_WRITE'; }
}
export function registerExistingSkills(repository, scenarioStore) {
  const registry = new SkillRegistry();
  for (const Adapter of [BillAdapter, CardAdapter, WealthAdapter, ScenarioAdapter, TransferAdapter]) registry.register(new Adapter(repository, scenarioStore));
  return registry;
}
