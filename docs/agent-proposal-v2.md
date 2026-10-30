# AgentProposalV2 只读规划

规划入口使用现有 `POST /api/banking-agent`，支持统一自然语言路由自动选择，也兼容显式 `planning: true`（或 `taskMode: "plan"`）。页面不再显示规划模式选择器。普通解释直接回答，单项业务继续 ParsedIntent v1，不强制经过规划循环。规划请求先在 ConversationState 中创建 `planning.read_only` 任务，结果 taskId 与服务端任务绑定。外层任务控制使用独立 control 契约，与本文件的 finish/cancel 分离。最新验收见 [统一自然对话交付记录](Unified-Conversation-Routing.md)。

## 契约

模型每轮只能返回一个 `schemaVersion: "2.0.0"` 的 JSON 对象。`kind` 分为：

- `business_intent`：普通单意图，交还现有 ParsedIntent/Dispatcher 链路。
- `plan_request`：提出一次只读工具调用。工具只能是 `bill.summary`、`subscription.list`、`card.get`、`product.list`、`wealth.recommend` 或 `wealth.compare`。
- `task_control`：结束或取消当前只读规划。
- `clarify`：缺少必要约束时请求用户补充。
- `unsupported`：目标超出当前能力。

规划器只接受用户称谓、已定义金额和时间结构。`operationId`、实体 ID、确认字段、令牌、工具调用对象和执行结果会在契约边界拒绝。任务 ID、步骤 ID、调用 ID、依赖关系、状态和证据由服务端生成或校验，模型不能声明可信身份。

## 调用链路

```text
POST /api/banking-agent planning=true
  -> 既有鉴权、限流、ConversationState 会话锁
  -> TrueForge JSON 规划 Runtime（无 MCP、无 Skill、无写权限）
  -> AgentProposalV2 校验
  -> 只读工具网关参数校验
  -> 正式 Repository / Skill
  -> 校验 ok/kind/data/evidence/source/asOf
  -> 结果摘要回送同一规划会话
  -> 下一轮模型选择工具、澄清、结束或 unsupported
  -> 有界计划结果
```

工具网关不使用固定用户的 MCP 试点凭据，也不调用 `Core.decide` 或 `Core.execute`。`bill.summary` 和 `subscription.list` 复用正式只读 Handler；卡片和产品读取正式 Repository；理财建议与比较复用现有 Wealth Skill，并删除面向模型的实体 ID。`wealth.recommend` 仅在请求明确提供结构化风险、期限与流动性约束且工具参数逐项一致时执行，否则停止并返回部分结果；页面当前尚无这组结构化输入。完整证据保留在服务端步骤记录中。

循环最多 6 步，重复的工具和参数会停止循环并返回 `partial`。单个工具失败返回可审计的失败步骤，不伪造成功，也不会无限重试。规划结果不能成为写操作授权；现有转账预览、确认、执行和恢复链路保持原入口。

## 事件记录

每个规划结果包含 `taskId`、`steps` 和 `audit`。步骤记录工具名、服务端生成的 `stepId`、依赖步骤、状态、已验证工具结果和证据；审计记录每轮 proposal 的 kind、工具、依据、接受/拒绝状态和停止原因。完成分析时模型需提供 `analysis` 与 `evidence_tools`；服务端只接受已成功完成工具的引用并映射到服务端步骤 ID。页面把模型说明和正式工具数据卡片分开，金额与实体来自后者。运行时日志不得写入访问码、签名令牌、TrueForge Session ID 或完整模型凭据。

## 验证范围

`tests/read-only-planner.test.mjs` 覆盖：越权工具和实体 ID 拒绝、正式 Repository 账单结果与证据、第二次工具选择依赖第一次真实结果、单项账单、缺数据、工具失败、重复调用停止和写工具阻断。专项测试使用传输层桩，明确不是模型实测。`node scripts/verify-planning-live.mjs` 只在配置真实 TrueForge 环境后调用实际 Banking API 和模型，并将逐轮观察与选择写入 `docs/evidence/planning-live-*.json`；缺少配置时退出且不生成证据。

下一阶段可把只读规划结果交给“计划 → 独立预览 → 用户确认”流程：规划器只提交经过验证的业务意图，服务端为每个写步骤重新解析实体并生成独立预览，用户确认后才进入既有 `Core.decide`/`Core.execute`。本阶段不开放该扩展。
