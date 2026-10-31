# 储蓄建议迁移交付记录

后续定点修复已将精确历史统计移至服务端，并补齐复核诊断和手动重试。当前合同与验证见 [储蓄计划复核失败修复](savings-repair.md)；下文保留初次迁移的历史记录。

验证日期：2026-10-30。工作目录：`saveflow-demo`，基线提交 `3de73ae`。本次修改保留在工作区，未发布至现有 Docker/线上部署。

## 模型与安全边界

储蓄建议通过已有 TrueForge SDK 0.2.1 调用，使用 `TRUEFORGE_BASE_URL`、`TRUEFORGE_MODEL` 和可选的 `TRUEFORGE_TOKEN`，不再读取 Qwen 配置，也没有隐藏回退。

本机实际核验结果：TrueForge 0.3.1；配置别名 `test/deepseek-v4-1-flash`；模型注册表返回供应商模型 ID `deepseek-flash`，provider 为 `test`；供应商配置的端点为 `https://api.deepseek.com/v1`。因此确认调用通道为 DeepSeek，但别名本身不能证明供应商的具体版本号。核验未修改供应商配置，未保存密钥。

独立的储蓄 instructions 不引用 ParsedIntent 提示词。每次建议新建私有 inline 会话，不恢复理解会话或复用其他用户上下文。MCP、Skills、sandbox、文件下载、联网搜索、动态子 Agent、提问能力及生成 UI 均禁用；迭代上限为一次。创建和运行前回读权限、模型及参数、instructions 和输出格式，流中出现工具调用或权限请求立即拒绝。

总期限沿用 `withTrueforgeDeadline`，最多二十五秒；输出最多 4096 tokens、24000 字符，SDK 流另有事件数与累计体积上限。SDK 自动重试关闭。格式错误、拒绝、截断、超时、权限异常或复核失败均不能产生 verified 计划。用户可以通过原有安全续接流程重试；测试覆盖失败后重试以及零金融写操作。

## 输入输出合同

发送前验证事实，并逐层投影为：

- `recent`：`month`、`income_minor`、`category_expenses_minor`。
- `history`：每月的 `month`、`category_expenses_minor`。
- `sources`：`recent`、`recent_as_of`、`history`、`history_as_of`。
- `required_monthly_minor`：服务端计算的每月最低储蓄需求。

金额单位均为人民币分。原始流水、账户/卡号、密钥、续接凭据及额外嵌套字段不会随请求发送。历史月份必须有效、去重且早于 recent，金额必须有效；缺失分类不补零。

模型只返回四个字段，所有对象禁止额外字段或缺少必需字段：

| 字段 | 合同 |
| --- | --- |
| `observations` | 每项恰好为 `category, trend, evidence_refs, reason, uncertain`；趋势为 `up/down/flat`，`uncertain=true`；每个有可比历史的近期类别恰好一项，没有可比类别时为空 |
| `category_budgets` | 每项恰好为 `category, suggested_minor, reason, evidence_refs`；近期类别逐一覆盖，不增不漏不重；金额为零至 10,000,000,000 的安全整数 |
| `caveats` | 最多五条非空字符串，每条最多二百字符 |
| `self_review` | 恰好为 `passed, data_coverage, category_evidence, fixed_costs, budget_totals, uncertainty, failed_items`；前六项必须为 boolean，最后一项为 string[] |

reason 非空、最多二百字符，禁止阿拉伯数字、全角数字及货币符号。证据数组长度为一至八，只接受真实同类别的 `recent:类别`、`history:YYYY-MM:类别`。观察必须同时有 recent 和历史证据，预算必须有 recent 证据。

处理顺序为：完整流与终态验证 → JSON 解析 → 精确字段及类型校验 → `verifySavingsAdvice()` 独立语义复核。服务端重新计算历史有效月均及严格阈值 `max(1000, baseline * 0.1)`；阈值边界为 flat。房租、通信不得无依据下降。自检六项必须全部为 true 且 `failed_items=[]`，但自检不会代替这些复核。

目标、剩余金额、月需储蓄仍由未修改的 `calculateSavingsGoal()` 计算；建议后支出合计、可行性和实际缺口由复核器计算。允许结果不可行。

## 与原合同的兼容性

`requestSavingsAdvice(facts, options)`、`verifySavingsAdvice(advice, facts)`、`orchestrator.goal`、签名续接、`goal_plan` 和只读卡片返回结构均保留。原模型 JSON 的四个顶层字段及字段含义保留，服务端可继续复核符合合同的旧数据。

