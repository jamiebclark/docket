# Feature Specification: Post and account insights, with Bluesky as the pilot platform

**Feature Branch**: `080-insights-core-bluesky`

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description: "Build the whole read-and-store spine against the platform that cannot block it. Add an `insights?` member to `SocialProvider` as generic change **G30** … two snapshot tables … a per-target poll state … a decaying poll schedule … a new `runInsightsPoll` tick section with `INSIGHTS_*` config knobs … the Bluesky reader needs no new permission at all … the only UI is a performance panel on the post detail page. Does **not**: touch any OAuth scope or request any new permission; add an API or MCP operation; draw any chart, trend or comparison; or read any Instagram, Facebook, Threads, TikTok, Pinterest or X account." (section 1 of `.specify/roadmaps/social-insights.md`)

## Overview

Docket publishes and, since 077, reads what people *say* back. It is blind to numbers: nothing in the
database records that a post got 4 likes or 40,000 views. This entry builds the whole read-and-store
spine — a declared provider capability, two append-only snapshot tables, per-target and per-account
poll state, a decaying poll schedule, a bounded tick section and one honest panel — and proves it end
to end on the one platform that cannot block it. Bluesky's `externalId` is already the post's at-URI,
and reading counts needs no permission Docket does not already hold, so the subsystem can be finished
and verified before any OAuth scope question is opened (entry 2 opens it).

The product rule that shapes everything here: **a metric is a snapshot, never a current value, and a
metric a platform does not report is absent, never zero.** Docket stores
`(target or account, captured_at, metrics)` rows and the UI always says what a number is "as of".

## Context and sources

- **This entry changes the product's stated scope.** The constitution's Engineering Constraints list
  "analytics" as out of scope *until a spec says otherwise*. This is that spec, for per-post and
  per-account metric capture only; charts, trends and comparisons remain out of scope and belong to
  entry 4. `docs/build-prompt.md` and the constitution must both be amended in this entry rather than
  silently contradicted, as 077 did for the inbox.
- **The roadmap this entry belongs to**: `.specify/roadmaps/social-insights.md` §1, read in full,
  including "Behaviour on `main` that every entry builds on" and "Rules for every entry". Entry 2
  (`insights-reconnect-and-meta`) adds the scope machinery and the Meta family, entry 3
  (`insights-tiktok-pinterest-x`) the rest, entry 4 (`insights-schedule-intelligence`) everything
  derived.
- **077 is the worked precedent for a read subsystem** and its shape is copied, not reinvented:
  - `src/providers/types.ts:485-500` — `EngagementDeclaration` with `reads`, `writeBudget` and the
    `unavailable: { reason, docsPath }` escape, and `EngagementReadResult` (`page` /
    `retryable_error` / `fatal_error` / `credentials_invalid` / `rate_limited` / `cursor_lost` /
    `unavailable`).
  - `src/server/db/schema/engagement.ts:208` — `engagement_account_states`: cursor, `provider_state`,
    lease pair, `read_not_before`, `consecutive_failures`, `last_error`, with
    `engagement_account_states_lease_pair`, `..._failures_nonneg` and a 2,000-byte
    `octet_length(provider_state::text)` size check. `engagement_items.provider_data` is size-checked
    the same way (`engagement.ts:72`).
  - `src/server/dal/engagement-read-claims.ts` — a claim DAL that creates state rows lazily for
    eligible accounts and takes `FOR UPDATE SKIP LOCKED` on the *state* table only, so a concurrent
    publish holding the account row never blocks a claim.
  - `src/server/scheduler/engagement-read.ts` — the provider call outside any transaction, one
    commit per account, the lease released on every path, and the stop-result table mapping each
    non-`page` kind onto backoff, `rate_limited` retryAt, `markInvalidEmitting` and `redact`.
  - `src/server/scheduler/engagement-budget.ts` — `stricterBudget`, `windowStart`, `reserveFloor`
    (`floor(count × (1 − reserve))`) and `mayAttemptReply`: pure, unit-tested budget maths.
  - `src/server/scheduler/config.ts:45-52, 140-168` — the `ENGAGEMENT_*` knob block, the
    `ENGAGEMENT_DEFAULTS` table, `engagementConfig()` and the time-share comment at 162-166.
  - `src/server/scheduler/index.ts:19-31, 56` — `TickSummary`, one `SectionResult` per section, and
    the `Promise.all` they run in.
  - `src/providers/mock/engagement.ts` and `src/providers/mock/settings.ts:42-50` — the scripted
    fixture (`engagementUnavailable`, `engagementItems`, `engagementReadBehaviour`,
    `engagementReadFailAfterPages`) that makes the generic layer testable with no credentials.
- **The join key already exists.** `post_targets.external_id` and `external_url`
  (`src/server/db/schema/posts.ts:233-235`) are written for every published target, and for Bluesky
  the external id *is* the post's at-URI (`src/providers/bluesky/publish.ts:207`,
  `docs/research/bluesky.md` "Posting"). The account's `external_account_id` is the DID
  (`src/providers/bluesky/session.ts:56`).
- **Other existing pieces reused rather than reimplemented** (constitution IV): the scoped DAL
  (`src/server/dal/`), `src/server/scheduler/limits.ts` (`effectiveLimits`, `deferralTime`),
  `src/server/scheduler/backoff.ts` (`nextRetryAt`), `src/server/scheduler/redact.ts` (`redact`,
  `secretValues`), `src/server/scheduler/credentials.ts` (`markInvalidEmitting`),
  `src/server/dal/heartbeats.ts` (`writeHeartbeat`), `src/server/scheduler/housekeeping.ts` and
  `src/server/services/engagement/retention.ts` as the pruning precedent, `src/providers/bluesky/`
  (`client.ts`'s `agentFor`, `errors.ts`'s `isCredentialRejection`/`rateLimitNotBefore`/`safeReason`,
  `session.ts`), and `tests/integration/security/secret-scan.test.ts`.

### Constraints found while specifying (recorded for planning)

