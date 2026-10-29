# ConversationState HTTP 与前端接入（P2-3 / P2-4）

`handleBankingAgent()` 在鉴权、请求大小及来源检查后建立 ConversationState。`server/banking-conversation.mjs` 管理请求与任务关联，`banking-orchestrator.mjs` 仍运行原来的 TrueForge/ParsedIntent、Resolver、Skill、Core.prepare 链路。没有新的意图规划器，没有修改 Skill 公共接口。

## 请求和响应

既有请求字段不变，增加：

| 字段 | 用途 |
| --- | --- |
| conversationToken | 服务端生成的不透明会话令牌。不能提交内部 conversationId。 |
| conversationRevision | 客户端最后看到的版本；不匹配时返回 409。旧调用方可暂不发送，但仍受服务端互斥与最新续接凭据校验。 |
| taskId | continue/resume 时匹配原任务；显式 resume 必须提供。不是执行授权。 |
| taskMode | auto（默认）、new、plan、continue、resume、sync。`plan` 仅进入只读规划循环。 |

首次正常请求不带会话字段，返回 `data.conversation`：token、revision、expiresAt、currentTask、suspendedTasks、operationReferences。任务摘要仅含 taskId、action、status、expiresAt；操作摘要仅含 operationId、taskId、coreState。没有向浏览器返回权威槽位快照、已选实体、确认决定或执行权限。

成功结果、澄清、已建立会话中的可恢复错误都返回该元数据。鉴权失败、无效/过期会话等不能建立可信关联的路径不回显可用会话令牌。前端同时严格校验元数据结构、任务/状态枚举、容量、未知字段和响应会话归属；业务账单金额及证据校验保留。

`use-saveflow.ts` 保存实际响应中的会话令牌与 revision；业务消息、选项、储蓄表单、预览编辑使用对应 taskId 和 continuationToken。新增卡片式“待继续业务”入口，可恢复挂起任务或重新核验会话，保留原页面风格。

`sync` 是同一已鉴权 POST 入口的只读会话核验：必须提供 conversationToken，不能附带 message、choice、planInputs、taskId 或 continuationToken。不调用模型、prepare、decide 或 execute；读取服务端会话及其原 Core 操作状态，返回 `OK / conversation_state` 与 `data.conversation`。客户端严格要求 sync 返回该状态，不能把业务结果当作核验结果。

## 任务边界

- 无 continuationToken 的请求按新业务理解，不发送其他任务 history 或槽位；合法意图成为新任务，仍有效的旧任务挂起。
- new 明确忽略顺带提交的旧 continuationToken；同 action 的新业务也得到新 taskId，不继承旧账户、收款人或预览。
- auto 带有效 continuationToken 时续接其当前任务。如果模型提出不同 action，服务端会再次独立理解原消息，不传旧草稿、选项或历史；两次 action 不一致时拒绝，确认新动作后才挂起原任务并创建新任务。
- continue 不能靠模型输出切换 action。ParsedIntent 不允许模型指定会话、taskId、Core operationId 或 confirmed。
- resume 必须提供当前会话令牌、原 taskId 和该任务最新的有效 continuationToken；检查归属、可恢复状态、期限及 Core 状态后恢复。支持挂起任务，也支持刷新后重新关联当前任务。只提交恢复指令时，服务端重跑原 Resolver/Skill 流程，重新查询实体并生成新的正式预览；不自动确认或执行。

## 浏览器刷新和显示快照

标签页 sessionStorage 沿用 `saveflow.banking-chat.v1` 键，快照升级为 version 2，并兼容旧 version 1。只保存显示消息、服务端生成的不透明会话令牌和每个任务的续接引用。revision、当前任务和挂起状态必须来自新的服务端响应；缓存中的 previewCurrent、historySnapshot 或 confirmed 不能恢复确认权限。

刷新后的数据流：显示只读历史 → 重新输入访问码并授权 → 点击“核验并恢复会话”（或发送新消息时先核验）→ sync 返回权威会话摘要 → 用户点击“继续/恢复业务” → 服务端验证原续接并重新解析实体、生成新选项/正式预览。单独 sync 不激活旧预览，也不会自动重发任何写操作。

访问码、API Key、服务端签名密钥和授权勾选不写入浏览器存储。快照序列化只保留明确的显示/导航字段。已有 P2-3 消息中的会话元数据可迁移出不透明令牌和任务引用，但仍须重新鉴权及 sync。新会话不重复发送其他任务的聊天快照作为槽位来源。

“开始新业务”保留聊天记录并发出 new 请求建议；实际任务转换仍由服务端决定。令牌失效或服务端进程重启后显示重新开始入口，不要求清空聊天。当前会话存在未知执行结果时保留原操作查询入口，缓存记录不能直接触发 execute。Core 状态与银行身份仍由 Core API 校验。

## 续接和并发

继续复用 AES-GCM continuationToken。其认证载荷增加 conversation `{token, taskId}`；Task 只记录最新 tokenId。旧版本、其他任务的令牌和挂起任务的隐式续接被拒绝。错误后重新生成选项并签发新凭据时，同样更新最新 tokenId。

