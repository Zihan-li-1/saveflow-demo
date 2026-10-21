# Banking Agent 联调验收记录

日期：2026-09-26。工作分支 feat/validated-qwen-parsed-intent。

## 已验证

- Node 22.23.3 下运行 npm test：84项通过。机器默认 Node 20，因此通过 npx --package=node@22 执行项目脚本，未修改系统 Node。
- npm run typecheck、npm run lint、npm run build 通过。
- [请求日志](verification/banking-agent-tests.log) 包含两个独立 PID、请求编号、HTTP 状态和业务状态；不记录访问码或 token。
- 张三：首轮真实 Repository 账户选项 → 第二进程点选 → Core 正式预览500元。
- 王先生：可区分的姓名/脱敏账号 → 选择正确收款人；伪造 optionId 和额外 entityId 被拒绝。
- 账单：月份追问 → 第二进程回答2026年8月 → 12笔汇总及 synthetic_demo_only 来源。
- 修改600元生成新 operationId；改给王先生重新消歧；已选王先生后改成李四不沿用旧实体；改选收款人返回新列表。
- 两个进程余额、交易笔数均保持不变。访问码错误401、外源403、执行字段400；响应不泄露测试模型密钥。
- 本地处理器与 Netlify Function 导出入口分别通过上述 HTTP 验证。测试只有供应商响应为桩，Core/Repository/解析验证/续接逻辑均为项目实现。

## 未完成的实际环境验收

当前工具报告 apps=[]、browsers=[]，内置浏览器不可用。因此尚未在 IM 页面实际点击或录屏；不能将 API 日志作为 UI 点击证明。

工作区没有 .env.local、服务运行时凭据或 Netlify 连接，未取得本轮联调部署地址及可用连接。已请求补充。Netlify 入口的本地 HTTP 测试不等于实际部署环境验证，也未调用真实 Qwen。线上两轮成功与跨实例日志仍待验收。

## 前端成员复现

真实联调：配置 .env.local 中的 DASHSCOPE_API_KEY、SAVEFLOW_ACCESS_CODE、CONTINUATION_TOKEN_SECRET，运行 npm run dev:qwen。页面选 Banking Agent，输入演示访问码并勾选授权。

无供应商费用的页面调试：先 npm run build，再执行 `node tests/fixtures/banking-agent/http-worker.mjs --ui`。终端输出随机端口，在浏览器访问 http://127.0.0.1:<port>；访问码为 integration-access-code-1234。这是仅供本地的测试宿主，不用于部署。它使用固定供应商输出和真实 Core。

逐条重新开始，验证：

1. 给张三转500元 → 选择模拟活期账户 → 正式预览500元；输入“改成600元”，旧预览先消失再展示新预览，无确认按钮。
2. 给王先生转500元 → 选择账户 → 选择房东王先生或王强 → 正确预览；再输入“改选收款人”重新选择。
3. 查账单 → 回答2026年8月 → 显示月份、收入、支出、12笔及来源。
4. 修改请求失败时旧预览不恢复；旧选项不可再次点击；模式切换清空会话。Network 面板只应出现 /api/banking-agent，不同时调用 /api/agent。

## B 接续边界

当前是撤下 UI 卡片，不是共享存储中的旧预览撤销。确认/执行尚未开放；B 需提供共享预览状态、替代/失效校验与原子账务后再接确认。不得把 optionId 选择作为确认凭据。