1. **Bluesky's metric fields are confirmed from the installed package; the transport is not.** Read
   directly from `node_modules/@atproto/api` (constitution I permits the installed package's own
   types), both the generated types and the bundled lexicon `schemaDict`:
   - `app.bsky.feed.getPosts` takes `uris: string[]` with lexicon `maxLength: **25**` and returns
     `posts: PostView[]`.
   - `PostView` properties are exactly `uri, cid, author, record, embed, bookmarkCount, replyCount,
     repostCount, likeCount, quoteCount, indexedAt, viewer, labels, threadgate, debug`. All four
     counts the roadmap names are **optional**, so "absent" is a real wire state, not a modelling
     choice. **There is no view, impression or reach field of any kind** — a confirmed negative.
   - `app.bsky.actor.getProfile` takes `actor` (handle or DID) and returns `ProfileViewDetailed`
     with optional `followersCount`, `followsCount`, `postsCount` (and no reach or views field).
   - **Not confirmed anywhere**: that the public AppView serves these two queries *without*
     authentication, or at which host. `docs/research/bluesky.md` records a default PDS of
     `https://bsky.social`, a custom-PDS setting, and nothing about an unauthenticated AppView.
     The roadmap asserts it; constitution I forbids taking it on trust.
     **`NEEDS RESEARCH: docs/research/bluesky.md` — whether `app.bsky.feed.getPosts` and
     `app.bsky.actor.getProfile` answer unauthenticated, at which host, and under what read limit.**
     The design does not depend on the answer (see Decisions: reads go through the account's existing
     session), so this is a recorded gap, not a blocker.
2. **Bluesky read rate limits are explicitly unverified.** `docs/research/bluesky.md` "Rate limits"
   documents write points only, and 077's `docs/research/engagement.md` states outright that the file
   "is silent on `listNotifications` read limits". So no read allowance can be declared from research.
   Any declared insights read budget is **interim, UNVERIFIED** and must say so, exactly as other
   interim figures in `docs/limits.md` do.
3. **A hand-resolved target is published with no external id, and that is not a failure.**
   `post_targets_published_has_id` (`src/server/db/schema/posts.ts:269`) reads
   `status <> 'published' OR external_id IS NOT NULL OR resolved_at IS NOT NULL`. Such a target can
   never be polled; it must be skipped and shown as a reason, never counted as an error.
4. **A deleted post disappears silently.** `getPosts` returns views only for posts it can hydrate; a
   deleted or blocked post is simply **absent from the `posts` array** with no error. So "the
   platform no longer returns this post" is a distinct, terminal outcome that must be modelled, or
   the poller retries a dead at-URI hourly for 28 days and the panel claims a failure.
5. **Tick sections run concurrently under one deadline, and a section out of time claims nothing and
   returns success** (`src/server/scheduler/config.ts:162-166`). Without its own `SectionResult` in
   `TickSummary`, its own `Promise.all` entry and its own heartbeat, a starved insights section is
   invisible rather than visible. Insights is also the *least* urgent section in the tick, so its
   time share must be well below engagement's 0.8 or it will starve the sections that predate it.
6. **The allowance window needs a count, and `allowance_uses` cannot supply it.** `allowance_uses`
   (`src/server/db/schema/scheduler.ts:19-39`) has `units` and no kind column — it is specifically a
   provider's `creationAllowance` (containers) ledger, and writing insights reads into it would
   corrupt the count that defers a publish. A separate rolling counter table, or a counter column
   touched by both the per-target and the per-account claim path, would introduce a second row to
   lock in each transaction and with it a lock-order deadlock risk the constitution's review list
   calls out. See Decisions for the resolution.
7. **A snapshot per target per hour is a lot of rows, and a lot of activity events.** A project with
   50 live targets produces ~1,200 post snapshots a day. The retention default must therefore be
   chosen for entry 4's year-long trends rather than copied from engagement's 90 days, and a
   successful poll must not write an activity event — `engagement_received` is one event per *batch
   of new comments*, whereas an insights poll succeeds on every target every hour and would bury the
   log.