为兼容现有调用方，已绑定的加密 continuationToken 可提供会话选择令牌；如果请求同时提供 conversationToken，必须与载荷一致。不会从无绑定旧令牌或客户端快照建立权威会话。HTTP 会话凭据与 MCP 试点凭据不能跨入口交换；MCP 自身继续使用原共享校验与编排规则。

同一会话的 HTTP 处理在模型/Skill/Core.prepare 之前互斥，结束和异常都释放。处理中的重复请求返回 `CONVERSATION_BUSY`（不是成功）。P2-5 为已接受且成功的业务请求保存每会话至多一份结果：完整请求的规范化指纹必须一致，且服务端仍处于该结果的 revision、会话和任务仍有效，才能返回原响应、原续接凭据和原预览，不重复理解或 prepare。请求须携带 revision 或绑定续接凭据；不同请求使用旧 revision、不同会话/任务替换以及后续转换后的旧请求仍拒绝。复用预览前按原编号读取该任务所有 Core 引用；若状态改变或预览过期，不复用原结果，保护态返回原操作查询指引。首次响应尚未取得会话令牌时的网络丢失不能提供跨请求去重，此时只能重新理解/生成预览，仍不会执行任何金融操作。

P2-5 修复明确恢复指令：前端对“继续刚才的转账”等有限、完整匹配的导航指令，使用最新服务端摘要中的唯一有效转账与本标签页原凭据发出既有 `resume` 请求，不将指令交给模型重建任务。没有唯一匹配或缺失凭据时，提示使用任务面板选择，不猜测归属；这不承诺任意措辞的历史任务检索。

## Core 安全

编辑/恢复时按原 operationId 查询任务的 Core 引用；新写任务也检查会话内未完成引用。confirmed、executing、unknown、checking 等状态阻止模型修改/再次提交，并返回原编号、uncertain 和 query_status 指引。已有成功操作的任务也不能继续改成另一笔操作。独立账单等读取仍允许进行。

每次修改金额、收款人、付款账户都重新经过解析、合同校验、实体解析与 Core.prepare；pendingPreview 只绑定经 Core 读取验证的正式引用。原操作引用保留。聊天确认仍返回 CONFIRMATION_REQUIRED，不进入 decide/execute；这些能力仅由现有页面确认和 Core API 使用。

Store 按配置身份和 Core 实例隔离，驻留当前本地进程；进程重启或跨进程续接明确失效。本阶段没有数据库、Netlify 多实例或部署适配。

## 验证

`npm run test:conversation-http`：真实本地 HTTP → handleBankingAgent → orchestrator/Skill → 模拟 Banking Core，并包含真实 askBankingAgent 的响应校验。自然语言理解使用合同注入；executing/unknown 使用可信 Core 读取替身，其余预览、确认及资金状态来自实际模拟 Core。不能将这些用例描述为真实模型测试。

旧回归用例相应改为：同进程续接、跨进程拒绝；HTTP/MCP 凭据隔离；旧令牌重放拒绝；语言风格比较剔除每次请求新生成的会话元数据。没有降低金额、实体、预览和证据校验断言。

P2-3 基线验证（2026-10-26）：`npm run test:conversation-http` 13/13，`npm run test:conversation-state` 24/24；当时 `npm test` 共 451 项，439 通过、0 失败、12 跳过。

P2-4 增加 React 页面/Hook、浏览器存储和 sync HTTP 回归。真实 Chrome 验证命令为 `npm run build`，然后设置可用的外部 `PLAYWRIGHT_MODULE` 并运行 `npm run verify:conversation-ui`；Playwright 不属于应用依赖。本地测试 host 使用独立端口、固定模拟身份、实际 Banking Agent/模拟 Core 和注入的理解结果，阻止对其他来源的浏览器请求，不读取真实模型密钥。证据在 `docs/verification/conversation-ui/checks.json`；实际完成的 8 项浏览器验证不能描述为真实模型测试。

本地运行请使用 `npm run dev:qwen`，该自定义 Node 服务提供真实 Banking API。单独的静态构建只验证前端产物，不能承载进程内 Store。刷新必须仍连接同一服务端进程；sessionStorage 仅限当前标签页，关闭标签页或服务端重启可能需要重新建立业务。仍不包含长期记忆、PostgreSQL、多实例或生产部署适配。

P2-4 最终验证（2026-10-26）：`npm test` 共 459 项，447 通过、0 失败、12 跳过；`npm run typecheck`、`npm run lint`、`npm run build` 均通过。12 项跳过为 10 项 PostgreSQL 未配置，以及 2 项真实模型专项未启用，均未计为通过。React 页面生命周期测试 24/24、存储专项 3/3、HTTP 会话专项 14/14。外部 Playwright 工具与本机 Chrome 实际运行 8 项浏览器场景，全部通过且 pageErrors 为 0；模型理解使用注入合同。执行后响应丢失通过浏览器网络层在实际 Core 提交后中断响应实现，刷新后只查询原编号，没有新增执行或重复入账。

仍需人工验收：接入真实 TrueForge 后的自由措辞、多设备尺寸和实际运行浏览器中的人工交互。上述真实模型专项与人工验收均未验证，不属于浏览器 8 项通过范围。本轮没有提交、推送、合并或部署。
