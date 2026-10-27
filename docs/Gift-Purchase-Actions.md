# 生日购物跨场景动作契约草案

状态：设计已由用户通过，按此契约实现与测试中；不表示已部署或已接真实购物平台。配套设计：[完整流程设计](superpowers/specs/2026-10-24-gift-scenario-design.md)。实现基线：main `f4adb32`，与 PR27 保持独立。

平台前提：用户已说明团队暂时没有购物平台接口权限。当前拟交付可运行的模拟 HTTP 流程；真实平台的凭据、商品链接、建单及支付能力留待实际权限就绪后按该平台适配，不预先声称已支持任何真实购物平台。

## 一、这份草案解决什么

将“预留 1000 元，在某一天订鲜花和蛋糕”拆成可逐步核验的调用；提供问答选品与商品链接自选，最后由用户确认具体订单，再调用 Commerce 接口。只预留应用预算，不冻结银行余额。只保存预算/预约不能算已订购，只有平台回执证明订单状态。

本稿给出业务动作合同，不为 A 的 LLM 增加执行权限。模型只识别 `scenario.plan_purchase` 和偏好；保存预算、选定商品、确认订单来自可信页面操作。内部 Commerce 动作不作为用户可任意调用的工具名透传。

## 二、公共类型和信任边界

所有对象拒绝未列字段，所有字符串限制长度，所有引用校验当前用户归属。下列名称是新合同候选，实施时一并注册、导出和测试，不宣称已经存在。

| 类型 | 约束 |
|---|---|
| Money | `{amount_minor: 整数, currency: "CNY"}`；金额范围 1–1000000000 分；0 仅允许在费用或余额输出中 |
| Ref | 服务端签发的非空不透明引用，最长 128 字符；不得用模型猜测值直接查询任意用户对象 |
| Version | 大于等于 1 的安全整数；更新必须带 `expected_version` |
| SelectionMode | `guided`（问答）或 `browse`（链接自选）；可以切换 |
| DateMeaning | `order_on`（届时下单）或 `deliver_on`（届时送达）；缺失时必须追问 |
| Timing | 服务端从用户原话解析的具体日期/时间窗与 `Asia/Shanghai` 时区；校验真实日期、未来日期与窗口顺序，保存解析基准 |
| Preferences | `flower_colors`、`flower_materials`、`flower_exclusions`、`scent_preference`、`cake_flavors`、`cake_servings`、`ingredient_exclusions`、`occasion`、`style`；所有字段可缺省，缺省表示未知，不表示不限 |
| Evidence | 来源、观察时间、上下文版本和可访问实体引用；用户填报与银行/商家数据分别标注 |
| ExecutionEnvironment | `mock` 或 `live`；模拟输出必有 `synthetic_demo_only:true` |

金额在模型/Skill 合同中使用整数分，不接浮点人民币数。现有内部金额名称 `amountFen` 等仅在适配层转换字段名，不再乘 100。私密地址只进入服务器的地址对象，模型拿到区域和 `address_ref` 的可读脱敏描述即可；不把收件电话或完整地址放进模型 history。

对外 HTTP 沿用项目 `code/message/requestId/reply/data` 响应封装；下文“输出”指 `data` 的业务字段。`data` 增加 `as_of`、`context_snapshot_id`、`evidence`、`execution_environment`，按来源设置 `synthetic_demo_only`。

确认凭据绑定：认证用户、流程版本、动作、操作引用、精确预览 hash、有效期。服务端校验并单次消费；`confirmed:true`、聊天里的“我确认了”、模型工具调用都不能代替凭据。现有共享访问码不是正式客户登录：模拟使用服务端签发的持久会话，真实购买需稳定认证身份和对应平台授权。

## 三、逐动作输入、输出、错误与 Mock

### 1. scenario.plan_purchase：理解目标、生成草案

调用方：A 的意图适配层。沿用当前代码的 `schemaVersion/action/slots/missingSlots/status` 形状，保持与团队 `ParsedIntentEnvelope` 的服务端适配关系。

输入 `slots`：

| 字段 | 类型 | 必填时机 |
|---|---|---|
| budget | Money | 可初始缺失；保存前必须明确 |
| budget_month | YYYY-MM | 同上，不能仅猜“当月”的年份 |
| funding_account_ref | 用户原始账户称谓 | 初始可缺；保存前由 Resolver 或选项解析 |
| date_expression | 用户原始日期说法，最多 256 字符 | 初始可缺；执行前必须解析为具体时间 |
| date_meaning | DateMeaning | 含糊时追问 |
| items | 1–2 个 `{category:"flowers"|"cake",quantity:1–10}`，类别不重复 | 只保留用户提到的品类，不擅自多买 |
| selection_mode | SelectionMode | 页面可补选 |
| preferences | Preferences | 问答与页面逐步补全 |