8. **`post_targets.external_id` can change owner-side after the fact**, which 077 already notes
   (`engagement-read.ts`: the parent is resolved "once at ingest, since `post_targets.external_id`
   can change owner-side"). A snapshot must therefore be keyed on the *target*, not on the external
   id, so a re-resolved target keeps its history.
9. **`src/providers/**` must not import from `src/server/**`** — a lint test enforces it, so the
   provider-facing contract cannot reference DAL types, scheduler config or schema rows.
10. **No new infrastructure is available** (constitution VI): polling happens inside `runTick()`,
    bounded well under 30 s, safe to run concurrently, safe to kill mid-run, with no advisory locks
    and no `LISTEN` (Neon's pooler is transaction-mode).

## Decisions made while specifying

Each is a judgement call to be appended to `docs/decisions.md`, and each is reversible.

- **A metric the platform does not report is absent, and absence is carried all the way to the
  screen.** Not zero, not an em dash standing in for zero, not a key with a null. The provider
  declares which keys it reports; a key missing from a snapshot renders no row at all. Bluesky
  declares **no views and no reach**, from the confirmed negative in constraint 1, so the panel never
  implies the post was seen zero times. This is the rule the whole roadmap turns on: an Instagram
  "view", a TikTok "view" and a Threads "view" are different events and Bluesky has none, so nothing
  is ever summed or averaged across platforms, and every number is labelled with that platform's own
  word supplied by that platform's own provider.
- **Nothing overwrites a number.** Every successful read inserts a row; no row is ever updated. The
  DAL exposes insert and read-latest and has no update or single-row delete for a snapshot, so
  "overwrite the current value" is not expressible. The panel always states "as of <time>".
- **Reads go through the account's existing session, not an unauthenticated host.** Constraint 1
  leaves the public AppView unverified, and 077 already proves the authenticated path:
  `agentFor(pdsUrl, accessJwt)` reading `app.bsky.*` through the account's own PDS. That path needs
  **no new permission** — the app-password session Docket already holds for publishing and for the
  inbox is the same session — so the roadmap's actual premise (Bluesky cannot block this entry)
  holds either way. If the research lands and the public AppView does serve these queries
  anonymously, switching is a change inside the Bluesky provider alone and a later entry's business.
- **The declaration names metric keys with the platform's own label, and the generic layer never
  renames one.** A declared key is `{ key, label }` — `likeCount` / "Likes" — and no shared code
  maps, aliases or groups keys across platforms. This is what makes "never sum across platforms"
  enforceable in the data layer rather than only in a chart.
- **The result vocabulary is `EngagementReadResult`'s, minus `cursor_lost`.** `page`,
  `retryable_error`, `rate_limited`, `credentials_invalid`, `fatal_error`, `unavailable` — no new
  error words. `cursor_lost` is dropped because an insights read has no cursor: a poll asks for a
  fixed set of ids and the schedule, not a cursor, decides what comes next.
- **A declared-but-unavailable surface is shown and never called.** The same
  `unavailable: { reason, docsPath }` escape as `engagement`, honoured in the claim itself — an
  account whose provider declares `insights.unavailable` is never claimed, so no call is ever
  attempted, and the panel shows the reason with a docs link. Entries 2 and 3 depend on this.
- **`readPostMetrics` takes a batch of targets for one account, not one target.** `getPosts` accepts
  25 at-URIs in one call, and entry 3's TikTok reader is capped at 20 video ids per request and
  "must group by account". Making the contract batch-shaped now means entry 3 adds a provider, not a
  contract change. The batch size is `min(INSIGHTS_READ_PAGE_SIZE, provider.insights.maxPostsPerRead)`.
- **The poll schedule decays, from `published_at`, in pure functions with no clock inside them.**
  Hourly for the first 24 hours, daily to day 7, weekly to day 28, then frozen. A three-week-old
  post does not change, and polling it hourly for ever spends an allowance a scheduled publish may
  need, for nothing.
- **The first capture is an hour after publish, not at publish.** The schedule is anchored on
  `published_at`, so the earliest snapshot describes a post that has had an hour of life rather than
  recording a row of zeroes-or-absences a reader would mistake for a result.
- **A target already past the frozen boundary when the subsystem arrives gets exactly one capture,
  then freezes.** Otherwise every post published before this entry existed would have no numbers for
  ever, and the panel would be empty on the day the feature shipped for every post anybody cares
  about. The one-off captures are bounded by `INSIGHTS_TARGETS_PER_RUN`, so a large backlog drains
  over ticks instead of arriving as a spike.
- **"The platform no longer returns this post" is terminal, not a failure.** Constraint 4. The
  target's poll state is frozen with that reason, `consecutive_failures` stays at zero, and the panel
  says the post is no longer on the platform — beside whatever snapshots were captured while it
  existed, which are kept. A deleted post's history is still history.
- **The allowance check counts what is on the ledger already and reserves a share for publishing.**
  Constraint 6. For an account, the window count is the publishes started in the window
  (`post_targets.publish_started_at`, the existing `post_targets_started_idx`) plus the snapshots
  already captured in the window, and a poll is refused when that total reaches
  `floor(stricterBudget.count × (1 − INSIGHTS_READ_RESERVE))` — `reserveFloor` reused unchanged. No
  new table, no counter column, no second row to lock, so no lock-order risk. The stated limitation:
  a *failed* read leaves no snapshot and so is not counted, and the bound on repeated failures is
  the existing backoff on `consecutive_failures`, not the allowance. The reserve default is 0.5,
  double engagement's 0.25 for writes, because a reply somebody approved is worth more of an
  account's allowance than a number nobody is waiting for.
- **The reserve applies even where the platform's read limit is separate from its write limit.**
  Bluesky's documented points are for writes; reads are unverified (constraint 2). Charging insights
  reads against the publish allowance is therefore conservative rather than exact, and conservative
  is the right direction: it can only make Docket poll less than it might, never publish less than
  it should. Recorded so a later entry with verified read limits can relax it.
- **A successful poll writes no activity event and no notification.** Constraint 7. Nothing here is
  something a person needs telling about; the panel is the surface. The one exception is already
  generic: a `credentials_invalid` read goes through `markInvalidEmitting`, which emits the existing
  needs-reauth signal, as every other credential rejection does.
- **No new permission statement.** The panel is governed by `post: ["view"]` — these are the brand's
  own published numbers, visible to anyone who can already see the post, and unlike 077's inbox they
  are not a third party's personal data. Nothing is added to `src/server/auth/access.ts`.
- **No API, no MCP, no export.** 074's rule: a capability worth driving over MCP with no endpoint
  belongs in an API entry first, and entry 4 owns both. Leaving `OPERATIONS` untouched also keeps the
  enumerated-surface tests green with no edits.
- **Two snapshot tables and two poll-state tables, not one of each.** A post metric is keyed on a
  target and an account metric on an account; they have different cadences, different lifetimes (a
  post freezes, an account never does) and different natural keys. One table with nullable keys would
  need a check constraint forbidding the invalid combinations and would make every query say "the
  ones that are really posts". The account poll state is `engagement_account_states`' shape almost
  exactly.
- **`social_account_id` is on `post_metric_snapshots` too.** The roadmap names `project_id`,
  `post_target_id`, `provider_key`, `captured_at`, `metrics`; the allowance window count needs
  "snapshots for this account in this window" on an index, and resolving it through `post_targets` on
  every poll is a join the claim path does not need. It is denormalised from the target and never
  diverges, because a target's account cannot change.
- **Retention defaults to 400 days, not engagement's 90.** The point of the subsystem is history
  entry 4 can compare, and 365 would delete the far end of a year-on-year comparison on the day it
  became interesting. Pruning joins the existing housekeeping section with its own counts, exactly
  as `pruneEngagementItems` does; entry 4 owns the "aggregate before pruning" refinement.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Numbers appear for a published post, and the panel never lies about them (Priority: P1)

A member opens a post that went out yesterday. Under each account the post reached, a short
performance panel shows that account's platform's own numbers — Likes, Reposts, Replies, Quotes for
Bluesky — each labelled with the platform's own word, with one line saying what they are "as of".
Where a number has not been read yet, or the platform reports nothing, or the read is failing, the
panel says which of those it is instead of showing a zero.

**Why this priority**: This is the whole spine. The provider declaration, the snapshot tables, the
poll state, the tick section and the panel are all exercised by it, and with the `mock` provider's
`insights` module it is fully testable with no platform credentials at all — which is what makes
every later entry cheap.

**Independent Test**: With a project holding a `mock` account and a published target, run a tick with
a pinned clock: a snapshot row appears, the panel renders the mock's declared labels and an "as of"
time, and switching the mock's scripted behaviour to each honest state (never polled, nothing
reported, unavailable, failing, gone) renders that state and no number.

**Acceptance Scenarios**:

1. **Given** a published target on a provider that declares insights, and no snapshot yet, **When** a
   member opens the post, **Then** the panel says the numbers have not been read yet and names when
   the first read is due, and shows no zeroes.
2. **Given** one tick has captured a snapshot with `likeCount: 4` and no `quoteCount` key, **When** a
   member opens the post, **Then** "Likes 4" is shown with the platform's own word, no quotes row is
   shown at all, and one "as of <time in the project's time zone>" line covers the panel.
3. **Given** two snapshots for the same target an hour apart, **When** a member opens the post,
   **Then** only the later one is shown, the earlier one is still stored, and nothing in the UI
   presents a difference, trend or arrow between them.
4. **Given** a provider that declares insights with an `unavailable` reason and a docs path, **When**
   a member opens a post with a target on it, **Then** the panel shows that reason and a link to the
   doc, and no provider call has been attempted for that account in any tick.
5. **Given** a target published by hand with no external id, **When** a member opens the post,
   **Then** the panel says there is no post on the platform to read numbers from, the tick counted it
   as skipped rather than failed, and no poll state is left in a failing condition.
6. **Given** four consecutive failed reads for a target that had one good snapshot, **When** a member
   opens the post, **Then** the last good snapshot is still shown with its own "as of" time *and* a
   line saying reads have been failing since a stated time, with a plain reason and no credential,
   token or URL fragment in it.
7. **Given** a target whose post the platform no longer returns, **When** a member opens the post,
   **Then** the panel says the post is no longer on the platform, any snapshots captured while it
   existed are still shown, and the target is not being polled any more.

---

### User Story 2 - Bluesky's own numbers, with no new permission asked for (Priority: P2)

The Bluesky accounts an install already has start producing real numbers — post likes, reposts,
replies and quotes, and account followers, follows and posts — without anybody reconnecting an
account, approving a scope, or changing a single setting. Views and reach are not shown for Bluesky,
because the protocol has none.

**Why this priority**: It is the proof that the spine works against a real platform, and it is
available on day one because the session Docket already holds is the only credential needed. It
depends on US1's contract but on nothing else.

**Independent Test**: With mocked HTTP for `app.bsky.feed.getPosts` and `app.bsky.actor.getProfile`,
a tick captures a post snapshot keyed by the at-URI in `post_targets.external_id` and an account
snapshot keyed by the DID in `social_accounts.external_account_id`; the Bluesky provider's declared
keys contain no views or reach key; and each of the mocked failure shapes (429 with a retry header, a
rejected session, a 5xx, a post absent from the response) produces the documented outcome.

**Acceptance Scenarios**:

1. **Given** a Bluesky account with three published targets due a poll, **When** the tick runs,
   **Then** one `getPosts` call carries all three at-URIs, three snapshots are written, and each
   holds only the count keys the response actually contained.
2. **Given** a `getPosts` response in which a post carries `likeCount: 2` and no other count,
   **When** the snapshot is stored, **Then** it holds `likeCount` alone — not three zeroes — and the
   panel shows one number.
3. **Given** a Bluesky account due an account poll, **When** the tick runs, **Then** one
   `getProfile` call is made for the account's DID and a snapshot holds whichever of
   `followersCount`, `followsCount` and `postsCount` the response contained.
4. **Given** Bluesky answers 429 with a rate-limit reset header, **When** the tick runs, **Then** no
   snapshot is written, the next poll is set no earlier than the reset the header states, and the
   tick counts it as rate limited rather than failed.
5. **Given** Bluesky rejects the stored session, **When** the tick runs, **Then** the account is put
   into the existing needs-reauth state through the same path a failed publish uses, and the error
   recorded carries no part of any token.
6. **Given** a requested at-URI is absent from the `posts` array, **When** the tick runs, **Then**
   that target is frozen as no longer on the platform, the other requested targets in the same call
   are still stored, and nothing is counted as a failure.

---

### User Story 3 - Polling pays for itself: it decays, it is bounded, and publishing always wins (Priority: P2)

An operator running a busy install finds that insights polling has not delayed a single scheduled
post, has not grown without limit as the archive grows, and has not kept asking a platform about
posts that stopped changing weeks ago.

**Why this priority**: Without this the subsystem is a liability rather than a feature — it spends a
shared per-account allowance that scheduled publishing needs, and it does so on posts whose numbers
are settled. It is independently testable with pure-function unit tests plus a tick test that pins
the clock.

**Independent Test**: Unit-test the schedule functions at each boundary with injected `now` values
(no clock read inside them), then run a tick against an account whose allowance window is already
full of publishes and assert that no provider call was made and the poll was deferred rather than
failed.

**Acceptance Scenarios**:

1. **Given** a target published 30 minutes ago, 20 hours ago, 3 days ago, 10 days ago and 40 days
   ago, **When** the next poll time is computed with a fixed `now`, **Then** the intervals are one
   hour, one hour, one day, one week and frozen respectively, and the function reads no clock.
2. **Given** a target published 40 days ago that has never been captured, **When** the next poll time
   is computed, **Then** it is due immediately, and after one successful capture it is frozen.
3. **Given** an account whose effective allowance window already holds publishes and snapshots up to
   the reserve floor, **When** the tick runs, **Then** no provider call is made for that account, the
   poll is left due and counted as deferred for allowance, and a scheduled publish for that account
   in the same tick is unaffected.
4. **Given** more targets due than `INSIGHTS_TARGETS_PER_RUN`, **When** the tick runs, **Then** at
   most that many are claimed, the rest stay due, and the oldest-due are taken first.
5. **Given** a tick whose remaining time is less than the provider timeout, **When** the insights
   section runs, **Then** it claims nothing, writes its heartbeat with a zeroed count set and an
   out-of-budget count, and returns success.
6. **Given** two ticks running concurrently, **When** both claim, **Then** no target or account is
   claimed by both, no claim blocks on a row a publish holds, and killing one mid-read leaves no
   lease held past its expiry and no half-written snapshot.

---

### User Story 4 - An operator can see the section working, or see that it did nothing (Priority: P3)

The tick summary carries insights counts of its own and the section writes its own heartbeat, so an
operator reading a tick can tell the difference between "there was nothing due" and "the section ran
out of time and claimed nothing".

**Why this priority**: Sections run concurrently under one deadline and a starved section returns
success with zero counts (constraint 5). Without its own counts and heartbeat the failure mode is
silence, which is the hardest kind to diagnose and the reason this is called out explicitly in the
roadmap.

**Independent Test**: Run a tick and assert the summary contains an insights section result with the
documented count keys, and that a heartbeat row for the section exists with the same counts; then
run one with the time share set to near zero and assert the out-of-budget count is non-zero and the
section still reports success.

**Acceptance Scenarios**:

1. **Given** a tick with nothing due, **When** it completes, **Then** the summary holds an insights
   section result with every count at zero and a heartbeat was written.
2. **Given** a tick in which the insights section throws, **When** it completes, **Then** that
   section reports failure with zeroed counts, the other sections are unaffected, and the logged
   message carries no credential.
3. **Given** retention is configured and snapshots older than it exist, **When** housekeeping runs,
   **Then** it deletes them in bounded batches, counts post and account snapshots separately, and
   never deletes a poll state row or a target.

---

### Edge Cases

- **A target that is scheduled, failed, ambiguous or cancelled** — never polled. Only `published`
  with an external id is eligible.
- **A target published, then re-resolved to a different external id** — the snapshot history follows
  the target, not the id, so earlier snapshots are kept and the next poll uses the new id.
- **An account removed from the project (soft-deleted) or set to needs-reauth** — not claimed, its
  existing snapshots stay readable, the panel shows the last "as of" without implying a live read.
- **A project or post deleted** — its snapshots and poll states go with it by cascade; no orphan row
  survives a project delete, which the project-isolation suite already asserts for every table.
- **A provider with no `insights` member at all** — accounts on it are absent from the poller with no
  error, and the panel says Docket cannot read numbers from that platform yet. This is how every
  platform other than Bluesky and `mock` starts.
- **A provider that declares a key it then never returns** — the key is simply absent from snapshots
  and from the panel; declaring a key is not a promise that the platform answered.
- **A provider that returns a metric key it never declared** — the undeclared key is dropped before
  storage, so the panel can only ever show what the provider said it reports.
- **A metrics payload that is too large, or fails the provider's own schema** — the snapshot is
  refused, the read counted as failed, the stated reason recorded, and no partial row written.
- **A metric value that is not a whole number, is negative, or is enormous** — stored as the provider
  validated it and rendered as given; Docket does not correct a platform's arithmetic, but the size
  check and the provider schema bound what can arrive.
- **The clock moving backwards between ticks, or two captures in the same instant** — a repeat
  capture at an identical `captured_at` for the same subject is idempotent rather than duplicated.
- **A target published in a time zone far from the project's** — snapshots are stored in UTC and the
  "as of" line is rendered in the project's time zone, like every other time in the product.
- **An install that never has a Bluesky account** — nothing changes anywhere, no table grows, and no
  section does work.

## Requirements *(mandatory)*

### Functional Requirements

#### The provider contract (generic change G30)

- **FR-001**: `SocialProvider` MUST gain one optional member, `insights`, recorded as generic change
  **G30**. A provider that omits it is absent from the poller and from the panel with no error
  anywhere, and no other code may name a provider to decide whether it has insights.
- **FR-002**: The declaration MUST name, separately, the metric keys the platform reports **for a
  post** and **for an account**. Each declared key MUST carry the platform's own label for it. The
  generic layer MUST NOT rename, alias, translate or group a key, and MUST NOT define any key of its
  own.
- **FR-003**: The declaration MUST carry the same `unavailable: { reason, docsPath }` escape as
  `engagement`. A provider that declares it MUST never be called for any account: the claim itself
  excludes it, and the panel shows the reason with a link to the named doc.
- **FR-004**: A declaration MUST be rejected at registration if it declares neither a post key nor an
  account key and is not marked unavailable — the way to report nothing is to omit `insights`.
- **FR-005**: The declaration MUST carry the provider's own schema for the stored metrics payload (one
  for a post, one for an account), which the generic layer validates against and never reads into.
  Each schema MUST reject anything resembling a credential or token.
