# SaveFlow 本地 Docker 运行检测报告

## 2026-10-18 提交前修复与复验（当前结论）

**PostgreSQL JSONB 缺陷已修复，Core 持久化验收通过；完整 TrueForge 续接持久化验收未通过，当前不满足合并 main 的完成标准。** 分支仍为 `spike/trueforge-harness`。没有执行 Git 提交、推送、合并或生产部署，没有开放真实资金执行。下方 2026-10-17 内容保留为历史报告，其失败数量与内存运行配置不代表本轮结果。

### 修复与兼容策略

- `src/banking-core/postgres-store.mjs` 的全部 JSONB 写入改用事务驱动的 `tx.json(object)`，交给 postgres 驱动序列化一次。实测 `jsonb_typeof(record) = object`，内外层 action 一致，fingerprint 与独立列一致，request、preview、decision、receipt 均保留对象结构。
- 读取操作记录、转账/卡片提交记录和交易记录统一经过解码函数：正常对象直接复制；旧版 JSONB 字符串只解析一层；非法 JSON、数组、null 或额外字符串层明确拒绝。保留 action、fingerprint、决定冲突、终态和回执保护，没有禁用幂等校验。
- 月份筛选使用已有 `occurred_at` 时间列的 UTC 月份，避免旧字符串记录缺失 JSON 键时漏账单。旧记录按需读取，操作下次写入时恢复对象；本轮没有批量改写历史数据或调整数据库 schema。
- 新增 5 个数据库回归测试，覆盖真实驱动行为、字段结构、新旧转账/卡片回执、旧交易月份/账户过滤、参数/动作/决定冲突和坏记录拒绝。

### 最终自动化结果

| 检查 | 通过 | 失败 | 跳过 | 证据 |
| --- | ---: | ---: | ---: | --- |
| 原有 PostgreSQL 189 项 | 189 | 0 | 0 | [原测试完整日志](verification/postgres-fix/postgres-original-189.log) |
| PostgreSQL 全量，含新增 5 项 | 194 | 0 | 0 | [最终数据库日志](verification/postgres-fix/postgres-tests.log) |
| Mock Core 全量 194 项 | 187 | 0 | 7 | [Mock 日志](verification/postgres-fix/mock-tests.log) |
| Docker HTTP 边界 | 16 | 0 | 0 | [HTTP 报告](verification/postgres-fix/http-report.json) |
| 真实生产网页业务脚本 | 10 个请求全部符合断言 | 0 | 0 | [UI 报告](verification/postgres-fix/ui-report.json) |

Mock 跳过项为原有 2 项与新增 5 项 PostgreSQL 专用测试；数据库模式没有跳过项。此前失败的 local HTTP、Netlify Function 包装跨进程续接、Postgres B、Postgres cards 四项全部通过。Netlify 这里是本地真实 HTTP 的 Function 包装测试，没有部署到 Netlify。

Docker lint、Next typegen、typecheck 均通过，见数据库全量日志末尾；最后新增验收/审计脚本后的 lint 也通过，见 [最终 lint](verification/postgres-fix/final-lint.log)。Docker 生产构建成功，见 [镜像与生产构建日志](verification/postgres-fix/images-build.log)。

首次新增回归中有 1 个断言遗漏 Core 自动补齐的 `memo: ''`，修正预期后 194 项通过；[首次失败日志](verification/postgres-fix/postgres-regression-first-attempt.log) 保留。验收驱动还修正过 SQL 字符串引号和 JSON 对象键顺序比较；两者为测试驱动问题。HTTP 检测曾因上批请求仍占用原 60 秒窗口而提前收到 429，等待完整窗口后重跑通过；未修改限流。宿主机 `npx.ps1` 被本机执行策略阻止，最终直接运行本地 eslint 的 Node 入口成功，没有修改执行策略。

### 真实持久化模式与安全验证

本轮实际使用 `compose.yaml + compose.postgres.yaml`，网页和试点 MCP 均启用真实 PostgreSQL。新增 `pilot-db` 和 `pilot-web-db` 两个隔离的合成数据库及独立命名卷，数据库不发布宿主机端口。原 `test-db` 仍只供自动化，使用 tmpfs。普通 `compose.yaml` 默认仍是内存模式，不能把默认启动误认成持久化验收模式。

