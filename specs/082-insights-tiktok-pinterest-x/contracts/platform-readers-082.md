# Contract — the three readers

Feature `082-insights-tiktok-pinterest-x`. Every endpoint, field, cap and limit below traces to a
CONFIRMED row in [research.md](../research.md) §1–§3. Nothing here was written from memory.

All three readers obey the 080/081 rules unchanged: never throw; map every failure to an existing
result kind; put every platform string through the provider's own scrubber before returning it;
return **no entry** for an id the response omitted (the generic layer leaves such a target due);
and never read a clock other than `ctx.now`.

---

## §1 TikTok (`src/providers/tiktok/insights.ts`)

### Post read — FR-020 … FR-025

| | |
|---|---|
| Call | `POST /v2/video/query/?fields=like_count,comment_count,share_count,view_count,id` |
| Body | `{ "filters": { "video_ids": [ …ctx.posts.map(p => p.externalId) ] } }` |
| Ids per call | **20** (`maxPostsPerRead: 20`), the documented cap; the existing batching splits a larger claim with no scheduler change (FR-021) |
| Identifier | `postIdSource: "publicPostId"` (G35) — so every id in the body is a video id, and every id belongs to the one account the call is made for |
| Scope | `postScopes: ["video.list"]` |
| Response | `{ data: { videos: [ { id, like_count, comment_count, share_count, view_count } ] } }` |
| Keys declared | `tiktok_like_count`, `comment_count`, `share_count`, `view_count` → Likes, Comments, Shares, Views — `like_count` is read from the response as-is but stored under `tiktok_like_count`: the raw name collides with X's declared `like_count` (FR-018, constitution V) |

**Per-id outcome**: for each requested id, `metrics` if the response carried a `videos` entry for
it; otherwise **one `unqueryable` entry** whose reason names both possibilities — "TikTok did not
return this post for this account; it may have been deleted, or the stored id may not be a video
id." No entry is invented for an id the response omitted *and* that Docket did not ask for
(FR-022). `id` is requested alongside the metrics precisely so entries can be matched back.

**Error mapping**, through the existing `inspect` (`src/providers/tiktok/http.ts`):

| `inspect` tag | Result |
|---|---|
| `expired`, or `access_token_invalid` | `credentials_invalid` |
| `rate` | `rate_limited`, `retryAt = now + r.ms` |
| `cap`, `transient`, `lost` | `retryable_error` |
| `refused` with `scope_not_authorized` | `unavailable`, reason naming `video.list`, `docsPath: "tiktok-setup#insights"` — this is the belt to the claim's braces: the SQL should already have excluded the account |
| `refused`, anything else | `fatal_error` |

### Account read — FR-023

`GET /v2/user/info/?fields=follower_count,likes_count,video_count`, scope
`accountScopes: ["user.info.stats"]`. Keys `tiktok_follower_count`, `likes_count`, `video_count` →
Followers, Likes, Videos — `follower_count` is read from the response as-is but stored under
`tiktok_follower_count`: the raw name collides with Instagram's and Pinterest's declared
`follower_count` (FR-018, constitution V). Same error table.

### Declaration

`readBudget: { count: 600, windowSeconds: 60 }` — the documented 600/min sliding window, recorded in
`docs/limits.md` as **per app token (PARTLY CONFIRMED)**, which makes the per-account declaration
deliberately permissive; `INSIGHTS_TARGETS_PER_RUN` and the reserve are the real protection (FR-026).

---

## §2 Pinterest (`src/providers/pinterest/insights.ts`)

### Post read — FR-030, FR-031, FR-034

