import postgres from 'postgres';
import { getConfiguredBankingCore } from '../../src/banking-core/postgres-store.mjs';
import { createInMemoryScenarioStore } from '../../src/skills/scenario/scenario-skill.mjs';
import { registerExistingSkills } from './adapters.mjs';
import { InMemoryAgentRunRepository, PostgresAgentRunRepository } from './repository.mjs';
import { AgentOrchestrator } from './orchestrator.mjs';
import { createAgentApi } from './api.mjs';
import { randomUUID } from 'node:crypto';

let configured;
export async function handleUnifiedAgent(request) {
  // Liveness must not initialize a database or any Skill.
  if (new URL(request.url).pathname === '/health' && request.method === 'GET') return Response.json({ request_id: randomUUID(), run_id: null, state: null, data: { status: 'alive' }, error: null });
  try {
    configured ??= (async () => {
      const env = process.env;
      if (!env.DATABASE_URL && (env.NODE_ENV === 'production' || env.NETLIFY) && env.ALLOW_EPHEMERAL_BANKING !== 'true') throw new Error('persistence required');
      const core = await getConfiguredBankingCore(env);
      const repository = env.DATABASE_URL ? new PostgresAgentRunRepository(postgres(env.DATABASE_URL, { max: 3, connect_timeout: 5 })) : new InMemoryAgentRunRepository();
      // No invented trusted events. Existing scenario.review_event fails closed until a trusted event store is provided.
      const registry = registerExistingSkills(core.repository, createInMemoryScenarioStore());
      const orchestrator = new AgentOrchestrator({ registry, repository });
      return createAgentApi({ orchestrator, registry, repository, env });
    })();
    return await (await configured)(request);
  } catch {
    configured = undefined;
    return Response.json({ request_id: randomUUID(), run_id: null, state: null, data: null, error: { code: 'NOT_READY', message: 'NOT_READY' } }, { status: 503 });
  }
}
