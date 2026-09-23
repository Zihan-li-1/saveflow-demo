/** Banking Core 1.0.0. Internal money = safe integer fen; rates = integer bps.
 * NLP/HTTP snake_case conversion belongs exclusively to wire.mjs. */
export type Currency = "CNY";
export type RiskLevel = "L0" | "L1" | "L2" | "L3";
export type Account = { id: string; name: string; type: "checking" | "saving"; currency: Currency; balanceFen: number; availableBalanceFen: number; version: number; status: "active" | "frozen" };
export type Payee = { id: string; name: string; phone?: string; aliases: string[]; accountNoMasked: string; currency: Currency; status: "active" | "disabled" };
export type Transaction = { id: string; accountId: string; payeeId?: string; operationId?: string; occurredAt: string; type: "income" | "expense" | "transfer_out"; category: string; merchant: string; amountFen: number; currency: Currency; status: "posted"; source: "synthetic_seed" | "mock_execution" };
export type Card = { id: string; name: string; accountId: string; status: "active" | "frozen"; monthlyLimitFen: number; monthlySpentFen: number };
export type Subscription = { id: string; name: string; monthlyFeeFen: number; status: "active" | "cancelled"; lastUsedDate: string; isPotentiallyUnused: boolean; mandateId: string | null };
/** expectedYield is an illustrative annual rate in BPS, never a guaranteed yield. */
export type InvestmentProduct = { id: string; name: string; riskLevel: "R1" | "R2" | "R3"; expectedYield: number; liquidity: "T+0" | "T+1" | "AT_MATURITY"; minimumAmountFen: number; durationDays: number; currency: Currency; isSynthetic: true };
export type ContextInfo = { datasetId: string; asOf: string; currentMonth: string; previousMonth: string; snapshotId: string; dataSource: "synthetic_demo_only"; currency: Currency };
export type SavingGoal = { id: string; targetAmountFen: number; currentAmountFen: number; targetDate: string; proposedMonthlySavingFen: number };
export type DemoSettings = { monthlyIncomeFen: number; defaultMonthlySavingFen: number; monthlySavingCapFen: number };
export interface FinancialContextRepository {
  getContextInfo(): ContextInfo;
  getAccounts(): Account[];
  getAccount(id: string): Account | undefined;
  getPayees(): Payee[];
  getPayee(id: string): Payee | undefined;
  getTransactions(filter?: { accountId?: string; month?: string }): Transaction[];
  getCards(): Card[];
  getSubscriptions(): Subscription[];
  getInvestmentProducts(): InvestmentProduct[];
  getSavingGoal(): SavingGoal;
  getDemoSettings(): DemoSettings;
}
export type TransferInput = { fromAccountId: string; payeeId: string; amountFen: number; currency: Currency; memo?: string };
export type ActionRequest = { action: "transfer_money"; input: TransferInput; planId?: string; stepId?: string; origin?: "user_requested" | "agent_suggested" | "event_triggered" };
export type ActionState = "preparing" | "risk_check" | "awaiting_confirmation" | "confirmed" | "executing" | "succeeded" | "failed" | "cancelled" | "unknown" | "checking";
export type ErrorCode = "VALIDATION_ERROR" | "UNKNOWN_ACTION" | "ACCOUNT_NOT_FOUND" | "PAYEE_NOT_FOUND" | "ACCOUNT_BLOCKED" | "PAYEE_BLOCKED" | "INSUFFICIENT_BALANCE" | "LIMIT_EXCEEDED" | "CONFIRMATION_REQUIRED" | "CONFIRMATION_INVALID" | "PREVIEW_EXPIRED" | "PREVIEW_STALE" | "IDEMPOTENCY_CONFLICT" | "OPERATION_NOT_FOUND" | "INVALID_STATE" | "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "TIMEOUT" | "INTERNAL_ERROR";
export type ActionError = { code: ErrorCode; message: string; uncertain: boolean };
export type RiskResult = { allowed: boolean; riskLevel: RiskLevel; policyVersion: string; requiredConfirmation: "mock_explicit"; warnings: string[]; error?: ActionError };
export type TransferEffect = { kind: "transfer_out"; fromAccountId: string; accountName: string; payeeId: string; payeeName: string; accountNoMasked: string; amountFen: number; feeFen: number; currency: Currency; balanceBeforeFen: number; balanceAfterFen: number; availableBalanceAfterFen: number; accountVersion: number; memo: string; arrival: "mock_immediate" };
export type ActionPreview = { planId: string; stepIds: string[]; summary: string; exactEffects: TransferEffect[]; riskLevel: RiskLevel; warnings: string[]; expiresAt: string; previewHash: string; contextSnapshotId: string };
export type UserDecision = { planId: string; previewHash: string; decision: "confirm" | "reject"; confirmedStepIds: string[]; confirmationMethod: "mock_explicit"; idempotencyKey: string; decidedAt: string };
/** Only the UI confirmation adapter supplies this, never an LLM tool call. */
export type DecisionInput = Pick<UserDecision, "previewHash" | "decision" | "confirmedStepIds">;
export type ActionReceipt = { receiptId: string; operationId: string; action: "transfer_money" | "legacy.create-plan"; planId: string; stepId: string; status: "succeeded" | "failed" | "cancelled"; message: string; executedAt: string; dataSource: "synthetic_demo_only"; transactionIds: string[]; effects: TransferEffect[]; error?: ActionError };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError; operationId?: string };
export type PreparedAction = { operationId: string; state: "awaiting_confirmation"; preview: ActionPreview; risk: RiskResult };
export type OperationStatus = { operationId: string; state: ActionState; status: "pending" | "succeeded" | "failed" | "cancelled"; receipt?: ActionReceipt; preview?: ActionPreview; error?: ActionError };
export type ToolCall<T = Record<string, unknown>> = { toolCallId: string; tool: string; arguments: T; planId?: string; stepId?: string };
export type ToolResult<T = unknown> = { toolCallId: string; tool: string; result: ActionResult<T>; evidence: { source: string; asOf: string; entityIds: string[] }[] };
export type AuditEvent = { operationId: string; action: string; state: ActionState; at: string; errorCode?: ErrorCode };
export type OperationRecord = { operationId: string; action: "transfer_money" | "legacy.create-plan"; fingerprint: string; state: ActionState; request?: ActionRequest; preview?: ActionPreview; decision?: UserDecision; receipt?: ActionReceipt; risk?: RiskResult; error?: ActionError };
