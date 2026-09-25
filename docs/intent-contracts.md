# AI Banking Agent — Intent Contracts v1.1

> 状态：面向新版 SaveFlow Demo 的目标合同，尚未由现有代码实现；适用于 IM 输入、意图识别器、Orchestrator、六类 Skill、Financial Context、Risk & Action Engine。  
> 范围：定义“用户想做什么、已说清什么、还缺什么”；不授权银行操作。演示数据与银行接口均可为 Mock，但确认、状态与审计链路按真实系统设计。

## 0. 一句话边界

```text
用户输入 → 意图识别（ParsedIntent）→ 槽位补全/实体解析 → 规划（BankingPlan）
        → 风险校验 → 操作预览 → 用户确认 → 工具执行 → 验证与审计
```

- **识别器**提取目标、动作、用户原话中的参数及歧义；JEV、LLM、规则或其组合均只能产出同一合同。识别器不能决定账户余额是否足够、产品是否适合、风险级别或是否已经得到确认。
- **Context Resolver**从用户可访问的金融上下文查找收款人、账户、卡、交易、订阅、产品、事件。解析结果须带来源；“我妈”若匹配多人，不得猜测。
- **Orchestrator**基于一个或多个意图生成可审查的依赖步骤。分析得出的建议属于系统建议，不伪装成用户指令。
- **Skill**承接领域动作，返回证据、预览或执行结果；不能自行跳过统一的风险和确认流程。
- **Risk & Action Engine**按服务端配置确定所需权限、确认方式及有效期；只有它能下发执行许可。

## 1. 传输约定和版本

所有跨模块消息使用 UTF-8 JSON；字段名 `snake_case`；时间为含时区 ISO 8601；金额以**最小货币单位整数**表示，如 1000.00 CNY → `100000` 分；默认币种不得默认为真实银行账户币种。`request_id`、`conversation_id`、`message_id`、`intent_id`、`plan_id` 均由服务端生成。目标接口采用 `schema_version: "1.1.0"`；这是尚未落地的新合同版本，旧 Demo 的数据 `schemaVersion: "1.0.0"` 和旧业务 API 不随之自动升级。后续新增可选字段升小版本，改字段含义、改枚举或必填性升大版本。未知动作拒绝路由，未知可选字段可忽略并记录。原始语句只传内部可信组件，日志对姓名、手机号、账号脱敏。

### 1.1 识别器输出：`ParsedIntentEnvelope`

下面是 TypeScript **接口约定**，实现可改用 Python/Pydantic，但 JSON 语义须一致。`slots` 只能使用第 2、3 节注册的键与类型；服务端还要按动作注册表做交叉校验。

```ts
type Domain = "transfer" | "bill" | "wealth" | "card" | "subscription"
  | "scenario" | "orchestrator";
type IntentStatus = "recognized" | "ambiguous" | "unsupported";
type Origin = "user_explicit" | "user_implied";
type SlotSource = "utterance" | "conversation";
type SlotValue = string | number | boolean | null | SlotValue[] | { [key: string]: SlotValue };
// JSON 载体允许复合槽位；真正的字段、嵌套形状和数值范围由 action 专属 Schema 验证。

interface ParsedIntentEnvelope {
  schema_version: "1.1.0";
  request_id: string;
  conversation_id: string;
  message_id: string;
  locale: "zh-CN" | string;
  timezone: string;                  // 输入发生时的 IANA 时区，如 Asia/Shanghai
  message_time: string;              // 服务端接收时间，供“今天/下月”解析
  input_kind: "user_message" | "ui_action";
  intents: ParsedIntent[];           // 允许多意图；空数组代表未识别出可用意图
  relations: Array<{
    from_intent_id: string;
    to_intent_id: string;
    kind: "then" | "depends_on" | "alternative";
  }>;
  utterance_ref: string;             // 原文在可信会话存储中的引用；不在此复制全文
}

interface ParsedIntent {
  intent_id: string;
  domain: Domain;
  action: string | null;             // recognized/ambiguous 时须为注册的 action；unsupported 时为 null
  status: IntentStatus;
  origin: Origin;                    // 仅反映话语来源，不是执行授权
  confidence: number;               // 0..1，识别置信度，不是风险分数
  slots: Record<string, SlotValue>; // 只放话语/会话已有信息；缺失键省略，不以 null 假装已经提供
  slot_sources: Record<string, SlotSource>;
  missing_slots: string[];           // 此阶段判断的缺失，服务端会重新计算
  ambiguities: Array<{
    slot: string;
    candidates?: string[];
    question: string;
  }>;
  evidence: Array<{ text: string; start?: number; end?: number }>;
}
```

