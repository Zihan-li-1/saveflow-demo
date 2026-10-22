# 虚拟卡查询与安全管理

Banking Agent 注册 `card.get`、`card.set_budget`、`card.set_controls`、`card.security_review`、`card.freeze`、`card.unfreeze`。`card.set_budget` 设置可超出的月消费预算，不是消费硬限额。预算设置成功后，界面会提示用户继续设置余额提醒；`card.set_controls` 支持固定剩余金额或预算剩余百分比两种余额阈值（两者互斥），也管理线上支付、禁用消费类别和单笔提醒，所有修改都必须经过预览与用户确认。达到阈值时显示余额提醒；即使未设置阈值，预算余额用完时也会提醒。`card.security_review` 只给出卡片信息泄露、异常交易或设备丢失的处置建议；即使建议冻结，也不会替用户执行。虚拟卡注销或换号依赖发卡银行能力，本模块不伪装成传统挂失补卡。

| 动作 | 模型可提供的槽位 | Skill 写请求 | Core 效果 |
| --- | --- | --- | --- |
| `card.get` | `card_ref` | 无 | 查询当前卡片、预算、消费和版本 |
| `card.set_budget` | `card_ref`、`amount` | `{action:"card.set_budget",input:{cardId,monthlyBudgetFen}}` | 更新月预算；版本加一 |
| `card.set_controls` | `card_ref`，以及至少一项安全设置 | `{action:"card.set_controls",input:{cardId,...controls}}` | 用户确认后更新交易权限或提醒 |
| `card.security_review` | `card_ref`、`issue_type` | 无执行请求 | 返回只读处置建议，绝不自动冻结 |
| `card.freeze` | `card_ref` | `{action:"card.freeze",input:{cardId}}` | `active → frozen`；版本加一 |
| `card.unfreeze` | `card_ref` | `{action:"card.unfreeze",input:{cardId}}` | `frozen → active`；版本加一 |

模型只能保留原始卡片称谓，不能提供卡片 ID、风险等级、确认标记或操作编号。缺少卡片或金额时追问；卡片称谓不唯一时显示候选，用户选中后重新校验归属。Skill 只读取卡片并生成内部请求，不会修改卡片。

Agent HTTP 入口把 Skill 写请求交给 Banking Core `prepare()`，返回带卡名、版本、变更前后值、风险、警示、有效期、预览哈希和操作编号的正式预览。只有页面确认按钮调用独立的 `action.decide` 和 `action.execute` 接口。聊天中的“确认”不执行操作。`execute()` 使用保存的请求，重新检查预览、卡片状态、版本及确认决定，并以事务提交卡片变更与回执；重复执行同一操作返回原回执。页面在收到成功回执后重新 `card.get`，以查询结果显示最新值；结果未知时保留操作编号供 `action.status` 查询。

新预览会使同一卡片的旧预览失效。服务端以 `previewGeneration` 复核，不依赖页面隐藏按钮。Postgres 使用 `migrations/002_cards.sql` 和 `migrations/004_card_security_controls.sql` 存储用户归属、卡片状态、预算、消费、安全设置、版本与预览代数；种子只在首次创建卡片时插入，不覆盖已修改值。部署前运行 `npm run db:migrate`，并配置 `DATABASE_URL`。没有数据库时，仅适用于单进程 Mock 演示。
