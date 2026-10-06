# 本轮开发交接契约：转账预览安全与双月账单分析

状态：**待 A、B、C、D 核对的本轮实现合同**。基线为主分支 `47522d092f075f5e294142099e9d3ab82eb9045e`。本文件定义本轮要实现和验收的接口，不表示代码现已实现。各成员若需改变字段或行为，先同步修改本文和相关测试，再合并代码。

本轮只冻结两个交接点：**A/B/D 的转账预览—决策—执行边界**与 **A/C 的 `bill.analyze` 输入—结果边界**。A 应实现解析、校验、路由、运行时、HTTP 与转账回归测试；B 实现共享状态和旧预览失效；C 实现基于交易的计算；D 实现按钮、状态与结果展示。E 的理财只读 Skill 和 Workflow 骨架独立推进。订阅接口另行约定，不纳入本轮解析器枚举。

## 1. 保持的现有合同

- 模型输出仍是单意图 `ParsedIntent`，`schemaVersion: "1.0.0"`，字段为 `schemaVersion/action/slots/missingSlots/status`；`bill.summary` 和 `transfer.create` 保持原语义。`docs/intent-contracts.md` 中的 v1.1 多意图 envelope 是目标合同，**本轮不迁移**。
- 模型只能提供原始用户意图和槽位，不提供 `operationId`、实体 ID、`previewHash`、确认、风险等级或执行工具调用。`action.decide`、`action.execute` 不能注册为模型工具。`continuationToken` 是澄清状态，不是付款授权。
- `POST /api/banking-agent` 负责理解、澄清、只读账单和转账预览，其响应为 `{code,message,requestId,data?}`，预览内部使用 Core 的 camelCase。已存在的 `POST /api/banking` 使用 `{schema_version:"1.1.0",action,input}` 和 snake_case wire；由现有 `createBankingClient` 转换。
- 余额与交易只以 Repository/Core 为准；金额始终用整数分。历史账单样例的数据截点来自 `getContextInfo().asOf`，不能把合成账单说成实时账单。

## 2. A/B/D：正式预览、确认和旧操作失效

### 2.1 页面收到的预览

`/api/banking-agent` 成功生成转账预览时，保留现有响应结构：

```json
{
  "code": "OK",
  "requestId": "<服务端请求编号>",
  "message": "转账正式预览已生成，等待用户确认",
  "data": {
    "status": "awaiting_confirmation",
    "action": "transfer.create",
    "operationId": "op_<服务端生成>",
    "preview": {
      "planId": "plan_<服务端生成>",
      "stepIds": ["step_<服务端生成>"],
      "previewHash": "<Core 生成的哈希>",
      "summary": "<精确预览>",
      "exactEffects": ["<Core 效果对象>"],
      "riskLevel": "L3",
      "expiresAt": "<ISO 时间>",
      "contextSnapshotId": "<快照编号>"
    },
    "risk": { "allowed": true, "riskLevel": "L3" },
    "continuationToken": "<仅用于修改/追问>"
  }
}
```

示意中 `exactEffects` 的占位字符串不是有效生产值；实际必须是 Core 返回的 `TransferEffect[]`，展示金额、付款账户、收款人及脱敏账号、手续费、预计余额和有效期。D 把 **`operationId` + `preview.previewHash` + `preview.stepIds`** 作为一张卡片的不可拆分数据保存，不从摘要文字反向解析，也不从 token 取确认字段。确认前余额不变。

### 2.2 独立按钮的 wire 请求

按钮仅在最新、未过期、未被替代且 `status=awaiting_confirmation` 的正式预览上可点；展示的金额、账户和收款人须与 `exactEffects` 一致。D 使用现有 `createBankingClient({accessCode: () => 当前内存访问码})`，它把下列 camelCase 入参转换成 `/api/banking` 的 snake_case：

| 用户动作 | 客户端调用（camelCase） | wire `input`（snake_case） | 服务端结果 |
| --- | --- | --- | --- |
| 点击确认 | `action.decide({operationId,previewHash,decision:"confirm",confirmedStepIds:stepIds})` | `operation_id,preview_hash,decision,confirmed_step_ids` | `OperationStatus`，通常 `state=confirmed`，**尚未扣款** |
| 确认成功后执行 | `action.execute({operationId,previewHash})` | `operation_id,preview_hash`，请求头 `Idempotency-Key: <同一 operationId>` | `ActionReceipt`；只有可信的 `status=succeeded` 才显示模拟成功 |
| 点击取消 | `action.decide({operationId,previewHash,decision:"reject",confirmedStepIds:[]})` | 同上，空步骤数组 | `state=cancelled` 及取消回执，不再执行 |
| 超时或结果不确定 | `action.status({operationId})` | `operation_id` | 查询同一操作的 `state/status/receipt/error` |

D 不通过 `/api/banking-agent` 发送确认对象，也不把聊天里的“确认”转成按钮点击。`action.decide`、`action.execute` 的提交以用户明确点击为入口；同一操作只允许一次确认中的 UI 请求。确认/执行响应不可靠时保留原编号并查询；**不得用新 `transfer.prepare` 或新编号“重试转账”**。重复点击只能取得同一操作的状态/回执，不重复扣款；页面不能仅凭 HTTP 200 显示成功。页面切换入口、重置或离开时不应把待核实的旧编号误标为失败。

