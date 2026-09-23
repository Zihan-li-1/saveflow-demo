# Banking Core B 项目交接合同 v1.0.0

日期：2026-09-22。依据工作区《建骨架.md》的 B 分工及《intent-contracts.md》v1.1。

B 已实现统一数据仓库、公共类型、转账 Risk/Preview/Confirm/Execute/Receipt、用户作用域幂等、待核实查询、Mock/HTTP 适配和回归测试。A 的 Qwen 新意图路由、C 的完整账单 Skill、D 的收款人消歧及聊天转账确认卡、E 的工作流仍由各自模块接入。本次不会让旧储蓄助手声称已经完成自然语言转账。

## 1. 唯一入口与版本

TypeScript 模块统一从 `src/banking-core/index.ts` 引入类型和底座；纯 Node ESM 服务从 `core.mjs` 引入运行时。`.mjs` 使用 `@ts-check` 和同一份 TS 合同，供 Next 浏览器包和 Node/Netlify 服务共享，避免复制执行逻辑。

| 合同 | 冻结规则 |
| --- | --- |
| B 内部合同 v1.0.0 | 按《建骨架》使用 camelCase、`amountFen` / `balanceFen` 等；金额必须为安全整数分 |
| 新 HTTP 合同 v1.1.0 | 按《intent-contracts》使用 snake_case；金额为 `amount_minor` 等整数，显式 `currency: "CNY"` |
| 意图适配 | `transfer.create` → `transfer_money`；只在 `wire.mjs` 适配已经唯一解析的账户/收款人引用 |
| 旧接口 v1 | `analyze/create-plan/operation-status` 原字段保留，不自动升级为转账或理财指令 |

新增可选字段升小版本；改单位、含义、必填字段或枚举升大版本。金额换算只允许在原始元种子导入和 UI 展示处发生；HTTP/意图边界只改字段名，不乘除 100。禁止把 `monthlySavingFen` 当转账金额，把 `saveRateBps` 当卡限额。

## 2. 公共类型

准确类型以 `src/banking-core/contracts.ts` 为唯一来源，其他 Skill 不另写同名实体。

| 类型 | 核心字段与语义 |
| --- | --- |
| Account | id、name、checking/saving、currency、balanceFen、availableBalanceFen、version、status |
| Payee | id、name、可选 phone、aliases、accountNoMasked、currency、status；当前只有脱敏账号，无真实手机号 |
| Transaction | id、accountId、可选 payeeId/operationId、occurredAt、type、amountFen、currency、status、source；金额为正数，方向由 type 表达 |
| Card | id、name、accountId、status、monthlyLimitFen、monthlySpentFen |
| Subscription | id、name、monthlyFeeFen、status、lastUsedDate、isPotentiallyUnused、mandateId；当前 mandateId=null，不支持解除代扣 |
| InvestmentProduct | id、name、R1/R2/R3、expectedYield、liquidity、minimumAmountFen、durationDays、currency、isSynthetic |
| ActionRequest | 注册动作 + input，可带服务端 planId/stepId/origin；当前仅 `transfer_money` |
| ActionResult<T> | `{ok:true,data:T}` 或 `{ok:false,error,operationId?}`；不能只检查 HTTP 200 |
| ActionReceipt | receiptId、operationId、action、planId、stepId、status、executedAt、transactionIds、effects、dataSource；失败/取消不含已执行效果 |
| ToolCall/ToolResult | toolCallId、tool、arguments/result、evidence；证据带 source/asOf/entityIds，写结果带具体步骤回执 |

`InvestmentProduct.expectedYield` 明确为整数基点，例如 150=1.50% 的模拟年化展示值，HTTP 字段为 `expected_yield_bps`；不是承诺收益。产品为三个自造合成样例，分别 T+0、T+1、30 天到期。

## 3. FinancialContextRepository

```ts
import { bankingCore } from "@/banking-core";
const repo = bankingCore.repository;
repo.getAccounts();
repo.getAccount("ACC-CHECKING");        // 不存在返回 undefined
repo.getPayees();
repo.getPayee("payee_001");
repo.getTransactions({ month: "2026-08" });
repo.getCards();
repo.getSubscriptions();
repo.getInvestmentProducts();
repo.getContextInfo();
```

所有查询返回防御性副本，改返回值不能改余额。唯一种子读取位置为 `repository.mjs`；Mock 运行期间不回写 JSON。`createBankingCore()` 创建独立演示实例，默认单例 `bankingCore` 供同一运行时内各模块共享。

