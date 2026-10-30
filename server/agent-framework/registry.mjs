import { fail } from './models.mjs';

export class SkillRegistry {
  #adapters = new Map();
  register(adapter) { if (this.#adapters.has(adapter.name)) fail('DUPLICATE_REQUEST'); this.#adapters.set(adapter.name, adapter); return this; }
  get(name) { const adapter = this.#adapters.get(name); if (!adapter) fail('SKILL_NOT_FOUND'); return adapter; }
  list() { return [...this.#adapters.values()].map(adapter => adapter.definition()); }
  schema(name) { const { input_schema, output_schema } = this.get(name).definition(); return { input_schema, output_schema }; }
  async health() { return Promise.all([...this.#adapters.values()].map(async adapter => ({ name: adapter.name, ...await adapter.health_check() })) ); }
}
