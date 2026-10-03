# Tasks: Docket Scheduling Engine — Accounts, Posts, Posting Slots, Provider Framework and the Scheduler Tick

**Input**: Design documents from `/specs/002-scheduling-engine/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/{providers,services,scheduler,dal,env}.md, quickstart.md

**Tests**: REQUESTED. The spec input carries a required test list (10 categories) and the success criteria SC-001…SC-013 are measured by tests. Test tasks are included, written against real Postgres with 001's harness (`tests/helpers/db.ts`, `factories.ts`, `scope-check.ts`). Pure modules get colocated `*.test.ts` unit tests.

**Organization**: Grouped by user story. Within a story: tests → DAL/services → scheduler/UI.

## Format: `- [ ] T### [P?] [US#?] Description with file path`

- **[P]**: different files, no dependency on an incomplete task.
- Commands are headless-safe: `pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm db:check`, `pnpm build`. No browser, no dev server, no `curl`: HTTP behaviour is tested by calling the route handler / `handleTickRequest` directly in Vitest; UI is tested by rendering the server component to HTML in Vitest.
- Read `node_modules/next/dist/docs/` for any Next.js API touched (route handler, `instrumentation.ts`) before writing it (AGENTS.md). Follow the `docket-ui` skill for the indicator.
- Locking order and the join rule (`a.project_id = b.project_id`) in `contracts/dal.md` are binding for every DAL task. Run `pnpm vitest run tests/integration/scope-check.test.ts` early.

---

## Phase 1: Setup

**Purpose**: Configuration and access statements every later task reads.

- [X] T001 Add the 16 new variables to the Zod schema in `src/server/env.ts` with a new `bool(default)` helper and the cross-field rules (lease > budget + provider timeout; provider timeout < budget; backoff max ≥ base; `TICK_SECRET` ≥ 32 chars, empty = unset), per `contracts/env.md`; messages name the variable and never print values
- [X] T002 [P] Extend `src/server/env.test.ts` to cover defaults, ranges, each cross-field rule, empty `TICK_SECRET`, `MOCK_PROVIDER_ENABLED` default off in production, and that issue messages contain no values
- [X] T003 [P] Document all 16 variables (purpose, format, default, `openssl rand -base64 32` hint for `TICK_SECRET`) in `.env.example`
- [X] T004 [P] Add account/slot/media/post access statements (`account:view|manage`, `slot:view|manage`, `media:edit`, `post:view|edit|delete|schedule`) per research D20 and `contracts/services.md` in `src/server/auth/access.ts`; extend the existing permissions test (`tests/integration/permissions.test.ts`) with the role matrix from FR-009
- [X] T005 [P] Add `ValidationIssuesError` (`name = "ValidationIssuesError"`) to `src/server/dal/errors.ts` and map it to `validation` with issues attached in `src/lib/action-result.ts`; extend `src/lib/action-result.test.ts`

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: Schema, migration, scope registry, DAL repos, clock, provider contract, text counting, validation, registry, mock provider, shared Zod schemas, test helpers.

**⚠️ CRITICAL**: No user story starts until this phase is complete.

### Schema and registry

- [X] T006 [P] Define enums and `social_accounts` + `posting_slots` tables (unique `(project_id, provider_key, external_account_id)`, unique slot `(social_account_id, weekday, local_time)`, checks) in `src/server/db/schema/accounts.ts` per `data-model.md`
- [X] T007 [P] Define `media_assets` in `src/server/db/schema/media.ts`
- [X] T008 [P] Define `posts`, `post_media`, `post_targets` (incl. lease, in-flight, step-state, `slot_occurrence_at` columns, due-target index, and the partial unique index `post_targets_occurrence_uq` on `(social_account_id, slot_occurrence_at)` for live slot-held targets) in `src/server/db/schema/posts.ts` per `data-model.md`
- [X] T009 [P] Define append-only `publish_attempts` in `src/server/db/schema/attempts.ts` and system-wide `scheduler_heartbeats` in `src/server/db/schema/scheduler.ts`
- [X] T010 Export the new schema from `src/server/db/schema/index.ts`; register the 7 project-owned tables and `scheduler_heartbeats` (not project-owned) in `src/server/db/project-owned.ts`; raise the floor in `src/server/db/project-owned.test.ts` from 11 to 19
- [X] T011 Generate the migration with `pnpm db:generate` (`drizzle/0001_*.sql` + `meta/`), review the SQL for the partial unique index and checks, then run `pnpm db:check` and `pnpm vitest run src/server/db/project-owned.test.ts`

