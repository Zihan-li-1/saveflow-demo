import type { BankingTask } from '../lib/banking-conversation-contract';

const names: Record<string, string> = {
  'transfer.create': '转账', 'bill.summary': '账单查询', 'card.get': '卡片查询', 'card.freeze': '冻结卡片', 'card.unfreeze': '解冻卡片',
  'card.set_budget': '卡片预算', 'card.set_controls': '卡片设置', 'card.security_review': '卡片安全查询',
  'orchestrator.goal': '储蓄目标', 'wealth.recommend': '理财建议', 'wealth.compare': '产品比较',
  'wealth.assess_risk': '风险测评', 'wealth.subscribe': '理财申购', 'wealth.redeem': '理财赎回',
  'scenario.create_rule': '创建规则', 'scenario.update_rule': '修改规则', 'scenario.disable_rule': '停用规则',
};
export function BankingConversationTasks({ phase, tasks, disabled, onVerify, onResume, onNew }: {
  phase: 'none' | 'unverified' | 'ready' | 'failed'; tasks: Array<BankingTask & { canResume: boolean; blocked: boolean }>;
  disabled: boolean; onVerify: () => void; onResume: (taskId: string) => void; onNew: () => void;
}) {
  if (phase === 'none') return null;
  return <section className="banking-result-card" aria-label="会话与待继续业务">
    <b>{phase === 'ready' ? '待继续业务' : phase === 'failed' ? '会话需要重新开始' : '历史会话待核验'}</b>
    <p>{phase === 'ready' ? '恢复时会重新查询当前数据并生成选项或正式预览。' : phase === 'failed'
      ? '服务端会话不可用。聊天记录已保留，可以重新描述业务。' : '请输入访问码并重新授权，再核验会话。历史选项和预览保持只读。'}</p>
    {phase === 'ready' && tasks.map((task, index) => <div className="transfer-preview-actions" key={task.taskId}>
      <button type="button" className="secondary-button" disabled={disabled || !task.canResume || task.blocked}
        onClick={() => onResume(task.taskId)}>{task.status === 'suspended' ? '恢复' : '继续'}{names[task.action] || '原业务'}{tasks.filter(other => other.action === task.action).length > 1 ? `（${index + 1}）` : ''}</button>
      {task.blocked ? <small>请先使用原操作的状态查询入口核实结果。</small> : !task.canResume ? <small>本标签页的续接凭据不可用，请重新开始业务。</small> : null}
    </div>)}
    <div className="transfer-preview-actions">
      {phase !== 'failed' && <button type="button" className="secondary-button" disabled={disabled} onClick={onVerify}>{phase === 'unverified' ? '核验并恢复会话' : '重新核验会话'}</button>}
      <button type="button" className="secondary-button" disabled={disabled} onClick={onNew}>开始新业务</button>
    </div>
  </section>;
}
