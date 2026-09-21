import { handleAgent } from '../../server/qwen.mjs';

const agent = request => handleAgent(request);
export default agent;
export const config = {
  path: '/api/agent',
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
