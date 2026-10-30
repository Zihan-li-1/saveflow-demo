# 储蓄计划复核失败定点修复

2026-10-30；修复基线为最新 main `416433c`。本次没有修改 Banking Core、金融写操作、确认或执行权限。

## 版本与实际故障定位

排查时 `http://127.0.0.1:4300/version` 和容器环境都报告提交 `d8ef2d5f76f9e1ffe8fdc7f1fc7aabe66a811137`、`gitDirty=false`；它落后于最新 main。用户提供的 requestId `7edc6120-1847-4164-a434-a7c3968115f3` 在现有容器日志中没有细化复核记录，旧服务也没有该阶段诊断。因此不能追溯断言那一次请求究竟触发了哪条规则。

在只增加诊断、尚未改变统计合同的代码上，用真实 TrueForge/DeepSeek 复现两次，得到：

| requestId | HTTP | 阶段 | 静态原因 |
| --- | --- | --- | --- |
| `0a4d5f62-cf87-4bb3-bb3e-51a270beeecc` | 502 | `semantic_review` | `trend_mismatch` |
| `47ea9f6f-5986-484d-918f-99255bb3d4e9` | 502 | `semantic_review` | `trend_mismatch` |

这两次复现通过了事实和 JSON 结构检查，具体失败是 `verifySavingsAdvice()` 中模型趋势与完整历史月均的比较结果不一致；不能推广为所有 `ADVICE_REVIEW_FAILED` 都是这个原因。原始脱敏记录见 [before.json](verification/savings-repair/before.json)。

## 定点修改

服务端 `calculateSavingsEvidence()` 在验证原始汇总后，按类别对所有有效历史月份求和、计数，生成历史月均、严格阈值、差值、方向以及真实合法引用。缺失类别为未知，不补零。方向使用整数比值比较，避免提前舍入引发边界错误：比较 `10 × (recent × count - total)` 与 `max(10000 × count, total)`；正负边界内为 flat。

模型现在接收最小化的 `recent`、`sources`、`required_monthly_minor`、`comparisons` 和 `category_evidence`。原始历史记录不再交给模型重新统计。每条 comparison 包含类别、有效月份数、合计、月均、阈值、差值、方向及证据；category_evidence 给出全部合法引用和适合展示的引用子集。模型采用已有统计及引用，负责提出保守预算和定性说明。

对外建议仍是 `observations`、`category_budgets`、`caveats`、`self_review` 四个字段。服务端继续逐层校验精确字段、类型、自检、类别完整覆盖、证据实际存在且属于同类、趋势与确定性统计一致、金额范围、固定支出保护和合计。模型若改错方向或证据仍然失败；没有把错误趋势覆盖成正确值来放行。目标数学计算和 `goal_plan` 结构保持原样。

`ADVICE_REVIEW_FAILED` 改归 `advice_review`，提示“本次储蓄建议未通过安全复核，尚未生成计划。请保留本次填写，手动重试。”储蓄调用中的 JSON/流格式错误也归入这一路径；其他业务错误策略保持不变。已有页面重试按钮复用内存中的表单和签名续接，不增加自动请求或自动重试；签名过期、快照更新及任务归属检查照常生效。

## 脱敏诊断

`savings_advice_review` 事件始终记录，其他调试日志仍受原开关控制。字段只允许：`event`、`requestId`、`stage`、`code`、`reason`。阶段区分 `facts`、`json_parse`、`model_output`、`shape`、`semantic_review`、`model_transport` 和 `complete`；原因来自服务端静态枚举，例如 `facts_invalid`、`shape_budgets`、`self_review_failed`、`trend_mismatch`、`fixed_cost_reduction`、`json_invalid`。

任意上下文、金额、类别、原始模型文本、错误自由文本、密钥和会话凭据均不进入该事件，额外字段会被剔除。日志失败不会影响业务处理。

## 测试证据

