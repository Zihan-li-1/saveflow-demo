# Banking Agent 单轮语义理解专项检测报告

- 检测日期：2026-10-28（Asia/Shanghai）
- 目标入口：`saveflow-deploy/server/banking-agent.mjs`，按 `origin/main`（commit `3125eb1`）核对入口与合同。
- 检测范围：仓库当前未找到名为 A1—C5 的 20 条清单；为避免编造，本报告采用当前 main 中 `tests/fixtures/natural-language-cases.mjs` 的前 20 条，临时编号 A1—D5。编号映射仅为审计占位，需人工把原始 A1—C5 清单映射回来。
- 执行状态：**20/20 未执行**。当前环境缺少 `TRUEFORGE_BASE_URL`、`TRUEFORGE_MODEL`、`SAVEFLOW_ACCESS_CODE`、`CONTINUATION_TOKEN_SECRET`；未调用真实模型。历史 `docs/verification/natural-language/real-model.json`（2026-10-26）仅作背景证据，不能充当本轮输出。
- 安全边界：没有调用真实写接口；本报告只读。

## 分类口径

本轮每条的正式分类都是“测试环境未满足”，因为模型未调用；“预期分类”是按现有语义合同和合成数据推断的人工复核起点，不是测试结论。

| 分类 | 含义 |
|---|---|
| 语义正确且能力支持 | 若 ParsedIntent 保留关键槽位，现有 Resolver/Skill/Core 可产生查询或预览；转账、改预算仍需后续确认。 |
| 语义正确但参数需澄清 | 动作正确，但金额、账户、卡片、时间或目标不完整/不确定。 |
| 语义正确但能力不支持 | 动作含义正确，但 Skill/业务能力拒绝或只能给只读结果。 |
| 语义理解错误 | action、否定、时间、金额、目标或约束被模型错误改写。 |
| 下游信息丢失 | 模型输出已保留，但校验、Resolver、路由或响应丢失槽位。 |
| 测试环境未满足 | 没有真实模型或必要运行条件，不能产生原始输出。 |

## 逐条测试记录

> “模型原始 ParsedIntent、校验、路由、最终响应”四列对本轮均明确写“未执行”，没有用桩输出填充。历史栏只帮助定位曾经出现的风险。

