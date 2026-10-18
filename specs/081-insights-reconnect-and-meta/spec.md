# Feature Specification: Persist what a platform granted, then read Instagram, Facebook Page and Threads numbers

**Feature Branch**: `081-insights-reconnect-and-meta`

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description: "Two halves, in this order, because the second cannot be enabled without the first. **Persist the grant.** Add a `granted_scopes` column to `social_accounts` … written at connect and at every refresh for each OAuth provider, and an `optionalScopes` declaration on the provider so an insight permission is requested only where the operator wants it rather than widening every new connection silently. Then the accounts page gains a real state: 'Insights need a reconnect' … **Then the three readers**, all on the Graph API the publish path already uses: Instagram under `instagram_manage_insights`; Facebook Pages under `read_insights`; Threads under `threads_manage_insights`. Two platform specifics the generic schedule gets wrong: **stories expire**, and **Meta's call limit is impressions-based**. Extend `docs/research/meta.md` with every metric name, its required scope and the 24-48h processing delay, each with a source URL, **before** implementing. Does **not**: TikTok, Pinterest or X (entry 3); any chart, trend or cross-platform comparison (entry 4)." (section 2 of `.specify/roadmaps/social-insights.md`)

## Overview

080 built the whole insights spine — a declared provider capability (G30), two append-only snapshot
tables, per-target and per-account poll state, a decaying schedule, a bounded `runInsightsPoll`
section and one honest panel — and proved it on Bluesky, the one platform that needs no permission.
Every other platform does need one, and Docket cannot currently answer the question that decides
whether a reader may run: **what did this account actually grant?** `social_accounts` has no column
for it (`src/server/db/schema/accounts.ts:24-52`); what a platform granted is inspected once at
connect and thrown away into free-text notes (`src/providers/x/connect-group.ts:72-74`).

So this entry is two halves, strictly in order.

**First, persist the grant.** A `granted_scopes` column written at connect and at every refresh for
every OAuth provider that reports one; an `optionalScopes` declaration so an insight permission is
asked for only where the operator has turned it on, never by silently widening every new connection;
and an honest account state — *"Insights need a reconnect"* — carrying the per-provider reason and a
docs link, through the same `unavailable { reason, docsPath }` convention 077 and 080 already use, so
a declared-but-unpermissioned surface is **displayed and never called**.

**Then the three readers**, on the Graph API the publish path already uses: Instagram under
`instagram_manage_insights`, Facebook Pages under `read_insights`, Threads under
`threads_manage_insights`. Two things the generic schedule gets wrong for them: **stories expire**, so
a story target must be read inside its 24-hour window and then frozen, because the insight dies with
the story; and **Meta's call limit is impressions-based**, not a flat count per hour, so the budget
must respect the live usage signal Meta returns rather than a number Docket made up.

The two rules the whole roadmap turns on are unchanged and are re-stated here because this is the
first entry where more than one platform exists: **never sum or average a metric across platforms** —
an Instagram "view", a Threads "view" and a Facebook "impression" are different events and Bluesky has
none, so one column per platform, labelled with that platform's own word, and a metric the platform
does not provide is **absent, never zero** — and **metrics are mutable, so store snapshots**, never a
single overwritten current value, with the UI always saying what a number is "as of".

The safety property that governs everything here: **an install that never reconnects keeps working
exactly as it does today.** No new scope is requested, no call is attempted, no account changes state
in a way that blocks publishing, and nothing anywhere reports an error. Insights are simply absent for
that account, with a reason a person can act on if they want to.

## Context and sources

- **The roadmap this entry belongs to**: `.specify/roadmaps/social-insights.md` §2, read in full,
  including the preamble, "Behaviour on `main` that every entry builds on" and "Rules for every
  entry". Entry 1 (`insights-core-bluesky`, `specs/080-insights-core-bluesky/`) landed everything
  this entry extends. Entry 3 (`insights-tiktok-pinterest-x`) consumes this entry's `optionalScopes`
  machinery for TikTok's `video.list` and Pinterest's `pins:read`, and ships X declared unavailable.
  Entry 4 (`insights-schedule-intelligence`) owns every chart, trend, comparison, API operation and
  MCP tool.
- **Required reading done before specifying** (roadmap preamble): `docs/adding-a-provider.md`
  §18–§21 and the "Generic hooks index" (which runs to **G30**), `docs/engagement.md`,
  `docs/insights.md`, `docs/limits.md` and `docs/research/meta.md` in full.
- **What 080 landed that this entry builds on, and must not break**:
  - `src/providers/types.ts:595-660` — `InsightsDeclaration` (`post`, `account`,
    `maxPostsPerRead`, `readBudget`, `unavailable`), `MetricKeyDeclaration` (`{ key, label }`),
    `PostMetricsReadResult` / `AccountMetricsReadResult` (`page` / `retryable_error` /
    `fatal_error` / `credentials_invalid` / `rate_limited` / `unavailable`), `PostMetricEntry`
    (`metrics` | `gone`), and `insights?: InsightsSupport<Settings>` on `SocialProvider` (line 694).
  - `src/server/db/schema/insights.ts` — `post_metric_snapshots`, `account_metric_snapshots`,
    `post_metric_poll_states` (with `frozen_reason` constrained to `('settled','gone')`) and
    `account_metric_poll_states`.
  - `src/server/dal/insights-claims.ts` — `claimDueAccountMetricPolls`, `claimDuePostMetricPolls`
    and `countPublishedWithoutExternalId`, all taking a `providerKeys` list and taking
    `FOR UPDATE SKIP LOCKED` on the poll-state table only.
  - `src/server/scheduler/insights-poll.ts` — the tick section. Eligibility today is
    provider-wide: `listProviders().filter((p) => p.insights && !p.insights.declaration.unavailable)`
    (lines 67-70). `InsightsPollCounts` is the section's visible output.
  - `src/server/scheduler/insights-budget.ts` — `checkInsightsAllowance`, reusing `stricterBudget`,
    `windowStart` and `reserveFloor` from the engagement budget, with `INSIGHTS_READ_RESERVE`
    defaulting to 0.5.
  - `src/lib/insights/schedule.ts` — `nextPostPollAt` (hourly → daily → weekly → frozen at 28 days)
    and `nextAccountPollAt`, pure and clock-free.
  - `src/lib/insights/panel.ts` — `buildTargetInsightsView`, the single ordered decision table
    producing `not_published` / `no_external_id` / `platform_unsupported` / `unavailable` /
    `not_polled_yet` / `nothing_reported` / `reported` / `gone` / `failing`.
  - `src/providers/mock/insights.ts` and `src/providers/mock/settings.ts:52-65` — the scripted
    fixture every scheduler test uses.
  - `src/providers/bluesky/insights.ts` — the one real reader, needing no permission.
