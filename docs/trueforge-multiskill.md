# TrueForge 多 Skill 接入交付记录

后续多轮转账和刷新恢复修复见 [排查报告](trueforge-transfer-debug.md)。网页刷新现在恢复限时历史；独立演示请显式点击“重新开始演示”。确认执行仍未开放。

跨 Skill 切换与返回修改原转账的后续修复、七场景真实验收见 [跨 Skill 报告](trueforge-skill-switch.md)。

零余额账户的余额提示和失败后续接恢复见 [余额不足恢复报告](trueforge-balance-recovery.md)。

分支 spike/trueforge-harness。初轮验证于 2026-10-14，中断后于 2026-10-17 继续完成。本轮开始时的未提交文件已保存本地快照于 `.next/trueforge-multiskill-before`，没有改写 `.env.local`，未提交 Git、创建 PR 或部署。

## 阶段 A：已通过

真实 TrueForge 0.3.1 / SDK 0.2.1 / sv-trial MCP / 原 UI：卡片查询、卡片候选续接、不存在卡片澄清、订阅、理财产品和账单回归全部通过。7 个 HTTP 请求为 1.47–3.78 秒。候选续接两次 Turn 使用相同 Session；安全事件证据仅包含哈希 Session 标识和工具名，没有凭据或模型文本。只有 card_get、subscription_list、product_list 和原 bill_summary 被调用。

新增阶段 A 自动化 6 项通过；既有全量 155 项通过、2 项 PostgreSQL 跳过；lint/typecheck 通过。协议测试使用真实 MCP 和模拟 TrueForge 事件，明确不视为 Agent 端到端测试。真实浏览器报告、桌面/窄屏截图和事件证据见 `docs/verification/trueforge-multi-A/`。

| 工具 | 初次参数 | MCP 原结果 | HTTP/UI 映射 |
| --- | --- | --- | --- |
| card_get | 可选 card_ref，保留用户称谓 | data.kind=query、data.card、data.context、evidence；未知/模糊名称返回候选及 MCP token | status=card_result，复用 BankingCardResult；澄清复用 BankingClarificationCard |
| subscription_list | 空对象 | data 数组：id/name/monthlyFeeFen/status/lastUsedDate/isPotentiallyUnused/mandateId；context、evidence | status=subscription_result，data.subscriptions 原值；BankingReadCard 订阅布局 |
| product_list | 空对象 | data 数组：id/name/riskLevel/expectedYield（bps）/liquidity/minimumAmountFen/durationDays/currency/isSynthetic；context、evidence | status=product_result，data.products 原值；BankingReadCard 产品布局，收益率仅作示例 |

试点默认关闭：阶段 A 使用服务端 `SAVEFLOW_TRUEFORGE_READ_ENABLED=true`；账单原开关不变。窄范围入口匹配明确查询，混合或不支持请求继续原 Harness。每个 Session 只授权当前一个工具，浏览器不能指定工具或内部动作。

`trueforge-client.mjs` 复用 SDK/Session/SSE 并扩展固定权限配置；`trueforge-tool-result.mjs` 共用调用/connector/toolCallId/threadId/参数关联、MCP 错误包装解析和 deadline；账单已复用关联校验，保留原业务数据和显示。

其他 Skill 共用 `trueforge-skill-adapter.mjs`，浏览器收到 tfm1 随机 nonce + HMAC 凭据；真实 MCP continuationToken 留在服务端，绑定工具、Session、用户范围、候选和 5 分钟 TTL。重复同补参共享一个 Turn；不同补参拒绝重复消费。该 Map 仅适用于本地单进程。

## 阶段 B：2026-10-17 已通过

新增 transfer_preview → 原 Core prepare → 原 BankingPreviewCard。原页面真实完成缺账户、重名收款人选择、500 元预览及修改为 600 元；确认返回 PREVIEW_ONLY，取消结束会话，直接向网站执行接口提交试点编号返回 403；6000 元转账由 Core 返回 INSUFFICIENT_BALANCE，没有成功卡片。原页面正常请求 1.43–2.31 秒；证据见 `docs/verification/trueforge-multi-B/`。A/B 协议与安全专项 12 项通过，既有全量回归 155 通过、2 PostgreSQL 跳过，lint/typecheck 通过。

