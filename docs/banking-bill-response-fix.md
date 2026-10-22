# 自然语言多月账单响应修复

验收日期：2026-10-22（Asia/Shanghai）。基线为刷新远端后最新 `origin/main`：`b8dc50763f1ce020d79fb1626eed6f9f36995c84`；修复分支为 `fix/banking-bill-response-contract`。

## 根因与复现

在未修改代码上新增 `tests/banking-bill-contract.test.cjs`，固定时钟为 `2026-10-22T04:00:00Z`，使用原始 seed 和合同内的 ParsedIntent 注入 TrueForge 客户端边界。真实 `handleBankingAgent()` 返回 HTTP 200，Repository 收到 `{startDate:"2026-06-01",endDate:"2026-09-30",timezone:"Asia/Shanghai"}`；9 月月度状态为 `unavailable`。把同一真实后端结果交给真实 `askBankingAgent()`，测试失败，错误为 `BANKING_AGENT_RESPONSE_ERROR: Banking Agent 返回格式异常。`。

原因是客户端 `validMonthlyBreakdown` 仅允许 complete/partial/future，而后端合法状态还有 unavailable。原始数据仅覆盖 2026-06、07、08，9 月不能视为实际零消费。修复后同一测试通过。另一个合同差异是前端 period.timezone 硬编码 Asia/Shanghai，后端支持合法 IANA 时区。

## 五层核验

1. `use-saveflow.ts` 直接发送当前 text，只有 history 截取最近 8 条及每条 2000 字符；当前用户输入未被替换或截断。续接凭据来自当前草稿或显式恢复的流程；服务端验证签名，并允许理解边界识别用户换任务。本次原网页实测成功，测试也断言新请求不附加 continuationToken。
2. `trueforge-banking-runtime.mjs` 已把 `understandingContext({now,timezone,financialContext})` 放入 `calendar`。真实运行的模型收到 currentDate=2026-10-22、Asia/Shanghai 及财务覆盖上下文，正确理解用户要求的四句话；没有修改模型提示词或增加上下文字段、句式解析器。
3. `validate-parsed-intent.mjs` 接受合法 period，严格验证日期、时区、最长 366 天及 month/period 互斥；`merge-intent.mjs` 已将 period 视为完整时间槽位。无需修改这两处。
4. `banking-orchestrator.mjs` 将验证后的意图交给 `handleBillSummary()`；Repository 接收到正确过滤器，按交易本地日期包含起止全天。没有伪造交易或改变 Core 的确认、执行和权限边界。
5. 客户端与卡片接受合法 unavailable，展示缺数据。缺数据不进入完整月份均值/趋势；单月或整个期间完全没有可用记录时显示未知金额及说明，避免把占位 0 解释为零消费。

## 修改文件与安全保证

| 文件 | 修改目的 |
| --- | --- |
| `src/lib/bill-response-validation.ts` | 聚合账单校验：允许四种合法状态；验证字段、日期、IANA 时区、范围、金额、分类合计、逐月连续性、总额对账及证据。金额合计使用 BigInt，避免浮点舍入放过错误统计。 |
| `src/lib/banking-agent-client.ts` | 调用账单校验并保留其他业务验证；开发环境提供固定失败原因、阶段、字段路径及 requestId，错误仍关闭处理，不放行失败响应。 |
| `src/lib/calendar.mjs` | 前后端共用时区检查；拒绝带空白或仅数字偏移的值，保留合法 IANA 时区。 |
| `server/banking-agent.mjs` | 增加 X-Request-ID，非 JSON/网关失败也可关联请求；不改变 JSON API 合同。 |
| `src/app/BankingBillCard.tsx` | 单月、短范围和完全无数据时明确显示缺数据；完全缺数据时不展示占位 0 为实际收支。 |
| `src/lib/bill-display.ts` | 已支持四种合法状态及整数分格式，无需修改。 |
| `tests/banking-bill-contract.test.cjs`、`package.json` | 将真实 HTTP→客户端→卡片测试加入默认测试，包括非法响应、金额、分类、状态、日期、时区、证据及原始请求内容。包含单独启用的真实模型全链路测试。 |
| `tests/fixtures/natural-language-cases.mjs` | 增加本次五条自然语言查询，桩测试只证明接线；真实模型结果另行记录。 |
| `scripts/verify-natural-language.mjs`、`docs/verification/natural-language/real-model.json` | 真实模型验证仅保存时间合同与结果状态等证据，不再保存完整模型输出和财务上下文。 |
| `scripts/verify-banking-bill-ui.mjs` | 既有可选浏览器脚本同步缺数据语义，金额极值 fixture 提供一致的分类，遵守新校验。 |

未知状态、非法金额、分类不平、错误统计结构、额外字段、不连续或重复月份、不可信来源和无效证据都被拒绝。诊断仅包含固定标识及安全路径，不含访问码、Key、账户信息、金额或完整模型输出；日志故障不能绕过校验。生产环境默认不输出开发诊断。

## 实际响应与网页

[本地真实 HTTP 响应关键字段](verification/bill-response-contract/local-http-summary.json) 来自原网页同一地址 `http://127.0.0.1:3000/api/banking-agent` 的真实 TrueForge 查询，未修改 seed。该文件为响应摘录，省略分类及实体 ID，将 evidence.entityIds 长度另列为 entityCount；不能把摘录直接当作完整 API 响应。

- 期间：2026-06-01 至 2026-09-30，Asia/Shanghai。
- 支出 2,232,000 分，收入 3,600,000 分，36 笔。
- 6/7/8 月支出分别为 668,000 / 718,000 / 846,000 分，状态 complete。
- 9 月为 unavailable，数值 0 仅为未取得记录的占位；覆盖状态 unverified，明确提示无记录不代表没有支出。

已在用户当前打开的本地原网页手动输入“查看今年六到九月的账单”，看到正确期间、¥22,320.00 支出、¥36,000.00 收入、36 笔及 9 月“缺数据”。截图：[汇总](verification/bill-response-contract/local-summary.png)、[缺数据月份](verification/bill-response-contract/local-missing-month.png)。

## 验证与部署边界

| 命令 | 结果 |
| --- | --- |
| `npm test` | 349 项，338 通过，0 失败，11 跳过：10 项未配置 PostgreSQL，1 项默认关闭的真实模型测试。 |
| `npm run typecheck` | 通过。 |
| `npm run lint` | 通过。 |
| `npm run build` | 通过，生成静态生产构建。 |
| `npm run verify:natural-language` | 使用已配置的真实 TrueForge，31/31 通过；不是模型桩。 |
| `$env:SAVEFLOW_VERIFY_LIVE_BILL='true'; node --env-file=.env.local --test tests/banking-bill-contract.test.cjs` | 8/8 通过，无跳过；最后一项为真实模型→真实 HTTP→真实客户端→实际卡片渲染，使用未修改 seed。 |

真实模型为本机已配置的 `test/deepseek-v4-1-flash`。自然语言 harness 为其他业务场景补充合成边界记录，因此“9 月原始缺数据”的验收使用独立的原始 seed 全链路测试和原网页实测。

本地原网页已通过热更新加载修复。未执行生产发布、合并或覆盖 main。GitHub 当前基线无可读提交部署状态，且没有本次远端部署证据，不能声称远端网页已经包含修复。远端部署环境的实际版本、TrueForge 配置、PostgreSQL 和线上端到端验收仍未验证。可选的旧 Playwright 全套脚本本轮未运行，浏览器实测使用 computer-use。
