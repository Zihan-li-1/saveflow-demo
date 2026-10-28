/* eslint-disable @typescript-eslint/no-require-imports -- CJS loader compiles the actual TS contract without a new dependency. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ParsedIntentValidationError,
  isParsedIntent,
  validateParsedIntent,
} = require('../src/agent/validate-parsed-intent.ts');

const base = (action, slots, missingSlots, status) => ({
  schemaVersion: '1.0.0', action, slots, missingSlots, status,
});

test('accepts transfer.create with raw references and integer minor units', () => {
  const intent = base('transfer.create', {
    payee_ref: '张三',
    amount: { amount_minor: 50000, currency: 'CNY' },
    source_account_ref: '活期账户',
  }, [], 'ready_for_resolution');

  assert.equal(validateParsedIntent(intent), intent);
  assert.equal(intent.slots.amount.amount_minor, 50000);
  assert.equal(isParsedIntent(intent), true);
});

test('requires clarification when transfer amount is absent and never invents a value', () => {
  const intent = base('transfer.create', {
    payee_ref: '张三',
    source_account_ref: '活期账户',
  }, ['amount'], 'needs_clarification');

  assert.equal(validateParsedIntent(intent), intent);
  assert.equal('amount' in intent.slots, false);
  assert.throws(
    () => validateParsedIntent({ ...intent, missingSlots: [], status: 'ready_for_resolution' }),
    ParsedIntentValidationError,
  );
});

test('requires clarification when source account is absent', () => {
  const intent = base('transfer.create', {
    payee_ref: '张三',
    amount: { amount_minor: 50000, currency: 'CNY' },
  }, ['source_account_ref'], 'needs_clarification');

  assert.doesNotThrow(() => validateParsedIntent(intent));
});

test('ambiguous transfer direction requires an explicit transfer_type and validates its value', () => {
  const ambiguous = base('transfer.create', { amount: { amount_minor: 10000, currency: 'CNY' } }, ['transfer_type', 'source_account_ref'], 'needs_clarification');
  assert.doesNotThrow(() => validateParsedIntent(ambiguous));
  assert.throws(() => validateParsedIntent(base('transfer.create', { transfer_type: 'maybe', amount: { amount_minor: 10000, currency: 'CNY' } }, ['source_account_ref', 'payee_ref'], 'needs_clarification')), ParsedIntentValidationError);
  assert.throws(() => validateParsedIntent(base('transfer.create', { transfer_type: 'internal', target_account_ref: '储蓄', payee_ref: '张三', amount: { amount_minor: 10000, currency: 'CNY' } }, ['source_account_ref'], 'needs_clarification')), ParsedIntentValidationError);
});

test('accepts missingSlots regardless of array order and rejects duplicates', () => {
  assert.doesNotThrow(() => validateParsedIntent(
    base('transfer.create', { payee_ref: '张三' }, ['source_account_ref', 'amount'], 'needs_clarification'),
  ));
  assert.throws(() => validateParsedIntent(
    base('transfer.create', { payee_ref: '张三' }, ['amount', 'amount'], 'needs_clarification'),
  ), ParsedIntentValidationError);
});

test('accepts bill.summary for a valid month without requiring an account', () => {
  const intent = base('bill.summary', { month: '2026-08' }, [], 'ready_for_resolution');
  assert.equal(validateParsedIntent(intent), intent);
});

test('subscription.list is a ready read-only intent with no model slots', () => {
  const intent = base('subscription.list', {}, [], 'ready_for_resolution');
  assert.equal(validateParsedIntent(intent), intent);
  assert.throws(() => validateParsedIntent(base('subscription.list', { subscription_ref: '视频会员' }, [], 'ready_for_resolution')), ParsedIntentValidationError);
  assert.throws(() => validateParsedIntent(base('subscription.list', {}, ['subscription_ref'], 'needs_clarification')), ParsedIntentValidationError);
});

test('subscription writes require a subscription and renew also requires a source account', () => {
  const cancel = base('subscription.cancel_renewal', { subscription_ref: '模拟视频会员' }, [], 'ready_for_resolution');
  assert.equal(validateParsedIntent(cancel), cancel);
  const renew = base('subscription.renew', { subscription_ref: '模拟视频会员' }, ['source_account_ref'], 'needs_clarification');
  assert.equal(validateParsedIntent(renew), renew);
  assert.throws(() => validateParsedIntent(base('subscription.renew', { subscription_ref: '模拟视频会员' }, [], 'ready_for_resolution')), ParsedIntentValidationError);
});

test('accepts an exact bill period and rejects conflicting or oversized periods', () => {
  const period = { start_date: '2026-07-01', end_date: '2026-12-31', timezone: 'Asia/Shanghai', label: '2026年下半年' };
  assert.doesNotThrow(() => validateParsedIntent(base('bill.summary', { period }, [], 'ready_for_resolution')));
  assert.throws(() => validateParsedIntent(base('bill.summary', { month: '2026-08', period }, [], 'ready_for_resolution')), ParsedIntentValidationError);
  assert.throws(() => validateParsedIntent(base('bill.summary', { period: { ...period, end_date: '2027-07-02' } }, [], 'ready_for_resolution')), ParsedIntentValidationError);
});

test('rejects account entity IDs from the model', () => {
  assert.throws(() => validateParsedIntent(
    base('bill.summary', { month: '2026-08', accountId: 'ACC-CHECKING' }, [], 'ready_for_resolution'),
  ), ParsedIntentValidationError);
});

test('ambiguous input can only produce canonical clarify or unsupported intents', () => {
  assert.doesNotThrow(() => validateParsedIntent(
    base('clarify', {}, ['action'], 'needs_clarification'),
  ));
  assert.doesNotThrow(() => validateParsedIntent(
    base('unsupported', {}, [], 'unsupported'),
  ));
  assert.throws(() => validateParsedIntent(
    base('transfer.create', {}, [], 'ready_for_resolution'),
  ), ParsedIntentValidationError);
});

test('rejects model-injected tool, confirmation, risk, operation and entity fields', () => {
  const valid = base('transfer.create', {
    payee_ref: '张三',
    amount: { amount_minor: 50000, currency: 'CNY' },
    source_account_ref: '活期账户',
  }, [], 'ready_for_resolution');

  for (const field of ['tool', 'confirmed', 'riskLevel', 'operationId', 'result', 'taskId', 'conversationId', 'verifiedSlots', 'preview', 'coreState', 'executionState']) {
    assert.throws(() => validateParsedIntent({ ...valid, [field]: true }), ParsedIntentValidationError);
  }
  for (const field of ['payee_id', 'entity_id', 'source_account_id']) {
    assert.throws(() => validateParsedIntent({
      ...valid,
      slots: { ...valid.slots, [field]: 'server-id' },
    }), ParsedIntentValidationError);
  }
  assert.throws(() => validateParsedIntent({
    ...valid,
    slots: { ...valid.slots, payee_ref: 'payee_001' },
  }), ParsedIntentValidationError);
  assert.throws(() => validateParsedIntent({
    ...valid,
    slots: { ...valid.slots, source_account_ref: 'ACC-CHECKING' },
  }), ParsedIntentValidationError);
});

test('rejects unsafe amounts, unsupported currency, invalid actions and extra nested fields', () => {
  const withAmount = (amount) => base('transfer.create', {
    payee_ref: '张三', amount, source_account_ref: '活期账户',
  }, [], 'ready_for_resolution');

  for (const amount_minor of [500.5, 0, -1, '50000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateParsedIntent(withAmount({ amount_minor, currency: 'CNY' })),
      ParsedIntentValidationError,
    );
  }
  assert.throws(
    () => validateParsedIntent(withAmount({ amount_minor: 50000, currency: 'USD' })),
    ParsedIntentValidationError,
  );
  assert.throws(
    () => validateParsedIntent(withAmount({ amount_minor: 50000, currency: 'CNY', confirmed: true })),
    ParsedIntentValidationError,
  );
  assert.throws(
    () => validateParsedIntent(base('card.freeze', {}, [], 'ready_for_resolution')),
    ParsedIntentValidationError,
  );
});

test('enforces bill month format and status derived from required slots', () => {
  for (const month of ['2026-8', '2026-00', '2026-13', 202608]) {
    assert.throws(
      () => validateParsedIntent(base('bill.summary', { month }, [], 'ready_for_resolution')),
      ParsedIntentValidationError,
    );
  }
  assert.doesNotThrow(() => validateParsedIntent(
    base('bill.summary', {}, ['month'], 'needs_clarification'),
  ));
  assert.throws(() => validateParsedIntent(
    base('bill.summary', {}, ['month'], 'ready_for_resolution'),
  ), ParsedIntentValidationError);
});

test('E actions enforce required wealth, scenario and goal slots', () => {
  assert.equal(validateParsedIntent(base('wealth.compare', { product_refs: ['产品A', '产品B'] }, [], 'ready_for_resolution')).action, 'wealth.compare');
  assert.equal(validateParsedIntent(base('scenario.disable_rule', { rule_ref: 'rule_001' }, [], 'ready_for_resolution')).action, 'scenario.disable_rule');
  assert.equal(validateParsedIntent(base('orchestrator.goal', { goal_text: '看看财务情况' }, [], 'ready_for_resolution')).action, 'orchestrator.goal');
  assert.throws(() => validateParsedIntent(base('wealth.compare', { product_refs: ['产品A'] }, [], 'ready_for_resolution')), ParsedIntentValidationError);
  assert.throws(() => validateParsedIntent(base('scenario.create_rule', {}, [], 'ready_for_resolution')), ParsedIntentValidationError);
});
