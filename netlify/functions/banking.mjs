import { handleBanking } from '../../server/banking.mjs';
const banking = request => handleBanking(request);
export default banking;
export const config = { path: '/api/banking', rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
