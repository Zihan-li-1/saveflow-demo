import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import { handleBankingAgent } from '../server/banking-agent.mjs';

// 验证 banking-agent 端点（自然语言 → 意图 → 转账预览）的「会算账」上下文与「权限分级」。
// 通过注入 mock parseIntent，避免依赖真实大模型，保证测试确定性。

const env = { SAVEFLOW_BANKING_RUNTIME: 'legacy-qwen',
  SAVEFLOW_ACCESS_CODE: 'banking-agent-test-access-1234',
  CONTINUATION_TOKEN_SECRET: 'continuation-test-secret-123456',
};

const url = 'https://demo.example/api/banking-agent';

function transferIntent(amountMinor) {
  return {
    schemaVersion: '1.0.0',
    action: 'transfer.create',
    slots: { payee_ref: '张三', amount: { amount_minor: amountMinor, currency: 'CNY' }, source_account_ref: '活期账户' },
    missingSlots: [],
    status: 'ready_for_resolution',
  };
}

function request(message) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': env.SAVEFLOW_ACCESS_CODE, Origin: 'https://demo.example' },
    body: JSON.stringify({ message, history: [], consent: true }),
  });
}

test('转账预览返回「会算账」上下文：占月收入%、本月第N笔', async () => {
  const core = createBankingCore();
  const settings = core.repository.getDemoSettings();
  const currentMonth = core.repository.getContextInfo().currentMonth;
  const baseExpenseCount = core.repository.getTransactions({ month: currentMonth })
    .filter(transaction => transaction.type === 'expense' || transaction.type === 'transfer_out').length;

  const response = await handleBankingAgent(request('给张三转 500 元'), {
    env, core, parseIntent: async () => transferIntent(50000),
  });
  const payload = await response.json();

  assert.equal(payload.code, 'OK');
  assert.equal(payload.data.status, 'awaiting_confirmation');
  assert.equal(payload.data.context.monthlyIncomeFen, settings.monthlyIncomeFen);
  assert.equal(payload.data.context.expenseCountThisMonth, baseExpenseCount + 1);
  assert.equal(payload.data.context.incomeRatioPercent, Math.round((50000 / settings.monthlyIncomeFen) * 1000) / 10);
  assert.equal(payload.data.risk.requiredVerification, 'none'); // 500 元 ≤ 1000 元，仅需确认
});

test('大额转账（>1000元）触发短信验证码强验证', async () => {
  const core = createBankingCore();
  const response = await handleBankingAgent(request('给张三转 2000 元'), {
    env, core, parseIntent: async () => transferIntent(200000),
  });
  const payload = await response.json();

  assert.equal(payload.code, 'OK');
  assert.equal(payload.data.status, 'awaiting_confirmation');
  assert.equal(payload.data.risk.requiredVerification, 'mock_sms');
  assert.equal(payload.data.risk.verificationCode, '123456');
});
