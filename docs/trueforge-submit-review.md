# TrueForge 试点提交审阅说明

日期：2026-10-18；仓库：`saveflow-demo`；分支：`spike/trueforge-harness`。

当前建议：可以整理本地修复提交供审阅，PR 应保留草稿/阻塞状态。PostgreSQL 自动化和 Core 恢复已通过，但网页与 Bridge 的续接状态仍在内存，尚不满足本次完整验收标准。没有执行 commit、push、merge 或部署。

## 文件范围

工作区包含本任务开始前已经存在的 TrueForge/UI/Docker 改动。没有删除或覆盖这些既有工作，也没有将所有差异都归为本轮新增。当前完整清单见 [提交分组](verification/postgres-fix/proposed-commits.json) 和 [审计清单](verification/postgres-fix/submission-audit.json)。清单由实际 Git 差异及未追踪文件生成，只有建议，没有执行 `git add`。

本轮主要修改：

| 文件 | 目的 |
| --- | --- |
| `src/banking-core/postgres-store.mjs` | JSONB 写入单次序列化；各读取路径兼容旧字符串；月份筛选不漏旧账单；保留幂等保护 |
| `tests/postgres-persistence.test.mjs` | 新增 5 项真实 PostgreSQL 回归，包含旧格式与安全拒绝 |
| `server/mcp/saveflow-trial.mjs` | 显式启用合成 PostgreSQL MCP Core；要求稳定密钥；维持只读/预览工具边界 |
| `.env.example` | 补充服务端试点专用数据库变量，默认空值 |
| `compose.postgres.yaml` | 新增带卷的分库本地验收配置与迁移依赖 |
| `scripts/verify-docker-persistence.mjs` | 真实 MCP/HTTP、数据库容器重建、跨进程回执/账本验证及内存依赖证据 |
| `scripts/audit-trial-submission.mjs` | Git 清单、已配置秘密/凭据模式扫描、静态导出及容器边界核对、建议提交分组 |
| `docs/docker-test-report.md`、本说明及 `docs/verification/postgres-fix/` | 最新结论、完整日志、截图、脱敏证据与复跑方法 |

建议三个提交，完整逐文件列表在 JSON 清单中：

1. `feat(trueforge): add restricted query and preview trial harness`：既有 Harness、受限 Agent/MCP/Bridge、原网页卡片适配、对应测试及原试点文档/证据。
2. `fix(postgres): serialize JSONB once and support legacy records`：只含 PostgreSQL adapter 和新增数据库回归。
3. `test(docker): verify isolated PostgreSQL persistence and document continuation blockers`：Docker 文件、持久化验收/审计驱动、Docker 报告及相关证据。

`next-env.d.ts`、`tsconfig.tsbuildinfo` 虽被 Git 追踪且已有变化，属于生成文件，不建议纳入本次功能提交。本任务保留其工作区状态。`.env.local`、`.next`、`out`、`node_modules`、TrueForge 本机 SQLite 和私有诊断日志不纳入提交；`.env.local` 同时被 Git 与 Docker 上下文排除。Compose 中出现的是仅用于私有本地合成库的公开测试密码，不是生产凭据。

## 验证与风险

- 原有 PostgreSQL 189/189；新增后 194 通过、0 失败、0 跳过。
- Mock Core：187 通过、0 失败、7 个数据库专用测试跳过。
- lint、Next typegen、typecheck、Docker 生产构建通过；真实 HTTP 16 项通过；生产网页 10 次请求全部符合断言。
- PostgreSQL 容器重建和 Core/MCP 重启后保留预览、回执、余额与唯一账本条目；旧格式记录、重复模拟请求及冲突校验通过。
- 新旧卡片契约、Skill 参数和 Core 业务约束沿用原实现与全量回归。真实网页试点未扣款；只在独立合成 owner 上通过容器内 Core 模拟 100 分扣款。
- 已复现阻塞：网页 `tfm1`、账单 `tfb1` 与 Bridge `tfg1` 状态仍为独立进程 Map，重启不能恢复。当前结论为不满足完整持久化验收、不建议合并 main。
- 实际秘密扫描范围和数量以最终 [审计报告](verification/postgres-fix/submission-audit.json) 为准。配置值精确匹配与高置信凭据模式未发现泄漏；容器无 `.env.local`，实际静态导出无已配置秘密。该扫描不等于任意未知秘密或完整镜像漏洞审计。
- `main` 保持原哈希 `07d5667599601fd0b4ef97d82082362946876b8f`；工作 HEAD 保持 `eef277032ea7274d45342ba2a3b53b4f8098cf1e`。分支已有基线提交差异，提交前应按实际 PR diff 审阅，不能将其误称为本轮新增。

## 建议 PR 标题

`[Draft] TrueForge 受限试点与 PostgreSQL JSONB 修复（续接持久化待补）`

## 建议 PR 描述

```markdown
PostgreSQL adapter 预先 JSON.stringify 后再次被驱动序列化，使 operation record 成为 JSONB 字符串，跨实例后 action/fingerprint 读取错误并触发幂等冲突。本 PR 改用驱动 JSON 参数，兼容旧字符串记录及旧交易月份查询，保留冲突和回执保护。

包含 TrueForge 查询/预览试点及原网页卡片适配、Docker 运行入口、分离网页与试点 Core 的 PostgreSQL 验收配置、回归测试和脱敏证据。试点 MCP 不提供确认/执行工具，真实资金执行未开放。

验证：
- 原有 PostgreSQL 189 项全部通过；新增后 194 通过、0 失败、0 跳过。
- Mock Core 187 通过、0 失败、7 个数据库测试跳过。
- lint、Next typegen、typecheck、Docker 生产构建通过。
- 真实 HTTP 16 项及生产网页 10 次请求全部符合断言。
- 数据库容器重建、Core/MCP 重启与独立进程读取恢复回执/余额，重复模拟执行仅有一条账本记录。

合并阻塞：网页 tfm1、账单 tfb1 和 Bridge tfg1 续接状态仍保存在独立进程 Map，重启后旧凭据失效。Core 持久化通过不代表整个试点续接持久化通过。本 PR 保留草稿，补齐共享续接状态及跨实例/重启验收前不合并 main。

详见 docs/docker-test-report.md、docs/trueforge-submit-review.md 与 docs/verification/postgres-fix/。
```
