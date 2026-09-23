// @ts-check
/** Shared with the existing UI. Unknown outcomes allow ONLY a status query. */
export const writeOutcomeTransitions = Object.freeze({
  executing: Object.freeze({ SUCCEEDED: 'succeeded', FAILED: 'failed', UNCERTAIN: 'unknown' }),
  unknown: Object.freeze({ CHECK: 'checking' }),
  checking: Object.freeze({ SUCCEEDED: 'succeeded', FAILED: 'failed', UNCERTAIN: 'unknown' }),
});
/** @type {Readonly<Record<string, Readonly<Record<string, import('./contracts').ActionState>>>>} */
export const actionTransitions = Object.freeze({
  preparing: Object.freeze({ PREPARED: 'risk_check', FAILED: 'failed' }),
  risk_check: Object.freeze({ PREVIEWED: 'awaiting_confirmation', FAILED: 'failed' }),
  awaiting_confirmation: Object.freeze({ CONFIRM: 'confirmed', CANCEL: 'cancelled', FAILED: 'failed' }),
  confirmed: Object.freeze({ EXECUTE: 'executing', CANCEL: 'cancelled', FAILED: 'failed' }),
  ...writeOutcomeTransitions,
});
/** @param {import('./contracts').ActionState} state @param {string} event */
export function transitionAction(state, event) { return actionTransitions[state]?.[event] ?? state; }
/** @param {import('./contracts').ActionState} state @param {string} event */
export function canTransitionAction(state, event) { return actionTransitions[state]?.[event] !== undefined; }
