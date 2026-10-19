# Implementation Plan: the comparisons only Docket can make

**Branch**: `083-insights-schedule-intelligence` | **Date**: 2026-10-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/083-insights-schedule-intelligence/spec.md`

## Summary

080 built the spine, 081 the permissions, 082 the platforms. They have been writing
`post_metric_snapshots` and `account_metric_snapshots` on schedule ever since. This entry makes **no
platform call of any kind** — it is arithmetic, layout and honesty over rows that already exist. So
the design question is not "how do we read it" but "what is each number allowed to say", and the
answer is four pieces of durable truth plus one pure layer.

**One generic change, and it is a type, not a table (G38).** `MetricKeyDeclaration` gains a required
`shape`: `cumulative`, `windowed` (with a window length where confirmed), or `unknown`. Required with
no default, so `tsc` — not a test anyone can forget — stops a later provider declaring a key without
saying what shape it is (FR-002). All 46 declared keys across eight providers are classified from
`docs/research/*.md` in [research.md](./research.md) §1.1. Three come out `unknown`, which costs
Facebook Pages their account trend entirely and Pinterest its monthly-views trend. That is the honest
answer: resolving either means pinning a `period` on a reader, and FR-005 forbids this entry changing
what any reader asks for.

**One fold, fused with the prune it must beat.** 080's two prune passes are each replaced by a
fold-and-delete in **one transaction per batch**: claim the oldest `INSIGHTS_PRUNE_BATCH` snapshots
past retention `FOR UPDATE SKIP LOCKED`, upsert one rollup point per subject/key/UTC-day, delete
exactly those ids, commit. FR-051 (no prune ahead of the fold), FR-052 (a failing fold deletes
nothing), FR-053 (idempotent) and FR-057 (concurrency- and kill-safe) stop being invariants somebody
has to maintain and become properties of the transaction. No watermark exists to compute wrongly.

**One write-once record, holding instants rather than intervals.** `target_first_engagement` stores
`exact_first_at` (the inbox item's `said_at`) and `bound_before_at`/`bound_after_at` (the snapshot
bracket) as **independently** write-once columns, each set by compare-and-set. That is the only shape
in which FR-041 ("exact is preferred") and FR-043 ("never overwritten") can both hold, because the
two observations can arrive in either order. It holds no commenter name, handle, id, URL or text —
only instants — which is what makes the spec's assumption true that insights do not inherit the
inbox's stricter permission.

**One pure comparison layer.** One SQL fetch of per-target rows feeds all five dimensions in
`src/lib/insights/compare.ts`: slot, local weekday, series kind, voice profile, origin. Sample-size
floors (8 to rank, 4-7 provisional, below 4 not drawn), every exclusion, every refusal and every
"removed" label are unit-testable with no database, which is why SC-004's assertions at 3, 4, 7 and 8
are cheap.

### What the research changed

Two findings, both load-bearing. Done in full: [research.md](./research.md).

1. **The series-kind dimension was not durable, and nothing in the spec could have known.** The only
   path from a post to `cadence`-vs-`dated_list` runs through `standing_series_positions`, whose run
   is pruned at 90 days (`STANDING_SERIES_RUN_RETENTION_DAYS`), cascading to the position and nulling
   `posts.standing_series_position_id` (`ON DELETE SET NULL`). Roughly 90 days after publication
   Docket forgets a post came from a series at all. Left alone, the by-series-kind comparison would be
   right on the default 30-day range and would silently lose arms as a member widened it — the exact
   dishonesty FR-036 and FR-037 exist to prevent. **Fix:** record the fact where `voiceProfile` is
   already recorded, as an optional `standingSeries { id, name, occurrenceRule }` on
   `generationRecordSchema` — jsonb, no migration, survives both the run prune and the series' own
   deletion — with the live join as a fallback for posts that predate this entry and a stated
   exclusion for the rest. [research.md](./research.md) §2.2 has the four alternatives and why each
   loses.
2. **The voice-profile dimension needed no join at all.** `generationRecordSchema` already carries
   `voiceProfile.id` **and** `.name` (`src/lib/validation/generation.ts:78`), and the standing-series
   runner writes it through the same `saveGeneratedPost` every other generated post goes through
   (`runner.ts:24` → `save.ts:66`). So the current name comes from the live profile row, the
   "removed profile" label comes from the recorded name, and the whole dimension is durable for free.

### The spec tension this plan resolves, out loud

FR-050 asks for one rollup point per "project-local day". The Time edge case in the same spec says
"no bucket is stored pre-computed in a local zone" and that a project changing its time zone
re-buckets everything on the next read. Both cannot hold literally once the snapshots are gone.

**Resolution:** a point's identity is the **UTC day** of its `captured_at`, and it stores the real
instant. A local day overlaps at most two UTC days, so UTC-day grain is never coarser than local-day
grain; the reader re-buckets from `captured_at` under the project's *current* zone and applies
FR-013's "newest reading that local day", reaching the same answer a stored local bucket would have —
and still reaching it after the zone changes. The local-day *property* survives; only the stored key
differs, in the safe direction. Recorded in [research.md](./research.md) §3.3,
[contracts/fold.md](./contracts/fold.md) §2 and `docs/decisions.md`.

### What this entry delivers, and what it does not

Delivers: G38 and the classification; one migration with three tables and one enum; the fold;
the first-engagement recorder; a new `/p/[projectSlug]/insights` page with account trends and five
comparisons; per-post numbers on the overview and the posts list; one API operation exposed over MCP;
Docket's first chart conventions, written into the design system.

Does not: any provider reader, scope, platform or request change; any new runtime dependency; any new
environment variable; any new tick section; any cross-platform total, prediction, recommendation,
export or alert. The constitution's own out-of-scope line is amended, because this entry makes it
false (FR-081).

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16.3.8 (App Router, standalone), Drizzle ORM 0.45
(`drizzle-orm/node-postgres`), Zod 4.6, Better Auth, Vitest 5, `@js-temporal/polyfill` 0.5 for every
local-day, weekday and local-hour boundary. **No new runtime dependency, no new infrastructure, no
charting library** — charts are server-rendered inline SVG. Reuses 080/081/082's spine unchanged:
`buildTargetInsightsView` and its thirteen states, `insightsPermissionForAccount`, `insightsConfig`,
`crossProject`, the scoped DAL repos `postMetricSnapshots.latestForTargets` and
`postMetricPollStates.getMany`, `pruneEngagementItems`, `defineOperation`/`OPERATIONS`, `Table`,
`EmptyState`, `PageHeader`, `LocalTime`, `Icon`.

**Storage**: Postgres via Drizzle. **One** migration, generated by `pnpm db:generate`, numbered after
`drizzle/0046_low_colleen_wing.sql` (verify against `drizzle/`, do not assume — 082 had to renumber):

1. `CREATE TYPE metric_kind AS ENUM ('cumulative','windowed','unknown')`;
2. `account_metric_rollups` — one durable point per account/key/UTC-day, never pruned;
3. `post_metric_rollups` — the same for a target;
4. `target_first_engagement` — one write-once row per published target.

**No change to any existing table, column, CHECK or index.** No backfill statement: everything
historical is derived by the two bounded housekeeping steps as they run (FR-046), so the migration
never walks a large table. Shapes and constraints: [data-model.md](./data-model.md). All three tables
are added to `src/server/db/project-owned.ts`.

**Testing**: Vitest. Unit tests beside the source for every pure part — `shape.ts`, `trend.ts`,
`compare.ts`, `floor.ts`, `first-engagement.ts`, the two chart primitives — because every threshold,
exclusion, refusal, DST boundary and verdict in FR-030 to FR-045 is pure and needs no fixture.
Integration tests against real Postgres (**port 5555** locally, not the 5432 in `.env.example`) for
the fold's nine assertions, the recorder's eleven, the trend and comparison SQL, the two UI surfaces'
query counts, the page, the API operation and the extended secret scan. No provider test is added or
changed — **no provider HTTP is involved anywhere in this entry**, which SC-011 asserts by failing if
a provider read is invoked while rendering or serving insights. 080's, 081's and 082's insights
suites must pass with **one expected edit**: `tests/integration/insights/retention.test.ts`, whose
pruned rows now leave points behind. Any second edit means something generic broke.

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed; migrations on the direct URL; no session-level Postgres features — the
fold uses `FOR UPDATE SKIP LOCKED` inside an ordinary transaction, never an advisory lock, so it
works under Neon's transaction-mode pooler.

**Performance Goals**: `runTick()` unchanged — no new section, no new time share, no new budget. The
fold does the work the prune already did plus one bounded upsert over the same ≤200 rows, inside
`runHousekeeping`, which has no time deadline and is bounded by batch. The Insights page is **three**
scoped reads plus the accounts list, whatever the range. The posts list and overview each gain
**two** batched reads — the same two `getPostView` already makes — so the query count does not grow
with the rows (FR-024, SC-002). Dimension extraction happens in SQL (`generation_metadata ->
'records' -> -1 -> 'voiceProfile' ->> 'id'`), so a 25-row page never pulls 25 jsonb documents across.

**Constraints**: no provider call anywhere, so none inside a transaction; `src/providers/**` imports
nothing from `src/server/**`; the DAL imports nothing from the provider registry — the scheduler
passes `shapeFor(...)` down to the fold, as it already passes rules down; no generic layer branches on
a provider key; every read through the scoped DAL, so no route, page or operation imports the raw
client; no secret, token, raw payload or commenter identity on any path added here; the sample-size
floor is two constants, not configuration.

**Scale/Scope**: one generic hook (G38) and 46 keys classified; one migration (one enum, three
tables); one jsonb field added to a validated record; two new housekeeping steps replacing two prune
calls, with four new counts; one new page with two chart primitives and one new nav icon; two existing
surfaces extended; one API operation across the five places that enumerate the surface; five new pure
library modules; one constitution amendment and six docs files.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see [Post-design re-check](#post-design-re-check-after-phase-1).*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory (NON-NEGOTIABLE)** | There is no endpoint or limit to verify here, so the research is about **meaning**: every one of the 46 declared keys is classified with a source line in [research.md](./research.md) §1.1, from `docs/research/*.md` or the `period` Docket's own reader pins. Nothing is classified from a key's name — which is exactly why `monthly_views` is `unknown` despite the word "monthly", and why `page_post_engagements` is `unknown` despite its documented `day/week/days_28`, since Docket's request pins none of the three. Three `unknown` keys cost two platforms their trends, and that cost is stated in `docs/insights.md` rather than papered over | PASS |
| **II. Nothing is "working" unless it ran** | No credential exists to need; every behaviour is provable with fixtures and mocked HTTP, and [quickstart.md](./quickstart.md) gives the command per story. "Verified with mocks only" is not a caveat for this entry — it is the whole of what verification means when no platform is called. The one thing a human must judge (chart legibility, keyboard, screen reader in both themes) is parked last per FR-085 | PASS |
| **III. Project isolation is enforced in one place** | All three new tables carry `project_id`, cascade from `projects` **and** from their subject, and are registered in `src/server/db/project-owned.ts`, so `tests/helpers/scope-check` fails any unscoped query against them. Every UI and API read goes through the scoped DAL; the two cross-project passes (fold, recorder) are each wrapped in `crossProject(reason, …)` as 080's prune already is. The Insights page requires `scope.can({ post: ["view"] })`; the operation requires `read`. No new role, no new permission | PASS |
| **IV. One service layer, many callers** | **One** honest-state decision (`buildTargetInsightsView`) serves the detail panel, the overview and the posts list — FR-021's "no surface invents a second vocabulary" is satisfied by there being nothing else to call. **One** service function serves the Insights page and the API operation, so the screen and the body cannot disagree (US7.1 is asserted by comparing them). **One** recorder for first engagement, in housekeeping, covering historical and new targets identically — which is also why FR-046 needs no backfill. **One** floor module. **One** generic fold parameterised by subject, writing both rollup tables | PASS |
| **V. Providers are plug-ins** | G38 is a declaration value the provider owns, read beside the key and label it already declares. No generic code branches on a provider key to decide a shape, and the DAL still imports nothing from the registry — the scheduler passes `shapeFor` into the fold. A provider added later cannot declare a key without a shape, and needs no change to the scheduler, the fold, the trend, the comparisons or the page | PASS |
| **VI. Boring, few dependencies** | No new runtime dependency and no `pnpm install`: charts are inline SVG from `<polyline>`/`<rect>`, which is also the only option, since pipeline phases cannot reach the npm registry. No new infrastructure. **No new environment variable** — the fold and the recorder reuse `INSIGHTS_RETENTION_DAYS` and `INSIGHTS_PRUNE_BATCH`, and the spec's floor is deliberately not a knob. No new tick section: both steps join `runHousekeeping`, which has no deadline and is batch-bounded, so the spec's fallback (its own `SectionResult`) is not needed | PASS |
| **VII. Secrets never leak** | No credential is read on any path this entry adds, because no platform is called. The new rows hold numbers and instants; `target_first_engagement` has **no text column at all**, asserted at column level, so no commenter name, handle, id, URL or text can reach it. `tests/integration/security/secret-scan.test.ts` is extended to cover all three tables and the new API response — never exempted or narrowed (FR-084) | PASS |

**No violations, so [Complexity Tracking](#complexity-tracking) stays empty.** Three judgement calls
are stated up front rather than buried, each recorded in `docs/decisions.md`:

1. **The fold and the prune are fused**, so there is no "fold step before a prune step" to find in the
   code. Stronger than FR-051 reads, deliberately — [contracts/fold.md](./contracts/fold.md) §1.
2. **A point's key is a UTC day, not a stored project-local day**, because FR-050 and the spec's Time
   edge case cannot both hold literally — [research.md](./research.md) §3.3.
3. **The series-kind dimension needs a durable fact the schema did not have**, added to an existing
   jsonb record rather than as a column — [research.md](./research.md) §2.2.

## Project Structure

### Documentation (this feature)

```text
specs/083-insights-schedule-intelligence/
├── plan.md                        # This file
├── research.md                    # Phase 0: the 46-key classification, and the 90-day hole
├── data-model.md                  # Phase 1: three tables, one enum, one jsonb field, the read models
├── quickstart.md                  # Phase 1: how to prove each story with no platform call
├── contracts/
│   ├── metric-shape.md            # G38: the declaration, the classification, what each shape means
│   ├── fold.md                    # Fold-and-delete in one transaction; reading points and snapshots together
│   ├── comparisons.md             # The floor, the five dimensions, the exclusions, time bucketing
│   ├── first-engagement.md        # One recorder, two write-once figures, the wording
│   ├── insights-api.md            # The one operation, and the five places that enumerate the surface
│   └── charts.md                  # Chart conventions → docs/design-system.md (FR-073)
├── checklists/                    # Pre-existing
├── spec.md
└── tasks.md                       # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                        # G38: MetricShape + required `shape` on MetricKeyDeclaration
│   ├── bluesky/insights.ts             # 7 keys classified (cumulative)
│   ├── instagram/insights.ts           # 7 post cumulative; 2 account windowed, 1-day window
│   ├── facebook/insights.ts            # 4 post cumulative (period=lifetime pinned); 2 account unknown
│   ├── tiktok/insights.ts              # 7 keys cumulative
│   ├── pinterest/insights.ts           # 4 post windowed (rolling, windowMs null); follower cumulative, monthly_views unknown
│   ├── x/insights.ts                   # 6 post cumulative
│   ├── threads/insights.ts             # declares none — no change but the type still compiles
│   └── mock/insights.ts                # 5 keys cumulative (research §1.3)
├── lib/
│   ├── insights/
│   │   ├── shape.ts (new)              # isPlottable, shapeNote — pure
│   │   ├── trend.ts (new)              # rows + tz + range -> TrendSeries, gaps preserved
│   │   ├── compare.ts (new)            # rows + tz + dimension -> Comparison, all five dimensions
│   │   ├── floor.ts (new)              # RANK_MIN, PROVISIONAL_MIN, verdictFor
│   │   ├── first-engagement.ts (new)   # the record -> a stated figure
│   │   └── panel.ts                    # unchanged — the thirteen states, now reused on two more surfaces
│   └── validation/generation.ts        # `standingSeries` on generationRecordSchema (research §2.2)
├── server/
│   ├── db/schema/insights.ts           # metricKind enum, the two rollup tables, target_first_engagement
│   ├── db/project-owned.ts             # three new lines
│   ├── dal/
│   │   ├── insights.ts                 # rollup upsert; foldAndPrune's claim+delete; first-engagement CAS
│   │   └── insights-read.ts (new)      # accountTrendRows, comparableTargetRows, firstEngagementRows
│   ├── services/
│   │   ├── insights/
│   │   │   ├── retention.ts            # becomes foldAndPrune{Account,Post}Snapshots
│   │   │   ├── fold.ts (new)           # the generic fold, parameterised by subject
│   │   │   ├── first-engagement.ts (new)  # the bounded recorder
│   │   │   └── view.ts (new)           # the one service the page and the operation both call
│   │   ├── posts/{list,view}.ts        # the two batched reads, hoisted to the list
│   │   ├── overview.ts                 # recent published posts with their latest numbers
│   │   └── standing-series/runner.ts   # record `standingSeries` on the generation record
│   ├── scheduler/housekeeping.ts       # the recorder + two foldAndPrune calls; four new counts
│   └── api/operations/
│       ├── insights.ts (new)           # the one operation, mcp.expose: true
│       └── index.ts                    # one registry line, after activityOperations
├── components/
│   ├── insights/
│   │   ├── TrendChart.tsx (new)        # inline SVG + its table; server component
│   │   ├── GroupChart.tsx (new)        # horizontal bars + its table; server component
│   │   ├── ComparisonCard.tsx (new)    # counts, cautions, suppressed count, exclusions
│   │   └── TargetMetrics.tsx (new)     # one target's numbers for a list row / overview card
│   ├── overview/*.tsx                  # recent published posts' numbers
│   └── shell/LeftNav.tsx               # one NAV_SECTIONS entry, Project group
├── app/p/[projectSlug]/
│   ├── insights/{page,loading,error}.tsx (new)
│   ├── (overview)/page.tsx             # per-post numbers
│   └── posts/page.tsx                  # per-row numbers
└── server/mcp/naming.ts                # docket_get_insights, in operation-table order

scripts/generate-icons.mjs              # `insights: "chart-line"`; then `pnpm icons` inside this worktree

drizzle/0047_*.sql                      # the single migration (verify the number against drizzle/)

tests/
├── unit/mcp/naming.test.ts             # the frozen twenty-one
├── helpers/api-fixtures.ts             # a getInsights fixture
└── integration/
    ├── insights/
    │   ├── fold.test.ts (new)              # contracts/fold.md §7 — nine assertions
    │   ├── first-engagement.test.ts (new)  # contracts/first-engagement.md §6 — eleven
    │   ├── trends.test.ts (new)            # US1
    │   ├── comparisons.test.ts (new)       # US3, US4 where rows are needed
    │   ├── surfaces.test.tsx (new)         # US2, incl. the query count for a 25-row page
    │   ├── page.test.tsx (new)             # the page, its states, its tables
    │   ├── retention.test.ts               # 080's — the one expected edit
    │   └── panel.test.tsx                  # 080's — must pass unchanged (FR-004)
    ├── api/{openapi,mcp-*,scope-enforcement,setup-permission}.test.ts
    ├── docs/mcp-docs.test.ts
    └── security/secret-scan.test.ts        # extended, never narrowed
# every pure part is unit-tested beside its source: src/lib/insights/*.test.ts

docs/
├── insights.md                 # the two closed gaps; the floor; the fold; the new named gaps
├── design-system.md            # a NEW appended section for chart conventions (FR-073)
├── adding-a-provider.md        # G38 in the index and a prose section
├── decisions.md                # the three judgement calls above, plus the unknown-key refusals
├── feature-map.md, mcp.md      # the page and the tool
└── research/{meta,pinterest}.md  # the two open period questions, recorded not guessed
```

**Structure Decision**: unchanged — the existing Next.js App Router monolith with a worker running the
same `runTick()`. Every file above is an addition to, or a small extension of, a directory that
already exists. The one new directory is `src/components/insights/`, which `docs/design-system.md`
will name as the only place chart SVG lives.

## Where the new work runs

```text
runTick()
└── section("housekeeping", runHousekeeping)        # no deadline; every step batch-bounded
    ├── … existing steps, unchanged …
    ├── recordFirstEngagement(config, now)         # NEW — bounded by INSIGHTS_PRUNE_BATCH
    ├── pruneEngagementItems(config, now)          # unchanged, now strictly after its reader
    ├── foldAndPruneAccountSnapshots(…, shapeFor)  # REPLACES pruneAccountMetricSnapshots
    └── foldAndPrunePostSnapshots(…, shapeFor)     # REPLACES prunePostMetricSnapshots
```

No new `SectionResult`, no new `Promise.all` entry, no new heartbeat, no new time share, no new
environment variable. `HousekeepingCounts` gains `accountMetricPointsFolded`,
`postMetricPointsFolded`, `firstEngagementRecorded` and `firstEngagementScanned`; the two existing
prune counts keep their names and meaning. `firstEngagementScanned` exists beside
`firstEngagementRecorded` precisely so FR-055's failure mode is visible: zero recorded with hundreds
scanned is a working pass; zero and zero is a stalled one.

## Implementation order

Each numbered phase is a commit boundary, and each is independently testable. The order is forced by
two things: nothing can be drawn before shapes exist, and **US5's fold is P2 in the spec but ships
early here** — every day without it is a day of history that becomes unrecoverable at the 400-day
boundary, and the spec says so itself.

1. **G38 and the classification.** `MetricShape`, the required field, all 46 keys, the index entry in
   `docs/adding-a-provider.md`, the decisions entry, the two research notes. Gate: `pnpm typecheck`
   fails with a shape removed; `panel.test.tsx` passes unchanged.
2. **Migration and schema.** The enum, three tables, `project-owned.ts`, `pnpm db:generate`,
   `pnpm db:check`.
3. **The fold** (US5, FR-050 to FR-057). `fold.ts`, the DAL claim/upsert/delete, `retention.ts`
   rewritten, housekeeping wired, counts added, the nine assertions.
4. **The constitution amendment** (FR-081), in its own `docs(constitution):` commit with a version
   bump, because from phase 3 the out-of-scope line is false.
5. **Trends** (US1, FR-010 to FR-016). `insights-read.ts`'s trend query, `trend.ts`, `TrendChart`, the
   page shell, the nav entry, `pnpm icons`, `check-contrast.mjs`, the design-system section.
6. **Per-post numbers where the work happens** (US2, FR-020 to FR-024). `TargetMetrics`, the two
   batched reads hoisted into `listPosts` and the overview, the query-count test.
7. **The comparisons** (US3, US4, FR-030 to FR-038). `floor.ts`, `compare.ts`, the
   `comparableTargetRows` query, `standingSeries` on the generation record and in the runner,
   `GroupChart`, `ComparisonCard`.
8. **First engagement** (US6, FR-040 to FR-046). The recorder, the pure figure layer, the comparison
   arm, the eleven assertions.
9. **The API operation** (US7, FR-060 to FR-064). `operations/insights.ts`, the registry line, and all
   five enumerated places in one commit.
10. **Docs, then the full pass.** `docs/insights.md`'s two closed gaps and new named gaps,
    `feature-map.md`, `mcp.md`, the extended secret scan, SC-011's no-HTTP test. Then once:
    `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm db:check` and `pnpm build`.
11. **The one human task** (FR-085, last): open the page with seeded data and judge chart legibility
    in both themes and at phone width, full keyboard operation, and what a screen reader conveys
    without colour (SC-009).

## Post-design re-check (after Phase 1)

Re-run against the artifacts above, not against the summary.

- **I. Verified facts.** Phase 1 added no external fact. The one place the design could have guessed —
  Pinterest's post-metric window, whose length varies with a pin's age — is declared
  `windowed` with `windowMs: null` rather than assigned a number, and the comparability limit that
  follows is named in `docs/insights.md` instead of normalised away. **PASS**
- **II. Nothing works unless it ran.** [quickstart.md](./quickstart.md) gives a runnable command per
  story and a failing-first check for FR-002's compiler gate. The only human task is visual and
  parked last. **PASS**
- **III. Project isolation.** All three tables carry `project_id`, cascade twice, and are registered
  in `project-owned.ts`. Both arms of the trend query's `UNION ALL` are pinned on `project_id = $1`
  ([contracts/fold.md](./contracts/fold.md) §4) so `scope-check` passes; the two cross-project passes
  stay inside `crossProject`. **PASS**
- **IV. One service layer.** Phase 1 reduced the count rather than raising it: one fold for two
  tables, one service for the page and the API, one recorder for history and new rows, one floor
  module, one panel decision for three surfaces. **PASS**
- **V. Providers are plug-ins.** `shape` is a declaration value; the fold receives `shapeFor` from the
  scheduler; no generic layer names a provider. **PASS**
- **VI. Boring.** Still no dependency, no infrastructure, no environment variable, no tick section.
  Phase 1's chart design removed the one thing that would have cost something — a categorical palette
  — by noticing that FR-011 and FR-034 make every chart single-series
  ([contracts/charts.md](./contracts/charts.md) §2). `check-contrast.mjs` is expected to report no new
  pair. **PASS**
- **VII. Secrets.** No credential is read anywhere. `target_first_engagement` has no text column at
  all, asserted at column level; the secret scan covers all three tables and the response. **PASS**

No new violations. [Complexity Tracking](#complexity-tracking) stays empty.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

None. No new dependency, no new infrastructure, no new environment variable, no new tick section, no
new permission or role, and no change to any existing table or provider request.

## Requirement coverage

| Requirement | Where it is designed | Where it is proved |
|---|---|---|
| FR-001 to FR-005 (G38, the shapes) | [contracts/metric-shape.md](./contracts/metric-shape.md), [research.md](./research.md) §1 | quickstart §1 |
| FR-010 to FR-016 (account trends) | [contracts/charts.md](./contracts/charts.md), [data-model.md](./data-model.md) §7.1 | quickstart §2 |
| FR-020 to FR-024 (overview, posts list) | plan "Implementation order" 6; `buildTargetInsightsView` reused | quickstart §3 |
| FR-030 to FR-038 (comparisons) | [contracts/comparisons.md](./contracts/comparisons.md) | quickstart §4 |
| FR-040 to FR-046 (first engagement) | [contracts/first-engagement.md](./contracts/first-engagement.md) | quickstart §7 |
| FR-050 to FR-057 (fold before prune) | [contracts/fold.md](./contracts/fold.md) | quickstart §5 |
| FR-060 to FR-064 (the operation) | [contracts/insights-api.md](./contracts/insights-api.md) | quickstart §8 |
| FR-070 to FR-074 (presentation) | [contracts/charts.md](./contracts/charts.md) | quickstart §6, §9 |
| FR-080 to FR-086 (docs, schema, process) | plan "Implementation order" 1, 2, 4, 10, 11 | quickstart §1, §6, §9 |
| SC-001 to SC-011 | as above, per story | quickstart §1-§9 |
