> 历史 MCP 试点/专项记录：文中的句式路由、SAVEFLOW_TRUEFORGE_* 开关、tfm1/tfb1 续接和部署结果不适用于当前 `/api/banking-agent`。独立适配器及执行桥按原合同保留；当前统一入口与限制以 [Banking Agent API](Banking-Agent-API.md) 为准。

# TrueForge 账单最小适配层交付报告

## 本地访问码排障（2026-10-14）

只输出状态的检查发现：本次诊断终端没有继承 `SAVEFLOW_ACCESS_CODE`，Next 开发模式也未发现可加载的本地环境文件。与此同时，已运行的 `127.0.0.1:3000` 对缺少访问码 Header 的请求返回 401 `UNAUTHORIZED`；按照当时入口代码，这证明该进程已配置有效的访问码和续接密钥。运行中的进程与当前终端配置不同。页面错误发生在原 HTTP 认证入口，尚未进入 TrueForge；提交值与后端期待值不匹配，不能据此断定后端未加载访问码。未读取进程的敏感启动参数，也未核对用户实际输入，故具体旧值来源尚未确认。

客户端会发送 `X-Saveflow-Access`；本地桥接保留该 Header。`dev:qwen` 在 `app.prepare()` 后接收请求，HTTP 入口每次读取运行环境，没有发现访问码捕获过早的问题。Next 开发环境加载优先级为启动进程已有环境变量、`.env.development.local`、`.env.local`、`.env.development`、`.env`；Netlify 控制台变量不会自动同步至本机。

正确启动：先在原服务终端按 Ctrl+C 停止旧进程；打开新的 PowerShell，进入 `D:\金科国际\saveflow-demo`。在被 Git 忽略的 `.env.local` 中私下配置自己的访问码、续接密钥及既有 TrueForge 设置，然后执行 `npm.cmd run dev:qwen`。不要把真实值贴入聊天或提交 Git。检查启动日志中的 `banking_auth_config`：`accessCode` 和 `continuationSecret` 均应为 `configured`，账单试点需要 `trueforgeBillEnabled: true`。浏览器访问该进程日志显示的地址，输入与本地配置一致的访问码。若终端已设置同名变量，它会覆盖文件；请在启动前检查配置来源。修改环境文件或启动变量后重启后端。

本轮仅增加安全诊断和提示：认证失败日志只含固定分类、事件名称和请求 ID；不记录访问码、密钥、Header、长度或摘要。缺 Header 与不匹配对外均为同一种 401；未认证用户不能探测续接密钥配置。访问码未配置时对外为通用 503，具体缺失/无效原因仅记服务端日志。页面认证错误显示“访问验证失败，请检查演示访问码后重试。”，服务配置错误显示“服务暂时不可用，请联系演示维护者。”，不再展示认证内部错误码。

验证：`npm.cmd run test:banking:auth` 通过 6 项；完整 `npm.cmd test` 共 152 项，150 通过、2 项 PostgreSQL 环境条件跳过；lint、typecheck 和 diff 检查通过。测试使用注入的虚构凭据，覆盖缺失/错误/正确访问码、同长度错误值、配置失败的对外隐藏、Next 文件加载和继承优先级、Netlify 包装入口、旧 Harness、TrueForge 路由及浏览器 Header/错误映射。没有更改真实配置、Core、资金执行逻辑或运行中的用户服务。真实访问码在重启后的 UI 验证、真实 TrueForge 新一轮端到端联调及线上部署验证尚未进行。

验证日期：2026-10-14，分支：`spike/trueforge-harness`。

**结果：本地完整联调成功。原网页通过真实 TrueForge 调用 MCP `bill_summary`，原 BankingBillCard 显示正确账单。** 没有部署、提交 Git 或创建 PR；保留了开始工作时已有的未提交改动。

## 文件职责

