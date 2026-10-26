import type { BankingAgentData } from '../lib/banking-agent-client';

export function BankingClarificationCard({ data, onChoice, active = true }: { data?: BankingAgentData; onChoice: (optionId: string, label: string) => void; active?: boolean }) {
  return <div className="banking-choice-card"><b>可选项</b><div className="banking-choice-list">{(data?.choices || []).map(choice => <button key={choice.optionId} disabled={!active || data?.historySnapshot} onClick={() => onChoice(choice.optionId, choice.label)}>{choice.label}</button>)}</div><small>选择仅用于补全本次请求，不代表确认或执行操作。</small></div>;
}
