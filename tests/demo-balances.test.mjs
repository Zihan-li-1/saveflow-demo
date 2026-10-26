import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };

test('interactive demo accounts start with 30000 and 10000 yuan as integer fen', () => {
  const core = createBankingCore();
  for (const [id, amountFen] of [['ACC-CHECKING', 3000000], ['ACC-SAVINGS', 1000000]]) {
    const account = core.repository.getAccount(id);
    assert.equal(account.balanceFen, amountFen);
    assert.equal(account.availableBalanceFen, amountFen);
    assert.equal(seed.accounts.find(item => item.id === id).availableBalance * 100, amountFen);
  }
});

test('both funded accounts prepare large transfers while retaining confirmation and verification requirements', async () => {
  const core = createBankingCore();
  for (const [fromAccountId, amountFen] of [['ACC-CHECKING', 2000000], ['ACC-SAVINGS', 500000]]) {
    const before = core.repository.getAccount(fromAccountId).availableBalanceFen;
    const result = await core.prepare({ action: 'transfer_money', input: { fromAccountId, payeeId: 'payee_001', amountFen, currency: 'CNY' } });
    assert.equal(result.ok, true);
    assert.equal(result.data.risk.requiredVerification, 'mock_sms');
    assert.equal(result.data.risk.requiredConfirmation, 'mock_explicit');
    assert.equal(result.data.preview.exactEffects[0].amountFen, amountFen);
    assert.equal((await core.execute(result.data.operationId, result.data.preview.previewHash)).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(core.repository.getAccount(fromAccountId).availableBalanceFen, before);
  }
});