| 文件 | 本轮变化 |
| --- | --- |
| `server/trueforge-client.mjs` | 官方 SDK 接入、专用 inline Agent、Session 创建/恢复及权限复核、SSE delta 合并、Turn 完成检查、取消 |
| `server/trueforge-bill-adapter.mjs` | 窄范围路由、用户年月校验、工具调用/结果关联校验、原响应结构转换、签名澄清凭据、重复补参处理、统一安全错误 |
| `server/banking-agent.mjs` | 传输安全检查之后读取服务端开关；试点命中调用适配层，其余调用现有编排器 |
| `scripts/verify-trueforge-bill.mjs` | 独立真实服务验证，可在同一 Session 发送多条消息 |
| `scripts/verify-trueforge-ui.mjs` | Playwright 操作原 UI，检查原卡片及 30 秒请求约束；可验证预期故障 |
| `tests/trueforge-bill.test.mjs` | 15 项自动化测试，覆盖用户列出的 10 类验收条件及安全边界 |
| `tests/fixtures/trueforge-bill-turn.json` | 真实 0.3.1 工具事件采样，供数据转换回放测试；不作为真实连接的替代 |
| `package.json` / `package-lock.json` | 精确锁定官方 SDK 0.2.1、验证命令、默认测试加入试点测试；保留此前 MCP 依赖变化 |
| `.env.example` | 增加服务端试点配置，开关默认关闭 |
| 本文及 `docs/verification/trueforge-*` | 可复核的交付说明、浏览器报告、截图和超时证据 |

没有修改原 UI、`askBankingAgent()`、两套账单实现、Core prepare/decide/execute、Mock 种子、数据库迁移或原 Harness。也没有修改用户指定的已保存 Agent `billtest`。

## 实际服务和版本

- 本机缓存安装：`@truefoundry/trueforge` **0.3.1**；运行中的 `/api/v1/openapi.json` 也报告 **0.3.1**。
- 与本机服务配套：`@truefoundry/trueforge-sdk` **0.2.1**，已精确加入项目依赖。本轮 npm 注册表最新版分别为 0.178.2 / 0.178.0；没有升级本地服务。
- 实际 API 基址：`http://localhost:8790`。本机 TrueForge 的 `localhost` 监听在 IPv6 `::1`；`127.0.0.1:8790` 并不可达，不能盲目替换。
- MCP：`http://127.0.0.1:3333/mcp`，TrueForge connector 名称 `sv-trial`，MCP 服务版本 0.2.0。
- 模型：沿用现有 `test/deepseek-v4-1-flash` provider 配置；模型鉴权保留在 TrueForge，不复制到 SaveFlow。
- 本地 standalone 无登录；SDK 不传 token。登录部署使用服务端 `TRUEFORGE_TOKEN` bearer token，需要自行管理刷新。
- 刚开始时两个服务均未运行；用既有缓存版本启动，没有重建数据库或更改现有 provider/connector。
- 初次调用受到 TrueForge 出站 URL 策略阻止。仅为本地 MCP 启动设置 `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`，未关闭全局 URL 检查。

