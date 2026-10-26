# Agent 错误恢复修复交付

最终验证日期：2026-10-26（Asia/Shanghai）。分支：`fix/agent-error-recovery`，基于上一轮账单修复提交 `7dd6de4`。上一轮 PR #20 仍未合并，本次以该功能分支为 PR 基线，避免把账单修复重复混入审阅范围。未合并、覆盖 main，未执行生产部署。

## 根因和完整链路

`card-skill.mjs` 在解冻正常卡片时返回 `INVALID_STATE: 卡片当前未冻结`，Core 也独立执行相同状态校验。这是合法的业务拒绝，并非网络错误。原 Card Handler 将其传为 `card_error`，HTTP 使用错误响应；客户端只为余额不足支持恢复，其他错误变成普通 ApiError。

前端 `use-saveflow.ts` 将这些错误统一送入 FAILED/error，页面只看 stage/error 和 failure/analysis，因而无条件显示“重试本次请求”，点击后重发完全相同的消息/选择。发送前旧澄清按钮已被清空；失败后没有新选项或新续接。状态机虽允许 error→START，但输入框、发送按钮及选项回调的白名单没有包含 error，造成只能重试或清空聊天的死胡同。另有部分正常订阅、理财、规则、预览分支没有结束 analyzing，也会锁住后续输入。

执行确认还有一个独立风险：Card/Transfer 的 HTTP 执行响应丢失后，确认按钮仍可能被再次激活，且新请求会删除历史转账预览，使原操作查询入口消失。本次把不确定结果的确认停用和历史查询入口一起保留下来。

现有链路仍为：用户文本/opaque optionId → askBankingAgent → handleBankingAgent → ParsedIntent 严格校验及 Dispatcher → 现有 Skill → Core.prepare → HTTP → 客户端校验 → 现有澄清卡片或预览。只有页面独立确认可进入 Core.decide/execute，错误恢复不能触发执行。

## 扩展现有错误合同

保留现有 HTTP code、data.error 和 data.recovery，增加 `category`、`retryable`、`nextAction`、`context` 字段；没有引入第二套响应协议或新框架。前端按固定机器码及结构化字段处理，且校验服务端策略必须匹配共享合同，不能伪造 retryable=true 将业务拒绝变成重试。

| 类别 | 典型代码 | 恢复方式 |
| --- | --- | --- |
| invalid_input | INVALID_AMOUNT、VALIDATION_ERROR、MODEL_FORMAT_ERROR | 修正输入；已认证草稿保留其他合法槽位，重新追问错误槽位。无重试按钮。 |
| missing_information | MISSING_SLOTS；通常直接使用 needs_clarification 状态 | 继续现有澄清补参。 |
| invalid_choice | INVALID_CHOICE、CARD_NOT_FOUND、CARD_AMBIGUOUS | 从 Repository 重新读取候选，签发新 optionId 和新 token，不重放旧结果。 |
| business_conflict | INVALID_STATE、INSUFFICIENT_BALANCE、PREVIEW_STALE | 解释状态，提供符合当前条件的候选或输入修正；没有候选时明确说明并允许新查询。 |
| restricted | FORBIDDEN、LIMIT_EXCEEDED、SUITABILITY_FAILED 等 | 解释限制、关闭直接重试，清除不可继续的续接；仍可进行其他查询。 |
| session_expired | CONTINUATION_INVALID | 丢弃旧 token，重新描述当前业务；不清空聊天，不把失效 token 作为授权重新签发。 |
| transient | NETWORK_ERROR、MODEL_TIMEOUT、TRUEFORGE_UNAVAILABLE 等 | 允许用户主动安全重试理解/查询/预览阶段，不自动重试。 |
| internal | 未知或未分类故障 | 默认禁止重试执行，提示修改或新请求。 |

