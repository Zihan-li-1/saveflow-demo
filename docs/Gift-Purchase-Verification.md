# 购物联动：运行与验收记录

当前为合成演示环境，未连接真实购物平台。真实平台授权、支付、查单及配送能力需取得接口权限后逐一适配和验收。

## 运行

要求 Node >=22.12，现有项目依赖已安装。所有配置仅在服务端：

```text
SAVEFLOW_ACCESS_CODE=<至少16字符的演示访问码>
CONTINUATION_TOKEN_SECRET=<至少32字符的稳定随机密钥>
DATABASE_URL=<演示PostgreSQL连接>
COMMERCE_MOCK_URL=http://127.0.0.1:4401
COMMERCE_MOCK_TOKEN=<至少16字符的内部服务凭据>
PURCHASE_WORKER_ENABLED=true
```

1. 执行 `npm run db:migrate`，包含 `006_purchase_workflows.sql`；请使用合成演示数据库。
2. 分别运行 `npm run dev:commerce` 和 `npm run worker:purchase`，再运行 `npm run dev:qwen`。
3. 打开 `/shopping/`，填写演示访问码并勾选同意。也可在主聊天输入生日购物目标，进入同一购物卡片。
4. 自然语言问答使用现有配置的 TrueForge 网关，或显式配置 `SAVEFLOW_BANKING_RUNTIME=legacy-qwen` 时的 Qwen 网关；配置方法沿用 `.env.example`。模型不可用时可以手动填写，界面不会声称已调用模型。

首次 worker 写入心跳后才能确认保存预约；超过两分钟没有心跳则拒绝新的预约。worker 只生成到期待办，不建单、不支付。Netlify 部署只有 API 函数，后台 worker 仍需要独立常驻服务；单纯发布静态页面不能完成后台预约。

Mock 服务默认只绑定本机。跨容器时由运维设置 COMMERCE_MOCK_HOST，保持内部网络及令牌保护。开发脚本默认把 Mock 状态保存到 .commerce-mock/state.json（已忽略，不上传），或由 COMMERCE_MOCK_STATE_FILE 指定专用持久卷。已验证重启后按固定幂等键查回同一订单；同一状态文件仅支持一个 Mock 服务进程。未配置文件的测试实例使用隔离内存。应用预算和操作保存在 PostgreSQL。真实适配器仍必须支持平台侧持久幂等及查单。

## 人工验收

- 输入预算1000元、未来明确日期和时间窗；选“下单日”或“送达日”。补充自己填报的可用余额和近期义务，核对后确认预留；银行账务不发生写入。
- 切换问答/商品自选，说明花色、花材、蛋糕口味与原料禁忌。先看鲜花再看蛋糕，打开模拟详情，换一批，核对切换模式后原选择仍在。
- 填测试配送信息，刷新两件商品及全部费用。每笔单独打开预览，检查商品/SKU/数量、费用和服务端配送快照后勾选确认。
- 第一单建成后仍显示待支付；第二单失败应同时保留两个真实状态。修改计划或取消只能调整未占用预算，未知订单不释放。
- 关闭页面后重开，恢复最近流程；服务端校验会话归属。到期后刷新可见待确认事项；无人确认的下单窗口过后显示错过窗口。

## 自动化证据与未通过的门槛

2026-10-26 全套回归首次运行：414 tests，403 pass，11 skip，0 fail。类型检查通过。后续审阅修复后的最终计数需以本文件更新及实际输出为准。

- 新测试覆盖严格契约、真实本机 HTTP 模拟服务、价格/时间失效、未知结果、幂等重放、跨用户隔离、预算并发与部分失败、修改和重新确认、界面业务文案。
- `PURCHASE_TEST_DATABASE_URL` 缺失，PostgreSQL 并发/重连测试跳过；内存测试只证明算法和测试适配器，不能证明数据库已部署或迁移成功。
- 尚无真实模型会话、部署 worker 到期执行、真实平台商品链接/下单/支付/配送验收证据。这些不能由注入的模型测试替身或页面截图替代。

运行 `npm run test:purchase`；数据库实测须显式设置专用 `PURCHASE_TEST_DATABASE_URL`，测试只删除自身生成的 test_ 用户记录。全项目验收还包括 `npm test`、`npm run typecheck` 和 `npm run build -- --webpack`。

2026-10-26 浏览器验收：独立测试主机使用内存测试库、固定时钟及模型测试替身，实际调用独立 Commerce HTTP 服务。验证预留1000元、花315元+蛋糕415元、两种模式切换/分页保留选择、逐单确认、总占用730元/可分配270元、刷新恢复两笔待支付订单及有效模拟商品详情页。该证据不等同于真实数据库或模型验收。

可选容器部署：叠加 compose.purchase.yaml，构建新版 runtime 镜像后运行 `docker compose --env-file .env.local -f compose.yaml -f compose.postgres.yaml -f compose.purchase.yaml up -d --build web commerce purchase-worker`。此环境未安装 Docker，尚未执行该容器验收。HTTPS 反向代理部署需设置精确 SAVEFLOW_PUBLIC_ORIGIN；服务不信任客户端自行填写的转发头。

会话默认七天，每次有效使用续期；保存计划前页面要求用户自行保存长期演示身份恢复码。恢复码不进入URL、模型上下文或日志，不自动存入浏览器存储；仅不透明流程引用保存在 localStorage。恢复凭据依赖稳定的 CONTINUATION_TOKEN_SECRET，轮换须有单独迁移/恢复方案。真实购买仍需正式用户认证与平台授权。

独立审阅修复后的检查：全套421项，410通过、11跳过、0失败；修改范围ESLint通过，生产Webpack构建及随构建执行的TypeScript检查通过。全部五条重要审阅反馈均有回归测试：HTTPS代理、中文/未知过敏原、长期身份恢复、到期下单与实际送达时间分离、确认页显示商户。

## 最新主干兼容性检查

已核验主干提交 `938f4d8a00312a01957241b2444d2155e80578f1`。Git传输被连接重置后，从GitHub官方归档取得源码，逐文件校验452个Git blob，导入后的Git tree与官方tree `e4fbb7ae68db4df9190fdf2f66ca8b49fdcb41f4` 完全相同。保留主干的会话恢复、OTP及共享测试注册，解决3个文本冲突后重跑。上传时以官方主干作为父提交，只写本功能55个文件，不上传本地快照导入历史。

最新主干未改动基线：{'tests': 510, 'pass': 466, 'fail': 31, 'skipped': 13}。加入本功能后：{'tests': 548, 'pass': 503, 'fail': 31, 'skipped': 14}。两次31项失败的测试名称集合完全相同，新增失败0项。失败集中于主干原有转账/OTP预览验证用例，不能据此宣布全套检查通过，亦未在本PR改动B的资金执行逻辑。

购物专项：{'tests': 38, 'pass': 37, 'fail': 0, 'skipped': 1}；唯一跳过是缺少专用PostgreSQL测试库。新主干下生产构建/代码检查结果另随最终记录更新。

最终主干检查补充：修改范围ESLint与TypeScript检查通过。最新主干及加入购物代码后的生产构建均失败于同一条客户端导入链：page.tsx → saveflow-mock.ts → legacy-adapter.mjs → core.mjs → verification.mjs → node:crypto。已在未加入本功能的精确官方主干树上复现；本交付保持草稿，不能宣称最新主干可部署或直接合入。旧基线f4adb32上的成功构建仅作为历史证据。
