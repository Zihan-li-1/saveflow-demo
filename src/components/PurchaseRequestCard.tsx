'use client';
import { PurchaseFlow } from './PurchaseFlow';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { yuan, type PurchaseSlots } from '../lib/purchase-client';
import { purchaseNeedsReservation, purchaseMissingQuestions, deriveBudgetMonth } from '../lib/purchase-flow.mjs';

const categoryLabel = (category: 'flowers' | 'cake') => (category === 'flowers' ? '鲜花' : '蛋糕');
const meaningLabel = (meaning?: 'order_on' | 'deliver_on') =>
  meaning === 'order_on' ? '提醒我下单' : meaning === 'deliver_on' ? '希望送达' : '';
const chip: React.CSSProperties = {
  display: 'inline-block', margin: '0 6px 4px 0', padding: '3px 10px', borderRadius: '999px',
  background: '#f2f4f7', border: '1px solid #e2e5ea', color: '#333', fontSize: '13px',
};
const hintStyle: React.CSSProperties = { color: '#8a8f98', fontSize: '13px' };

export function PurchaseRequestCard({ accessCode = '', consent = false, slots = {} }: {
  accessCode?: string;
  consent?: boolean;
  slots?: PurchaseSlots;
}) {
  const items = slots.items ?? [];
  const links = shoppingSearchLinks(slots) as Array<{ category: 'flowers' | 'cake'; label: string; query: string; url: string; check_before_order: string[] }>;
  const needsReservation = purchaseNeedsReservation(slots);
  const missing = needsReservation ? purchaseMissingQuestions(slots) : [];
  const budgetMonth = deriveBudgetMonth(slots);
  const flowSlots = budgetMonth && !slots.budget_month ? { ...slots, budget_month: budgetMonth } : slots;
  const confirmed = [
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning) ? `${meaningLabel(slots.date_meaning)} ` : ''}${slots.date_expression}` : '',
    slots.funding_account_ref ? `账户「${slots.funding_account_ref}」` : '',
  ].filter(Boolean);

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
      {missing.length > 0 && <p style={{ margin: '10px 0 2px' }}>还差：</p>}
      {missing.map(item => <div key={item.field} style={{ margin: '6px 0' }}>
        <span>{item.prompt} </span>
        {'options' in item && item.options?.map(option => <span key={option} style={chip}>{option}</span>)}
        {'hint' in item && item.hint && <span style={hintStyle}>{item.hint}</span>}
      </div>)}
      <details style={{ marginTop: 8 }}>
        <summary>手动填写完整表单</summary>
        <PurchaseFlow accessCode={accessCode} consent={consent} initialSlots={flowSlots} />
      </details>
    </div>}
  </section>;
}
