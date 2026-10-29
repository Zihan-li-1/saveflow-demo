const UUID = /^[0-9a-f-]{36}$/i;

export function createAgentDiagnostics(env = process.env, requestId, sink = console.warn) {
  const enabled = env.SAVEFLOW_AGENT_DIAGNOSTICS === 'true';
  const emit = (event, fields = {}) => {
    if (!enabled) return;
    const supplied = event && typeof event === 'object' ? event : { event, ...fields };
    const entry = { ...supplied, ...(UUID.test(requestId || '') ? { requestId } : {}) };
    try { sink(JSON.stringify(entry)); } catch { /* diagnostics must never affect business handling */ }
  };
  return { enabled, emit };
}

export function diagnosticCategory(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/TIMEOUT/.test(code)) return 'timeout';
  if (/AUTH|CONFIG/.test(code)) return 'auth_or_config';
  if (/FORMAT|VALIDATION/.test(code)) return 'format_or_validation';
  if (/UPSTREAM|UNAVAILABLE|RATE_LIMIT/.test(code)) return 'upstream';
  if (/CONVERSATION|CONTINUATION/.test(code)) return 'conversation';
  return code || 'unknown';
}
