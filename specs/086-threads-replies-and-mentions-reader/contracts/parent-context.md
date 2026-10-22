# Contract: the three parent contexts, and the unavailable notice

**Feature**: 086 | **Implements**: FR-012 … FR-015, FR-017 … FR-024, FR-034
**Scope**: shared ingest, first-engagement, inbox service and inbox views. **Provider-independent**
by FR-024 — every rule here is a property of these files, proven through the mock provider and
Bluesky, and inherited by any provider that ever emits a parentless item.

## 1. The three contexts are three, everywhere

One inbound item is in exactly one of these states, and the three must stay distinguishable from
ingest to pixel.

| # | Stored state | `resolveParent` returns | What the member is told |
|---|---|---|---|
| **A** | `parent_external_id` set, `parent_post_target_id` set, target content resolves | `{ kind: "docket_post", text, externalId: null }` | the brand's own post, shown as the item's context |
| **B** | `parent_external_id` set, no target (or no resolvable content) | `{ kind: "external_reference", text: null, externalId }` | a reference to something that is **not** one of the brand's posts |
| **C** | `parent_external_id` null | `null` | plainly: this is not about one of the brand's own posts |

**Nothing collapses.** B is not A with a missing title; C is not B with a missing id; neither B nor
C renders a blank, a dash, a placeholder or an empty context block. SC-004 is the test of this: the
three produce visibly different results.

## 2. Ingest (FR-017) — no change, now proven

`src/server/scheduler/engagement-read.ts:169,185-187` is already correct: a null
`parentExternalId` short-circuits `getByExternalId`, so `parent_external_id`, `parent_post_id` and
`parent_post_target_id` are written null together. There is no path that writes a post id for a
parentless item.

**Proof required (FR-034): against a stored row, not the mapper.** Run the real section with a
provider emitting one parentless `mention` and one parented `reply` in the same page, then read both
rows back from `engagement_items` and assert all three columns on the mention and all three set on
the reply. This is the edge case the spec names — "a parentless item arriving for a provider that
also emits parented items must not disturb the parented ones".

## 3. First engagement (FR-018) — no change, now proven

`earliestInboxSaidAt` (`src/server/dal/insights.ts:387`) matches on
`parent_post_target_id = <uuid>`, which is never true for `NULL`. The only other writer of
`target_first_engagement` is the snapshot walk, which never reads the inbox.

**Proof required at the pass level, not the predicate.** Publish a target, store a parentless
mention whose `said_at` is after the publish, run `recordFirstEngagement`, then assert:

- `exact_first_at` is null and `bound_before_at` is null on that target's row;
- `firstEngagementFigure(row)` is `none_yet` or `not_examined` — never `exact` (spec scenario 2's
  "still reports that nothing has been observed on it yet", SC-003);
- a parented reply on the **same** target, stored in the same run, *does* produce
  `kind: "exact"` — the set case must be demonstrably different from the null case (FR-021), or the
  test proves only that nothing happened.

## 4. The same-post count (FR-019) — no change, now proven

`services/engagement/inbox.ts:121` asks `countNewerOnSameParent` only when `parentExternalId` is
non-null, and reports `0` otherwise.

**Proof required with more than one parentless item.** The bug this guards against is a count of
*other parentless items*, which is invisible when only one exists. Store three parentless mentions
with ascending `said_at`, open the oldest, assert `newerOnSameParent === 0`. Then store two parented
replies on one target and assert the older one reports `1`.

## 5. The item page (FR-020, FR-022, FR-023) — the one presentation change

`src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:63-68` currently renders the parent block only
when `item.parent` is truthy and labels both non-null kinds identically (`On`, then
`text ?? externalId ?? "—"`). So state C renders silence and state B is indistinguishable from
state A. The service already computes `kind`; the view discards it.

Replace with a three-arm render on `item.parent`:

| State | Rendered |
|---|---|
| `null` (C) | a block stating plainly that this is **not about one of your posts** — present, not omitted (FR-023) |
| `kind: "docket_post"` (A) | heading `On your post`, body the post's text (FR-021) |
| `kind: "external_reference"` (B) | heading that names it as not one of the brand's posts, body the platform reference (FR-022) |

Constraints:

- The C block is **not** an error, a warning or a loading state: `EmptyState` is for an empty list,
  and a `role="alert"` would make a normal mention look wrong. Plain muted text in the same block
  position as A and B, so the page's shape does not jump between items.
- No `"—"` fallback survives: in A the text is resolved or the item is in B; in B the reference is
  non-null by construction (B exists only when `parentExternalId` is set).
- Keyboard and semantics unchanged — it is static text, no new control, no new focus stop
  (`docket-ui` skill, constitution accessibility line).

**Proof required**: render the **real page**, not a view model —
`renderToStaticMarkup(await InboxItemPage({ params, searchParams }))` with the `next/navigation`,
`next/cache` and `@/server/auth/session` mocks from `tests/helpers/actions`, the shape
`tests/integration/accounts/accounts-page-insights.test.ts` already uses
(`tests/integration/engagement/meta-not-repliable.test.tsx` is the same idea one component down).
Seed one item per state, assert each produces a distinct non-empty statement, and assert A's
statement is absent from C's markup and C's from A's — a test that only checks "the right text is
present" passes a page that prints all three.

## 6. The unavailable notice and the filter (FR-012, FR-013, FR-014, FR-015)

### 6.1 Inbox — already built, now reached by Threads

`listEngagementAccounts` (`services/engagement/inbox.ts:195`) includes an account iff its provider
declares `engagement`, and carries `unavailable` straight off the declaration. The inbox page
(`inbox/page.tsx:71-88`) renders one notice per unavailable account, and the account filter
(`:120-127`) already excludes them. Adding the Threads declaration is what makes a Threads account
appear in both — **no change to either file beyond §7's precedence guard and the `docsHref` fix**.

### 6.2 Accounts page — new (FR-014)

`AccountView` has `engagementReadPermission` but no engagement unavailability, so the accounts page
says nothing. Add:

```ts
// src/server/services/accounts.ts, on AccountView
engagementUnavailable: { reason: string; docsPath?: string } | null;
```

filled from `findProvider(a.providerKey)?.engagement?.declaration.unavailable ?? null` inside
`view()`, beside the three permission fields already computed there.

`src/app/p/[projectSlug]/accounts/page.tsx` renders it in the same place as the engagement
permission block, with the same prose as the inbox notice so FR-014's "consistent in wording" is
checkable: the declared `reason` verbatim, and a "Set up comments →" link through `docsHref`. **No
reconnect button** — reconnecting cannot help, which is the whole of FR-015.

### 6.3 Precedence (FR-015)

The registry already refuses a declaration carrying both `unavailable` and `readScopes`, and
`engagementPermissionForAccount` returns `null` when `readScopes` is empty — so for Threads the
permission notice cannot appear. FR-015 asks for precedence rather than impossibility, so both
render sites state it explicitly instead of relying on the invariant holding forever:

- `inbox/page.tsx`: the permission-notice block is rendered only for accounts with
  `!a.unavailable`.
- `accounts/page.tsx`: the `engagementReadPermission` block is rendered only when
  `account.engagementUnavailable === null`.

Two guards, each one condition, each one test. The contrived "both" case cannot be a real provider
(the registry refuses it), so it is built with `registerTestProvider`
(`tests/helpers/provider-fixtures.ts`), which pushes a provider onto the registry for the lifetime
of one test file — the same helper `accounts-page-insights.test.ts` uses for its own gated-scope
fixtures. Note that `registerTestProvider` bypasses `assertEngagementDeclaration`, which is exactly
why the guards are worth having: the invariant is enforced for shipped providers and the render does
not depend on it.

An account on that provider is told it is unavailable and is **not** asked to reconnect.

## 7. What does not change

- **No migration.** `parent_external_id`, `parent_post_id`, `parent_post_target_id` already exist
  and already allow null (`src/server/db/schema/engagement.ts:44-46`), and
  `engagement_items_project_parent_idx` is already partial on `parent_external_id IS NOT NULL`.
  `drizzle/`'s latest file is unchanged by this entry.
- **No new item kind, state or filter value.** `reply` and `mention` already exist in
  `ENGAGEMENT_ITEM_KINDS` and in the inbox's kind filter.
- **No scheduler section, setting or environment variable.**
- **No change to `resolveParent`, `earliestInboxSaidAt`, `countNewerOnSameParent` or the ingest
  write.** They are correct; this entry proves them.
