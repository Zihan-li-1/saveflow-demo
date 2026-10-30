import { canonical } from '../src/banking-core/errors.mjs';

export const PLANNING_TOOLS = Object.freeze([
  'bill.summary', 'subscription.list', 'card.get', 'product.list',
  'wealth.recommend', 'wealth.compare',
]);

const toolSet = new Set(PLANNING_TOOLS);
const kinds = new Set(['business_intent', 'plan_request', 'task_control', 'clarify', 'unsupported']);
const forbidden = /(?:^|_)(?:confirmed|confirmation|operation|preview|token|credential|toolcall|execution|entity_id|account_id|card_id|product_id|holding_id|payee_id)(?:$|_)/i;

export class AgentProposalV2Error extends Error {
  constructor(code, message = code) { super(message); this.name = 'AgentProposalV2Error'; this.code = code; }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'AgentProposalV2 字段不符合契约。');
}

function boundedString(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', `${name} 必须是有限长度的非空文本。`);
  return value;
}

function walk(value, depth = 0) {
  if (depth > 8) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', '规划参数嵌套过深。');
  if (Array.isArray(value)) { if (value.length > 32) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', '规划参数数组过长。'); value.forEach(item => walk(item, depth + 1)); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.test(key)) throw new AgentProposalV2Error('PROPOSAL_FORBIDDEN_FIELD', '规划请求包含受保护字段。');
    if (key.length > 64) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', '规划字段名过长。');
    walk(item, depth + 1);
  }
}

function rawReference(value, name) {
  boundedString(value, name, 128);
  if (/^(?:card|acc(?:ount)?|payee|product|holding|op|task|step)[_-][a-z0-9-]+$/i.test(value.trim()) || /^(?:[a-z]+[_-])?[a-f0-9]{8,}$/i.test(value.trim())) throw new AgentProposalV2Error('PROPOSAL_FORBIDDEN_FIELD', `${name} 必须保留用户称谓，不能提供实体 ID。`);
  return value.trim();
}

function amount(value) {
  exact(value, ['amount_minor', 'currency']);
  if (!Number.isSafeInteger(value.amount_minor) || value.amount_minor < 0 || value.currency !== 'CNY') throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', '金额必须是 CNY 的安全整数分。');
}

function validateToolArguments(tool, args) {
  if (!object(args)) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', '工具参数必须是对象。');
  if (tool === 'bill.summary') {
    exact(args, ['month', 'period']);
    if ((args.month === undefined) === (args.period === undefined)) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', '账单查询必须且只能提供 month 或 period。');
    if (args.month !== undefined && (typeof args.month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(args.month))) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'month 必须是 YYYY-MM。');
    if (args.period !== undefined) {
      exact(args.period, ['start_date', 'end_date', 'timezone', 'label']);
      for (const key of ['start_date', 'end_date']) if (typeof args.period[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.period[key])) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'period 日期格式无效。');
      boundedString(args.period.timezone, 'period.timezone', 64); boundedString(args.period.label, 'period.label', 128);
      if (args.period.end_date < args.period.start_date) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'period 结束日期不能早于开始日期。');
    }
  } else if (tool === 'subscription.list' || tool === 'product.list') {
    exact(args, []);
  } else if (tool === 'card.get') {
    exact(args, ['card_ref']);
    if (args.card_ref !== undefined) rawReference(args.card_ref, 'card_ref');
  } else if (tool === 'wealth.recommend') {
    exact(args, ['goal', 'max_risk_level', 'horizon_days', 'liquidity_requirement', 'amount']);
    boundedString(args.goal, 'goal', 256);
    if (!['R1', 'R2', 'R3'].includes(args.max_risk_level)) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'max_risk_level 无效。');
    if (!Number.isSafeInteger(args.horizon_days) || args.horizon_days < 0 || args.horizon_days > 3650) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'horizon_days 无效。');
    if (!['T+0', 'T+1', 'AT_MATURITY'].includes(args.liquidity_requirement)) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'liquidity_requirement 无效。');
    if (args.amount !== undefined) amount(args.amount);
  } else if (tool === 'wealth.compare') {
    exact(args, ['product_refs']);
    if (!Array.isArray(args.product_refs) || args.product_refs.length < 2 || args.product_refs.length > 5 || new Set(args.product_refs).size !== args.product_refs.length) throw new AgentProposalV2Error('PROPOSAL_ARGUMENT_INVALID', 'product_refs 必须是 2—5 个不同的用户称谓。');
    args.product_refs.forEach(value => rawReference(value, 'product_ref'));
  } else throw new AgentProposalV2Error('PROPOSAL_TOOL_NOT_ALLOWED', '工具不在只读白名单中。');
  return structuredClone(args);
}