- **FR-006**: The declaration MUST state the maximum number of posts the platform will answer for in
  one call, so the poller can batch without knowing any platform's rules.
- **FR-007**: The declaration MUST carry its own per-account read budget (a count and a window), used
  for the publishing-first reserve. Where no platform figure is verified, the declared figure MUST be
  marked interim and unverified in `docs/limits.md`.
- **FR-008**: `readPostMetrics` MUST accept one account plus a batch of that account's targets (each
  with its external id) and MUST return a single discriminated result. The `page` outcome MUST carry
  one entry per requested target, each either the metrics read for it or an explicit statement that
  the platform no longer returns that post.
- **FR-009**: `readAccountMetrics` MUST accept one account and return the same discriminated result
  shape, with metrics for that account.
- **FR-010**: Both MUST return one of exactly `page`, `retryable_error`, `rate_limited`,
  `credentials_invalid`, `fatal_error` or `unavailable` — the `EngagementReadResult` vocabulary minus
  `cursor_lost` — and MUST NOT introduce a new error word.
- **FR-011**: Neither call may throw, and neither may have any side effect on the platform: no mark
  as seen, no write, no state change of any kind on the account.
- **FR-012**: `src/providers/**` MUST NOT import from `src/server/**`, and the existing lint test
  enforcing it MUST stay green with the new contract in place.
