import nextEnv from '@next/env';
import { TrueForge } from '@truefoundry/trueforge-sdk';
nextEnv.loadEnvConfig(process.cwd(), true);
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL, token: process.env.TRUEFORGE_TOKEN || undefined, maxRetries: 0, timeoutInSeconds: 5 });
await client.settings.mcpServers.createOrUpdate({ manifest: { type: 'remote', name: 'saveflow-token-bridge', description: 'Local SaveFlow existing MCP tools with opaque credential aliases; preview only.', url: 'http://127.0.0.1:3334/mcp' } });
console.log('Configured local connector saveflow-token-bridge; existing connectors and Agents unchanged.');
