/** This base URL is server configuration, never a user/model supplied URL. */
export function createCommerceClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 5000 }) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid commerce base URL');
  if (typeof token !== 'string' || token.length < 16) throw new Error('Missing commerce credential');
  const request = async (path, input, write = false) => {
    let response;
    try {
      response = await fetchImpl(new URL(path, url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw Object.assign(new Error(write ? '订单结果待核实，请查单' : '购物服务暂不可用'), { code: write ? 'ORDER_STATUS_UNKNOWN' : 'PLATFORM_UNAVAILABLE' });
    }
    let data;
    try { data = await response.json(); } catch { throw Object.assign(new Error('无法核实购物服务响应'), { code: write ? 'ORDER_STATUS_UNKNOWN' : 'PLATFORM_UNAVAILABLE' }); }
    if (!response.ok) throw Object.assign(new Error('购物服务拒绝请求'), { code: data.code ?? 'PLATFORM_UNAVAILABLE' });
    if (data?.synthetic_demo_only !== true || data.execution_environment !== 'mock') throw Object.assign(new Error('未配置真实购物平台适配器'), { code: write ? 'ORDER_STATUS_UNKNOWN' : 'CAPABILITY_UNAVAILABLE' });
    return data;
  };
  return Object.freeze({ search: input => request('/search', input), quote: input => request('/quote', input),
    execute: input => request('/orders', input, true), status: input => request('/orders/status', input) });
}