初始请求只解析明确的“从某账户给某人转金额”或“给某人转金额”；金额使用安全整数分/CNY。用户未提供账户时不猜选。补参和改口复用原 MCP 编排器；在等待另一个槽位时改金额，会在同一 TrueForge Session 重新提交仅包含用户已提供/选择的称谓草稿，重新得到合法澄清凭据。没有提取模型文字中的金额或实体 ID。

预览的公开编号是 `tfpreview:` 加真实 MCP/Core operationId，原编号/哈希均来自可信工具数据。网站 `/api/banking` 在进入 dispatcher 前永久拒绝该命名空间，包括 decide、execute、status，且不依赖功能开关、内存 Map 或按钮状态；Core 契约不变。旧网站编号与执行链路保留。

### 长凭据与重复调用的处理

真实测试曾捕获模型把 935 字符 MCP 凭据改错一字符，严格校验已拒绝；也捕获一次重复只读工具请求。两者均没有被作为成功结果交付。为消除长凭据复制负担并在调用前阻止重复 prepare，增加：

- `server/mcp/trueforge-token-bridge.mjs`：仅监听 127.0.0.1:3334，保留原工具名/schema、只代理原 MCP。长 opaque 凭据换成 128-bit 随机短句柄；还原后才调用原 Skill，绑定工具、TTL、重复消费。业务数据原样透传。没有修改原 Skill 参数字段/类型或业务规则。
- `saveflow-token-bridge` 是新增本地 connector；原 sv-trial 和 billtest 配置未改。`TRUEFORGE_SKILL_MCP_SERVER` 可选择此代理，账单仍用原 sv-trial。代理与外层会话 Map 均是本地临时状态。
- SDK 将当前唯一工具设为 requireApprovalForTools=['@all']。这是 SDK 的查询/prepare 放行机制，不是 Core action.decide。服务端先检查本次确定的工具、connector 和精确参数，最多放行一次。模型再请求调用时发送 SDK deny，不再次到达 MCP；最多有限轮完成并检查最终 Turn done。没有开启任何金融确认或执行工具。

2026-10-17 使用该机制重新跑过完整阶段 A，全部通过，报告见 `docs/verification/trueforge-multi-A-final/`；之后才通过 B 并进入 C。

最终收紧为低随机性提示，并对“尚未执行”的错误参数候选允许一次有界 SDK deny 后修正；任何已经放行过的调用都不能再次放行。最多 3 个 SDK Turn，仍共用同一 25 秒请求期限。拒绝事件不会冒充 MCP 业务结果。参数始终精确相等，不自动改写工具字段。此机制与业务动作 action.decide/action.execute 无关。

## 阶段 C：已通过

card_budget_preview、card_freeze_preview、card_unfreeze_preview 都通过原 BankingCardPreview 展示，带“仅供预览 · 尚未执行”。预算 1000 元、改成 2000 元、换卡、取消、0 元和 100000 元上限，以及冻结预览、未冻结卡片的解冻错误均已真实联调。原 UI 不显示试点执行/查询另一套 Core 的按钮，回调还有独立拦截；后端命名空间拦截始终生效。旧卡片正式预览的控件与原执行链路保持兼容。

原种子中两张卡都是 active，因此正常解冻使用 `scripts/serve-frozen-trial-mcp.mjs` 创建独立内存冻结夹具，datasetId 明确附加 frozen-test。原 seed 文件没有改动，也没有先执行冻结。真实 UI 完成缺卡澄清、选择娱乐虚拟卡、frozen→active 预览；随后查询仍是 frozen、预算 80000 分、版本 0，冻结已冻结卡返回 INVALID_STATE。报告和截图单列 `docs/verification/trueforge-multi-C-frozen/`；验证后已恢复原 MCP。

