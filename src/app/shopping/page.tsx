'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PurchaseFlow } from '../../components/PurchaseFlow';
export default function ShoppingPage() {
  const [access, setAccess] = useState(''), [consent, setConsent] = useState(false);
  return <main style={{ maxWidth: 820, margin: '24px auto', padding: 16 }}><Link href="/">返回 SaveFlow</Link><h1>购物联动</h1>
    <label>演示访问码<input type="password" autoComplete="off" value={access} onChange={e => setAccess(e.target.value)} maxLength={128} /></label>
    <p><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />同意在使用模型理解目标时发送我输入的完整描述和已有购物草案信息，并保存模拟购物预算。不要填写电话、地址或恢复码；商品由我自行在平台下单。</label></p>
    <PurchaseFlow accessCode={access} consent={consent} /></main>;
}