### DAL

- [X] T012 [P] Implement `src/server/dal/clock.ts` (`now()` via `select clock_timestamp()`, `runAtTime(date, fn)` ALS override) and `tests/helpers/clock.ts` (`atTime`)
- [X] T013 [P] Implement `src/server/dal/accounts.ts` and `src/server/dal/slots.ts` repos per `contracts/dal.md` (duplicate slot `23505` → `ConflictError("That account already has a slot at that time.", "localTime")`)
- [X] T014 [P] Implement `src/server/dal/media.ts` and `src/server/dal/attempts.ts` (attempts exposes `insert` and `listForTarget` ONLY — FR-006)
- [X] T015 Implement `src/server/dal/posts.ts` (incl. `lockForUpdate` as its own statement) and `src/server/dal/targets.ts` (`heldInstants`, `tryHoldOccurrence` in a savepoint returning `false` on `23505`, `releaseOccurrence`, `queuedForAccount` locking in order, `nearScheduled`, `effectiveContent`); every join carries `project_id` equality
- [X] T016 [P] Implement `src/server/dal/heartbeats.ts` (`writeHeartbeat`, `readHeartbeats`) and `src/server/dal/schema-ready.ts` (`schemaIsReady`, false on `42P01`/`42703`/connection errors)
- [X] T017 Extend `ProjectScope` in `src/server/dal/scope.ts` with `accounts, slots, media, posts, targets, attempts`; export new types, `now`, `closeDb`, heartbeat functions from `src/server/dal/index.ts`
- [X] T018 Implement `src/server/dal/scheduler.ts`: `claimDueTargets(opts)` and `claimRefreshAccounts(opts)` inside `crossProject` with the exact reasons in `contracts/scheduler.md` (`FOR UPDATE SKIP LOCKED` on targets then `FOR NO KEY UPDATE SKIP LOCKED` on accounts, never waiting, no post lock), `forSchedulerProject(projectId)` (pinned, no membership), `releaseLease`, `recordWithLease(targetId, token, patch)`
- [X] T019 Extend `tests/helpers/scope-check.ts` / `tests/integration/scope-check.test.ts` with a case exercising every new repo and both claim queries (recorder must see no cross-project reason for the record step)

### Providers (pure, no server imports)

- [X] T020 [P] Define `SocialProvider`, capabilities, `StepResult` (continue/done/retryable_error/fatal_error/ambiguous), `stepFor`, connect strategies, `refreshCredentials` in `src/providers/types.ts` and error helpers in `src/providers/errors.ts` per `contracts/providers.md`
- [X] T021 [P] Implement grapheme / code-point / UTF-8-byte counting with `Intl.Segmenter` in `src/providers/text.ts` + `src/providers/text.test.ts` (emoji, ZWJ sequences, combining marks, CJK, empty string)
- [X] T022 Implement shared content validation (text limit by counting rule, image count/type/size, alt text, text-only allowed) in `src/providers/validation.ts` + `src/providers/validation.test.ts`
- [X] T023 Implement the `mock` provider in `src/providers/mock/index.ts` and `src/providers/mock/settings.ts` (all 7 behaviours, `stepFor` rules, `delayMs` honouring `ctx.signal`, `refreshCredentials`) per `contracts/providers.md`, with `src/providers/mock/mock.test.ts` covering each behaviour table row
- [X] T024 Implement `src/providers/registry.ts` (`findProvider`, `listProviders`, one registry line for `mock`) + `src/providers/registry.test.ts` (unknown key → undefined)

### Shared validation and test helpers

