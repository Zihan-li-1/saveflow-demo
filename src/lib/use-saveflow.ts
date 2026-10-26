"use client";
import { useEffect, useRef, useState } from "react";
import { canTransition, coreOperationBlocksInput, transition, type CoreOperationStage, type FlowEvent, type Stage } from "./flow-machine";
import { saveflowMock } from "./saveflow-mock";
import { request } from "./api/client";
import { apiConfig } from "./api/config";
import { askQwen, type AgentTurn } from "./agent-client";
import { askBankingAgent, BankingAgentError, executeTrialTransfer, startTrialVerification, verifyTrialVerification, type BankingAgentData, type SavingsPlanInputs } from "./banking-agent-client";
import { createBankingClient } from "./api/banking-client";
import type { ActionReceipt } from "../banking-core/contracts";
import { ApiError, validatePlan, type Analysis, type Receipt } from "./api/contracts";
import { isTrialOperationId, isTrialPreview } from "./trial-preview.mjs";
import { bankingChatKey, continuationLifetime, restoreBankingChat, saveBankingChat } from "./banking-chat-storage";
import { transferFlow, bankingContinuationToken, updateBankingFlows, type BankingFlows } from "./banking-flow-state";

import { agentErrorHint, agentErrorPolicy } from "./agent-error-policy.mjs";
import type { BankingConversation } from './banking-conversation-contract';

export type Message = { id: number; role: "agent" | "user"; text: string; kind?: "normal" | "analysis" | "result" | "error" | "banking_clarification" | "banking_bill" | "banking_preview" | "banking_card" | "banking_card_preview" | "banking_read" | "banking_receipt" | "banking_wealth" | "banking_wealth_preview" | "banking_wealth_receipt" | "banking_savings_inputs" | "banking_savings_plan"; analysis?: Analysis; banking?: BankingAgentData; receipt?: ActionReceipt; verification?: { availableBalanceFen: number; transactionId: string; occurredAt: string; amountFen: number; status: string }; errorHint?: string };
const initialMessages: Message[] = [{ id: 1, role: "agent", text: "你好，我是 SaveFlow。可以查询模拟账单，或生成转账正式预览，例如：给张三转 500 元。" }];
const pendingKey = "saveflow.pending-operation.v1";

