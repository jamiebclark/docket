# Phase 1 — data model

Feature: `082-insights-tiktok-pinterest-x` · Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md)

**One migration, five columns, one backfill. No new table, no new enum type, no change to either
snapshot table, no change to any existing CHECK.** Every entity below already exists; this entry
widens three of them and reuses the rest untouched.

---

## §1 `post_targets.public_post_id` (new column) — FR-005, FR-006, FR-009

```text
public_post_id  text  NULL
```

| Property | Value | Why |
|---|---|---|
| Nullable | yes | Null is the normal state for every provider but TikTok, and the honest state for a TikTok target whose id is gone or was never issued (FR-010) |
| CHECK `post_targets_public_post_id_len` | `public_post_id IS NULL OR char_length(public_post_id) BETWEEN 1 AND 64` | FR-009's "reject a value that is not a plausible id rather than store it", enforced in the database as well as in code. 64 matches the existing `publishId` bound in `src/providers/tiktok/publish.ts` |
| Index | **none** | It is never a search key. The claim filters on it with `IS NOT NULL` *after* joining a target it already selected by poll state, so the existing `post_metric_poll_states_claim_idx` still drives the plan |
| Relationship to `external_id` | independent | `external_id` keeps holding TikTok's `publish_id`, so the external-id ledger, duplicate detection and `external_url` are byte-for-byte unchanged (FR-006) |
| Who writes it | the generic publish path only, from `{ kind: "done", publicPostId }` (G36), plus the one-off backfill | TikTok's provider code never touches the database (constitution V) |
| What it never holds | a credential, a token, a signed URL | Covered by the extended secret scan, not by an exemption (FR-013) |

**Null means "this post's numbers cannot be read" — never "zero".** A target with
`postIdSource: "publicPostId"` and a null column is frozen `unqueryable` by the claim's lazy insert
and never claimed again (§4).

## §2 `post_metric_poll_states` and `account_metric_poll_states` (four new columns) — FR-050

```text
unavailable_reason     text  NULL
unavailable_docs_path  text  NULL
```

on **both** tables, with on each:

- `*_unavailable_reason_len`: `unavailable_reason IS NULL OR char_length(unavailable_reason) <= 500`
  — the same bound `last_error` already carries, and the same `redact` pass writes it;
- `*_unavailable_docs_pair`: `unavailable_docs_path IS NULL OR unavailable_reason IS NOT NULL` — a
  link without a reason is meaningless;
- `*_unavailable_docs_path_len`: `unavailable_docs_path IS NULL OR char_length(unavailable_docs_path) <= 100`.

**Lifecycle**, in the generic commit (`src/server/scheduler/insights-poll.ts`):

| Event | `unavailable_reason` | `unavailable_docs_path` |
|---|---|---|
| read returns `{ kind: "unavailable", reason, docsPath }` | set to the redacted reason | set, or null |
| read returns `{ kind: "page" }` (any success) | **cleared** | cleared |
| any other failure kind | left as it was | left as it was |
| the subject freezes (`gone`, `settled`, `expired`, `unqueryable`) | cleared — the frozen reason is now the explanation | cleared |

**Why these columns and not an inference.** The alternative is "non-null `last_error` with
`consecutive_failures = 0` means unavailable". That is exactly the shape the `unqueryable` freeze
writes, so the two states would be indistinguishable. Four nullable columns in a migration this
entry already ships is cheaper than a wrong panel. Recorded in `docs/decisions.md`.

## §3 The backfill, inside the same migration — FR-008, FR-009, FR-063

One statement, after the column and its CHECK exist:

```sql
UPDATE post_targets t
   SET public_post_id = src.id
  FROM (
    SELECT DISTINCT ON (a.post_target_id)
           a.post_target_id,
           a.response_summary -> 'publicPostIds' ->> 0 AS id
      FROM publish_attempts a
     WHERE jsonb_typeof(a.response_summary) = 'object'
       AND a.response_summary -> 'publicPostIds' ->> 0 IS NOT NULL
     ORDER BY a.post_target_id, a.created_at DESC
  ) src
 WHERE t.id = src.post_target_id
   AND t.public_post_id IS NULL
   AND char_length(src.id) BETWEEN 1 AND 64;
```