- [X] T025 [P] Implement shared Zod schemas (weekday 1–7, `HH:MM` local time, publish limit, post input, `at` ISO instant) in `src/lib/validation/scheduling.ts` with `src/lib/validation/scheduling.test.ts`
- [X] T026 [P] Implement `tests/helpers/scheduling.ts` factories (mock account with settings, slots, draft post with targets, due targets, media asset) built on `tests/helpers/factories.ts`

**Checkpoint**: `pnpm typecheck && pnpm db:check && pnpm vitest run src/providers src/server/db tests/integration/scope-check.test.ts` green.

---

## Phase 3: User Story 1 — Queue a post and have it publish on its own (P1) 🎯 MVP

**Goal**: Connect a mock account, add slots, create a draft, preview and confirm a queue, and have one tick publish it at its slot.

**Independent Test**: `tests/integration/scheduler/e2e.test.ts` — fresh project, mock account, one slot, draft post, `previewQueue` → `addToQueue` → `atTime(slot)` → `runTick()` → target `published`, post `published`, attempt rows recorded, second tick does nothing (SC-001).

### Tests

- [x] T027 [P] [US1] Unit tests for slot occurrence maths (weekday/time → instants in project zone, active slots only, dedupe, `from < instant ≤ to`) in `src/server/services/queue/occurrences.test.ts`
- [x] T028 [P] [US1] Integration tests for accounts and slots (connect mock gated by `MOCK_PROVIDER_ENABLED`, reconnect upsert, never returns credentials, duplicate slot conflict, role matrix, another project's ids behave as not found) in `tests/integration/accounts-slots.test.ts`
- [x] T029 [P] [US1] Integration tests for post lifecycle (create draft with media/targets, update, delete rules, `previewQueue` writes nothing, `addToQueue` allocates, `scheduleAt`, `publishNow`, cancel frees occurrence) in `tests/integration/posts/lifecycle.test.ts`
- [x] T030 [P] [US1] Integration tests for validation refusal (over-limit text, too many images, wrong type, per-target override, one target failing never blocks others) in `tests/integration/posts/validation.test.ts`
- [x] T031 [P] [US1] Unit tests for `derivePostStatus` over the full FR-029 table in `src/server/services/posts/status.test.ts` and integration tests for `applyDerivedStatus` in `tests/integration/posts/status.test.ts`
- [x] T032 [P] [US1] Cross-project isolation tests for accounts/slots/posts/targets/attempts in `tests/integration/posts/isolation.test.ts`
- [x] T033 [P] [US1] Unit tests for `redact` (known secrets, tokens, nested objects) in `src/server/scheduler/redact.test.ts`, and for `applyStepResult` (done/continue → patch) in `src/server/scheduler/record.test.ts`
- [x] T034 [US1] End-to-end test in `tests/integration/scheduler/e2e.test.ts` (draft → queued → published within one tick of its slot; multi-step mock continues across ticks honouring `notBefore`; late target publishes with `lateBySeconds`)

### Implementation

- [x] T035 [P] [US1] Implement `src/server/services/queue/occurrences.ts` (`resolveOccurrence` with Temporal `'compatible'` disambiguation, `occurrencesBetween`)
- [x] T036 [P] [US1] Implement `src/server/services/accounts.ts` (`listAccounts`, `listConnectableProviders`, `connectMock`, `saveConnectedAccount`, `updateAccountSettings`, `setPublishLimit`, `removeAccount`) per `contracts/services.md`; credentials AES-GCM with AAD `social_account:<id>` via 001's `secrets.ts`
- [x] T037 [P] [US1] Implement `src/server/services/slots.ts` and `src/server/services/media.ts`
- [x] T038 [US1] Implement `src/server/services/queue/index.ts` `allocateNextFree` (walk candidates, savepoint per candidate, `23505` → next) with the two failure messages, and `nearQueuedWarnings`
- [x] T039 [P] [US1] Implement `src/server/services/posts/status.ts` (`derivePostStatus`, `applyDerivedStatus`) and `src/server/services/posts/content.ts` (effective content assembly)
- [x] T040 [US1] Implement `src/server/services/posts/index.ts`: `createDraft`, `updatePost`, `setReviewState`, `deletePost`, `getPost`, `validatePost`, `previewQueue`, `addToQueue`, `scheduleAt`, `publishNow`, `cancelTarget`, `retryTarget`, `resolveAmbiguous`, `listAttempts` — post lock before target locks, per-target results, DB-clock `now`
- [x] T041 [P] [US1] Implement `src/server/scheduler/config.ts` (`schedulerConfig(env)` → `SchedulerConfig`, test overrides), `src/server/scheduler/redact.ts`, `src/server/scheduler/backoff.ts` (`nextRetryAt`), `src/server/scheduler/record.ts` (`applyStepResult`, persistence via DAL)
- [x] T042 [US1] Implement `src/server/scheduler/publishing.ts` (claim → lease → advance outside any transaction with `AbortSignal.timeout` → record under lease token) and `src/server/scheduler/index.ts` `runTick()` + `TickSummary`; heartbeat written on section completion; no `next/*` imports

**Checkpoint**: `pnpm vitest run tests/integration/scheduler/e2e.test.ts tests/integration/posts tests/integration/accounts-slots.test.ts src/server/services` green. MVP complete.

---

## Phase 4: User Story 2 — Safe at any concurrency, safe to kill (P1)

**Goal**: Any number of concurrent ticks publish each target exactly once; a killed tick is recovered; a tick is bounded.

**Independent Test**: `tests/integration/scheduler/concurrency.test.ts` — 5 parallel `runTick` over 200 due targets, 0 duplicate "done" calls across 20 repeated runs (SC-002).

### Tests

- [x] T043 [P] [US2] Concurrency test in `tests/integration/scheduler/concurrency.test.ts` (own pool via `createDatabase(url, 20)`; 5 ticks × 200 targets × 20 repetitions; count provider `done` calls per target)
- [x] T044 [P] [US2] Recovery/stale-lease tests in `tests/integration/scheduler/recovery.test.ts` and `tests/integration/scheduler/stale-lease.test.ts` (expired lease + safe step → retried with attempt counted; unsafe step → `ambiguous`; late result with wrong lease token → `stale_result` attempt only; SC-005)
- [x] T045 [P] [US2] Budget test in `tests/integration/scheduler/budget.test.ts` (1,000 due targets + slow mock provider → tick returns within budget, no provider call starts when `now + timeout > deadline`, unstarted claimed rows `released`; SC-004)

### Implementation

- [x] T046 [US2] Implement `src/server/scheduler/recovery.ts` (expired-lease handling per D5, used from the claim step) and wire it into `publishing.ts`
- [x] T047 [US2] Implement the item/time budget and release-on-deadline logic in `publishing.ts` (`batchSize` 4, `maxItems`, per-row release attempt `released`) and section-level crash isolation (a crashed section marks `ok:false`, skips its heartbeat; FR-039)
- [x] T048 [P] [US2] Implement `src/server/scheduler/loop.ts` `runLoop` with `src/server/scheduler/loop.test.ts` (abort during tick lets it finish, abort during sleep ends it, throwing tick logged and loop continues, log line format)
- [x] T049 [P] [US2] Implement `src/worker.ts` (parse env, wait for schema every 2 s logging ≤ every 30 s, SIGTERM/SIGINT abort, second signal exits 1, `closeDb`) and add `build:worker` to `package.json` (chained into `build`); test the schema-wait in `tests/integration/worker-schema-wait.test.ts`
- [x] T050 [P] [US2] Implement `src/server/scheduler/http.ts` `handleTickRequest` (404 unset secret, identical 401 for all bad auth with `WWW-Authenticate: Bearer`, constant-time `timingSafeEqual(sha256…)`, 200 summary with `Cache-Control: no-store`, 503 on throw) with `src/server/scheduler/http.test.ts`
- [x] T051 [US2] Add `src/app/api/internal/tick/route.ts` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`, POST only), add `"/api/internal/"` to public prefixes in `src/lib/auth-gate.ts` with a case in `src/lib/auth-gate.test.ts`, and add `tests/integration/tick-endpoint.test.ts` (calls the exported `POST` with real Requests)
- [x] T052 [P] [US2] Implement `src/server/scheduler/in-process.ts` (`startInProcessLoop`, no-op unless `RUN_WORKER_IN_PROCESS`, `globalThis` guard, SIGTERM aborts) and call it after `runStartup()` in `src/instrumentation.ts`; unit-test the guard/no-op in `src/server/scheduler/in-process.test.ts`
- [x] T053 [US2] Run `pnpm build` and assert `.next/standalone/worker.mjs` exists and contains no `next/` import (grep the bundle); fix offending imports, not bundle flags

**Checkpoint**: `pnpm vitest run tests/integration/scheduler tests/integration/tick-endpoint.test.ts src/server/scheduler` green.

---

## Phase 5: User Story 3 — Failures are handled honestly (P1)

**Goal**: Retry with backoff, permanent failures, ambiguous never retried, honest attempt log, no secrets.

**Independent Test**: `tests/integration/scheduler/backoff.test.ts` and `ambiguous.test.ts` with mock accounts per failure mode.

### Tests

- [x] T054 [P] [US3] Unit tests for `nextRetryAt` (doubling, cap, respects provider `notBefore`) in `src/server/scheduler/backoff.test.ts`
- [x] T055 [P] [US3] Backoff integration test in `tests/integration/scheduler/backoff.test.ts` (retryable: retried at computed times via `atTime`, stops after exactly `PUBLISH_MAX_ATTEMPTS`; `failTimes` then success; `rate_limited` honours `retryAfterSeconds`; SC-008)
- [x] T056 [P] [US3] Ambiguous test in `tests/integration/scheduler/ambiguous.test.ts` (provider `ambiguous`, throw/timeout on a `mayPublish` step → `ambiguous`; throw on a safe step → retry; 100 further ticks never call the provider again; SC-006)
- [x] T057 [P] [US3] Retry/resolve service tests in `tests/integration/posts/retry-resolve.test.ts` (`retryTarget` only for `failed`, resets attempts, writes `retry_requested`; `resolveAmbiguous` published/failed; post status re-derived; `partially_failed`)
- [x] T058 [P] [US3] Extend `tests/integration/no-plaintext.test.ts` into the SC-012 scan: attempts, errors, summaries, `listAccounts` output and rendered HTML contain 0 stored credentials/tokens, including a provider that throws with a secret in its message

### Implementation

- [x] T059 [US3] Implement the result table from `contracts/providers.md` in `record.ts`/`publishing.ts` (retryable → backoff + attempt count; fatal → `failed`; ambiguous; throw/timeout classification by `mayPublish`; `PUBLISH_MAX_DURATION_HOURS` → "publishing did not complete"; FR-038 `needs_reauth`/unregistered provider → `failed` with clear message)
- [x] T060 [US3] Apply `redact()` to every attempt summary, `last_error`, and tick summary before persistence; confirm `TickSummary` carries counts only

---

## Phase 6: User Story 4 — A queue that is always correct (P2)

**Goal**: No double-held occurrence under any concurrency; DST-correct; freed slots reusable; explicit actions.

**Independent Test**: `tests/integration/queue/concurrency.test.ts` — 50 simultaneous `addToQueue` on one account → 50 distinct occurrences, 20 repetitions (SC-003).

### Tests

- [X] T061 [P] [US4] Allocation tests in `tests/integration/queue/allocation.test.ts` (earliest free after now, paused slots skipped, horizon exhaustion message, no-slots message, never guesses a time)
- [X] T062 [P] [US4] Concurrency test in `tests/integration/queue/concurrency.test.ts` (own pool of 20; 50 parallel requests × 20 runs; 0 duplicates; DB unique index asserted by a direct duplicate insert)
- [X] T063 [P] [US4] DST tests in `tests/integration/queue/dst.test.ts` and extend `occurrences.test.ts` for spring-forward and fall-back in `America/New_York`, `Europe/London` and one southern-hemisphere zone (e.g. `Australia/Sydney`); pin the `'compatible'` rule FIRST (research F1) — if a test disagrees with F1, stop and record it in `docs/decisions.md` rather than switching modes (SC-007)
- [X] T064 [P] [US4] Actions tests in `tests/integration/queue/actions.test.ts` (`moveToNextFreeSlot` excludes own occurrence, `swapQueuedTargets` atomic and same-account only, `pullQueueForward` order-preserving and never later, cancel/delete/move free the occurrence, nothing else moves)
- [X] T065 [P] [US4] Empty-slot listing and explicit-time tests in `tests/integration/queue/empty-slots.test.ts` (range ≤ 92 days, excludes held and paused, past time refused `in_past`, near-queued warning without error, explicit time consumes no occurrence)

### Implementation

- [X] T066 [US4] Implement `moveToNextFreeSlot`, `swapQueuedTargets`, `pullQueueForward`, `listEmptySlots` in `src/server/services/queue/index.ts` following the locking order in `contracts/dal.md` (posts by id → targets by id)
- [X] T067 [US4] Verify `scheduleAt`/`publishNow`/`cancelTarget`/`deletePost` free occurrences and honour `EXPLICIT_TIME_WARNING_MINUTES` / `QUEUE_HORIZON_DAYS`; add any missing paths in `src/server/services/posts/index.ts`

---

## Phase 7: User Story 5 — Platform limits and account health respected (P2)

**Goal**: Per-account rolling-window limits, token refresh, `needs_reauth` handling.

**Independent Test**: `tests/integration/scheduler/limits.test.ts` and `refresh.test.ts`.

### Tests

- [x] T068 [P] [US5] Unit tests for effective limits and deferral time (stricter of provider default and account limit wins; deferral = oldest start + window) in `src/server/scheduler/limits.test.ts`
- [x] T069 [P] [US5] Limits integration test in `tests/integration/scheduler/limits.test.ts` (twice the limit due at once → never exceeds limit in any rolling window incl. in-flight; excess `deferred` with attempt row; `setPublishLimit` warns when looser than provider default; SC-009)
- [x] T070 [P] [US5] Refresh test in `tests/integration/scheduler/refresh.test.ts` (credentials expiring in window refreshed and re-encrypted; failure → `needs_reauth` + redacted `last_error`; cap of 5; one failure doesn't stop others; section has its own budget share and heartbeat; due target on `needs_reauth` account fails without a provider call)

### Implementation

- [x] T071 [P] [US5] Implement `src/server/scheduler/limits.ts` and call it for first steps in `publishing.ts` (count `publish_started_at` in window)
- [x] T072 [US5] Implement `src/server/scheduler/token-refresh.ts` (claim → decrypt → `refreshCredentials` → record with refresh lease token) and add it as the second section of `runTick` with its own heartbeat

---

## Phase 8: User Story 6 — Operator can see whether the scheduler is alive (P2)

**Goal**: Quiet indicator when healthy, loud accessible banner when stale or never run.

**Independent Test**: `tests/integration/scheduler-health.test.ts` renders the indicator with fresh / stale / never heartbeats.

### Tests

- [x] T073 [P] [US6] Service tests for `getSchedulerHealth` states (`ok`/`stale`/`never`, any member may call, threshold not exposed, crashed section leaves heartbeat untouched) and rendering tests for `SchedulerHealth` (quiet text with `<time>`; banner with `role="alert"`, fix list, text not colour alone; no secrets/thresholds in HTML) in `tests/integration/scheduler-health.test.ts` using `react-dom/server` `renderToStaticMarkup` (SC-010)

### Implementation

- [x] T074 [P] [US6] Implement `src/server/services/scheduler-health.ts` reading `dal/heartbeats.ts` and `SCHEDULER_STALE_AFTER_MINUTES`
- [x] T075 [US6] Implement `src/components/shell/SchedulerHealth.tsx` (server component per `docket-ui`; quiet form and banner form) and render it in `src/app/p/[projectSlug]/layout.tsx` (quiet in header `left`, banner above `<main>`)

---

## Phase 9: User Story 7 — Developer adds a platform by adding one folder (P3)

**Goal**: Provider contract is self-evident; mock proves it.

**Independent Test**: `src/providers/mock/mock.test.ts` plus an import-boundary lint test.

- [x] T076 [P] [US7] Add an architecture test in `tests/lint/` asserting `src/providers/**` imports nothing from `src/server/**` and that `src/server/scheduler/**` and `src/worker.ts` import no `next/*`; extend ESLint config if the ban is rule-based
- [x] T077 [P] [US7] Test that registering a throwaway provider (one folder + one registry line, defined in a test) is publishable by `runTick` with no change to scheduler, services or schema, in `tests/integration/scheduler/provider-plugin.test.ts`
- [x] T078 [US7] Write `docs/adding-a-provider.md` with the 12 required sections from `contracts/providers.md` (checklist, contract fields, capabilities, connect strategies, settings vs credentials, `stepFor`/`mayPublish`, StepResult decision table incl. when to return `ambiguous`, limits, refresh/`needs_reauth`, mocked-HTTP testing, no-secrets rule, mock worked example)

---

## Phase 10: Polish & Cross-Cutting

- [x] T079 Add the `worker` service, `x-docket-env` anchor and web healthcheck to `docker-compose.yml` per `contracts/scheduler.md`; validate with `docker compose config` if Docker is installed (otherwise parse the YAML in a Vitest test asserting `worker` uses the web image, `command`, and `depends_on.web.condition: service_healthy`)
- [x] T080 [P] README "Running the scheduler" (worker / tick endpoint with cron example / in-process), what the stale banner means, in `README.md`
- [x] T081 [P] Append "002 — Scheduling engine" entries (DST rule, backoff/attempt defaults and `attempt_count` meaning, lease/recovery, limit counting, status derivation + `review_state`, `chars` = code points, `needs_reauth` with no transient retry, system-wide heartbeat, mock gating, soft deletes, "move to next" excluding current, two extra env vars, batch size 4 / refresh cap 5) to `docs/decisions.md`
- [x] T082 Walk `specs/002-scheduling-engine/quickstart.md` command by command, running every listed `pnpm vitest run …` selection; record any unrun item as not verified in `docs/decisions.md`
- [x] T083 Final gate: `pnpm lint && pnpm typecheck && pnpm db:check && pnpm test && pnpm build` all green; confirm `.next/standalone/worker.mjs` present
- [ ] T084 🛑 BLOCKED: needs a Docker daemon and a free port — run `docker compose up` and confirm the indicator shows a recent tick within two minutes (SC-013); one survey task, absolute measurement
- [ ] T085 🛑 BLOCKED: needs a Neon database URL — run `pnpm vitest run tests/integration/scheduler` against Neon to close research unknown U1 (transaction-scoped locks only); record the result in `docs/decisions.md`

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. Phase 2 blocks everything.
- **US1** first (MVP): it builds allocation, post services, `runTick` core. **US2, US3, US5** extend `runTick` (`publishing.ts`, `record.ts`) and so are sequential with each other on those files (US2 → US3 → US5); their test tasks are parallel. **US4** extends `queue/index.ts` and needs only US1. **US6** needs only Phase 2 + heartbeat writing from T042. **US7** needs US1/US2.
- Story order: US1 → (US2, US4, US6 in parallel) → US3 → US5 → US7 → Polish.
- Within a story: tests first (expect failures), then implementation.
- Docs tasks T078, T080, T081 may start once their behaviour is implemented.

## Parallel Examples

- Phase 2: T006–T009 (schema files), then T012/T013/T014/T016 (DAL), T020/T021 (providers), T025/T026.
- US1 tests T027–T033 together; implementation T035/T036/T037/T039/T041 together.
- US2: T043–T045 together; T048/T049/T050/T052 together.
- US4: T061–T065 together.

## Implementation Strategy

1. **MVP = Phases 1–3**: a draft becomes a published mock post via `runTick()` at its slot.
2. Add US2 (concurrency, recovery, triggers) — required before anything ships, since P1.
3. Add US3 failure handling (P1), then US4/US5/US6 (P2), then US7 (P3), then polish.
4. Run `pnpm vitest run <story path>` at each checkpoint; commit per task group with conventional commits and explicit paths.
5. Human-owned items (T084, T085) are owed, not missing; everything else is executable headless.

---

## Phase 11: Review remediation

- [X] T086 Make every post-service write to a target refuse a row the scheduler has claimed: after the post lock, lock the target rows (`SELECT … FOR UPDATE` as its own statement, per `contracts/dal.md` lock order) and re-check status and lease on that read, or add a `lease_owner IS NULL OR lease_until < now` guard to `cancelTargetRow`, `tryHoldOccurrence`, the `scheduleExplicit` update and the `updatePost` target writes. A missed guard must surface as `ConflictError("Publishing in progress…")` or a per-target `not_queueable` result, never `ok: true`. Add integration tests that hold a claim open (gated `decide` in `claimDueTargets`) and assert `cancelTarget`, `deletePost`, `moveToNextFreeSlot`, `scheduleAt` and `updatePost` refuse, plus a plain test that a leased target cannot be cancelled or deleted — review F1 (BLOCKER), src/server/services/posts/cancel.ts:22, src/server/services/posts/index.ts:508-529, src/server/services/posts/index.ts:281-293, src/server/services/posts/index.ts:439-455, src/server/services/queue/index.ts:138-145, src/server/dal/targets.ts:104-117
- [X] T087 Fix publish-limit accounting for retried targets. Re-arming a target (`retryTarget`, `addToQueue`, `scheduleAt`/`publishNow`) clears `publish_started_at`; leasing a first step stamps it when null; the limit check no longer counts a target's own in-window start against itself. Add integration tests: (a) limit 1/hour plus a `retryable` `failTimes: 1` target is retried at its backoff time, not deferred to the window end; (b) limit 1/hour, a target failed 2 h ago is retried with `retryTarget` while another target is due, and only one publishes in the window. Amend the "Limit counting" entry in `docs/decisions.md` — review F2 (MAJOR), src/server/scheduler/publishing.ts:116-129, src/server/scheduler/publishing.ts:161, src/server/scheduler/limits.ts:30-33, src/server/services/posts/index.ts:539-543

## Phase 12: Review remediation

- [x] T088 Count a publish-limit start at the attempt that may actually publish: in `src/server/scheduler/publishing.ts:161` stamp `publishStartedAt: now` on every first-step lease (automatic and recovery retries included) instead of keeping the first-ever value (the own-row exclusion at :120 already prevents self-deferral; the release path at :213-217 already restores the prior value). Add an integration test to `tests/integration/scheduler/limits-retry.test.ts`: limit 1/hour, mock `retryable` `failTimes: 1`; A fails at 09:00 and is retried and published at 09:30; B due at 10:00:30 must be `deferred` (not published) until 10:30. Amend the "Limit counting" entry in `docs/decisions.md:162-168` (a start is the most recent lease of a first step) — review F13 (MAJOR), src/server/scheduler/publishing.ts:161

## Phase 13: Review remediation

- [x] T089 (fixed at the source: `createDatabase` now attaches a pool `error` listener, so a client killed by the forced drop is logged and discarded instead of surfacing as an unhandled 57P01; regression test `tests/integration/db-pool-error.test.ts` fails without the fix) Make the throwaway-database teardown in `tests/helpers/db.ts` (`createThrowawayDb().drop()`) immune to the `pg-pool` end/drop race, so `pnpm test` exits 0. `pool.end()` resolves before idle clients finish closing, and the forced `drop database … with (force)` then terminates them, surfacing an unhandled `57P01` via the pool's `error` event. Attach `pool.on("error", () => {})` to the throwaway pool before ending it (the database is being destroyed), or wait for every client's `remove` event before the drop. Confirm two consecutive full `pnpm test` runs exit 0 with no "Unhandled Errors" section — review F16 (MAJOR), tests/helpers/db.ts:35-36
