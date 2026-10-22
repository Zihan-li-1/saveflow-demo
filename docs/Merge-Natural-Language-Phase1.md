# 第一阶段提交与主分支合并

当前分支：`feat/unified-trueforge-banking-runtime`。第一阶段实现提交为 `d53a16f`；合并基准为最新获取的 `origin/main`：`c88ad2f`（此前缓存停留在 `9dc09e9`）。最初直接连接 GitHub 失败，随后使用系统已有代理完成 Git 拉取，未修改全局代理配置。

实际解决 7 个文件的合并冲突：

- `package.json`：同时保留主分支新增的理财、商务及客户端测试与本阶段自然语言测试。
- `server/banking-intent-parser.mjs`：合并新增 Wealth 动作、原有确认约束，以及本阶段金额、日历、候选选择契约。
- `server/banking-orchestrator.mjs`：保留订阅洞察和 Wealth 解析/正式预览；所有自由文本补参继续交给模型，结构化候选保留服务端校验。未恢复主分支的固定文本解析捷径。
- `src/agent/parsed-intent.ts`：保留 Wealth 类型、目标结构化金额/截止日期及可选候选选择字段。
- `src/agent/validate-parsed-intent.mjs`：同时保留 Wealth Skill 校验与本阶段数值、日历、目标澄清校验。
- `src/banking-core/contracts.ts`：保留 Wealth 操作类型和旧计划的结构化截止日期记录。
- `src/lib/bill-display.ts`：同时保留分类比较数据和缺数据月份状态。

自动合并的转账凭证、修改入口、订阅分析、理财业务、持久化等变更由扩展后的全量回归覆盖。主分支新增的 R2 补参测试改为提供带草稿上下文的模型桩，并明确验证首轮、补参均调用模型，没有以测试桩冒充真实语义验收。

## 合并后验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全量自动化 | 323 通过、0 失败；宿主跳过 10 项数据库测试 | [日志](verification/natural-language/merge-tests.log) |
| 隔离 PostgreSQL 集成 | 10/10 通过，包括主分支新增 Wealth 持久化回归 | [日志](verification/natural-language/merge-postgres.log) |
| 类型 / Lint / 构建 | 通过 | [类型](verification/natural-language/merge-typecheck.log)、[Lint](verification/natural-language/merge-lint.log)、[构建](verification/natural-language/merge-build.log) |
| 真实模型 | 26/26 场景通过，30 次真实理解调用，核对查询/预览参数 | [参数证据](verification/natural-language/real-model.json)、[日志](verification/natural-language/merge-real-model.log) |

真实模型复测曾暴露一例跨年错误：本地日期为 2027-01-01 时，模型误用了 UTC 瞬间中的 2026 年。保留该次 [失败证据](verification/natural-language/merge-real-model-before-clock-clarification.json)。修复只加强提示词中本地 `calendar.currentDate` 的权威性，不通过原文规则重写模型结果；最终完整复测全部通过。

测试使用合成数据与临时数据库，测试容器和临时数据库已清理。未合并 GitHub PR，未发布或部署；独立 Qwen 服务与浏览器手动交互的既有未验收限制仍适用。