MCP 仅在明确设置 `SAVEFLOW_TRIAL_DATABASE_URL` 时使用 PostgreSQL，仍固定 Mock 用户和合成数据；稳定的续接密钥为必需项，不继承通用 `DATABASE_URL`，不增加任何 Skill 参数或确认/执行工具。网页 Core 与试点 MCP 分库，避免 `tfpreview:` 前缀被移除后访问同一条可执行记录。真实 HTTP 已验证：带前缀执行被 403 拒绝；移除前缀后在网页库找不到该操作，也不能执行。

真实链路仍为：浏览器 → Docker 网页/API → 宿主机 TrueForge 0.3.1/已有模型 → Docker MCP/Bridge → PostgreSQL 合成 Core → 原网页卡片。

- 账单：2026-08 收入 1,200,000 分、支出 846,000 分、12 笔。
- 账户/收款人澄清、零余额拒绝与重新选账户、500→400→300 元正式预览、卡片查询、网页刷新后修改与取消全部通过。桌面与 390px 页面无脚本错误、无横向溢出：[桌面](verification/postgres-fix/desktop.png)、[手机](verification/postgres-fix/mobile.png)。
- 聊天确认、试点直接执行、伪造续接、错误访问码、跨来源、未注册执行字段、路径穿越和请求大小/频率限制均按预期拒绝；MCP 暴露的 8 个工具中没有 confirm/decide/execute。
- 通过独立合成测试 owner 在容器内直接调用 Core，模拟确认并扣 100 分。另一实例重复执行取得相同回执；重建数据库容器、重启 MCP、再由新 Node 进程读取后，余额仍为 499,900 分，原操作账本恰好 1 条。试点用户的余额、卡片和 36 条原始交易均未改变。此模拟执行没有经过模型或新增资金执行入口。
- 数据库容器 `--force-recreate` 后命名卷保留，预览、action/fingerprint、操作状态、回执与余额恢复。MCP 自包含加密澄清 Token 在稳定密钥下跨重启继续有效。

以上断言与脱敏回执见 [实际持久化报告](verification/postgres-fix/persistence-report.json)，可用 `node scripts/verify-docker-persistence.mjs` 重跑。真实工具事件见 [TrueForge 事件](verification/postgres-fix/trueforge-events.json)；Session 和 Token 已脱敏。

### 未解决项与合并判断

已实际复现以下三处独立内存依赖，不能用 PostgreSQL 测试全绿覆盖：

1. `server/trueforge-skill-adapter.mjs` 的 `tfm1` 状态、会话 revision、取消与重复请求缓存在进程内 Map，重启网页后旧 Token 返回 `CONTINUATION_INVALID`。
2. `server/trueforge-bill-adapter.mjs` 的 `tfb1` Session/来源/重复请求缓存也在 Map，重启网页后旧账单澄清 Token 失效。
3. `server/mcp/trueforge-token-bridge.mjs` 的 `tfg1` 别名和重复请求缓存在 Map，重启 Bridge 后旧别名失效。

TrueForge Session 由独立宿主机服务管理；实测网页、MCP、Bridge 重启后同一受限 Session 仍可由新 SDK 客户端读取。TrueForge 本身使用已有 SQLite，**本轮没有重启 TrueForge 宿主服务，不能声称已完成该服务自身重启/容灾验收**。网页刷新恢复聊天历史并不能替代服务端续接恢复。限流 Map、Core 的单进程执行去重缓存和内存审计事件也不提供跨实例全局语义；Core 的回执与账本一致性另由数据库事务及本轮跨实例测试验证。

合并门槛仍包括：为上述续接状态设计共享持久化及原子消费/取消/重复请求语义，再补充跨网页实例、跨 Bridge 实例和完整重启恢复验收。压力/故障注入、TrueForge 自身重启、完整多用户授权及生产部署未验收。现有 5 分钟续接/预览有效期不因持久化延长；旧坏记录的人工修复也不在本轮自动兼容范围内。

