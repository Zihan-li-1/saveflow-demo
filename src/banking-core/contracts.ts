/** Banking Core 1.0.0. Internal money = safe integer fen; rates = integer bps.
 * NLP/HTTP snake_case conversion belongs exclusively to wire.mjs. */
export type Currency = "CNY";
export type RiskLevel = "L0" | "L1" | "L2" | "L3";
export type Account = { id: string; name: string; type: "checking" | "saving"; currency: Currency; balanceFen: number; availableBalanceFen: number; version: number; status: "active" | "frozen" };
export type Payee = { id: string; name: string; phone?: string; aliases: string[]; accountNoMasked: string; currency: Currency; status: "active" | "disabled" };
export type Transaction = { id: string; accountId: string; payeeId?: string; counterpartyAccountId?: string; operationId?: string; occurredAt: string; type: "income" | "expense" | "transfer_out" | "internal_transfer_out" | "internal_transfer_in"; category: string; merchant: string; amountFen: number; currency: Currency; status: "posted"; source: "synthetic_seed" | "mock_execution" };
export type Card = { id: string; name: string; accountId: string; status: "active" | "frozen"; monthlyBudgetFen: number; monthlySpentFen: number; onlinePaymentsEnabled: boolean; blockedCategories: string[]; alertThresholdFen: number | null; balanceReminderAmountFen: number | null; balanceReminderPercent: number | null; version: number; previewGeneration: number };
export type Subscription = { id: string; name: string; monthlyFeeFen: number; status: "active" | "cancelled"; lastUsedDate: string; isPotentiallyUnused: boolean; mandateId: string | null };
/** expectedYield is an illustrative annual rate in BPS, never a guaranteed yield. */
export type InvestmentProduct = { id: string; name: string; riskLevel: "R1" | "R2" | "R3"; expectedYield: number; liquidity: "T+0" | "T+1" | "AT_MATURITY"; minimumAmountFen: number; durationDays: number; currency: Currency; isSynthetic: true };
export type ContextInfo = { availableMonths?: string[]; datasetId: string; asOf: string; currentMonth: string; previousMonth: string; snapshotId: string; dataSource: "synthetic_demo_only"; currency: Currency };
export type SavingGoal = { id: string; targetAmountFen: number; currentAmountFen: number; targetDate: string; proposedMonthlySavingFen: number };
export type DemoSettings = { monthlyIncomeFen: number; defaultMonthlySavingFen: number; monthlySavingCapFen: number };
export type MaybePromise<T> = T | Promise<T>;
export interface FinancialContextRepository {
  getContextInfo(): MaybePromise<ContextInfo>;
  getAccounts(): MaybePromise<Account[]>;
  getAccount(id: string): MaybePromise<Account | undefined>;
  getPayees(): MaybePromise<Payee[]>;
  getPayee(id: string): MaybePromise<Payee | undefined>;
  getTransactions(filter?: { accountId?: string; month?: string; startDate?: string; endDate?: string; timezone?: string }): MaybePromise<Transaction[]>;
  getCards(): MaybePromise<Card[]>;
  getCard(id: string): MaybePromise<Card | undefined>;
  getSubscriptions(): MaybePromise<Subscription[]>;
  getInvestmentProducts(): MaybePromise<InvestmentProduct[]>;
  getSavingGoal(): MaybePromise<SavingGoal>;
  getDemoSettings(): MaybePromise<DemoSettings>;
}
/** The in-memory fixture repository always returns resolved values. */
export type SyncFinancialContextRepository = {
  [K in keyof FinancialContextRepository]: (...args: Parameters<FinancialContextRepository[K]>) => Awaited<ReturnType<FinancialContextRepository[K]>>;
};
export interface BankingOperationStore {
  get(owner: string, operationId: string): MaybePromise<OperationRecord | undefined>;
  put(owner: string, record: OperationRecord): MaybePromise<void>;
  fingerprint(action: string, input: unknown): string;
  close?(): MaybePromise<void>;
  /** Atomically apply a verification transition against a fresh, row-locked read (Postgres `FOR UPDATE`).
   *  `apply` receives the current persisted record (never a stale copy), mutates its `verification`
   *  field in place, and returns an optional error to surface after the store has committed the
   *  mutation. A throw from `apply` aborts the transaction without persisting. Used so concurrent
   *  wrong-code attempts cannot lose counts. */
  mutateVerification?(owner: string, operationId: string, apply: (record: OperationRecord) => { error?: Pick<ActionError, "code" | "message"> }): MaybePromise<{ error?: Pick<ActionError, "code" | "message"> }>;
  commitTransfer?(owner: string, record: OperationRecord, effect: TransferEffect | InternalTransferEffect, at: string, makeReceipt: (transaction: Transaction | Transaction[]) => ActionReceipt): MaybePromise<ActionReceipt>;
  reserveCardPreview?(owner: string, cardId: string): MaybePromise<number>;
  commitCard?(owner: string, record: OperationRecord, effect: CardEffect, makeReceipt: () => ActionReceipt): MaybePromise<ActionReceipt>;
  commitWealth?(owner: string, record: OperationRecord, effect: WealthEffect, makeReceipt: () => ActionReceipt): MaybePromise<ActionReceipt>;
  getScenarioRule?(owner: string, ruleId: string): MaybePromise<ScenarioRule | undefined>;
  reserveScenarioPreview?(owner: string, ruleId: string): MaybePromise<number>;
  commitScenario?(owner: string, record: OperationRecord, effect: ScenarioEffect, makeReceipt: () => ActionReceipt): MaybePromise<ActionReceipt>;
}
export type TransferInput = { fromAccountId: string; payeeId: string; toAccountId?: never; amountFen: number; currency: Currency; memo?: string } | { fromAccountId: string; toAccountId: string; payeeId?: never; amountFen: number; currency: Currency; memo?: string };
export type CardAction = "card.set_budget" | "card.set_controls" | "card.freeze" | "card.unfreeze";
export type CardInput = { cardId: string; monthlyBudgetFen?: number; onlinePaymentsEnabled?: boolean; blockedCategories?: string[]; alertThresholdFen?: number | null; balanceReminderAmountFen?: number | null; balanceReminderPercent?: number | null };
export type WealthAction = "wealth.subscribe" | "wealth.redeem";
export type WealthInput = { productId?: string; amountFen?: number; currency?: Currency; sourceAccountId?: string; holdingId?: string; quantityKind?: "amount" | "units"; unitsMilli?: number };
export type ScenarioStep = { action: string; parameters: Record<string, string | number | boolean | string[]> };
export type ScenarioRule = { id: string; status: "active" | "disabled"; trigger: { type: "manual" | "date" | "financial_event"; value: string }; conditions: Record<string, string | number | boolean>; proposed_steps: ScenarioStep[]; authorization_scope: "suggest_only"; version: number; previewGeneration: number; created_at: string; updated_at: string };
export type ScenarioAction = "scenario.create_rule" | "scenario.update_rule" | "scenario.disable_rule";
export type ScenarioInput = { trigger: ScenarioRule["trigger"]; conditions: ScenarioRule["conditions"]; proposed_steps: ScenarioStep[]; authorization_scope: "suggest_only" } | { ruleRef: string; changes: Partial<Pick<ScenarioRule, "trigger" | "conditions" | "proposed_steps">> } | { ruleRef: string };
export type ActionRequest = { action: "transfer_money"; input: TransferInput; planId?: string; stepId?: string; origin?: "user_requested" | "agent_suggested" | "event_triggered" } | { action: CardAction; input: CardInput } | { action: ScenarioAction; input: ScenarioInput } | { action: WealthAction; input: WealthInput };
export type ActionState = "preparing" | "risk_check" | "awaiting_confirmation" | "confirmed" | "executing" | "succeeded" | "failed" | "cancelled" | "unknown" | "checking";
export type ErrorCode = "VALIDATION_ERROR" | "UNKNOWN_ACTION" | "CARD_NOT_FOUND" | "ACCOUNT_NOT_FOUND" | "PAYEE_NOT_FOUND" | "ACCOUNT_BLOCKED" | "PAYEE_BLOCKED" | "INSUFFICIENT_BALANCE" | "LIMIT_EXCEEDED" | "CONFIRMATION_REQUIRED" | "CONFIRMATION_INVALID" | "PREVIEW_EXPIRED" | "PREVIEW_STALE" | "IDEMPOTENCY_CONFLICT" | "OPERATION_NOT_FOUND" | "INVALID_STATE" | "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "TIMEOUT" | "INTERNAL_ERROR" | "CAPABILITY_UNAVAILABLE" | "SUITABILITY_FAILED" | "BELOW_MINIMUM_AMOUNT" | "HOLDING_NOT_FOUND" | "REDEMPTION_RESTRICTED" | "INSUFFICIENT_HOLDING" | "VERIFICATION_REQUIRED" | "VERIFICATION_INVALID" | "VERIFICATION_EXPIRED" | "VERIFICATION_LOCKED" | "VERIFICATION_ALREADY_USED" | "VERIFICATION_RATE_LIMITED";
export type ActionError = { code: ErrorCode; message: string; uncertain: boolean };
/** `requiredVerification` only states what extra step a risk policy demands. It never carries the
 *  credential itself — the OTP challenge is generated and verified server-side, out of band. */
