# Phase 0 — research

Feature: `082-insights-tiktok-pinterest-x` · Date: 2026-10-18 · Spec: [spec.md](./spec.md)

The spec opened with three `NEEDS RESEARCH` items (FR-001, FR-002, FR-003) and forbade writing a
reader before each was answered. All three are now answered well enough to implement, and the X
answer **changes the entry**: impressions are a *public* metric, so the thing FR-044 forbids is
narrower than the spec thought.

**Method, and its limit.** Every external fact below came from the phase's web search tool, which
returns result URLs plus a model summary of each page rather than the page text. That is the same
method and the same caveat `docs/research/meta.md` records for its 2026-10-07 section and
`specs/081-.../research.md` records for all of its rows, and it is weaker than reading the page. So
every row carries a confidence word and the spec's rule is applied as written:

> **FR-004: only a CONFIRMED row may be declared or requested.** A PARTLY CONFIRMED or NEEDS
> RESEARCH row is not declared, not requested, and not hoped for.

A wrong metric name is not a soft failure on these three platforms either. TikTok rejects an
unknown `fields` entry; Pinterest requires `metric_types` up front; X silently omits a field it
does not recognise. In all three cases a guess costs the whole surface, not one row.

---

## §1 TikTok — CONFIRMED enough to implement

**Scope `video.list`** — "read access to a user's public videos on TikTok". `user.info.stats` —
"read access to a user's statistical data, such as likes count, follower count, following count,
and video count". Both are separate, user-declinable scopes in TikTok's scope reference. CONFIRMED.
Source: <https://developers.tiktok.com/docs/en/tiktok-api-scopes>. Checked 2026-10-18.

**Post metrics — `POST /v2/video/query/`** (host `https://open.tiktokapis.com`), scope
`video.list`. "Given an authorized user and a list of video IDs, verifies that the videos belong
to the user and returns video details." **Up to 20 video IDs per request.** CONFIRMED.

- **Query parameter `fields`** (required): a comma-separated list drawn from the Video Object
  vocabulary — `id`, `create_time`, `cover_image_url`, `share_url`, `video_description`,
  `duration`, `height`, `width`, `title`, `embed_html`, `embed_link`, **`like_count`**,
  **`comment_count`**, **`share_count`**, **`view_count`**, `is_aigc`.
- **Request body `filters`** (required): `{ "filters": { "video_ids": ["7077642457847991554", …] } }`.
- **Response**: `{ "data": { "videos": [ { …requested fields… } ] }, "error": { "code": "ok",
  "message": "", "log_id": "…" } }`.
- **Metric types**: `like_count` int32, `comment_count` int32, `share_count` int32,
  `view_count` **int64**.
