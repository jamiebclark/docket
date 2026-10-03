# Implementation Plan: Docket Scheduling Engine — Accounts, Posts, Posting Slots, Provider Framework and the Scheduler Tick

**Branch**: `002-scheduling-engine` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-scheduling-engine/spec.md`

## Summary

This builds the engine behind Docket's scheduler pillar on top of entry 001's
scoped DAL, project model, secrets facility and env validation:

- seven project-owned tables plus one system-wide heartbeat table;
- a plug-in provider contract with a configurable `mock` provider;
- one slot-allocation service, DST-correct through Temporal and race-free through a partial unique index;
- the post services every later caller uses;
- `runTick()`, a bounded, concurrency-safe and kill-safe tick, with three triggers: a worker process, a secret-protected HTTP endpoint, and an in-process loop;
- a health indicator in the app shell.

There are no screens beyond the indicator; entry 3 builds them on these services.

**Technical approach.**

- **Occurrences are virtual.** A queued target *holds* `(social_account_id, slot_occurrence_at)`, and a partial unique index guards it. Allocation walks the candidate instants and takes the first free one inside a savepoint, moving on after a `23505`. Freeing an occurrence nulls the column.
- **Claiming** is a short `crossProject` transaction. It uses `FOR UPDATE SKIP LOCKED` on targets *and* their accounts and never waits on a lock. It stamps a per-claim lease token and the step that is about to run, plus whether that step could make the post public.
- **Provider calls** run outside any transaction, with a timeout. Results are recorded in a project-pinned transaction guarded by the lease token.
- **Recovery and failure handling** use the declared step safety. An interrupted, throwing or timed-out step that could publish becomes `ambiguous` and is never retried. A safe step is retried.
- **Time comes from the database clock**, passed as a parameter so tests can pin it.
- **Post status** is derived under a post-row lock after every target change.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `noUncheckedIndexedAccess`) on Node 24 LTS (`>=24.10 <25`; verified on v24.16.0)

**Primary Dependencies** (all already installed, research D25):

- Next.js 16.3.8 (route handler, `instrumentation.ts`)
- drizzle-orm 0.45.3 + pg 8 (`SKIP LOCKED`, partial indexes, savepoints: research F3–F5), drizzle-kit 0.31.11
- zod 4.6.5
- `@js-temporal/polyfill` 0.5.1 (F1, F2)
- `node:crypto` (`timingSafeEqual`, AES-GCM via 001's `secrets.ts`)
- `Intl.Segmenter` (F6)
- esbuild (dev dependency; the worker bundle, F11)

**Storage**: PostgreSQL 17 (Compose/CI). Neon is compatible by design: transaction-scoped row locks only, no advisory locks, LISTEN or `SET` (F12). One new migration, `drizzle/0001_*.sql`.

**Testing**: Vitest 5 against real Postgres, using 001's harness (fresh migrated schema, factories, SQL scope recorder). New pieces:

- `tests/helpers/clock.ts` (`atTime`) for deterministic time;
- `tests/helpers/scheduling.ts` factories (mock account, slots, post, due targets);
- concurrency tests use parallel `runTick` / service calls on the shared pool;
- unit tests are colocated for the pure modules (text counters, validation, occurrences/DST, backoff, limits, status derivation, redaction, `runLoop`, `handleTickRequest`).

**Target Platform**: Linux container (`node:24-slim`). One image runs `web` (`node scripts/prestart.mjs`) and `worker` (`node worker.mjs`). It also runs on any container host, with Neon or with an external cron hitting the tick endpoint.

**Project Type**: Web application, the single Next.js app with server layers (`src/server/{dal,services,scheduler}`) and plug-ins (`src/providers/`).

**Performance Goals**:

- A tick returns within its 20 s budget even with 1,000 due targets and a slow provider (SC-004).
- A queued post is published within one worker interval (≤ 60 s) of its slot (SC-001).
- 50 concurrent queue requests on one account all succeed with distinct occurrences (SC-003).

**Constraints**:

- No provider call inside a transaction.
- Lease (300 s) > budget (20 s) + provider timeout (10 s), validated at start-up.
- Time is judged by the DB clock.
- No secrets in attempts, errors, summaries, logs or pages.
- `src/server/scheduler/**` and `src/worker.ts` must not import `next/*`.
- Keyboard and screen-reader-accessible indicator (`role="alert"` banner).

**Scale/Scope**: Self-hosted, tens of projects and tens of accounts, hundreds of queued posts.

- 8 new tables (7 project-owned, 1 system-wide) and 7 enums.
- About 30 service functions, 1 HTTP route, 1 UI component, 1 worker entry and 16 env vars.
- The required test list in the spec input (10 categories).

No `NEEDS CLARIFICATION` remains. Three items are carried as **unverified**
with a fallback (research U1 Neon, U2 dev-mode double `register()`, U3 Docker
availability).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Every library behaviour the design relies on was read from installed types or **run**: Temporal disambiguation in four zones, Drizzle `skipLocked` / partial index / savepoints, `Intl.Segmenter` counts, esbuild alias bundling, `timingSafeEqual`, Next `register()` semantics, and the proxy's public paths (research F1–F16). The polyfill's misleading JSDoc for `'compatible'` is noted, and the behaviour is pinned by tests. Platform limits are cited from `docs/research/` only as examples. No `NEEDS RESEARCH` items |
| II. Nothing is "working" unless it ran | ✅ | Quickstart lists runnable checks with expected results. Neon and (possibly) Docker are reported "not verified" if unavailable (U1, U3). There are no real providers; the mock is exercised offline, and real providers will use mocked HTTP |
| III. Isolation enforced in one place | ✅ | 7 new project-owned tables are registered with `project_id` scope, and the heartbeat is registered as not project-owned (FR-007). All access goes through new DAL repos. The scheduler crosses projects only inside two named `crossProject` claims, then acts through `forSchedulerProject(projectId)` with pinned queries (FR-008). The join rule `a.project_id = b.project_id` keeps the recorder green. Roles are checked on the server via new access statements (D20) |
| IV. One service layer | ✅ | Allocation exists once (`services/queue.ts`), used by `posts.addToQueue` and the queue actions. Status derivation exists once (`posts/status.ts`), used by services and the scheduler. Connect is one upsert (`saveConnectedAccount`) for every future flow. The tick, HTTP trigger, worker and in-process loop all call the same `runTick()`/`runLoop()` |
| V. Providers are plug-ins | ✅ | `src/providers/<key>/` + one registry line. Provider keys, settings, state and step names are `text`/`jsonb`, so no schema change is needed per provider. `advance()` returns the five kinds. `stepFor().mayPublish` drives ambiguity, and ambiguous targets are excluded from every automatic path (FR-034). The mock is built through the same contract (FR-015) |
| VI. Boring, few dependencies | ✅ | No new runtime dependency or infrastructure. esbuild is an existing dev dependency, used exactly as in decision #20 (D25) |
| VII. Secrets never leak | ✅ | Credentials are AES-256-GCM with row-bound AAD (D16) and decrypted only by the engine right before a call. `redact()` runs over every summary and error. Accounts are returned as `hasCredentials` / expiry only. The tick secret is compared in constant time and never logged. New env is validated with Zod and documented. The SC-012 scan test covers attempts, errors, summaries, service output and rendered HTML |
| Eng. constraints | ✅ | Compose gains the `worker` service from the same image (with a web healthcheck for ordering). `runTick()` is bounded, concurrent-safe and kill-safe, with `SKIP LOCKED` + lease and no call inside a held transaction. UTC `timestamptz`; wall time only via Temporal `compatible`. The indicator is a server component following `docket-ui` |
| Workflow | ✅ | Conventional commits with explicit paths. Gates: lint, typecheck, `db:check` (new migration committed), test, build (now including `worker.mjs`), Docker. Decisions log, README, `.env.example` and `docs/adding-a-provider.md` are deliverables (FR-048) |

**Gate result: PASS** (no violations; Complexity Tracking is empty).

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Scope.** Every new table has a scope column in the registry. The only unpinned queries are the two named claims. Joins carry `project_id` equality (dal.md).
- **No hidden waits.** The claim never waits on a lock and takes no post lock; post status is derived in a separate short transaction. Every waiting transaction takes the post lock before target locks. No lock cycle exists (dal.md "Locking order"). This was fixed during design: an earlier draft derived status inside the claim, which could deadlock with cancel.
- **No session-level Postgres features.** Savepoints and row locks are transaction-scoped.
- **Ambiguity has no automatic exit.** The only automatic exit would be the claim predicate, which excludes `ambiguous`. The only exits are the user actions `resolveAmbiguous` → published or failed.
- **Providers.** They import nothing from `src/server/**` (contract rule). Adding one touches no table or service.
- **No new dependencies.**

**PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/002-scheduling-engine/
├── plan.md              # This file
├── research.md          # Phase 0: verified facts F1–F16, unknowns U1–U3, decisions D1–D25
├── data-model.md        # Phase 1: tables, constraints, state machine, derivation, validation
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── providers.md     # SocialProvider, StepResult, registry, text counting, validation, mock, guide outline
│   ├── services.md      # accounts, slots, media, queue (allocation), posts, scheduler-health
│   ├── scheduler.md     # runTick, sections, runLoop, worker, in-process, tick endpoint, Compose, indicator
│   ├── dal.md           # new repos, forSchedulerProject, claim queries, join rule, locking order
│   └── env.md           # 16 new variables + cross-field rules
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
.env.example                         # + scheduler/tick/mock variables (contracts/env.md)
docker-compose.yml                   # + x-docket-env anchor, web healthcheck, worker service
package.json                         # + build:worker; build chains it
README.md                            # + "Running the scheduler" (3 ways) + health indicator
docs/adding-a-provider.md            # new (FR-014)
docs/decisions.md                    # + "002 — Scheduling engine" entries (FR-048)
drizzle/0001_*.sql + meta/           # generated migration

src/
├── worker.ts                        # worker entry → .next/standalone/worker.mjs
├── instrumentation.ts               # + startInProcessLoop() after runStartup()
├── app/
│   ├── api/internal/tick/route.ts   # POST → handleTickRequest
│   └── p/[projectSlug]/layout.tsx   # + <SchedulerHealth/> (quiet + banner)
├── components/shell/SchedulerHealth.tsx
├── lib/
│   ├── auth-gate.ts                 # + "/api/internal/" public prefix
│   ├── action-result.ts             # + ValidationIssuesError → "validation"
│   └── validation/scheduling.ts     # shared Zod: weekday, localTime, limits, post input, at
├── providers/
│   ├── types.ts, registry.ts, errors.ts, text.ts, validation.ts (+ *.test.ts)
│   └── mock/{index.ts,settings.ts,mock.test.ts}
└── server/
    ├── env.ts                       # + 16 variables, bool() helper, cross-field rules
    ├── auth/access.ts               # + account/slot/media/post statements (D20)
    ├── db/
    │   ├── schema/{accounts,media,posts,attempts,scheduler}.ts (+ index.ts exports)
    │   └── project-owned.ts         # + 7 tables, + scheduler_heartbeats
    ├── dal/
    │   ├── clock.ts, accounts.ts, slots.ts, media.ts, posts.ts, targets.ts, attempts.ts,
    │   │   scheduler.ts, heartbeats.ts, schema-ready.ts
    │   ├── scope.ts                 # ProjectScope + new repos
    │   ├── errors.ts                # + ValidationIssuesError
    │   └── index.ts                 # + exports
    ├── services/
    │   ├── accounts.ts, slots.ts, media.ts, scheduler-health.ts
    │   ├── queue/{index.ts,occurrences.ts,occurrences.test.ts}
    │   └── posts/{index.ts,status.ts,status.test.ts,content.ts}
    └── scheduler/
        ├── index.ts, config.ts, publishing.ts, record.ts, recovery.ts, limits.ts,
        │   backoff.ts, redact.ts, token-refresh.ts, loop.ts, in-process.ts, http.ts
        └── *.test.ts (pure units: backoff, limits, record, redact, loop, http)

tests/
├── helpers/{clock.ts,scheduling.ts}
└── integration/
    ├── queue/{allocation,concurrency,dst,actions,empty-slots}.test.ts
    ├── scheduler/{e2e,concurrency,recovery,backoff,ambiguous,limits,refresh,budget,stale-lease}.test.ts
    ├── posts/{lifecycle,status,retry-resolve,validation,isolation}.test.ts
    ├── accounts-slots.test.ts, tick-endpoint.test.ts, scheduler-health.test.ts, worker-schema-wait.test.ts
    └── no-plaintext.test.ts, scope-check.test.ts     # extended
```

**Structure Decision**: this is the same single Next.js app as 001, with the
same layering:

- `src/app` → `src/server/services` → `src/server/dal` → `src/server/db`.
- The new `src/server/scheduler` sits beside `services`. It calls the DAL (claims and records) and the pure parts of services (status derivation, content assembly), never `next/*`.
- `src/providers` is a leaf with no server imports, and both services (validation) and the scheduler (advance) consume it.

Integration tests live in `tests/`, and pure unit tests sit beside their modules.

## Implementation notes for the tasks phase

These are ordering and risk notes, not tasks.

1. **Order**:
   1. Env additions and the access statements.
   2. Schema + migration + registry, then the DAL repos and the clock. The registry test and scope recorder guard everything after this.
   3. Providers: types, text, validation, registry, mock. These are pure, and so is their test-first work.
   4. Queue: pure occurrences + DST tests, then allocation, then actions.
   5. Post services + status derivation.
   6. Scheduler: pure pieces (backoff, limits, record, redact), then claim/record, publishing, recovery, refresh, then `runTick`.
   7. Triggers: `runLoop`, worker + `build:worker`, the HTTP route + auth-gate, the in-process loop.
   8. Health indicator.
   9. Compose.
   10. Docs: adding-a-provider, README, decisions, `.env.example`.
2. **Test the DST rule first** (research F1). The polyfill's comment for `'compatible'` is misleading. If a test disagrees with F1, stop and record it rather than switching modes.
3. **The scope recorder will flag joins** that lack `a.project_id = b.project_id`. Write the DAL with that rule from the start. Run `scope-check.test.ts` early.
4. **Concurrency tests need real parallel connections.** The shared pool defaults to `DATABASE_POOL_MAX=10`. The 50-way queue test and the 5-tick test should create their own pool (`createDatabase(url, 20)`) or set the pool size for the test file. Do not lower the counts the spec asks for.
5. **Deadlocks**: follow dal.md "Locking order" exactly. In particular, the claim must not call `applyDerivedStatus` inside its own transaction.
6. **Build**: `worker.mjs` must not pull in `next/*`. If esbuild reports a `next` import, a scheduler/DAL module is importing UI or route code. Fix the import, not the bundle flags.
7. **The proxy**: add `/api/internal/` to the public prefixes *with* a test. Otherwise the endpoint silently 307s to `/login` (F15).
8. **Decisions log** (FR-048). Append condensed D1–D25, at least:
   - the DST rule;
   - backoff/attempt defaults and the meaning of `attempt_count`;
   - lease/recovery rules;
   - limit counting (both limits enforced; counts starts);
   - status derivation + `review_state`;
   - `chars` = code points;
   - `needs_reauth` with no transient retry;
   - the heartbeat being system-wide;
   - mock gating;
   - soft deletes;
   - "move to next" excluding the current occurrence;
   - the two extra env vars;
   - batch size 4 / refresh cap 5.
9. **Docs**:
   - README: "Running the scheduler" (worker / tick endpoint + cron example / in-process), plus what the stale banner means.
   - `docs/deployment.md` is the hardening entry's, not this one's.

## Complexity Tracking

No constitution violations to justify.
