"use client";
import { useEffect, useRef, useState } from "react";
import { canTransition, transition, type FlowEvent, type Stage } from "./flow-machine";
import { saveflowMock } from "./saveflow-mock";
import { request } from "./api/client";
import { apiConfig } from "./api/config";
import { askQwen, type AgentTurn } from "./agent-client";
import { askBankingAgent, BankingAgentError, executeTrialTransfer, type BankingAgentData } from "./banking-agent-client";
import { createBankingClient } from "./api/banking-client";
import type { ActionReceipt } from "../banking-core/contracts";
import { ApiError, validatePlan, type Analysis, type Receipt } from "./api/contracts";
import { isTrialOperationId, isTrialPreview } from "./trial-preview.mjs";
import { bankingChatKey, restoreBankingChat, saveBankingChat } from "./banking-chat-storage";
import { transferFlow, bankingContinuationToken, updateBankingFlows, type BankingFlows } from "./banking-flow-state";
import { agentErrorHint, agentErrorPolicy } from "./agent-error-policy.mjs";

export type Message = { id: number; role: "agent" | "user"; text: string; kind?: "normal" | "analysis" | "result" | "error" | "banking_clarification" | "banking_bill" | "banking_preview" | "banking_card" | "banking_card_preview" | "banking_read" | "banking_receipt" | "banking_wealth" | "banking_wealth_preview"; analysis?: Analysis; banking?: BankingAgentData; receipt?: ActionReceipt; verification?: { availableBalanceFen: number; transactionId: string; occurredAt: string; amountFen: number; status: string }; errorHint?: string };
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
  const [validation, setValidation] = useState("");
  const [bankingContinuation, setBankingContinuation] = useState<string | null>(null);
  const [bankingFlows, setBankingFlows] = useState<BankingFlows>({});
  const [focusedFlowId, setFocusedFlowId] = useState<string | null>(null);
  const continuationIssuedAt = useRef(0);
  const [chatReady, setChatReady] = useState(false);
  const [activeCardOperationId, setActiveCardOperationId] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const cardBusyRef = useRef(false);
  const [activeTransferOperationId, setActiveTransferOperationId] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const transferBusyRef = useRef(false);
  const lastBankingRequest = useRef<{ text: string; choice?: { optionId: string; label: string }; resumeFlowId?: string } | null>(null);
  const flowStartMessage = useRef("");
  const pendingWrites = useRef(new Set<string>());
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
  useEffect(() => {
    try {
      const saved = restoreBankingChat(sessionStorage.getItem(bankingChatKey));
      if (saved) {
        // Browser storage must be restored after hydration, once per mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMessages(saved.messages);
        pendingWrites.current = new Set(saved.messages.filter(m => m.banking?.outcomePending && m.banking.operationId).map(m => m.banking!.operationId!));
        setBankingContinuation(saved.continuation);
        setBankingFlows(saved.flows);
        setFocusedFlowId(saved.focusedFlowId);
        continuationIssuedAt.current = saved.continuationExpiresAt - 300000;
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
      const saved = saveBankingChat(messages, bankingContinuation, continuationIssuedAt.current, Date.now(), { flows: bankingFlows, focusedFlowId });
      if (saved.length <= 256000) sessionStorage.setItem(bankingChatKey, saved);
      else sessionStorage.removeItem(bankingChatKey);
    } catch { /* A storage quota error must not interrupt a request. */ }
  }, [messages, bankingContinuation, chatReady, modelMode, bankingFlows, focusedFlowId]);
  useEffect(() => {
    const expiries = Object.values(bankingFlows).map(flow => flow.expiresAt);
    if (!expiries.length) return;
    const timer = setTimeout(() => setBankingFlows(current => Object.fromEntries(Object.entries(current).filter(([, flow]) => flow.expiresAt > Date.now()))), Math.max(0, Math.min(...expiries) - Date.now()));
    return () => clearTimeout(timer);
  }, [bankingFlows]);
  const startBanking = async (text: string, choice?: { optionId: string; label: string }, resumeFlowId?: string) => {
    if (!consent || !accessCode.trim()) { setValidation("请勾选授权并输入演示访问码。"); return; }
    const flowId = resumeFlowId || focusedFlowId || crypto.randomUUID();
    const resumed = resumeFlowId ? bankingFlows[resumeFlowId] : undefined;
    if (resumeFlowId && (!resumed || resumed.expiresAt <= Date.now())) { setValidation("该预览续接已过期，请发起新转账。"); return; }
    const requestToken = resumed?.token || bankingContinuation || undefined;
    if (!send("START")) return;
    setBankingFailure(null);
    if (!requestToken && !choice) flowStartMessage.current = text;
    lastBankingRequest.current = { text, choice, resumeFlowId };
    setValidation("");
    if (!choice) setInput("");
    setMessages(current => current.map(message => message.kind === "banking_clarification" ? { ...message, banking: { ...message.banking!, choices: [] } } : message));
    setActiveCardOperationId(null);
    setActiveTransferOperationId(null);
    addMessage({ role: "user", text: choice?.label || text });
    const version = ++generation.current;
    active.current?.abort(); active.current = new AbortController();
    try {
      const body = choice
        ? { continuationToken: requestToken, choice: { optionId: choice.optionId }, replyStyle }
        : { message: text, continuationToken: requestToken, replyStyle };
      const history = messages.slice(-8).map(message => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: message.text.slice(0, 2000) })).filter(message => message.content.trim());
      const answer = await askBankingAgent({ ...body, history }, accessCode, active.current.signal);
      if (generation.current !== version) return;
      const replyText = [answer.reply!.text, ...answer.reply!.safetyNotices].join("\n");
      continuationIssuedAt.current = Date.now();
      setBankingContinuation(answer.continuationToken || null);
      setBankingFlows(current => updateBankingFlows(current, flowId, answer));
      setFocusedFlowId(bankingContinuationToken(answer.continuationToken) ? flowId : null);
      if (answer.kind === "clarification" || answer.status === "needs_clarification") {
        addMessage({ role: "agent", kind: "banking_clarification", text: replyText, banking: answer });
        send("CLARIFY");
      } else if (answer.status === "bill_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_bill", text: replyText, banking: answer });
        send("ANSWER");
      } else if (answer.status === "card_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_card", text: replyText, banking: answer });
        send("ANSWER");
      } else if (answer.status === "wealth_result") {
        setBankingContinuation(null);
        addMessage({ role: "agent", kind: "banking_wealth", text: replyText, banking: answer });
      } else if (["subscription_result", "product_result", "wealth_recommendation", "wealth_comparison", "risk_assessment_required", "goal_plan", "scenario_rule_preview", "scenario_rule", "scenario_event_review"].includes(answer.status)) {
        setBankingContinuation(null);
        if (answer.status === 'scenario_rule_preview') setActiveCardOperationId(pendingWrites.current.size ? null : answer.operationId || null);
        addMessage({ role: "agent", kind: "banking_read", text: answer.status === "scenario_rule_preview" ? "规则变更预览已生成。请核对后使用页面确认按钮，聊天文字不会执行操作。" : replyText, banking: answer });
      } else if (answer.status === "cancelled") {
        setBankingContinuation(null);
        addMessage({ role: "agent", text: answer.action?.startsWith("scenario.") ? "场景规则变更已取消，规则未修改。" : replyText });
        send("ANSWER");
      } else if (answer.status === "awaiting_confirmation") {
        if (answer.action?.startsWith("card.") && isTrialPreview(answer)) {
          setActiveCardOperationId(null);
          addMessage({ role: "agent", kind: "banking_card_preview", text: replyText, banking: { ...answer, previewCurrent: true } });
        } else if (answer.action?.startsWith("card.")) {
          setBankingContinuation(null);
          setActiveCardOperationId(pendingWrites.current.size ? null : answer.operationId || null);
          addMessage({ role: "agent", kind: "banking_card_preview", text: replyText, banking: answer });
        } else if (answer.action?.startsWith("wealth.")) {
          setBankingContinuation(null);
          setActiveCardOperationId(pendingWrites.current.size ? null : answer.operationId || null);
          addMessage({ role: "agent", kind: "banking_wealth_preview", text: replyText, banking: answer });
        } else if (answer.action?.startsWith("transfer.") && !isTrialPreview(answer)) {
          setBankingContinuation(null);
          setActiveTransferOperationId(pendingWrites.current.size ? null : answer.operationId || null);
          addMessage({ role: "agent", kind: "banking_preview", text: replyText, banking: answer });
        } else addMessage({ role: "agent", kind: "banking_preview", text: replyText, banking: answer });
      } else if (answer.status === "unsupported") {
        addMessage({ role: "agent", text: replyText });
        send("ANSWER");
      } else {
        addMessage({ role: "agent", kind: "error", text: "Banking Agent 未返回可用结果，请重新描述请求。", errorHint: "可以继续输入，无需清空聊天记录。" });
      }
    } catch (error) {
      if (generation.current !== version) return;
      if (error instanceof BankingAgentError && error.recovery) {
        const recovery = error.recovery;
        continuationIssuedAt.current = Date.now();
        setBankingContinuation(recovery.continuationToken!);
        setBankingFlows(current => updateBankingFlows(current, flowId, recovery));
        setFocusedFlowId(flowId);
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
        setBankingFlows(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== flowId)));
      }
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "Banking Agent 请求失败", errorHint: agentErrorHint(safePolicy) });
    } finally {
      // Every Skill result and failure releases the composer, including read-only results.
      if (generation.current === version && stageRef.current === 'analyzing') send('ANSWER');
    }
  };
  const markOutcome = (id: string, pending: boolean) => {
    if (pending) pendingWrites.current.add(id); else pendingWrites.current.delete(id);
    setMessages(current => current.map(message => message.banking?.operationId === id ? { ...message, banking: { ...message.banking, outcomePending: pending } } : message));
  };
  const cardClient = () => createBankingClient({ mode: "http", accessCode: () => accessCode });
  const showCardOutcome = async (data: BankingAgentData, receipt: ActionReceipt) => {
    if (receipt.status !== "succeeded") {
      if (data.operationId) markOutcome(data.operationId, false);
      addMessage({ role: "agent", kind: "error", text: receipt.message });
      setActiveCardOperationId(current => current === data.operationId ? null : current);
      return;
    }
    if (data.action?.startsWith("wealth.")) {
      const checked = await cardClient().request("action.status", { operationId: data.operationId! });
      if (checked.receipt?.receiptId !== receipt.receiptId) throw new ApiError("INVALID_RESPONSE", "理财回执无法核实，请查询原操作");
      if (data.operationId) markOutcome(data.operationId, false);
      addMessage({ role: "agent", text: `${receipt.message}；已核对操作回执。合成数据仅供演示。` });
      setActiveCardOperationId(current => current === data.operationId ? null : current);
      return;
    }
    if (data.action?.startsWith('scenario.')) {
      const checked = await cardClient().request('action.status', { operationId: data.operationId! });
      const effect = receipt.effects[0];
      if (checked.receipt?.receiptId !== receipt.receiptId || effect?.kind !== 'scenario_rule_change') throw new ApiError('INVALID_RESPONSE', '规则回执无法核实，请查询原操作');
      markOutcome(data.operationId!, false); setActiveCardOperationId(null);
      addMessage({ role: 'agent', kind: 'banking_read', text: '已核对规则保存回执。规则只生成建议。', banking: { status: 'scenario_rule', action: data.action, data: { rule: effect.after } } });
      return;
    }
    const effect = receipt.effects[0]?.kind === "card_change" ? receipt.effects[0] : undefined;
    if (!effect) throw new ApiError("INVALID_RESPONSE", "卡片回执缺少变更效果");
    const card = await cardClient().request("card.get", { id: effect.cardId });
    if (card.status !== effect.after.status || card.monthlyBudgetFen !== effect.after.monthlyBudgetFen || card.version < effect.cardVersion + 1) throw new ApiError("INVALID_RESPONSE", "回执与重新查询的卡片状态不一致，请查询原操作");
    if (data.operationId) markOutcome(data.operationId, false);
    addMessage({ role: "agent", text: `${receipt.message}；已重新查询卡片。` });
    addMessage({ role: "agent", kind: "banking_card", text: "卡片当前状态", banking: { status: "card_result", action: "card.get", data: { card }, evidence: data.evidence } });
    setActiveCardOperationId(current => current === data.operationId ? null : current);
  };
  const checkCardOperation = async (data: BankingAgentData) => {
    if (isTrialPreview(data)) return;
    if (!data.operationId || cardBusyRef.current) return;
    cardBusyRef.current = true; setCardBusy(true);
    try {
      const status = await cardClient().request("action.status", { operationId: data.operationId });
      if (status.receipt) await showCardOutcome(data, status.receipt);
      else {
        if (['awaiting_confirmation', 'confirmed'].includes(status.state)) { markOutcome(data.operationId, false); setActiveCardOperationId(data.operationId); }
        addMessage({ role: "agent", text: `操作 ${data.operationId} 状态：${status.state}，尚未取得成功回执。请核对原预览；不要创建重复操作。` });
      }
    } catch (error) { addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "状态查询失败" }); }
    finally { cardBusyRef.current = false; setCardBusy(false); }
  };
  const confirmCardOperation = async (data: BankingAgentData) => {
    if (isTrialPreview(data)) return;
    if (!data.operationId || data.operationId !== activeCardOperationId || cardBusyRef.current) return;
    if (pendingWrites.current.size) { addMessage({ role: 'agent', text: '已有操作结果待核实，请先查询原操作状态，再继续写操作。' }); return; }
    const previewHash = data.preview?.previewHash;
    const confirmedStepIds = data.preview?.stepIds;
    if (typeof previewHash !== "string" || !Array.isArray(confirmedStepIds) || confirmedStepIds.some(id => typeof id !== "string")) return;
    cardBusyRef.current = true; setCardBusy(true);
    setActiveCardOperationId(null); markOutcome(data.operationId, true);
    try {
      const client = cardClient();
      const decision = await client.request("action.decide", { operationId: data.operationId, previewHash, decision: "confirm", confirmedStepIds: confirmedStepIds as string[] });
      if (decision.state !== "confirmed") throw new ApiError("CONFIRMATION_INVALID", "卡片操作未被确认");
      const receipt = await client.request("action.execute", { operationId: data.operationId, previewHash });
      await showCardOutcome(data, receipt);
    } catch (error) {
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "卡片操作未取得可靠结果", errorHint: `请先查询原操作状态（${data.operationId}），核实后再继续；可以继续其他查询。` });
    } finally { cardBusyRef.current = false; setCardBusy(false); }
  };
  const rejectCardOperation = async (data: BankingAgentData) => {
    if (isTrialPreview(data)) return;
    if (!data.operationId || data.operationId !== activeCardOperationId || cardBusyRef.current || typeof data.preview?.previewHash !== "string") return;
    cardBusyRef.current = true; setCardBusy(true);
    setActiveCardOperationId(null); markOutcome(data.operationId, true);
    try {
      const status = await cardClient().request("action.decide", { operationId: data.operationId, previewHash: data.preview.previewHash, decision: "reject", confirmedStepIds: [] });
      if (status.status === "cancelled") {
        markOutcome(data.operationId, false);
        setActiveCardOperationId(null);
        addMessage({ role: "agent", text: "已取消本次卡片操作，卡片未变更。" });
      } else addMessage({ role: "agent", kind: "error", text: "未取得明确取消结果，请查询操作状态。" });
    } catch (error) { addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "取消请求失败" }); }
    finally { cardBusyRef.current = false; setCardBusy(false); }
  };
  const showTransferOutcome = async (data: BankingAgentData, receipt: ActionReceipt) => {
    if (receipt.status !== "succeeded") {
      if (data.operationId) markOutcome(data.operationId, false);
      addMessage({ role: "agent", kind: "error", text: receipt.message });
      setActiveTransferOperationId(current => current === data.operationId ? null : current);
      return;
    }
    const first = receipt.effects[0];
    const effect = first?.kind === "transfer_out" ? first : undefined;
    if (!effect) throw new ApiError("INVALID_RESPONSE", "转账回执缺少扣款效果");
    // 同一后端复核两件事：账户余额与交易记录，证明这笔钱确实已记账。
    const account = await cardClient().request("account.get", { id: effect.fromAccountId });
    if (account.availableBalanceFen !== effect.availableBalanceAfterFen) throw new ApiError("INVALID_RESPONSE", "回执与重新查询的账户余额不一致，请查询原操作");
    const transactions = await cardClient().request("transaction.list", { accountId: effect.fromAccountId });
    const booked = transactions.find(transaction => receipt.transactionIds.includes(transaction.id));
    if (!booked || booked.amountFen !== effect.amountFen || booked.type !== "transfer_out" || booked.payeeId !== effect.payeeId || booked.status !== "posted") {
      throw new ApiError("INVALID_RESPONSE", "回执与后端交易记录不一致，请查询原操作");
    }
    // 执行后预览只读：标记已执行，并撤销试点续接，避免同一预览再次确认或在聊天中“取消”。
    if (data.operationId) {
      markOutcome(data.operationId, false);
      setMessages(current => current.map(message => message.kind === "banking_preview" && message.banking?.operationId === data.operationId
        ? { ...message, banking: { ...message.banking!, executed: true } } : message));
      if (isTrialOperationId(data.operationId)) {
        setBankingFlows(current => Object.fromEntries(Object.entries(current).filter(([, flow]) => flow.previewOperationId !== data.operationId)));
        setFocusedFlowId(current => current && bankingFlows[current]?.previewOperationId === data.operationId ? null : current);
      }
    }
    addMessage({ role: "agent", kind: "banking_receipt", text: "转账已完成，凭证可在账户概览中查看。", receipt,
      verification: { availableBalanceFen: account.availableBalanceFen, transactionId: booked.id, occurredAt: booked.occurredAt, amountFen: booked.amountFen, status: booked.status } });
    setActiveTransferOperationId(current => current === data.operationId ? null : current);
  };
  const checkTransferOperation = async (data: BankingAgentData) => {
    if (!data.operationId || transferBusyRef.current) return;
    transferBusyRef.current = true; setTransferBusy(true);
    try {
      // Legacy bridge IDs wrap the same Core operation. Unwrap for read-only status only.
      const queryId = isTrialOperationId(data.operationId) ? data.operationId.slice('tfpreview:'.length) : data.operationId;
      const status = await cardClient().request("action.status", { operationId: queryId });
      if (status.receipt) await showTransferOutcome(data, status.receipt);
      else {
        if (['awaiting_confirmation', 'confirmed'].includes(status.state)) { markOutcome(data.operationId, false); setActiveTransferOperationId(data.operationId); }
        addMessage({ role: "agent", text: `操作 ${data.operationId} 状态：${status.state}，尚未取得成功回执。请核对原预览；不要创建重复操作。` });
      }
    } catch (error) { addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "状态查询失败" }); }
    finally { transferBusyRef.current = false; setTransferBusy(false); }
  };
  const confirmTrialTransferOperation = async (data: BankingAgentData) => {
    if (!isTrialPreview(data)) return;
    const previewHash = data.preview?.previewHash;
    if (!data.operationId || !isTrialOperationId(data.operationId) || typeof previewHash !== "string" || transferBusyRef.current || pendingWrites.current.size || data.executed) return;
    transferBusyRef.current = true; setTransferBusy(true);
    markOutcome(data.operationId, true);
    try {
      const receipt = await executeTrialTransfer(data.operationId, previewHash, accessCode, active.current?.signal ?? new AbortController().signal);
      await showTransferOutcome(data, receipt);
    } catch (error) {
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "转账未取得可靠结果", errorHint: `请先查询原操作状态（${data.operationId}），勿重复提交或重新发起同一笔转账。` });
    } finally { transferBusyRef.current = false; setTransferBusy(false); }
  };
  const confirmTransferOperation = async (data: BankingAgentData) => {
    if (isTrialPreview(data)) { await confirmTrialTransferOperation(data); return; }
    if (!data.operationId || data.operationId !== activeTransferOperationId || transferBusyRef.current) return;
    if (pendingWrites.current.size) { addMessage({ role: 'agent', text: '已有操作结果待核实，请先查询原操作状态，再继续写操作。' }); return; }
    const previewHash = data.preview?.previewHash;
    const confirmedStepIds = data.preview?.stepIds;
    if (typeof previewHash !== "string" || !Array.isArray(confirmedStepIds) || confirmedStepIds.some(id => typeof id !== "string")) return;
    transferBusyRef.current = true; setTransferBusy(true);
    setActiveTransferOperationId(null); markOutcome(data.operationId, true);
    try {
      const client = cardClient();
      const decision = await client.request("action.decide", { operationId: data.operationId, previewHash, decision: "confirm", confirmedStepIds: confirmedStepIds as string[] });
      if (decision.state !== "confirmed") throw new ApiError("CONFIRMATION_INVALID", "转账操作未被确认");
      const receipt = await client.request("action.execute", { operationId: data.operationId, previewHash });
      await showTransferOutcome(data, receipt);
    } catch (error) {
      addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "转账未取得可靠结果", errorHint: `请先查询原操作状态（${data.operationId}），核实后再继续；可以继续其他查询。` });
    } finally { transferBusyRef.current = false; setTransferBusy(false); }
  };
  const rejectTransferOperation = async (data: BankingAgentData) => {
    if (isTrialPreview(data)) return;
    if (!data.operationId || data.operationId !== activeTransferOperationId || transferBusyRef.current || typeof data.preview?.previewHash !== "string") return;
    transferBusyRef.current = true; setTransferBusy(true);
    setActiveTransferOperationId(null); markOutcome(data.operationId, true);
    try {
      const status = await cardClient().request("action.decide", { operationId: data.operationId, previewHash: data.preview.previewHash, decision: "reject", confirmedStepIds: [] });
      if (status.status === "cancelled") {
        markOutcome(data.operationId, false);
        setActiveTransferOperationId(null);
        addMessage({ role: "agent", text: "已取消本次转账，资金未扣。" });
      } else addMessage({ role: "agent", kind: "error", text: "未取得明确取消结果，请查询转账状态。" });
    } catch (error) { addMessage({ role: "agent", kind: "error", text: error instanceof Error ? error.message : "取消请求失败" }); }
    finally { transferBusyRef.current = false; setTransferBusy(false); }
  };
  const startDemo = async (text = input.trim() || "我想在年底存下 2 万元") => {
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
    if (!send("RESET")) return;
    if (pendingWrites.current.size) {
      setInput(''); setBankingContinuation(null); setFocusedFlowId(null); setBankingFlows({}); setBankingFailure(null);
      setValidation('原操作结果待核实，已保留聊天记录和查询入口；可以继续其他查询。');
      return;
    }
    targetDeadline.current = null;
    generation.current++; active.current?.abort(); setMessages(initialMessages); setInput("");
    setMonthlySaving(saveflowMock.goal.monthlySaving); setValidation(""); setOperationId(""); setConsent(false);
    setTargetAmountFen(saveflowMock.goal.targetAmount * 100); setUsage(null); conversation.current = []; setBankingContinuation(null); lastBankingRequest.current = null;
    setActiveCardOperationId(null);
    setActiveTransferOperationId(null);
    setBankingFlows({}); setFocusedFlowId(null);
    setBankingFailure(null);
    try { sessionStorage.removeItem(bankingChatKey); } catch { /* Optional browser storage. */ }
  };
  const changeModelMode = (mode: "qwen" | "mock" | "banking") => { if (!canTransition(stageRef.current, "RESET")) return; restart(); setModelMode(mode); };
  const chooseBankingOption = (optionId: string, label: string) => {
    if (!messages.some(message => message.banking?.choices?.some(choice => choice.optionId === optionId))) return;
    if (modelMode !== "banking" || !bankingContinuation || !canTransition(stageRef.current, 'START')) return;
    return startBanking("", { optionId, label });
  };
  const editTransferPreview = (data: BankingAgentData, message: string) => {
    if (modelMode !== "banking" || !canTransition(stageRef.current, "START")) return;
    if (isTrialPreview(data)) {
      const flow = transferFlow(bankingFlows, data);
      if (!flow) return;
      void startBanking(message, undefined, flow.id);
    } else {
      void startBanking(message);
    }
  };
  const restartBankingFlow = () => {
    if (!canTransition(stageRef.current, 'START')) return;
    setBankingContinuation(null); setFocusedFlowId(null); setBankingFlows({}); setBankingFailure(null);
    setMessages(current => current.map(m => m.kind === 'banking_clarification' ? { ...m, banking: { ...m.banking!, choices: [] } } : m));
    setInput(flowStartMessage.current); setValidation('请重新描述或修改这项业务后发送；聊天记录已保留。');
  };
  const retryAnalysis = () => {
    if (modelMode !== 'banking') return startDemo(goal.current);
    if (bankingFailure?.retryable && lastBankingRequest.current) return startBanking(lastBankingRequest.current.text, lastBankingRequest.current.choice, lastBankingRequest.current.resumeFlowId);
  };
  return { bankingFailure, restartBankingFlow, stage, messages, input, setInput, monthlySaving, setMonthlySaving, consent, setConsent, validation, operationId, failure, startDemo, chooseBankingOption, editTransferPreview, bankingContinuation, resumableTransferIds: Object.values(bankingFlows).filter(flow => flow.action === "transfer.create").map(flow => flow.previewOperationId).filter((id): id is string => !!id), confirmCardOperation, rejectCardOperation, checkCardOperation, activeCardOperationId, cardBusy, confirmTransferOperation, rejectTransferOperation, checkTransferOperation, activeTransferOperationId, transferBusy, confirmPlan, checkResult, editPlan, savePlan, cancelPlan, restart, retryAnalysis, canStart: canTransition(stage, "START"), canReset: canTransition(stage, "RESET"), modelMode, changeModelMode, accessCode, setAccessCode, targetAmountFen, usage, replyStyle, setReplyStyle };
}
