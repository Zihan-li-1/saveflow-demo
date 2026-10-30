# SaveFlow Demo

本地 Docker 运行方式与实际检测结果见 [Docker 检测报告](docs/docker-test-report.md)。正式本地网页入口固定为：http://localhost:4300/。该报告为历史环境记录，不能代替当前统一 Banking 流程的部署验收。

## 一键更新

在本目录运行 `powershell.exe -ExecutionPolicy Bypass -File .\scripts\Update-SaveFlow.ps1`。脚本会拒绝带未提交修改的部署目录，拉取 `origin/main`，执行持久化数据库迁移，重建并启动 Web、MCP、Bridge，核对 `/healthz`、`/version` 与镜像 Git SHA，成功后自动打开 `http://localhost:4300`。

版本核验接口为 `http://localhost:4300/version`。只有 GitHub `origin/main`、部署目录 `HEAD`、运行 Web 镜像 label 和接口返回的 SHA 全部一致且健康检查通过时，脚本才输出“部署成功”。

本轮分支推送、Draft PR 与 Netlify 预览结果见 [部署预览验收](docs/netlify-preview-report.md)。预览构建成功，当前业务验收被 Netlify 登录保护拦截。

对应公共网址：https://startling-flan-ed8dcb.netlify.app/

已完成 B 项目 Banking Core：公共类型、统一 FinancialContextRepository、Mock 转账预览/风险/确认/幂等执行/回执、HTTP 及旧接口适配。交接规范见 [Banking Core 合同与验收](docs/Banking-Core.md)。本次修改未发布到上述网址。

```bash
npm install
npm run dev:qwen
```

`dev:qwen` 同时启动前端及本地模型/Banking Core API；需要 Node >=22.12，访问码配置见 [Qwen 接入](docs/Qwen接入与部署.md)。默认业务为离线 Mock，资金操作均为合成数据。

```bash
npm run demo:banking
npm test
npm run typecheck
npm run lint
npm run build
```

Banking 页面统一使用 `/api/banking-agent`：默认 TrueForge 无工具语义路由，自动选择自然聊天、现有 ParsedIntent v1 业务链路、多步骤只读规划或可信任务控制。用户使用同一个输入框，普通聊天保留待确认预览。迁移期 `legacy-qwen` 仍是服务端显式选择的旧业务入口，不提供本次新增语义路由。独立 `/api/agent` 储蓄助手保持原行为。

自然语言回复与结构化卡片分离，提供简洁/亲切/专业风格；风格不改变风险、确认和安全提示。多个只读步骤的目标自动进入受限规划；写操作仍逐项预览、确认和验证。实现、能力目录、20 项场景及真实模型未验证范围见 [统一自然对话交付记录](docs/Unified-Conversation-Routing.md)。配置与合同见 [Banking Agent API](docs/Banking-Agent-API.md)。

默认 npm test 使用模拟资金及模型传输桩，部分外部环境专项按配置跳过。`verify:conversation-routing:live` 显式调用真实 TrueForge，仍使用隔离的内存模拟 Core，不调用真实银行或执行资金操作。
