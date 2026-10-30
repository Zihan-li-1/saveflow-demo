# Banking Agent API 与回复合同

默认 TrueForge 入口先验证独立 ConversationRoute：普通聊天直接回复，业务进入原 ParsedIntent v1 → Skill/Resolver → Core 查询或正式预览，多步骤只读目标自动进入现有规划器，任务控制进入独立可信校验。仍兼容 API 显式 `planning: true` / `taskMode: "plan"`，页面已移除规划模式勾选框。详见 [统一对话与验收](Unified-Conversation-Routing.md)。

## 唯一入口与服务端配置

页面的 Banking 消息、自由文本补充、选项都只调用 `POST /api/banking-agent`。本地通过 `npm run dev:qwen` 提供 API，Netlify 入口为 `netlify/functions/banking-agent.mjs`；静态 `out` 本身不提供 API。

`SAVEFLOW_BANKING_RUNTIME` 整体选择实现，默认 `trueforge`：

- `trueforge`：TrueForge Agent Runtime 先提出 ConversationRoute；业务分支再由独立 ParsedIntent v1 理解器处理。两者均无工具、无执行权限。需要 `TRUEFORGE_BASE_URL`（不带路径/查询的 HTTP(S) origin）、`TRUEFORGE_MODEL`、按部署需要配置 `TRUEFORGE_TOKEN`。
- `legacy-qwen`：迁移期显式选择 Qwen 单意图理解；首轮、补充和修改均调用同一模型，仍经过同一服务端编排器和回复合同，需要 `DASHSCOPE_API_KEY` 等旧配置。
- 其他值为配置错误。没有按句式选择实现、按请求试探多个后端或失败静默回退。旧 `SAVEFLOW_TRUEFORGE_*_ENABLED` 开关不再选择此 API 的路由。

`SAVEFLOW_ACCESS_CODE`、`CONTINUATION_TOKEN_SECRET` 分别至少 16 字符。持久 Core 部署还需配置 `DATABASE_URL` 并迁移；同一部署的实例使用相同续接密钥和一致 Repository。访问码通过 `X-Saveflow-Access` 发送；服务端拒绝不同源 Origin、限流每分钟 10 次、限制 JSON 请求体 16KB。密钥不得使用 `NEXT_PUBLIC_` 前缀。

## 请求

自动规划示例：`{"message":"分析8月账单支出与闲置订阅，不要执行任何修改。"}`。规划任务在 ConversationState 内独立绑定。自动路由剥离旧续接凭据；显式 plan 请求仍不能带旧任务的 continuationToken、taskId 或选择。一般解释和单项查询不会仅因包含多个关键词而进入规划。

普通上下文独立使用 `chatHistory:[{role:"user"|"assistant",content:"..."}]`：输入最多 12 条、每条 2000 字符；模型只接收最近 8 条、每条至多 800 字符；页面和 sessionStorage 限制为最近 6 条、每条 400 字符。这个字段不传给业务解析器，不提供槽位或授权。

普通回答固定为 `code:"OK", data:{status:"conversation_reply"}, reply:{text,style,safetyNotices}`。不附带 operationId、预览、回执、续接或金融会话元数据，表示金融状态未被本次聊天修改。客户端保留已有任务、选项、预览和凭据。外层 clarify/unsupported 也以经过校验的纯文字说明原因，不创建澄清任务。

任务控制响应为 `data.status:"task_control"`、`control` 和可信 `conversation`。自然恢复时服务端只选唯一任务；客户端再用该任务原签名 continuationToken 发出 resume，重新核验状态及实体。模型不能提交任务 ID。多任务时返回 ambiguous 并要求使用既有任务面板明确选择。

```json
{"message":"给张三转500元","history":[],"consent":true,"replyStyle":"friendly"}
```

```json
{"continuationToken":"<上一响应令牌>","message":"从活期账户","replyStyle":"professional"}
```

```json
{"continuationToken":"<上一响应令牌>","choice":{"optionId":"<上一响应选项>"}}
```

`replyStyle` 可省略，默认 `concise`（简洁）；另有 `friendly`、`professional`。风格仅供普通对话文案生成及业务展示，不进入 ParsedIntent 参数理解，不修改工具、卡片、风险或确认要求。

首次 message 为 1–2000 字符（页面限制 500）；history 最多 12 条，每条 role 为 user/assistant、content 为 1–2000 字符。history 是不可信文本，不能授权实体、余额或确认。consent 可省略，提供时只能为 true；页面要求勾选授权。choice 只能含非空 optionId，必须携带 token，不能同时携带 message。请求不接受实体 ID、confirmed、riskLevel、operationId、工具名等额外字段。

