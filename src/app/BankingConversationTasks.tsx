import type { BankingTask } from '../lib/banking-conversation-contract';

type TaskView = BankingTask & { canResume: boolean; blocked: boolean; operationId?: string; coreState?: string };

export function BankingConversationTasks({ phase, tasks, hasWork, disabled, newDisabled, onVerify, onResume, onCancel, onCheck, onNew }: {
  phase: 'none' | 'unverified' | 'ready' | 'failed'; tasks: TaskView[]; hasWork: boolean;
  disabled: boolean; newDisabled: boolean; onVerify: () => void; onResume: (taskId: string) => void; onCancel: (taskId: string) => void; onCheck: (operationId: string) => void; onNew: () => void;
}) {
  if (phase === 'none' || !hasWork) return null;
  const blocked = tasks.filter(task => task.blocked && task.operationId);
  const resumable = tasks.filter(task => !task.blocked);
  if (phase === 'ready' && !blocked.length && !resumable.length) return null;
  if (blocked.length && !resumable.length) return <section className="banking-result-card" aria-label="正在核实转账结果">
    <b>正在核实转账结果</b>
    <p>您的转账请求已收到，但我们暂时无法确认最终结果。为避免重复扣款，请先不要再次发起相同转账。</p>
    {blocked.map(task => <div className="transfer-preview-actions" key={task.taskId}>
      <button type="button" className="primary-button" disabled={disabled} onClick={() => onCheck(task.operationId!)}>查询转账结果</button>
      <small>我们会根据原交易记录核实状态，无需重新填写转账信息。</small>
    </div>)}
    <div className="transfer-preview-actions"><button type="button" className="secondary-button" disabled={disabled || newDisabled} onClick={onNew}>开始新业务</button><small>请先查询原转账结果；在结果确认前不能开始可能重复付款的新业务。</small></div>
  </section>;
  return <section className="banking-result-card banking-task-panel" aria-label="会话与待继续业务">
    <b>{phase === 'ready' ? '您有一笔尚未完成的转账' : phase === 'failed' ? '会话需要重新开始' : '历史会话待核验'}</b>
    <p>{phase === 'ready' ? '上次转账尚未完成确认。继续办理时，我们会重新核对账户余额和收款信息，确保使用最新数据。' : phase === 'failed'
      ? '服务端会话不可用。聊天记录已保留，可以重新描述业务。' : '请输入访问码并重新授权，再核验会话。历史选项和预览保持只读。'}</p>
    {phase === 'ready' && resumable.map((task, index) => <div className="transfer-preview-actions" key={task.taskId}>
      <button type="button" className="secondary-button" disabled={disabled || !task.canResume}
        onClick={() => onResume(task.taskId)}>{task.status === 'suspended' ? '恢复' : '继续'}办理{resumable.filter(other => other.action === task.action).length > 1 ? `（${index + 1}）` : ''}</button>
      {task.canResume ? <button type="button" className="text-button" disabled={disabled} onClick={() => onCancel(task.taskId)}>放弃本次转账</button> : <small>本标签页的续接凭据不可用，请重新开始业务。</small>}
    </div>)}
    <div className="transfer-preview-actions">
      {phase !== 'failed' && <button type="button" className="secondary-button" disabled={disabled} onClick={onVerify}>{phase === 'unverified' ? '核验并恢复会话' : '重新核验会话'}</button>}
      <button type="button" className="secondary-button" disabled={disabled || newDisabled} onClick={onNew}>开始新业务</button>
    </div>
  </section>;
}
