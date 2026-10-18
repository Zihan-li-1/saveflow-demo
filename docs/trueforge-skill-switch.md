# TrueForge 跨 Skill 续接隔离修复

2026-10-17，`spike/trueforge-harness`。先复现后修复；保留已有未提交改动，没有提交、PR、部署、修改 main、密钥、Core 或数据库迁移。

## 根因和代码证据

[修复前真实网页报告](verification/skill-switch/before-ui.json)：转账预览成功后，“查看我的卡”的 HTTP 请求错误携带原转账 token，返回 400 / CONTINUATION_ACTION_MISMATCH，历史预览仍在。

1. 网页 `src/lib/use-saveflow.ts:startBanking` 原来把唯一的 bankingContinuation 附加到每条消息；它同时代表“当前聊天焦点”和“具体业务的续接权”。完成卡片查询又会把全局 token 清空，无法返回原转账；刷新也只恢复这一个全局状态。
2. `server/banking-agent.mjs` 看到 tfm1 后正确进入 Skill Adapter。`server/trueforge-skill-adapter.mjs` 先校验签名/scope/有效期/revision，再校验新路由的工具与 token 绑定工具一致；转账 token 配卡片查询必须报错。不能靠删掉此校验修复。
3. `server/banking-orchestrator.mjs:switchesTask` 在独立 MCP 调用中受 expectedAction 约束，不能跨工具重用旧业务 slots。Bridge 的 `state.name !== name` 也防止把 transfer_preview 的私有凭据用于 card_get。两者均未修改。

修复将聊天历史/焦点与每个业务流的续接记录分开。明确的新业务由网页发送**不带旧 token 的新请求**；返回原转账则从对应卡片选择仍有效的那笔业务流，发送原 token。浏览器没有修改、解码或重新签名任何凭据。

## 实现

- `src/lib/trueforge-routing.mjs`：把现有窄路由和策略原样移到无 SDK/密钥依赖的纯模块，服务端保留原导出兼容性。客户端只用于判断任务边界，不能授权工具；后端仍独立读取私有开关和验证请求。明确查询开新任务；混合/含糊输入只提示澄清，不套用转账 token。
- `src/lib/banking-flow-state.ts`：每个业务流保存本地导航 key、动作、服务器原样发出的 token、期限和最新预览编号。key 不是 TrueForge Session ID，也不是身份凭证。新查询完成只结束自己的流，不删除原转账流；修改转账只替换该流的预览版本；取消只删除该流。其他 Skill 不延长转账有效期。最多保存 25 个流。
- `src/lib/use-saveflow.ts`：区分新请求、当前流补参和从卡片明确恢复的请求。金额修改继续带原转账 token，卡片/账单新查询不带；返回修改使用对应流最新 token，不依赖最近查询留下的全局值。保留聊天历史；历史已替换版本禁用。到期清理流并禁用操作。
- `src/app/page.tsx`：按每笔有效转账的最新预览编号启用修改/取消，查询其他 Skill 后仍可从原卡片恢复。BankingTransferPreview 组件及其禁执行逻辑未改。
- `src/lib/banking-chat-storage.ts`：持久化/校验多个限时业务流和当前焦点，兼容此前单 token 历史。仅 tab 内 sessionStorage，原 100 条/256000 字符/30 分钟历史上限保留。只保存原样 tfm1/tfb1 外层 token，续接最长 5 分钟，刷新不延长。访问码、授权勾选、私有 MCP token 和 TrueForge Session ID 不保存；服务器仍是最终权威。
- `server/trueforge-skill-adapter.mjs`：保留原跨动作拒绝逻辑，并补充携带其他 Skill token 查询账单的明确拒绝。正常切换不靠服务器丢弃转账 token，而靠网页发送正确的新请求。

`server/banking-agent.mjs`、`server/banking-orchestrator.mjs`、MCP Bridge、ParsedIntent、Dispatcher、Skill/Core 契约本轮均未修改。每个业务流继续使用独立、只允许对应工具的 TrueForge Session，没有把原 Agent 权限扩大为通用执行 Agent。

## “查询8月账单”的真实发现

原账单入口只支持完整年月或不指定月份，本轮补充 month-only 入口。缺年份时调用账单 Skill 的 `{}`，按真实 MISSING_MONTH 结果澄清完整年月，禁止猜年。

首次扩展联调，DeepSeek 从“8月”推断出 2026-08，现有严格参数校验拒绝了结果，网页返回 TRUEFORGE_FORMAT_ERROR，没有账单卡片。[失败报告](verification/skill-switch/intermediate-bill-failure.json) 和 [实际错误调用](verification/skill-switch/intermediate-bill-events.json) 保留。

针对该事实，`server/trueforge-bill-adapter.mjs` 改为发送与其他 Skill 相同的服务端 JSON：`{userMessage, toolArguments}`；`server/trueforge-client.mjs:billAgentSpec` 明确要求逐字使用 toolArguments，不能从当前日期或 Mock 数据推断年份。原工具名、参数、evidence 和结果月份一致性校验没有放宽。独立 probe 脚本也同步此消息格式。

最终真实事件确认模型调用 `bill_summary({})` → MCP 返回 MISSING_MONTH → 用户补充“2026年8月” → 同一账单 Session 调用 `bill_summary({month:"2026-08"})`，收入 1200000 分、支出 846000 分、12 笔。若模型以后仍产生错误参数，校验仍拒绝，不会用模型文字制造账单。

## 七项真实验收

