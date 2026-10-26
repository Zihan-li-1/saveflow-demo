import { createCommerceMockServer } from '../server/commerce/mock-service.mjs';
const server = createCommerceMockServer({ token: process.env.COMMERCE_MOCK_TOKEN, stateFile: process.env.COMMERCE_MOCK_STATE_FILE || '.commerce-mock/state.json' });
const port = Number(process.env.COMMERCE_MOCK_PORT || 4401);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid COMMERCE_MOCK_PORT');
server.listen(port, process.env.COMMERCE_MOCK_HOST || '127.0.0.1', () => console.info(`Synthetic Commerce service listening on port ${port}; no real purchases`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
