# Phase 0 research: Facebook Page and Instagram comment reading

**Feature**: `085-facebook-instagram-comments-reader` | **Date**: 2026-10-19

This file resolves every unknown the plan needed before it could choose a design. §1 is the
load-bearing one: it closes gaps **G1 to G4**, which the spec said decide whether each surface ships
readable or ships declared-but-unavailable (FR-006). §2 onwards record the design decisions that
followed, each with the alternative that was rejected.

Nothing here edits `docs/research/engagement.md`. That edit is FR-001 to FR-005's deliverable and
belongs to the implement phase; [contracts/research-section-2-additions.md](./contracts/research-section-2-additions.md)
states the exact shape it must take. This file is the planning evidence that the edit will have
something true to write.

---

## 1. The four gaps, answered

**Method.** Official Meta documentation domains only (`developers.facebook.com`), reached through
`WebSearch`. 084 established why that tool and not a human task
(`specs/084-meta-engagement-facts-and-scope-gate/research.md` §1: this harness has `WebSearch` and no
`WebFetch`), and `contracts/research-section-2.md` §3 established the grading that follows from it:
**`page`** means the official page's own text was read; **`search-summary`** means an official-domain
search result quoted the fact verbatim. Every answer below is graded, and the grade is not flattering
itself — most are `search-summary`, because a search summary is all this harness can obtain.

No live call was made to any Meta endpoint during planning, and none will be made during
implementation (FR-044, FR-045, constitution II).

### G1 — commenter identity fields

**Facebook Page comments: CONFIRMED.** The Comment object carries `from`, "The person that made this
comment", of type `User`, and the `from` field in the response "includes the `name` and `id` of the
commenter". Access to it is conditional and the condition is one Docket already meets: "For any
comments or replies owned by (on) a Page, you must use a Page access token if you want User
information to be included in the response." Docket reads Meta surfaces with the stored Page token
(`src/providers/meta/credentials.ts`, `readPageToken`), which is the Page access token in question.

- Fields available: `id`, `message`, `created_time`, `from{name,id}`, `like_count`, `comment_count`.
- Source: <https://developers.facebook.com/docs/graph-api/reference/comment> · checked 2026-10-19 · evidence `search-summary`
- Consequence for the design: `displayName` = `from.name`, `externalId` = `from.id`. **No handle and
  no profile-link field is documented on the Comment object**, so both stay `null` — FR-028 forbids
  constructing a profile address out of an identifier.

**Instagram comments: CONFIRMED, and narrower.** The returnable fields on an IG Comment are
`hidden`, `id`, `like_count`, `media`, `replies`, `text`, `timestamp`, `user` and `username`, with
this condition stated on `user`: it is "only returned if the user making the query also owns the
comment, otherwise, the username field will be included". The same rule is stated the other way round
on the comments edge: "the `user` and `biography` fields will not be included in responses unless the
User making the request owns the Comment; instead, we will return `username` for all commenters."