- 储蓄单元及集成测试 64 项通过；页面组件测试确认失败保留表单与签名，只有点击才重试。
- 真实 Chrome → HTTP → 原认证处理器 → 官方 SDK → TrueForge/DeepSeek：三次连续生成，均得到八个月历史、九类别预算的 verified 计划。
- 百万元目标在收入不足时仍返回 verified 的不可行计划及真实缺口；未伪造可行结果。
- JSON 异常通过“真实模型完成推理后，截断其实际返回字符串”的故障注入验证；没有用固定 JSON 替代模型生成。该请求被拒绝并记录 `json_parse/json_invalid`，页面保留六百五十元已存输入和原签名；人工点击重试后，再次真实推理成功。
- 共六次真实建议调用：五次有效生成，一次预期的截断拒绝；金融写操作零次，浏览器异常零次。详见 [live-checks.json](verification/savings-repair/live-checks.json)。
- 生产构建及 TypeScript 检查通过；lint 零错误，三项既有 warning。
- 全量测试 717 项：692 通过、14 跳过、11 项理财相关既有失败。未修改的 `416433c` 独立工作树也有完全相同的 11 项失败，见 [baseline-comparison.json](verification/savings-repair/baseline-comparison.json)。本次不修复无关理财逻辑。

成功响应来自实际 HTTP，已移除签名和会话凭据：[verified-response.json](verification/savings-repair/verified-response.json)。主要字段为：

```json
{
  "httpStatus": 200,
  "code": "OK",
  "requestId": "43321e97-1417-4437-831e-1d13bc3cb255",
  "status": "goal_plan",
  "verification_status": "verified",
  "execution_allowed": false
}
```

[成功计划截图](verification/savings-repair/verified-plan.png) · [手动重试后截图](verification/savings-repair/manual-retry-verified.png) · [收入不足响应](verification/savings-repair/shortfall-response.json)

## 实际修改文件

| 文件 | 用途 |
| --- | --- |
| `server/savings-advisor.mjs` | 确定性历史统计、方向及证据生成；最小化模型输入；严格独立复核 |
| `server/savings-advice-contract.mjs` | 区分事实、结构及语义失败的静态原因，过滤诊断标签 |
| `server/trueforge-savings-runtime.mjs` | 模型采用可信统计；JSON/输出错误的阶段标记 |
| `server/banking-orchestrator.mjs` | 复核诊断关联 requestId；储蓄格式错误归类 |
| `server/agent-diagnostics.mjs` | 始终记录经过字段白名单过滤的储蓄复核事件 |
| `server/banking-agent.mjs` | 专用安全错误提示 |
| `src/lib/agent-error-policy.mjs` | 正确归类并允许手动重试，保留有效状态 |
| `tests/savings-advisor.test.mjs` | 八月统计、精确边界、证据、诊断脱敏及输入合同测试 |
| `tests/savings-conversation.test.mjs` | HTTP 错误分类、requestId 诊断关联、签名手动重试 |
| `tests/banking-lifecycle.test.cjs` | 真实页面组件的表单保留、禁止自动重试和点击重试 |
| `tests/fixtures/savings-live-ui-server.mjs` | 仅供 QA 的真实模型宿主；可截断实际返回以验证失败链路 |
| `scripts/verify-savings-repair-live.mjs` | 可重跑的真实浏览器与模型验收，保存脱敏响应及截图 |
| `docs/savings-repair.md`、原迁移记录中的链接、`docs/verification/savings-repair/*` | 本次故障、合同、测试及交付证据 |

复跑储蓄测试：`node --test tests/savings-advisor.test.mjs tests/savings-conversation.test.mjs`。

真实验收需要现有 TrueForge 配置、访问码和续接密钥；执行 `node scripts/verify-savings-repair-live.mjs`。Playwright 仍是独立 QA 工具，可用 `PLAYWRIGHT_MODULE` 指向独立安装的 `index.mjs`，不增加应用依赖。QA 服务仅监听本机，使用合成数据并禁止金融写入；故障入口不加入生产服务。
