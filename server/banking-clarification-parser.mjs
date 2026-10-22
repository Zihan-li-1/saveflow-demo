import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';

function amount(message, allowZero = false) {
  const match = message.replaceAll(',', '').match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const yuan = Number(match[1]);
  if (!Number.isFinite(yuan) || yuan < (allowZero ? 0 : Number.EPSILON) || (match[1].includes('.') && match[1].split('.')[1].length > 2)) return null;
  const minor = Math.round(yuan * 100);
  return Number.isSafeInteger(minor) && minor >= (allowZero ? 0 : 1) && Math.abs(yuan * 100 - minor) < 0.000001 ? { amount_minor: minor, currency: 'CNY' } : null;
}

function amountAnswer(message, action) {
  const input = action === 'transfer.create' ? message.trim().replace(/^((?:金额)?改成|改为)\s*转账\s*/, '$1') : message.trim();
  const value = /^(?:(?:金额|预算)?改成|改为)?\s*-?\d[\d,]*(?:\.\d+)?\s*(?:元|块钱?|人民币)?[。！]?$/.test(input) ? amount(input, action === 'card.set_budget') : null;
  return value && (action !== 'card.set_budget' || value.amount_minor <= 10_000_000) ? { kind: 'slot', updates: { amount: value } } : { kind: 'unrecognized' };
}

function month(message, now) {
  const explicit = message.match(/(20\d{2})\s*(?:年|-|\/|\.)\s*(\d{1,2})\s*月?/);
  if (explicit) {
    const value = `${explicit[1]}-${String(Number(explicit[2])).padStart(2, '0')}`;
    return /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value) ? value : null;
  }
  if (!/(上个|上月|这个月|本月)/.test(message)) return null;
  const date = new Date(now);
  const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(date);
  let year = Number(current.find(part => part.type === 'year').value);
  let value = Number(current.find(part => part.type === 'month').value);
  if (/上个|上月/.test(message)) value -= 1;
  if (value === 0) { value = 12; year -= 1; }
  return `${year}-${String(value).padStart(2, '0')}`;
}

export function parseClarificationAnswer(message, { action, slot, slots = {}, choices = [], now = Date.now(), choice } = {}) {
  // Explicit edits replace the old resolution as well as the visible draft.
  if (!choice) {
    const card = message.trim().match(/^(?:卡片?改成|卡片?换成|改成|改为|换成|改选)\s*(.+卡)[。！]?$/);
    if (card) return { kind: 'slot', updates: { card_ref: card[1] } };
    if (/^(?:重新选择|改选|更换|换)(?:卡|卡片)[。！]?$/.test(message.trim())) return { kind: 'slot', updates: { card_ref: undefined } };
    const payee = message.trim().match(/^(?:收款人改成|收款人换成|改为给|改给|换成给|换给)\s*(.+?)[。！]?$/);
    if (payee) return { kind: 'slot', updates: { payee_ref: payee[1] } };
    if (/^(?:重新选择|改选|更换)(?:付款)?账户[。！]?$/.test(message.trim())) return { kind: 'slot', updates: { source_account_ref: undefined } };
    if (/^(?:重新选择|改选|更换)收款人[。！]?$/.test(message.trim())) return { kind: 'slot', updates: { payee_ref: undefined } };
    // Explicit amount edits retain signed account/payee selections even when
    // the current clarification is asking the user to change the payer.
    if (['transfer.create', 'card.set_budget'].includes(action) && /^(?:(?:金额|预算)?改成|改为)/.test(message.trim())) {
      const edit = amountAnswer(message, action);
      if (edit.kind === 'slot') return edit;
    }
  }
  if (choice || choices.length) {
    const selected = resolveChoice(choice ?? message, choices);
    if (selected) return { kind: 'choice', choice: selected };
    if (choice || message.trim()) return { kind: 'unrecognized' };
  }
  if (slot === 'amount') {
    return amountAnswer(message, action);
  }
  if (slot === 'card_ref' && message.trim()) return { kind: 'slot', updates: { card_ref: message.trim() } };
  if (slot === 'payee_ref' && message.trim()) return { kind: 'slot', updates: { payee_ref: message.trim() } };
  if (slot === 'month') {
    let value = month(message, now);
    const year = message.trim().match(/^(20\d{2})\s*年?[。！]?$/);
    const m = message.trim().match(/^(\d{1,2})\s*月?[。！]?$/);
    if (!value && slots.monthNumber && year) value = `${year[1]}-${String(slots.monthNumber).padStart(2, '0')}`;
    if (!value && slots.year && m && Number(m[1]) >= 1 && Number(m[1]) <= 12) value = `${slots.year}-${String(Number(m[1])).padStart(2, '0')}`;
    return value ? { kind: 'slot', updates: { month: value, year: undefined, monthNumber: undefined } } : { kind: 'unrecognized' };
  }
  return { kind: 'unrecognized' };
}

export function isBillTask(message) {
  return /账单|查账|支出|流水|消费(?!限额|预算)/.test(message);
}

export function isTransferTask(message) {
  return /转账|转\s*\d|付款|汇款|转给|转钱/.test(message);
}

export function isCardTask(message) {
  return /冻结|解冻|解除冻结|锁卡|卡片?预算|月预算|查(?:询|看)?.{0,4}(?:银行卡|卡片)|卡片?信息/.test(message);
}
