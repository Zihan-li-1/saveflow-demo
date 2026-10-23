# Verified Savings Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a goal amount and deadline into a verified, evidence-labelled savings card with Chinese action labels and optional read-only Wealth follow-up.

**Architecture:** Keep `orchestrator.goal` as the route. A deterministic planner validates recent user-provided category data and calculates the target; a separate server-side LLM call proposes grounded category budgets, then the planner verifies its output before the UI renders. Missing data uses the existing signed continuation flow.

**Tech Stack:** Node 22 ESM, Next.js/React/TypeScript, built-in `node:test`, existing Qwen compatible API. No new dependencies or savings Skill.

**Spec:** `docs/superpowers/specs/2026-10-22-savings-plan-design.md`

## Global Constraints

- Money is safe integer fen, currency CNY. Calendar uses Asia/Shanghai and next full-month starts.
- A new goal never inherits `getSavingGoal()` progress or assumes account balance is already saved.
- Recent complete-month data and goal saved amount are required; old 2026-06 to 2026-08 Mock is historical context only.
- LLM self-review is required but never substitutes for independent server verification.
- No new Skill, investment purchase, bank write, shopping action, or dependency.

## Review Focus

1. Deadline before the next month start: no fabricated monthly installment (Task 1 test).
2. User input says one month while data labels another: reject stale/wrong-month input (Task 1 test).
3. Model invents a category or lowers fixed rent without evidence: reject (Task 2 test).
4. Model suggestion exceeds income after required saving: show a gap without false feasibility (Task 2 test).
5. Replayed/foreign continuation with `planInputs`: reject instead of combining with a different goal (Task 3 test).

---

### Task 1: Deterministic savings calculation

**Files:** Create `src/agent/savings-plan.mjs`; test `tests/savings-plan.test.mjs`.

**Interfaces:** `validatePlanInputs(value, { currentDate, categories })` returns normalized recent month, saved amount, income and category amounts or throws a coded input error. `calculateSavingsGoal({ targetAmountMinor, deadline, savedAmountMinor, incomeMinor, categoryExpensesMinor, currentDate })` returns required monthly amount, opportunity dates, observed surplus and gap in integer fen.

- [ ] Write tests for Oct 22 to Dec 31 → Nov 1 and Dec 1, ¥10,000/2 = ¥5,000; partial savings, achieved target, cross-year, zero opportunities, wrong latest month, negative/unsafe/floating amounts.
- [ ] Run `node --test tests/savings-plan.test.mjs` and confirm red.
- [ ] Implement only validation and arithmetic; no model or UI logic.
- [ ] Run the focused test and confirm green; commit the task.

### Task 2: Grounded LLM advice and independent review

**Files:** Create `server/savings-advisor.mjs`; test `tests/savings-advisor.test.mjs`.

**Interfaces:** `requestSavingsAdvice(facts, { env, fetchImpl, signal })` returns parsed JSON from Qwen with `observations`, `category_budgets`, `caveats`, `self_review`; `verifySavingsAdvice(advice, facts)` returns normalized verified advice or throws a coded format/evidence error. Reuse existing server-only Qwen settings pattern.

- [ ] Write tests with injected fake upstream for valid advice, failed self-review, invented evidence, unknown/duplicate categories, fixed-expense cuts, malformed fen, arithmetic disagreement and over-income infeasibility.
- [ ] Confirm red, then implement bounded JSON prompt and verifier. The model cannot set target math or execution status.
- [ ] Confirm green; commit the task.

### Task 3: Goal conversation and missing-input continuation

**Files:** Modify `src/agent/runtime.mjs`, `server/banking-orchestrator.mjs`, `src/agent/clarification/continuation-token.mjs` only if its contract requires it; test `tests/e-agent.test.mjs` and new `tests/savings-conversation.test.mjs`.

**Interfaces:** Missing inputs return `status: needs_plan_inputs` with a signed continuation bound to `orchestrator.goal`; continuation accepts only `planInputs` with `month`, `saved_amount_minor`, `income_minor`, `category_expenses_minor`. Valid submissions produce `status: goal_plan` with `data.verification_status: verified`, deterministic math, reviewed advice, source/as-of evidence and `execution_allowed: false`.

- [ ] Test initial goal requires input form, no card; valid continuation; foreign/expired token; unregistered fields; malformed category input; model outage; resulting verified card shape.
- [ ] Confirm red; implement request validation and reuse signed continuation without trusting model/entity IDs or persisted Mock mutation.
- [ ] Confirm green; commit the task.

### Task 4: Chinese card and data form

**Files:** Modify `src/lib/banking-agent-client.ts`, `src/lib/use-saveflow.ts`, `src/app/BankingReadCards.tsx`, `src/app/page.tsx`, existing card CSS as needed; test `tests/banking-savings-client.test.cjs` with the repository's `react-test-renderer` pattern.

**Interfaces:** Client handles `needs_plan_inputs` with a form, submits `planInputs` + token, and renders only verified `goal_plan`. All visible step action labels map to Chinese; internal action strings remain unchanged. Plan card shows objective, dates, monthly math, category actual/proposed, evidence and gap.

- [ ] Test response validation rejects unverified/mismatched amounts and action codes no longer render as user-facing titles.
- [ ] Confirm red; implement accessible form and responsive card with source/assumption labels.
- [ ] Confirm green; commit the task.

### Task 5: End-to-end acceptance and Wealth handoff

**Files:** Extend `tests/savings-conversation.test.mjs` and `tests/banking-savings-client.test.cjs`; modify `package.json` test script to include all new test files; change only the existing goal/wealth route when necessary.

**Interfaces:** Explicit user request/click for read-only product screening enters existing `wealth.recommend` clarification path; goal plan itself never subscribes or automatically recommends a product.

- [ ] Test natural-language goal → missing-input form → valid submission → model advice review → verified card; bad model yields no card; Wealth follow-up asks for risk, horizon and liquidity before read-only screening.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; inspect the rendered card at desktop and mobile widths.
- [ ] Review diff against spec, then commit and prepare a PR without merging main.

