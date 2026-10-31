// Descriptions of existing callable actions, not new business capabilities.
const actions = {
  'bill.summary': ['monthly_spending_summary', '按明确日历月汇总已有交易的收入、支出、分类金额和上一月变化。用户可问钱花在哪、上月花销；不能按卡筛选或创建提醒。'],
  'subscription.list': ['subscription_overview', '查询已有订阅、每月费用和可能闲置的标记；不取消会员或代扣。'],
  'card.get': ['card_budget_snapshot', '读取指定模拟卡当前状态、月预算和已消费，可回答预算剩多少、消费接近预算没有；不是任意历史月份或商户交易查询。'],
  'card.set_budget': ['card_budget_proposal', '生成调整指定模拟卡月预算的操作请求；不能当作银行硬限额或已修改成功。'],
  'card.freeze': ['card_freeze_proposal', '用户明确要求时生成冻结指定模拟卡的操作请求。'],
  'card.unfreeze': ['card_unfreeze_proposal', '生成解冻指定已冻结模拟卡的操作请求。'],
  'wealth.compare': ['investment_comparison', '比较至少两个用户明确指出的模拟理财产品的风险、期限、流动性和预期收益，不购买产品。'],
  'wealth.recommend': ['investment_screening', '依据用户明确提供的目标、风险上限、期限、流动性和可选金额筛选模拟理财产品，不承诺最高收益或适当性通过。'],
  'wealth.assess_risk': ['risk_questionnaire_requirement', '提示用户完成适当性问卷，不代替用户填写问卷。'],
  'scenario.create_rule': ['suggest_only_rule_proposal', '生成触发条件和只读建议步骤明确的模拟规则提案；不会运行后台监听、比较实时阈值或发送通知，不能把提醒目标冒充规则已生效。'],
  'scenario.review_event': ['trusted_event_review', '复核可信事件存储中的已有事件，读取当前财务上下文并给建议；用户描述不等于可信事件。'],
  'transfer.create': ['external_transfer_resolution', '根据明确的转出账户称谓、已有收款人称谓、人民币金额解析外部转账提案；购物预算不是转账金额，不支持任意真实卡号转账。'],
};
const notes = {
  bill: { description: '理解用户查看钱花在哪、某月收支、支出变化、订阅开销的目标，调用现有月账单摘要或订阅查询；必须明确月份，不把买东西的价格当账单。', use_when: ['用户关心某月收入与支出', '用户想核对订阅费用或闲置订阅'], do_not_use_when: ['用户要设置卡预算或提醒', '用户要生成商品搜索链接', '用户只提到金额但没有查询个人流水的目标'] },
  card: { description: '理解用户查看一张已有模拟卡的状态、预算和已消费，以及明确要求调整预算、冻结或解冻的目标。通过既有实体解析消除卡片歧义。', use_when: ['用户问卡预算剩多少或卡状态', '用户明确要求修改月预算、冻结、解冻'], do_not_use_when: ['查询全账户某月交易明细', '生成商品搜索链接', '建立后台阈值通知或注销卡片'] },
  wealth: { description: '理解用户比较已有模拟产品或依据明确的目标、风险、期限与流动性筛选产品；条件不足需追问，不能将想多赚一点直接视为授权投资。', use_when: ['用户比较两个理财产品', '用户希望为应急金等目标筛选产品', '用户想了解测评流程'], do_not_use_when: ['付款或转账', '购买商品', '保证收益、代答问卷或实际申购赎回'] },
  scenario: { description: '理解用户组织触发条件、约束和只读建议步骤的规则提案，或复核已有可信事件的目标。规则提案不提供后台监听和通知能力。', use_when: ['用户明确要创建仅生成建议的规则提案', '用户复核已有可信事件'], do_not_use_when: ['要求完成阈值监控或发送通知', '规则预授权转账、购买理财', '耳机等通用商品搜索；购物子流程也仅支持鲜花/蛋糕且未注册到本统一接口'] },
  transfer: { description: '理解用户从哪个已有模拟账户向哪位已有收款人划转多少钱的目标，保留原始称谓并请求缺失信息。当前统一接口只解析外部转账，不扣款。', use_when: ['用户明确要给某人转钱', '用户补充本次转账的账户、收款人或精确金额'], do_not_use_when: ['用户描述购物预算', '用户问消费或理财产品', '仅出现数字或币种但没有资金划转目标'] },
};
export function actionSchemas(schema) {
  return (schema.oneOf ?? schema.anyOf ?? [schema]).filter(branch => branch.properties?.action?.const).map(branch => ({ action: branch.properties.action.const, schema: branch }));
}
export function enrichDefinition(definition, examples = []) {
  const supported = actionSchemas(definition.input_schema).filter(item => actions[item.action]);
  return { ...definition, ...(notes[definition.name] ?? {}),
    capabilities: supported.map(({ action, schema }) => ({ id: actions[action][0], action, description: actions[action][1], input_schema: schema })),
    required_parameters: supported.map(({ action, schema }) => ({ action, fields: (schema.required ?? []).filter(name => name !== 'action') })),
    optional_parameters: supported.map(({ action, schema }) => ({ action, fields: Object.keys(schema.properties).filter(name => name !== 'action' && !schema.required?.includes(name)) })),
    examples: examples.filter(item => item.kind !== 'counter'), counter_examples: examples.filter(item => item.kind === 'counter'),
  };
}