prepare() 会按原 Core 契约创建预览操作记录并推进卡片 previewGeneration；没有改变余额、交易记录、卡片预算、冻结状态或金融版本。取消仅结束适配层会话，不声称调用了 Core 的拒绝决定；原预览记录由其有效期约束。

## 最终调用与字段映射

| 工具 | 参数（额外字段均拒绝） | 可信结果/展示 |
| --- | --- | --- |
| bill_summary | month | 原 bill_result → 原 BankingBillCard；本轮只共用事件关联校验，不改统计/账单 UI |
| card_get | card_ref；续接用 MCP token + choice 或 message | 原 data.card/context/evidence → BankingCardResult |
| subscription_list | {} | 原 data 数组包装到 data.subscriptions → BankingReadCard；每月分金额、状态、最近使用和闲置标记 |
| product_list | {} | 原 data 数组包装到 data.products → BankingReadCard；风险、bps 示例年化率、最低分金额、流动性、期限 |
| transfer_preview | source_account_ref/payee_ref/amount；续接 token + choice 或 message | 原 operationId/previewHash/exactEffects/risk/expiresAt → BankingPreviewCard，显示账户/收款人/金额/风险提示/有效期/未执行 |
| card_budget_preview | card_ref、amount；续接同上 | 原 Core card_change.before/after/budget/version/generation/evidence → BankingCardPreview |
| card_freeze_preview | card_ref；续接同上 | 原 Core active→frozen 预览 → BankingCardPreview，不冻结 |
| card_unfreeze_preview | card_ref；续接同上 | 原 Core frozen→active 预览 → BankingCardPreview，不解冻；active 原种子返回可信状态错误 |

amount 保留 `{amount_minor:安全整数分,currency:'CNY'}`。预算范围保留 0–10000000 分，转账大于零，其他限制交给原 Skill/Core。所有金融值、哈希、风险和业务编号只取关联的 MCP 数据，不解析模型自然语言。前端新增字段都是兼容的标记/列表结果，没有改变原请求接口。

原网页 → POST /api/banking-agent（原鉴权、来源、16KB、限流）→ 按服务端开关和窄范围语句选择固定工具 → 同一 TrueForge Session 内 SDK 参数门控/SSE → 本地 token bridge → 原 saveflow-trial MCP → 原 Skill/Repository/Core.prepare → 业务校验 → 原响应 envelope → 既有/新增只读卡片。账单仍直连原 sv-trial connector。非试点、模糊/混合初始请求或关闭开关时保留旧 Harness；已经开始的试点失败不调用旧 Harness。

## 文件职责

| 文件 | 本轮职责 |
| --- | --- |
| server/trueforge-client.mjs | 复用 Session/Turn/SSE，固定每会话单工具，参数放行和重复拒绝，安全审计 |
| server/trueforge-tool-result.mjs | 通用事件关联、MCP 错误包装、evidence 和 25 秒期限/取消 |
| server/trueforge-bill-adapter.mjs | 仅复用通用事件解析，保留原账单逻辑和 token 行为 |
| server/trueforge-skill-adapter.mjs | 七个新 Skill 的固定路由、各自业务字段校验、会话草稿/候选/版本/去重/取消及响应映射 |
| server/mcp/trueforge-token-bridge.mjs | 本地凭据短句柄代理；原 MCP、Skill 及 Core 文件不改 |
| server/banking-agent.mjs | 现有传输校验后分流新适配层；保留已有鉴权修正和旧 Harness |
| server/banking.mjs、src/lib/trial-preview.mjs | 保留 Core 契约，永久隔离 tfpreview 操作编号；共用前端防误调用判定 |
| src/lib/banking-agent-client.ts | 接受订阅/产品/会话取消及预览标记，保留原账单/卡片校验和鉴权处理 |
| src/lib/use-saveflow.ts | 新只读结果、试点预览续接、旧预览标识、可恢复输入错误和执行回调拦截 |
| src/app/BankingReadCards.tsx、banking-trial-cards.css | 订阅和产品只读卡片，桌面/窄屏展示、Mock 来源和收益示例标注 |
| src/app/BankingCardCards.tsx、page.tsx | 复用预览组件，显示未执行/风险警告/有效期，禁止试点按钮；授权文字不再误称固定 Qwen 提供方 |
| scripts/configure-trueforge-bridge.mjs | 通过官方 SDK 配置新增本地 connector，不改 sv-trial/billtest |
| scripts/verify-trueforge-skills-ui.mjs | 分阶段实际 Chrome + 原 UI + TrueForge + MCP 联调及截图 |
| scripts/verify-trueforge-skills-timeout.mjs | 实际 SDK/native HTTP 停滞故障注入；明确不作为模型/MCP E2E 成功 |
| scripts/serve-frozen-trial-mcp.mjs | 独立冻结内存夹具，不改原 seed，不调用执行 |
| tests/trueforge-skills.test.mjs、trueforge-preview-client.test.cjs | 20 项协议/安全/事件回放/真实组件与 TS 客户端专项 |
| package.json、.env.example | 默认测试纳入专项、验证/代理命令、分阶段服务端开关；未新增 npm 依赖 |