输出：`status=needs_clarification|purchase_draft`、已知槽位、服务端重算的缺失项、一个具体问题或两个选品按钮、draft_ref 与 version。草案存储不能产生预算占用、后台任务或外部订单。

错误：`VALIDATION_ERROR`、`DATE_AMBIGUOUS`、`DATE_IN_PAST`、`UNSUPPORTED_CATEGORY`、`MODEL_FORMAT_ERROR`。需要 Mock：可注入可信时钟、含歧义的自然语言样例、多个账户候选。

例：输入“月底给妈妈送花和蛋糕，预留一千”，不能直接生成一个当天到期订单；先确定具体年月日和“送达”时间窗。LLM 提议的值须显示给用户核对。

### 2. scenario.purchase.save：确认预算和预约

输入：`draft_ref:Ref`、`expected_version:Version`、`plan_preview_ref:Ref`、`plan_confirmation_token:非空字符串`。预算、账户、日期不从本次请求重复接收，读取已绑定的计划预览。

前置：账户由可信引用解析；完整的预算和日期语义；当前财务来源/时间可见；资金数据不足时先追问，不使用过期快照宣称预算充足。预留前读取其他有效预算和近期义务，同一账户并发保存必须串行校验额度。

输出：`status=budget_reserved`、workflow_ref、reservation_ref、version、`bank_balance_changed:false`、预算摘要与预约能力。要承诺“后台已安排”，必须同事务持久化预算及调度任务且 worker 已启用；否则仅保存草案并返回能力缺口。

错误：`PREVIEW_STALE`、`CONFIRMATION_REQUIRED`、`INSUFFICIENT_PLANNING_BALANCE`、`FINANCIAL_DATA_REQUIRED`、`PERSISTENCE_UNAVAILABLE`、`SCHEDULER_UNAVAILABLE`、`IDEMPOTENCY_CONFLICT`。Mock：账户余额、已有预算、已知义务、缺失月份、持久化失败。

### 3. scenario.purchase.update：修改偏好或选择

输入：`workflow_ref:Ref`、`expected_version:Version`、`changes`。`changes` 仅允许 `selection_mode`、`preferences`、`selected_candidate_refs`、`address_ref`；数组引用必须属于当前流程搜索结果，最终 SKU 用可信商品选项确定。预算和日期变更先创建新的计划预览，重新走保存确认，不在 update 中直接改生效数据。

输出：新 version、已确认偏好、当前选择、仍缺信息、失效的旧报价/预览提示。问答和自选切换保留已选商品，只有与新条件冲突时提示重新选择。

错误：`WORKFLOW_NOT_FOUND`、`FORBIDDEN`、`VERSION_CONFLICT`、`CANDIDATE_NOT_FOUND`、`INVALID_TRANSITION`。Mock：候选列表、用户纠正偏好、过期候选、他人引用。已执行或 unknown 的订单不允许通过改草案抹掉。

### 4. commerce.search：提供可信商品候选与链接

内部输入：`workflow_ref`、`category`、已校验的 preferences、`delivery_region_ref`、已确定的送达窗口（如有）、`remaining_budget:Money`、可选 `cursor`。这一调用在服务器根据流程构造，浏览器不能覆盖价格/预算或传任意网络 URL。

输出：`status=candidates|no_match`、`candidates[]`、`next_cursor`。候选含 candidate_ref、product_ref、可选 SKU 选项、merchant_ref、名称、类别、已核实标签、price/from_price 状态、运费是否待报价、配送能力、canonical_url、来源/时间。实际选择 SKU 后才形成可确认的精确报价。

推荐依据允许 LLM 解释，但预算、禁忌、配送条件由规则复核；候选可能包含商品资料缺失提示。没有可靠过敏原信息不能通过“无坚果”等硬约束筛选。换一批按流程记录展示历史，去重；结果耗尽时提示修改条件，不能编新商品或放松禁忌。

错误：`PLATFORM_NOT_CONNECTED`、`SEARCH_UNAVAILABLE`、`INVALID_CURSOR`。Mock：至少每类 6 个候选、2 家商户、可分页、有超预算/缺货/不配送/过敏原未知的候选。模拟 URL 只链接本项目模拟详情页；真实商品链接必须由真实平台或审核目录证实。

### 5. commerce.quote：形成精确价格与配送条件

