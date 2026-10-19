# Contract: the shared Meta comment sweep

**Feature**: `085-facebook-instagram-comments-reader` | Satisfies FR-008 to FR-023, FR-033

One walk over the brand's own posts, written once, called by both providers through
[`MetaCommentSurface`](./meta-comment-surface.md). This contract fixes its state, its call bound, its
step order and its outcomes, because those four are where an off-by-one costs a member a comment they
never see.

## 1. The entry point

```ts
export function metaEngagementRead(
  surface: MetaCommentSurface,
  ctx: EngagementReadContext<unknown>,
): Promise<EngagementReadResult>;
```

The seam is unchanged (spec Out of Scope). Of what it hands over:

| Input | How the sweep uses it |
|---|---|
| `account.externalId` | The Page id or IG user id: the listing path's subject, and half of `MetaSelfIdentity` |
| `account.credentials` | `readPageToken` only. A missing or malformed token is `credentials_invalid` before any call |
| `providerState` | **The position.** Parsed through the schema in §2; an unparseable state is treated as `{}` (a fresh start), never as an error |
| `direction` | Honoured in step order §4.2, but not the only way the catch-up advances — see §4 and research.md §2.1 |
| `limit` | A cap on items **emitted**, and the divisor for the inline comment limit (§3) |
| `cursor` | **Ignored.** The position lives in `providerState` (FR-012); see research.md §2.2 |
| `now` | The usage back-off check, and `saidAt` fallbacks. The sweep reads no other clock |
| `signal` | Passed to every Graph call, unmodified |

The returned `cursor` is **always `null`**.

## 2. Provider state

```ts
export const metaEngagementStateSchema = z
  .object({
    v: z.literal(1),
    /** ms since epoch: the newest comment time the fresh pass has emitted for this account. */
    freshSince: z.number().int().nonnegative().optional(),
    /** Posts whose comments are mid-walk, oldest queued first. At most MAX_PENDING. */
    pending: z
      .array(z.object({ postId: z.string().min(1).max(100), after: z.string().max(200).optional() }))
      .max(3)
      .optional(),
    /** The catch-up's position in the own-posts listing. Absent + !done = start at the newest page. */
    catchUp: z.object({ postsAfter: z.string().max(200).optional() }).optional(),
    /** The catch-up passed the oldest post the platform will return. Never resumes (SC-004). */
    done: z.literal(true).optional(),
    /** Instagram only. The account's own username, for FR-016. */
    selfUsername: z.string().min(1).max(100).optional(),
    /** Which step ran last, so fresh and catch-up alternate (§4.2 step 3). */
    lastStep: z.enum(["fresh", "catchUp"]).optional(),
  })
  .strict();
```

**Rules.**

1. **Nothing unbounded.** The object has a fixed field count and `pending` is capped at 3; its size
   does not grow with the account's. Worst case ≈ 900 bytes against the database's
   `octet_length(provider_state::text) <= 2000` check.
2. **Shrink before returning.** The sweep serialises the state it is about to return and, while it
   exceeds **1,500 bytes**, drops `pending` entries oldest-first, then `catchUp.postsAfter` (which
   restarts the catch-up from the newest post, losing progress but never items). An oversized state
   is not a degraded read — it is a failed transaction that discards the items committed with it
   (FR-013).
3. **`v: 1` is required, not defaulted.** A state from a later version with a different `v` fails the
   parse, which yields `{}` and a fresh start rather than a misread position (FR-013).
4. **A `pending` post the platform refuses is dropped from state**, not retried (FR-017).
5. **`done: true` is terminal.** No step ever clears it; only the scheduler's `cursor_lost` handler
   does, by resetting `provider_state` to `{}` (SC-004: "never resumes").

### 2.1 The seam field this depends on, and the defect that blocks it