已有未提交的账单组件、账单样式/展示辅助、鉴权日志和其他成员修改保留。next-env.d.ts 是 Next 生成文件，仅统一换行并保留当前类型引用；tsconfig.tsbuildinfo 保留其生成状态。原两套账单实现、Banking Core 和数据库迁移均未修改。

## 会话和安全边界

tfm1 外层凭据绑定随机 nonce/HMAC、用户范围（访问码与现有来源键摘要）、当前工具、私有 Session、候选和 5 分钟 TTL。真实 MCP 凭据存在本地 bridge；浏览器不能指定 Session ID、工具或内部动作，不能提交真实 MCP token。跨工具/跨范围/伪造/过期/不属于本轮的候选均拒绝。每次有效续接推进会话 revision，旧预览/旧澄清 token 不再成为最新上下文；并发或重复同回答共用一次调用结果。已经执行的调用不自动重放；第一次独立初始查询没有持久化幂等键，重复初始请求是不同的只读/prepare 会话。

Map 和 bridge 都是单进程临时状态，重启会使旧 token 失效；不是 Netlify 多实例方案。预览过期不显示成功卡片。SDK/网络请求无自动重试；25 秒统一期限包括 Session、SDK 多轮和事件读取，取消预算最多 1 秒。

SDK 内置时间工具在该版本无法从 spec 完全移除；本轮实际事件只有各已授权金融工具。MCP 不存在 action.decide/action.execute，试点 Agent 不提供它们。网站原 Core 与 MCP Core 仍独立；没有把 MCP 的操作记录当作网站状态。

## 测试、证据与未覆盖事项

- 最终 npm test：177 项，175 通过，0 失败，2 项 PostgreSQL 按环境条件跳过；lint/typecheck 通过。专项 20 项包含真实 MCP + 模拟 TrueForge 协议集成、纯单元、SDK 事件回放、原组件渲染和真实 TS 客户端校验，均没有冒充真实 Agent 联调。
- 真实浏览器：A、B、C 和独立冻结夹具均通过，均使用真实 TrueForge 模型、MCP 和原 UI，没有拦截/伪造响应。原账单八月收入 1200000 分、支出 846000 分、12 笔保持兼容；订阅 2 条、产品 3 条来自原 Mock Repository。
- 实际停 TrueForge 后，卡片查询在 60ms 返回 502 TRUEFORGE_UNAVAILABLE，页面没有成功卡片；服务已恢复。见 trueforge-multi-F-unavailable/report.json。
- 实际 SDK/native HTTP 停滞 SSE 在 25025ms 返回 504 TRUEFORGE_TIMEOUT，cancel 请求 1 次，无工具被执行；它是故障注入验证，**不是**模型/MCP 端到端调用。见 trueforge-multi-C/timeout.json。
- 伪造/过期/跨工具凭据、错误工具/connector/参数/金额/evidence、禁止工具、网络故障、中断、非法输入、重复调用、Core 余额与金融卡片状态、执行端点隔离均有自动化覆盖。实际模型参数错误曾被拒绝，最终已增加未执行候选的有界修正；不承诺模型永远不会产生格式错误，无法安全完成时仍返回错误。
- 正常请求均在原浏览器 30 秒期限内完成。没有运行长期压力/尾延迟、OIDC、共享多实例存储、真实旧 Qwen 上游、PostgreSQL 两项测试或 Netlify build/Deploy Preview；未连接真实金融交易。

