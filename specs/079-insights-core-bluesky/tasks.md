---

description: "Task list template for feature implementation"
---

# Tasks: Post and account insights, with Bluesky as the pilot platform

**Input**: Design documents from `/specs/079-insights-core-bluesky/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Requested throughout the spec and plan (quickstart.md names the test files directly) — every phase below includes its test tasks, written to run and fail before the implementation task that follows them.

**Organization**: Tasks are grouped by user story per spec.md's priorities (US1 P1, US2 P2, US3 P2, US4 P3). Per the project's own "park the human task last" rule (spec "Task ordering note for planning", plan.md "Task ordering note for Phase 2"), the one task needing a live Bluesky account and a browser is placed at the very end even though it would otherwise run early to verify US2 — nothing else waits on it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US4)
- Exact file paths are given in every task

---

## Phase 1: Setup

**Purpose**: Env knobs every later phase reads.

- [X] T001 Add `INSIGHTS_READ_PAGE_SIZE` (int 1–100, default 25), `INSIGHTS_TARGETS_PER_RUN` (int 1–500, default 50), `INSIGHTS_ACCOUNTS_PER_RUN` (int 1–100, default 20), `INSIGHTS_POLL_MIN_INTERVAL_SECONDS` (int 60–86400, default 900), `INSIGHTS_ACCOUNT_POLL_INTERVAL_SECONDS` (int 300–604800, default 21600), `INSIGHTS_TIME_SHARE` (float 0–1, default 0.3), `INSIGHTS_READ_RESERVE` (float 0–1, default 0.5), `INSIGHTS_RETENTION_DAYS` (int 1–3650, default 400), `INSIGHTS_PRUNE_BATCH` (int 1–1000, default 200) to `src/server/env.ts`'s schema, the `EnvLike` pick and `src/server/scheduler/config.ts`'s `INSIGHTS_DEFAULTS` table and `insightsConfig(config)` reader, after the `ENGAGEMENT_*` block (data-model.md §10)
- [X] T002 [P] Add the nine `INSIGHTS_*` knobs to `.env.example` with their ranges and defaults (FR-071)
- [X] T003 [P] `src/server/scheduler/config.test.ts`: assert each of the nine new env vars parses with its documented default and rejects an out-of-range value (data-model.md §10) — depends on T001

**Checkpoint**: env config ready for every later phase to read.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The provider contract (G30), the four tables and their migration, the DAL, the claim functions and the mock fixture every user story's implementation sits on. **No user story work starts before this phase is green.**

### Provider contract (G30)

- [X] T004 [P] Edit `src/providers/types.ts`: add `MetricKeyDeclaration`, `InsightsDeclaration`, `InsightsSupport`, `PostMetricsReadContext`, `PostMetricEntry`, `PostMetricsReadResult`, `AccountMetricsReadContext`, `AccountMetricsReadResult`, and the optional `insights?: InsightsSupport<Settings>` member on `SocialProvider`, exactly per contracts/provider-insights.md §1–§3 (FR-001, FR-002, FR-006 … FR-011)
- [X] T005 [P] Edit `src/providers/registry.ts`: add `assertInsightsDeclaration`, called at load beside `assertCreationAllowance`, enforcing D1–D6 from contracts/provider-insights.md §1 (empty post+account+no-unavailable rejected; duplicate/malformed keys and labels rejected; `maxPostsPerRead` in `[1,200]`; `readBudget.count >= 1` and `windowSeconds` in `[1,604800]`; `unavailable.reason` 1–300 chars; both metrics schemas closed objects of optional numbers) — depends on T004
- [X] T006 [P] `src/providers/registry.test.ts`: extend with D1–D6 — a declaration with no post key, no account key and no `unavailable` throws at registry load; so do a duplicate key, an empty label, `maxPostsPerRead: 0` and `readBudget.count: 0` (quickstart.md §3, FR-004) — depends on T005

### Schema and migration

- [X] T007 Create `src/server/db/schema/insights.ts`: the four tables `post_metric_snapshots`, `account_metric_snapshots`, `post_metric_poll_states`, `account_metric_poll_states` with every column, CHECK and index in data-model.md §1–§4 — `project_id` `ON DELETE CASCADE` on all four, the lease-pair/non-negative-failures/frozen-pair/frozen-reason-enum/frozen-has-no-next/failing-pair CHECKs, the `captured_at` millisecond-truncation and 2000-byte size CHECKs, and the claim indexes with their `WHERE poll_lease_until IS NULL AND next_poll_at IS NOT NULL` predicates
- [X] T008 Edit `src/server/db/schema/index.ts`: export the four new tables and their row/insert types from `insights.ts`
- [X] T009 Generate migration `drizzle/0041_*.sql` via `pnpm db:generate` from T007/T008 (never hand-written) and run `pnpm db:check` until green (FR-023, SC-012) — depends on T007, T008
- [X] T010 [P] `tests/integration/db/enum-value-in-batch.test.ts`: extend the existing rule to confirm the new `frozen_reason` CHECK is a text CHECK, not an enum, and is unaffected by the partial-index/enum trap (data-model.md §3) — depends on T009

### DAL and claims

- [X] T011 [P] `src/server/dal/insights.ts` (new): `PostMetricSnapshotsRepo` (`insertIfAbsent` with `ON CONFLICT DO NOTHING`, `latestForTargets`, `countForAccountSince` — no `update`, no single-row `delete`), `AccountMetricSnapshotsRepo` (same shape), `PostMetricPollStatesRepo` (`get`, `getMany`, `update` with `expectedLeaseOwner`, `deleteForAccount`), `AccountMetricPollStatesRepo` (same shape) per data-model.md §7 — depends on T007, T008
- [X] T012 [P] `src/server/dal/insights-claims.ts` (new): `claimDueAccountMetricPolls` and `claimDuePostMetricPolls` per data-model.md §5, §7 — lazy row creation inside the claim transaction (account states for every active, non-removed social account on a provider that declares `insights` and is not `unavailable` and has no state row; post states for every published target with a non-null `external_id` and `published_at` on such an account and no state row, `next_poll_at` from `nextPostPollAt`, bounded by the caller's limit), then `SELECT ... FOR UPDATE OF <poll-state table> SKIP LOCKED` ordered by `(next_poll_at, id)` with `LIMIT`, each wrapped in `crossProject(reason, …)` — depends on T011
- [X] T013 Edit `src/server/dal/scope.ts` and `src/server/dal/index.ts`: register the four new repos on `ProjectScope` and on `createSchedulingRepos`, export their types from `dal/index.ts` (data-model.md §7) — depends on T011, T012
- [X] T014 [P] `tests/unit/dal/insights.test.ts` (new): assert `PostMetricSnapshotsRepo` and `AccountMetricSnapshotsRepo`'s public surface has no `update` and no single-row `delete` method, by walking the repo object's keys (FR-016) — depends on T011

### Pure library

- [X] T015 [P] [US3] `tests/unit/insights/schedule.test.ts` (new): the module imports no clock and no DAL; ages 30 min/20 h/3 d/10 d/40 d → 1 h/1 h/1 d/1 w/`null`; every band edge (24 h, 7 d, 28 d) at the boundary, one second before, one second after; a candidate on or after `publishedAt + 28 d` returns `null`; age 40 d with `lastCapturedAt === null` → due now, then `null` after one capture; a frozen target returns `null` never a far-future date; `minIntervalMs` floors the result; `nextAccountPollAt` never decays and never returns `null`; walking one target from publish to day 40 yields exactly 32 capture times (FR-024 … FR-030, SC-006) — write first, confirm it fails
- [X] T016 [P] [US3] `src/lib/insights/schedule.ts` (new, pure, no clock, no database): `nextPostPollAt` and `nextAccountPollAt` per research.md §5 — depends on T015
- [X] T017 [P] [US3] `tests/unit/insights/budget.test.ts` (new): `stricterBudget` and `reserveFloor` are imported from `scheduler/engagement-budget.ts`, not reimplemented; the refusal threshold is `floor(count × (1 − reserve))` at the boundary, one below and one above (FR-049) — write first, confirm it fails
- [X] T018 [P] [US3] `src/server/scheduler/insights-budget.ts` (new, pure): the per-account reserve check of research.md §4 and contracts/scheduler-insights.md §3 step 3, importing `stricterBudget`/`reserveFloor`/`windowStart` from `engagement-budget.ts` and `writesStartedSince` from `dal/scheduler.ts` unchanged — depends on T011, T017

### The mock fixture

- [X] T019 [P] Edit `src/providers/mock/settings.ts`: add the eight insights scripting fields — `insightsUnavailable` (bool, default false), `insightsPostMetrics` (record, default `{ likeCount: 4, repostCount: 1 }`), `insightsAccountMetrics` (record, default `{ followersCount: 100 }`), `insightsGoneExternalIds` (string array, default `[]`), `insightsPostReadBehaviour` / `insightsAccountReadBehaviour` (enum of the five stop kinds plus `page`, default `page`), `insightsReturnUndeclaredKey` (bool, default false), `insightsOversizedPayload` (bool, default false) per contracts/provider-insights.md §6 — depends on T004
- [X] T020 [P] `src/providers/mock/insights.ts` (new): `mockInsights: InsightsSupport` declaring post keys `likeCount`/"Likes", `repostCount`/"Reposts", `viewCount`/"Views" and account keys `followersCount`/"Followers", `postsCount`/"Posts", `maxPostsPerRead: 3`, serving T019's scripted settings for `readPostMetrics`/`readAccountMetrics` — depends on T004, T019
- [X] T021 Edit `src/providers/mock/index.ts`: add `insights: mockInsights` — depends on T020
- [X] T022 [P] `src/providers/mock/insights.test.ts` (new): every stop kind, `unavailable`, a `gone` external id, an undeclared returned key, and an oversized payload are each reachable from settings alone (FR-059 … FR-061) — depends on T021
- [X] T023 [P] `tests/helpers/scheduling.ts`: add `parkAllInsightsPolls()` after `parkAllEngagementReads()` — creates missing poll-state rows for every account and target on the worker's database and sets `next_poll_at = PARKED_UNTIL`; wire it into `parkAllTickWork()` (contracts/scheduler-insights.md §7) — depends on T012

**Checkpoint**: contract, schema, DAL, pure library and mock fixture are all in place and green. User story work can now begin.

---

## Phase 3: User Story 1 — Numbers appear for a published post, and the panel never lies about them (Priority: P1) 🎯 MVP

**Goal**: The whole spine — provider declaration, snapshot tables, poll state, tick section and panel — proved end to end on the `mock` provider with no platform credentials.

**Independent Test**: with a project holding a `mock` account and a published target, run a tick with a pinned clock: a snapshot row appears, the panel renders the mock's declared labels and an "as of" time, and switching the mock's scripted behaviour to each honest state (never polled, nothing reported, unavailable, failing, gone) renders that state and no number.

### Tests for User Story 1

- [X] T024 [P] [US1] `tests/unit/insights/panel.test.ts` (new): every row of the decision table in contracts/panel.md §2, in order — `not_published`, `platform_unsupported`, `unavailable`, `no_external_id`, `gone` (before `failing`), `failing` (with and without a surviving snapshot), `not_polled_yet`, `nothing_reported`, `reported`; a declared-but-absent key renders no row; a `failing` state with an earlier snapshot carries both; no output path produces a delta, a total or a second value (FR-062 … FR-068) — write first, confirm it fails
- [X] T025 [P] [US1] `tests/integration/insights/poll.test.ts` (new): pin the clock with `atTime` and the budget with `tickConfig()`, call `parkAllInsightsPolls()` in `beforeEach` — a due target yields one snapshot row and one poll-state update committed together (FR-031); a tick with nothing due has an `insightsPoll` section result with every count zero and a `scheduler_heartbeats` row for `insights_poll` with the same counts (FR-036, FR-037, US4-AS1); a thrown provider call leaves `insightsPoll.ok === false` with zeroed counts, every other section unaffected, no credential in the logged message (FR-038, US4-AS2); a published-by-hand target (no `external_id`) is counted in `targetsSkippedNoExternalId`, gets no poll state, no `last_error`, no backoff (FR-039, US1-AS5); with `insightsUnavailable`, no state row is created, no call is made in any tick, `unavailable` is counted (FR-003, US1-AS4); with every provider's `insights` absent, the section claims nothing, writes zeroes, no table grows (SC-010) — write first, confirm it fails
- [X] T026 [P] [US1] `tests/integration/insights/storage.test.ts` (new): both snapshot tables accept a valid row and reject one over 2,000 bytes, a non-object `metrics`, an unrounded `captured_at` (FR-014, FR-015); the lease-pair, non-negative-failures, frozen-pair, frozen-has-no-next and failing-pair CHECKs each reject their violation (FR-019, FR-020); an install whose providers all omit `insights` gains no poll-state row after a tick (FR-020); a provider returning an undeclared key stores a snapshot without it (FR-018); re-resolving a target's `external_id` keeps its earlier snapshots and the next poll uses the new id (FR-021); an oversized payload is refused with no partial row and the read counted failed (edge case) — write first, confirm it fails
- [X] T027 [P] [US1] `tests/integration/insights/panel.test.tsx` (new): renders the real post detail page through the existing page-test helpers — no snapshot → "have not been read yet" + due time, no `0` anywhere (US1-AS1); `likeCount: 4` with no `quoteCount` → "Likes"/"4" present, "Quotes" absent, exactly one "as of" line (US1-AS2); two snapshots an hour apart → only the later rendered, no arrow/delta/second number (US1-AS3); an `unavailable` declaration → the reason and a working docs link (US1-AS4); four failures after one good snapshot → the snapshot and the failing notice, no credential in the reason (US1-AS6); a `gone` target → "no longer on the platform" plus snapshots captured while it existed (US1-AS7); heading order `h1 → h2 → h3`, keyboard reachable, no new permission statement in `access.ts` (FR-069); no client component in the rendered tree, no new network call (FR-070); across all eight states no `0`, no `—`, no empty number cell (SC-003) — write first, confirm it fails

### Implementation for User Story 1

- [X] T028 [US1] `src/lib/insights/panel.ts` (new, pure, no clock, no database): `buildTargetInsightsView` — the nine-shape `TargetInsightsView` type and the ordered decision table of contracts/panel.md §2 — depends on T024
- [X] T029 [US1] `src/server/scheduler/insights-poll.ts` (new): `runInsightsPoll` per contracts/scheduler-insights.md §2–§5 — compute the deadline from `INSIGHTS_TIME_SHARE`; build `providerKeys` from providers declaring `insights` and not `unavailable`; return early with a zeroed heartbeat when that set is empty or when remaining time is under `providerTimeoutMs`; claim accounts and targets via T012; count `targetsSkippedNoExternalId` via a companion query; group claimed targets by `socialAccountId` and process each account concurrently with `Promise.all`; `emptyInsightsPollCounts()` and `InsightsPollCounts` with all fourteen keys; `writeHeartbeat("insights_poll", now, counts)` unconditionally on every path — depends on T011, T012, T013, T018, T023
- [X] T030 [US1] Edit `src/server/scheduler/insights-poll.ts`: `processAccount` — decrypt credentials, parse settings, run T018's budget check (refusal releases every lease, leaves `next_poll_at` unchanged, counts `deferredForAllowance`, no failure); for each batch of `min(INSIGHTS_READ_PAGE_SIZE, maxPostsPerRead)` targets call `readPostMetrics` outside any transaction with `AbortSignal.timeout(providerTimeoutMs)`, then commit the batch in one transaction (`insertIfAbsent` per entry, `update` per state row with `expectedLeaseOwner`); if an account poll was claimed and time remains, call `readAccountMetrics` and commit in one transaction; release every lease in a `try/finally` on every path including a throw (FR-031 … FR-035, FR-045, FR-046) — depends on T029
- [X] T031 [US1] Edit `src/server/scheduler/insights-poll.ts`: the result-mapping table of contracts/scheduler-insights.md §4 — `page`/`metrics`/valid schema → insert, `consecutive_failures` → 0, `failing_since` → NULL, `next_poll_at` from `nextPostPollAt(publishedAt, now, …)` or frozen `settled` when that returns null; `page`/`metrics`/invalid or oversized schema → no snapshot, `failures+1`, `nextRetryAt`; `page`/`gone` → no snapshot, failures unchanged, frozen `gone`, `next_poll_at` NULL; `retryable_error`/`fatal_error` → `failures+1`, `retryAt ?? nextRetryAt`; `rate_limited` → failures unchanged, `retryAt ?? nextRetryAt`; `credentials_invalid` → `failures+1`, `markInvalidEmitting`; `unavailable` → unchanged, lease released; every `error`/`reason`/`last_error` passed through `redact(text, secretValues(credentials))` before storage (FR-040 … FR-044) — depends on T030
- [X] T032 [US1] Edit `src/server/scheduler/index.ts`: add the `insightsPoll` section as a new `Promise.all` entry, concurrent with the rest, not sequenced after publishing, plus the `insightsPoll: SectionResult<InsightsPollCounts>` field on `TickSummary` (contracts/scheduler-insights.md §1) — depends on T029
- [X] T033 [US1] Edit `src/server/services/posts/view.ts`: add `insights: TargetInsightsView` to `PostViewTarget`, loading `scope.postMetricSnapshots.latestForTargets(...)` and `scope.postMetricPollStates.getMany(...)` as two batched reads and calling T028's `buildTargetInsightsView` per target (contracts/panel.md §4) — depends on T013, T028
- [X] T034 [US1] `src/components/targets/PerformancePanel.tsx` (new, server component): render the nine `TargetInsightsView` states per contracts/panel.md §3 — one `<h3>` under the target's `<h2>`, a `<dl>` of label/value pairs, exactly one "as of" line via `<LocalTime>`, no chart/trend/delta, a `docsPath` link through `docsUrl(...)` — depends on T028
- [X] T035 [US1] Edit `src/app/p/[projectSlug]/posts/[postId]/page.tsx`: render T034's panel inside each target's existing section (contracts/panel.md) — depends on T033, T034

**Checkpoint**: User Story 1 is independently functional — the spine works end to end on the mock provider. This is the entry's MVP.

---

## Phase 4: User Story 2 — Bluesky's own numbers, with no new permission asked for (Priority: P2)

**Goal**: Real Bluesky accounts produce real post and account numbers through the account's existing session, with no reconnect, no scope and no new setting.

**Independent Test**: with mocked HTTP for `app.bsky.feed.getPosts` and `app.bsky.actor.getProfile`, a tick captures a post snapshot keyed by the at-URI and an account snapshot keyed by the DID; the declared keys contain no views or reach key; each mocked failure shape produces the documented outcome.

### Tests for User Story 2

- [X] T036 [P] [US2] `src/providers/bluesky/insights.test.ts` (new, mocked HTTP only): the declaration's post keys, account keys, labels and `maxPostsPerRead: 25` (FR-050, FR-051, FR-053); no declared key contains `view`, `impression` or `reach` for posts or accounts (FR-052); a response with `likeCount: 2` and no other count yields `{ likeCount: 2 }` not three zeroes (FR-054); a requested at-URI absent from `posts` yields `{ kind: "gone" }` for that id alone (FR-055); three targets produce one `getPosts` call carrying all three URIs (US2-AS1); 429 + reset header → `rate_limited` with that `retryAt`; 401 → `credentials_invalid`; 503 → `retryable_error`; `ENOTFOUND` → `retryable_error`; 403 → `fatal_error` (FR-057); a thrown `XRPCError`, an abort and a malformed body all map, none escape (FR-011); no message contains the access JWT, the refresh JWT or the app password (FR-075) — write first, confirm it fails
- [X] T037 [P] [US2] `tests/lint/import-boundaries.test.ts`: confirm it stays green with the new contract and the new `src/providers/bluesky/insights.ts` module in place (FR-012) — depends on T036

### Implementation for User Story 2

- [X] T038 [US2] `src/providers/bluesky/insights.ts` (new): `blueskyInsights: InsightsSupport<BlueskySettings>` per contracts/provider-insights.md §5 — the declaration (four post keys, three account keys, `maxPostsPerRead: 25`, `readBudget: { count: 1_666, windowSeconds: 3_600 }`), `postMetricsSchema`/`accountMetricsSchema` as closed `z.object`s of optional `z.number().int()` fields, `readPostMetrics` calling `agentFor(settings.pdsUrl, creds.accessJwt).app.bsky.feed.getPosts({ uris }, { signal })` and emitting `{ kind: "metrics" }` with only the contained count fields or `{ kind: "gone" }` per absent uri, `readAccountMetrics` calling `app.bsky.actor.getProfile({ actor: account.externalId })` — depends on T004, T036
- [X] T039 [US2] Edit `src/providers/bluesky/insights.ts`: map every platform failure through the provider's existing helpers in `src/providers/bluesky/errors.ts` per the table in contracts/provider-insights.md §5 (`rateLimitNotBefore`, `isCredentialRejection`, `safeReason`, `isPreSend`, `blueskyCredentialsSchema.safeParse`) — depends on T038
- [X] T040 [US2] Edit `src/providers/bluesky/index.ts`: add `insights: blueskyInsights` — depends on T038, T039

**Checkpoint**: User Stories 1 and 2 both work independently — real Bluesky numbers flow through the spine built in Phase 3.

---

## Phase 5: User Story 3 — Polling pays for itself: it decays, it is bounded, and publishing always wins (Priority: P2)

**Goal**: Insights polling never delays a scheduled publish, never grows without limit, and stops asking about posts that have settled.

**Independent Test**: unit-test the schedule functions at each boundary with injected `now` values (done in Phase 2, T015/T016), then run a tick against an account whose allowance window is already full of publishes and assert no provider call was made and the poll was deferred rather than failed.

### Tests for User Story 3

- [X] T041 [P] [US3] `tests/integration/insights/allowance.test.ts` (new): an account whose window already holds publishes + snapshots at the reserve floor gets no provider call, the poll stays due, `deferredForAllowance` is 1 (FR-045, US3-AS3); that refusal leaves `consecutive_failures = 0` and `last_error = null` (FR-046); with the default 0.5, half the declared count is still available to publishing (FR-047); a scheduled publish for the same account in the same tick publishes normally while polling is at its floor (FR-048, SC-005) — write first, confirm it fails
- [X] T042 [P] [US3] `tests/integration/insights/poll.test.ts`: extend with — more targets due than `INSIGHTS_TARGETS_PER_RUN` claims at most that many, oldest-due first, the rest stay due (FR-034); six targets on a mock with `maxPostsPerRead: 3` produce two calls of three (FR-034); a tick whose remaining time is under `providerTimeoutMs` claims nothing, counts `outOfBudget`, writes the heartbeat, returns `ok: true` (FR-035, US3-AS5); one `gone` entry in a three-entry response freezes that target with `frozen_reason = 'gone'` and `consecutive_failures = 0`, the other two snapshots are written (FR-042, US2-AS6); a batch that stops on a failure keeps the snapshots the earlier batch committed, the failed target's `next_poll_at` comes from the backoff not the cadence (FR-043); no `activity_events` row and no notification exists after a successful poll (FR-044) — depends on T025, write first, confirm it fails
- [X] T043 [P] [US3] `tests/integration/insights/concurrency.test.ts` (new): two concurrent `runTick()`s claim disjoint target and account sets (FR-032, US3-AS6); a transaction holding `post_targets`/`social_accounts` `FOR UPDATE` does not block a claim (FR-032); a run killed mid-read leaves no lease past its expiry, no half-written snapshot, no advanced schedule, the next tick resumes with no manual step (FR-033, SC-008); two ticks committing a capture for the same subject at the same `captured_at` produce one row and no error (FR-017, SC-009); the clock moving backwards between ticks is idempotent, not a duplicate (FR-017) — write first, confirm it fails

### Implementation for User Story 3

- [X] T044 [US3] Edit `src/server/dal/insights-claims.ts`: enforce `FOR UPDATE OF <poll-state table> SKIP LOCKED` naming only the poll-state table (never `post_targets`/`social_accounts`), ordered by `(next_poll_at, id)`, bounded by `INSIGHTS_TARGETS_PER_RUN`/`INSIGHTS_ACCOUNTS_PER_RUN`, oldest-due first (FR-032, FR-034) — depends on T012, T043
- [X] T045 [US3] Edit `src/server/scheduler/insights-poll.ts`: honour `AbortSignal.timeout(providerTimeoutMs)` on every provider call and release remaining leases with `outOfBudget++` when `(deadline − now) < providerTimeoutMs` before a batch starts (FR-035, US3-AS5) — depends on T029, T041, T042

**Checkpoint**: User Stories 1, 2 and 3 all work independently — the subsystem is bounded and publishing-safe.

---

## Phase 6: User Story 4 — An operator can see the section working, or see that it did nothing (Priority: P3)

**Goal**: The tick summary and heartbeat make a starved section visible, and retention prunes bounded batches without touching poll state.

**Independent Test**: run a tick and assert the summary contains an insights section result with the documented count keys and a matching heartbeat row; run one with the time share near zero and assert the out-of-budget count is non-zero with the section still reporting success.

### Tests for User Story 4

- [X] T046 [P] [US4] `tests/integration/insights/retention.test.ts` (new): snapshots older than `INSIGHTS_RETENTION_DAYS` are deleted in bounded batches of `INSIGHTS_PRUNE_BATCH`; post and account counts are reported separately in `HousekeepingCounts`; no poll state, target, post or account is deleted; a frozen target's state row survives its last snapshot being pruned (FR-073, FR-074, US4-AS3) — write first, confirm it fails

### Implementation for User Story 4

- [X] T047 [US4] `src/server/services/insights/retention.ts` (new): `prunePostMetricSnapshots(config, now)` and `pruneAccountMetricSnapshots(config, now)`, each one bounded batch deleting only rows whose `captured_at` is older than `INSIGHTS_RETENTION_DAYS`, cross-project, after `services/engagement/retention.ts` (data-model.md §11) — depends on T011
- [X] T048 [US4] Edit `src/server/scheduler/housekeeping.ts`: call T047's two prune functions and add `postMetricSnapshotsPruned`/`accountMetricSnapshotsPruned` to `HousekeepingCounts` (FR-073, contracts/scheduler-insights.md §6) — depends on T047, T046

**Checkpoint**: All four user stories work independently. The subsystem is fully observable and self-pruning.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-project isolation, secrets, the provider seam, account removal cleanup, docs, the constitution amendment, and the final whole-suite pass.

- [X] T049 [P] `tests/integration/insights/isolation.test.ts` (new): a member of project A cannot read project B's snapshots or poll states through any repo; deleting a `projects` row deletes its snapshot and poll-state rows (direct SQL assertion, all four tables); deleting a post, a target or an account cascades likewise; soft-deleting an account leaves its snapshots readable and removes its poll states (FR-022, research.md §13) — depends on T013
- [X] T050 [P] Edit the account-removal service: explicitly call `deleteForAccount` on both poll-state repos when an account is soft-deleted (`removed_at` does not cascade), per data-model.md §9 — depends on T013, T049
- [X] T051 [P] `tests/integration/insights/provider-seam.test.ts` (new): after `tests/integration/engagement/provider-seam.test.ts` — a module-scan assertion that no file outside `src/providers/` names a provider key or a platform metric key in any insights code path (FR-061, SC-013) — write first, confirm it fails, then green
- [X] T052 [P] Edit `tests/integration/security/secret-scan.test.ts`: extend coverage to the post detail page rendered with insights present and to a tick that runs the insights section against an account holding the distinctive fake credentials, with no exemption added (FR-075, SC-011) — depends on T035, T032
- [X] T053 [P] `tests/lint/env-coverage.test.ts`: confirm all nine `INSIGHTS_*` variables are validated, registered and in `.env.example` (FR-071) — depends on T001, T002
- [X] T054 [P] Write `docs/insights.md` (new) and add it to `mkdocs.yml`'s nav: what the feature does for a member, which platforms report what today, the snapshot-not-current-value rule, the absent-never-zero rule, the decay schedule, retention, and what it deliberately does not do including the account-snapshots-captured-but-shown-nowhere gap (FR-076, plan.md "What this entry delivers")
- [X] T055 [P] Edit `docs/adding-a-provider.md`: add the G30 row to the "Generic hooks index" table and a worked section for `InsightsSupport`, naming the `mock` module as the one to read first, in the shape of section 20 (FR-013, FR-077)
- [X] T056 [P] Edit `docs/decisions.md`: append the G30 entry and every decision in spec.md's "Decisions made while specifying" and plan.md's "Post-design re-check" (FR-013, FR-078)
- [X] T057 [P] Edit `docs/feature-map.md`: add what shipped (the panel, the tick section) and the named gaps — account snapshots shown nowhere, no manual refresh, no per-project switch, `bookmarkCount` unowned (FR-079)
- [X] T058 [P] Edit `docs/limits.md`: add the Bluesky insights read-budget row, marked interim/unverified, naming where it is enforced (FR-080) — depends on T038
- [X] T059 [P] `tests/integration/docs/limits-inventory.test.ts`: extend to assert T058's row exists and the existing limits-inventory test stays green (FR-080) — depends on T058
- [X] T060 [P] Edit `docs/research/bluesky.md`: add the section recording, with provenance, every metric field confirmed from the installed package per research.md §1 (including the confirmed absence of any views/reach field and the 25-URI limit), and the unverified-AppView and unverified-read-limit lines marked `NEEDS RESEARCH` (FR-081)
- [X] T061 [P] Edit the constitution's Engineering Constraints list in `.specify/memory/constitution.md` and `docs/build-prompt.md`'s "analytics" out-of-scope line: record that per-post and per-account metric capture is now in scope and that charts, trends and comparisons are not, with a `docs(constitution):` commit and a version bump (FR-082)
- [X] T062 [P] `tests/integration/docs/published-docs.test.ts`: confirm `docs/insights.md` is in the mkdocs nav and every `docsUrl()` target referenced by the panel resolves (FR-076) — depends on T054, T034
- [X] T063 Run the full final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` — depends on every task above except Phase 8

