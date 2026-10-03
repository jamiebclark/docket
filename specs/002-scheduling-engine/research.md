# Research: Scheduling Engine (002)

Phase 0 output for [plan.md](./plan.md). Sources are listed per item:

- `docs/research/*.md` (official sources, checked 2026-10-02);
- installed packages under `node_modules/` (read or run on 2026-10-03);
- entry 001's code.

Pipeline phases cannot fetch the web (constitution I). Anything not covered
here is marked **NEEDS RESEARCH** in the artifact that needs it. None is
needed for this feature: it has no real provider.

## Verified facts (F)

| # | Fact | Source / how verified |
|---|---|---|
| F1 | `Temporal.PlainDateTime.from(...).toZonedDateTime(tz, { disambiguation: "compatible" })` resolves a **gap** forward by the gap length and an **overlap** to the **earlier** instant. That is exactly the rule in FR-016. Run results: New York 2026-03-08 02:30 → 03:30-04:00 (07:30Z). New York 2026-11-01 01:30 → 01:30-04:00 (05:30Z, earlier). London 2026-03-29 01:30 → 02:30+01:00. London 2026-10-25 01:30 → 01:30+01:00 (earlier). Sydney 2026-10-04 02:30 → 03:30+11:00. Sydney 2026-04-05 02:30 → 02:30+11:00 (earlier). Lord Howe 2026-10-04 02:15 → 02:45+11:00 (30-minute gap, shifted 30 minutes). | Ran against `@js-temporal/polyfill` 0.5.1 on Node v24.16.0. The polyfill's JSDoc for `'compatible'` (`index.d.ts:65`) reads ambiguously, so **behaviour is pinned by tests**, not the comment. `docs/research/tooling.md` "Time zones" agrees |
| F2 | `ZonedDateTime.dayOfWeek` is ISO: 1 = Monday … 7 = Sunday | Temporal polyfill `index.d.ts` (`dayOfWeek`); used for `posting_slots.weekday` |
| F3 | Drizzle 0.45.3: `.for("update", { skipLocked: true })` renders `for update skip locked`. Also available: `noWait`, `of` | `drizzle-orm/pg-core/query-builders/select.types.d.ts:64-71`, `pg-core/dialect.js:301-302`; tooling.md |
| F4 | Drizzle index builder supports a partial predicate: `uniqueIndex(name).on(cols).where(sql\`…\`)` | `drizzle-orm/pg-core/indexes.d.ts:24,67` |
| F5 | Drizzle node-postgres nested `tx.transaction()` uses `savepoint spN` / `rollback to savepoint` | `drizzle-orm/node-postgres/session.js:206-219` |
| F6 | `Intl.Segmenter` (grapheme granularity) is available in Node 24 with full ICU. For `"👨‍👩‍👧‍👦" + "é"`: graphemes 2, code points 9, UTF-8 bytes 28 | Ran on Node v24.16.0 (`[...segmenter.segment(t)].length`, `[...t].length`, `Buffer.byteLength`) |
| F7 | `crypto.timingSafeEqual(a, b)` needs equal-length buffers (it throws otherwise) | `@types/node/crypto.d.ts:2517` |
| F8 | `AbortSignal.timeout(ms)` is a standard static | `typescript/lib/lib.dom.d.ts:2789` |
| F9 | Next 16.3.8 `instrumentation.ts` `register()` is called once per server instance and **must complete before the server handles requests**. Node-only code is imported conditionally on `process.env.NEXT_RUNTIME === "nodejs"` | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`, `…/02-guides/instrumentation.md:19,72` |
| F10 | Route handlers export named HTTP methods (`export async function POST(request: Request)`); config `runtime = 'nodejs'` and `dynamic` are available. Only exported methods are served | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:24-31,645-658` |
| F11 | esbuild (dev dependency, already used for `scripts/prestart.mjs`) bundles TypeScript and resolves the `@/*` tsconfig `paths` alias. The bundled output with `@js-temporal/polyfill` and `@/server/env` ran on Node 24 | Probe bundle built and executed on 2026-10-03 with the same flags as `build:prestart` (`--platform=node --target=node24 --format=esm --external:pg-native` + `createRequire` banner) |
| F12 | Neon's pooler is PgBouncer in transaction mode. `FOR UPDATE SKIP LOCKED` inside transactions works; session features (advisory locks, LISTEN) do not | `docs/research/tooling.md` "Postgres / Neon" |
| F13 | Platform limits the future provider entries will declare: Instagram 100 API posts / account / rolling 24 h; Threads 250 posts / 24 h. Bluesky text limit is 300 **graphemes**; up to 4 images ≤ 2,000,000 bytes | `docs/build-prompt.md` "Platform notes" + `docs/research/meta.md`, `bluesky.md` (input to the capability contract only) |
| F14 | Entry 001 provides these, and they are reused: `forProject` / `crossProject` (`src/server/dal/scope.ts`); `projectOwnedTables` / `notProjectOwned` (`src/server/db/project-owned.ts`) + registry test; the SQL scope recorder (`tests/setup/scope-recorder.ts`); `encryptSecret` / `decryptSecret` with optional AAD (`src/server/crypto/secrets.ts`); Zod env with `int()` helper and cross-field issues (`src/server/env.ts`); `createAccessControl` statements (`src/server/auth/access.ts`); `runStartup()` from `instrumentation.ts`; the prestart esbuild bundle (decision #20); the ESLint db-import ban (`eslint.config.mjs`) | Read in the repo |
| F15 | The proxy (`src/proxy.ts` → `src/lib/auth-gate.ts`) redirects every non-public path without a session cookie to `/login`. Only `/api/auth/`, `/api/health`, `/login`, `/setup`, `/signup` are public. **`/api/internal/tick` must be added to `PUBLIC_PREFIXES`**, or every cron call becomes a 307 to `/login` | `src/lib/auth-gate.ts:4-11` |
| F16 | The scope recorder pins a table reference only through `alias.scope_col = $n` or a `scope_col = scope_col` link to an already-pinned reference. It treats `or` / `not` in a WHERE as unpinned. So **every join between two project-owned tables must include `a.project_id = b.project_id`**, and the claim query (which deliberately spans projects) must run inside `crossProject(reason)` | `tests/helpers/scope-check.ts` |

## Unknowns carried forward (U)

| # | Unknown | Handling |
|---|---|---|
| U1 | The Neon half of the deployment story (claiming through the transaction-mode pooler) | Not verifiable without a Neon URL. Report "not verified" (constitution II), as 001 U3 did. The design uses only transaction-scoped locks |
| U2 | Under `next dev`, whether `register()` runs more than once per process (HMR) when `RUN_WORKER_IN_PROCESS=true` | Guarded with a `globalThis` flag so a second `register()` never starts a second loop. Verify by observing one heartbeat cadence in `next dev` (quickstart §6). A double loop would be safe anyway (claims are concurrency-safe), just wasteful |
| U3 | Whether Docker is available to the build environment for SC-013 | Quickstart §7. If Docker is unavailable, report SC-013 "not verified" and cover the worker by running `node .next/standalone/worker.mjs` against local Postgres |

## Decisions (D)

### D1 — One clock: the database's, overridable in tests
- **Decision**: `src/server/dal/clock.ts` exports `now(): Promise<Date>`. In production it runs `select clock_timestamp()` (one round trip per operation).
  - `runTick` reads it once at start (T0) and then uses `T0 + (performance.now() − m0)`.
  - Every comparison (due-ness, lease expiry, backoff, limit windows, "after now" for allocation, past-time refusal) passes that value as a **parameter**. SQL `now()` is never used in predicates.
  - Tests override the clock with `atTime(date, fn)`, an `AsyncLocalStorage` override like `runCrossProject`. Inside it, `now()` returns the fixed date.
- **Rationale**: FR-040 / edge case "clock skew" requires the DB clock. Tests must "advance the clock past the slot time" deterministically. A parameterised `$now` serves both, and ALS keeps service signatures clean (`(scope, input)`, as in 001).
- **Alternatives**: SQL `now()` in predicates was rejected: untestable without sleeping, and in a transaction it is the transaction start time. Process `Date.now()` was rejected: it violates the skew rule. A `now` parameter on every service was rejected: it leaks test plumbing into callers.

### D2 — DST rule via `disambiguation: "compatible"` (F1)
- **Decision**: one pure function, `resolveOccurrence(date: PlainDate, time: PlainTime, timeZone) → Instant`, using `PlainDateTime.toZonedDateTime(tz, { disambiguation: "compatible" })`. Two slots that resolve to the same instant on one account collapse into **one** occurrence (dedupe by epoch ms). Tests cover New York, London and Sydney (southern hemisphere), plus Lord Howe (30-minute gap), on both transitions. Logged in `docs/decisions.md`.
- **Alternatives**: `'earlier'` was rejected: it moves gap times *backwards* (02:30 → 01:30). `'reject'` was rejected: it would make queueing fail twice a year. Hand-rolled offset maths was rejected: the constitution forbids it.

### D3 — An occurrence is "held" by a column on the target, backed by a partial unique index
- **Decision**: `post_targets.slot_occurrence_at timestamptz` (plus `slot_id` for display) and a partial unique index `post_targets_occurrence_uq ON (social_account_id, slot_occurrence_at) WHERE slot_occurrence_at IS NOT NULL`. **Freeing = setting the column to NULL** (cancel, delete, move, account removal).
  - Allocation computes the earliest candidate that is not held and tries to take it inside a **savepoint** (F5).
  - On `23505` (unique violation) it marks that instant held and tries the next one, up to the candidate count within the horizon.
  - Concurrent writers block on the uncommitted index entry, and the loser gets `23505` after the winner commits, so no request fails because of the race.
- **Rationale**: FR-018 requires a DB guarantee. A column plus an index needs no extra table, and the "slot occurrence" entity stays virtual, as the spec's Key Entities state.
- **Alternatives**: a separate `slot_occurrences` table was rejected: more writes, and the same guarantee. A unique *constraint* (deferrable) was rejected: it can't be partial, and swap is solved without deferral (D10). `SELECT … FOR UPDATE` on the account was rejected: it is application-level only.

### D4 — Claiming: short transaction, `SKIP LOCKED` on targets *and* accounts, per-claim lease token
- **Decision**: the claim transaction runs inside `crossProject("scheduler: claim due targets")`:
  1. Select up to *k* rows where `status IN ('scheduled','publishing') AND next_attempt_at <= $now AND (lease_until IS NULL OR lease_until < $now) AND id <> ALL($alreadyHandledThisTick)`, ordered by `next_attempt_at, id`, with `FOR UPDATE SKIP LOCKED`.
  2. Lock the distinct accounts of those rows with `FOR NO KEY UPDATE SKIP LOCKED`. Targets whose account is locked elsewhere are left untouched until a later round or tick.
  3. Per target, decide one of: recover, fail (account unavailable or max duration), defer (limit), or **lease**.
  4. To lease a target: `lease_owner = gen_random_uuid()` (a token per claim, not per process), `lease_until = $now + lease`, `status = 'publishing'`, `in_flight_step`, `in_flight_may_publish`, `publish_started_at` (first step only).
  5. Commit.

  Results are recorded later by `UPDATE … WHERE id = $1 AND project_id = $2 AND lease_owner = $token`. Zero rows means the lease was lost. The result is then written to `publish_attempts` as `stale_result` and is not applied (FR-031, US2-AS4).
- **Rationale**:
  - Because the claim never *waits* on a lock and takes no post lock, a claim can't deadlock with service transactions (cancel, remove account), which lock post → targets / account → posts → targets. Post status is re-derived after the claim commits, in its own short transaction (contracts/dal.md "Locking order").
  - The account lock serialises limit counting per account across ticks (D8).
  - Excluding ids already handled means each tick advances a target at most once (US1-AS5).
- **Alternatives**: a blocking `FOR UPDATE` on accounts was rejected: it can deadlock with `removeAccount`. Advisory locks are ruled out by the constitution and Neon. `UPDATE … RETURNING` without SKIP LOCKED was rejected: concurrent ticks would serialise.

### D5 — Step safety is declared by the provider and stamped at claim time
- **Decision**: the provider contract has `stepFor(state | null): { name: string; mayPublish: boolean }`. At claim time, the engine stores `in_flight_step` / `in_flight_may_publish` on the target.
  - **Recovery** (lease expired while `in_flight_step` is set): if `mayPublish`, the target becomes `ambiguous` (`recovered_ambiguous`). Otherwise it counts an attempt and the step is retried in the same claim (`recovered_retry`), or the target fails when the cap is reached.
  - **Provider throws, or the engine timeout fires**: `mayPublish` → `ambiguous`; otherwise it is treated as `retryable_error`.
  - After a recorded result, `in_flight_*` is cleared.
- **Rationale**: FR-011, FR-035 and the edge cases "provider throws" and "call hangs". The engine never guesses which call could have gone public.
- **Alternatives**: a static `unsafeSteps: string[]` was rejected: equivalent, but `stepFor` also names the step for the attempt log. Treating every interrupted step as ambiguous was rejected: it would strand harmless "create container" steps.

### D6 — Bounded tick: deadline guard, small parallel batches, release of unstarted work
- **Decision**: `deadline = start + SCHEDULER_TICK_BUDGET_SECONDS` (default 20).
  - The publishing section loops: claim a batch of `min(4, itemsLeft)`, run the batch's provider calls concurrently (`Promise.allSettled`), record each result, repeat.
  - A provider call **starts only if `now + SCHEDULER_PROVIDER_TIMEOUT_SECONDS ≤ deadline`**. Otherwise the target's lease is released (lease cleared, nothing else changed, no attempt counted).
  - Each call gets `AbortSignal.timeout(providerTimeout)` plus an engine-side race on the same timeout.
  - The loop stops when there is no due work, the item budget (default 25) is used, or the deadline guard trips.
  - Env validation enforces `LEASE > BUDGET + PROVIDER_TIMEOUT` and `PROVIDER_TIMEOUT < BUDGET`.
- **Rationale**: SC-004 (returns within budget even with 1,000 due targets and a slow provider) and FR-031 (the lease outlives any live call). The batch concurrency of 4 is a constant, recorded in decisions: Docket is small-scale, and a pool of 10 must also serve the refresh section and the web app.
- **Alternatives**: claim-all-then-process was rejected: it holds leases on work that can't start before the deadline. Fully sequential processing was rejected: one slow provider would starve the tick.

### D7 — Tick sections run concurrently under the shared deadline
- **Decision**: `runTick` runs `publishing` and `token_refresh` with `Promise.allSettled`, under the same deadline. Each section catches its own failures, and each writes its own heartbeat (`scheduler_heartbeats.section`) **only when it completes** (FR-039).
  - Token refresh claims at most 5 accounts per tick, through `refresh_lease_until` / `refresh_lease_owner` with `FOR UPDATE SKIP LOCKED` (same pattern as D4).
  - It considers only `status = 'active'` accounts with `credentials_expires_at <= $now + TOKEN_REFRESH_WINDOW_HOURS` whose provider defines `refreshCredentials`.
- **Rationale**: FR-037 requires "own share of the budget" and that failures in one section don't stop the other. Concurrency gives each section the full wall-clock budget without one starving the other.
- **Alternatives**: running the sections sequentially with a fixed split was rejected: idle reserve time is wasted, and the code is more complex.

### D8 — Publish limits: enforce every applicable limit; count publishes *started*
- **Decision**:
  - The provider declares `defaultPublishLimit?: { count, windowSeconds }`. The account may set `publish_limit_count` + `publish_limit_window_seconds`.
  - The engine enforces **both** when both exist, which is how "the stricter one applies" (FR-001, US5-AS2) even when the windows differ.
  - A target "starts" when its first step is leased (`publish_started_at = $now`). That is counted per account over `publish_started_at > $now − window`, so in-flight targets count, and so do started targets that later failed (conservative).
  - Excess targets get `next_attempt_at = (oldest start in window) + window`, with no attempt counted and no provider call, and log one `deferred` attempt row.
  - Because both limits are enforced, an account limit looser than the provider default has no effect. It is accepted, and the service returns a warning saying so.
- **Rationale**: FR-036 and SC-009 under concurrency. The account row lock (D4) makes count-then-start atomic per account.
- **Alternatives**: counting only `published` was rejected: in-flight targets could overshoot. A token bucket table was rejected: more state for no gain at this scale.

### D9 — Retry, backoff and attempt counting
- **Decision**:
  - `attempt_count` is the number of **failed** attempts at the current step: retryable errors and lease recoveries that retry. It resets to 0 after a `continue`.
  - Backoff: `delay = min(BASE × 2^(attempt_count−1), MAX)` (defaults 60 s / 3600 s, no jitter), and `next_attempt_at = max($now + delay, notBefore)`.
  - When `attempt_count` reaches `PUBLISH_MAX_ATTEMPTS` (default 5), the target becomes `failed` with the last error.
  - A retryable error before any step completed returns the target to `scheduled`. After a step completed, it stays `publishing` (between steps, unleased).
  - **Retry** (user action, `failed` only): `attempt_count = 0`, `step_state = NULL`, `first_step_at = NULL`, `next_attempt_at = $now`, `status = 'scheduled'`, `last_error = NULL`. It is refused while the account is `needs_reauth` or its provider is unregistered.
  - Multi-step maximum: if `first_step_at + PUBLISH_MAX_DURATION_HOURS < $now` at claim time, the target becomes `failed` ("publishing did not complete"). No provider call is made, and nothing is in flight.
- **Rationale**: FR-033, FR-041, US3-AS1/2/6, SC-008. Predictable times make the tests exact (spec assumption: no jitter).

### D10 — Queue actions keep the index as the single guard
- **Move to next free slot**: in one transaction, lock the post, then take the earliest free occurrence after `$now`, **excluding the one the target already holds**, then release the old one. For an explicit target, it is simply the earliest free occurrence. If no other occurrence is free, the target is left unchanged and a clear message is returned.
- **Swap**: lock both targets (ordered by id), then: set A's occurrence to NULL, set B to A's old instant, set A to B's old instant, all inside one transaction. A third transaction trying to take either instant blocks on the uncommitted index entry, then gets `23505` and moves on. No deferrable constraint is needed. Different accounts, or a target that is not queued (`status='scheduled' AND schedule_kind='slot'`), are refused.
- **Pull forward**: lock the account's queued targets (`status='scheduled' AND schedule_kind='slot' AND scheduled_at > $now`) in `scheduled_at` order and clear their occurrences. Then each target in turn takes the earliest free occurrence after the previous assignment. Because their own old instants are in the candidate set, no target moves later (FR-021). Explicit and in-flight targets are untouched.
- **Explicit-time warning**: any queued target on the same account with `|scheduled_at − at| ≤ EXPLICIT_TIME_WARNING_MINUTES`. The service returns warnings and the schedule still succeeds.
- **Rationale**: FR-020–FR-023, US4-AS5–10. "Move to next" excludes the current instant so the action always visibly does something. Logged as a decision.

### D11 — Post status: `review_state` stored, `status` derived
- **Decision**:
  - `posts.review_state` (`draft | needs_review | approved`) is the editorial state. `posts.status` is **derived and stored**, re-computed in the same transaction as every target change, under a `posts` row lock taken first as its own statement (the same pattern as 001's lock-then-read).
  - `derivePostStatus(reviewState, targetStatuses)` is pure and implements FR-029 exactly. Live targets exclude `draft` and `cancelled`; `ambiguous` counts as not published.
  - When a cancel leaves no live targets, `review_state` becomes `draft` (spec: "all-cancelled returns to draft").
- **Rationale**: list filters (entry 3) need a stored status, and the lock makes the derivation race-free across targets of one post published by parallel ticks.
- **Alternatives**: computing status at read time was rejected: the post list would need to aggregate on every query, and the services couldn't check status transitions.

### D12 — Soft deletes keep the append-only log intact
- **Decision**:
  - `posts.deleted_at` and `social_accounts.removed_at`. Deleting a post cancels its targets and frees their occurrences. It is refused if any target is `publishing`, `published` or `ambiguous` (an ambiguous target may be public).
  - Removing an account cancels its unpublished targets (refused while one is leased mid-call), frees their occurrences, and wipes its credentials. Published history stays.
  - Removing a draft post's target account deletes the target row only if it has no attempts; otherwise the target is cancelled.
  - DAL repositories exclude soft-deleted rows by default.
- **Rationale**: FR-006 says attempts are never deleted by the application, and the spec says "published history is kept". A hard delete would cascade into `publish_attempts`.

### D13 — Provider contract shape (refines the brief's sketch)
- **Decision** (details in [contracts/providers.md](./contracts/providers.md)):
  - `SocialProvider` = `key`, `displayName`, `capabilities`, `defaultPublishLimit?`, `connect` (`{ strategy: "oauth" | "credentials" | "manual-token" | "mock" }` descriptor), `settingsSchema` (Zod, non-secret per-account settings), `refreshCredentials?`, `validate(content, capabilities)`, `stepFor(state)` and `advance(ctx)`.
  - `StepResult` is the brief's five kinds, with optional `summary: { request?, response? }` for the attempt log.
  - The registry is one array literal in `src/providers/registry.ts`.
- **Mock connect**: the input names `oauth | credentials | manual-token`. The mock declares `credentials` with an empty field list, and its connect is a service function (`accounts.connectMock`) gated by `MOCK_PROVIDER_ENABLED`. The strategy union is not widened.
- **Rationale**: FR-010–FR-015; adding a provider stays "one folder + one registry line". `settingsSchema` lets providers keep per-account options (the mock's behaviour now, a Bluesky PDS URL later) without schema changes.

### D14 — Text counting: graphemes, code points, UTF-8 bytes
- **Decision**: `src/providers/text.ts` exports `countGraphemes` (`Intl.Segmenter`, F6), `countCodePoints` (`[...s].length`), `countUtf8Bytes` (`Buffer.byteLength(s, "utf8")`) and `countText(s, rule)`. The rule `"chars"` in the input means **code points**, not UTF-16 units (spec assumption), so the capability enum is `"graphemes" | "code_points" | "utf8_bytes"`. Logged as a decision.

### D15 — Validation: shared baseline + provider-specific checks
- **Decision**: `validateAgainstCapabilities(content, capabilities)` in `src/providers/validation.ts` covers these, each with severity, code, message, field and numbers:
  - text over the limit (counted by the provider's rule);
  - too many images;
  - disallowed mime type;
  - file too large;
  - media required;
  - text-only not allowed;
  - unsupported post type (inferred: no media → `text`, one → `image`, several → `carousel`);
  - missing alt text (a warning).

  Each provider's `validate` calls it and appends its own issues. Services refuse error-level issues; warnings never block (FR-027).

### D16 — Credentials and redaction
- **Decision**:
  - Credentials are a provider-defined JSON object, stored as `encryptSecret(JSON.stringify(c), { aad: "social_account:" + id })`. The AAD binds a ciphertext to its row.
  - Only the engine decrypts, immediately before `advance` / `refreshCredentials`, and hands the plain object to the provider via `ctx`.
  - Every attempt summary and error message passes through `redact(value, knownSecrets)` before it is stored. `redact` drops keys matching `/token|secret|password|authorization|cookie|credential|session/i` and replaces any string containing a known credential value with `"[redacted]"`.
  - Account records returned to callers expose `hasCredentials` and `credentialsExpireAt` only.
- **Rationale**: constitution VII and SC-012. Redaction is defence in depth on top of the provider rule in the guide.

### D17 — Worker entry and build
- **Decision**:
  - `src/worker.ts` is bundled by esbuild (F11) to `.next/standalone/worker.mjs` by a new `build:worker` script chained after `build:prestart`, so the existing Dockerfile `COPY .next/standalone` already ships it.
  - Start-up: validate env (print issues and exit 1, as `runStartup` does). Then **wait for schema**: probe `select … from post_targets limit 0` and `scheduler_heartbeats`, retry every 2 s on SQLSTATE `42P01` / `42703` or connection errors, and log once per 30 s.
  - Then run `runLoop({ tick: runTick, intervalSeconds: WORKER_INTERVAL_SECONDS, signal })`.
  - `SIGTERM` / `SIGINT` abort the sleep; the current tick finishes, then the worker closes the pool and exits 0.
  - The worker never migrates; the web service does.
  - `scripts/` and `src/server/scheduler/**` must not import `next/*` (they are bundled outside Next).
- **Compose**:
  - New `worker` service: `image: docket:local` (the same image `web` builds; no `build:` of its own), `command: ["node", "worker.mjs"]`, the same env (shared through a YAML anchor), and `depends_on: web: condition: service_healthy`.
  - `web` gains a healthcheck: `node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`. The slim image has no curl.
- **Alternatives**: Node type-stripping (`node src/worker.ts`) was rejected: no alias resolution, and the pnpm standalone `node_modules` is incomplete (decision #20). A separate Dockerfile target was rejected: the spec wants one image.

### D18 — In-process loop
- **Decision**: `instrumentation.ts` runs `runStartup()` (unchanged). If the env sets `RUN_WORKER_IN_PROCESS=true`, it then calls `startInProcessLoop()` **without awaiting** it, because `register()` must return before the server serves (F9). The loop is the same `runLoop`, first tick deferred by `setTimeout(…, 0)`. A `globalThis.__docketWorkerLoop` guard prevents a second loop (U2), and `SIGTERM` stops it after the current tick. Default off.

### D19 — Tick endpoint
- **Decision**:
  - `POST /api/internal/tick` with `Authorization: Bearer <TICK_SECRET>`.
  - `TICK_SECRET` unset → **404** `{ error: "not_found" }`, so the endpoint is disabled and its existence is not revealed.
  - Missing or wrong secret → **401** `{ error: "unauthorized" }` with the same body and the same code path.
  - The comparison is `timingSafeEqual(sha256(given), sha256(secret))`. Hashing first gives equal lengths (F7), so the length is not leaked.
  - Correct secret → runs one `runTick()` and returns **200** with the summary (counts only).
  - The handler logic lives in `handleTickRequest(request, deps)`, a pure function with injected `secret` and `runTick`, so tests avoid the memoised env. The route file wires the real deps, sets `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
  - Add `/api/internal/` to `PUBLIC_PREFIXES` (F15). `TICK_SECRET` must be ≥ 32 characters (FR-043).
- **Alternatives**: a query-string secret was rejected: it leaks into access logs.

### D20 — Roles: new access-control statements
- **Decision**: extend `statements` with `account: ["view","manage"]`, `slot: ["view","manage"]`, `media: ["view","edit"]`, `post: ["view","edit","schedule","delete"]`.
  - owner/admin: everything.
  - editor: `account:view`, `slot:view`, `media:*`, `post:*`.

  Services check with `requirePermission`, and transactions re-check inside, as `updateSettings` does. The scheduler does not use roles (it is not a member). Its cross-project claim is the sanctioned `crossProject` path (FR-008).

### D21 — Mock provider behaviour and gating
- **Decision**:
  - The mock is registered always, so existing mock accounts keep publishing.
  - `MOCK_PROVIDER_ENABLED` (default `true` unless `NODE_ENV=production`) controls whether `connectMock` is allowed and whether the mock is listed in `listConnectableProviders`.
  - Behaviour lives in `social_accounts.settings` (validated by the mock's `settingsSchema`): `behaviour: succeed | multi_step | retryable | fatal | ambiguous | rate_limited | throw`, with options `steps` (multi-step continues, default 1), `failTimes` (retryable for the first N attempts; omitted means always), `retryAfterSeconds` (rate_limited `notBefore`), `delayMs` (slow provider for SC-004) and `refresh: succeed | fail`.
  - Steps: single-step `publish` (`mayPublish: true`). Multi-step `create_container` ×N (`mayPublish: false`) then `publish` (`mayPublish: true`).
  - `connectMock` can optionally store fake credentials with an expiry (`simulateCredentialExpiryHours`) so the refresh section can be tested. The fake token is random and is encrypted like real credentials, which lets SC-012 scan for it.

### D22 — Token refresh failure handling
- **Decision**: any failure from `refreshCredentials` (it throws or returns `{ ok: false }`) sets `status = 'needs_reauth'` and `last_error` = the redacted reason. There is no automatic retry. Due targets on that account then fail with "Reconnect <account> to publish" (FR-038) without a provider call. They can be retried after reconnection; `saveConnectedAccount` for the same external id reactivates the account.
- **Alternatives**: a transient-retry window before flagging was deferred to the provider entries if a platform needs it, and logged with its reversal path.

### D23 — Heartbeat is the one system-wide table
- **Decision**: `scheduler_heartbeats(section text primary key, last_success_at, last_summary jsonb, updated_at)` is listed in `notProjectOwned`. The section values are `publishing` and `token_refresh`; the generator adds `generation` later. Writes are an upsert at section completion with the clock's `now`. The indicator reads `publishing` only (US6-AS5) and compares it with `SCHEDULER_STALE_AFTER_MINUTES`.

### D24 — Service shapes for partial success
- **Decision**: actions that touch several targets (`addToQueue`, `scheduleAt`, `publishNow`, `previewQueue`) **return per-target results** (`{ targetId, accountId, ok: true, … } | { ok: false, code, message, issues? }`) instead of throwing, because one target's failure must not block the others (US4-AS4).
  - Whole-request errors still throw the 001 error classes (`NotFoundError`, `ForbiddenError`, `ConflictError`).
  - One new class, `ValidationIssuesError`, carries issues for single-target actions.
  - Per-target codes: `no_active_slots`, `no_free_occurrence`, `validation`, `not_queueable`, `account_unavailable`, `in_past`.

### D25 — No new dependencies
- **Decision**: everything uses the installed stack: Temporal polyfill, Drizzle, Zod, `node:crypto`, `Intl.Segmenter`, and esbuild (already a dev dependency, used the same way as decision #20). No queue, no Redis, no cron library.
