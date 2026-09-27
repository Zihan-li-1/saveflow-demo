# Banking Agent 与 IM 合同 v1.1

边界：理解 → 澄清/选择 → 账单结果或 Core 正式预览。确认、执行、回执等待 B 的共享状态方案；页面没有转账确认按钮，不调用 action.decide / action.execute。

## 入口与切换

POST /api/banking-agent；本地 npm run dev:qwen；生产 netlify/functions/banking-agent.mjs。普通 next dev 或单独上传 out 不提供 POST。

页面默认 Banking Agent。消息、补充回答和选项只调用此接口；明确切换“Qwen 储蓄助手”才使用旧 /api/agent；离线模拟保留。切换清空会话、token、卡片，不双发、不静默回退。

请求头为 Content-Type: application/json 和 X-Saveflow-Access: <演示访问码>。前端使用同源相对路径；服务端拒绝不匹配的 Origin。访问码只存页面内存。服务端需要 SAVEFLOW_ACCESS_CODE 和 CONTINUATION_TOKEN_SECRET（分别至少16字符），所有实例使用相同续接密钥。DASHSCOPE_API_KEY 和续接密钥不得使用 NEXT_PUBLIC_ 前缀或传入浏览器。

## 请求

首次消息：
```json
{"message":"给张三转 500 元","history":[],"consent":true}
```
补充回答或修改预览：
```json
{"continuationToken":"<上一响应的令牌>","message":"2026年8月"}
```
选项点击：
```json
{"continuationToken":"<上一响应的令牌>","choice":{"optionId":"opt_<上一响应选项>"}}
```

choice 只能包含 optionId，必须带 token，不能同时带 message。前端不传实体 ID、金额对象、operationId、confirmed 或 riskLevel。首次 message 为1–2000字符，页面限制500字；history 可省略，最多12条，每条为 role（user/assistant）与 content（1–2000字符）。consent 为兼容现有调用方可省略，提供时只能 true；页面强制勾选并提交 true。请求体最多16KB。

token 为5分钟有效的加密认证状态，包含槽位和服务端候选映射，不代表确认。不是一次性消费 token，不提供写入幂等性；重放可能生成另一个预览。不得记录完整 token、访问码、模型密钥。跨进程续接需要相同密钥和一致的 Repository；续接时重新检查选中实体有效性。

## 响应

统一 envelope：`{code,message,requestId,data?}`。requestId 由服务端生成；Cache-Control: no-store。HTTP 200 不等于业务成功。

| HTTP / code | data | 页面处理 |
| --- | --- | --- |
| 200 / NEEDS_CLARIFICATION | kind=clarification、status=needs_clarification、action、slot、question、choices、continuationToken，可有 source/message | 显示追问及 {optionId,label}；无选项时文字回答 |
| 200 / OK | status=bill_result、action=bill.summary、data、evidence | 月份、收入/支出、笔数、来源和截点 |
| 200 / OK | status=awaiting_confirmation、action=transfer.create、operationId、preview、risk、continuationToken | 显示 Core 正式预览；本轮不能确认 |
| 200 / UNSUPPORTED | status=unsupported | 提示暂不支持 |
| 4xx/5xx / 错误码 | 可无 data，或 status=error/core_error、error | 显示 envelope.message，旧预览不恢复 |

账单 data：month、totalIncomeFen、totalExpenseFen、transactionCount、categoryTotals；evidence 为 {source,asOf,entityIds} 数组。金额整数分，展示时除100。统计由 Repository 计算，不由模型生成。

preview 使用 B 的 camelCase 合同：planId、stepIds、summary、previewHash、exactEffects、riskLevel、warnings、expiresAt、contextSnapshotId。effect 包含账户名、收款人名、脱敏账号、整数分金额、手续费与预期余额。operationId/hash 只由 Core 生成。此入口不同于 /api/banking 的 snake_case wire 合同。

完整固定响应见 [fixtures](../tests/fixtures/banking-agent)。样例 token 为占位符，不能重放；实际续接必须使用上一响应的 token/optionId。

常见错误：401 UNAUTHORIZED；403 FORBIDDEN；400 INVALID_REQUEST / INVALID_CHOICE / CONTINUATION_INVALID；429 RATE_LIMIT（每分钟10次）；503 ACCESS_NOT_CONFIGURED / CONTINUATION_CONFIG_ERROR；MODEL_*；Core INSUFFICIENT_BALANCE 等。错误可能没有 data。令牌过期需重新开始；网络错误不自动重试。

## 修改与失效

每次消息或点选先撤下旧预览、停用旧选项，再发送请求；失败也不恢复旧预览。只保留最近 token；重置和切换来源清空。请求代次丢弃过期响应，同步状态门禁防双击。

支持“改成 600 元”“改给王先生”“收款人改成李四”“改选收款人”“改选账户”。修改实体槽位同时删除旧实体选择，重新消歧；金额保留，生成新的 operationId/hash。选择账户/收款人不代表确认；输入“确认”不会执行转账。

本轮撤卡是 UI 失效，不宣称跨实例撤销旧 Core operation。B 开放确认前需在共享存储实现预览替代/失效校验，不能仅依靠隐藏卡片。

## 验证

Node >=22.12。运行 npm test、npm run typecheck、npm run lint、npm run build。

banking-agent-integration.test.cjs 通过真实 HTTP 将两轮发送到不同 PID，分别验证本地处理器、Netlify Function 导出入口。覆盖账户选择、收款人消歧、账单月份、修改、伪造选项、访问码、Origin、资金不变。供应商使用测试桩，Core/Repository 为真实实现；不等于线上部署或真实 Qwen 验收。

线上部署需配置相同 Functions 运行时续接密钥，重跑三条链路，并用平台日志核对请求编号和实例。实际验收范围见 [联调记录](Banking-Agent-Integration.md)。
