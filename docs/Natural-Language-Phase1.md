# 自然语言金额与日期接入：第一阶段

工作目录 `saveflow-demo`，分支 `feat/unified-trueforge-banking-runtime`。读取 README、CLAUDE.md 及现行 API/代码；工作目录、上级目录和仓库内未找到 AGENTS.md（CLAUDE.md 仅引用该缺失文件）。第一阶段保留了开始时已有的四个文件修改，后续按用户要求提交为 `d53a16f` 并合并最新主分支；未发布或部署。最新合并验收见 [合并记录](Merge-Natural-Language-Phase1.md)，下表保留第一阶段提交前的验收结果。

## 原因与现行流程

- 前端 `use-saveflow.ts` 的 Banking 入口已统一发往 `/api/banking-agent`，未发现句式分流拦截。旧句式辅助文件仍供独立试点/历史测试使用，不用于当前 Banking 理解。
- `server/trueforge-banking-runtime.mjs` 已把原始输入交给无工具 Agent，但 `validateIntentGrounding` 的金额、年月原文匹配否决中文/混合金额与相对日期；本轮删除该限制，保留实体引用/候选的服务端验证。
- TrueForge 首轮没有当前时钟，Qwen Banking 解析器会用 `resolveBillPeriod` 覆盖模型结果。旧 Qwen/MCP 补参则依赖固定解析。本轮统一首轮、补充和修改的模型理解，模型失败不作后端回退。
- 已有账单 ParsedIntent 支持范围，无需另造意图体系。Repository 查询仅有月份，PostgreSQL 还按 UTC 月份过滤。本轮贯通范围与时区查询，保留查询范围和数据覆盖提示。
- 目标接口缺结构化金额/截止日期，独立储蓄入口按 UTC 截日且只保留月数。本轮增加必要字段、真实日期校验，并传至只读目标结果/既有确认保存参数。

当前流程：原始输入及近期对话 → 当前配置的 TrueForge（默认）或 Qwen 理解器，携带服务端当前日历、财务日期和签名草稿 → ParsedIntent 数值/日期/权限校验 → 现有 Resolver/Skill → Repository 查询或 Core 正式预览。模型每轮理解一次；结构化按钮直接核对选项，不调用模型。确认和执行仍走原机制。

新增 `server/understanding-context.mjs`、`src/lib/calendar.mjs`；理解/编排文件为 `server/banking-agent.mjs`、`banking-intent-parser.mjs`、`trueforge-banking-runtime.mjs`、`banking-orchestrator.mjs`、`qwen.mjs`、`mcp/saveflow-trial.mjs`。契约、两个账单 Handler、内存/PostgreSQL Repository、客户端和续接令牌同步调整；账单卡片仅补覆盖提示/缺数据标签，未改版。

接口细节见 [API 合同](Banking-Agent-API.md#金额日历和目标参数第一阶段)。时间支持 1900–2099 年，账单最长 366 个日历日；起止本地日期均含全天。用户时区由宿主注入，默认 Asia/Shanghai；HTTP 请求不能更改时钟。

## 验证

自动测试将时钟固定为 2026-10-22，Asia/Shanghai，并另测跨年、其他时区和日界线。模型桩测试只证明接线与校验，不作为真实语义证据。真实模型测试使用当前已配置的 TrueForge 模型与合成财务数据，经过真实 `handleBankingAgent`、参数校验、Repository 和 Core 预览；记录原文、模型输入/输出、真实查询过滤参数及 Core prepare 参数，不只检查回复文字。

可复现命令：

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:natural-language
```

PostgreSQL 测试使用已有本地测试数据库容器中新建的随机临时数据库，应用现有三份迁移后，独立容器运行 `tests/postgres-persistence.test.mjs`；结束删除该临时数据库与测试容器，未修改运行中的网页/MCP 服务。

真实扩展测试曾发现“模糊储蓄目标省略金额并追问”被旧 goal 契约拒绝的问题，已增加目标 `amount/deadline` 的显式澄清支持，并加入续接回归。结果与日志见本目录的 [验证证据](verification/natural-language/)。

最终结果：

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 293 通过，0 失败；9 项 PostgreSQL 测试因宿主未设连接而跳过 | [完整日志](verification/natural-language/tests.log) |
| 独立 PostgreSQL 集成 | 9/9 通过，无跳过；含 SQL 月份、区间、时区边界及既有持久化回归 | [数据库日志](verification/natural-language/postgres.log) |
| TypeScript / ESLint / 构建 | 全部通过 | [类型](verification/natural-language/typecheck.log)、[Lint](verification/natural-language/lint.log)、[构建](verification/natural-language/build.log) |
| 真实 TrueForge 模型 | 26/26 场景通过，包含 30 次真实理解调用 | [逐场景实际参数](verification/natural-language/real-model.json)、[运行日志](verification/natural-language/real-model.log) |

真实模型为当前配置的 `test/deepseek-v4-1-flash`，经本地 TrueForge 服务调用；未替换成模型桩。覆盖所有用户验收样例，并包含大写金额、混合小数单位、自然改述、跨年、上海/纽约日界线、模糊目标的追问续接、文本候选选择和多动作澄清。金额最终核对 Core 预览中的分值；日期最终核对 Repository 实际收到的过滤器；目标核对业务结果中的金额与截止日。

## 限制

仍为合成财务数据，原数据仅覆盖部分历史月份；全年/截至今日可正确查询，但不能将缺数据区间解释为无消费。返回覆盖未保证完整的明确提示。

默认配置的真实 TrueForge 服务已测试；未配置独立 DashScope 凭据，因此 `legacy-qwen` 和独立 `/api/agent` 只验证传输桩、校验与保存接线，未作真实 Qwen 语义验收。未重新做浏览器手动点击或部署验收；页面组件由既有渲染回归及构建检查覆盖。语义测试通过只代表本次语料及服务配置，不保证所有自然语言表达均正确；所有写操作仍需现有预览、确认和验证。
