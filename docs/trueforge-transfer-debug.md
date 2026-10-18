# TrueForge 多轮转账与网页交互排查

2026-10-17，本地 `spike/trueforge-harness`。保留已有未提交改动，未提交 Git、创建 PR、修改 main 或部署。先用真实 Chrome/HTTP/TrueForge/MCP 复现，再修复。未重写 Agent、Dispatcher、Skill 或 Banking Core。

## 根因与证据

修复前 [网页报告](verification/transfer-debug/before-ui.json) 和 [真实工具事件](verification/transfer-debug/before-events.json) 已保存；凭据去除，Session 仅保留 SHA256 摘要。

| 问题 / 层级 | 修复前证据 | 原因及修复 |
| --- | --- | --- |
| 首句未进入 TrueForge / 适配层 | 原样“从模拟活期账户转账500元给房东王先生”返回 503 / MODEL_AUTH_ERROR，无对应 TrueForge Session；换成“从…给…转500元”才进入试点。 | `server/trueforge-skill-adapter.mjs:routeTrueforgeSkill` 原来只匹配收款人在金额之前的语序。增加严格的金额在前语序，保留金额验证与混合任务排除。旧 Harness 的模型配置缺失是已有本地配置问题，此次未改其凭据。 |
| 修改后仍问金额 / Agent 续接解析层 | 支持的语序先得到 50000 分预览；第二次真实 transfer_preview 调用返回 NEEDS_CLARIFICATION、source=parser、slot=amount、“要转多少钱？例如 500 元。” | `server/banking-clarification-parser.mjs:parseClarificationAnswer` 支持“改成400元”，不支持“改成转账400元”。仅对 transfer.create 金额编辑前缀归一化，继续使用原精度/正数校验及 slots/selections 合并。适配器明确拒绝非法金额。 |
| 收款人看起来丢失 / 网页与续接 | 第二次调用与第一次结果的 token 摘要匹配，仍在同一 Session；原网页却删除了预览，刷新又丢掉内存消息和外层 token。 | 未发现有效续接内部丢失实体 ID，不能把它归因于 Core 或模型。`server/banking-orchestrator.mjs` 的 mergeSlots 保留其他槽和候选选择；`src/agent/runtime.mjs:transferRepository` 使用已选候选。本轮保留此契约，修复网页丢卡片和刷新失联。 |
| 卡片/聊天消失 / 网页层 | 第二轮卡片从 1 变 0，消息从应有 5 条变 4 条；刷新后只剩 1 条欢迎消息。 | `src/lib/use-saveflow.ts:startBanking` 每次 filter 掉所有 banking_preview。移除删除，保留历史并禁用旧操作。原来只有 saving-plan 操作 ID 恢复，没有聊天恢复；本轮新增限时的 tab 内恢复。 |
| 缺修改/取消按钮 / 网页层 | 修复前 .banking-preview-card button 数量为 0。 | 原 page.tsx:BankingPreviewCard 仅展示。提取 BankingTransferPreview.tsx，为当前试点预览提供金额/收款人表单、取消、禁用确认；表单阻止默认导航。旧 Harness 的转账展示和原卡片执行链路保持原行为。 |
| “确认转账”错误不清楚 / 适配层 | 首轮扩展复测发现该短语未被本地拒绝规则覆盖，模型未调用工具，返回格式错误，没有执行。 | 扩充精确拒绝规则，直接 403 / PREVIEW_ONLY，不调用模型或消费 token，仍可取消。[中间失败记录](verification/transfer-debug/intermediate-confirm-failure.json) 保留，最终复测通过。 |
| 确认不能执行 / Core 边界 | MCP 与网站使用两个独立 Mock Core，网站没有试点预览的业务状态；MCP 只授权查询/prepare。 | 执行集成尚未完成，不能通过启用按钮解决。按钮保持 disabled；聊天确认拒绝；原 /api/banking 永久拒绝 tfpreview: 编号的 guard 保留。 |

`server/banking-agent.mjs` 已按开关和可信续接分流，本轮无须修改。鉴权、来源、限流、体积限制仍先执行；TrueForge 处理后失败不会再走旧 Harness。

## 真实服务与会话