**约束：** `intents` 顺序与用户表述顺序一致；同一消息可有多个意图及未知片段，不能因部分无法识别而丢掉其他意图。未知片段可用 `status=unsupported, action=null` 保留；整句无法识别时可为空数组并由上层追问。`evidence` 是来源片段，不作为校验后的业务事实。对带编辑风险的前文指代（“改成 2000”“就那个”），仅用当前有效会话上下文解析；不明确则追问。解析器不得填充 `risk_level`、`confirmed`、`tool_name`、`account_balance` 或执行结果。`ui_action` 由服务端识别实际按钮和当前预览，不把按钮文案当自然语言授权。可信定时/账户事件经独立 `EventEnvelope` 进入规划器，**不走用户意图识别器**。

### 1.2 服务器处理结果：`ResolvedIntent`

```ts
interface ResolvedIntent {
  intent_id: string;
  action: string;
  resolved_slots: Record<string, unknown>;
  references: Array<{
    slot: string; entity_type: string; entity_id: string;
    source: "financial_context" | "user_selection" | "tool_result";
  }>;
  state: "needs_clarification" | "ready_for_planning" | "unsupported";
  missing_slots: string[];
  clarification?: { question: string; options?: Array<{ label: string; entity_id: string }> };
}
```

`ResolvedIntent` 的 `entity_id` 来自服务端数据，不接受模型编造。**“可规划”不等于“可执行”。** 无法匹配收款人、账户、产品或撤销对象时保持 `needs_clarification`。一个关键歧义每轮优先问一个问题，保留已确定槽位。

## 2. 动作注册表（六项赛题全覆盖）

动作 ID 是稳定的路由键；技能内部可有更多工具，但不得把工具名当作用户意图。`必备槽位` 表示进入**该动作预览或执行**所需信息，查询目标的初始识别允许缺失。