| ID | 用户输入 | 预期动作/槽位 | 模型原始 ParsedIntent（本轮） | 校验结果（本轮） | 路由结果（本轮） | 最终响应（本轮） | 本轮正式分类 | 预期分类与关键保留项 | 历史证据（不可代替本轮） |
|---|---|---|---|---|---|---|---|---|---|
| A1 | 查看今年六到九月的账单 | bill.summary；{"period":{"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"2026年6月至9月"}}}；route=bill_result；queries=[{"startDate":"2026-06-01","endDate":"2026-09-30","timezone":"Asia/Shanghai"}]。 |
| A2 | 分析上个月的账单 | bill.summary；{"month":"2026-09"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间="2026-09" | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"month":"2026-09"}}；route=bill_result；queries=[{"month":"2026-09"},{"month":"2026-08"}]。 |
| A3 | 查看今年以来的消费 | bill.summary；{"period":{"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"今年以来"}}}；route=bill_result；queries=[{"startDate":"2026-01-01","endDate":"2026-10-22","timezone":"Asia/Shanghai"}]。 |
| A4 | 查询2026年6月到9月的账单 | bill.summary；{"period":{"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2026-06-01","end_date":"2026-09-30","timezone":"Asia/Shanghai","label":"2026年6月到9月"}}}；route=bill_result；queries=[{"startDate":"2026-06-01","endDate":"2026-09-30","timezone":"Asia/Shanghai"}]。 |
| A5 | 查看2026年8月账单 | bill.summary；{"month":"2026-08"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间="2026-08" | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"month":"2026-08"}}；route=bill_result；queries=[{"month":"2026-08"},{"month":"2026-07"}]。 |
| B1 | 给张三转一千二百五十元 | transfer.create；{"payee_ref":"张三","amount":{"amount_minor":125000,"currency":"CNY"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确但参数需澄清；金额={"amount_minor":125000,"currency":"CNY"}；目标=张三 | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"transfer.create","status":"needs_clarification"}；route=awaiting_confirmation；queries=[{"month":"2026-08"}]。 |
| B2 | 给张三转1万 | transfer.create；{"payee_ref":"张三","amount":{"amount_minor":1000000,"currency":"CNY"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确但参数需澄清；金额={"amount_minor":1000000,"currency":"CNY"}；目标=张三 | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"transfer.create","status":"needs_clarification"}；route=awaiting_confirmation；queries=[{"month":"2026-08"}]。 |
| B3 | 把月预算改成两千五 | card.set_budget；{"amount":{"amount_minor":250000,"currency":"CNY"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确但参数需澄清；金额={"amount_minor":250000,"currency":"CNY"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"card.set_budget","status":"needs_clarification"}；route=awaiting_confirmation；queries=[]。 |
| B4 | 查去年全年的账单 | bill.summary；{"period":{"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"去年全年"}}}；route=bill_result；queries=[{"startDate":"2025-01-01","endDate":"2025-12-31","timezone":"Asia/Shanghai"}]。 |
| B5 | 看看今年九月的支出 | bill.summary；{"month":"2026-09"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间="2026-09" | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"month":"2026-09"}}；route=bill_result；queries=[{"month":"2026-09"},{"month":"2026-08"}]。 |
| C1 | 查上个月的账单 | bill.summary；{"month":"2026-09"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间="2026-09" | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"month":"2026-09"}}；route=bill_result；queries=[{"month":"2026-09"},{"month":"2026-08"}]。 |
| C2 | 今年到现在花了多少 | bill.summary；{"period":{"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2026-01-01","end_date":"2026-10-22","timezone":"Asia/Shanghai","label":"2026年至今"}}}；route=bill_result；queries=[{"startDate":"2026-01-01","endDate":"2026-10-22","timezone":"Asia/Shanghai"}]。 |
| C3 | 我要在年底存够一万 | orchestrator.goal；{"goal_text":"我要在年底存够一万","amount":{"amount_minor":1000000,"currency":"CNY"},"deadline":"2026-12-31"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；金额={"amount_minor":1000000,"currency":"CNY"}；截止=2026-12-31 | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"orchestrator.goal","status":"ready_for_resolution"}；route=needs_plan_inputs；queries=[{"month":"2026-06"},{"month":"2026-07"},{"month":"2026-08"}]。 |
| C4 | 麻烦从活期账户汇给李四壹仟零捌元伍角 | transfer.create；{"source_account_ref":"活期账户","payee_ref":"李四","amount":{"amount_minor":100850,"currency":"CNY"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；金额={"amount_minor":100850,"currency":"CNY"}；来源=活期账户；目标=李四 | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"transfer.create","status":"ready_for_resolution"}；route=awaiting_confirmation；queries=[{"month":"2026-08"}]。 |
| C5 | 娱乐虚拟卡每月能花的钱调到2千零六块五毛 | card.set_budget；{"card_ref":"娱乐虚拟卡","amount":{"amount_minor":200650,"currency":"CNY"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；金额={"amount_minor":200650,"currency":"CNY"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"card.set_budget","status":"ready_for_resolution"}；route=awaiting_confirmation；queries=[]。 |
| D1 | 帮我合计一下上一自然年度的收支 | bill.summary；{"period":{"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2025-01-01","end_date":"2025-12-31","timezone":"Asia/Shanghai","label":"上一自然年度（2025年）"}}}；route=bill_result；queries=[{"startDate":"2025-01-01","endDate":"2025-12-31","timezone":"Asia/Shanghai"}]。 |
| D2 | 查上个月的账单 | bill.summary；{"month":"2025-12"} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间="2025-12" | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-01-01","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"month":"2025-12"}}；route=bill_result；queries=[{"month":"2025-12"},{"month":"2025-11"}]。 |
| D3 | 今年到现在花了多少 | bill.summary；{"period":{"start_date":"2027-01-01","end_date":"2027-01-01","timezone":"Asia/Shanghai","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2027-01-01","end_date":"2027-01-01","timezone":"Asia/Shanghai","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2027-01-01","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2027-01-01","end_date":"2027-01-01","timezone":"Asia/Shanghai","label":"今年至今"}}}；route=bill_result；queries=[{"startDate":"2027-01-01","endDate":"2027-01-01","timezone":"Asia/Shanghai"}]。 |
| D4 | 今年到现在花了多少 | bill.summary；{"period":{"start_date":"2026-01-01","end_date":"2026-12-31","timezone":"America/New_York","label":"测试期间"}} | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确且能力支持；时间={"start_date":"2026-01-01","end_date":"2026-12-31","timezone":"America/New_York","label":"测试期间"} | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-12-31","timezone":"America/New_York","financialContextPresent":true},"action":"bill.summary","status":"ready_for_resolution","time":{"period":{"start_date":"2026-01-01","end_date":"2026-12-31","timezone":"America/New_York","label":"今年至今"}}}；route=bill_result；queries=[{"startDate":"2026-01-01","endDate":"2026-12-31","timezone":"America/New_York"}]。 |
| D5 | 从活期账户给张三转一两千 | transfer.create；{"source_account_ref":"活期账户","payee_ref":"张三"}；预期澄清 | 未执行：无真实模型原始 ParsedIntent | 未执行：无法校验 | 未执行：无法路由 | 未执行：无最终响应 | 测试环境未满足 | 语义正确但参数需澄清；来源=活期账户；目标=张三；不确定/缺参须保留并追问 | 历史（2026-10-26，非本轮）: ParsedIntent={"calendar":{"currentDate":"2026-10-22","timezone":"Asia/Shanghai","financialContextPresent":true},"action":"transfer.create","status":"needs_clarification"}；route=needs_clarification；queries=[]。 |

## 当前发现与问题分级

**P0（阻断本轮检测）**：真实 TrueForge 运行条件缺失，20 条均不能产生可归因的模型输出；不得据此判定模型理解正确或错误。

**P1（合同/下游风险，需人工复核）**：历史报告显示目标动作可能在模型理解后被下游补充流程改变最终状态，例如储蓄目标进入 `needs_plan_inputs`；这属于意图契约或计划输入要求，不能直接归因于模型错误。

**P1（时间边界风险）**：相对月份、跨年日界线、时区会改变 `month` 或 `period`；必须人工核对当前日期、用户时区与“今年至今”边界。

**P2（参数澄清）**：金额模糊、来源账户缺失、卡片未指明时，应保留已知目标并进入澄清，不应猜测实体 ID 或授权执行。

**P2（授权边界）**：ParsedIntent 不得含 `confirmed`、`operationId`、工具调用或执行结果；预览和确认仍由服务端后续链路负责。

## 当前代码证据

1. `server/banking-agent.mjs:119-132` 默认选择 TrueForge，并把解析结果交给 `runBankingConversation`；真实条件需要在 `docs/Banking-Agent-API.md:11-15` 配置。
2. `server/banking-orchestrator.mjs:289-291` 对 `clarify`/`unsupported` 做保守返回，不会从模型输出直接执行。
3. `server/banking-orchestrator.mjs:355-368` 显示购物复合意图、储蓄目标、订阅列表等动作的实际分支；`455` 将 Skill 的 unsupported 作为明确不支持返回。
4. `server/banking-intent-parser.mjs:13-39` 限制单一动作、槽位、金额/时间格式，并禁止确认字段、实体 ID 和执行声明。

## 最值得人工复核的 10 条

1. **A2**：相对“上个月”历史上出现了额外查询过滤，核对是否为账单覆盖或基线查询，避免把下游二次查询误判成模型重复意图。
2. **A5**：明确月份与合成数据覆盖范围可能不一致，区分语义正确、数据不足和查询过滤错误。
3. **B1**：中文金额“一千二百五十元”及缺少来源账户，确认金额单位与澄清槽位均保留。
4. **B2**：“1万”的金额归一化，确认 10000 元而非 10000 分，并保持未授权执行。
5. **B3**：未指明卡片的“月预算”，确认进入卡片候选澄清而非猜卡。
6. **C4**：中文小数金额“壹仟零捌元伍角”，核对 1008.50 元与 CNY 分单位。
7. **C3**：储蓄目标的 deadline/amount 已理解但最终还需 `planInputs`，核对这是契约限制还是信息丢失。
8. **D2**：相对月份在 2026-01-01 边界，确认“上个月”是 2025-12。
9. **D3**：在 2026-12-31/2027-01-01 日界线测试“今年至今”，预期本身可能存在合理解释，标记待人工判断。
10. **D4**：America/New_York 时区下“今年至今”与 UTC/本地日期的边界，需核对 timezone 是否贯穿查询。

## 结论

本轮没有可归因的真实模型结果；正式结果是 20 条全部“测试环境未满足”。历史 2026-10-26 证据只能作为复核线索。补齐真实 TrueForge 配置后，应重新运行同一入口并保存每条原始 ParsedIntent、验证错误（如有）、路由或 Skill 结果和最终响应，再把“预期分类”改为实际分类。