种子账户可用余额为活期 ¥5,000、储蓄 ¥0；总余额暂等于可用余额，这只是没有冻结款的 Mock 快照，不从历史账单倒推余额。收款人张三/李四/房东王先生/王强；“王先生”同时匹配后两位，由 D 追问，B 只执行确定的 ID。

数据统一标注截至 **2026-09-01**，账单样例月为 **2026-08**，上月为 **2026-07**。Mock 新交易标注 `source=mock_execution` 和实际演示执行时刻；历史交易仍为 `synthetic_seed`。C 统计消费时须区分 `expense` 与 `transfer_out`，避免把转账直接当消费。

目标进度统一使用种子 `currentAmount=0`，移除页面和 Qwen 的硬编码 ¥2,400。种子原目标需 ¥5,000/月，仍保留在 `proposedMonthlySavingFen`；旧计划默认 ¥2,500/月、演示上限 ¥3,000/月来自 `getDemoSettings()`，不宣称按这个上限可以在原期限完成目标。账户余额不等同于可投资金额。

## 4. 写操作生命周期

```text
prepare → risk_check → awaiting_confirmation → confirmed → executing → succeeded/failed
                         ↓ reject                  ↓ reject
                       cancelled                cancelled

executing → unknown → checking → succeeded / failed / unknown
```

`prepare()` 生成服务端 operationId/planId/stepId，校验参数、实体、余额、限额；产出风险结果及预览，不扣款。L3 风险和零手续费由 Mock 策略确定，模型不能覆盖。SHA-256 绑定用户、操作编号、步骤、来源、精确效果、数据版本、有效期和策略。有效期默认 5 分钟，单笔 Mock 上限默认 ¥100,000；两者都不是银行官方参数。

`decide()` 只能由 UI 确认适配器调用，必须提交原 previewHash 和精确 stepIds；服务器记录确认方式、时刻和幂等键。裸 `confirmed:true` 对新动作无效。确认不会扣款，`reject` 形成取消回执。

`execute()` 只接受原 operationId 和 previewHash，不接受新的金额或收款人；执行前再次检查有效期、账户版本、收款人、余额和限额。余额不足/预览过期/版本变化会形成标准失败回执；必须重新预览确认。**相同操作成功后重放返回原回执，不因后来余额变化重新扣款。**

`action-machine.mjs` 是执行/待核实状态的共同规则来源；旧 `flow-machine.ts` 仅将 succeeded/failed 映射为旧 UI 的 success/error。未取得可靠回执只允许查原编号，不允许自动重试写入或重置。未知编号返回 `state=unknown,status=pending`，尤其不能把进程重启后的查无记录当成“没有扣款”。

## 5. D 的接入范例

```ts
import { bankingCore } from "@/banking-core";

// Tool / 服务端：账户和收款人已由 D 解析为唯一 ID。
const result = await bankingCore.prepare({
  action: "transfer_money",
  input: { fromAccountId: "ACC-CHECKING", payeeId: "payee_001", amountFen: 50000, currency: "CNY" },
});
if (!result.ok) throw new Error(result.error.message);
const { operationId, preview } = result.data;
// 将 preview 渲染给用户；此处必须返回并等待用户按钮，不能由 Tool 自动确认。

// 以下属于用户点击“确认转账”的独立 UI 处理函数。
const confirmed = bankingCore.decide(operationId, {
  previewHash: preview.previewHash,
  decision: "confirm",
  confirmedStepIds: preview.stepIds,
});
if (!confirmed.ok) throw new Error(confirmed.error.message);
const executed = bankingCore.execute(operationId, preview.previewHash);
// 按 executed.ok 和回执 status 展示本步骤结果；不等同于整份多步骤计划成功。
```

浏览器 HTTP 模式应使用 `src/lib/api/banking-client.ts` 的 `createBankingClient({accessCode: () => 当前内存访问码})`，依次 `request("transfer.prepare", ...)`、用户确认后 `action.decide`、`action.execute`。遇到 `ApiError.uncertain` 保留编号，走 `action.status`；确认接口超时也查同一编号确认当前状态。A 的模型工具注册表不得注册 `action.decide` 或将它自动串在 prepare 后面。

## 6. HTTP 契约

`POST /api/banking`，`Content-Type: application/json`，`X-Saveflow-Access: 演示访问码`。执行额外传 `Idempotency-Key: 原 operationId`。输入不允许 user_id、confirmed、risk_level 或未注册字段。服务端按访问码绑定唯一演示用户，不能通过请求体选择用户。

