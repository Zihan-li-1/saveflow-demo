// skill/transfer/repository-adapter.ts
import type {
  Account as BankingAccount,
  FinancialContextRepository as BankingRepository,
} from "../../banking-core/contracts";
import type {
  Account,
  FinancialContextRepository as TransferRepository,
  Payee,
  SlotSelections,
} from "./types";

function normalize(value: string): string {
  return value.trim().replace(/^模拟/, "").replace(/账户$/, "");
}

async function findAccount(
  repository: BankingRepository,
  reference: string,
): Promise<BankingAccount | undefined> {
  const query = reference.trim();
  const normalized = normalize(query);
  return (await repository.getAccounts()).find((account) => {
    const name = normalize(account.name);
    return account.id === query || account.name === query || name === normalized ||
      (normalized === "活期" && account.type === "checking") ||
      (normalized === "储蓄" && account.type === "saving");
  });
}

/**
 * 把共享只读底座（B 的 getAccounts/getPayees）适配成 D 的查询接口
 * （queryAccount/queryPayeesByName）。
 *
 * selections 用于澄清续接时复用用户已选定的实体（按 entity_id 直取），
 * 避免重新按名字匹配而再次撞上重名歧义——与 runtime.mjs 的 transferRepository 行为一致。
 */
export function createTransferRepositoryAdapter(
  repository: BankingRepository,
  selections: SlotSelections = {},
): TransferRepository {
  return {
    async queryAccount(reference: string): Promise<Account | null> {
      const selected = selections.source_account_ref;
      if (selected?.entityId) {
        const account = await repository.getAccount(selected.entityId);
        if (!account || account.status !== "active") return null;
        return { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen };
      }
      const account = await findAccount(repository, reference);
      if (!account) return null;
      return { id: account.id, currency: account.currency, availableBalanceFen: account.availableBalanceFen };
    },
    async queryPayeesByName(name: string): Promise<Payee[]> {
      const query = name.trim();
      const selected = selections.payee_ref;
      if (selected?.entityId) {
        const payee = await repository.getPayee(selected.entityId);
        if (!payee || payee.status !== "active") return [];
        return [{ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }];
      }
      return (await repository.getPayees())
        .filter((payee) => payee.status === "active" && (payee.name === query || payee.aliases.includes(query)))
        .map((payee) => ({ id: payee.id, name: payee.name, aliases: [...payee.aliases], accountNoMasked: payee.accountNoMasked }));
    },
  };
}
