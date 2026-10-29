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

Banking 页面统一使用 `/api/banking-agent`：默认 TrueForge 无工具理解 → 服务端校验 → 现有 Skill/Core 查询或预览。迁移期仅可由服务端 `SAVEFLOW_BANKING_RUNTIME=legacy-qwen` 整体切换，不按句式分流或静默回退。独立 `/api/agent` 储蓄助手保持原行为。

自然语言回复与结构化卡片分离，提供简洁/亲切/专业风格；风格不改变风险、确认和安全提示。本次只支持单动作，多动作需要拆开；未完成真实 TrueForge 部署验收。配置、合同及限制见 [Banking Agent API](docs/Banking-Agent-API.md)，验证范围见 [联调记录](docs/Banking-Agent-Integration.md)。

验收脚本使用模拟资金与供应商桩，不调用真实模型或银行。
