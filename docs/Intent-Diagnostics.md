# Banking Intent 校验诊断

模型响应校验失败时，服务端向标准错误输出写入一行 JSON。
在 Netlify 的 `banking-agent` Function 日志中搜索
`banking_intent_validation_failed`，使用响应中的 `requestId` 关联请求。

示例（固定校验规则，不包含模型字段值）：

```json
{"event":"banking_intent_validation_failed","schemaVersion":"1.0.0","reason":"schema_validation_failed","validationRule":"slots.amount must be an object","requestId":"12345678-1234-1234-1234-123456789abc"}
```

失败类别：

- `incomplete_response`：响应不完整，或缺少文本内容。
- `invalid_response_json`：上游 HTTP 响应不是有效 JSON。
- `invalid_json`：模型文本不是有效 JSON。
- `schema_validation_failed`：模型 JSON 不满足 ParsedIntent v1；`validationRule` 指明失败规则。

日志不保存用户输入、对话历史、模型原文、未知字段名、金额、收款人、
账户、密钥或令牌。校验规则中的路径和要求均来自代码中的固定规则。
解析失败不会触发 Skill 或转账执行，系统不自动重试或放宽校验。
日志保留期限由部署平台设置决定。
