# Gift Purchase Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User approved the design on 2026-10-24; proceed without another approval gate.

**Goal:** Deliver the approved budget-reservation, guided/browse selection and precisely confirmed shopping workflow, preserving the separate real-platform acceptance gate.
**Architecture:** A validates a single purchase intent; Scenario owns the workflow and budget; Commerce owns catalog/quote/order HTTP calls. PostgreSQL persists ownership, reservations, operations and due jobs; a worker generates confirmation tasks, never unconfirmed orders.
**Tech Stack:** Existing Node ESM, Next/React, PostgreSQL, node:test. No new framework.
**Spec:** ../specs/2026-10-24-gift-scenario-design.md and ../../Gift-Purchase-Actions.md

## Global Constraints
- Money is integer CNY minor units; budget reservation never changes bank balance.
- Keep existing suggest_only Scenario behavior and PR27 independent.
- Two selectable modes: guided and browse. Exact per-merchant confirmation, no inherited budget authorization.
- Model cannot invent IDs, URLs, prices, execution steps or confirmations; addresses stay outside model history.
- Mock HTTP is independently queryable and marked synthetic_demo_only; real platform integration remains incomplete until credentials and actual receipts exist.
- All state changes owner-bound, versioned, persistent; unknown orders retain allocation.

## Review Focus
- Task 1: reject prototype/unknown fields, floating amounts and fake confirmations.
- Task 2: changing SKU/fees, duplicate keys and lost response must not create a second order.
- Task 3: concurrent budgets and paid-but-not-bank-reconciled orders must not double allocate or double deduct.
- Task 4: cross-user references and replayed/expired confirmation tokens must fail before HTTP calls.
- Task 5: mode switching, ambiguous dates and unavailable allergens must preserve user choices and truthfulness.

### Task 1: Purchase contracts
Files: schemas/purchase-actions.schema.json; src/skills/scenario/purchase-contract.mjs; tests/purchase-contract.test.mjs.
Interface: validatePurchaseAction(action,input) returns a defensive validated copy or throws VALIDATION_ERROR. Export purchaseActions for registered trusted UI/internal commands; only scenario.plan_purchase is model-facing.
- [ ] Write table tests rejecting unknown action/fields, float amounts, fabricated risk/confirmation fields; allow partial draft and validate exact trusted execute fields.
- [ ] Run node --test tests/purchase-contract.test.mjs; expected missing module failure.
- [ ] Implement strict validators and matching schemas; explicit nested fields, bounds, category uniqueness, timing semantics.
- [ ] Same test command passes; commit contract, docs and tests.

### Task 2: Independent Commerce Mock HTTP
Files: server/commerce/mock-service.mjs; src/skills/commerce/commerce-client.mjs; tests/commerce-http.test.mjs; tests/fixtures/commerce/gift-catalog.json.
Interface: createCommerceMockServer({now,faults}) returns Node HTTP Server; createCommerceClient({baseUrl,fetchImpl}) exposes search, quote, execute and status. Explicit trusted base URL; no user URL fetching. Mock server binds loopback by default.
- [ ] Write HTTP tests for two categories, pagination, hard exclusions, total fees, quote expiry/change, identical idempotent replay/conflicting body, accepted-then-lost-response lookup.
- [ ] Run node --test tests/commerce-http.test.mjs; expect missing implementation.
- [ ] Implement using node:http and fetch; catalog >=6 items/category, two merchants, per-order truthful payment state. Quote IDs and order keys server-issued; service clone state per test.
- [ ] Same tests pass; commit.

### Task 3: Persistent purchase state and budgets
Files: migrations/006_purchase_workflows.sql (verify next unused migration number before writing); src/skills/scenario/purchase-store.mjs; tests/purchase-store.test.mjs.
Interface: createPurchaseStore(sql) exposes owner-bound transaction(callback); transaction offers workflow/reservation/operation/job reads and CAS writes. Test adapter uses isolated cloned state; production requires PostgreSQL.
- [ ] Test simultaneous 700+700 reservations against 1000 available, owner isolation, failed/unknown/paid allocation transitions, cancellation and bank reconciliation.
- [ ] Run store tests RED; implement database transactions and unique operation/event constraints; run GREEN against isolated PostgreSQL when available, never report skipped DB verification as passed.
- [ ] Commit implementation and migrations.

### Task 4: Purchase workflow, sessions and scheduling
Files: src/skills/scenario/purchase-skill.mjs; server/purchase-api.mjs; server/purchase-worker.mjs; src/app/api/purchase/route.ts; tests/purchase-workflow.test.mjs; tests/purchase-http.test.mjs.
Interfaces: handlePurchaseRequest(Request,dependencies) returns Response; createPurchaseSkill({store,commerce,financialContext,now}) dispatches validated actions. Worker runDuePurchases({store,now}) returns persisted due events, not orders.
- [ ] Tests: budget approval causes zero bank mutation; execute requires owner/action/version/hash/expiry-bound confirmation; stale prices cause zero orders; double clicks/worker restarts preserve one operation; unknown stays occupied; partial failure keeps both receipts; missing DB/worker capability never reports scheduled.
- [ ] Run RED, implement persistent state transitions and server session owner; no IP identity, no model owner fields. Address and tokens excluded from logs/model inputs.
- [ ] Run GREEN including real local HTTP Mock calls and restart/concurrency checks; commit.

