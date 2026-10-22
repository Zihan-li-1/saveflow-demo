// Acceptance corpus only. These utterances never enter production parsing rules.
const amount = n => ({ amount_minor: n, currency: 'CNY' });
const period = (start_date, end_date) => ({ start_date, end_date, timezone: 'Asia/Shanghai', label: '测试期间' });
export const fixedNow = () => Date.parse('2026-10-22T04:00:00Z');
export const languageCases = [
  { message: '给张三转一千二百五十元', action: 'transfer.create', slots: { payee_ref: '张三', amount: amount(125000) } },
  { message: '给张三转1万', action: 'transfer.create', slots: { payee_ref: '张三', amount: amount(1000000) } },
  { message: '把月预算改成两千五', action: 'card.set_budget', slots: { amount: amount(250000) } },
  { message: '查去年全年的账单', action: 'bill.summary', slots: { period: period('2025-01-01', '2025-12-31') } },
  { message: '看看今年九月的支出', action: 'bill.summary', slots: { month: '2026-09' } },
  { message: '查上个月的账单', action: 'bill.summary', slots: { month: '2026-09' } },
  { message: '今年到现在花了多少', action: 'bill.summary', slots: { period: period('2026-01-01', '2026-10-22') } },
  { message: '我要在年底存够一万', action: 'orchestrator.goal', slots: { goal_text: '我要在年底存够一万', amount: amount(1000000), deadline: '2026-12-31' } },
  { message: '麻烦从活期账户汇给李四壹仟零捌元伍角', action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '李四', amount: amount(100850) } },
  { message: '娱乐虚拟卡每月能花的钱调到2千零六块五毛', action: 'card.set_budget', slots: { card_ref: '娱乐虚拟卡', amount: amount(200650) } },
  { message: '帮我合计一下上一自然年度的收支', action: 'bill.summary', slots: { period: period('2025-01-01', '2025-12-31') } },
  { message: '查上个月的账单', now: () => Date.parse('2026-01-01T00:10:00+08:00'), action: 'bill.summary', slots: { month: '2025-12' } },
  { message: '今年到现在花了多少', now: () => Date.parse('2026-12-31T16:30:00Z'), action: 'bill.summary', slots: { period: period('2027-01-01', '2027-01-01') } },
  { message: '今年到现在花了多少', now: () => Date.parse('2026-12-31T16:30:00Z'), timezone: 'America/New_York', action: 'bill.summary', slots: { period: { ...period('2026-01-01', '2026-12-31'), timezone: 'America/New_York' } } },
  ...['一两千', '几百', '差不多一万'].map(text => ({ message: `从活期账户给张三转${text}`, action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '张三' }, clarify: true })),
  { message: '查2026年2月30日的账单', action: 'clarify', slots: {}, clarify: true },
  { message: '给那个人转一千', action: 'transfer.create', slots: { amount: amount(100000) }, clarify: true },
  { message: '从活期账户给张三转0.001元', action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '张三' }, clarify: true },
  { message: '从活期账户给张三转钱', answer: '一千五', action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '张三' }, answerSlots: { source_account_ref: '活期账户', payee_ref: '张三', amount: amount(150000) } },
  { message: '从活期账户给张三转一千元', answer: '算了，数额换成一千五，其他照旧', action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '张三', amount: amount(100000) }, answerSlots: { source_account_ref: '活期账户', payee_ref: '张三', amount: amount(150000) } },
  { message: '从活期账户给王先生转一千五', answer: '第二个', ordinalChoice: true, previewCount: 1, expectedPayeeId: 'payee_004', action: 'transfer.create', slots: { source_account_ref: '活期账户', payee_ref: '王先生', amount: amount(150000) }, answerSlots: { source_account_ref: '活期账户', payee_ref: '王先生', amount: amount(150000) } },
  { message: '先看看上个月账单，再给张三转一千', action: 'clarify', slots: {}, clarify: true },
  { message: '年底攒个一两万吧', action: 'clarify', slots: {}, clarify: true },
  { message: '想在年底攒个大概一万', answer: '确切是一万二', action: 'orchestrator.goal', slots: { goal_text: '想在年底攒个大概一万', deadline: '2026-12-31' }, initialMissing: ['amount'], answerSlots: { goal_text: '想在年底攒个大概一万', deadline: '2026-12-31', amount: amount(1200000) } },
];
