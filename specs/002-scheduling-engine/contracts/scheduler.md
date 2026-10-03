# Contract: Scheduler tick, triggers and health indicator

Location: `src/server/scheduler/`. This code must not import `next/*`, because
it is bundled into `worker.mjs` outside Next (research D17). It reaches data
only through `src/server/dal/` (the lint ban applies).

```text
src/server/scheduler/
├── index.ts          # runTick(), TickSummary
├── config.ts         # schedulerConfig(env) → SchedulerConfig (+ overrides for tests)
├── publishing.ts     # publishing section: claim → advance → record
├── record.ts         # applyStepResult (pure: result + target → patch) + persistence via dal
├── recovery.ts       # expired-lease handling (D5)
├── limits.ts         # effective limits + deferral time (pure)
├── backoff.ts        # nextRetryAt (pure)
├── redact.ts         # redact(value, knownSecrets) (D16)
├── token-refresh.ts  # token-refresh section (D7, D22)
├── loop.ts           # runLoop() shared by worker and in-process loop
└── in-process.ts     # startInProcessLoop() (D18)
src/worker.ts         # worker entry (D17)
src/app/api/internal/tick/route.ts  # HTTP trigger (D19)
src/server/scheduler/http.ts        # handleTickRequest() (pure; imported by the route)
```

## `runTick(options?)`

```ts
export interface SchedulerConfig {
  timeBudgetMs: number;          // SCHEDULER_TICK_BUDGET_SECONDS × 1000 (default 20 000)
  maxItems: number;              // SCHEDULER_TICK_MAX_ITEMS (25)
  leaseMs: number;               // SCHEDULER_LEASE_SECONDS (300)
  providerTimeoutMs: number;     // SCHEDULER_PROVIDER_TIMEOUT_SECONDS (10)
  maxAttempts: number;           // PUBLISH_MAX_ATTEMPTS (5)
  backoffBaseMs: number;         // PUBLISH_BACKOFF_BASE_SECONDS (60)
  backoffMaxMs: number;          // PUBLISH_BACKOFF_MAX_SECONDS (3600)
  maxPublishDurationMs: number;  // PUBLISH_MAX_DURATION_HOURS (24)
  refreshWindowMs: number;       // TOKEN_REFRESH_WINDOW_HOURS (72)
  refreshMaxAccounts: number;    // constant 5
  batchSize: number;             // constant 4 (D6)
}

export interface TickSummary {
  tickId: string;                // uuid; stamped on every attempt row of this tick
  startedAt: string; durationMs: number;
  publishing: SectionResult<{
    claimed: number; done: number; continued: number; retried: number; failed: number;
    ambiguous: number; deferred: number; recovered: number; staleResults: number; released: number;
  }>;
  tokenRefresh: SectionResult<{ refreshed: number; failed: number }>;
}
type SectionResult<C> = { ok: true; counts: C } | { ok: false; counts: C; error: "section_failed" };

export function runTick(options?: { config?: Partial<SchedulerConfig>; lockTimeoutMs?: number }): Promise<TickSummary>;
```

Guarantees:

- **Bounded**: it returns within `timeBudgetMs` plus record/DB overhead. Provider calls only start when `now + providerTimeoutMs ≤ deadline` (D6). SC-004.
- **Concurrent-safe**: any number of concurrent `runTick` calls in any number of processes; no target is advanced twice (D4). SC-002.
- **Kill-safe**: a kill at any point leaves either an unleased target (nothing changed) or a leased one, which a later tick recovers after `leaseMs` (D5). SC-005.
- **No provider call inside a transaction**. Every transaction is short. Claim and record are separate transactions.
- **Never throws for a target**: per-target errors are recorded. A section-level crash marks only that section `ok: false` and skips its heartbeat. `runTick` itself throws only if the clock query fails (the DB is down).
- **Summary is counts only**: no content, ids of other projects, or secrets.

### Publishing section algorithm