- TrueForge：http://localhost:8790；原网页/HTTP：http://127.0.0.1:3000；bridge：127.0.0.1:3334/mcp；原 MCP：127.0.0.1:3333/mcp。地址只在服务器端使用。核对本机包：CLI **0.3.1**、SDK **0.2.1**。
- 网页实际使用 `server/trueforge-client.mjs:trialAgentSpec` 创建的 **inline Agent，并非注册的 billtest**。模型为 `test/deepseek-v4-1-flash`，connector 为 saveflow-token-bridge；每个转账 Session 只允许 transfer_preview，所有调用需先校验参数。未修改已有注册 Agent。
- SDK 用 POST /api/v1/sessions 创建、GET /api/v1/sessions/{id} 恢复并复核权限，通过 sessions.createTurnStream 读取 SSE。model.message.toolCalls 是模型提出的调用，tool.response 才是 MCP 业务结果；最终必须 turn.done / status=done，且无 requiredActions。
- tool.approval_required 时先核对工具、connector、参数，再发送 user.tool_approval 继续。因此一个网页请求通常对应两个连续 SDK Turn。保留 SDK delta 合并、结束状态、期限与取消逻辑，不能用模型“已经完成”替代工具结果。
- 最终真实转账测试只有 **1 个 Session、10 个连续 SDK Turn、5 次真实 transfer_preview**。所有 previousTurnId 连续，续接摘要与上次结果对应；usage 显示模型收到了工具定义，model.message 有真实函数调用。见 [完整脱敏事件](verification/transfer-debug/after-events.json)、[已断言的摘要](verification/transfer-debug/trace-checks.json)。没有确认或执行工具调用。

第一次实际工具参数：

```json
{"source_account_ref":"模拟活期账户","payee_ref":"房东王先生","amount":{"amount_minor":50000,"currency":"CNY"}}
```

第二次为 `{continuationToken: <上次结果的 bridge 别名>, message: "改成转账400元"}`。工具返回新的 operationId/previewHash，exactEffects 为 **ACC-CHECKING → payee_003，40000 分**；实体 ID 没有由模型生成。后续金额表单改为 350 元、收款人表单输入“王先生”，resolver 返回真实候选，选择“王强”得到 payee_004，仍保留原账户和 35000 分。

模型最终文字是“已返回结果”，网页金额和收款人来自工具数据。修复前“要转多少钱”是 SaveFlow 固定澄清提示，不是 DeepSeek 总结。

## 调用链与刷新恢复

原网页 → askBankingAgent → POST /api/banking-agent（原传输安全检查） → Skill Adapter → SDK inline Agent / DeepSeek → 参数放行 → MCP bridge → transfer_preview → 原 runBankingConversation → ParsedIntent / Dispatcher / Transfer Skill / resolver → 独立 Mock Core.prepare → tool.response → 可信结果校验 → 原 HTTP envelope → BankingTransferPreview。

网页没有作为可信身份的 TrueForge sessionId。浏览器的随机 HMAC tfm1 token 在服务器关联到私有 Session、MCP token、动作、来源 scope、revision 和有效期。第二轮使用该映射，不从聊天文字猜实体 ID。

新增 sessionStorage 恢复最多 100 条合成消息、256000 字符，记录 30 分钟有效，仅限同一浏览器 tab。只恢复仍有效的 tfm1 token，最长 5 分钟，刷新不延长期限。访问码、授权勾选、真实 TrueForge Session ID、私有 MCP token、旧 Core 的 continuation token 均不保存；旧 Core 执行卡片不会恢复为活动操作。刷新后需重新输入访问码/勾选授权，不自动发请求。过期记录只能作历史。

“重新开始演示”显式清空历史与续接。原 UI 回归脚本的独立场景现在点击该按钮，不再用 reload 清空会话。服务器重启或多实例失联不由浏览器存储解决。

## 本轮修改文件