- Source: <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/> and <https://developers.facebook.com/docs/instagram-api/reference/comment/> · checked 2026-10-19 · evidence `search-summary`
- Consequence for the design: for a comment left by **somebody else** — which is every comment that
  becomes an inbox item — Instagram supplies `username` and **no identifier at all**. So `handle` =
  `username`, and `displayName`, `externalId` and `url` are all `null`. A username is not an
  identity (the spec's uniform identity rule), so `identityStable` is `false`.

Both surfaces therefore pass G1. Neither supplies a profile link, and neither gets one invented.

### G2 — is the identifier stable across two comments by the same person?

**Facebook: CONFIRMED yes, within the scope Docket uses.** Two independent documented statements,
either of which is sufficient:

- Page-scoped: "The PSID will remain unique for the user-page combination irrespective of which app
  retrieves it", and PSIDs "will be returned for … `Comment/comments`, `PagePost/comments`" — the
  comment edges by name.
  Source: <https://developers.facebook.com/docs/pages/access-tokens/psid-api/faq> · checked 2026-10-19 · evidence `search-summary`
- App-scoped: "An App-Scoped User ID is unique to the app and cannot be used by other apps", and
  "If your app stores the IDs of people who do not use your app, such as the IDs of people who
  comment on your Page's posts, these IDs will change from their original ID to an app-scoped ID."
  Source: <https://developers.facebook.com/documentation/facebook-login/guides/map-users> and <https://developers.facebook.com/docs/apps/faq> · checked 2026-10-19 · evidence `search-summary`

Docket's scope is one Meta app reading one Page. Both the page-scoped and the app-scoped reading are
*at least as wide* as that pair, so under either, the same person commenting twice on the same Page
presents the same `from.id`. `identityStable: true` for Facebook.

The documentation does **not** promise the identifier is the same across two *different* Pages, and
the design does not need it to be: `engagement_items` has no author table and identity is
unmergeable by construction (`src/server/db/schema/engagement.ts`, "There is deliberately no author
table").

**Instagram: moot, and answered `false`.** G1 settled that no identifier is returned for a comment
Docket does not own. There is nothing to be stable. `identityStable: false`, `externalId: null`.

### G3 — how a deleted or edited comment presents on a later read

**Both surfaces: answered, and the answer is "absence is not a signal."** This is a real answer, not
an `unverified` cell, and it confirms the stance FR-032 already takes.

Facebook's own comments-edge reference states that `total_count` "can be greater than or equal to the
actual number of comments returned **due to comment privacy or deletion**" — the document itself
makes absence ambiguous between a privacy setting and a deletion. A deleted comment fetched by id
returns the generic error code 100, "Object with ID does not exist, cannot be loaded due to missing
permissions, or does not support this operation" — equally ambiguous between gone, hidden and
unpermitted.

- Source: <https://developers.facebook.com/docs/graph-api/reference/v2.4/object/comments> · checked 2026-10-19 · evidence `search-summary`

**Edits: still `unverified` on both surfaces.** No `edited_time`, revision count or equivalent field
appears in either surface's documented field list. Instagram's `hidden` field remains what §2 already
records — a moderation flag the media owner sets, not an upstream signal.

- Consequence: `upstream` is **never set** by either surface. Nothing is marked withdrawn, nothing is
  marked edited, and absence from a re-read changes nothing (FR-032, and the same stance Bluesky
  takes). This is the one place where an answered question produces *less* code, not more.

### G4 — how to list the brand's own recent posts (the question §2 never asked)

**Facebook: CONFIRMED.** `GET /{page-id}/posts` "shows only the posts that were published by this
page" — which is precisely "the brand's own posts", and is the narrower of the two available edges
(`/{page-id}/feed` also returns "posts … published by others on this page", which this feature must
not read). `pages_read_engagement` "is needed to read content posted to the Page". Paging is the
Graph API's general cursor shape: a `paging` object with `cursors.before`, `cursors.after` and
`paging.next`.

- Source: <https://developers.facebook.com/docs/pages-api/> and <https://developers.facebook.com/docs/graph-api/reference/page/feed/> · checked 2026-10-19 · evidence `search-summary`
- The ids returned are Page post ids of the form `{page-id}_{post-id}` — the same shape
  `src/providers/facebook/publish.ts` records as a target's `externalId` (it prefers `post_id`), and
  the same shape `src/providers/facebook/insights.ts` already calls the only one the insights edge
  answers for. So a comment's parent resolves against `post_targets.external_id` without a
  translation step (FR-026).

**Instagram: CONFIRMED.** `GET /{ig-user-id}/media` "gets all IG Media on an IG User". It "supports
time-based pagination" via `since`/`until` in addition to the general cursor paging.

- Source: <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/> · checked 2026-10-19 · evidence `search-summary`
- The ids returned are `ig-media-id`s — exactly what `GET /{ig-media-id}/comments` takes, and exactly
  what `media_publish` returns and `post_targets.external_id` holds
  (`src/providers/instagram/publish.ts:320`).

### The FR-006 verdict, computed

| Surface | Comments endpoint | Permission | Own-posts listing (G4) | Identity shape (G1) | **Ships** |
|---|---|---|---|---|---|
| Facebook Page comments | ✅ `/{post-id}/comments` (§2 Q1) | ✅ (§2 Q2) + see §1.1 below | ✅ `/{page-id}/posts` | ✅ `from{name,id}` | **readable** |
| Instagram comments | ✅ `/{ig-media-id}/comments` (§2 Q1) | ✅ (§2 Q2) | ✅ `/{ig-user-id}/media` | ✅ `username` | **readable** |

**Both surfaces ship readable.** This overturns §2's standing verdict ("must ship
declared-but-unavailable") by the mechanism the spec built for exactly this — FR-001 to FR-005 closed
the gap that caused it, and FR-006 then decides mechanically. The spec's "Recorded disagreement"
section anticipated this: the roadmap entry said the sweep was buildable today, the research did not
yet support it, and the research step was the way to settle it rather than assume it.

The `unavailable` path is **still built and still tested** (US6, FR-039). It is one declaration field
away at all times, and the surfaces are decided independently — so if a reviewer rejects one of the
`search-summary` grades above, that surface flips to `unavailable` by editing one object literal and
nothing else.

### 1.1 The permission finding the spec did not expect

§2 Q2 records `pages_read_engagement` for Facebook Page comments. That is necessary and **not
sufficient**. The Permissions Reference states that `pages_read_user_content` "allows your app to
read user generated content on the Page, such as posts, comments, and ratings by users or other
Pages", and that in many Graph API operations "both the `pages_read_engagement` permission and the
`pages_read_user_content` permission are required to access page feed data and read comments".
A commenter's comment is user-generated content by definition.

- Source: <https://developers.facebook.com/documentation/development/permissions> · checked 2026-10-19 · evidence `search-summary`
- Access level: Standard Access, by the general rule `docs/research/meta.md` already quotes directly
  from the access-levels page ("Business, Consumer, and Gaming apps are automatically approved for
  Standard Access for all permissions and features available to their app type"). No App Review.

**Consequences, all of them good, none of them free:**

- Facebook's `readScopes` is `["pages_read_engagement", "pages_read_user_content"]`, not just the
  first (FR-037).
- `pages_read_user_content` is in neither `META_SCOPES` nor `ENGAGEMENT_SCOPES_DECLARED` today, so
  **no existing account holds it.** Every connected Facebook Page is therefore skipped by the claim
  as missing a declared read scope, counted in `accountsSkippedNoPermission`, and shown in the
  inbox's reconnect notice — until its owner opts in with `META_ENGAGEMENT_SCOPES=true` and
  reconnects. That is 084's permission gate doing exactly the job it was built for (US6 scenario 3),
  and it is the honest outcome: without the permission the reads would fail or return nothing.
- `ENGAGEMENT_SCOPES_DECLARED` in `src/providers/meta/connect-group.ts` gains it, so the opt-in
  dialog can request it and `cannotWiden`'s login-configuration message can name it.

Had this not been found during planning, the implementation would have shipped a reader that quietly
returned empty comment lists on every Page. It is recorded here, and must be recorded in §2, because
principle I means a permission list is a researched fact and not a plausible one.

### 1.2 Facts the design deliberately does not depend on

Three things the documentation does state, which the design treats as unavailable anyway, because
depending on them would be fragile:

| Fact | Documented? | Why the design ignores it |
|---|---|---|
| `order=reverse_chronological` on `/{object-id}/comments` | Yes — the `order` parameter is an enum of `chronological` and `reverse_chronological`, and `filter` is an enum of `toplevel` (default, "all top-level comments in chronological order") and `stream`. Source: <https://developers.facebook.com/docs/graph-api/reference/v2.4/object/comments>, checked 2026-10-19, `search-summary` | Used on Facebook's standalone drain call, where it is documented as a parameter of that edge. **Not** relied on for correctness: the sweep filters comments by their own timestamp rather than trusting the order they arrive in, so an undocumented or changed default cannot drop a comment. Instagram's comments edge documents no `order` parameter at all, and none is sent to it |
| Default ordering of `/{page-id}/posts` and `/{ig-user-id}/media` | Not stated on either page | Same reason. The sweep's newest-first guarantee (FR-010) comes from the fresh pass reading the **first** page of the listing and comparing each comment's own time against a stored high-water mark — not from an assumption about row order |
| `summary=total_count` on the comments edge | Yes, with the caveat quoted in G3 | Nothing in this feature needs a count, and the documented caveat makes it unreliable as a change signal |

### 1.3 Field expansion: the fact that shaped the whole design

"Field expansion allows you to not only perform nested queries, but also limit results by adding a
`.limit()` argument to any field or edge", and "nested fields will include their own paging cursors
in the response".

- Source: <https://developers.facebook.com/docs/graph-api/using-graph-api> · checked 2026-10-19 · evidence `search-summary`
- §2 already records the Instagram half of this independently ("not included unless you use field
  expansion to request the `replies` field").

This is why the sweep costs **one Graph call per `read()`** rather than one per post. A single request

```
GET /{id}/posts?fields=id,created_time,comments.limit(10){id,message,created_time,from}&limit=5
```

returns five of the brand's own posts *with* their comments and *with* a nested paging cursor per
post. The naive shape — list posts, then one call per post — would have cost 1 + N calls and made
FR-014's bound a negotiation. With field expansion it is a constant, and the per-post fan-out the
spec worried about does not exist.

---

## 2. One Graph call per `read()`, and the state machine that makes it enough

**Decision.** One `read()` call performs exactly **one step** and issues exactly **one** Graph
request (plus, once in an Instagram account's lifetime, one more — see §4). The step is chosen from
the provider's own state, in this order:

1. a post is mid-walk (`pending` non-empty) → **drain** one comments page for it;
2. `direction === "older"` and the catch-up is unfinished → **catch-up** step;
3. the previous step was a fresh pass and the catch-up is unfinished → **catch-up** step;
4. otherwise → **fresh** step.

**Rationale.** Three things had to be true at once. FR-014 needed a bound stated as a number, not a
formula over an account's size. US4 needed that number small enough that reading cannot crowd out
publishing on a shared call budget. And FR-012 required the position to live in the provider-owned
state rather than in a new field. One call per step satisfies all three: with
`ENGAGEMENT_READ_PAGES_PER_RUN` at its default of 3, one account's read costs **at most 3 Graph
calls per run**, whatever it holds — 5 posts and 10 comments per post examined per fresh step, one
comments page per drain step.

**Alternatives considered.**

- *List posts, then one call per post.* 1 + N calls per read, N bounded by a constant chosen from
  nowhere. Rejected once §1.3 made field expansion available: the bound becomes 1 and the arbitrary
  constant disappears.
- *Let `read()` do as much work as the remaining tick budget allows.* Rejected: the call bound would
  depend on machine speed, SC-003 would be unassertable, and a fast machine would spend the Page's
  hourly budget on the inbox.
- *A process-local pacing gate — one real read per account per 15 minutes.* Seriously considered and
  rejected. It would have been a number from nowhere (principle I), it duplicates what
  `ENGAGEMENT_READ_MIN_INTERVAL_SECONDS` already does, and FR-018's usage-signal back-off is the
  governor the research actually confirms exists. The honest mitigation for an install with many Meta
  accounts is to raise the existing interval, and `docs/engagement.md` will say so.

### 2.1 Why the walk cannot use the scheduler's backfill flag

A fact found by reading `src/lib/engagement/paging.ts` rather than by assuming: the scheduler only
enters the backfill direction when a page comes back **full** with nothing already stored
(`nextBackfillState`: `pageItemCount >= pageSize && !anyAlreadyStored`). That is right for Bluesky,
whose notification feed fills a page on day one. It is wrong for a Meta account with months of posts
and a handful of comments: the first fresh pass returns four items, the flag never flips, and US3's
catch-up never starts.

The seam cannot be changed (spec Out of Scope), and the provider cannot set the flag. So the sweep
runs **its own** catch-up inside provider state and advances it on step 3 above — which fires on
roughly every other `read()`, because the scheduler calls `read()` up to three times per run. The
`direction` argument is still honoured (step 2): when the scheduler does ask for older items, it
gets them. It is simply not the only way the catch-up progresses.

This is the second place the design leans on FR-033. Provider state that is parsed and then
re-committed unchanged (`src/server/scheduler/engagement-read.ts:124-125` and `:245`) makes every
walk restart from nothing on every run. Bluesky never noticed because it returns no state. The sweep
would notice immediately: it would re-read the same five posts forever and never catch up.

### 2.2 The seam's `cursor` is unused, and that is deliberate

FR-012 puts the position in `providerState`. A two-level position — which post, and where in that
post's comments — does not fit a single string the generic layer treats as opaque, and splitting it
across `cursor` and `providerState` would give one walk two homes and two chances to disagree. So
`read()` returns `cursor: null` always and ignores `ctx.cursor`. The seam is unchanged; one of its
fields is simply not needed by this provider, exactly as `writeBudget` is not needed by a surface
that cannot reply.

---

## 3. What "already have it" means without database access

**Decision.** The fresh pass keeps one number in provider state — `freshSince`, the newest comment
timestamp it has ever emitted for this account — and emits only comments newer than it.

**Rationale.** FR-009 forbids the provider from reading Docket's database, so it cannot ask whether a
comment is stored. The obvious alternative, remembering the newest comment seen *per post*, is
unbounded: one entry per post breaks FR-013's size promise for an account of any size. A single
high-water mark is one number, is bounded by construction, and is sufficient — anything newer than
every comment ever emitted is new, and the scheduler's `insertIfAbsent` makes an exact repeat
harmless (SC-002).

What the high-water mark deliberately does *not* do is find a comment older than the mark that was
never seen — one left on a post beyond the fresh pass's five, say. That is the catch-up walk's job,
and the catch-up applies no `freshSince` filter at all.

**Alternative considered.** Having the generic layer pass the provider its newest stored item time.
Rejected: it is a new field on `EngagementReadContext`, which the spec puts out of scope, and the
provider can derive the same thing from state it already owns.

---

## 4. Not notifying a member of their own words

**Decision.** Facebook compares the comment's `from.id` against the account's own `externalId` (the
Page id). Instagram compares the comment's `username` against the account's own `username`, fetched
once per account with `GET /{ig-user-id}?fields=username` and cached in provider state; a comment
carrying a `user` object whose `id` is the account's own id is also treated as self.

**Rationale.** FR-016 is a correctness requirement, not a nicety — a member who gets notified about
their own reply will not trust the inbox. Facebook is easy: a Page commenting as itself presents the
Page id, which Docket already holds. Instagram is not: the only identity field a non-owned comment
carries is `username`, and Docket stores the IG account's *display* name
(`"{page name} · Instagram"`, `src/providers/meta/candidates.ts`), not its username.

`username` is a documented field on IG User
(<https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/>,
checked 2026-10-19, `search-summary`), so one extra call settles it, once, for the life of the
account. The first Instagram read for an account fetches it **before** reading any comments, and a
failure to fetch it returns `retryable_error` rather than proceeding — because proceeding would risk
storing a self-comment, and FR-016 does not have a degraded mode.

The `user`-object check is the belt to that braces. Documentation says `user` is returned "only if
the user making the query also owns the comment", which — read strictly — identifies self-authored
comments exactly. It is used as a second signal rather than the only one because "owns the comment"
is ambiguous enough to be read as "owns the media the comment is on", and under that reading the
check would match everything and store nothing. The username comparison is unambiguous; the `user`
check can only ever remove a comment the username comparison already removed, or catch one it missed.

**Alternative considered.** Deriving the username from the account's display name by stripping the
` · Instagram` suffix. Rejected outright: FR-028 forbids deriving an identity field from another
field, and a Page's name is not its Instagram username.

---

## 5. Provider state that stays small, and stays readable by a later version

**Decision.** One versioned object, every string length-capped, with a serialise-and-shrink guard: if
the encoded state exceeds 1,500 bytes the provider drops `pending` entries oldest-first, then the
catch-up cursor (which restarts the catch-up from the newest post), before returning it.

**Rationale.** `engagement_account_states.provider_state` carries a database check constraint —
`octet_length(provider_state::text) <= 2000` — so an oversized state is not a degraded read, it is a
failed transaction that loses the items read with it. The guard makes the cap unreachable rather than
merely unlikely (FR-013). The caps: at most 3 `pending` entries, each cursor at most 200 characters,
a post id at most 100. Worst case ≈ 900 bytes.

FR-013 also asks that a later version reading a position naming a post that no longer exists stay
readable. It does: the state schema is parsed with Zod and a parse failure yields `{}`, the scheduler
already substitutes `{}` for unparseable state, and a `pending` post the platform refuses is dropped
from state and skipped (FR-017) rather than retried forever.

---

## 6. Every Graph failure, mapped to an outcome that already exists

**Decision.** One shared `metaEngagementOutcome(outcome, …)` in the Meta layer maps `GraphOutcome` to
the six non-`page` members of `EngagementReadResult`, reusing `classifyGraphError` and `scrub` from
`src/providers/meta/errors.ts`.

| Graph outcome | Engagement outcome | Why |
|---|---|---|
| `network` | `retryable_error` | A read is never ambiguous: nothing was published, so trying again is free |
| `unparseable` | `retryable_error` | Same |
| `http_error` ≥ 500 or 429 | `retryable_error` | Same |
| `http_error` 4xx (other) | `fatal_error` | A malformed request will not fix itself |
| `graph_error` → `invalid_token` | `credentials_invalid` | FR-021. The scheduler then tries the renewal the publish path would before flagging the account |
| `graph_error` → `rate_limited` | `rate_limited` | FR-018, with `retryAt` from the usage signal when present |
| `graph_error` → `temporary` | `retryable_error` | |
| `graph_error` code 100 **on a request that carried a stored cursor** | `cursor_lost` | FR-020. The position, not the account, is what went bad |
| `graph_error` code 100 on a post's comments edge | *not an outcome* | FR-017: that post is skipped and the sweep continues |
| `graph_error` → `rejected` (other) | `fatal_error` | |

**Rationale.** FR-019 forbids a new outcome kind, and `src/providers/facebook/insights.ts` already
contains almost exactly this table for the four insights outcomes — written twice there, once per
provider, which is the duplication FR-008 exists to prevent here. The two rows that are not a
transcription of the insights mapping are the code-100 rows, and they are the interesting ones:
the same Graph code means "your cursor is stale" in one position and "that post is gone" in another,
and conflating them would turn one deleted post into a whole-account cursor reset.

`classifyGraphError`'s table is unchanged: codes 4/17/32/613/80001/80002 are already the rate-limit
set, and 80001 (Pages) and 80002 (Instagram) are the business-use-case codes these reads will meet.

---

## 7. Where the code goes

**Decision.** The sweep, the mapping, the state, the outcome mapping and the usage back-off live in
`src/providers/meta/engagement-*.ts`. Each provider's `engagement.ts` is a declaration plus a
`MetaCommentSurface` object naming only what differs between a Page and an Instagram account.

**Rationale.** FR-008, and the precedent is in the same two folders: `facebook/insights.ts` and
`instagram/insights.ts` each hold their own metric names and their own `GraphOutcome` mapping, and
the duplicated mapping is a cost this entry should not repeat. What genuinely differs between the two
surfaces is a short list — the listing path, three field names, the comment field list, the
self-comment test, and whether a standalone comments page may be ordered — and
[contracts/meta-comment-surface.md](./contracts/meta-comment-surface.md) is that list.

**Alternative considered.** A generic "per-post engagement sweep" in `src/lib/engagement/`, usable by
any future provider. Rejected as speculative: Threads is the only candidate, it is a different host
with a different token and its endpoints are still `unverified` in §2, so the abstraction would be
designed against one real caller and one imagined one. The Meta layer is the right home until a
second platform needs it.

---

## 8. Facts this plan did not need, and did not invent

- **A read rate limit specific to comments.** §2 Q7 records that none exists and that the general
  business-use-case ceiling is the only budget. The design observes that ceiling through the
  machinery insights already uses (`parseUsageHeader`, `metaUsageCeiling`, `recordUsageBackoff`) and
  introduces no number of its own.
- **Nested replies.** Instagram returns top-level comments only unless `replies` is expanded, and
  Facebook's `filter=toplevel` is the default. Both surfaces read top level only; expanding is a
  later decision resting on a confirmed fact (spec Assumptions).
- **A reply endpoint.** §2 Q5 is `unverified` on both surfaces and replying is out of scope for the
  whole roadmap. `canReply: false`, no write allowance declared, no reply scope requested.
- **A retention horizon inside the provider.** The seam does not pass the inbox's retention window to
  a provider, and inventing one would be a number from nowhere. So the catch-up walks until the
  platform genuinely has no more posts (FR-015, literally), and the scheduler discards pre-horizon
  items as it already does. On a very old account the last few catch-up steps therefore store
  nothing — correct, bounded, and noted in [plan.md](./plan.md) as a known inefficiency rather than
  papered over.
