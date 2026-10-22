export const replyStyles = Object.freeze(['concise', 'friendly', 'professional']);
export function validateReplyStyle(value = 'concise') {
  if (!replyStyles.includes(value)) throw Object.assign(new Error('Invalid reply style'), { code: 'INVALID_REQUEST', status: 400, userMessage: '请选择简洁、亲切或专业语言风格。' });
  return value;
}

export const previewSafetyNotice = '资金和卡片状态尚未改变。只有在页面核对预览并完成所需确认与验证后，操作才可执行。';
const questions = {
  amount: '转账金额是多少？', source_account_ref: '请选择付款账户。', payee_ref: '请明确收款人。',
  card_ref: '请选择要查询或操作的卡片。', action: '请明确一个要处理的 Banking 请求；多个动作请分开提交。',
};

function knownSummary(action, slots) {
  if (action === 'transfer.create') return [slots.payee_ref && `收款人「${slots.payee_ref}」`, slots.amount && `金额 ¥${(slots.amount.amount_minor / 100).toFixed(2)}`, slots.source_account_ref && `付款账户「${slots.source_account_ref}」`].filter(Boolean).join('，');
  if (action?.startsWith('card.')) return [slots.card_ref && `卡片「${slots.card_ref}」`, slots.amount && `月预算 ¥${(slots.amount.amount_minor / 100).toFixed(2)}`].filter(Boolean).join('，');
  return '';
}

// Pure presentation: no intent parsing, model calls, tool selection or mutation.
// Structured data and safety notices never pass through style transforms.
export function bankingReply({ code, message, data, replyContext = {} }, style = 'concise') {
  let text = message;
  const safetyNotices = [];
  const c = data?.recovery ?? data;
  if (c?.status === 'needs_clarification') {
    const slots = replyContext.slots ?? {};
    const known = knownSummary(c.action, slots);
    const lead = style === 'friendly' ? '好的，' : style === 'professional' ? '当前请求：' : '';
    const question = (data?.recovery || replyContext.reason || c.source === 'resolver') ? c.question : c.slot === 'amount' && c.action === 'card.set_budget' ? '新的月消费预算是多少？' : c.slot === 'month' ? c.question : questions[c.slot] || c.question;
    text = `${lead}${known ? `${known}。` : ''}${c.action === 'orchestrator.goal' ? c.question : question}`;
    if (data?.error) safetyNotices.push(data.error.message);
  } else if (data?.status === 'awaiting_confirmation') {
    text = style === 'friendly' ? '预览准备好了，请仔细核对卡片中的操作信息。' : style === 'professional' ? '操作预览已生成，请核对明细。' : '预览已生成，请核对明细。';
    safetyNotices.push(data.previewOnly ? '本操作仅供预览，不支持执行。' : previewSafetyNotice);
    // Core warnings remain verbatim and independent of style.
    safetyNotices.push(...(data.risk?.warnings ?? []), ...(data.preview?.warnings ?? []));
  } else if (['bill_result', 'card_result', 'subscription_result', 'product_result'].includes(data?.status)) {
    text = style === 'friendly' ? '查好了，结果在下方卡片中。' : style === 'professional' ? '查询已完成，详见结果卡片。' : '查询完成。';
  } else if (data?.status === 'unsupported' || code === 'UNSUPPORTED') {
    text = '暂不支持该请求。可以查询账单、卡片、订阅或产品，或生成转账及卡片操作预览；请一次描述一个动作。';
  }
  if (data?.status === 'bill_result' && data.data?.coverage?.warning) text += ` ${data.data.coverage.warning} 数据截至 ${data.data.coverage.asOf}。`;
  return { text, style, safetyNotices: [...new Set(safetyNotices)] };
}