### Task 5: Natural language and two UI paths
Files: server/banking-intent-parser.mjs; server/trueforge-banking-runtime.mjs; src/agent/parsed-intent.ts; src/agent/validate-parsed-intent.mjs; server/banking-orchestrator.mjs; src/components/PurchaseFlow.tsx; src/lib/purchase-client.ts; src/app/page.tsx; tests/purchase-conversation.test.mjs; tests/purchase-ui.test.cjs.
Interface: registered scenario.plan_purchase slots route to purchase draft; PurchaseFlow consumes API envelopes. Reuse existing model gateway without tools.
- [ ] Tests: birthday request routes once, unrelated multiple actions still clarify; absolute date/year/order-vs-delivery clarification; corrections retained; guided/browse switching retains selections; pagination never fabricates candidates; links are verified Mock detail pages or approved provider links.
- [ ] Run RED; implement both entry points, private delivery form, business status labels, per-merchant preview/confirmation and pending payment/unknown/partial failure cards.
- [ ] Run GREEN; browser verify both paths with captured HTTP receipts; commit.

### Task 6: Deployment, teaching and end-to-end verification
Files: scripts/dev-commerce.mjs; scripts/purchase-worker.mjs; docs/Gift-Purchase-Verification.md; deployment config as needed; personal teaching document outside repo.
- [ ] Add runnable Mock service/worker commands and environment capability checks; test disabled services fail explicitly.
- [ ] Exercise full 1000-yuan flowers+cake flow via UI, HTTP and DB, including response loss and restart. Run npm test, npm run typecheck and build; record exact pass/skip/failure counts.
- [ ] Fresh whole-branch reviewer checks spec coverage. Resolve substantive findings with regression tests.
- [ ] Provide PR-ready deliverables and personal teaching; keep real-platform and live LLM/worker verification gaps explicit if credentials/deployment absent. Do not claim complete real purchasing.

## Execution ledger
- Baseline: latest origin/main fetched; 13 existing Scenario/Commerce tests passed. New branch codex/gift-purchase-20261024 in existing isolated worktree.
- Ruling: proceed inline after explicit design approval; no redundant plan-approval question. Goal's real-platform gate remains unchanged.

- Implementation record 2026-10-26: contracts, independent HTTP provider, PostgreSQL adapter, budget state, exact confirmation, API/session recovery, worker heartbeat, both UI paths and natural-language registration implemented. Mock provider file restart test passed.
- Verification: full suite 421 tests /410 pass/11 skip/0 fail; targeted ESLint and production Webpack build passed. PostgreSQL integration skipped without dedicated test URL. Browser verified both modes, paging/retained choices, two orders (315+415), occupied730/free270 and reload recovery; test host used model stub and memory store, not a live-model/DB proof.
- Ruling: reuse existing static-export API adapters (Netlify/local/container), rather than adding a Next POST route incompatible with output:export. Synthetic catalog lives in server/commerce/gift-catalog.mjs and is defensively cloned per provider.
- Ruling: one PostgreSQL owner row serializes atomic workflow state rather than separate tables; bounded Demo throughput tradeoff, bank ledger untouched. Mock provider uses optional single-process atomic file persistence, not a real platform adapter.
- Ruling: recovery credentials preserve dormant Demo owners across seven-day cookie expiry; real authenticated identity remains a live-platform gate.
- Final review: fresh independent reviewer; fixed HTTPS origin/cookie handling, hard allergen normalization, recovery after expiry, order-vs-delivery windows and merchant disclosure with regression tests. No deferred minor findings were reported.
- Pending: new mainline integration, actual PostgreSQL/Docker deployment, live LLM and deployed-worker proof, real-platform credentials/receipts. Do not mark the full goal achieved.

- Mainline integration: verified exact official tree for main938f4d8 via source archive; resolved package/page/hook conflicts preserving conversation recovery and OTP. New main full-suite baseline has31 failures; integrated branch reproduces exactly the same31 failure names, no added failures. Purchase-specific38 tests:37pass/1DBskip/0fail. This is not a green full-project baseline.
- Ruling: publish only tested feature-file deltas through GitHub tree/commit API with official main parent, since Git transport resets. Do not push local snapshot-import history.

- Final mainline build gate: baseline938f4d8 and feature integration both fail at the same existing client import of node:crypto from banking-core/verification.mjs. No B code modified. Draft-only delivery until mainline build and baseline failures are resolved. Targeted lint and typecheck pass.
