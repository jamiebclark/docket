---

description: "Task list for 083-insights-schedule-intelligence"
---

# Tasks: the comparisons only Docket can make

**Input**: Design documents from `/specs/083-insights-schedule-intelligence/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/*.md

**Tests**: Included — the spec and contracts name specific unit and integration tests throughout, and
FR-086 requires the full suite green.

**Organization**: Tasks are grouped by user story, following `plan.md`'s "Implementation order", which
is forced by two things: nothing can be drawn before shapes exist, and US5's fold ships early because
every day without it is a day of history that becomes unrecoverable at the 400-day boundary. Each
numbered phase below is a commit boundary (per `plan.md`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US7), or none for Setup/Foundational/Polish

---

## Phase 1: Setup

**Purpose**: Verify the environment this entry needs, before any code changes.

- [X] T001 Run `pnpm install` inside this worktree (a worktree has no `node_modules` of its own), confirm `docker compose up -d postgres` is reachable on port 5555, and confirm `pnpm db:migrate` runs clean against current `main` migrations
- [X] T002 Verify the next migration number by listing `drizzle/` (currently ends at `0046_low_colleen_wing.sql`) — do not assume `0047`, confirm at migration-generation time in Phase 3

---

## Phase 2: Foundational — G38 and the classification (US1.6, FR-001 to FR-005)

**Purpose**: The one generic type change every later phase depends on. No trend, comparison or panel
code can be written until every provider compiles with a required `shape`.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete — `MetricShape` is read by
the fold, the trend reader, the comparison reader and `shape.ts`.

- [X] T003 Add `MetricShape` discriminated union and make `shape: MetricShape` required (no default) on `MetricKeyDeclaration` in `src/providers/types.ts`, per [contracts/metric-shape.md](contracts/metric-shape.md) §1
- [X] T004 [P] Classify Bluesky's 7 keys (`likeCount`, `repostCount`, `replyCount`, `quoteCount`, `followersCount`, `followsCount`, `postsCount`) as `cumulative` in `src/providers/bluesky/insights.ts`, per [research.md](research.md) §1.1
- [X] T005 [P] Classify Instagram's 7 post keys as `cumulative` and 2 account keys (`reach`, `follower_count`) as `windowed` with `windowMs: 86_400_000` in `src/providers/instagram/insights.ts`, per [research.md](research.md) §1.1
- [X] T006 [P] Classify Facebook's 4 post keys as `cumulative` and 2 account keys (`page_post_engagements`, `page_follows`) as `unknown` with the exact reason strings from [contracts/metric-shape.md](contracts/metric-shape.md) §2 in `src/providers/facebook/insights.ts`
- [X] T007 [P] Classify TikTok's 4 post keys and 3 account keys as `cumulative` in `src/providers/tiktok/insights.ts`, per [research.md](research.md) §1.1
- [X] T008 [P] Classify Pinterest's 4 post keys as `windowed` with `windowMs: null`, its `pinterest_follower_count` as `cumulative`, and `monthly_views` as `unknown` with the exact reason string from [contracts/metric-shape.md](contracts/metric-shape.md) §2 in `src/providers/pinterest/insights.ts`
- [X] T009 [P] Classify X's 6 post keys as `cumulative` in `src/providers/x/insights.ts` (no account keys declared, no change there)
- [X] T010 [P] Confirm Threads' `insights.ts` declares no keys (`post: []`, `account: []`) and still compiles with the new required field — no classification needed, verify only
- [X] T011 [P] Classify `mock`'s 3 post keys and 2 account keys as `cumulative` in `src/providers/mock/insights.ts`, per [research.md](research.md) §1.3 — do not add or reclassify any key, existing fixtures assert against these three
- [X] T012 [P] Create `src/lib/insights/shape.ts` with pure `isPlottable(shape)` and `shapeNote(shape)` per [contracts/metric-shape.md](contracts/metric-shape.md) §3, with `src/lib/insights/shape.test.ts` covering all three shape kinds
- [X] T013 [P] Add the G38 row to the Generic hooks index and a prose section in `docs/adding-a-provider.md`, per [contracts/metric-shape.md](contracts/metric-shape.md) §4
- [X] T014 [P] Record the classification decision, the three `unknown` keys and the refusal to pin a period in `docs/decisions.md`, per [contracts/metric-shape.md](contracts/metric-shape.md) §4
- [X] T015 [P] Record the two open period questions (Facebook's account period, Pinterest's `monthly_views` window) in `docs/research/meta.md` and `docs/research/pinterest.md`, per [research.md](research.md) §1.2, §8
- [X] T016 Add `tests/integration/insights/provider-seam.test.ts` asserting every provider's declared keys carry a `shape`, and that exactly `page_follows`, `page_post_engagements` and `monthly_views` are classified `unknown`
- [X] T017 Run `pnpm typecheck`, confirm it fails if a `shape` is removed locally (delete one, confirm the failure, restore it), then confirm it passes; run `tests/integration/insights/panel.test.tsx` unchanged and confirm it still passes byte-identically

**Checkpoint**: `pnpm typecheck` passes, `panel.test.tsx` is unchanged and green, all 46 keys are classified. Every later phase can now read `shape`.

---

## Phase 3: Migration and schema

**Purpose**: The three tables and one enum every later phase's DAL and services write to and read from.

**⚠️ CRITICAL**: Blocks the fold (Phase 4), the per-post numbers reads, the comparisons reads, the first-engagement recorder, and the API operation.

- [ ] T018 Add `metricKind` pgEnum (`cumulative`, `windowed`, `unknown`), `accountMetricRollups` and `postMetricRollups` tables (columns, CHECKs, unique constraints and indexes per [data-model.md](data-model.md) §1-§3) to `src/server/db/schema/insights.ts`
- [ ] T019 Add `targetFirstEngagement` table (columns, CHECKs including the write-once-shape CHECKs, and index per [data-model.md](data-model.md) §4) to `src/server/db/schema/insights.ts`
- [ ] T020 Add the three new tables with `scopeColumn: "project_id"` to `src/server/db/project-owned.ts`
- [ ] T021 Run `pnpm db:generate`, verify the generated migration number against `drizzle/` (do not assume `0047` — 082 had to renumber), and verify its contents match [data-model.md](data-model.md) §9 exactly (one enum, three `CREATE TABLE`, no backfill statement)
- [ ] T022 Run `pnpm db:migrate` and `pnpm db:check`, confirm both green

**Checkpoint**: Schema exists, is scoped, and `pnpm db:check` is green. Fold, DAL and service work can now begin.

---

## Phase 4: User Story 5 - A year-old trend outlives the rows that made it (Priority: P2, shipped early per plan.md)

**Goal**: Before any snapshot is pruned, fold it into a durable rollup point in the same transaction, so a year-old trend survives the row that produced it.

**Independent Test**: Seed snapshots older than the retention window, run housekeeping, assert the rolled-up points exist, the snapshot rows are gone, the trend still draws, and that forcing the fold to fail leaves every snapshot row in place.

### Implementation for User Story 5

- [ ] T023 [US5] Create `src/server/services/insights/fold.ts`: the pure `foldRows(rows, shapeFor)` function producing one point per (subject, metric key, UTC day) per [contracts/fold.md](contracts/fold.md) §2, with `src/server/services/insights/fold.test.ts` for the pure part
- [ ] T024 [US5] Add the claim/upsert/delete DAL methods to `src/server/dal/insights.ts`: `FOR UPDATE SKIP LOCKED` claim of the oldest `INSIGHTS_PRUNE_BATCH` rows past retention, the commutative upsert (`ON CONFLICT … WHERE EXCLUDED.captured_at > rollups.captured_at`) for both rollup tables, and the delete of exactly the claimed ids — per [contracts/fold.md](contracts/fold.md) §1, §3
- [ ] T025 [US5] Rewrite `src/server/services/insights/retention.ts` into `foldAndPruneAccountSnapshots` and `foldAndPrunePostSnapshots`, each running claim→upsert→delete in one transaction per batch, replacing the two prior prune-only functions, per [contracts/fold.md](contracts/fold.md) §1
- [ ] T026 [US5] Wire `foldAndPruneAccountSnapshots` and `foldAndPrunePostSnapshots` into `src/server/scheduler/housekeeping.ts` in place of `pruneAccountMetricSnapshots`/`prunePostMetricSnapshots`, passing `shapeFor` down from the provider registry (scheduler owns the import, not the DAL), per [contracts/fold.md](contracts/fold.md) §5
- [ ] T027 [US5] Add `accountMetricPointsFolded`, `postMetricPointsFolded` to `HousekeepingCounts` and `TickSummary` (the other two new fields, `firstEngagementRecorded`/`firstEngagementScanned`, are added in Phase 8) — the two existing prune count fields keep their names and meaning, per [data-model.md](data-model.md) §8
- [ ] T028 [US5] Create `src/server/dal/insights-read.ts`'s trend-reading query: folded points and surviving snapshots read together, bucketed so exactly one value appears per subject/metric/day, per [contracts/fold.md](contracts/fold.md) §4
- [ ] T029 [US5] Write `tests/integration/insights/fold.test.ts` covering all nine assertions in [contracts/fold.md](contracts/fold.md) §7: 500-day backfill with 400-day retention (US5.1, SC-005); a failing upsert deletes nothing (US5.2, FR-052); a batch smaller than the backlog deletes nothing newer than what was folded (US5.3, FR-051); re-running over the same days is idempotent (US5.4, FR-053); a day with both a point and a surviving snapshot yields exactly one value (US5.5, FR-054); an account deletion cascades its points (US5.6, FR-056); two concurrent folds over the same backlog double-write nothing (FR-057); `captured_day` is the UTC day of `captured_at` for every point; a pass that folds nothing reports zero rather than being silent (FR-055)
- [ ] T030 [US5] Update `tests/integration/insights/retention.test.ts` — the one expected edit to 080's suites: the rows it asserts gone now leave rollup points behind. If any other test in 080's or 081's insights suites needs an edit, treat that as a signal something generic broke and stop to investigate before continuing

**Checkpoint**: `pnpm vitest run tests/integration/insights/fold.test.ts tests/integration/insights/retention.test.ts` is green. History now outlives retention.

---

## Phase 5: The constitution amendment (FR-081)

**Purpose**: From Phase 4 onward the constitution's out-of-scope line ("analytics […] charts, trends and comparisons stay out of scope") is false. Amend it in its own commit, as `plan.md`'s implementation order requires.

- [ ] T031 Amend the constitution's out-of-scope line in `.specify/memory/constitution.md` (or wherever the canonical constitution file lives in this repo) to reflect that this entry makes charts, trends and comparisons in scope, with a version bump, in a standalone `docs(constitution):` commit

---

## Phase 6: User Story 1 - Is this account growing? (Priority: P1) 🎯 MVP

**Goal**: Per connected account, show that account's declared account metrics over a member-chosen date range as its own chart with its own axis — never summed, never averaged across platforms.

**Independent Test**: Seed `account_metric_snapshots` for four accounts across three platforms over 30 days, open the page, confirm one chart per account, correct per-platform labelling, a gap where a day has no snapshot, and no figure anywhere that combines two platforms.

### Tests for User Story 1

- [ ] T032 [P] [US1] Write `src/lib/insights/trend.test.ts`: a `cumulative` series rises and falls (US1.1); a `windowed` series collapses to at most one value per project-local day (US1.2, FR-013); a gap where no snapshot exists is absent, never interpolated or zeroed (US1.5, FR-014); an `unknown`-shaped key is absent entirely (US1.6, FR-004)
- [ ] T033 [P] [US1] Write `tests/integration/insights/trends.test.ts` per [quickstart.md](quickstart.md) §2: all six assertions in that table, seeded against real Postgres

### Implementation for User Story 1

- [ ] T034 [US1] Create `src/lib/insights/trend.ts`: pure `rows + tz + range -> TrendSeries`, applying FR-013's "newest reading per project-local day" for `windowed` metrics and preserving gaps for `cumulative` ones, per [data-model.md](data-model.md) §7.1 (depends on T023, T028)
- [ ] T035 [US1] Extend `src/server/dal/insights-read.ts` with `accountTrendRows(accountIds, from, to)`: the `UNION ALL` of `account_metric_snapshots` (via `jsonb_each`, filtered to `jsonb_typeof(value) = 'number'`) and `account_metric_rollups`, both arms pinned on `project_id = $1`, per [research.md](research.md) §6 and [contracts/fold.md](contracts/fold.md) §4
- [ ] T036 [US1] Create `src/server/services/insights/view.ts`'s account-trends half: the one service function the page and the future API operation both call, producing `TrendSeries[]` plus `trendNotes` for platforms with no account metrics (FR-015) and for `unknown`-shaped keys (US1.3, US1.6)
- [ ] T037 [P] [US1] Create `src/components/insights/TrendChart.tsx`: server component, inline SVG line/bar-per-period, its accompanying `<table>`, per [contracts/charts.md](contracts/charts.md) §1-§4
- [ ] T038 [US1] Add `insights: "chart-line"` to `ICONS` in `scripts/generate-icons.mjs`, then run `pnpm icons` from inside this worktree
- [ ] T039 [US1] Add one `NAV_SECTIONS` entry for Insights under the left nav's `Project` group in `src/components/shell/LeftNav.tsx`
- [ ] T040 [US1] Create `src/app/p/[projectSlug]/insights/page.tsx`, `loading.tsx` and `error.tsx`: the page shell reachable at `/p/{slug}/insights`, requiring `scope.can({ post: ["view"] })`, rendering account trend charts with their date-range and "as of" text (FR-016), and an `EmptyState` naming what has to happen for a project with no data
- [ ] T041 [US1] Append the chart-conventions section to `docs/design-system.md` per [contracts/charts.md](contracts/charts.md) §7 (appended at the end, never inserted — renumbering breaks inbound anchors)
- [ ] T042 [US1] Run `node scripts/check-contrast.mjs`, confirm no new colour pair is reported (still 27)
- [ ] T043 [US1] Write `tests/integration/insights/page.test.tsx`: the page's states, its tables, its `loading.tsx`/`error.tsx`, no chart component carrying `"use client"`, per [quickstart.md](quickstart.md) §6

**Checkpoint**: `pnpm vitest run src/lib/insights/trend.test.ts tests/integration/insights/trends.test.ts tests/integration/insights/page.test.tsx` is green; `pnpm build` succeeds with the new route. User Story 1 is independently functional — this is the MVP.

---

## Phase 7: User Story 2 - How did last week's posts do, without opening each one? (Priority: P1)

**Goal**: Recent published posts show their per-target numbers on the overview and the posts list, reusing the one honest-state decision already made for the detail panel, with no query count growth.

**Independent Test**: Seed published targets across platforms with and without snapshots, confirm the overview card and the list rows show the right per-platform numbers, the right honest states, and no cross-platform total.

### Tests for User Story 2

- [ ] T044 [P] [US2] Write `tests/integration/insights/surfaces.test.tsx` per [quickstart.md](quickstart.md) §3: all thirteen `buildTargetInsightsView` states read identically on the overview, the posts list and the detail panel (FR-021); a no-external-id target states Docket has no post to read (US2.4); a project with no insights data issues no extra per-row query (US2.5); a 25-row, 3-target-per-post page's query count does not grow with rows (US2.6, SC-002)

### Implementation for User Story 2

- [ ] T045 [US2] Create `src/components/insights/TargetMetrics.tsx`: one target's numbers for a list row or overview card, per-target and per-platform, each with its own label and "as of" (FR-022), rendering nothing (no row, no dash, no `0`) for an absent metric (FR-023)
- [ ] T046 [US2] Hoist the two batched reads (`postMetricSnapshots.latestForTargets`, `postMetricPollStates.getMany`) that `getPostView` already makes into `src/server/services/posts/list.ts`, so the posts list gains the same two calls, bounded regardless of row count (FR-024)
- [ ] T047 [US2] Hoist the same two batched reads into `src/server/services/overview.ts` for the project overview's recent published posts
- [ ] T048 [US2] Wire `TargetMetrics` into the posts-list row rendering and the overview card rendering, both reusing `buildTargetInsightsView` from `src/lib/insights/panel.ts` unchanged (FR-021)
- [ ] T049 [US2] Confirm neither the overview nor the posts list breaks or goes blank when insights data is unavailable or a read fails (FR-024, FR-074)

**Checkpoint**: `pnpm vitest run tests/integration/insights/surfaces.test.tsx` is green, including the query-count assertion. User Stories 1 and 2 both work independently.

---

## Phase 8: User Story 3 - Does the time I post change anything? (Priority: P2) and User Story 4 - Which of the things I make actually works? (Priority: P2)

**Goal**: Compare published posts by slot, local weekday, series kind, voice profile and origin, each group stating its sample size, with ranking only at 8+ comparable posts.

**Independent Test (US3)**: Seed published slot-scheduled targets across weekdays with known snapshot values, assert group ordering, per-group counts, and refusal behaviour at each threshold.

**Independent Test (US4)**: Seed posts across both occurrence rules, two voice profiles and all three origins, assert each dimension's grouping, counts, exclusions and refusals without touching the UI.

### Tests for User Story 3 and User Story 4

- [ ] T050 [P] [US3] Write `src/lib/insights/floor.test.ts`: `verdictFor` at the floor boundaries **3, 4, 7, 8** (SC-004), per [contracts/comparisons.md](contracts/comparisons.md) §1
- [ ] T051 [P] [US3] [US4] Write `src/lib/insights/compare.test.ts`: all eleven assertions in [contracts/comparisons.md](contracts/comparisons.md) §7 — the floor at 3/4/7/8; no ranking/superlative/ordering below 8; exactly one group above the floor draws no comparison; each of the six `ExclusionReason`s counted with no zero-valued post; a deleted slot/profile/series stays comparable under "removed"; `explicit`/`now` excluded from `slot`, included in `day_of_week`; DST either side of a 09:00 slot and a time-zone change re-bucketing; two platforms stay in separate series; a multi-target post contributes one point per target; mean and median both reported; a range change moves a group across the floor
- [ ] T052 [US3] [US4] Write `tests/integration/insights/comparisons.test.ts` per [quickstart.md](quickstart.md) §4: 10 `cadence` vs 9 `dated_list` posts (US4.1); a standing-series post whose run has been pruned falls back correctly (run `pruneClosedStandingSeriesRuns` against a 100-day-old closed run, re-read); a renamed voice profile shows its current name, a deleted one is a stated removed group (US4.4); `manual`/`generated`/`api` as three groups (US4.5); DST and time-zone-change re-bucketing (US3.6, US3.8)

### Implementation for User Story 3 and User Story 4

- [ ] T053 [US3] [US4] Create `src/lib/insights/floor.ts`: `RANK_MIN = 8`, `PROVISIONAL_MIN = 4`, `verdictFor(sampleSize)`, as two constants, not configuration, per [contracts/comparisons.md](contracts/comparisons.md) §1
- [ ] T054 [US4] Add optional `standingSeries: { id, name, occurrenceRule }` (nullish, no migration) to `generationRecordSchema` in `src/lib/validation/generation.ts`, per [research.md](research.md) §2.2 and [data-model.md](data-model.md) §6
- [ ] T055 [US4] Record `standingSeries` on the generation record in `src/server/services/standing-series/runner.ts`, written through `saveGeneratedPost` as `voiceProfile` already is, per [research.md](research.md) §2.2
- [ ] T056 [US3] [US4] Extend `src/server/dal/insights-read.ts` with `comparableTargetRows(from, to)`: one row per comparable published target carrying every dimension key (slot occurrence, slot id, schedule kind, origin, the latest generation record's `voiceProfile`/`standingSeries` jsonb paths, the live position→run→series fallback) and its latest value per metric key via `DISTINCT ON` over snapshots `UNION ALL` rollups, per [research.md](research.md) §6
- [ ] T057 [US3] [US4] Create `src/lib/insights/compare.ts`: pure `rows + tz + range + dimension + metric -> Comparison`, implementing all five dimensions, the exclusion reasons, the "removed"/"Not generated"/`api`-as-own-group handling, DST-safe time bucketing via `@js-temporal/polyfill` with `disambiguation: "compatible"`, and the mean/median aggregate, per [contracts/comparisons.md](contracts/comparisons.md) §2-§6
- [ ] T058 [P] [US3] [US4] Create `src/components/insights/GroupChart.tsx`: horizontal bars, one per comparison group, hatched-fill-plus-text for `provisional` groups (never a second colour), its accompanying `<table>`, per [contracts/charts.md](contracts/charts.md) §1-§4
- [ ] T059 [P] [US3] [US4] Create `src/components/insights/ComparisonCard.tsx`: counts, cautions, suppressed count, exclusions, dimension-level refusals ("the project has not used series"), per [contracts/comparisons.md](contracts/comparisons.md) §1-§2 and [contracts/charts.md](contracts/charts.md) §3
- [ ] T060 [US3] [US4] Wire the five comparisons (slot, day-of-week, series-kind, voice-profile, origin) into `src/app/p/[projectSlug]/insights/page.tsx` using `ComparisonCard`/`GroupChart`

**Checkpoint**: `pnpm vitest run src/lib/insights/compare.test.ts src/lib/insights/floor.test.ts tests/integration/insights/comparisons.test.ts` is green. User Stories 1-4 all work independently.

---

## Phase 9: User Story 6 - How long before anybody noticed? (Priority: P3)

**Goal**: Record, once per published target, when engagement was first observed, preferring an exact inbox time over a snapshot-derived bound, and never overwriting either figure.

**Independent Test**: Seed a target's snapshot sequence and inbox rows with known timings, run the recording step, assert the stored record, its source, its resolution, and that a later prune of the inbox row does not change it.

### Tests for User Story 6

- [ ] T061 [P] [US6] Write `src/lib/insights/first-engagement.test.ts`: the pure figure-precedence function over all six `FirstEngagementFigure` kinds, per [data-model.md](data-model.md) §7.3 and [contracts/first-engagement.md](contracts/first-engagement.md) §4
- [ ] T062 [US6] Write `tests/integration/insights/first-engagement.test.ts` covering all eleven assertions in [contracts/first-engagement.md](contracts/first-engagement.md) §6: 1h-2h bound from two snapshots (US6.1); engagement present in the very first snapshot reported as an upper bound (US6.2); a 14-minute inbox reply preferred over an already-recorded snapshot bound (US6.3, FR-041); the record unchanged after the inbox row is pruned and separately withdrawn (US6.4, SC-006); platforms with no engagement reader are snapshot-sourced only (US6.5); 20 targets with 7 having no engagement reported correctly (US6.6); a `gone` target with nothing observed reported "never observed" (US6.7); a later higher snapshot does not move the recorded time (US6.8, FR-043); a pre-existing target derived with no platform call (FR-046); two concurrent recorder runs produce one figure with no double-count (FR-057); the table holds no text column and the secret scan finds nothing (FR-064, FR-084)

### Implementation for User Story 6

- [ ] T063 [US6] Add the write-once compare-and-set DAL methods to `src/server/dal/insights.ts`: ensure-row, CAS `exact_first_at`, CAS `bound_before_at`/`bound_after_at`, advance `scanned_through` — per [data-model.md](data-model.md) §4 and [contracts/first-engagement.md](contracts/first-engagement.md) §1, §3
- [ ] T064 [US6] Create `src/server/services/insights/first-engagement.ts`: the bounded `recordFirstEngagement(config, now)` housekeeping step per the pseudocode in [contracts/first-engagement.md](contracts/first-engagement.md) §1, batched by `INSIGHTS_PRUNE_BATCH` (no new environment variable)
- [ ] T065 [US6] Wire `recordFirstEngagement` into `src/server/scheduler/housekeeping.ts`, running strictly before `pruneEngagementItems`, and add `firstEngagementRecorded`/`firstEngagementScanned` to `HousekeepingCounts`/`TickSummary`, per [contracts/fold.md](contracts/fold.md) §5 and [data-model.md](data-model.md) §8
- [ ] T066 [US6] Create `src/lib/insights/first-engagement.ts`: the pure `FirstEngagementFigure` precedence function (exact → bounded → within_first_reading → none_yet → never_observed → not_examined), per [contracts/first-engagement.md](contracts/first-engagement.md) §4
- [ ] T067 [US6] Extend `src/server/dal/insights-read.ts` with `firstEngagementRows(targetIds)`, per [research.md](research.md) §6
- [ ] T068 [US6] Add the first-engagement comparison arm to `src/server/services/insights/view.ts` and render it on `src/app/p/[projectSlug]/insights/page.tsx`, stating that exact times exist only for platforms with an engagement reader (FR-045)

**Checkpoint**: `pnpm vitest run src/lib/insights/first-engagement.test.ts tests/integration/insights/first-engagement.test.ts` is green. User Stories 1-6 all work independently.

---

## Phase 10: User Story 7 - The same numbers from the API (Priority: P3)

**Goal**: One API operation returning the same account trends and comparisons as the screen, with the same refusals, over REST, OpenAPI and MCP together.

**Independent Test**: Call the operation with a read key against a seeded project, assert the body matches the screen's figures, that a key from another project gets nothing, and that the secret scan finds nothing in the response.

### Tests for User Story 7

- [ ] T069 [US7] Write the seven assertions from [contracts/insights-api.md](contracts/insights-api.md) §6 across `tests/integration/api/` and `tests/unit/mcp/`: body matches the screen's figures (US7.1); project isolation (US7.2); missing `read` permission refused (US7.3); a below-floor comparison returns counts plus `conclusion: "not_enough_posts"` with no ordering (US7.4); the operation appears in REST, OpenAPI and MCP consistently (US7.5, SC-008); the secret scan finds nothing in the response (US7.6); no platform HTTP call is made while serving it (SC-011)

### Implementation for User Story 7

- [ ] T070 [US7] Finish `src/server/services/insights/view.ts` as the one service both the page and the API call, returning trends, comparisons and the first-engagement arm together
- [ ] T071 [US7] Create `src/server/api/operations/insights.ts`: `getInsights`, `GET /insights`, `permission: "read"`, `ApiInsightsQuerySchema` (`from`, `to`, `accountId`, `dimension`, `metricKey`, unknown params rejected, `from` after `to` a 400), `mcp: { expose: true }`, `run` calling the one service function, per [contracts/insights-api.md](contracts/insights-api.md) §1-§4
- [ ] T072 [US7] Register the operation once in `OPERATIONS` (`src/server/api/operations/index.ts`), after `activityOperations`, per [contracts/insights-api.md](contracts/insights-api.md) §1
- [ ] T073 [US7] Update the five enumerated places together in one commit per [contracts/insights-api.md](contracts/insights-api.md) §5: `src/server/mcp/naming.ts` (`PUBLISHED_TOOL_NAMES`, add `"docket_get_insights"` after `"docket_list_activity"`); `tests/unit/mcp/naming.test.ts` (list plus "frozen twenty-one"); `tests/helpers/api-fixtures.ts` (a `getInsights` fixture); `tests/integration/api/setup-permission.test.ts` (`OTHER_FIXTURES`); `docs/mcp.md` (tool table and "## 3. The 20 exposed tools" → 21)

**Checkpoint**: `pnpm vitest run tests/unit/mcp tests/integration/api tests/integration/docs` is green. All seven user stories are independently functional.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Docs, the extended secret scan, the no-HTTP assertion, and the one full repo-wide pass FR-086 requires.

- [ ] T074 [P] Update `docs/insights.md`: close the "No chart, trend, delta or comparison of any kind" and "No account-metric screen yet" gaps; state the sample-size floor, the fold, Facebook Pages' lost account trend, Pinterest's lost monthly-views trend, and the Pinterest-age-normalization limit from [research.md](research.md) §8; state what remains out of scope (FR-080)
- [ ] T075 [P] Update `docs/feature-map.md` for the new Insights page and surfaces (FR-082)
- [ ] T076 [P] Update `docs/mcp.md`'s prose beyond the tool table/count already done in T073, if any remains (FR-082) — skip if T073 already covers it fully
- [ ] T077 [P] Extend `tests/integration/security/secret-scan.test.ts` to cover all three new tables and the new API response, asserting `target_first_engagement` has no text column at all; never exempt or narrow an existing check (FR-084)
- [ ] T078 [P] Add the SC-011 test asserting no provider HTTP call is made while rendering or serving insights
- [ ] T079 Run the full pass: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm db:check` and `pnpm build`, all green (FR-086)