只要已经进入页面写操作阶段，结果不确定时下一步都是查询原 operationId，而不是重新执行。保留忙碌互斥、原编号、预览哈希、步骤确认和 Core 幂等检查。不确定操作未核实前，其他读取和聊天可继续，但新的写操作不能确认。查询确认原操作仍在 awaiting_confirmation/confirmed 时，才可由用户重新核对并使用原预览继续。

## 恢复行为与安全边界

- 解冻正常卡片时解释“当前处于正常使用状态，无需解冻”；只向用户提供当前已冻结的其他卡片。没有候选时引导输入“查看我的卡”，不显示无效重试。
- 无效序号、模型无法完成当前澄清或无效 optionId 都保留已认证操作及必要槽位，重新生成选项。当前数据变化后再次校验操作资格；旧选择不能作为绕过 Core 的授权。
- 真实完整的新业务可直接切换；过期续接只能安全重启。跨工具/动作的 token 不匹配仍保留 `CONTINUATION_ACTION_MISMATCH`，不会因恢复机制变成普通选择。
- 所有 Agent 请求在 finally 中释放 analyzing；canStart 与状态机保持一致。错误后输入框可用，用户无需清空聊天。
- 待核实预览及查询按钮不会被新消息、演示重启或普通历史截断删除；刷新恢复的记录只用于查询，不恢复执行权限。该标签页中有待核实操作时，保留其记录超过普通聊天的 30 分钟期限，核实后恢复普通保留规则。
- 排查发现旧场景规则是“聊天确认保存直接执行”的例外。本次按任务的统一确认要求关闭该入口，改为现有卡片风格的页面确认、取消和状态查询；Skill 公共接口、Core 请求、执行协议和规则合同均未改变。HTTP 通用字段转换后的规则回执还原为原有领域字段，再进行严格校验。
- 未增加依赖，未更改原始 seed，未放宽确认、风险或实体来源校验。恢复数据中不接受 confirmed、riskLevel、operationId 等执行授权字段。

## 修改文件

| 文件 | 主要改动 |
| --- | --- |
| `src/lib/agent-error-policy.mjs` | 各 Skill 共用的错误类别、下一步、重试及恢复槽位白名单；未知错误默认拒绝重试。 |
| `server/banking-agent.mjs` | 在既有 error 中补充结构化恢复策略，并兼容新旧 recovery token 位置。 |
| `server/banking-orchestrator.mjs` | 从可信数据重新生成澄清、处理当前状态冲突、保留已知槽位；严格拒绝跨工具 token；禁止聊天确认执行规则。 |
| `server/banking-intent-parser.mjs` | 明确候选无法匹配时继续当前澄清，非法金额不得沿用旧值。 |
| `server/banking-reply.mjs` | 恢复提示不重复叠加同一错误。 |
| `src/agent/runtime.mjs` | 已知业务异常保留原代码，不笼统降级为 skill_error。 |
| `src/agent/handlers/card-handler.mjs` | 选择失败给出重新选择提示；传递服务端已解析的卡片引用，供可信状态解释。 |
| `src/lib/banking-agent-client.ts` | 校验和处理通用 recovery，校验策略与代码匹配；拒绝非法恢复槽位或携带执行字段的恢复信息。 |
| `src/lib/use-saveflow.ts` | 统一释放 loading、恢复选项、控制重试；无清空聊天的业务重启；不确定写结果先查询，保留预览和互斥。 |
| `src/lib/banking-chat-storage.ts` | 保留待核实记录、查询上下文及理财消息类型；恢复不授予执行权限。 |
| `src/app/page.tsx` | 按结构化策略显示重试或业务重启；复用已有组件和样式。 |
| `src/app/BankingCardCards.tsx`、`src/app/BankingTransferPreview.tsx` | 不确定结果显示待核实，确认停用，查询入口保留；旧执行桥同样先查询原 Core 编号。 |
| `src/app/BankingReadCards.tsx` | 为已有规则预览增加页面独立确认、取消、查询；新增可选 props，原调用保持兼容。 |
| `src/lib/api/banking-client.ts` | 校验规则回执，恢复 HTTP 字段转换后的原规则结构；不改变 Skill 或 Core 公共接口。 |
| `tests/agent-recovery.test.cjs`、`tests/fixtures/saveflow-hook.cjs` | 16 项稳定恢复/安全回归及 1 项可单独启用的真实模型连续交互测试。Hook 测试替换 React 调度，HTTP、客户端、Skill、Core 均使用真实实现。 |
| `tests/e-agent.test.mjs`、`tests/trueforge-preview-client.test.cjs`、`package.json` | 同步页面确认与状态查询预期，将恢复测试纳入默认测试。 |
| `docs/verification/agent-recovery/*` | 保留安全的响应摘录、检查结果及前阶段浏览器截图；不记录密钥、完整模型输出或访问码。 |

