// skill/transfer/index.ts
import { resolvePayee } from "./resolve_payee";
import { prepareTransfer } from "./prepare_transfer";
import type { PrepareTransferInput, TransferDependencies } from "./types";

// 导出两个核心函数 + 全部类型定义
export { resolvePayee, prepareTransfer };
export * from "./types";

/** Tool 输入 schema 字段描述 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "integer"; description: string }>;
  required: string[];
}

/**
 * 单个 Tool 元信息 + 已绑定依赖的处理函数。
 * 供 A 同学的 ToolRegistry 注册，供 Orchestrator 调度调用。
 */
export interface TransferTool {
  /** Tool 唯一名，建议带命名空间前缀 */
  name: string;
  /** Tool 用途描述，供 Orchestrator 做意图路由 */
  description: string;
  /** 输入约束（JSON Schema 风格），供参数校验 */
  inputSchema: ToolInputSchema;
  /** 已绑定依赖的执行入口 */
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 产出 Transfer Skill 的 Tool 元信息（用于注册进 A 同学的 ToolRegistry，
 * 供 Orchestrator 调度调用）。外部依赖由调用方注入并在此绑定。
 *
 * 注意：executeTransfer 在 deps 中声明但不在任何 Tool 内直接调用——
 * 真正扣款应在 Orchestrator 拿到 canExecute=true 的预览结果、并取得用户
 * 确认后，由上层调用 deps.executeTransfer 执行。
 */
export function createTransferTools(deps: TransferDependencies): TransferTool[] {
  return [
    {
      name: "transfer.resolve_payee",
      description: "根据收款人姓名解析唯一收款人；重名时返回全部候选，绝不私下挑选。",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "收款人姓名" } },
        required: ["name"],
      },
      run: (args) => resolvePayee(deps.repository, typeof args.name === "string" ? args.name : ""),
    },
    {
      name: "transfer.prepare_transfer",
      description: "转账预览预演算：只计算预估转账后余额，不扣款、不改账户，并做风险校验。",
      inputSchema: {
        type: "object",
        properties: {
          sourceAccountId: { type: "string", description: "转出账户 ID" },
          payeeId: { type: "string", description: "收款人 ID" },
          amountFen: { type: "integer", description: "转账金额（分，整数）" },
          currency: { type: "string", description: "货币代码，当前仅 CNY" },
        },
        required: ["sourceAccountId", "payeeId", "amountFen", "currency"],
      },
      run: (args) =>
        prepareTransfer(deps.repository, deps.riskCheck, args as unknown as PrepareTransferInput),
    },
  ];
}