- **FR-013**: G30 MUST be recorded as a new row in the "Generic hooks index" table of
  `docs/adding-a-provider.md` and as a new entry in `docs/decisions.md`, each stating what the hook is
  and how to reverse it.

#### Storage

- **FR-014**: A `post_metric_snapshots` table MUST hold `project_id`, `post_target_id`,
  `social_account_id`, `provider_key`, `captured_at` and a `metrics` payload, with the payload
  validated by the provider's own schema before insert and size-checked exactly as
  `engagement_items.provider_data` is.
- **FR-015**: An `account_metric_snapshots` table MUST hold `project_id`, `social_account_id`,
  `provider_key`, `captured_at` and a `metrics` payload, under the same validation and size check.
- **FR-016**: Both tables MUST be append-only through the DAL: the DAL MUST expose insert and
  read-latest and MUST NOT expose any way to update a snapshot or delete a single one. Deletion
  happens only through retention pruning and through the cascade from a deleted project, post or
  account.
- **FR-017**: A second insert for the same subject at the same `captured_at` MUST be idempotent, not
  a duplicate row and not an error the poller has to handle.
- **FR-018**: A metric key the provider did not declare MUST be dropped before storage, so no snapshot
  can hold a key the panel is unable to label.
- **FR-019**: A per-target poll state MUST hold `next_poll_at`, a lease pair, `consecutive_failures`
  and `last_error`, plus when it was last polled, when it was last captured, and whether and why it
  is frozen. It MUST carry the same lease-pair check constraint as `engagement_account_states`
  (`(lease_until IS NULL) = (lease_owner IS NULL)`) and the same non-negative-failures check.
- **FR-020**: A per-account poll state MUST hold the same fields for the account read. Rows of both
  kinds MUST be created lazily — only for a target or account on a provider that declares insights
  and is not unavailable — so an install with no such provider gains no rows.
- **FR-021**: Snapshots MUST be keyed on the target and on the account, never on an external id, so a
  target re-resolved to a different external id keeps its history.
- **FR-022**: Every new table MUST carry `project_id` and be reachable only through the scoped DAL,
  and MUST cascade on project, post, target and account deletion as the existing tables do.
- **FR-023**: The schema change MUST ship as a committed migration generated by `pnpm db:generate`,
  with `pnpm db:check` green.

#### The decaying poll schedule

- **FR-024**: The next poll time for a post MUST be a pure, total function of the post's publish time,
  the time of the last capture, and an injected "now". It MUST read no clock, consult no database and
  have no other input.
- **FR-025**: The cadence MUST be, with every band half-open on its upper end and measured as age
  since publishing: every hour while age is under 24 hours; every day while age is 24 hours or more
  and under 7 days; every week while age is 7 days or more and under 28 days; frozen once age reaches
  28 days. A next time the rule would place on or after the freeze boundary MUST be no next time at
  all, so no poll is ever scheduled for a target that will be frozen when it arrives.
- **FR-026**: A target whose publish time is already past the frozen boundary and which has never been
  captured MUST be due immediately, and MUST freeze after one successful capture.