## 验证结果

| 检查 | 最终结果 |
| --- | --- |
| `npm test` | 366 项：354 通过，0 失败，12 跳过。10 项为未配置 PostgreSQL，另 2 项为默认关闭的真实模型测试。 |
| `npm run typecheck` | 通过。 |
| `npm run lint` | 通过。 |
| `npm run build` | 通过。 |
| `npm run verify:natural-language` | 已配置的真实 TrueForge，31/31 通过；固定日历与其他边界日期由用例明确注入。 |
| `$env:SAVEFLOW_VERIFY_LIVE_RECOVERY='true'; node --env-file=.env.local --test tests/agent-recovery.test.cjs` | 17/17 通过。其中 16 项为稳定注入理解/技术故障的合同测试，最后 1 项为真实 TrueForge→HTTP→真实 Hook 的连续恢复测试，不能将其余 16 项称为真实模型测试。 |
| `$env:SAVEFLOW_VERIFY_LIVE_BILL='true'; node --env-file=.env.local --test tests/banking-bill-contract.test.cjs` | 8/8 通过，其中最后 1 项为真实模型账单全链路，原多月修复不回归。 |

恢复用例覆盖：解冻正常卡片、有/无可用候选、无效序号及伪造选项、模糊名称、多轮无法理解后继续、过期 token、非法金额修正、风控拒绝、临时网络错误、写操作响应丢失/重复点击、失败后新查询、候选状态变化、其他 Skill 错误、待核实记录的重启/刷新、规则独立确认及查询回执。

响应丢失测试先让真实 Core 执行成功，再让 HTTP 客户端收到网络异常，断言只能查询原结果；重复点击及新预览都不能再执行，原账上只有一笔交易。

真实后端合同响应摘录：[response-summary.json](verification/agent-recovery/response-summary.json)。这里使用注入 ParsedIntent 稳定复现业务错误，未声称它是模型输出；token 已省略。前阶段在隔离的 `127.0.0.1:3001` 使用真实 TrueForge 验证正常卡片解冻错误后输入仍可用、无重试按钮，并继续进入卡片选择和无效序号恢复；[截图](verification/agent-recovery/business-conflict.png)。最终规则页面流程由 HTTP/Hook/组件渲染测试验证，本轮没有重复完整浏览器验收。

## 尚未验证与部署

没有真实银行接入；风控限制通过 Core 返回结构化 FORBIDDEN 的测试注入验证，不能声称已通过真实银行风控验收。PostgreSQL 的 10 项测试未运行；跨进程/重启后查询原操作依赖已配置持久化，内存模式不能恢复服务端已丢失的操作记录，前端不会据此盲目执行新写操作。浏览器存储被用户主动删除或标签页关闭也不提供跨设备恢复能力。

未执行生产发布，未重启用户原先的 3000 服务或清空其模拟状态。原服务若仍缓存旧后端模块，需由正常发布/重启流程加载本次代码；仅前端热更新不足以加载完整后端修复。规则 UI 新增的是可选回调及现有 Core 操作，没有要求其他成员迁移 Skill 接口；合并时需保留此独立确认入口，不能恢复聊天确认执行。
