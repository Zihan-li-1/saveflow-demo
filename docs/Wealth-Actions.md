# Wealth Skill 动作契约（E 组）

## 1. 边界

Wealth Skill 只接收 A 解析并由服务端补全实体后的 `ResolvedIntent`。Qwen 不能直接提供产品、持仓或账户 ID，也不能提供 `risk_level`、`confirmed`、工具名或执行结果。

- A/E 跨模块合同：`snake_case`、`{ amount_minor, currency }`。E 返回给 B 的待执行请求与要求沿用 Card 的 `camelCase`。
- 项目内部：沿用 `camelCase`、`Fen`、`expectedYield`（BPS）。
- Repository 的 `MaybePromise<T>` 调用全部 `await`。测评、披露与锁定期按可信服务端时钟判断，不能用旧 Mock 快照日期代替当前时间。
- 查询与适配规则是确定性的；LLM 不决定适当性，也不按收益率选“最佳产品”。
- `expectedYield` 只是合成 BPS 展示值，必须展示“不保证收益”。
- 申购、赎回只生成 L3 `action_request`。确认和执行归 B 的 Action Engine；当前测试端口不进入生产代码。
- 本实现不修改 `src/agent`、`src/banking-core` 或 `saveflow_mock_data.json`。

## 2. 动作一览

| Action | Resolved 输入 | 输出 | 风险 |
|---|---|---|---|
| `wealth.recommend` | `goal`、可选 `constraints` | 匹配产品、排除产品、原因码、证据与披露 | 只读建议 |
| `wealth.compare` | 2–5 个唯一 `product_ids` | 风险、展示收益 BPS、流动性、最低金额、期限 | 只读 |
| `wealth.assess_risk` | `assessment_scope` | 有效测评，或可信 UI 问卷入口 | 信息/资格 |
| `wealth.subscribe` | `product_id`、`amount`、`source_account_id` | L3 `action_request` | 资金 |
| `wealth.redeem` | `holding_id`、明确单位的 `quantity_or_amount` | L3 `action_request` | 资金 |

机器合同：

- `schemas/wealth-actions.schema.json`：A 的原始 action fragment，只允许用户称呼。
- `schemas/wealth-resolved-actions.schema.json`：Resolver 产出的服务端实体引用。
- 运行时 `validateResolvedWealthIntent` 强制 `resolved_slots` 中的 ID 与 `references` 相等。

## 3. 逐动作合同

### 3.1 `wealth.recommend`

输入：

```json
{
  "goal": {
    "kind": "short_term_purchase",
    "target_date": "2026-10-15",
    "max_risk_level": "R2"
  },
  "constraints": {
    "investable_amount": { "amount_minor": 200000, "currency": "CNY" },
    "max_settlement_days": 1
  }
}
```

筛选顺序：披露有效 → 风险等级 → 流动性 → 期限 → 最低金额。用户提出的风险上限只能收紧可信测评结果，不能把 R2 测评放宽到 R3。结果同时返回 `matches` 与 `excluded[].reason_codes`，避免只给结论不解释原因。
当前三个 Mock 产品均没有可验证的本金保障；`capital_preservation` 不被解释成“低风险即可保本”，而是明确返回 `NO_MATCHING_PRODUCT`。目标日期若已过则拒绝。

### 3.2 `wealth.compare`

`product_ids` 必须有 2–5 个且不重复；每个 ID 都必须来自 `references`。未知产品返回 `PRODUCT_NOT_FOUND`。

### 3.3 `wealth.assess_risk`

有效结果必须满足：`source=trusted_ui`、未过期、风险等级为 R1/R2/R3。缺失或过期时只返回问卷入口，模型不能填写答案或推断等级。

### 3.4 `wealth.subscribe`

准备请求前检查：

1. 产品存在且允许申购；
2. 测评有效且产品风险不高于用户等级；
3. 产品披露有效；
4. 金额不低于产品最低金额；
5. 来源账户存在、处于 active 状态且余额充足。

输出仍是请求：

```json
{
  "kind": "action_request",
  "request": {
    "action": "wealth.subscribe",
    "input": {
      "productId": "product_002",
      "amountFen": 10000,
      "currency": "CNY",
      "sourceAccountId": "ACC-CHECKING"
    }
  },
  "requirements": {
    "minimumRiskLevel": "L3",
    "explicitUserConfirmation": true,
    "executionOwner": "banking_core"
  }
}
```

### 3.5 `wealth.redeem`

`quantity_or_amount` 必须明确是金额还是份额，禁止混用。Skill 检查持仓、数量、锁定期和产品赎回能力，然后返回 L3 请求，不修改持仓。

## 4. 错误码

