# Phase 0 research: the comparisons only Docket can make

**Feature**: 083-insights-schedule-intelligence | **Date**: 2026-10-18

This entry makes no platform call, so there is no endpoint, scope, price or rate limit to verify. The
research is therefore of two kinds, and both were done before any design:

1. **What each already-declared metric key actually means** (§1), because FR-001 cannot be satisfied
   by inspecting a key's name. Every row cites `docs/research/*.md` or the pinned request in Docket's
   own reader; nothing is classified from memory, and three keys are classified `unknown` because the
   research does not say.
2. **Where each fact a comparison needs is durably stored** (§2), because a comparison drawn over a
   180-day range reads rows that other housekeeping passes have already pruned. One of those
   dimensions turned out to be unrecoverable after 90 days — §2.3 is the one genuine discovery of
   this phase and it changes the design.

The rest records the design decisions the spec left to planning: the fold (§3), the first-engagement
record (§4), charts without a dependency or a new colour (§5), the query budget (§6) and the API
operation (§7). §8 lists what this phase refused to guess.

---

## §1 Metric shapes — the classification behind G38

**Decision.** `MetricKeyDeclaration` gains a required `shape` field, a discriminated union:

```ts
export type MetricShape =
  | { kind: "cumulative" }
  /** `windowMs: null` when the window exists but its length is not fixed or not confirmed. */
  | { kind: "windowed"; windowMs: number | null }
  /** Shown where the series would otherwise be (FR-004). */
  | { kind: "unknown"; reason: string };
```

**Rationale.** Required, not optional, so FR-002's "a provider added later MUST NOT be able to
declare a key without a kind" is enforced by `tsc` rather than by a test anyone can forget. The
discriminated union carries the window length where research confirms one and carries the *reason* on
`unknown`, which is what FR-004 must render. A bare string enum could not carry either.

**Alternatives considered.** A separate `metricShapes` map per provider (rejected: FR-002 says the
kind is declared "next to the key and label it already declares", and a parallel map can fall out of
step with the key list). A `windowSeconds?: number` on the existing interface with "absent means
cumulative" (rejected: absence would then mean both "cumulative" and "nobody said", which is exactly
the distinction FR-001 exists to make).

### 1.1 The classification, key by key

All 46 declared keys across eight providers. "Pinned" means the request Docket's own reader sends
today; FR-005 forbids changing any of them.

