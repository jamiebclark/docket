# Feature Specification: the comparisons only Docket can make

**Feature Branch**: `083-insights-schedule-intelligence`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "No new platform calls: this entry reads the snapshot history the first three accumulated and turns it into the thing a native dashboard cannot give, because only Docket knows why a post went out when it did. Account trends from `account_metric_snapshots` — follower and reach over time per account, per platform, **never summed**. Per-post performance surfaced where the work happens: the project overview (`src/app/p/[projectSlug]/(overview)/page.tsx`) and the posts list, not only the detail panel entry 1 added. Then the comparisons: performance by slot and by day of week (`post_targets.slotOccurrenceAt`, `scheduleKind`), by series — evergreen (071) against date-pegged (072) — by voice profile, and model-generated against hand-written. Plus time-to-first-engagement, joining the snapshot history to the inbox rows 077 already stores. Every comparison must state its own sample size and refuse to draw a conclusion from too few posts; a chart over three posts is noise with axes. Follow `docs/design-system.md` and the project's chart conventions, and keep each platform's series visually separate so the \"never sum across platforms\" rule holds in the UI and not just the data layer. One API operation in a new `src/server/api/operations/insights.ts`, registered in `OPERATIONS` with an explicit `mcp.expose` decision. Retention and pruning of old snapshots join the existing housekeeping section with an `INSIGHTS_RETENTION_DAYS` knob — aggregate **before** pruning, so a year-old trend survives the row that produced it. Does **not**: add any provider reader, any new scope, or any new platform. Everything it needs landed in entries 1-3." (section 4 of `.specify/roadmaps/social-insights.md`)

## Overview

080 built the spine: the `insights?` capability (G30), two append-only snapshot tables, per-target and
per-account poll state, a decaying read schedule, a bounded `runInsightsPoll` tick section, and one
honest performance panel on the post detail page. 081 added the permission machinery and the Meta
family. 082 finished the platforms. Together they have been writing `post_metric_snapshots` and
`account_metric_snapshots` on schedule, and `docs/insights.md` records what that deliberately does not
do yet:

> **No chart, trend, delta or comparison of any kind.** The panel shows the one latest reading and
> nothing else.
>
> **Account snapshots are captured but shown nowhere.** […] that capture exists so a later entry
> covering account trends does not have to wait for history to accumulate.

This is that entry. It makes no platform call of any kind. Every number it shows was already read and
stored by entries 1-3; this entry is arithmetic, layout and honesty.

Two of those three are the easy part. The honesty is the work, and it has four distinct edges:

**A metric over time is not the same shape as a metric right now.** The panel 080 built renders one
reading, so it never had to ask what a number *means*. A trend does. Bluesky's `followersCount` is a
running total: plot it as a line and a rise is new followers. Instagram's `follower_count` is labelled
"New followers" and is read with `period=day` (`src/providers/instagram/insights.ts:154`,
`docs/research/meta.md:467`) — it is a *one-day window*, read every six hours
(`INSIGHTS_DEFAULTS.accountPollIntervalMs`, `src/server/scheduler/config.ts:185`), so four consecutive
snapshots describe four heavily overlapping days. Drawn as a cumulative line it is a lie; added
together it is a worse lie. `MetricKeyDeclaration` (`src/providers/types.ts:623`) carries only `key`
and `label` — nothing says which kind a key is. Closing that gap is this entry's one generic change.

**Too few posts is not a small answer, it is no answer.** "Thursday wins" over three posts is noise
with axes. Every comparison this entry draws carries its own sample size and declines to rank below a
stated floor.

**The inbox is not a measurement instrument.** Time-to-first-engagement is the one comparison that
needs 077's rows, and those rows are pruned at 90 days by default (`ENGAGEMENT_RETENTION_DAYS`,
`src/server/env.ts:359`) and deleted outright when a reply is withdrawn upstream
(`docs/engagement.md` §Retention). A figure recomputed from that table shrinks and then silently
*lengthens* as history disappears. It has to be recorded once, when first observed, and kept.

**Retention is already pruning.** 080 shipped `INSIGHTS_RETENTION_DAYS` (default 400) and the two
prune passes already run in `runHousekeeping` (`src/server/scheduler/housekeeping.ts:166-167`). What
does not exist is anything that survives them. A 400-day-old trend point must outlive the snapshot row
that produced it, which means a rollup that runs **before** the prune and a prune that can never
outrun the rollup.

Everything else follows from the roadmap's standing rules, which this entry inherits unchanged: never
sum or average across platforms; a metric the platform does not provide is absent, never zero; a
figure always says what it is "as of"; nothing overwrites a snapshot; no credential reaches a row, a
log or a response.

## Clarifications

### Session 2026-10-18

- Q: What counts as "too few posts"? → A: A group is **ranked** only with 8 or more comparable posts,
  **shown with a caution** at 4-7, and **not drawn at all** below 4. A comparison whose every group is
  below 8 states that it cannot yet conclude anything and shows the counts it has. Chosen because the
  roadmap's own example ("a chart over three posts") must fall below the floor, and because a
  four-arm comparison (two series kinds × two origins) needs a floor low enough to be reachable by a
  real project within an entry's horizon.
- Q: Where do the trends and comparisons live? → A: One new **Insights** page per project
  (`/p/[projectSlug]/insights`), under the left nav's `Project` group, holding account trends and
  every comparison. Per-post numbers additionally appear on the overview and the posts list, as the
  roadmap directs. Chosen over scattering comparisons across existing pages because a comparison needs
  a date range and a platform filter that no existing page has, and over a new nav group because the
  nav already has three and insights is a project-level read.
