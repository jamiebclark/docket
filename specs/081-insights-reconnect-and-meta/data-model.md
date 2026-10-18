# Phase 1 — data model

Feature: `081-insights-reconnect-and-meta` · [plan.md](./plan.md) · [research.md](./research.md)

One new column, one widened CHECK, one new index. **No new table, no new enum type, no change to any
snapshot table.** One migration covers all of it.

---

## §1 `social_accounts.granted_scopes` — the grant, as the platform reported it

```ts
// src/server/db/schema/accounts.ts, inside socialAccounts
/**
 * Permission identifiers the platform reported granting for this account (G31).
 * NULL = Docket has never recorded a grant (an install that has not reconnected, or a provider
 * whose reply does not list permissions). `{}` = the platform answered and granted nothing.
 * Never derived from what Docket requested. Not a secret.
 */
grantedScopes: text("granted_scopes").array(),
```

`NULL` and `{}` are deliberately different, and FR-007 requires them to read differently on screen.
Postgres distinguishes them for free; the risk is TypeScript code treating `?? []` as equivalent, so
`insightsPermissionFor()` takes `readonly string[] | null` and branches on `null` explicitly.

### Constraints (FR-009 — enforced by the database, not only by the writer)

```ts
check(
  "social_accounts_granted_scopes_shape",
  sql`${t.grantedScopes} IS NULL
      OR cardinality(${t.grantedScopes}) = 0
      OR (cardinality(${t.grantedScopes}) <= 40
          AND octet_length(array_to_string(${t.grantedScopes}, ',')) <= 1000
          AND array_to_string(${t.grantedScopes}, ',') ~ '^[a-z0-9_.:-]{1,64}(,[a-z0-9_.:-]{1,64})*$')`,
),
```

**Why the joined-string regex.** A CHECK cannot contain a subquery, so `unnest` is unavailable and
there is no per-element regex operator. Joining on `,` and matching a comma-separated grammar
validates **every** element, because `,` is absent from the character class — an element containing a
comma cannot satisfy the pattern. One scalar expression, no function, no trigger.

**Why this character class rejects tokens.** It is lowercase-only, has no `+`, `/`, `=`, `%` or
whitespace, and caps each element at 64 characters. It accepts every permission identifier Docket's
providers actually see — `instagram_manage_insights`, `read_insights`, `threads_manage_insights`,
`pages_show_list`, `pins:read` (Pinterest), `video.list` (TikTok), `tweet.read` / `offline.access`
(X) — and rejects the shapes a credential takes: Meta user tokens (`EAA…`, mixed case, hundreds of
characters), bearer tokens, JWTs (`.`-separated but long and mixed case), base64 (`=`, `+`, `/`),
PKCE verifiers. This is a **defence in depth**, not the primary one; the primary defence is
`normalizeGrantedScopes()` at the write boundary (§2), and the CHECK is what makes a future provider
that bypasses it fail loudly instead of storing a secret.

**Why the empty array is allowed past the regex.** `array_to_string('{}', ',')` is `''`, which no
non-empty pattern matches, so `{}` needs its own arm. FR-007 requires `{}` to be storable.

### Index

```ts
index("social_accounts_granted_scopes_idx").using("gin", t.grantedScopes),
```

The claim's eligibility test is `granted_scopes @> $1::text[]` (§4), which GIN answers. The table is
small in any realistic install, so this index is about keeping the predicate honestly indexable as
entries 3 and 4 add more required scopes, not about present-day speed.

### What is deliberately **not** done

- **No back-fill and no migration-time probe.** Every existing row starts `NULL` (spec Assumptions).
  A migration that called a platform would be a network call inside `pnpm db:migrate`.
- **No `NOT NULL` and no default.** `NULL` carries meaning.
- **No encryption.** Permission identifiers are public strings (spec Assumptions); the guard is
  validation plus the extended secret scan, which already serialises every `social_accounts` row
  minus its ciphertext (`tests/integration/security/secret-scan.test.ts:773-774`), so the new column
  is covered by construction. FR-015 asks for a case that proves a token-shaped list is *refused*,
  which is a test of §2, not of the scan's coverage.

---

## §2 `normalizeGrantedScopes` — the write boundary, and the only gate

New pure module `src/lib/granted-scopes.ts` (pure so both the DAL and the scheduler can import it,
and so `src/providers/**` could too without reaching into `src/server/**`):

```ts
export const GRANTED_SCOPE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
export const MAX_GRANTED_SCOPES = 40;
export const MAX_GRANTED_SCOPES_BYTES = 1000;

/**
 * The list as it may be stored, or `null` to leave the column unset (FR-009).
 * Total: never throws. Order is the platform's own, duplicates removed keeping the first.
 * Returns `null` — not a filtered list — when any entry fails, so a reply carrying one
 * token-shaped string stores nothing rather than a half-truth.
 */
export function normalizeGrantedScopes(raw: unknown): string[] | null;
```