续接令牌为有效期 5 分钟的 AES-GCM 加密认证草稿，包含槽位、追问及服务端候选映射，不是确认授权或写入幂等键。自由文本续聊由当前配置的同一理解器接收已认证的 action/slots/pendingSlot/question 和候选项；结构化选项由服务端核对映射，无需额外模型调用。模型理解文本候选选择时，可在 ParsedIntent 顶层返回 `choice:{optionId}`，服务端仍须核对令牌中的候选和原始引用，模型不能提供实体 ID。实体原始引用变化时删除旧选择。补充时保留已知槽位；改为不确定值时可省略并明确标记待澄清。

## 金额、日历和目标参数（第一阶段）

原始自然语言直接交给模型；金额和日期校验不再对输入原文做阿拉伯数字或显式年月匹配。金额统一为 `{amount_minor:整数分,currency:"CNY"}`，保留现有预算上限、余额、风险与确认校验；无法确定的精确金额必须澄清，不能从示例或余额填值。

服务端 `now:()=>毫秒时间戳` 与 `timezone` 可由宿主/测试注入，默认动态 `Date.now` 和 `Asia/Shanghai`。每轮模型获得 `calendar.currentTime/currentDate/timezone`，以及单独标识的财务 `asOf/currentMonth/availableMonths`。HTTP 用户不能指定时钟。口语日期只以当前日历为准，不能以样例数据月份为准。

`bill.summary` 继续使用已有 `month` 或 `period`。日期支持 1900–2099 年；范围不超过 366 个日历日，`start_date` 和 `end_date` 均包含该时区下的全天。其他用户时区的单月使用 `period`，`month` 默认为上海时区。Repository 新增 `getTransactions({startDate,endDate,timezone})`，内存与 PostgreSQL 使用相同边界；SQL 单月查询同步修正为用户本地日期。返回的 `coverage` 和缺数据月份明确提示覆盖与新鲜度限制，无记录不代表零支出。

`orchestrator.goal.slots` 新增可选 `amount`、`deadline:YYYY-MM-DD`，实际结果返回 `targetAmountFen`、`deadline`。目标需要精确值而尚不确定时可将 `amount/deadline` 放入 `missingSlots`，保留其他已知内容并续接；普通只读建议不强制提供这两项。未增加规划算法或执行权限。

独立 `/api/agent` 储蓄助手也获得相同日历基准，新增结构化 `deadline` 与 `goal` 返回值；已存在的月数计算由宿主按截止日期换算，现有确认保存请求和模拟计划记录保留截止日期。MCP 的结构化参数/按钮仍可直接处理，自由文本补参由配置的理解器处理；服务不可用时明确报错，不退回固定解析。

验收与限制见 [第一阶段报告](Natural-Language-Phase1.md)。`npm run verify:natural-language` 使用真实 TrueForge 服务和合成数据，独立于 `npm test` 的模型桩验证。

旧试点 `tfm1`/`tfb1` 令牌返回 CONTINUATION_INVALID，必须重新开始。统一入口不暴露远端 TrueForge session ID。浏览器可恢复有效澄清草稿，但不能从存储恢复 Core 确认/执行按钮的有效状态。

## 响应：文字与卡片分离

```json
{
  "code":"NEEDS_CLARIFICATION",
  "message":"请选择付款账户。",
  "requestId":"<服务端编号>",
  "reply":{
    "text":"好的，收款人「张三」，金额 ¥500.00。请选择付款账户。",
    "style":"friendly",
    "safetyNotices":[]
  },
  "data":{
    "kind":"clarification","status":"needs_clarification",
    "action":"transfer.create","slot":"source_account_ref",
    "question":"请选择付款账户。",
    "choices":[{"optionId":"<服务端选项>","label":"模拟活期账户（可用 ¥5000.00）"}],
    "continuationToken":"<不透明令牌>"
  }
}
```

以上选项与余额仅示意，真实值由 Repository 产生。`message` 保留兼容状态说明；客户端展示 `reply.text` 和逐字安全提示 `reply.safetyNotices`。`data` 保留原有结构化业务合同，卡片只读取它，不能从自然语言解析金额、风险或执行结果。澄清卡片只提供候选按钮及固定选择提示，不再重复 `data.question`；无选项时只显示气泡并允许文字回答。

