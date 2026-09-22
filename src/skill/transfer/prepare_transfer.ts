// skill/transfer/prepare_transfer.ts
import {
  TransferSkillError,
  type FinancialContextRepository,
  type PrepareTransferInput,
  type RiskCheck,
  type TransferPrepareResult,
  type TransferPrepareStatus,
} from "./types";

/**
 * 转账预览预演算。
 *
 * 只计算预估转账后的可用余额，绝不修改、变更任何真实账户数据，不做扣款。
 * 调用外部 riskCheck 做风险校验；余额不足时在结果中标记风险状态。
 *
 * @param repository 金融上下文底座（B 同学提供），用于查询转出账户余额
 * @param riskCheck  外部风险校验函数（B 同学 Banking Core）
 * @param input      转出账户、收款人、金额（分）与币种
 */
export async function prepareTransfer(
  repository: FinancialContextRepository,
  riskCheck: RiskCheck,
  input: PrepareTransferInput
): Promise<TransferPrepareResult> {
  const { sourceAccountId, payeeId, amountFen, currency } = input;

  if (!sourceAccountId || !payeeId) {
    throw new TransferSkillError("INVALID_INPUT", "转出账户与收款人 ID 不能为空。");
  }
  // 金额强制规则：必须为大于 0 的整数分，严禁浮点数。
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new TransferSkillError("INVALID_AMOUNT", "转账金额必须为大于 0 的整数分（fen），严禁浮点数。");
  }

  const account = await repository.queryAccount(sourceAccountId);
  if (!account) {
    throw new TransferSkillError("ACCOUNT_NOT_FOUND", `转出账户 ${sourceAccountId} 不存在。`);
  }

  const availableBalanceFen = account.availableBalanceFen;
  // 预演算：仅计算预估结果，不写回任何账户数据。
  const estimatedBalanceAfterFen = availableBalanceFen - amountFen;

  const risk = await riskCheck({ sourceAccountId, payeeId, amountFen, currency });

  const warnings: string[] = [];
  let status: TransferPrepareStatus;
  let canExecute: boolean;

  if (estimatedBalanceAfterFen < 0) {
    // 余额不足：标记风险状态，禁止执行。
    status = "insufficient-balance";
    canExecute = false;
    warnings.push(
      `余额不足：可用余额 ${availableBalanceFen} 分，不足以支付 ${amountFen} 分，本次未扣款。`
    );
  } else if (!risk.passed) {
    status = "risk-rejected";
    canExecute = false;
    warnings.push(
      ...(risk.reasons && risk.reasons.length > 0 ? risk.reasons : ["外部风险校验未通过。"])
    );
  } else {
    status = "ready";
    canExecute = true;
  }

  return {
    status,
    sourceAccountId,
    payeeId,
    amountFen,
    currency,
    availableBalanceFen,
    estimatedBalanceAfterFen,
    risk,
    canExecute,
    warnings,
  };
}