**结论：JSONB 修复和 Core 持久化通过；资金执行仍仅限模拟。整条 TrueForge 持久化链路尚未达到用户定义的完成标准，不建议合并 main。** 建议提交文件、Commit 信息与可直接使用的 PR 描述见 [提交审阅说明](trueforge-submit-review.md)。

### 复跑命令

```powershell
# 项目目录 saveflow-demo；宿主机已有 TrueForge 须监听 127.0.0.1:8790
docker compose --env-file .env.local --profile test build tests web
docker compose --env-file .env.local --profile test run --rm tests
docker compose --env-file .env.local --profile test run --rm tests sh -c 'unset DATABASE_URL BANKING_TEST_DATABASE_URL; npm test'
docker compose --env-file .env.local -f compose.yaml -f compose.postgres.yaml up -d web mcp bridge
node scripts/configure-trueforge-docker.mjs
node scripts/verify-docker-persistence.mjs
# UI/HTTP/持久化脚本共用原有限流，批次之间留足 60 秒
node scripts/verify-docker-ui.mjs
node scripts/verify-docker-http.mjs
node scripts/audit-trial-submission.mjs
```

持久化验收脚本会重建测试数据库容器并重启网页/MCP/Bridge，会使旧 `tfm1`/`tfb1`/`tfg1` 失效。停止这组本地服务时使用同一组 `-f` 参数执行 `down`，不加 `-v` 以保留测试卷；不要把此命令用于其他项目或生产数据库。

---

## 历史记录：2026-10-17（修复前）

检测日期：2026-10-17；项目：`D:\金科国际\saveflow-demo`；分支：`spike/trueforge-harness`。构建使用当前工作区代码，包含已有未提交修改，没有提交 Git、创建 PR 或部署。

**结论：容器构建、内存 Mock Core 的网页/HTTP/真实 TrueForge 试点链路可用；PostgreSQL 持久化检测不通过，不能据此认定持久化模式可上线。**

## 当前可访问服务

网页：**http://127.0.0.1:4300/**，使用原 `.env.local` 的演示访问码。可测试“查询2026年8月账单”“给王先生转500元”，选账户时能看到真实模拟可用余额。

| 服务 | 运行位置/地址 | 实测状态 |
| --- | --- | --- |
| 网页与原 API | Docker，127.0.0.1:4300 → 容器3000 | healthy |
| 独立 Mock MCP | Docker，127.0.0.1:4333 → 容器3333 | healthy |
| MCP 凭据 Bridge | Docker，127.0.0.1:4334 → 容器3334 | healthy |
| PostgreSQL 测试库 | Docker 私有网络 test-db:5432，无宿主机端口 | healthy，数据仅 tmpfs |
| TrueForge 0.3.1 | **宿主机原有进程**，127.0.0.1:8790 | 容器调用实测200 |
| 浏览器驱动 | 宿主机 Chrome/Playwright | 访问容器网页进行真实操作 |

TrueForge 不在本项目 Docker 镜像中；完整调用链是：浏览器 → Docker 网页/API → 宿主机 TrueForge/DeepSeek → Docker MCP/Bridge → Docker API → 原网页卡片。没有把宿主机原3333/3334的 MCP 冒充容器 MCP。

原网页开发服务3000与原MCP端口保留。新容器端口仅发布到127.0.0.1，没有对局域网开放。

## 环境与构建

- Docker Engine **29.8.2**，Compose **5.5.1**，Docker Desktop Linux/WSL2，x86_64。
- Node **v24.22.0**，基础镜像 node:24-bookworm-slim；隔离数据库 **PostgreSQL 17.11**。
- `saveflow-docker-test:local` 约 **1.02GB**，镜像 ID、关键源码与宿主机的 SHA256 对比见 [环境证据](verification/docker-check/environment.json)。三项核对的源码完全一致。
- Docker 内 `npm ci` 和 `npm run build` 成功，生成生产静态导出。[构建日志](verification/docker-check/build.log)。
- 原 next.config.ts 使用 output=export，不能仅用 next start 提供原 API。新增 Node 容器入口提供 out 静态文件并调用现有 API handlers；没有改 UI 卡片契约、意图/Skill/Core 架构。
- 运行容器使用 node 用户（UID1000）、只读根文件系统、临时/tmp、cap_drop=ALL。`.env.local` 不进入镜像，运行时仅注入所需配置。17个网页静态文件中未检出已配置的访问码/私密值。[镜像边界证据](verification/docker-check/image-boundary.json)。这不是完整镜像漏洞审计。