### 2.3 修改、取消与竞态：B 的服务端保证

现状：A 的续接 token 只保存槽位/选项，D 只隐藏旧预览卡；Core `decide` 按旧 `operationId` 查记录，旧卡若仍在 `awaiting_confirmation`，仍可能被确认。**在 B 的共享存储规则完成前，D 的正式确认按钮不得联到生产式聊天流程。**

本轮目标语义：一条转账草稿在同一受控操作链上只允许一个有效待确认预览。A 的服务端续接需把上一次正式 `operationId` 与操作链标识绑定在受保护状态中；普通聊天文本及前端提交的字段不得决定替代哪个操作。用户说“改成 600 元”“改给李四”或更换账户时，解析新槽位并重新解析实体；服务端替代旧预览，**新预览返回给 D 之前**，旧操作已进入不可确认、不可执行的终态。旧 `operationId` 即使被旧标签页或重放请求提交，也须由 `action.decide` 与 `action.execute` 服务端拒绝，且余额不变。原始 token 重放不能重新激活更早的预览。

B 与 A 实现同一存储域中的原子替代/版本检查（可用同一操作链的服务端序号或等价方案）；跨实例的确认、替代、执行必须按相同锁/事务规则排序。对仍待确认的旧预览，推荐在原记录保留取消/被替代原因和可查询状态；若改用新状态或错误码，需同时更新 Core 类型、HTTP 映射及 D 的处理。若旧操作已确认、执行中或结果待核实，**不可伪称替代成功**：先按原编号查明状态；不能再让“修改金额”默默覆盖可能已经发起的操作。新旧并发确认只能有一个确定的胜者。B 必须用 PostgreSQL 跨实例验证这一条，而不仅靠进程内 Map。

聊天框输入“确认”不能使模型调用 `decide/execute`，应提示使用正式预览卡确认；输入“取消”需走服务端可信的取消/失效路径，至少使该卡在 Core 无法再确认，不能只删除 UI。若取消/替代调用结果不确定，D 展示待核实并按原 `operationId` 查询。`continuationToken` 仍只表示对话续接，任何旧 token 重放均不构成确认。A 补测试覆盖金额变更、收款人变更、换账户、聊天“取消”与“确认”、旧 token 重放、过期、双标签页/跨实例竞态；B 覆盖旧预览被确认/执行的拒绝、确认与替代并发、持久化及重复执行只扣一次。

## 3. A/C：`bill.analyze` 双月比较

### 3.1 新意图输入

新增业务 action `bill.analyze`，原有 `bill.summary` 不变。它只处理**两个明确日历月的支出比较**，不暗中扩成年度报告、异常检测或转账动作。ParsedIntent 分支：

```json
{
  "schemaVersion": "1.0.0",
  "action": "bill.analyze",
  "slots": { "month": "2026-08", "compareMonth": "2026-07" },
  "missingSlots": [],
  "status": "ready_for_resolution"
}
```

`month` 是要解释的月份，`compareMonth` 是基准月份；二者均为真实 `YYYY-MM`，不可相等。缺一个就追问该槽位，`status=needs_clarification` 且 `missingSlots` **恰好等于**缺失槽位集合；`slots` 不允许账户 ID、查询得到的金额、结论或未注册字段。示例“2026 年 8 月为什么比 7 月花得多”必须解析到 `2026-08` / `2026-07`；若年份含糊或是“上月/这个月”，A 基于请求时间与 `Asia/Shanghai` 解析并校验，不从固定合成数据的 `currentMonth` 猜成“现实本月”。时间或比较对象仍不明确时追问，不编造月份。缺参续接也支持 `compareMonth`，切换 `bill.summary`/`bill.analyze` 时不能沿用错误槽位。

### 3.2 C 接给 A 的处理函数与结果

建议在 `src/skills/bill/bill-skill.ts` 导出 `analyzeBills(targetTransactions, baselineTransactions)` 纯计算函数，并在 `src/agent/handlers/bill-handler.ts` 或独立 `bill-analysis-handler.ts` 包装 Repository 调用。接口的可观察语义为：

```ts
type BillAnalyzeInput = { month: string; compareMonth: string };
type BillAnalyzeResult = {
  month: string; compareMonth: string; currency: "CNY";
  totalExpenseFen: number; compareTotalExpenseFen: number;
  differenceFen: number;               // 本月减基准月，可为负数
  changeBps: number | null;             // 分母为基准月；基准为 0 时 null
  transactionCount: number; compareTransactionCount: number;
  categoryChanges: Array<{
    category: string; expenseFen: number; compareExpenseFen: number;
    differenceFen: number; transactionIds: string[];
  }>;
  largestIncreaseCategory: string | null; // 仅正增长；没有则 null
  highValueTransactions: Array<{
    transactionId: string; occurredAt: string; merchant: string;
    category: string; amountFen: number; reason: "TOP_EXPENSE";
  }>;
  highValueRule: "TOP_3_TARGET_EXPENSES";
  explanation: string;                // 基于上述数字与交易，避免主观成因
  evidence: {
    source: "synthetic_demo_only"; asOf: string; snapshotId: string;
    targetTransactionIds: string[]; compareTransactionIds: string[];
  };
};
```

