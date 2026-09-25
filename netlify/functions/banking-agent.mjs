import { handleBankingAgent } from '../../server/banking-agent.mjs';

const bankingAgent = request => handleBankingAgent(request);
export default bankingAgent;
export const config = {
  path: '/api/banking-agent',
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
