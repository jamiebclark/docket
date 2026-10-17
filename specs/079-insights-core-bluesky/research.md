# Phase 0 research: post and account insights, Bluesky pilot

**Feature**: 079-insights-core-bluesky | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

Every fact below is either read from a file in this repository, read from the installed package, or
marked `NEEDS RESEARCH` together with the statement that nothing in the design depends on it
(constitution I).

---

## §1 Bluesky's metric surface, from the installed package

Confirmed 2026-10-17 by reading `node_modules/@atproto/api` directly — the generated types under
`dist/client/types/app/bsky/` and the bundled lexicon `schemaDict` in `dist/client/lexicons.js`. The
spec's "Facts recorded against the research notes" table was re-verified row by row during this
phase; every row holds.

| Fact | Value | Where it was read |
|---|---|---|
| `app.bsky.feed.getPosts` params | `uris: string[]`, required, `maxLength: 25` | `schemaDict.AppBskyFeedGetPosts`; `types/app/bsky/feed/getPosts.d.ts` (`QueryParams = { uris: string[] }`) |
| `app.bsky.feed.getPosts` output | `{ posts: PostView[] }` | `getPosts.d.ts` `OutputSchema` |
| `PostView` properties, in full | `$type?, uri, cid, author, record, embed?, bookmarkCount?, replyCount?, repostCount?, likeCount?, quoteCount?, indexedAt, viewer?, labels?, threadgate?, debug?` | `types/app/bsky/feed/defs.d.ts` |
| The four counts in scope | `likeCount`, `repostCount`, `replyCount`, `quoteCount` — **all optional** | same |
| Views / impressions / reach on a post | **No such property exists** | same (confirmed negative) |
| `app.bsky.actor.getProfile` params | `actor: string` (handle or DID), required | `types/app/bsky/actor/getProfile.d.ts` |
| `app.bsky.actor.getProfile` output | `ProfileViewDetailed`, with optional `followersCount`, `followsCount`, `postsCount` | `types/app/bsky/actor/defs.d.ts` |
| Views / reach on a profile | **No such property exists** | same (confirmed negative) |
| Bluesky's post `external_id` in Docket | the at-URI | `src/providers/bluesky/publish.ts:207` |
| Bluesky's account `external_account_id` | the DID | `src/providers/bluesky/session.ts:56` |

**Decision**: declare exactly four post keys (`likeCount`, `repostCount`, `replyCount`,
`quoteCount`) and three account keys (`followersCount`, `followsCount`, `postsCount`); declare
`maxPostsPerRead: 25`.

**Rationale**: these are the only count fields the installed lexicon carries, and 25 is the
lexicon's own `maxLength`, so a 26-URI call would be refused by the server rather than by Docket.

**Alternatives considered**: declaring `bookmarkCount` as a fifth post key — rejected: it is in the
installed lexicon but absent from `docs/research/bluesky.md`, and the spec records it as an unowned
gap rather than smuggling it in. Declaring a `views` key that is always absent — rejected: under the
"absent, never zero" rule an undeclared key and a never-returned key render identically, and
declaring a key the protocol has no concept of would put the lie in the declaration itself.

---

## §2 The transport: the account's own session, not the public AppView

`NEEDS RESEARCH (docs/research/bluesky.md)`: whether `app.bsky.feed.getPosts` and
`app.bsky.actor.getProfile` answer **unauthenticated**, at which host, and under what read
allowance. Not in the installed package (a lexicon states the shape of a call, never its auth
requirement); not in `docs/research/bluesky.md`, which records a default PDS of `https://bsky.social`
and a custom-PDS setting and nothing about an anonymous AppView.

**Decision**: read through `agentFor(settings.pdsUrl, credentials.accessJwt)`
(`src/providers/bluesky/client.ts`), exactly as `src/providers/bluesky/engagement.ts` reads
`app.bsky.notification.listNotifications`.

**Rationale**: this path is already proven in the repository by 077, needs no permission Docket does
not already hold (the same app-password session publishes and reads the inbox — FR-056), and is
therefore sufficient for the roadmap's premise that Bluesky cannot block this entry. That makes the
open question genuinely optional: if the public AppView does answer anonymously, switching is a
change inside `src/providers/bluesky/insights.ts` alone and a later entry's business.

