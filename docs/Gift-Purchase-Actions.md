# 购物联动动作契约：预算提醒与外部搜索链接

状态：2026-10-27 用户确认的范围。本文取代 2026-10-24 设计中“Agent 调购物平台建单”的部分。旧设计和 `schemas/purchase-actions.schema.json` 保留为历史 Mock 实验资料；其中的 `commerce.*` **不是当前公开接口能力**。当前没有购物平台商户接口权限。

## 当前用户流程

1. 用户说出目标、金额、品类和日期；`purchase.understand` 仅把购物目标与偏好交给模型解析。模型不能提交预算或下单。
2. 用户核对账户称谓、预算月份、日期含义与时间窗，填写近期可用余额和待付义务。金额使用 `{amount_minor,currency:"CNY"}`，整数分；用户填报的财务数据标注 `user_provided`，不冒充银行事实。
3. `purchase.plan_preview` 生成预算及提醒预览；用户保存演示身份恢复码并确认，`scenario.purchase.save` 在 PostgreSQL 中预留**应用内预算**和提醒任务。银行余额不变，也不会限制其他消费。预算不足、财务数据缺失、数据库或 worker 不可用时，不能保存成功。
4. 用户可用 `scenario.purchase.update` 切换问答搭配与商品自选，或补充鲜花颜色、花材、蛋糕口味和人数等偏好。页面按品类和偏好生成购物平台**搜索链接**，用户在平台自行挑选商品、核对价格、库存、运费、配送与过敏原，并自行创建订单和付款。搜索链接不代表已核实的商品或推荐承诺。
5. `order_on` 的提醒时间是用户指定时间窗起点；`deliver_on` 在期望送达前三天提醒（若不足三天则立即生成到期待办）。worker 只生成应用内待办；用户需要打开页面查看。实际送达日期由购物平台确认。
6. 用户可经 `purchase.cancel_preview` 和 `scenario.purchase.cancel` 释放尚未占用的应用预算。外部平台订单需要用户在平台自行管理；SaveFlow 不读取或取消它。

## 当前公开动作

| 动作 | 主要输入 | 输出或约束 |
|---|---|---|
| `scenario.plan_purchase` | 可逐步补齐的 `budget`、`budget_month`、`funding_account_ref`、`date_expression`、`date_meaning`、`items`、`selection_mode`、`preferences` | 草案及缺失字段；没有预算占用 |
| `purchase.understand` | `message`，已有流程时加 `workflow_ref`、`expected_version` | 只提取业务槽位，不发送地址、电话、恢复码或确认凭据给模型 |
| `purchase.draft.update` | `workflow_ref`、`expected_version`、完整草案槽位 | 更新草案；生效计划的修订须重新预览确认 |
| `purchase.plan_preview` | `workflow_ref`、`expected_version`、可选 `manual_finance` | 精确金额、财务来源和 `reminder_due_at`，带短时有效的确认凭据 |
| `scenario.purchase.save` | `draft_ref`、`expected_version`、`plan_preview_ref`、`plan_confirmation_token` | 持久预算及提醒任务；服务端校验版本、上下文和凭据 |
| `scenario.purchase.update` | `workflow_ref`、`expected_version`、`changes`（仅 `selection_mode`、`preferences`） | 偏好/模式更新；不替用户选择、购买或支付 |
| `purchase.read` / `purchase.list` | 当前会话的流程引用或空对象 | 当前用户的预算、提醒和旧 Mock 记录；不宣称外部订单状态 |
| `purchase.cancel_preview` / `scenario.purchase.cancel` | 流程引用、版本，取消时加预览引用和凭据 | 释放预留，停止未来提醒 |
| `purchase.session.backup` / `purchase.session.recover` | 空对象或恢复码 | 演示身份恢复；恢复码不得交给模型或放进链接 |

公开 `/api/purchase` 需要访问码、用户同意及同源请求。`commerce.search`、`commerce.quote`、`commerce.order.prepare`、`commerce.order.execute`、`commerce.order.status` 和 `purchase.address` 返回 `CAPABILITY_UNAVAILABLE`；生产配置不连接 Commerce Mock。旧 Mock Skill、测试及 schema 留在仓库供历史实验使用，不能从生产公开接口建单。调用方不应把旧 schema 的 Commerce 分支注册成模型工具。

## 搜索链接与数据边界

第一版只生成京东搜索入口 `https://search.jd.com/Search?keyword=...`。关键词只包含品类、受控词表中的颜色、花材和口味，以及 1–100 的人数；其他自由文本会被忽略，预算、账户、购买日期、收件人、地址和排除项不进入 URL。排除项单独展示供人工核对。链接是外部搜索页，不是已验证的单品、价格或下单接口；平台可改变结果。没有平台权限时，不声称支持订单、支付、配送或退款状态。

每个业务结果继续标记 `as_of`、`context_snapshot_id`、证据来源和 `synthetic_demo_only`。旧 Mock 订单在恢复的流程里只读显示，与用户自行创建的真实订单严格区分。