---

## Phase 8: Human task — the live Bluesky check

**Needs a real Bluesky account, a browser, and a live post — none of which a pipeline phase has.** Scheduled last so it never starves the implement loop behind it; nothing in Phases 1–7 depends on it completing (spec "Task ordering note for planning", plan.md "Task ordering note for Phase 2", quickstart.md §10).

- [ ] T064 [US2] **Human task.** With a real Bluesky account connected, publish a post, wait an hour, run a tick, and confirm the panel shows the counts `bsky.app` shows for the same post; confirm an account read returns followers/follows/posts; record whether the public AppView answers `getPosts`/`getProfile` **unauthenticated**, at which host, and under what read allowance — the one open `NEEDS RESEARCH` (research.md §2) — and write the answer into `docs/research/bluesky.md`, replacing T060's `NEEDS RESEARCH` marker with the confirmed or still-unverified result. If the window to run this closes before anyone does, mark this task in `docs/research/bluesky.md` as unachievable and state why, rather than leaving it silently open. Until this runs, the Bluesky reader is reported as "verified with mocks only" (constitution II).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Phase 1 — **blocks every user story**
- **US1 (Phase 3)**: depends on Phase 2 only — the whole spine, proved on `mock`
- **US2 (Phase 4)**: depends on Phase 2 (the contract) and reuses Phase 3's section/panel to prove itself through the tick and the UI tests, but its own provider code depends only on T004
- **US3 (Phase 5)**: depends on Phase 2 (T012, T018) and extends Phase 3's section (T029); independently testable via the pure functions from Phase 2
- **US4 (Phase 6)**: depends on Phase 2 (T011) and Phase 3's section existing to extend with heartbeats/counts (already built in T029/T032); retention is additive
- **Polish (Phase 7)**: depends on all of Phases 2–6
- **Human task (Phase 8)**: depends on nothing in this list completing first; nothing in Phases 1–7 depends on it

