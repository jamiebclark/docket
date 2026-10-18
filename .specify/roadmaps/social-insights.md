# Roadmap: see what happens to a post after it publishes

Goal: Docket can schedule and publish, and since 077 it can read what people say back — but it is blind to
numbers. Nothing in the database records that a post got 4 likes or 40,000 views. Give Docket sight of
what happens after publish: read per-post and per-account metrics back from each connected platform, keep
them as history Docket owns rather than a number rendered once, and turn that history into the scheduling
comparisons no native dashboard can make (by slot, by series, by voice profile, generated vs hand-written).

Read `docs/adding-a-provider.md` (sections 18 and 20, and the "Generic hooks index"), `docs/engagement.md`,
`docs/limits.md` and the relevant `docs/research/*.md` in full before specifying any entry.

## Behaviour on `main` that every entry builds on

- **The provider contract** is `src/providers/types.ts`. Optional per-platform modules hang off
  `SocialProvider`: `posting?` (line 619), `accountDetails?` (620), `consent?` (621), `engagement?` (622).
  Each was added as a numbered generic change recorded in the "Generic hooks index" table of
  `docs/adding-a-provider.md` and in `docs/decisions.md`; that ledger currently runs to **G29**, so a new
  `insights?` member is **G30** and must be recorded in both places. `src/providers/**` must not import
  from `src/server/**` — a lint test enforces it.
- **The join key already exists.** `post_targets.externalId` and `externalUrl`
  (`src/server/db/schema/posts.ts:233-235`) are written for every published target. But the constraint
  `post_targets_published_has_id` (line 269) reads
  `status <> 'published' OR external_id IS NOT NULL OR resolved_at IS NOT NULL` — a target resolved by
  hand is published with **no** external id. Every poll must skip those, not treat them as a failure.
- **077 is the worked precedent for a read subsystem.** Copy its shape rather than inventing one:
  a provider declaration carrying `reads` and `unavailable: { reason, docsPath }` so a surface the
  install cannot permission is shown as unavailable and **never called** (`src/providers/types.ts:489-500`);
  per-account state with cursor, lease, backoff and `consecutiveFailures`
  (`engagement_account_states`, `src/server/db/schema/engagement.ts:208`); a claim DAL that skips locked
  rows (`src/server/dal/engagement-read-claims.ts`); a tick section that calls the provider outside any
  transaction and commits per account (`src/server/scheduler/engagement-read.ts`); and `ENGAGEMENT_*`
  config knobs with a time share of the tick (`src/server/scheduler/config.ts:45-52` and `152-168`).
- **Tick sections run concurrently under one deadline, and a section out of time claims nothing and
  returns success** — see the comment at `src/server/scheduler/config.ts:162-166`. A new section needs its
  own `SectionResult` in `TickSummary` (`src/server/scheduler/index.ts:19-31`), its own entry in the
  `Promise.all` (line 56) and its own heartbeat, or it is invisible when it silently does nothing.
- **The API surface is one registry.** `OPERATIONS` (`src/server/api/operations/index.ts:17`) feeds the
  router (`router.ts:25`), the OpenAPI document (`openapi.ts:126`) and the MCP tool list, which filters on
  `op.mcp.expose` (`src/server/mcp/dispositions.ts:5`). One new operations file plus one line there covers
  REST, the schema and MCP together.
- **Scopes requested today contain no insight permission.** `META_SCOPES`
  (`src/providers/meta/oauth.ts:7`) is `pages_show_list, pages_manage_posts, pages_read_engagement,
  instagram_basic, instagram_content_publish`; Threads asks for `threads_basic,threads_content_publish`
  (`src/providers/threads/connect-group.ts:105`); `TIKTOK_SCOPES` is `user.info.basic,video.publish`
  (`src/providers/tiktok/config.ts:6`); `PINTEREST_SCOPES` is
  `user_accounts:read,boards:read,pins:write` (`src/providers/pinterest/oauth.ts:6`); `X_SCOPES` is
  `tweet.read tweet.write users.read media.write offline.access` (`src/providers/x/config.ts:6`).