| Skill | action ID | 含义及典型说法 | 预览/执行前必备槽位 | 副作用分类 |
|---|---|---|---|---|
| 智能转账 | `transfer.create` | 按姓名/手机号/备注转一次账 | `payee_ref`, `amount`, `source_account_ref`；备注类收款人需先解析 | 资金 |
| 智能转账 | `transfer.schedule` | 定时或周期转账 | 同上 + `schedule`；周期结束条件按产品规则补齐 | 持续资金 |
| 智能转账 | `transfer.split_bill` | 按 AA 计算份额并发起收款/提醒 | `total_amount`, `participants`, `split_rule`；实际转出另建 `transfer.create` | 收款请求可能对外 |
| 账单分析 | `bill.analyze` | 消费分类、区间收支、对比、原因解释 | `period`（模糊“这个月”先按会话时区解析） | 只读 |
| 账单分析 | `bill.detect_anomaly` | 异常交易、重复扣费 | `period` 或明确的 `transaction_ref` | 只读 |
| 账单分析 | `bill.report` | 月度/年度报告 | `period`, `granularity` | 只读 |
| 账单分析 | `bill.forecast_cashflow` | 未来可支配金额、近期待扣款 | `horizon`；服务端补足账户范围 | 只读 |
| 理财操作 | `wealth.recommend` | 基于目标筛选产品 | `goal`；实际推荐前须读取风险与期限/流动性约束 | 只读建议 |
| 理财操作 | `wealth.compare` | 比较指定产品 | `product_refs`（至少 2 个） | 只读 |
| 理财操作 | `wealth.assess_risk` | 风险测评/适配检查 | `assessment_scope`；法定问卷不能由模型代答 | 数据/测评 |
| 理财操作 | `wealth.subscribe` | 申购 | `product_ref`, `amount`, `source_account_ref`；资格、适配与披露由服务端检查 | 资金 |
| 理财操作 | `wealth.redeem` | 赎回 | `holding_ref`, `quantity_or_amount`；核对份额和到账规则 | 资金 |
| 卡片管理 | `card.apply` | 申请卡片 | `card_product_ref`；申请资料由正式流程补充 | 申请 |
| 卡片管理 | `card.set_limit` | 调整总额/单笔/分类限额 | `card_ref`, `limit_type`, `amount` | 控制变更 |
| 卡片管理 | `card.set_rule` | 线上/境外开关、交易类别或商户限制 | `card_ref`, `rule_type`, `rule_value` | 控制变更 |
| 卡片管理 | `card.freeze` / `card.unfreeze` | 冻结/解冻 | `card_ref` | 控制变更 |
| 卡片管理 | `card.report_loss` | 挂失 | `card_ref`；特殊不可逆限制由银行能力决定 | 控制变更 |
| 订阅/代扣 | `subscription.list` | 自动识别、查询扣款、续费/涨价提醒 | 可选 `period` | 只读 |
| 订阅/代扣 | `subscription.cancel_debit` | 解除银行侧代扣授权 | `mandate_ref`；必须核对可撤销性 | 授权变更 |
| 订阅/代扣 | `subscription.remind` | 设置提醒 | `subscription_ref`, `remind_at` | 提醒 |
| 跨场景联动 | `scenario.create_rule` | 将用户目标保存为事件规则 | `trigger`, `conditions`, `proposed_steps`；明确用户授权范围 | 自动化规则 |
| 跨场景联动 | `scenario.update_rule` / `scenario.disable_rule` | 改规则/停规则 | `rule_ref`；更新时需变更内容 | 自动化规则 |
| 跨场景联动 | `scenario.review_event` | 事件发生后重新评估财务上下文 | `event_ref`；由可信事件总线提供 | 只读/建议 |

总管可以识别 `orchestrator.goal`（槽位：`goal_text`，可选 `horizon`、`constraints`），如“帮我看看这个月财务情况”“下个月房租提前安排好”。这类目标只触发规划，**不能把“帮我看看”解释为授权取消订阅或购买理财**。跨场景联动是规则和流程能力，不假设一定有真实的花店接口。`scenario.create_rule` 可编排其他 Skill，不能代替它们的确认。

**能力边界：** 银行侧解除代扣授权不等于已取消商户会员；应分别展示商户侧状态与银行侧状态。AA 算账和收款请求不等于自动扣其他人的钱。预留资金须区分“预算占用/展示性预留”与银行真实冻结；只有注册了对应能力才可显示“已锁定资金”。订花、订蛋糕需独立外部服务能力和支付确认；Demo 可使用明确标注的 Mock 工具。

## 3. 通用槽位词典