Rules, in order:

| Input | Result | Why |
|---|---|---|
| `undefined` / `null` | `null` | "not reported" (FR-011, FR-012) |
| not an array | `null` | a provider bug must not become a stored value |
| `[]` | `[]` | "answered, granted nothing" (FR-007) |
| any element not a string | `null` | whole-list rejection |
| any element failing `GRANTED_SCOPE_PATTERN` | `null` | **FR-015 / the token-shaped edge case** |
| more than 40 entries, or over 1000 bytes joined | `null` | bounded (FR-009) |
| otherwise | deduped, order preserved | deterministic for tests |

**Whole-list rejection, not per-element filtering**, is the deliberate choice. Filtering would keep
the good entries from a reply Docket evidently misunderstood, and could leave an account *eligible*
on the strength of a list that also contained a secret. Rejecting leaves the column `NULL`, which
reads as "Insights need a reconnect" — honest, recoverable, and never a false grant. The connect or
refresh itself still succeeds (FR-009): a grant Docket cannot record is not a reason to refuse a
working connection.

**Exactly two callers**, which is FR-010's requirement:

1. `upsertConnected` (`src/server/dal/accounts.ts:160-201`) — from `ConnectCandidate.grantedScopes`.
2. `applyRefreshResult` (`src/server/scheduler/credentials.ts:56`) — from the success arm of
   `RefreshResult`, **and only when the field is present** (FR-011): the patch spreads
   `...(normalized !== null ? { grantedScopes: normalized } : {})`, so a refresh that reports nothing
   writes nothing and a working reader does not stop a few days after it started (spec constraint 6).

A lint-level guard is not available for "only these two may write this column", so the test is: grep
the repo for `grantedScopes:` in an update/insert position and assert exactly those two sites, in the
same style as the existing enumerated-surface tests.

**Reconnect preservation (FR-014) is an existing property to pin, not to build.** `upsertConnected`
already updates in place on `(project_id, provider_key, external_account_id)` among non-removed rows
and already leaves `id`, `postingInstructions`, `publishLimitCount`, `publishLimitWindowSeconds`,
`removedAt` and `createdAt` untouched; slot assignments, engagement state, poll states and snapshots
all key off `id`, so they survive automatically. The work is the test, over every OAuth group, that
says so — including that no second row appears and that the insights poll state and its snapshots are
still attached afterwards.

---

## §3 `post_metric_poll_states.frozen_reason` — two more terminal reasons

```ts
// was: IN ('settled', 'gone')
check(
  "post_metric_poll_states_frozen_reason_enum",
  sql`${t.frozenReason} IS NULL
      OR ${t.frozenReason} IN ('settled', 'gone', 'expired', 'unqueryable')`,
),
```

| Reason | Meaning | Added by |
|---|---|---|
| `settled` | 080: the decaying schedule reached 28 days | 080 |
| `gone` | 080: the platform no longer returns this post | 080 |
| **`expired`** | the subject was ephemeral and its lifetime has passed; its numbers are final | FR-040 |
| **`unqueryable`** | the stored external id cannot be used against the insights endpoint | FR-036 |

Both are **terminal and not failures**. `frozen_at IS NOT NULL` forces `next_poll_at IS NULL` through
the existing `post_metric_poll_states_frozen_has_no_next` CHECK, and the claim predicate requires
`next_poll_at IS NOT NULL`, so a target frozen for either reason is invisible to the claim whatever a
later caller forgets. That is 080's "freeze, in two expressions at once" property, inherited free.

