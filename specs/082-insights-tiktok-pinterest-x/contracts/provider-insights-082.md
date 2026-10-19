# Contract — the insights provider interface after 082 (G35, G36, G37)

Feature `082-insights-tiktok-pinterest-x`. Extends
[080 contracts/provider-insights.md](../../080-insights-core-bluesky/contracts/provider-insights.md)
and [081 contracts/provider-insights-081.md](../../081-insights-reconnect-and-meta/contracts/provider-insights-081.md).
Everything those two define still holds; only the deltas are here.

## §1 `InsightsDeclaration`, after this entry

```ts
export interface InsightsDeclaration {
  post: readonly MetricKeyDeclaration[];
  account: readonly MetricKeyDeclaration[];
  maxPostsPerRead: number;
  readBudget: PublishLimit;
  unavailable?: { reason: string; docsPath?: string };

  /** G37. Permissions the POST surface needs before any post read. Default empty. */
  postScopes?: readonly string[];
  /** G37. Required when `postScopes` is non-empty. */
  missingPostScopes?: { reason: string; docsPath?: string };
  /** G37. Permissions the ACCOUNT surface needs. Default empty — may differ from `postScopes`. */
  accountScopes?: readonly string[];
  /** G37. Required when `accountScopes` is non-empty. */
  missingAccountScopes?: { reason: string; docsPath?: string };

  /** G35. Which stored identifier `readPostMetrics` is given. Default `"externalId"`. */
  postIdSource?: "externalId" | "publicPostId";
  /** G35. Required when `postIdSource` is `"publicPostId"`: shown for a target that has none. */
  missingPostId?: { reason: string; docsPath?: string };

  /** G34, unchanged. */
  ephemeralPostTypes?: readonly { postType: PostType; lifetimeMs: number }[];
}
```

**Migration of 081's field.** `requiredScopes`/`missingScopes` are **removed**. Instagram and
Facebook set `postScopes` and `accountScopes` to the same list they used before and duplicate their
`missingScopes` into both `missing*Scopes`; Threads is `unavailable` so neither matters; Bluesky and
`mock` leave all four unset. **No current behaviour changes**, and
`tests/integration/insights/eligibility-matrix.test.ts` proves it with its existing rows before the
new ones are added.

### Rules the generic layer enforces

1. `post` empty ⇒ the post claim never claims this provider. `account` empty ⇒ the account claim
   never claims it. (081 required one of the two to be non-empty; that still holds.)
2. `unavailable` set ⇒ **neither** surface is ever claimed, as in 081. It stays whole-provider; a
   single-surface refusal is expressed by leaving that surface's key list empty, or by returning
   `{ kind: "unavailable" }` from that surface's reader at run time (§5).
3. `postIdSource: "publicPostId"` ⇒ `missingPostId` is required. A registry test asserts it, as 081
   does for `missingScopes`.
4. `maxPostsPerRead` is honoured by the existing batching at
   `src/server/scheduler/insights-poll.ts:220` — `min(INSIGHTS_READ_PAGE_SIZE, maxPostsPerRead)`.
   A provider raising it above the configured page size gains nothing, which is why TikTok's 20 is
   a real cap while X's 100 is bounded by the page size of 25 until an operator raises it.

## §2 G35 — the declared identifier source

**Why**: TikTok's `external_id` is a publish receipt, not a queryable id. A generic layer that
assumes one identifier per target would either poll the wrong id or need a TikTok branch.

**Where it is honoured** — all three places, because any one alone would leak a call:

| Place | Behaviour |
|---|---|
| `claimDuePostMetricPolls`, the claim query | `AND <this provider's id column> IS NOT NULL`, inside the existing `OR`-of-`AND`s over providers. A target without one is never claimed and never leased |
| `claimDuePostMetricPolls`, the lazy insert | a target without one is inserted **already frozen**: `frozen_reason = 'unqueryable'`, `next_poll_at = null`, `unavailable_reason = declaration.missingPostId.reason`. One row written, zero calls spent (FR-010, FR-015) |
| `ClaimedPostMetricPoll.externalId` | carries the **source-appropriate** id, so `readPostMetrics` receives `posts: [{ externalId: <the public post id, for TikTok> }]` and the provider never learns which column it came from |

**What the provider sees**: nothing new. `PostMetricsReadContext.posts[].externalId` keeps its name
and its meaning — "the id you asked to be given". A provider that does not set `postIdSource` is
byte-for-byte unaffected.

**Reversal**: delete the field; both claims fall back to `external_id`; TikTok's declaration becomes
`unavailable`. Recorded in `docs/decisions.md`.

## §3 G36 — a public post id on the publish result

**Why**: the id exists exactly once, in TikTok's status reply, and today it is dropped into an
attempt summary that retention prunes.

**The hook**:

```ts
| { kind: "done"; externalId: string; url?: string; publicPostId?: string }
```