| 槽位 | 规范类型与示例 | 约束 |
|---|---|---|
| `amount`, `total_amount` | `{ "amount_minor": 100000, "currency": "CNY" }` | 严禁浮点金额；不得从余额推断用户指定金额 |
| `payee_ref`, `card_ref`, `account_ref`, `source_account_ref`, `product_ref`, `holding_ref`, `mandate_ref`, `subscription_ref`, `rule_ref` | 识别阶段可为用户原称谓字符串；解析后为服务端 ID | “我妈”、卡尾号、昵称需解析；手机号仅在必要时处理并脱敏 |
| `period`, `horizon`, `remind_at` | 含时区的时间/区间对象；如 `{"date":"2026-09-01","timezone":"Asia/Shanghai"}` | “昨天/下月/生日前 2 天”按 `message_time` 和用户时区计算；跨年要核实 |
| `schedule`, `trigger` | 可执行时间规则对象；如 `{"recurrence":"MONTHLY:DAY=1","timezone":"Asia/Shanghai"}` | 定时/重复规则需要明确触发条件；不要让模型产未经校验的 cron |
| `participants`, `split_rule` | 收款人列表与 `equal` / `specified` | 人数含不含本人须确认；金额余数要有明确分配规则 |
| `goal`, `goal_text`, `constraints` | 用户原始目标及时间、风险、流动性约束 | “风险低”不可替代正式风险评估 |
| `quantity_or_amount` | 份额数量或金额，必须指明单位 | 赎回份额与人民币金额不能混用 |
| `conditions`, `proposed_steps` | 规则前提及候选动作 | 在创建规则时只是计划；事件到来要再次核验数据与确认要求 |

`slot_sources` 只允许 `utterance`/`conversation`；从数据库补全的值只能出现在 `ResolvedIntent.references`。默认账户、默认卡、常用收款人可以作为候选建议，但有多个候选或重要信息不一致时必须追问。来源证据贯穿分析结果，便于解释“为什么建议调整购物卡限额”。

**逐动作 Schema 必须补充：** `period`/`horizon` 的起止与开闭区间、`schedule` 的执行时刻与结束条件、`participants` 的成员及本人是否计入、`quantity_or_amount` 的单位、`rule_value` 的布尔/类别形状、`proposed_steps` 的动作与最大权限。`granularity`、`assessment_scope`、`card_product_ref`、`limit_type`、`rule_type`、`rule_value`、`event_ref`、`trigger` 和 `conditions` 也要在对应动作 Schema 明确定义；不能因为通用 JSON 类型宽松就通过业务校验。服务端将相对时间按 `message_time` 和时区解析，并记录原始表达与解析基准。

## 4. 从意图到执行的第二份合同

计划和执行消息**与意图输出分开**，以防止模型输出“已确认”绕过安全门。服务器负责组装以下对象：

```ts
interface BankingPlan {
  schema_version: "1.1.0";
  plan_id: string;
  based_on_intent_ids: string[];
  context_snapshot_id: string;           // 计划所用数据的版本/快照
  steps: Array<{
    step_id: string;
    action: string;
    depends_on: string[];
    origin: "user_requested" | "agent_suggested" | "event_triggered";
    mode: "read" | "preview" | "execute";
    inputs: Record<string, unknown>;
    state: "planned" | "awaiting_clarification" | "awaiting_confirmation"
      | "executing" | "succeeded" | "failed" | "skipped";
  }>;
}

interface ActionPreview {
  plan_id: string;
  step_ids: string[];
  summary: string;                        // 谁、从哪、给谁、多少、何时、费用/预计到账等
  exact_effects: Array<Record<string, unknown>>;
  risk_level: "L0" | "L1" | "L2" | "L3"; // 服务端策略计算，不接受识别器输入
  warnings: string[];
  expires_at: string;
  preview_hash: string;                   // 服务端根据标准化效果计算
}

interface UserDecision {
  plan_id: string;
  preview_hash: string;
  decision: "confirm" | "reject";
  confirmed_step_ids: string[];
  confirmation_method: string;            // 服务端记录的真实交互方式
  idempotency_key: string;                 // 服务端生成，每次操作唯一
}
```

| 级别 | 典型动作 | 执行门槛 |
|---|---|---|
| L0 | 余额/账单查询、产品公开信息查询 | 鉴权后可执行 |
| L1 | 报告、分类、普通提醒 | 用户已有授权范围内执行；规则持久化按 L2 |
| L2 | 修改卡规则/额度、解除代扣、建立自动化规则、外部收款请求 | 对**每项真实效果**展示预览并确认 |
| L3 | 转账、定时/周期转账授权、理财申购/赎回、任何外部支付 | 精确预览 + 强确认；真实接入时服从银行现有鉴权、适当性和合规要求 |

