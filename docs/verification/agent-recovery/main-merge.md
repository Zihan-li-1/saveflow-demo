# 同步最新 main 与冲突解决

日期：2026-10-26，Asia/Shanghai。

推送前工作区干净，功能分支 `fix/agent-error-recovery` 与 GitHub 均为 `ec833dc`。检查发现 main 已前进到 `5aacc64d8a996bf7ea66042263b5ba8d24372a5c`，共同祖先为 `b8dc507`；上游新增 12 个提交。原 PR #28 对旧功能基线可合并，但旧账单 PR #20 对 main 已有冲突，因此本次将最新 main 合入当前功能分支，并将 #28 的比较基线改为 main。

实际处理 12 个文件的文本冲突：`package.json`、`server/banking-agent.mjs`、`server/banking-orchestrator.mjs`、`src/agent/runtime.mjs`、四个账单/卡片/只读/转账组件、`src/app/page.tsx`、`src/lib/banking-agent-client.ts`、`src/lib/banking-chat-storage.ts`、`src/lib/use-saveflow.ts`。

- 保留 main 的储蓄目标与分类收支表单、储蓄建议验证、卡片管理页、余额提醒、订阅识别说明，以及账单变化解读。
- 保留本分支合法 unavailable 月份和 IANA 时区校验、严格金额/证据验证、结构化错误恢复、服务端新选项与续接、规则页面独立确认。
- 采用上游统一 Core 操作生命周期、同步互斥和请求代次校验，避免执行期间切换请求或迟到响应覆盖状态。按原恢复需求，unknown 结果仍允许聊天和读取，但不允许确认新的写操作；必须先核实原编号。
- 对上游新增账单 insights 扩展严格校验：验证字段、变化计算、分类金额，以及大额交易必须属于当前证据，不删除原有响应验证。单月正常增加上一月查询用于比较，回归测试同步验证两个过滤器。
- 同时支持旧 coreStage 和 outcomePending 的待核实历史，保留查询入口而不恢复执行权限。
- 上游已有的 react-test-renderer 测试依赖按 lockfile 安装，未使用 npm audit fix 或修改业务依赖版本。

合并后验证：`npm test` 为 414 项，402 通过、0 失败、12 跳过（10 项 PostgreSQL 未配置、2 项真实模型测试默认关闭）；`npm run typecheck`、`npm run lint`、`npm run build` 均通过。真实 TrueForge 恢复专项 17/17、账单专项 8/8、自然语言回归 31/31 通过，其中专项分别有 1 项真实模型用例，其余为稳定合同测试。上游真实 React Hook/页面生命周期测试 20/20 通过；未知结果的断言同步为“允许读取、禁止再次执行”。

本次只更新功能分支和 PR，未合并或写入 main，未发布生产环境。Git 直连不可用时使用已连接的 GitHub Git 数据接口，逐一核对 blob、tree 和最终提交内容；远端引用仅按预期旧 SHA 快进更新。
