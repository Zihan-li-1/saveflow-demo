import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { budgetReminderRuleIntentFromMessage } from '../src/lib/scenario-rule-flow.mjs';
import { purchaseIntentFromMessage } from '../src/lib/purchase-flow.mjs';
import { shoppingSearchLinks } from '../src/lib/purchase-links.mjs';
import { createScenarioSkill, createInMemoryScenarioStore } from '../src/skills/scenario/scenario-skill.mjs';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

const env = { SAVEFLOW_ACCESS_CODE: 'catalog-example-access', CONTINUATION_TOKEN_SECRET: 'catalog-example-continuation-secret' };
const request = (message, ip) => new Request('http://localhost/api/banking-agent', { method: 'POST', headers: {
  'content-type': 'application/json', 'x-saveflow-access': env.SAVEFLOW_ACCESS_CODE, 'x-forwarded-for': ip,
}, body: JSON.stringify({ message, consent: true, history: [] }) });

test('catalog budget reminder becomes a valid suggest-only scenario draft', async () => {
  const parsed = budgetReminderRuleIntentFromMessage('创建一条模拟规则：娱乐卡本月消费达到预算的 80% 时提醒我');
  assert.ok(parsed);
  assert.equal(validateParsedIntent(parsed).action, 'scenario.create_rule');
  assert.deepEqual(parsed.slots.conditions, { card_ref: '娱乐卡', budget_usage_percent_gte: 80 });
  assert.equal(parsed.slots.proposed_steps[0].action, 'notification.remind');
  assert.equal(parsed.slots.authorization_scope, 'suggest_only');

  const skill = createScenarioSkill({ store: createInMemoryScenarioStore() });
  const preview = await skill({ action: parsed.action, ...parsed.slots });
  assert.equal(preview.ok, true);
  assert.equal(preview.data.requires_confirmation, true);
  assert.match(preview.data.execution_policy, /写操作仍须重新预览并确认/);
});

test('catalog headphone request produces a bounded search link with the price limit', () => {
  const slots = purchaseIntentFromMessage('帮我生成 500 元以内耳机的购物平台搜索链接');
  assert.deepEqual(slots, {
    items: [{ category: 'headphones', quantity: 1 }],
    budget: { amount_minor: 50000, currency: 'CNY' },
  });
  assert.equal(validateParsedIntent({ schemaVersion: '1.0.0', action: 'scenario.plan_purchase', slots, missingSlots: [], status: 'ready_for_resolution' }).action, 'scenario.plan_purchase');
  const [link] = shoppingSearchLinks(slots);
  assert.equal(link.category, 'headphones');
  assert.equal(link.query, '耳机 500元以内');
  assert.match(link.url, /^https:\/\/search\.jd\.com\/Search\?/);
});

test('fallbacks do not overmatch unrelated reminders or arbitrary products', () => {
  assert.equal(budgetReminderRuleIntentFromMessage('提醒我明天交水费'), null);
  assert.equal(budgetReminderRuleIntentFromMessage('创建规则：预算达到 180% 时提醒我'), null);
  assert.equal(purchaseIntentFromMessage('介绍一下耳机的工作原理'), null);
});

test('HTTP entry recognizes both catalog examples even if outer/model fallbacks would reject them', async () => {
  const rejectRoute = async () => assert.fail('Supported catalog examples must not be swallowed by the chat route');
  const rejectParser = async () => assert.fail('Bounded server recognition must not depend on a model retry');
  const core = createBankingCore();
  const ruleResponse = await handleBankingAgent(request('创建一条模拟规则：娱乐卡本月消费达到预算的 80% 时提醒我', 'catalog-rule'), {
    env, core, routeConversation: rejectRoute, parseIntent: rejectParser,
  });
  const rule = await ruleResponse.json();
  assert.equal(rule.data.status, 'scenario_rule_preview');
  assert.equal(rule.data.data.requires_confirmation, true);
  assert.equal(rule.data.data.rule.proposed_steps[0].action, 'notification.remind');

  const linkResponse = await handleBankingAgent(request('帮我生成 500 元以内耳机的购物平台搜索链接', 'catalog-headphones'), {
    env, core, routeConversation: rejectRoute, parseIntent: async () => ({ schemaVersion: '1.0.0', action: 'unsupported', slots: {}, missingSlots: [], status: 'unsupported' }),
  });
  const link = await linkResponse.json();
  assert.equal(link.data.status, 'purchase_request');
  assert.deepEqual(link.data.data.slots.items, [{ category: 'headphones', quantity: 1 }]);
  assert.equal(link.data.data.slots.budget.amount_minor, 50000);
});