| | |
|---|---|
| Call | `GET /v5/pins/{pin_id}/analytics?start_date=…&end_date=…&metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE` |
| Ids per call | **1** (`maxPostsPerRead: 1`) — the endpoint is per pin. `multi_pins-analytics` exists but its parameters are not researched, so it is not used |
| Identifier | `postIdSource: "externalId"` — Pinterest's pin id *is* the external id |
| Scope | `postScopes: ["pins:read"]` |
| Response | an object keyed by split; read `["ALL"]`, else the single value present, else no metrics. Take **`summary_metrics` only** |
| Keys declared | `IMPRESSION`, `PIN_CLICK`, `OUTBOUND_CLICK`, `SAVE` → Impressions, Pin clicks, Outbound clicks, Saves |

**The date window** — `pinterestAnalyticsWindow({ publishedAt, now })`, pure, total, no clock
inside it, unit-tested (FR-030):

```text
end   = UTC calendar date of `now`
start = max(UTC calendar date of `publishedAt`, end − 90 days)
```

- never in the future (`end` is today);
- never wider than the documented 90 days (`start` is clamped, so the `end − start ≤ 90d` rule
  holds automatically);
- `start ≤ end` always, because a published target's date is in the past;
- day-grained, because Pinterest's analytics are (research §2).

**`PINNER_DATA_ACCESS_DENIED`** (FR-031): HTTP 403 whose body `message` is that token →
`{ kind: "unavailable", reason: "Pinterest does not give Docket pin analytics for this account; it
needs a business account with pinner-data access.", docsPath: "pinterest-setup#insights" }`. Not
`credentials_invalid`, so **the account is never flagged**; `unavailable` already backs off through
`nextRetryAt` rather than retrying tightly. Matching a documented **message token** is a deliberate
exception to the publishing path's "status only, never a numeric code" rule — it lives in this file
only and is recorded in `docs/decisions.md`.

**Trial access** (FR-032): a pin whose analytics come back with no declared metric renders 080's
existing `nothing_reported` state, which the component already words as *"Pinterest reports no
numbers for this post."* plus *"As of <time>"* (`src/components/targets/PerformancePanel.tsx:94`).
The spec quotes it as "for this pin"; the shipped wording says "post" and **stays that way** —
making it say "pin" would mean branching the UI on a provider key, which constitution V forbids.
Not an error, not a zero. `docs/pinterest-setup.md` explains why a Trial app sees this.

**Other errors**: 401 → `credentials_invalid`; 429 → `rate_limited` with `retryAt` from
`x-ratelimit-reset`; 404 → `gone` for that pin; 5xx and network → `retryable_error`; other 4xx →
`fatal_error`. Every message goes through `scrubPinterest` and is capped at the existing 200
characters.

### Account read — FR-028, FR-029, FR-035

`GET /v5/user_account`, **`accountScopes: []`** — `user_accounts:read` is in `PINTEREST_SCOPES`
(`src/providers/pinterest/oauth.ts:6`) and every connected account granted it, so account snapshots
begin accruing with **no reconnect and no flag** (the entry's one intended behaviour change for an
install that sets nothing, spec FR-055). Keys `pinterest_follower_count`, `monthly_views` →
Followers, Monthly views; a field the response omitted is absent. `follower_count` is read from the
response as-is but stored under `pinterest_follower_count`: the raw name collides with Instagram's
declared `follower_count` (FR-018, constitution V).

An account whose stored `granted_scopes` is **null** still qualifies for the account surface
(`accountScopes` is empty, so there is nothing to check) and still does **not** qualify for pin
analytics (`@>` against a null array is never true). That is FR-035 exactly: Docket never infers a
grant it did not observe, and never withholds a surface that needs no grant.

### Declaration

`readBudget: { count: 1000, windowSeconds: 86_400 }` — the `org_read` **Trial** figure, because
every install starts there and the connection cannot reveal the app's tier (FR-033).

---

## §3 X (`src/providers/x/insights.ts`)

### Post read — FR-038, FR-042, FR-044

