'use client';
import { useEffect, useState } from 'react';
import { purchaseRequest, orderStatusText, yuan, inputMinor, type PurchaseSlots, type PurchaseWorkflow, type PlanPreview } from '../lib/purchase-client';
import { shoppingSearchLinks } from '../lib/purchase-links.mjs';
import { nextPurchaseQuestion, purchaseValueLabel } from '../lib/purchase-guidance.mjs';
import styles from './PurchaseFlow.module.css';

export function PurchaseFlow({ accessCode = '', consent = false, initialSlots = {}, initialData }: {
  accessCode?: string; consent?: boolean; initialSlots?: PurchaseSlots; initialData?: PurchaseWorkflow;
}) {
  const [wf, setWf] = useState<PurchaseWorkflow | undefined>(initialData);
  const [editing, setEditing] = useState(false);
  const [recovery, setRecovery] = useState(''), [recoverySaved, setRecoverySaved] = useState(false), [recoveryInput, setRecoveryInput] = useState('');
  const [budget, setBudget] = useState(initialSlots.budget ? String(initialSlots.budget.amount_minor / 100) : '');
  const [month, setMonth] = useState(initialSlots.budget_month ?? '');
  const [account, setAccount] = useState(initialSlots.funding_account_ref ?? '');
  const parsedDate = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(initialSlots.date_expression ?? '');
  const [date, setDate] = useState(parsedDate?.[1] ?? ''), [start, setStart] = useState(parsedDate?.[2] ?? ''), [end, setEnd] = useState(parsedDate?.[3] ?? '');
  const [meaning, setMeaning] = useState(initialSlots.date_meaning ?? '');
  const [items, setItems] = useState<Array<'flowers' | 'cake'>>(initialSlots.items?.map(item => item.category) ?? []);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [balance, setBalance] = useState(''), [obligations, setObligations] = useState('');
  const [plan, setPlan] = useState<PlanPreview>();

  useEffect(() => {
    if (wf?.status === 'active') {
      try { localStorage.setItem('saveflow.purchase.last.v1', wf.workflow_ref); } catch { /* Optional browser storage. */ }
    }
  }, [wf]);
  const call = <T,>(action: string, input: unknown) => purchaseRequest<T>(action, input, accessCode, consent);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : '请求未完成'); }
    finally { setBusy(false); }
  }
  function syncDraft(next: PurchaseWorkflow) {
    setWf(next);
    const slots = next.slots;
    setBudget(slots.budget ? String(slots.budget.amount_minor / 100) : '');
    setMonth(slots.budget_month ?? ''); setAccount(slots.funding_account_ref ?? '');
    const parsed = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(slots.date_expression ?? '');
    setDate(parsed?.[1] ?? ''); setStart(parsed?.[2] ?? ''); setEnd(parsed?.[3] ?? '');
    setMeaning(slots.date_meaning ?? ''); setItems(slots.items?.map(item => item.category) ?? []);
  }
  function revisedSlots(): PurchaseSlots {
    if (!date || !start || !end || !meaning || !month || !account || !items.length) throw new Error('请填写预算月份、账户、日期、时间窗和购买品类。');
    return { ...(wf?.slots ?? initialSlots), budget: { amount_minor: inputMinor(budget), currency: 'CNY' }, budget_month: month,
      funding_account_ref: account, date_expression: date + ' ' + start + '-' + end, date_meaning: meaning as 'order_on' | 'deliver_on',
      items: items.map(category => ({ category, quantity: 1 })), selection_mode: wf?.slots.selection_mode ?? initialSlots.selection_mode ?? 'guided' };
  }
  async function changeMode(selection_mode: 'guided' | 'browse') {
    if (!wf) return;
    setWf(await call<PurchaseWorkflow>('scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, changes: { selection_mode } }));
  }
  const active = wf?.status === 'active';
  const links: Array<{ category: 'flowers' | 'cake'; label: string; query: string; url: string; check_before_order: string[] }> = active ? shoppingSearchLinks(wf.slots) : [];
  return <section className={styles.flow} aria-label="购物联动流程" aria-busy={busy}>
    <div className={styles.heading}><h3>购物预算与商品链接</h3><span>预留预算，银行余额不变</span></div>
    <p>Agent 帮你预留购物金额；到期提醒会在你打开本页面时显示。商品链接打开购物平台，由你自行核对商品、价格、配送并创建订单。</p>
    {!wf && <button disabled={busy} onClick={() => run(async () => {
      const id = localStorage.getItem('saveflow.purchase.last.v1');
      if (!id) throw new Error('当前浏览器没有保存过购物预算。');
      setWf(await call<PurchaseWorkflow>('purchase.read', { workflow_ref: id }));
    })}>恢复最近购物预算</button>}
    {!wf && <details><summary>会话过期或换浏览器？使用恢复码</summary>
      <label>购物恢复码<input type="password" value={recoveryInput} onChange={event => setRecoveryInput(event.target.value)} maxLength={256} autoComplete="off" /></label>
      <button disabled={busy || !recoveryInput} onClick={() => run(async () => {
        await call('purchase.session.recover', { recovery_code: recoveryInput }); setRecoveryInput('');
        const result = await call<{ workflows: PurchaseWorkflow[] }>('purchase.list', {});
        const next = result.workflows.find(item => item.status === 'active') ?? result.workflows[0];
        if (!next) throw new Error('该演示身份尚无购物预算');
        setWf(next);
      })}>恢复购物预算</button></details>}
    {!wf || wf.status === 'draft' || editing ? <>
      <label>描述你的购物目标（不要填写电话、地址等私密信息）
        <textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={1000} placeholder="预留1000元，11月1日给妈妈买鲜花和蛋糕……" /></label>
      <button disabled={busy || !message.trim()} onClick={() => run(async () => syncDraft(await call<PurchaseWorkflow>('purchase.understand', {
        message, ...(wf ? { workflow_ref: wf.workflow_ref, expected_version: wf.version } : {}) }))) }>用模型理解目标</button>
      <p>也可直接填写。模型不可用时，手动表单仍需服务端数据库和提醒服务。</p>
      <div className={styles.grid}>
        <label>预留购物金额（元）<input inputMode="decimal" value={budget} onChange={event => { setBudget(event.target.value); setPlan(undefined); }} /></label>
        <label>预算月份<input type="month" value={month} onChange={event => { setMonth(event.target.value); setPlan(undefined); }} /></label>
        <label>资金账户称谓<input value={account} onChange={event => { setAccount(event.target.value); setPlan(undefined); }} placeholder="例如：我的活期账户" maxLength={128} /></label>
        <label>日期含义<select value={meaning} onChange={event => { setMeaning(event.target.value); setPlan(undefined); }}>
          <option value="">请选择</option><option value="order_on">提醒我下单的日期</option><option value="deliver_on">希望送达的日期</option></select></label>
        <label>明确日期<input type="date" value={date} onChange={event => { setDate(event.target.value); setPlan(undefined); }} /></label>
        <label>开始时间<input type="time" value={start} onChange={event => { setStart(event.target.value); setPlan(undefined); }} /></label>
        <label>结束时间<input type="time" value={end} onChange={event => { setEnd(event.target.value); setPlan(undefined); }} /></label>
      </div>
      <fieldset><legend>购物品类</legend>{(['flowers', 'cake'] as const).map(category => <label key={category} className={styles.inline}>
        <input type="checkbox" checked={items.includes(category)} onChange={event => {
          setItems(items.filter(item => item !== category).concat(event.target.checked ? [category] : [])); setPlan(undefined);
        }} />{category === 'flowers' ? '鲜花' : '蛋糕'}</label>)}</fieldset>
      <div className={styles.grid}><label>你填写的可用余额（元）<input inputMode="decimal" value={balance} onChange={event => { setBalance(event.target.value); setPlan(undefined); }} /></label>
        <label>近期已知待付义务（元；没有则填0）<input inputMode="decimal" value={obligations} onChange={event => { setObligations(event.target.value); setPlan(undefined); }} /></label></div>
      <p>这两项是你填报的规划依据，未经银行验证。预留金额不会从账户扣除，也不能阻止你在别处花掉。</p>
      <button disabled={busy} onClick={() => run(async () => {
        const slots = revisedSlots();
        const next = wf ? await call<PurchaseWorkflow>('purchase.draft.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version, slots })
          : await call<PurchaseWorkflow>('scenario.plan_purchase', slots);
        setWf(next);
        setPlan(await call<PlanPreview>('purchase.plan_preview', { workflow_ref: next.workflow_ref, expected_version: next.version,
          manual_finance: { available_minor: inputMinor(balance), obligations_minor: inputMinor(obligations) } }));
        const backup = await call<{ recovery_code: string }>('purchase.session.backup', {});
        setRecovery(backup.recovery_code); setRecoverySaved(false);
      })}>预览预留金额与提醒时间</button>
      {plan && wf && <div className={styles.preview}><b>请核对：{yuan(plan.preview?.slots.budget?.amount_minor ?? 0)} · {plan.preview?.slots.date_expression}</b>
        {plan.preview?.reminder_due_at && <p>预计提醒时间：{new Date(plan.preview.reminder_due_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>}
        <p>{plan.notice}</p>
        {plan.preview?.context && <p>规划依据：{plan.preview.context.source === 'user_provided' ? '你填写的数据，未经银行验证' : '合成演示财务来源'}；
          余额 {yuan(plan.preview.context.available_minor)}，待付义务 {yuan(plan.preview.context.obligations_minor)}。</p>}
        <p>请自行保存恢复码；持有码的人可以恢复此演示购物预算。勿发送给模型或他人。</p>
        <label>购物恢复码<textarea readOnly value={recovery} /></label>
        <label className={styles.inline}><input type="checkbox" checked={recoverySaved} onChange={event => setRecoverySaved(event.target.checked)} />我已妥善保存恢复码</label>
        <button disabled={busy || !recoverySaved || !recovery} onClick={() => run(async () => {
          setWf(await call<PurchaseWorkflow>('scenario.purchase.save', { draft_ref: wf.workflow_ref, expected_version: wf.version,
            plan_preview_ref: plan.plan_preview_ref, plan_confirmation_token: plan.plan_confirmation_token }));
          setPlan(undefined); setEditing(false);
        })}>确认预留金额并保存提醒</button></div>}
    </> : <>
      {wf.reservation && <div className={styles.totals}><span>本月预留 {yuan(wf.reservation.total_minor)}</span><span>仍可用于本计划 {yuan(wf.reservation.unallocated_minor)}</span></div>}
      <p>这笔钱仍在原账户中。查看或购买其他商品前，请记得扣除这笔预留和必要开支。余额变化和平台支付不会自动同步；下单前请重新核对实际可用金额。</p>
      {wf.financial_basis && <p>规划数据：{wf.financial_basis.source === 'user_provided' ? '用户填报，未与银行核对' : '合成演示数据'} · 截至 {wf.financial_basis.as_of}</p>}
      <button disabled={busy} onClick={() => run(async () => setWf(await call<PurchaseWorkflow>('purchase.read', { workflow_ref: wf.workflow_ref })))}>刷新预算与提醒</button>
      {active && <>
        <button disabled={busy} onClick={() => { syncDraft(wf); setPlan(undefined); setEditing(true); }}>修改金额或日期（需重新确认）</button>
        <div className={styles.actions}><button aria-pressed={wf.slots.selection_mode === 'guided'} disabled={busy} onClick={() => run(() => changeMode('guided'))}>问答搭配</button>
          <button aria-pressed={wf.slots.selection_mode === 'browse'} disabled={busy} onClick={() => run(() => changeMode('browse'))}>商品自选</button></div>
        {wf.slots.selection_mode === 'guided' && <><p>{nextPurchaseQuestion(wf.slots)}</p>
          <label>补充或纠正偏好<textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={1000}
            placeholder="例如：粉色玫瑰，6人水果蛋糕，不要坚果" /></label>
          <button disabled={busy || !message.trim()} onClick={() => run(async () => {
            setWf(await call<PurchaseWorkflow>('purchase.understand', { workflow_ref: wf.workflow_ref, expected_version: wf.version, message }));
          })}>提取偏好并核对</button></>}
        <p>已记录的偏好：{Object.entries(wf.slots.preferences ?? {}).map(([key, value]) => key + '：' + purchaseValueLabel(value)).join('；') || '尚未提供，可直接打开链接浏览'}</p>
        <div className={styles.grid}>{links.map(link => <article key={link.category}><b>{link.category === 'flowers' ? '鲜花' : '蛋糕'}</b>
          <p>平台搜索词：{link.query}</p><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}，自行选择并下单</a>
          {link.check_before_order.length > 0 && <p>下单前请人工核对排除项：{link.check_before_order.join('、')}。搜索结果不能证明商品符合要求。</p>}</article>)}</div>
        <p>每个品类只有一条搜索入口；SaveFlow 尚未筛选具体商品，也没有按价格分档推荐。商品、库存、总价、运费、配送时间和过敏原请以平台页面为准；SaveFlow 不创建或查询平台订单。</p>
        <button disabled={busy} onClick={() => run(async () => setPlan(await call<PlanPreview>('purchase.cancel_preview', { workflow_ref: wf.workflow_ref, expected_version: wf.version })))}>预览释放预留预算</button>
        {plan && <div className={styles.preview}><p>{plan.notice}</p><button disabled={busy} onClick={() => run(async () => {
          setWf(await call<PurchaseWorkflow>('scenario.purchase.cancel', { workflow_ref: wf.workflow_ref, expected_version: wf.version,
            plan_preview_ref: plan.plan_preview_ref, plan_confirmation_token: plan.plan_confirmation_token }));
          setPlan(undefined);
        })}>确认释放预留</button></div>}
      </>}
      {wf.orders?.length > 0 && <div><p>旧版模拟订单记录（只读，不代表真实平台订单）：</p>{wf.orders.map(order =>
        <p key={order.operation_ref}>{order.category === 'flowers' ? '鲜花' : '蛋糕'} · {orderStatusText[order.status] ?? '状态待核实'} · {yuan(order.amount_minor)}</p>)}</div>}
      {wf.pending_tasks?.map(task => <p key={task.event_ref}>{task.status === 'missed_window'
        ? '原提醒窗口已过，请重新核对预算和商品信息后自行下单。'
        : '已到约定时间：请核对可用金额，并打开商品链接自行下单。'}</p>)}
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {busy && <p role="status">正在核对，请稍候……</p>}
  </section>;
}