**Where it is honoured**: `stepOutcome` (`src/server/scheduler/record.ts`, pure) adds
`publicPostId: result.publicPostId ?? null` to the `published` patch. That is the whole generic
change — one line in one pure function, no provider key anywhere, and the existing `applied`/stale
guard in `publishing.ts` covers it unchanged.

**Constraints**:

- the value is length-capped at 64 by the column CHECK; a longer or empty value is **not sent** by
  the provider (`plausiblePublicPostId` filters it) rather than rejected at the database;
- it is **never** a precondition for anything in the publish path. A `done` without it publishes
  exactly as today (FR-011);
- `external_id` is untouched by it (FR-006).

**Reversal**: drop the field from the result type and the patch; the column stays, holding what the
backfill and prior publishes put there. Recorded in `docs/decisions.md`.

## §4 G37 — per-surface eligibility

**Why**: Pinterest's account numbers need only a scope every install already granted, while its pin
numbers need a new one. TikTok needs two *different* scopes for its two surfaces. One
`requiredScopes` list cannot express either without blocking a surface that works.

**Where it is honoured**:

| Consumer | Before | After |
|---|---|---|
| `claimDuePostMetricPolls` | `grantedScopes @> requiredScopes` | `grantedScopes @> postScopes`, over providers with a non-empty `post` |
| `claimDueAccountMetricPolls` | the same predicate | `grantedScopes @> accountScopes`, over providers with a non-empty `account` |
| `buildTargetInsightsView` | one `permission` | one `permission`, computed from the **post** set — it is a post panel |
| the accounts page | one "Insights need a reconnect" line | one line **per waiting surface**, naming which one waits on what |
| `countAccountsMissingInsightsScopes` | accounts missing `requiredScopes` | accounts missing **either** surface's set, deduplicated by account |

**One decision, mirrored twice.** `insightsPermissionFor` keeps its signature; it is called with
the relevant scope set. The SQL cannot call it, so
`tests/integration/insights/eligibility-matrix.test.ts` is the only guarantee, extended to the four
quadrants (post scope held only / account scope held only / both / neither) × (`granted_scopes`
null / narrow / wide), asserted against both claims' actual output.

**Reversal**: collapse both fields into one list, taking the union; every surface then needs every
scope, which is 081's behaviour. Recorded in `docs/decisions.md`.

## §5 Not a hook: persisting a run-time `unavailable` (FR-050)

A reader already returns `{ kind: "unavailable"; reason; docsPath? }`. The generic layer now
**keeps** it instead of discarding it, so a member sees why there are no numbers:

| Step | Change |
|---|---|
| `commitPostBatch` / `commitAccountResult`, `case "unavailable"` | also write `unavailableReason: redact(reason, secrets)` and `unavailableDocsPath: docsPath ?? null` |
| the same functions, on a successful `page` | **clear** both columns |
| any freeze (`gone`, `settled`, `expired`, `unqueryable`) | clear both — the frozen reason explains it now |
| `buildTargetInsightsView` | a new branch, **after** the permission checks and **before** `not_polled_yet`: a non-null `unavailableReason` renders the existing `unavailable` state with that reason and docs path |
| `PerformancePanel` | **no change** — it already renders `unavailable` with a "Learn more" link |

Because `declaration.unavailable` already maps to the same view state, the panel has one way to say
"Docket cannot read this", whether the refusal is static (X with the opt-in off) or run-time (a
Pinterest 403). No new provider hook, so no new G row; `docs/adding-a-provider.md` §21 records it as
a change to how an existing hook's output is used.

### The full panel ordering after this entry

1. `not_published` · 2. `platform_unsupported` · 3. `unavailable` (declaration) ·
4. `permission_not_requested` · 5. `needs_reconnect` · 6. `no_external_id` · 7. `gone` ·
8. `unqueryable` *(reason now from `unavailable_reason`, falling back to 080's sentence)* ·
9. `expired` · 10. `failing` · **11. `unavailable` (run-time, new)** · 12. `not_polled_yet` ·
13. `nothing_reported` · 14. `reported`.

A run-time refusal sits **after** `failing` so a transient error still shows as failing, and
**before** `not_polled_yet` so it can never be read as "not read yet" (FR-050, SC-003).

## §6 What the `mock` provider must be able to script (FR-052)

`src/providers/mock/settings.ts` gains, all non-secret and all off by default:

| Setting | Scripts |
|---|---|
| `insightsPostIdSource: "externalId" \| "publicPostId"` | G35 — a target with and without a queryable id |
| `insightsPostScopes` / `insightsAccountScopes` | G37 — the four quadrants, replacing `insightsRequiredScopes` |
| `insightsAccountReadBehaviour` | a run-time `unavailable` on the **account** surface alone |
| `insightsUnavailableDocsPath` | FR-050 — the docs link reaching the panel |

`mockInsightsRuleFor` returns the extended `InsightsProviderRule` of
[data-model.md §4](../data-model.md), so the eligibility matrix and the lazy-insert freeze are
exercisable with **no platform credentials and no network** (SC-004).