- **FR-027**: A frozen target MUST never be claimed again, and the function MUST say so by returning
  no next time rather than a far-future one.
- **FR-028**: A configured minimum interval MUST apply as a floor on top of the cadence, so no target
  can be polled twice inside it however the cadence is configured or whatever the clock does.
- **FR-029**: The account cadence MUST be its own pure function with the same rules about clocks, and
  MUST NOT decay — an account's followers keep changing — subject to the same minimum interval.
- **FR-030**: Every boundary in both functions MUST be covered by unit tests at the boundary value, one
  second before it and one second after it.

#### The tick section

- **FR-031**: A new `runInsightsPoll` tick section MUST claim due targets and due accounts, call the
  provider outside any transaction, and commit each account's snapshots and poll-state updates in one
  transaction per account.
- **FR-032**: Claims MUST take `FOR UPDATE SKIP LOCKED` on the poll-state rows only, so a concurrent
  publish holding an account or target row never blocks a claim, and two concurrent ticks never claim
  the same subject.
- **FR-033**: A lease MUST be released on every path out of the section, including every failure path,
  and an expired lease MUST be reclaimable by a later tick with no manual intervention.
- **FR-034**: The section MUST claim at most the configured number of targets per run and at most a
  stated number of accounts per run, oldest-due first in both cases, and MUST batch each account's
  claimed targets into calls of at most
  `min(configured page size, the provider's declared maximum)`.
- **FR-035**: The section MUST take only its configured share of the tick's time budget, and MUST stop
  claiming and stop calling once the remaining time is less than the provider timeout — claiming
  nothing, counting that it ran out of budget, and returning success.
- **FR-036**: `TickSummary` MUST gain its own section result for insights, with counts covering at
  least: targets claimed, accounts claimed, post snapshots written, account snapshots written, targets
  frozen, posts the platform no longer returns, targets skipped for having no external id, polls
  deferred for allowance, retryable failures, rate-limited reads, invalid credentials, unavailable
  surfaces, outright failures, and times it ran out of budget.
- **FR-037**: The section MUST have its own entry in the tick's concurrent run and MUST write its own
  heartbeat with those counts on every run, including a run that did nothing.
- **FR-038**: A throw anywhere in the section MUST be contained to the section — it reports failure
  with zeroed counts and no other section is affected.
- **FR-039**: A published target with no external id MUST be skipped and counted as skipped. It MUST
  NOT increment `consecutive_failures`, set a `last_error`, or be retried on a backoff.
- **FR-040**: Each non-`page` result MUST map as 077 does: `retryable_error` and `fatal_error` to an
  incremented failure count and the existing backoff; `rate_limited` to the provider's stated retry
  time or the backoff, without incrementing failures; `credentials_invalid` through the existing
  needs-reauth path; `unavailable` to a released lease and no state change.
- **FR-041**: Every error recorded on a poll state, logged, or shown MUST be passed through the
  existing redaction helper against the account's own credential values first.
- **FR-042**: A read whose `page` result names a post the platform no longer returns MUST freeze that
  target with that reason, leave `consecutive_failures` at zero, and keep the other targets in the
  same batch.
- **FR-043**: Snapshots already captured in a batch MUST be committed even when the same batch then
  stops on a failure, and a failed read MUST never advance a target's schedule as though it had
  succeeded.
- **FR-044**: Nothing in this section may write an activity event or a notification for a successful
  read.

#### Publishing wins the allowance

- **FR-045**: Before each provider call for an account, the section MUST check that account's
  effective allowance — the stricter of the provider's declared read budget and the account's own
  publish-limit override — and MUST refuse the call when the publishes started in the window plus the
  snapshots already captured in the window have reached `floor(count × (1 − reserve))`.
- **FR-046**: A refusal MUST leave the poll due, count as deferred for allowance, and never be
  recorded as a failure or a platform error.
- **FR-047**: The reserve MUST be configurable and MUST default to leaving at least half of each
  account's allowance untouched by polling.
- **FR-048**: A scheduled publish MUST never be deferred, delayed or failed because of an insights
  poll, and a test MUST prove it with an account whose window polling has already filled to the
  reserve floor.
- **FR-049**: The budget maths MUST be pure and unit-tested, reusing the existing reserve-floor and
  stricter-budget helpers rather than a second implementation.

#### The Bluesky reader

- **FR-050**: The Bluesky provider MUST declare post metric keys for likes, reposts, replies and
  quotes, each labelled with Bluesky's own word, read from `app.bsky.feed.getPosts` keyed by the
  at-URI already stored in `post_targets.external_id`.
- **FR-051**: It MUST declare account metric keys for followers, follows and posts, read from
  `app.bsky.actor.getProfile` keyed by the DID already stored in
  `social_accounts.external_account_id`.
- **FR-052**: It MUST declare **no** views and **no** reach key, because the protocol has neither, so
  the panel shows them as absent and never as zero.
- **FR-053**: It MUST declare a maximum of 25 posts per call, the lexicon's own limit.
- **FR-054**: A count the platform omits for a post MUST be omitted from the snapshot, never defaulted
  to zero.
- **FR-055**: A requested post absent from the response MUST be reported as no longer returned by the
  platform for that target alone.
- **FR-056**: It MUST request no new permission and MUST use only the credential the account already
  holds for publishing and the inbox. No scope, consent screen or setting changes.
- **FR-057**: Platform failures MUST map through the provider's existing error helpers: a 429 to rate
  limited with the reset time the response states, a rejected session to invalid credentials, a 5xx or
  unreachable host to retryable, and anything else to fatal — with no token or credential in any
  message.
- **FR-058**: All of it MUST be tested with mocked HTTP only, and reported as verified with mocks only
  until the live checks are done.

#### The mock provider

- **FR-059**: The `mock` provider MUST gain an `insights` module that declares both post and account
  keys with their own labels, and serves scripted values from account settings, so the whole
  subsystem is testable with no platform credentials.
- **FR-060**: Its settings MUST be able to script, per account: each stop result in the vocabulary, an
  `unavailable` declaration, a post the platform no longer returns, a response omitting a declared
  key, a response holding an undeclared key, and an oversized payload.
- **FR-061**: It MUST be the fixture the scheduler and UI tests use, and a test MUST assert that the
  generic layer names no provider.

#### The performance panel

- **FR-062**: The post detail page MUST show, per target, a performance panel holding the latest
  snapshot for that target: each declared key the snapshot contains, with the platform's own label and
  the value as read.
- **FR-063**: The panel MUST state once what the numbers are "as of", rendered in the project's time
  zone like every other time in the product.
- **FR-064**: A declared key absent from the latest snapshot MUST render nothing at all — no row, no
  dash, no zero.
