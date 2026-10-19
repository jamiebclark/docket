# Contract: `MetaCommentSurface` — the only things a Page and an Instagram account disagree about

**Feature**: `085-facebook-instagram-comments-reader` | Satisfies FR-008, FR-016, FR-024 to FR-031,
FR-035, FR-037 to FR-040

FR-008 says the sweep lives once in the shared Meta layer and each provider's own module holds "only
its declaration and the facts that genuinely differ between a Page and an Instagram account". This
contract is that list. If a future change needs a per-surface branch that is not a field below, the
branch belongs here or the design was wrong — it does not belong inside the sweep.

Every value in §3 and §4 traces to `docs/research/engagement.md` §2 or to
[research.md](../research.md) §1, which §2 must absorb (FR-001 to FR-005, FR-007). A value with no
such trace fails review.

## 1. The shape

```ts
export interface MetaCommentSurface {
  /** Prefixes every member-visible error, as `facebook/insights.ts`'s `PLATFORM` already does. */
  platform: "Facebook" | "Instagram";
  /** Graph path listing the brand's own posts. Takes the account's `externalId`. */
  ownPostsPath(accountExternalId: string): string;
  /** Field carrying a post's publication time on that listing. */
  postTimeField: string;
  /** Fields requested inside the nested `comments{…}` expansion. */
  commentFields: readonly string[];
  /** Field carrying a comment's words. "" when absent — never a placeholder (FR-031). */
  commentTextField: string;
  /** Field carrying a comment's time. */
  commentTimeField: string;
  /** Extra params for a standalone comments page. Empty unless the edge documents them. */
  drainParams: Readonly<Record<string, string>>;
  /** FR-027 to FR-029. Returns exactly the fields §2 confirms, and `null` for every other. */
  mapAuthor(comment: Record<string, unknown>): InboundItemDraft["author"];
  /** FR-016. True when the brand itself wrote this comment. */
  isSelf(comment: Record<string, unknown>, identity: MetaSelfIdentity): boolean;
  /**
   * One-off account-identity prefetch, or `null` when the surface needs none. Runs before the
   * first comment is read for an account and its result is cached in provider state.
   */
  prefetchSelf:
    | null
    | ((input: { accountExternalId: string; token: string; signal: AbortSignal })
        => Promise<{ kind: "ok"; selfUsername: string } | Exclude<GraphOutcome, { kind: "ok" }>>);
}

/** What the sweep knows about who the brand is, assembled from the account and provider state. */
export interface MetaSelfIdentity {
  /** The account's `externalId`: a Page id, or an IG user id. */
  externalId: string;
  /** Instagram only; `null` until `prefetchSelf` has run. */
  selfUsername: string | null;
}
```

`mapAuthor` and `isSelf` are **pure** and total: they take a parsed JSON object, never throw, and
never call the network. They are unit-tested directly against recorded response fragments, with no
HTTP mocking at all.

## 2. Rules every surface obeys

1. **Nothing is synthesised.** `mapAuthor` returns `null` for any field the surface's own §2 row does
   not confirm. No handle derived from a name, no profile URL built from an id, no display name
   copied from a handle (FR-028). A reviewer must be able to point at a §2 cell for every non-`null`
   field a surface returns (SC-008).
2. **`identityStable` is `false` unless §2 confirms the same person gives the same identifier
   twice** (FR-029). A display name is not an identity. A username is not an identity.
3. **`url` is `null` on both surfaces.** Neither surface's documented field list contains a profile
   link, and an absent link stays absent (FR-028, spec US1 scenario 4).
4. **`reachable` is left at its default** (`true`). Neither surface documents a signal for it, and
   inventing one would make the inbox refuse a reply it was never going to offer anyway.
5. **No credential ever reaches a mapped value.** `mapAuthor` sees only a comment object; the token
   is not in scope for it (FR-023, FR-034).
6. **`data` is `{}`.** Replying is not built on either surface, so there is nothing a stored item
   needs beyond what the generic columns hold. `itemDataSchema` is `z.object({}).strict()`, which
   makes a credential in `provider_data` a type error rather than a review finding (FR-034).

