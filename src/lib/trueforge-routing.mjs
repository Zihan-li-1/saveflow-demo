// Retired standalone MCP pilot phrase helpers plus period copy.
// The Banking API and UI do not use these to choose an understanding backend.
const trueforgeError = (code, userMessage, status) => Object.assign(new Error(userMessage), { code, userMessage, status });

export const YEAR_MONTH = '(?:\\d{4}\\s*年\\s*\\d{1,2}\\s*月|\\d{4}-\\d{1,2})';
const YEAR_ONLY = '\\d{4}\\s*年';
const CHINESE_MONTH = '(?:十[一二]?|[一二三四五六七八九])\\s*月';
const FUZZY_PERIOD = '(?:最近|近期|前段时间|今年|去年|上半年|下半年|最近\\s*\\d+\\s*个?月|前\\s*\\d+\\s*个?月)';
const BILL_QUERY = new RegExp(`^(?:请\\s*|帮我\\s*)?(?:查询|查看|查|看看|看)?\\s*(${YEAR_MONTH}|${YEAR_ONLY}|\\d{1,2}\\s*月|${CHINESE_MONTH}|${FUZZY_PERIOD})?\\s*(?:的\\s*)?(?:月账单|账单)(?:汇总)?[。！？!?]?$`);
const INCOMPLETE_BILL_QUERY = /^(?:请\s*|帮我\s*)?(?:我想\s*)?(?:查询|查看|查|看看|看)\s*([^，。,；;!?！？]{0,40}?)\s*(?:的\s*)?(?:月账单|账单)(?:汇总)?[。！？!?]?$/;
const OTHER_TASK = /转账|付款|汇款|卡片?|冻结|解冻|预算|订阅|理财|产品|确认|执行/;
export function matchBillQuery(message) {
  if (typeof message !== 'string') return null;
  const value = message.trim();
  const exact = BILL_QUERY.exec(value);
  if (exact) return exact;
  const incomplete = INCOMPLETE_BILL_QUERY.exec(value);
  return incomplete && !OTHER_TASK.test(incomplete[1]) ? incomplete : null;
}

function chineseMonthNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value === '十一') return 11;
  if (value === '十二') return 12;
  return digits[value];
}

export function billClarificationQuestion(message) {
  const value = typeof message === 'string' ? message.trim() : '';
  const year = value.match(/(?:^|\D)((?:19|20)\d{2})\s*年/);
  const numericMonth = value.match(/(?:^|\D)(\d{1,2})\s*月/);
  const namedMonth = value.match(/(十[一二]?|[一二三四五六七八九])\s*月/);
  const month = numericMonth ? Number(numericMonth[1]) : namedMonth ? chineseMonthNumber(namedMonth[1]) : undefined;
  if (month && !year && month >= 1 && month <= 12) {
    return `你想查询哪一年的 ${month} 月账单？例如 2026 年 ${month} 月。`;
  }
  if (year && !month) {
    return `你想查询 ${year[1]} 年的哪个月账单？例如 ${year[1]} 年 8 月。`;
  }
  return '请提供明确的账单年月，例如 2026 年 8 月。';
}

export const skillPolicies = Object.freeze({
  card_get: { action: 'card.get', kind: 'card_result', flag: 'SAVEFLOW_TRUEFORGE_READ_ENABLED' },
  subscription_list: { action: 'subscription.list', kind: 'subscription_result', flag: 'SAVEFLOW_TRUEFORGE_READ_ENABLED' },
  product_list: { action: 'product.list', kind: 'product_result', flag: 'SAVEFLOW_TRUEFORGE_READ_ENABLED' },
  transfer_preview: { action: 'transfer.create', kind: 'awaiting_confirmation', flag: 'SAVEFLOW_TRUEFORGE_TRANSFER_ENABLED', preview: true },
  card_budget_preview: { action: 'card.set_budget', kind: 'awaiting_confirmation', flag: 'SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED', preview: true },
  card_freeze_preview: { action: 'card.freeze', kind: 'awaiting_confirmation', flag: 'SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED', preview: true },
  card_unfreeze_preview: { action: 'card.unfreeze', kind: 'awaiting_confirmation', flag: 'SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED', preview: true },
});

function moneyInput(raw, allowZero = false) {
  const m = raw.trim().match(/^(-?\d+)(?:\.(\d{1,2}))?\s*(?:元|块钱?|人民币)?$/);
  if (!m || m[1].startsWith('-')) throw trueforgeError('INVALID_AMOUNT', '请提供有效金额，精确到分。', 400);
  const n = BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0'));
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < (allowZero ? 0n : 1n) || (allowZero && n > 10000000n)) throw trueforgeError('INVALID_AMOUNT', '金额超出允许范围。', 400);
  return { amount_minor: Number(n), currency: 'CNY' };
}