- **`social_accounts` has no granted-scopes column** (`src/server/db/schema/accounts.ts:24-52`). What a
  platform actually granted is inspected once at connect and discarded into free-text notes — see
  `src/providers/x/connect-group.ts:72-74`. Nothing in the database can answer "may this account read
  insights?", which is why entry 2 has to persist it before any scoped reader can be enabled.
- **TikTok stores the wrong identifier for this purpose.** `src/providers/tiktok/publish.ts:439` returns
  `externalId: s.publishId` — the publish_id, which is not a video id. The real
  `publicaly_available_post_id` is read at line 438 and only ever lands in
  `publish_attempts.response_summary` (`src/server/db/schema/attempts.ts:45`).
- **Bluesky needs no new permission at all.** Its `externalId` is already the post's at-URI, and the
  public AppView serves counts without authentication, which is why it is the pilot platform in entry 1.

## Rules for every entry

- Must leave the repo working, and must say what it does **not** do and which later entry owns it.
- **Never sum or average a metric across platforms.** An Instagram "view", a TikTok "view" and a Threads
  "view" are different events, and Bluesky has none. One column per platform, labelled with that
  platform's own word. A metric the platform does not provide is **absent**, never rendered as zero.
- **Metrics are mutable, so store snapshots.** Never overwrite a single current value: a row is
  `(target or account, captured_at, metrics)`, and the UI always says what it is "as of".
- Every provider call goes through the existing per-account allowance machinery (`docs/limits.md`) with its
  own reserve, so polling can never consume the allowance a scheduled publish needs.
- **Park every task that needs a live OAuth consent screen, a real platform account or a browser at the
  very end of its entry's task list.** A judgement task in an early phase starves the implement loop.
- No secret, token or credential may reach a snapshot row, a log line or an API response. Extend
  `tests/integration/security/secret-scan.test.ts` rather than exempting anything from it.
- Schema changes ship as a committed migration from `pnpm db:generate`, with `pnpm db:check` green.

## 1. insights-core-bluesky — the subsystem, and the one platform that needs no permission

Build the whole read-and-store spine against the platform that cannot block it. Add `insights?` to
`SocialProvider` as **G30**: a declaration naming which metric keys this platform reports for a post and
for an account, with the same `unavailable: { reason, docsPath }` escape as `engagement`, plus
`readPostMetrics` and `readAccountMetrics` returning a discriminated result in the shape of
`EngagementReadResult` (`page` / `retryable_error` / `rate_limited` / `credentials_invalid` /
`fatal_error` / `unavailable`) so no new error vocabulary is invented.

