# Banking Agent 请求入口

本地使用 `npm run dev:qwen`，生产使用 Netlify Function；两者路径均为 `POST /api/banking-agent`。请求需要服务端配置的演示访问码和 `CONTINUATION_TOKEN_SECRET`（至少 16 位），且只能提交消息、可选历史和可选授权标记。

## 请求样例

```bash
curl -X POST http://127.0.0.1:3000/api/banking-agent \
  -H "Content-Type: application/json" \
  -H "X-Saveflow-Access: <SAVEFLOW_ACCESS_CODE>" \
  -d '{"message":"从活期账户给张三转500元","history":[],"consent":true}'
```

## 转账预览响应

```json
{
  "code": "OK",
  "message": "转账正式预览已生成，等待用户确认",
  "requestId": "<request-id>",
  "data": {
    "status": "awaiting_confirmation",
    "action": "transfer.create",
    "operationId": "op_<id>",
    "preview": {
      "planId": "plan_<id>",
      "stepIds": ["step_<id>"],
      "summary": "<Core 生成的正式预览>",
      "previewHash": "<sha256>",
      "exactEffects": [{ "kind": "transfer_out", "amountFen": 50000, "currency": "CNY" }]
    },
    "risk": {
      "allowed": true,
      "riskLevel": "L3",
      "requiredConfirmation": "mock_explicit"
    }
  }
}
```

## 账单响应

```json
{
  "code": "OK",
  "data": {
    "status": "bill_result",
    "action": "bill.summary",
    "data": {
      "totalIncomeFen": 0,
      "totalExpenseFen": 0,
      "transactionCount": 12,
      "categoryTotals": {}
    },
    "evidence": [{
      "source": "synthetic_demo_only",
      "asOf": "2026-09-01T00:00:00+08:00",
      "entityIds": ["<transaction-id>"]
    }]
  }
}
```

## 多轮澄清与选择

首轮缺少付款账户时，响应只展示 Repository 返回的账户名称和一次性选项标识；`continuationToken` 仅用于续接未完成意图，不代表确认授权。

```json
{
  "code": "NEEDS_CLARIFICATION",
  "data": {
    "kind": "clarification",
    "status": "needs_clarification",
    "action": "transfer.create",
    "question": "要从哪个账户转出？",
    "slot": "source_account_ref",
    "choices": [{ "optionId": "opt_<opaque>", "label": "模拟活期账户" }],
    "continuationToken": "<opaque-short-lived-token>"
  }
}
```

续接时提交选项标识，不提交账户 ID；服务端核对候选仍有效后才重新解析并调用 Core：

```json
{
  "continuationToken": "<opaque-short-lived-token>",
  "choice": { "optionId": "opt_<opaque>" }
}
```

成功响应仍只包含 Banking Core 的正式 `awaiting_confirmation` Preview、风险结果和 `operationId`。

澄清返回 `code: "NEEDS_CLARIFICATION"`，不支持返回 `code: "UNSUPPORTED"`；模型、Skill 或 Core 错误返回对应错误码。该入口只生成转账预览，不接受 `operationId`、`confirmed`、`riskLevel` 等执行字段，也不确认或执行交易。
