'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PurchaseFlow } from '../../components/PurchaseFlow';
export default function ShoppingPage() {
  const [access, setAccess] = useState(''), [consent, setConsent] = useState(false);
  return <main style={{ maxWidth: 820, margin: '24px auto', padding: 16 }}><Link href="/">返回 SaveFlow</Link><h1>购物联动</h1>
    <label>演示访问码<input type="password" autoComplete="off" value={access} onChange={e => setAccess(e.target.value)} maxLength={128} /></label>
    <p><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />同意将购物目标和选品偏好发送至已配置模型，并使用模拟数据演示。配送信息仅进入服务端购物流程。</label></p>
    <PurchaseFlow accessCode={access} consent={consent} /></main>;
}