| action | input（wire 字段） | 成功 data |
| --- | --- | --- |
| context.get | `{}` | 数据截点/样例月份/快照 |
| account.list / payee.list | `{}` | 实体数组 |
| account.get / payee.get | `{id}` | 单个实体，找不到为标准错误 |
| transaction.list | 可选 account_id、month（YYYY-MM） | 原始交易数组 |
| product.list / card.list / subscription.list | `{}` | 合成产品/卡/订阅数组 |
| transfer.prepare | source_account_id、payee_id、amount_minor、currency，可选 memo | operation_id、state、preview、risk |
| action.decide | operation_id、preview_hash、decision、confirmed_step_ids | 该操作状态；拒绝时 step_ids 传空数组 |
| action.execute | operation_id、preview_hash | ActionReceipt |
| action.status | operation_id | state、status、可选 receipt/preview/error |

```json
{
  "schema_version": "1.1.0",
  "action": "transfer.prepare",
  "input": {
    "source_account_id": "ACC-CHECKING",
    "payee_id": "payee_001",
    "amount_minor": 50000,
    "currency": "CNY"
  }
}
```

响应统一 `{schema_version, request_id, code, message, data? , error?, operation_id?}`。错误对象 `{code,message,uncertain}`；新 request_id 由服务器生成，不接受模型设置。常见错误：VALIDATION_ERROR、ACCOUNT_NOT_FOUND、PAYEE_NOT_FOUND、INSUFFICIENT_BALANCE、LIMIT_EXCEEDED、CONFIRMATION_REQUIRED、CONFIRMATION_INVALID、PREVIEW_EXPIRED、PREVIEW_STALE、IDEMPOTENCY_CONFLICT。客户端校验预览金额/收款人、回执编号和状态，网络错误或异常回执不能成为成功提示。

旧 `POST /api/saveflow` 由同一服务处理器适配，旧 UI 仍用原 v1 envelope；创建计划没有资金效果、不会改目标余额。旧查询不会把转账回执误当储蓄计划成功。

## 7. 本地运行与验收

Node >=22.12；已有 `.env.local` 和密钥保持不变。

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run demo:banking
```

`demo:banking` 在隔离内存里模拟按钮确认，演示张三 ¥500 转账、确认前余额不变、重复只扣一次、余额不足和不存在收款人。没有模型费用。

默认 `NEXT_PUBLIC_SAVEFLOW_API_MODE=mock` 使用浏览器内存底座。HTTP 本地联调设置 `NEXT_PUBLIC_SAVEFLOW_API_MODE=http`、`NEXT_PUBLIC_SAVEFLOW_API_BASE_URL=`（留空，同源），运行 `npm run dev:qwen`。该命令同时提供 Next、`/api/agent`、`/api/banking`、旧 POST `/api/saveflow`；只有主动请求 `/api/agent` 才可能调用 Qwen。普通 `next dev` 不提供这些 POST 服务。

自动化测试涵盖 B 的四个必验项目，另含 20 次重复提交、两笔不同转账争用余额、取消、篡改确认、过期、用户隔离、响应丢失后查询、HTTP 拒绝、客户端回执校验、旧 UI/Qwen 回归。核心测试、HTTP 测试和验收脚本均不读取真实密钥或调用供应商。

## 8. 存储与扩展边界

当前是**单运行时内存 Mock**：operation store 按用户+操作编号隔离，执行的校验、扣款、交易追加和回执落在同一个同步临界段，没有 await，保证该运行时内不重复扣款。刷新浏览器/重启进程会重置；不同标签页、进程、Netlify 实例不共享状态。HTTP 与浏览器 Mock 也是独立数据空间，不应混用同一笔操作。

`netlify/functions/banking.mjs` 与 `saveflow.mjs` 是完整项目部署时的模拟处理器，不代表已更新线上站点；`out/` 自身不包含 POST 能力。Serverless 多实例不提供持久幂等保证，不应用于真实资金或跨实例账务验收。演示访问码 + mock_explicit 只是私人 Mock 的确认门，不是银行 L3 强认证。

新增 cancel_subscription/update_card_limit/purchase_product 时，向同一引擎增加 action 专属校验、风险、精确效果和原子提交适配器，复用状态机、确认、OperationStore、ActionReceipt 和审计。当前这些动作明确拒绝，不能用假成功占位。真实后端还需替换为用户身份/强认证、持久化幂等唯一约束与账务事务、银行状态查询/对账及审计存储；未来异步银行调用不能直接套用当前同步内存提交假设。
