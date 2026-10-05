# E：Card Skill 四动作契约草案

## 1. 本次交付边界

本次只交付 `card.get`、`card.set_limit`、`card.freeze`、`card.unfreeze` 的动作契约、Schema 和第一个 Card Skill。它不修改 Banking Core、HTTP API、页面或 Qwen 旧 intent 枚举。

A 统一生成 `ParsedIntentEnvelope`。原始识别片段使用 `schemas/card-actions.schema.json`；完成实体解析后，A/Resolver 按共享 `ResolvedIntent` 结构生成 `schemas/card-resolved-actions.schema.json` 所描述的片段，再交给 Card Skill。`create_plan` 等旧枚举只允许在服务端适配层处理，Card Skill 明确拒绝。

项目命名规则保持一致：模型与跨模块合同使用 `snake_case` 和整数最小货币单位；Skill 向 B 生成的内部请求使用 `camelCase` 和 `Fen`。字段只改名，不乘除 100。

## 2. 逐动作契约

| action | 原始 slots | 解析后输入 | Skill 输出 | 错误码 | 所需 Mock |
| --- | --- | --- | --- | --- | --- |
| `card.get` | `card_ref` | `card_id` + 唯一 `card` reference | `{kind:"query", card, context}` | `VALIDATION_ERROR`、`CARD_NOT_FOUND`、`CARD_AMBIGUOUS` | 卡片列表、数据截点 |
| `card.set_limit` | `card_ref`、`limit_type:"monthly_total"`、`amount` | `card_id`、`limit_type`、`amount` | 交给 B 的 `{action:"card.set_limit",input:{cardId,limitType,amountFen,currency}}` | 上述错误 + `LIMIT_EXCEEDED`、`INVALID_STATE` | 当前限额、本月已消费、卡片状态 |
| `card.freeze` | `card_ref` | `card_id` | 交给 B 的 `{action:"card.freeze",input:{cardId}}` | 上述错误 + `INVALID_STATE` | 卡片状态 |
| `card.unfreeze` | `card_ref` | `card_id` | 交给 B 的 `{action:"card.unfreeze",input:{cardId}}` | 上述错误 + `INVALID_STATE` | 卡片状态 |

所有输入都拒绝额外字段。`card_ref` 是用户原始称谓，模型不能生成 `CARD-ENT` 一类实体 ID。实体 ID 只能由 Financial Context 或用户明确选择产生，并记录在 `references` 中。

## 3. 输出与权限边界

`card.get` 是只读结果。三个写动作只生成 `action_request`：

- `card.set_limit` 和 `card.freeze` 要求 B 至少按 L2 处理；
- `card.unfreeze` 要求 B 至少按 L3 处理；
- 三个写动作都必须经过真实 UI 明确确认；
- Skill 没有 confirm、execute 或直接修改 Repository 的入口；
- 最终风险判定、预览哈希、幂等、执行和回执仍由 B 的 Risk & Action Engine 负责。

`requirements` 是 Skill 根据注册动作产生的确定性要求，不来自模型，也不能替代 B 的风险计算。

## 4. 与当前仓库统一的变量和 Mock

Card Skill 只使用当前 `FinancialContextRepository` 已有的 `getCards()` 和 `getContextInfo()`，不要求修改现有接口。卡片字段沿用当前项目：

```text
id, name, accountId, status, monthlyLimitFen, monthlySpentFen
```

当前 Mock 对照：

| 卡片 | accountId | status | monthlyLimitFen | monthlySpentFen |
| --- | --- | --- | ---: | ---: |
| `CARD-MAIN` / 日常虚拟卡 | `ACC-CHECKING` | `active` | 500000 | 0 |
| `CARD-ENT` / 娱乐虚拟卡 | `ACC-CHECKING` | `active` | 80000 | 76000 |

`amount.amount_minor` 与内部 `amountFen` 数值相同。例如 1000 元均表示为 `100000`，仅字段名变化。

## 5. A/E 交接示例

```json
{
  "intent_id": "intent_card_001",
  "action": "card.set_limit",
  "state": "ready_for_planning",
  "resolved_slots": {
    "card_id": "CARD-ENT",
    "limit_type": "monthly_total",
    "amount": { "amount_minor": 100000, "currency": "CNY" }
  },
  "references": [
    {
      "slot": "card_ref",
      "entity_type": "card",
      "entity_id": "CARD-ENT",
      "source": "financial_context"
    }
  ],
  "missing_slots": []
}
```

Skill 输出：

```json
{
  "kind": "action_request",
  "request": {
    "action": "card.set_limit",
    "input": {
      "cardId": "CARD-ENT",
      "limitType": "monthly_total",
      "amountFen": 100000,
      "currency": "CNY"
    }
  },
  "requirements": {
    "minimumRiskLevel": "L2",
    "explicitUserConfirmation": true,
    "executionOwner": "banking_core"
  }
}
```

## 6. 当前未包含的集成工作

A 仍需把四个 action 注册到统一的 `ParsedIntentEnvelope` 输出与路由。B 仍需决定何时把对应请求注册到公共 `ActionRequest`、预览、确认、执行和 HTTP 层。这些是 A/B 负责的后续集成，不属于 E 本次提交，也不能由本 Skill 假装成功。

单独验收命令：

```bash
node --test tests/card-skill.test.mjs
```