```text
deadline = T0 + timeBudget; handled = ∅
loop while handled.size < maxItems:
  if clockNow() + providerTimeout > deadline: break
  CLAIM tx (crossProject "scheduler: claim due targets"):
    rows = due targets (D4 predicate, id ∉ handled) LIMIT min(batchSize, maxItems − handled) FOR UPDATE SKIP LOCKED
    accounts = their accounts FOR NO KEY UPDATE SKIP LOCKED   -- rows with an unlocked account are skipped
    for each row (ordered by next_attempt_at, id):
      handled += row.id
      provider = findProvider(account.provider_key)
      if row.in_flight_step != null:                      -- lease expired: recovery (FR-035)
        if row.in_flight_may_publish → ambiguous, attempt "recovered_ambiguous"; continue
        else attempt_count += 1, attempt "recovered_retry", clear in_flight;
             if attempt_count ≥ maxAttempts → failed; continue
             else fall through: the interrupted step is retried now, under a fresh lease
      if account removed | needs_reauth | provider missing → failed, attempt "account_unavailable"; continue
      if row.first_step_at and now − first_step_at > maxPublishDuration → failed "publishing did not complete", attempt "did_not_complete"; continue
      if row.step_state == null (first step): for each effective limit (D8):
           started = count(targets of account with publish_started_at > now − window)
           if started ≥ count → next_attempt_at = oldestStart + window, attempt "deferred"; skip
      step = provider.stepFor(row.step_state)
      lease: status='publishing', lease_owner=uuid(), lease_until=now+lease, in_flight_step=step.name,
             in_flight_may_publish=step.mayPublish, first_step_at ??= now, publish_started_at ??= now (first step)
  after commit: applyDerivedStatus per affected post, each in its own short tx (post lock → read targets; see dal.md locking order)
  for each leased row (parallel, ≤ batchSize):
    if clockNow() + providerTimeout > deadline: RELEASE (clear lease/in_flight, attempt "released"); continue
    load effective content + decrypt credentials (project-pinned DAL)
    result = race(provider.advance(ctx with AbortSignal.timeout(providerTimeout)), timeout)
             -- throw/timeout → mayPublish ? ambiguous : retryable_error (D5)
    RECORD tx (project-pinned): lock post; UPDATE target … WHERE id AND project_id AND lease_owner = token
             0 rows → attempt "stale_result" only (US2-AS4)
             else apply result (D9 table in contracts/providers.md), clear lease + in_flight, attempt row, applyDerivedStatus
  if the claim returned no rows: break
write heartbeat("publishing") on completion
```

The attempt row's `request_summary.lateBySeconds = max(0, now − scheduled_at)`
is set on a target's first step (edge case "late rather than never").

### Token-refresh section

```text
CLAIM tx (crossProject "scheduler: claim token refresh"): accounts where status='active' AND removed_at IS NULL
  AND credentials_encrypted IS NOT NULL AND credentials_expires_at <= now + refreshWindow
  AND provider_key = ANY($keysWithRefresh) AND (refresh_lease_until IS NULL OR refresh_lease_until < now)
  LIMIT 5 FOR UPDATE SKIP LOCKED → set refresh lease
for each (sequential, deadline-guarded): decrypt → provider.refreshCredentials({…, signal}) (throw = failure)
  RECORD tx (project-pinned, refresh_lease_owner = token):
    ok   → credentials re-encrypted, credentials_expires_at, last_refreshed_at, clear lease
    fail → status='needs_reauth', last_error=redact(reason), clear lease
  one account's failure never stops the others
write heartbeat("token_refresh") on completion
```

## `runLoop` (`loop.ts`), shared by the worker and the in-process loop

```ts
export function runLoop(opts: {
  tick: () => Promise<unknown>; intervalMs: number; signal: AbortSignal;
  log?: (line: string) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void>;
```

- It repeats `await tick()` then sleeps `intervalMs`, and resolves when `signal` aborts.
- An abort during a tick lets the tick finish. An abort during the sleep ends the sleep immediately.
- A tick that throws is logged (message only) and the loop continues.
- It logs one line per tick: `Docket scheduler: tick <ms>ms published=<n> failed=<n> ambiguous=<n> deferred=<n>`.

## Worker (`src/worker.ts`), FR-042

1. `parseEnv(process.env)`. On issues, print `formatEnvIssues` and exit 1.
2. **Wait for the schema** (D17): every 2 s, log at most every 30 s ("waiting for database schema…"). There is no timeout, because Compose restarts would only loop.
3. `AbortController`. `SIGTERM` / `SIGINT` call `abort()`. A second signal exits 1 immediately.
4. `await runLoop({ tick: () => runTick(), intervalMs: WORKER_INTERVAL_SECONDS × 1000, signal })`.
5. `await closeDb()` (through a DAL export), then exit 0.

