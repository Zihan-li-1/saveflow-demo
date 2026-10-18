// Explicit local test fixture only. Does not modify the seed file or call Core.execute.
import seed from '../src/data/saveflow_mock_data.json' with { type: 'json' };
import { createBankingCore } from '../src/banking-core/core.mjs';
import { startTrialMcpServer } from '../server/mcp/saveflow-trial.mjs';
const source = structuredClone(seed);
source.datasetId += '-frozen-test';
source.cards.find(c => c.id === 'CARD-ENT').status = 'frozen';
const core = createBankingCore({ source });
const server = startTrialMcpServer({ core, repository: core.repository });
server.on('listening', () => console.log('ISOLATED FROZEN TEST FIXTURE MCP on 127.0.0.1:3333; original seed unchanged.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