export type RiskResult = { allowed: boolean; riskLevel: RiskLevel; policyVersion: string; requiredConfirmation: "mock_explicit"; requiredVerification?: "none" | "otp"; warnings: string[]; error?: ActionError };
export type VerificationStatus = "pending" | "verified" | "locked";
/** Persisted server-side (inside OperationRecord, JSONB). The plaintext code is never stored — only its
 *  per-challenge hash. `verifiedAt` marks single-use consumption; resend replaces the whole state. */
export type VerificationState = { challengeId: string; codeHash: string; issuedAt: string; expiresAt: string; attempts: number; maxAttempts: number; status: VerificationStatus; verifiedAt?: string };
export type VerificationStartResult = { challengeId: string; expiresAt: string; remainingAttempts: number; deliveryHint: string };
export type VerificationVerifyInput = { challengeId: string; code: string };
export type TransferEffect = { kind: "transfer_out"; fromAccountId: string; accountName: string; payeeId: string; payeeName: string; accountNoMasked: string; amountFen: number; feeFen: number; currency: Currency; balanceBeforeFen: number; balanceAfterFen: number; availableBalanceAfterFen: number; accountVersion: number; memo: string; arrival: "mock_immediate" };
export type InternalTransferEffect = { kind: "transfer_internal"; fromAccountId: string; accountName: string; toAccountId: string; targetAccountName: string; amountFen: number; currency: Currency; sourceBalanceBeforeFen: number; sourceBalanceAfterFen: number; sourceAvailableBalanceAfterFen: number; sourceAccountVersion: number; targetBalanceBeforeFen: number; targetBalanceAfterFen: number; targetAvailableBalanceAfterFen: number; targetAccountVersion: number; memo: string };
export type CardEffect = { kind: "card_change"; action: CardAction; cardId: string; cardName: string; cardVersion: number; previewGeneration: number; before: { status: Card["status"]; monthlyBudgetFen: number; onlinePaymentsEnabled: boolean; blockedCategories: string[]; alertThresholdFen: number | null; balanceReminderAmountFen: number | null; balanceReminderPercent: number | null }; after: { status: Card["status"]; monthlyBudgetFen: number; onlinePaymentsEnabled: boolean; blockedCategories: string[]; alertThresholdFen: number | null; balanceReminderAmountFen: number | null; balanceReminderPercent: number | null }; monthlySpentFen: number };
export type WealthEffect = { kind: "wealth_change"; action: WealthAction; productId: string; productName: string; holdingId: string; holdingVersion: number | null; fundingAccountId?: string; accountVersion?: number; amountFen: number; unitsMilli: number; disclosureVersion?: string; assessmentId?: string; settlement?: string };
export type ScenarioEffect = { kind: "scenario_rule_change"; action: ScenarioAction; ruleId: string; ruleVersion: number | null; previewGeneration: number; before: ScenarioRule | null; after: ScenarioRule };
export type ActionPreview = { planId: string; stepIds: string[]; summary: string; exactEffects: (TransferEffect | InternalTransferEffect | CardEffect | ScenarioEffect | WealthEffect)[]; riskLevel: RiskLevel; warnings: string[]; expiresAt: string; previewHash: string; contextSnapshotId: string };
export type UserDecision = { planId: string; previewHash: string; decision: "confirm" | "reject"; confirmedStepIds: string[]; confirmationMethod: "mock_explicit"; idempotencyKey: string; decidedAt: string };
/** Only the UI confirmation adapter supplies this, never an LLM tool call. */
export type DecisionInput = Pick<UserDecision, "previewHash" | "decision" | "confirmedStepIds">;
export type ActionReceipt = { receiptId: string; operationId: string; action: "transfer_money" | CardAction | ScenarioAction | WealthAction | "legacy.create-plan"; planId: string; stepId: string; status: "succeeded" | "failed" | "cancelled"; message: string; executedAt: string; dataSource: "synthetic_demo_only"; transactionIds: string[]; effects: (TransferEffect | InternalTransferEffect | CardEffect | ScenarioEffect | WealthEffect)[]; error?: ActionError };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError; operationId?: string };
export type PreparedAction = { operationId: string; state: "awaiting_confirmation"; preview: ActionPreview; risk: RiskResult };
export type OperationStatus = { operationId: string; state: ActionState; status: "pending" | "succeeded" | "failed" | "cancelled"; receipt?: ActionReceipt; preview?: ActionPreview; error?: ActionError };
export type ToolCall<T = Record<string, unknown>> = { toolCallId: string; tool: string; arguments: T; planId?: string; stepId?: string };
export type ToolResult<T = unknown> = { toolCallId: string; tool: string; result: ActionResult<T>; evidence: { source: string; asOf: string; entityIds: string[] }[] };
export type AuditEvent = { operationId: string; action: string; state: ActionState; at: string; errorCode?: ErrorCode };
export type OperationRecord = { legacyPlan?: { monthlySavingFen: number; targetAmountFen: number | null; deadline: string | null }; operationId: string; action: "transfer_money" | CardAction | ScenarioAction | WealthAction | "legacy.create-plan"; fingerprint: string; state: ActionState; request?: ActionRequest; preview?: ActionPreview; decision?: UserDecision; receipt?: ActionReceipt; risk?: RiskResult; verification?: VerificationState; error?: ActionError };
