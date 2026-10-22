> 历史 MCP 试点/专项记录：文中的句式路由、SAVEFLOW_TRUEFORGE_* 开关、tfm1/tfb1 续接和部署结果不适用于当前 `/api/banking-agent`。独立适配器及执行桥按原合同保留；当前统一入口与限制以 [Banking Agent API](Banking-Agent-API.md) 为准。

# 零余额账户导致转账预览失败的排查与修复

2026-10-17，本地 spike/trueforge-harness。先读取截图对应的真实 TrueForge 事件，再修改。未改 .env.local、Mock 种子、Banking Core、资金余额、数据库迁移；未提交或部署。

## 实际原因

用户两次真实会话（UTC 11:42、11:43）的参数都是给王先生转 **50000 分**，不是金额被错误放大。账户选择的 optionId 都对应 **模拟储蓄账户**；之后选择了房东王先生（****1003）。储蓄账户的模拟可用余额为 **0 元**；模拟活期账户为 **5000 元**。因此 Core 的 INSUFFICIENT_BALANCE 是正确拦截。

证据：[用户原始脱敏事件](verification/balance-recovery/user-before-events.json)。可将账户选择调用的 optionId 与其前一次工具结果 choices 对照。账户原始余额来自 src/data/saveflow_mock_data.json，经 repository 转换为整数分；不是从模型回复推测。

真正的交互缺陷是：原账户选项只显示名称，不显示余额；工具失败后适配器只返回通用错误，已选择的收款人没有可继续使用的新凭据，页面进入不可输入的 error 状态。旧澄清卡片的按钮在选择后清空是历史失效处理，但没有新恢复卡片接替，用户无法改正账户。

## 修复

- **server/banking-orchestrator.mjs**：账户选项在现有 label 字段内显示来自同一 repository 的真实可用余额；rawValue、entityId 和选择校验保留。Core 拒绝余额不足后，仍返回原错误状态/错误码，只额外签发具有原 action/slots/selections 的恢复凭据与新账户候选。金额和已确认的房东 ID 保留，不自动选活期账户，不伪造正式预览。
- **server/banking-clarification-parser.mjs**：明确的金额修改可以在重新选择账户期间更新 amount，并保留其他签名 selections。无须丢弃原凭据、重新猜收款人。
- **server/mcp/trueforge-token-bridge.mjs**：仅允许 transfer_preview 的 INSUFFICIENT_BALANCE 恢复结果交换短别名；仍是 isError/ok=false，别名仍绑定工具与有效期，禁止跨工具使用。没有新增执行能力。
- **server/trueforge-skill-adapter.mjs**：仅从已关联且参数匹配的真实工具错误中校验恢复结构，再发行作用域隔离的 tfm1；HTTP 仍为 **400 / INSUFFICIENT_BALANCE**，data.status=error，恢复提示位于 data.recovery。正常结果卡片规则不变。续接修改始终使用 MCP 的签名状态，不再用展示标签重建账户/收款人。
- **src/lib/banking-agent-client.ts**：对上述错误的恢复结构进行严格验证，使用专用 ApiError 子类传递。拒绝伪造 operationId、错误 action、原始 Session ID、空候选等；恢复不是成功响应。
- **src/lib/use-saveflow.ts**：展示明确错误原因和新的账户选择卡片，恢复可输入状态与该业务流的最新凭据。更换账户或修改金额后继续原业务流，保留消息历史。不会自动重试失败的 prepare，更不会执行转账。

测试修改：tests/banking-clarification.test.cjs、tests/trueforge-skills.test.mjs、tests/trueforge-preview-client.test.cjs。新增 scripts/verify-transfer-balance-ui.mjs；事件提取脚本 scripts/inspect-trueforge-transfer.py 补充嵌套 MCP error[].text 内 JSON 的凭据脱敏。

## 真实验证

[完整网页/HTTP 报告](verification/balance-recovery/report.json)、[真实工具调用与结果](verification/balance-recovery/trueforge-events.json)、[已断言的事件摘要](verification/balance-recovery/trace-checks.json)。本地 Chrome → 原 HTTP → TrueForge 0.3.1 / SDK 0.2.1 → DeepSeek → Bridge → MCP → Core.prepare，没有用模拟 Agent 替代。

1. 给王先生转500元 → 账户列表显示活期5000元、储蓄0元 → 明确选择储蓄 → 选择房东 → HTTP400，未生成任何预览，页面展示真实余额和新账户选项，输入可用。
2. 只重新选择活期 → 同一 TrueForge 转账 Session 返回 **50000 分正式预览**，fromAccountId=ACC-CHECKING、payeeId=payee_003，无须再次选房东。
3. 改成6000元 → 仍 HTTP400，不制造成功卡片 → 改成400元 → **40000 分新预览**，账户和房东不变。
4. 查看日常虚拟卡 → 返回原转账修改300元 → **30000 分新预览**，跨 Skill 状态隔离仍正常。
5. 聊天确认403，直接 /api/banking execute 403，取消不执行；三张真实历史预览保留，无浏览器脚本错误。

最终共 2 个受限 Session：原转账7次工具调用（包括2次真实 Core 拒绝）、卡片查询1次。所有恢复调用的 token 摘要与上次真实结果对应；三个成功预览的余额前值均为500000分，未扣款；没有确认或执行工具调用。[恢复提示截图](verification/balance-recovery/insufficient-recovery.png)、[预览截图](verification/balance-recovery/recovered-preview.png)。

`npm.cmd test`：**189 项，187通过、0失败、2项 PostgreSQL 集成跳过**（未提供测试数据库）。[完整日志](verification/balance-recovery/tests.log)。lint、typecheck、git diff --check 通过。没有执行 PostgreSQL、真实资金操作、Netlify build 或部署。

本轮为加载 mjs 更新重启了本地 HTTP/MCP/Bridge。刷新网页后可重新发起明确的转账请求，历史仍保留；选择“模拟活期账户（可用 ¥5000.00）”即可预览500元。旧服务进程的续接凭据可能失效，不能从其旧选项继续。

服务端会话仍是单进程 TTL 存储，两个 Core 仍独立；确认执行仍未开放。本次修复没有增加余额、忽略余额验证、猜测实体 ID、重放旧执行或放宽跨 Skill/HMAC 校验。