| | |
|---|---|
| Call | `GET /2/tweets?ids=<comma list>&tweet.fields=public_metrics` |
| Ids per call | **100** (`maxPostsPerRead: 100`), the documented 1–100 array length. Bounded in practice by `INSIGHTS_READ_PAGE_SIZE` (25) until an operator raises it |
| Identifier | `postIdSource: "externalId"` — X's post id *is* the external id |
| Scope | `postScopes: ["tweet.read"]` — **already in `X_SCOPES`**; no new scope is requested (FR-038) |
| Keys declared | `like_count`, `reply_count`, `retweet_count`, `quote_count`, `bookmark_count`, `impression_count` → Likes, Replies, Reposts, Quotes, Bookmarks, Impressions |
| Never requested | `non_public_metrics`, `organic_metrics`, `promoted_metrics` (FR-044) |

**Why `impression_count` is here and FR-044 is still obeyed**: it is a field of `public_metrics`,
not of `non_public_metrics` (research §3). Asking for `public_metrics` returns all six sub-fields;
there is no way to ask for five. Docket never names `non_public_metrics`.

**Per-id outcome**: X returns `data[]` for the ids it resolved and `errors[]` for the rest.
A `data` entry → `metrics`. An `errors` entry whose title/type is a not-found kind → **`gone`** for
that id (X does distinguish, unlike TikTok, so the spec's `gone` state is reachable here). Any id
in neither array → no entry, left due.

**Error mapping**, through `xRequest`/`readRate`/`problemText`:

| Condition | Result |
|---|---|
| 401, or a token-invalid problem | `credentials_invalid` |
| **429** | `rate_limited`, `retryAt` from `x-rate-limit-reset` — the time **X names** (FR-042) |
| 403 | `fatal_error` (a refusal that retrying will not fix) |
| 5xx, network | `retryable_error` |
| other 4xx | `fatal_error` |

Every message goes through `scrubX` and the existing 300-character cap. **No error string, snapshot
row or log line may contain a token or a bearer header** (FR-046) — enforced by
`tests/integration/x/no-secrets.test.ts`, extended to the reader.

### Account read — FR-043

```ts
async readAccountMetrics(): Promise<AccountMetricsReadResult> {
  return { kind: "unavailable", reason: X_ACCOUNT_UNPRICED, docsPath: "x-setup#insights" };
}
```

with `account: []`, so **the account claim never claims an X account at all** (G37) and the reader
above is unreachable belt-and-braces. The reason names the fact: X's per-user read price is not
confirmed to be the $0.001 owned rate, and an unverified billing assumption is not allowed to spend
the operator's money (research §3, FR-043).

### The opt-in and the ceiling

See [x-metered-reads.md](./x-metered-reads.md).

---

## §4 Test matrix every reader must satisfy (FR-051, SC-003)

Each row is one `*.test.ts` case per provider, **mocked HTTP only**, no live call:

| Case | Asserted |
|---|---|
| happy page | one snapshot per id; only declared keys stored; labels are the platform's own |
| a declared metric the response omitted | the key is **absent** from the stored metrics and from the panel — no row, no dash, no zero |
| an undeclared key in the response | dropped before storage (080's `filterToDeclared`, re-asserted) |
| an id the response omitted | no entry returned; the target stays due; no snapshot |
| rate limited | `rate_limited` with the platform's own `retryAt` where it gives one |
| credentials invalid | `credentials_invalid`; the account is flagged once, by the generic layer |
| run-time unavailable | `unavailable` with reason + `docsPath`; **persisted and rendered** (provider-insights-082 §5) |
| gone (Pinterest 404, X not-found error) | `gone`; target frozen; last snapshot kept |
| unqueryable (TikTok omission) | `unqueryable` with the two-possibility reason; frozen; last snapshot kept |
| fatal | `fatal_error`; counted; backed off |
| scrubbing | a token planted in the platform's error text does not appear in the returned string |
| batching (TikTok) | 25 due targets on one account → calls of **20** and **5**, every id in each call belonging to that account (SC-006) |
| three platforms on one post | `tests/integration/insights/four-platform.test.tsx`, extended: the rendered panel shows a block per platform, each under its own words, with **nothing summed, averaged or compared** (SC-009) |
