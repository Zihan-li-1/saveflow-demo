import assert from 'node:assert/strict';
import { createBankingCore } from '../src/banking-core/core.mjs';

const core = createBankingCore();
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const accountId = 'ACC-CHECKING';
const input = { fromAccountId: accountId, payeeId: 'payee_001', amountFen: 50000, currency: 'CNY' };
const before = core.repository.getAccount(accountId).availableBalanceFen;
const prepared = value(await core.prepare({ action: 'transfer_money', input }));
assert.equal(core.repository.getAccount(accountId).availableBalanceFen, before);
console.log('B 验收：隔离内存中的合成数据，不调用 Qwen 或真实银行。');
console.log('数据截点：', core.repository.getContextInfo().asOf);
console.log('预览（尚未扣款）：', prepared.preview.summary);
// This script explicitly simulates the confirmation button; the agent/model cannot do this.
value(core.decide(prepared.operationId, { previewHash: prepared.preview.previewHash, decision: 'confirm', confirmedStepIds: prepared.preview.stepIds }));
const receipt = value(core.execute(prepared.operationId, prepared.preview.previewHash));
assert.deepEqual(value(core.execute(prepared.operationId, prepared.preview.previewHash)), receipt);
assert.deepEqual(value(core.getOperation(prepared.operationId)).receipt, receipt);
assert.equal(core.repository.getAccount(accountId).availableBalanceFen, before - 50000);
assert.equal((await core.prepare({ action: 'transfer_money', input: { ...input, amountFen: 50000000 } })).error.code, 'INSUFFICIENT_BALANCE');
assert.equal((await core.prepare({ action: 'transfer_money', input: { ...input, payeeId: 'missing' } })).error.code, 'PAYEE_NOT_FOUND');
console.log('回执：', JSON.stringify(receipt, null, 2));
console.log('PASS：正常转账、确认前余额不变、重复请求仅扣一次、余额不足、不存在收款人、原编号查回执。');