Build: `"build:worker": "esbuild src/worker.ts --bundle --platform=node --target=node24 --format=esm --outfile=.next/standalone/worker.mjs --external:pg-native --banner:js=\"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\""`.
The `build` script becomes `next build && pnpm run build:prestart && pnpm run build:worker`.
Local run: `pnpm build && node .next/standalone/worker.mjs`.

## In-process loop, FR-044

`src/instrumentation.ts` gains the following. The loop is not awaited, so `register()`
completes before serving (F9):

```ts
await runStartup();
const { startInProcessLoop } = await import("./server/scheduler/in-process");
startInProcessLoop();   // no-op unless getEnv().RUN_WORKER_IN_PROCESS; globalThis guard (U2); SIGTERM aborts
```

## HTTP trigger: `POST /api/internal/tick`, FR-043

| Request | Response |
|---|---|
| `TICK_SECRET` unset | `404 {"error":"not_found"}`, no tick |
| no `Authorization` header, a non-`Bearer` scheme, or a wrong secret | `401 {"error":"unauthorized"}`, identical for every case, no tick (`WWW-Authenticate: Bearer`) |
| `Authorization: Bearer <TICK_SECRET>` | `200` with `TickSummary` JSON (`Cache-Control: no-store`) |
| tick throws (DB down) | `503 {"error":"tick_failed"}` |
| `GET` / other methods | `405`, Next's default for unexported methods (F10) |

- The comparison is `timingSafeEqual(sha256(given), sha256(secret))` (D19). The secret is never logged.
- Route file: `export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export async function POST(req) { return handleTickRequest(req, { secret: getEnv().TICK_SECRET, runTick }) }`.
- `src/lib/auth-gate.ts` `PUBLIC_PREFIXES` gains `"/api/internal/"` (F15). Without it, the proxy answers 307 → `/login`. `auth-gate.test.ts` gains a case for it.

Example cron: `curl -fsS -X POST -H "Authorization: Bearer $TICK_SECRET" https://docket.example.com/api/internal/tick`.

## Docker Compose, FR-045

```yaml
x-docket-env: &docket-env
  DATABASE_URL: postgres://docket:docket@postgres:5432/docket
  BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3000}
  BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?…}
  CREDENTIALS_ENCRYPTION_KEY: ${CREDENTIALS_ENCRYPTION_KEY:?…}
services:
  web:      # unchanged + environment: *docket-env + healthcheck:
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 10s
  worker:
    image: docket:local          # the image web builds; no build: of its own
    restart: unless-stopped
    command: ["node", "worker.mjs"]
    env_file: .env
    environment: *docket-env
    depends_on:
      web:
        condition: service_healthy   # web has applied migrations
```

The Dockerfile is unchanged: `worker.mjs` is inside `.next/standalone`. Its
header comment already describes the one-image design.

## Health indicator (UI), FR-047

- Component: `src/components/shell/SchedulerHealth.tsx`, a **server component**.
- It is rendered by `src/app/p/[projectSlug]/layout.tsx`:
  - the quiet form in the `SignedInHeader` `left` area next to the switcher;
  - the stale banner directly above `<main>`.
- Data comes from `services/scheduler-health.getSchedulerHealth(scope)`. It follows the `docket-ui` skill.

| State | Rendering |
|---|---|
| `ok` | small muted text: "Scheduler ran 40 s ago". A `<time dateTime=ISO title="Sat 3 Oct 2026, 14:05:10 Europe/London">` shows the absolute time in the project zone |
| `stale` | red banner, `role="alert"`: **"The scheduler last ran 2 hours ago. Scheduled posts are not going out."** Then a list of fixes: "Start the worker (`docker compose up -d worker`)", "or set `RUN_WORKER_IN_PROCESS=true` for the web service", "or call `POST /api/internal/tick` from a cron every minute with `TICK_SECRET`". The absolute time is shown as above |
| `never` | the same banner: **"The scheduler has never run. Scheduled posts will not go out."** + the same fixes |

- Text and colour are used together (never colour alone), with contrast ≥ 4.5:1.
- No secrets, threshold or other configuration values are shown. Mentioning env var *names* is guidance, not configuration.
- The banner is visible to every member.
- It is a server-rendered snapshot per page load (SC-010); no polling.
