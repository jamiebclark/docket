# Contract: G40a — read scopes on an `engagement` declaration, checked in the claim

**Feature**: `084-meta-engagement-facts-and-scope-gate` | `src/providers/types.ts`,
`src/providers/registry.ts`, `src/server/dal/engagement-read-claims.ts`,
`src/server/dal/scope-predicates.ts`, `src/server/scheduler/engagement-read.ts`

Satisfies FR-011 to FR-014, FR-018 to FR-025, FR-038, FR-040, FR-041.

G40's other half — `cannotWiden` per surface — is
[optional-scopes-per-surface.md](./optional-scopes-per-surface.md). They are one numbered change: see
§6.

## 1. The declaration

```ts
export interface EngagementDeclaration {
  reads: readonly EngagementItemKind[];
  canReply: boolean;
  writeBudget?: PublishLimit;
  /**
   * Set when a surface is known to need a permission the install cannot hold (077 FR-055).
   * A blanket claim about the whole provider on this install.
   */
  unavailable?: { reason: string; docsPath?: string };
  /**
   * G40. Permissions an account must hold before Docket reads a single comment for it.
   * Default empty — "no permission needed", which is every provider's behaviour today.
   * A per-account claim: two accounts on the same provider may differ.
   */
  readScopes?: readonly string[];
  /** G40. Shown when `readScopes` are not held. Required when `readScopes` is non-empty. */
  missingReadScopes?: { reason: string; docsPath?: string };
}
```

**One pair, not two.** Engagement has one read surface, so there is one `readScopes`, unlike
insights' `postScopes` + `accountScopes`. **No reply or send scope is added** (FR-015): replying to a
Meta surface is out of scope for the whole roadmap, and a declaration field with no consumer invites
a guess about which permission it needs.

`unavailable` and `readScopes` say different things and are mutually exclusive (§2): "not readable
here at all" versus "not granted by this account yet".

## 2. Registry assertions — `assertEngagementDeclaration`

New in `src/providers/registry.ts`, run over every provider at module load
(`for (const p of providers) assertEngagementDeclaration(p)`), beside the two assertions already
there. There is no engagement assertion today, so two 077-era rules that were comments become
enforced in passing.

Message prefix, matching the existing style:
`Inconsistent engagement declaration for ${provider.key}: ${why}.`

| Check | Message fragment | FR |
|---|---|---|
| `reads.length > 0` | `reads is empty; omit engagement instead` | 077 FR-053 (newly enforced) |
| `unavailable.reason` 1–300 chars when `unavailable` set | `unavailable.reason must be 1-300 characters` | 077 FR-055 (newly enforced) |
| not (`unavailable` && `readScopes?.length`) | `unavailable and readScopes must never both be set` | **FR-013** — names both fields |
| `readScopes?.length` ⇒ `missingReadScopes.reason` 1–300 chars | `readScopes is non-empty but missingReadScopes.reason is missing or not 1-300 characters` | **FR-012** |
| every scope matches `GRANTED_SCOPE_PATTERN` | `readScopes entry "${scope}" does not match GRANTED_SCOPE_PATTERN` | **FR-012** |

