// Reviewed utterance corpus. Labels are evaluation data, never a keyword router.
const groups = {
  bill: {
    direct: ['查询2026-09账单', '汇总2026-09收入支出', '列出当前订阅', '分析2026-09分类开销', '比较2026-09与上月支出'],
    colloquial: ['九月份的钱都花哪了', '帮我瞅瞅2026年9月的开销', '每个月那些会员扣多少钱', '2026年9月我花得多不多', '哪些订阅好久没用了还扣钱'],
    indirect: ['我想知道2026年9月存不下钱的原因', '想核对2026年9月收支是否平衡', '想找出持续付费却可能闲置的服务'],
    ambiguous: ['看看我的消费', '这笔钱是什么', '查一下这张卡的账单'],
    counter: ['把娱乐卡预算改成1000元', '帮我生成500元以内耳机的购物平台搜索链接', '替我取消视频会员'],
  },
  card: {
    direct: ['查看娱乐虚拟卡', '查询日常虚拟卡状态', '娱乐卡月预算改为1000元', '冻结娱乐卡', '解冻娱乐卡'],
    colloquial: ['娱乐卡还能花多少', '日常卡现在能用不', '娱乐卡这月额度快用光了吗', '把娱乐卡先停用冻结', '娱乐卡已经冻结了帮我解冻'],
    indirect: ['我担心娱乐卡支出接近预算，想核对一下', '我想把娱乐卡每月开销控制在1000元，修改月预算', '想知道娱乐卡的预算和已消费'],
    ambiguous: ['帮我看看这张卡', '把额度调高一点', '卡是不是有问题'],
    counter: ['查看2026年9月全部收支', '帮我注销银行卡', '生成买显卡的购物搜索链接'],
  },
  wealth: {
    direct: ['比较模拟灵活现金基金 A和模拟稳健债券基金 B', '按R1和T+0筛选期限30天的应急金产品', '提示我如何开始适当性测评', '查看两个模拟产品的风险和流动性区别', '为应急金筛选R2以内、180天、T+1产品'],
    colloquial: ['这两个理财哪个取钱方便', '有闲钱但怕波动，先帮我看看选择条件', 'A和B有啥不一样', '钱随时要用，可以怎么筛选产品', '做理财前是不是要填问卷'],
    indirect: ['我想为半年后用钱筛选产品，风险最高R2，接受T+1，目标是应急金', '想弄清两个模拟产品的取用资金限制', '希望了解做投资前的风险测评要求'],
    ambiguous: ['帮我理财', '推荐收益高的', '替我处理这笔投资'],
    counter: ['给张三转500元', '查上月账单', '帮我自动买入基金 A'],
  },
  scenario: {
    direct: ['创建手动触发的订阅查询建议规则提案', '生成仅建议的场景规则', '复核可信事件event_demo', '创建每次手动触发时查看卡片的规则提案', '生成包含只读账单查询步骤的规则草案'],
    colloquial: ['把这些只读检查整理成一个手动规则', '先写个规则草稿，别真执行', '看看已经记录的那个事件', '帮我把触发条件和查询建议列出来', '把查订阅的步骤做成仅建议的规则'],
    indirect: ['希望以后复核时能参考一份手动只读检查提案', '想把指定触发条件与只读建议整理保存前先预览', '希望了解已记录可信事件对应的建议'],
    ambiguous: ['创建一条模拟规则：娱乐卡本月消费达到预算的80%时提醒我', '帮我自动管理财务', '有变化时提醒我'],
    counter: ['直接查看娱乐卡', '自动转账不用确认', '帮我生成耳机购物链接'],
  },
  transfer: {
    direct: ['从模拟活期账户给张三转500元人民币', '从活期账户向李四转100元', '给张三转账', '从活期账户汇200元给房东王先生', '解析一笔给张三的500元转账'],
    colloquial: ['从活期给张三打五百块', '给李四打点钱', '把活期里的两百转给房东王先生', '从活期给张三转两千五', '从活期给张三打一万块'],
    indirect: ['我需要把500元从活期账户交给张三，通过转账', '准备向李四支付100元，走活期账户转账', '希望从活期向张三划转人民币200元'],
    ambiguous: ['转500元', '给他打钱', '从这个账户转给上次那个人'],
    counter: ['找500元以内的耳机', '看看本月花了500元在哪', '比较500元起购的理财产品'],
  },
};
export const routingExamples = Object.entries(groups).flatMap(([skill, kinds]) => Object.entries(kinds).flatMap(([kind, queries]) => queries.map((query, index) => ({ id: `${skill}_${kind}_${index + 1}`, skill, kind, query }))));
export const examplesFor = skill => routingExamples.filter(example => example.skill === skill);

// First-stage few-shots teach goal decomposition without naming Skills or action IDs.
export const understandingExamples = [
  { user_message: '先核对五月收入支出，再看看日常卡还能花多少', tasks: [
    { goal: '查询指定月份的收入和支出', required_capability: '按月汇总收支', depends_on: [] },
    { goal: '读取指定卡的预算和已消费', required_capability: '卡片预算快照', depends_on: ['前一项查询'] },
  ], lesson: '分别保留两个目标；五月的年份由日历和上下文判断，不猜卡片实体 ID。' },
  { user_message: '找三百元以内的护肤品', tasks: [{ goal: '搜索符合预算的商品', required_capability: '商品搜索', depends_on: [] }], lesson: '金额是购物约束，不代表转账意图。支持性留给后续能力匹配判断。' },
  { user_message: '这个月', context: { active_goal: '查看收支', pending_question: 'month' }, tasks: [{ goal: '补充原收支查询的月份', required_capability: '按月汇总收支', depends_on: [] }], lesson: '依据服务端日历和可信当前任务补参，不新建无关目标。' },
];