C 分别调用 `repository.getTransactions({month})` 与 `getTransactions({month:compareMonth})`，只计 `status="posted"` 且 `type="expense"` 的交易；收入及 `transfer_out` 不计入消费。统计所有可访问账户的交易，每个 ID 只计一次，使用安全整数分求和；`differenceFen = totalExpenseFen - compareTotalExpenseFen`，`changeBps = Math.round(differenceFen * 10000 / compareTotalExpenseFen)`（分母为零返回 `null`）。`categoryChanges` 取两个月类别的并集，缺少类别计 0，逐项差额和应等于总差额；类别排序先按差额降序，再按类别名稳定排序。`largestIncreaseCategory` 仅在最大差额大于 0 时取对应类别。高额样例是目标月单笔支出金额降序的前三笔（金额相同按时间、ID 稳定排序）；`TOP_EXPENSE` 只是展示规则，**高额不等于异常或欺诈**，缺少可证实的规则时不返回“可疑”断言。解释可说“增量主要来自某类别并列举对应交易”，不能把统计相关性说成确定的行为原因。

`evidence.asOf/source/snapshotId` 取 `repository.getContextInfo()`；类别对应的 `transactionIds` 和高额交易 ID 必须存在于目标月交易集中。若基准月无交易，比例为 `null` 并说明无法计算增长率；若目标月没有增加，说明“本月没有比基准月多花”，不能顺着用户问题编造增长。结果随 Repository 中的交易金额变化而变化，不读写旧静态月汇总。

### 3.3 A 的运行时与 HTTP 交付

A 同步更新 `src/agent/parsed-intent.ts`、`validate-parsed-intent.mjs`（及 TS 桥接）、`dispatcher.ts`、**实际执行的** `runtime.mjs`、Qwen 提示词、澄清合并/续接白名单、`server/banking-agent.mjs`、`src/lib/banking-agent-client.ts`。TypeScript Dispatcher 的路由测试不代替 `runtime.mjs` 的真实 HTTP 测试。

新 HTTP 成功响应沿用 Agent envelope，`data.status="bill_analysis"`、`data.action="bill.analyze"`，`data.data` 为上述数值/解释字段，`data.evidence` 为上述证据对象；D 依据 action 和 status 显示两个具体月份、金额差、类别贡献、交易依据、数据截点和“合成数据”标识。`bill.summary` 仍返回旧 `status="bill_result"` 和旧 `evidence` 数组；不得借此轮改变旧接口。初期 A 可用测试 handler 先跑通新 action，再接 C 的真实 handler；上线演示必须使用 Repository 实算结果。

## 4. 并行顺序与验收样例

| 成员 | 可以立即开始 | 联调依赖与交付 |
| --- | --- | --- |
| A | 写本契约对应的解析/校验/路由/HTTP、假 handler 测试；补转账聊天与续接安全回归 | 接 C 真实结果；和 B 核验 token 操作链、替代原子性及聊天取消，不开放模型执行路径 |
| B | PostgreSQL 迁移和跨实例预览→确认→执行→状态验收；设计替代/取消事务 | 与 A 明确服务端操作链/版本；给 D 稳定的拒绝状态/错误码；附数据库测试记录 |
| C | 按本文件两个月槽位和结果类型写纯计算及 Repository handler | 修改某笔交易金额后数字、类别和解释一起改变；向 A 提供测试样例 |
| D | 先用假 API 测按钮、禁用条件、待核实查询与账单分析 UI | B 的服务端失效/跨实例规则、A 的结果接入通过后才联正式确认 |

最少验收用例：

1. “给张三转 500 元”返回正式预览，确认前余额不变；点确认后 `action.decide` 再 `action.execute`，以同编号查到模拟回执；重复点击和跨实例重复请求只扣一次。
2. 在未确认时“改成 600 元”或“改给李四”生成新编号/哈希；旧编号即使持有正确旧哈希也无法确认或执行。聊天“确认”不执行；聊天“取消”令服务端旧预览失效。确认与替代竞态只允许一种确定结局；超时保留原编号查询。
3. “2026 年 8 月为什么比 7 月花得多”由 `bill.analyze` 返回两个月份、总差、类别差、增长最大类别、可追溯的交易及数据截点；调整测试交易后结果同步变化。零基数、不增长、无交易、跨年月份均有正确结果或明确追问。
4. `bill.summary`、转账缺参追问与正式预览、同名收款人选择、旧 Qwen 入口等现有回归继续通过。建议执行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`；数据库验收另需独立测试库及跨实例记录。

本文件冻结的是接口与验收语义。B 的事务方案、C 的解释措辞可以调整，只要上述可观察结果与安全边界保持一致，并在变更接口前同步给使用方。
