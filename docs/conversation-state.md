# ConversationState 核心模块（P2-2）

本模块在 P2-2 建立，P2-3 已通过 `server/banking-conversation.mjs` 接入真实 Banking Agent HTTP 链路。既有 continuationToken 加密、解密、选项校验与 Skill/Core 边界继续复用；新增会话/任务绑定与最新 tokenId 记录。接口细节见 `conversation-backend.md`。不实现数据库、多实例和部署适配。

## 接口与信任边界

`server/conversation-state.mjs` 导出 `createConversationStore(options)` 和只包含安全错误码的 `ConversationStateError`。类型与 Store 接口位于 `server/conversation-state-types.ts`，现有 typecheck 会检查 JS 实现。

- `create()` 不接受客户端 ID 或初始化状态，生成独立内部 conversationId 与 32 随机字节的 `cs1.*` 不透明令牌。Store 仅保存令牌 SHA-256 摘要；内部 ID 不能用于读取状态。
- `read(token)` 返回隔离快照，并惰性处理过期。
- `transition(token, expectedRevision, command)` 只接受已注册命令，校验后原子发布；没有任意 put/patch 接口。异步 Core 读取后再次核对 revision、会话/任务有效期和操作归属。
- `cleanup()` 清理过期会话、对应操作绑定、挂起过期任务，并将当前过期任务标记 expired。没有后台定时器；create 自动清理，后续宿主也可定时调用。

令牌是会话选择凭据，不是银行身份或执行授权。后续 HTTP 层仍须鉴权，并避免将令牌写入日志。任务输入只能来自服务端已有校验/Resolver 边界；本模块复用 ParsedIntent 合同检查结构，不替代实体解析、来源检查或 Core 业务校验。不可把请求或完整模型输出直接当成已核验状态。

## 数据

ConversationState 包含 conversationId、currentTask、suspendedTasks、verifiedSlots、pendingPreview、operationReferences、revision、createdAt、updatedAt、expiresAt。

每个任务包含 taskId、action、status、resumeStatus、verifiedSlots、pendingSlots、continuationExpiresAt、previewOperationId、operationReferences、revision 及创建/更新时间。槽位和 pendingPreview 是当前有效任务的投影；挂起任务保留自己的草稿和预览引用。已结束的当前任务在被新任务替换前可见，结束或过期的挂起任务从恢复列表移除；已绑定 Core 操作引用保留到会话过期，不因任务结束而删除。

pendingPreview 只保存 operationId、taskId、previewHash、stepIds、expiresAt、coreState。operationReferences 另含 action 和 observedAt；coreState 是最后一次 Core 读取结果，不宣称实时状态。模块不保存完整交易效果、确认标志或执行权限。

## 转换

| 命令 | 规则 |
| --- | --- |
| start_task | 服务端生成 taskId；根据合法 ParsedIntent 进入 ready 或 awaiting_input。已有有效任务时必须显式 suspendCurrent，否则拒绝。 |
| update_task | 只能修改当前有效的同 action 任务；完整替换已校验草稿，重新计算待补参数，清除当前预览关联，保留原操作查询引用。 |
| suspend_task / resume_task | 显式按 taskId 挂起/恢复；恢复不延长续接期限。跨会话、已结束、已过期任务不能恢复。 |
| end_task | 只接受 completed/cancelled。缺参数或仍有未核实最终结果的 Core 引用时不能声明 completed。取消对话不等于取消 Core 操作。 |
| attach_preview | 只接收 taskId、operationId；通过宿主注入的只读 readCoreOperation 向 Core 取证。必须是同动作、尚有效的 awaiting_confirmation 正式预览，且该操作未绑定其他任务/会话。不能传 previewHash、预览内容或 Core 状态。 |
| observe_operation | 只查询已绑定编号，记录可信状态；当前预览取得最终结果时结束任务，同一任务的旧预览已经成功也会结束任务，避免再改成另一笔操作。不会复活已取消或过期的任务。 |
| set_continuation | HTTP 编排器记录原加密机制实际签发的最新 tokenId 和有效期，必要时标记待补参数；不接受 tokenId 代替原令牌认证，也不重新实现签名或选项解析。修改草稿使旧 tokenId 失效，挂起/恢复不会赋予其他任务使用该凭据的能力。 |

readCoreOperation 可直接适配 `core.getOperation(id)`。Store 不持有 prepare、decide 或 execute 能力。预览到期只清除 pendingPreview 投影，不虚构 Core 已取消；用户修改/挂起/结束任务也不会改变 Core 状态。

每个成功命令增加会话 revision，任务变化也增加任务 revision。过期引起的可见状态变化同样增加 revision。预览绑定的异步读取使用提交前比较并交换；同版并发提交仅一个能成功，无部分写入。失败不会发布草稿；已到期状态的清理仍然生效。

## 生命周期和容量

默认会话绝对有效期 30 分钟，任务续接默认 5 分钟，服务端可指定不超过 30 分钟且不超过会话期限的 continuationExpiresAt，兼容储蓄表单期限。读取、恢复和普通更新不自动续期；需要续期时必须由服务端命令明确提供期限。

默认最多 500 个会话、每会话 25 个当前/挂起任务、100 个操作引用。容量满时明确拒绝，不淘汰仍可用任务或未核实操作。进程重启后旧会话令牌失效，不从浏览器缓存恢复权威状态。Core 操作仍按其自己的存储和编号查询。

主要错误：CONVERSATION_NOT_FOUND / EXPIRED、TASK_NOT_FOUND / EXPIRED、REVISION_CONFLICT、INVALID_INPUT / TRANSITION、ACTION_MISMATCH、各类 CAPACITY、CORE_UNAVAILABLE、INVALID_CORE_REFERENCE、OPERATION_ALREADY_BOUND。实际错误码均使用完整 CONVERSATION_ 前缀，不包含令牌、参数值或财务数据。

测试：`npm run test:conversation-state`；默认 `npm test` 同时包含本模块测试。预览用例使用真实模拟 Banking Core，只有畸形上游和并发时序用例注入只读替身；不调用真实模型。
