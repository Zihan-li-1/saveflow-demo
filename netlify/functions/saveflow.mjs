import { handleBanking } from '../../server/banking.mjs';
const saveflow = request => handleBanking(request);
export default saveflow;
export const config = { path: '/api/saveflow', rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
