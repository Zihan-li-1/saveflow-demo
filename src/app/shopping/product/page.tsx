'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { purchaseValueLabel } from '../../../lib/purchase-guidance.mjs';
import { giftCatalog } from '../../../../server/commerce/gift-catalog.mjs';
function Product() {
  const ref = useSearchParams().get('ref'); const p = giftCatalog.find(item => item.product_ref === ref);
  return <main style={{ maxWidth: 640, margin: '40px auto', padding: 24 }}><Link href="/shopping/">返回购物规划</Link><h1>模拟商品详情</h1>
    <p>此页用于演示，无真实商家、库存或交易能力。最终金额与配送条件以模拟服务的最新报价为准。</p>
    {p ? <><h2>{p.name}</h2><p>样例标价 ¥{(p.price_minor / 100).toFixed(2)}；配送费 ¥{(p.delivery_fee_minor / 100).toFixed(2)}</p><p>规格：{p.sku_ref}</p><p>模拟商户 {p.merchant_ref}</p><p>{p.allergens_known ? `已知原料：${purchaseValueLabel(p.ingredients) || '不适用'}` : '过敏原信息未知，不能认定安全'}</p><p>支持的模拟区域：上海。</p></> : <p>找不到此模拟商品。</p>}</main>;
}
export default function ProductPage() { return <Suspense fallback={<p>载入详情……</p>}><Product /></Suspense>; }