实际等级以银行服务端规则为准，不能被模型降低。一个“全部处理”只表示要求生成汇总预览，不视为对未来动态金额、未来收款人或未展示步骤的永久授权；混合 L2/L3 步骤需按业务能力分别确认。参数、收款人、产品、费用、规则或风险状态变化使 `preview_hash` 失效，重算并重新确认。真实执行需复核权限、余额/持仓、适当性、限额、时效、重复请求，再通过 Mock/银行 API 执行；返回订单号、真实状态和审计记录。超时不能当成功，重试必须用同一幂等键核查。部分失败逐步报告，不能声称整单完成。

## 5. 三个标准示例

### 示例 A：“给我妈转 1000 元”

```json
{
  "schema_version": "1.1.0",
  "request_id": "req_demo_1",
  "conversation_id": "conv_demo",
  "message_id": "msg_demo_1",
  "locale": "zh-CN",
  "timezone": "Asia/Shanghai",
  "message_time": "2026-09-22T09:00:00+08:00",
  "input_kind": "user_message",
  "utterance_ref": "msg_demo_1",
  "intents": [{
    "intent_id": "intent_demo_1",
    "domain": "transfer",
    "action": "transfer.create",
    "status": "recognized",
    "origin": "user_explicit",
    "confidence": 0.98,
    "slots": {"payee_ref": "我妈", "amount": {"amount_minor": 100000, "currency": "CNY"}},
    "slot_sources": {"payee_ref": "utterance", "amount": "utterance"},
    "missing_slots": ["source_account_ref"],
    "ambiguities": [],
    "evidence": [{"text": "给我妈转 1000 元"}]
  }],
  "relations": []
}
```

接下来：解析“我妈”身份与到账账户；选择/核实付款账户、余额及费用；输出预览；请求 L3 强确认；调用转账工具。即使识别器置信度 0.98，也不能跳过以上任何一步。

### 示例 B：“帮我看看这个月财务情况”

`orchestrator.goal`，`slots.goal_text = "看看这个月财务情况"`，`slots.horizon` 从输入与会话时区解析。规划器可读账单、订阅、待扣款及可支配余额，随后提出取消闲置订阅、调整购物卡额度、查看理财方案等**建议**。这些建议的 `origin = agent_suggested`；用户选择后才创建相应操作的预览。不得凭一句“看看”自动申购或取消。

### 示例 C：“我爱人生日那个月预留 1000 元，生日前两天买花和蛋糕”

识别 `scenario.create_rule`。槽位包含关系对象、`amount=100000 CNY`、生日前两天的相对触发条件、购买商品目标；先解析生日与年份、确认“预留”采用预算标记还是真实资金锁定、补充商品规格/商户/价格上限/配送地址，并查外部购买能力。只能建立有明确权限范围的规则；每次触发应重读现金流，支付/订购前再次出具具体预览并按 L3 确认。缺少外部接口的 Demo 只展示 Mock 订单状态。

## 6. 校验、失败和交接验收

1. **解析校验**：JSON Schema/Pydantic 验证版本、枚举、金额类型、置信度范围、槽位来源、ID 引用和 `relations` 无环；对 `recognized/ambiguous` 拒绝未注册 action/槽位，`unsupported` 只允许 `action=null` 且不路由 Skill。用户原话中的“忽略确认”只能作为文本证据，不能作为系统指令。
2. **状态校验**：对每个 action 由服务端重算必备槽位；先追问，再解析实体，再规划。未支持的银行/外部能力返回 `unsupported` 及可替代的查询/手动路径，禁止静默当成功。
3. **端到端样例**：按姓名转账、定时房租、三人 AA、月度账单异常、闲置资金理财对比与申购预览、购物卡限额调整、订阅代扣解除、生日跨场景规则各至少一条；覆盖多意图、歧义、取消确认、预览过期、重复请求和部分失败。
4. **模块交接**：意图组提供 `ParsedIntentEnvelope` 与标注语料；Context 组提供实体解析及证据；各 Skill 组提供 action 注册、槽位规则、预览与 Mock 工具；风险组提供服务端分级、确认令牌/幂等与审计；前端只消费统一的澄清、预览、确认和执行状态。