证据目录：`docs/verification/trueforge-multi-A*`、`trueforge-multi-B`、`trueforge-multi-C`、`trueforge-multi-C-frozen`、`trueforge-multi-F-unavailable`。报告/截图展示合成结果；事件日志只有工具名、哈希 Session 标识和状态，不含密钥、凭据、原始模型消息。完整默认测试日志随 C 证据保存。

## 本地启动和回退

保持既有 `.env.local` 的访问码、续接密钥及模型配置，不把 URL/密钥放入 NEXT_PUBLIC。分别运行：

```powershell
# 终端 1：既有版本，保持 localhost，不对公网开放
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx.cmd @truefoundry/trueforge@0.3.1 --port 8790

# 终端 2：原独立 Mock MCP
npm.cmd run mcp:trial

# 终端 3：本地凭据代理
npm.cmd run mcp:bridge

# 一次性配置新增 connector（通过官方 SDK，读取 .env.local）
npm.cmd run configure:trueforge:bridge

# 终端 4：原 UI/HTTP，服务端开关独立控制
$env:SAVEFLOW_TRUEFORGE_BILL_ENABLED = 'true'
$env:SAVEFLOW_TRUEFORGE_READ_ENABLED = 'true'
$env:SAVEFLOW_TRUEFORGE_TRANSFER_ENABLED = 'true'
$env:SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED = 'true'
$env:TRUEFORGE_SKILL_MCP_SERVER = 'saveflow-token-bridge'
npm.cmd run dev:qwen
```

访问 http://127.0.0.1:3000，使用 `.env.local` 已有演示访问码。可输入“查询订阅”“查询理财产品”“给王先生转500元”“设置娱乐虚拟卡预算1000元”“冻结娱乐虚拟卡”。原种子 active 卡的解冻应返回状态错误。

关闭对应开关并重启 UI/HTTP 即回到原 Harness，新适配层不会接收该类初始请求。原网页仍只有同一个 POST /api/banking-agent 接口。试点 token 关闭后安全失效；试点编号即使开关关闭也不能通过网站 Core 执行。

浏览器验证需独立安装 Playwright 或用 PLAYWRIGHT_MODULE 指定其 index.mjs file URL（本轮用临时 npm Playwright 1.64.1 和本机 Chrome，没有增加生产依赖）。执行 `npm run verify:trueforge:skills:ui -- A`、B、C；每阶段后保留 10 次/分钟原限流，必要时等窗口结束再跑下一批。C-frozen 必须明确启动隔离夹具，结束后恢复原 MCP，不可把该夹具当原数据状态。

## Deploy Preview 前仍需完成

1. 将 TrueForge、MCP/凭据代理放到 Netlify 后端可达、有 TLS 和鉴权的环境；不能把本机 standalone/无鉴权 MCP 暴露到公网。
2. 把外层会话、bridge alias、revision、去重结果及并发领取变成共享 TTL/原子存储；确定多用户身份映射、密钥轮换和 TrueForge Session 清理。现有访问码+来源键只适合固定 Mock 演示。
3. 在托管 Function 中验证执行时限、出站/SSE/取消、token 更新、负载与 30 秒客户端约束；固定服务/SDK 兼容版本并保留开关回退。
4. 继续保持两个 Core 的只读/预览隔离。若以后要执行，必须另行设计同一 Core/owner 与可验证授权交接，不能移除当前编号隔离就直接上线。
5. 复核公开页面的模型数据披露、部署配置和原业务回归，完成代码审核后才安排独立 Deploy Preview。本轮没有部署、合并或自动提交。
