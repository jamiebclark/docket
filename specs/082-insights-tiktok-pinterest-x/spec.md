# Feature Specification: TikTok and Pinterest numbers, and a priced opt-in for X

**Feature Branch**: `082-insights-tiktok-pinterest-x`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "**TikTok**, under a `video.list` scope added through entry 2's `optionalScopes`: `/v2/video/query/` returns `like_count`, `comment_count`, `share_count` and `view_count` for videos it first verifies belong to the user, up to 20 ids per request — so the reader batches, and the poll claim must group by account. `user.info.stats` covers follower, likes and video counts. This entry also carries a **repair**: TikTok stores the wrong identifier for this purpose — `src/providers/tiktok/publish.ts:439` returns `externalId: s.publishId`, a publish_id which is not a video id, while the real `publicaly_available_post_id` is read at line 438 and only ever lands in `publish_attempts.response_summary`. Add a dedicated column for the public post id; recover it for existing targets from `publish_attempts.response_summary.publicPostIds` wherever attempt retention still holds it; write it going forward at publish time from the status fetch; and for targets where it is unrecoverable, show insights as unavailable for that post rather than guessing. **Pinterest**, under `pins:read`: `GET /v5/pins/{pin_id}/analytics` with its required `start_date`, `end_date` and `metric_types`, plus `/v5/user_account` for `follower_count` and `monthly_views` — which `user_accounts:read`, already held, covers. Pin analytics need a business account, and a Trial app's content is invisible to anyone else, so both become `unavailable` reasons with a docs link rather than a confusing empty panel. **X ships behind a priced opt-in, NOT as permanently unavailable.** `public_metrics` is reachable with the `tweet.read` scope already in `X_SCOPES`, so this was never a permission problem — and the cost objection in the first draft of this roadmap was computed at the wrong rate. Verified 2026-10-18 against https://docs.x.com/x-api/getting-started/pricing: **Owned Reads cost $0.001 per resource**, a fifth of the $0.005 standard Post read. At that rate 100 posts a month on entry 1's decay schedule (~33 polls per post over 28 days) is ~3,300 resources, about **$3.30 a month**, and X grants new accounts \"$20 in free X API credits when you save your first eligible payment card\". So build the reader, keep it **off by default**, and gate it on an explicit env opt-in whose docs state the per-read price and a worked monthly estimate. Keep the conservative floor interval and a hard per-cycle cap. With the opt-in off, declare `unavailable` with a reason naming the metered read, link `docs/x-setup.md`, and make no call. Two things stay UNVERIFIED and belong in a parked human task: whether `public_metrics` on an owned post bills as one resource per post, and whether `non_public_metrics` (impressions) is included at the owned rate. Update `docs/tiktok-setup.md`, `docs/pinterest-setup.md` and `docs/x-setup.md` with the extra permission each install must grant and what it gets for it. Does **not**: add charts, trends or comparisons, and does not expose anything over the API or MCP — both belong to entry 4." (section 3 of `.specify/roadmaps/social-insights.md`)

## Overview

080 built the insights spine — the `insights?` provider capability (G30), two append-only snapshot
tables, per-target and per-account poll state, a decaying read schedule, a bounded `runInsightsPoll`
tick section and one honest performance panel — and proved it on Bluesky. 081 added the machinery a
*permissioned* platform needs: `granted_scopes` on `social_accounts`, `optionalScopes` on a connect
group (G32), claim-level eligibility checked as SQL against the stored grant (G33), and expiring post
types (G34). It then read Instagram, Facebook Pages and (where research could confirm the metric
names) Threads.

This entry finishes the platforms. It is three readers and one repair, and it is the first entry where
Docket has to say "this costs money" out loud.

**TikTok** needs a permission (`video.list`) it does not request today, and — before any permission
matters — it needs an identifier it does not store. TikTok's published post is addressed by a **video
id**; what Docket keeps in `post_targets.external_id` is the `publish_id` from the Content Posting API
(`src/providers/tiktok/publish.ts:439`). The real public id *is* read at `publish.ts:438` and then
thrown into an attempt row (`publish_attempts.response_summary.publicPostIds`,
`src/server/db/schema/attempts.ts:45`) that retention eventually prunes. So TikTok insights have
nothing to query with, and the repair comes first: a dedicated column, a backfill from whatever
attempt rows survive, a write-forward at publish time, and — for the targets where the id is simply
gone or was never issued — an honest "Docket cannot read this post's numbers" rather than a guess
against the wrong id.

**Pinterest** needs `pins:read` for pin analytics, but *not* for account numbers: `/v5/user_account`
is covered by `user_accounts:read`, which every connected Pinterest account already granted. So
Pinterest's account numbers must start accruing the moment this ships, with no reconnect, while pin
analytics wait for the opt-in. Two Pinterest realities become stated reasons rather than an empty
panel: pinner (non-business) data access is refused by Pinterest with a documented 403, and a Trial
app's content is invisible to anyone but its own creator.

**X needs no new permission at all** — `public_metrics` is reachable with the `tweet.read` scope
already in `X_SCOPES` (`src/providers/x/config.ts:6`). What X needs is **consent to spend money**. The
first draft of this roadmap priced it at the standard Post read rate and concluded it was prohibitive;
that was the wrong rate. Docket reading the metrics of a post it published, on an account the operator
connected, is an **Owned Read** at **$0.001 per resource** (`docs/research/x.md` "Access and pricing",
re-verified 2026-10-18). On entry 1's decay schedule that is roughly **$3.30 a month for 100 posts**,
against a $20 promotional credit for a newly carded account. That is small, but it is not zero and it
is not Docket's money. So the reader ships **off by default** behind an explicit environment opt-in,
and the thing it defends against is not the unit price but a **runaway bill from a misconfigured
schedule**: a conservative floor interval and a hard per-account per-cycle ceiling, both enforced
through the allowance machinery that already exists.

The roadmap's standing rules govern all of it: **never sum or average a metric across platforms** (a
TikTok "view" is not an Instagram "view" is not a Pinterest "impression" — one column per platform,
labelled with that platform's own word, and a metric the platform does not report is **absent, never
zero**); **metrics are mutable, so store snapshots** and always say what a number is "as of"; every
provider call goes through the per-account allowance with its own reserve, so polling can never eat
the allowance a scheduled publish needs; no secret reaches a snapshot row, a log line or a response;
and an install that opts into nothing keeps working exactly as it does today.