// Fixed, narrow entry phrases. Mixed tasks and unrecognized prose stay with the old Harness.
export function routeTrueforgeSkill(message, env) {
  if (typeof message !== 'string') return undefined;
  const value = message.trim().replace(/[。！？!?]$/, '');
  let tool, args;
  const cardState = value.match(/^(?:请|帮我)?\s*(解冻|解除冻结|冻结)\s*(.*?)$/);
  const budget = value.match(/^(?:设置|调整|修改)\s*(.*?)(?:的)?(?:月消费|月)?预算(?:为|到|成)?\s*(.*?)$/) ||
    value.match(/^(?:把|将)?\s*(.*?)(?:的)?(?:月消费|月)?预算(?:设置为|调整为|调整到|改成|改为|设为)\s*(.*?)$/);
  if (env.SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED === 'true' && (cardState || budget)) {
    const ref = (cardState ? cardState[2] : budget[1]).trim();
    if ((ref && !/(?:卡|卡片)$/.test(ref)) || /并|然后|转账|执行|确认|取消|订阅|产品/.test(ref)) return undefined;
    if (budget && /并|然后|转账|执行|确认|取消|订阅|产品/.test(budget[2])) return undefined;
    tool = cardState ? (cardState[1] === '冻结' ? 'card_freeze_preview' : 'card_unfreeze_preview') : 'card_budget_preview';
    args = /^(?:卡|卡片|银行卡)?$/.test(ref) ? {} : { card_ref: ref };
    if (budget && budget[2].trim()) args.amount = moneyInput(budget[2], true);
    return { tool, args };
  }
  const payeeFirst = value.match(/^(?:请|帮我)?\s*(?:从(.+?)\s*)?给([^，。,；;!?！？]{1,128}?)\s*转(?:账)?\s*([^，。,；;!?！？]*)$/);
  const amountFirst = value.match(/^(?:请|帮我)?\s*从([^，。,；;!?！？]{1,128}?)\s*转账\s*([^，。,；;!?！？]+?)\s*给([^，。,；;!?！？]{1,128})$/);
  const transfer = payeeFirst || (amountFirst && [amountFirst[0], amountFirst[1], amountFirst[3], amountFirst[2]]);
  if (env.SAVEFLOW_TRUEFORGE_TRANSFER_ENABLED === 'true' && (transfer || value === '转账')) {
    tool = 'transfer_preview'; args = {};
    if (transfer) {
      if ([transfer[1], transfer[2]].some(ref => /并|然后|转账|执行|确认|取消|冻结|预算|账单|订阅|产品/.test(ref || '')) || /并|然后|执行|确认|取消/.test(transfer[3])) return undefined;
      args.payee_ref = transfer[2].trim();
      if (transfer[1]) args.source_account_ref = transfer[1].trim();
      if (transfer[3].trim()) args.amount = moneyInput(transfer[3]);
    }
  }
  else if (/^(?:(?:请|帮我)\s*)?(?:查询|查看|查|看)?\s*(?:我的)?订阅(?:列表|项目)?$/.test(value)) { tool = 'subscription_list'; args = {}; }
  else if (/^(?:(?:请|帮我)\s*)?(?:查询|查看|查|看)?\s*(?:理财)?产品(?:列表)?$/.test(value)) { tool = 'product_list'; args = {}; }
  else {
    const match = value.match(/^(?:请|帮我)?\s*(?:查询|查看|查|看)\s*(.+?)(?:的信息|信息)?$/);
    if (match && /(?:卡|卡片)$/.test(match[1]) && !/账单|转账|冻结|解冻|预算|订阅|产品/.test(match[1])) {
      tool = 'card_get'; const ref = match[1].trim(); args = /^(?:卡|卡片|银行卡)$/.test(ref) ? {} : { card_ref: ref };
    }
  }
  return tool && env[skillPolicies[tool].flag] === 'true' ? { tool, args } : undefined;
}

const allSkills = { SAVEFLOW_TRUEFORGE_READ_ENABLED: 'true', SAVEFLOW_TRUEFORGE_TRANSFER_ENABLED: 'true', SAVEFLOW_TRUEFORGE_CARD_PREVIEW_ENABLED: 'true' };
// This selects a UI task boundary, never grants tool permissions. The server
// independently checks its private flags, token scope/action and tool arguments.
export function bankingTaskBoundary(message, currentAction, pendingSlot) {
  if (matchBillQuery(message)) return 'new';
  try { if (routeTrueforgeSkill(message, allSkills)) return 'new'; }
  catch { return 'new'; } // Explicit task with an invalid amount: server validates it.
  const families = [
    ['bill', /账单|流水/], ['card', /卡|冻结|解冻|预算/], ['transfer', /转账|付款|汇款|转给/],
    ['subscription', /订阅/], ['wealth', /理财|产品|风险测评/], ['scenario', /场景规则|规则编号|事件编号/], ['orchestrator', /财务情况|财务规划|综合规划/],
  ].filter(([, pattern]) => pattern.test(message));
  // With no focused TrueForge flow, a phrase that names one business family
  // starts a new task. A family-free answer (for example "R2", "2026年8月"
  // or "确认保存") must keep the opaque non-TrueForge continuation token.
  if (!currentAction) return families.length === 0 ? 'continue' : families.length === 1 ? 'new' : 'clarify';
  const currentFamily = currentAction?.split('.')[0];
  if (families.length > 1 || families.some(([family]) => family !== currentFamily)) return 'clarify';
  if (currentAction && !pendingSlot && !/^(?:改成|改为|金额|预算|收款人|改给|换给|换成|重新选择|改选|更换|取消|不用了|确认|执行|同意|-?\d)/.test(message.trim())) return 'clarify';
  return 'continue';
}