- **Rate limit**: **600 requests/minute**, one-minute sliding window; over it, HTTP 429 with error
  code `rate_limit_exceeded`. The number is CONFIRMED; that the 600 is counted **per application
  access token rather than per user** is PARTLY CONFIRMED (the summary says "a global limit for
  your application's access token"). Treated as per-app in `docs/limits.md`, which makes the
  per-account declaration deliberately permissive — see §5.

Sources: <https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query>,
<https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object>,
<https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit>,
<https://developers.tiktok.com/docs/en/display-api-overview>. Checked 2026-10-18.

**Account metrics — `GET /v2/user/info/`**, scope `user.info.stats`, field names
**`follower_count`**, **`likes_count`** ("the total number of likes received by the user across all
of their videos"), **`video_count`** ("the total number of publicly posted videos"). CONFIRMED.
(`following_count` is in the same scope and is not declared: it is not a measure of this account's
reach and the spec names three counts.) Sources: as above plus
<https://developers.tiktok.com/docs/en/tiktok-api-v1-user-info>.

**What is NOT confirmed, and what Docket does about it**

| Open question | Confidence | Posture |
|---|---|---|
| Is `publicaly_available_post_id` the same identifier as the Video Object `id` that `/v2/video/query/` accepts? | PARTLY CONFIRMED — TikTok calls it "the actual post ID … after moderation approves the content", never states the equality | **Ship it as a stated assumption** (§6) whose falsification is already an honest outcome: `/v2/video/query/` verifies ownership and simply omits an id it will not answer for, which the reader maps to `unqueryable` (FR-022). No number is ever invented. Parked live check. |
| Does `/v2/video/query/` answer for a **photo** post (`publish_photos`)? | NEEDS RESEARCH — the Video Object page documents videos only | No separate declaration, no guess. A photo target whose id the query omits freezes `unqueryable` with the same reason as any other omission (spec edge case). |
| Is the 600/min per app or per user token? | PARTLY CONFIRMED | Declared permissively per account; recorded as such in `docs/limits.md`. The real protection is `INSIGHTS_TARGETS_PER_RUN` and the reserve. |

---

## §2 Pinterest — CONFIRMED, including the date window the spec left open

**Post metrics — `GET /v5/pins/{pin_id}/analytics`**, scope `pins:read`. CONFIRMED.

- `start_date` (required, `YYYY-MM-DD`) **cannot be more than 90 days back from today**;
  `end_date` (required, `YYYY-MM-DD`) **cannot be more than 90 days past `start_date`**. This
  closes the spec's open item ("the exact maximum span allowed is a research item") and gives the
  pure window function its clamp (§6, FR-030).
- `metric_types` (required): an array of pin metric types.
- `app_types` (default `ALL`; enum `ALL`, `MOBILE`, `TABLET`, `WEB`), `split_field`
  (default `NO_SPLIT`).
- **Response shape**: an object **keyed by split** (`NO_SPLIT` + `app_types=ALL` yields a single
  `"ALL"` key), each value carrying three blocks:

  ```json
  { "ALL": {
      "summary_metrics": { "IMPRESSION": 240, "PIN_CLICK": 37, "OUTBOUND_CLICK": 20, "SAVE": 20,
                           "SAVE_RATE": 0.18, "QUARTILE_95_PERCENT_VIEW": 8, "VIDEO_MRC_VIEW": 20,
                           "VIDEO_START": 29, "VIDEO_10S_VIEW": 2, "VIDEO_AVG_WATCH_TIME": 2507.75,
                           "VIDEO_V50_WATCH_TIME": 10031 },
      "daily_metrics": [ { "date": "…", "data_status": "READY", "metrics": { … } } ],
      "lifetime_metrics": { "TOTAL_COMMENTS": 10, "TOTAL_REACTIONS": 12 } } }
  ```

Sources: <https://developers.pinterest.com/docs/api/v5/pins-analytics/>,
<https://developers.pinterest.com/docs/analytics-and-reports/organic-reporting/>. Checked 2026-10-18.

**Decision — which keys Docket declares.** `summary_metrics` only, and only its four
non-video counts: **`IMPRESSION`**, **`PIN_CLICK`**, **`OUTBOUND_CLICK`**, **`SAVE`**. These are
the four that mean something for every pin Docket publishes, image or video.

- **`SAVE_RATE` is excluded**: it is a derived ratio, and every derived view belongs to entry 4.
- **`VIDEO_*` and `QUARTILE_95_PERCENT_VIEW` are excluded**: whether naming a video metric in
  `metric_types` for an *image* pin is an error or merely absent is NEEDS RESEARCH, and the whole
  call is at stake. Declaring four keys that always answer beats eleven that might 400.
- **`lifetime_metrics` (`TOTAL_REACTIONS`, `TOTAL_COMMENTS`) is excluded**: whether those two need
  to appear in `metric_types` to be returned is NEEDS RESEARCH. Declaring a key that is always
  absent would be honest but useless; recorded as a gap in `docs/insights.md` instead.

**Account metrics — `GET /v5/user_account`**, scope `user_accounts:read`, already granted by every
connected Pinterest account. `follower_count` and `monthly_views` are already CONFIRMED in
`docs/research/pinterest.md:166-173` (together with `pin_count`, `following_count`, `board_count`,
which the spec does not ask for and this entry does not declare). No new research needed.

**The two refusals that become stated reasons, not empty panels** — both already in research:

- `PINNER_DATA_ACCESS_DENIED`: HTTP **403** with body
  `{"code": 403, "message": "PINNER_DATA_ACCESS_DENIED", "detail": "Your application does not have
  access to read pinner data…"}`, documented for `GET /v5/pins/{pin_id}` among others, for apps
  registered on or after 2026-09-14 reading a **non-business** account
  (`docs/research/pinterest.md:22-46`). Whether `/analytics` is on that list specifically is
  PARTLY CONFIRMED — the changelog names the pin *get*, not the pin *analytics* — so the reader
  matches the sentinel wherever it appears rather than assuming an endpoint list.
- **Trial access**: "All Pins and Boards created with Trial access are only visible to their
  creator as Sandbox entities" (`docs/research/pinterest.md:55-58`). Whether a Trial app's own pins
  return analytics **to their own creator** is NEEDS RESEARCH and is a parked live check; either
  way the panel's existing "reports no numbers … as of" state is the honest rendering (FR-032).

**Rate category**: `org_read` — Trial **1000/day/app**, Standard **1000/minute/user/app**
(`docs/research/pinterest.md:287`). The connection cannot tell Docket which tier the app is on, so
the declared budget takes the Trial figure (§5).

---

## §3 X — CONFIRMED, and the entry's recorded correction

**Post metrics — `GET /2/tweets`**, with `tweet.fields=public_metrics`. CONFIRMED.

- `ids` (required): **array length 1–100**, a comma-separated list of post ids. So
  `maxPostsPerRead: 100`, the largest in Docket.
- `public_metrics` carries **`retweet_count`**, **`reply_count`**, **`like_count`**,
  **`quote_count`**, **`bookmark_count`** and **`impression_count`**.
- **Rate limit**: 3,500 requests / 15 minutes per app, 5,000 / 15 minutes per user.
- Scope: no new one. `public_metrics` is reachable with `tweet.read`, already in `X_SCOPES`
  (`src/providers/x/config.ts:6`) — the spec's FR-038 holds.

Sources: <https://docs.x.com/x-api/posts/post-lookup-by-post-ids>,
<https://docs.x.com/x-api/fundamentals/metrics>,
<https://docs.x.com/x-api/fundamentals/data-dictionary>,
<https://docs.x.com/x-api/fundamentals/rate-limits>. Checked 2026-10-18.

### The correction: impressions are a *public* metric

X's metrics page separates four families, and the spec conflates two of them:

| Family | Auth | Fields | 30-day limit? |
|---|---|---|---|
| **Public** | Bearer token — any caller | `retweet_count`, `reply_count`, `like_count`, `quote_count`, `bookmark_count`, **`impression_count`** | No |
| Non-public | User context, owned posts only | `impression_count`, `url_link_clicks`, `user_profile_clicks`, `engagements` | Yes |
| Organic | User context, owned posts only | engagement metrics in an organic context | Yes |
| Promoted | User context, owned posts only | the same, promoted | Yes |

So **`public_metrics.impression_count` is a public field** and needs no `non_public_metrics`
request. **FR-044 is satisfied as written** — `non_public_metrics` is never requested — and
impressions still reach the panel, because they are in the field Docket already asks for. Asking
for `public_metrics` returns all six of its sub-fields; there is no way to ask for five.

This narrows **parked X billing question 2** rather than answering it: what stays unverified is
whether *`non_public_metrics`* (the `url_link_clicks` / `user_profile_clicks` / `engagements` set)
is included at the owned rate. Nothing in this entry depends on that answer any more.

### Account metrics: no owned-rate surface confirmed → `account: []`

Reads are priced "$0.005 per post, $0.010 per user", with Owned Reads at $0.001 per resource and
`GET /2/users/{id}/tweets` given as the owned example; `GET /2/users/me`'s cost is explicitly
**UNVERIFIED** in `docs/research/x.md:26`. A user read may therefore be a $0.010 standard read, ten
times the owned rate, and **FR-043 forbids spending the operator's money on an unverified rate**.
So X declares `account: []` and its account reader returns `unavailable` naming that reason — the
same posture 081 took for Threads account metrics. Confirmed-by-absence, not a guess.

### Pricing, re-verified

$0.001 per resource for Owned Reads, resources deduplicated per 24 h UTC day, post reads capped at
3 million per cycle, and "$20 in free X API credits when you save your first eligible payment card"
(promotional credits expire after 3 months). Already in `docs/research/x.md:19-41`, re-read
2026-10-18 against <https://docs.x.com/x-api/getting-started/pricing> — unchanged.

**Parked X billing question 1 stands**: whether `public_metrics` on a post the app itself published
bills as **one resource per post** at the owned rate. It needs one live call against a funded key
and a look at the developer console's usage. Until it is answered the ceiling is sized on the
assumption that it does (§4), which is the *pessimistic* reading for cost per post and therefore the
safe one for a ceiling.

---

## §4 What X actually costs, and how the ceiling is sized

**Reads per post over its life**, on 080's decay schedule (`src/lib/insights/schedule.ts`,
unchanged by this entry): hourly for the first 24 h = **23**; daily from day 1 to day 7 = **6**;
weekly from day 7 to day 28 = **3**; then frozen. **≈ 32 reads per post.**

| Posts/month | Resources/month | At $0.001 |
|---|---|---|
| 25 | ~800 | **$0.80** |
| 100 | ~3,200 | **$3.20** |
| 300 | ~9,600 | **$9.60** |

The spec's "~$3.30 a month for 100 posts" is confirmed by this arithmetic (it used 33 reads).

**The ceiling, expressed as the provider's read budget.** `checkInsightsAllowance`
(`src/server/scheduler/insights-budget.ts`) already refuses a read when
`writesStarted + postSnapshots + accountSnapshots` in the budget's window reaches
`reserveFloor(budget, INSIGHTS_READ_RESERVE)` = `floor(count × (1 − 0.5))` = **half the nominal
count**. So a monthly ceiling needs **no new enforcement path** — exactly as the spec assumed:

- `readBudget: { count: X_INSIGHTS_READ_CEILING, windowSeconds: 2_592_000 }` (30 days, X's billing
  cycle length).
- Default `X_INSIGHTS_READ_CEILING = 8000` → **realised ceiling 4,000 reads per account per 30
  days → $4.00 per account per cycle** at the owned rate, against a $20 promotional credit. That
  covers ~125 posts a month at full schedule fidelity before deferring.
- `docs/x-setup.md` states the **realised** figure ($4.00) and the nominal one, because the
  realised figure is what an operator is billed (FR-041, and the spec's own assumption that "the
  docs state the realised figure, not the nominal one").
- A per-account publish limit set by the operator can only make this *stricter*:
  `stricterBudget` compares rates and keeps the lower. That is existing 080 behaviour for every
  provider, and it is noted in `docs/limits.md` rather than changed here.

**Why a runaway bill is impossible even when the schedule is misconfigured.** Three independent
bounds, all already built: `INSIGHTS_POLL_MIN_INTERVAL_SECONDS` (the floor between two reads of one
post), `INSIGHTS_TARGETS_PER_RUN` (per tick), and the reserve above (per 30-day window). The
spec's FR-039/SC-005 test drives the tick past the ceiling and asserts *deferral*, which is the
third bound; the first is a property of the pure schedule and is already unit-tested in 080.

---

## §5 The three read budgets for `docs/limits.md`

| Provider | Declared `readBudget` | Source | Confidence |
|---|---|---|---|
| TikTok | `{ count: 600, windowSeconds: 60 }` | `/v2/video/query/` documented 600 req/min, sliding window | number CONFIRMED; **per-app rather than per-account** PARTLY CONFIRMED, so the per-account declaration is deliberately permissive and binds little on its own — `INSIGHTS_TARGETS_PER_RUN` and the reserve are the real protection |
| Pinterest | `{ count: 1000, windowSeconds: 86_400 }` | `org_read`, **Trial** tier: 1000/day/app (`docs/research/pinterest.md:287`) | CONFIRMED; the Trial figure is chosen because every new install starts there and the connection cannot tell Docket the app's tier. Standard is 1000/min/user/app, i.e. 1,440× more generous |
| X | `{ count: 8000, windowSeconds: 2_592_000 }`, env-overridable | not a platform rate limit at all — a **spend** ceiling derived in §4 | the price is CONFIRMED; the *default* is a judgement call recorded in `docs/decisions.md` |

X's row also carries the 3-million-post-read per-cycle platform cap, as FR-045 requires.

---

## §6 The decisions this research forces

1. **`unqueryable`, not `gone`, when TikTok omits an id.** `/v2/video/query/` returns the videos it
   verified and says nothing about the rest, so "deleted" and "this is not a video id" are
   indistinguishable in the response. Both are terminal, both keep the last snapshot, and the only
   difference is wording — so the reader returns one `unqueryable` entry whose reason names both
   possibilities, and FR-050's run-time reason carries it to the panel.
   **Recorded deviation from the spec**: its edge case says a deleted video "reports it gone". It
   cannot, without a per-id error TikTok does not send. Distinguishing them would need the target's
   capture history inside the read context — a generic change this entry is not chartered to make.
2. **The Pinterest window is `[max(publishedDate, today − 90d), today]` in UTC**, day-grained, pure,
   clock-injected. `end ≥ start` always holds because a published target's date is in the past; the
   90-day span cap holds automatically once `start` is clamped. Never in the future, never wider
   than Pinterest permits (FR-030).
3. **Pinterest's analytics response is read by split key**: prefer `"ALL"`, else the single value
   present, else no metrics. `summary_metrics` only.
4. **X declares six public metrics including `impression_count`**, and never names
   `non_public_metrics`, `organic_metrics` or `promoted_metrics` — the last three also carry a
   30-day availability limit that would make them absent for most of a post's polled life anyway.
5. **TikTok's two surfaces need two different scopes** (`video.list` for posts, `user.info.stats`
   for the account) and **Pinterest's need one and none**. That is not a special case: it is the
   general shape G37 exists for, and it is why a single `requiredScopes` list could not express
   this entry.

---

## §7 What remains open, and nothing depends on it

| # | Open question | Blocks? | Where it is declared |
|---|---|---|---|
| R1 | Does `publicaly_available_post_id` equal the Video Object `id`? | No — a wrong id surfaces as `unqueryable`, never as a number | Parked task; assumption stated in plan.md |
| R2 | Does `/v2/video/query/` answer for a photo post? | No — same `unqueryable` path | `docs/insights.md` gaps |
| R3 | Is TikTok's 600/min per app or per user? | No — the declaration is permissive either way | `docs/limits.md` |
| R4 | Do Pinterest's `lifetime_metrics` / `VIDEO_*` need requesting, and does a video metric on an image pin error? | No — neither is declared | `docs/insights.md` gaps |
| R5 | Does a Trial app's own pin return analytics to its creator? | No — "reports no numbers" is the honest state | Parked task; `docs/pinterest-setup.md` |
| R6 | Is `/analytics` among the endpoints that can answer `PINNER_DATA_ACCESS_DENIED`? | No — the reader matches the sentinel wherever it appears | Parked task |
| R7 | Does `public_metrics` on an owned post bill one resource per post at $0.001? | No — the ceiling assumes the pessimistic reading | Parked task; `docs/research/x.md` |
| R8 | Is `non_public_metrics` included at the owned rate? | No — never requested (FR-044) | Parked task |
| R9 | Is there an X account surface at the owned rate? | No — `account: []` with that reason (FR-043) | `src/providers/x/insights.ts` |

Every one of R1–R9 needs either a live platform account, a funded key, or page text this phase
cannot fetch. None of them is on the critical path, which is what FR-004 is for.

**This table is how SC-011 is met.** Every external fact this entry touches is either a CONFIRMED
row in §1–§3 — carrying its source URL and the date it was read, and copied into
`docs/research/{tiktok,pinterest,x}.md` before any reader is written (FR-001–FR-003) — or a row
above, published with the reason it is unconfirmed and the honest surface it ships as. **Nothing is
coded from memory or from an assumption that is not written down**, and the one design assumption
that is (R1) is stated in [plan.md](./plan.md), in §6.1 here, and in
[contracts/public-post-id.md](./contracts/public-post-id.md) §5, with a failure mode that produces
a stated reason rather than a number.
