# Banking Agent 请求与 Core 操作生命周期修复

日期：2026-10-22。基于远端 main `b8dc50763f1ce020d79fb1626eed6f9f36995c84`，功能分支 `fix/banking-request-lifecycle`。

## 根因

`startBanking()` 发送 START 后，wealth_result、多种只读结果、场景规则结果和 awaiting_confirmation 分支没有发送结束事件。首页把 analyzing 同时用于请求提示和输入禁用，因而即使 Core 已经执行并重新查询卡片，页面也不能继续输入。原来的卡片/转账 outcome 函数只添加消息、清理预览 ID，没有独立的操作终态。busy 只保护同类操作，也没有将回执未知、复核失败或遗失响应持久标记为待核实。

## 修改

- `src/lib/use-saveflow.ts`：所有 Agent 响应统一在 finally 中收尾；只在 generation 仍匹配且仍处于 analyzing 时发送 ANSWER。澄清和错误保留 CLARIFY / FAILED，不对预览发送 SUCCEEDED。
- `src/lib/flow-machine.ts`：复用现有 Stage 定义独立 CoreOperationStage；集中定义哪些 Core 状态阻止输入。
- `src/lib/use-saveflow.ts`：卡片、转账和理财共用 Core 操作入口；同步占用 busy 和 operationId，阻止重复确认及跨 Skill 并发。执行后的卡片/账户/交易/理财回执核验完成才进入 success；核验异常保留 unknown。取消、明确失败均撤销旧预览的执行权限。每次异步返回检查 generation，旧实例不写入新实例状态。
- `src/app/page.tsx`：输入与预览按钮统一考虑两类 busy，显示独立 Core 操作状态、原编号及只读查询入口。unknown 禁止新请求、重置和切换模式。
- `src/app/BankingCardCards.tsx`、`BankingTransferPreview.tsx`、`BankingWealthCards.tsx`：展示执行、待核实及终态标签。
- `src/lib/banking-agent-client.ts`：附加纯 UI 的 coreStage；旧试点执行桥连接失败、无效回执或未知错误均视为结果不确定。试点状态查询仅将原编号映射为 Core 编号进行只读查询，不重新决定或执行。
- `src/lib/banking-chat-storage.ts`：允许恢复理财预览/结果。正在执行、核验及未知操作随消息保存，重新挂载时保守恢复为 unknown，不恢复确认权限。
- `tests/banking-lifecycle.test.cjs`、`package.json`、`package-lock.json`：增加匹配 React 版本的 react-test-renderer，将 19 项真实 Hook/首页生命周期测试加入 npm test。

Core.prepare、Core.decide、Core.execute 及服务端安全校验均未修改。

## 验证

Windows 使用 npm.cmd 执行同名 npm scripts：

| 命令 | 结果 |
| --- | --- |
| npm test | 355 项；345 通过、0 失败、10 跳过 |
| npm run typecheck | 通过 |
| npm run lint | 通过 |
| npm run build | 通过，生产构建与静态页面生成成功 |

19 项新增测试挂载真实 useSaveflow 和首页，在进程内调用实际 Agent HTTP handler、Core HTTP handler、客户端及内存 Core；逐项断言输入框 disabled、发送按钮 disabled、Agent typing 提示、预览可确认性、操作状态和 execute 调用次数。覆盖：

1. 同页查询卡片 → 冻结 → 回执/重新查询 → 查询账单 → 解冻 → 查询卡片，并继续修改预算及交易权限。
2. 所有当前接受的只读、场景、澄清、取消、不支持和预览状态均结束请求 loading。
3. 转账预览和理财预览仍独立等待确认，执行及核验后恢复输入。
4. Core decide、execute、重新查询三个阶段均禁止重复确认、新请求、重置及切换模式。
5. API 失败、超时信号、错误状态可恢复，并能通过首页发送按钮继续请求。
6. 丢失执行响应、复核失败、pending 状态及状态查询失败不重做写操作；只查询原操作。
7. 未知结果刷新恢复、卸载中的核验、旧 Agent 响应/finally 返回均不会覆盖新实例或新请求。
8. 旧试点执行桥响应丢失后仅查询原 Core 回执，不自动再次执行。
9. 真实多轮澄清选项可以继续生成预览。

## 覆盖边界

- 未配置 DATABASE_URL，10 项既有 PostgreSQL 集成测试按原条件跳过；未验证真实数据库故障、跨进程恢复或事务连接中断。
- 模型意图使用确定性注入；未调用外部真实模型服务，也未做实际浏览器跨标签并发或视觉检查。首页组件在 React 测试渲染器中运行，非浏览器 DOM。
- 超时测试注入已中止的超时信号，不实际等待 30 秒。异常通过故障注入验证，并非真实网络断连。
- 会话恢复依赖现有 sessionStorage 的容量和保留期限；存储不可用、被手动清除或历史过期后，不保证恢复旧操作入口。服务端幂等和确认约束保持不变。
- 后端永久 pending 或历史余额/卡片状态因外部操作变化而无法与原回执对齐时，继续保持待核实，只允许查询，不自动重新执行或声称成功。
- React 19 对 react-test-renderer 输出弃用提示；不影响上述验证结果。
