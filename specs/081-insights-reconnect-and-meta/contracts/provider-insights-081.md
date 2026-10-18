# Contract — the three readers, G34 ephemeral post types, and the ephemeral schedule

[plan.md](../plan.md) · [research.md](../research.md) · FR-029 … FR-043

**The governing rule, from research §1–§3 and FR-003:** only a metric marked **CONFIRMED** in
`docs/research/meta.md` is declared or requested. The tables below are what that rule yields today.
A metric that becomes confirmable later is one line in a provider folder, not a redesign.

---

## §1 Instagram — `src/providers/instagram/insights.ts`

```ts
requiredScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
missingScopes: {
  reason: "Instagram needs the instagram_manage_insights permission before Docket can read its numbers.",
  docsPath: "meta-setup#insights",
},
maxPostsPerRead: 1,
readBudget: { count: 48_000, windowSeconds: 86_400 },   // interim, UNVERIFIED (research §4)
ephemeralPostTypes: [{ postType: "story", lifetimeMs: 86_400_000 }],
```

All three required scopes are the documented set for the Instagram-API-with-Facebook-Login path
(research §1). Two of them are already in `META_SCOPES`, so in practice only
`instagram_manage_insights` is new — but declaring all three is what makes the eligibility test
trace to a research row rather than to an assumption about what else was granted.

**Post keys** — `GET /{ig-media-id}/insights?metric=…`, one media per call:

| Key | Label |
|---|---|
| `views` | Views |
| `reach` | Reach |
| `likes` | Likes |
| `comments` | Comments |
| `saved` | Saved |
| `shares` | Shares |
| `total_interactions` | Interactions |

**Account keys** — `GET /{ig-user-id}/insights?metric=…&period=day`: `reach` → "Reach",
`follower_count` → "New followers", `profile_views` → "Profile views". User-level `views` is **not**
declared (research R1).

**The prohibition (FR-004), enforced by test, not by comment.** One exported constant is the single
source of both the declaration and the request:

```ts
export const INSTAGRAM_POST_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"] as const;
export const INSTAGRAM_PROHIBITED_METRICS = ["impressions", "plays", "clips_replays_count", "ig_reels_aggregated_all_plays_count"] as const;
```

Tests assert that no prohibited name appears in `INSTAGRAM_POST_METRICS`, in the account list, in
`declaration.post`/`declaration.account`, **or in any request the reader records against mocked
HTTP** — the last is the one that catches a hand-built query string. Each prohibited name has an
official deprecation citation in research §1, so this is a sourced prohibition rather than caution.

## §2 Facebook — `src/providers/facebook/insights.ts`

```ts
requiredScopes: ["pages_read_engagement", "read_insights"],
missingScopes: {
  reason: "A Facebook Page needs the read_insights permission before Docket can read its numbers.",
  docsPath: "meta-setup#insights",
},
maxPostsPerRead: 1,
readBudget: { count: 48_000, windowSeconds: 86_400 },   // interim, UNVERIFIED (research §4)
// no ephemeralPostTypes: Facebook Page Stories are out of scope by the constitution
```

**Post keys**: `post_reactions_by_type_total` → "Reactions", `post_clicks` → "Clicks".
**Account keys**: `page_post_engagements` → "Engagements", `page_follows` → "Follows".

**The views/impressions family is deliberately absent, and this is the entry's headline research
finding.** `post_impressions`, `page_impressions` and `page_fans` — the names in the roadmap and in
FR-030 — were deprecated on 2025-11-15 and now return an invalid-metric error; their documented
replacements `post_media_view` / `page_media_view` are themselves flagged for deprecation in v25.0
with a viewer metric planned for June 2026, and which of them answers on v26.0 today could not be
confirmed (research §2, R2). Declaring an unconfirmed name would not cost just that metric: an
invalid metric fails **the whole call**, so it would also lose `post_clicks`. FR-005 requires the
disagreement in `docs/research/meta.md` and `docs/decisions.md`; R2 is parked as a live check.

`FACEBOOK_PROHIBITED_METRICS` covers `post_impressions*`, `page_impressions*`, `page_fans*`,
`page_posts_impressions*` and — until R2 is answered — the four `*media_view*` names, tested exactly
as Instagram's are.

**The unqueryable-id rule (FR-036).** A Page *post* id is `{page-id}_{post-id}`; a Reel publishes a
bare video id (`src/providers/facebook/publish.ts:278` returns `externalId: state.videoId`). The
reader classifies before calling:

```ts
const PAGE_POST_ID = /^\d{1,40}_\d{1,40}$/;
// else, a bare /^\d{1,40}$/ is a video id from the Reel path
```