**Alternatives considered**: an unauthenticated `agentFor(PUBLIC_APPVIEW)` call — rejected under
constitution I, since both the host and the auth behaviour would come from memory. A hybrid that
tries anonymous first and falls back — rejected: two code paths, two failure vocabularies, and the
fallback is the one that ends up tested.

**What ships instead**: FR-081's section in `docs/research/bluesky.md` records both the confirmed
facts of §1 and this gap, marked unverified, with the live check parked as the very last task (the
spec's "Task ordering note").

---

## §3 The read allowance is unverified, so the declared figure is interim

`docs/research/bluesky.md` "Rate limits" documents **write** points only (5,000/hour, 35,000/day, a
create costing 3). `docs/research/engagement.md` §1 states outright that the research is silent on
`listNotifications` read limits. Nothing in the installed package states a read allowance.

**Decision**: declare `readBudget: { count: 1_666, windowSeconds: 3_600 }` for Bluesky insights —
the figure `blueskyEngagement.writeBudget` already declares
(`src/providers/bluesky/engagement.ts`) — and record it in `docs/limits.md` as **interim,
UNVERIFIED**, in a row naming where it is enforced.

**Rationale**: the design needs *a* number for the publishing-first reserve (FR-045), not the right
number. Reusing the figure already in the tree leaves one value to revise when the research lands,
and the direction of error is safe: charging reads against the publish allowance can only make
Docket poll less than it might, never publish less than it should.

**Alternatives considered**: no declared budget, with the reserve skipped when absent — rejected:
FR-007 requires the declaration to carry one and FR-045 requires the check before every call, so an
absent budget would make the reserve unreachable on the pilot platform, i.e. untested. A
deliberately tiny figure (say 60/hour) — rejected: it would make the reserve bind under ordinary
load, against FR-072.

---

## §4 The allowance window count, without a new counter row

Spec constraint 6: `allowance_uses` (`src/server/db/schema/scheduler.ts:19-39`) has `units` and no
kind column — it is a provider's `creationAllowance` ledger, and writing insights reads into it
would corrupt the count that defers a publish.

**Decision**: compute the window count by reading shapes that already exist, and add no counter:

```text
usedInWindow(account, since) = count(post_targets.publish_started_at > since for this account)
                             + count(post_metric_snapshots.captured_at > since for this account)
                             + count(account_metric_snapshots.captured_at > since for this account)
```

A call is refused when `usedInWindow >= reserveFloor(budget, INSIGHTS_READ_RESERVE)`, with
`reserveFloor` and `stricterBudget` imported unchanged from
`src/server/scheduler/engagement-budget.ts`. The first term is `writesStartedSince()`
(`src/server/dal/scheduler.ts:295`), already served by `post_targets_started_idx`. The second and
third are `COUNT(*)` over the new snapshot tables on their `(social_account_id, captured_at)`
indexes (data-model.md §1, §2).

**Rationale**: the snapshot rows *are* the ledger — one row per successful read is exactly what the
window needs to count — so a counter table would be a second source of truth for a number already
stored. It also leaves no second row to lock in the commit transaction, and therefore no lock-order
pair to get wrong, which is what the constitution's review list calls out.

**Alternatives considered**: a `kind` column on `allowance_uses` — rejected: it changes the meaning
of a table the publishing engine reserves against, and every existing query would need the new
filter added correctly. A rolling counter column on the poll state — rejected: it puts a second row
in the claim transaction and goes stale after retention pruning.

**Stated limitation**, carried from the spec and repeated so the tasks phase does not try to fix it:
a *failed* read writes no snapshot and so is not counted against the window. The bound on repeated
failures is the existing `consecutive_failures` backoff, not the allowance.

---

## §5 The decaying schedule as pure arithmetic

**Decision**: two pure, total functions in `src/lib/insights/schedule.ts`, neither reading a clock:

```ts
nextPostPollAt(input: {
  publishedAt: Date;
  lastCapturedAt: Date | null;
  now: Date;
  minIntervalMs: number;
}): Date | null;

nextAccountPollAt(input: {
  lastCapturedAt: Date | null;
  now: Date;
  intervalMs: number;
  minIntervalMs: number;
}): Date;
```

Bands, measured as age since `publishedAt`, each half-open on its upper end (FR-025):

| Age | Interval | Next time |
|---|---|---|
| `[0, 24 h)` | 1 h | `lastCapturedAt + 1 h`, or `publishedAt + 1 h` when never captured |
| `[24 h, 7 d)` | 1 d | `lastCapturedAt + 1 d`, floored at `publishedAt + 24 h` |
| `[7 d, 28 d)` | 7 d | `lastCapturedAt + 7 d`, floored at `publishedAt + 7 d` |
| `>= 28 d` | frozen | `null` |

Two rules on top. A candidate next time **on or after** `publishedAt + 28 d` returns `null` instead
(FR-025's last sentence: no poll is ever scheduled for a target that will be frozen when it
arrives). And the returned time is never earlier than `lastCapturedAt + minIntervalMs` (FR-028). A
target with `age >= 28 d` and `lastCapturedAt === null` returns `now` — due immediately — and
freezes after that one capture (FR-026), which is what gives the panel numbers on the day the
feature ships.

`nextAccountPollAt` never decays (FR-029): an account's followers keep changing. It returns
`max(lastCapturedAt + intervalMs, lastCapturedAt + minIntervalMs)`, or `now` when never captured,
and never `null` — an account is never frozen.

**Rationale**: the first capture lands an hour after publish, not at publish, so the earliest row
describes a post that has had an hour of life rather than a row of absences a reader would mistake
for a result. `null` means frozen, so "frozen" is unrepresentable as a far-future date some later
bug could reach.

**Call budget, for SC-006**: 24 hourly captures in `[0, 24 h)`, then daily at 2 d…7 d (6), then
weekly at 14 d and 21 d (2) — the 28 d candidate is suppressed by the boundary rule. **32 captures
maximum over a post's whole life**, matching SC-006 exactly. The clock-pinned test that walks one
target from publication to day 40 asserts that count.

**Alternatives considered**: anchoring the cadence on `lastCapturedAt` alone — rejected: a target
that missed a window would drift its whole band structure. A cron-style schedule — rejected: it
needs a clock and a time zone, and these intervals have no wall-time meaning.

---

## §6 Where the section sits in the tick, and its time share

Spec constraint 5: sections run concurrently under one deadline, and a section out of time claims
nothing and returns success (`src/server/scheduler/config.ts:162-166`). Insights is the least urgent
section in the tick.

**Decision**: one new section, `runInsightsPoll`, added to the existing `Promise.all` in
`src/server/scheduler/index.ts` — concurrent, not sequenced after publishing. Its time share
defaults to `INSIGHTS_TIME_SHARE = 0.3`, against engagement's 0.8. It stops claiming and stops
calling once `deadline - now < providerTimeoutMs`, counting `outOfBudget` and returning success, and
it writes its own heartbeat (section name `insights_poll`) on **every** run, including one that did
nothing.

**Rationale**: insights only reads, so unlike `engagement-send` it does not compete with publishing
for the account's *write* path and needs no sequencing — the allowance reserve (§4) is the whole of
the protection FR-048 requires. A 0.3 share leaves the sections that predate it the bulk of the
budget. `outOfBudget` plus the unconditional heartbeat is what makes a starved run visible rather
than silent (US4, SC-007).

**Alternatives considered**: sequencing it after publishing as `engagement-send` is — rejected: it
would serialise a read-only section behind the slowest section in the tick for no safety gain.
Reusing engagement's `timeShare` knob — rejected: tuning one would silently move the other.

---

## §7 Two snapshot tables, two poll-state tables

**Decision**: `post_metric_snapshots`, `account_metric_snapshots`, `post_metric_poll_states`,
`account_metric_poll_states`. Columns, constraints and indexes in [data-model.md](./data-model.md).

**Rationale**: a post metric is keyed on a target and an account metric on an account; they have
different cadences, different lifetimes (a post freezes, an account never does) and different
natural keys. One table with nullable keys would need a CHECK forbidding the invalid combinations
and would make every query say "the ones that are really posts". The account poll state is
`engagement_account_states`' shape almost exactly, minus `cursor`, `provider_state`, `backfilling`
and `gap_at` — an insights read has no cursor (§9).

**`social_account_id` is denormalised onto `post_metric_snapshots`** so §4's window count is an index
lookup rather than a join through `post_targets` on every poll. It cannot diverge: a target's
`social_account_id` is fixed for its life (`post_targets_post_account_uq`, and nothing in the
codebase updates the column), and the insert copies it from the claimed target.

**Alternatives considered**: one `metric_snapshots` table with a `subject_kind` enum — rejected per
above. Storing metrics on `post_targets` as current values — rejected outright by the spec's central
rule: a metric is a snapshot, never a current value.

---

## §8 Idempotency of a repeat capture

FR-017: a second insert for the same subject at the same `captured_at` must be idempotent.

**Decision**: a unique constraint on `(project_id, post_target_id, captured_at)` and on
`(project_id, social_account_id, captured_at)`, with the DAL inserting `ON CONFLICT DO NOTHING`, and
`captured_at` truncated to milliseconds by a CHECK exactly as `engagement_items_said_at_ms` does
(`src/server/db/schema/engagement.ts:73`).

**Rationale**: `DO NOTHING` makes both the clock stepping backwards between ticks and two concurrent
ticks committing a capture for the same subject at the same instant harmless, rather than either a
duplicate row or an error the poller has to classify (SC-009). The millisecond truncation stops two
rows that are "the same moment" to a reader from differing in microseconds — the trap
`engagement_items` already guards against.

**Alternatives considered**: `ON CONFLICT DO UPDATE` — rejected: that is an overwrite, and the DAL
must make overwrite inexpressible (FR-016). No constraint, relying on the lease — rejected: a lease
prevents concurrent claims, not a clock stepping back between ticks.

---

## §9 The result vocabulary, and what "no longer on the platform" is

**Decision**: `InsightsReadResult` is `page | retryable_error | rate_limited | credentials_invalid |
fatal_error | unavailable` — `EngagementReadResult`'s vocabulary minus `cursor_lost`. The `page`
outcome carries one entry per **requested** target:

```ts
type PostMetricEntry =
  | { externalId: string; kind: "metrics"; metrics: unknown }
  | { externalId: string; kind: "gone" };
```

**Rationale**: an insights read has no cursor — a poll asks for a fixed set of ids, and the schedule
rather than a cursor decides what comes next — so `cursor_lost` has nothing to mean. `gone` is a
**per-target terminal outcome inside a successful read**, not an error kind, because
`app.bsky.feed.getPosts` returns views only for posts it can hydrate: a deleted or blocked post is
simply absent from the `posts` array, with no error at all (spec constraint 4). Modelling it as an
error would retry a dead at-URI hourly for 28 days and the panel would claim a failure where there
is none.

**One entry per requested target, not per returned post**: the provider diffs its request against
the response, so the generic layer never has to know that an absent element means gone — which is
the Bluesky-specific part of it. Entry 3's TikTok reader will report `gone` for its own reasons.

**Alternatives considered**: a seventh result kind `post_gone` — rejected: one call carries up to 25
targets and some of them are fine, and FR-042 requires the other targets in the batch to be stored
anyway.

---

## §10 Absence, carried all the way to the screen

**Decision**: a snapshot's `metrics` is a JSON object holding **only** keys the platform actually
returned; the DAL drops any key the provider did not declare before insert (FR-018); the panel
renders one row per declared key **present** in the latest snapshot, and nothing at all — no row, no
dash, no zero — for a key that is absent (FR-064).

**Rationale**: this is the rule the whole roadmap turns on. An Instagram "view", a TikTok "view" and
a Threads "view" are different events and Bluesky has none, so nothing may ever be summed or
averaged across platforms. Enforcing it in the data layer — declared keys only, platform labels
only, no generic key names anywhere in shared code — makes it true of every future surface rather
than only of this panel.

**How it is enforced mechanically**: the provider declares `{ key, label }` pairs; the generic layer
holds no metric-key constant of its own; and a provider-seam test (FR-061, after
`tests/integration/engagement/provider-seam.test.ts`) asserts that no module outside
`src/providers/` names a provider key or a platform metric key in any insights path (SC-013).

**Alternatives considered**: a shared metric taxonomy (`likes`, `shares`, `views`) with per-platform
mappings — rejected: it is precisely the thing that makes a cross-platform total look reasonable.

---

## §11 Retention of 400 days, pruned by the existing housekeeping section

**Decision**: `INSIGHTS_RETENTION_DAYS` defaults to **400**. Pruning joins
`src/server/scheduler/housekeeping.ts` as one more bounded batch per table per tick, counting
`postMetricSnapshotsPruned` and `accountMetricSnapshotsPruned` separately in `HousekeepingCounts`,
after the `pruneEngagementItems` precedent (`src/server/services/engagement/retention.ts`).

**Rationale**: the point of the subsystem is the history entry 4 compares. 365 would delete the far
end of a year-on-year comparison on the day it became interesting, and engagement's 90 would delete
it four times sooner. The rows are small. An operator who disagrees changes one setting.

**Pruning never touches a poll state** (FR-074): a frozen target keeps its state row, with its
freeze reason, after its last snapshot is pruned — otherwise the target would become eligible again
and the panel would promise a read that is never coming.

**Alternatives considered**: aggregating before pruning so an aggregate outlives the row — the spec
assigns that to entry 4, and this entry's 400-day default exists precisely to give entry 4 a year of
raw history to aggregate from.

---

## §12 No activity event, no notification, no new permission

**Decision**: a successful poll writes neither an `activity_events` row nor a notification. No label
is added to any activity enum. No statement is added to `src/server/auth/access.ts`; the panel is
governed by the existing `post: ["view"]`.

**Rationale**: a poll succeeds on every live target every hour, so one event per success would bury
the log — `engagement_received` is one event per *batch of new comments*, a different frequency
entirely (spec constraint 7). Nothing here is something a person needs telling about; the panel is
the surface. And these are the brand's own published numbers, visible to anyone who can already see
the post: unlike 077's inbox they are not a third party's personal data, so 077's reasoning for a
new permission statement does not carry over.

**The one exception is already generic**: a `credentials_invalid` read goes through
`markInvalidEmitting` (`src/server/scheduler/credentials.ts`), which emits the existing needs-reauth
signal, exactly as every other credential rejection does.

**Alternatives considered**: a `metrics_read` activity kind — rejected per above. An
`insights: ["view"]` statement — rejected: it would allow a role that can see a post but not its own
numbers, which nothing in the product wants.

---

## §13 A correction to one line of the spec

The spec's edge-case list says a project delete is covered because "the project-isolation suite
already asserts for every table" that no orphan row survives. Searched during this phase: there is
no such whole-schema assertion in `tests/`. The isolation tests
(`tests/integration/{posts,jobs,generation,standing-series}/isolation.test.ts`) each assert that one
feature's reads and writes cannot cross a project boundary — a different, and also necessary,
property.

**Consequence for this entry, not a scope change**: the four new tables still carry `project_id`
with `ON DELETE CASCADE` to `projects`, as FR-022 requires, and the quickstart adds a cross-project
isolation test in the shape of the existing ones. What this plan does **not** do is claim an existing
suite proves the cascade: [quickstart.md](./quickstart.md) §7 proves it directly, by deleting a
project row and asserting the snapshot and poll-state rows are gone.

---

## §14 Resolved: everything the Technical Context could have marked unknown

| Question | Resolution |
|---|---|
| New runtime dependency? | None. `@atproto/api` is installed and carries both queries |
| New infrastructure? | None. The work is a section of `runTick()` |
| Which host and auth for the reads? | The account's own PDS with its stored session (§2) |
| What is the read allowance? | Unverified; an interim declared figure (§3) |
| Where does the window count come from? | Rows that already exist; no new ledger (§4) |
| Migration number | `drizzle/0041_*.sql` — `0040_dark_whirlwind.sql` is the current head |
| New activity / notification vocabulary? | None (§12) |
| New permission statement? | None (§12) |
| New API / MCP / OpenAPI surface? | None — `OPERATIONS` is untouched, so the enumerated-surface tests need no edit |
| Where does the pure schedule live? | `src/lib/insights/schedule.ts`, no clock, no database (§5) |

One `NEEDS RESEARCH` remains open (§2) and is recorded in `docs/research/bluesky.md` as unverified.
No requirement, test or default depends on its answer.
