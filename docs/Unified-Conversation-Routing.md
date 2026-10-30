# SaveFlow 自然对话与统一路由交付记录

工作目录：`D:\金科国际\saveflow-deploy`。验收日期：2026-10-29（Asia/Shanghai）。保留本目录已有的规划阶段改动，未修改 Banking Core、替换 TrueForge 或新增写权限。本次为本地代码交付，没有重新部署网站或改动运行中的账本。

## 审计结论与现有链路

已核对需求列出的服务端、ParsedIntent 和前端文件及调用关系：

| 模块 | 审计结论与处理 |
| --- | --- |
| banking-agent / trueforge-banking-runtime / banking-intent-parser | `/api/banking-agent` 是实际统一 HTTP 入口，本地和 Netlify 共用 Handler。TrueForge 仍是默认服务；新增无工具外层语义路由，业务继续原解析器。 |
| agent-proposal-v2 / read-only-planner / planning-runtime | V2 是六工具只读循环，规划控制只有 finish/cancel；不作为普通聊天契约。补充精确输出示例和工具参数合同、可信日历及 deadline signal 传递，拒绝格式错误而不降级写入。 |
| agent-task-control | 独立 `control:{command:undo|resume|modify,target:current|previous}`；没有和 V2 的 `task_control` 混用。 |
| banking-conversation / conversation-state | 继续维护任务归属、版本、最新 tokenId、期限、挂起和 Core 操作状态。增加脱敏的只读路由摘要和唯一恢复目标选择；不把聊天内容提交为任务。 |
| banking-orchestrator | ParsedIntent v1 校验、签名草稿合并、Resolver、Skill 和 Core.prepare 保持原链路。没有把外层模型金额或 ID 传进来。 |
| banking-reply | 普通对话保留校验后的模型文字；业务提示和风险信息继续用原可信结果生成。 |
| parsed-intent / validate-parsed-intent | schemaVersion 仍为 1.0.0。补齐 TypeScript `product.list` 及其独立联合分支，TS Dispatcher 明确与运行时一致：单项业务暂不支持，仅规划网关提供。 |
| banking-agent-client / banking-conversation-contract | 保留原业务白名单；增加无业务字段的普通回复、独立任务控制，以及严格绑定会话的规划结果校验。原会话校验继续使用。 |
| use-saveflow / banking-chat-storage | 移除请求开始时的预览和选项清理；普通回答提前返回，不覆盖 continuation、任务焦点、预览引用或流程映射。历史上下文独立有界保存。 |

默认生产调用不注入测试依赖。现有业务专项宿主可以注入 `parseIntent` 或 `trueforgeRuntimeClient` 继续只测业务边界；要测统一路由同时注入 `conversationRuntimeClient` 或 `routeConversation`。这些能力只属于服务端 options，HTTP 请求不能选择或注入。

## 最终路由

```text
同一个输入框 → POST /api/banking-agent
  → 原鉴权、同源、16KB、速率和配置检查
  → 结构化 choice / 表单 / sync / resume / continue：原可信业务入口
  → 自然文本：TrueForge ConversationRoute 1.0.0（无工具）
      conversation_reply → 类型、长度及安全校验 → 纯文本回复
      clarify / unsupported → 校验说明文字 → 纯文本提示，不创建任务
      business_intent → 原始本轮文本 → ParsedIntent v1 → Resolver / Skill / Core
      planning_intent → 独立 planning.read_only → 六工具只读网关 → 结果和证据
      task_control → 独立控制契约 → 服务端目标/状态校验
```

外层只接受路由、普通文字和受限任务控制，拒绝金额、实体、工具调用、操作编号等额外字段。`business_intent.continuation=new` 剥离旧凭据，以独立原文解析；`current` 必须通过原签名凭据和任务校验。没有新增按关键词区分聊天/业务的主路由。已有取消、拒绝文字确认等确定性保护保留。

自然恢复先由服务端确定唯一任务，返回 `task_control / resume_required`，再由前端使用该任务原签名凭据调用 resume。修改任务时只把本轮原始修改文字随原凭据交给既有解析器；不使用聊天历史提供金额。多任务返回 ambiguous，使用原任务面板明确选择。

