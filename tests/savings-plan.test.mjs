import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSavingsGoal, validatePlanInputs, validateSavedAmount } from '../src/agent/savings-plan.mjs';

const categories = ['房租', '餐饮', '交通', '通信', '日用品', '娱乐', '购物', '订阅', '其他'];
const expenses = { 房租: 300000, 餐饮: 145000, 交通: 40000, 通信: 10000, 日用品: 50000, 娱乐: 112000, 购物: 128000, 订阅: 9000, 其他: 52000 };

test('goal math uses only future full-month starts and integer fen', () => {
  const input = validatePlanInputs({ month: '2026-09', saved_amount_minor: 0, income_minor: 1200000, category_expenses_minor: expenses }, { currentDate: '2026-10-22', categories });
  const plan = calculateSavingsGoal({ targetAmountMinor: 1000000, deadline: '2026-12-31', ...input, currentDate: '2026-10-22' });
  assert.deepEqual(plan.opportunity_dates, ['2026-11-01', '2026-12-01']);
  assert.equal(plan.required_monthly_minor, 500000);
  assert.equal(plan.observed_expense_minor, 846000);
  assert.equal(plan.observed_surplus_minor, 354000);
  assert.equal(plan.monthly_gap_minor, 146000);
});

test('goal math respects saved amount and rejects a deadline with no future monthly opportunity', () => {
  const input = validatePlanInputs({ month: '2026-09', saved_amount_minor: 200000, income_minor: 1200000, category_expenses_minor: expenses }, { currentDate: '2026-10-22', categories });
  assert.equal(calculateSavingsGoal({ targetAmountMinor: 1000000, deadline: '2026-12-31', ...input, currentDate: '2026-10-22' }).required_monthly_minor, 400000);
  assert.throws(() => calculateSavingsGoal({ targetAmountMinor: 1000000, deadline: '2026-10-31', ...input, currentDate: '2026-10-22' }), { code: 'DEADLINE_TOO_SOON' });
  const achieved = calculateSavingsGoal({ targetAmountMinor: 1000000, deadline: '2026-10-31', ...input, savedAmountMinor: 1000000, currentDate: '2026-10-22' });
  assert.deepEqual(achieved.opportunity_dates, []);
  assert.equal(achieved.required_monthly_minor, 0);
});

test('recent month and exact category money are required', () => {
  const base = { month: '2026-09', saved_amount_minor: 0, income_minor: 1200000, category_expenses_minor: expenses };
  assert.throws(() => validatePlanInputs({ ...base, month: '2026-08' }, { currentDate: '2026-10-22', categories }), { code: 'PLAN_INPUT_INVALID' });
  assert.throws(() => validatePlanInputs({ ...base, category_expenses_minor: { ...expenses, 购物: 12.5 } }, { currentDate: '2026-10-22', categories }), { code: 'PLAN_INPUT_INVALID' });
  assert.throws(() => validatePlanInputs({ ...base, category_expenses_minor: { ...expenses, 游戏: 100 } }, { currentDate: '2026-10-22', categories }), { code: 'PLAN_INPUT_INVALID' });
});

test('trusted recent month accepts only this goal’s saved amount from the user', () => {
  assert.equal(validateSavedAmount({ saved_amount_minor: 250000 }), 250000);
  assert.throws(() => validateSavedAmount({ saved_amount_minor: 250000, income_minor: 1 }), { code: 'PLAN_INPUT_INVALID' });
  assert.throws(() => validateSavedAmount({ saved_amount_minor: 1.5 }), { code: 'PLAN_INPUT_INVALID' });
});

