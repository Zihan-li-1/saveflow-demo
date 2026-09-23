"use client";
import { useEffect, useRef, useState } from "react";
import { canTransition, transition, type FlowEvent, type Stage } from "./flow-machine";
import { saveflowMock } from "./saveflow-mock";
import { request } from "./api/client";
import { apiConfig } from "./api/config";
import { askQwen, type AgentTurn } from "./agent-client";
import { ApiError, validatePlan, type Analysis, type Receipt } from "./api/contracts";

export type Message = { id: number; role: "agent" | "user"; text: string; kind?: "normal" | "analysis" | "result" | "error"; analysis?: Analysis };
const initialMessages: Message[] = [{ id: 1, role: "agent", text: "你好，我是 SaveFlow。告诉我一个具体的储蓄目标，我会把它拆成可执行的消费规则。" }];
const pendingKey = "saveflow.pending-operation.v1";

export function useSaveflow() {
  const [stage, setStage] = useState<Stage>("welcome");
  const [modelMode, setModelMode] = useState<"qwen" | "mock">("qwen");
  const [accessCode, setAccessCode] = useState("");
  const [category, setCategory] = useState("日常消费");
  const [targetAmountFen, setTargetAmountFen] = useState<number | null>(saveflowMock.goal.targetAmount * 100);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const conversation = useRef<AgentTurn[]>([]);
  const stageRef = useRef<Stage>("welcome");
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [monthlySaving, setMonthlySaving] = useState(saveflowMock.goal.monthlySaving);
  const [saveRate, setSaveRate] = useState(10);
  const [consent, setConsent] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [failure, setFailure] = useState<"analysis" | "plan">("analysis");
  const [validation, setValidation] = useState("");
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
    // Persist only the opaque operation ID, never the goal, balances, or credentials.
    if (apiConfig.mode === "http") {
      const pending = sessionStorage.getItem(pendingKey);
      if (pending) {
        stageRef.current = "unknown";
        // Recovery must happen after hydration, because storage is browser-only.
        // eslint-disable-next-line react-hooks/set-state-in-effect
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
  const startDemo = async (text = input.trim() || "我想在年底存下 2 万元") => {
    if (!consent) { setValidation("请先勾选账单分析授权。"); return; }
    if (!text.trim() || text.length > 500) { setValidation("目标须为 1–500 字。"); return; }
    if ((modelMode === "qwen" || apiConfig.mode === "http") && !accessCode.trim()) { setValidation("请输入服务端配置的演示访问码（不是百炼 API Key）。"); return; }
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
          setMonthlySaving(answer.plan.monthlySavingFen / 100); setSaveRate(answer.plan.saveRateBps / 100);
          setCategory(answer.plan.category); setTargetAmountFen(answer.plan.targetAmountFen);
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
    const draft = { monthlySavingFen: Math.round(monthlySaving * 100), saveRateBps: Math.round(saveRate * 100), category, targetAmountFen, confirmed: true as const };
    const invalid = validatePlan(draft) || (Math.abs(monthlySaving * 100 - draft.monthlySavingFen) > 0.000001 || Math.abs(saveRate * 100 - draft.saveRateBps) > 0.000001 ? "金额和比例最多保留两位小数。" : null);
    if (invalid) { setValidation(invalid); return; }
    if (!send("CONFIRM")) return;
    setValidation(""); setFailure("plan");
    const id = crypto.randomUUID(); setOperationId(id);
    addMessage({ role: "user", text: `确认创建计划：每月 ¥${monthlySaving}，${category}储蓄 ${saveRate}%。本次不发起支付。` });
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
    const bps = Math.round(saveRate * 100);
    const error = validatePlan({ monthlySavingFen: cents, saveRateBps: bps }) || (Math.abs(monthlySaving * 100 - cents) > 0.000001 || Math.abs(saveRate * 100 - bps) > 0.000001 ? "金额和比例最多保留两位小数。" : null);
    if (error) { setValidation(error); return; }
    if (send("SAVE")) { setValidation(""); addMessage({ role: "agent", text: "已更新草稿，请确认新的储蓄安排。" }); }
  };
  const cancelPlan = () => { if (send("CANCEL")) { setValidation(""); addMessage({ role: "agent", text: "本次计划已取消，未提交执行。" }); } };
  const restart = () => {
    if (!send("RESET")) return;
    generation.current++; active.current?.abort(); setMessages(initialMessages); setInput("");
    setMonthlySaving(saveflowMock.goal.monthlySaving); setSaveRate(10); setValidation(""); setOperationId(""); setConsent(false);
    setCategory("日常消费"); setTargetAmountFen(2000000); setUsage(null); conversation.current = [];
  };
  const changeModelMode = (mode: "qwen" | "mock") => { if (!canTransition(stageRef.current, "RESET")) return; restart(); setModelMode(mode); };
  return { stage, messages, input, setInput, monthlySaving, setMonthlySaving, saveRate, setSaveRate, consent, setConsent, validation, operationId, failure, startDemo, confirmPlan, checkResult, editPlan, savePlan, cancelPlan, restart, retryAnalysis: () => startDemo(goal.current), canStart: ["welcome", "success", "cancelled", "clarifying", "answered"].includes(stage), canReset: canTransition(stage, "RESET"), modelMode, changeModelMode, accessCode, setAccessCode, category, targetAmountFen, usage };
}