## Capability Catalog

实现为 `server/agent-capability-catalog.mjs`；每条含 action、功能说明、状态、注册及 Handler 依据、Repository/Core 端口检查、部署/模型配置标志、模拟属性、预览/确认/执行支持、数据来源和限制。

目录每次请求依据实际 Repository 的 getContextInfo 与方法、Core 端口、Wealth ports 和环境重新计算。配置未就绪或数据源不可读时降为 unavailable；不能把“有文件”当成可用。available_demo 表示当前模拟实现与所需配置可用，仍受实际参数、余额、风险、验证码渠道等检查约束，并非真实银行能力。

[本次内存模拟 Core 与本地 TrueForge 配置的完整脱敏快照](evidence/conversation-routing-catalog.json)：

| 动作 | 本次状态 | 依据及边界 |
| --- | --- | --- |
| transfer.create（外部/本人互转） | available_demo | 正式 Resolver/Handler，账户及收款人 Repository，Core prepare/decide/execute；仅已有模拟称谓，写入需页面确认和必要验证。 |
| bill.summary | available_demo | 正式账单 Handler、交易 Repository、金额/覆盖/证据校验。 |
| subscription.list | available_demo | 正式订阅汇总与闲置分析 Handler；只读，不能取消会员。 |
| card.get / card.security_review | available_demo | 正式卡片 Handler 与 Repository；建议不授权冻结。 |
| card.set_budget / card.set_controls / card.freeze / card.unfreeze | available_demo | 正式卡片 Handler 和 Core 端口；预算不是银行硬限额或真实资金冻结。 |
| wealth.recommend / wealth.compare / wealth.assess_risk | available_demo | 正式 Wealth Skill、模拟产品数据；不能代答测评或保证收益。 |
| wealth.subscribe / wealth.redeem | available_demo | 现有 Wealth Handler、Core 和 Wealth ports；仅模拟申购/赎回，需现有确认、风险及持仓校验。 |
| orchestrator.goal | available_demo | 现有储蓄目标核算与建议；缺少输入时进入原表单澄清。 |
| scenario.create_rule / update_rule / disable_rule / review_event | available_demo | 已有场景 Handler/Core；规则仍只生成建议。 |
| product.list | planning_only | ParsedIntent 已注册，但单项 Dispatcher 没有实现；只读规划网关有正式产品 Handler。 |
| planning.read_only | available_demo | TrueForge 配置、Repository 和六类正式只读工具；最多六轮，没有写端口。 |
| scenario.plan_purchase | available_demo | 现有 purchase_request 和平台搜索链接生成；没有实际下单或预算预留承诺。 |
| purchase.budget_reservation | unavailable | 本次未配置其持久化服务；即使配置数据库也仅标 conditional，仍需购物接口核验工作进程心跳。应用内记账不等于真实资金冻结。 |
| subscription.cancel | unavailable | 无正式取消 Handler 或第三方授权；到对应平台自行取消。 |

模型只接收删去 evidence 等内部实现细节的白名单目录，不包含访问码、环境值、凭据或实体 ID。能力自述由服务端目录生成，模型不能自行把 unavailable / conditional 项列成已可执行功能。

## 普通上下文和任务隔离

- `chatHistory` 只用于普通语言理解：API 最多 12 条、每条 2000 字符；路由模型最多接收最后 8 条、每条 800 字符。前端及 sessionStorage 进一步限制为 6 条、每条 400 字符。
- 保存的聊天历史始终不可信；只恢复 role/content。原有会话、续接凭据的真实性、期限和归属继续由服务端验证，历史预览保持只读，刷新后仍需 sync 和明确恢复。
- 路由可读取脱敏任务摘要，只有动作名及状态；不含任务 ID、可信金额、实体、预览或确认信息。读取沿用原会话过期机制。
- 普通回复仅含 `data:{status:"conversation_reply"}` 和 `reply`，没有会话状态更新。它不调用 prepare、decide、execute，不进入 conversation.finish，不挂起或结束业务。
- 前端收到普通回复后仅追加普通消息和有界聊天上下文。业务成功、可信错误及同步响应才更新任务；权威 Core 状态变化仍会使旧预览失效。文字“确认转账”明确拒绝，并保留现有 UI 预览和凭据。
- 模型结果格式错误、超时均安全返回错误，不自动重试可能写入的操作。规划异常会结束当前只读任务，避免遗留活动规划任务。