---

## Phase 12: The one human task (last, per FR-085)

**Needs a signed-in browser session, visual judgement, and keyboard/screen-reader testing** — none of which a pipeline phase has.

- [ ] T080 Open `/p/{slug}/insights` with seeded data in a real browser and judge by hand: chart legibility in both light and dark themes and at phone width; full keyboard operability with visible focus; what a screen reader conveys about each series, platform, metric and sample size without colour (SC-009); that no chart reads as a cross-platform total at a glance. If this task's window closes before it can be run (e.g. the page is later redesigned), mark it here as unachievable and state why, rather than leaving it open indefinitely.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational — G38 (Phase 2)**: Depends on Setup. BLOCKS every later phase — the fold, the trend reader and the comparison reader all read `shape`.
- **Migration and schema (Phase 3)**: Depends on Phase 2 compiling. BLOCKS the fold, per-post numbers, comparisons, first engagement and the API operation.
- **US5 — the fold (Phase 4)**: Depends on Phase 3. Ships before US1-US4 in this plan because every day without it is unrecoverable history past the 400-day boundary (plan.md).
- **Constitution amendment (Phase 5)**: Depends on Phase 4 (the out-of-scope line becomes false from that point).
- **US1 — account trends (Phase 6)**: Depends on Phase 4 (reads folded points via T028/T035). MVP.
- **US2 — per-post numbers (Phase 7)**: Depends on Phase 3 only (reuses existing panel decision; no new table read beyond what already exists). Independent of US1.
- **US3+US4 — comparisons (Phase 8)**: Depends on Phase 4 (reads rollups via comparableTargetRows) and Phase 3.
- **US6 — first engagement (Phase 9)**: Depends on Phase 3 (its own table) and Phase 4 (shares the housekeeping wiring pattern). Independent of US1-US4.
- **US7 — the API operation (Phase 10)**: Depends on US1, US3, US4 and US6 each having a service-layer result to expose (view.ts is finished incrementally across those phases; T070 finishes it).
- **Polish (Phase 11)**: Depends on all desired user stories being complete.
- **Human task (Phase 12)**: Last, always — per FR-085.

