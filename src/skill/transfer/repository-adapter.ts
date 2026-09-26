import type {
  Account as BankingAccount,
  FinancialContextRepository as BankingRepository,
} from "../../banking-core/contracts";
import type {
  Account,
  FinancialContextRepository as TransferRepository,
  Payee,
} from "./types";

function normalize(value: string): string {
  return value.trim().replace(/^模拟/, "").replace(/账户$/, "");
}

async function findAccount(repository: BankingRepository, reference: string): Promise<BankingAccount | undefined> {
  const query = reference.trim();
  const normalized = normalize(query);
  return (await repository.getAccounts()).find((account) => {
    const name = normalize(account.name);
    return account.id === query || account.name === query || name === normalized ||
      (normalized === "活期" && account.type === "checking") ||
      (normalized === "储蓄" && account.type === "saving");
  });
}

/** Adapts the shared read repository to D's query-only FinancialContextRepository. */
export function createTransferRepositoryAdapter(
  repository: BankingRepository,
): TransferRepository {
  return {
    async queryAccount(reference: string): Promise<Account | null> {
      const account = await findAccount(repository, reference);
      if (!account) return null;
      return {
        id: account.id,
        currency: account.currency,
        availableBalanceFen: account.availableBalanceFen,
      };
    },
    async queryPayeesByName(name: string): Promise<Payee[]> {
      const query = name.trim();
      return (await repository.getPayees())
        .filter((payee) => payee.status === "active" && (payee.name === query || payee.aliases.includes(query)))
        .map((payee) => ({ id: payee.id, name: payee.name, aliases: [...payee.aliases] }));
    },
  };
}