## Context and sources

- **The roadmap this entry belongs to**: `.specify/roadmaps/social-insights.md` §3, read in full,
  including the preamble, "Behaviour on `main` that every entry builds on" and "Rules for every
  entry". Entry 1 (`specs/080-insights-core-bluesky/`) landed the spine; entry 2
  (`specs/081-insights-reconnect-and-meta/`) landed the grant and the Meta family; entry 4
  (`insights-schedule-intelligence`) owns every chart, trend, comparison, API operation and MCP tool.
- **Required reading done before specifying** (roadmap preamble): `docs/adding-a-provider.md` §18
  (TikTok), §19 (Pinterest), §20 (`engagement`), §21 (`insights`, including "Gated permissions and
  expiring post types", G33/G34) and the "Generic hooks index" — which runs to **G34**, so the first
  new generic change here is **G35**; `docs/engagement.md`; `docs/insights.md`; `docs/limits.md`
  (including the "note: insights read budget" row convention); and `docs/research/tiktok.md`,
  `docs/research/pinterest.md` and `docs/research/x.md` in full.
- **What `main` already provides, and must not be re-invented**: the poll claim already groups claimed
  targets by account and already batches each provider call at
  `min(INSIGHTS_READ_PAGE_SIZE, declaration.maxPostsPerRead)`
  (`src/server/scheduler/insights-poll.ts:106-112` and `:220-228`), so TikTok's 20-id cap is a
  declaration value, not new scheduler code. The per-account reserve
  (`src/server/scheduler/insights-budget.ts`), the eligibility decision shared by the panel, the
  accounts page and the claim's SQL (`src/lib/insights/eligibility.ts`,
  `tests/integration/insights/eligibility-matrix.test.ts`), the decay schedule
  (`src/lib/insights/schedule.ts`), the panel's state machine (`src/lib/insights/panel.ts`,
  `src/components/targets/PerformancePanel.tsx`) and the `INSIGHTS_*` knobs
  (`.env.example:202-237`) are all in place.
- **Facts that are verified** (constitution principle I): TikTok's token/callback grant recording
  (`src/providers/tiktok/connect-group.ts:55,93`), Pinterest's token reply carrying `scope`
  (`docs/research/pinterest.md` "OAuth"), Pinterest's `GET /v5/user_account` fields including
  `follower_count`, `monthly_views`, `pin_count`, `following_count` and `board_count`
  (`docs/research/pinterest.md:166-173`), Pinterest's `GET /v5/pins/{pin_id}/analytics` with required
  `start_date`, `end_date` and `metric_types` under `pins:read` (`docs/research/pinterest.md:226-228`),
  Pinterest's documented `PINNER_DATA_ACCESS_DENIED` 403 for non-business data access
  (`docs/research/pinterest.md:22-46`), Pinterest's Trial invisibility
  (`docs/research/pinterest.md:55-58`), Pinterest's `org_read` rate category
  (`docs/research/pinterest.md:287`), TikTok's `publicaly_available_post_id` being returned **only for
  a public and approved post** (`docs/research/tiktok.md:193-207`), and X's Owned Read price of
  $0.001 per resource with resources deduplicated per UTC day and a 3-million-Post-read per-cycle cap
  (`docs/research/x.md:19-41`).
- **Facts that are NOT yet in research and must be researched before they are coded** (constitution
  principle I; phases cannot fetch the web, so each is a research task with source URLs, and anything
  still unconfirmed ships as a declared `unavailable` surface in the Threads manner, never as a guess):
  1. **TikTok's `video.list` scope and `/v2/video/query/`** — the scope's own wording, the endpoint's
     request shape, its `fields` vocabulary (`like_count`, `comment_count`, `share_count`,
     `view_count`), the documented per-request id cap, its rate limit, and the `user.info.stats`
     field names for follower/likes/video counts. `docs/research/tiktok.md` documents scopes
     (`:46-56`) and the Content Posting API only; it contains no query or stats endpoint at all.
  2. **Pinterest's `metric_types` enum and the analytics response shape** — `docs/research/pinterest.md:226`
     gives only two example values (`VIDEO_MRC_VIEW`, `VIDEO_V50_WATCH_TIME`) and no response body.
  3. **X's metrics read** — the endpoint and parameters that return `public_metrics` for a known post
     id, its field names, its per-request id cap and its rate limit. `docs/research/x.md` prices owned
     reads but documents no metrics endpoint.
- **Decisions already recorded that constrain this entry**: `docs/decisions.md` G30-G34 and the 081
  entry's closing note, which names "repairing Facebook's stored external id for Reel targets" as
  owned by no entry — TikTok's equivalent repair **is** owned here, and the two must not be confused.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A published TikTok post has an identifier its numbers can be asked for (Priority: P1)

A member opens a TikTok post Docket published last week. Today the post detail page says the numbers
have not been read yet, and they never will be, because the id Docket stored is a `publish_id` — an
upload receipt, not a reference to the video. After this story, every TikTok target Docket publishes
carries the platform's **public post id** alongside the publish id; every older target recovers one if
the attempt row that saw it still exists; and a target whose public id cannot be recovered says so, on
the post, in plain words, instead of being polled forever against an id the platform will reject.

**Why this priority**: Nothing else about TikTok insights can work or even be tested until there is a
queryable identifier. It is also the only part of this entry that repairs stored data, so it ships
first and alone, and it is valuable on its own: it ends the silent loss of an id Docket already saw.

**Independent Test**: Publish a TikTok target through the mocked-HTTP publish path whose status fetch
returns `publicaly_available_post_id`, and confirm the id is stored on the target and shown nowhere it
should not be. Run the backfill against a target whose attempt row still holds `publicPostIds` and
confirm it recovers. Run it against a target with no surviving attempt row and confirm the post detail
page explains that this post's numbers cannot be read, with no poll attempt ever made.

**Acceptance Scenarios**:

1. **Given** a TikTok target being published whose status fetch returns `PUBLISH_COMPLETE` with a
   `publicaly_available_post_id`, **When** the publish completes, **Then** the target's external id is
   unchanged (still the publish id, so the external-id ledger and duplicate detection keep working)
   **and** the public post id is stored in its own column on the target.
2. **Given** a TikTok target published before this entry whose `publish_attempts.response_summary`
   still contains `publicPostIds`, **When** the migration's backfill runs, **Then** the first such id
   is stored on the target and the target becomes eligible for polling.
3. **Given** a TikTok target published before this entry whose attempt rows have been pruned, **When**
   the backfill runs, **Then** no id is invented, the target is frozen as unqueryable, the post detail
   page says Docket cannot read this post's numbers and why, and no provider call is ever made for it.
4. **Given** a TikTok target published by an unaudited install (`TIKTOK_APP_AUDITED` false, so the post
   is `SELF_ONLY` and TikTok issues no public post id at all), **When** the publish completes, **Then**
   the target is recorded as having no readable numbers for the same reason, and publishing is
   unaffected.
5. **Given** a TikTok target published by hand with no external id at all
   (`post_targets_published_has_id` permits it), **When** the poller runs, **Then** the target is
   skipped and counted as skipped, never failed.

---

### User Story 2 - TikTok numbers appear on the post that earned them (Priority: P1)

The operator turns on TikTok's insight permission, reconnects the account, and from then on each
published TikTok video's likes, comments, shares and views — in TikTok's own words — appear on its post
detail page with an "as of" time, on the decay schedule 080 established. The account's own follower,
likes and video counts are captured on their own interval. Before the reconnect, nothing is requested,
nothing is called, and the panel says which permission is missing and links the setup guide.

**Why this priority**: It is the entry's headline capability and the platform most likely to be the
reason a self-hoster installed Docket at all. It depends only on User Story 1.

**Independent Test**: With a mocked `/v2/video/query/` and the `video.list` scope recorded as granted,
run the poll tick over 25 claimed TikTok targets on one account and assert two provider calls of 20 and
5 ids, one snapshot row per target, and the panel rendering each metric under TikTok's own label.

**Acceptance Scenarios**:

1. **Given** `TIKTOK_INSIGHTS_SCOPES` is unset or false, **When** anyone connects TikTok, **Then** the
   authorization request asks for exactly the scopes it asks for today and nothing more.
2. **Given** the flag is on and an account reconnected and granted `video.list`, **When** the poll tick
   runs, **Then** the account's due targets are read, snapshots are written, and the panel shows each
   declared metric under TikTok's own label with an "as of" timestamp.
3. **Given** the flag is on but an account connected before it was turned on, **When** the poll tick
   runs, **Then** that account is never claimed, never leased, its credentials are never decrypted, no
   call is made, the accounts page offers a reconnect with the reason, and the post panel says the same.
4. **Given** 25 due targets on one account, **When** the tick reads them, **Then** no single provider
   call carries more than 20 ids, and the ids in each call all belong to that one account.
5. **Given** a response that omits a metric Docket declares, **When** the snapshot is written, **Then**
   that metric is absent from the panel entirely — no row, no dash, no zero.
6. **Given** two accounts on different platforms on the same post, **When** the panel renders, **Then**
   each platform's numbers appear in their own block under their own words, with nothing summed,
   averaged or compared.

---

### User Story 3 - Pinterest numbers, with the half that needs no permission arriving immediately (Priority: P2)

A Pinterest account connected months ago already granted `user_accounts:read`. So the moment this
ships, Docket starts capturing that account's follower count and monthly views on the account interval
— no reconnect, no flag, no action by anyone. Pin analytics are different: they need `pins:read`, which
no install requests today, so they wait behind the same opt-in-then-reconnect path as TikTok. And when
Pinterest refuses the read because the connected account is not a business account, or returns nothing
because the app is still on Trial access and its pins are invisible, the post says that in words a
person can act on, with a link to the setup guide.

