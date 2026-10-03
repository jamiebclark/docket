# Quickstart: validating the scheduling engine (002)

This is a run guide that proves the feature works end to end. Contracts
define the behaviour: [scheduler](./contracts/scheduler.md),
[services](./contracts/services.md), [providers](./contracts/providers.md),
[DAL](./contracts/dal.md), [env](./contracts/env.md). The tables are in the
[data model](./data-model.md). Nothing here needs real social accounts: every
publish goes through the `mock` provider (constitution II).

## Prerequisites

- Node 24 (`>=24.10 <25`), pnpm, dependencies installed (decision #19; nothing new for this feature).
- A test Postgres. Locally, use the `docket-pg` container on **5433** (decision #21):
  `docker run -d --name docket-pg -e POSTGRES_USER=docket -e POSTGRES_PASSWORD=docket -p 5433:5432 postgres:17`
- `export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test`

## 1. Quality gates (CI parity)

```bash
pnpm lint && pnpm typecheck && pnpm db:check && pnpm test && pnpm build
```

Expected:

- all pass;
- `pnpm db:check` reports no drift, so the new migration is committed;
- `pnpm build` produces `.next/standalone/server.js`, `.next/standalone/scripts/prestart.mjs` **and** `.next/standalone/worker.mjs`.

## 2. Targeted test suites (each maps to a required test)

```bash
pnpm vitest run src/providers                      # text counters, validation, mock behaviours, registry
pnpm vitest run src/server/services/queue          # occurrence maths + DST (no DB)
pnpm vitest run tests/integration/queue            # allocation, concurrency, free/reuse, move/swap/pull, empty slots
pnpm vitest run tests/integration/scheduler        # claims, recovery, backoff, ambiguous, limits, refresh, budget, e2e
pnpm vitest run tests/integration/posts            # status derivation, retry, resolve, cancel/delete rules, validation refusal
pnpm vitest run tests/integration/tick-endpoint.test.ts tests/integration/scheduler-health.test.ts
pnpm vitest run src/server/db/project-owned.test.ts tests/integration/scope-check.test.ts tests/integration/no-plaintext.test.ts
```

| Scenario | Proves | Expected |
|---|---|---|
| e2e: connect mock → slot Mon 09:00 → draft → `previewQueue` → `addToQueue` → `atTime(slot + 1 s, runTick)` | US1, SC-001 | post `published`; target has `external_id`, `external_url`; attempt rows `done` with `lateBySeconds` |
| multi-step mock (`steps: 2`), 3 ticks | US1-AS5 | one step per tick; `publishing` between; `published` after the 3rd |
| 5 concurrent `runTick` over 200 due targets, ×20 | US2-AS1, SC-002 | each target exactly one `done` attempt; 0 duplicates |
| claim then abandon; `atTime(+lease+1 s)` tick; both step kinds | US2-AS3, SC-005 | `create_container` → retried (`recovered_retry`); `publish` → `ambiguous` (`recovered_ambiguous`) |
| a stale record after lease takeover | US2-AS4 | target state unchanged; a `stale_result` attempt row |
| 1,000 due targets, `delayMs` slow mock, budget 3 s / timeout 1 s (config override) | US2-AS2, SC-004 | `durationMs ≤ 3 000` + overhead; unstarted claims `released`; rest handled by later ticks |
| retryable ×N with controlled clock | US3-AS1/2, SC-008 | retries at +60, +120, +240, +480 s; `failed` after the 5th |
| `rate_limited` mock | US3-AS1 | `next_attempt_at = max(backoff, notBefore)` |
| fatal / ambiguous / throw on the publish step | US3-AS3/4, SC-006 | `failed` at once / `ambiguous` and never called again over 10 further ticks |
| two targets, one published, one fatal → retry the failed one | US3-AS5/6 | post `partially_failed`, then `published`; the published target gets no new attempt |
| resolve ambiguous → failed → retry; resolve → published | US3-AS7 | as in data-model rules |
| 50 concurrent `addToQueue` for one account, ×20 | US4-AS1, SC-003 | 50 distinct occurrences; none fail; 0 duplicates |
| DST: New York, London, Sydney, Lord Howe on both transitions | US4-AS2/3, SC-007 | instants as in research F1; the overlap yields one occurrence |
| cancel → re-queue another post | US4-AS5/6 | the freed occurrence is reused; nothing else moved |
| move / swap / pull forward / empty-slot listing / near-time warning / past time | US4-AS7–13 | as in contracts/services.md |
| limit N=3 per 24 h, 6 due | US5-AS1/2, SC-009 | 3 `done`, 3 `deferred` to oldest start + 24 h; no attempt counted |
| refresh succeed / fail; `needs_reauth` target | US5-AS3–5 | new expiry, still `active` / `needs_reauth`, other accounts unaffected / target `failed` "Reconnect…" without a provider call |
| secret scan | US5-AS6, SC-012 | the fake mock token appears in no attempt row, error, `listAccounts` output, tick summary or rendered shell HTML |
| scope-check over every new repo + registry test | FR-008 | 0 violations; the scheduler claim appears only under its `crossProject` reasons |

## 3. Tick endpoint (manual, against the dev server)

```bash
export TICK_SECRET=$(openssl rand -base64 32)
pnpm dev   # separate terminal, with the same env
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/internal/tick                                  # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer wrong" http://localhost:3000/api/internal/tick # 401
curl -s -X POST -H "Authorization: Bearer $TICK_SECRET" http://localhost:3000/api/internal/tick                           # 200 + summary JSON
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/internal/tick                                          # 405
```

Restart without `TICK_SECRET`: the POST returns **404**. None of these
responses is a 307 to `/login`; if one is, `/api/internal/` is missing from
the public paths.

## 4. Worker process (no Docker)

```bash
pnpm build
node .next/standalone/worker.mjs     # env as for the web app; WORKER_INTERVAL_SECONDS=30
```

Expected:

- one log line per tick;
- the `scheduler_heartbeats` rows for `publishing` and `token_refresh` advance;
- `Ctrl-C` during the sleep exits 0 at once;
- during a tick, the worker finishes it first.

Against an empty database it logs "waiting for database schema…", and it
starts ticking once the web app has migrated.

## 5. Health indicator

Sign in, open any `/p/<slug>`:

- **fresh heartbeat**: quiet "Scheduler ran … ago" with the absolute time in the project zone as the tooltip;
- **stop the worker for longer than `SCHEDULER_STALE_AFTER_MINUTES`** (or delete the `publishing` row): a red banner announced as an alert, with the three fixes;
- **a fresh database**: "never run".

`tests/integration/scheduler-health.test.ts` renders all three states.

## 6. In-process loop

Run `RUN_WORKER_IN_PROCESS=true pnpm dev`, or use `pnpm start` from the
standalone build. The heartbeat advances every `WORKER_INTERVAL_SECONDS` with
no worker running. Check that only one tick line appears per interval
(research U2). With the flag unset, no heartbeat advances.

## 7. Docker Compose (SC-013)

```bash
cp .env.example .env   # fill BETTER_AUTH_SECRET and CREDENTIALS_ENCRYPTION_KEY
docker compose up --build
```

Expected:

- `postgres`, `web` and `worker` start, all from `docket:local`;
- the worker waits for `web` to be healthy;
- within 2 minutes the project shell shows a recent tick.

Behind the owner's TLS-intercepting proxy, pass the `extra_ca` build secret
(tooling.md). If Docker is unavailable in the build environment, report SC-013
as **not verified** and rely on §4 (research U3).

## Not verifiable here

- **Neon** (transaction-mode pooler): needs a Neon URL (research U1). Report "not verified".
- **Real providers**: out of scope. The provider entries prove them with mocked HTTP.