`src/server/scheduler/engagement-read.ts` parses `providerState` on entry and, on a successful page,
commits **that same parsed value** (`:124-125` and `:245`), discarding `result.providerState`.
Bluesky returns no state, so the discard has never shown. The sweep's whole position lives in this
field, so the sweep cannot work until it is honoured: every run would re-read the same five posts and
no catch-up would ever advance.

**The fix (FR-033)**: on the `kind: "page"` branch, commit the state the provider returned when it
returned one, and the state parsed on entry when it did not. On every other outcome, commit neither —
the existing behaviour, which FR-022 requires. One expression, no interface change, no schema change,
Bluesky byte-identical.

This is a defect fix on a field the seam already declares, not a new hook. Its test is a provider
that returns a changed state and an assertion that the next read receives it.

## 3. The call bound (FR-014, SC-003)

| Constant | Value | What it bounds |
|---|---|---|
| `POSTS_PER_PAGE` | 5 | Posts examined per fresh or catch-up step |
| `COMMENTS_PER_POST_INLINE` | `clamp(floor(ctx.limit / POSTS_PER_PAGE), 1, 10)` | Comments requested inline per post. 10 at the default `ENGAGEMENT_READ_PAGE_SIZE` of 50 |
| `COMMENTS_PER_DRAIN_PAGE` | `min(ctx.limit, 50)` | Comments requested on a drain step |
| `MAX_PENDING` | 3 | Busy posts remembered at once |
| `GRAPH_CALLS_PER_READ` | **1** | Graph requests per `read()` — plus one, once in an Instagram account's lifetime, for `prefetchSelf` |

So one `read()` examines **at most 5 posts** and reads **at most 1 comments page per post**, and one
account's read costs **at most `ENGAGEMENT_READ_PAGES_PER_RUN` Graph calls per run** — 3 by default,
whatever the account holds. That is FR-014's "stated, bounded number", and SC-003 asserts it against
a mocked account with ten times more posts than the bound examines.

Items emitted per read never exceed `ctx.limit`, by construction: a fresh step's ceiling is
`POSTS_PER_PAGE × COMMENTS_PER_POST_INLINE ≤ ctx.limit`, and a drain step's is
`COMMENTS_PER_DRAIN_PAGE ≤ ctx.limit`.

The single call is possible because of field expansion with `.limit()` and per-edge nested cursors
(research.md §1.3). The request a fresh step issues:

```
GET /{account.externalId}/{posts|media}
    ?fields=id,{postTimeField},comments.limit({COMMENTS_PER_POST_INLINE}){ {commentFields} }
    &limit={POSTS_PER_PAGE}
```

## 4. One read, one step

### 4.1 Before any step

1. `activeUsageBackoff(account.id, now)` is set → return
   `rate_limited` with that `retryAt` and **no call** (FR-018, the behaviour
   `facebook/insights.ts` already implements for insights).
2. `readPageToken(credentials)` is null → `credentials_invalid`.
3. The surface has a `prefetchSelf` and `state.selfUsername` is absent → run it. On success, the
   `selfUsername` is in the state this read returns. On failure, return the mapped outcome (§6) —
   **never a read that proceeds without it** (FR-016, [meta-comment-surface.md](./meta-comment-surface.md) §4).

Every Graph response passes through `applyUsageSignal`: a usage signal at or above
`metaUsageCeiling()` carrying `retryAfterMinutes` records a back-off that makes this account's
**next** read decline (FR-018). It never aborts the read in progress — the response in hand is
already paid for, and discarding it would lose comments for nothing.

### 4.2 Choosing the step

In this order, first match wins:

1. `state.pending` is non-empty → **drain** its first entry.
2. `direction === "older"` and not `state.done` → **catch-up**.
3. `state.lastStep === "fresh"` and not `state.done` → **catch-up**.
4. otherwise → **fresh**.