export function useSaveflow() {
  const [stage, setStage] = useState<Stage>("welcome");
  const [modelMode, setModelMode] = useState<"qwen" | "mock" | "banking">("banking");
  const [replyStyle, setReplyStyle] = useState<"concise" | "friendly" | "professional">("concise");
  const [accessCode, setAccessCode] = useState("");
  const [targetAmountFen, setTargetAmountFen] = useState<number | null>(saveflowMock.goal.targetAmount * 100);
  const targetDeadline = useRef<string | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const conversation = useRef<AgentTurn[]>([]);
  const stageRef = useRef<Stage>("welcome");
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [monthlySaving, setMonthlySaving] = useState(saveflowMock.goal.monthlySaving);
  const [consent, setConsent] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [failure, setFailure] = useState<"analysis" | "plan">("analysis");
  const [bankingFailure, setBankingFailure] = useState<ReturnType<typeof agentErrorPolicy> | null>(null);
  const flowStartMessage = useRef("");
  const [validation, setValidation] = useState("");
  const [bankingContinuation, setBankingContinuation] = useState<string | null>(null);
  const bankingConversation = useRef<BankingConversation | undefined>(undefined);
  const restoredSessionToken = useRef<string | undefined>(undefined);
  const [sessionPhase, setSessionPhase] = useState<'none' | 'unverified' | 'ready' | 'failed'>('none');
  const [sessionView, setSessionView] = useState<BankingConversation | null>(null);
  const [bankingFlows, setBankingFlows] = useState<BankingFlows>({});
  const bankingFlowsRef = useRef<BankingFlows>({});
  const forceNewTask = useRef(false);
  const [focusedFlowId, setFocusedFlowId] = useState<string | null>(null);
  const continuationIssuedAt = useRef(0);
  const [chatReady, setChatReady] = useState(false);
  const [activeCardOperationId, setActiveCardOperationId] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const cardBusyRef = useRef(false);
  const [activeTransferOperationId, setActiveTransferOperationId] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const transferBusyRef = useRef(false);
  const [coreOperations, setCoreOperations] = useState<Record<string, CoreOperationStage>>({});
  const coreOperationsRef = useRef<Record<string, CoreOperationStage>>({});
  const submittedOperations = useRef(new Set<string>());
  const activePreviews = useRef<{ card: string | null; transfer: string | null }>({ card: null, transfer: null });
  const coreBlocked = () => cardBusyRef.current || transferBusyRef.current || Object.values(coreOperationsRef.current).some(state => state !== "unknown" && coreOperationBlocksInput(state));
  const coreLocked = cardBusy || transferBusy || Object.values(coreOperations).some(state => state !== "unknown" && coreOperationBlocksInput(state));
  const hasUnresolvedWrite = () => Object.values(coreOperationsRef.current).some(coreOperationBlocksInput);
  const setCoreOperation = (id: string, state: CoreOperationStage) => {
    coreOperationsRef.current = { ...coreOperationsRef.current, [id]: state };
    setCoreOperations(coreOperationsRef.current);
    setMessages(current => current.map(message => message.banking?.operationId === id
      ? { ...message, banking: { ...message.banking, coreStage: state, outcomePending: ["executing", "checking", "unknown"].includes(state) } } : message));
  };
  const [otpChallenge, setOtpChallenge] = useState<{ operationId: string; challengeId: string; expiresAt: string } | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const lastBankingRequest = useRef<{ text: string; choice?: { optionId: string; label: string }; resumeFlowId?: string; savings?: { token: string; inputs: SavingsPlanInputs }; syncOnly?: boolean } | null>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const goal = useRef("");
  const send = (event: FlowEvent) => {
    if (!canTransition(stageRef.current, event)) return false;
    stageRef.current = transition(stageRef.current, event);
    setStage(stageRef.current);
    return true;
  };
  const addMessage = (message: Omit<Message, "id">) => setMessages(current => [...current, { ...message, id: Date.now() + current.length }]);
  const installFlows = (flows: BankingFlows) => { bankingFlowsRef.current = flows; setBankingFlows(flows); };
  const acceptSession = (answer: BankingAgentData, flowId = '') => {
    if (answer.conversation) {
      bankingConversation.current = answer.conversation;
      restoredSessionToken.current = answer.conversation.token;
      setSessionPhase('ready'); setSessionView(answer.conversation);
      for (const reference of answer.conversation.operationReferences) {
        if (['confirmed', 'executing', 'checking', 'unknown'].includes(reference.coreState) && !['success', 'cancelled', 'error'].includes(coreOperationsRef.current[reference.operationId])) setCoreOperation(reference.operationId, 'unknown');
      }
    }
    installFlows(updateBankingFlows(bankingFlowsRef.current, flowId, answer));
  };
  useEffect(() => {
    try {
      const saved = restoreBankingChat(sessionStorage.getItem(bankingChatKey));
      if (saved) {
        // Browser storage must be restored after hydration, once per mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMessages(saved.messages);
        const recovered: Record<string, CoreOperationStage> = {};
        for (const message of saved.messages) {
          const data = message.banking;
          if (data?.operationId && (data.outcomePending === true || ["executing", "checking", "unknown"].includes(data.coreStage || ""))) {
            recovered[data.operationId] = "unknown";
            submittedOperations.current.add(data.operationId);
          }
        }
        coreOperationsRef.current = recovered;
        setCoreOperations(recovered);
        restoredSessionToken.current = saved.conversationToken;
        setSessionPhase(saved.conversationToken ? 'unverified' : 'none');
        setBankingContinuation(saved.conversationToken ? null : saved.continuation);
        installFlows(saved.flows);
        setFocusedFlowId(saved.conversationToken ? null : saved.focusedFlowId);
        continuationIssuedAt.current = saved.continuationExpiresAt - continuationLifetime(saved.messages, saved.continuation);
        stageRef.current = "answered";
        setStage("answered");
      } else sessionStorage.removeItem(bankingChatKey);
    } catch { /* Storage may be unavailable; the in-memory conversation still works. */ }
    setChatReady(true);
    // The original saving-plan recovery separately stores only its opaque ID.
    if (apiConfig.mode === "http") {
      const pending = sessionStorage.getItem(pendingKey);
      if (pending) {
        stageRef.current = "unknown";
        // Recovery must happen after hydration, because storage is browser-only.
        setStage("unknown");
        setOperationId(pending);
      }
    }
    return () => {
      // Invalidate the latest request generation, not the value captured on mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!chatReady || modelMode !== "banking") return;
    try {
      const saved = saveBankingChat(messages, bankingContinuation, continuationIssuedAt.current, Date.now(), { flows: bankingFlows, focusedFlowId,
        conversationToken: bankingConversation.current?.token ?? restoredSessionToken.current });
      if (saved.length <= 256000) sessionStorage.setItem(bankingChatKey, saved);
      else sessionStorage.removeItem(bankingChatKey);
    } catch { /* A storage quota error must not interrupt a request. */ }
  }, [messages, bankingContinuation, chatReady, modelMode, bankingFlows, focusedFlowId, sessionPhase, sessionView]);
  useEffect(() => {
    const expiries = Object.values(bankingFlows).filter(flow => !flow.taskId).map(flow => flow.expiresAt);
    if (!expiries.length) return;
    const timer = setTimeout(() => installFlows(Object.fromEntries(Object.entries(bankingFlowsRef.current).filter(([, flow]) => flow.taskId || flow.expiresAt > Date.now()))), Math.max(0, Math.min(...expiries) - Date.now()));
    return () => clearTimeout(timer);
  }, [bankingFlows]);
  const startBanking = async (text: string, choice?: { optionId: string; label: string }, resumeFlowId?: string, savings?: { token: string; inputs: SavingsPlanInputs }, syncOnly = false) => {
    if (coreBlocked()) return;
    if (!consent || !accessCode.trim()) { setValidation("请勾选授权并输入演示访问码。"); return; }
    let flowId = resumeFlowId || (forceNewTask.current ? null : focusedFlowId) || crypto.randomUUID();
    let requestToken: string | undefined;
    if (!send("START")) return;
    setBankingFailure(null);
    const explicitNew = forceNewTask.current && !resumeFlowId && !choice && !savings && !syncOnly;
    if ((!bankingContinuation || explicitNew) && !choice && !savings && !syncOnly) flowStartMessage.current = text;
    lastBankingRequest.current = { text, choice, resumeFlowId, savings, syncOnly };
    setValidation("");
    if (!choice) setInput("");
    setMessages(current => current.map(message => message.kind === "banking_clarification" ? { ...message, banking: { ...message.banking!, choices: [] } } : message));
    activePreviews.current = { card: null, transfer: null };
    setActiveCardOperationId(null);
    setActiveTransferOperationId(null);
    if (!syncOnly) addMessage({ role: "user", text: savings ? ('month' in savings.inputs ? `已填写 ${savings.inputs.month} 分类收支和本目标已存金额` : "已填写本目标已存金额") : choice?.label || text || '恢复原业务' });
    const version = ++generation.current;
    active.current?.abort(); active.current = new AbortController();
    try {
      if (restoredSessionToken.current && !bankingConversation.current) {
        const checked = await askBankingAgent({ conversationToken: restoredSessionToken.current, taskMode: 'sync', replyStyle }, accessCode, active.current.signal);
        if (generation.current !== version) return;
        acceptSession(checked);
        if (syncOnly) { addMessage({ role: 'agent', text: '已恢复服务端会话关联。请使用下方业务入口继续；历史预览保持只读。' }); return; }
      }
      const resumeDirective = !explicitNew && !resumeFlowId && !choice && !savings && !syncOnly &&
        /^(?:请)?(?:继续|恢复)(?:刚才|之前|上次)的?转账[。！!？?]?$/.test(text.replace(/\s+/g, ''));
      if (resumeDirective) {
        // This is the same explicit navigation as the task-panel button. Only a
        // freshly verified server task and this tab's bound credential can match.
        const current = bankingConversation.current;
        const candidates = current ? [...(current.currentTask ? [current.currentTask] : []), ...current.suspendedTasks]
          .filter(task => task.action === 'transfer.create' && ['ready', 'awaiting_input', 'awaiting_confirmation', 'suspended'].includes(task.status) && task.expiresAt > Date.now()) : [];
        if (candidates.length !== 1 || !bankingFlowsRef.current[candidates[0].taskId]) {
          setValidation('请在待继续业务中选择要恢复的转账；若没有有效凭据，请重新开始业务。');
          return;
        }
        resumeFlowId = candidates[0].taskId;
        flowId = resumeFlowId;
      }
      const resumed = resumeFlowId ? bankingFlowsRef.current[resumeFlowId] : undefined;
      if (resumeFlowId && (!resumed || (!resumed.taskId && resumed.expiresAt <= Date.now()))) throw new ApiError('CONTINUATION_INVALID', '该业务续接不可用，请重新开始当前业务。');
      const session = bankingConversation.current;
      if (resumed?.taskId && (!session || ![session.currentTask, ...session.suspendedTasks].some(task => task?.taskId === resumed.taskId))) throw new ApiError('CONTINUATION_INVALID', '该业务不属于当前已核验会话。');
      requestToken = explicitNew ? undefined : savings?.token || resumed?.token || bankingContinuation || undefined;
      const resumeMode = !!resumed?.taskId && (resumeDirective || session?.suspendedTasks.some(task => task.taskId === resumed.taskId) || (!text && !choice && !savings));
      const body = savings
        ? { continuationToken: requestToken, planInputs: savings.inputs, replyStyle }
        : choice ? { continuationToken: requestToken, choice: { optionId: choice.optionId }, replyStyle }
          : resumeMode && (!text || resumeDirective) && !choice ? { continuationToken: requestToken, replyStyle } : { message: text, continuationToken: requestToken, replyStyle };
      // The authenticated draft carries task context. Do not donate another task's
      // chat history or overflow the HTTP body by replaying display snapshots.
      const history = session ? [] : messages.slice(-4).map(message => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text.slice(0, 500) })).filter(message => message.content.trim());
      const answer = await askBankingAgent({ ...(syncOnly ? { taskMode: 'sync' as const, replyStyle } : body), history,
        ...(session ? { conversationToken: session.token, conversationRevision: session.revision } : {}),
        ...(!syncOnly && resumed?.taskId ? { taskId: resumed.taskId, taskMode: resumeMode ? 'resume' as const : 'continue' as const } : {}),
        ...(explicitNew ? { taskMode: 'new' as const } : {}) }, accessCode, active.current.signal);
      if (generation.current !== version) return;
      forceNewTask.current = false;
      acceptSession(answer, flowId);
      const replyText = [answer.reply!.text, ...answer.reply!.safetyNotices].join("\n");
      continuationIssuedAt.current = Date.now();
      setBankingContinuation(answer.continuationToken || null);
      setFocusedFlowId(bankingContinuationToken(answer.continuationToken) ? answer.conversation?.currentTask?.taskId || flowId : null);
      if (answer.status === 'conversation_state') {
        addMessage({ role: 'agent', text: '已核验当前会话。恢复业务后将重新查询参数、选项和正式预览。' });
      } else if (answer.status === "needs_plan_inputs") {
        addMessage({ role: "agent", kind: "banking_savings_inputs", text: replyText, banking: answer });
        send("CLARIFY");
      } else if (answer.kind === "clarification" || answer.status === "needs_clarification") {
        addMessage({ role: "agent", kind: "banking_clarification", text: replyText, banking: answer });
        send("CLARIFY");
      } else if (answer.status === "bill_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_bill", text: replyText, banking: answer });
      } else if (answer.status === "card_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_card", text: replyText, banking: answer });
      } else if (answer.status === "wealth_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_wealth", text: replyText, banking: answer });
      } else if (answer.status === "goal_plan" && answer.data?.verification_status === "verified") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_savings_plan", text: replyText, banking: answer });
      } else if (["subscription_result", "product_result", "wealth_recommendation", "wealth_comparison", "risk_assessment_required", "goal_plan", "scenario_rule_preview", "scenario_rule", "scenario_event_review"].includes(answer.status)) {
        setBankingContinuation(null);
        if (answer.status === "scenario_rule_preview" && answer.operationId) { activePreviews.current.card = hasUnresolvedWrite() ? null : answer.operationId; setActiveCardOperationId(activePreviews.current.card); setCoreOperation(answer.operationId, "plan"); }
        addMessage({ role: "agent", kind: "banking_read", text: answer.status === "scenario_rule_preview" ? "规则变更预览已生成。请核对后使用页面确认按钮，聊天文字不会执行操作。" : replyText, banking: answer });
      } else if (answer.status === "cancelled") {
        setBankingContinuation(null);
        addMessage({ role: "agent", text: answer.action?.startsWith("scenario.") ? "场景规则变更已取消，规则未修改。" : replyText });
      } else if (answer.status === "awaiting_confirmation") {
        if (answer.action?.startsWith("card.") && isTrialPreview(answer)) {
          setActiveCardOperationId(null);
          addMessage({ role: "agent", kind: "banking_card_preview", text: replyText, banking: { ...answer, previewCurrent: true } });
        } else if (answer.action?.startsWith("card.")) {
          setBankingContinuation(null);
          activePreviews.current.card = hasUnresolvedWrite() ? null : answer.operationId || null;
          if (answer.operationId) setCoreOperation(answer.operationId, "plan");
          setActiveCardOperationId(activePreviews.current.card);
          addMessage({ role: "agent", kind: "banking_card_preview", text: replyText, banking: answer });
        } else if (answer.action?.startsWith("wealth.")) {
          setBankingContinuation(null);
          activePreviews.current.card = hasUnresolvedWrite() ? null : answer.operationId || null;
          if (answer.operationId) setCoreOperation(answer.operationId, "plan");
          setActiveCardOperationId(activePreviews.current.card);
          addMessage({ role: "agent", kind: "banking_wealth_preview", text: replyText, banking: answer });
        } else if (answer.action?.startsWith("transfer.") && !isTrialPreview(answer)) {
          setBankingContinuation(null);
          activePreviews.current.transfer = hasUnresolvedWrite() ? null : answer.operationId || null;
          if (answer.operationId) setCoreOperation(answer.operationId, "plan");
          setActiveTransferOperationId(activePreviews.current.transfer);
          addMessage({ role: "agent", kind: "banking_preview", text: replyText, banking: answer });
        } else {
          activePreviews.current.transfer = hasUnresolvedWrite() ? null : answer.operationId || null;
          setActiveTransferOperationId(activePreviews.current.transfer);
          if (answer.operationId) setCoreOperation(answer.operationId, "plan");
          addMessage({ role: "agent", kind: "banking_preview", text: replyText, banking: answer });
        }
      } else if (answer.status === "unsupported") {
        addMessage({ role: "agent", text: replyText });
      } else {
        setFailure("analysis");
        addMessage({ role: "agent", kind: "error", text: "Banking Agent 未返回可用结果，请重新描述请求。", errorHint: "可以继续输入，无需清空聊天记录。" });
        send("FAILED");
      }
    } catch (error) {
      if (generation.current !== version) return;
      if (error instanceof BankingAgentError && error.conversation) acceptSession({ status: 'conversation_state', conversation: error.conversation });
      if ((error instanceof BankingAgentError && error.policy.category === 'session_expired' && !error.conversation) ||
          (error instanceof ApiError && ['CONVERSATION_NOT_FOUND', 'CONVERSATION_EXPIRED'].includes(error.code))) {
        bankingConversation.current = undefined; restoredSessionToken.current = undefined; setSessionView(null); setSessionPhase('failed'); installFlows({});
      }
      if (error instanceof BankingAgentError && error.recovery) {
        const recovery = error.recovery;
        continuationIssuedAt.current = Date.now();
        setBankingContinuation(recovery.continuationToken!);
        acceptSession(recovery, flowId);
        setFocusedFlowId(recovery.conversation?.currentTask?.taskId || flowId);
        addMessage({ role: "agent", kind: "banking_clarification", text: [recovery.reply?.text || error.message, ...(recovery.reply?.safetyNotices || [])].join("\n"), banking: recovery });
        send("CLARIFY"); return;
      }
      const policy = error instanceof BankingAgentError ? error.policy : agentErrorPolicy(error instanceof ApiError ? error.code : 'UNKNOWN_ERROR');
      // A rule-confirmation turn can perform a write; never replay it after a lost response.
      const previousAction = messages.findLast(m => m.banking?.continuationToken === requestToken)?.banking?.action;
      const safePolicy = requestToken && previousAction?.startsWith('scenario.') && policy.retryable ? { ...policy, retryable: false, nextAction: 'restart_flow', context: 'clear' } : policy;
      setBankingFailure(safePolicy);
      if (safePolicy.context === 'clear') {
        setBankingContinuation(null); setFocusedFlowId(null);
        installFlows(Object.fromEntries(Object.entries(bankingFlowsRef.current).filter(([id]) => id !== flowId)));
      }
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "Banking Agent 请求失败", errorHint: agentErrorHint(safePolicy) });
      setFailure('analysis'); send('FAILED');
    } finally {
      // Only this live request may settle analyzing. A preview is an answer,
      // never evidence that a financial operation succeeded.
      if (generation.current === version && stageRef.current === "analyzing") send("ANSWER");
    }
  };
  const cardClient = () => createBankingClient({ mode: "http", accessCode: () => accessCode });
  const retirePreview = (data: BankingAgentData, kind: "card" | "transfer") => {
    if (activePreviews.current[kind] === data.operationId) {
      activePreviews.current[kind] = null;
      if (kind === "card") setActiveCardOperationId(null);
      else setActiveTransferOperationId(null);
    }
  };
  const showCardOutcome = async (data: BankingAgentData, receipt: ActionReceipt, version: number) => {
    if (receipt.operationId !== data.operationId || receipt.action !== data.action) throw new ApiError("INVALID_RESPONSE", "操作回执不匹配，请查询原操作", true);
    if (receipt.status !== "succeeded") {
      addMessage({ role: "agent", kind: "error", text: receipt.message });
      return receipt.status === "cancelled" ? "cancelled" as const : "error" as const;
    }
    if (data.action?.startsWith("wealth.")) {
      const checked = await cardClient().request("action.status", { operationId: data.operationId! });
      if (generation.current !== version) return;
      if (checked.status !== "succeeded" || checked.receipt?.receiptId !== receipt.receiptId) throw new ApiError("INVALID_RESPONSE", "理财回执无法核实，请查询原操作", true);
      addMessage({ role: "agent", kind: "banking_wealth_receipt", text: `${receipt.message}；已核对操作回执。`, receipt });
      return "success" as const;
    }
    if (data.action?.startsWith('scenario.')) {
      const checked = await cardClient().request('action.status', { operationId: data.operationId! });
      if (generation.current !== version) return;
      const effect = receipt.effects[0];
      if (checked.receipt?.receiptId !== receipt.receiptId || effect?.kind !== 'scenario_rule_change') throw new ApiError('INVALID_RESPONSE', '规则回执无法核实，请查询原操作');
      addMessage({ role: 'agent', kind: 'banking_read', text: '已核对规则保存回执。规则只生成建议。', banking: { status: 'scenario_rule', action: data.action, data: { rule: effect.after } } });
      return "success" as const;
    }
    const effect = receipt.effects[0]?.kind === "card_change" ? receipt.effects[0] : undefined;
    if (!effect) throw new ApiError("INVALID_RESPONSE", "卡片回执缺少变更效果", true);
    const card = await cardClient().request("card.get", { id: effect.cardId });
    if (generation.current !== version) return;
    if (card.status !== effect.after.status || card.monthlyBudgetFen !== effect.after.monthlyBudgetFen || card.version < effect.cardVersion + 1 ||
        card.onlinePaymentsEnabled !== effect.after.onlinePaymentsEnabled || JSON.stringify(card.blockedCategories) !== JSON.stringify(effect.after.blockedCategories) || card.alertThresholdFen !== effect.after.alertThresholdFen ||
        card.balanceReminderAmountFen !== effect.after.balanceReminderAmountFen || card.balanceReminderPercent !== effect.after.balanceReminderPercent) throw new ApiError("INVALID_RESPONSE", "回执与重新查询的卡片状态不一致，请查询原操作", true);
    addMessage({ role: "agent", text: `${receipt.message}；已重新查询卡片。` });
    addMessage({ role: "agent", kind: "banking_card", text: "卡片当前状态", banking: { status: "card_result", action: "card.get", data: { card }, evidence: data.evidence } });
    if (data.action === "card.set_budget") addMessage({ role: "agent", text: "月预算已设置。要不要再设置预算余额提醒？例如：余额剩 200 元时提醒我，或预算只剩 20% 时提醒我。余额用完时也会提醒。" });
    return "success" as const;
  };
  const showTransferOutcome = async (data: BankingAgentData, receipt: ActionReceipt, version: number) => {
    const coreId = isTrialOperationId(data.operationId) ? data.operationId!.slice("tfpreview:".length) : data.operationId;
    if (receipt.operationId !== coreId || receipt.action !== "transfer_money") throw new ApiError("INVALID_RESPONSE", "转账回执不匹配，请查询原操作", true);
    if (receipt.status !== "succeeded") {
      addMessage({ role: "agent", kind: "error", text: receipt.message });
      return receipt.status === "cancelled" ? "cancelled" as const : "error" as const;
    }
    const first = receipt.effects[0];
    const effect = first?.kind === "transfer_out" ? first : undefined;
    if (!effect) throw new ApiError("INVALID_RESPONSE", "转账回执缺少扣款效果", true);
    const account = await cardClient().request("account.get", { id: effect.fromAccountId });
    if (generation.current !== version) return;
    if (account.availableBalanceFen !== effect.availableBalanceAfterFen) throw new ApiError("INVALID_RESPONSE", "回执与重新查询的账户余额不一致，请查询原操作", true);
    const transactions = await cardClient().request("transaction.list", { accountId: effect.fromAccountId });
    if (generation.current !== version) return;
    const booked = transactions.find(transaction => receipt.transactionIds.includes(transaction.id));
    if (!booked || booked.amountFen !== effect.amountFen || booked.type !== "transfer_out" || booked.payeeId !== effect.payeeId || booked.status !== "posted") throw new ApiError("INVALID_RESPONSE", "回执与后端交易记录不一致，请查询原操作", true);
    setMessages(current => current.map(message => message.banking?.operationId === data.operationId
      ? { ...message, banking: { ...message.banking!, executed: true } } : message));
    if (data.operationId && isTrialOperationId(data.operationId)) {
      installFlows(Object.fromEntries(Object.entries(bankingFlowsRef.current).filter(([, flow]) => flow.previewOperationId !== data.operationId)));
      setFocusedFlowId(current => current && bankingFlows[current]?.previewOperationId === data.operationId ? null : current);
      setBankingContinuation(null);
    }
    addMessage({ role: "agent", kind: "banking_receipt", text: "转账已完成，凭证可在账户概览中查看。", receipt,
      verification: { availableBalanceFen: account.availableBalanceFen, transactionId: booked.id, occurredAt: booked.occurredAt, amountFen: booked.amountFen, status: booked.status } });
    return "success" as const;
  };
  const runCoreOperation = async (data: BankingAgentData, kind: "card" | "transfer", mode: "confirm" | "reject" | "check") => {
    const id = data.operationId;
    const trial = isTrialPreview(data);
    if (!id || (trial && (!isTrialOperationId(id) || kind !== "transfer" || mode === "reject"))) return;
    if (cardBusyRef.current || transferBusyRef.current || stageRef.current === "analyzing") return;
    if (mode !== "check" && (data.historySnapshot || hasUnresolvedWrite() || coreBlocked() || activePreviews.current[kind] !== id || submittedOperations.current.has(id))) return;
    const previewHash = data.preview?.previewHash;
    const stepIds = data.preview?.stepIds;
    if (mode !== "check" && (typeof previewHash !== "string" || (!trial && (!Array.isArray(stepIds) || stepIds.some(step => typeof step !== "string"))))) return;
    // 高风险试点转账先发起一次性验证码，进入 OTP 输入态；验证通过后才执行，绝不未验证直接扣款。
    if (mode === "confirm" && trial && kind === "transfer" && typeof previewHash === "string" && data.risk?.requiredVerification === "otp") {
      transferBusyRef.current = true; setTransferBusy(true);
      try {
        const started = await startTrialVerification(id, previewHash, accessCode, active.current?.signal ?? new AbortController().signal);
        setOtpChallenge({ operationId: id, challengeId: started.challengeId, expiresAt: started.expiresAt });
        setOtpError(null);
      } catch (error) {
        addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "验证码发起失败", errorHint: "验证码未发出；可重新点击确认转账。" });
      } finally { transferBusyRef.current = false; setTransferBusy(false); }
      return;
    }
    const busyRef = kind === "card" ? cardBusyRef : transferBusyRef;
    const setBusy = kind === "card" ? setCardBusy : setTransferBusy;
    busyRef.current = true; setBusy(true);
    const version = generation.current;
    const live = () => generation.current === version;
    if (mode !== "check") {
      // Consume before the first await, including decide, so stale handlers cannot replay.
      submittedOperations.current.add(id);
      retirePreview(data, kind);
    }
    setCoreOperation(id, mode === "check" ? "checking" : "executing");
    let verifyingReceipt = false;
    try {
      const client = cardClient();
      let receipt: ActionReceipt;
      if (mode === "check" || mode === "reject") {
        const status = mode === "check"
          ? await client.request("action.status", { operationId: isTrialOperationId(id) ? id.slice("tfpreview:".length) : id })
          : await client.request("action.decide", { operationId: id, previewHash: previewHash as string, decision: "reject", confirmedStepIds: [] });
        if (!live()) return;
        if (!status.receipt) {
          const awaiting = mode === "check" && ["awaiting_confirmation", "confirmed"].includes(status.state);
          const owner = Object.values(bankingFlowsRef.current).find(flow => flow.previewOperationId === id);
          const currentOwner = !owner?.taskId || bankingConversation.current?.currentTask?.taskId === owner.taskId;
          if (awaiting && !data.historySnapshot && currentOwner) {
            submittedOperations.current.delete(id);
            activePreviews.current[kind] = id;
            if (kind === "card") setActiveCardOperationId(id); else setActiveTransferOperationId(id);
          }
          setCoreOperation(id, awaiting ? "plan" : "unknown");
          addMessage({ role: "agent", text: `操作 ${id} 状态：${status.state}，尚未取得最终回执。请查询操作状态，勿重复提交。` });
          return;
        }
        receipt = status.receipt;
      } else if (trial) {
        receipt = await executeTrialTransfer(id, previewHash as string, accessCode, new AbortController().signal);
      } else {
        const decision = await client.request("action.decide", { operationId: id, previewHash: previewHash as string, decision: "confirm", confirmedStepIds: stepIds as string[] });
        if (!live()) return;
        if (decision.state !== "confirmed") throw new ApiError("CONFIRMATION_INVALID", "操作未被确认");
        receipt = await client.request("action.execute", { operationId: id, previewHash: previewHash as string });
      }
      if (!live()) return;
      verifyingReceipt = true;
      const outcome = kind === "card" ? await showCardOutcome(data, receipt, version) : await showTransferOutcome(data, receipt, version);
      if (!live() || !outcome) return;
      submittedOperations.current.add(id);
      retirePreview(data, kind);
      setCoreOperation(id, outcome);
    } catch (error) {
      if (!live()) return;
      const uncertain = mode === "check" || mode === "reject" || verifyingReceipt || !(error instanceof ApiError) || error.uncertain;
      setCoreOperation(id, uncertain ? "unknown" : "error");
      retirePreview(data, kind);
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "操作未取得可靠结果", errorHint: uncertain ? `结果待核实，操作编号：${id}。请查询操作状态，勿重复提交。` : `操作失败，编号：${id}。可修改请求并生成新预览。` });
    } finally {
      if (live()) { busyRef.current = false; setBusy(false); }
    }
  };
  const checkCardOperation = (data: BankingAgentData) => runCoreOperation(data, "card", "check");
  const confirmCardOperation = (data: BankingAgentData) => runCoreOperation(data, "card", "confirm");
  const rejectCardOperation = (data: BankingAgentData) => runCoreOperation(data, "card", "reject");
  const checkTransferOperation = (data: BankingAgentData) => runCoreOperation(data, "transfer", "check");
  const confirmTransferOperation = (data: BankingAgentData) => runCoreOperation(data, "transfer", "confirm");
  const rejectTransferOperation = (data: BankingAgentData) => runCoreOperation(data, "transfer", "reject");
  const verifyTransferOperation = async (data: BankingAgentData, code: string) => {
    const challenge = otpChallenge;
    if (!challenge || challenge.operationId !== data.operationId || transferBusyRef.current) return;
    const previewHash = data.preview?.previewHash;
    if (!data.operationId || typeof previewHash !== "string") return;
    transferBusyRef.current = true; setTransferBusy(true); setOtpError(null);
    const version = generation.current;
    try {
      await verifyTrialVerification(data.operationId, previewHash, challenge.challengeId, code, accessCode, active.current?.signal ?? new AbortController().signal);
      const receipt = await executeTrialTransfer(data.operationId, previewHash, accessCode, active.current?.signal ?? new AbortController().signal);
      setOtpChallenge(null);
      const outcome = await showTransferOutcome(data, receipt, version);
      if (outcome) {
        submittedOperations.current.add(data.operationId);
        retirePreview(data, "transfer");
        setCoreOperation(data.operationId, outcome);
      }
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : "验证码校验失败");
    } finally { transferBusyRef.current = false; setTransferBusy(false); }
  };
  const cancelTransferVerification = () => { setOtpChallenge(null); setOtpError(null); };
  const startDemo = async (text = input.trim() || "我想在年底存下 2 万元") => {
    if (coreBlocked()) return;
    if (!consent) { setValidation("请先勾选账单分析授权。"); return; }
    if (!text.trim() || text.length > 500) { setValidation("目标须为 1–500 字。"); return; }
    if ((modelMode === "qwen" || modelMode === "banking" || apiConfig.mode === "http") && !accessCode.trim()) { setValidation("请输入服务端配置的演示访问码（不是百炼 API Key）。"); return; }
    if (modelMode === "banking") { await startBanking(text); return; }
    if (!send("START")) return;
    setValidation(""); setInput(""); goal.current = text;
    addMessage({ role: "user", text });
    const version = ++generation.current;
    active.current?.abort(); active.current = new AbortController();
    try {
      if (modelMode === "qwen") {
        const answer = await askQwen(text, conversation.current, accessCode, active.current.signal);
        if (generation.current !== version) return;
        conversation.current = [...conversation.current, { role: "user", content: text }, { role: "assistant", content: answer.reply.slice(0, 1500) }].slice(-6) as AgentTurn[];
        setUsage(answer.usage);
        addMessage({ role: "agent", text: answer.reply, ...(answer.intent === "analyze_bills" || answer.intent === "subscriptions" ? { kind: "analysis" as const, analysis: answer.analysis } : {}) });
        if (answer.plan) {
          targetDeadline.current = answer.plan.deadline ?? null;
          setMonthlySaving(answer.plan.monthlySavingFen / 100);
          setTargetAmountFen(answer.plan.targetAmountFen);
          send("ANALYZED");
        } else send(answer.needsClarification ? "CLARIFY" : "ANSWER");
        return;
      }
      const analysis = await request("analyze", { goal: text, consent: true }, { signal: active.current.signal, accessCode });
      if (generation.current !== version) return;
      addMessage({ role: "agent", kind: "analysis", analysis, text: "模拟账单分析已完成。以下为演示方案，修改后请再次确认。" });
      send("ANALYZED");
    } catch (error) {
      if (generation.current !== version) return;
      setFailure("analysis"); send("FAILED");
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "账单分析失败" });
    }
  };
  const settle = (receipt: Receipt) => {
    if (receipt.status === "pending") { send("UNCERTAIN"); return; }
    if (apiConfig.mode === "http") sessionStorage.removeItem(pendingKey);
    setFailure("plan");
    send(receipt.status === "succeeded" ? "SUCCEEDED" : "FAILED");
    addMessage({ role: "agent", kind: receipt.status === "succeeded" ? "result" : "error", text: receipt.message });
  };
  const confirmPlan = async () => {
    const draft = { monthlySavingFen: Math.round(monthlySaving * 100), targetAmountFen, ...(targetDeadline.current ? { deadline: targetDeadline.current } : {}), confirmed: true as const };
    const invalid = validatePlan(draft) || (Math.abs(monthlySaving * 100 - draft.monthlySavingFen) > 0.000001 ? "金额最多保留两位小数。" : null);
    if (invalid) { setValidation(invalid); return; }
    if (!send("CONFIRM")) return;
    setValidation(""); setFailure("plan");
    const id = crypto.randomUUID(); setOperationId(id);
    addMessage({ role: "user", text: `确认创建目标计划：每月 ¥${monthlySaving}${targetDeadline.current ? `，截止 ${targetDeadline.current}` : ""}。本次不发起支付。` });
    try {
      if (apiConfig.mode === "http") sessionStorage.setItem(pendingKey, id);
      settle(await request("create-plan", draft, { operationId: id, accessCode }));
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.uncertain;
      send(uncertain ? "UNCERTAIN" : "FAILED");
      if (!uncertain && apiConfig.mode === "http") sessionStorage.removeItem(pendingKey);
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "操作结果待核实" });
    }
  };
  const checkResult = async () => {
    if (!operationId || !send("CHECK")) return;
    try { settle(await request("operation-status", { operationId }, { accessCode })); }
    catch (error) { send("UNCERTAIN"); addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "结果查询失败" }); }
  };
  const editPlan = () => { if (send("EDIT")) setValidation(""); };
  const savePlan = () => {
    const cents = Math.round(monthlySaving * 100);
    const error = validatePlan({ monthlySavingFen: cents }) || (Math.abs(monthlySaving * 100 - cents) > 0.000001 ? "金额最多保留两位小数。" : null);
    if (error) { setValidation(error); return; }
    if (send("SAVE")) { setValidation(""); addMessage({ role: "agent", text: "已更新草稿，请确认新的储蓄安排。" }); }
  };
  const cancelPlan = () => { if (send("CANCEL")) { setValidation(""); addMessage({ role: "agent", text: "本次计划已取消，未提交执行。" }); } };
  const restart = () => {
    if (coreBlocked() || !send("RESET")) return;
    if (hasUnresolvedWrite()) { setInput(""); setBankingContinuation(null); setFocusedFlowId(null); forceNewTask.current = true; setBankingFailure(null); setValidation("原操作结果待核实，已保留聊天记录和查询入口；可以继续其他查询。"); return; }
    setBankingFailure(null);
    targetDeadline.current = null;
    bankingConversation.current = undefined;
    restoredSessionToken.current = undefined; setSessionView(null); setSessionPhase('none'); forceNewTask.current = false;
    generation.current++; active.current?.abort(); setMessages(initialMessages); setInput("");
    coreOperationsRef.current = {}; setCoreOperations({});
    activePreviews.current = { card: null, transfer: null };
    setMonthlySaving(saveflowMock.goal.monthlySaving); setValidation(""); setOperationId(""); setConsent(false);
    setTargetAmountFen(saveflowMock.goal.targetAmount * 100); setUsage(null); conversation.current = []; setBankingContinuation(null); lastBankingRequest.current = null;
    setActiveCardOperationId(null);
    setActiveTransferOperationId(null);
    installFlows({}); setFocusedFlowId(null);
    try { sessionStorage.removeItem(bankingChatKey); } catch { /* Optional browser storage. */ }
  };
  const changeModelMode = (mode: "qwen" | "mock" | "banking") => { if (coreBlocked() || !canTransition(stageRef.current, "RESET")) return; restart(); setModelMode(mode); };
  const chooseBankingOption = (optionId: string, label: string, owner?: BankingAgentData) => {
    const data = owner ?? messages.findLast(message => message.banking?.choices?.some(choice => choice.optionId === optionId))?.banking;
    if (!data?.choices?.some(choice => choice.optionId === optionId && choice.label === label) || data.historySnapshot || data.continuationToken !== bankingContinuation) return;
    if (modelMode !== "banking" || !bankingContinuation || !canTransition(stageRef.current, 'START')) return;
    const flow = Object.values(bankingFlowsRef.current).find(flow => flow.token === data.continuationToken);
    if (flow?.taskId && bankingConversation.current?.currentTask?.taskId !== flow.taskId) { setValidation('请先恢复该业务，再使用服务端重新提供的选项。'); return; }
    return startBanking("", { optionId, label }, flow?.id);
  };
  const submitSavingsInputs = (data: BankingAgentData, inputs: SavingsPlanInputs) => {
    if (modelMode !== "banking" || data.historySnapshot || data.status !== "needs_plan_inputs" || !data.continuationToken || data.continuationToken !== bankingContinuation || !canTransition(stageRef.current, "START")) return;
    const flow = Object.values(bankingFlowsRef.current).find(flow => flow.token === data.continuationToken);
    return startBanking("", undefined, flow?.id, { token: data.continuationToken, inputs });
  };
  const editTransferPreview = (data: BankingAgentData, message: string) => {
    if (modelMode !== "banking" || !canTransition(stageRef.current, "START")) return;
    if (data.historySnapshot) { setValidation('历史预览只供查看，请恢复业务以获取新的正式预览。'); return; }
    const flow = transferFlow(bankingFlowsRef.current, data);
    if (flow) {
      return startBanking(message, undefined, flow.id);
    } else if (bankingConversation.current || data.historySnapshot || isTrialPreview(data)) {
      setValidation('请先恢复这项业务，再使用最新正式预览修改参数。');
    } else {
      return startBanking(message);
    }
  };
  const restartBankingFlow = () => {
    if (!canTransition(stageRef.current, 'START')) return;
    setBankingContinuation(null); setFocusedFlowId(null); forceNewTask.current = true; setBankingFailure(null);
    setMessages(current => current.map(m => m.kind === 'banking_clarification' ? { ...m, banking: { ...m.banking!, choices: [] } } : m));
    setInput(flowStartMessage.current); setValidation('请重新描述或修改这项业务后发送；聊天记录已保留。');
  };
  const resumeBankingTask = (taskId: string) => {
    if (modelMode !== 'banking' || sessionPhase !== 'ready') return;
    const flow = Object.values(bankingFlowsRef.current).find(flow => flow.taskId === taskId);
    if (!flow) { setValidation('本标签页没有这项业务的续接凭据，请重新开始当前业务。'); return; }
    return startBanking('', undefined, flow.id);
  };
  const unresolvedWrite = Object.values(coreOperations).some(coreOperationBlocksInput);
  const sessionTasks = sessionPhase === 'ready' && sessionView ? [...(sessionView.currentTask ? [sessionView.currentTask] : []), ...sessionView.suspendedTasks]
    .filter(task => ['ready', 'awaiting_input', 'awaiting_confirmation', 'suspended'].includes(task.status))
    .map(task => ({ ...task, canResume: !!bankingFlows[task.taskId], blocked: sessionView.operationReferences.some(ref => ref.taskId === task.taskId && ['confirmed', 'executing', 'checking', 'unknown'].includes(ref.coreState)) ||
      (unresolvedWrite && ['transfer.create', 'card.freeze', 'card.unfreeze', 'card.set_budget', 'card.set_controls', 'wealth.subscribe', 'wealth.redeem', 'scenario.create_rule', 'scenario.update_rule', 'scenario.disable_rule'].includes(task.action)) })) : [];
  return { sessionPhase, sessionTasks, resumeBankingTask, verifyBankingSession: () => startBanking('', undefined, undefined, undefined, true), bankingFailure, restartBankingFlow, stage, coreOperations, messages, input, setInput, monthlySaving, setMonthlySaving, consent, setConsent, validation, operationId, failure, startDemo, chooseBankingOption, submitSavingsInputs, editTransferPreview, bankingContinuation, resumableTransferIds: Object.values(bankingFlows).filter(flow => !flow.taskId && flow.action === "transfer.create").map(flow => flow.previewOperationId).filter((id): id is string => !!id), confirmCardOperation, rejectCardOperation, checkCardOperation, activeCardOperationId, cardBusy, confirmTransferOperation, rejectTransferOperation, checkTransferOperation, activeTransferOperationId, transferBusy, otpChallenge, otpError, verifyTransferOperation, cancelTransferVerification, confirmPlan, checkResult, editPlan, savePlan, cancelPlan, restart, retryAnalysis: () => modelMode === "banking" ? bankingFailure?.retryable && lastBankingRequest.current ? startBanking(lastBankingRequest.current.text, lastBankingRequest.current.choice, lastBankingRequest.current.resumeFlowId, lastBankingRequest.current.savings, lastBankingRequest.current.syncOnly) : undefined : startDemo(goal.current), canStart: !coreLocked && canTransition(stage, "START"), canReset: !coreLocked && canTransition(stage, "RESET"), modelMode, changeModelMode, accessCode, setAccessCode, targetAmountFen, usage, replyStyle, setReplyStyle };
}

