# Phase 0 — research

Feature: `081-insights-reconnect-and-meta` · Date: 2026-10-17 · Spec: [spec.md](./spec.md)

The spec recorded five `NEEDS RESEARCH` items and two recorded disagreements with the roadmap.
This phase closes four of the five, opens two new ones that matter more than any of them, and
corrects three statements the spec makes about code that has since changed.

**Method, and its limit.** Every external fact below was obtained with the phase's web search tool,
which returns result URLs plus a model summary of each page rather than the page text. That is the
same method and the same caveat `docs/research/meta.md` already records for its "Limits
verification, 2026-10-07" section, and it is weaker than reading the page. So each row below carries
a confidence word, and the rule the whole entry turns on (spec FR-003) is applied strictly:

> **Only a row marked CONFIRMED may be declared or requested. A row marked PARTLY CONFIRMED or
> NEEDS RESEARCH is not declared, not requested, and not hoped for.**

A metric name is not a soft fact for this feature. Meta's insights endpoints reject an unknown or
deprecated metric with an error that fails **the whole call**, not just that metric — so a single
wrong name in a declared list silently costs every other number on that surface. That is why the
conservative rule above is worth its cost here and would not be elsewhere.

---

## §1 Instagram — CONFIRMED enough to implement

**Endpoint**: `GET /{ig-media-id}/insights?metric=…` for a post;
`GET /{ig-user-id}/insights?metric=…&period=day` for the account.
Source: <https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights>,
<https://developers.facebook.com/docs/instagram-platform/insights/>. Checked 2026-10-17.

**Permissions**. Docket connects Instagram through Facebook Login (`docs/research/meta.md`
§"Login path — decision: Facebook Login for Business"), so the documented permission set for that
path applies: **`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`**. Docket's
`META_SCOPES` already requests `instagram_basic` and `pages_read_engagement`
(`src/providers/meta/oauth.ts:7-13`), so **`instagram_manage_insights` is the only scope this entry
has to add** for Instagram. (The `instagram_business_*` names in the same document belong to the
Instagram-Login path, which Docket does not use — do not mix the two sets.) CONFIRMED.
Source: as above.

**Post metrics — CONFIRMED**, and they are exactly the roadmap's list:

| Key | Label (Instagram's own word) | Notes |
|---|---|---|
| `views` | Views | The documented replacement for `impressions` |
| `reach` | Reach | Unique accounts that saw it at least once |
| `likes` | Likes | Organic only |
| `comments` | Comments | Organic only |
| `saved` | Saved | Times saved by an Instagram user |
| `shares` | Shares | |
| `total_interactions` | Interactions | likes + saves + comments + shares, minus undos |

**Processing delay — CONFIRMED: up to 48 hours.** "Data used to calculate metrics can be delayed up
to 48 hours." Organic only: interactions on ads containing the media are not counted. This is what
makes "absent, never zero" the correct presentation on an early read, not a bug (spec edge cases).

**`impressions` is an error, not an omission — CONFIRMED, with a date.** Graph API v22.0 deprecated
`impressions` on media **and** user insights "applying to all versions April 21, 2025"; requests for
media created on or after 2024-07-02 **return an error** after that date. `views` is the documented
replacement. Three more names are deprecated with it and must be prohibited for the same reason:
**`clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `plays`**.
Source: <https://developers.facebook.com/docs/graph-api/changelog/version22.0/>. Checked 2026-10-17.
→ This is spec constraint 2 and FR-004, now with an official citation and a wider prohibition list.

**Account metrics — CONFIRMED for three, with `period=day`**: `reach`, `follower_count`
(new followers per day; at most 30 days of history), `profile_views`. User metric data is retained
90 days. A user-level `views` metric also exists as the `impressions` replacement, but its required
`period`/`metric_type` combination was not captured → **NEEDS RESEARCH**, not declared (R1 below).
Source: <https://developers.facebook.com/docs/instagram-platform/insights/>.

**Batching — NOT DOCUMENTED, so `maxPostsPerRead: 1`.** `/insights` is a per-media edge; no
`ids`-style batch parameter appears anywhere in the Instagram insights or IG Media reference. Absence
of documentation is not proof of absence, so this is recorded as a confirmed-negative-by-absence and
the safe number is declared. This closes the spec's `NEEDS RESEARCH` #2 as the spec itself predicted
("Non-blocking: `1` is the safe default").

**Stories — CONFIRMED, and it is 24 hours.** "Story media metrics are only available for 24 hours."
The documented way to get them before they expire is a `story_insights` webhook subscription; data may
also survive if the story is added to a Highlight. Docket has no webhook ingestion for Instagram and
this entry adds none, so the polling window **is** the 24 hours, which is exactly what G34 declares.
Source: <https://developers.facebook.com/docs/instagram-platform/insights/>. Checked 2026-10-17.
This closes the spec's `NEEDS RESEARCH` #3 and fixes Instagram's `ephemeralPostTypes` lifetime at
24 h with a source.

---

## §2 Facebook Pages — the entry's biggest finding: the roadmap's metric names are **deprecated**

This is the one place the research does not merely fill a gap but **overturns the brief**, and
constitution I says the research wins (spec FR-005).

**Endpoint and permission — CONFIRMED.** `GET /{page-post-id}/insights?metric=…` for a post,
`GET /{page-id}/insights?metric=…&period=…` for the Page. Page insights need **`read_insights` and
`pages_read_engagement`**, *and* a Page access token held by a person who can perform the **`ANALYZE`
task** on that Page. Without `read_insights` the endpoint answers with an **empty dataset**, not an
error. Docket already requests `pages_read_engagement`, so **`read_insights` is the only scope to
add** for Facebook.
Sources: <https://developers.facebook.com/docs/graph-api/reference/insights/>,
<https://developers.facebook.com/docs/platforminsights/page/>,
<https://developers.facebook.com/docs/permissions>. Checked 2026-10-17.

→ Two consequences the spec did not know:
1. **The `ANALYZE` task is a third precondition Docket cannot see in `granted_scopes`.** An account
   may hold `read_insights` and still get nothing, because the connecting person lacks `ANALYZE` on
   that Page. `docs/research/meta.md` §5 already records a required-Page-task constraint for
   Instagram; this is its Pages analogue. Eligibility (G33) therefore answers "may Docket call?",
   never "will Docket get numbers?" — and an empty answer must present as `nothing_reported`
   (080's existing state), never as a failure. Recorded as a named gap, no code.
2. **An empty dataset is the documented symptom of a missing permission.** So "declared and
   permitted but returning nothing" is indistinguishable at the wire from "permitted and genuinely
   zero activity". 080's `nothing_reported` already says exactly that honestly.

**The metric names in the roadmap and in spec FR-030 are deprecated — CONFIRMED, twice over.**

Meta's Page Insights deprecation, announced 2025-08-15 and effective **2025-11-15** — eleven months
before today — removed the impressions and fans families and states that after deprecation "the API
will return an **invalid metric error** when calling any of these metrics":

| Roadmap / FR-030 name | Status since 2025-11-15 | Documented alternative |
|---|---|---|
| `post_impressions` | **deprecated — errors** | `post_media_view` |
| `page_impressions` | **deprecated — errors** | `page_media_view` |
| `page_fans` | **deprecated — errors** | `page_follows` |
| `post_impressions_paid` / `_fan` | deprecated | `post_media_view` + breakdown |
| `page_impressions_paid` / `_viral` / `_nonviral` | deprecated | `page_media_view` + breakdown |

Source: <https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/>,
<https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics>.
Checked 2026-10-17.

**And the replacements are themselves mid-migration — PARTLY CONFIRMED, which is worse.**
`page_media_view` and `post_media_view` are documented (periods day/week/days_28 for the Page,
lifetime for the post; breakdowns `is_from_ads`, `is_from_followers`) **but are flagged for
deprecation as part of Graph API v25.0**, with a "Page Viewer Metric" planned "by the end of June
2026" exposed as `GET {page-id}/insights/page_total_media_view_unique` and
`GET {post-id}/insights/post_total_media_view_unique`, replacing the legacy reach concept.
Sources: <https://developers.facebook.com/docs/graph-api/reference/insights/>,
<https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25>.
Checked 2026-10-17.

Docket runs **v26.0** (`src/providers/meta/config.ts:3`) and today is **2026-10-17**, i.e. past both
the November 2025 removal and the June 2026 replacement date. The search summaries cannot tell me
which of `post_media_view` and `post_total_media_view_unique` actually answers on v26.0 today, and
guessing costs the whole surface.

**Decision — Facebook ships with the metrics that are on no deprecation list, and the views family
waits.** Declared post keys: **`post_reactions_by_type_total`** ("Reactions", reactions broken out by
type, lifetime) and **`post_clicks`** ("Clicks", lifetime) — both documented, neither on any
deprecation list. Declared account keys: **`page_post_engagements`** ("Engagements", day/week/days_28)
and **`page_follows`** ("Follows", the documented replacement for `page_fans`). The whole
views/impressions/reach family for Pages is **NEEDS RESEARCH** (R2) and is **not declared**.

This satisfies FR-030's *shape* — post reactions broken out by type and clicks; Page engagements and
fans-as-follows — while refusing its two deprecated names. It is a smaller Facebook surface than the
roadmap imagined and it is the only honest one available today. FR-005 requires the disagreement be
recorded in `docs/research/meta.md` **and** `docs/decisions.md`; it is the first item of both.

**Prohibition list for Facebook, mirroring FR-004's for Instagram** (a wrong name here is an error
that loses `post_clicks` too, so the prohibition is enforced by test, not comment):
`post_impressions*`, `page_impressions*`, `page_fans*`, `page_posts_impressions*`, and — until R2 is
answered — `post_media_view`, `page_media_view`, `post_total_media_view_unique`,
`page_total_media_view_unique`.

**An unexpected gift to the roadmap's hardest rule.** Facebook's surviving views metric, whatever it
turns out to be called, is a *views* metric, and Instagram's is `views`, and Threads' is `views`.
After this entry, three platforms will label a metric "Views" and mean three different events —
Facebook counts a play-or-display including ads, Instagram counts organic plays, Threads counts daily
totals. The roadmap's "never sum across platforms" rule stops being an abstract principle and becomes
the thing standing between the panel and three identically-named, incomparable numbers. The structural
answer is unchanged and is already enforced by 080 (no metric-key constant outside a provider folder),
but it now has teeth, and FR-034's disjointness test should assert the *labels* collide while the
*keys and providers* stay separate — rather than asserting labels are unique, which they are not.

---

## §3 Threads — permission CONFIRMED, metric names PARTLY CONFIRMED

**Permission — CONFIRMED.** `threads_manage_insights` "allows your app to get access to insights for
a Threads profile", with allowed usage covering both profile-level insights and insights for
individual threads published by that profile. Docket requests only
`threads_basic,threads_content_publish` today (`src/providers/threads/connect-group.ts:105`), so
**`threads_manage_insights` is the one scope to add**.
Sources: <https://developers.facebook.com/documentation/development/permissions>,
<https://developers.facebook.com/documentation/threads>. Checked 2026-10-17.

**Endpoints — CONFIRMED to exist**, documented at
<https://developers.facebook.com/documentation/threads/insights>, with a documented split into
per-post media insights and account-level user insights — the same two surfaces 080's
`InsightsDeclaration` already has (`post` and `account`).

**Post metric names — PARTLY CONFIRMED.**
`GET /{threads-media-id}/insights?metric=views,likes,replies,reposts,quotes` is corroborated by
several independent third-party integration guides, which agree on
**`views`, `likes`, `replies`, `reposts`, `quotes`**, on `graph.threads.net` as the host (which
matches Docket's existing Threads transport), and on "most metrics return lifetime totals, though
`views` pulls in daily totals". The official page's own metric enum was **not captured**. Third-party
agreement is corroboration, not an official source, so under FR-003 these are **not declared yet**.

**`shares` is not corroborated at all.** FR-031 lists it from the roadmap; no source found names it
on the Threads media insights edge. It is dropped from the declared list and recorded as NEEDS
RESEARCH (R3) — a recorded, minor disagreement with the roadmap.

**Account metric names — PARTLY CONFIRMED and easily confused.** The Threads *profile* edge
(`/{threads-user-id}?fields=…`) exposes `follower_count`, and 7-day counters `likes_count`,
`quotes_count`, `reposts_count`, `views_count`. These are **profile fields, not insight metrics**,
and they are not the `user_insights` metric enum. Declaring a profile field as an insights metric key
would be a category error that happens to half-work, which is worse than not shipping it.
Source: <https://developers.facebook.com/documentation/threads/threads-profiles>.

**Rate limit — already CONFIRMED in `docs/research/meta.md` §Q5** and unchanged: "Calls within 24
hours = 4800 × Number of Impressions", with a documented **impression floor of 10** → a conservative
declared floor of **48 000 per 24 h**, the only one of the three surfaces whose floor is documented
rather than invented.

**Decision — Threads is the surface most likely to ship `unavailable`, and that is a working
outcome.** The implement phase does, in order: (a) write the §3 table into `docs/research/meta.md`
with its confidence words; (b) if it can confirm the media-insights metric enum from the official
page, declare `views, likes, replies, reposts, quotes` and build the post reader; (c) if it cannot,
ship `src/providers/threads/insights.ts` **declared `unavailable`** with a reason naming the gap and
a link, which costs one small file and zero risk, and which FR-003 explicitly blesses. The account
surface stays undeclared either way (`account: []`).

Threads is therefore the cleanest test of FR-003 in the entry: a reader that ships honestly absent.

---

## §4 The impressions-based budget, and why the declared floor does almost nothing

Three layers, as the spec decided. What the research adds is how little layer 2 is worth, which is
better said now than discovered in review.

**Layer 1 — the per-account reserve, unchanged.** `checkInsightsAllowance`
(`src/server/scheduler/insights-budget.ts`) takes
`stricterBudget(providerBudget, accountPublishLimit)` and refuses a poll once the window's usage
reaches `reserveFloor(budget, readReserve)`.

**Layer 2 — the declared `readBudget` floor.** Threads: 4800 × 10 = **48 000 / 86 400 s**, sourced
(§Q5). Facebook Pages (§Q1: 4800 × engaged users, **no documented floor**) and Instagram (§Q2:
4800 × impressions, **no documented floor**): the same 48 000 / 86 400 s as an **interim,
UNVERIFIED** stand-in, marked as such in `docs/limits.md` exactly as 080's Bluesky row is.

**The honest limitation, stated plainly.** 48 000 in 24 hours is three orders of magnitude above
anything this subsystem does — `INSIGHTS_TARGETS_PER_RUN` is 50 and `maxPostsPerRead` for Instagram
is 1 — so `reserveFloor(48000, 0.5) = 24000` will never be reached. **Layer 2 therefore binds
nothing on its own.** Layer 1 only bites where `stricterBudget` picks the *account's* publish limit
instead, i.e. where the operator set a per-account publish override. So:

- SC-008 ("a publish is never deferred by a poll") is really delivered by `stricterBudget` choosing
  the account's own publish limit when one is set, plus the fact that insights only ever **reads**
  and the section is bounded by its time share and its per-run caps.
- The actual protection against Meta's impressions-based limit is **layer 3**, the live header.
- This is not a defect to fix here — a made-up smaller number would be a fiction with the same
  shape — but it must be written down, because a reader of `docs/limits.md` would otherwise believe
  the 48 000 row is doing work. Recorded for `docs/decisions.md` and in the limits row's own note.

**Layer 3 — the live signal, and the one transport change it needs.** `X-Business-Use-Case-Usage` is
keyed by object id and carries `call_count`, `total_cputime`, `total_time` (percentages) plus
`estimated_time_to_regain_access` in minutes (`docs/research/meta.md` §Q6, CONFIRMED). **Docket
cannot see it today**: `send()` in `src/providers/meta/graph.ts` reads `res.status` and the body and
discards `res.headers` entirely, and `GraphOutcome` has no field for it. So layer 3 needs a real,
small change to the shared Graph transport — see
[contracts/meta-usage.md](./contracts/meta-usage.md) for the shape, which deliberately carries
**only two integers** out of the header so FR-048 (no header value that could carry a token) is
satisfied by construction rather than by scrubbing.

---

## §5 Three corrections to the spec, from reading the code it cites

The spec was written against `main` as it was; two of its statements are now stale and one is a
mis-reading. None changes a requirement, and all three *reduce* the work.

1. **Graph codes 80001 and 80002 are already rate-limited, with a test.** The spec's constraint list
   and FR-046 say `src/providers/meta/errors.ts` "treats only `[4, 17, 32, 613]` as rate-limited, so
   80001 and 80002 are missing today". They were added in commit `3a2626c`
   ("fix(meta): treat business use case throttles 80001 and 80002 as rate limits"):
   `GRAPH_ERROR_TABLE.rateLimited` is `[4, 17, 32, 613, 80001, 80002]`
   (`src/providers/meta/errors.ts:8`) and `src/providers/meta/errors.test.ts:22` asserts each.
   **FR-046 is already satisfied on the Meta side.** What remains of it is genuinely small:
   - the Threads path already reuses the same table (`src/providers/threads/oauth.ts` `failure()`
     tests `GRAPH_ERROR_TABLE.rateLimited`), so FR-046's "the equivalent check MUST be applied on
     the Threads path" is already done;
   - `docs/research/meta.md` §Q6 and its "Code impact" list still *assert the gap exists*, and
     `docs/limits.md:285` already contradicts them ("already in the rate-limited set"). The research
     note is simply out of date and must be corrected in this entry — otherwise the next entry
     re-discovers a fixed bug. **That correction is the real remaining FR-046 task.**
2. **`unavailable` does not stop a post-metric poll from being retried forever.** Reading
   `commitPostBatch` (`src/server/scheduler/insights-poll.ts`): the `unavailable` arm increments
   `counts.unavailable` and then falls through to `releaseTarget` **without touching `nextPollAt`**,
   so the target stays due and is re-claimed next tick. For 080 that was unreachable (a provider
   declaring `unavailable` is filtered out before the claim, `insights-poll.ts:67-70`), so it was
   harmless dead code. This entry makes a *per-read* `unavailable` reachable for the first time.
   Handled in the design rather than left: see
   [contracts/scheduler-insights-081.md](./contracts/scheduler-insights-081.md) §4.
3. **`fatal_error` is not fatal to a poll.** The same arm treats `retryable_error` and `fatal_error`
   identically — both back off and retry. So a permanently wrong metric name would retry on the
   decaying schedule for 28 days, showing `failing` with Meta's own message on the panel. That is
   visible and actionable, so it is accepted rather than redesigned (a fifth result kind is entry
   4's business if it ever matters) — but it is the second reason the "only CONFIRMED metrics are
   declared" rule is load-bearing and not merely tidy.

---

## §6 Per-account eligibility: one predicate, two expressions, and a test that pins them together

Spec constraint 3 is the entry's hardest design problem: `declaration.unavailable` is static per
provider, the grant is per account, and FR-023 requires ineligibility to be enforced **in the claim**
so an unpermissioned account is never leased or decrypted.

**The predicate.** An account is eligible for provider *p* when *p* declares `insights` without a
blanket `unavailable`, **and** either `p.requiredScopes` is empty, **or**
`granted_scopes IS NOT NULL AND granted_scopes @> p.requiredScopes`.

**Why a `text[]` column and not `jsonb`.** `@>` on `text[]` is a plain containment check with a GIN
index behind it; the same test in `jsonb` would be `?&` over a different operator class, and the
array is also what makes the per-element CHECK writable (data-model §1). The spec decided this; the
research confirms the SQL exists and indexes.

**Why the claim takes a list of declarations, not a list of provider keys.**
`claimDuePostMetricPolls` and `claimDueAccountMetricPolls` take `providerKeys: readonly string[]`
today. They now need, per provider, the required scopes *and* (for the lazy insert, FR-041) the
ephemeral post types. The DAL must not import the provider registry — `insights-claims.ts` imports
only `../../lib/insights/schedule` — so the scheduler passes the whole thing down as one
`providers: readonly InsightsProviderRule[]` argument. Provider knowledge stays in the registry, the
SQL stays in the DAL, and nothing new crosses the seam.

**The drift risk, named.** The same rule is now written twice: once as SQL inside the claim, once as
the pure `insightsPermissionFor()` that the panel and the accounts page use. They can disagree, and
if they do, Docket will show "numbers are coming" for an account it never calls — the exact
invisible-failure mode 080's visibility work exists to prevent. The design's answer is **not** to
share code (the SQL cannot call the function) but to pin them with one integration test over a
matrix of accounts — null grant, empty grant, partial grant, exact grant, superset grant, each
against a provider with zero / one / two required scopes — asserting that *claimed* and
*`insightsPermissionFor` says ok* agree on every cell. That test is the contract between the two
expressions, and it is the single most valuable test in the entry.

---

## §7 Open `NEEDS RESEARCH`, carried into `docs/research/meta.md`

| # | Question | Blocks | Fallback taken |
|---|---|---|---|
| **R1** | Instagram user-level `views`: required `period` / `metric_type`? | One IG account key | Not declared; `reach`, `follower_count`, `profile_views` are |
| **R2** | **Which Pages views/reach metric answers on v26.0 today** — `post_media_view`, `post_total_media_view_unique`, or neither? | Facebook's whole views family | Not declared; reactions-by-type and clicks are |
| **R3** | Threads media-insights metric enum from the official page; does `shares` exist? | Threads post reader | §3 decision: declare the corroborated five if confirmable, else ship `unavailable` |
| **R4** | Threads `user_insights` metric enum (not the profile fields) | Threads account surface | `account: []` |
| **R5** | Documented minimum call-budget floor for Pages (§Q1) and Instagram (§Q2)? | Nothing | 48 000 / 24 h interim, marked UNVERIFIED (§4) |
| **R6** | Does Pinterest's token reply carry a `scope` field? | Nothing | `granted_scopes` stays `NULL` for Pinterest; entry 3 picks it up |

R2 is the one worth a human minute: it is answerable in thirty seconds in Graph API Explorer against
a real Page, and it is parked with the other live checks at the very end of `tasks.md`. R5 and R6 are
the spec's #4 and #5, unchanged. The spec's #1, #2 and #3 are closed by §1–§3 above.

**Nothing in the first half of the entry depends on any of these.** The column, the two declarations,
the eligibility predicate, the claim change, the panel states, the accounts-page line, the ephemeral
schedule, the usage header, the counts, the security scan and every doc are all reachable now — which
is exactly the sequencing the spec's "Facts recorded against the research notes" §1 predicted
("**Blocking for the readers only**").

---

## §8 Resolution of every unknown the Technical Context could have marked

| Unknown | Resolution |
|---|---|
| New runtime dependency? | **None.** Graph transport, Zod, Drizzle, Vitest all present |
| New infrastructure? | **None.** No queue, no Redis, no advisory lock, no second deployable |
| New tick section? | **No.** `runInsightsPoll` gains counts and an eligibility argument |
| New table? | **No.** One column on `social_accounts`, one widened CHECK on `post_metric_poll_states` |
| New enum type? | **No.** `frozen_reason` is a text CHECK precisely so this entry can widen it (080 decision 3) |
| New permission in `access.ts`? | **No** — spec decision; the panel stays `post: ["view"]`, the accounts line follows the page's existing `canManage` |
| New API / MCP / OpenAPI surface? | **No.** `OPERATIONS` untouched, so the enumerated-surface tests need no edit |
| Does any provider need a new HTTP client? | **No.** Instagram and Facebook use `graphRequest`; Threads uses its own existing Graph transport |
| How does the panel learn the grant? | `getPostView` already loads the account; it gains `grantedScopes` and calls the one pure helper |
| Migration count | **One**, covering the column, its CHECKs, its GIN index and the widened `frozen_reason` |
| Does anything need the npm registry? | **No** (constitution VI, `docs/decisions.md` #19) |

Every `NEEDS CLARIFICATION` the Technical Context could have carried is resolved. Six
`NEEDS RESEARCH` rows remain open; each is published as unverified, each has a stated fallback, and
**no requirement, default or test depends on an unanswered one** — which is the condition
constitution I sets for proceeding.

## Sources

- <https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights>
- <https://developers.facebook.com/docs/instagram-platform/insights/>
- <https://developers.facebook.com/docs/graph-api/changelog/version22.0/>
- <https://developers.facebook.com/docs/graph-api/reference/insights/>
- <https://developers.facebook.com/docs/platforminsights/page/>
- <https://developers.facebook.com/docs/permissions>
- <https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/>
- <https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics>
- <https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25>
- <https://developers.facebook.com/documentation/development/permissions>
- <https://developers.facebook.com/documentation/threads>
- <https://developers.facebook.com/documentation/threads/insights>
- <https://developers.facebook.com/documentation/threads/threads-profiles>