and returns, **without issuing a request for that id**:

```ts
{ externalId, kind: "unqueryable",
  reason: "This Reel was published as a video id, which Facebook's post insights cannot read." }
```

Terminal, counted on its own, never a failure. An id matching neither pattern gets the same outcome
with a reason naming it as unrecognised — degrading to "cannot read this" rather than guessing.

## §3 Threads — `src/providers/threads/insights.ts`

```ts
requiredScopes: ["threads_manage_insights"],
missingScopes: {
  reason: "Threads needs the threads_manage_insights permission before Docket can read its numbers.",
  docsPath: "threads-setup#insights",
},
maxPostsPerRead: 1,
readBudget: { count: 48_000, windowSeconds: 86_400 },   // 4800 x 10, the documented floor (§Q5)
account: [],                                            // research R4: enum not confirmed
```

Threads is the only one of the three whose declared budget is **sourced** rather than interim: §Q5
documents an impression floor of 10, so 4800 × 10 is a real floor rather than a stand-in.

**Two shapes, and the implement phase picks one from `docs/research/meta.md`:**

- **(a) Confirmed.** If the official insights page's metric enum can be read, declare post keys
  `views` → "Views", `likes` → "Likes", `replies` → "Replies", `reposts` → "Reposts",
  `quotes` → "Quotes" and build the reader on
  `GET /{threads-media-id}/insights?metric=…` through the existing Threads transport.
- **(b) Not confirmed.** Ship the module with
  `unavailable: { reason: "Docket has not confirmed which metrics the Threads insights API reports.", docsPath: "insights" }`,
  `post: []`, `account: []`. A provider declaring `unavailable` is filtered out before the claim
  (`insights-poll.ts:67-70`), so **no account is claimed, no call is made, and the panel shows the
  reason** — a working, honest outcome that FR-003 explicitly blesses, at the cost of one small file.

`shares` is **not** declared in either shape: FR-031 lists it from the roadmap and no source
corroborates it on the media-insights edge (research §3, R3). Recorded as a minor disagreement.

Whichever shape ships, **`threads_manage_insights` is still requested** under
`THREADS_INSIGHTS_SCOPES` and the grant is still recorded — so shape (b) upgrades to shape (a) in a
later entry with no reconnect needed by anyone who already granted it.

---

## §4 G34 — ephemeral post types and the schedule that reads them

Constitution V forbids teaching the scheduler that an Instagram story dies after a day. So the
provider declares it and the **pure** schedule reads the declaration.

### The new pure function, beside the existing one

`src/lib/insights/schedule.ts` keeps `nextPostPollAt` **byte-identical** — FR-043 requires 080's
schedule tests to pass untouched, and the cheapest way to guarantee that is not to edit the function
they test. The reason a caller needs is carried by a new wrapper:

```ts
export type PostPollDecision =
  | { kind: "due"; at: Date }
  | { kind: "frozen"; reason: "settled" | "expired" };

/** Pure, total, no clock, no database. Delegates to `nextPostPollAt` for a non-ephemeral subject. */
export function postPollDecision(input: {
  publishedAt: Date;
  lastCapturedAt: Date | null;
  now: Date;
  minIntervalMs: number;
  /** `post_targets.chosen_post_type`; null = the provider's default, never ephemeral. */
  chosenPostType: string | null;
  ephemeralPostTypes?: readonly { postType: string; lifetimeMs: number }[];
}): PostPollDecision;
```

### Its rules

1. **No match** — `chosenPostType` is null, or no declaration matches it: delegate.
   `nextPostPollAt(...)` → `{ kind: "due", at }`, or `{ kind: "frozen", reason: "settled" }` for
   `null`. **This is 080, unchanged** (FR-043, US5-AS5).
2. **A match**, with `expiresAtMs = publishedAt + lifetimeMs`:
   - `now >= expiresAtMs` → `{ kind: "frozen", reason: "expired" }`. Covers both "the window just
     closed" and "this subject was already expired the first time Docket saw it" (FR-041) — the
     second is why the claim's lazy insert calls this function rather than `nextPostPollAt`.
   - otherwise the candidate is the **dense first-band cadence from publication**, i.e.
     `(lastCapturedAt ?? publishedAt) + HOUR_MS`, then raised to at least
     `lastCapturedAt + minIntervalMs` when there is a capture — the same floor the existing function
     applies, so `INSIGHTS_POLL_MIN_INTERVAL_SECONDS` still bounds call volume.
   - if that candidate `>= expiresAtMs` → `{ kind: "frozen", reason: "expired" }`
     (FR-039: never scheduled past the boundary).
   - else `{ kind: "due", at: candidate }`.

