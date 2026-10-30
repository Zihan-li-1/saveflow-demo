# 只读规划第一阶段验证记录

本文保留最初显式规划阶段的记录。后续已接入自动语义路由、HTTP 客户端及前端完整展示，并通过真实 TrueForge 验收组；当前结果以 [统一自然对话交付记录](Unified-Conversation-Routing.md) 为准。

## 当前可复现结果

- 基于 `origin/main` 的 `ca200bd`，在合成数据和正式内存 Repository 上运行 `node --test tests/read-only-planner.test.mjs`：10 项通过。
- `npm test` 已纳入新增规划测试：629 项中 615 项通过、14 项因外部环境未配置而跳过、0 失败。回归组覆盖会话续接、页面生命周期、卡片、互转、Banking Runtime 和 TrueForge Skill 试点。
- `npm run typecheck`、目标文件 ESLint 和 `npm run build` 通过。

以下是自动化测试中的**传输层桩轨迹，不是实际模型输出**。桩每轮只能看到当轮传入的 JSON，第二轮断言真实 `bill.summary` 返回的 `month` 后才选择订阅工具：

| 轮次 | 输入中的已完成工具观察 | 本轮选择 | 服务端结果 |
| --- | --- | --- | --- |
| 1 | 无 | `bill.summary({month:"2026-08"})` | 正式账单 Handler 返回 `transactionCount=12`，附 `synthetic_demo_only` 证据 |
| 2 | `bill.summary` 的实际结果，`month=2026-08` | `subscription.list({})`，依赖上一账单步骤 | 正式订阅 Handler 返回已验证结果 |
| 3 | 账单和订阅结果 | `task_control.finish`，引用两项工具 | 服务端映射为可信步骤 ID，并结束只读任务 |

这条轨迹证明循环的服务端实现会在下一轮送入前一工具结果；它尚不能证明真实 TrueForge 模型会作出同样选择。

## 真实模型验证状态

最初仅检查此目录配置时没有发现可用环境，原脚本记录为未执行。后续沿部署脚本找到 `../saveflow-demo/.env.local` 回退配置，已用隔离的内存模拟 Core 实测统一路由与自动规划。逐轮工具和实际状态见 `docs/evidence/conversation-routing-live.json`；未保存凭据或模型会话 ID。

## 当前限制

- 原阶段的规划模式勾选框已移除，当前由 TrueForge 外层语义路由自动判定。
- `wealth.recommend` 需要用户在 `planningConstraints` 中明确提供风险、期限与流动性，页面目前尚无结构化输入表单；否则网关拒绝该工具。`wealth.compare` 可以按正式产品称谓调用。
- 规划结果中的模型分析文字是解释，不作为可信金额或实体来源。卡片数据来自经过校验的 Repository/Skill 返回值。规划结果不授权写操作。