| Requirement | How this satisfies it |
|---|---|
| FR-008 "the first id of the most recent attempt row that carries one" | `->> 0` takes the first element; `DISTINCT ON … ORDER BY created_at DESC` takes the most recent such attempt |
| FR-008 "leave the column null where no attempt row survives" | an inner join against only the rows that carry one |
| FR-009 idempotent, never overwrites | `AND t.public_post_id IS NULL`; running it twice changes nothing |
| FR-009 rejects an implausible value | the `char_length` guard, mirroring the column CHECK, so the statement cannot fail the migration on bad legacy data |
| Provider-agnostic | it does not name TikTok. Only TikTok's publish writes `publicPostIds`, so only TikTok's targets match — no `provider_key` filter is needed, and none is written |

The `jsonb_typeof` guard is belt-and-braces: `response_summary` defaults to `{}` and the engine
only ever writes objects, but a `->` on a scalar would be a pointless way to fail a migration. The
statement scans `publish_attempts` once — `publish_attempts_target_created_idx` leads with
`project_id` so it does not drive this plan, which is correct for a one-off bounded by the retention
window.

The migration is generated by `pnpm db:generate` for the DDL; the backfill is appended to the
generated file by hand (the repo's existing practice for data migrations), and `pnpm db:check` must
be green after it.

---

## §4 `InsightsProviderRule` — the shape the scheduler passes the DAL (extended) — G35, G37

`src/server/dal/insights-claims.ts` must not import the provider registry, so the scheduler builds
one rule per provider from the declaration and hands it down. 081's shape gains two fields and
splits one:

```ts
export interface InsightsProviderRule {
  providerKey: string;
  /** G37. Scopes the POST surface needs. Empty = none (Bluesky, mock). */
  postScopes: readonly string[];
  /** G37. Scopes the ACCOUNT surface needs. Empty = none (Pinterest, Bluesky, mock). */
  accountScopes: readonly string[];
  /** G35. Which stored column the post reader is given. */
  postIdSource: "externalId" | "publicPostId";
  /** G37. False when the provider declares no post metrics — the post claim skips it entirely. */
  postMetricsDeclared: boolean;
  /** G37. False when the provider declares no account metrics — the account claim skips it (X). */
  accountMetricsDeclared: boolean;
  /** Unchanged from 081 (G34). */
  ephemeralPostTypes: readonly { postType: string; lifetimeMs: number }[];
}
```

The 081 field `requiredScopes` is **replaced** by `postScopes` + `accountScopes`. Every existing
provider is migrated by setting both to the old value (Instagram, Facebook, Threads) or both to
empty (Bluesky, mock), so no current behaviour changes.

### The eligibility predicate, per surface

| Claim | Predicate added to 081's | Effect |
|---|---|---|
| `claimDuePostMetricPolls` | `eligible(rules, "post")` — the same `grantedScopes @> postScopes` test, over providers with `postMetricsDeclared` | An account lacking a post scope is never claimed for a post read even if its account reads work (Pinterest) |
| `claimDuePostMetricPolls` | `isNotNull(idColumn(rule))` per provider, where `idColumn` is `post_targets.external_id` or `post_targets.public_post_id` (**G35**) | A TikTok target with no public post id is **never claimed, never leased, never decrypted for** (FR-015) |
| `claimDueAccountMetricPolls` | `eligible(rules, "account")`, over providers with `accountMetricsDeclared` | Pinterest accounts qualify with today's grant; X accounts are never claimed at all, because X declares `account: []` |

Both claims' **lazy inserts** change with them:

- the post claim's `missing` select applies the same per-provider id predicate, so a target with no
  queryable id gets a state row inserted **frozen** `{ nextPollAt: null, frozenAt: now,
  frozenReason: "unqueryable", unavailableReason: <the provider's reason> }` — one row, zero calls
  (FR-015, FR-010);
- the account claim's `missing` select skips providers with `accountMetricsDeclared: false`, so no
  X account ever gets an account-poll state row.

The existing `frozen_reason` enum CHECK already allows `unqueryable` (081 widened it), so **no
CHECK changes**.

### The companion counts

| Count | 081 behaviour | 082 behaviour |
|---|---|---|
| `targetsSkippedNoExternalId` | published, insights-eligible, `external_id IS NULL` | unchanged — it is about hand-resolved targets (FR-014) |
| `accountsSkippedNoPermission` | accounts missing `requiredScopes` | now counts an account missing **either** surface's scopes, deduplicated by account id, over providers that declare that surface |
| `targetsSkippedNoPublicPostId` (**new**) | — | published, insights-eligible, provider's `postIdSource` is `publicPostId`, column is null (FR-053) |

## §5 Insights declaration (existing contract, extended) — G35, G37

See [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §1 for the full
type. The three added fields are `postScopes`, `accountScopes` and `postIdSource`;
`requiredScopes`/`missingScopes` become `postScopes`/`accountScopes` with one
`missingScopes: { reason, docsPath }` each (`missingPostScopes`, `missingAccountScopes`).

## §6 `StepResult` `{ kind: "done" }` (existing contract, extended) — G36

```ts
| { kind: "done"; externalId: string; url?: string; publicPostId?: string }
```

`stepOutcome` (`src/server/scheduler/record.ts:51`) adds
`publicPostId: result.publicPostId ?? null` to the `published` patch — one line, pure, no provider
key. A provider that never sets it leaves the column null forever, which is the correct state for
every provider but TikTok.

## §7 Entities reused with no change

| Entity | Used how |
|---|---|
| `post_metric_snapshots` | gains rows for three more `provider_key` values. Shape, CHECKs, indexes and the 2000-byte metrics cap unchanged |
| `account_metric_snapshots` | the same; Pinterest starts writing them immediately |
| `social_accounts.granted_scopes` | read by both claims and by `insightsPermissionForAccount`; now also **written at refresh** for TikTok and Pinterest (FR-056), through the `grantedScopes` field `RefreshResult` already carries (G31) |
| `post_metric_poll_states.frozen_reason` | `unqueryable` now also means "no queryable identifier"; the enum is unchanged |
| The decay schedule, the reserve, the lease, the tick section | unchanged (spec assumption) |

## §8 Metric keys declared by this entry

Each key is stored verbatim and rendered under the platform's own label; **nothing is summed,
averaged or compared across the three blocks** (FR-047, SC-009).

| Provider | Surface | Keys (platform's own names) | Labels |
|---|---|---|---|
| TikTok | post | `tiktok_like_count`, `comment_count`, `share_count`, `view_count` | Likes, Comments, Shares, Views |
| TikTok | account | `tiktok_follower_count`, `likes_count`, `video_count` | Followers, Likes, Videos |
| Pinterest | post | `IMPRESSION`, `PIN_CLICK`, `OUTBOUND_CLICK`, `SAVE` | Impressions, Pin clicks, Outbound clicks, Saves |
| Pinterest | account | `pinterest_follower_count`, `monthly_views` | Followers, Monthly views |
| X | post | `like_count`, `reply_count`, `retweet_count`, `quote_count`, `bookmark_count`, `impression_count` | Likes, Replies, Reposts, Quotes, Bookmarks, Impressions |
| X | account | **none** — `account: []` | — (price UNVERIFIED, FR-043) |

Three platforms now label something "Views"/"Impressions" and mean three different events. That is
why the keys stay provider-local and why no constant leaves a provider folder — 080's structural
rule, which this entry only has to not break. Every value is a `z.number().optional()` in the
provider's own schema, so a metric the response omitted is **absent**: no row, no dash, no zero
(FR-024, FR-034, SC-003).

TikTok's and Pinterest's account readers request the platform's own `follower_count` field (shown
above and in contracts/platform-readers-082.md §1/§2) but store it under `tiktok_follower_count` /
`pinterest_follower_count`: the raw field name collides with Instagram's existing declared
`follower_count` key, and TikTok's raw `like_count` collides with X's declared `like_count` — a
declared key must stay disjoint across every provider, not just within one (FR-018, constitution V,
caught by `tests/integration/insights/provider-seam.test.ts`).
