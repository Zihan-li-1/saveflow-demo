import { savingsFailureDiagnostic } from './savings-advice-contract.mjs';

const UUID = /^[0-9a-f-]{36}$/i;

export function createAgentDiagnostics(env = process.env, requestId, sink = console.warn) {
  const enabled = env.SAVEFLOW_AGENT_DIAGNOSTICS === 'true';
  const emit = (event, fields = {}) => {
    const supplied = event && typeof event === 'object' ? event : { event, ...fields };
    const savingsReview = supplied.event === 'savings_advice_review';
    if (!enabled && !savingsReview) return;
    // Savings review remains traceable with general debugging off. Use only static labels.
    const safe = savingsReview ? { event: 'savings_advice_review', ...(supplied.code === 'OK' && supplied.reason === 'checks_passed'
      ? { stage: 'complete', code: 'OK', reason: 'checks_passed' }
      : savingsFailureDiagnostic({ code: supplied.code, savingsReview: { reason: supplied.reason } })) } : supplied;
    const entry = { ...safe, ...(UUID.test(requestId || '') ? { requestId } : {}) };
    try { sink(JSON.stringify(entry)); } catch { /* diagnostics must never affect business handling */ }
  };
  return { enabled, emit };
}

export function diagnosticCategory(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'ADVICE_REVIEW_FAILED') return 'advice_review';
  if (/TIMEOUT/.test(code)) return 'timeout';
  if (/AUTH|CONFIG/.test(code)) return 'auth_or_config';
  if (/FORMAT|VALIDATION/.test(code)) return 'format_or_validation';
  if (/UPSTREAM|UNAVAILABLE|RATE_LIMIT/.test(code)) return 'upstream';
  if (/CONVERSATION|CONTINUATION/.test(code)) return 'conversation';
  return code || 'unknown';
}