## 7. 扩展点与兼容策略

| 将来扩展 | 接入位置 | 不需要改动的边界 |
|---|---|---|
| JEV + LLM、纯 LLM、分类器联合识别 | 识别器适配层，同样输出 v1.1 envelope | Skill、Risk 不关心识别技术；可以先用规则/Mock 造样例 |
| 新增同义说法、方言、输入形式 | 解析语料与 `evidence` / `input_kind` | action ID 与已上线 Skill 不变 |
| 增加新银行业务能力或细粒度子动作 | action 注册表、槽位校验器、Skill 实现 | 既有 action 保持原语义；不复用旧 ID 表达新副作用 |
| 更复杂多意图和跨场景编排 | `relations`、`BankingPlan.steps.depends_on` | 识别器仍只报用户目标与显式依赖，规划器补充步骤 |
| 个性化金融记忆与主动事件 | Context Resolver、独立 `EventEnvelope` 与可信事件总线 | 事件本身不构成用户确认；规则权限单独管理 |
| 银行接口替换 Mock、增加外部商户 | Tool Registry 与 Skill adapter，含 capability/环境标识 | 预览、确认、幂等、审计仍在统一执行层 |
| 风控与合规规则更新 | 服务端 Risk Policy 版本 | 模型输出及前端不能自行降低门槛 |

**迭代顺序：** 先冻结 v1.1 action ID、通用槽位、状态和确认语义；用样例 JSON 跑通 `识别 → 解析 → 计划 → 预览 → 确认 → Mock 执行`；随后分别替换识别技术与银行工具。现有单意图输出在入口做过渡 adapter；不能映射的动作保持 `unsupported` 或转入追问，不让六个 Skill 分别适配六套意图格式。

## 8. 与 2026-09-22 新版 SaveFlow Demo 的对接说明

**结论：可复用前端入口、Qwen 服务端调用、合成账单和“草稿→确认→结果待核实”的交互骨架；目前尚未实现本合同的 `ParsedIntentEnvelope`、六类 Skill、跨能力规划和统一执行门。** 本节以压缩包中的源码为准，不将规划项写成已完成功能。

| 当前源码/数据 | 当前语义 | 目标合同中的位置与动作 |
|---|---|---|
| `server/qwen.mjs` → `intent=create_plan/update_saving_rule/analyze_bills/subscriptions/clarify/unsupported` | 单一旧枚举，另带 `reply`、`plan`、`analysis`；模型解析与业务计划部分混在 `interpret()` | 在服务端新增 Parser 输出 v1.1 envelope；`analyze_bills` 可映射 `bill.analyze`，`subscriptions` 只有查询意图时可映射 `subscription.list`；`clarify` 是交互状态，不能作为 action |
| `create_plan` / `update_saving_rule` 和 `AgentPlan` | 月金额 + 消费类别储蓄比例的旧计划 | 不映射 `wealth.subscribe`、`card.set_limit`、`scenario.create_rule`；若保留普通目标储蓄，另注册 `goal.create`，只创建目标/提醒，不自动消费扣划。消费比例规则从比赛主链路下线 |
| `src/lib/api/contracts.ts` 的 `analyze/create-plan/operation-status` | SaveFlow 专用业务 API，`confirmed:true`、`Idempotency-Key`、操作回执 | 作为过渡实现保留；新 Skill 使用独立 action 注册和逐步回执。`confirmed:true` 只供旧模拟计划使用，不能成为转账/申购等动作的授权凭证 |
| `flow-machine.ts` 与 `use-saveflow.ts` | 单张储蓄计划的状态与写后查询，Qwen 读请求可以追问/回答 | UI 状态骨架可复用；扩展为每个 `step_id` 的预览、确认、执行、待核实和部分失败。禁止把一个 `success` 表示多步骤全部成功 |
| `saveflow_mock_data.json` | 用户、2 账户、36 笔交易、3 个月汇总、2 卡、2 订阅、1 目标、2 预算 | 可支撑部分账单/卡片/订阅查询演示；缺收款人及收款账户、授权代扣、理财产品/持仓/测评、未来事件/待扣款/订单、能力注册与审计记录，不能直接演示其操作成功 |