- Q: Does a metric whose kind cannot be confirmed get plotted? → A: No. It is classified `unknown` and
  is **absent from every trend and comparison**, while its latest reading still shows as a number on
  the existing panel. An unconfirmed window is exactly the case the absent-never-zero rule exists for,
  applied to a whole series rather than one cell.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Is this account growing? (Priority: P1)

A member opens the project's Insights page. For each connected account that has account snapshots,
they see that account's own numbers over time: Bluesky's followers as a line that goes up and down,
Instagram's reach as a bar per day, TikTok's follower count as its own line. Each account is its own
chart with its own axis. Nothing is added together, nothing is averaged across platforms, and a
platform that reports no account numbers at all (Threads, X today) is simply not there — no empty
chart, no zero line. Every chart states the date range it covers and when its most recent point was
captured.

**Why this priority**: `docs/insights.md` names "No account-metric screen yet" as a known deliberate
gap, and entries 1-3 have been accumulating this data for exactly this moment. It is the single
largest unused asset in the database, and it needs no join to anything.

**Independent Test**: Seed `account_metric_snapshots` for four accounts across three platforms over 30
days, open the page, and confirm one chart per account, correct per-platform labelling, a gap where a
day has no snapshot, and no figure anywhere that combines two platforms.

**Acceptance Scenarios**:

1. **Given** a Bluesky account with 30 daily snapshots of `followersCount`, **When** a member opens
   Insights, **Then** a single rising-and-falling line is drawn with the platform's own label
   "Followers", and the chart states the window and the "as of" time of the newest point.
2. **Given** an Instagram account whose `reach` is a `period=day` reading taken four times a day,
   **When** the trend is drawn, **Then** at most one value per project-local day is shown (the newest
   reading for that day) and the values are never added across days or across readings.
3. **Given** a Threads account (which declares `account: []`), **When** a member opens Insights,
   **Then** no Threads account chart appears and no zero-valued series is drawn; a line states that
   Threads reports no account numbers, with a link to `docs/insights.md`.
4. **Given** two Instagram accounts in one project, **When** trends are drawn, **Then** they are two
   separate series or charts and no combined follower total appears anywhere on the page.
5. **Given** an account whose polling has been failing for a week, **When** its trend is drawn,
   **Then** the missing days are a visible gap — not interpolated, not zero — and the chart says when
   the last successful reading was.
6. **Given** a metric whose cumulative-or-windowed kind is not confirmed (Facebook's `page_follows`,
   whose period `docs/research/meta.md:521` records as "not stated"), **When** trends are drawn,
   **Then** that metric is absent from the trend, with a stated reason, and is still shown as a latest
   number on the existing panels as before.

---

### User Story 2 - How did last week's posts do, without opening each one? (Priority: P1)

A member looks at the project overview and sees recent published posts with their numbers beside them,
read from the latest snapshot per target. They open the posts list and the same numbers are on the
rows. They no longer have to click into a post to learn it did nothing. Each number is labelled with
its platform's own word, each carries its "as of", and a post whose platform reports nothing, or which
has not been polled yet, says so rather than showing a zero.

**Why this priority**: The roadmap's phrase is "surfaced where the work happens". The detail panel 080
built answers a question a member has to already be asking; the overview and the list answer it before
they ask.

**Independent Test**: Seed published targets across platforms with and without snapshots, and confirm
the overview card and the list rows show the right per-platform numbers, the right honest states, and
no cross-platform total.

**Acceptance Scenarios**:

1. **Given** a published post with one Bluesky target holding a snapshot, **When** a member views the
   posts list, **Then** the row shows that target's numbers with Bluesky's own labels and an "as of"
   time.
2. **Given** a post with one Instagram and one Bluesky target, **When** the row is shown, **Then** each
   platform's numbers are presented separately and no row anywhere shows a single combined engagement
   figure for the post.
3. **Given** a published target that has not been polled yet, **When** the row is shown, **Then** it
   says so (or shows nothing for that metric) and never renders `0`.
4. **Given** a target published by hand with no external id (allowed by
   `post_targets_published_has_id`), **When** the row is shown, **Then** it states that Docket has no
   post to read numbers from, consistent with the existing panel's `no_external_id` state.
5. **Given** a project with no insights data at all, **When** a member opens the overview, **Then** the
   overview is unchanged apart from an honest empty state, nothing on the page breaks, and no extra
   per-row query is issued.
6. **Given** a posts list page of 25 posts each with 3 targets, **When** the page is rendered, **Then**
   the numbers for every row are fetched in a bounded number of queries that does not grow with the
   number of rows.

---

### User Story 3 - Does the time I post change anything? (Priority: P2)

On the Insights page a member sees the project's published posts grouped by the slot they went out in,
and by project-local day of week, with the chosen platform's own metric on the axis. Beside every group
is the number of posts it is based on. Groups with 8 or more posts are ranked; groups with 4-7 carry a
caution; groups below 4 are not drawn. If no group reaches 8, the comparison says plainly that it
cannot conclude anything yet and shows the counts it has.

**Why this priority**: This is the comparison a native dashboard structurally cannot make, because only
Docket knows a post went out in the Tuesday 09:00 slot rather than at some timestamp.

**Independent Test**: Seed published slot-scheduled targets across weekdays with known snapshot values,
then assert the group ordering, the per-group counts, and the refusal behaviour at each threshold.

**Acceptance Scenarios**:

1. **Given** 12 posts in a Tuesday 09:00 slot and 10 in a Friday 17:00 slot on one account, **When** the
   by-slot comparison is drawn, **Then** both groups appear with their counts and are ranked by the
   selected metric.
