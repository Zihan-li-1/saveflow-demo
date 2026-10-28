import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/banking-agent/route.ts';

test('local App Router Banking Agent route is a live POST handler', async () => {
  const response = await POST(new Request('http://localhost:3000/api/banking-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '查询2026年8月账单', history: [], consent: true }),
  }));
  assert.notEqual(response.status, 404);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const payload = await response.json();
  assert.equal(typeof payload.code, 'string');
  assert.equal(typeof payload.requestId, 'string');
});
