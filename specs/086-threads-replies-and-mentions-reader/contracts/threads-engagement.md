# Contract: the Threads `engagement` member

**Feature**: 086 | **Implements**: FR-001 … FR-011, FR-016, FR-033, FR-035
**File**: `src/providers/threads/engagement.ts`, exported as `threadsEngagement`, wired as
`engagement: threadsEngagement` on `threadsProvider` (`src/providers/threads/index.ts`).

This is the whole of the member. It is a declaration, two schemas and two functions that make no
call. Every value below traces to a confirmed cell of `docs/research/engagement.md` §2 (FR-011);
where §2 says `unverified`, this contract says nothing.

## 1. The declaration

```ts
declaration: {
  reads: ["reply", "mention"],
  canReply: false,
  unavailable: {
    reason:
      "Docket cannot read Threads replies or mentions yet: Threads does not publish a confirmed "
      + "read endpoint for either surface, so there is nothing to call. This is not a permission "
      + "you can grant or a setting you can change.",
    docsPath: "meta-setup#engagement",
  },
}
```

| Field | Value | Requirement | Why exactly this |
|---|---|---|---|
| `reads` | `["reply", "mention"]` | FR-002 | The two kinds Bluesky already emits (`src/providers/bluesky/engagement.ts`, `REASONS`), so `ENGAGEMENT_ITEM_KINDS`, the inbox filter's options and every stored value gain nothing new. Both are named even though neither is readable: naming one would under-declare the surface, and naming none is forbidden (`reads.length === 0` throws). |
| `canReply` | `false` | FR-007 | Reply sending is out of scope for the whole roadmap. `replyableVerdict` (`services/engagement/inbox.ts:109`) and the send gate (`scheduler/engagement-send.ts:76`) both read this, so the composer is absent rather than present-and-failing. |
| `writeBudget` | **absent** | FR-007 | `assertEngagementDeclaration` throws on `canReply: false` with a `writeBudget` set: an allowance on a surface that cannot be written is dead configuration taken from the publishing reserve. |
| `unavailable.reason` | the three sentences above | FR-003, FR-004 | Sentence 1 names both surfaces and the cause (no confirmed read endpoint). Sentence 2 forecloses the two wrong readings FR-004 names — a permission to grant, a setting to change. Length is inside `assertEngagementDeclaration`'s 1–300 bound. |
| `unavailable.docsPath` | `"meta-setup#engagement"` | FR-003 | The same `page#anchor` shape every other provider uses; `docs/meta-setup.md`'s `## Engagement` section is where the Threads opt-in is documented. Rendered through §4's helper, never raw. |
| `readScopes` | **absent** | FR-005 | `assertEngagementDeclaration` throws on `unavailable` together with a non-empty `readScopes`. The two are different claims: "not readable here at all" versus "this account has not granted it yet". Threads is the first. |
| `missingReadScopes` | **absent** | FR-005 | Only meaningful with `readScopes`. |

**The reason must not say** any of: *reconnect*, *grant*, *permission needed*, *opt in*, *enable*,
*not supported on your plan*, *App Review*. FR-004 is a constraint on wording and is tested as one.

## 2. The schemas

```ts
const threadsEngagementItemDataSchema = z.object({}).strict();
const threadsEngagementStateSchema = z.object({}).strict();
```

Both are closed and empty. No item can be stored and no position can be held, so a field either
way would be a claim about a shape §2 does not confirm. `.strict()` rather than `z.object({})` so a
stray `accessToken` is a parse failure and not a silently-kept extra key (section 20's "must reject
anything resembling a credential").

**The deferred dual cursor** ("two surfaces, one cursor", spec Out of Scope) adds its fields to
`threadsEngagementStateSchema` when it has two confirmed pagination shapes to divide between. It is
named here so the seam is obvious, and left empty so nothing guesses it.

## 3. `read()` and `send()`

```ts
async function read(_ctx: EngagementReadContext<ThreadsSettings>): Promise<EngagementReadResult> {
  return { kind: "unavailable", reason: <the declaration's reason>, docsPath: "meta-setup#engagement" };
}

async function send(_ctx: EngagementSendContext<ThreadsSettings>): Promise<EngagementSendResult> {
  return { kind: "fatal_error", error: "Threads replies cannot be sent through Docket." };
}
```

Rules this file is held to, each testable by reading it:

1. **The whole file's import list is `zod` and `../types` (plus `./settings` for the type
   parameter).** No `./requests`, no `./credentials`, no `./config`, no `../meta/*`. FR-009 forbids
   depending on an endpoint path, field name or pagination shape, and importing the Threads Graph
   client would be depending on a caller with nothing confirmed to call (research.md §4).
2. **Neither function touches `ctx`.** The parameters are `_ctx`. `ctx.account.credentials` is never
   read, so even a direct call with a decrypted credential in hand cannot leak one (FR-010).
