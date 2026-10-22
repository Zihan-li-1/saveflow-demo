/** Synthetic, single-user demo data. It is never an investment account or a live assessment. */
export function createWealthMockPorts({ getHoldings, now = Date.now }) {
  const assessment = {
    assessment_id: 'risk_demo_001', risk_level: 'R2', assessment_scope: 'investment',
    completed_at: '2026-10-01T00:00:00+08:00', expires_at: '2027-01-01T00:00:00+08:00', source: 'trusted_ui',
  };
  const rules = {
    product_001: { subscription_enabled: true, redemption_enabled: true, settlement: 'T+0' },
    product_002: { subscription_enabled: true, redemption_enabled: true, settlement: 'T+1' },
    product_003: { subscription_enabled: true, redemption_enabled: true, settlement: 'AT_MATURITY' },
  };
  return Object.freeze({
    now: () => new Date(now()).toISOString(),
    questionnaire: { source: 'trusted_ui', route: '/wealth/risk-assessment' },
    getRiskAssessment: async () => structuredClone(assessment),
    getDisclosure: async productId => rules[productId] ? {
      product_id: productId, status: 'active', version: '2026-10-01',
      expires_at: '2027-01-01T00:00:00+08:00',
      risk_disclosure: 'Synthetic demo only. Principal and displayed yield are not guaranteed.',
    } : undefined,
    getOperationRule: async productId => structuredClone(rules[productId]),
    getHoldings: async () => structuredClone(await getHoldings()),
  });
}
