# TrueForge 试点 GitHub 推送与 Netlify 预览验收

日期：2026-10-18（Asia/Shanghai）。本轮目标为竞赛 Demo；关闭网页后的聊天历史不保留不作为阻塞，多轮业务状态可靠性仍须单独验收。

## 当前结论

**试点分支已推送，Draft PR #13 已创建，Netlify Deploy Preview 构建成功；实际业务验收被 Netlify 登录保护拦截，尚不能确认线上 Demo 可演示。** 没有合并 PR、修改/推送 main、关闭站点保护或开放真实资金执行。

- 分支：[spike/trueforge-harness](https://github.com/Zihan-li-1/saveflow-demo/tree/spike/trueforge-harness)
- Draft PR：[PR #13](https://github.com/Zihan-li-1/saveflow-demo/pull/13)
- 预览：[deploy-preview-13](https://deploy-preview-13--startling-flan-ed8dcb.netlify.app)
- 实际部署日志入口：[Netlify deploy 6ad4a3ebf7b8f5ab5b5f1b17](https://app.netlify.com/projects/startling-flan-ed8dcb/deploys/6ad4a3ebf7b8f5ab5b5f1b17)

## Git 与完整差异审阅

开始时 `HEAD=eef2770`，刷新后的 `origin/main=4f6a80b75143aef98e63f08e5a4deeaa66ffcf51`，有 3 个新增上游提交。若直接发布旧分支，会丢失上游转账财务上下文、权限元数据、TS 对齐改进与 10 项测试。

已按三组提交原有工作：

1. `9728e72 feat(trueforge): add restricted query and preview trial harness`
2. `d29b481 fix(postgres): serialize JSONB once and support legacy records`
3. `4790ba4 test(docker): record isolated persistence and trial verification evidence`

随后在独立 worktree 整合 origin/main，解决 `package.json` 和 `server/banking-agent.mjs` 冲突：保留全量试点测试和依赖，把上游财务上下文放回抽取后的 `banking-orchestrator.mjs`，并保留上游 Core/Skill 改动及新增测试。整合提交为 `b6eeee0`；最终本地验证与部署驱动提交为 `49c32a5`。没有重置、丢弃已有工作或改动本地 main。

Git 的 github.com HTTPS 连接多次失败，但 GitHub API 可用。使用本机既有 Git 凭据在内存中，通过 Git 数据 API 上传相同 blob/tree/commit，并逐个校验原 SHA；仅创建/快进 `spike/trueforge-harness`，没有强推或改动 main。远端业务提交与本地一致：`49c32a50eb0c6bbd8e561bae1b334cf19b84411b`。随后补充的验收记录提交不改变业务运行代码。

`next-env.d.ts` 与 `tsconfig.tsbuildinfo` 的工作区改动保留，不纳入 PR 的生成文件差异；对上游已追踪的 buildinfo 仅在索引恢复 origin/main 基线，不覆盖工作区文件。`.env.local`、`.netlify/`、`.trueforge/`、SQLite、私有诊断日志和依赖/构建目录均排除。凭据值未写入 Git、日志、前端或 PR。

## 本轮实际运行的本地验证

| 检查 | 通过 | 失败 | 跳过 | 证据 |
| --- | ---: | ---: | ---: | --- |
| 整合前 PostgreSQL 试点基线 | 194 | 0 | 0 | [日志](verification/netlify-preview/postgres-before-sync.log) |
| 整合前 Mock | 187 | 0 | 7 | [日志](verification/netlify-preview/mock-before-sync.log) |
| 整合后 PostgreSQL 全量 | 204 | 0 | 0 | [日志](verification/netlify-preview/postgres-final.log) |
| 整合后 Mock 全量 | 197 | 0 | 7 | [日志](verification/netlify-preview/mock-final.log) |
| 新增上游转账契约测试 | 10 | 0 | 0 | [日志](verification/netlify-preview/upstream-contracts.log) |
| Docker HTTP 安全边界 | 16 | 0 | 0 | [报告](verification/netlify-preview/docker-http-report.json) |
| Docker 原网页业务 | 10 次请求符合断言 | 0 | 0 | [报告](verification/netlify-preview/docker-ui-report.json) |

七项跳过均为数据库专用测试；204 比 194 多出的十项来自最新 main。lint、Next typegen、typecheck 均通过。Docker 生产构建第一次因 npm 下载 `ECONNRESET` 失败，原命令重试成功：[失败证据](verification/netlify-preview/docker-build-network-attempt.log)、[成功构建](verification/netlify-preview/docker-build-final.log)。宿主机 `node --run test` 异常退出，改用原生 `npm.cmd test` 成功；不把前一次调用计为通过。

真实 Docker 网页通过账单、卡片查询、账户/收款人澄清、余额不足与恢复、修改金额、预览、取消、聊天确认拒绝与直接执行拒绝；桌面和手机无脚本错误或横向溢出。此结果来自本地 Docker/宿主机 TrueForge，不是 Netlify 业务结果。

## Netlify 实际结果

初次验收部署为 `6ad4a3ebf7b8f5ab5b5f1b17`，Build ID 为 `6ad4a3ebf7b8f5ab5b5f1b15`，对应业务提交 `49c32a50eb0c6bbd8e561bae1b334cf19b84411b`。公开部署 API 返回 `state=ready`、`plugin_state=success`，Netlify bot 在 PR 中确认 ready。部署摘要显示 15 个新文件、3 条重定向、1 条 Header 规则和 4 个 Functions 发布成功。见 [部署快照](verification/netlify-preview/deployment-report.json)。

实际浏览器与独立 HTTP 请求结果：

| 路径 | HTTP | 响应类型 | 结论 |
| --- | ---: | --- | --- |
| `/` | 401 | `text/html`，标题 `Login Redirect` | 预览入口登录保护 |
| `/api/banking-agent` | 401 | `text/html` | 请求未进入 SaveFlow Agent |
| `/api/banking` | 401 | `text/html` | 请求未进入 Core API |

这是 Netlify 入口访问保护，**不是 SaveFlow JSON `UNAUTHORIZED`，也不是 `CONTINUATION_INVALID`**。浏览器尚未加载原应用，业务 POST 数量为 0。[入口证据及请求 ID](verification/netlify-preview/preview-access-report.json)、[浏览器验收记录](verification/netlify-preview/preview-ui-report.json)。

因此以下项目明确为**未验收**：线上原卡片 UI、账单/卡片查询、账户选择、收款人选择、修改金额、预览与取消、聊天确认拒绝、跨请求多轮续接、实际 TrueForge/MCP 网络连接与实际数据库连接。不能把登录保护的 401 当成业务安全测试通过。

公开站点/部署元数据可读，但完整构建元数据 API 返回 401；没有 Netlify 私有账户会话，未读取完整构建日志、Function 实例日志或部署上下文环境变量。公开元数据省略环境值，不能据此认定变量缺失。已提供日志入口和请求 ID，便于有权限的站点维护者继续定位。

## 剩余风险与继续验收条件

- 需要可用的 Netlify 预览登录方式/授权会话，才能继续业务验收；没有关闭整个站点的保护，也没有把应用访问码当成 Netlify 登录密码尝试。
- 应核对 Deploy Previews 的 Functions 环境：访问码、稳定续接密钥、数据库 URL/允许临时 Mock 的显式决策、TrueForge 开关、模型与服务地址、MCP/Bridge connector。密钥不得使用 `NEXT_PUBLIC_` 或写进 netlify.toml。
- Docker `host.docker.internal` 与宿主机 `127.0.0.1` 地址仅供本机链路，不能证明 Netlify 能访问 TrueForge/MCP。未读取线上环境，不能断言线上已错误使用这些地址。
- `tfm1`、`tfb1` 和 Bridge `tfg1` 的会话、取消/重复请求状态仍在各自 Map；不同 Function 实例或重启可能失效。上一轮本地重启已复现，本轮 Netlify 因入口被拦截未触发，不能写成“已在线上复现”或“已修复”。
- 聊天历史暂不持久化不作为本次 Demo 阻塞；业务续接能否完成独立判断。当前“部署成功、业务未验收”，不能承诺满足线上 Demo 演示要求，更不等于生产验收。

解锁预览访问后可使用 `scripts/verify-netlify-preview.mjs` 复跑；脚本仅接受 `https://deploy-preview-<PR>--<site>.netlify.app`，拒绝生产域名，不确认/执行资金操作，不保存访问码或 Token。需要账户授权时通过本地安全配置提供，不把密码发到聊天或写入报告。