| 文件 | 职责 |
| --- | --- |
| server/trueforge-skill-adapter.mjs | 严格金额在前语序、非法修改错误、本地拒绝确认转账。 |
| server/banking-clarification-parser.mjs | 识别金额修改，保留原 ParsedIntent 续接合并。 |
| src/lib/use-saveflow.ts | 保留历史、恢复聊天、绑定当前试点预览的编辑/取消。 |
| src/lib/banking-chat-storage.ts（新增） | 有界/限时恢复，去除私有凭据，不恢复执行权。 |
| src/app/BankingTransferPreview.tsx（新增） | 试点修改表单、取消、禁用确认，历史不可操作。 |
| src/app/page.tsx、src/app/modern-bank-overrides.css | 组件接线和样式。 |
| tests/trueforge-skills.test.mjs、tests/trueforge-preview-client.test.cjs | 精确短语、实体保留、非法金额/旧凭据/重启、刷新、按钮安全回归。 |
| scripts/diagnose-transfer-before.mjs（新增） | 本地真实网页故障采集，报告去除凭据。 |
| scripts/inspect-trueforge-transfer.py（新增） | 只读 TrueForge SQLite，保存脱敏参数、结果与连续 Turn 证据。 |
| scripts/verify-transfer-continuation-ui.mjs（新增） | 真实 Chrome/HTTP/TrueForge/DeepSeek/MCP 多轮 UI 回归。 |
| scripts/verify-trueforge-skills-ui.mjs | 独立场景显式重新开始，适配刷新恢复。 |
| 本文、trueforge-multiskill.md、docs/verification/transfer-debug/* | 根因、前后报告、失败记录、事件、截图与测试日志。 |

next-env.d.ts / tsconfig.tsbuildinfo 是 Next/类型检查生成文件，延续原未提交状态。未改 .env.local、Core、种子、迁移、schema 或 Dispatcher 契约。

## 验证结果

- `npm.cmd test`：181 项，**179 通过、0 失败、2 跳过**。跳过两项未配置数据库的 PostgreSQL 集成。[完整日志](verification/transfer-debug/tests.log)。
- `npm.cmd run test:trueforge:skills`：24/24；其中真实 MCP + 模拟 TrueForge transport 的测试明确标为协议测试，不能代替真实模型 E2E。
- `npm.cmd run lint`、`npm.cmd run typecheck`：通过。PowerShell 禁用 npm.ps1，使用现有 npm.cmd，未修改执行策略。
- [真实转账 UI](verification/transfer-debug/after-ui.json)：通过。原样 500 → 400；刷新续接；表单编辑/真实候选消歧；重复请求返回同一操作；历史卡片禁用；聊天确认 403；取消不执行；直接执行 403；取消 token 失效；最终 **15 条消息、4 张历史预览**保留，无浏览器脚本错误。
- 最终复测成功转账模型请求 **1420–2636ms**，低于原 30 秒客户端限制；仅调用 transfer_preview。[截图](verification/transfer-debug/transfer-history.png)。
- [原网页 A 类查询](verification/transfer-debug/read-ui-regression.json)：卡片、候选、未知卡、订阅、产品、账单全部通过。
- [原网页 C 类预览](verification/transfer-debug/card-ui-regression.json)：预算编辑/换卡、0 与上限、取消、冻结、active 卡不允许解冻全部通过。
- 修复前及中间失败均保留，不算作最终通过。未跑长期负载、真实转账执行、OIDC、PostgreSQL、Netlify build/部署。

按 trueforge-multiskill.md 启动现有四项服务，保留 .env.local。复跑：

```powershell
# 本机临时 Playwright；也可指定自己的 index.mjs file URL，无新增生产依赖
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/lzh/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
node scripts/verify-transfer-continuation-ui.mjs
python scripts/inspect-trueforge-transfer.py --since <本次开始的UTC时间> --output .next/transfer-debug-after/trueforge-events.json
```

保留原 10 次/分钟限制，各批次间等待窗口；不放宽限流。脚本只读取现有访问码，不打印或写入报告。本轮为加载 mjs 修复重启了本地 HTTP/MCP/bridge，TrueForge 沿用原服务；旧页面可能需要点一次“重新开始演示”。

## 未解决项和部署前条件

1. **执行仍未开放。** 两个 Core 仍独立。必须另行完成同一 Core/owner、哈希/期限、显式决定、幂等、受控 HTTP 执行与回执核对后才能启用确认。不能用聊天或移除 tfpreview: guard 替代。
2. **会话关联仍为单进程内存。** 浏览器恢复不解决 HTTP/MCP/bridge 重启和多实例切换。部署前需共享 TTL/原子领取、revision、去重结果和 alias 存储。TrueForge Session 自身落盘不代表这些关联持久化。
3. **旧 Harness 真实模型配置缺失。** 窄路由外请求仍可能 MODEL_AUTH_ERROR；开关关闭路径有自动化验证，但本机未成功调用真实旧上游，本轮未改密钥。
4. Deploy Preview 前需可达 HTTPS/鉴权、多用户隔离、共享存储、尾延迟/取消验证和审核。本轮只完成真实预览/续接与网页交互，没有部署或连接真实资金。