Two snapshot tables via a committed migration: `post_metric_snapshots`
(`project_id`, `post_target_id`, `provider_key`, `captured_at`, `metrics` jsonb validated by the
provider's own schema, size-checked like `engagement_items.provider_data`) and `account_metric_snapshots`
(`project_id`, `social_account_id`, `captured_at`, `metrics`), both append-only through the DAL. Plus a
per-target poll state carrying `next_poll_at`, lease columns, `consecutive_failures` and `last_error`,
modelled on `engagement_account_states` with the same lease-pair check constraint.

The poll schedule decays, because a three-week-old post does not change: hourly for the first 24 hours,
daily to day 7, weekly to day 28, then frozen — pure functions, unit-tested, no clock reads inside them.
A new `runInsightsPoll` tick section with `INSIGHTS_*` config knobs mirroring `ENGAGEMENT_*` (page size,
targets per run, min interval, time share, retention days, prune batch), its own counts in `TickSummary`
and its own heartbeat so a starved section is visible rather than silent.

The Bluesky reader: `app.bsky.feed.getPosts` for `likeCount`, `repostCount`, `replyCount` and
`quoteCount` keyed by the at-URI already in `externalId`, and `app.bsky.actor.getProfile` for
`followersCount`, `followsCount` and `postsCount`. It must declare that Bluesky reports **no** views or
reach — the protocol has none — so the UI shows those as absent and never as zero. Give the `mock`
provider an `insights` module too, as the worked example and the fixture every scheduler test uses.

The only UI is a performance panel on `src/app/p/[projectSlug]/posts/[postId]/page.tsx`: the latest
snapshot per target, each number labelled with the platform's own word, an "as of" timestamp, and the
honest states — not yet polled, platform reports nothing, poll failing. Docs: a new `docs/insights.md`,
the G30 rows in `docs/adding-a-provider.md` and `docs/decisions.md`, and `docs/feature-map.md`.

Does **not**: touch any OAuth scope or request any new permission; add an API or MCP operation; draw any
chart, trend or comparison; or read any Instagram, Facebook, Threads, TikTok, Pinterest or X account.
Entry 2 adds the scope machinery and the Meta family, entry 3 the rest, entry 4 everything derived.

## 2. insights-reconnect-and-meta — persist what was granted, then read the Meta family

Two halves, in this order, because the second cannot be enabled without the first.

**Persist the grant.** Add a `granted_scopes` column to `social_accounts` (there is none today) written at
connect and at every refresh for each OAuth provider, and an `optionalScopes` declaration on the provider
so an insight permission is requested only where the operator wants it rather than widening every new
connection silently. Then the accounts page gains a real state: "Insights need a reconnect", carrying the
per-provider reason and a docs link, driven through the existing `unavailable { reason, docsPath }`
convention so a declared-but-unpermissioned surface is displayed and **never called**. Reconnecting an
account must not duplicate it — `social_accounts_external_uq` already keys on
`(project_id, provider_key, external_account_id)` — and must not lose its settings, publish-limit
overrides or posting instructions. An install that never reconnects keeps working exactly as before, with
insights absent for that account and no error anywhere.

**Then the three readers**, all on the Graph API the publish path already uses:
Instagram under `instagram_manage_insights` — `/{ig-media-id}/insights` for `views`, `reach`, `likes`,
`comments`, `saved`, `shares` and `total_interactions`, and `/{ig-user-id}/insights` for `reach`,
`follower_count` and profile views. `impressions` was removed by Meta in April 2025 and must not be
requested; `views` is the metric now. Facebook Pages under `read_insights` — post impressions, reactions
by type and clicks, plus page impressions, engagements and fans. Threads under
`threads_manage_insights` — media `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`, and the user
series plus `followers_count`.

Two platform specifics the generic schedule gets wrong. **Stories expire**: a target whose
`chosenPostType` is `story` (078) must be polled inside its 24-hour window and then frozen, because the
insight dies with the story. And **Meta's call limit is impressions-based**, already recorded in
`docs/research/meta.md` §Q5 — the budget for these polls has to respect it rather than a flat per-hour
count. Extend `docs/research/meta.md` with every metric name, its required scope and the 24-48h
processing delay, each with a source URL, before implementing.

Does **not**: TikTok, Pinterest or X (entry 3); any chart, trend or cross-platform comparison (entry 4).

## 3. insights-tiktok-pinterest-x — the remaining platforms, and an honest "no" for X

**TikTok**, under a `video.list` scope added through entry 2's `optionalScopes`: `/v2/video/query/`
returns `like_count`, `comment_count`, `share_count` and `view_count` for videos it first verifies belong
to the user, up to 20 ids per request — so the reader batches, and the poll claim must group by account.
`user.info.stats` covers follower, likes and video counts. This entry also carries a **repair**: TikTok's
`post_targets.externalId` is a publish_id, not a video id, so there is nothing to query with. Add a
dedicated column for the public post id; recover it for existing targets from
`publish_attempts.response_summary.publicPostIds` wherever attempt retention still holds it; write it
going forward at publish time from the status fetch (`src/providers/tiktok/publish.ts:438`); and for
targets where it is unrecoverable, show insights as unavailable for that post rather than guessing.

**Pinterest**, under `pins:read`: `GET /v5/pins/{pin_id}/analytics` with its required `start_date`,
`end_date` and `metric_types` (already recorded at `docs/research/pinterest.md:226`), plus
`/v5/user_account` for `follower_count` and `monthly_views` — which `user_accounts:read`, already held,
covers. Pin analytics need a business account, and a Trial app's content is invisible to anyone else
(`docs/research/pinterest.md:57`), so both become `unavailable` reasons with a docs link rather than a
confusing empty panel.

**X ships behind a priced opt-in, NOT as permanently unavailable.** `public_metrics` is reachable with
the `tweet.read` scope already in `X_SCOPES`, so this was never a permission problem — and the cost
objection in the first draft of this roadmap was computed at the wrong rate. Verified 2026-10-18 against
https://docs.x.com/x-api/getting-started/pricing: **Owned Reads — "requests made by your own developer
app for your own data (posts, bookmarks, followers, likes, lists, and more)" — cost $0.001 per resource**,
a fifth of the $0.005 standard Post read. Docket reading metrics for posts it published, on an account
the operator connected, is an owned read.

At that rate 100 posts a month on entry 1's decay schedule (~33 polls per post over 28 days) is ~3,300
resources, about **$3.30 a month**, and X grants new accounts "$20 in free X API credits when you save
your first eligible payment card" — roughly 20,000 owned reads. There is no free allowance otherwise,
and pay-per-usage is "capped at 3 million Post reads per monthly billing cycle".

So build the reader, keep it **off by default**, and gate it on an explicit env opt-in whose docs state
the per-read price and a worked monthly estimate: a self-hoster must consent to spending real money,
however small. Keep the conservative floor interval and a hard per-cycle cap — the live risk is a runaway
bill from a misconfigured schedule, not the unit price. With the opt-in off, declare `unavailable` with a
reason naming the metered read, link `docs/x-setup.md`, and make no call.

Two things stay unverified and belong in a parked human task rather than an assumption: whether
`public_metrics` on an owned post bills as one resource per post, and whether `non_public_metrics`
(impressions) is included at the owned rate. Both need a live call against a funded key. Record the
answers in `docs/research/x.md` with source URLs and the date.

Update `docs/tiktok-setup.md`, `docs/pinterest-setup.md` and `docs/x-setup.md` with the extra permission
each install must grant and what it gets for it.

Does **not**: add charts, trends or comparisons, and does not expose anything over the API or MCP — both
belong to entry 4.

## 4. insights-schedule-intelligence — the part only Docket can do

No new platform calls: this entry reads the snapshot history the first three accumulated and turns it into
the thing a native dashboard cannot give, because only Docket knows why a post went out when it did.

Account trends from `account_metric_snapshots` — follower and reach over time per account, per platform,
never summed. Per-post performance surfaced where the work happens: the project overview
(`src/app/p/[projectSlug]/(overview)/page.tsx`) and the posts list, not only the detail panel entry 1
added. Then the comparisons: performance by slot and by day of week (`post_targets.slotOccurrenceAt`,
`scheduleKind`), by series — evergreen (071) against date-pegged (072) — by voice profile, and
model-generated against hand-written. Plus time-to-first-engagement, joining the snapshot history to the
inbox rows 077 already stores.

Every comparison must state its own sample size and refuse to draw a conclusion from too few posts; a
chart over three posts is noise with axes. Follow `docs/design-system.md` and the project's chart
conventions, and keep each platform's series visually separate so the "never sum across platforms" rule
holds in the UI and not just the data layer.

One API operation in a new `src/server/api/operations/insights.ts`, registered in `OPERATIONS`
(`src/server/api/operations/index.ts:17`) with an explicit `mcp.expose` decision, which gives REST, the
OpenAPI document and the MCP tool list together. Retention and pruning of old snapshots join the existing
housekeeping section (`src/server/scheduler/housekeeping.ts`) with an `INSIGHTS_RETENTION_DAYS` knob —
aggregate before pruning, so a year-old trend survives the row that produced it.

Does **not**: add any provider reader, any new scope, or any new platform. Everything it needs landed in
entries 1-3.