- **FR-065**: The panel MUST distinguish, in plain words, each of: not published yet; published by
  hand with no post to read; the platform cannot be read by Docket yet; the surface is declared
  unavailable (with the reason and a docs link); not polled yet (with when the first read is due);
  the platform reports nothing for this post; reads are failing (with since when and a plain reason);
  and the post is no longer on the platform.
- **FR-066**: When reads are failing but an earlier snapshot exists, the panel MUST show that snapshot
  with its own "as of" time alongside the failing notice, not instead of it.
- **FR-067**: The panel MUST NOT draw any chart, sparkline, trend, arrow, delta, total or comparison,
  and MUST NOT combine a number from one platform with a number from another in any way.
- **FR-068**: Numbers from different accounts MUST stay in their own account's panel, each labelled
  with that platform's own word.
- **FR-069**: The panel MUST be visible to anyone who can already view the post, add no new permission
  statement, and be reachable and readable by keyboard with the page's existing heading structure and
  the project's design system.
- **FR-070**: The panel MUST add no client-side interactivity, no polling from the browser and no new
  network call from the page.

#### Configuration, retention and housekeeping

- **FR-071**: `INSIGHTS_*` environment knobs MUST mirror the `ENGAGEMENT_*` block: read page size,
  targets per run, minimum poll interval, time share of the tick, read reserve, retention days and
  prune batch. Each MUST be validated at startup with its own range and default, and documented in
  `.env.example`.
- **FR-072**: Every default MUST be safe on a small install with no tuning: the section must do useful
  work out of the box without ever reaching the allowance reserve under ordinary load.
- **FR-073**: Snapshots older than the retention setting MUST be pruned by the existing housekeeping
  section in bounded batches, counting post and account snapshots separately in its counts.
- **FR-074**: Pruning MUST never delete a poll state, a target, a post or an account, and MUST leave a
  frozen target's state intact after its last snapshot is pruned.

#### Secrets, isolation and docs

- **FR-075**: No secret, token or credential may reach a snapshot payload, a poll state, a log line,
  an activity event, an error message or the rendered panel.
  `tests/integration/security/secret-scan.test.ts` MUST be extended to cover the poller and the panel,
  and nothing may be exempted from it.
- **FR-076**: A new `docs/insights.md` MUST describe what the feature does for a member, which
  platforms report what today, the snapshot-not-current-value rule, the "absent, never zero" rule, the
  decay schedule, retention, and what it deliberately does not do.
- **FR-077**: `docs/adding-a-provider.md` MUST gain the G30 row in its "Generic hooks index" and a
  worked section for the new member, naming the `mock` module as the one to read first, in the shape
  of its section 20.
- **FR-078**: `docs/decisions.md` MUST gain the G30 entry and every decision this spec records.
- **FR-079**: `docs/feature-map.md` MUST gain an entry for what shipped and a list of what is not yet
  owned by any spec.
- **FR-080**: `docs/limits.md` MUST gain a note row per platform that declares an insights read budget,
  stating the figure, its source or that it is interim and unverified, and where it is enforced, with
  the existing limits-inventory test staying green.
- **FR-081**: `docs/research/bluesky.md` MUST gain a section recording, with provenance, every metric
  field confirmed from the installed package (including the confirmed absence of any views or reach
  field and the 25-URI limit) and, marked unverified, whether the public AppView answers these queries
  without authentication and what the read limits are.
- **FR-082**: The constitution's and `docs/build-prompt.md`'s "analytics out of scope" lines MUST be
  amended to record that metric capture is now in scope and that charts, trends and comparisons are
  not.

### Key Entities

- **Insights declaration (on a provider)**: what one platform reports — the post metric keys and the
  account metric keys, each with that platform's own label; the provider's own schema for each stored
  payload; the maximum posts per call; the per-account read budget; and optionally the single reason,
  with a docs path, that the surface cannot be read on this install at all.
- **Post metric snapshot**: one reading of one published target's numbers at one moment —
  project, target, account, provider, captured-at, and the metrics as the platform reported them.
  Immutable, append-only, and the sole record of what a post's numbers were. Several per target.
- **Account metric snapshot**: the same for a connected account — project, account, provider,
  captured-at, metrics. Immutable, append-only, several per account.
- **Post poll state**: one row per eligible published target saying when it is next due, whether a
  tick holds it, how many reads in a row have failed, the last reason one did, when it was last
  polled and captured, and whether it is frozen and why (settled by age, or no longer on the
  platform).
- **Account poll state**: the same for a connected account's own numbers, without freezing.
- **Poll schedule**: not a stored thing but a named rule — the mapping from a post's age to its next
  reading, and the floor no configuration can cross.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member looking at a post published yesterday can tell, within one screen and with no
  clicks, how it is doing on each account it reached and exactly when those numbers were read.
- **SC-002**: For every number shown anywhere, a reader can say which platform's own word it is and
  which moment it describes; no number on any screen is an aggregate of two platforms.
- **SC-003**: No metric a platform does not report is ever rendered as a zero, a dash or a blank
  number — in any of the eight states the panel distinguishes.
- **SC-004**: One hundred per cent of the honest states (not published, published by hand, platform
  unreadable, declared unavailable, not polled yet, nothing reported, reads failing, no longer on the
  platform) are reachable in tests from the `mock` provider alone, with no platform credentials.
- **SC-005**: Across a run of one hundred ticks on an install with a full archive, no scheduled post
  is deferred, delayed or failed by insights polling, and the number of provider calls per account
  never exceeds the configured share of that account's allowance.
- **SC-006**: A post 28 days old or older receives no further provider call, and the captures made for
  one post over its whole life number at most **32** - 24 hourly in the first day, 6 daily to day 7,
  2 weekly to day 21 - verifiable by counting calls in a clock-pinned test that advances a single
  target from publication to day 40.
- **SC-007**: Reading a tick summary or a heartbeat, an operator can distinguish "nothing was due"
  from "the section ran out of time" without reading a log line.
- **SC-008**: Killing the worker at any point in the section leaves the database valid: no held lease
  outlives its expiry, no snapshot is half-written, no target's schedule advances without a capture,
  and the next tick resumes with no manual step.
- **SC-009**: Two ticks running at once produce exactly the snapshots one would, with no duplicate for
  the same subject and the same moment.
- **SC-010**: An install that never adds a Bluesky account, and never touches a setting, behaves
  exactly as it does today: no new table grows, no section does work, no error appears, and no screen
  changes except a panel that states plainly that Docket cannot read numbers from that platform yet.