function validateCommon(input) {
  exact(input, ['schemaVersion', 'kind', 'goal', 'constraints', 'plan_request', 'task_control', 'clarify', 'unsupported', 'business_intent']);
  if (input.schemaVersion !== '2.0.0' || !kinds.has(input.kind)) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'AgentProposalV2 版本或 kind 无效。');
  if (input.goal !== undefined) boundedString(input.goal, 'goal', 4000);
  if (input.constraints !== undefined) { walk(input.constraints); if (!object(input.constraints)) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'constraints 必须是对象。'); }
  walk(input);
}

export function validateAgentProposalV2(value) {
  if (!object(value) || JSON.stringify(value).length > 32768) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'AgentProposalV2 为空、过大或不是普通对象。');
  validateCommon(value);
  if (value.kind === 'plan_request') {
    exact(value.plan_request, ['tool', 'arguments', 'depends_on', 'reason']);
    if (!toolSet.has(value.plan_request.tool)) throw new AgentProposalV2Error('PROPOSAL_TOOL_NOT_ALLOWED', '工具不在只读白名单中。');
    const args = validateToolArguments(value.plan_request.tool, value.plan_request.arguments);
    if (value.plan_request.depends_on !== undefined) {
      if (!Array.isArray(value.plan_request.depends_on) || value.plan_request.depends_on.length > 8 || value.plan_request.depends_on.some(item => typeof item !== 'string' || !/^[a-z.]{3,64}$/.test(item))) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'depends_on 只能引用已知工具名称。');
    }
    if (value.plan_request.reason !== undefined) boundedString(value.plan_request.reason, 'reason', 500);
    return Object.freeze({ ...value, plan_request: Object.freeze({ ...value.plan_request, arguments: args, ...(value.plan_request.depends_on ? { depends_on: [...value.plan_request.depends_on] } : {}) }) });
  }
  if (value.kind === 'business_intent') {
    exact(value.business_intent, ['action', 'slots']); boundedString(value.business_intent.action, 'business_intent.action', 128); if (!object(value.business_intent.slots)) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', 'business_intent.slots 必须是对象。');
    return Object.freeze(structuredClone(value));
  }
  if (value.kind === 'task_control') {
    exact(value.task_control, ['command', 'analysis', 'evidence_tools']); if (!['finish', 'cancel'].includes(value.task_control.command)) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', '规划 task_control 只允许 finish 或 cancel。');
    if (value.task_control.analysis !== undefined) boundedString(value.task_control.analysis, 'task_control.analysis', 2000);
    if (value.task_control.evidence_tools !== undefined && (!Array.isArray(value.task_control.evidence_tools) || value.task_control.evidence_tools.length > 6 || value.task_control.evidence_tools.some(tool => !toolSet.has(tool)))) throw new AgentProposalV2Error('PROPOSAL_SCHEMA_INVALID', '分析依据必须引用只读工具。');
  } else if (value.kind === 'clarify') {
    exact(value.clarify, ['question']); boundedString(value.clarify.question, 'clarify.question', 1000);
  } else if (value.kind === 'unsupported') {
    exact(value.unsupported, ['reason']); boundedString(value.unsupported.reason, 'unsupported.reason', 1000);
  }
  return Object.freeze(structuredClone(value));
}

export function proposalFingerprint(proposal) { return canonical(proposal); }
