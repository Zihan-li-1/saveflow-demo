import { validCalendarDate } from '../lib/calendar.mjs';

function invalid(code, message) { return Object.assign(new Error(message), { code }); }
function minor(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_00; }

export function validateSavedAmount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).join(',') !== 'saved_amount_minor' || !minor(value.saved_amount_minor)) throw invalid('PLAN_INPUT_INVALID', '请填写本目标已存金额');
  return value.saved_amount_minor;
}

export function validatePlanInputs(value, { currentDate, categories }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'category_expenses_minor,income_minor,month,saved_amount_minor' ||
    !validCalendarDate(currentDate) || !Array.isArray(categories) || !categories.length) throw invalid('PLAN_INPUT_INVALID', '储蓄计划输入不完整');
  const previous = new Date(Date.UTC(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  if (value.month !== previous || !minor(value.saved_amount_minor) || !minor(value.income_minor)) throw invalid('PLAN_INPUT_INVALID', '需填写最近完整月及有效金额');
  const expenses = value.category_expenses_minor;
  if (!expenses || typeof expenses !== 'object' || Array.isArray(expenses) ||
    Object.keys(expenses).length !== categories.length ||
    Object.keys(expenses).some(key => !categories.includes(key) || !minor(expenses[key]))) throw invalid('PLAN_INPUT_INVALID', '分类支出必须逐项填写整数分');
  return { month: value.month, savedAmountMinor: value.saved_amount_minor, incomeMinor: value.income_minor, categoryExpensesMinor: structuredClone(expenses) };
}

export function calculateSavingsGoal({ targetAmountMinor, deadline, savedAmountMinor, incomeMinor, categoryExpensesMinor, currentDate }) {
  if (!minor(targetAmountMinor) || targetAmountMinor === 0 || !minor(savedAmountMinor) || !minor(incomeMinor) ||
    !validCalendarDate(currentDate) || !validCalendarDate(deadline) || deadline < currentDate ||
    !categoryExpensesMinor || Object.values(categoryExpensesMinor).some(value => !minor(value))) throw invalid('PLAN_INPUT_INVALID', '储蓄目标或金额无效');
  const opportunityDates = [];
  const first = new Date(Date.UTC(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)), 1));
  for (let month = new Date(first); month.toISOString().slice(0, 10) <= deadline && opportunityDates.length <= 120; month.setUTCMonth(month.getUTCMonth() + 1)) opportunityDates.push(month.toISOString().slice(0, 10));
  const remaining = Math.max(0, targetAmountMinor - savedAmountMinor);
  if (remaining > 0 && (!opportunityDates.length || opportunityDates.length > 120)) throw invalid('DEADLINE_TOO_SOON', '截止日前没有可安排的完整月');
  const expense = Object.values(categoryExpensesMinor).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(expense)) throw invalid('PLAN_INPUT_INVALID', '分类支出合计超出范围');
  const required = remaining ? Math.ceil(remaining / opportunityDates.length) : 0;
  const surplus = incomeMinor - expense;
  return { target_amount_minor: targetAmountMinor, saved_amount_minor: savedAmountMinor, remaining_minor: remaining,
    deadline, opportunity_dates: opportunityDates, required_monthly_minor: required,
    observed_income_minor: incomeMinor, observed_expense_minor: expense, observed_surplus_minor: surplus,
    monthly_gap_minor: Math.max(0, required - surplus) };
}

