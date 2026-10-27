'use client';
import { useEffect, useState } from 'react';
import { purchaseRequest, orderStatusText, yuan, inputMinor, type PurchaseSlots, type PurchaseWorkflow, type PurchaseCandidate, type PurchaseQuote, type PlanPreview, type OrderPreview } from '../lib/purchase-client';
import styles from './PurchaseFlow.module.css';
import { nextPurchaseQuestion, purchaseValueLabel } from '../lib/purchase-guidance.mjs';

export function PurchaseOrderDetails({ preview }: { preview: OrderPreview['preview'] }) {
  return <><p>{preview.merchant_name} · {preview.product_name} · 规格 {preview.sku_ref} · 数量 {preview.quantity} · 总价 {yuan(preview.total.amount_minor)}</p>
    <p>配送：{preview.delivery.recipient}，{preview.delivery.phone}，{preview.delivery.address}；{preview.delivery_window.starts_at} 至 {preview.delivery_window.ends_at}</p>
    <p>{preview.cancellation_terms}</p><p>{preview.payment_mode === 'mock_no_payment' ? '模拟环境不支持真实付款。' : '建单后仍需到平台支付。'}建单不等于付款成功。</p></>;
}

export function PurchaseFlow({ accessCode = '', consent = false, initialSlots = {}, initialData }: {
  accessCode?: string; consent?: boolean; initialSlots?: PurchaseSlots; initialData?: PurchaseWorkflow;
}) {
  const [wf, setWf] = useState<PurchaseWorkflow | undefined>(initialData);
  const [editing, setEditing] = useState(false);
  const [recovery, setRecovery] = useState(''), [recoverySaved, setRecoverySaved] = useState(false), [recoveryInput, setRecoveryInput] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(''), [deliveryStart, setDeliveryStart] = useState(''), [deliveryEnd, setDeliveryEnd] = useState('');
  const [budget, setBudget] = useState(initialSlots.budget ? String(initialSlots.budget.amount_minor / 100) : '');
  const [month, setMonth] = useState(initialSlots.budget_month ?? '');
  const [account, setAccount] = useState(initialSlots.funding_account_ref ?? '');
  const parsedDate = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(initialSlots.date_expression ?? '');
  const [date, setDate] = useState(parsedDate?.[1] ?? ''), [start, setStart] = useState(parsedDate?.[2] ?? ''), [end, setEnd] = useState(parsedDate?.[3] ?? '');
  const [meaning, setMeaning] = useState(initialSlots.date_meaning ?? '');
  const [items, setItems] = useState<Array<'flowers' | 'cake'>>(initialSlots.items?.map(item => item.category) ?? []);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [balance, setBalance] = useState(''), [obligations, setObligations] = useState('');
  const [plan, setPlan] = useState<PlanPreview>(), [order, setOrder] = useState<OrderPreview>();
  const [agreed, setAgreed] = useState(false), [submitted, setSubmitted] = useState(false);
  const [candidates, setCandidates] = useState<PurchaseCandidate[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [category, setCategory] = useState<'flowers' | 'cake'>('flowers');
  const selected: Record<string, PurchaseCandidate> = Object.fromEntries((wf?.selected_candidates ?? []).map(c => [c.category, c]));
  const [quotes, setQuotes] = useState<PurchaseQuote[]>([]);
  const [recipient, setRecipient] = useState(''), [phone, setPhone] = useState(''), [address, setAddress] = useState('');
  useEffect(() => {
    if (!wf) return;
    if (wf.status === 'active') { try { localStorage.setItem('saveflow.purchase.last.v1', wf.workflow_ref); } catch { /* Storage can be disabled. */ } }
  }, [wf]);
  const call = <T,>(action: string, input: unknown) => purchaseRequest<T>(action, input, accessCode, consent);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '请求未完成'); } finally { setBusy(false); } }
  async function refresh() { if (wf) setWf(await call<PurchaseWorkflow>('purchase.read', { workflow_ref: wf.workflow_ref })); }
  function syncDraft(next: PurchaseWorkflow) {
    setWf(next); const s = next.slots;
    setBudget(s.budget ? String(s.budget.amount_minor / 100) : ''); setMonth(s.budget_month ?? ''); setAccount(s.funding_account_ref ?? '');
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(s.date_expression ?? '');
    setDate(m?.[1] ?? ''); setStart(m?.[2] ?? ''); setEnd(m?.[3] ?? ''); setMeaning(s.date_meaning ?? ''); setItems(s.items?.map(i => i.category) ?? []);
  }
  function revisedSlots(): PurchaseSlots {
    if (!date || !start || !end || !meaning || !month || !account || !items.length) throw new Error('请填写预算月份、账户、日期、时间窗和购买品类。');
    return { ...(wf?.slots ?? initialSlots), budget: { amount_minor: inputMinor(budget), currency: 'CNY' }, budget_month: month,
      funding_account_ref: account, date_expression: `${date} ${start}-${end}`, date_meaning: meaning as 'order_on' | 'deliver_on',
      items: items.map(category => ({ category, quantity: 1 })), selection_mode: wf?.slots.selection_mode ?? initialSlots.selection_mode ?? 'guided' };
  }
  async function mode(selection_mode: 'guided' | 'browse') {
    if (!wf) return;
    setWf(await call<PurchaseWorkflow>('scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, changes: { selection_mode } }));
    setOrder(undefined); setQuotes([]);
  }
  async function search(next = false, selectedCategory = category) {
    if (!wf?.slots.budget) return;
    const result = await call<{ candidates: PurchaseCandidate[]; next_cursor: string | null }>('commerce.search', { workflow_ref: wf.workflow_ref,
      category: selectedCategory, preferences: wf.slots.preferences ?? {}, delivery_region_ref: 'demo-shanghai', remaining_budget: wf.slots.budget, ...(next && cursor ? { cursor } : {}) });
    setCandidates(result.candidates); setCursor(result.next_cursor); setCategory(selectedCategory);
    if (!result.candidates.length) setError('没有符合条件的商品。可调整偏好；不会自动放宽禁忌。');
  }
  return <section className={styles.flow} aria-label="购物联动流程" aria-busy={busy}>
    <div className={styles.heading}><h3>鲜花与蛋糕 · 模拟购物</h3><span>预留预算，银行余额不变</span></div>
    <p>先预留预算，再挑选商品。核对具体商品、总价和配送信息后逐单确认。当前商品、订单和库存均为模拟。</p>
    {!wf && <button disabled={busy} onClick={() => run(async () => {
      const id = localStorage.getItem('saveflow.purchase.last.v1'); if (!id) throw new Error('当前浏览器没有保存过购物流程。');
      setWf(await call<PurchaseWorkflow>('purchase.read', { workflow_ref: id }));
    })}>恢复最近购物流程</button>}
    {!wf && <details><summary>会话过期或换浏览器？使用恢复码</summary><label>购物恢复码<input type="password" value={recoveryInput} onChange={e => setRecoveryInput(e.target.value)} maxLength={256} autoComplete="off" /></label>
      <button disabled={busy || !recoveryInput} onClick={() => run(async () => {
        await call('purchase.session.recover', { recovery_code: recoveryInput }); setRecoveryInput('');
        const result = await call<{ workflows: PurchaseWorkflow[] }>('purchase.list', {});
        const next = result.workflows.find(w => w.status === 'active') ?? result.workflows[0]; if (!next) throw new Error('该演示身份尚无购物流程'); setWf(next);
      })}>恢复购物身份和流程</button></details>}
    {!wf || wf.status === 'draft' || editing ? <>
      <label>描述你的目标（不要填写电话、地址等私密信息）<textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={1000} placeholder="预留1000元，在11月1日给妈妈送花和蛋糕……" /></label>
      <button disabled={busy || !message.trim()} onClick={() => run(async () => syncDraft(await call<PurchaseWorkflow>('purchase.understand', {
        message, ...(wf ? { workflow_ref: wf.workflow_ref, expected_version: wf.version } : {}) }))) }>用模型理解目标</button>
      <p>也可直接填写。模型不可用时，手动表单仍需服务端数据库和预约服务。</p>
      <div className={styles.grid}>
        <label>购物预算（元，含全部费用）<input inputMode="decimal" value={budget} onChange={e => { setBudget(e.target.value); setPlan(undefined); }} /></label>
        <label>预算月份<input type="month" value={month} onChange={e => { setMonth(e.target.value); setPlan(undefined); }} /></label>
        <label>资金账户称谓<input value={account} onChange={e => { setAccount(e.target.value); setPlan(undefined); }} placeholder="例如：我的活期账户" maxLength={128} /></label>
        <label>日期含义<select value={meaning} onChange={e => { setMeaning(e.target.value); setPlan(undefined); }}><option value="">请选择</option><option value="order_on">下单日：到时再确认下单</option><option value="deliver_on">送达日：提前确认预约配送</option></select></label>
        <label>明确日期<input type="date" value={date} onChange={e => { setDate(e.target.value); setPlan(undefined); }} /></label>
        <label>开始时间<input type="time" value={start} onChange={e => { setStart(e.target.value); setPlan(undefined); }} /></label>
        <label>结束时间<input type="time" value={end} onChange={e => { setEnd(e.target.value); setPlan(undefined); }} /></label>
      </div>
      <fieldset><legend>购买品类（每类一件）</legend>{(['flowers', 'cake'] as const).map(c => <label key={c} className={styles.inline}><input type="checkbox" checked={items.includes(c)} onChange={e => { setItems(items.filter(i => i !== c).concat(e.target.checked ? [c] : [])); setPlan(undefined); }} />{c === 'flowers' ? '鲜花' : '蛋糕'}</label>)}</fieldset>
      <div className={styles.grid}><label>你填写的可用余额（元）<input inputMode="decimal" value={balance} onChange={e => { setBalance(e.target.value); setPlan(undefined); }} /></label>
        <label>近期已知待付义务（元；没有则填0）<input inputMode="decimal" value={obligations} onChange={e => { setObligations(e.target.value); setPlan(undefined); }} /></label></div>
      <p>这两项仅是你填报的规划依据，未经银行验证；请勿挪用其他必要开支。</p>
      <button disabled={busy} onClick={() => run(async () => {
        const slots = revisedSlots();
        const next = wf ? await call<PurchaseWorkflow>('purchase.draft.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, slots }) : await call<PurchaseWorkflow>('scenario.plan_purchase', slots);
        setWf(next); setPlan(await call<PlanPreview>('purchase.plan_preview', { workflow_ref: next.workflow_ref, expected_version: next.version,
          manual_finance: { available_minor: inputMinor(balance), obligations_minor: inputMinor(obligations) } }));
        const backup = await call<{ recovery_code: string }>('purchase.session.backup', {}); setRecovery(backup.recovery_code); setRecoverySaved(false);
      })}>预览预算与预约</button>
      {plan && wf && <div className={styles.preview}><b>请核对：{yuan(plan.preview?.slots.budget?.amount_minor ?? 0)} · {plan.preview?.slots.date_expression} · {plan.preview?.slots.date_meaning === 'order_on' ? '届时下单' : '届时送达'}</b><p>{plan.notice}</p>
        {plan.preview?.context && <p>规划依据：{plan.preview.context.source === 'user_provided' ? '你填写的数据，未经银行验证' : '合成演示财务来源'}；余额 {yuan(plan.preview.context.available_minor)}，待付义务 {yuan(plan.preview.context.obligations_minor)}；时间 {plan.preview.context.as_of}。{plan.preview.context.repository_as_of && `历史账单截至 ${plan.preview.context.repository_as_of}，不代表当前流水。`}</p>}
        <p>请自行保存恢复码。持有码的人可恢复此演示购物身份；会话过期后用它找回跨月预约。勿发送给模型或他人。</p><label>购物恢复码<textarea readOnly value={recovery} /></label>
        <label className={styles.inline}><input type="checkbox" checked={recoverySaved} onChange={e => setRecoverySaved(e.target.checked)} />我已妥善保存恢复码</label>
        <button disabled={busy || !recoverySaved || !recovery} onClick={() => run(async () => { setWf(await call<PurchaseWorkflow>('scenario.purchase.save', { draft_ref: wf.workflow_ref, expected_version: wf.version,
          plan_preview_ref: plan.plan_preview_ref, plan_confirmation_token: plan.plan_confirmation_token })); setPlan(undefined); setEditing(false); setQuotes([]); setOrder(undefined); })}>确认预留预算及保存预约</button></div>}
      <p>选品可用“问答搭配”或“商品自选”，保存预算后进入。</p>
    </> : <>
      <div className={styles.totals}>{wf.reservation && <><span>总预算 {yuan(wf.reservation.total_minor)}</span><span>可分配 {yuan(wf.reservation.unallocated_minor)}</span><span>预算占用 {yuan(wf.reservation.occupied_minor)}</span><span>已消费 {yuan(wf.reservation.consumed_minor)}</span><span>已释放 {yuan(wf.reservation.released_minor)}</span></>}</div>
      {wf.financial_basis && <p>规划数据：{wf.financial_basis.source === 'user_provided' ? '用户填报，未与银行核对' : '合成演示数据'} · 截至 {wf.financial_basis.as_of}</p>}
      <button disabled={busy} onClick={() => run(refresh)}>刷新流程</button>
      {wf.status === 'active' && <>
        <button disabled={busy} onClick={() => { syncDraft(wf); setPlan(undefined); setEditing(true); }}>修改预算或日期（需重新确认）</button>
        <div className={styles.actions}><button aria-pressed={wf.slots.selection_mode === 'guided'} disabled={busy} onClick={() => run(() => mode('guided'))}>问答搭配</button><button aria-pressed={wf.slots.selection_mode === 'browse'} disabled={busy} onClick={() => run(() => mode('browse'))}>商品自选</button></div>
        {wf.slots.selection_mode === 'guided' && <><p>{nextPurchaseQuestion(wf.slots)}</p><p>模型提取的条件会显示供你核对；不确定的偏好保持未知，也可随时切换商品自选。</p>
          <label>补充或纠正偏好<textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={1000} placeholder="例如：粉色玫瑰，淡香，6人水果蛋糕，不要坚果" /></label>
          <button disabled={busy || !message.trim()} onClick={() => run(async () => { setWf(await call<PurchaseWorkflow>('purchase.understand', { workflow_ref: wf.workflow_ref, expected_version: wf.version, message })); setQuotes([]); setOrder(undefined); setCandidates([]); setCursor(null); })}>提取偏好并核对</button></>}
        <p>当前偏好：{Object.entries(wf.slots.preferences ?? {}).map(([key, v]) => `${({ flower_colors: '花色', flower_materials: '花材', flower_exclusions: '排除花材', scent_preference: '香味', cake_flavors: '蛋糕口味', cake_servings: '人数', ingredient_exclusions: '禁忌原料', occasion: '场合', style: '风格' } as Record<string, string>)[key] ?? '偏好'}：${purchaseValueLabel(v)}`).join('；') || '尚未提供，可先浏览再调整'}</p>
        <div className={styles.actions}>{wf.slots.items?.map(i => <button key={i.category} disabled={busy} onClick={() => run(() => search(false, i.category))}>{i.category === 'flowers' ? '看鲜花' : '看蛋糕'}</button>)}
          {cursor && <button disabled={busy} onClick={() => run(() => search(true))}>换一批</button>}</div>
        <div className={styles.grid}>{candidates.map(c => <article key={c.candidate_ref}><b>{c.name}</b><p>{yuan(c.price_minor)} + 配送 {yuan(c.delivery_fee_minor)} + 包装 {yuan(c.packaging_fee_minor)}</p>
          <p>{c.category === 'cake' ? c.allergens_known ? `已知原料：${purchaseValueLabel(c.ingredients)}` : '过敏原信息未知，不可认定安全' : '模拟规格：标准花束'}</p>
          <a href={`/shopping/product/?ref=${encodeURIComponent(c.product_ref)}`} target="_blank" rel="noopener noreferrer">查看模拟商品详情</a>
          <button disabled={busy} onClick={() => run(async () => {
            const next = { ...selected, [c.category]: c };
            setWf(await call<PurchaseWorkflow>('scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, changes: { selected_candidate_refs: Object.values(next).map(p => p.candidate_ref) } }));
            setQuotes([]); setOrder(undefined);
          })}>选择{c.category === 'flowers' ? '鲜花' : '蛋糕'}</button></article>)}</div>
        <p>已选：{Object.values(selected).map(c => c.name).join('、') || (wf.selected_candidate_refs?.length ? '已有选择，重新浏览可核对或更换' : '尚未选择')}。切换模式保留选择。</p>
        <fieldset><legend>配送信息（只提交到购物服务，不发送给模型；请使用测试信息）</legend><div className={styles.grid}>
          <label>收件人<input value={recipient} onChange={e => setRecipient(e.target.value)} maxLength={80} /></label><label>联系电话<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={11} /></label>
          <label>模拟上海地区详细地址<input value={address} onChange={e => setAddress(e.target.value)} maxLength={256} /></label></div>
          {wf.slots.date_meaning === 'order_on' && <div className={styles.grid}><p>约定的是下单窗口；到期后请另外核对实际送达时间。</p>
            <label>实际送达日期<input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} /></label>
            <label>送达开始<input type="time" value={deliveryStart} onChange={e => setDeliveryStart(e.target.value)} /></label>
            <label>送达结束<input type="time" value={deliveryEnd} onChange={e => setDeliveryEnd(e.target.value)} /></label></div>}
          <button disabled={busy || !Object.keys(selected).length} onClick={() => run(async () => {
            const saved = await call<{ address_ref: string; workflow: PurchaseWorkflow }>('purchase.address', { workflow_ref: wf.workflow_ref, expected_version: wf.version, address: { recipient, phone, address, region: 'demo-shanghai' } });
            setWf(saved.workflow); setOrder(undefined);
            const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(wf.slots.date_expression ?? ''); if (!m) throw new Error('日期需要重新核对');
            const delivery = wf.slots.date_meaning === 'order_on' ? [deliveryDate, deliveryStart, deliveryEnd] : m.slice(1);
            if (delivery.some(v => !v)) throw new Error('请填写实际送达日期和时间窗');
            const result = await call<{ quotes: PurchaseQuote[] }>('commerce.quote', { workflow_ref: wf.workflow_ref, expected_version: saved.workflow.version,
              address_ref: saved.address_ref, selections: Object.values(selected).filter(c => !wf.orders.some(o => o.category === c.category && !['failed', 'cancelled'].includes(o.status))).map(c => ({ candidate_ref: c.candidate_ref, sku_ref: c.sku_ref, quantity: 1 })),
              delivery_window: { starts_at: `${delivery[0]}T${delivery[1]}:00+08:00`, ends_at: `${delivery[0]}T${delivery[2]}:00+08:00`, timezone: 'Asia/Shanghai' } }); setQuotes(result.quotes);
          })}>保存配送信息并刷新全部费用</button></fieldset>
        {quotes.map(q => <article key={q.quote_ref}><b>{q.product_name} · 合计 {yuan(q.total.amount_minor)}</b><p>商品 {yuan(q.items_amount_minor)}，配送 {yuan(q.delivery_fee_minor)}，包装 {yuan(q.packaging_fee_minor)}。报价截止 {q.expires_at}</p>
          <button disabled={busy} onClick={() => run(async () => { const p = await call<OrderPreview>('commerce.order.prepare', { workflow_ref: wf.workflow_ref, expected_version: wf.version, quote_ref: q.quote_ref }); setOrder(p); setAgreed(false); setSubmitted(false); })}>核对这笔订单</button></article>)}
        {order && <div className={styles.preview}><h4>确认这笔模拟订单</h4><PurchaseOrderDetails preview={order.preview} />
          <label className={styles.inline}><input type="checkbox" checked={agreed} disabled={submitted} onChange={e => setAgreed(e.target.checked)} />我已核对这笔商品、总价和配送信息</label>
          <button disabled={busy || !agreed || submitted} onClick={() => run(async () => { setSubmitted(true); await call('commerce.order.execute', { operation_ref: order.operation_ref, preview_hash: order.preview_hash, confirmation_token: order.confirmation_token }); await refresh(); setQuotes([]); })}>确认并创建此单</button>
          {submitted && <button disabled={busy} onClick={() => run(async () => { await call('commerce.order.status', { operation_ref: order.operation_ref }); await refresh(); })}>查询刚才的订单</button>}</div>}
        <button disabled={busy} onClick={() => run(async () => setPlan(await call<PlanPreview>('purchase.cancel_preview', { workflow_ref: wf.workflow_ref, expected_version: wf.version })))}>预览取消计划</button>
        {plan && <div className={styles.preview}><p>{plan.notice}</p><button disabled={busy} onClick={() => run(async () => { setWf(await call<PurchaseWorkflow>('scenario.purchase.cancel', { workflow_ref: wf.workflow_ref, expected_version: wf.version, plan_preview_ref: plan.plan_preview_ref, plan_confirmation_token: plan.plan_confirmation_token })); setPlan(undefined); })}>确认取消计划</button></div>}
      </>}
      {wf.orders.map(o => <article key={o.operation_ref}><b>{o.category === 'flowers' ? '鲜花' : o.category === 'cake' ? '蛋糕' : '订单'} · {orderStatusText[o.status] ?? '状态待核实'} · {yuan(o.amount_minor)}</b><p>订单编号 {o.operation_ref}</p><button disabled={busy} onClick={() => run(async () => { await call('commerce.order.status', { operation_ref: o.operation_ref }); await refresh(); })}>查询订单</button></article>)}
      {wf.pending_tasks?.map(task => <p key={task.event_ref}>{task.status === 'missed_window' ? '已错过下单确认窗口，未自动补单。' : '预约已到期，请重新核对商品、费用与配送信息。'}</p>)}
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {busy && <p role="status">正在核对，请稍候……</p>}
  </section>;
}
