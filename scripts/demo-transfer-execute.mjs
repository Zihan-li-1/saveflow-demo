// 演示：TrueForge 试点预览 → 授权桥 → 确认 → 执行 → 回执（完整闭环）。
// 用法：node scripts/demo-transfer-execute.mjs
//
// 生产环境应把 core 换成 createPostgresBankingCore（共享库），预览与执行同源；此处用内存 Core 演示最小闭环。
import { createBankingCore } from '../src/banking-core/core.mjs';
import { executeTrialTransfer } from '../server/transfer-execute-bridge.mjs';

const core = createBankingCore();
const account = () => core.repository.getAccount('ACC-CHECKING');

// ① 模拟 TrueForge 试点：只出预览，不给执行能力（预览 only）。
const prepared = await core.prepare({
  action: 'transfer_money',
  input: { fromAccountId: 'ACC-CHECKING', payeeId: 'payee_001', amountFen: 50000, currency: 'CNY' },
});
if (!prepared.ok) { console.error('预览失败：', prepared.error); process.exit(1); }
const { operationId, preview } = prepared.data;
console.log('① 试点预览（不可执行）');
console.log(`   operationId = tfpreview:${operationId}`);
console.log(`   summary     = ${preview.summary}`);
console.log(`   previewHash = ${preview.previewHash}`);

// ② 授权桥：用户确认后，服务端精确确认 + 执行。
const before = account().availableBalanceFen;
const executed = await executeTrialTransfer(core, { trialOperationId: `tfpreview:${operationId}`, previewHash: preview.previewHash });
if (!executed.ok) { console.error('执行失败：', executed.error); process.exit(1); }

console.log('② 授权桥执行回执');
console.log(`   receiptId = ${executed.data.receiptId}`);
console.log(`   status    = ${executed.data.status}`);
console.log(`   txns      = ${executed.data.transactionIds.join(', ')}`);
console.log(`③ 余额变化  ¥${(before / 100).toFixed(2)} → ¥${(account().availableBalanceFen / 100).toFixed(2)}`);
