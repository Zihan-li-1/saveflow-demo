import { PARSED_INTENT_ACTIONS } from '../src/agent/validate-parsed-intent.mjs';
import { READ_ONLY_TOOL_NAMES } from './read-only-tool-gateway.mjs';

// Reviewed against dispatchParsedIntent, runBankingConversation and Core ports.
// Availability requires runtime ports/data, never the presence of a source file.
const definitions = [
  ['transfer.create', '转账及本人账户互转', ['getAccounts', 'getPayees'], true],
  ['bill.summary', '账单查询和支出分析', ['getTransactions'], false],
  ['subscription.list', '订阅查询和潜在闲置分析', ['getSubscriptions'], false],
  ['card.get', '卡片查询', ['getCards'], false],
  ['card.security_review', '卡片安全处理建议', ['getCards'], false],
  ['card.set_budget', '调整模拟卡片月预算', ['getCards'], true],
  ['card.set_controls', '调整模拟卡片支付控制', ['getCards'], true],
  ['card.freeze', '冻结模拟卡片', ['getCards'], true],
  ['card.unfreeze', '解冻模拟卡片', ['getCards'], true],
  ['wealth.recommend', '按条件筛选模拟理财产品', ['getInvestmentProducts'], false],
  ['wealth.compare', '比较模拟理财产品', ['getInvestmentProducts'], false],
  ['wealth.assess_risk', '提示用户填写风险测评', ['getInvestmentProducts'], false],
  ['wealth.subscribe', '模拟理财申购', ['getInvestmentProducts'], true],
  ['wealth.redeem', '模拟理财赎回', ['getInvestmentProducts'], true],
  ['orchestrator.goal', '储蓄目标核算与建议', ['getTransactions', 'getAccounts'], false],
  ['scenario.create_rule', '创建模拟场景规则', ['getSubscriptions'], true],
  ['scenario.update_rule', '修改模拟场景规则', ['getSubscriptions'], true],
  ['scenario.disable_rule', '停用模拟场景规则', ['getSubscriptions'], true],
  ['scenario.review_event', '查看模拟场景事件', ['getSubscriptions'], false],
];