### 8.1 对接时必须统一的口径

1. **日期与数据有效期**：种子数据 `snapshotDate=2026-09-01`，账单样例 `currentMonth=2026-08`；Qwen 提示词使用运行时的“今天”。不能直接把 8 月样例说成当前月、把 9 月余额当作实时余额或据此算未来十天现金流。Demo 固定“数据截至 2026-09-01”，或者提供可重放的 `as_of` 与未来事件数据；统计结果携带区间、数据截点与来源。
2. **数据口径**：种子文件 `savingGoals[0].currentAmount=0`、`proposedMonthlySaving=5000`；服务端 `savedAmountFen=240000` 和页面“已完成 ¥2,400”，且创建计划上限为每月 ¥3,000，三处互相冲突。先确定唯一的目标进度、月金额口径及演示目标是否可达，再由 Context 统一供给。账户余额、月收入、月支出不能替代可投资金额或可转账余额；可用金额须扣除已知义务，并明确未知事项。
3. **字段映射**：旧 API 用 `camelCase` 和 `Fen/Bps` 后缀，新内部合同用 `snake_case`、`amount_minor + currency`；只在边界 adapter 转换。`monthlySavingFen` ≠ 转账金额，`saveRateBps` ≠ 卡限额。数据里的 `savingRate` 属旧消费储蓄设计，可留在历史字段但不作为新 Skill 的输入。
4. **模型与权限**：Qwen 目前返回已经计算好的 `plan` 及自然语言 `reply`，只能作为草稿建议；新流程先验证意图和槽位，再由服务端读 Context、生成逐步计划、预览哈希和确认凭证。旧前端 `confirmed:true` 与演示访问码不能用于 L2/L3 真实授权。
5. **跨场景触发**：只有模拟事件数据或可信事件源才可生成 `scenario.review_event`。定时任务与用户输入必须区分来源、权限、去重及重放；事件触发后产生建议，不继承用户上次对未来付款的确认。

### 8.2 最小迁移顺序与验收

1. **先加适配层**：保留现有 `/api/agent` 对旧 UI 的响应，在同一服务端引入 `parseMessage()` 与 v1.1 envelope 验证；用八类黄金语句覆盖六个领域、复合目标、追问、未知意图。旧枚举不能一对多凭空补出用户没有说过的动作；Qwen/JEV 可替换 Parser 内部算法，不改变 v1.1 输出。
2. **再加数据/只读 Skill**：给合成数据添加 `as_of`；先实现 `bill.analyze`、`subscription.list`、卡片查询和 `orchestrator.goal` 的多步骤只读计划，返回来源与数据范围。卡片查询若对用户开放，需要另注册 `card.get`；不要误用 `card.set_limit`。
3. **最后加写操作**：为每个新动作增加 Mock 工具、逐动作 Schema、服务端预览与授权、幂等回执/状态查询和审计；先贯通一个 L2（如卡额度）与一个 L3（如模拟转账），再扩展理财、代扣和场景规则。未具备对应数据和工具时明确显示“仅建议/尚未支持”。

**演示剧本核验：** 当前可以展示账单摘要、订阅摘要和模拟储蓄计划；“转账成功”“已取消商户会员”“卡限额已更新”“理财已申购”“生日规则已执行”目前都不能在此版本中宣称。新主剧情建议从“8 月支出为何增加”开始，逐步加入待扣款、卡限额建议和逐项确认的 Mock 执行；普通目标储蓄只作为可选支线。