### Parallel Opportunities

- All provider classification tasks (T004-T011) run in parallel — different files, no dependencies on each other.
- Doc updates (T013-T015, T074-T078) run in parallel with each other and with later code phases once their source material exists.
- Within US1, T037 (TrendChart) can be built in parallel with T034-T036 (trend logic) since it is a presentational component against the `TrendSeries` type already defined in data-model.md.
- Within US3/US4, T058-T059 (chart components) can be built in parallel with T053-T057 (comparison logic) for the same reason.
- US2 (Phase 7) and US6 (Phase 9) can proceed in parallel with each other and with US3/US4 (Phase 8) once Phase 4 is checkpointed, since they touch disjoint files.

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 (Setup) and Phase 2 (G38 — Foundational).
2. Complete Phase 3 (Migration and schema).
3. Complete Phase 4 (US5 — the fold), because every day without it loses history.
4. Complete Phase 5 (constitution amendment) in its own commit.
5. Complete Phase 6 (US1 — account trends). **STOP and VALIDATE**: open the Insights page with seeded data and confirm per-account trends draw correctly.

### Incremental Delivery

6. Add Phase 7 (US2 — per-post numbers on overview/list) → validate independently.
7. Add Phase 8 (US3+US4 — comparisons) → validate independently.
8. Add Phase 9 (US6 — first engagement) → validate independently.
9. Add Phase 10 (US7 — the API operation) → validate independently.
10. Phase 11 (Polish): docs, extended secret scan, SC-011, the full `pnpm lint && pnpm typecheck && pnpm test` + `pnpm db:check` + `pnpm build` pass.
11. Phase 12 (the one human task), last.
