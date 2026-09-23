// skill/transfer/prepare_transfer.ts
import type {
  FinancialContextRepository,
  PrepareTransferInput,
  PrepareTransferResult,
} from "./types";

/**
 * 组装转账预览数据：仅查询转出账户余额并计算预估转账后余额。
 * 不改账户、不扣款、不计算风险（risk_level 由上层 Risk 引擎负责）、不执行真实转账。
 *
 * 转出账户在此处做唯一解析：若账户不存在，返回 needs_clarification，不抛异常。
 *
 * @param repository 金融上下文底座（只读），用于查询转出账户余额
 * @param input      已唯一解析的转出账户 ID、收款人 ID 与金额
 */
export async function prepareTransfer(
  repository: FinancialContextRepository,
  input: PrepareTransferInput
): Promise<PrepareTransferResult> {
  const account = (await repository.queryAccount(input.source_account_id)) ?? null;
  if (!account) {
    return {
      status: "needs_clarification",
      clarification: {
        reason: "source_account_not_found",
        slot: "source_account_ref",
        question: `转出账户 ${input.source_account_id} 不存在，请确认。`,
      },
    };
  }

  return {
    status: "ready",
    preview: {
      source_account_id: account.id,
      payee_id: input.payee_id,
      amount_minor: input.amount.amount_minor,
      currency: input.amount.currency,
      available_balance_minor: account.availableBalanceFen,
      estimated_balance_after_minor: account.availableBalanceFen - input.amount.amount_minor,
    },
  };
}