## 3. Facebook Pages

| Field | Value | Trace |
|---|---|---|
| `platform` | `"Facebook"` | — |
| `ownPostsPath` | `` (id) => `/${id}/posts` `` — the edge that "shows only the posts that were published by this page", **not** `/feed`, which also returns posts published by others | research.md §1 G4 |
| `postTimeField` | `"created_time"` | research.md §1 G4 |
| `commentFields` | `["id", "message", "created_time", "from{name,id}"]` | research.md §1 G1 |
| `commentTextField` | `"message"` | §2 Q1 / research.md §1 G1 |
| `commentTimeField` | `"created_time"` | §2 Q1 / research.md §1 G1 |
| `drainParams` | `{ order: "reverse_chronological", filter: "toplevel" }` — both documented enums of this edge | research.md §1.2 |
| `prefetchSelf` | `null` — the Page id Docket already holds is the identity it needs | research.md §4 |

**`mapAuthor`**, given `from` as `{ name?: string, id?: string }` (absent entirely when Meta withheld
it):

| Draft field | Value |
|---|---|
| `displayName` | `from.name` when a non-empty string, else `null` |
| `handle` | `null` — no handle field is documented on the Comment object |
| `externalId` | `from.id` when a non-empty string, else `null` |
| `url` | `null` |
| `identityStable` | `true` **iff** `externalId !== null`; `false` otherwise |

`identityStable: true` rests on the PSID/ASID stability quoted in research.md §1 G2, and on nothing
else. The conditional matters: a comment arriving with no `from` at all yields an author that is
entirely `null` and not stably identified, which the database's
`engagement_items_identity_stable` check already permits and
`engagement_items_author_external_id_len` already bounds.

**`isSelf`**: `from.id === identity.externalId`. A Page commenting on its own post presents the Page
id, which is the account's `externalId`.

**Declaration**:

```ts
declaration: {
  reads: ["comment"],
  canReply: false,
  // no writeBudget: nothing is written on this surface
  readScopes: ["pages_read_engagement", "pages_read_user_content"],
  missingReadScopes: {
    reason:
      "A Facebook Page needs the pages_read_user_content permission before Docket can read the "
      + "comments people leave on its posts. Reconnect the Page to grant it.",
    docsPath: "meta-setup#engagement",
  },
}
```

`pages_read_user_content` is the finding in research.md §1.1, and it is why **every existing Facebook
account is skipped until it reconnects** (FR-037, US6 scenario 3). It must also be added to
`ENGAGEMENT_SCOPES_DECLARED` in `src/providers/meta/connect-group.ts` and named in `cannotWiden`'s
engagement message, or the opt-in cannot request what the surface declares — a contradiction a
registry assertion should catch, not a reviewer.

## 4. Instagram

| Field | Value | Trace |
|---|---|---|
| `platform` | `"Instagram"` | — |
| `ownPostsPath` | `` (id) => `/${id}/media` `` — "gets all IG Media on an IG User" | research.md §1 G4 |
| `postTimeField` | `"timestamp"` | research.md §1 G4 |
| `commentFields` | `["id", "text", "timestamp", "username", "user{id}"]` | research.md §1 G1 |
| `commentTextField` | `"text"` | §2 Q1 / research.md §1 G1 |
| `commentTimeField` | `"timestamp"` | §2 Q1 / research.md §1 G1 |
| `drainParams` | `{}` — this edge documents no `order` and no `filter`, so neither is sent | research.md §1.2 |
| `prefetchSelf` | `GET /{ig-user-id}?fields=username` → `selfUsername` | research.md §4 |

**`mapAuthor`**:

| Draft field | Value |
|---|---|
| `displayName` | `null` — no name field is returned for a comment Docket does not own |
| `handle` | `username` when a non-empty string, else `null` |
| `externalId` | `null` — `user` is returned only for a comment the requester owns, and such comments are dropped by `isSelf` before mapping |
| `url` | `null` |
| `identityStable` | `false`, always |

