// Dedicated local connectors; existing sv-trial/saveflow-token-bridge stay intact.
import nextEnv from '@next/env';
import { TrueForge } from '@truefoundry/trueforge-sdk';
nextEnv.loadEnvConfig(process.cwd(), true);
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL, token: process.env.TRUEFORGE_TOKEN || undefined, maxRetries: 0, timeoutInSeconds: 5 });
for (const [name, port] of [['saveflow-docker-mcp', 4333], ['saveflow-docker-bridge', 4334]]) {
  await client.settings.mcpServers.createOrUpdate({ manifest: { type: 'remote', name, description: 'Local Docker SaveFlow synthetic query/preview test.', url: `http://127.0.0.1:${port}/mcp` } });
  console.log(`Configured local Docker connector: ${name}`);
}
