'use client';
import { useRef, useState } from 'react';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { yuan, inputMinor, purchaseRequest, type PurchaseSlots, type PurchaseWorkflow, type PlanPreview } from '../lib/purchase-client';
import { purchaseNeedsReservation, purchaseMissingQuestions, purchaseDateFields } from '../lib/purchase-flow.mjs';
import { localDate } from '../lib/calendar.mjs';

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

export function PurchaseRequestCard({ accessCode = '', consent = false, slots = {}, cards = [] }: {
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
  const [cats, setCats] = useState<Array<'flowers' | 'cake'>>(items.map(item => item.category));
  const links = shoppingSearchLinks({ ...slots, items: cats.map(category => ({ category })) }) as Array<{ category: 'flowers' | 'cake'; label: string; query: string; url: string; check_before_order: string[] }>;
  const [dateText, setDateText] = useState(dateFields.date);
  const [startTime, setStartTime] = useState(dateFields.start);
  const [endTime, setEndTime] = useState(dateFields.end);
  const [meaning, setMeaning] = useState<'order_on' | 'deliver_on' | ''>(slots.date_meaning ?? '');
  const [amount, setAmount] = useState(slots.budget ? String(slots.budget.amount_minor / 100) : '');
  const [card, setCard] = useState(slots.funding_account_ref ?? '');
  const [draft, setDraft] = useState<PurchaseWorkflow>();
  const [preview, setPreview] = useState<PlanPreview>();
  const [receipt, setReceipt] = useState<PurchaseWorkflow>();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [needFinance, setNeedFinance] = useState(false);
  const [balance, setBalance] = useState(''), [obligations, setObligations] = useState('');
  const inFlight = useRef(false);
  const call = <T,>(action: string, input: unknown) => purchaseRequest<T>(action, input, accessCode, consent);
  const [today] = useState(() => localDate(Date.now()));
  const datePast = Boolean(dateText) && dateText < today;
  const ready = cats.length > 0 && dateText && startTime && endTime && meaning && Number(amount) > 0 && card && !datePast;

  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await work(); } catch (cause) {
      if ((cause as { code?: string })?.code === 'FINANCIAL_DATA_REQUIRED') setNeedFinance(true);
      setError(cause instanceof Error ? cause.message : '请求未完成，请重试。');
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function prepare() {
    if (!ready) throw new Error('请补齐下方缺少的信息。');
    const nextSlots: PurchaseSlots = { ...slots, budget: { amount_minor: inputMinor(amount), currency: 'CNY' },
      budget_month: dateText.slice(0, 7), funding_account_ref: card, date_expression: `${dateText} ${startTime}-${endTime}`,
      date_meaning: meaning as 'order_on' | 'deliver_on', items: cats.map(category => ({ category, quantity: items.find(item => item.category === category)?.quantity ?? 1 })) };
    const next = draft ? await call<PurchaseWorkflow>('purchase.draft.update', { workflow_ref: draft.workflow_ref, expected_version: draft.version, slots: nextSlots })
      : await call<PurchaseWorkflow>('scenario.plan_purchase', nextSlots);
    setDraft(next);
    const result = await call<PlanPreview>('purchase.plan_preview', { workflow_ref: next.workflow_ref, expected_version: next.version,
      ...(needFinance ? { manual_finance: { available_minor: inputMinor(balance), obligations_minor: inputMinor(obligations) } } : {}) });
    if (!result.preview?.reminder_due_at || !result.plan_preview_ref || !result.plan_confirmation_token) throw new Error('未取得有效提醒预览，请重试。');
    setPreview(result);
  }

  async function confirm() {
    if (!draft || !preview) return;
    const saved = await call<PurchaseWorkflow>('scenario.purchase.save', { draft_ref: draft.workflow_ref, expected_version: draft.version,
      plan_preview_ref: preview.plan_preview_ref, plan_confirmation_token: preview.plan_confirmation_token });
    if (saved.workflow_ref !== draft.workflow_ref || saved.status !== 'active' || !saved.reminder?.due_at || !['scheduled', 'delivered'].includes(saved.reminder.status)) {
      throw new Error('尚未核实提醒已保存，请重试确认原提醒。');
    }
    setReceipt(saved);
    try { localStorage.setItem('saveflow.purchase.last.v1', saved.workflow_ref); } catch { /* Optional browser storage. */ }
  }

  const toggleCat = (category: 'flowers' | 'cake') =>
    setCats(current => current.includes(category) ? current.filter(item => item !== category) : [...current, category]);

  const recognised = [
    items.length ? items.map(item => categoryLabel(item.category)).join('、') : '',
    slots.date_expression ? `${meaningLabel(slots.date_meaning)} ${slots.date_expression}`.trim() : '',
    slots.budget ? `预留 ${yuan(slots.budget.amount_minor)}` : '',
    slots.funding_account_ref ? `卡「${slots.funding_account_ref}」` : '',
  ].filter(Boolean);
  const cardOptions = cards.length ? cards : ['娱乐虚拟卡', '日常虚拟卡'];

  // 日期已过去：只回一句，不再展开任何信息或表单。
  if (datePast) return <section aria-label="购物请求">
    <p role="alert" style={{ margin: '12px 0 0' }}>所选日期已过去</p>
  </section>;

  return <section aria-label="购物请求">
    {links.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      {links.map(link => <article key={link.category}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">在京东搜索{categoryLabel(link.category)}</a>
        {link.check_before_order.length > 0 && <p style={{ margin: '2px 0 0' }}>下单前核对排除项：{link.check_before_order.join('、')}</p>}
      </article>)}
    </div>}
    {!needsReservation && items.length > 0 && <p style={{ marginTop: 8 }}>现在就买，不预留预算、不设置提醒。</p>}
    {needsReservation && <div aria-busy={busy} style={{ marginTop: 12, padding: '12px 14px', border: '1px solid #e2e5ea', borderRadius: 10, background: '#fafbfc' }}>
      {receipt ? <div role="status" aria-label="提醒设置回执">
        <b>预提醒已设置成功</b>
        <p>{receipt.slots.items?.map(item => categoryLabel(item.category)).join('、')} · {meaningLabel(receipt.slots.date_meaning)} {receipt.slots.date_expression}</p>
        <p>提醒时间：{new Date(receipt.reminder!.due_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>
        <p>预留 {yuan(receipt.reservation?.total_minor ?? receipt.slots.budget!.amount_minor)} · {receipt.slots.funding_account_ref}</p>
        <p>已保存。到期提醒在本应用内查看；银行余额不变，商品由你自行下单。</p>
        <details><summary>保存恢复码（会话过期时使用）</summary>
          <p>恢复码仅供本人保存，可在购物页面恢复提醒。</p>
          {recoveryCode ? <textarea aria-label="提醒恢复码" readOnly value={recoveryCode} /> : <button type="button" disabled={busy} onClick={() => run(async () => {
            const backup = await call<{ recovery_code: string }>('purchase.session.backup', {});
            setRecoveryCode(backup.recovery_code);
          })}>获取恢复码</button>}
        </details>
      </div> : preview ? <div aria-label="确认提醒">
        <b>请确认预留预算与提醒</b>
        <p>{preview.preview!.slots.date_expression} · {meaningLabel(preview.preview!.slots.date_meaning)}</p>
        <p>{yuan(preview.preview!.slots.budget!.amount_minor)} · {preview.preview!.slots.funding_account_ref}</p>
        <p>提醒时间：{new Date(preview.preview!.reminder_due_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>
        <p>预算依据：{preview.preview!.context.source === 'user_provided' ? '你填写的数据，未经银行核实' : '模拟财务数据'}。</p>
        <p>{preview.notice}</p>
        <button type="button" disabled={busy} onClick={() => run(confirm)} style={submitStyle}>确认设置提醒</button>
        <button type="button" disabled={busy} onClick={() => { setPreview(undefined); setError(''); setEditing(true); }} style={submitStyle}>返回修改</button>
      </div> : <>
      <b>预留预算与提醒</b>
      {!editing && recognised.length > 0 && <p style={{ margin: '6px 0 2px' }}>
        已识别：{recognised.join(' · ')}
      </p>}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      {need('items') && <div style={fieldStyle}><span>买什么？ </span>
        {(['鲜花', '蛋糕'] as const).map(option => {
          const category = option === '鲜花' ? 'flowers' as const : 'cake' as const;
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
      {needFinance && <div style={fieldStyle}>
        <p>还缺可用余额和近期待付金额，请核对后填写（仅用于预算规划）。</p>
        <label>可用余额（元）<input aria-label="可用余额" type="number" min="0" step="0.01" value={balance} onChange={event => setBalance(event.target.value)} style={inputStyle} /></label>
        <label>近期待付金额（元，无则填0）<input aria-label="近期待付金额" type="number" min="0" step="0.01" value={obligations} onChange={event => setObligations(event.target.value)} style={inputStyle} /></label>
      </div>}
      </fieldset>
      <button type="button" disabled={busy || !ready || (needFinance && (!balance || !obligations))} onClick={() => run(prepare)} style={submitStyle}>预览提醒设置</button>
      </>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在保存或核对，请稍候……</p>}
    </div>}
  </section>;
}