- **SC-011**: The secret scan passes with the poller and the panel inside it, with no exemption added.
- **SC-012**: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm db:check` are all
  green, and the committed migration is the one `pnpm db:generate` produces.
- **SC-013**: A second platform can be added in a later entry by writing one provider folder and
  nothing else — provable by a test asserting that no file outside `src/providers/` names a provider
  key in any insights code path.

## Out of Scope

Each belongs to a named later entry, or to no entry yet.

- **Any OAuth scope change, any new permission, any consent screen, any reconnect flow.** Entry 2
  (`insights-reconnect-and-meta`) persists what a platform granted and adds the reconnect state.
- **Instagram, Facebook Pages and Threads metrics.** Entry 2.
- **TikTok and Pinterest metrics, and X's deliberate unavailable declaration**, with TikTok's
  public-post-id repair. Entry 3 (`insights-tiktok-pinterest-x`).
- **Any chart, sparkline, trend, delta, arrow, total, ranking or cross-platform comparison; account
  trends over time; performance by slot, day of week, series, voice profile or generated-vs-written;
  time-to-first-engagement; surfacing numbers on the overview or posts list; stating a sample size or
  refusing a conclusion from too few posts.** Entry 4 (`insights-schedule-intelligence`).
- **Any API operation, OpenAPI schema entry, MCP tool, webhook or export of a metric.** Entry 4.
- **Aggregating before pruning, so an aggregate outlives the row that produced it.** Entry 4; this
  entry prunes raw snapshots only, and its 400-day default is chosen so entry 4 has a year of history
  to aggregate from.
- **Story-aware polling** — a Story's insight dies with the Story inside 24 hours, so the generic
  decay is wrong for it. Entry 2, which owns the platform that has Stories.
- **Impressions-based call budgeting** for platforms whose limit is not a flat per-hour count.
  Entry 2.
- **Owned by no entry yet, recorded here as gaps**: Bluesky's `bookmarkCount` (present in the
  installed lexicon, absent from `docs/research/bluesky.md`, so not declared here); per-project or
  per-account control over whether polling happens at all; a manual "read the numbers now" action; a
  backfill of numbers from before a target was published; alerting on a post that outperforms or
  underperforms; showing a metric's own history on the post page; and reading metrics for a post
  Docket did not publish.

## Assumptions

- **The reader uses the credential the account already holds.** The roadmap's premise is that Bluesky
  needs no new permission; the authenticated session Docket already keeps for publishing and the inbox
  satisfies that premise and is the one path confirmed to work. Whether the public AppView would also
  answer anonymously is recorded as research owed (constraint 1) and changes nothing in this spec.
- **A declared read budget may be interim.** No platform read limit for these calls is verified
  anywhere, so the figure Bluesky declares is a conservative Docket choice, marked interim and
  unverified in `docs/limits.md` and revisable the moment the research lands. The design does not
  depend on the number being right, only on there being one.
- **Hourly is often enough for the first day.** Nobody is watching a like counter in Docket in real
  time; the panel's job is to say what happened, "as of" a stated moment. A manual refresh action is
  recorded as a gap rather than built.
- **Retention of 400 days is right for a self-hosted install.** Metric rows are small and the whole
  point is the history entry 4 compares; an operator who disagrees changes one setting.
- **Polling is on for every eligible account, with no per-project switch.** The allowance reserve,
  the per-run cap and the decay are what keep it safe, and a switch nobody needs is a setting to
  explain. Recorded as a gap in case an install does need it.
- **The panel is governed by `post: ["view"]`.** These are the brand's own published numbers, not a
  third party's personal data, so 077's reasoning for a new permission statement does not apply here.
- **Nothing here needs new infrastructure, a new dependency or a model call.** The work fits inside
  `runTick()` with the existing claim, lease, backoff, redaction and heartbeat machinery.
- **Every platform fact used is confirmed from the installed `@atproto/api` package** (both the
  generated types and its bundled lexicon definitions), which constitution I accepts, and each is
  recorded against `docs/research/bluesky.md` by FR-081 before the reader is built.

## Facts recorded against the research notes

Confirmed 2026-10-17 by reading `node_modules/@atproto/api` directly — the generated types under
`dist/client/types/app/bsky/` and the bundled lexicon `schemaDict` in `dist/client/lexicons.js`. These
MUST be written into `docs/research/bluesky.md` with that provenance (FR-081) before the reader is
built.

| Fact | Value | Source |
|---|---|---|
| `app.bsky.feed.getPosts` parameters | `uris: string[]`, required, lexicon `maxLength: 25` | `schemaDict.AppBskyFeedGetPosts` |
| `app.bsky.feed.getPosts` output | `posts: PostView[]` | same |
| `PostView` properties, in full | `uri, cid, author, record, embed, bookmarkCount, replyCount, repostCount, likeCount, quoteCount, indexedAt, viewer, labels, threadgate, debug` | `schemaDict.AppBskyFeedDefs.defs.postView`; `dist/client/types/app/bsky/feed/defs.d.ts` |
| The four counts in scope | `likeCount`, `repostCount`, `replyCount`, `quoteCount` — **all optional** | same |
| Views, impressions, reach on a post | **None exists.** No such property on `PostView` | same (confirmed negative) |
| `app.bsky.actor.getProfile` parameters | `actor` (handle or DID, `at-identifier`), required | `schemaDict.AppBskyActorGetProfile` |
| `app.bsky.actor.getProfile` output | `ProfileViewDetailed`, with optional `followersCount`, `followsCount`, `postsCount` | `schemaDict.AppBskyActorDefs.defs.profileViewDetailed` |
| Views or reach on a profile | **None exists** | same (confirmed negative) |
| Bluesky's external id in Docket | the post's at-URI, `at://did/app.bsky.feed.post/<rkey>` | `src/providers/bluesky/publish.ts:207`; `docs/research/bluesky.md` "Posting" |
| Bluesky's account external id in Docket | the account's DID | `src/providers/bluesky/session.ts:56` |
| Public AppView serves these unauthenticated | **UNVERIFIED** — not in the installed package, not in `docs/research/bluesky.md` | `NEEDS RESEARCH` |
| Read rate limits for these two queries | **UNVERIFIED** — the research file documents write points only and is explicitly silent on read limits | `docs/research/bluesky.md` "Rate limits"; `docs/research/engagement.md` §1 |

## Task ordering note for planning

The roadmap's rule, and `docs/decisions.md`'s standing lesson from 077: **park every task that needs a
live OAuth consent screen, a real platform account or a browser at the very end of the task list.** A
judgement task in an early phase starves the implement loop. This entry is deliberately designed to
have very few such tasks — it asks for no scope and no consent — but the live Bluesky verification
(confirming a real account's real post returns the counts this spec expects, and confirming whether
the public AppView answers anonymously) is exactly that kind of task and must be the last item,
after every mocked test, every doc and the panel.