内部输入：`workflow_ref`、`expected_version`、`selections:[{candidate_ref,sku_ref,quantity}]`、`address_ref`、具体送达窗口。地址和商品引用在服务端解析。

输出：按商户拆分的 `quotes[]`，每份包含 quote_ref、版本、有效期、商品/数量/规格快照、商品金额、包装费、运费、其他费用、优惠及最终 total、库存状态、送达窗口、取消条款、付款能力与来源。

报价时同时计算整个花+蛋糕流程的预算占用，包含另一笔已创建/未知订单；不得因为分两单而各自放行 1000 元。未知费用不能当 0；不支持指定日期配送则无法形成承诺该日期的可执行报价。

错误：`PRODUCT_UNAVAILABLE`、`SKU_REQUIRED`、`ADDRESS_REQUIRED`、`DELIVERY_UNAVAILABLE`、`QUOTE_INCOMPLETE`、`BUDGET_EXCEEDED`。Mock：花 300 元、蛋糕 400 元、两单运费合计 30 元；价格变化、缺货、区域不配送、报价过期。

### 6. commerce.order.prepare / commerce.order.execute：逐单确认并下单

prepare 内部输入：`workflow_ref`、`expected_version`、单份 `quote_ref`。输出 operation_ref、精确预览、preview_hash、expires_at、确认要求。订单预览包含具体商户、商品/SKU/数量、含全部费用总价、地址脱敏摘要与送达窗口、付款方式、取消条款。

execute 的可信 UI 输入仅允许 `operation_ref`、`preview_hash`、`confirmation_token`。平台幂等键由服务端根据持久操作生成，客户端或 LLM 不得替换。刷新报价后即使只涨一元，只要不再等于已确认快照，就停止并要求新确认；不把“仍在 1000 元预算内”当作更改订单授权。

执行顺序：验证归属和确认 → 原子校验预算/版本并保存订单占用及 executing 状态 → 使用固定幂等键调用平台 → 保存可验证回执和状态。确认本身和处理结果记录幂等，重复点击不能重复调用建单。

输出：operation_ref、provider_order_ref（若已取得）、`status=created_pending_payment|accepted|unknown|failed`、逐单回执、payment_url（平台需要用户支付时）、下一步。不把 accepted 推断成 paid 或 delivered。

错误：`CONFIRMATION_REQUIRED`、`CONFIRMATION_INVALID`、`QUOTE_EXPIRED`、`PREVIEW_EXPIRED`、`PREVIEW_STALE`、`BUDGET_EXCEEDED`、`CAPABILITY_UNAVAILABLE`、`ORDER_STATUS_UNKNOWN`、`IDEMPOTENCY_CONFLICT`。其中 `QUOTE_EXPIRED` 表示商家报价已失效，`PREVIEW_EXPIRED` 表示用户确认窗口已过期；两者都要求刷新并重新确认。Mock：拒绝确认、双击、平台已受理但响应丢失、待支付、同键重复请求、第二单库存不足。

若平台超时，订单占用保持有效。平台支持使用商户请求号查单时先查询；查不到但平台尚不能确认未受理，不得新建不同幂等键重试。

### 7. commerce.order.status：查单与恢复

输入：当前 owner 可访问的 `operation_ref`。输出订单最新状态、来源及更新时间、逐阶段回执，不返回其他用户地址/订单。

支持状态：`created_pending_payment`、`accepted`、`paid`、`fulfilling`、`delivered`、`cancelled`、`failed`、`unknown`；以平台事件/查询为证据。回调与查询结果按平台状态版本/时序合并，晚到的旧消息不能把 paid 退回 pending_payment。未知状态不能简单按超时自动释放预算。

错误：`OPERATION_NOT_FOUND`、`FORBIDDEN`、`PLATFORM_UNAVAILABLE`。Mock：创建响应丢失后查到同一订单、状态乱序、重复回调、长期 unknown。

### 8. scenario.purchase.cancel：取消预约并核对剩余预算

输入：`workflow_ref`、`expected_version`、取消计划预览的确认凭据。输出计划停用回执、已释放金额、仍占用/已消费金额、需单独处理的外部订单及链接。

没有外部订单时可释放剩余预算并取消未来任务。已有订单时“取消计划”不会默默撤销该订单；无法确定的订单仍保留占用。若未来增加平台订单取消，另定义预览和确认合同，并展示取消费/不可退信息。

错误：`VERSION_CONFLICT`、`CONFIRMATION_REQUIRED`、`WORKFLOW_NOT_FOUND`。Mock：未下单取消、第一单成功后取消、unknown 状态取消计划。

