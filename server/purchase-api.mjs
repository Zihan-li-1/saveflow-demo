import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createPurchaseStore } from '../src/skills/scenario/purchase-store.mjs';
import { createPurchaseSkill } from '../src/skills/scenario/purchase-skill.mjs';
import { createCommerceClient } from '../src/skills/commerce/commerce-client.mjs';
import { validateParsedIntent } from '../src/agent/validate-parsed-intent.mjs';
import { parseTrueforgeBankingIntent } from './trueforge-banking-runtime.mjs';
import { parseBankingIntent } from './banking-intent-parser.mjs';
import { getConfiguredBankingCore } from '../src/banking-core/postgres-store.mjs';
import { purchaseFinancialContext } from './purchase-financial-context.mjs';
import { nextPurchaseQuestion } from '../src/lib/purchase-guidance.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const ref = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const helperSchemas = {
  'purchase.list': z.strictObject({}),
  'purchase.session.backup': z.strictObject({}),
  'purchase.session.recover': z.strictObject({ recovery_code: z.string().min(40).max(256) }),
  'purchase.read': z.strictObject({ workflow_ref: ref }),
  'purchase.understand': z.strictObject({ message: z.string().trim().min(1).max(1000), workflow_ref: ref.optional(), expected_version: version.optional() }),
  'purchase.draft.update': z.strictObject({ workflow_ref: ref, expected_version: version, slots: z.record(z.string(), z.unknown()) }),
  'purchase.plan_preview': z.strictObject({ workflow_ref: ref, expected_version: version, manual_finance: z.strictObject({ available_minor: z.number().int().min(0).max(1e9), obligations_minor: z.number().int().min(0).max(1e9) }).optional() }),
  'purchase.cancel_preview': z.strictObject({ workflow_ref: ref, expected_version: version }),
  'purchase.address': z.strictObject({ workflow_ref: ref, expected_version: version, address: z.unknown() }),
};
const messages = { PERSISTENCE_UNAVAILABLE: '购物流程数据库未配置，尚未保存预约。', SCHEDULER_UNAVAILABLE: '后台预约服务未运行，尚未安排任务。',
  PLATFORM_NOT_CONNECTED: '购物模拟服务未连接。', FINANCIAL_DATA_REQUIRED: '缺少近期余额和待付义务，请在表单补充用于预算规划的数据。',
  DATE_AMBIGUOUS: '请填写明确日期和开始、结束时间，并选择下单日或送达日。', DATE_IN_PAST: '请选择未来日期。',
  CONFIRMATION_INVALID: '确认凭据无效，请重新核对预览。', PREVIEW_STALE: '内容已变化，请刷新报价并重新确认。', PREVIEW_EXPIRED: '确认窗口已过期，请刷新报价。',
  VERSION_CONFLICT: '流程已有更新，请刷新后继续。', BUDGET_EXCEEDED: '商品和全部费用超过剩余预算，请重新选择。',
  INSUFFICIENT_PLANNING_BALANCE: '可规划余额不足，已考虑其他预留和待付义务。', ORDER_EXISTS: '该品类已有订单，请先查询原订单状态。',
  OUTSIDE_ORDER_WINDOW: '尚未到约定下单时间，或已错过窗口。', SESSION_INVALID: '购物会话已失效，请重新进入。', MISSING_SLOTS: '请补齐预算、账户、日期和品类。' };