`identityStable: false` is not a shortcoming to be fixed later; it is the correct reading of G1.
Instagram supplies no identifier for someone else's comment, and a username is not an identity — so
the inbox must not group two comments as one person (spec Edge Cases, FR-029).

**`isSelf`**: `username === identity.selfUsername` (when `selfUsername` is known) **or**
`user.id === identity.externalId`. The second is a belt to the first, for the reason research.md §4
gives; it can only ever remove a comment the first already removed, or catch one it missed.

**The sweep must refuse to read comments for an Instagram account whose `selfUsername` is unknown.**
`prefetchSelf` runs first, and a failure to fetch it returns `retryable_error` — never a read that
proceeds without the means to recognise the brand's own words (FR-016 has no degraded mode).

**Declaration**:

```ts
declaration: {
  reads: ["comment"],
  canReply: false,
  readScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
  missingReadScopes: {
    reason:
      "This Instagram account needs the instagram_manage_comments permission before Docket can read "
      + "the comments people leave on its posts. Reconnect the account to grant it.",
    docsPath: "meta-setup#engagement",
  },
}
```

The three scopes are §2 Q2's Facebook-Login-flow answer, in full and in order. `instagram_basic` and
`pages_read_engagement` are already in `META_SCOPES`, so for Instagram the opt-in adds only
`instagram_manage_comments`, which `ENGAGEMENT_SCOPES_DECLARED` already lists.

## 5. The `unavailable` variant, and how to reach it

Both surfaces ship **readable** on the evidence in research.md §1. The `unavailable` path stays built
and stays tested, because FR-039 requires it and because a reviewer who rejects one of the
`search-summary` grades must be able to flip one surface without touching the other.

Flipping a surface to unavailable is **one field**:

```ts
declaration: {
  reads: ["comment"],
  canReply: false,
  unavailable: { reason: "<names the missing fact>", docsPath: "meta-setup#engagement" },
  readScopes: [...],
  missingReadScopes: { ... },
}
```

and nothing else changes: `runEngagementRead` already filters declared-but-unavailable providers out
of its claim rules (`src/server/scheduler/engagement-read.ts`), so no account on that surface is
claimed and no call is made for it; `listEngagementAccounts` already surfaces the reason and the
link. The `reason` must name the **missing fact**, not say "unsupported" (FR-039, US6 scenario 4).

The two surfaces are decided independently and one must never gate the other (FR-006). Asserted, not
assumed: a test declares one surface unavailable through `registerTestProvider` and proves the other
still reads.

## 6. Registry assertions

`assertEngagementDeclaration` (added by 084) runs over every provider at load. This entry's
surfaces must satisfy it and add two checks of their own, both of which encode a mistake that would
otherwise reach a member:

1. **A non-empty `readScopes` must be requestable.** Every scope a surface declares must appear in
   its connect group's `baseScopes` or its `optionalScopes.declared`. Without this, declaring
   `pages_read_user_content` while forgetting `ENGAGEMENT_SCOPES_DECLARED` yields a surface no
   account can ever hold the permission for, with no error anywhere.
2. **`canReply: false` forbids `writeBudget`.** A write allowance on a surface that cannot be written
   to is dead configuration, and the reserve it would claim is taken from publishing.

## 7. Reversal

Delete `src/providers/facebook/engagement.ts`, `src/providers/instagram/engagement.ts` and the
`engagement:` line from each provider's object; delete the `engagement-*` files from
`src/providers/meta/`; remove `pages_read_user_content` from `ENGAGEMENT_SCOPES_DECLARED` and from
`cannotWiden`'s engagement message. Nothing persisted needs undoing except the rows this feature
inserted: `engagement_items` for the two provider keys and the `provider_state` on their
`engagement_account_states` rows, both of which the existing retention pass and a `provider_state`
reset already handle. The FR-033 fix in `src/server/scheduler/engagement-read.ts` **stays** — it is a
defect fix on a field the seam already declares, and Bluesky is unaffected by it either way.