| Provider | Surface | Key | Shape | Source |
|---|---|---|---|---|
| bluesky | post | `likeCount`, `repostCount`, `replyCount`, `quoteCount` | `cumulative` | `PostView` counters are running totals on the post record (`docs/research/bluesky.md:83-84`) |
| bluesky | account | `followersCount`, `followsCount`, `postsCount` | `cumulative` | `ProfileViewDetailed` counters are running totals (`docs/research/bluesky.md:87`, with a live reading at `:96`) |
| instagram | post | `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions` | `cumulative` | `docs/research/meta.md:443-452` — "lifetime (no `period` param)" for every one; reader pins no `period` (`src/providers/instagram/insights.ts:124`) |
| instagram | account | `reach` | `windowed`, `windowMs: 86_400_000` | `docs/research/meta.md:466` — `period=day`, CONFIRMED; reader pins `period: "day"` (`insights.ts:154`) |
| instagram | account | `follower_count` | `windowed`, `windowMs: 86_400_000` | `docs/research/meta.md:467` — `period=day`, CONFIRMED; label is already the platform's own "New followers" |
| facebook | post | `post_media_view`, `post_total_media_view_unique`, `post_reactions_by_type_total`, `post_clicks` | `cumulative` | `docs/research/meta.md:677-693` — live-verified on v26.0 with `period=lifetime`, which Docket's reader pins (`src/providers/facebook/insights.ts:175`); `meta.md:476-479` records `lifetime` for the two older keys |
| facebook | account | `page_post_engagements` | `unknown` | `docs/research/meta.md:519-522` lists `day/week/days_28`. Docket's reader pins **no** `period` (`src/providers/facebook/insights.ts:200-206`), so which of the three answers is not confirmed, and FR-005 forbids pinning one here |
| facebook | account | `page_follows` | `unknown` | `docs/research/meta.md:521` records the period as **"not stated"** — the exact case the spec names in FR-005 |
| threads | both | *(none declared)* | — | `src/providers/threads/insights.ts:25-29` declares `post: []`, `account: []` |
| tiktok | post | `tiktok_like_count`, `comment_count`, `share_count`, `view_count` | `cumulative` | `/v2/video/query/` returns per-video running totals (082 research §1, `docs/research/tiktok.md`) |
| tiktok | account | `tiktok_follower_count`, `likes_count`, `video_count` | `cumulative` | 082 research §1: `likes_count` is "the total number of likes received by the user across all of their videos", `video_count` "the total number of publicly posted videos" |
| pinterest | post | `IMPRESSION`, `PIN_CLICK`, `OUTBOUND_CLICK`, `SAVE` | `windowed`, `windowMs: null` | `summary_metrics` totals the `[start_date, end_date]` the request names, and Docket's window is `[max(publishedDate, today − 90d), today]` (082 research §2 and §6) — a *rolling* window whose length grows with the pin's age and then clamps at 90 days. There is no fixed length to state |
| pinterest | account | `pinterest_follower_count` | `cumulative` | `GET /v5/user_account`'s `follower_count` is a running total (`docs/research/pinterest.md:171`) |
| pinterest | account | `monthly_views` | `unknown` | `docs/research/pinterest.md:171` names the field and nothing else. No source states the window, and the name is not a source (constitution I). The spec names this key as `unknown` too |
| x | post | `like_count`, `reply_count`, `retweet_count`, `quote_count`, `bookmark_count`, `impression_count` | `cumulative` | `public_metrics` are per-tweet running totals (082 research §3, `docs/research/x.md`) |
| x | account | *(none declared)* | — | 082 declared `account: []` because the per-user read price is UNVERIFIED |
| mock | post | `likeCount`, `repostCount`, `viewCount` | `cumulative` | Docket's own fixture platform; see 1.3 |
| mock | account | `followersCount`, `postsCount` | `cumulative` | as above |

### 1.2 What `unknown` costs, stated plainly

Three keys are `unknown`: `page_follows`, `page_post_engagements`, `monthly_views`. Under FR-004 they
are absent from every trend and comparison with their reason shown, and keep appearing as a latest
number on the existing panels. The practical effect: **Facebook Pages get no account trend at all**
(both their account keys are `unknown`), and Pinterest gets a follower trend but no monthly-views
trend. That is the honest outcome of the research and it is recorded as a named gap in
`docs/insights.md`, with the fix named: pin a `period` on the Facebook account read, which is a
reader change and belongs to a later entry.

### 1.3 Why `mock` stays entirely `cumulative`

FR-005 forbids changing any provider's declared keys, so no `windowed` or `unknown` key can be *added*
to `mock`, and reclassifying one of its three existing keys would silently redefine a fixture other
suites already assert against. The `windowed` and `unknown` code paths are therefore exercised two
ways: through the real Instagram (`windowed`), Facebook and Pinterest (`unknown`) declarations in the
integration fixtures that already exist (`tests/integration/insights/four-platform.test.tsx`), and
through synthetic declarations in unit tests — every pure function in this entry takes a declaration
as an argument, so a unit test can hand it any shape without touching a provider.

---

## §2 Where each comparison's facts durably live

A comparison over a member-chosen range reads rows several housekeeping passes already prune. Each
dimension was checked against the schema and the prune that could remove it.

### 2.1 Dimensions that are durable as they stand