let configured;
export async function configuredPurchaseSkill({ env = process.env, now = Date.now } = {}) {
  if (!env.DATABASE_URL) fail('PERSISTENCE_UNAVAILABLE');
  if (!configured || configured.url !== env.DATABASE_URL) {
    const { default: postgres } = await import('postgres');
    const sql = postgres(env.DATABASE_URL, { max: 4, connect_timeout: 5, idle_timeout: 20 });
    configured = { url: env.DATABASE_URL, store: createPurchaseStore(sql) };
  }
  const store = configured.store;
  const heartbeat = await store.transaction('purchase_worker_system', state => state.events.heartbeat);
  const schedulerEnabled = env.PURCHASE_WORKER_ENABLED === 'true' && heartbeat?.at > now() - 120000;
  const commerce = env.COMMERCE_MOCK_URL && env.COMMERCE_MOCK_TOKEN ? createCommerceClient({ baseUrl: env.COMMERCE_MOCK_URL, token: env.COMMERCE_MOCK_TOKEN }) : undefined;
  return createPurchaseSkill({ store, commerce, schedulerEnabled, now,
    financialContext: async (_owner, rawAccount) => purchaseFinancialContext((await getConfiguredBankingCore(env)).repository, rawAccount) });
}
function sessionCookie(owner, secret, now, origin) {
  const value = `${owner}.${now + 7 * 86400000}`, signature = createHmac('sha256', secret).update(value).digest('base64url');
  return `saveflow_purchase=${value}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
}
function recoveryCode(owner, secret) { return `${owner}.${createHmac('sha256', secret).update(`purchase-recovery/v1:${owner}`).digest('base64url')}`; }
function session(request, secret, now, origin) {
  const existing = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('saveflow_purchase='))?.slice(18);
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  if (existing) {
    const [id, expires, signature, extra] = existing.split('.');
    if (extra || !/^[\w-]{36}$/.test(id ?? '') || !/^\d{13}$/.test(expires ?? '') || !signature || Number(expires) <= now || !equal(sign(`${id}.${expires}`), signature)) fail('SESSION_INVALID');
    return { owner: id, cookie: sessionCookie(id, secret, now, origin) };
  }
  const id = randomUUID();
  return { owner: id, cookie: sessionCookie(id, secret, now, origin) };
}
async function readBody(request) {
  const reader = request.body?.getReader(); if (!reader) fail('VALIDATION_ERROR');
  const chunks = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 16384) { await reader.cancel(); fail('REQUEST_TOO_LARGE'); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('VALIDATION_ERROR'); }
}
export async function handlePurchaseRequest(request, options = {}) {
  const { env = process.env, now = Date.now, getSkill = configuredPurchaseSkill } = options;
  const requestId = randomUUID(); let cookie;
  const reply = (status, code, data) => Response.json({ code, requestId, message: code === 'OK' ? '购物流程已更新' : messages[code] ?? '请求未完成，请核对输入或刷新流程。',
    ...(data ? { data } : {}) }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  try {
    if (request.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED');
    if (!env.SAVEFLOW_ACCESS_CODE || env.SAVEFLOW_ACCESS_CODE.length < 16 || !env.CONTINUATION_TOKEN_SECRET || env.CONTINUATION_TOKEN_SECRET.length < 32) return reply(503, 'ACCESS_NOT_CONFIGURED');
    if (!equal(request.headers.get('x-saveflow-access') ?? '', env.SAVEFLOW_ACCESS_CODE)) return reply(401, 'UNAUTHORIZED');
    const publicOrigin = new URL(env.SAVEFLOW_PUBLIC_ORIGIN || request.url).origin;
    if (request.headers.get('origin') !== publicOrigin) return reply(403, 'FORBIDDEN');
    const body = await readBody(request);
    if (body?.consent !== true) return reply(403, 'CONSENT_REQUIRED');
    if (!body || Object.keys(body).some(k => !['action', 'input', 'consent'].includes(k)) || typeof body.action !== 'string') fail('VALIDATION_ERROR');
    if (body.action === 'purchase.session.recover') {
      const input = helperSchemas[body.action].safeParse(body.input); if (!input.success) fail('SESSION_INVALID');
      const [owner] = input.data.recovery_code.split('.');
      if (!/^[\w-]{36}$/.test(owner ?? '') || !equal(recoveryCode(owner, env.CONTINUATION_TOKEN_SECRET), input.data.recovery_code)) fail('SESSION_INVALID');
      cookie = sessionCookie(owner, env.CONTINUATION_TOKEN_SECRET, now(), publicOrigin);
      return reply(200, 'OK', { recovered: true, synthetic_demo_only: true, execution_environment: 'mock' });
    }
    const current = session(request, env.CONTINUATION_TOKEN_SECRET, now(), publicOrigin); cookie = current.cookie;
    if (body.action === 'purchase.session.backup') {
      if (!helperSchemas[body.action].safeParse(body.input).success) fail('VALIDATION_ERROR');
      return reply(200, 'OK', { recovery_code: recoveryCode(current.owner, env.CONTINUATION_TOKEN_SECRET), synthetic_demo_only: true, execution_environment: 'mock' });
    }
    const skill = await getSkill({ env, now }); let data;
    if (Object.hasOwn(helperSchemas, body.action)) {
      const parsed = helperSchemas[body.action].safeParse(body.input); if (!parsed.success) fail('VALIDATION_ERROR'); const input = parsed.data;
      if (body.action === 'purchase.read') data = await skill.read(current.owner, input.workflow_ref);
      if (body.action === 'purchase.list') data = await skill.list(current.owner);
      if (body.action === 'purchase.plan_preview') data = await skill.previewPlan(current.owner, input.workflow_ref, input.expected_version, input.manual_finance);
      if (body.action === 'purchase.cancel_preview') data = await skill.previewCancel(current.owner, input.workflow_ref, input.expected_version);
      if (body.action === 'purchase.address') data = await skill.saveAddress(current.owner, input.workflow_ref, input.expected_version, input.address);
      if (body.action === 'purchase.draft.update') data = await skill.reviseDraft(current.owner, input.workflow_ref, input.expected_version, input.slots);
      if (body.action === 'purchase.understand') {
        const wf = input.workflow_ref ? await skill.read(current.owner, input.workflow_ref) : undefined;
        if (wf && wf.version !== input.expected_version) fail('VERSION_CONFLICT');
        const parseIntent = options.parseIntent ?? (env.SAVEFLOW_BANKING_RUNTIME === 'legacy-qwen' ? parseBankingIntent : parseTrueforgeBankingIntent);
        // Only business slots are sent: never address objects, order previews,
        // confirmation credentials, account balances or browser history.
        const intent = validateParsedIntent(await parseIntent(input.message, { env, now, history: [],
          context: wf ? { action: 'scenario.plan_purchase', slots: wf.slots, pendingSlot: 'preferences', question: nextPurchaseQuestion(wf.slots) } : undefined }));
        if (intent.action !== 'scenario.plan_purchase') fail('PURCHASE_INTENT_REQUIRED');
        if (!wf) data = await skill.perform(current.owner, intent.action, intent.slots);
        else if (wf.status === 'draft') data = await skill.reviseDraft(current.owner, wf.workflow_ref, wf.version, { ...wf.slots, ...intent.slots,
          ...(intent.slots.preferences ? { preferences: { ...wf.slots.preferences, ...intent.slots.preferences } } : {}) });
        else {
          for (const key of ['budget', 'budget_month', 'funding_account_ref', 'date_expression', 'date_meaning', 'items']) {
            if (intent.slots[key] !== undefined && JSON.stringify(intent.slots[key]) !== JSON.stringify(wf.slots[key])) fail('PLAN_REVIEW_REQUIRED');
          }
          data = await skill.perform(current.owner, 'scenario.purchase.update', { workflow_ref: wf.workflow_ref, expected_version: wf.version,
            changes: { ...(intent.slots.preferences ? { preferences: intent.slots.preferences } : {}), ...(intent.slots.selection_mode ? { selection_mode: intent.slots.selection_mode } : {}) } });
        }
      }
    } else data = await skill.perform(current.owner, body.action, body.input);
    return reply(200, 'OK', data);
  } catch (error) {
    const code = error.code ?? 'PURCHASE_UNAVAILABLE';
    return reply(['PERSISTENCE_UNAVAILABLE', 'SCHEDULER_UNAVAILABLE', 'PURCHASE_UNAVAILABLE', 'ACCESS_NOT_CONFIGURED'].includes(code) ? 503 : code === 'SESSION_INVALID' ? 401 : 400, code);
  }
}
