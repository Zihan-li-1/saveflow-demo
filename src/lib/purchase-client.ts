export type PurchaseSlots = {
  budget?: { amount_minor: number; currency: 'CNY' }; budget_month?: string; funding_account_ref?: string;
  date_expression?: string; date_meaning?: 'order_on' | 'deliver_on'; selection_mode?: 'guided' | 'browse';
  items?: Array<{ category: 'flowers' | 'cake'; quantity: number }>; preferences?: Record<string, unknown>;
};
export type PurchaseOrder = { operation_ref: string; status: string; amount_minor: number; category?: string };
export type PurchaseWorkflow = {
  workflow_ref: string; version: number; status: string; slots: PurchaseSlots; address_ref?: string;
  selected_candidate_refs?: string[]; orders: PurchaseOrder[];
  selected_candidates?: PurchaseCandidate[];
  reservation?: { total_minor: number; unallocated_minor: number; occupied_minor: number; consumed_minor: number; released_minor: number };
  pending_tasks?: Array<{ event_ref: string; status: string }>;
  financial_basis?: FinancialBasis;
};
export type PurchaseCandidate = { candidate_ref: string; sku_ref: string; product_ref: string; category: 'flowers' | 'cake'; name: string;
  price_minor: number; delivery_fee_minor: number; packaging_fee_minor: number; allergens_known: boolean; ingredients: string[]; canonical_url: string };
export type FinancialBasis = { source: string; as_of: string; available_minor: number; obligations_minor: number; repository_as_of?: string };
export type PlanPreview = { plan_preview_ref: string; plan_confirmation_token: string; preview?: { slots: PurchaseSlots; context: FinancialBasis; reminder_due_at: string }; notice: string };
export type PurchaseBudgetCheck = { coverage_status: 'enough' | 'shortfall'; required_minor: number; available_for_plan_minor: number;
  shortfall_minor: number; source: 'user_provided'; financial_as_of: string; reservation_unchanged: true; bank_balance_changed: false };

export async function purchaseRequest<T>(action: string, input: unknown, accessCode: string, consent: boolean): Promise<T> {
  if (!consent) throw new Error('请先勾选本次演示和模型使用同意项。');
  let response: Response;
  try { response = await fetch('/api/purchase', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Saveflow-Access': accessCode },
    body: JSON.stringify({ action, input, consent }), signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('购物预算服务连接失败，请稍后重试。'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('无法核实购物预算服务响应，请刷新后查询原预算。'); }
  if (!response.ok || body?.code !== 'OK') throw new Error(body?.message || '购物请求未完成。');
  if (!body.data || body.data.synthetic_demo_only !== true || body.data.execution_environment !== 'mock') throw new Error('购物响应环境无法核实。');
  return body.data as T;
}
export const orderStatusText: Record<string, string> = { executing: '提交中，请查询原订单', unknown: '结果待核实', created_pending_payment: '已创建，待支付',
  accepted: '商家已接单，付款状态待核实', paid: '平台已确认付款', fulfilling: '配送准备中', delivered: '已送达', failed: '下单失败', cancelled: '已取消' };
export const yuan = (minor: number) => `¥${(minor / 100).toFixed(2)}`;
export function inputMinor(value: string): number {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) throw new Error('金额请填写最多两位小数的非负数字。');
  const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