**Why this priority**: It is the only platform in this entry where real value lands with no operator
action at all, and the account history it starts accruing is what entry 4 needs. It is P2 rather than
P1 because no screen displays account numbers yet (080's known gap).

**Independent Test**: With a mocked `/v5/user_account`, run the account poll for a Pinterest account
whose stored grant contains only today's three scopes, and assert a snapshot row with `follower_count`
and `monthly_views`. Separately, with `pins:read` absent, assert no pin analytics call is made and the
post panel names the missing permission.

**Acceptance Scenarios**:

1. **Given** a Pinterest account whose stored grant is `user_accounts:read`, `boards:read`,
   `pins:write`, **When** the account poll runs, **Then** an account snapshot is written and no pin
   analytics call is attempted.
2. **Given** the same account, **When** a member opens one of its published pins, **Then** the panel
   names the missing `pins:read` permission with a link to `docs/pinterest-setup.md`, and no call is
   made for that post.
3. **Given** `pins:read` granted and a pin analytics response, **When** the poll runs, **Then** a post
   snapshot is written containing only the metrics the response actually carried, each under
   Pinterest's own label.
4. **Given** Pinterest answers the analytics call with the documented `PINNER_DATA_ACCESS_DENIED` 403,
   **When** the poll handles it, **Then** the post panel states that Pinterest refuses pin data for
   this account and links the setup guide, the read is not treated as a credential failure, the account
   is not flagged, and the retry backs off rather than hammering.
5. **Given** an app still on Trial access, **When** analytics return nothing for a pin, **Then** the
   panel shows the honest "Pinterest reports no numbers for this pin, as of …" state, and the setup
   guide explains that Trial content is invisible to anyone else.

---

### User Story 4 - X is available, priced, and off until someone says yes (Priority: P2)

X insights are built and work, and they are switched off. A member looking at an X post sees that
Docket can read this post's numbers but that X charges per read, with the price and a link to the
setup guide; nothing is called and nothing is spent. An operator who decides it is worth a few dollars
a month sets one environment variable, restarts, and from then on X posts get their public metrics on
the same decaying schedule as everything else — inside a per-account per-cycle ceiling that cannot be
exceeded even if the schedule is misconfigured.

**Why this priority**: It converts a "no" in the first draft of the roadmap into a real capability,
and it is the only place in Docket where a feature spends the operator's money, so the consent and the
ceiling matter more than the reader. It is P2 because it is independent of the other two platforms.

**Independent Test**: With the opt-in unset, run the tick and assert zero X provider calls, zero
snapshot rows and a panel that names the metered read and links `docs/x-setup.md`. With the opt-in set
and a mocked metrics response, assert snapshots are written and that the per-cycle ceiling refuses
further reads for that account once reached, without failing anything.

**Acceptance Scenarios**:

1. **Given** the X insights opt-in is unset, **When** the poll tick runs, **Then** no X account or
   target is ever claimed or leased, no credentials are decrypted, no HTTP call is made, and the panel
   states that reading X numbers is a metered request Docket is not making, with a link to
   `docs/x-setup.md`.
2. **Given** the opt-in is set to true, **When** the poll tick runs for an account holding
   `tweet.read`, **Then** public metrics are read and snapshots written under X's own labels.
3. **Given** the opt-in is set but an account's stored grant does not include `tweet.read`, **When**
   the tick runs, **Then** that account is not claimed and the panel offers a reconnect with the reason.
4. **Given** the opt-in is set and this account has already used its per-cycle read ceiling, **When**
   the tick runs, **Then** the reads are deferred for allowance (not failed), the deferral is counted,
   and the next scheduled publish for that account is unaffected.
5. **Given** a misconfigured schedule that would poll far more often than the floor interval allows,
   **When** the tick runs, **Then** the floor interval and the per-cycle ceiling both still hold, and
   no combination of settings can make Docket read an account's metrics more often than the ceiling
   permits.
6. **Given** the opt-in is set and X answers 429, **When** the poll handles it, **Then** the read backs
   off to the time X names, no snapshot is written, and nothing in the stored error names a token or a
   credential.

---

### User Story 5 - An operator can find out what to grant and what it will cost (Priority: P3)

Someone setting up TikTok, Pinterest or X reads that platform's setup guide and finds: the extra
permission this install must request, the one environment variable that asks for it, what Docket can
read once it is granted, what still will not work and why — and for X, the price per read and a worked
monthly estimate for a realistic posting volume.

**Why this priority**: Without it, every capability above is undiscoverable; it is P3 only because the
software works without it.

**Independent Test**: Read `docs/tiktok-setup.md`, `docs/pinterest-setup.md` and `docs/x-setup.md` and
confirm each names its permission, its flag, what it buys, and (for X) the price and worked estimate;
the docs tests confirm every environment variable mentioned exists and every heading anchor Docket
links to resolves.

**Acceptance Scenarios**:

1. **Given** a fresh install, **When** the operator reads `docs/x-setup.md`, **Then** it states the
   $0.001-per-resource Owned Read price with its source and date, a worked monthly estimate, the
   promotional-credit note, the per-cycle ceiling Docket enforces, and that insights are off by default.
2. **Given** any of the three guides, **When** the operator follows it, **Then** the variable it names
   exists in `.env.example` with the same default, and the anchors Docket's in-app links point at
   resolve to real headings.

---

### User Story 6 - A renewed or narrowed grant does not go stale (Priority: P3)

An operator narrows a TikTok or Pinterest grant, or simply lets Docket refresh the token on its
schedule. What Docket believes about that account's permissions matches what the platform last
reported, so a surface is never called on the strength of a grant that no longer exists, and never
withheld from an account that has since granted it.

**Why this priority**: It closes a gap left by 081 — the grant is recorded at connect for these
providers but not at refresh — and it is small. It is P3 because the common path (reconnect) already
records the grant.

**Independent Test**: Refresh a TikTok and a Pinterest account with a mocked token reply whose `scope`
differs from the stored grant, and assert the stored grant now matches the reply; refresh with a reply
carrying no scope and assert the stored grant is left untouched.

**Acceptance Scenarios**:

1. **Given** a refresh reply whose scope list omits a previously granted insight scope, **When** the
   refresh completes, **Then** the stored grant is updated and the account's insight surfaces move to
   the "needs a reconnect" state without any call having been attempted.
2. **Given** a refresh reply that carries no scope field, **When** the refresh completes, **Then** the
   stored grant is left exactly as it was.

### Edge Cases

- **A TikTok target holds a public post id that TikTok no longer recognises** (the video was deleted):
  the read reports it gone, the target freezes with its last known numbers kept, and the panel says the
  post is no longer on TikTok. Not a failure.
- **A TikTok status fetch returns several public post ids** (the field is a list): the first is stored,
  the full list stays only in the attempt summary, and the choice is documented.
- **A TikTok photo post** (`publish_photos`): whether `/v2/video/query/` answers for it is unknown
  until research says. If it does not, such targets freeze as unqueryable with a reason, never retried.
- **The backfill finds an id on a target that already has one**: the stored value wins; the backfill is
  idempotent and safe to run twice.
- **A backfilled id is malformed or absurdly long**: it is rejected rather than stored, and the target
  is treated as having none.
- **A Pinterest pin analytics window** needs `start_date` and `end_date`: the window is derived from the
  target's publication date and the read time in UTC, is never in the future, and never asks for a span
  the platform refuses. The rule is a pure, unit-tested function with no clock read inside it.
- **Pinterest returns a metric Docket does not declare**: it is dropped, exactly as 080 already filters
  to declared keys.
- **A Pinterest account whose token reply never carried a scope list**: the stored grant is null, so pin
  analytics stay in the "needs a reconnect" state and nothing is called. Docket never infers a grant it
  did not observe. Account numbers still work, because they need no scope Docket has to check.
- **X's resources are deduplicated per UTC day**: two reads of the same post in one UTC day may bill
  once, which makes the ceiling conservative rather than wrong. The dedup is not relied on.
- **X's opt-in is turned off again after snapshots exist**: existing snapshots stay, the panel keeps
  showing the last one with its "as of" time, no further call is made, and nothing errors.
- **A platform surface is declared unavailable at run time** (the X opt-in off, a Pinterest 403): the
  reason reaches the post panel rather than only the poll state, so the member sees why there are no
  numbers instead of an indefinite "not read yet".
- **An account is removed or goes inactive mid-cycle**: its poll states stop being claimed, exactly as
  080 defined; its snapshots are untouched.
- **The tick runs out of time in the middle of a batched TikTok read**: claimed-but-unread targets are
  released with their leases cleared, the section counts itself out of budget, and the next tick picks
  them up. No partial batch is written as if complete.
- **Two ticks run concurrently**: no target or account is read twice, because the claim takes the lease
  with `FOR UPDATE SKIP LOCKED` exactly as 080 and 081 do.
- **The poll's reserve is exhausted by publishing**: reads defer, publishing wins, and the deferral is
  counted. Reading never consumes the allowance a scheduled publish needs.
- **A provider response contains a token, a signed URL or an upload address**: nothing from a response
  reaches a snapshot row or an error message except declared metric keys and value-free text.

## Requirements *(mandatory)*

### Functional Requirements

#### Research before code (constitution principle I)

- **FR-001**: `docs/research/tiktok.md` MUST be extended, before any TikTok reader is written, with the
  `video.list` scope's own documented wording, the video-query endpoint's request and response shape,
  the exact metric field names, the documented maximum ids per request, its rate limit, and the
  `user.info.stats` field names — each with a source URL and the date it was read.
- **FR-002**: `docs/research/pinterest.md` MUST be extended, before the pin analytics reader is
  written, with the confirmed `metric_types` vocabulary and the analytics response shape, with source
  URLs and dates.
- **FR-003**: `docs/research/x.md` MUST be extended, before the X reader is written, with the endpoint
  and parameters that return a post's `public_metrics`, the metric field names, the maximum post ids
  per request and the endpoint's rate limit, with source URLs and dates.
- **FR-004**: Where a metric name, field or endpoint cannot be confirmed from an official source, the
  provider MUST declare that surface `unavailable` with a reason naming what is unconfirmed and a docs
  link — the posture `src/providers/threads/insights.ts` already sets — and MUST NOT declare, request
  or guess it. A surface declared unavailable is never claimed and never called.

#### The TikTok identifier repair

- **FR-005**: `post_targets` MUST gain a dedicated, nullable column for the platform's public post id,
  distinct from `external_id`, shipped as a committed migration generated by `pnpm db:generate` with
  `pnpm db:check` green.
- **FR-006**: `post_targets.external_id` for TikTok MUST keep holding the publish id, so the
  external-id ledger, duplicate detection, `external_url` and every existing behaviour are unchanged.
- **FR-007**: At publish time, when TikTok's status fetch reports `PUBLISH_COMPLETE` with a
  `publicaly_available_post_id`, the first id in that list MUST be persisted to the new column on the
  target, through the generic publish path rather than a TikTok-specific write.
- **FR-008**: The migration MUST backfill the new column for existing TikTok targets from
  `publish_attempts.response_summary.publicPostIds`, taking the first id of the most recent attempt row
  that carries one, and MUST leave the column null where no attempt row survives.
- **FR-009**: The backfill MUST be idempotent (never overwrite a value already present) and MUST reject
  a value that is not a plausible id rather than store it.
- **FR-010**: A TikTok target with no public post id MUST be frozen as unqueryable with a stated
  reason, MUST never be claimed for a read, and MUST show on the post detail page as "Docket cannot
  read this post's numbers", never as a failure, an error or an empty panel.
- **FR-011**: Publishing MUST be unaffected by every part of this repair: no publish path gains a
  precondition on the new column, and a target that never receives a public post id publishes exactly
  as it does today.
- **FR-012**: An unaudited install (`TIKTOK_APP_AUDITED` false) publishes `SELF_ONLY`, for which TikTok
  issues no public post id. Such targets MUST reach the FR-010 state, and `docs/tiktok-setup.md` MUST
  say so where it already explains the audit.
- **FR-013**: No value written to or read from the new column may be a credential, a token or a signed
  address, and `tests/integration/security/secret-scan.test.ts` MUST be extended to cover the new
  column and the new snapshot payloads rather than exempting them.
- **FR-014**: A published target with no external id at all MUST continue to be skipped and counted,
  never failed — `post_targets_published_has_id` (`src/server/db/schema/posts.ts:269`) permits it.

#### Generic provider-contract changes

- **FR-015**: The insights declaration MUST be able to say **which stored identifier** a provider's
  post reader needs — the target's external id, or the public post id of FR-005. The post claim MUST
  require that identifier to be present as part of its own SQL predicate, so a target lacking it is
  never claimed, never leased and never decrypted for; and the lazy insert MUST freeze such a target as
  unqueryable with no call spent. This is generic change **G35** and MUST be recorded as a new row in
  the "Generic hooks index" of `docs/adding-a-provider.md` (§21) and as an entry in `docs/decisions.md`
  with its reversal.
- **FR-016**: The publish step's successful result MUST be able to carry the platform's public post id
  alongside the external id and url it already carries, and the generic publish path MUST persist it.
  No scheduler or engine code may name TikTok. This is generic change **G36**, recorded in the same two
  places.
- **FR-017**: The insights declaration MUST be able to require **different permissions for post reads
  than for account reads**, because Pinterest's account numbers need only a scope every install already
  holds while its pin numbers need a new one. The post claim and the account claim MUST each check
  their own set in SQL; the post panel MUST reflect the post set; and the accounts page MUST name which
  surface is waiting on what. This is generic change **G37**, recorded in the same two places.
- **FR-018**: `src/providers/**` MUST NOT import from `src/server/**` (the existing lint test), and no
  generic layer may branch on a provider key. Every platform specific in this entry MUST arrive as a
  declaration value or a provider-owned function.

#### The TikTok reader

- **FR-019**: TikTok's connect group MUST declare the insight scope as an optional scope with its
  purpose, requested only when a new environment flag (default off) is set, following the shape
  `src/providers/meta/connect-group.ts` established (G32). With the flag off, the authorization request
  MUST be byte-for-byte what it is today.
- **FR-020**: TikTok's insights declaration MUST require the insight scope for post reads and for
  account reads, so an account that has not granted it is never claimed, leased, decrypted or called —
  the check happening inside the claim's SQL (G33), not inside the reader.
- **FR-021**: TikTok's declaration MUST state the platform's documented maximum ids per request as
  `maxPostsPerRead`, so the existing batching at `src/server/scheduler/insights-poll.ts:220` splits a
  larger claim without new scheduler code, and every id in a call MUST belong to the one account that
  call is made for.
- **FR-022**: The TikTok post reader MUST return, per id, either the metrics the response carried, or
  gone, or unqueryable with a reason — and MUST NOT invent an entry for an id the response omitted.
- **FR-023**: The TikTok account reader MUST capture the account's own counts (followers, likes, videos)
  from the documented stats surface, under TikTok's own field names and labels.
- **FR-024**: Every TikTok metric MUST be stored under TikTok's own field name and rendered under
  TikTok's own label; a declared metric a response omitted MUST be absent from the panel — no row, no
  dash, no zero.
- **FR-025**: Every TikTok failure MUST map to one of the existing result kinds (retryable, rate
  limited, credentials invalid, fatal, unavailable); the reader MUST NOT throw and MUST NOT invent a
  new error vocabulary.
- **FR-026**: TikTok's read budget MUST be declared and MUST appear as a `note: insights read budget`
  row in `docs/limits.md` with its source (or an explicit `interim, UNVERIFIED` label and the decision
  that introduced it), its enforcement point and its test, as Instagram's and Facebook's already do.

#### The Pinterest reader

- **FR-027**: Pinterest's connect group MUST declare `pins:read` as an optional scope with its purpose,
  requested only when a new environment flag (default off) is set. With the flag off, the authorization
  request MUST be exactly what it is today.
- **FR-028**: Pinterest's insights declaration MUST require `pins:read` for **post** reads only.
  Account reads MUST require no scope beyond `user_accounts:read`, which every connected Pinterest
  account already granted, so account snapshots begin accruing with no reconnect and no flag (FR-017).
- **FR-029**: The Pinterest account reader MUST capture `follower_count` and `monthly_views` from
  `/v5/user_account`, under Pinterest's own names and labels, and MUST omit any field the response did
  not carry.
- **FR-030**: The Pinterest post reader MUST call pin analytics with the required `start_date`,
  `end_date` and `metric_types`, where the date window is computed by a pure, unit-tested function from
  the target's publication date and the read time in UTC, never reaching into the future and never
  reading a clock inside itself.
- **FR-031**: A documented `PINNER_DATA_ACCESS_DENIED` refusal MUST be surfaced as an unavailable
  surface with a reason naming the business-account requirement and a link to
  `docs/pinterest-setup.md`; it MUST NOT be treated as invalid credentials, MUST NOT flag the account,
  and MUST back off rather than retry tightly.
- **FR-032**: Trial-access invisibility MUST be explained in `docs/pinterest-setup.md` and MUST NOT be
  presented as an error: a pin for which analytics return nothing renders the existing "reports no
  numbers … as of" state.
- **FR-033**: Pinterest's read budget MUST be declared consistently with the `org_read` rate category
  recorded in research, and MUST appear as a `note: insights read budget` row in `docs/limits.md` with
  its source, enforcement point and test.
- **FR-034**: Pinterest metric keys MUST be stored and rendered under Pinterest's own words, with a
  metric the response omitted absent rather than zero, and MUST never be combined with another
  platform's metric of a similar name.
- **FR-035**: A Pinterest account with no recorded grant MUST leave pin analytics in the needs-a-
  reconnect state with no call attempted; Docket MUST NOT infer a grant it did not observe.

#### X: a priced opt-in

- **FR-036**: X's insights reader MUST be built and MUST be **off by default**, gated on an explicit
  environment opt-in (default false) documented in `.env.example` and `docs/x-setup.md`.
- **FR-037**: With the opt-in off, X's insights declaration MUST be `unavailable` with a reason that
  names the metered read and links `docs/x-setup.md`; no X account or target may be claimed, leased,
  decrypted or called, and no snapshot row may be written.
- **FR-038**: X MUST NOT request any new OAuth scope: `public_metrics` is reachable with the
  `tweet.read` scope already in `X_SCOPES` (`src/providers/x/config.ts:6`). The declaration MUST
  require `tweet.read` so an account whose recorded grant lacks it is never called.
- **FR-039**: With the opt-in on, X reads MUST be bounded by **both** the existing floor interval
  (`INSIGHTS_POLL_MIN_INTERVAL_SECONDS`) and a **hard per-account per-cycle read ceiling**, declared as
  the provider's read budget over a 30-day window (X's billing cycle is monthly) so the existing
  allowance machinery (`src/server/scheduler/insights-budget.ts`) enforces it with no new enforcement
  path. The ceiling MUST be configurable by environment variable, with a default low enough that an
  operator who turns the opt-in on without reading anything else cannot be surprised by the bill.