本次明确收紧不完整的历史观察覆盖、重复观察、跨类别引用、其他货币符号和错误类型；这些输出现在会失败。修复了“history 非空但类别均不可比”时不可能满足的观察要求。未增加储蓄 Skill，未修改 Banking Core 或转账、卡片、申购的确认与执行权限。

原先覆盖模型 `reason`、`caveats` 的设计继续保留：字段类型合法并不证明自由文本的事实、收益承诺或操作建议可信。可信卡片只显示由已核对金额、趋势及证据生成的说明。模型仍决定通过复核的预算数值，但其个性化措辞不会直接展示；本次未引入无法可靠验证的自由文本放行规则。

## 修改文件清单

| 文件 | 作用 |
| --- | --- |
| `server/savings-advisor.mjs` | 移除 Qwen 调用；验证及最小化事实；独立复核可比历史、完整覆盖及同类别证据 |
| `server/savings-advice-contract.mjs` | JSON 精确字段、类型、金额与文本格式校验 |
| `server/trueforge-savings-runtime.mjs` | 独立储蓄 instructions、会话策略、超时、输出限制和解析 |
| `server/trueforge-capability-free-runtime.mjs` | 从原 runtime 提取共享 SDK 传输、权限回读、流校验和取消逻辑；回读同时核对模型参数 |
| `server/trueforge-banking-runtime.mjs` | 原理解流程调用共享 SDK 辅助层，保留原理解指令及业务行为 |
| `server/banking-agent.mjs` | 传递当前请求的取消信号 |
| `server/banking-orchestrator.mjs` | 将取消信号传给原储蓄建议接口 |
| `.env.example` | 标明储蓄建议始终使用 TrueForge，不要求 DashScope key |
| `tests/savings-advisor.test.mjs` | 新通道、合同拒绝、历史边界、权限、流异常、超时及数据最小化测试 |
| `tests/savings-conversation.test.mjs` | 通过 SDK fixture 运行新建议模块；失败、零写操作、原签名表单重试和业务响应测试 |
| `tests/banking-lifecycle.test.cjs` | 页面/Hook fixture 对齐完整历史观察覆盖 |
| `tests/fixtures/savings-runtime.mjs` | 仅供测试的合法输出和 SDK 会话事件 fixture，生产代码不使用 |
| `scripts/verify-savings-ui.mjs` | 可重跑的真实 Chrome、HTTP、TrueForge、DeepSeek 页面验收，无响应替换 |
| `docs/verification/savings-trueforge/live-ui.json` | 脱敏页面验收结果及模型注册表映射 |
| `docs/verification/savings-trueforge/verified-plan.png` | 真实页面中已复核计划卡片截图 |
| `docs/savings-trueforge.md` | 本交付记录 |

## 验证结果

- 针对性单元、集成、页面组件和理解 runtime 回归：108 项全部通过。
- 全量测试：660 项，645 通过、14 跳过、1 项既有失败。失败项是 `tests/banking-intent-parser.test.cjs:179` 的诊断事件预期：当前实现会额外报告模型请求及响应事件，但旧断言只允许一个验证失败事件。已在未修改的 `3de73ae` 独立工作树复现。
- ESLint：零错误，四项既有 warning。
- `npm.cmd run build`：应用编译成功；类型检查因 `src/banking-core/postgres-store.mjs` 的既有类型错误失败。在未修改的基线独立运行 TypeScript 同样复现；本次按范围约束没有修改 Banking Core。
- 真实 Chrome 页面端到端：通过。原目标请求 → 已签名表单 → 填写已存两千元及近期收支 → 真实建议调用 → verified 只读卡片；月需储蓄四千元，分类逐一展示。浏览器错误零次，金融写请求零次。
- 在服务器 `DASHSCOPE_API_KEY` 置空后重启并重跑真实页面链路，仍通过。模型未使用测试 JSON 或拦截响应。真实建议数值可随生成变化，复核严格按当次结果计算可行性及缺口。
- 确定性缺口测试：收入 1,200,000 分、分类建议支出 846,000 分、月需储蓄 500,000 分时返回缺口 146,000 分，`feasible=false`。

