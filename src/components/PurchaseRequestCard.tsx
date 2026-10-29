'use client';
import { useState } from 'react';
import { PurchaseFlow } from './PurchaseFlow';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { yuan, type PurchaseSlots } from '../lib/purchase-client';
import { purchaseNeedsReservation, purchaseMissingQuestions, deriveBudgetMonth } from '../lib/purchase-flow.mjs';

const categoryLabel = (category: 'flowers' | 'cake') => (category === 'flowers' ? '鲜花' : '蛋糕');
const meaningLabel = (meaning?: 'order_on' | 'deliver_on') =>
  meaning === 'order_on' ? '提醒我下单' : meaning === 'deliver_on' ? '希望送达' : '';
const chip: React.CSSProperties = {
  display: 'inline-block', margin: '0 6px 4px 0', padding: '4px 12px', borderRadius: '999px',
  border: '1px solid #e2e5ea', color: '#333', fontSize: '13px', cursor: 'pointer', background: '#f2f4f7',
};
const fieldStyle: React.CSSProperties = { margin: '8px 0' };
const inputStyle: React.CSSProperties = { padding: '6px 8px', border: '1px solid #d0d4da', borderRadius: 6, marginRight: 4 };
const submitStyle: React.CSSProperties = { marginTop: 4, padding: '6px 16px', borderRadius: 6, border: '1px solid #d0d4da', background: '#fff', cursor: 'pointer' };

export function PurchaseRequestCard({ accessCode = '', consent = false, slots = {}, onAnswer, cards = [] }: {
  accessCode?: string;
  consent?: boolean;
  slots?: PurchaseSlots;
  onAnswer?: (text: string) => void;
  cards?: string[];
}) {
  const items = slots.items ?? [];
  const links = shoppingSearchLinks(slots) as Array<{ category: 'flowers' | 'cake'; label: string; query: string; url: string; check_before_order: string[] }>;
  const needsReservation = purchaseNeedsReservation(slots);
  const missing = needsReservation ? purchaseMissingQuestions(slots) : [];
  const budgetMonth = deriveBudgetMonth(slots);
  const flowSlots = budgetMonth && !slots.budget_month ? { ...slots, budget_month: budgetMonth } : slots;
  const need = (field: string) => missing.some(item => item.field === field);
  const [cats, setCats] = useState<Array<'flowers' | 'cake'>>([]);
  const [dateText, setDateText] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('12:00');
  const [meaning, setMeaning] = useState<'order_on' | 'deliver_on' | ''>('');
  const [amount, setAmount] = useState('');
  const [card, setCard] = useState('');

  const toggleCat = (category: 'flowers' | 'cake') =>
    setCats(current => current.includes(category) ? current.filter(item => item !== category) : [...current, category]);

  const submit = () => {
    const chosenCats = cats.length ? cats : items.map(item => item.category);
    const chosenDate = dateText || (/^\d{4}-\d{2}-\d{2}$/.test(slots.date_expression ?? '') ? slots.date_expression!.slice(0, 10) : '');
    const segments: string[] = [];
    if (chosenCats.length) segments.push(`买${chosenCats.map(categoryLabel).join('和')}`);
    if (chosenDate) segments.push(`${chosenDate} ${startTime}-${endTime}${meaning === 'deliver_on' ? '希望送达' : meaning === 'order_on' ? '提醒下单' : ''}`);
    else if (slots.date_expression) segments.push(`${slots.date_expression}${meaning ? (meaning === 'deliver_on' ? '希望送达' : '提醒下单') : ''}`);
    const amountValue = amount || (slots.budget ? String(slots.budget.amount_minor / 100) : '');
    if (amountValue !== '') segments.push(`预留${amountValue}元`);
    const cardValue = card || slots.funding_account_ref || '';
    if (cardValue) segments.push(`用${cardValue}`);
    onAnswer?.(segments.join('，'));
  };

  const confirmed = [
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning) ? `${meaningLabel(slots.date_meaning)} ` : ''}${slots.date_expression}` : '',
    slots.funding_account_ref ? `卡「${slots.funding_account_ref}」` : '',
  ].filter(Boolean);
  const cardOptions = cards.length ? cards : ['娱乐虚拟卡', '日常虚拟卡'];

  return <section aria-label="购物请求">
    {links.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      {links.map(link => <article key={link.category}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">在京东搜索{categoryLabel(link.category)}</a>
        {link.check_before_order.length > 0 && <p style={{ margin: '2px 0 0' }}>下单前核对排除项：{link.check_before_order.join('、')}</p>}
      </article>)}
    </div>}
    {!needsReservation && items.length > 0 && <p style={{ marginTop: 8 }}>现在就买，不预留预算、不设置提醒。</p>}
    {needsReservation && <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #e2e5ea', borderRadius: 10, background: '#fafbfc' }}>
      <b>预留预算与提醒</b>
      {confirmed.length > 0 && <p style={{ margin: '6px 0 2px' }}>
        {confirmed.join(' · ')}{budgetMonth ? ` · 预算月份 ${budgetMonth}` : ''}
      </p>}
      {need('items') && <div style={fieldStyle}><span>买什么？ </span>
        {(['鲜花', '蛋糕'] as const).map(option => {
          const category = option === '鲜花' ? 'flowers' as const : 'cake' as const;
          const selected = cats.includes(category);
          return <button key={option} type="button" style={{ ...chip, background: selected ? '#e8f0fe' : '#f2f4f7' }} onClick={() => toggleCat(category)}>{option}</button>;
        })}
      </div>}
      {need('date_expression') && <div style={fieldStyle}><span>哪天、哪个时间段？ </span>
        <input type="date" value={dateText} onChange={event => setDateText(event.target.value)} style={inputStyle} />
        <input type="time" value={startTime} onChange={event => setStartTime(event.target.value)} style={inputStyle} />–
        <input type="time" value={endTime} onChange={event => setEndTime(event.target.value)} style={inputStyle} />
      </div>}
      {need('date_meaning') && <div style={fieldStyle}><span>届时怎么处理？ </span>
        {(['提醒我下单', '希望送达'] as const).map(option => {
          const value = option === '提醒我下单' ? 'order_on' as const : 'deliver_on' as const;
          return <button key={option} type="button" style={{ ...chip, background: meaning === value ? '#e8f0fe' : '#f2f4f7' }} onClick={() => setMeaning(value)}>{option}</button>;
        })}
      </div>}
      {need('budget') && <div style={fieldStyle}><span>预留多少预算？ </span>
        <input type="number" min="0" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} style={inputStyle} /> 元
      </div>}
      {need('funding_account_ref') && <div style={fieldStyle}><span>用哪张卡预留？ </span>
        {cardOptions.map(option => <button key={option} type="button" style={{ ...chip, background: card === option ? '#e8f0fe' : '#f2f4f7' }} onClick={() => setCard(option)}>{option}</button>)}
      </div>}
      {missing.length > 0 && <button type="button" disabled={!onAnswer} onClick={submit} style={submitStyle}>补充</button>}
      <details style={{ marginTop: 8 }}>
        <summary>手动填写完整表单</summary>
        <PurchaseFlow accessCode={accessCode} consent={consent} initialSlots={flowSlots} />
      </details>
    </div>}
  </section>;
}
