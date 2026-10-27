import { handlePurchaseRequest } from '../../server/purchase-api.mjs';
const purchase = request => handlePurchaseRequest(request);
export default purchase;
export const config = { path: '/api/purchase', rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
