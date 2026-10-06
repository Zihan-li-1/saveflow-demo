# 目标动作—当前实现—本轮状态

状态：合同预备；前两条主链路验收后接入。接入前由 B、C、D 确认各自接口；本文不表示功能已经上线。
前两条主链路的接口与验收约定见 [本轮开发交接契约：转账预览安全与双月账单分析](iteration-handoff-transfer-bill.md)。
A 负责合同、解析、校验、路由、HTTP 整合及解析与拒绝执行测试；C 负责订阅 handler 的业务测试；D 负责页面测试。
E 原分工为 Wealth + Scenario，可提供少量跨场景样例，不承担订阅整套测试，也不作为订阅接入的前置确认人。
订阅动作仍待前两条主链路验收及 B、C、D 接口确认后注册。卡片查询、月消费预算、冻结和解冻已接入解析器、Agent、Core 正式预览、独立页面确认、执行回执和持久化适配，范围见 [卡片查询与月预算操作](Card-Actions.md)。跨实例数据库验收需配置 `BANKING_TEST_DATABASE_URL` 后运行测试。当前保持 `schemaVersion: "1.0.0"` 单意图结构，不宣称实现目标合同的多意图 `1.1.0`。

| 用户要做的事 | action ID / 含义 | 负责成员 | 当前实现与是否可调用 | 本轮状态 | 缺少的能力 |
|---|---|---|---|---|---|
| 查看现有订阅及模拟月费 | `subscription.list`：只读订阅查询 | A 接入与解析测试；B 提供仓库；C handler 与业务测试；D 页面与页面测试 | Banking Core 已有 `subscription.list` 读接口；Banking Agent 解析、路由、HTTP 及页面尚未接入，因此自然语言入口目前不可调用 | **合同预备；前两条主链路验收后接入** | 注入式 handler、模拟月费结果及证据、严格空槽位校验、HTTP 结果和页面、回归测试 |
| 解除银行侧代扣授权 | `subscription.cancel_debit`：解除银行侧授权，不是商户退订 | A 拒绝路由与拒绝执行测试；B 授权/执行能力；C 订阅语义；D 说明与页面测试 | 未注册执行能力；不可调用。主分支 `src/skills/schemas.ts` **仍存在旧草案名，待统一**：`subscription.cancel`；合同文档名称为 `subscription.cancel_debit` | **未实现，明确拒绝执行** | 可撤销代扣授权数据、权属与可撤销性校验、风险预览、用户确认、统一执行及持久化审计 |
| 取消商户会员 | 无已注册 action；不等同于 `subscription.cancel_debit` | A 返回不支持与拒绝执行测试；C 说明业务边界；D 明示与页面测试 | 无商户会员取消接口；不可调用 | **不能声称已取消** | 商户侧接口及权限、商户确认和可验证结果；不得通过查询伪装完成 |
| 查看账单汇总 | 当前 `bill.summary`；目标 `bill.analyze` 是另一合同动作，不能直接替换 | A 保持解析与路由及回归测试；B 交易仓库；C 账单 handler 与业务测试；D 页面与页面测试 | 已有 month 槽位、路由、账单 HTTP 结果和展示，可调用 | **保持兼容** | 本轮无新增能力要求；`bill.analyze` 的区间、分析语义及合同迁移另行设计 |

## A → C / D：订阅只读结果约定（待确认）

输入意图必须是：

```json
{"schemaVersion":"1.0.0","action":"subscription.list","slots":{},"missingSlots":[],"status":"ready_for_resolution"}
```

拒绝任何额外槽位、顶层字段及执行数据，包括 `subscriptionId`、`mandateId`、`confirmed`。
取消会员或关闭代扣语句输出 `unsupported`，不得改为查询或宣称完成。

C 提供 `subscriptionHandler(intent, repository)`，由调用方传入当前请求使用的 `FinancialContextRepository`。
Dispatcher 注入的单参数 handler 由调用方绑定 Repository，例如：

```ts
const dependencies = {
  subscriptionHandler: intent => subscriptionHandler(intent, repository),
};
```

handler 从该 Repository 读取订阅和上下文，兼容同步或异步返回，不自行创建另一份仓库。返回：

```ts
{
  ok: true,
  kind: "subscription_result",
  action: "subscription.list",
  data: {
    subscriptions: Array<{
      id: string; name: string; monthlyFeeFen: number;
      status: "active" | "cancelled";
      lastUsedDate: string; isPotentiallyUnused: boolean;
    }>;
    activeSubscriptionCount: number;
    totalMonthlyFeeFen: number;
    currency: "CNY";
    dataSource: "synthetic_demo_only";
  },
  evidence: Array<{ source: string; asOf: string; entityIds: string[] }>
}
```

金额使用安全整数分；`totalMonthlyFeeFen` 仅合计 active 订阅的模拟月费，不是银行实际扣费。
返回全部可访问订阅并逐项展示状态；active 数量单独计数。
证据来自 `getContextInfo()` 和 `getSubscriptions()`，不得编造银行或商户执行状态。
对外结果不提供 `mandateId`；本轮没有任何取消执行入口。

A 的 HTTP envelope 沿用 `{code, message, requestId, data}`；成功 `code: "OK"`。
其内层 `data` 为 `{status: "subscription_result", action: "subscription.list", data: <上述业务数据>, evidence}`。
禁止内层含 `operationId`、`preview`、`risk`、`confirmed` 或 `continuationToken`。
D 按 `status` 增加只读结果展示，不提供取消/确认按钮。
未注入 subscriptionHandler 时明确返回 unsupported，不回退 Qwen 储蓄助手，不进入账单或转账 handler。

## 确认记录

| 成员 | 需确认的行与接口 | 状态 | 回复/日期 |
|---|---|---|---|
| B | 查询仓库可用；取消代扣未实现；不会因名称统一开通写能力；账单读接口保持兼容 | 待确认 | — |
| C | 订阅 list handler、Repository 依赖传递、active 模拟月费合计与证据形状及业务测试；商户退订与银行代扣边界；bill.summary 保持兼容 | 待确认 | — |
| D | subscription_result HTTP envelope、只读页面及页面测试；取消能力说明、不显示完成或确认按钮；账单页面兼容 | 待确认 | — |

请 B、C、D 回复“确认 + 涉及行/接口”，或注明修改项；A 记录实际回复，并在前两条主链路验收后再新增枚举。
E 可提供 Wealth + Scenario 的少量跨场景样例，其回复不作为订阅接入前置条件。
未收到的回复不能标记已确认。本文当前尚未发送：等待提供实际成员联系渠道，或由负责人转发。

## 订阅接入时的验收清单

1. parser 增加 subscription.list 的空槽位示例和取消请求拒绝说明。
2. `.mjs` 校验器及 `parsed-intent.ts` 同步增加动作和专属空槽位校验。
3. `dispatcher.ts` 与真实 `runtime.mjs` 均支持可选注入 handler；缺失时 unsupported。
4. HTTP 增加 subscription_result 分支，可注入测试 handler，不依赖 C 的真实实现完成验收。
5. A 用假模型响应跑通解析 → 校验 → 指定 handler → HTTP 结果，证明取消不调用任何 handler、额外执行字段拒绝、原有解析与路由不回归。
6. C 验证 handler 的 Repository 读取、active 月费合计、订阅状态和证据；D 验证页面展示、能力说明及无取消/确认按钮。E 可补充少量跨场景样例，无需承担订阅整套测试。
