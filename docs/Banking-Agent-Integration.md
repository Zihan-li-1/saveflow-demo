# Banking Agent 联调与验证

本轮工作目录为 `saveflow-demo`。当前合同见 [Banking Agent API](Banking-Agent-API.md)。本轮改造在本地实施，未提交、部署或修改既有公共站点。

## 自动验证范围

`npm run test:banking:runtime` 包含统一 Runtime 专项和实际 TypeScript 客户端/React 卡片渲染测试：

- 同一 API、不同句式和退役开关均走配置的理解器；明确 legacy 配置才使用 Qwen，不可用时不回退。
- 现有账单/卡片/订阅/产品查询，转账、预算、冻结及解冻预览回归；账户和卡片业务状态不因理解或预览而变更。
- 已知收款人/金额写入澄清文字，部分年月只问缺失部分；自由文本使用同一理解器及认证草稿；选项由服务端映射、无需模型。
- 歧义实体、多动作和不支持请求；未知 action/字段、伪造实体/权限/确认/风险、丢失已知槽位、未经原文支持的值被拒绝。
- SDK 协议桩验证无工具私有 inline Agent、权限配置、事件/终态一致性、未授权工具拒绝、超时取消及不重试。
- 实际客户端调用统一处理器并验证 reply/data 分离，三种风格下业务数据和账单卡片 HTML 相同；澄清卡片 HTML 不重复气泡追问；关键安全提示完全一致。
- 实际 Core 余额不足经 API→客户端恢复为澄清；统一加密草稿刷新恢复和过期，历史 Core 预览不能恢复执行权限。

`npm test` 同时包含旧动作、安全边界和 `/api/agent` 的 Qwen 回归；既有跨进程真实 HTTP 测试显式选择 `legacy-qwen`，验证本地与 Netlify 导出宿主的加密草稿续接、Origin/访问码、实体选择及 Core 预览。这些用例使用供应商桩，不能当作真实 Qwen 或 TrueForge 服务验证。

本轮生产构建、lint、typecheck 均通过；专项 24/24 通过，全量 236 项中 229 通过、7 项 PostgreSQL 用例因缺少测试数据库跳过、0 失败。复现使用 Node >=22.12，Windows 可使用 npm.cmd：

```sh
npm run test:banking:runtime
npm test
npm run lint
npm run typecheck
npm run build
```

PostgreSQL 专项需要 `BANKING_TEST_DATABASE_URL`，缺少时明确跳过，不作为通过的数据库验证。真实服务凭据不写入测试日志。

## 目标环境仍需验收

本轮未调用真实模型/TrueForge 服务、未执行 PostgreSQL 集成、未做浏览器实际点击或部署验收。React 静态渲染验证不是浏览器交互证明。

配置 `.env.local` 的访问码、续接密钥、TrueForge URL/模型/可选 token，以及部署所需 Core 数据库。运行 `npm run dev:qwen`；页面选择 Banking Agent，输入访问码并勾选授权。必须核对以下链路：

1. “给张三转500元”→ 气泡保留张三及500元，只问账户 → 卡片只列账户 → 点击选项生成 Core 正式预览，资金未变。
2. “查8月账单”→ 只问年份 → 回答2026年 → 账单汇总；“查2026年账单”只问月份。
3. 三种语言风格下重复同一请求，文字变化，结构化字段、风险、安全提示和确认要求保持相同。
4. 冻结/解冻及预算走 Core 预览，页面既有确认/验证才能执行；聊天确认不能执行。刷新仅恢复历史展示和有效澄清，不恢复 Core 执行权限。
5. “查询账单然后冻结卡片”明确拆分；TrueForge 停服应返回明确错误，Network 中不出现另一路 Qwen 回退。
6. 页面对 Banking 消息只发送 `/api/banking-agent`；手动切换独立 Qwen 储蓄助手才调用 `/api/agent`。

需根据真实返回会话配置、模型 finishReason/JSON 格式等核对 SDK 兼容性；未验证前不宣称上线可用或支持多意图编排。

## 历史记录

2026-09-26 的 Qwen 解析器跨进程验收日志保留于 [历史日志](verification/banking-agent-tests.log)。当时“没有确认按钮”等描述不再适用于当前 Core 页面，不能作为本轮 TrueForge 统一流程的验收证据。其他 MCP 试点说明仅适用于各自独立适配器/执行桥。
