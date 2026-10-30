import { fail } from './models.mjs';

export const TRANSITIONS = Object.freeze({
  CREATED: ['UNDERSTANDING', 'CANCELLED'],
  UNDERSTANDING: ['COLLECTING_INPUT', 'PLANNING', 'FAILED', 'CANCELLED'],
  COLLECTING_INPUT: ['PLANNING', 'CANCELLED'],
  PLANNING: ['READY_TO_EXECUTE', 'COLLECTING_INPUT', 'FAILED', 'CANCELLED'],
  READY_TO_EXECUTE: ['WAITING_CONFIRMATION', 'EXECUTING', 'CANCELLED'],
  WAITING_CONFIRMATION: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['AGGREGATING', 'COLLECTING_INPUT', 'FAILED', 'CANCELLED'],
  AGGREGATING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [], FAILED: [], CANCELLED: [],
});
export class AgentStateMachine {
  constructor(logger = event => console.info(JSON.stringify(event))) { this.logger = logger; }
  transition(run, next) {
    if (!TRANSITIONS[run.state]?.includes(next)) fail('INVALID_STATE_TRANSITION');
    const at = new Date().toISOString();
    const event = { event: 'agent_state_changed', run_id: run.run_id, at, version: run.version + 1, from: run.state, to: next };
    run.state = next; run.updated_at = at; run.audit.push(event);
    this.logger(event);
  }
}
