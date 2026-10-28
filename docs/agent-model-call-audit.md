# SaveFlow Banking Agent 模型调用审计

审计对象是 `saveflow-demo` 当前分支 `codex/task-b-context-control` 的 `/api/banking-agent` 入口。本文只记录代码和定向测试证据；没有把 mock 传输层结果当成真实 TrueForge 服务可用性证明。

## 当前调用链

```text
src/lib/use-saveflow.ts
  -> src/lib/banking-agent-client.ts
  -> POST /api/banking-agent
  -> server/banking-agent.mjs
  -> server/banking-conversation.mjs（会话、续接凭据、任务锁）
  -> server/banking-orchestrator.mjs
       ├─ continuation + 取消/撤回：确定性 task control，跳过模型
       ├─ continuation + choice.optionId：确定性候选解析，跳过模型
       └─ 普通文本或自由文本补充
            -> SAVEFLOW_BANKING_RUNTIME=trueforge（默认）
                 -> server/trueforge-banking-runtime.mjs
                 -> TrueForge private session -> one turn
            -> SAVEFLOW_BANKING_RUNTIME=legacy-qwen（仅显式配置）
                 -> server/banking-intent-parser.mjs -> Qwen compatible endpoint
       -> ParsedIntent JSON.parse + validateParsedIntent + grounding 校验
       -> src/agent/runtime.mjs / Banking Core prepare（只读查询或正式预览）
       -> server/banking-reply.mjs 固定模板/安全提示
       -> JSON response
```

默认 Banking 路由是 TrueForge。`SAVEFLOW_BANKING_RUNTIME` 是唯一选择 TrueForge 或旧 Qwen 的服务端变量；未知值直接返回配置错误，不会静默回退。TrueForge Agent 被配置为无 MCP、无 Skill、单轮、JSON object 输出，模型只提出 ParsedIntent，Skill/Core 才能执行查询或生成预览。

TrueForge 的会话创建、模型 turn、终态检查和 JSON 解析发生在 `server/trueforge-banking-runtime.mjs`。模型输出随后必须通过 `validateParsedIntent` 与 `validateIntentGrounding`；失败时返回 `TRUEFORGE_FORMAT_ERROR`，不会进入业务执行。`unsupported` 是模型理解出的业务结果，不代表模型调用失败。

历史上下文规则如下：首次请求没有服务端会话时，前端最多送最近 4 条展示消息；会话已建立后，服务端清空这类聊天 history，改用已认证的会话草稿、任务和 `conversationToken`。TrueForge 实际收到的是服务端 JSON 中的 `userMessage`、经过限制的 `history`、日历/财务上下文和已校验 draft；续接候选按钮本身不调用模型。

## 诊断日志

设置 `SAVEFLOW_AGENT_DIAGNOSTICS=true` 后，服务端按现有 `requestId` 输出 JSONL 事件；默认关闭。事件只记录路由、枚举、布尔值、历史条数、耗时、状态和错误类别，不记录用户原文、完整 history、prompt、模型原始输出、token、账户/卡号、金额、余额、conversation/continuation token 或 operationId。

事件含义：

| 事件 | 证据 |
|---|---|
| `agent_request_received` | 入口模式和是否有续接凭据 |
| `agent_model_route` | 选中的 `trueforge`/`qwen`，以及是否准备模型调用 |
| `agent_model_request` | provider、配置模型名、history 条数、是否有 draft context |
| `agent_model_response` | 是否完成、成功布尔值、耗时、错误类别 |
| `agent_intent_validation` | JSON/Schema 是否通过、最终 action 或失败类别 |
| `agent_dispatch` | action、结果状态、是否进入业务路由、确定性跳过原因 |
| `agent_response_sent` | HTTP 状态、业务 code、响应状态和来源类型 |

日志仅在 `SAVEFLOW_AGENT_DIAGNOSTICS=true` 生效，诊断 sink 失败不会影响业务请求。

## 定向验证结果