`GRANTED_SCOPE_PATTERN` is `src/lib/granted-scopes.ts`'s existing `/^[a-z0-9_.:-]{1,64}$/` — the same
one the insights declaration enforces, imported, not restated (FR-012's "the same pattern").

Absent or `[]` `readScopes` passes every check and means "no permission needed" (FR-014). Load-time,
not tick-time: a provider bug is a startup failure (US3 scenarios 6 and 7).

## 3. Eligibility

> An account is eligible for a provider's engagement reads when that provider declares `engagement`
> without a blanket `unavailable`, **and** either the declared read-scope list is empty **or** the
> account's recorded grant is non-null and contains every declared read scope. (FR-018)

Three grant states, all distinct (FR-021):

| `granted_scopes` | Non-empty `readScopes` declared | Verdict |
|---|---|---|
| `NULL` (never recorded) | yes | **ineligible** — `NULL` means "not known", never "holds everything" |
| `{}` (recorded as nothing) | yes | **ineligible** — granted nothing |
| missing one of several | yes | **ineligible** — no partial credit; the displayed reason names the whole requirement |
| contains all (or a superset) | yes | eligible |
| any, including `NULL` | no (`[]` or absent) | **eligible** — matched by provider key alone (FR-022: Bluesky, `mock`) |

The pure form of this decision is `scopePermissionFor` ([scope-permission.md](./scope-permission.md));
the SQL form is §4. FR-023 requires the two never to disagree, which §5 pins.

## 4. The claim

`claimDueEngagementReads` takes rules instead of keys:

```ts
export interface EngagementProviderRule {
  providerKey: string;
  readScopes: readonly string[];   // empty = no permission needed
}

claimDueEngagementReads(opts: {
  now: Date; limit: number; leaseMs: number; minIntervalMs: number;
  providers: readonly EngagementProviderRule[];   // was: providerKeys: readonly string[]
}): Promise<ClaimedEngagementAccount[]>
```

Shared SQL, new `src/server/dal/scope-predicates.ts`, used by this claim, the insights claim and both
companion counts:

```ts
/** Holds every scope. NULL = not recorded, so it holds nothing. [] = no predicate at all. */
export function accountHoldsScopes(scopes: readonly string[]): SQL | undefined;
//   []        → undefined (caller omits the condition)
//   otherwise → granted_scopes IS NOT NULL AND granted_scopes @> $scopes::text[]

/** Missing at least one. The negation, with NULL on the missing side. */
export function accountMissingScopes(scopes: readonly string[]): SQL;
//   granted_scopes IS NULL OR NOT (granted_scopes @> $scopes::text[])
```

Eligibility condition, `OR` over the rules:

```ts
const eligible = (rules) => or(...rules.map((r) =>
  r.readScopes.length === 0
    ? eq(socialAccounts.providerKey, r.providerKey)
    : and(eq(socialAccounts.providerKey, r.providerKey), accountHoldsScopes(r.readScopes)),
));
```

Applied in **both** places, inside the one existing transaction:

| # | Site | FR | Guarantee |
|---|---|---|---|
| 1 | the lazy-insert left-join select, before `INSERT … ON CONFLICT DO NOTHING` | **FR-020** | no `engagement_account_states` row is created for an account that may not be read |
| 2 | the due-rows select with `FOR UPDATE SKIP LOCKED` | **FR-019** | not claimed ⇒ not leased ⇒ credentials never decrypted ⇒ no provider read attempted |

Gating only (2) would leave (1) writing state rows for unpermitted accounts — the spec's Constraint 5,
and the reason the insights claim gates both.

**Everything else about the claim is unchanged**: `FOR UPDATE SKIP LOCKED` on
`engagement_account_states` only, the same ordering, the same `limit`, the same lease update, the same
`crossProject` wrapper, the same `ACCOUNTS_PER_RUN = 20`.

**Concurrency** (spec Edge Cases): the predicate is evaluated inside the claiming transaction, so two
overlapping ticks each either see a grant or do not, and neither can claim an account the predicate
excluded. No new lock, no new ordering, nothing to deadlock against.

**An account that gains the grant** is picked up by (1) on the next run — it is a left-join for
absence, not a one-shot backfill — and read from its first page with no manual step (US3 scenario 5).

**An account that loses the grant** stops being claimed. Items already read stay readable, unchanged,
not withdrawn and not deleted, and retention is untouched (FR-024). Publishing, status badge,
publish limits and `needs_reauth` are untouched on every path (FR-025) — the gate is read-only and
adds no write to `social_accounts`.

## 5. The companion count

```ts
export function countAccountsMissingEngagementScopes(
  rules: readonly EngagementProviderRule[],
): Promise<number>;
```

- considers only rules with a **non-empty** `readScopes`; if there are none it returns `0` **without
  issuing a query** (FR-038, US6 scenario 3);
- `SELECT count(*)::int FROM social_accounts WHERE removed_at IS NULL AND status = 'active' AND (…)`,
  where `(…)` is an `OR` of `provider_key = $k AND accountMissingScopes($scopes)`;
- counts an account **exactly once** (FR-038, US6 scenario 2): the arms are mutually exclusive because
  `provider_key` is single-valued, so no `DISTINCT` is needed — asserted rather than assumed;
- wrapped in `crossProject("scheduler: count engagement-ineligible accounts", …)`.

Surfaced as `accountsSkippedNoPermission` on `EngagementReadCounts`, set in `runEngagementRead` right
after the claim, exactly where `runInsightsPoll` sets its own
(`src/server/scheduler/insights-poll.ts:113`). It is **distinct from** `unavailable`, `failed` and
`rateLimited` and never conflated with them (FR-038, US6 scenario 4): `unavailable` is a
provider-level refusal, this is a per-account missing grant.

Without this count the only visible effect of the gate would be a tick that claims fewer accounts and
reports success — the silent-skip failure this codebase has repeatedly been bitten by.

## 6. Why this and `cannotWiden` are one change (G40), and how to reverse it

They answer one question from two sides: *may this account's comments be read, and if not, can
reconnecting fix it?* Shipping the declaration alone would let the UI say "not granted" on an install
whose dialog cannot be widened, sending a member round a reconnect loop that cannot grant anything —
the precise failure 081 called out and the roadmap entry instructs us to honour (spec Constraint 6).

Index entry, `docs/adding-a-provider.md` "Generic hooks index" (today's last row is G39):

```text
| G40 | `readScopes`/`missingReadScopes` on an `engagement` declaration, checked in the claim; `optionalScopes.cannotWiden` answered per surface | 4, 20 |
```

**Reversal**: delete both declaration fields and `assertEngagementDeclaration`'s last three checks;
restore `claimDueEngagementReads`'s `providerKeys: readonly string[]`; delete
`countAccountsMissingEngagementScopes` and the count field; drop the `surface` argument from
`cannotWiden`; delete both env flags and the engagement entries from both groups' `declared`. Nothing
persisted has to be undone, because nothing is persisted. `src/server/dal/scope-predicates.ts` and
`src/lib/scope-permission.ts` stay — they are the insights code, relocated.

## 7. Tests (FR-041 — every path, no live call)

| What | Where | Asserts |
|---|---|---|
| registry assertions | `src/providers/registry.test.ts` (unit) | each of §2's five failures by message; a valid declaration loads |
| claim exclusion | `tests/integration/engagement/scope-gate.test.ts` | an account missing one scope is **not** returned; its `read_lease_until`/`read_lease_owner` are still `NULL`; **no decrypt happened** (spy on `decryptCredentials`, call count 0) and the provider's `read` was never invoked — FR-019 proven by absence, not by a refusal |
| `NULL` grant | same | treated as not holding the scopes |
| lazy-insert exclusion | same | no `engagement_account_states` row exists for the ineligible account after a run |
| gaining the grant | same | next run creates the row and reads from page one |
| empty `readScopes` | same | Bluesky and default `mock` claimed, read and committed exactly as 077 — asserted by 077's own suite passing **unedited** |
| the count | same | equals the number of ineligible accounts; exactly 1 for an account missing two scopes; `0` and no query when no rule declares scopes; distinct from `unavailable` |
| pure ↔ SQL agreement | `tests/integration/insights/eligibility-matrix.test.ts` (extended) | the engagement claim and `scopePermissionFor` agree over every combination of declared scopes × grant state × requested scopes |
| items survive | `tests/integration/engagement/scope-gate.test.ts` | an account that loses eligibility keeps every item readable and unchanged |
| publishing untouched | same | status, publish limits and `needs_reauth` identical before and after |
