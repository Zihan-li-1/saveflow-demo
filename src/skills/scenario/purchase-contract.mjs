import { z } from 'zod';

// Syntax validation is not authorization: callers must resolve every reference
// within the authenticated owner's workflow before using it.
const text = (max = 128) => z.string().trim().min(1).max(max);
const ref = text().regex(/^[a-zA-Z0-9_-]+$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const money = z.strictObject({ amount_minor: z.number().int().min(1).max(1_000_000_000), currency: z.literal('CNY') });
const mode = z.enum(['guided', 'browse']);
const category = z.enum(['flowers', 'cake']);
const list = z.array(text(80)).max(20);
const preferences = z.strictObject({
  flower_colors: list.optional(), flower_materials: list.optional(), flower_exclusions: list.optional(),
  scent_preference: z.enum(['none', 'light', 'any']).optional(), cake_flavors: list.optional(),
  cake_servings: z.number().int().min(1).max(100).optional(), ingredient_exclusions: list.optional(),
  occasion: text(160).optional(), style: text(160).optional(),
});
export const purchasePreferencesSchema = preferences;
const window = z.strictObject({
  starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), timezone: z.literal('Asia/Shanghai'),
}).refine(value => Date.parse(value.starts_at) < Date.parse(value.ends_at), '送达窗口结束必须晚于开始');
const quantity = z.number().int().min(1).max(10);
const confirmation = { plan_preview_ref: ref, plan_confirmation_token: text(2048) };
const schemas = {
  'scenario.plan_purchase': z.strictObject({
    budget: money.optional(), budget_month: text(7).regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    funding_account_ref: text(128).optional(), date_expression: text(256).optional(),
    date_meaning: z.enum(['order_on', 'deliver_on']).optional(),
    items: z.array(z.strictObject({ category, quantity })).min(1).max(2)
      .refine(items => new Set(items.map(item => item.category)).size === items.length, '品类不能重复').optional(),
    selection_mode: mode.optional(), preferences: preferences.optional(),
  }),
  'scenario.purchase.save': z.strictObject({ draft_ref: ref, expected_version: version, ...confirmation }),
  'scenario.purchase.update': z.strictObject({
    workflow_ref: ref, expected_version: version,
    changes: z.strictObject({ selection_mode: mode.optional(), preferences: preferences.optional(),
      selected_candidate_refs: z.array(ref).max(2).refine(items => new Set(items).size === items.length).optional(), address_ref: ref.optional(),
    }).refine(value => Object.keys(value).length > 0, '修改不能为空'),
  }),
  'commerce.search': z.strictObject({ workflow_ref: ref, category, preferences, delivery_region_ref: ref,
    delivery_window: window.optional(), remaining_budget: money, cursor: text(256).optional() }),
  'commerce.quote': z.strictObject({ workflow_ref: ref, expected_version: version,
    selections: z.array(z.strictObject({ candidate_ref: ref, sku_ref: ref, quantity })).min(1).max(2),
    address_ref: ref, delivery_window: window }),
  'commerce.order.prepare': z.strictObject({ workflow_ref: ref, expected_version: version, quote_ref: ref }),
  'commerce.order.execute': z.strictObject({ operation_ref: ref, preview_hash: text(128), confirmation_token: text(2048) }),
  'commerce.order.status': z.strictObject({ operation_ref: ref }),
  'scenario.purchase.cancel': z.strictObject({ workflow_ref: ref, expected_version: version, ...confirmation }),
};
const publicSchemas = {
  'scenario.plan_purchase': schemas['scenario.plan_purchase'],
  'scenario.purchase.save': schemas['scenario.purchase.save'],
  'scenario.purchase.update': z.strictObject({ workflow_ref: ref, expected_version: version,
    changes: z.strictObject({ selection_mode: mode.optional(), preferences: preferences.optional() })
      .refine(value => Object.keys(value).length > 0, '修改不能为空') }),
  'scenario.purchase.cancel': schemas['scenario.purchase.cancel'],
};
export const purchaseActions = Object.freeze(Object.keys(publicSchemas));

export function validatePurchaseAction(action, input) {
  const result = Object.hasOwn(schemas, action) ? schemas[action].safeParse(input) : null;
  if (!result?.success) throw Object.assign(new Error('购物动作字段缺失、格式错误或包含未注册字段'), { code: 'VALIDATION_ERROR' });
  return result.data;
}

export function purchaseJsonSchema() {
  const schema = z.toJSONSchema(z.discriminatedUnion('action', Object.entries(publicSchemas).map(([action, input]) =>
    z.strictObject({ action: z.literal(action), input }))));
  schema.title = 'Public shopping budget actions';
  schema.$comment = 'Legacy Commerce Mock actions are intentionally absent. Runtime also enforces ownership, trusted-clock freshness, budget and confirmation validity.';
  return schema;
}