Step 3 is why US3 works. The scheduler only enters the `older` direction when a page comes back full
with nothing already stored (`nextBackfillState`), which a typical Meta account never does — so
without step 3 the catch-up would never start. It fires on roughly every other `read()`, and the
scheduler calls `read()` up to three times per run. See research.md §2.1.

### 4.3 The fresh step (FR-010)

One call for the **first** page of the own-posts listing — no cursor, so always the newest posts.
Then, for each post in the response, for each comment in its inline block:

1. `surface.isSelf(comment, identity)` → skip (FR-016).
2. comment time ≤ `state.freshSince` → skip. This is "comments it already holds": anything at or
   below the high-water mark has been emitted before (research.md §3).
3. otherwise → emit (§5).

Afterwards: `freshSince` becomes the greatest emitted comment time (never decreasing); any post whose
inline block came back **full** and carries a nested `paging.cursors.after` is appended to `pending`
(up to `MAX_PENDING`, duplicates by `postId` ignored); `lastStep: "fresh"`.

Returns `exhausted: false`. A fresh step is not walking history and has no business reporting on it
(FR-015).

**Order is not trusted.** Neither listing documents its default order, so the step filters by each
comment's own timestamp rather than assuming the newest arrive first (research.md §1.2). A busy post
whose *newest* comments are therefore not in the inline block is reached by the drain step, which
asks Facebook for `order=reverse_chronological` and follows Instagram's nested cursor.

### 4.4 The drain step

One call: `GET /{postId}/comments?limit={COMMENTS_PER_DRAIN_PAGE}&{drainParams}` plus
`after={pending[0].after}` when set. Every non-self comment is emitted with **no `freshSince`
filter** — a drain exists because the fresh pass could not see the whole post.

Afterwards: if the response carries a further `after`, `pending[0].after` advances and the entry
stays; otherwise the entry is removed. `freshSince` is **not** advanced by a drain step (a drain may
legitimately return old comments, and advancing the mark would hide newer ones the fresh pass has yet
to see). `lastStep` is left unchanged, so a drain does not consume the fresh/catch-up alternation.

A Graph error identifying the post as gone (code 100) removes the entry and returns an empty page,
not a failure — one unreadable post never fails the account (FR-017).

Returns `exhausted: false`.

### 4.5 The catch-up step (FR-011, FR-015)

One call for the own-posts listing at `state.catchUp.postsAfter` (absent → the newest page, i.e. the
walk starts where the fresh pass starts and works back). Every non-self comment in every post's
inline block is emitted, **with no `freshSince` filter** — the catch-up's whole purpose is the
comments the high-water mark hides.

Afterwards: `catchUp.postsAfter` advances to the response's `paging.cursors.after`; busy posts are
appended to `pending` as in §4.3; `lastStep: "catchUp"`.

`exhausted: true` — and `done: true` written into state — **iff** the listing response carried no
further page (`paging.next` absent, or no `after` cursor) **and** `pending` is empty after this step.
Both halves are required: FR-015 forbids reporting exhaustion because the sweep hit its own bound, so
a step that stopped at `POSTS_PER_PAGE` with a cursor still in hand returns `exhausted: false`.

The scheduler's response to `exhausted: true` is to clear its own `backfilling` flag and stop the
loop. The sweep's own `done` is what makes the stop permanent (SC-004).

**Known inefficiency, recorded rather than papered over.** The seam does not pass the inbox's
retention window to a provider, so the catch-up walks until the platform runs out of posts, and the
scheduler discards items older than `ENGAGEMENT_RETENTION_DAYS` as it already does. On an account
with years of history the last catch-up steps therefore store nothing. Bounding this would mean
inventing a horizon constant, which principle I does not allow; passing the real one would mean a new
seam field, which the spec puts out of scope.

## 5. Emitting one comment (FR-024 to FR-031)

