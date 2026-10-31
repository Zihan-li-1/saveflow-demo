# 购物预算与链接：运行及验收

范围以 [当前动作契约](Gift-Purchase-Actions.md) 为准。仓库中的旧 Commerce Mock 和订单执行测试只证明历史实验逻辑；生产公开接口已经停用这些动作。

## 运行条件

需要 Node >=22.12、项目依赖、PostgreSQL、演示访问码、稳定的会话密钥和单独运行的提醒 worker。服务端配置：`SAVEFLOW_ACCESS_CODE`（至少 16 字符）、`CONTINUATION_TOKEN_SECRET`（至少 32 字符）、`DATABASE_URL`、`PURCHASE_WORKER_ENABLED=true`；反向代理部署需设置精确的 `SAVEFLOW_PUBLIC_ORIGIN`。无需 Commerce Mock 凭据或服务。

先运行 `npm run db:migrate`，再运行 `npm run worker:purchase` 与应用。也可在现有 Compose 文件上叠加 `compose.purchase.yaml` 启动 `web` 和 `purchase-worker`。worker 的近期数据库心跳是保存提醒的前提；若失联超过两分钟，预览返回 `SCHEDULER_UNAVAILABLE`。Netlify 的 API 函数本身不是常驻 worker。

### 本地 `npm run dev` 验证预览和确认

1. 将 `.env.example` 复制为不提交的 `.env.local`，设置长度至少 16 的 `SAVEFLOW_ACCESS_CODE`、长度至少 32 的 `CONTINUATION_TOKEN_SECRET`、`PURCHASE_WORKER_ENABLED=true` 和 `DATABASE_URL`。银行流水仍是合成 Mock；数据库只负责保存演示状态。若使用现有 Docker PostgreSQL，连接地址为 `postgresql://saveflow_web:local-synthetic-web-only@127.0.0.1:5433/saveflow_web`。若本机已有 PostgreSQL，改成其实际地址即可，不需要 Docker。
2. 有 Docker 时，运行 `docker compose --env-file .env.local -f compose.yaml -f compose.postgres.yaml up -d pilot-db`，只启动数据库；本机 `npm run dev` 通过 `127.0.0.1:5433` 访问。没有 Docker 时，先自行启动 PostgreSQL 并建立 `DATABASE_URL` 指向的数据库。
3. 运行一次 `npm run db:migrate`。在另一个终端运行 `npm run worker:purchase`，保持它运行；再运行 `npm run dev`。迁移与 worker 会读取 `.env.local`，已由部署环境设置的变量保持优先。
4. 在 `http://localhost:3000` 填演示访问码并勾选同意。选择未来日期、时间段、预算和卡后点击“预览提醒设置”；如缺少近期余额和待付金额，按卡片提示补齐。预览卡片出现“确认设置提醒”后再点击确认，只有保存成功才显示回执。到期后打开或刷新应用查看待办；不会主动发短信、系统通知或真实购物订单。

若显示“购物流程数据库未配置”，核对 `DATABASE_URL` 和数据库连接；若显示“后台预约服务未运行”，核对 worker 进程与 `PURCHASE_WORKER_ENABLED=true`。不要通过关闭这两项检查来伪造成功回执。

打开 `/shopping/`，填访问码并同意在使用模型理解目标时发送本次自由文本及已有购物草案槽位；不要在自由文本中填写电话、地址或恢复码。没有模型时可手动补全槽位。确认预算前要核对日期含义：`order_on` 是希望收到提醒去下单的日子；`deliver_on` 是希望送达的日子，页面会预估提前三天提醒。到期事项由 worker 写入数据库，用户**再次打开或刷新页面**才看得到；没有短信或系统推送，也不保证平台送达日期。

## 人工验收

1. 输入 1000 元、账户称谓、预算月份、未来日期与时间窗、鲜花/蛋糕；填可用余额和待付义务。确认前检查预览中的金额、来源和提醒时间，保存恢复码，再确认。
2. 重新打开页面或使用恢复码读取同一流程。核对“本月预留 1000 元”“银行余额不变”和“不要挪用”提示。该金额是规划数据，不能阻止账户其他消费。
3. 切换问答/自选，补充颜色、花材、口味和禁忌。页面应给出对应品类的外部搜索入口；打开新标签后由用户自行挑选、核对总价、配送和过敏原并在平台创建订单。SaveFlow 不收集配送地址、不展示模拟订单确认按钮、不代用户下单或付款。
4. 尝试公开调用 `commerce.order.execute` 或 `purchase.address`，应得到 `CAPABILITY_UNAVAILABLE`。修改偏好可以；使用旧候选/地址字段修改生效计划应被拒绝。
5. 到期后运行 worker 并刷新页面，看到一条待办提醒；重复运行不能产生重复待办。取消预算后未来任务停用，外部平台的订单不受影响。
6. 保存 1000 元预算后，模拟在别处消费；在页面按最新余额 800 元、待付义务 0 元主动复核，应显示差额 200 元，数据库中的预留和银行账务不变。该输入是用户自述，不能替代实时银行余额。

2026-10-27 实际浏览器抽查：按当前链接生成器的“鲜花花束 粉色 玫瑰”和“生日蛋糕 水果 6人”两个搜索词打开京东，均进入了对应搜索结果页并显示商品列表。该检查证明这两条示例链接当时可用；页面内容包括广告、动态价格与用户所在地区的配送结果，不能证明任意时刻、地区或商品详情页都可用，也不是本应用的商品推荐或报价验证。

## 自动化检查

运行 `node --test tests/purchase-*.test.mjs tests/purchase-ui.test.cjs`、`npm test`、`npm run typecheck`，并对修改文件运行 ESLint。`PURCHASE_TEST_DATABASE_URL` 是独立测试数据库的可选配置；缺失时数据库集成测试会跳过。旧 Mock 订单路径的通过不代表当前公开下单能力。

当前主干的生产 Webpack 构建基线存在客户端 `node:crypto` 导入错误（`page.tsx → saveflow-mock.ts → legacy-adapter.mjs → core.mjs → verification.mjs`）。该问题在未加入本改动的主干上也能复现；测试结果与可部署状态应分别报告。