## 检测结果

| 检测 | 实际结果 | 证据 |
| --- | --- | --- |
| 容器生产构建 | 通过 | [build.log](verification/docker-check/build.log) |
| 默认内存 Core 自动化 | **189项：187通过、0失败、2跳过** | [mock-tests.log](verification/docker-check/mock-tests.log) |
| 启用 PostgreSQL 的自动化 | **189项：185通过、4失败、0跳过** | [tests.log](verification/docker-check/tests.log) |
| 容器 lint、Next typegen、typecheck | 通过；在数据库用例失败后独立执行 | [quality.log](verification/docker-check/quality.log) |
| 容器 HTTP 边界 | **16项全部通过** | [http-report.json](verification/docker-check/http-report.json) |
| 真实生产网页/TrueForge/MCP | 通过，10个请求；业务模型请求1107–2894ms | [ui-report.json](verification/docker-check/ui-report.json) |
| 桌面/390px手机宽度 | 无浏览器脚本错误，无横向溢出 | [桌面](verification/docker-check/desktop.png)、[手机](verification/docker-check/mobile.png) |

HTTP 检测包含健康页、首页、禁止读取.env.local、编码路径穿越、POST限制、缺少/错误访问码、跨来源拒绝、JSON类型限制、16KiB请求体、非法JSON、执行字段拒绝、伪造续接拒绝、原10次/分钟限流、试点编号直接执行403。没有放宽传输层校验或用模拟响应掩盖失败。

真实网页检测依次通过：

1. 查询2026年8月账单：收入1200000分、支出846000分、12笔，使用原账单卡片。
2. 给王先生转500元：选择零余额储蓄账户和房东后，正确返回余额不足，无假预览；新恢复选项可用。
3. 重新选活期账户，真实生成500元正式预览；改为400元，保留账户与房东。
4. 查询日常虚拟卡，切换不携带转账token；刷新后消息恢复，再返回原转账修改为300元。
5. 聊天确认403、直接Core执行403、取消成功，资金执行没有开放。

实际事件为 **3个受限Session、8次真实工具调用**：bill_summary 1次、transfer_preview 6次、card_get 1次；MCP connector 均为专用 Docker connector，没有确认/执行工具。[完整脱敏事件](verification/docker-check/trueforge-events.json)、[断言摘要](verification/docker-check/trace-checks.json)。Session和凭据只保留摘要，密钥未写入报告。

首轮网页自动化曾因测试脚本使用不存在的旧CSS选择器而超时；当时账单接口已返回正确结果。修正驱动选择器后完整重跑通过，[驱动失败记录](verification/docker-check/driver-selector-failure.json) 保留，不把它归因于应用业务失败。

## PostgreSQL 不通过项与定位证据

以下4项在启用真实隔离数据库后失败，主要错误为 **IDEMPOTENCY_CONFLICT**：

1. real HTTP / local：跨独立进程继续账户/收款人/账单/编辑流程。
2. real HTTP / netlify：同类Function封装集成流程。
3. Postgres B：跨Core实例共享预览、确认、回执和账本。
4. Postgres cards：跨实例/重启共享卡片预算与状态。

直接查询测试数据库发现，banking_operations.record 的 **jsonb_typeof(record)=string**，不是对象；`record ? 'fingerprint'` 为false。[数据库实测](verification/docker-check/postgres-record-evidence.log)。