## 四、定时触发不是订单授权

任务记录包含 workflow_ref、owner、明确的 due_at/timezone、状态、租约和唯一 event_id。服务器可信调度只生成到期待办/刷新报价；实际下单仍走 prepare/execute 的新确认。

`order_on`：指定日到期后请求确认，有效窗口错过则显示未执行，不补单。`deliver_on`：平台支持预约配送时可以提前确认并建立指定日送达订单；否则显示缺失能力。

日期改变使原任务失效；并发 worker 不能重复领取同一任务。网页关闭、服务器重启后调度仍需从数据库恢复；仅手工推进时钟通过，不能证明真实部署后台定时已工作。

## 五、预算与部分失败的可核算例子

初始预留 1000 元：未分配 1000，占用 0，已消费 0，已释放 0。

花单 315 元已创建待支付、蛋糕单 415 元失败：未分配 685，占用 315，已消费 0，已释放 0。仍显示“花已创建待支付，蛋糕失败”，不能显示“两件已订好”。

花支付被平台确认后：未分配 685，占用 0，已消费 315，已释放 0。若客户取消剩余计划：未分配 0，占用 0，已消费 315，已释放 685。账单同步后用订单与银行交易的对应引用避免在“建议可支配金额”中重复扣 315 元；无法确认对应时标记待核对，不猜测已匹配。

始终满足 `总预留 = 未分配 + 占用 + 已消费 + 已释放`。银行余额是另一份原始事实，不以这些规划字段覆盖它。

## 六、验收证据清单

| 用户需求 | 必须看到的证据 |
|---|---|
| 一句话触发对应 Skill | 自然语言 HTTP 请求产生结构化目标，日志证明读了财务来源并调 Commerce，页面显示业务状态 |
| LLM 问答了解偏好 | 实际模型网关调用和校验结果；用户纠正被保留，缺失问题逐步减少；离线测试替身不算真实 LLM 验收 |
| 链接自选到满意 | 两类候选与有效详情链接、换一批去重、选择保留、模式切换的页面行为 |
| 预留 1000 元 | 数据库预算记录、银行余额前后相同、并发预算不超分配、取消后的核算 |
| 指定日期 | 可信时钟/重启测试以及实际部署 worker 的一次执行证据；区分下单日与送达日 |
| 确认后 Agent 下单 | 未确认时平台调用计数 0；确认后独立 HTTP 服务存在可查订单，响应丢失也不重复建单 |
| 故障可恢复 | 第二单失败、过期报价、变价、缺货、重复事件、unknown 查询、计划取消逐条测试 |
| 真实跨平台执行 | 实际平台权限、真实链接与订单/付款状态证据；未取得权限前明确未完成 |

开发交付只包含上述新功能所需文件；个人教学材料单独保存。真实平台暂缺不会阻碍开发完整模拟流程，但也不构成最终目标完成的理由。

## 七、可信页面辅助入口

`/api/purchase` 使用 `{action,input,consent:true}`，需同源请求、演示访问码和服务端签发的 HttpOnly 会话。以下辅助入口不属于模型可执行工具，不能透传模型返回的工具名。所有 input 均拒绝额外字段。

| 页面入口 | input | 用途 |
|---|---|---|
| `purchase.understand` | message，已有流程时 workflow_ref、expected_version | 将目标/偏好送现有无工具模型网关；只取校验通过的业务槽位；不发送地址、电话、订单预览和确认凭据 |
| `purchase.read` | workflow_ref | 当前用户流程、预算、逐单状态；不返回私密地址或确认凭据 |
| `purchase.draft.update` | workflow_ref、expected_version、slots | 表单补齐草案；已生效计划只生成待审核修订，不立即修改预留或已有订单 |
| `purchase.plan_preview` | workflow_ref、expected_version、可选 manual_finance | 计划或修订的精确预览；manual_finance 仅含 available_minor、obligations_minor，标注 user_provided，未经银行验证 |
| `purchase.address` | workflow_ref、expected_version、address | 可信表单填写 recipient、phone、address、region；Mock 仅支持 demo-shanghai；修改使旧预览失效 |
| `purchase.cancel_preview` | workflow_ref、expected_version | 生成取消计划的独立确认凭据 |

数据存储选择：PostgreSQL 每用户一份 JSONB 状态，使用行锁和同一事务保存预算、操作、预约、事件与版本，替代多个互相分离的表。并发操作串行检查余额；真实银行账务表不改。内存适配器只在 tests/fixtures 中使用，生产不自动降级。调度服务必须有近期数据库心跳，单独设置开关不能宣称已安排预约。
