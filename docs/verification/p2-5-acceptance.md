# P2-5 集成验收（2026-10-26，Asia/Shanghai）

结论：本轮发现并修复两处验收缺陷；下述本地单进程范围内未发现遗留阻断或安全缺陷。没有提交、推送、合并或部署；保留进入本轮前已有的未提交改动。

## 1. 实际数据流

浏览器显示消息与任务引用 → 已鉴权的 `/api/banking-agent` → `openBankingConversation` 校验会话、任务、revision、最新绑定续接凭据并取得会话互斥 → 原理解模型/ParsedIntent 合同校验 → Resolver 重新核验实体 → 原 Skill → 模拟 Banking Core `prepare()` → Store 只读查询 Core 后绑定正式预览引用 → 签发绑定会话和 taskId 的最新续接凭据 → 前端依据服务端任务摘要关联选项、表单与预览编辑。

任务 ID 由服务端生成；模型不能提交 taskId、已核验实体 ID、Core 预览或执行状态。Store 的预览是引用，不能授予确认或执行权限。聊天中的“确认”返回 `CONFIRMATION_REQUIRED`；决定和执行继续走页面独立确认与 Core 校验。

## 2. 任务切换与恢复

通过：发起转账、补付款账户 → 查询账单 → 查询娱乐虚拟卡 → 输入“继续刚才的转账” → 恢复原转账 taskId → 修改 500 元为 600 元并获得不同 operationId。新任务不继承旧任务的草稿、选项、续接凭据或预览。隔离合同测试还验证了收款人和付款账户修改，各生成新的正式预览。

发现并修复：原来直接输入恢复指令会交给模型重新理解，实际返回 clarify。现对有限的明确恢复措辞复用既有 resume 协议，仅使用最新服务端摘要中的唯一有效转账和本标签页原凭据；多项转账、过期任务或缺失凭据时提示用户从任务面板选择，不让模型猜测 taskId。按钮恢复仍通过。

## 3. 重复请求与并发

发现并修复：原来成功请求的安全重试被旧 revision 拒绝，不能取回原结果。现在每会话至多缓存一个已接受且成功的业务响应；只有完整请求规范化指纹一致、结果 revision 仍为当前版本、会话/任务未过期时才可取回原响应、原续接凭据和原预览。

通过：同一选项重复提交与同一金额编辑请求安全重试均不增加 `Core.prepare()`；两个相同请求并发只生成一份正式预览。处理中的请求明确返回 `CONVERSATION_BUSY`，不计成功；完成后按原请求重试可取得原结果。旧 revision 的不同请求、改变选项、后续转换后的旧请求和跨会话/任务替换仍拒绝。修改金额、收款人或付款账户按正常合同产生不同正式预览。

复用预览前按原编号读取该任务的 Core 引用。confirmed/executing/unknown 时返回原操作和 `query_status`，不复用可操作的旧预览，也不再次 prepare/execute。过期凭据不能借缓存恢复。没有会话令牌的首次请求无法跨请求去重；此限制不授予执行权限。

## 4. 前端任务关联与安全边界

通过：旧任务选项不能用于另一任务；恢复后重新生成选项；预览编辑绑定原 taskId 和最新续接凭据。跨会话令牌、同会话内不同任务凭据及模型注入字段均有拒绝回归。过期任务无法恢复。

合同测试中的 executing/unknown 使用可信 Core 读取替身；其余正式预览、确认和资金变化来自实际模拟 Core。浏览器隔离验收通过网络层在 Core 实际提交后丢弃执行响应，再刷新并查询原编号，确认 execute 次数和交易条数均未增加。

## 5. 实际验证结果

| 验证 | 通过 | 失败 | 跳过 | 类型/说明 |
| --- | ---: | ---: | ---: | --- |
| `npm test` | 453 | 0 | 12 | 共 465 项；离线合同、Mock、实际模拟 Core、React 与本地 HTTP 回归，不是 453 项真实模型测试 |
| `npm run typecheck` | 通过 | 0 | 0 | TypeScript 检查 |
| `npm run lint` | 通过 | 0 | 0 | ESLint 检查 |
| `npm run build` | 通过 | 0 | 0 | Next 静态产物构建；不表示静态文件可承载内存 Store |
| `npm run verify:natural-language` | 31 | 0 | 0 | 实际配置的 TrueForge 模型；合成测试数据、实际模拟 Core |
| 显式启用两个 `LIVE TrueForge` 专项 | 2 | 0 | 0 | 真实模型错误恢复、真实 HTTP/客户端账单合同 |
| `npm run verify:conversation-ui` | 9 | 0 | 0 | 真实 Chrome + 本地 HTTP + 注入理解结果 + 模拟 Core |
| `node scripts/verify-conversation-live-ui.mjs` | 5 | 0 | 0 | 真实 Chrome + 完整 `dev:qwen` + 真实配置模型 + 内存模拟 Core |

默认 `npm test` 的 12 项跳过是：10 项未配置 `BANKING_TEST_DATABASE_URL` 的 PostgreSQL 测试，以及 2 项默认未启用的真实模型专项。后两项另以 `SAVEFLOW_VERIFY_LIVE_RECOVERY=true`、`SAVEFLOW_VERIFY_LIVE_BILL=true` 和 `node --env-file=.env.local --test --test-name-pattern='LIVE TrueForge' tests/agent-recovery.test.cjs tests/banking-bill-contract.test.cjs` 实际执行通过，不修改默认运行的跳过统计，也不重复计入其通过数。

自然语言 runner 同时修正了验收日期和未配置时的统计：未配置模型时明确 skipped。新增独立子进程回归在无配置的临时目录实际得到 0 通过、0 失败、31 跳过；不把它当成 31 项模型成功。

## 6. 浏览器与刷新

实际启动：`PORT=3105 npm run dev:qwen`，本地地址 `http://127.0.0.1:3105`。真实 Chrome 在同一会话连续经过转账、账单、卡片三个 Skill，直接输入恢复指令后修改金额，再刷新页面。两个浏览器脚本均为 0 pageErrors。

刷新恢复通过：只读显示历史 → 访问码和授权勾选清空 → 重新授权 → sync 核验同一服务端会话 → 旧预览仍不可确认 → 明确恢复取得新正式预览。真实模型浏览器验收没有调用决定或执行；资金执行故障恢复只在隔离模拟环境验证。

证据：[`conversation-ui/checks.json`](conversation-ui/checks.json)、[`conversation-live-ui/checks.json`](conversation-live-ui/checks.json)、[`natural-language/real-model.json`](natural-language/real-model.json)。浏览器脚本使用外部 `PLAYWRIGHT_MODULE`，Playwright 未加入应用依赖；本机使用 runtime 已有的 Playwright 与 Chrome。截图已清空访问码。

## 7. 内存限制与未解决事项

刷新恢复仅适用于同一标签页仍连接同一服务端进程，且会话与任务未过期。sessionStorage 不是权威状态，也不恢复确认权。服务端进程重启会丢失 ConversationState、互斥和重试缓存；当前内存 Core 也不保证操作/回执跨进程恢复。已有真实 HTTP 跨进程拒绝用例通过，不能宣称进程重启后可恢复操作。

当前没有遗留阻断问题。未验证范围：PostgreSQL 持久化、多实例、多设备、生产部署和任意自由措辞的历史任务检索；本轮没有引入这些能力。无有效会话标识的首次请求丢包不具备跨请求预览去重。上述限制不属于已通过范围。