A 24-hour story with the default 15-minute floor therefore gets **at most 23 reads** and then
freezes, instead of 080's decaying 32 reads over 28 days — and the last of those reads lands inside
the window where Instagram still answers, which is the entire point.

### Both call sites

| Call site | Today | After |
|---|---|---|
| `claimDuePostMetricPolls` lazy insert | `nextPostPollAt` → `nextPollAt` | `postPollDecision` → due, or born frozen (data-model §4) |
| `commitPostBatch` after a capture | `next === null ? "settled" : null` | `decision.reason` — `settled` or `expired` |

`commitPostBatch` must pass `chosenPostType` through, so `ClaimedPostMetricPoll` gains
`chosenPostType: string \| null` (it is already selected from `post_targets` for the lazy insert, so
this is a field on an existing row, not a new query).

**Why evaluate the declaration at poll time rather than storing a per-target expiry.** A stored
expiry column would be a second source of truth for a number derivable from `published_at` and the
declaration, and would go stale if a lifetime were ever corrected. Evaluating it each time also gives
the spec's edge case ("a target that stops matching simply returns to the ordinary schedule") for
free, with no migration.

---

## §5 What all three readers share, and what they must not

**Shared transport (FR-032), reused verbatim:** `graphRequest` / `graphList`
(`src/providers/meta/graph.ts`) for Instagram and Facebook; the existing Threads request layer for
Threads; `scrub` and `GRAPH_ERROR_TABLE` (`src/providers/meta/errors.ts`) for classification;
`graphSummary` for the secret-free `AttemptSummary`. **No new HTTP client anywhere.**

**Shared meaning: forbidden (FR-034).** There is no `src/providers/meta/metrics.ts`, no shared label
map, no key alias table and no normalisation step. Facebook's "Reactions", Instagram's "Views" and
Threads' "Views" are keys in three provider folders. Research §2 notes the sharp edge this entry
creates: after it, **three platforms label a metric "Views" and mean three different events**. So
FR-034's test asserts the right thing — that the three providers' *keys* live only in their own
folders and that no module outside `src/providers/` names a metric key — and explicitly **does not**
assert that labels are unique, because they are not, and a test demanding uniqueness would push
someone to rename a platform's own word.

**Result mapping, per read** (080's vocabulary, no additions beyond the per-entry `unqueryable`):

| Situation | Returned |
|---|---|
| Metrics for the id | `page` with `{ kind: "metrics" }` |
| The platform no longer returns the post | `page` with `{ kind: "gone" }` |
| The stored id cannot be queried (FR-036) | `page` with `{ kind: "unqueryable", reason }` |
| Usage header at or above the ceiling | `rate_limited` with `retryAt` from the header (meta-usage.md) |
| Graph code 80001 / 80002, or 4 / 17 / 32 / 613 | `rate_limited` — already classified (research §5) |
| Graph code 190 | `credentials_invalid` |
| Network before send, 5xx, 429, transient | `retryable_error` |
| Anything else, including an invalid metric name | `fatal_error` with Meta's own scrubbed message |

An invalid metric name lands in `fatal_error`, which backs off and surfaces as `failing` on the panel
with Meta's own text — visible and actionable, though it will retry for 28 days (research §5.3). That
is the second reason the "only CONFIRMED metrics are declared" rule is load-bearing.

**Never throws (FR-033).** Each reader's entry point is total; the section wraps it anyway, but a
provider relying on that would be a provider that reports `fatal_error` where it meant
`retryable_error`.

**Mocked HTTP only (FR-037, constitution II).** No provider test makes a live call. Until the parked
live checks run, all three readers are reported as **"verified with mocks only"**.

## §6 The `mock` provider's new scripting

`src/providers/mock/insights.ts` and `src/providers/mock/settings.ts` gain the scripting every new
behaviour needs, so the scheduler and panel tests never need a Meta fixture:

| Field | Drives |
|---|---|
| `insightsRequiredScopes` | the eligibility matrix test, without touching a real provider |
| `insightsEphemeralLifetimeMs` | the ephemeral schedule and the `expired` freeze, end to end |
| `insightsUnqueryableIds` | the `unqueryable` entry kind and its count |
| `insightsUsagePercent`, `insightsRetryAfterMinutes` | the usage-ceiling path and `retryAt` |

This keeps the pattern 080 established: every generic behaviour is proved on `mock`, and each real
provider's test only proves *its own* mapping from a scripted platform reply.