| 错误码 | 含义 |
|---|---|
| `PRODUCT_NOT_FOUND` | 产品不存在 |
| `NO_MATCHING_PRODUCT` | 没有同时满足约束的产品 |
| `RISK_ASSESSMENT_REQUIRED` | 测评缺失或过期 |
| `SUITABILITY_FAILED` | 产品风险高于用户等级 |
| `BELOW_MINIMUM_AMOUNT` | 金额低于产品门槛 |
| `HOLDING_NOT_FOUND` | 持仓不存在 |
| `INSUFFICIENT_HOLDING` | 赎回金额/份额超过持仓 |
| `REDEMPTION_RESTRICTED` | 持仓仍在锁定期 |
| `DISCLOSURE_EXPIRED` | 产品披露不存在或过期 |
| `CAPABILITY_UNAVAILABLE` | Mock/后端不支持当前能力 |

通用错误继续使用 `VALIDATION_ERROR`、`ACCOUNT_NOT_FOUND`、`INSUFFICIENT_BALANCE`、`INTERNAL_ERROR`。
冻结或其他不可用来源账户返回 `ACCOUNT_UNAVAILABLE`；可信问卷入口未配置也返回 `CAPABILITY_UNAVAILABLE`。

## 5. Mock 数据

团队测试 fixture 独立保存，不改共享 Mock：

- `tests/fixtures/wealth/risk-assessments.json`
- `tests/fixtures/wealth/holdings.json`
- `tests/fixtures/wealth/product-disclosures.json`
- `tests/fixtures/wealth/operation-rules.json`
- `tests/fixtures/commerce/catalog.json`
- `tests/fixtures/commerce/events.json`
- `tests/fixtures/commerce/capabilities.json`

沿用 Repository 的 `product_001`、`product_002`、`product_003`。`src/skills/wealth/mock-ports.mjs` 提供单用户合成测评、披露与规则；持仓由 Banking Core 的 Mock Repository 或 PostgreSQL 保存。测试专用 `wealth-test-port.mjs` 仍只克隆账户与持仓，不写入正式 Repository。

## 6. 四条购物联动

1. **大额购物规划**：报价和购买日期转为 `short_term_purchase`；只生成 `suggested_slots`，不是完整 `ResolvedIntent`。
2. **结算前流动性检查**：先从现金中预留近期账单义务，再算购物现金缺口；卡额度只抵购物金额，不抵账单义务。需要赎回时，赎回确认与订单确认分开；到账后刷新报价与库存。
3. **退款到账后再配置**：只有可信 Commerce Mock 来源的 `refund.settled` 事件产生 `subscription_candidate`；用事件 ID 去重。
4. **消费凑整投资**：只消费可信 Financial Context 的 `transaction.posted`；累计到阈值后产生 `subscription_candidate`。

`subscription_candidate` 只有金额和事件来源，尚无产品、来源账户与适当性结论，不能送到 Action Engine。Orchestrator 必须先让用户选产品、核验测评并生成完整申购预览；一次确认只授权一笔投资。事件处理函数需要服务端注入的 `isTrustedEvent` 校验器，缺失时拒绝；单靠事件的 `source` 字段不能证明真实性。购物订单与赎回分别确认；无足额可赎回持仓时返回 `can_proceed=false`。
凑整达到阈值只生成候选，不清空累计金额；只有未来正式申购成功回执才能结算相应累计额度，避免用户拒绝预览时丢失记录。

多步骤部分失败保留每一步真实回执。赎回成功而订单失败时，不宣称赎回已回滚。

## 7. 接口接入与部署

当前 `/api/banking-agent` 使用项目现有的 `ParsedIntent` v1.0.0 单意图适配层：模型只输出原始称呼，服务端 Resolver 生成带 `references` 的 Wealth `ResolvedIntent`，再调用 Skill。五个 action 已在解析器、校验器与 dispatcher 注册；查询结果可在页面展示。`wealth.subscribe` 与 `wealth.redeem` 的请求交给 Banking Core 生成 L3 预览，再由已授权页面通过独立的 `action.decide` 与 `action.execute` 接口确认和执行。模型没有确认或执行权限。

部署 PostgreSQL 前必须应用 `migrations/003_wealth_holdings.sql`。适配器在同一事务中更新 Mock 账户或持仓及操作回执；再次执行同一操作只返回原回执。赎回仅减少模拟持仓，**不承诺即时到账，也不把赎回金额直接加到活期余额**。`as_of` 是 Mock 快照时间；正式预览与执行前会重新读取账户、测评、披露和持仓。购物联动仍只生成候选或分步建议，没有外部购物平台下单接口。

`ParsedIntentEnvelope` v1.1 的统一生产者仍由 A 负责；本适配层不将旧 Qwen 枚举直接交给 Wealth Skill。真实银行或真实投资接入、风险问卷完成接口和真实风控不在此演示范围内。当前测评是明确标记为合成数据的单用户演示状态，不可作为实际投资适当性依据。

专项验证：

```bash
node --test tests/wealth-skill.test.mjs tests/wealth-commerce.test.mjs tests/wealth-agent-integration.test.mjs
```