This widening is why 080 chose a text CHECK over a pg enum (080 plan, post-design re-check #3): an
`ALTER TABLE … DROP CONSTRAINT` + `ADD CONSTRAINT` in one migration, no `ALTER TYPE`, no index
rebuild, no partial-index-cannot-cast-an-enum problem.

`account_metric_poll_states` has **no** freeze columns and gains none — an account still never
freezes (080 FR-029). An account that becomes ineligible simply stops being claimed (§4).

---

## §4 The claim signature — from provider keys to provider rules (G33)

```ts
// src/server/dal/insights-claims.ts
export interface InsightsProviderRule {
  providerKey: string;
  /** Empty = no permission needed (Bluesky, mock). Otherwise every one must be held. */
  requiredScopes: readonly string[];
  /** FR-038/FR-041: used by the lazy insert to freeze an already-expired subject with no call. */
  ephemeralPostTypes: readonly { postType: string; lifetimeMs: number }[];
}
```

`claimDueAccountMetricPolls`, `claimDuePostMetricPolls` and `countPublishedWithoutExternalId` take
`providers: readonly InsightsProviderRule[]` in place of `providerKeys: readonly string[]`. The
scheduler builds the list from the registry, so the DAL still imports no provider code.

### The eligibility predicate, in SQL

Replacing `inArray(socialAccounts.providerKey, providerKeys)` in **every** place it appears (both
claims' `missing` query, both claims' main query, and the companion count):

```ts
/** FR-022/FR-023. An ineligible account never reaches a lease, a decrypt or a call. */
function eligible(rules: readonly InsightsProviderRule[]) {
  return or(
    ...rules.map((r) =>
      r.requiredScopes.length === 0
        ? eq(socialAccounts.providerKey, r.providerKey)
        : and(
            eq(socialAccounts.providerKey, r.providerKey),
            isNotNull(socialAccounts.grantedScopes),
            sql`${socialAccounts.grantedScopes} @> ${sql.param([...r.requiredScopes])}::text[]`,
          ),
    ),
  );
}
```

Four properties worth stating because tests assert each:

1. **`NULL` is ineligible.** `NULL @> anything` is `NULL`, which is not `TRUE`, so `isNotNull` is
   belt-and-braces rather than load-bearing — but it makes the intent readable and survives someone
   adding `OR` branches later.
2. **`{}` is ineligible** whenever `requiredScopes` is non-empty, and eligible when it is empty.
3. **A superset is eligible.** `@>` is containment, not equality, so an account that granted more
   than Docket needs is read, which is correct.
4. **Bluesky and `mock` are untouched** — `requiredScopes: []` collapses the branch to today's
   `providerKey = …`, so 080's behaviour is byte-identical for them (FR-024, US1-AS5).

An empty `rules` array short-circuits to `[]` / `0` exactly as the empty `providerKeys` array does
today.

### The lazy insert gains a freeze arm (FR-041)

`claimDuePostMetricPolls` creates a missing state row with
`nextPollAt: nextPostPollAt({…})`. It now selects `postTargets.chosenPostType` as well and calls the
new decision function (contracts/provider-insights-081.md §4):

```ts
const decision = postPollDecision({
  publishedAt: row.publishedAt!, lastCapturedAt: null, now: opts.now,
  minIntervalMs: opts.minIntervalMs,
  chosenPostType: row.chosenPostType,
  ephemeralPostTypes: rule.ephemeralPostTypes,
});
await exec.insert(postMetricPollStates).values(
  decision.kind === "due"
    ? { …ids, nextPollAt: decision.at }
    : { …ids, nextPollAt: null, frozenAt: opts.now, frozenReason: decision.reason },
).onConflictDoNothing(…);
```

So an Instagram story already past its 24 hours when the subsystem first sees it is inserted
**frozen `expired`**, with no provider call and **no** 080 catch-up capture — which is what FR-041
asks for, achieved by making the row born frozen rather than by adding a skip somewhere.

### One new companion count (FR-049)

An ineligible account is excluded by the claim, so the claim cannot report it. As with
`countPublishedWithoutExternalId`, visibility needs its own query:

```ts
/** Active accounts whose provider wants insights but whose grant does not cover it (FR-049). */
export function countAccountsMissingInsightsScopes(
  providers: readonly InsightsProviderRule[],
): Promise<number>;
```

counting non-removed, `active` accounts whose provider has a non-empty `requiredScopes` and for which
`granted_scopes IS NULL OR NOT (granted_scopes @> requiredScopes)`. Wrapped in
`crossProject("scheduler: count insights-ineligible accounts", …)` like its sibling.

A second companion count for unqueryable external ids is **not** added: an unqueryable target *is*
claimed (Docket cannot tell a video id from a post id in SQL without teaching the DAL about
Facebook, which constitution V forbids), the provider reports it per entry, and the section counts it
from the read result. See contracts/scheduler-insights-081.md §3.

---

## §5 Configuration

Everything new is **per connect group** or **per provider**, parsed by that provider's own
`config.ts` from `process.env` — the `TIKTOK_APP_AUDITED` precedent — so nothing is added to
`src/server/env.ts` and `src/server/scheduler/config.ts` is untouched.

| Variable | Shape | Default | Read by | Requirement |
|---|---|---|---|---|
| `META_INSIGHTS_SCOPES` | `true` / `false` | **`false`** | `parseMetaEnv` → `MetaConfig.insightsScopes` | FR-017 |
| `THREADS_INSIGHTS_SCOPES` | `true` / `false` | **`false`** | `parseThreadsEnv` | FR-017 |
| `META_INSIGHTS_USAGE_CEILING` | integer 1–100 (percent) | **`80`** | `src/providers/meta/config.ts` | FR-045 |
| `THREADS_INSIGHTS_USAGE_CEILING` | integer 1–100 (percent) | **`80`** | `src/providers/threads/config.ts` | FR-045 |

- Both flags are declared in their group's `environment.variables` as
  `{ secret: false, required: false }` and validated with `reason: "must be true or false"`, matching
  `TIKTOK_APP_AUDITED` exactly (`src/providers/tiktok/config.ts:60`). An invalid value is an
  environment **issue**, not a crash, and is shown on the accounts page as every other issue is.
- **Default off is the whole point of FR-017/FR-018.** With both unset, `dialogUrl` produces the
  byte-identical URL it produces today, which is what US1-AS1 asserts.
- `80` for the ceiling: Meta's own exhaustion is at 100, and the header is sampled only on responses
  Docket already received, so a 20-point margin leaves room for the publishing path — which shares the
  same BUC budget — to finish the window. Configurable because the right number depends on how much
  else the install does with the same Meta app (spec Assumptions).
- No new `INSIGHTS_*` scheduler knob. The nine 080 added are unchanged.

### `.env.example`

One block per group, each naming the permission it adds, the fact that the permission must **also**
be added to the Meta app / Threads app, and the Login-for-Business caveat (FR-019, FR-053).

---

## §6 Type changes, in one place

```ts
// src/providers/types.ts

export interface ConnectCandidate {
  …
  /** Permission identifiers the platform reported granting (G31). Absent = not reported. */
  grantedScopes?: readonly string[];
}

export type RefreshResult =
  | { ok: true; credentials: unknown; expiresAt: Date | null; displayName?: string;
      /** G31. Absent leaves the stored grant unchanged (FR-011). */
      grantedScopes?: readonly string[] }
  | { ok: false; reason: string; transient?: boolean; retryAt?: Date };

export interface OAuthConnectGroup {
  …
  /** G32. The extra permissions this group may request, and whether it is asking for them now. */
  optionalScopes?: {
    /** Every extra scope, each with the purpose it serves. Static, non-secret, shown in docs. */
    declared: readonly { scope: string; purpose: string }[];
    /** Published guide explaining the opt-in, e.g. `docsUrl("meta-setup", "insights")`. */
    doc?: string;
    /** Pure; reads only `source`. The scopes this group will add to its dialog as configured now. */
    requested(source: Readonly<Record<string, string | undefined>>): readonly string[];
    /**
     * Pure. Non-null when the operator opted in but Docket cannot widen the dialog — Facebook
     * Login for Business takes its permission set from the Meta app's configuration (FR-019).
     * Reconnecting cannot help, so no reconnect control is offered.
     */
    cannotWiden?(source: Readonly<Record<string, string | undefined>>): { reason: string; doc?: string } | null;
  };
}

export interface InsightsDeclaration {
  …                                   // post, account, maxPostsPerRead, readBudget, unavailable
  /** G33. Permissions an account must hold before any read is attempted. Default empty. */
  requiredScopes?: readonly string[];
  /** G33. Shown when `requiredScopes` are not held. Required when `requiredScopes` is non-empty. */
  missingScopes?: { reason: string; docsPath?: string };
  /** G34. Post types whose numbers die after `lifetimeMs` from publication. */
  ephemeralPostTypes?: readonly { postType: PostType; lifetimeMs: number }[];
}

export type PostMetricEntry =
  | { externalId: string; kind: "metrics"; metrics: unknown }
  | { externalId: string; kind: "gone" }
  /** FR-036. This id cannot be used against the insights endpoint. Terminal, **not** a failure. */
  | { externalId: string; kind: "unqueryable"; reason: string };
```

### Registry-load assertions (extending `assertInsightsDeclaration`, 080 FR-004)

Checked once at module load, so a provider cannot ship a declaration that would mislead the UI:

1. `requiredScopes` non-empty ⇒ `missingScopes.reason` is a non-empty string of at most 300
   characters. Without it the accounts page would have no reason to show.
2. every `requiredScopes` entry matches `GRANTED_SCOPE_PATTERN` — otherwise the SQL containment test
   could never be satisfied by a value the column is able to store.
3. every `ephemeralPostTypes.postType` is a known `PostType`, appears in the provider's own
   `capabilities.postTypes`, and is unique within the list.
4. every `ephemeralPostTypes.lifetimeMs` is an integer in `[60_000, 30 * 86_400_000]`.
5. `unavailable` and `requiredScopes` are not both set — a blanket-unavailable surface is never
   claimed anyway, so required scopes on it would be dead configuration that still produces an
   "Insights need a reconnect" line for an account that could never read. (This is the one assertion
   that exists purely to stop a confusing screen rather than a crash.)

### `AccountView` (`src/server/services/accounts.ts:25-42`)

```ts
  /** G33. Null when this provider declares no insights or needs no permission. */
  insightsPermission: InsightsPermission | null;
```

computed by the service from the account's `grantedScopes`, the provider's declaration and the
group's `optionalScopes`, via the single pure helper — so the page renders a decision rather than
making one. `status`, `notes`, `publishLimit` and every other field are unchanged; FR-013 and FR-027
are satisfied by addition only.
