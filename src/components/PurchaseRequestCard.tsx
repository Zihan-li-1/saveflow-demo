'use client';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { yuan, inputMinor, type PurchaseSlots } from '../lib/purchase-client';
import { purchaseNeedsReservation, purchaseMissingQuestions, purchaseDateFields } from '../lib/purchase-flow.mjs';
import { localDate } from '../lib/calendar.mjs';

type PurchaseCategory = 'flowers' | 'cake' | 'headphones';
const categoryLabel = (category: PurchaseCategory) =>
  category === 'flowers' ? '鲜花' : category === 'cake' ? '蛋糕' : '耳机';
const meaningLabel = (meaning?: 'order_on' | 'deliver_on') =>
  meaning === 'order_on' ? '提醒我下单' : meaning === 'deliver_on' ? '希望送达' : '';
const chip: React.CSSProperties = {
  display: 'inline-block', margin: '0 6px 4px 0', padding: '4px 12px', borderRadius: '999px',
  border: '1px solid #e2e5ea', color: '#333', fontSize: '13px', cursor: 'pointer', background: '#f2f4f7',
};
const fieldStyle: React.CSSProperties = { margin: '8px 0' };
const inputStyle: React.CSSProperties = { padding: '6px 8px', border: '1px solid #d0d4da', borderRadius: 6, marginRight: 4 };
const submitStyle: React.CSSProperties = { marginTop: 4, padding: '6px 16px', borderRadius: 6, border: '1px solid #d0d4da', background: '#fff', cursor: 'pointer' };

type BrowserReminder = {
  categories: PurchaseCategory[];
  date: string;
  start: string;
  end: string;
  meaning: 'order_on' | 'deliver_on';
  amountMinor: number;
  card: string;
};
function readBrowserReminder(raw: string | null): BrowserReminder | undefined {
  try {
    const value = raw ? JSON.parse(raw) as BrowserReminder : undefined;
    return value && Array.isArray(value.categories) &&
      value.categories.every(category => category === 'flowers' || category === 'cake' || category === 'headphones') &&
      typeof value.date === 'string' && typeof value.start === 'string' && typeof value.end === 'string' &&
      (value.meaning === 'order_on' || value.meaning === 'deliver_on') &&
      Number.isSafeInteger(value.amountMinor) && value.amountMinor > 0 && typeof value.card === 'string' ? value : undefined;
  } catch { return undefined; }
}