| HTTP / code | data.status | 含义 |
| --- | --- | --- |
| 200 / NEEDS_CLARIFICATION | needs_clarification | action、slot、question、choices、continuationToken；只问缺失或歧义信息 |
| 200 / OK | bill_result / card_result / subscription_result / product_result | 现有 Skill/Core 结构化查询数据及 evidence |
| 200 / OK | awaiting_confirmation | Core 正式预览、operationId、preview、risk、continuationToken；尚未执行 |
| 200 / OK | cancelled | 取消当前对话草稿，未执行资金/卡片操作；不代表撤销另一条已准备的 Core operation |
| 200 / UNSUPPORTED | unsupported | 不支持该动作，未准备执行 |
| 400 / INSUFFICIENT_BALANCE | core_error | error 及可选 recovery 澄清，保留收款人与金额，账户余额由 Repository 提供 |
| 4xx / 5xx | error / core_error / card_error 或无 data | 明确失败，不回退、不自动重试 |

能力与实际运行配置以服务端 Catalog 为准：账单、卡片、订阅、理财筛选/比较和模拟申购赎回复用既有 Handler；`product.list` 当前仅有规划网关 Handler，单项 Dispatcher 仍不支持，目录明确标为 planning_only。真实第三方订阅取消和真实购物下单未接入。多步骤规划只能读取六类白名单工具，不授权任何写入。

金额使用整数分。实体及余额来自 Repository，预览编号/哈希/风险等级/确认步骤来自 Core。此接口使用 camelCase 结构，不改变 `/api/banking` 的既有 wire 合同。页面确认后仍走既有 Core `action.decide` / `action.execute` 与验证流程；模型没有这些工具。文字“确认执行”不能替代页面确认。

关键预览安全提示不受风格影响：

> 资金和卡片状态尚未改变。只有在页面核对预览并完成所需确认与验证后，操作才可执行。

Core risk/preview warnings 原文进入 safetyNotices，不交给模型润色。错误、安全要求也不做风格变换。余额不足恢复以澄清而非成功卡片展示。

常见错误包括 UNAUTHORIZED、FORBIDDEN、INVALID_REQUEST、INVALID_CHOICE、CONTINUATION_INVALID、CONFIRMATION_REQUIRED、RATE_LIMIT、TRUEFORGE_CONFIG_ERROR、TRUEFORGE_UNAVAILABLE、TRUEFORGE_TIMEOUT、TRUEFORGE_AGENT_POLICY_ERROR、TRUEFORGE_FORMAT_ERROR。错误响应不泄露供应商异常或凭据。所有响应含 requestId，并使用 Cache-Control: no-store。

## 当前限制与 SDK 证据

依赖锁定 `@truefoundry/trueforge-sdk@0.2.1`。本地声明 `AgentSpec.d.ts` 提供 inline spec、responseFormat、mcpServers、skills、RuntimeConfig；`TurnStateDone.d.ts` 提供 requiredActions 和最终 model.message；`ModelMessageEvent.d.ts` 提供 toolCalls、finishReason、threadId。这些能力足以实现无工具理解边界。

当前采用 JSON object 输出并在服务端严格验证 ParsedIntent、字段、槽位来源；没有把 SDK 的 JSON 输出格式当作业务授权。创建和每次使用会话前校验私有会话、模型、指令、空工具/Skill、禁用搜索/沙盒/子 Agent 等配置；拒绝工具请求、待审批状态、未完成终态和与消息事件不一致的输出。25 秒超时或中断后尝试取消，不重试或切换模型。

业务回复仍由 `banking-reply.mjs` 根据可信槽位和结果生成；普通回答由外层 TrueForge 生成并通过严格类型、长度、业务编号/余额/执行结果/收益承诺检查。能力自述采用服务端 Catalog 生成文字，避免模型把不可用能力说成已实现。自然回答不进入业务展示文案覆盖分支。

金额与日历仍由已有 ParsedIntent 理解和数值/日期校验负责，实体解析由现有 Resolver 处理。普通聊天不恢复历史槽位。自动规划的理财风险、期限和流动性仍要求 API 提供显式 planningConstraints；模型不能自行填入已授权约束。真实模型可用性及性能尚需在配置完整的环境验收。

2026-10-22 已针对当前本地 TrueForge 服务实测会话配置及两轮账单请求：显式设置 sandbox.fileDownloads=false，避免服务补入默认 true 后触发严格配置比较；终态消息仅忽略 createdAt 的时间戳差异，内容、消息编号、工具调用及其他字段仍须与流式事件一致。真实“查账单”→年月澄清→“2026年8月”→账单结果已通过，不代表浏览器、其他动作或部署环境均已验收。检查记录见 [联调与验证](Banking-Agent-Integration.md)。