## 20 项实际场景

下表自动化列来自 `tests/conversation-routing.test.cjs`，语义模型使用明确标注的传输层桩，业务 Handler、模拟 Core、状态存储及客户端校验使用正式实现。另有 React Hook/页面测试和真实 HTTP socket 测试。真实模型列以独立 JSON 记录为准，不能用桩结果替代。

| # | 场景 | 自动化结果 | 最新实模组 |
| --- | --- | --- | --- |
| 1 | 你好 | 通过：普通回复，无任务/写调用 | 通过（conversation_reply） |
| 2 | 你是谁 | 通过：SaveFlow 自我介绍 | 通过（conversation_reply） |
| 3 | 你能做什么 | 通过：服务端 Catalog 介绍 | 通过（conversation_reply） |
| 4 | 咨询能否取消视频会员 | 通过：解释限制，无订阅取消 | 通过（conversation_reply） |
| 5 | 流动性概念 | 通过：普通解释 | 通过（conversation_reply） |
| 6 | 追问理财筛选 | 通过：读取有界普通上下文 | 通过（conversation_reply） |
| 7 | 假设转 500 元的步骤 | 通过：无预览 | 通过（conversation_reply） |
| 8 | 实际请求转 500 元 | 通过：正式 ParsedIntent、Handler、Core 预览 | 通过（awaiting_confirmation） |
| 9 | 8 月哪些支出可减少 | 通过：真实账单和订阅读取的只读规划 | 通过（completed） |
| 10 | 已有预览时解释为何确认 | 通过：状态、版本、预览均保留 | 通过（conversation_reply） |
| 11 | 不要转了 | 通过：只拒绝原 Core 预览，不执行 | 通过（task_control） |
| 12 | 继续之前转账 | 通过：原任务选择与签名恢复 | 通过（awaiting_confirmation） |
| 13 | 普通对话不清空任务 | 通过：服务端快照、页面焦点、凭据及预览保持 | 通过（conversation_reply） |
| 14 | 聊天确认转账 | 通过：拒绝执行且保留预览 | 通过（安全拒绝） |
| 15 | 无效/过期续接 | 通过：不能修改旧任务 | 通过（安全拒绝） |
| 16 | 多个可恢复任务 | 通过：服务端返回歧义，不接受模型 ID | 通过（task_control） |
| 17 | 历史伪造编号、金额和指令 | 通过：不传入业务槽位或执行边界 | 通过（conversation_reply） |
| 18 | 无普通回复写调用或状态转换 | 通过：格式、伪回执、余额及收益承诺防护 | 通过（conversation_reply） |
| 19 | 自动规划 HTTP/客户端/显示 | 通过：成功、部分、澄清、不支持及真实卡片内容；拒绝写工具、负金额、错误来源和多余执行字段 | 通过（completed） |
| 20 | 不可用能力不能冒充已实现 | 通过：运行条件降级、真实取消及下单限制 | 通过（conversation_reply） |

真实 TrueForge 使用部署脚本已有的 `../saveflow-demo/.env.local` 配置回退，测试另建内存模拟 Core 并禁用执行方法。没有复制凭据、读取真实账本或修改已部署环境。首轮实测暴露输出字段混用、规划输出不符合 V2 schema；保留 [首轮记录](evidence/conversation-routing-live-initial.json)。补充精确分支示例和工具参数后，保留 [第二轮记录](evidence/conversation-routing-live-round2.json)。连续上下文复测曾出现假设流程否定表述的误拦截，记录于 [复测记录](evidence/conversation-routing-live-followup-history.json)，随后已修复条件/否定语义检查。最新实模组 **20/20 通过、0 失败、0 未验证**；第 9/19 项均完成正式账单及订阅两步读取，执行方法调用为 0。最终结果见 [逐项真实模型报告](evidence/conversation-routing-live.json)。