- **FR-040**: Reaching the ceiling MUST defer reads for allowance and be counted as such — never fail a
  target, never flag an account, and never consume the half of the allowance reserved for publishing.
- **FR-041**: `docs/x-setup.md` MUST state the Owned Read price of $0.001 per resource with its source
  URL and the date it was verified, a worked monthly estimate at a realistic posting volume, the
  promotional-credit note, the default ceiling and the dollar figure that ceiling implies per account
  per cycle, and that insights are off until the operator turns them on.
- **FR-042**: The X post reader MUST read only posts Docket published on accounts the operator
  connected (an Owned Read), MUST batch within the endpoint's documented id cap, and MUST map every
  failure to an existing result kind — with 429 backing off to the time X names.
- **FR-043**: X's account numbers MUST be captured only if research confirms a surface for them at the
  owned rate; otherwise the account surface is declared unavailable with that reason (FR-004).
- **FR-044**: `non_public_metrics` (impressions) MUST NOT be requested in this entry: whether it is
  included at the owned rate is unverified (see the parked tasks), and an unverified billing assumption
  is not allowed to spend the operator's money.
- **FR-045**: X's read budget and ceiling MUST appear in `docs/limits.md` as a `note: insights read
  budget` row with source, enforcement point and test, alongside a note of the per-cycle Post-read cap
  research records.
- **FR-046**: No X error message, snapshot row or log line may contain a token, a bearer header or any
  part of a credential.

#### Rules that hold across all three platforms

- **FR-047**: No metric may be summed, averaged or otherwise combined across platforms, anywhere in the
  data layer or the UI. Each platform's numbers appear in their own block, under that platform's own
  words.
- **FR-048**: Every reading MUST be stored as an append-only snapshot `(subject, captured_at, metrics)`
  through the existing DAL; no current value may be overwritten, and every number shown MUST carry the
  time it was captured.
- **FR-049**: Every provider call MUST pass the per-account allowance check with the insights reserve
  before it is made, so polling can never consume the allowance a scheduled publish needs.
- **FR-050**: A surface that reports itself unavailable **at run time** (the X opt-in off, a Pinterest
  403) MUST reach the post detail panel as a stated reason with its docs link, not merely a poll-state
  field — a member must never see an indefinite "not read yet" for a surface Docket knows it cannot
  read.
- **FR-051**: All three readers MUST be tested with mocked HTTP only, including their rate-limited,
  credential-invalid, unavailable, gone and unqueryable paths; no test may make a live call.
- **FR-052**: `src/providers/mock/insights.ts` MUST be able to script every new shape this entry
  introduces (an identifier requirement, a per-surface permission split, a run-time unavailable), so
  the whole subsystem stays testable with no platform credentials.
- **FR-053**: The tick section's counts MUST cover the new outcomes (targets skipped for a missing
  public post id, reads deferred for the X ceiling) so a section that silently does nothing is visible
  in its heartbeat rather than invisible.
- **FR-054**: `tests/integration/security/secret-scan.test.ts` MUST be extended to the new column, the
  three providers' snapshot payloads and their error strings. Nothing may be exempted from it.
- **FR-055**: An install that sets none of the new flags MUST behave exactly as it does today: no new
  scope requested, no call attempted, no account state that blocks publishing, no error anywhere — with
  the single intended exception of Pinterest account snapshots, which need no permission and begin
  accruing silently.

#### Keeping the recorded grant current

- **FR-056**: TikTok's and Pinterest's credential refresh MUST record the scope list the refresh reply
  carries, so the stored grant reflects what the platform last reported (G31 already allows it; the two
  providers' refresh paths do not yet use it).
- **FR-057**: A refresh reply that carries no scope list MUST leave the stored grant unchanged.

#### Documentation and migrations

- **FR-058**: `docs/tiktok-setup.md`, `docs/pinterest-setup.md` and `docs/x-setup.md` MUST each state
  the extra permission (or opt-in) this install must grant, the environment variable that asks for it,
  what Docket can read once granted, and what still will not work and why.
- **FR-059**: `docs/insights.md` MUST be updated: the supported-platforms table gains TikTok, Pinterest
  and X with their permissions and honest gaps, and the named-gaps section gains this entry's gaps
  (unrecoverable TikTok ids, anything research could not confirm, X's unverified billing questions).
- **FR-060**: `docs/adding-a-provider.md` MUST record G35, G36 and G37 in the "Generic hooks index" and
  explain each in §21, and `docs/decisions.md` MUST carry one entry per change with its reversal.
- **FR-061**: `docs/limits.md` MUST gain the three read-budget rows (FR-026, FR-033, FR-045), and its
  inventory test MUST stay green.
- **FR-062**: `.env.example` MUST document every new variable with its default, and the startup
  environment validation MUST reject an invalid value with a reason that names the variable and never
  its value.
- **FR-063**: Schema changes MUST ship as a single committed migration from `pnpm db:generate` with
  `pnpm db:check` green, and the backfill MUST ship inside it.
- **FR-064**: `docs/feature-map.md` MUST be updated for what this entry adds.
- **FR-065**: The repo MUST be left working: lint, typecheck, the test suite, `pnpm db:check` and the
  build all green on the final pass.

### Key Entities

- **Post public id (new column on an existing entity)**: the platform's own identifier for a published
  post, where that differs from the id the publish API returned. Nullable; TikTok is the only provider
  that sets it in this entry; null means "this post's numbers cannot be read", never "zero".
- **Post metric snapshot** (existing, from 080): one append-only reading of one target's numbers at one
  time, with the provider key and the provider-validated metric object. Gains rows for three more
  platforms; its shape does not change.
- **Account metric snapshot** (existing, from 080): the same for a connected account. Pinterest begins
  writing these with no reconnect.
- **Post metric poll state** (existing, from 080): when a target is next due, its lease, its failure
  count and its frozen reason. Gains the unqueryable-for-want-of-a-public-id case.
- **Insights declaration** (existing contract, from 080/081): per provider, the metric keys for a post
  and for an account, the batch cap, the read budget, any unavailable reason, the scopes required —
  now split post-from-account — and which stored identifier the post reader needs.
- **Granted scopes** (existing, from 081): what a platform last reported it granted for an account; now
  also updated at refresh for TikTok and Pinterest.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every TikTok post Docket publishes after this entry has a stored identifier its numbers
  can be requested with — 100% of newly published TikTok targets whose platform issued a public post
  id, measured by the publish-path tests.
- **SC-002**: For TikTok targets published before this entry, 100% of those whose attempt history still
  records a public post id recover one, and 0% of the remainder are assigned a guessed id.
- **SC-003**: A member looking at any published post on any of the three platforms always sees one of a
  closed set of honest states — numbers with an "as of" time, "reports no numbers", "cannot be read and
  why", "needs a permission and how to grant it", or "not read yet, next read due at" — and never an
  empty panel, a zero Docket invented, or a silent absence.
- **SC-004**: An install that turns on no new flag makes zero additional platform requests and shows
  zero new errors, verified by asserting no HTTP call for TikTok, Pinterest pin analytics or X in a
  full tick run.
- **SC-005**: With the X opt-in off, zero X requests are made and zero cost is incurred; with it on,
  no account can exceed its configured per-cycle read ceiling under any schedule configuration,
  verified by driving the tick past the ceiling and asserting deferral rather than further reads.
- **SC-006**: A TikTok account with 25 or more due targets is read in calls of no more than the
  platform's documented id cap, with every id in a call belonging to that one account — verified by
  asserting the exact call count and payloads.
- **SC-007**: Reading never delays publishing: in a tick where an account's allowance is nearly spent,
  the scheduled publish proceeds and the reads defer, verified by a test that asserts both outcomes in
  the same tick.
- **SC-008**: No secret, token or credential appears in any snapshot row, stored error, log line or API
  response, verified by the extended secret scan over all three platforms' payloads.
- **SC-009**: Every metric rendered is labelled with the platform's own word, and no screen or query
  sums or averages across platforms — verified by a test over the rendered panel for a post with
  targets on three platforms at once.
- **SC-010**: Each of the three setup guides lets an operator go from "insights unavailable" to numbers
  on a post by following it, with every variable it names present in `.env.example` and every anchor it
  links resolving; the X guide states the price, the worked monthly estimate and the ceiling's dollar
  value.
- **SC-011**: Every unverified fact this entry touches is either confirmed in a research file with a
  source URL and a date, or visibly declared unavailable with that reason — zero facts are coded from
  memory or assumption.
- **SC-012**: The repo is green on the final pass (lint, typecheck, tests, `pnpm db:check`, build), and
  `pnpm db:check` confirms the committed migration matches the schema.

## Assumptions

- **Entry 2's machinery is on `main` and is used as is**: `granted_scopes` on `social_accounts`,
  `optionalScopes` on a connect group (G32), claim-level scope eligibility (G33) and the shared
  eligibility decision (`src/lib/insights/eligibility.ts`). This entry adds no second mechanism for
  any of it.
- **Entry 1's schedule, snapshot tables, tick section, reserve and panel are reused unchanged** except
  where a requirement here names a change. In particular the decay schedule is not re-tuned per
  platform, and the poll claim's existing per-account grouping and batching satisfy TikTok's batch
  requirement without new scheduler code.
- **One environment flag per connect group**, in the shape 081 established (`META_INSIGHTS_SCOPES`,
  `THREADS_INSIGHTS_SCOPES`), named consistently for TikTok and Pinterest; X's flag gates a *reader*
  rather than a scope, because X needs no new scope, so it is named for what it enables rather than for
  a scope request.
- **X's per-cycle ceiling is expressed as the provider's declared read budget over a cycle-length
  window**, because `stricterBudget` compares rates and the existing reserve check already counts
  snapshots in a window — so a monthly ceiling needs no new enforcement path. Half of it is reserved
  for publishing, which makes the realised ceiling conservative; the docs state the realised figure,
  not the nominal one.
- **TikTok's public post id is taken as the first element of `publicaly_available_post_id`.** The field
  is documented as a list; Docket publishes one video or one photo set per target, so the first id is
  the post. The full list remains in the attempt summary.
- **Pinterest's analytics date window** is derived from the target's publication date to the read date
  in UTC. Pinterest's analytics are day-grained, so a day-resolution window is the correct unit; the
  exact maximum span allowed is a research item (FR-002) and the window is clamped to whatever it says.
- **Account metric snapshots remain displayed nowhere** — that is 080's deliberate gap, and entry 4
  owns the screen. Pinterest account capture is still worth shipping now so entry 4 inherits history.
- **Attempt retention limits the backfill.** `publish_attempts` are pruned by the existing housekeeping
  retention, so an unknown fraction of older TikTok targets is unrecoverable. The spec requires honesty
  about them, not recovery of them.
- **No live platform call happens in any phase.** Everything is proved with mocked HTTP; the facts that
  genuinely need a live call are parked (below) and the features that depend on them are declared
  unavailable until the answers land.

## Parked human tasks (live account, consent screen or funded key)

These need a live OAuth consent screen, a real platform account or a funded API key, so every one of
them belongs at the **very end** of the task list — a judgement task in an early phase starves the
implement loop (roadmap "Rules for every entry").

- **X billing, question 1**: does `public_metrics` on a post the app itself published bill as one
  resource per post at the Owned Read rate of $0.001? Needs one live call against a funded key, read
  off the developer console's usage. Record the answer in `docs/research/x.md` with the source URL and
  the date.
- **X billing, question 2**: is `non_public_metrics` (impressions) included at the owned rate, or billed
  as a standard read? Same method, same recording. Until answered, FR-044 forbids requesting it.
- **TikTok consent**: confirm on a live consent screen that `video.list` appears as a separate
  permission a user can decline, and that declining it leaves posting working.
- **Pinterest grant reporting**: confirm on a live connect that the token reply's `scope` carries
  `pins:read` when granted, since the stored grant is the only thing that makes pin analytics eligible.
- **Pinterest business/Trial reality**: confirm the `PINNER_DATA_ACCESS_DENIED` body and whether a Trial
  app's own pins return analytics to their own creator.

## What this entry does NOT do, and which entry owns it

- **No chart, trend, delta, sparkline or comparison of any kind**, and no second snapshot shown beside
  the first. The panel keeps showing exactly one latest reading per target. Entry 4
  (`insights-schedule-intelligence`) owns every derived view.
- **No API operation and no MCP tool.** Nothing from this entry is exposed over REST, the OpenAPI
  document or MCP. Entry 4 owns the single insights operation and its `mcp.expose` decision.
- **No screen for account numbers.** Account snapshots accrue for all platforms and are displayed
  nowhere, as in 080 and 081. Entry 4 owns account trends.
- **No cross-platform totals, ever** — not in this entry and not in entry 4; the rule is permanent.
- **No manual "refresh now" action**, no per-project on/off switch, and no change to the decay
  schedule. 080 owns those decisions.
- **No `non_public_metrics` for X** (FR-044) until the parked billing questions are answered; the entry
  that acts on those answers is whichever one picks up the parked task, not this one.
- **No repair of Facebook's stored external id for Reel targets.** 081 recorded that gap as owned by no
  entry, and it stays that way; this entry repairs TikTok's identifier only.
- **No Threads metric upgrade.** Threads remains declared unavailable pending the research 081 parked;
  that gap belongs to whoever resolves it, not here.
- **No new TikTok public post URL.** The new column makes a post URL constructible, but building or
  backfilling `external_url` is not in scope; nothing in the UI changes except the performance panel's
  states.
- **No video, reels or stories work beyond what already exists**, and no change to any publish path
  other than persisting the public post id (FR-007).
