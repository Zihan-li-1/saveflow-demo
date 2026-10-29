# 服务端只读财务分析上下文

`server/financial-analysis-context.mjs` 提供 `buildFinancialAnalysisContext(repository, options)`。没有模型调用、写操作、跨请求缓存或新 HTTP 入口。账单、理财和储蓄模块可以主动读取，不改变现有 Skill 公开合同，也不自动把历史交易加入每次模型请求。

```js
import { buildFinancialAnalysisContext } from './financial-analysis-context.mjs';
import { understandingContext } from './understanding-context.mjs';

// repository 来自当前已鉴权用户的 Core；不可让请求或模型替换数据源。
const financial = await buildFinancialAnalysisContext(repository);
// 使用既有账单时间槽位，也可显式指定 month: '2026-08'。
const selected = await buildFinancialAnalysisContext(repository, {
  period: { start_date: '2026-06-01', end_date: '2026-08-31', timezone: 'Asia/Shanghai' },
});
// 后续业务确有需要时再传递聚合结果，保留 status、coverage 与 source。
const input = understandingContext({ financialContext: financial });
```

只需要 Repository 的 `getContextInfo()`、`getTransactions()`，兼容同步及异步返回。收入、支出、按原分类汇总和交易数共用 `src/skills/bill/bill-summary.mjs`；原 TS Bill Skill 仍从原路径导出 `summarizeBills`，运行时账单处理器也使用同一实现，不另建查询系统。

金额为安全整数分。净现金流采用既有账单口径：收入减消费支出；`transfer_out` 不计为消费支出，也不计入这个净现金流。它不是账户余额变动或可投资余额，调用方不能直接把它作为可支配资金。无记录的统计为 `null`，而有收入记录、没有消费记录时支出可以是 0。

默认范围由可信数据决定：在 `availableMonths`（如无此元信息则使用实际记录月份）中，选择服务端当前日期和数据快照日期之前均已结束、且确有已入账记录的最近三个自然月。少于三个月时只返回实际可用月份，标记 `partial/insufficientMonths`；不能把缺月补成零，也不除以三推导虚假的月均值。没有完整月但有可用的部分月份时返回部分月份和 `partial`；没有可用记录时为 `unavailable`，`summary: null`。

显式时间范围沿用账单的 `month` 或 `period`，互斥；自定义区间为 1–366 个自然日，含首尾日，按请求时区过滤。缺月逐月返回 `unavailable` 和 `summary: null`，实际有记录的部分月份保持 `partial`。默认选择可以不连续，必须以 `range.months` 为准，`missingMonths` 揭示选中首尾之间的缺口。

返回值包括 `summary`、`monthly`、统计区间 `range`、实际记录首尾日期、缺月/不足标志 `coverage`，以及 datasetId、snapshotId、dataSource、asOf 和交易来源集合 `source`。不返回原始流水、商户、账户 ID 或交易 ID。完整自然月仅表示时间已结束；现有数据未证明流水连续完整，因此 `coverage.completeness` 始终明确为 `unverified`，不能把首尾记录日期当成这之间每天都有数据。

当前演示数据默认选中 2026-06、07、08：收入 3,600,000 分，消费支出 2,232,000 分，净现金流 1,368,000 分；实际记录日期为 2026-06-05 至 2026-08-26，源快照为 2026-09-01。

验证：`npm run test:financial-context`，新增 11 项数据/合同测试及原账单 Skill 5 项回归，共 16 通过、0 失败、0 跳过；不调用真实模型。另通过 TypeScript 和相关文件 ESLint 检查。
