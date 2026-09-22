// skill/transfer/types.ts
/**
 * Transfer Skill 类型定义（阶段一：仅转账能力）
 *
 * 约定：
 * 1. 本模块只实现转账能力，不包含任何卡片相关代码。
 * 2. 金额一律使用「分」（fen）的整数表示：500 元 = 50000 fen。
 *    严禁浮点数，禁止直接用元作为内部计算单位。
 * 3. 所有外部依赖（FinancialContextRepository / riskCheck / executeTransfer）
 *    均由调用方以入参注入，本模块不自行实现、不写硬编码 mock 账户 / 收款人数据。
 * 4. 状态一律用字面量联合类型严格约束，便于编译期收窄与校验。
 */

/** 货币代码（严格字面量约束；当前仅支持人民币，fen 即人民币最小货币单位） */
export type Currency = "CNY";

/** 收款人实体（由 FinancialContextRepository 提供） */
export interface Payee {
  /** 收款人唯一 ID */
  id: string;
  /** 收款人姓名 */
  name: string;
  /** 收款账户号（可选，由底座按需提供） */
  accountNumber?: string;
  /** 收款银行（可选） */
  bankName?: string;
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
 * 金融上下文底座（B 同学提供）。
 * 本模块仅声明接口契约，不实现、不 mock。
 */
export interface FinancialContextRepository {
  /** 按账户 ID 查询账户；不存在时返回 null */
  queryAccount(accountId: string): Promise<Account | null> | Account | null;
  /** 按收款人姓名查询收款人列表（可能 0 个、1 个或多个重名） */
  queryPayeesByName(name: string): Promise<Payee[]> | Payee[];
}

/** 风险等级（严格字面量约束） */
export type RiskLevel = "none" | "low" | "medium" | "high";

/** 外部风险校验结果（riskCheck 返回） */
export interface RiskCheckResult {
  /** 是否通过风险校验 */
  passed: boolean;
  /** 风险等级 */
  level: RiskLevel;
  /** 未通过时的具体原因 */
  reasons?: string[];
}

/** 风险校验入参 */
export interface RiskCheckInput {
  sourceAccountId: string;
  payeeId: string;
  amountFen: number;
  currency: Currency;
}

/** 风险校验函数（B 同学 Banking Core），本模块仅声明类型 */
export type RiskCheck = (input: RiskCheckInput) => Promise<RiskCheckResult> | RiskCheckResult;

/** 真实转账入参 */
export interface ExecuteTransferInput {
  sourceAccountId: string;
  payeeId: string;
  amountFen: number;
  currency: Currency;
}

/** 转账回执 */
export interface TransferReceipt {
  operationId: string;
  status: "succeeded" | "failed" | "pending";
  message: string;
}

/**
 * 真实执行转账（B 同学 Banking Core）。
 * 本模块只做「调用声明」，不实现内部逻辑；真正的扣款由外部实现，
 * 并在 Orchestrator 确认预览结果后调用。
 */
export type ExecuteTransfer = (input: ExecuteTransferInput) => Promise<TransferReceipt>;

/**
 * 收款人解析结果（可辨识联合，用字面量严格约束状态）：
 * - resolved   ：唯一匹配，携带 payee 实体
 * - not_found  ：0 个匹配
 * - ambiguous  ：重名歧义，携带全部候选列表（绝不私下挑选其中一个）
 */
export type ResolvePayeeResult =
  | { status: "resolved"; payee: Payee }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; candidates: Payee[] };

/** 转账预览入参 */
export interface PrepareTransferInput {
  /** 转出账户 ID */
  sourceAccountId: string;
  /** 收款人 ID（由 resolve_payee 解析得到） */
  payeeId: string;
  /** 转账金额（分，整数） */
  amountFen: number;
  /** 货币代码 */
  currency: Currency;
}

/**
 * 转账预览状态（严格字面量约束）：
 * - ready               ：余额充足且风险校验通过，可执行
 * - insufficient-balance：余额不足，标记风险，禁止执行
 * - risk-rejected       ：外部风险校验未通过，禁止执行
 */
export type TransferPrepareStatus = "ready" | "insufficient-balance" | "risk-rejected";

/** 转账预览结果（纯预演算，不改账户、不扣款） */
export interface TransferPrepareResult {
  status: TransferPrepareStatus;
  sourceAccountId: string;
  payeeId: string;
  amountFen: number;
  currency: Currency;
  /** 转账前可用余额（分） */
  availableBalanceFen: number;
  /** 预估转账后可用余额（分） */
  estimatedBalanceAfterFen: number;
  /** 外部风险校验结果 */
  risk: RiskCheckResult;
  /** 是否可提交真实扣款（余额不足或风险拒绝时为 false） */
  canExecute: boolean;
  /** 提示 / 风险说明 */
  warnings: string[];
}

/** 转账 Skill 全部外部依赖（由调用方一次性注入） */
export interface TransferDependencies {
  repository: FinancialContextRepository;
  riskCheck: RiskCheck;
  executeTransfer: ExecuteTransfer;
}

/** 转账 Skill 业务异常（非法金额、账户不存在等前置条件失败） */
export class TransferSkillError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "INVALID_AMOUNT" | "ACCOUNT_NOT_FOUND",
    message: string
  ) {
    super(message);
    this.name = "TransferSkillError";
  }
}