依据：[官方 SDK Quickstart](https://github.com/truefoundry/trueforge/blob/main/docs/api/quickstart.mdx)、[官方 Session/Turn/Event 文档](https://github.com/truefoundry/trueforge/blob/main/docs/api/use-agent.mdx)，并以本机版本的 OpenAPI、SDK 类型和真实事件为最终兼容性依据。

## Session、事件和工具来源

SDK 创建指定 Agent 的基本方式是 `sessions.create({agent:{name:'已保存名称'}})` 或 `sessions.create({agent:{spec}})`。开始检查时现有 TrueForge UI 会话使用 inline Agent，注册表为空；用户后续提供名称 `billtest` 后，重新查询发现它已保存，模型为 `alibaba/qwen3-7-flash`，但 manifest 没有 mcpServers，因此不能直接调用 bill_summary。本轮没有修改该已保存 Agent；本适配层每次创建独立、权限固定的账单 inline Agent，模型和 connector 从服务端配置读取，不能由浏览器指定。报告中的真实端到端结果来自该专用 inline Agent，不声称由 billtest 完成。

仅启用 `enableTools:['bill_summary']`，并 preload。关闭 sandbox、子 Agent、问答暂停工具、生成 UI、web search、上下文压缩和大结果卸载；不附加 skills。该版本始终带有内置时间工具，本轮事件中未调用它，适配器也不接受额外工具调用。没有确认或执行工具。

`sessions.get(sessionId)` 恢复并复核非共享 Session 的 Agent 配置。发送消息使用 `sessions.createTurnStream(sessionId,{input:[{type:'user.message',content:message}]})`。第二条消息在同一 Session 创建新的 Turn。

流处理保留以 event id 为键的索引，使用官方 `isEventDelta` / `mergeEventDelta` 合并工具参数片段。必须收到 `turn.created`，随后完整结束流并收到 `turn.done`，且 `state.status==='done'`、没有 requiredActions。`error`、`cancelled`、流提前关闭、需要审批/认证/工具响应等情况均返回错误。

本版本成功 MCP 调用把 `structuredContent` 序列化成 `tool.response.content` 的 JSON 字符串，失败的 MCP `isError` 则包成 `{error:[{type:'text',text:'工具错误 JSON'}]}`。适配层只解析这个已关联的工具响应，不解析 `model.message.content`、reasoning 或 `turn.done.state.output`。

校验要求：恰好一条调用、一条结果，调用的 toolInfo.type 为 mcp、connector 匹配、工具名和 function.name 都是 bill_summary、toolCallId 和 threadId 对应、参数只含请求的 month；月份、整数分金额、交易数、分类和 evidence 一致。来源限定为本轮的 `synthetic_demo_only`，交易 ID 数量与 transactionCount 相符且无重复。错误、额外调用、错误月份或非法结构均不能生成账单卡片。

另有官方替代 API：`createTurn` 后 `getTurn` 轮询，再 `listTurnEvents` 获取合并后的事件；已有 Turn 可通过 `subscribeTurn` 续读。替代方式仍须取得关联的工具事件，仅 `state.output` 的文字不满足验收。

## 原网页的实际链路

```text
原 SaveFlow 网页 / askBankingAgent (30s)
  → POST /api/banking-agent
  → 方法 / 限流 / content-type / 来源 / 访问码 / 续接密钥 / 16KB 限制
  → SAVEFLOW_TRUEFORGE_BILL_ENABLED === 'true' + 窄范围账单路由
  → TrueForge 账单 inline Agent 的 Session / Turn / SSE
  → sv-trial connector → HTTP MCP → bill_summary
  → MCP 自己的独立 Mock Repository → 原 handleBillSummary (.mjs)
  → 关联工具结果 → 严格业务校验 → 原 {code,message,requestId,data}
  → askBankingAgent 原字段校验 → 原 BankingBillCard
```

首条允许如“查账单”“查询 2026 年 8 月账单”“查看2026-08的账单”。其他卡片/转账/订阅请求、混合任务、模糊查询和相对月份继续走原 Harness；不实现复杂意图分类。

开关关闭后原查询和业务链路保留。已经进入 TrueForge 的请求失败时返回明确错误，不回调原 Harness。试点签发的 token 在开关关闭后明确失效，不误交给旧续接机制。

## 澄清、隔离和重复请求

缺月份必须收到 bill_summary 的真实 `MISSING_MONTH`，才返回 `NEEDS_CLARIFICATION`、原 UI 允许的空 `choices`、固定年月问题和试点 token。补参接受明确的“2026 年 8 月”或“2026-08”，不猜测年份或月份。

Token 为 `tfb1.<256-bit随机nonce>.<HMAC-SHA256>`，MAC 有试点专用用途标识。Session ID 完全保留在服务端 Map。记录有效期 5 分钟，并绑定服务端访问码与既有客户端来源键的摘要；每次初始查询独立 Session。签名、scope、有效期和服务端记录均需匹配。没有把可篡改的 Session ID 交给浏览器当凭据。

同一 token 的相同补参，包括并发请求，共用一次 Turn 的 Promise 和响应。成功或失败均不自动重跑；同 token 不同回答返回 `CONTINUATION_CONSUMED`。首次独立查询没有 idempotency key：重复初始请求允许分别做只读查询，不产生业务操作。非法年月不创建 Session、不消费已有补参凭据。

试点 token 的账单续接仅支持补年月。补参期间明确切换到卡片或转账时，复用现有任务检测规则，验证并撤销未消费的账单 token，再作为新请求交回原 Harness，不发送给账单 Agent。混合/含糊的补参文字返回安全错误；没有试点 token 的其他业务消息仍走旧 Harness。

最多保留 500 个 token 状态，按访问清理过期记录。Map 是单进程本地状态，服务重启会使 token 失效；即使相同签名密钥，其他进程也不能恢复 Map。它不满足 Netlify 多实例、冷启动或持久化要求。部署前需共享持久化/TTL 存储，并对补参领取、正在运行 Turn 和重复结果缓存做原子处理。

## 超时和安全错误

每次适配层请求总预算 25 秒，包括创建/恢复 Session 和读取 SSE；客户端中止信号也向下传递。SDK `maxRetries:0`。失败/中止后调用官方 `sessions.cancel`，独立取消预算最多 1 秒；浏览器 30 秒预算仍有余量。取消请求若因服务不可达失败，不能保证远端立即停止，但此 Agent 仅可查询账单。

浏览器收到 TRUEFORGE_TIMEOUT / TRUEFORGE_UNAVAILABLE / TRUEFORGE_TURN_FAILED / BILL_SUMMARY_FAILED / TRUEFORGE_FORMAT_ERROR 等固定中文消息，不收到上游 URL、鉴权、Session ID、原始错误、模型文字或敏感事件。

## 执行结果

| 验证 | 结果 |
| --- | --- |
| 全量 `npm test` | 146 项：144 通过、0 失败、2 PostgreSQL 环境条件跳过 |
| 新增 `npm run test:trueforge:bill` | 15 项全部通过，独立单元/事件回放/HTTP 契约验证 |
| `npm run lint` / `npm run typecheck` | 均通过 |
| `git diff --check` | 通过；Next 启动生成的 next-env.d.ts 改动已恢复，原先修改过的 tsconfig.tsbuildinfo 保留 |
| 首次独立真实 SDK 查询 | 收到实际 MCP 结构化结果，Turn done，约 20 秒 |
| 收窄输出和关闭模型 thinking 后 | 真实查询约 2.3 秒 |
| 原网页查询 2026-08 | 卡片：收入 1200000 分，支出 846000 分，12 笔；最终代码重启后 HTTP 1950ms |
| 原网页缺月份 → 补参 | 真实工具错误澄清 + 原 Session 第二 Turn；HTTP 1266ms / 1705ms |
| 原网页查询 2026-01 | 原卡片显示真实 0 收入、0 支出、0 笔；HTTP 1624ms |
| 原网页非法月份 | 400 INVALID_MONTH，显示错误且无账单卡片；46ms |
| 真实 MCP Repository 故障注入 | 原 MCP 服务入口临时注入 getTransactions 异常，真实 TrueForge 工具返回错误；原 UI 502 BILL_SUMMARY_FAILED，无账单卡片；1827ms；已恢复正常 MCP |
| TrueForge 实际停服务 | 原 UI 502 TRUEFORGE_UNAVAILABLE，无账单卡片；68ms；已恢复服务 |
| 原 UI / 服务 Session 事件审计 | 只有 bill_summary，无确认/执行调用；完成请求的 Turn 均为 done |
| 25 秒停滞 SSE | 真实 SDK + 本地 HTTP 故障代理，25017ms 返回 504 TRUEFORGE_TIMEOUT，cancel 1 次；见超时 JSON 证据 |
| 非账单路由、开关关闭、旧 token、重复/非法结果、传输安全 | 自动化测试通过；旧业务模型协议使用注入测试，不声称调用了真实 Qwen |

证据：`docs/verification/trueforge-ui-report.json`、`trueforge-bill-ui.png`、`trueforge-zero-ui.png`、`trueforge-BILL_SUMMARY_FAILED-ui-report.json`、`trueforge-TRUEFORGE_UNAVAILABLE-ui-report.json`、`trueforge-timeout-report.json`。完整测试日志位于 `.next/trueforge-all-tests.log`。真实探针记录在 `.next/trueforge-probe.json`，含服务端 Session 标识，仅供本地开发，不应公开托管。

未执行：PostgreSQL 两项集成测试、真实旧 Qwen 模型链路、OIDC 部署验证、Netlify build/Deploy Preview、持续负载与长期延迟测试。本轮没有新增永久的故障配置。

## 本地重现

先启动与已配置数据库匹配的 TrueForge 0.3.1（不升级）：

```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx.cmd @truefoundry/trueforge@0.3.1 --port 8790
```

另一个终端启动既有 MCP：

```powershell
npm.cmd run mcp:trial
```

原 UI/HTTP 终端设置服务端配置，再启动：

```powershell
$env:SAVEFLOW_TRUEFORGE_BILL_ENABLED = 'true'
$env:TRUEFORGE_BASE_URL = 'http://localhost:8790'
$env:TRUEFORGE_MODEL = 'test/deepseek-v4-1-flash'
$env:TRUEFORGE_MCP_SERVER = 'sv-trial'
$env:SAVEFLOW_ACCESS_CODE = '<你自己的至少16字符访问码>'
$env:CONTINUATION_TOKEN_SECRET = '<你自己的随机服务端密钥>'
npm.cmd run dev:qwen
```

访问 `http://127.0.0.1:3000`，在原页面输入同一演示访问码并勾选现有授权。配置也可放在被 Git 忽略的 `.env.local`，但独立 SDK 脚本需另行加载环境。

在带有 TRUEFORGE 配置的终端独立运行：

```powershell
npm.cmd run verify:trueforge:bill
npm.cmd run verify:trueforge:bill -- '查账单' '2026 年 8 月' '查询 2026 年 1 月账单'
```

Playwright 是可选本地验证工具，不属于生产依赖。本轮用临时 npm 包 Playwright 1.64.1 和本机 Chrome 执行。安装到独立工具目录后，可设置 `PLAYWRIGHT_MODULE` 为该包 `index.mjs` 的 file URL，再设置相同 `SAVEFLOW_ACCESS_CODE`，执行 `npm run verify:trueforge:ui`。它不拦截或伪造 HTTP 响应。

## 状态边界和 Deploy Preview 前置条件

MCP 始终使用自己的独立 Mock Core/Repository。这里只取账单查询数据，不能把其预览操作记录作为网站 Core 的正式状态。没有解决两个 Core 的状态共享问题，也没有把试点数据升级为正式银行数据。

Deploy Preview 前须至少满足：

1. TrueForge/MCP 有 Netlify 后端可达的部署地址，使用 TLS、鉴权和明确出站允许范围，避免暴露本地 standalone 无鉴权实例。API/模型密钥只能存在服务端。
2. 部署共享会话存储和原子补参/重复结果机制；确定用户身份隔离、token 密钥轮换和 TrueForge Session 清理策略。当前访问码+来源键仅适用于本地固定 Mock 演示，不等同于多用户身份验证。
3. 保持 Mock 只读边界，若要正式数据须另行审批/设计 Repository 和身份映射；执行权限仍不能附给账单 Agent。
4. 验证托管 Function 的执行时限、SSE/出站网络、令牌刷新、30 秒客户端约束及真实负载延迟；固定服务/SDK 兼容版本。
5. 原 UI 的授权文字当前仍写“阿里云 Qwen”，而试点沿用的是 DeepSeek provider。本轮按要求保留 UI；公开 Preview 前应确认授权文字与实际数据接收方一致。
6. 分别验证开关开/关和旧业务部署依赖，配置独立 Preview 环境，完成人工审核。本轮未执行任何部署。