export function PurchaseRequestCard({ slots = {}, cards = [] }: {
  accessCode?: string;
  consent?: boolean;
  slots?: PurchaseSlots;
  onAnswer?: (text: string) => void;
  cards?: string[];
}) {
  const items = slots.items ?? [];
  const needsReservation = purchaseNeedsReservation(slots);
  const missing = needsReservation ? purchaseMissingQuestions(slots) : [];
  const [editing, setEditing] = useState(false);
  const need = (field: string) => editing || missing.some(item => item.field === field);
  const [dateFields] = useState(() => purchaseDateFields(slots.date_expression));
  const [cats, setCats] = useState<PurchaseCategory[]>(items.map(item => item.category));
  const links = shoppingSearchLinks({ ...slots, items: cats.map(category => ({ category, quantity: 1 })) }) as Array<{ category: PurchaseCategory; label: string; query: string; url: string; check_before_order: string[] }>;
  const [dateText, setDateText] = useState(dateFields.date);
  const [startTime, setStartTime] = useState(dateFields.start);
  const [endTime, setEndTime] = useState(dateFields.end);
  const [meaning, setMeaning] = useState<'order_on' | 'deliver_on' | ''>(slots.date_meaning ?? '');
  const [amount, setAmount] = useState(slots.budget ? String(slots.budget.amount_minor / 100) : '');
  const [card, setCard] = useState(slots.funding_account_ref ?? '');
  const [preview, setPreview] = useState<BrowserReminder>();
  const [receipt, setReceipt] = useState<{ key: string; value: BrowserReminder }>();
  const [error, setError] = useState('');
  const storageKey = `saveflow.purchase.browser.v1:${JSON.stringify({ items: items.map(item => item.category), date: slots.date_expression, meaning: slots.date_meaning })}`;
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('storage', notify);
    return () => window.removeEventListener('storage', notify);
  }, []);
  const storedJson = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  }, () => null);
  const savedReminder = receipt?.key === storageKey ? receipt.value : readBrowserReminder(storedJson);
  const [today] = useState(() => localDate(Date.now()));
  const datePast = Boolean(dateText) && dateText < today;
  const ready = cats.length > 0 && dateText && startTime && endTime && meaning && Number(amount) > 0 && card && !datePast;

  function prepare() {
    try {
      if (!ready) throw new Error('请补齐下方缺少的信息。');
      if (startTime >= endTime) throw new Error('结束时间必须晚于开始时间。');
      setPreview({ categories: cats, date: dateText, start: startTime, end: endTime,
        meaning: meaning as 'order_on' | 'deliver_on', amountMinor: inputMinor(amount), card });
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '请核对填写的信息。'); }
  }

  function confirm() {
    if (!preview) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(preview));
      setReceipt({ key: storageKey, value: preview });
      setPreview(undefined);
      setError('');
    } catch { setError('浏览器存储不可用，提醒信息尚未保存。'); }
  }

  const toggleCat = (category: PurchaseCategory) =>
    setCats(current => current.includes(category) ? current.filter(item => item !== category) : [...current, category]);

  const recognised = [
    items.length ? items.map(item => categoryLabel(item.category)).join('、') : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning)} ${slots.date_expression}`.trim() : '',
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.funding_account_ref ? `卡「${slots.funding_account_ref}」` : '',
  ].filter(Boolean);
  const cardOptions = cards.length ? cards : ['娱乐虚拟卡', '日常虚拟卡'];

  // 日期已过去：只回一句，不再展开任何信息或表单。
  if (datePast && !savedReminder) return <section aria-label="购物请求">
    <p role="alert" style={{ margin: '12px 0 0' }}>所选日期已过去</p>
  </section>;

  return <section aria-label="购物请求">
    {links.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      {links.map(link => <article key={link.category}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
        {link.check_before_order.length > 0 && <p style={{ margin: '2px 0 0' }}>下单前核对排除项：{link.check_before_order.join('、')}</p>}
      </article>)}
    </div>}
    {needsReservation && <div style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #e2e5ea', borderRadius: 10, background: '#fafbfc' }}>
      {savedReminder ? <div role="status" aria-label="提醒设置回执">
        <b>提醒信息已保存</b>
        <p>{savedReminder.categories.map(categoryLabel).join('、')} · {meaningLabel(savedReminder.meaning)} {savedReminder.date} {savedReminder.start}–{savedReminder.end}</p>
        <p>模拟预留 {yuan(savedReminder.amountMinor)} · {savedReminder.card}</p>
        <p>仅保存在此浏览器；不会定时通知或冻结资金。到时请自行查看并下单。</p>
      </div> : preview ? <div aria-label="确认提醒">
        <b>请核对将保存的信息</b>
        <p>{preview.categories.map(categoryLabel).join('、')} · {meaningLabel(preview.meaning)} {preview.date} {preview.start}–{preview.end}</p>
        <p>模拟预留 {yuan(preview.amountMinor)} · {preview.card}</p>
        <p>仅本浏览器保存，不会定时通知或冻结资金。</p>
        <button type="button" onClick={confirm} style={submitStyle}>确认设置提醒</button>
        <button type="button" onClick={() => { setPreview(undefined); setError(''); setEditing(true); }} style={submitStyle}>返回修改</button>
      </div> : <>
      <b>预留预算与提醒</b>
      {!editing && recognised.length > 0 && <p style={{ margin: '6px 0 2px' }}>
        已识别：{recognised.join(' · ')}
      </p>}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      {need('items') && <div style={fieldStyle}><span>买什么？ </span>
        {(['鲜花', '蛋糕', '耳机'] as const).map(option => {
          const category = option === '鲜花' ? 'flowers' as const : option === '蛋糕' ? 'cake' as const : 'headphones' as const;
          const selected = cats.includes(category);
          return <button key={option} type="button" style={{ ...chip, background: selected ? '#e8f0fe' : '#f2f4f7' }} onClick={() => toggleCat(category)}>{option}</button>;
        })}
      </div>}
      <div style={fieldStyle}><span>{dateFields.date ? need('date_expression') ? '日期已填入，请补充时间段：' : '已识别的购买时间：' : '哪天、哪个时间段？'} </span>
        <input aria-label="购买日期" type="date" min={today} value={dateText} onChange={event => setDateText(event.target.value)} style={inputStyle} />
        <input aria-label="开始时间" type="time" value={startTime} onChange={event => setStartTime(event.target.value)} style={inputStyle} />–
        <input aria-label="结束时间" type="time" value={endTime} onChange={event => setEndTime(event.target.value)} style={inputStyle} />
      </div>
      {need('date_meaning') && <div style={fieldStyle}><span>届时怎么处理？ </span>
        {(['提醒我下单', '希望送达'] as const).map(option => {
          const value = option === '提醒我下单' ? 'order_on' as const : 'deliver_on' as const;
          return <button key={option} type="button" style={{ ...chip, background: meaning === value ? '#e8f0fe' : '#f2f4f7' }} onClick={() => setMeaning(value)}>{option}</button>;
        })}
      </div>}
      {need('budget') && <div style={fieldStyle}><span>预留多少预算？ </span>
        <input aria-label="预留预算" type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} style={inputStyle} /> 元
      </div>}
      {need('funding_account_ref') && <div style={fieldStyle}><span>用哪张卡预留？ </span>
        {cardOptions.map(option => <button key={option} type="button" style={{ ...chip, background: card === option ? '#e8f0fe' : '#f2f4f7' }} onClick={() => setCard(option)}>{option}</button>)}
      </div>}
      </fieldset>
      {error && <p role="alert" style={{ color: '#a22121', margin: '8px 0 0' }}>{error}</p>}
      <button type="button" onClick={prepare} style={submitStyle}>预览提醒设置</button>
      </>}
      {(preview || savedReminder) && error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}