2. **Given** a slot with 3 published posts, **When** the comparison is drawn, **Then** that group is not
   drawn, and the comparison states how many groups it suppressed and why.
3. **Given** every group has fewer than 8 posts, **When** the comparison is drawn, **Then** no ranking,
   "best", "worst" or "winner" wording appears anywhere; the comparison states it cannot yet conclude
   and shows the counts.
4. **Given** a posting slot that has since been deleted (so `post_targets.slot_id` is null while
   `slot_occurrence_at` survives), **When** the comparison is drawn, **Then** those posts are still
   grouped by their occurrence's project-local weekday and local time, labelled as a removed slot.
5. **Given** targets whose `schedule_kind` is `explicit` or `now`, **When** the by-slot comparison is
   drawn, **Then** they are excluded from it (they occupy no slot) and that exclusion is stated with a
   count; they are still included in the by-day-of-week comparison, grouped by their published time.
6. **Given** a 09:00 slot occurrence either side of a daylight-saving change in the project's time
   zone, **When** posts are grouped by day of week and local hour, **Then** both fall in the 09:00
   bucket on their correct local weekday.
7. **Given** two accounts on different platforms in the same project, **When** a comparison is drawn,
   **Then** each platform's figures stay in their own series with that platform's own metric name, and
   no bar represents two platforms' values added together.
8. **Given** the project's time zone is changed in settings, **When** the comparison is reloaded,
   **Then** the weekday and local-hour buckets are recomputed from the stored UTC timestamps under the
   new zone.

---

### User Story 4 - Which of the things I make actually works? (Priority: P2)