- **Where the grant currently lands and is lost**:
  - `META_SCOPES` (`src/providers/meta/oauth.ts:7-13`) is exactly `pages_show_list`,
    `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
    `instagram_content_publish` — **no insight permission**.
  - `dialogUrl` (`src/providers/meta/oauth.ts:21-29`) sets `scope` **only when
    `META_LOGIN_CONFIG_ID` is unset**; with a Login-for-Business config id it sends `config_id` and
    no `scope` at all.
  - Threads requests `threads_basic,threads_content_publish`
    (`src/providers/threads/connect-group.ts:105`) and already parses what came back
    (`grantedList`, `src/providers/threads/oauth.ts:44-45`, reading `permissions` or `scope`), then
    uses it only to write a free-text note.
  - X already parses `tokens.scopes` (`src/providers/x/oauth.ts:71-76`) and uses it only for notes
    (`src/providers/x/connect-group.ts:72-74`).
  - TikTok already reads the callback's `scopes` and falls back to the token reply's `scope`
    (`src/providers/tiktok/connect-group.ts:54-63`).
  - Meta already reads `granular_scopes` from `debug_token` to work out which Page ids a login
    granted (`src/providers/meta/candidates.ts:58-90`), but never records the flat permission list.
  - `ConnectCandidate` (`src/providers/types.ts:195-205`) has no field for granted scopes, and
    neither does the success arm of `RefreshResult` (line 412).
  - `upsertConnected` (`src/server/dal/accounts.ts:160-201`) already updates in place on
    `(project_id, provider_key, external_account_id)` and already leaves `postingInstructions`,
    `publishLimitCount`, `publishLimitWindowSeconds` and the row's `id` untouched — reconnect
    preservation is mostly an existing property to be pinned by tests, not built.
  - `applyRefreshResult` (`src/server/scheduler/credentials.ts:56`) is the single place every
    provider's refresh result is persisted, for `threads`, `x`, `tiktok`, `pinterest`, `bluesky` and
    `mock`. Facebook and Instagram have no `refreshCredentials` — Page tokens do not expire.
- **What the research already settles, and what it does not** (`docs/research/meta.md`):
  - Graph version v26.0, configurable via `META_GRAPH_VERSION` (§Graph API version).
  - §Q1 Facebook Pages are under Business Use Case limits, *per Page*:
    "Calls within 24 hours = 4800 * Number of Engaged Users". **No minimum floor is documented for
    Pages** — explicitly recorded as UNVERIFIED.
  - §Q2 Instagram is under BUC *per app-and-app-user pair*: "Calls within 24 hours = 4800 * Number
    of Impressions".
  - §Q5 Threads is under an **impressions-based** call limit: "Calls within 24 hours = 4800 * Number
    of Impressions", with a documented **impression floor of 10**.
  - §Q6 the live usage header is `X-Business-Use-Case-Usage` (`call_count`, `total_cputime`,
    `total_time` as percentages, plus `estimated_time_to_regain_access` in minutes), and the BUC
    exhaustion codes are **80001** (Pages) and **80002** (Instagram). §Q6's own "Code impact" note
    records that `src/providers/meta/errors.ts` treats only `[4, 17, 32, 613]` as rate-limited, so
    **80001 and 80002 are missing today** — the two codes these readers will actually receive.
  - **Nothing about insights metrics is recorded anywhere.** `grep` over `docs/` finds no
    `instagram_manage_insights`, no `read_insights`, no `threads_manage_insights`, no `/insights`
    endpoint, no metric name and no processing delay. Constitution I therefore forbids implementing
    any reader from the roadmap's list on trust; see "Facts recorded against the research notes".
- **Other existing pieces reused rather than reimagined** (constitution IV/V): `graphRequest` and
  `graphSummary` (`src/providers/meta/graph.ts`), `scrub` and the Graph error table
  (`src/providers/meta/errors.ts`), the Threads request layer (`src/providers/threads/requests.ts`),
  `ReconnectGroupButton` (`src/app/p/[projectSlug]/accounts/ReconnectGroupButton.tsx`), the accounts
  page's existing per-account notes and status badges (`.../accounts/page.tsx:37, 189-230`),
  `src/server/scheduler/redact.ts`, `src/server/scheduler/backoff.ts`, and
  `tests/integration/security/secret-scan.test.ts`, which already serialises every
  `social_accounts` row minus its ciphertext (lines 773-774).

### Constraints found while specifying (recorded for planning)

1. **Meta's insight metric names, scopes, periods and processing delay are not in `docs/research/`
   at all.** The roadmap names them, but constitution I is explicit that research beats the brief
   and that an unrecorded fact is `NEEDS RESEARCH`, not a guess. The roadmap itself orders the
   research first ("Extend `docs/research/meta.md` … **before** implementing"). This is the single
   largest sequencing constraint in the entry: **no reader may be implemented before its metric
   table exists in `docs/research/meta.md` with a source URL per row.** A metric that cannot be
   confirmed is not requested and not declared — not requested-and-hoped-for.
   **`NEEDS RESEARCH: docs/research/meta.md` — for each of Instagram media insights, Instagram user
   insights, Facebook Page post insights, Facebook Page insights, Threads media insights and Threads
   user insights: the endpoint, every metric name, the `period` / `metric_type` each requires, the
   exact permission each requires, whether several media ids can be asked for in one request, the
   24–48h processing delay, and whether Instagram story media expose insights only inside the
   24-hour window — each with a source URL and a check date.**
2. **`impressions` is a trap on Instagram, and the roadmap says so.** Meta removed it in April 2025
   and `views` replaced it. Requesting a removed metric is not a silent no-op — it is an error that
   would fail the whole read. This needs an enforced prohibition, not a comment.
3. **The declaration's `unavailable` is static per provider; the grant is per account.** Today
   `runInsightsPoll` filters whole providers (`insights-poll.ts:67-70`) and
   `buildTargetInsightsView` branches on `declaration.unavailable`
   (`src/lib/insights/panel.ts:58`). Neither can express "this Instagram account granted the
   permission and that one did not", which is the entire point of the entry. Per-account
   eligibility must become a first-class, SQL-answerable property, or the claim will fetch accounts
   it must never call.
4. **With `META_LOGIN_CONFIG_ID` set, Docket cannot add a scope to the dialog at all.** `dialogUrl`
   sends `config_id` and omits `scope` entirely (`src/providers/meta/oauth.ts:27-28`), because
   Facebook Login for Business takes its permission set from the configuration in the Meta app
   dashboard. So `optionalScopes` can only widen the request in the non-config-id path; in the
   config-id path the operator must add the permission to the Login configuration itself. Telling a
   member to "reconnect" in that situation, without saying this, sends them round a loop that
   cannot succeed.
5. **Not every provider reports what it granted, and a silent empty list would be a lie.** Threads'
   `grantedList` and X's `scopes` are both typed `string[] | null` precisely because the reply may
   not list them. "Unknown" and "granted nothing" must stay distinguishable in the column, or an
   account that in fact holds the permission would be told to reconnect forever.
6. **A refresh usually does not restate the grant.** Threads' `th_refresh_token` and the other
   refresh flows return a token, not a permission list. A refresh that reports nothing must leave
   the stored value alone; overwriting it with `NULL` on every token renewal would make the state
   flap and would silently stop a working reader a few days after it started.
7. **Facebook Reels publish a video id as the external id, not a Page post id.**
   `src/providers/facebook/publish.ts:278` returns `externalId: state.videoId`, while the feed and
   photo paths return a post id (lines 125-130). Page *post* insights are keyed by post id. So some
   already-published Facebook targets cannot be read with the post-insights endpoint at all. This is
   the Facebook analogue of the TikTok `publish_id` defect the roadmap hands to entry 3, and the
   roadmap does not assign it to anybody. It must be handled honestly here (shown as unavailable for
   that target, never as a failure) and recorded as a named gap.
8. **The story freeze is a provider fact the generic schedule cannot know.** `post_targets`
   already carries `chosenPostType` (`src/server/db/schema/posts.ts:214`, constrained to include
   `'story'` at line 256) and Instagram declares `story` among its post types
   (`src/providers/instagram/capabilities.ts:92`), but *that a story's numbers die after 24 hours* is
   Instagram's knowledge, not the scheduler's. Constitution V forbids teaching the scheduler about a
   platform. And `post_metric_poll_states.frozen_reason` is constrained to `('settled','gone')`, so
   a third terminal reason needs a migration, not just a new string.
9. **The impressions-based budget cannot be computed locally.** `checkInsightsAllowance` takes a
   static `PublishLimit`. `4800 × engaged users` and `4800 × impressions` are numbers Meta knows and
   Docket does not, and the Pages floor is documented nowhere (§Q1, UNVERIFIED). Any static figure
   Docket declares is therefore a floor-estimate, and the only authoritative signal is the
   `X-Business-Use-Case-Usage` header on each response plus codes 80001/80002.
10. **The accounts page has no concept of a per-feature permission state.** It has a status badge
    (`active` / `needs_reauth`, `.../accounts/page.tsx:37`) and free-text `notes` (line 189).
    `needs_reauth` is a *publishing* state and must not be reused: an account that can publish
    perfectly well but cannot read insights is not broken, and marking it broken would be a lie that
    also changes what the scheduler does with it.
11. **`docs/limits.md` is test-checked.** `tests/integration/docs/limits-inventory.test.ts` holds
    the file against the registered providers, and 080 added the row shape
    `note: insights read budget | <count> / <window> s` (`docs/limits.md:174`). Three new readers
    mean three new rows, each with its source and its enforcement pointer, or the test fails.
12. **The secret-scan test already covers the new column by construction** — it serialises every
    `social_accounts` row minus `credentialsEncrypted` (lines 773-774) — so the risk is not that the
    scan misses `granted_scopes`, but that a provider writes a token-shaped string into it. The
    defence belongs at the write boundary, and the test needs a case that proves it.

## Decisions made while specifying

Each is a judgement call to be appended to `docs/decisions.md`, and each is reversible.

- **Research first, and a reader that cannot be sourced is not written.** Constraint 1 and the
  roadmap's own ordering. The research task produces, in `docs/research/meta.md`, one table per
  surface: metric name, the permission it requires, the `period`/`metric_type` it requires, whether
  it is available for which media types, the processing delay, and a source URL and check date per
  row. Only metrics that appear in that table are declared and requested. If a whole surface cannot
  be confirmed, that provider's insights module ships **declared `unavailable`** with a reason
  naming the gap — which is a working, honest outcome this entry already supports — rather than a
  reader that guesses. This keeps the entry shippable under constitution I in the worst case.
- **`granted_scopes` is a nullable array of text, and `NULL` means "not known", not "none".**
  Constraint 5. `NULL` = never recorded (an install that has not reconnected, or a provider whose
  reply does not list permissions); `{}` = the platform answered and granted nothing relevant. The
  two produce different, honest reasons on screen. An array column is chosen over `jsonb` so the
  eligibility test is a plain SQL containment check the claim query can index, which constraint 3
  requires.
- **A grant is recorded only from what the platform said, never from what Docket asked for.**
  Writing `META_SCOPES` into the column at connect would make the column a restatement of Docket's
  own request, which answers nothing. Each provider contributes the list the platform returned, or
  nothing.
- **G31 — `grantedScopes` travels on `ConnectCandidate` and on the success arm of `RefreshResult`.**
  Those are the two existing doors into `social_accounts`, and `upsertConnected` and
  `applyRefreshResult` are the two existing places that write through them. No provider gets a
  second, private path to the column. A refresh that reports nothing leaves the stored value
  unchanged (constraint 6); only an explicitly reported list overwrites.
- **G32 — `optionalScopes` lives on the `OAuthConnectGroup`, and the per-provider need lives on the
  insights declaration.** The roadmap says "a declaration on the provider"; the dialog URL is built
  by the *group* (`authorizationUrl`), and one group can back several providers with different
  needs — the Meta group backs Facebook (`read_insights`) and Instagram
  (`instagram_manage_insights`) from a single consent. So the two halves are split: the provider
  declares `insights.declaration.requiredScopes`, the scopes an account must hold for *that*
  provider's reads; the group declares `optionalScopes`, the extra scopes it may ask for and why.
  Recorded here as a deliberate, minimal divergence from the roadmap's wording, taken so neither
  half has to be duplicated per provider.
- **The operator opts in with one environment flag per connect group, defaulting to off.** The
  roadmap's requirement is that an insight permission is requested "only where the operator wants
  it rather than widening every new connection silently". In a self-hosted product the operator is
  the deployer, the precedent is `TIKTOK_APP_AUDITED`, and — decisively — on Meta the permission
  must *also* be added to the Meta app itself, which is a deployment act and not something a member
  can do from a web form. A per-connect checkbox would therefore offer a choice that does not work
  on its own. Default **off** means no existing install's consent screen changes until someone
  deliberately changes it, which is the whole point of the requirement.
- **With `META_LOGIN_CONFIG_ID` set, Docket says so instead of pretending.** Constraint 4. When the
  flag is on and a config id is set, the dialog is unchanged (Docket cannot add a scope), and the
  accounts page's reason says the permission must be added to the Meta Login configuration, with a
  link to `docs/meta-setup.md`. The account is still never called. No reconnect button is offered
  for a loop that cannot succeed.
- **G33 — per-account eligibility, and "never called" enforced in the claim, not in the reader.**
  Constraint 3. An account is eligible for a provider's insights reads when that provider declares
  `insights` without a blanket `unavailable`, **and** `requiredScopes` is empty, **or**
  `granted_scopes` is non-null and contains every entry of `requiredScopes`. The claim queries apply
  this as a SQL predicate, so an unpermissioned account is never claimed, never leased, never
  decrypted and never called — exactly the guarantee `unavailable` gives today, at account
  granularity. Bluesky and `mock` declare no `requiredScopes` and are unaffected.
- **The panel and the accounts page gain states; `needs_reauth` is left alone.** Constraint 10.
  `buildTargetInsightsView` gains `needs_reconnect` (the install asks for the permission, this
  account has not granted it) and `permission_not_requested` (the install has not turned the
  permission on at all), both ordered immediately after `unavailable` and before `no_external_id`,
  both carrying `{ reason, docsPath }`. The accounts page shows the matching per-account line —
  *"Insights need a reconnect"* with the provider's reason, a docs link, and the existing
  `ReconnectGroupButton` — only in the first case. The account's status badge, its ability to
  publish and everything the scheduler does with it are untouched.
- **Reconnecting updates the account in place and loses nothing.** `social_accounts_external_uq`
  keys on `(project_id, provider_key, external_account_id)` and `upsertConnected` already updates
  rather than inserts. This entry makes that a *stated, tested* property rather than an incidental
  one: after a reconnect the row keeps its `id`, its publish-limit overrides, its posting
  instructions, its slot assignments, its engagement state and its insights poll state and
  snapshots, and no second row appears. Account settings continue to be refreshed from the
  platform's own answer, exactly as today — that is a refresh of platform-derived facts, not a loss
  of a member's choice.
- **G34 — a provider declares which post types expire, and how long they live.** Constraint 8.
  `insights.declaration.ephemeralPostTypes?: readonly { postType, lifetimeMs }[]`, and Instagram
  declares `story` with a 24-hour lifetime sourced from the research of constraint 1. The pure
  schedule function reads the declaration: an ephemeral target is polled on the dense first-band
  cadence from publication, is never scheduled past `publishedAt + lifetimeMs`, and freezes at that
  boundary with the new reason `expired`. The scheduler learns nothing about Instagram; a later
  platform with a 7-day ephemeral type needs no scheduler change.
- **A story already past its window when this entry lands is frozen, not captured once.** 080 grants
  a settled-but-never-polled target exactly one catch-up capture so the panel is not empty on day
  one. For an expired story there is nothing left to read, so the catch-up would spend an allowance
  to record an error. It is frozen `expired` immediately, with no call.
- **`frozen_reason` gains `expired` through a migration**, and the panel renders it as "this story
  has expired; these numbers are final", beside whatever snapshots were captured while it lived.
- **Meta's budget is enforced from Meta's own answer, with a conservative declared floor underneath
  it.** Constraint 9. Three layers, in order: (1) the existing per-account reserve, unchanged, so a
  poll can never eat the allowance a scheduled publish needs; (2) a declared `readBudget` that is an
  explicit, conservative *floor* estimate — for Threads, the documented impression floor of 10 gives
  `4800 × 10` per 24 h (§Q5); for Pages and Instagram no floor is documented (§Q1, §Q2), so the same
  figure is used as an interim stand-in and recorded as **interim, UNVERIFIED** in `docs/limits.md`
  exactly as 080's Bluesky row is; (3) the live signal — every Graph response's
  `X-Business-Use-Case-Usage` is read, and when any of `call_count`, `total_cputime` or `total_time`
  reaches a configured percentage ceiling the read returns `rate_limited` with `retryAt` taken from
  `estimated_time_to_regain_access`. Layer 3 is the one that actually respects an impressions-based
  limit; layers 1 and 2 are the floor that holds when no header arrives.
- **Graph codes 80001 and 80002 become rate-limited, because this entry is what makes them
  reachable.** §Q6 already recorded the omission in `src/providers/meta/errors.ts`; before this
  entry a BUC exhaustion would be classified `fatal_error` and the poll would stop rather than back
  off. Fixed here, with its test, as the research's own "Code impact" note asks. The same check is
  applied to the Threads client.
- **One insights module per provider folder, with no shared Meta metric vocabulary.**
  `src/providers/instagram/insights.ts`, `src/providers/facebook/insights.ts` and
  `src/providers/threads/insights.ts`, each declaring its own keys with its own labels. Shared
  *transport* (the Graph request helper, the usage-header parser, the error table) is reused from
  `src/providers/meta/`; shared *meaning* is forbidden. Facebook's "Impressions", Instagram's
  "Views" and Threads' "Views" are three keys with three labels on three providers, and no generic
  code may map one to another. This is what makes "never sum across platforms" a property of the
  data layer rather than a promise about a chart.
- **Instagram's `impressions` is prohibited, not merely omitted.** Constraint 2. The Instagram
  module's requested-metric list is a single exported constant, and a test asserts that
  `impressions` is absent from it and from every request the reader issues.
- **Instagram reads one media at a time unless the research says otherwise.**
  `/{ig-media-id}/insights` is a per-media edge; whether several ids can be batched is part of the
  research of constraint 1. `maxPostsPerRead` is declared `1` until the research says a larger
  number is supported — under-declaring costs calls, over-declaring breaks the read. The batch-shaped
  contract 080 chose means this is a number, not a redesign.
- **A Facebook target whose external id is a video id is unavailable for post insights, and said
  so.** Constraint 7. The Facebook reader can tell a Page post id from a video id and reports that
  target as `gone`-adjacent — a distinct, terminal, **non-failure** outcome with its own reason on
  the panel and its own count in the section — rather than issuing a call that cannot work. Recorded
  as a named gap in `docs/insights.md`; repairing the stored id is not in this entry's scope and no
  later entry currently owns it.
- **No API operation, no MCP tool, no chart, no account-metric screen.** Entry 4 owns all of them,
  and leaving `OPERATIONS` untouched keeps the enumerated-surface tests green with no edits.
- **No new permission statement in `src/server/auth/access.ts`.** The panel stays governed by
  `post: ["view"]` as 080 decided, and the new accounts-page line is governed by the account
  management the page already checks (`canManage` for the reconnect button, view for the reason).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An install that does nothing keeps working, exactly as before (Priority: P1)

An operator upgrades Docket and changes no configuration. Their Facebook Page, Instagram and Threads
accounts keep publishing on schedule. The consent screen for a brand-new connection asks for exactly
the permissions it asked for yesterday. On a Meta post's detail page, the performance panel says
plainly that Docket has not been given permission to read Instagram's numbers, with a link to the
setup guide. Nothing is marked broken, no account needs reconnecting, no error appears in the
scheduler's heartbeat, and the Bluesky numbers that 080 shipped keep arriving.

**Why this priority**: This is the entry's safety property. Every other story is optional for an
install; this one is not, and if it fails the entry is a regression for every existing deployment.

**Independent Test**: Run the full suite with no new environment variable set, with accounts whose
`granted_scopes` is `NULL`. Assert: the Meta and Threads authorization URLs are byte-identical to
the pre-change ones; no insights claim returns a Meta or Threads account; `InsightsPollCounts`
records zero failures and zero credential problems attributable to them; the panel renders a reason,
not an error; and the Bluesky and mock paths are unchanged.

**Acceptance Scenarios**:

1. **Given** no insight-permission flag is set, **When** a member starts a Facebook/Instagram
   connection, **Then** the dialog URL carries exactly today's `META_SCOPES` (or today's
   `config_id`) and nothing more.
2. **Given** an Instagram account connected before this entry (`granted_scopes` is `NULL`),
   **When** the insights section runs, **Then** that account is never claimed, never leased and
   never called, and the section reports no failure for it.
3. **Given** the same account, **When** a member opens a published Instagram post, **Then** the
   panel shows "Docket has not been given permission to read Instagram's numbers", with a link to
   the setup guide, and no number, no dash and no zero.
4. **Given** the same account, **When** a member opens the accounts page, **Then** the account's
   status badge is unchanged, it is not described as needing reconnecting, and publishing is
   unaffected.
5. **Given** a Bluesky account, **When** the insights section runs, **Then** it is claimed and read
   exactly as 080 specified, with no new condition applied to it.

---

### User Story 2 - The grant is recorded, so Docket can answer "may this account read insights?" (Priority: P1)

An operator connects a Facebook Page and an Instagram account through one Meta login, a Threads
account, and an X account. For each, Docket records what the platform said it granted — not what
Docket asked for. Later, a member reconnects one of them: the same account is updated in place, its
publish-limit override, posting instructions and slot assignments survive, no duplicate appears, and
the recorded grant is refreshed from the new consent. When a token is refreshed in the background
and the platform says nothing about permissions, the recorded grant is left exactly as it was.

**Why this priority**: Nothing else in the entry can be built on top of a column that is not written
reliably, and a reconnect that duplicated an account or dropped a member's settings would be a data
loss bug shipped to fix a reporting gap.

**Independent Test**: Connect each OAuth provider against mocked HTTP whose token/permission replies
are scripted, and assert the stored value for each. Reconnect and assert the row's identity and every
preserved field. Run a scripted refresh with and without a permission list and assert the column.

**Acceptance Scenarios**:

1. **Given** a Meta login whose permission list the platform reports, **When** the Page and the
   Instagram account are created, **Then** both rows record that reported list.
2. **Given** a Threads login whose reply carries no permission list, **When** the account is
   created, **Then** `granted_scopes` is `NULL`, not an empty list and not the requested list.
3. **Given** an existing account with a publish-limit override, posting instructions, slot
   assignments and insights snapshots, **When** a member reconnects it through the same group,
   **Then** exactly one row still exists, with the same identifier, and every one of those survives.
4. **Given** an account whose stored grant includes the insight permission, **When** a background
   token refresh returns a token and no permission list, **Then** the stored grant is unchanged.
5. **Given** a provider whose refresh **does** report a permission list that no longer includes the
   insight permission, **When** the refresh is applied, **Then** the stored grant is replaced and
   the account stops being eligible for insights reads from the next tick, with no error.
6. **Given** any connect or refresh, **When** the stored grant is written, **Then** it contains only
   short permission-shaped identifiers and the security scan finds no credential anywhere in the
   row.

---

### User Story 3 - An operator turns the permission on, a member reconnects, and numbers arrive (Priority: P1)

An operator decides they want Instagram numbers. They follow `docs/meta-setup.md`: add the
permission to their Meta app, then set the flag in their environment. The accounts page now shows,
against each Meta account, "Insights need a reconnect" with the reason and a link. A member presses
Reconnect, approves the extra permission on Meta's screen, and comes back to the same account. From
the next scheduler run, that post's panel starts showing Instagram's own numbers — Views, Reach,
Likes, Comments, Saves, Shares, Interactions — each labelled with Instagram's word, with one line
saying what they are "as of".

**Why this priority**: This is the feature the entry exists to deliver, and it is the whole reason
the first half must land first.

**Independent Test**: With the flag on and scripted Graph responses, drive the connect callback with
a permission list that includes the insight scope, then run the tick, then render the panel. Every
step is exercisable with mocked HTTP; only the live consent screen itself is not, and that is a
parked manual check.

**Acceptance Scenarios**:

1. **Given** the flag is on and no Login-for-Business config id is set, **When** the dialog URL is
   built, **Then** it requests today's scopes plus exactly the declared optional scopes, and
   nothing else.
2. **Given** the flag is on and an account has not granted the insight permission, **When** a member
   opens the accounts page, **Then** that account shows "Insights need a reconnect" with the
   provider's own reason, a docs link and a reconnect button, and its status badge is unchanged.
3. **Given** the flag is on and a Login-for-Business config id **is** set, **When** a member opens
   the accounts page, **Then** the reason says the permission must be added to the Meta Login
   configuration, links to the setup guide, and offers no reconnect button.
4. **Given** an account that has granted the permission, **When** the insights section runs,
   **Then** it is claimed and read, and a snapshot is written for each eligible published target.
5. **Given** that snapshot, **When** a member opens the post, **Then** each metric the response
   contained is shown with Instagram's own label and one "as of" time, and each metric the response
   did not contain is shown not at all.
6. **Given** two accounts on the same Page-and-Instagram login, one eligible and one not, **When**
   the section runs, **Then** the eligible one is read and the other is not claimed at all.

---

### User Story 4 - Three platforms, three vocabularies, never added together (Priority: P2)

A member looks at a post that went out to Instagram, a Facebook Page, Threads and Bluesky on the same
day. They see four separate blocks, one per account. Instagram says Views and Reach; Facebook says
Impressions, reactions broken out by type, and Clicks; Threads says Views, Likes, Replies, Reposts,
Quotes and Shares; Bluesky says Likes, Reposts, Replies and Quotes and shows nothing where views
would be, because Bluesky has none. Nowhere is there a total, an average, a combined "reach", or one
platform's word standing in for another's.

**Why this priority**: It is the roadmap's hardest rule and the first entry where it can actually be
broken. Getting it wrong here makes it structural for entries 3 and 4.

**Independent Test**: A rendering test over one post with four targets and four scripted snapshots,
asserting the labels, the per-account grouping, the absence of any aggregate, and the absence of any
row for a metric the response omitted.

**Acceptance Scenarios**:

1. **Given** snapshots from four platforms on one post, **When** the panel renders, **Then** each
   account's numbers are in its own block with that platform's own labels, and no total, average or
   cross-platform figure appears anywhere.
2. **Given** a Threads response that omits `quotes`, **When** the panel renders, **Then** there is
   no Quotes row — no label, no dash, no zero.
3. **Given** a Facebook response whose reactions are broken out by type, **When** the panel renders,
   **Then** each type appears under Facebook's own name for it and none is folded into a single
   "reactions" number by generic code.
4. **Given** any two providers, **When** their declarations are compared in a test, **Then** no
   metric key is renamed, aliased or grouped by any code outside the provider's own folder.

---

### User Story 5 - A story is read while it exists, then frozen (Priority: P2)

A member posts an Instagram story at 9am. Docket reads its numbers through the day while the story is
live. At 9am the next day the story is gone from Instagram, and so are its insights. Docket stops
reading it, keeps every snapshot it took, and the panel says the story has expired and these numbers
are final. It never spends another call on it, and never reports a failure for it.

**Why this priority**: Without it the generic schedule would poll a dead story for 28 days, burning
an allowance a publish may need and showing a persistent false failure on the post.

**Independent Test**: Pure unit tests over the schedule function with an ephemeral declaration, plus
an integration test driving a story target through its window and past it against the mock provider.

**Acceptance Scenarios**:

1. **Given** a target whose chosen post type is `story` on a provider declaring it ephemeral,
   **When** the next poll time is computed, **Then** it is inside the declared lifetime and never
   beyond it.
2. **Given** the same target at the end of its lifetime, **When** the schedule is computed, **Then**
   it is frozen with the reason `expired` and no further poll is scheduled.
3. **Given** a story target already older than its lifetime when the subsystem first sees it,
   **When** the section runs, **Then** it is frozen `expired` with **no** provider call and no
   catch-up capture.
4. **Given** a frozen-expired story, **When** a member opens the post, **Then** the snapshots taken
   while it was live are shown with their "as of" time, alongside a plain statement that the story
   has expired, and no failure is shown.
5. **Given** a non-ephemeral target on the same account, **When** the schedule is computed, **Then**
   it follows 080's decaying schedule unchanged.

---

### User Story 6 - Polling respects Meta's own limit and never starves a publish (Priority: P2)

An operator with a busy Page watches a tick. Insights reads happen within the share of the account's
allowance reserved for them, and the moment Meta's own usage header says the account is approaching
its budget, polling backs off until Meta's own estimate of when access returns. A scheduled publish
in the same tick is never deferred because a poll took its allowance, and a BUC exhaustion is a
backoff, not a stopped subsystem.

**Why this priority**: Meta's limit is impressions-based (§Q2, §Q5) and a flat per-hour count is the
wrong shape; getting it wrong risks the publishing path, which is the product.

**Independent Test**: Scripted Graph responses carrying `X-Business-Use-Case-Usage` at various
percentages and `estimated_time_to_regain_access`, plus scripted 80001/80002 errors, asserted against
the read result, the recorded backoff and the section counts; plus the existing reserve tests
extended to the new providers.

**Acceptance Scenarios**:

1. **Given** a response whose usage header reports a percentage at or above the configured ceiling,
   **When** the read returns, **Then** it is `rate_limited` with a retry time derived from the
   header's own estimate, and no further call is made for that account in the tick.
2. **Given** a Graph error with code 80001 or 80002, **When** it is classified, **Then** it is
   rate-limited and backed off, not fatal.
3. **Given** an account whose window usage has reached the publishing reserve, **When** a poll is
   considered, **Then** it is deferred and counted as deferred, and a publish for that account in
   the same tick proceeds.
4. **Given** no usage header at all, **When** reads run, **Then** the declared floor budget and the
   existing reserve still bound them.
5. **Given** any of these, **When** the error or reason is recorded, **Then** it carries no token,
   no header value that could contain one, and nothing longer than the stored limit.

---

### User Story 7 - An operator can see what the readers did (Priority: P3)

An operator checks the scheduler's health page. The insights section reports, per tick, how many
accounts and targets it claimed, how many snapshots it wrote, how many targets it froze and why, how
many it skipped because the account has not granted the permission, how many it skipped because the
target has no external id or has an id it cannot query, and how many were deferred for allowance.
A section that did nothing because nothing was eligible is distinguishable from one that did nothing
because it ran out of time.

**Why this priority**: 080 established that a tick section which silently claims nothing and returns
success is the main source of invisible failure; three new platforms make that more likely, not less.

**Independent Test**: Assert the section's counts over scripted fixtures covering each outcome, and
assert a heartbeat is written on every path including the empty one.

**Acceptance Scenarios**:

1. **Given** accounts ineligible for want of a granted permission, **When** the section runs,
   **Then** their number is reported under its own count and not as a failure.
2. **Given** a target frozen as expired and another frozen as settled, **When** the section runs,
   **Then** each is counted under its own reason.
3. **Given** a Facebook target whose external id cannot be queried, **When** the section runs,
   **Then** it is counted under its own reason, no call is made, and no failure is recorded.
4. **Given** a tick in which the section has no time left, **When** it returns, **Then** that is
   visible in the heartbeat and distinguishable from having nothing to do.

---

### Edge Cases

- **An account reconnects and the platform grants *fewer* permissions than before.** The stored
  grant is replaced by what was actually granted; the account stops being eligible from the next
  tick; existing snapshots are kept; the panel moves to "Insights need a reconnect"; nothing errors.
- **The same person connects the same Page twice in a row.** One row, updated in place, keyed on
  `(project_id, provider_key, external_account_id)`; the poll state and snapshots survive.
- **An account is removed and reconnected later.** The unique index is partial on
  `removed_at IS NULL`, so a new row is created; its insights start fresh. Stated so the behaviour
  is not mistaken for the duplicate the roadmap forbids.
- **A target is published by hand with no external id.** Skipped, counted under 080's existing
  no-external-id count, never a failure (`post_targets_published_has_id`,
  `src/server/db/schema/posts.ts:269`).
- **A Facebook Reel target carries a video id.** Not called; reported with its own reason and its
  own count; never a failure (constraint 7).
- **Meta returns a metric Docket did not declare.** Discarded by the declared-keys filter 080
  already applies; it never reaches a snapshot row or the screen.
- **Meta returns a metric Docket declared, with an empty `values` array.** Treated as absent, not as
  zero.
- **A metric is still inside its 24–48h processing delay.** Absent, not zero; the panel says what it
  has "as of" and nothing more. The schedule's first read is an hour after publish (080), so an
  early empty answer is expected and is not a failure.
- **The operator turns the flag on but never adds the permission to the Meta app.** The consent
  screen refuses or silently omits the scope; the reported grant does not contain it; the account
  stays ineligible with the reconnect reason. No loop, no error.
- **The operator turns the flag off again after accounts have granted the permission.** Stored
  grants are unchanged and those accounts remain eligible — the platform really did grant it. New
  connections stop asking. Stated so the flag is understood as governing the *request*, not the
  *right*.
- **A provider reports a permission list containing something token-shaped.** Rejected at the write
  boundary; the account connects with `granted_scopes` unset rather than storing it.
- **Two ticks race on the same account.** Unchanged from 080: `FOR UPDATE SKIP LOCKED` on the
  poll-state row, one commit per account, lease released on every path.
- **A story target's post type is changed after publication.** Not possible for a published target;
  the declared lifetime is evaluated against the stored `chosenPostType` at poll time, and a target
  that stops matching simply returns to the ordinary schedule.
- **An account's provider is removed from the registry.** Unchanged from 080: it is not claimed and
  the panel says the platform is unsupported.

## Requirements *(mandatory)*

### Functional Requirements

#### Research, before any reader exists

- **FR-001**: `docs/research/meta.md` MUST be extended, **before any reader is implemented**, with
  one table per surface — Instagram media insights, Instagram user insights, Facebook Page post
  insights, Facebook Page insights, Threads media insights, Threads user insights — each row giving
  the metric name, the permission it requires, the `period` and/or `metric_type` it requires, the
  media or post types it applies to, and its processing delay, with a **source URL and a check date**
  per table, and the 24–48 hour processing delay stated explicitly.
- **FR-002**: The research MUST state, with sources, whether more than one Instagram media id can be
  asked for in one request, and whether Instagram story media expose insights only inside their
  24-hour window and for how long.
- **FR-003**: A metric that cannot be confirmed from an official source MUST NOT be declared and MUST
  NOT be requested. A whole surface that cannot be confirmed MUST ship as a declared `unavailable`
  insights module with a reason naming the gap, and the entry remains shippable in that state.
- **FR-004**: `impressions` MUST NOT appear in Instagram's declared keys or in any request Instagram's
  reader issues. A test MUST assert its absence from the requested-metric constant and from every
  recorded request.
- **FR-005**: Where the research contradicts the roadmap's metric list, the research MUST win and the
  disagreement MUST be recorded in `docs/research/meta.md` and in `docs/decisions.md`.

#### Persisting the grant

- **FR-006**: `social_accounts` MUST gain a nullable `granted_scopes` column holding an ordered list
  of permission identifiers, shipped as a committed migration generated by `pnpm db:generate`, with
  `pnpm db:check` green.
- **FR-007**: `NULL` MUST mean "Docket has not recorded what was granted"; an empty list MUST mean
  "the platform answered and granted nothing". The two MUST produce different on-screen reasons.
- **FR-008**: The column MUST be writable only with what the platform reported. No code path may
  write the scopes Docket *requested* into it.
- **FR-009**: Each stored entry MUST be validated as a short permission-shaped identifier, with a
  bounded entry length, a bounded number of entries and a bounded total size enforced by a database
  check. A list failing validation MUST be rejected and the column left unset; the connect or
  refresh itself MUST still succeed.
- **FR-010** (G31): `ConnectCandidate` MUST gain an optional granted-scopes field, and the success
  arm of `RefreshResult` MUST gain one too. `upsertConnected` and `applyRefreshResult` MUST be the
  only writers of the column.
- **FR-011**: A refresh result that does **not** report a list MUST leave the stored value unchanged.
  Only an explicitly reported list may replace it.
- **FR-012**: Every OAuth provider that can obtain the list MUST supply it: Facebook and Instagram
  from the Meta login's reported permissions; Threads from the token reply's `permissions`/`scope`
  (`src/providers/threads/oauth.ts:44-45`); X from the token reply's `scope`
  (`src/providers/x/oauth.ts:71-76`); TikTok from the callback's `scopes` with the token reply's
  `scope` as fallback (`src/providers/tiktok/connect-group.ts:54-63`); Pinterest from its token
  reply if it carries one. A provider whose reply carries no list MUST leave the value unset.
- **FR-013**: The existing free-text notes about missing publish permissions MUST continue to be
  produced unchanged; recording the grant MUST NOT remove or alter a single existing note.
- **FR-014**: Reconnecting an account MUST update exactly one existing row, keyed on
  `(project_id, provider_key, external_account_id)` among non-removed rows, and MUST preserve that
  row's identifier, publish-limit overrides, posting instructions, slot assignments, engagement
  state, insights poll state and all existing snapshots. No duplicate row may be created.
- **FR-015**: No token, credential or secret may reach `granted_scopes`, a snapshot row, a log line,
  a panel, an error message or an API response.
  `tests/integration/security/secret-scan.test.ts` MUST be **extended** — with cases covering the
  new column, the new snapshot content and the new error strings — and nothing may be exempted from
  it.

#### Asking for the permission, only where the operator wants it

- **FR-016** (G32): `OAuthConnectGroup` MUST gain an `optionalScopes` declaration naming each extra
  scope, the purpose it serves and the doc that explains it.
- **FR-017**: An optional scope MUST be added to a group's authorization request only when that
  group's opt-in environment flag is set. The flag MUST default to off, be validated at startup,
  and be documented in `.env.example` and the group's setup guide.
- **FR-018**: With the flag unset, every group's authorization URL MUST be byte-identical to its
  pre-change value. A test MUST assert this for each OAuth group.
- **FR-019**: When the Meta group is configured with a Login-for-Business configuration id, the
  dialog MUST remain unchanged whatever the flag's value (Docket cannot add a scope to it), and
  Docket MUST state in the UI and the setup guide that the permission is added to the Meta Login
  configuration instead.
- **FR-020**: Turning the flag off MUST NOT revoke, clear or ignore a grant an account already holds;
  it governs the *request* for new consents only.

#### Per-account eligibility, displayed and never called

- **FR-021** (G33): `InsightsDeclaration` MUST gain `requiredScopes` — the permissions an account
  must hold for this provider's insights reads, empty by default — and the per-provider reason and
  docs path to show when they are not held.
- **FR-022**: An account MUST be eligible for insights reads when its provider declares `insights`
  without a blanket `unavailable`, **and** either `requiredScopes` is empty **or** `granted_scopes`
  is non-null and contains every required scope.
- **FR-023**: Ineligibility MUST be applied in the claim queries themselves, so an ineligible account
  is never claimed, never leased, never has its credentials decrypted and never has a provider call
  attempted for it.
- **FR-024**: Bluesky and `mock` MUST declare no required scopes and MUST behave exactly as 080
  specified, with `granted_scopes` left `NULL`.
- **FR-025**: `buildTargetInsightsView` MUST gain two states, ordered immediately after the existing
  `unavailable` branch and before `no_external_id`: one for "this install does not ask for the
  permission" and one for "this account has not granted it". Both MUST carry a reason and a docs
  path. Neither may render a number, a dash or a zero.
- **FR-026**: The accounts page MUST show, per account, an "Insights need a reconnect" line with the
  provider's reason and a docs link when the install asks for the permission and the account has not
  granted it, offering the existing reconnect control where reconnecting can actually succeed, and
  not offering it where it cannot (FR-019).
- **FR-027**: The account's status badge, its ability to publish, its publish-limit handling and
  every existing scheduler behaviour MUST be unaffected by insights ineligibility. `needs_reauth`
  MUST NOT be used to express it.
- **FR-028**: An account made ineligible — by a reconnect that granted less, or by a refresh that
  reported less — MUST stop being read from the next tick, keep its existing snapshots, and produce
  no error.

#### The three readers

- **FR-029**: Instagram MUST gain an insights module declaring `instagram_manage_insights` as its
  required scope, post keys for the per-media metrics confirmed by FR-001 (the roadmap's list:
  `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions`), and account keys
  for the per-user metrics confirmed by FR-001 (the roadmap's list: `reach`, `follower_count` and
  profile views) — each with Instagram's own label.
- **FR-030**: Facebook MUST gain an insights module declaring `read_insights` as its required scope,
  post keys for post impressions, reactions broken out by type and clicks, and account keys for Page
  impressions, engagements and fans — each with Facebook's own label, and each confirmed by FR-001.
- **FR-031**: Threads MUST gain an insights module declaring `threads_manage_insights` as its
  required scope, post keys for `views`, `likes`, `replies`, `reposts`, `quotes` and `shares`, and
  account keys for the user series plus `followers_count` — each with Threads' own label, and each
  confirmed by FR-001.
- **FR-032**: All three MUST go through the Graph transport the publish path already uses, reusing
  its request helper, its scrubbing and its error table; none may introduce a new HTTP client.
- **FR-033**: All three MUST return only the vocabulary 080 defined (`page`, `retryable_error`,
  `rate_limited`, `credentials_invalid`, `fatal_error`, `unavailable`, and `gone` per entry), MUST
  never throw, and MUST carry no credential in any returned message.
- **FR-034**: No metric key may be renamed, aliased, translated or grouped by any code outside the
  provider's own folder, and no code anywhere may sum or average a metric across providers. A test
  MUST assert that the three providers' declared keys and labels are disjoint declarations with no
  shared mapping table.
- **FR-035**: A declared metric absent from a response MUST be absent from the snapshot and from the
  screen — no row, no dash, no zero — including when the response returns the metric with an empty
  value list.
- **FR-036**: A Facebook target whose stored external id is a video id rather than a Page post id
  MUST NOT be called. It MUST be reported with its own reason on the panel and its own count in the
  section, and MUST NOT be recorded as a failure.
- **FR-037**: All three readers MUST be tested with mocked HTTP only, and anything needing a real
  account MUST be reported as "verified with mocks only".

#### Stories

- **FR-038** (G34): `InsightsDeclaration` MUST gain a declaration of which post types are ephemeral
  and how long each lives, and Instagram MUST declare `story` with the lifetime confirmed by FR-001
  (24 hours per the roadmap).
- **FR-039**: The poll schedule MUST remain pure, total and clock-free, and MUST, for a target whose
  stored chosen post type matches an ephemeral declaration, schedule reads on the dense first-band
  cadence and never past `published_at + lifetime`.
- **FR-040**: At that boundary the target MUST be frozen with a new terminal reason meaning
  "expired", shipped by extending the existing `frozen_reason` constraint in a committed migration.
- **FR-041**: An ephemeral target already past its lifetime when first seen MUST be frozen without
  any provider call and MUST NOT receive 080's one-off catch-up capture.
- **FR-042**: The panel MUST present an expired ephemeral target as final numbers plus a plain
  statement that the story has expired, alongside every snapshot captured while it existed, and MUST
  NOT present it as a failure.
- **FR-043**: Non-ephemeral targets MUST follow 080's decaying schedule unchanged, proven by the
  existing schedule tests continuing to pass untouched.

#### The impressions-based budget

- **FR-044**: Each new reader MUST declare a conservative `readBudget` floor, derived from the
  documented formula and its documented floor where one exists (Threads' impression floor of 10,
  §Q5) and marked **interim, UNVERIFIED** where none does (Pages §Q1, Instagram §Q2).
- **FR-045**: Every Graph response MUST have its `X-Business-Use-Case-Usage` header read, and when
  any reported percentage reaches a configured ceiling the read MUST return `rate_limited` with a
  retry time derived from the header's own `estimated_time_to_regain_access`.
- **FR-046**: Graph error codes **80001** and **80002** MUST be classified as rate-limited in
  `src/providers/meta/errors.ts`, and the equivalent check MUST be applied on the Threads path, with
  tests (the "Code impact" note of `docs/research/meta.md` §Q6).
- **FR-047**: The existing per-account reserve MUST continue to apply unchanged on top of all of
  this, so an insights poll can never consume the allowance a scheduled publish needs, and a poll
  refused for allowance MUST be counted as deferred rather than failed.
- **FR-048**: Every usage percentage, retry time and error reason recorded MUST be scrubbed and
  length-bounded, and MUST contain no token or header value that could carry one.

#### Visibility

- **FR-049**: The insights section's counts MUST distinguish, at minimum: accounts skipped for want
  of a granted permission; targets frozen as settled, gone and expired; targets skipped for having
  no external id; targets skipped for having an unqueryable external id; and polls deferred for
  allowance — each separate from failures.
- **FR-050**: A heartbeat MUST continue to be written on every path, including when nothing was
  eligible and when the section ran out of time, so the two remain distinguishable.

#### Documentation and the repo

- **FR-051**: `docs/insights.md` MUST be updated: the supported-platforms table, the permission each
  platform needs and how to grant it, the reconnect state, the story-expiry rule, and the named gaps
  (Facebook video-id targets; no account-metric screen yet).
- **FR-052**: `docs/adding-a-provider.md` MUST record G31, G32, G33 and G34 in the "Generic hooks
  index" and in the relevant sections, and `docs/decisions.md` MUST record each decision in this
  spec with its reversal.
- **FR-053**: `docs/meta-setup.md` MUST document the extra permission for each surface, the opt-in
  environment flag, the Login-for-Business configuration case, and what the install gets for it.
  `.env.example` MUST document every new variable.
- **FR-054**: `docs/limits.md` MUST gain an `insights read budget` row per new reader, each with its
  source and its enforcement pointer, keeping
  `tests/integration/docs/limits-inventory.test.ts` green.
- **FR-055**: `docs/feature-map.md` MUST be updated, and the constitution's scope sentence naming 080
  MUST be extended to name this entry, rather than being silently contradicted.
- **FR-056**: The repo MUST be left working: `pnpm lint`, `pnpm typecheck`, `pnpm test` and
  `pnpm db:check` green, with the migration committed.

### Key Entities

- **Granted scopes**: the list of permission identifiers a platform reported granting for one
  connected account, recorded at connect and at every refresh that reports one; nullable, where null
  means unknown and empty means none. Not a secret, and never derived from what Docket asked for.
- **Optional scope declaration**: a connect group's statement of the extra permissions it may
  request, each with the purpose it serves and the doc that explains it; requested only under the
  group's operator opt-in.
- **Required scopes**: a provider's statement of which permissions an account must hold before its
  insights reads may be attempted; the sole input, with the recorded grant, to per-account
  eligibility.
- **Ephemeral post type declaration**: a provider's statement that posts of a given type stop
  reporting numbers after a stated lifetime, used by the pure schedule to poll densely inside the
  window and freeze at its end.
- **Post metric snapshot** / **account metric snapshot** (from 080): one append-only reading of one
  target's or one account's numbers at one moment, under that platform's own keys. Unchanged here
  except that three more platforms now write them.
- **Poll state** (from 080): per target and per account — when next due, lease, failures, last error,
  and now a third terminal frozen reason meaning the subject expired.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An install that changes no configuration sees **zero** behaviour changes: identical
  consent screens, zero new provider calls, zero accounts marked as needing attention, zero errors
  reported anywhere, and Bluesky numbers still arriving.
- **SC-002**: For every connected account, a person can determine from the accounts page alone, in
  under 10 seconds and without reading a log, whether Docket may read that account's numbers and, if
  not, exactly what to do about it.
- **SC-003**: An account that has not granted the permission receives **zero** provider calls for
  insights — measured directly, by asserting no request is recorded for it.
- **SC-004**: An operator following the setup guide can go from "no insights" to numbers on a post,
  for all three Meta-family platforms, with no step that is not written down and no step inside
  Docket's code.
- **SC-005**: Reconnecting an account **never** produces a second account row and **never** loses a
  publish-limit override, a posting instruction, a slot assignment or a stored snapshot — asserted
  over every OAuth group.
- **SC-006**: No number shown anywhere combines two platforms, and no metric a platform did not
  report is shown as zero — asserted over a post with four platforms' snapshots.
- **SC-007**: A story's numbers stop being requested within its declared lifetime, and the post page
  shows final numbers rather than a failure — measured as zero calls after the boundary.
- **SC-008**: Insights polling never defers a scheduled publish: in a tick where both compete for one
  account's allowance, the publish proceeds and the poll is deferred, 100% of the time.
- **SC-009**: Every metric name, permission and delay used by the three readers traces to a row in
  `docs/research/meta.md` carrying a source URL — 100%, verified by inspection of the declarations
  against the tables.
- **SC-010**: The security scan finds no credential in any new column, snapshot, log line, reason
  string or rendered panel.
- **SC-011**: Every behaviour above is demonstrated with mocked HTTP only; anything needing a live
  consent screen or a real platform account is listed as a manual check and reported as "verified
  with mocks only".

## Out of Scope

Stated so the boundary is explicit, with the entry that owns each.

- **TikTok, Pinterest and X insights** — entry 3 (`insights-tiktok-pinterest-x`), which consumes the
  `optionalScopes` and `requiredScopes` machinery this entry builds, carries the TikTok
  external-id repair, and ships X declared unavailable on cost grounds. This entry records their
  granted scopes (they are OAuth providers and the column is generic) but declares no insights
  module for them.
- **Any chart, trend, delta, sparkline, time series or cross-platform comparison** — entry 4
  (`insights-schedule-intelligence`). The panel continues to show one latest snapshot per target.
- **Any screen for account metrics** — captured by 080 and by this entry, displayed nowhere. Entry 4
  owns account trends. This remains a known, deliberate gap, as `docs/insights.md` already states.
- **Any API operation or MCP tool** — entry 4. `OPERATIONS` is untouched.
- **A manual "refresh now" action** — out of scope for the whole roadmap as 080 decided; numbers
  arrive on the schedule.
- **A per-project on/off switch for insights** — not in this entry; the operator flag is per install
  and per connect group.
- **Repairing Facebook's stored external id for Reel targets** — those targets are declared
  unqueryable and recorded as a named gap (constraint 7). No entry currently owns the repair.
- **Facebook Page Stories** — out of scope by the constitution; only Instagram Stories (078) exist,
  and only those get the ephemeral declaration.
- **Comment and reply reading for Meta platforms** — `docs/engagement.md` records those as not yet
  built; nothing here changes that.
- **Any change to publishing, to the publish limits, or to what `needs_reauth` means.**

## Assumptions

Reasonable defaults taken where the roadmap did not specify; each is cheap to revisit.

- **The operator is the deployer.** The opt-in is an environment flag per connect group, defaulting
  to off, following the `TIKTOK_APP_AUDITED` precedent — not a per-connection checkbox, because on
  Meta the permission must also be added to the app itself, which no web form can do.
- **One flag per connect group, not per provider.** The Meta group's single consent covers both
  Facebook and Instagram, so one flag turns on both groups' optional scopes; Threads has its own
  group and its own flag.
- **Recording the grant is not a secret-bearing act.** Permission identifiers are public strings, so
  `granted_scopes` is readable in the UI and in logs — guarded by validation at the write boundary
  and by the extended security scan rather than by encryption.
- **Instagram reads one media at a time** until the research says a batch is supported; the
  batch-shaped contract from 080 makes this a declared number rather than a design.
- **The first read stays an hour after publish** (080), so the 24–48h processing delay shows up as
  absent metrics on early reads, which is the intended, honest presentation and not a failure.
- **The usage-header ceiling is configurable with a conservative default**, because the right
  percentage depends on how much else an install does with the same Meta app.
- **Snapshot retention stays at 400 days** (080) for the new platforms too; entry 4 owns the
  aggregate-before-pruning refinement.
- **Existing accounts are not migrated or back-filled.** `granted_scopes` starts `NULL` for every
  existing row and is filled by the next connect or by a refresh that reports one; nothing probes a
  platform at migration time.
- **The entry's two halves are shippable separately in principle but are specified together**,
  because the second cannot be enabled without the first and shipping the first alone would add a
  column nothing reads.

## Facts recorded against the research notes

Per constitution I, these are the facts this entry needs that are **not** in `docs/research/` today,
and the disagreement between the roadmap and what is recorded.

1. **`NEEDS RESEARCH: docs/research/meta.md`** — every metric name, required permission,
   `period`/`metric_type`, applicable media types and processing delay for Instagram media insights,
   Instagram user insights, Facebook Page post insights, Facebook Page insights, Threads media
   insights and Threads user insights, each with a source URL and check date (FR-001). **Blocking
   for the readers only**; the whole first half of the entry can be built without it.
2. **`NEEDS RESEARCH: docs/research/meta.md`** — whether several Instagram media ids can be asked for
   in one request, which sets `maxPostsPerRead` (FR-002). Non-blocking: `1` is the safe default.
3. **`NEEDS RESEARCH: docs/research/meta.md`** — whether Instagram story media expose insights only
   inside the 24-hour window, and for exactly how long, which sets the declared lifetime (FR-002).
   Non-blocking: 24 hours is the roadmap's figure and the conservative one.
4. **`NEEDS RESEARCH: docs/research/meta.md`** — whether a minimum call-budget floor exists for
   Facebook Pages and for Instagram. §Q1 and §Q2 both record this as UNVERIFIED, so the declared
   `readBudget` for those two is an interim stand-in and must say so in `docs/limits.md` (FR-044),
   exactly as 080's Bluesky row does.
5. **`NEEDS RESEARCH: docs/research/pinterest.md`** — whether Pinterest's token reply carries a
   `scope` field. Non-blocking: if it does not, `granted_scopes` stays `NULL` for Pinterest and
   entry 3 picks it up.
6. **Recorded disagreement with the roadmap**: the roadmap places `optionalScopes` "on the
   provider". The authorization URL is built by the connect group, and one group serves providers
   with different needs, so `optionalScopes` is specified on the group and `requiredScopes` on the
   provider's insights declaration (see Decisions, G32).
7. **Recorded disagreement with the roadmap**: the roadmap does not mention that Facebook Reels
   publish a video id rather than a Page post id (`src/providers/facebook/publish.ts:278`). Those
   targets are declared unqueryable here rather than silently failing (FR-036).
8. **Already recorded and acted on here**: `docs/research/meta.md` §Q6's "Code impact" note that
   codes 80001 and 80002 are missing from the rate-limited set — fixed by FR-046, because this entry
   is what makes them reachable.

## Task ordering note for planning

The roadmap's rule — *"park every task that needs a live OAuth consent screen, a real platform
account or a browser at the very end of its entry's task list, because a judgement task in an early
phase starves the implement loop"* — bites harder here than in any previous entry, because the
headline user journey **is** a consent screen. The following must be the **last** tasks in
`tasks.md`, after every mocked-HTTP, unit, integration and documentation task is done:

- Approving the extra permission on a live Meta consent screen and confirming the reported grant.
- The same for Threads.
- Confirming on a real Instagram, Facebook Page and Threads account that the declared metrics are
  actually returned, and that a story's insights behave as the research says inside and after its
  window.
- Any browser walk-through of the accounts page's reconnect flow.

Everything else — the column and its migration, the two declarations, the eligibility predicate, the
claim change, the panel states, the accounts-page line, the three readers against mocked Graph
responses, the ephemeral schedule, the budget layers, the counts, the security-scan extension and
every doc — is reachable with no platform credentials, and must be sequenced first. The research of
FR-001 is the one exception that must come **before** the readers rather than after them; it needs
published documentation, not an account.