export async function buildCapabilityCatalog({ core, repository = core?.repository, env = process.env } = {}) {
  let context;
  try { context = await repository?.getContextInfo?.(); } catch { /* Fail closed, without exposing connection details. */ }
  const dataReady = !!context?.dataSource;
  const modelReady = !!env.TRUEFORGE_MODEL && !!env.TRUEFORGE_BASE_URL;
  const entries = definitions.map(([action, description, ports, write]) => {
    const handler = PARSED_INTENT_ACTIONS.includes(action);
    const data = dataReady && ports.every(port => typeof repository?.[port] === 'function');
    const coreReady = !write || ['prepare', 'decide', 'execute'].every(port => typeof core?.[port] === 'function');
    const wealthReady = !['wealth.subscribe', 'wealth.redeem'].includes(action) || !!core?.wealthPorts;
    const available = handler && data && coreReady && wealthReady && modelReady;
    return { action, description, status: available ? 'available_demo' : 'unavailable',
      evidence: { registered: handler, formalHandler: 'ParsedIntent v1 Dispatcher / Banking Orchestrator', repositoryReady: data, corePortsReady: coreReady && wealthReady,
        deployment: env.NETLIFY ? 'hosted_demo' : 'local_demo', modelConfigured: modelReady },
      mockOnly: true, preview: available && write, confirmation: available && write, execution: available && write,
      dataSource: dataReady ? '模拟 Banking Repository' : '尚未核验数据源',
      limitations: [
        ...(write ? ['仅模拟数据；需要正式预览、页面确认和必要验证；不操作真实银行资金'] : ['只读；不能代替用户授权或保证收益']),
        ...(action === 'transfer.create' ? ['只解析已有模拟收款人及本人账户称谓；不支持任意真实卡号或手机号转账', '高风险转账需要可用的受控验证码渠道；不承诺真实短信或生物识别验证'] : []),
        ...(action === 'card.set_budget' ? ['月预算是应用内消费预算，不是银行硬限额，也不自动拦截消费'] : []),
      ] };
  });
  entries.push({ action: 'product.list', description: '浏览模拟理财产品', status: dataReady && modelReady && typeof repository?.getInvestmentProducts === 'function' ? 'planning_only' : 'unavailable',
    evidence: { registered: PARSED_INTENT_ACTIONS.includes('product.list'), formalHandler: 'ReadOnlyToolGateway', planningTool: READ_ONLY_TOOL_NAMES.includes('product.list') },
    mockOnly: true, preview: false, confirmation: false, execution: false, dataSource: '模拟产品目录', limitations: ['当前单项 Dispatcher 未实现；仅只读规划可调用'] });
  entries.push({ action: 'planning.read_only', description: '跨账单、订阅、卡片和产品的多步骤只读分析', status: dataReady && modelReady ? 'available_demo' : 'unavailable',
    evidence: { formalHandler: 'runReadOnlyPlanner / ReadOnlyToolGateway', tools: [...READ_ONLY_TOOL_NAMES], repositoryReady: dataReady, modelConfigured: modelReady },
    mockOnly: true, preview: false, confirmation: false, execution: false, dataSource: '已核验的模拟 Repository / Skill 结果', limitations: ['最多六轮；不能执行写操作；理财条件必须由用户明确提供'] });
  entries.push({ action: 'scenario.plan_purchase', description: '生成鲜花或蛋糕的平台购物搜索链接', status: dataReady && modelReady ? 'available_demo' : 'unavailable',
    evidence: { registered: PARSED_INTENT_ACTIONS.includes('scenario.plan_purchase'), formalHandler: 'Banking Orchestrator purchase_request / purchase-links', repositoryReady: dataReady, modelConfigured: modelReady },
    mockOnly: true, preview: false, confirmation: false, execution: false, dataSource: '应用内品类与平台搜索链接', limitations: ['仅支持 flowers/cake，不支持耳机等其他商品类别', '只生成购物链接，不代表已经下单或预留预算；不创建真实订单'] });
  entries.push({ action: 'purchase.budget_reservation', description: '购物预算预留及提醒场景', status: env.DATABASE_URL ? 'conditional' : 'unavailable',
    evidence: { registered: PARSED_INTENT_ACTIONS.includes('scenario.plan_purchase'), formalHandler: 'configuredPurchaseSkill / purchase API', persistenceConfigured: !!env.DATABASE_URL, schedulerVerified: false },
    mockOnly: true, preview: !!env.DATABASE_URL, confirmation: !!env.DATABASE_URL, execution: false, dataSource: '应用内购物目录和预算记录', limitations: ['持久化和预约工作进程需在购物接口另行核验；当前没有核验工作进程心跳', '预算预留是应用内记账，不是真实资金冻结；链接不代表下单；不能创建真实订单'] });
  entries.push({ action: 'subscription.cancel', description: '取消真实第三方会员或订阅', status: 'unavailable', evidence: { registered: false, formalHandler: '无取消 Handler 或第三方授权' },
    mockOnly: false, preview: false, confirmation: false, execution: false, dataSource: '无第三方取消接入', limitations: ['只能查询和分析订阅；请到对应平台自行取消'] });
  return entries;
}

export function publicCapabilityCatalog(catalog) {
  return catalog.map(({ action, description, status, mockOnly, preview, confirmation, execution, dataSource, limitations }) =>
    ({ action, description, status, mockOnly, preview, confirmation, execution, dataSource, limitations }));
}

export function capabilityIntroduction(catalog) {
  const available = catalog.filter(item => item.status === 'available_demo').map(item => item.description);
  return `我是 SaveFlow，可以自然交流、解释金融概念和操作步骤。${available.length ? `当前可用的模拟功能：${available.join('、')}。` : '当前业务数据或运行服务尚未核验，暂不能承诺业务功能可用。'}资金和卡片写入均为模拟，需要正式预览、页面明确确认及必要验证。只能查询和分析订阅，不能取消真实会员；购物链接不代表下单，预算预留只是应用内记账。`;
}
