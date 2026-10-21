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

  for (const field of ['tool', 'confirmed', 'riskLevel', 'operationId', 'result']) {
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