### Within Phase 2

T004 → T005 → T006. T007 → T008 → T009 → T010. T011 (depends on T007, T008) → T012 → T013 → T014. T015 → T016. T017 → T018 (depends on T011). T019 (depends on T004) → T020 → T021 → T022. T023 depends on T012.

### Parallel opportunities

- Phase 1: T002, T003 in parallel after T001
- Phase 2: the provider-contract chain (T004→T005→T006), the schema chain (T007→T010), the DAL chain (T011→T014), the pure-library chain (T015→T018) and the mock-fixture chain (T019→T023) can all proceed in parallel once their own first task's prerequisite (none, for T004/T007/T015/T019 since T019 needs T004) is met
- Phase 3: T024–T027 (all test files) in parallel; then T028 standalone, T029→T030→T031→T032 in sequence, T033→T034→T035 in sequence
- Phase 4: T036, T037 in parallel; then T038→T039→T040
- Phase 5: T041, T042, T043 in parallel; then T044, T045
- Phase 6: T046 alone; then T047→T048
- Phase 7: T049–T062 are nearly all [P] — independent files/doc edits, gated only by their listed dependency; T063 last

---

## Parallel Example: Phase 2 foundational work

```bash
# Launch independent foundational tracks together once Phase 1 is green:
Task: "Edit src/providers/types.ts with InsightsSupport (G30)"             # T004
Task: "Create src/server/db/schema/insights.ts"                            # T007
Task: "tests/unit/insights/schedule.test.ts"                               # T015
Task: "tests/unit/insights/budget.test.ts"                                 # T017

# Each then continues its own chain:
Task: "src/providers/registry.ts: assertInsightsDeclaration"               # T005, after T004
Task: "drizzle/0041_*.sql via pnpm db:generate"                            # T009, after T007/T008
Task: "src/lib/insights/schedule.ts"                                       # T016, after T015
```

---

## Implementation Strategy

### MVP first

1. Phase 1 (Setup) → Phase 2 (Foundational) — blocking, must be green
2. Phase 3 (US1, the spine on `mock`) → **stop and validate independently** (quickstart.md §1, §2, §5, §6) — this alone is a fully working, shippable insights panel against the mock provider

### Incremental delivery after the MVP

3. Phase 4 (US2, real Bluesky numbers) → **stop and validate independently** (quickstart.md §3)
4. Phase 5 (US3, decay/bounds/publishing-wins) → **stop and validate independently** (quickstart.md §4)
5. Phase 6 (US4, observability and retention) → **stop and validate independently** (quickstart.md §4, §5)
6. Phase 7 (Polish) — isolation, secrets, docs, scope amendment, final whole-suite pass
7. Phase 8 (human task) — runs whenever a live Bluesky account and a browser are available; resolves the one open `NEEDS RESEARCH` question

### Notes

- [P] tasks touch different files with no unmet dependency
- Every test task is written and confirmed failing before its matching implementation task
- Commit after each task or logical group
- The human task (Phase 8) is deliberately last despite US2 being P2 in spec priority — a judgement task needing a live account and a browser starves the implement loop if placed earlier, and every behaviour above it is provable from mocked HTTP