| Draft field | Value |
|---|---|
| `kind` | `"comment"`, always |
| `externalId` | the comment's own `id` from the platform. Trimmed; a comment with no usable id is skipped |
| `text` | `comment[surface.commentTextField]` when a string, else `""`. Never a placeholder (FR-031) |
| `textTruncated` | `true` when the text exceeded the inbox's stored length and was cut |
| `author` | `surface.mapAuthor(comment)` — and nothing else touches it |
| `saidAt` | `new Date(comment[surface.commentTimeField])`. Unparseable → the comment is skipped, not dated `now` |
| `parentExternalId` | the **post's** id from the listing (FR-026) |
| `data` | `{}` |
| `upstream` | **never set** (FR-032, research.md §1 G3) |

**Truncation length.** `engagement_items.text` carries a `char_length(text) <= 10000` check. The
inbox's existing limit is that check, so the sweep cuts at 10,000 characters and sets
`textTruncated`. It introduces no new policy (spec Assumptions).

`saidAt` is millisecond-precision from an ISO timestamp, which satisfies the
`said_at = date_trunc('milliseconds', said_at)` check without rounding.

**`parentExternalId` resolves without translation.** Facebook's listing returns
`{page-id}_{post-id}`, the shape `publish.ts` records; Instagram's returns the `ig-media-id`,
likewise. The generic layer's `targets.getByExternalId` then resolves the Docket post
(`engagement-read.ts`). A Facebook Reel published as a bare video id will **not** match — the item is
still stored and simply shows without post context, which the spec's edge cases already allow.

## 6. Outcomes

Exactly the table in [research.md](../research.md) §6. Two rules worth repeating here because they
are the ones a reviewer should check:

- **Graph code 100 means two different things** depending on where it lands. On a request that
  carried a stored cursor (`catchUp.postsAfter` or `pending[].after`) it is `cursor_lost` (FR-020), so
  the scheduler resets the position and the next run restarts from the newest post. On a post's own
  comments edge it is not an outcome at all: that post is skipped (FR-017).
- **No new outcome kind** (FR-019). The six non-`page` members of `EngagementReadResult` are the
  whole vocabulary, and a test enumerates every `GraphOutcome` shape and asserts each maps to one of
  them — nothing unclassified (SC-005).

Every message is `scrub`bed with the token in the secrets list before it leaves (FR-023), and every
`summary` is built from `graphSummary`, which emits only status, Graph code, type, trace id and usage
percent (FR-034, SC-007).

## 7. What a failure must leave alone (FR-022, SC-006)

On any outcome other than `kind: "page"`, the sweep returns **no `providerState`**. The scheduler's
non-page branch already leaves `cursor`, `providerState` and `backfilling` untouched while still
committing items inserted earlier in the same run — so the position is byte-for-byte what it was and
the work is not lost. The FR-033 fix must not change this: it applies to the `page` branch only.

A partial step is a committed step. A fresh step that emitted three comments and then met a malformed
post returns those three as a page with the state they imply; it does not discard them to report an
error about the fourth.

## 8. Tests this contract requires

Unit, no HTTP: `mapAuthor` and `isSelf` per surface against recorded fragments; the state schema's
caps, its shrink guard and its `v`-mismatch behaviour; the step chooser over every state/direction
combination; the outcome mapping over every `GraphOutcome` shape.

Mocked HTTP (`fetch` stubbed, as `facebook/insights.test.ts` already does): the fresh pass against a
page of posts with inline comments; the `freshSince` boundary on a re-read; self-comment exclusion on
both surfaces; the drain step's cursor advance and its removal on code 100; the catch-up's progress
across three successive reads; `exhausted` true only on a genuinely final page; the usage ceiling
recording a back-off and the next read declining with no call; and the full outcome table.

Integration, real Postgres (**port 5555**): FR-033's state round trip; one comment stored once across
ten consecutive runs (SC-002); the permission gate skipping an un-reconnected Facebook Page with zero
calls (SC-009); a surface declared unavailable never being claimed while the other still reads
(FR-006).

No test makes a live platform call (FR-044).
