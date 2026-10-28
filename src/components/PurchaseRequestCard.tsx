'use client';
import { PurchaseFlow } from './PurchaseFlow';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { purchaseValueLabel } from '../lib/purchase-guidance.mjs';
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
const reserveStyle: React.CSSProperties = {
  marginTop: 12, padding: '12px 14px', border: '1px solid #e2e5ea', borderRadius: 10, background: '#fafbfc',
};

export function PurchaseRequestCard({ accessCode = '', consent = false, slots = {} }: {
  accessCode?: string;
  consent?: boolean;
  slots?: PurchaseSlots;
}) {
  const items = slots.items ?? [];
  const links = shoppingSearchLinks(slots) as Array<{ category: 'flowers' | 'cake'; label: string; query: string; url: string; check_before_order: string[] }>;
  const preferences = slots.preferences ?? {};
  const needsReservation = purchaseNeedsReservation(slots);
  const missing = needsReservation ? purchaseMissingQuestions(slots) : [];
  const budgetMonth = deriveBudgetMonth(slots);
  const flowSlots = budgetMonth && !slots.budget_month ? { ...slots, budget_month: budgetMonth } : slots;
  const known = [
    items.length ? `买 ${items.map(item => `${categoryLabel(item.category)}×${item.quantity}`).join('、')}` : '',
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning) ? `${meaningLabel(slots.date_meaning)}：` : ''}${slots.date_expression}` : '',
    slots.funding_account_ref ? `账户「${slots.funding_account_ref}」` : '',
  ].filter(Boolean);

  return <section aria-label="购物请求">
    {known.length
      ? <p>已解析：{known.join(' · ')}。</p>
      : <p>想买什么？鲜花、蛋糕，还是都要？</p>}
    {links.length > 0 && <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      {links.map(link => <article key={link.category}>
        <b>{categoryLabel(link.category)}</b>
        <p>平台搜索词：{link.query}</p>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}，自行选择并下单</a>
        {link.check_before_order.length > 0 && <p>下单前请人工核对排除项：{link.check_before_order.join('、')}。</p>}
      </article>)}
    </div>}
    {Object.keys(preferences).length > 0 && <p>已记录偏好：{Object.entries(preferences).map(([key, value]) => `${key}：${purchaseValueLabel(value)}`).join('；')}</p>}
    {!needsReservation && items.length > 0 && <p>按现在就买处理，不预留预算、不设置提醒。</p>}
    {needsReservation && <div style={reserveStyle}>
      <b>预留预算与提醒</b>
      {budgetMonth && <p style={{ margin: '6px 0 2px' }}>预算月份按时间自动记为 <b>{budgetMonth}</b>。</p>}
      {missing.length > 0 && <>
        <p style={{ margin: '10px 0 4px' }}>还差这几项，直接回复补齐：</p>
        {missing.map(item => <div key={item.field} style={{ margin: '7px 0' }}>
          <span>{item.prompt} </span>
          {'options' in item && item.options?.map(option => <span key={option} style={chip}>{option}</span>)}
          {'hint' in item && item.hint && <span style={hintStyle}>{item.hint}</span>}
        </div>)}
      </>}
      <details style={{ marginTop: 10 }}>
        <summary>需要手动填写完整表单</summary>
        <PurchaseFlow accessCode={accessCode} consent={consent} initialSlots={flowSlots} />
      </details>
    </div>}
  </section>;
}