| Dimension | Read from | Survives because |
|---|---|---|
| Posting slot | `post_targets.slot_occurrence_at`, `.slot_id` | `slot_id` is `ON DELETE SET NULL` (`schema/posts.ts:210`) but `slot_occurrence_at` is a plain column that survives the slot's deletion — so FR-037's "removed slot" group is drawable from the occurrence alone |
| Day of week / local hour | `post_targets.slot_occurrence_at` (slot-scheduled) or `.published_at` (explicit/now) | plain columns on a row that only disappears with its post |
| Origin | `posts.origin` (`manual`/`generated`/`api`) | `NOT NULL` enum column, never rewritten |
| Voice profile | `posts.generation_metadata -> 'records' -> -1 -> 'voiceProfile'`, which carries **both** `id` and `name` (`src/lib/validation/generation.ts:78`) | `generation_metadata` is jsonb on the post and is pruned by nothing. The recorded `name` is what makes FR-037's "removed profile" label possible after the profile row is deleted; the *current* name (acceptance US4.4) comes from the live `voice_profiles` row when it still exists |
| Metric values | `post_metric_snapshots` + the new rollup points | §3 |

The voice-profile finding matters: every generated post, **including one created by the standing-series
runner** (`src/server/services/standing-series/runner.ts:24` calls `saveGeneratedPost`, which writes
`generationMetadata: { v: 1, records: [record] }` at `src/server/services/generation/save.ts:66`),
carries its own voice profile id and name forever. The by-voice comparison needs no join to
`standing_series` at all, and a post with no record forms the stated "not generated" group.

### 2.2 The 90-day hole in the series-kind dimension

The by-series-kind comparison needs each post's standing series' `occurrence_rule` (`cadence` =
071's evergreen, `dated_list` = 072's date-pegged). The only path from a post to that value today is:

```
posts.standing_series_position_id
  -> standing_series_positions.run_id
  -> standing_series_runs.series_id
  -> standing_series.occurrence_rule
```

and `pruneClosedStandingSeriesRuns` deletes closed runs after **90 days**
(`STANDING_SERIES_RUN_RETENTION_DAYS`, `src/server/scheduler/housekeeping.ts:30, 135-140`). Positions
cascade with their run, and `posts_standing_series_position_fk` is **`ON DELETE SET NULL`**
(`src/server/db/schema/posts.ts:117-121`). So roughly 90 days after a standing-series post publishes,
Docket forgets it came from a series at all — the link is nulled, not merely unlabelled.

Left alone, the by-series-kind comparison would work on a 30-day range (the default) and then
silently lose arms as a member widened the range, which is precisely the dishonesty FR-036 and FR-037
exist to prevent. Nothing in the spec's requirements can be satisfied for a 180-day range.

**Decision.** Record the fact on the post at creation time, in the one place that already records
durable generation facts: `generationRecordSchema` gains an optional

```ts
standingSeries: z.object({
  id: z.string(),
  name: z.string(),
  occurrenceRule: z.enum(["cadence", "dated_list"]),
}).nullish()
```

