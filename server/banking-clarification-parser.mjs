import { resolveChoice } from '../src/agent/clarification/choice-resolver.mjs';

function amount(message) {
  const match = message.replaceAll(',', '').match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const yuan = Number(match[1]);
  if (!Number.isFinite(yuan) || yuan <= 0 || (match[1].includes('.') && match[1].split('.')[1].length > 2)) return null;
  const minor = Math.round(yuan * 100);
  return Number.isSafeInteger(minor) && minor > 0 && Math.abs(yuan * 100 - minor) < 0.000001 ? { amount_minor: minor, currency: 'CNY' } : null;
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

export function parseClarificationAnswer(message, { slot, choices = [], now = Date.now(), choice } = {}) {
  if (choice || choices.length) {
    const selected = resolveChoice(choice ?? message, choices);
    if (selected) return { kind: 'choice', choice: selected };
    if (choice || message.trim()) return { kind: 'unrecognized' };
  }
  if (slot === 'amount') {
    const value = amount(message);
    return value ? { kind: 'slot', updates: { amount: value } } : { kind: 'unrecognized' };
  }
  if (slot === 'month') {
    const value = month(message, now);
    return value ? { kind: 'slot', updates: { month: value } } : { kind: 'unrecognized' };
  }
  return { kind: 'unrecognized' };
}

export function isBillTask(message) {
  return /账单|查账|消费|支出|流水/.test(message);
}

export function isTransferTask(message) {
  return /转账|转|付款|汇款/.test(message);
}
