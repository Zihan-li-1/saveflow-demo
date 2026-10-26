// Explicit low-balance fixture for insufficient-funds and legacy receipt tests.
// Keep these scenarios independent of the funded interactive demo accounts.
import seed from '../../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore } from '../../src/banking-core/core.mjs';
import { createFinancialContext } from '../../src/banking-core/repository.mjs';

export function lowBalanceSource() {
  const source = structuredClone(seed);
  source.accounts.find(account => account.id === 'ACC-CHECKING').availableBalance = 5000;
  source.accounts.find(account => account.id === 'ACC-SAVINGS').availableBalance = 0;
  return source;
}
export function createLowBalanceCore(options = {}) {
  return createBankingCore({ source: lowBalanceSource(), ...options });
}
export function createLowBalanceFinancialContext() {
  return createFinancialContext(lowBalanceSource());
}