`src/banking-core/postgres-store.mjs` 向 `::jsonb` 参数传入 JSON.stringify(record)，而当前 postgres 驱动对JSON类型还会再序列化。读取时 fromRecord 直接 structuredClone，store.put 按 existing.action / existing.fingerprint 访问；字符串中没有这些属性，因此同一操作后续保存被判断为冲突。该诊断由现存源码、驱动序列化实现及实际数据库记录共同支持。

**本轮没有通过关闭幂等验证、修改Core或迁移来“修复”测试。** 数据库仅用于检测，不接入运行中的网页/MCP。应另行修复JSONB存取并重跑上述4项；现在不能把PostgreSQL模式当作已验收。此前两项数据库测试跳过，没有暴露该问题。

## 本轮新增/调整文件

- Dockerfile：依赖、测试、构建和非root运行阶段。
- .dockerignore：排除密钥、宿主机依赖与构建/验证产物。
- compose.yaml：网页、MCP、Bridge及隔离测试数据库/测试profile；运行中的网页DATABASE_URL明确为空，仍用内存Mock Core。
- scripts/serve-container.mjs：静态导出与原API统一入口，保留鉴权/来源/大小/限流。
- server/mcp/trueforge-token-bridge.mjs：只增加监听host和上游URL的服务端配置，默认本机行为不变。
- scripts/configure-trueforge-docker.mjs：建立 saveflow-docker-mcp / saveflow-docker-bridge 两个本地connector，不修改旧connector或billtest。
- scripts/verify-docker-ui.mjs、scripts/verify-docker-http.mjs：可复跑的真实网页和HTTP检测。
- 本报告及 docs/verification/docker-check/：测试日志、截图和实际工具证据。

未修改.env.local、原种子余额、Core、数据库迁移、main；已有未提交改动保留。

## 重启与复跑

当前服务已运行。以后重启宿主机 TrueForge 时需 **HOST=127.0.0.1**：原进程只监听::1，容器访问host.docker.internal时曾ECONNREFUSED。曾尝试端口中继，自动审批以“blocked by policy”拒绝，未启动；最终使用TrueForge原生HOST配置解决，未开放0.0.0.0或保留中继程序。

```powershell
# 仅当 TrueForge 没有运行时启动；沿用本机既有配置/数据
$env:HOST = '127.0.0.1'
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
npx.cmd @truefoundry/trueforge@0.3.1 --port 8790

# 在另一终端，项目目录内；不要输出 docker compose config 的完整环境值
docker compose --env-file .env.local build web tests
docker compose --env-file .env.local up -d web mcp bridge
node scripts/configure-trueforge-docker.mjs
docker compose --env-file .env.local ps

# 隔离数据库检测：当前会如实报告4项失败
docker compose --env-file .env.local --profile test up -d test-db
docker compose --env-file .env.local --profile test run --rm tests

# 默认Mock测试与质量检查，独立于数据库问题
docker compose --env-file .env.local --profile test run --rm tests sh -c 'unset DATABASE_URL BANKING_TEST_DATABASE_URL; npm test && npm run lint && npx next typegen && npm run typecheck'

# 使用本机已安装的Playwright；两批API检测间需等待原限流窗口
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/lzh/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
node scripts/verify-docker-ui.mjs
node scripts/verify-docker-http.mjs
```

最后两条不能紧接执行：第一批10次请求会占满60秒窗口，应待窗口结束再运行下一批。测试没有改变限流。

停止本轮容器：`docker compose --env-file .env.local --profile test down`。测试库使用tmpfs，移除容器会丢弃该隔离测试库；宿主机原服务不由此命令停止。

## 适用范围与未检测项

本次是本地容器运行检测，不是完整部署验收。TrueForge/模型依赖仍在宿主机/已配置上游；停止它们会使业务调用失败，网页健康页只证明HTTP进程存活。Core及续接状态仍为各自独立进程内存，容器重建会丢失；未实现跨实例持久化或两个Core状态共享。未进行压力/尾延迟、镜像CVE扫描、OIDC、多用户隔离、真实银行操作、Netlify部署。

**可用于本地内存Mock试点验证；PostgreSQL模式不通过，资金执行与生产上线不可据此开放。**