日志位于工作区父目录 `saveflow-savings-focused-final-20261030.log`、`saveflow-savings-migration-tests-20261030.log`、`saveflow-savings-migration-lint-20261030.log`、`saveflow-savings-migration-build-20261030.log`，以及两份 `saveflow-savings-baseline-*` 日志。

复跑针对性测试：

```powershell
node --test tests/savings-advisor.test.mjs tests/savings-conversation.test.mjs tests/banking-lifecycle.test.cjs tests/banking-savings-client.test.cjs tests/banking-runtime.test.mjs
```

页面验收需要先启动配置好的 TrueForge 和当前代码的 Web 服务，设置 `SAVINGS_UI_URL`（默认 `http://127.0.0.1:3110`），再运行 `node scripts/verify-savings-ui.mjs`。Playwright 为外部 QA 工具，不增加生产依赖；可通过 `PLAYWRIGHT_MODULE` 指向独立安装的 `index.mjs`。

## 部署配置

本机 `.env.local` 已配置 `TRUEFORGE_BASE_URL`、`TRUEFORGE_MODEL`、`SAVEFLOW_ACCESS_CODE`、`CONTINUATION_TOKEN_SECRET`，无需添加新的储蓄专用变量。新部署须提供这些值；理解默认使用 TrueForge，可显式设置 `SAVEFLOW_BANKING_RUNTIME=trueforge`。受鉴权的 TrueForge 还需要 `TRUEFORGE_TOKEN`，供应商 DeepSeek key 配置在 TrueForge 内，不发送至页面。

持久化/Netlify 部署继续按原规则配置 `DATABASE_URL`（或明确允许临时演示状态）；它与本次模型迁移独立。`DASHSCOPE_API_KEY`、`QWEN_MODEL`、`QWEN_BASE_URL` 只供独立的 legacy Qwen 功能使用，不是储蓄建议的前置条件。

## 主分支合并复验（2026-10-30）

本节记录与最新远端 `377dd54` 合并后的结果；上文 108 项/660 项及原页面截图记录的是迁移分支初始验证，不代表合并后的主分支。

合并前已单独提交并保存 main 中三处未提交的储蓄修改（`1d3b92c`），迁移分支提交为 `3f0a826`。四处冲突按以下原则合并：

- `server/savings-advisor.mjs` 使用独立 Runtime、严格合同及独立复核；保留 `savingsAdviceAgentSpec` 导出兼容既有调用。
- `server/trueforge-banking-runtime.mjs` 提取共享 SDK 后继续支持主分支统一会话路由使用的 `agentSpec` 参数。
- `tests/banking-lifecycle.test.cjs` 保留主分支自然语言路由测试及九月账单，只替换储蓄输出 fixture。
- `tests/savings-advisor.test.mjs` 合并两边测试；保留 SDK 注入、无重试、配置错误及中断覆盖。新 Runtime 也保留 `sdk` 注入能力。

主分支已有的自检说明（模拟来源或仍有缺口本身不代表自检失败）已移入专用 instructions；观察覆盖继续遵循本任务的严格合同。增加对全部有效历史累加、比例分母及禁止提前舍入的指令，未放松服务端趋势校验。

最新远端新增了 InvestmentProduct 的 `category`、`displayCode` 必填属性，但未同步三个演示产品。合并时在 `src/banking-core/repository.mjs` 补齐演示分类和显式 DEMO 编码，使数据符合该类型；没有改变金额、风险、流动性或确认与执行权限。

合并验证：针对性回归 135 项通过；全量 712 项中 698 通过、14 跳过、零失败；lint 零错误、三项既有 warning；修复演示产品字段后，生产构建及 TypeScript 检查通过。主分支此前已修复上文初始分支上的诊断断言和 postgres-store 类型问题。

真实页面复验使用主分支扩展后的八个月历史及清空 DashScope key 的服务器，三次均因模型趋势与服务端精确月均比较不一致而被拒绝，没有生成 verified 卡片，金融写请求和浏览器异常均为零。此限制保留，不以省略观察、替换模型结果或放松复核处理。`main-live-ui.json` 记录此次未通过的主分支结果；`live-ui.json` 和截图保留迁移分支的原始成功证据。

主分支复验日志：工作区父目录的 `saveflow-savings-main-focused-20261030.log`、`saveflow-savings-main-tests-20261030.log`、`saveflow-savings-main-lint-20261030.log`、`saveflow-savings-main-build-20261030.log`。本次只合并代码，不重建或重启部署容器。