[完整 UI/HTTP 记录](verification/skill-switch/after-ui.json)、[工具事件](verification/skill-switch/trueforge-events.json)、[已断言的事件摘要](verification/skill-switch/trace-checks.json)、[截图](verification/skill-switch/switch-history.png)。所有记录来自本地真实 Chrome → HTTP → TrueForge → DeepSeek → MCP，非模拟 Agent transport。

| 场景 | 最终结果 |
| --- | --- |
| 转账预览 → 查看我的卡 | 新请求不带转账 token；真实 card_get 返回候选，选择后得到卡片，转账历史保留。 |
| 转账预览 → 查询8月账单 | 新请求不带转账 token；真实 bill_summary 澄清年份，补全后返回真实账单。 |
| 转账预览 → 改成300元 | 使用同一转账 token 和 Session，保留 ACC-CHECKING / payee_003，生成 30000 分新预览。 |
| 转账 → 卡片查询 → 返回修改原转账 | 从仍有效的 300 元卡片修改为 250 元，使用该转账流自己的 token，账户/收款人保留；500 元旧版本仍禁用。 |
| 转账 → 取消 → 新转账 | 原流取消不执行；新转账不带旧凭据，创建独立 Session，返回 20000 分预览。 |
| 卡片查询中强行附加转账 token | HTTP 400 / CONTINUATION_ACTION_MISMATCH，在模型/MCP 调用之前拒绝；该拒绝没有消费合法转账 token，之后仍能取消原转账。 |
| 刷新后跨 Skill 切换 | 消息保留，重新授权后卡片查询不带转账 token；完成后从刷新前的 200 元卡片恢复为 150 元，使用原流原样 token。 |

补充：混合请求“看看我的卡和账单”只显示澄清，未发送 Banking Agent 请求。确认按钮仍禁用，直接 `/api/banking` execute 仍 403。

最终事件共有 **5 个独立受限 Session、11 次真实工具调用**：

| 业务流 | 工具 | 实际调用 |
| --- | --- | --- |
| 原转账 | transfer_preview | 50000 → 30000 → 查询卡片后恢复 25000 分，始终同一 Session |
| 第一轮卡片查询 | card_get | 我的卡 → 真实候选选择，同一 Session |
| 账单 | bill_summary | `{}` → `{month:"2026-08"}`，同一 Session |
| 取消后的新转账 | transfer_preview | 20000 → 刷新及查询卡片后恢复 15000 分，同一 Session |
| 刷新后的卡片查询 | card_get | 我的卡 → 真实候选选择，同一 Session |

各 Session 的 previousTurnId 连续。没有 action.decide/action.execute 工具。实际 SDK Turn 因工具审批可以多于网页请求；最终均 turn.done/status=done，无悬挂审批。事件中的 Session/token 仅保存 SHA256 摘要，访问码/密钥不进入报告。

服务仍是 TrueForge http://localhost:8790（CLI 0.3.1，SDK 0.2.1），模型 test/deepseek-v4-1-flash；inline Agent 并非 billtest。多 Skill 走 saveflow-token-bridge → 本地 MCP，账单沿用 sv-trial connector。未对外开放服务。

## 测试与文件清单

- `npm.cmd test`：**185 项，183 通过、0 失败、2 跳过**；未配置测试数据库的两项 PostgreSQL 集成跳过。[完整日志](verification/skill-switch/tests.log)。
- lint、typecheck、git diff --check：通过。
- 新增七场景真实 UI 回归：通过。成功 Skill 请求 1354–2130ms，低于原 30 秒客户端期限。保留原 10 次/分钟限流，脚本在两批之间等待实际窗口，没有修改限流。
- [上一轮完整转账回归](verification/skill-switch/original-transfer-regression.json) 本轮重跑通过：500→400、刷新、表单、候选、重复请求、取消、聊天确认拒绝、直接执行拒绝、历史保留。
- 未进行 PostgreSQL、长期负载、Netlify build/Deploy Preview 或资金执行。首次缺年份模型调用失败如上保留，不当作成功；最终七场景均通过。

本轮修改：`src/lib/use-saveflow.ts`、`src/lib/banking-chat-storage.ts`、`src/app/page.tsx`、`server/trueforge-skill-adapter.mjs`、`server/trueforge-bill-adapter.mjs`、`server/trueforge-client.mjs`；新增纯路由模块 `src/lib/trueforge-routing.mjs` 和多业务流状态模块 `src/lib/banking-flow-state.ts`。

测试修改：`tests/trueforge-skills.test.mjs`、`tests/trueforge-preview-client.test.cjs`、`tests/trueforge-bill.test.mjs`。新增 `scripts/verify-skill-switch-ui.mjs`、`scripts/diagnose-skill-switch-before.mjs`；扩展 `scripts/inspect-trueforge-transfer.py` 支持多个只读工具事件，更新 `scripts/verify-trueforge-bill.mjs` 的消息格式。本文和 verification/skill-switch 为交付证据；next-env/tsbuildinfo 延续生成文件状态。

复跑（保留已有服务端配置，四项本地服务运行）：

```powershell
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/lzh/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
node scripts/verify-skill-switch-ui.mjs
python scripts/inspect-trueforge-transfer.py --since <本轮UTC开始时间> --tools transfer_preview,card_get,bill_summary --output .next/skill-switch-after/trueforge-events.json
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
```

## 保留的限制

服务端 tfm1 状态、Bridge alias/revision/去重仍是单进程内存；浏览器恢复不解决服务器重启、多实例或真实用户身份持久化。两个 Core 仍独立，确认/执行未开放。任何真实资金执行仍需独立受控 Core 链路、同一 owner、预览哈希/期限、明确确认、幂等及回执核对；本轮没有弱化这些要求。HTTP 为加载 mjs 更新重启，旧页面可点一次“重新开始演示”。