3. **`read()` returns `unavailable`, not `fatal_error`.** The scheduler counts the two differently
   (`engagement-read.ts:356` vs `:failed`) and FR-016 requires unavailable, not a failure. This arm
   is unreachable through a tick (§5) and exists as the second belt for a direct call.
4. **`send()` returns `fatal_error`, never `retryable_error`, `ambiguous` or `rate_limited`.** FR-008
   wants a permanent refusal that is never retried. `fatal_error` is the only arm the send path does
   not re-queue. `flagAccount` is **not** set: the account is fine, the platform surface is not.
5. **The `send()` message reads as a platform limitation.** "cannot be sent through Docket", not
   "failed", "error", "unavailable right now" or anything suggesting a retry would help.

## 4. `docsHref` — making the declared link reach the documentation

`src/lib/docs.ts` gains:

```ts
/** A provider-declared `page#anchor` docs pointer → its published URL. */
export function docsHref(docsPath: string): string;
```

It splits on the first `#`, validates the page against `DocPage`, and returns
`docsUrl(page, anchor)`. An unknown page returns `DOCS_BASE_URL` rather than throwing — a bad
pointer must not take a page down (research.md §2.6).

Every site that renders a declared `docsPath` uses it. There are six, and both existing shapes are
wrong: four render the raw value as an href (resolving relative to `/p/<slug>/`), and two cast it to
`DocPage` and call `docsUrl` with the anchor still attached (producing `…/meta-setup#engagement/`).

| File | Line | Was |
|---|---|---|
| `src/app/p/[projectSlug]/inbox/page.tsx` | 82 | raw href — the FR-003 link |
| `src/app/p/[projectSlug]/inbox/page.tsx` | 103 | raw href |
| `src/app/p/[projectSlug]/accounts/page.tsx` | 208 | raw href |
| `src/app/p/[projectSlug]/accounts/page.tsx` | 230 | raw href — live today via 085's Meta `missingReadScopes` |
| `src/components/insights/TargetMetrics.tsx` | 55 | `docsUrl(x as DocPage)` |
| `src/components/targets/PerformancePanel.tsx` | 32, 43, 54 | `docsUrl(x as DocPage)` |

The `as DocPage` casts go with them; a cast that is wrong for every value any provider declares is
what hid this.

## 5. What the scheduler does with it (FR-009, FR-010, FR-016)

Unchanged, and the point is that it is unchanged:

- `runEngagementRead` (`scheduler/engagement-read.ts:53-56`) filters providers whose declaration is
  `unavailable` out of the rule list **before** `claimDueEngagementReads` sees it.
- `claimDueEngagementReads` applies `eligible(rules)` to both its lazy `engagement_account_states`
  insert and its claim select, so a Threads account gets no state row, is never selected, never
  leased, never decrypted and never passed to `read()`.

One addition, mirroring 084's permission-gate count exactly:

```ts
// src/server/dal/engagement-read-claims.ts
export function countAccountsOnUnavailableEngagement(providerKeys: readonly string[]): Promise<number>;
```

Counts active, non-removed accounts on those providers. `runEngagementRead` computes the
unavailable provider keys alongside the rule list and adds the result to `counts.unavailable`,
**outside** the `providers.length > 0` guard so an install with no claimable provider still reports
it. No new heartbeat key: `unavailable` is already in the payload and is already the right word.

## 6. Registry assertions (FR-035)

`src/providers/registry.test.ts` or `threads/engagement.test.ts` proves both directions:

| Case | Expected |
|---|---|
| the shipped `threadsEngagement.declaration` | `assertEngagementDeclaration({ key: "threads", engagement: threadsEngagement, connect: … })` does not throw |
| the same declaration **plus** `readScopes: ["threads_manage_replies"]` | throws, message contains `unavailable and readScopes must never both be set` |
| the same declaration **plus** `writeBudget` | throws (`canReply is false but writeBudget is set`) |
| `reads: []` | throws (`reads is empty; omit engagement instead`) |

The first case is also covered for free by module load: `registry.ts:161` runs the assertion over
every provider at import, so a bad Threads declaration fails every test in the suite.

## 7. The connect dialog is untouched (FR-006)

`src/providers/threads/connect-group.ts` keeps `ENGAGEMENT_SCOPES_DECLARED`
(`threads_manage_replies`, `threads_manage_mentions`) in `optionalScopes.declared` and behind
`THREADS_ENGAGEMENT_SCOPES` in `optionalScopes.requested` and `authorizationUrl`. **No line of that
file changes.** The permissions stay requestable so a future reader needs no connect work, and
because the declaration names no `readScopes`, nothing anywhere treats a granted scope as a reason
to read or an ungranted one as a reason to prompt — which is what makes FR-015 true by construction
rather than by precedence logic.