The same page compares the project's published posts along the four content dimensions Docket already
records: posts belonging to a standing series with a cadence rule (071's evergreen) against those with
a dated list rule (072's date-pegged); posts grouped by the voice profile that generated them; and
model-generated posts against hand-written ones. Every group states its sample size and obeys the same
floor. A dimension the project has never used — no standing series, one voice profile, nothing
generated — says so rather than drawing a one-bar chart.

**Why this priority**: These are the levers a member actually pulls. They are also the comparisons
that need the most care: "which voice profile" is not a column anywhere, and a post can be
model-generated *and* hand-edited afterwards.

**Independent Test**: Seed posts across both occurrence rules, two voice profiles and all three origins,
and assert each dimension's grouping, counts, exclusions and refusals without touching the UI.

**Acceptance Scenarios**:

1. **Given** 10 posts from a `cadence` standing series and 9 from a `dated_list` standing series,
   **When** the by-series-kind comparison is drawn, **Then** the two kinds are separate groups with
   their counts, each named in the project's own words ("evergreen" and "date-pegged").
2. **Given** a project with no standing series, **When** the comparison is drawn, **Then** it states
   that the project has not used series rather than drawing an empty or single-bar chart.
3. **Given** posts generated under two voice profiles, **When** the by-voice comparison is drawn,
   **Then** posts are grouped by the voice profile recorded for them, each profile named, and posts
   with no recorded voice profile form a stated "not generated" group rather than being silently
   dropped.
4. **Given** a voice profile that has since been renamed, **When** the comparison is drawn, **Then** it
   shows the profile's current name; **Given** a profile that has been deleted, **Then** its posts are
   grouped as a stated removed profile rather than disappearing.
5. **Given** posts with `origin` of `manual`, `generated` and `api`, **When** the
   generated-against-hand-written comparison is drawn, **Then** `generated` is one group, `manual` is
   another, and `api` is its own stated third group — never folded into either, because Docket cannot
   know whether an API caller wrote its text by hand or with a model.
6. **Given** a generated post whose text a member later edited, **When** the comparison is drawn,
   **Then** it is counted as generated and the comparison states that later hand edits are not tracked.
7. **Given** any dimension where every group is below the floor, **When** it is drawn, **Then** it
   refuses to rank, exactly as in User Story 3.

---

### User Story 5 - A year-old trend outlives the rows that made it (Priority: P2)

An install that has been running for well over `INSIGHTS_RETENTION_DAYS` still sees its whole account
history on the trend chart, because before the housekeeping pass deletes a snapshot it has already been
folded into one durable point per account, per metric, per day. Pruning can never run ahead of that
fold: if the fold cannot complete, nothing is deleted.

**Why this priority**: The two prune passes already run on every tick
(`src/server/scheduler/housekeeping.ts:166-167`). Every day this entry ships without the fold is a day
of history that becomes unrecoverable at the 400-day boundary. It is also invisible until it is too
late, which is exactly the kind of bug that must not wait.

**Independent Test**: Seed snapshots older than the retention window, run housekeeping, and assert the
rolled-up points exist, the snapshot rows are gone, the trend still draws, and that forcing the fold to
fail leaves every snapshot row in place.

**Acceptance Scenarios**:

1. **Given** 500 days of account snapshots and a 400-day retention, **When** housekeeping runs to
   completion, **Then** the trend chart still shows all 500 days and the snapshot rows older than 400
   days are gone.
2. **Given** the fold step raises an error, **When** housekeeping runs, **Then** no snapshot row is
   deleted on that pass and the failure is reported in the pass's counts.
3. **Given** the fold has only reached day N, **When** the prune runs, **Then** it deletes nothing
   newer than what has been folded, however far past the retention boundary those rows are.
4. **Given** housekeeping runs twice over the same days, **When** the fold runs the second time,
   **Then** the rolled-up points are unchanged — the fold is idempotent and never double-counts.
5. **Given** a rolled-up point and a surviving snapshot for the same account, metric and day,
   **When** the trend is drawn, **Then** exactly one value appears for that day and no day is drawn
   twice.
6. **Given** an account is deleted, **When** the trend is next drawn, **Then** its rolled-up points are
   gone with it, by the same cascade every other project-owned row obeys.

---

### User Story 6 - How long before anybody noticed? (Priority: P3)

For each published target, Docket records when it first saw any engagement on that post, and the
Insights page shows how long that took, grouped by the same dimensions as every other comparison. The
figure states its own source and resolution: an exact time where the inbox holds a dated reply to that
post, or "within the first hour" where the only evidence is the first snapshot in which a number rose
above zero. Posts that have no engagement yet are counted and named as such — never dropped from the
average, and never counted as zero minutes.

**Why this priority**: It is the most interesting number here and the most easily made dishonest, so it
ships last of the comparisons and behind the ones that need no join.

**Independent Test**: Seed a target's snapshot sequence and inbox rows with known timings, run the
recording step, and assert the stored first-engagement record, its source, its resolution, and that a
later prune of the inbox row does not change it.

**Acceptance Scenarios**:

1. **Given** a target published at 10:00 whose first snapshot at 11:00 shows `likeCount: 0` and whose
   12:00 snapshot shows `likeCount: 3`, **When** the record is written, **Then** it records "between
   1h and 2h after publication", sourced from snapshots, with the bound stated and no exact minute
   claimed.
2. **Given** a target whose very first snapshot already shows engagement, **When** the record is
   written, **Then** it records "within the first hour" as an upper bound and says so, rather than
   claiming a time it cannot know.
3. **Given** a Bluesky target with an inbox reply whose `said_at` is 14 minutes after publication,
   **When** the record is written, **Then** it records 14 minutes, sourced from the inbox, and that
   exact figure is preferred over the coarser snapshot bound for the same target.
4. **Given** a first-engagement record sourced from an inbox row, **When** that row is later pruned by
   `ENGAGEMENT_RETENTION_DAYS` or deleted because the reply was withdrawn upstream, **Then** the
   recorded figure is unchanged.
5. **Given** targets on platforms with no engagement reader (every platform but Bluesky and mock
   today, per `docs/engagement.md`), **When** the comparison is drawn, **Then** their figures are
   snapshot-sourced only, and the comparison states that exact times exist for Bluesky alone.
6. **Given** 20 published posts of which 7 have no engagement at all yet, **When** the comparison is
   drawn, **Then** the 13 are reported with their count and the 7 are reported separately as "no
   engagement yet"; no average treats the 7 as zero minutes and none of them is silently excluded from
   the stated sample size.
7. **Given** a target frozen as `gone`, `expired` or `unqueryable` with no engagement ever observed,
   **When** the comparison is drawn, **Then** it is reported as "never observed" and excluded from the
   timing average with that exclusion stated.
8. **Given** a snapshot-sourced record for a target that is still being polled, **When** a later
   snapshot shows a higher number, **Then** the recorded first-engagement time does not move: it is
   written once and never overwritten.

---

### User Story 7 - The same numbers from the API (Priority: P3)

An operator with a read API key, or an agent through MCP, can fetch the project's insights — account
trends and the comparisons — with the same per-platform separation, the same sample sizes, the same
"as of" times and the same refusals as the screen. It is one operation, so REST, the OpenAPI document
and the MCP tool list all gain it together. No credential, token or platform secret appears anywhere in
the response.

**Why this priority**: The roadmap asks for exactly one operation and the registry makes it cheap, but
nothing else in the entry depends on it, so it ships after the screens are right.

**Independent Test**: Call the operation with a read key against a seeded project and assert the body
matches the screen's figures, that a key from another project gets nothing, and that the secret scan
finds nothing in the response.

**Acceptance Scenarios**:

1. **Given** a read API key, **When** the operation is called, **Then** it returns account trends and
   comparisons with per-platform series, per-group sample sizes, and each figure's "as of".
2. **Given** a key for project A, **When** it asks for project B's insights, **Then** nothing of
   project B is returned, enforced by the same scoped data access every other operation uses.
3. **Given** a key without `read`, **When** the operation is called, **Then** it is refused with the
   registry's standard missing-permission error.
4. **Given** a comparison below the sample floor, **When** it is returned over the API, **Then** the
   body carries the same refusal — the counts and a machine-readable "not enough posts" marker — and
   never a ranking the screen would decline to draw.
5. **Given** the operation exists, **When** the OpenAPI document and the MCP tool list are generated,
   **Then** it appears in both or neither according to one explicit `mcp.expose` decision recorded in
   its definition, with a reason if `false`.
6. **Given** the operation's response for a project with snapshots on every platform, **When** the
   secret-scan test runs over it, **Then** it finds no credential, token or platform secret.

---

### Edge Cases

**Shape of a metric**

- A metric whose kind is windowed is read more often than its window is long (Instagram `reach`, a
  one-day window read every six hours). Consecutive readings overlap; they are never added, and at
  most one reading per project-local day is drawn.
- A metric whose kind cannot be confirmed from `docs/research/*.md` is `unknown`: absent from every
  trend and comparison, with a stated reason, and still shown as a latest number where it already is.
- A cumulative metric that goes **down** (unfollows, a deleted post lowering a post count) is drawn as
  it is. A fall is a fact, not an error, and is never clamped to zero or to the previous value.
- A metric key a platform began reporting partway through the window produces a series that starts
  partway through. The gap before it is a gap, not zeros.
- A project-local day with several readings of a cumulative metric uses the newest reading for that
  day, so the "as of" shown is the newest capture, not the day boundary.

**Not enough data**

- A comparison with exactly one group above the floor states the group and its count but draws no
  comparison, because one arm is not a comparison.
- A group whose posts all come from a single account on a single platform is labelled as such, so a
  "Thursday wins" that is really "this one account wins" is visible.
- A project with no published posts at all, or no snapshots at all, gets an empty state naming what
  has to happen (publish, then wait for the first scheduled read) rather than an empty chart.
- Changing the date range can take a group from above the floor to below it. The refusal follows the
  current range; nothing is cached across ranges.

**Joins that can go wrong**

- A post whose target has no external id (hand-resolved, allowed by `post_targets_published_has_id`)
  is excluded from every comparison, and the exclusion is counted and stated — never treated as a
  post that performed badly.
- A target frozen `gone`, `expired` or `unqueryable` keeps its last snapshot and still counts in
  comparisons, labelled as final. `expired` story targets are comparable only against other expired
  stories, and never against targets whose numbers kept accruing.
- A post with targets on several platforms contributes one data point **per target**, to that
  platform's series only. It is never one averaged data point for the post.
- An account that was reconnected keeps its snapshots and its trend unbroken, because 081's reconnect
  updates the same `social_accounts` row.
- An account that was removed and reconnected as a new row begins a new series; the two are never
  stitched together, and the page does not pretend the gap is a decline.
- A voice profile, slot, series or account that has been deleted leaves its posts comparable under a
  stated "removed" label rather than vanishing from the counts.

**Time**

- Every bucket boundary (day, weekday, local hour) is computed in the project's time zone from stored
  UTC, with explicit DST disambiguation. A 23:00 slot in a zone that skips an hour still lands on its
  own local day.
- A project whose time zone changes re-buckets everything on the next read. No bucket is stored
  pre-computed in a local zone.
- A snapshot captured during a DST transition is attributed to the local day its UTC instant falls in,
  never duplicated into two days and never dropped.

**Housekeeping and the tick**

- The fold runs before the prune in the same housekeeping pass. If the pass runs out of time after the
  fold and before the prune, nothing is lost; if it runs out before the fold, nothing is deleted.
- The fold is bounded like every other housekeeping step and reports its own count, so a pass that
  folded nothing is visible rather than silent — the failure mode
  `src/server/scheduler/config.ts:172-175` warns about (the roadmap cites 162-166; the comment has
  since moved).
- Two schedulers running concurrently must not double-write a rolled-up point or let one's prune race
  the other's fold.

**Presentation**

- Charts are rendered server-side with no new runtime dependency, consistent with the constitution's
  "Boring, few dependencies" and the design system's "no UI framework, no icon package".
- Series are distinguishable without relying on colour alone (direct labels or shape), because the
  design system requires status to be "text plus colour" and the contrast script gates new pairs.
- Every chart has a text equivalent — a table or an accessible summary naming each series, its
  platform and its sample size — so the page is usable by keyboard and screen reader, and so the
  "never sum across platforms" rule is auditable without reading pixels.
- A chart with a single data point draws that point and says a trend needs more than one reading.
- Numbers are formatted in the viewer's locale but never rounded in a way that merges two platforms'
  magnitudes into one axis.

**Security and scope**

- No snapshot value, comparison, log line or API response may contain a credential, token or platform
  secret; `tests/integration/security/secret-scan.test.ts` is extended to cover this entry's new
  response and new rows, never exempted.
- Every read goes through the scoped data-access layer. No route, page or operation added here imports
  the raw database client.

## Requirements *(mandatory)*

### Functional Requirements

**The shape of a metric (the one generic change, G38)**

- **FR-001**: A declared metric key MUST carry its own kind: `cumulative` (a running total that can be
  plotted as-is), `windowed` (a total for a stated period, which must never be added across readings),
  or `unknown` (the kind is not confirmed from `docs/research/*.md`). A `windowed` kind MUST state its
  window length where that is confirmed.
- **FR-002**: The kind MUST be declared by the provider that owns the key, next to the key and label it
  already declares. Every existing declared key on every provider — including `mock` — MUST be
  classified, and a provider added later MUST NOT be able to declare a key without a kind.
- **FR-003**: This change MUST be recorded as **G38** in the "Generic hooks index" of
  `docs/adding-a-provider.md` and in `docs/decisions.md`, as every generic change before it was.
- **FR-004**: A key whose kind is `unknown` MUST be absent from every trend, every comparison and every
  derived figure in this entry, with the reason shown where a member would otherwise expect the series.
  It MUST continue to appear as a latest number wherever it already does.
- **FR-005**: Classifying a key MUST NOT change any provider's request, response parsing, declared
  keys, labels, scopes or read schedule. Where a kind cannot be classified without changing a request
  (Facebook's account metrics pin no `period`, and `docs/research/meta.md:521` records `page_follows`'
  period as "not stated"), the key MUST be classified `unknown` and the open question recorded in
  `docs/research/meta.md` and `docs/decisions.md` — this entry MUST NOT change what a reader asks a
  platform for.

**Account trends**

- **FR-010**: The system MUST show, per connected account, that account's declared account metrics over
  a member-chosen date range, drawn from `account_metric_snapshots`.
- **FR-011**: Each account MUST have its own series and its own axis. The system MUST NOT sum, average
  or otherwise combine a metric across accounts or across platforms, in the data layer or in the UI.
- **FR-012**: Each series MUST be labelled with the platform's own word for that metric, as declared.
- **FR-013**: A `cumulative` metric MUST be drawn as a continuous value over time. A `windowed` metric
  MUST be drawn as one value per period, using at most one reading per project-local day, and MUST
  NOT be accumulated.
- **FR-014**: A period with no snapshot MUST be a visible gap. The system MUST NOT interpolate it,
  carry the previous value forward, or render it as zero.
- **FR-015**: A platform that declares no account metrics MUST produce no chart and no empty series; a
  stated line MUST explain that the platform reports no account numbers, linking `docs/insights.md`.
- **FR-016**: Every trend MUST state the range it covers and the capture time of its most recent point.

**Per-post numbers where the work happens**

- **FR-020**: The project overview MUST show recent published posts with their latest per-target
  numbers, and the posts list MUST show the same per row.
- **FR-021**: Both surfaces MUST reuse the single decision already made in `src/lib/insights/panel.ts`
  for a target's honest state, so every state that decision already produces — `not_published`,
  `platform_unsupported`, `unavailable`, `permission_not_requested`, `needs_reconnect`,
  `no_external_id`, `unqueryable`, `gone`, `expired`, `failing`, `not_polled_yet`,
  `nothing_reported`, `reported` — reads identically on the overview, the posts list and the detail
  panel. No surface MUST invent a second vocabulary for the same facts.
- **FR-022**: Numbers on these surfaces MUST be per target and per platform, each with its platform's
  own label and an "as of". No combined per-post figure MUST appear.
- **FR-023**: A metric a response did not contain MUST render nothing — no row, no dash, no `0`.
- **FR-024**: Fetching these numbers MUST use a bounded number of queries independent of the number of
  rows on the page, and MUST NOT make the overview or the posts list fail or go blank if insights data
  is unavailable.

**Comparisons**

- **FR-030**: The system MUST compare published targets' performance grouped by: the posting slot the
  target occupied; project-local day of week; standing-series occurrence rule (`cadence`, i.e. 071's
  evergreen, against `dated_list`, i.e. 072's date-pegged); the voice profile recorded for the post;
  and post origin (`generated` against `manual`, with `api` as its own group).
- **FR-031**: Every group in every comparison MUST state the number of comparable posts it is based on.
- **FR-032**: A group with fewer than 4 comparable posts MUST NOT be drawn, and the number of groups
  suppressed MUST be stated. A group with 4-7 MUST be drawn with a visible caution. Ranking,
  superlatives and any "best"/"worst"/"winner" wording MUST appear only where a group has 8 or more.
- **FR-033**: A comparison in which no group reaches 8 MUST state that it cannot yet conclude anything
  and show the counts it has, with no ordering implied by the layout.
- **FR-034**: Every comparison MUST stay within one platform and one metric per series. The system MUST
  NOT compute a figure that mixes two platforms' metrics, and MUST NOT offer a metric chooser that
  allows it.
- **FR-035**: Every group boundary derived from time MUST be computed in the project's time zone from
  stored UTC with explicit DST disambiguation, and MUST be recomputed when the project's time zone
  changes.
- **FR-036**: Posts excluded from a comparison (no external id, wrong `schedule_kind` for a by-slot
  comparison, no snapshot, frozen with no reading) MUST be counted and the exclusion stated. An
  excluded post MUST NOT be counted as a zero-performing post.
- **FR-037**: A group whose subject has been deleted — slot, voice profile, series or account — MUST
  remain comparable under a stated "removed" label rather than disappearing from the counts.
- **FR-038**: A comparison MUST NOT claim causation, predict, forecast, or recommend a schedule or
  content change. It reports what was observed, for how many posts.

**Time to first engagement**

- **FR-040**: The system MUST record, once per published target, when engagement was first observed on
  that target, together with the source of that observation and its resolution.
- **FR-041**: Where the inbox holds an item whose parent is that target, the exact interval from
  publication to the item's `said_at` MUST be used, and MUST be preferred over a snapshot-derived
  bound for the same target.
- **FR-042**: Otherwise the system MUST use the first snapshot in which any declared engagement metric
  for that target rose above zero, and MUST express the result as a bound between the previous
  snapshot and that one — never as an exact time it cannot know. Engagement present in a target's very
  first snapshot MUST be expressed as an upper bound ("within the first hour").
- **FR-043**: Once written, a first-engagement record MUST NOT be overwritten, recomputed or deleted by
  a later snapshot, by inbox retention (`ENGAGEMENT_RETENTION_DAYS`, default 90), or by an item being
  withdrawn upstream.
- **FR-044**: Targets with no engagement yet MUST be counted and reported separately as "no engagement
  yet". They MUST NOT be dropped from the stated sample size, and MUST NOT be averaged in as zero.
- **FR-045**: The comparison MUST state that exact times exist only for platforms with an engagement
  reader (Bluesky and `mock` today, per `docs/engagement.md`) and that every other platform's figure
  is a snapshot bound whose resolution is the poll cadence.
- **FR-046**: The record MUST be derivable for a target published before this entry shipped, from the
  snapshots already stored, without any platform call.

**Fold before prune**

- **FR-050**: Before any snapshot is pruned, the system MUST fold the snapshots due for pruning into
  durable points — one per subject, per metric key, per project-local day — carrying the value, the
  metric's kind, and the capture time the value came from.
- **FR-051**: The fold MUST run before both prune passes in the same housekeeping pass, and a prune
  MUST NOT delete any row the fold has not yet covered, however old that row is.
- **FR-052**: If the fold fails or is incomplete, no snapshot row MUST be deleted on that pass.
- **FR-053**: The fold MUST be idempotent: running it again over the same days MUST leave the points
  unchanged and MUST NOT double-count.
- **FR-054**: A trend MUST read folded points and surviving snapshots together and show exactly one
  value per subject, metric and day, with no day drawn twice.
- **FR-055**: The fold MUST be bounded like every other housekeeping step and MUST report its own count
  in the pass's counts, so a pass that folded nothing is visible rather than silent.
- **FR-056**: Folded points MUST carry `project_id` and MUST be removed by the same cascade as the
  snapshots they came from when an account or project is deleted.
- **FR-057**: Folding and pruning MUST be safe to run concurrently from more than one scheduler and
  safe to kill mid-run, with no double-written point and no prune racing ahead of a fold.

**The API operation**

- **FR-060**: The system MUST add exactly one API operation, in a new operations file registered once
  in `OPERATIONS`, so the REST router, the OpenAPI document and the MCP tool list gain it together.
- **FR-061**: The operation MUST carry an explicit `mcp.expose` decision, with a reason when `false`.
- **FR-062**: It MUST require the `read` permission and MUST return only the calling project's data,
  through the scoped data-access layer.
- **FR-063**: Its response MUST carry the same per-platform separation, per-group sample sizes, "as of"
  times and refusals as the screen. It MUST NOT return a ranking the screen would decline to draw, and
  MUST carry a machine-readable marker for "not enough posts".
- **FR-064**: Its response MUST NOT contain any credential, token, platform secret, raw provider
  payload or account access detail.

**Presentation**

- **FR-070**: Charts MUST follow `docs/design-system.md`: semantic tokens, shared primitives, server
  components by default, and no new runtime dependency or UI framework.
- **FR-071**: A chart's series MUST be distinguishable without relying on colour alone. Any new colour
  pair MUST pass `node scripts/check-contrast.mjs` in both themes.
- **FR-072**: Every chart MUST have a text equivalent naming each series, its platform, its metric and
  its sample size, reachable by keyboard and to a screen reader.
- **FR-073**: The chart conventions established here MUST be written into `docs/design-system.md`, so
  the next entry that draws one follows the same rules.
- **FR-074**: Insights screens MUST have sensible empty, loading and error states and MUST NOT break a
  page that already works when insights data is missing or a read fails.

**Docs, schema and process**

- **FR-080**: `docs/insights.md` MUST be updated: the "No chart, trend, delta or comparison of any
  kind" and "No account-metric screen yet" gaps are closed by this entry and MUST stop claiming
  otherwise; the sample-size floor, the fold, and what remains out of scope MUST be stated.
- **FR-081**: The constitution's out-of-scope line ("analytics […] charts, trends and comparisons stay
  out of scope") MUST be amended in a `docs(constitution):` commit with a version bump, because this
  entry makes it false.
- **FR-082**: `docs/feature-map.md`, `docs/decisions.md` and `docs/mcp.md` (if the operation is
  exposed) MUST be updated for what this entry adds.
- **FR-083**: Any schema change MUST ship as a committed migration generated by `pnpm db:generate`,
  with `pnpm db:check` green.
- **FR-084**: `tests/integration/security/secret-scan.test.ts` MUST be extended to cover this entry's
  new rows and new API response. It MUST NOT be exempted or narrowed.
- **FR-085**: Every task requiring a live OAuth consent screen, a real platform account, a browser or
  a visual judgement MUST be placed at the very end of the task list.
- **FR-086**: The repo MUST be left working: lint, typecheck, the test suite, the build and
  `pnpm db:check` green.

### Key Entities

- **Metric kind**: The classification a provider gives each metric key it already declares —
  `cumulative`, `windowed` (with a window length where confirmed), or `unknown`. Decides whether a key
  can be plotted over time at all, and how.
- **Trend series**: One account's readings of one metric key over a range: a list of (project-local
  day, value, capture time), with gaps preserved. Belongs to exactly one account and therefore exactly
  one platform.
- **Snapshot rollup point**: One durable (subject, metric key, project-local day, value, capture time,
  kind) record, written by the fold before the snapshot it came from is pruned. Carries `project_id`
  and cascades with its subject.
- **Comparison**: One dimension (slot, day of week, series kind, voice profile, origin), one platform,
  one metric, a date range, and a set of groups.
- **Comparison group**: One arm of a comparison — its label, the posts in it, its sample size, its
  aggregate value, and its verdict: `ranked` (8+), `provisional` (4-7) or `suppressed` (below 4).
- **Exclusion**: A stated count of posts a comparison left out, with the reason (no external id, no
  snapshot, wrong schedule kind, frozen with no reading).
- **First-engagement record**: Per published target, written once: the interval from publication to the
  first observed engagement, its source (`inbox` or `snapshot`), its resolution (exact, or a bound
  between two captures), or the fact that none has been observed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can tell whether a connected account gained or lost followers over the last 30
  days without leaving the Insights page, and without any figure on the page combining two platforms.
- **SC-002**: A member can see a published post's numbers from the posts list in one page load, with no
  click into the post — verified over a 25-row page whose query count does not grow with the rows.
- **SC-003**: For every comparison, a reader can state the number of posts behind each group without
  hovering, clicking or expanding anything.
- **SC-004**: No comparison presents a ranking, a superlative or an ordered layout for any group with
  fewer than 8 comparable posts — asserted by test at the 3, 4, 7 and 8 boundaries.
- **SC-005**: An install whose oldest account snapshot is older than `INSIGHTS_RETENTION_DAYS` still
  draws a complete trend over its whole history after housekeeping has run.
- **SC-006**: A first-engagement figure recorded today is byte-identical 100 days later, after inbox
  retention has deleted the row it came from.
- **SC-007**: Every number on every new surface states what it is "as of", and no absent metric
  anywhere renders as `0` — asserted by test over a fixture in which each platform omits a declared
  key.
- **SC-008**: One new operations file plus one registry line yields the operation in the REST router,
  the OpenAPI document and the MCP tool list consistently with its single `mcp.expose` decision.
- **SC-009**: Every chart is fully usable by keyboard and conveys its series, platforms and sample
  sizes to a screen reader without colour.
- **SC-010**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm db:check` are green,
  and the secret scan finds nothing in the new rows or the new response.
- **SC-011**: No platform HTTP call is made by any code path this entry adds — asserted by a test that
  fails if a provider read is invoked while rendering or serving insights.

## What this entry does not do

Stated plainly, as every entry in this roadmap must.

- **No provider reader, no new scope, no new platform.** Nothing here asks a platform for anything.
  Every number comes from rows entries 1-3 already wrote. Threads' and X's account numbers stay
  unread because their providers declare none; Facebook's views family stays the named gap 081 left.
- **No change to what any reader requests.** Facebook's account metrics pin no `period` and Pinterest's
  `monthly_views` window is not recorded in research, so those keys are classified `unknown` and are
  absent from trends. Pinning a period is a reader change and belongs to a later entry, with the open
  question recorded in research and decisions.
- **No prediction, forecast, recommendation or significance test.** No "post on Thursdays", no
  confidence interval, no p-value. The sample-size floor is the honesty mechanism, and a comparison
  reports observation, not causation.
- **No cross-platform total, average, index or score**, anywhere, ever — not even behind a toggle.
- **No manual refresh.** Numbers still appear only on the schedule 080 set; nothing on these screens
  calls a platform while a member looks at the page.
- **No per-project on/off switch** for insights, and no per-member preference.
- **No new runtime dependency.** No charting library; charts are server-rendered inline SVG, per the
  constitution and the design system.
- **No export, download, CSV or scheduled digest** of insights, and no notification or alert driven by
  a trend.
- **No post-level or account-level goals, targets or benchmarks**, and no comparison against other
  projects or other installs.
- **No tracking of later hand edits to a generated post.** Origin is what Docket recorded at creation;
  the comparison says so.
- **No backfill of first-engagement from the inbox for posts whose inbox rows have already been
  pruned.** Those targets get the snapshot-derived bound, or "never observed".
- **No change to the poll schedule, the read budget, the reserve or any `INSIGHTS_*` knob** except the
  addition the fold needs, if any.
- **No new tick section.** The fold joins the existing housekeeping pass. If planning finds it cannot
  fit there, it gets its own `SectionResult` in `TickSummary`, its own `Promise.all` entry and its own
  heartbeat — never a silent passenger in another section's budget.

This is the last entry in `.specify/roadmaps/social-insights.md`. Anything named above as deferred has
no later entry waiting for it; it needs a new roadmap entry to happen.

## Assumptions

- **Sample-size floor.** 8 comparable posts to rank, 4-7 provisional, below 4 suppressed, as decided in
  Clarifications. Fixed constants, not configurable: a knob here would let an operator turn the
  honesty off.
- **Where it lives.** A new `/p/[projectSlug]/insights` page under the left nav's `Project` group,
  needing a new nav icon regenerated into `src/components/ui/icons.generated.ts` by `pnpm icons`
  (`scripts/generate-icons.mjs`), which must be run from inside this worktree. Per-post numbers go on
  the overview and the posts list as the roadmap directs.
- **Who can see it.** Insights are readable by any member who can read the project's posts. The inbox's
  stricter rule (owners, admins and editors only, no API key) applies to inbox *content*; this entry
  surfaces only a derived interval from an inbox row — never a commenter's name, handle, identifier,
  URL or text — so it does not inherit that restriction. No new role or permission is added.
- **Default range.** The last 30 days, in the project's time zone, with a member-chosen range. Trends
  can reach further back than 30 days where history exists.
- **The aggregate for a comparison** is the mean of the chosen metric across the group's comparable
  posts, with the group's median shown alongside, because a single viral post otherwise decides a
  group of eight. Both are reported; neither is presented as a conclusion below the floor.
- **Metric kinds come from research, not from the metric's name.** `followersCount` is cumulative
  because it is a count of followers; Instagram's `follower_count` is windowed because
  `docs/research/meta.md:467` records `period=day`. Where research does not say, the kind is `unknown`
  (constitution I: mark it, do not guess).
- **The fold's grain** is one point per subject, per metric key, per project-local day. Finer grain
  would not survive the 400-day horizon usefully; coarser would lose the day-of-week comparison.
- **Account trends need only `account_metric_snapshots`**; post comparisons need
  `post_metric_snapshots` joined to `post_targets`, `posts`, `posting_slots`, `standing_series` and the
  voice profile recorded for the post. `posts.generation_metadata` is a jsonb document
  (`src/lib/validation/generation.ts:122`) whose records carry `voiceProfile.id`, so the by-voice
  comparison reads a jsonb path for generated posts and `standing_series.voice_profile_id` for standing
  series posts; a post with neither forms the stated "not generated" group.
- **Existing installs** need no reconnect, no migration of behaviour and no configuration change. On
  upgrade the screens populate from history already stored; a brand-new install shows honest empty
  states until the first scheduled read lands.
- **Verified with mocks and fixtures only.** No part of this entry can be exercised against a live
  platform, because it makes no platform call. Visual and accessibility judgement on the charts is the
  only work that needs a browser, and it is parked at the end of the task list per FR-085.
