# 购物预算与链接：运行及验收

范围以 [当前动作契约](Gift-Purchase-Actions.md) 为准。仓库中的旧 Commerce Mock 和订单执行测试只证明历史实验逻辑；生产公开接口已经停用这些动作。

## 运行条件

需要 Node >=22.12、项目依赖、PostgreSQL、演示访问码、稳定的会话密钥和单独运行的提醒 worker。服务端配置：`SAVEFLOW_ACCESS_CODE`（至少 16 字符）、`CONTINUATION_TOKEN_SECRET`（至少 32 字符）、`DATABASE_URL`、`PURCHASE_WORKER_ENABLED=true`；反向代理部署需设置精确的 `SAVEFLOW_PUBLIC_ORIGIN`。无需 Commerce Mock 凭据或服务。

先运行 `npm run db:migrate`，再运行 `npm run worker:purchase` 与应用。也可在现有 Compose 文件上叠加 `compose.purchase.yaml` 启动 `web` 和 `purchase-worker`。worker 的近期数据库心跳是保存提醒的前提；若失联超过两分钟，预览返回 `SCHEDULER_UNAVAILABLE`。Netlify 的 API 函数本身不是常驻 worker。

打开 `/shopping/`，填访问码并同意发送购物目标和偏好至已配置的模型。没有模型时可手动补全槽位。确认预算前要核对日期含义：`order_on` 是希望收到提醒去下单的日子；`deliver_on` 是希望送达的日子，页面会预估提前三天提醒。到期事项由 worker 写入数据库，用户**再次打开或刷新页面**才看得到；没有短信或系统推送，也不保证平台送达日期。

## 人工验收

1. 输入 1000 元、账户称谓、预算月份、未来日期与时间窗、鲜花/蛋糕；填可用余额和待付义务。确认前检查预览中的金额、来源和提醒时间，保存恢复码，再确认。
2. 重新打开页面或使用恢复码读取同一流程。核对“本月预留 1000 元”“银行余额不变”和“不要挪用”提示。该金额是规划数据，不能阻止账户其他消费。
3. 切换问答/自选，补充颜色、花材、口味和禁忌。页面应给出对应品类的外部搜索入口；打开新标签后由用户自行挑选、核对总价、配送和过敏原并在平台创建订单。SaveFlow 不收集配送地址、不展示模拟订单确认按钮、不代用户下单或付款。
4. 尝试公开调用 `commerce.order.execute` 或 `purchase.address`，应得到 `CAPABILITY_UNAVAILABLE`。修改偏好可以；使用旧候选/地址字段修改生效计划应被拒绝。
5. 到期后运行 worker 并刷新页面，看到一条待办提醒；重复运行不能产生重复待办。取消预算后未来任务停用，外部平台的订单不受影响。

2026-10-27 实际浏览器抽查：按当前链接生成器的“鲜花花束 粉色 玫瑰”和“生日蛋糕 水果 6人”两个搜索词打开京东，均进入了对应搜索结果页并显示商品列表。该检查证明这两条示例链接当时可用；页面内容包括广告、动态价格与用户所在地区的配送结果，不能证明任意时刻、地区或商品详情页都可用，也不是本应用的商品推荐或报价验证。

## 自动化检查

运行 `node --test tests/purchase-*.test.mjs tests/purchase-ui.test.cjs`、`npm test`、`npm run typecheck`，并对修改文件运行 ESLint。`PURCHASE_TEST_DATABASE_URL` 是独立测试数据库的可选配置；缺失时数据库集成测试会跳过。旧 Mock 订单路径的通过不代表当前公开下单能力。

当前主干的生产 Webpack 构建基线存在客户端 `node:crypto` 导入错误（`page.tsx → saveflow-mock.ts → legacy-adapter.mjs → core.mjs → verification.mjs`）。该问题在未加入本改动的主干上也能复现；测试结果与可部署状态应分别报告。