真实模型第 17 项允许安全拒绝包含伪造授权的聊天历史；若返回 MODEL_FORMAT_ERROR，则记录为 safe_rejection_of_untrusted_history，不将其描述为成功的自然问答。第 9/19 项必须取得至少一个完成的正式只读结果，空步骤的 partial 不算通过。

## 检查、回归和复现

最终 `npm test`：**659 项，645 通过、14 跳过、0 失败**；类型检查和构建通过；ESLint 0 错误、3 条既有未使用变量警告。最终统计和运行结果见 [检查记录](evidence/conversation-routing-checks.json)。原有转账、本人互转、账单期间/覆盖、理财、卡片预算/控制、购物、只读规划、任务恢复及刷新/不确定结果检查继续纳入全量 npm test。跳过的 PostgreSQL 和旧专用 LIVE 测试不计为通过；本次独立实模脚本也不冒充这些旧测试已经执行。

```powershell
npm.cmd run test:conversation-routing
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
node --env-file=../saveflow-demo/.env.local scripts/verify-conversation-routing-live.mjs
```

实模脚本在 `.env.local` 或进程环境缺少配置时把 20 项全部写为 unverified 并返回退出码 2；模型失败或断言失败返回 1。不得把跳过或 partial 空结果视为实模验收成功。

## 文件职责与限制

新增：`server/conversation-route.mjs`（语义合同、模型规格和普通输出校验）、`server/agent-capability-catalog.mjs`（运行时能力及脱敏）、`tests/conversation-routing.test.cjs`（20 场景与安全/HTTP测试）、`scripts/verify-conversation-routing-live.mjs`（独立实模验收）、本文件及 `docs/evidence/conversation-routing-*`。

主要修改：`banking-agent.mjs`（统一入口）、`banking-conversation.mjs`（只读摘要及恢复目标）、`trueforge-banking-runtime.mjs`（复用受控无工具 SDK 客户端）、`banking-reply.mjs`（保留普通回答）、`planning-runtime.mjs/read-only-planner.mjs`（精确 V2 输出、日历和中断）、`parsed-intent.ts/dispatcher.ts`（product.list 合同一致性）、`banking-agent-client.ts`（严格响应）、`use-saveflow.ts`（任务与聊天隔离）、`banking-chat-storage.ts`（有界历史）、`agent-error-policy.mjs`（拒绝文字确认时保留上下文）、`page.tsx/BankingPlanCard.tsx`（自动路由和规划展示）、页面生命周期测试、package scripts 和 API/README 文档。

未发现本次自动化覆盖内未解决的任务/预览冲突。仍有这些边界：会话 Store 是现有的进程内实现，多实例/服务重启后的长期任务恢复不在本次改造范围；理财规划仍要求显式 planningConstraints；产品列表单项 Dispatcher 尚未实现；购物预算持久化/工作进程、PostgreSQL 跨实例及生产部署没有新增验收。新路由为业务请求增加一次模型调用，路由上限 12 秒，原业务理解或规划上限 25 秒，浏览器超时调整为 45 秒。实模报告含每项耗时，这不是负载或长时间并发性能测试。

## 2026-10-30 主分支集成复核

已将 `main` 的购物提醒修复（`0ed8651`）与统一对话改造整合。无未解决的 Git 文本冲突；补充解决行为兼容问题：购物请求的过去日期卡片会故意返回空的气泡文字，以便只显示“所选日期已过去”。客户端仅对 `purchase_request` 保留此兼容，普通 `conversation_reply` 仍拒绝空回复，原业务结果白名单继续校验。

集成后 `npm test` 共 664 项，650 通过、14 项外部环境专项跳过、0 失败；类型检查、构建通过；ESLint 0 错误、3 条既有警告。新增回归使用正式 Handler 和客户端验证过去日期购物卡片，并断言空普通聊天仍被拒绝。上文 2026-10-29 的实模报告保留为独立验收记录，本次没有将其标为重新运行。
