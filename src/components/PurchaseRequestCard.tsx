'use client';
import { PurchaseFlow } from './PurchaseFlow';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { purchaseValueLabel } from '../lib/purchase-guidance.mjs';
import { yuan, type PurchaseSlots } from '../lib/purchase-client';
import { purchaseNeedsReservation, purchaseMissingQuestions } from '../lib/purchase-flow.mjs';

const categoryLabel = (category: 'flowers' | 'cake') => (category === 'flowers' ? '鲜花' : '蛋糕');
const meaningLabel = (meaning?: 'order_on' | 'deliver_on') =>
  meaning === 'order_on' ? '提醒我下单' : meaning === 'deliver_on' ? '希望送达' : '';

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
  const summaryParts = [
    items.length ? `购买 ${items.map(item => `${categoryLabel(item.category)} ×${item.quantity}`).join('、')}` : '',
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning) ? `${meaningLabel(slots.date_meaning)}：` : ''}${slots.date_expression}` : '',
  ].filter(Boolean);
  return <section aria-label="购物请求">
    <p>
      {summaryParts.length
        ? `已解析：${summaryParts.join('；')}。`
        : '请告诉我要买什么（鲜花或蛋糕），我直接给你平台搜索链接。'}
      {!needsReservation && items.length > 0 ? ' 按现在就买处理，不预留预算、不设置提醒。' : ''}
    </p>
    {links.length > 0 && <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      {links.map(link => <article key={link.category}>
        <b>{categoryLabel(link.category)}</b>
        <p>平台搜索词：{link.query}</p>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}，自行选择并下单</a>
        {link.check_before_order.length > 0 && <p>下单前请人工核对排除项：{link.check_before_order.join('、')}。</p>}
      </article>)}
    </div>}
    {Object.keys(preferences).length > 0 && <p>已记录偏好：{Object.entries(preferences).map(([key, value]) => `${key}：${purchaseValueLabel(value)}`).join('；')}</p>}
    {missing.length > 0 && <p>要完成预留与提醒，还需要：{missing.map(item => item.question).join('；')}</p>}
    <details open={needsReservation}>
      <summary>{needsReservation ? '预留预算与设置提醒' : '预留预算与设置提醒（可选）'}</summary>
      <PurchaseFlow accessCode={accessCode} consent={consent} initialSlots={slots} />
    </details>
  </section>;
}