| 测试输入 | 模型是否调用 | 模型是否成功返回 | Schema | 最终路径 | 问题归属 |
|---|---:|---:|---:|---|---|
| `查询2026年8月账单`（TrueForge runtime mock transport） | YES | YES | PASS | `bill.summary` -> bill result | UNKNOWN（真实服务未验证） |
| 普通转账请求（TrueForge runtime mock） | YES | YES | PASS | `transfer.create` -> clarification/preview | UNKNOWN（真实服务未验证） |
| 带 `continuationToken` 的 `choice.optionId` | NO | N/A | 服务端重建并校验 | deterministic candidate selection -> preview | 无模型问题 |
| 带续接凭据的 `取消转账` | NO | N/A | N/A | task control -> cancelled/locked/finished | F：任务状态/操作状态决定结果 |
| `撤回上一步操作` | 通常 YES（若没有可识别续接状态） | 取决于模型 | 通过后才 dispatch | 没有专用入口匹配；可能 `unsupported` | F/G：确定性命令覆盖不足或固定回复信息损失 |
| `三个月内获得200元投资净收益` | YES（普通文本） | UNKNOWN | 通过则进入 goal/wealth 分支；失败则 `TRUEFORGE_FORMAT_ERROR` | 不能依据 HTTP 200 推断成功 | D/E/F：需看真实诊断事件区分 |

上述结果来自 `tests/agent-model-call-audit.test.mjs`、`tests/banking-runtime.test.mjs` 和代码路径。mock 只证明应用确实调用了注入的 runtime、携带了 context/history，并按校验和编排结果继续；它不证明真实模型服务可用。

## 三个异常示例的归因

1. `取消转账`：有有效 continuation 时，`banking-orchestrator.mjs` 在解析模型前匹配取消表达式，并调用 conversation task control。因此该路径应记录 `agent_model_route` 后以 `skipped`/`explicit_cancel` 结束。没有 continuation 时，文本会走普通理解边界；模型返回 `unsupported` 时，`banking-reply.mjs` 使用固定“不支持”模板。这是 F/G 或缺少已认证上下文的结果，不能归因于 TrueForge 未调用。

2. `撤回上一步操作`：当前确定性正则只覆盖“取消/不用了”等当前操作表达式；`agent-task-control.mjs` 支持 `undo`，但自然语言入口没有把“撤回上一步操作”稳定映射到它。没有可识别 continuation 时，该文本进入模型，随后可能得到 `unsupported` 或 clarification。现有证据支持优先修复入口/任务控制映射，暂不升级 AgentProposalV2。

3. `三个月内获得200元投资净收益`：普通 Banking 文本默认进入 TrueForge；返回内容必须先 JSON.parse、ParsedIntent v1 Schema 和 grounding 校验。若模型理解为 `unsupported`，这是 D（模型意图判断）；若模型给出 JSON 但字段不符合 v1，是 E；若校验通过后才出现错误，才属于 F。当前没有真实 TrueForge 日志，因此这条的最终分类保留 UNKNOWN，不能把“输入格式或数值不符合要求”反推成模型未调用。

## 真实 TrueForge 核验

状态：`NOT_VERIFIED`。

当前工作区 `.env.local` 只有本地 `TRUEFORGE_BASE_URL=http://localhost:8790` 和模型名，未提供可证明可用的 TrueForge token，且本次未启动或访问真实网关。没有虚构真实调用结果，也没有把 mock 通过当成真实验收通过。

具备授权部署环境后，最小核验命令为：

```powershell
$env:SAVEFLOW_AGENT_DIAGNOSTICS='true'
$env:SAVEFLOW_BANKING_RUNTIME='trueforge'
npm run dev
```

随后用现有访问码向 `/api/banking-agent` POST `{"message":"查询2026年8月账单"}`，读取服务端 stdout 中同一 `requestId` 的 `agent_model_route`、`agent_model_request`、`agent_model_response`、`agent_intent_validation`、`agent_dispatch`、`agent_response_sent`。只有看到真实 `agent_model_response.success=true`、真实 provider/model 请求完成、Schema 通过和正确 action，才能标记真实调用成功；否则保持 `NOT_VERIFIED`。

## 后续建议

优先级最高的是继续修复入口和上下文传递证据：为“撤回上一步操作”补一个明确的已认证任务控制入口，并在部署环境采集上述安全事件。其次再根据真实事件决定是 TrueForge 输出/Schema 问题还是 dispatcher/回复模板问题。当前证据不足以支持立即升级 AgentProposalV2；应先修复模型调用链的可观测性、上下文和路由判定。