written by the standing-series runner through `saveGeneratedPost`. At read time the comparison
prefers the recorded fact, falls back to the live position→run→series join while that still resolves,
and counts a post with neither as a **stated exclusion** ("Docket no longer records which series this
post came from") under FR-036.

**Rationale.** It mirrors exactly how `voiceProfile` is already recorded on the same record, needs no
migration (jsonb, and the field is `nullish` so every stored record still parses), survives both the
run prune and the series' own deletion, and satisfies FR-037's "removed series" label from the
recorded `name`. The fallback means posts that exist *today* are still comparable for their first 90
days, and the stated exclusion is honest about the rest.

**Alternatives considered.**

- *A `posts.standing_series_id` column with a composite FK, `ON DELETE SET NULL`.* Survives the run
  prune (series rows are never pruned) but not the series' deletion: a null would then mean both
  "never in a series" and "the series was deleted", which fails FR-037. Also a migration for a fact
  the existing jsonb already has a home for.
- *Stop pruning standing-series runs.* Changes another feature's retention contract to serve this
  one, and keeps far more than the comparison needs.
- *Accept the loss and state it.* Rejected: the entry would ship a comparison that is correct at 30
  days and quietly wrong at 180, and `docs/decisions.md` would carry a known-wrong screen. The
  stated exclusion is kept **as well**, for posts that predate this change.

### 2.3 Time to first engagement

`engagement_items` already carries `parent_post_target_id` (`src/server/db/schema/engagement.ts:46`),
so the join is direct. But those rows are pruned at `ENGAGEMENT_RETENTION_DAYS` (default 90,
`src/server/env.ts:359`) and deleted outright on withdrawal, so any figure *recomputed* from them
shrinks and then lengthens. Hence FR-040's write-once record; the design is §4.

---

## §3 The fold, and fold-before-prune

### 3.1 Fuse the fold and the delete into one transaction

**Decision.** There is no separate "fold pass" followed by a "prune pass". Each bounded batch:

1. selects the oldest `insightsPruneBatch` snapshot rows with `captured_at < now − retentionDays`,
   `FOR UPDATE SKIP LOCKED`;
2. upserts one rollup point per (subject, metric key, UTC day) from those rows;
3. deletes exactly those row ids —

all inside one transaction.

**Rationale.** FR-051 ("a prune MUST NOT delete any row the fold has not yet covered"), FR-052 ("if
the fold fails or is incomplete, no snapshot row MUST be deleted") and FR-057 (safe to run
concurrently and to kill mid-run) all become properties of the transaction rather than of a watermark
anyone could compute wrongly. A row can only ever be deleted by the same transaction that folded it,
so there is no state in which a snapshot is gone and its point is missing — however the process dies,
and however many schedulers run. `FOR UPDATE SKIP LOCKED` is the claim idiom the constitution already
mandates, and it hands two concurrent schedulers disjoint rows. No provider call is involved, so the
constitution's "no provider call inside a held transaction" is not touched, and the batch is 200 rows.

This is **stronger** than FR-051 reads literally, and a reviewer checking FR-051 against the code will
find no "fold step" ordered before a "prune step" — it is recorded here and in `contracts/fold.md` so
that is a deliberate strengthening, not a missing requirement.

**Alternatives considered.** A fold pass that advances a stored watermark, with the prune clamped to
`min(retentionBoundary, watermark)` (rejected: a second piece of state, a second failure mode, and
the race FR-057 names becomes real — one scheduler's prune can read another's half-advanced
watermark). A database trigger on delete (rejected: the constitution's style keeps append-only and
retention properties in the DAL, not in triggers — `schema/insights.ts:7` says so explicitly).

### 3.2 The upsert is commutative, which is what makes it idempotent

`ON CONFLICT (project_id, subject_id, metric_key, captured_day) DO UPDATE SET value = EXCLUDED.value,
captured_at = EXCLUDED.captured_at, kind = EXCLUDED.kind WHERE EXCLUDED.captured_at >
<table>.captured_at`.

"The newest capture that day wins" is order-independent, so two schedulers folding different rows of
the same day in either order reach the same point, and re-folding a row already folded changes
nothing (FR-053). It is also exactly FR-013's drawing rule for a `windowed` metric, pre-applied.

### 3.3 The grain is a UTC day, not a stored project-local day

FR-050 says "one per subject, per metric key, per **project-local** day". The Time edge case in the
same spec says "**No bucket is stored pre-computed in a local zone**" and "a project whose time zone
changes re-buckets everything on the next read". As written, the two cannot both hold.

**Decision.** The point's identity is the **UTC day** of its `captured_at`, and the point stores the
real `captured_at` instant it came from. The reader re-buckets into project-local days from
`captured_at` using the project's *current* time zone.

**Rationale.** A local day overlaps at most two UTC days, so UTC-day grain is never coarser than
local-day grain: every local day that had a reading still has at least one point, and where it has
two the reader applies FR-013's "newest reading for that day" and gets the same answer a stored
local-day bucket would have given. Unlike a stored local-day bucket, it stays correct after the
project's time zone changes — which is the requirement that would otherwise be impossible to meet
once the snapshots are gone. The local-day *property* FR-050 wants is preserved; only the stored key
differs, and it differs in the safe direction.

`captured_day` is written by TypeScript from the instant. It is **not** CHECK-enforced against
`captured_at`, because both candidate expressions (`date_trunc('day', captured_at)` and
`captured_at AT TIME ZONE 'UTC'`) are STABLE rather than IMMUTABLE for a `timestamptz` and Postgres
rejects them in a CHECK. The invariant is asserted by test instead, as the append-only property of
the snapshot tables already is.

### 3.4 Post snapshots are folded too, on the same grain

FR-050 says "before **any** snapshot is pruned", and the comparisons read the latest value per
target: without a post rollup, every comparison over a range older than `INSIGHTS_RETENTION_DAYS`
loses its posts. Both tables fold, through one generic function parameterised by subject, so there is
one implementation, one upsert shape and one test (constitution IV).

Growth, stated because the rollup tables are **never pruned** — that is their purpose. Accounts:
`accounts × declared keys` rows per day forever (4 accounts × 3 keys ≈ 4.4k rows/year). Posts: the
decaying poll schedule gives a target roughly 8-15 readings across its life, collapsing to ~8 days ×
4-7 keys per target — a net *reduction* against the snapshots they replace, since a target polled four
times a day folds to one point.

---

## §4 The first-engagement record

**Decision.** One row per published target, written by one bounded housekeeping step, storing
**instants, not intervals**, and never overwriting a figure it has already written:

- `exact_first_at` — the `said_at` of the earliest inbox item whose `parent_post_target_id` is this
  target. Written once; preferred at read time (FR-041).
- `bound_before_at` — the `captured_at` of the first snapshot in which any declared engagement metric
  for this target was above zero.
- `bound_after_at` — the `captured_at` of the snapshot immediately before it; `null` while
  `bound_before_at` is set means "engagement was already there in the very first reading", which the
  reader renders as the upper bound FR-042 requires.
- `scanned_through` — the newest `captured_at` examined. A watermark, not a figure: it moves forward
  every pass, which is how "no engagement observed through <time>" stays honest and how the step
  avoids rescanning.
- `published_at` — copied, so the interval survives anything that happens to the target's own row.

**Rationale, point by point.**

- **Instants, not intervals.** No unit to choose, no overflow (an `integer` of milliseconds caps at
  24.8 days, and a first reply a month later is ordinary), and the provenance *is* the data. The
  interval is arithmetic at read time.
- **Both an exact figure and a bound, each written once.** FR-041 prefers the exact figure; FR-043
  forbids overwriting. If the poll happens to record a snapshot bound before the inbox read ingests
  the reply, a single-figure row would have to choose between breaking one requirement or the other.
  Two independently write-once fields break neither: each is written when first observed, neither is
  ever rewritten, and the *preference* is a read-time choice.
- **One place, not two.** All recording happens in the housekeeping step, never in the insights poll's
  commit path. That gives one implementation for historical targets and new ones alike (FR-046 needs
  no separate backfill, and no migration-time derivation), keeps the poll's hot path untouched, and
  makes the step idempotent by construction. The inbox read runs every tick while insights polls at
  most every 15 minutes, so a reply is picked up long before `ENGAGEMENT_RETENTION_DAYS` could reach
  it.
- **The step runs before `pruneEngagementItems` in the same pass**, for the same reason the fold runs
  before its delete.
- **Write-once is enforced by the DAL, not a CHECK**: each write is a compare-and-set
  (`UPDATE … WHERE exact_first_at IS NULL`), which is both the write-once guarantee and the
  concurrency guarantee. Same pattern as the snapshot tables' append-only property.
- **No inbox identifier is stored.** Not the item id, not the author, not the text, not a URL — only
  the instant. The spec's assumption that insights do not inherit the inbox's stricter permission
  rests on the derived figure carrying nothing about the commenter, and that is only true if the row
  holds nothing about them.

**Alternatives considered.** Recomputing on every read from `engagement_items` + snapshots (rejected
by FR-043 and by the spec's own analysis: the figure would shrink and then lengthen as rows are
pruned). Writing the record inside the insights-poll commit (rejected: two implementations, and
historical targets would need a separate backfill path that the housekeeping step gives for free).
Storing a single `first_engagement_at` with a `source` column (rejected: see "both" above).

---

## §5 Charts: no new dependency, and no new colour pair

**Decision.** Server-rendered inline SVG, built from `viewBox` plus plain `<path>`/`<rect>` elements
in server components, with no client JavaScript, no charting library and **no new colour token**.

**Rationale on colour**, which is the part that would otherwise cost a palette. FR-011 and US1 put
each account's metric in **its own chart with its own axis**, and FR-034 restricts a comparison to one
platform and one metric per series. So no chart in this entry has more than one series, and a
categorical palette — the usual reason a chart needs new colours — is never needed. Marks use
`primary`, axes and gridlines `border`, axis labels `muted-foreground`; all three pairs are already
in `scripts/check-contrast.mjs`'s 27. The script is still run (FR-071) and is expected to report no
new pair.

Where two things must be told apart within one chart — a `ranked` group against a `provisional` one —
the difference is **shape plus text**: a hatched fill (an SVG `<pattern>`) and the words "few posts",
never a second colour. That satisfies FR-071 and the design system's "status is text plus colour"
rule without introducing a pair to check.

Every chart is accompanied by a real `<table>` carrying the same numbers, each series named with its
platform, metric and sample size (FR-072). The table is the accessible equivalent *and* the audit
surface for "never sum across platforms": a reviewer can read the rule off the DOM instead of off
pixels. The SVG itself gets `role="img"` and an `aria-labelledby` pointing at its caption, with
`aria-hidden` on the decorative parts.

**Alternatives considered.** A charting library (rejected by the constitution's "Boring, few
dependencies" and the spec's own out-of-scope list; also unavailable — pipeline phases cannot reach
the npm registry). Client-side canvas (rejected: server components by default, and nothing here is
interactive). CSS-only bars with `div` widths (workable for bars, but the trend needs a polyline, and
one technique for both charts beats two).

---

## §6 The query budget

**Decision.** The whole Insights page is **three** scoped reads plus the accounts list, and the posts
list and overview gain **two** batched reads each, whatever the row count.

| Surface | Reads added | Shape |
|---|---|---|
| Insights page | `accountTrendRows(accountIds, from, to)` | one query: declared-key rows from `account_metric_snapshots` `CROSS JOIN LATERAL jsonb_each(metrics)` filtered to `jsonb_typeof(value) = 'number'`, `UNION ALL` the rollup points for the same window |
| Insights page | `comparableTargetRows(from, to)` | one query: one row per comparable published target carrying every dimension key (slot occurrence, slot id, schedule kind, origin, the last generation record's `voiceProfile` and `standingSeries` paths, the live series-rule fallback) and its latest value per metric key via `DISTINCT ON` over snapshots `UNION ALL` rollups |
| Insights page | `firstEngagementRows(targetIds)` | one query |
| Posts list, overview | `postMetricSnapshots.latestForTargets(ids)` and `postMetricPollStates.getMany(ids)` | the two batched repo methods the detail panel already uses (`src/server/services/posts/view.ts:62-65`) |

**Rationale.** FR-024 and SC-002 forbid per-row queries, and both repo methods already take an id
array, so the posts list needs no new DAL at all — it needs the two calls `getPostView` already makes,
hoisted to the list. The dimension extraction happens in SQL (`generation_metadata -> 'records' -> -1
-> 'voiceProfile' ->> 'id'`; Postgres indexes `->` from the end for a negative integer) so the full
jsonb document is never pulled across for 25 posts.

**Grouping is pure TypeScript, not five SQL statements.** One fetch of per-target rows feeds all five
dimensions in `src/lib/insights/compare.ts`. Row counts are small by construction — a 30-day range on
a project publishing ten posts a week with three targets each is ~130 rows, a year ~1,500 — and every
threshold, exclusion, verdict and refusal in FR-031 to FR-037 becomes unit-testable without a
database. The SQL stays one statement that can be scope-checked once.

---

## §7 The API operation and the five places that enumerate the surface

**Decision.** One operation, `getInsights` → `GET /insights`, `permission: "read"`,
`idempotent: false`, `mcp: { expose: true }`, in a new `src/server/api/operations/insights.ts`
registered in `OPERATIONS` **after `activityOperations`**.

**Rationale for `expose: true`.** It is a read-only, bounded, project-scoped view of numbers an agent
asking "how did last week do?" needs, it takes no confirmation (`McpConfirm` guards effects, and this
has none), and US7 asks for it by name. Position after `activityOperations` places
`docket_get_insights` after `docket_list_activity` in `PUBLISHED_TOOL_NAMES`, which is maintained in
operation-table order.

**The five enumerated places**, each guarded by its own test and each failing with a near-identical
message, so all five change in one commit:

1. `src/server/mcp/naming.ts` — `PUBLISHED_TOOL_NAMES`, in operation-table order.
2. `tests/unit/mcp/naming.test.ts` — the same list literally, plus the count in the test's own name:
   `"is the frozen twenty"` becomes `twenty-one`.
3. `tests/helpers/api-fixtures.ts` — a call fixture per operation (used by `scope-enforcement`).
4. `tests/integration/api/setup-permission.test.ts` — its own second table, `OTHER_FIXTURES`.
5. `docs/mcp.md` — the tool table and the prose count in `## 3. The 20 exposed tools` (→ 21), parsed
   by `tests/integration/docs/mcp-docs.test.ts`.

**The refusal the response must carry.** FR-063 forbids returning a ranking the screen would decline
to draw, so the verdict is part of the schema, not a presentation detail: every group carries
`sampleSize` and `verdict: "ranked" | "provisional"`, every comparison carries
`conclusion: "ranked" | "not_enough_posts"` and an `exclusions` array. A client cannot accidentally
sort an unranked comparison into a ranking without ignoring a field that is always present.

---

## §8 What this phase did not resolve, and why nothing depends on it

- **Facebook's account period and Pinterest's `monthly_views` window** stay `unknown` (§1.1). Both
  would need a reader change, which FR-005 forbids. Recorded in `docs/research/meta.md`,
  `docs/research/pinterest.md` and `docs/decisions.md`; no requirement, default or test depends on
  an answer.
- **The aggregate for a comparison** is the spec's own assumption — the group's mean with its median
  alongside — and needs no research. No significance test, confidence interval or forecast is
  computed, by FR-038.
- **Whether a `windowed` post metric is comparable across posts of different ages.** Pinterest's four
  post keys total a window that grows with the pin's age and then clamps at 90 days, so comparing a
  100-day-old pin's impressions against a 10-day-old pin's compares different windows. This is a
  weaker version of a problem every `cumulative` metric has too (an older post has had longer to
  accrue), and the spec does not ask for age normalisation. The comparison states the metric's shape
  and its window beside the figure; nothing is normalised, nothing is hidden. Named in
  `docs/insights.md` as a known limit of comparing posts of different ages.
- **No live verification is possible or needed.** This entry makes no platform call, so constitution
  II is satisfied entirely by mocks and fixtures; the only work needing a browser is the visual and
  accessibility judgement on the charts, parked at the end of the task list per FR-085.
