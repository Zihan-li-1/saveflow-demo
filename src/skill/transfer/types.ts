// skill/transfer/types.ts
/**
 * Transfer Skill 类型定义（阶段一：仅转账能力）
 *
 * 契约依据：intent-contracts.md v1.1.0 的 transfer.create 动作。
 * 约定：
 * 1. 金额严禁浮点数，统一 { amount_minor: number, currency: "CNY" }，amount_minor 为分的整数。
 * 2. 槽位名遵循契约：payee_ref / amount / source_account_ref；
 *    payee_ref 原始可为用户口语称呼，解析完成后映射服务端 entity_id。
 * 3. 收款人歧义 / 找不到 → 返回 state:needs_clarification 并附带 clarification，不抛异常、不猜测。
 * 4. 本 skill 只做实体解析与转账预览数据组装：不实现用户确认、不计算 risk_level（由上层 Risk 引擎负责）、绝不直接执行真实转账。
 * 5. 对外输出字段 snake_case，对齐合约 JSON。
 */

/** 货币代码（严格字面量约束；当前仅支持人民币） */
export type Currency = "CNY";

/** 金额结构：严禁浮点，amount_minor 为分的整数 */
export interface Amount {
  /** 金额（分，整数） */
  amount_minor: number;
  /** 货币代码 */
  currency: Currency;
}

/** 收款人实体（由 FinancialContextRepository 提供）；id 即服务端 entity_id */
export interface Payee {
  /** 服务端 entity_id */
  id: string;
  /** 收款人姓名 */
  name: string;
  /** 别名（口语称呼），用于 payee_ref 匹配 */
  aliases?: string[];
}

/** 账户实体（由 FinancialContextRepository 提供） */
export interface Account {
  /** 账户唯一 ID */
  id: string;
  /** 账户币种 */
  currency: Currency;
  /** 可用余额（分，整数） */
  availableBalanceFen: number;
}

/**
 * 金融上下文底座（只读查询）。本模块仅声明接口契约，不实现、不 mock。
 */
export interface FinancialContextRepository {
  /** 按账户 ID 查询账户；不存在时返回 null */
  queryAccount(accountId: string): Promise<Account | null> | Account | null;
  /** 按收款人姓名（含别名）查询收款人列表（可能 0 / 1 / 多个） */
  queryPayeesByName(name: string): Promise<Payee[]> | Payee[];
}

/** 解析后的实体引用（对齐 wire.mjs 的 references 结构） */
export interface EntityReference {
  slot: "source_account_ref" | "payee_ref";
  /** 服务端实体 ID */
  entity_id: string;
  /** 实体来源：financial_context（底座唯一匹配）/ user_selection（用户显式选择） */
  source: "financial_context" | "user_selection";
}

/** 转账意图原始槽位（LLM 抽取的口语槽位，可能缺失） */
export interface TransferIntentSlots {
  /** 收款人原始称呼（口语）；缺失时为 null / undefined */
  payee_ref?: string | null;
  /** 金额结构；缺失时为 null / undefined */
  amount?: Amount | null;
  /** 转出账户引用；缺失时为 null / undefined */
  source_account_ref?: string | null;
}

/** clarification 追问信息（交由上层 Orchestrator 向用户澄清） */
export interface Clarification {
  reason:
    | "missing_slot"
    | "invalid_amount"
    | "payee_not_found"
    | "ambiguous_payee"
    | "source_account_not_found";
  /** 追问文案 */
  question: string;
  /** 需要澄清的槽位 */
  slot?: "payee_ref" | "amount" | "source_account_ref";
  /** 重名歧义时的候选列表 */
  candidates?: Payee[];
}

/** 转账预览数据（纯组装，不扣款、不含 risk_level） */
export interface TransferPreview {
  source_account_id: string;
  payee_id: string;
  amount_minor: number;
  currency: Currency;
  /** 转出账户可用余额（分） */
  available_balance_minor: number;
  /** 预估转账后余额（分） */
  estimated_balance_after_minor: number;
}

/** 收款人解析结果（resolve_payee 输出） */
export type PayeeResolution =
  | { status: "resolved"; payee: Payee }
  | { status: "needs_clarification"; clarification: Clarification };

/** 转账预览组装入参（已唯一解析的实体 ID + 金额） */
export interface PrepareTransferInput {
  source_account_id: string;
  payee_id: string;
  amount: Amount;
}

/** 转账预览组装结果（prepare_transfer 输出） */
export type PrepareTransferResult =
  | { status: "ready"; preview: TransferPreview }
  | { status: "needs_clarification"; clarification: Clarification };

/**
 * 解析后的转账意图（D skill 对外输出，snake_case，对齐 wire.mjs 的 A/D handoff）：
 * - ready_for_planning  ：全部槽位唯一解析成功，附带 references + preview
 * - needs_clarification ：缺失必备槽位 / 金额非法 / 收款人找不到或重名歧义 / 转出账户不存在
 */
export type ResolvedTransferIntent =
  | {
      action: "transfer.create";
      state: "ready_for_planning";
      resolved_slots: { amount: Amount };
      references: EntityReference[];
      preview: TransferPreview;
    }
  | {
      action: "transfer.create";
      state: "needs_clarification";
      clarification: Clarification;
    };

/** 转账 Skill 全部外部依赖（只读底座；不注入 riskCheck / executeTransfer） */
export interface TransferDependencies {
  repository: FinancialContextRepository;
}
