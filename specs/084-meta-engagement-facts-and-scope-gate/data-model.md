# Data model: Confirm the Meta comment facts, and gate the inbox on the permission they need

**Feature**: `084-meta-engagement-facts-and-scope-gate` | **Date**: 2026-10-19

## 1. No schema change

**No migration is added by this entry.** `drizzle/0047_salty_owl.sql` stays the newest file, `pnpm
db:check` has nothing new to compare, and no table is added to `src/server/db/project-owned.ts`
because none is added at all.

Every entity below is either **read** from a column that already exists, **derived** in memory, or
**reported** in a count that is already carried generically. The spec's own assumption — "No schema
change is needed. Eligibility is derived from the existing recorded-grant column and the provider
declaration; nothing new is persisted" — holds after design.

The two columns the gate reads, both unchanged:

| Column | Table | Type | Meaning |
|---|---|---|---|
| `granted_scopes` | `social_accounts` | `text[]`, nullable | Written at connect and refresh by 081 (G31). Three states, all load-bearing: `NULL` = never recorded, `{}` = recorded as granting nothing, non-empty = recorded contents. Normalised by `normalizeGrantedScopes` against `GRANTED_SCOPE_PATTERN` (`/^[a-z0-9_.:-]{1,64}$/`), at most 40 entries / 1000 bytes |
| `status`, `removed_at` | `social_accounts` | — | Already filtered by both claims; unchanged |

`engagement_account_states` is unchanged in shape. The gate changes **which** rows get created in it
(FR-020), never what a row holds.

---

## 2. `EngagementDeclaration` — two new optional fields (G40)

In `src/providers/types.ts`. The pair mirrors `InsightsDeclaration`'s
`postScopes`/`missingPostScopes` exactly, in engagement's vocabulary, singular because engagement has
one read surface (spec decision: reply scopes are deliberately absent).

```ts
export interface EngagementDeclaration {
  reads: readonly EngagementItemKind[];
  canReply: boolean;
  writeBudget?: PublishLimit;
  unavailable?: { reason: string; docsPath?: string };
  /** G40. Permissions an account must hold before any comment read. Default empty = none needed. */
  readScopes?: readonly string[];
  /** G40. Shown when `readScopes` are not held. Required when `readScopes` is non-empty. */
  missingReadScopes?: { reason: string; docsPath?: string };
}
```

Validation, at registry load, by a new `assertEngagementDeclaration` (there is none today — the
engagement declaration is the one optional member with no load-time assertion, which is also why
077's `reads` is "never empty" by comment only). Full rules and messages:
[contracts/engagement-read-scopes.md](./contracts/engagement-read-scopes.md) §2.

| Rule | FR | Failure |
|---|---|---|
| `reads` non-empty | 077 FR-053 | load fails (newly enforced, in passing) |
| `unavailable.reason` 1–300 chars when set | 077 FR-055 | load fails (newly enforced, in passing) |
| `unavailable` and non-empty `readScopes` never both set | FR-013 | load fails, message naming **both** fields |
| non-empty `readScopes` ⇒ `missingReadScopes.reason` present, 1–300 chars | FR-012 | load fails |
| every `readScopes` entry matches `GRANTED_SCOPE_PATTERN` | FR-012 | load fails, naming the entry |
| absent or `[]` `readScopes` ⇒ "no permission needed" | FR-014 | — (every provider's behaviour today) |

Declared values after this entry: **no provider declares a non-empty `readScopes`**. Bluesky and
`mock` declare none (FR-022); Facebook, Instagram and Threads have no `engagement` member at all
(FR-047). The field's only non-empty users in this entry are test providers registered through
`registerTestProvider`.

---

## 3. `ScopeSurface` and `cannotWiden` — one new argument (G40)

```ts
/** G40. Docket's own read surfaces that an opt-in scope can belong to. Never a platform name. */
export type ScopeSurface = "insights" | "engagement";

// OAuthConnectGroup.optionalScopes
cannotWiden?(
  source: Readonly<Record<string, string | undefined>>,
  surface: ScopeSurface,
): { reason: string; doc?: string } | null;
```

`declared` and `requested(source)` keep their shapes. `requested` stays a **union** across every
opt-in that is switched on — see [contracts/optional-scopes-per-surface.md](./contracts/optional-scopes-per-surface.md)
§3 for why narrowing it would reintroduce a bug 081 fixed, and FR-033 for the assertion that the
enlargement does not move any insights state.

---

## 4. `EngagementProviderRule` — the claim's eligibility input

In `src/server/dal/engagement-read-claims.ts`, replacing `providerKeys: readonly string[]`. The same
move the insights claim already made (`InsightsProviderRule`), kept as small as engagement needs.

```ts
export interface EngagementProviderRule {
  providerKey: string;
  /** G40. Empty = no permission needed (Bluesky, mock) — matched by provider key alone. */
  readScopes: readonly string[];
}
```

Built in `runEngagementRead` from the registry, so the DAL still imports nothing from
`src/providers/registry` (constitution V):

```ts
const rules: EngagementProviderRule[] = listProviders()
  .filter((p) => p.engagement && !p.engagement.declaration.unavailable)
  .map((p) => ({ providerKey: p.key, readScopes: p.engagement!.declaration.readScopes ?? [] }));
```

`unavailable` providers are dropped here exactly as today (`engagement-read.ts:52`), so the two
"not readable" mechanisms remain separate: a blanket per-provider drop before the claim, and a
per-account predicate inside it.

---

## 5. The claim predicate, and where it is applied

Shared SQL, new file `src/server/dal/scope-predicates.ts`, called by the engagement claim, the
insights claim and both companion counts:

```ts
/** Holds every scope. NULL = not recorded, so it holds nothing. */
accountHoldsScopes(scopes: readonly string[])
  //  scopes.length === 0  → TRUE (no predicate)
  //  otherwise            → granted_scopes IS NOT NULL AND granted_scopes @> $scopes::text[]

/** Missing at least one scope — the negation, with NULL on the missing side. */
accountMissingScopes(scopes: readonly string[])
  //  granted_scopes IS NULL OR NOT (granted_scopes @> $scopes::text[])
```

Eligibility for the engagement claim is then `OR` over the rules:

```sql
(provider_key = 'bluesky')                                            -- readScopes = []
OR (provider_key = 'x' AND granted_scopes IS NOT NULL
    AND granted_scopes @> ARRAY['…']::text[])                         -- readScopes non-empty
```

Applied in **both** places inside `claimDueEngagementReads`'s single transaction:

| # | Site | Line today | Why it must be gated |
|---|---|---|---|
| 1 | lazy-insert select + `INSERT … ON CONFLICT DO NOTHING` | `engagement-read-claims.ts:39-55` | FR-020 — gating only the select would still write a state row for an unpermitted account |
| 2 | due-rows select, `FOR UPDATE SKIP LOCKED` | `engagement-read-claims.ts:57-70` | FR-019 — no claim, so no lease, no decrypt, no call |

An account that gains the grant later is picked up by (1) on the next run and read from its first page
with no manual step (US3 scenario 5), because (1) is a left-join-for-absence, not a one-shot
backfill.

---

## 6. `EngagementReadCounts` — one new field

In `src/server/scheduler/engagement-read.ts`. Carried generically by
`SectionResult<EngagementReadCounts>` and `writeHeartbeat("engagement_read", …, { ...counts })`, so
there is no record shape to migrate and no reporting surface to extend.

```ts
export interface EngagementReadCounts {
  claimed: number;
  itemsInserted: number;
  accountsWithNewItems: number;
  retried: number;
  rateLimited: number;
  credentialsInvalid: number;
  cursorLost: number;
  unavailable: number;              // unchanged: a provider-level refusal, a different thing
  accountsSkippedNoPermission: number;  // G40, FR-038
  failed: number;
}
```

Computed by a companion query, because the claim excludes these accounts and therefore cannot report
them — the same structural reason `countAccountsMissingInsightsScopes` exists:

```ts
export function countAccountsMissingEngagementScopes(
  rules: readonly EngagementProviderRule[],
): Promise<number>;
//  rules with non-empty readScopes only; returns 0 with NO query issued when there are none (FR-038)
//  SELECT count(*) FROM social_accounts
//   WHERE removed_at IS NULL AND status = 'active'
//     AND ( (provider_key = $k AND accountMissingScopes($readScopes)) OR … )
```

Counted **exactly once** per account (FR-038, US6 scenario 2) because the query selects from
`social_accounts` with an `OR` of per-provider arms — an account matches at most one arm, since
`provider_key` is single-valued. No `DISTINCT` is needed and none is added; the matrix test asserts
the count for an account missing two declared scopes is 1.

---

## 7. `EngagementReadPermission` — the derived per-account answer

Not persisted. `ScopePermission` (the moved `InsightsPermission`), unchanged in shape:

| Variant | Meaning here | Where it shows |
|---|---|---|
| `{ kind: "ok" }` | no scopes declared, or the grant contains all of them | nothing is displayed |
| `{ kind: "not_requested", missing, reason, docsPath? }` | this install's dialog does not ask for the permission at all | notice + accounts line, **no** reconnect control |
| `{ kind: "not_granted", …, canReconnect: true }` | the dialog asks; this account has not granted it | notice + accounts line + reconnect control |
| `{ kind: "not_granted", …, canReconnect: false }` | opted in, but the dialog cannot be widened (`META_LOGIN_CONFIG_ID`) | notice + accounts line, **no** reconnect control (FR-030, SC-008) |

Derived by a new `engagementPermissionForAccount(account, provider)` in
`src/server/services/accounts.ts`, beside `insightsPermissionForAccount` and built the same way:

```ts
requiredScopes  = provider?.engagement?.declaration.readScopes ?? []   // [] → returns null
missingScopes   = provider?.engagement?.declaration.missingReadScopes ?? null
grantedScopes   = account.grantedScopes ?? null                        // NULL means "not known"
requestedScopes = [...(group?.baseScopes ?? []), ...(group?.optionalScopes?.requested(process.env) ?? [])]
cannotWiden     = group?.optionalScopes?.cannotWiden?.(process.env, "engagement") ?? null
```

Returns `null` — not `ok` — when the provider declares no `engagement` member or no read scopes, so
every consumer can render "nothing to say" without a second condition. `null` for `mock` and Bluesky
in this entry.

### Read models that carry it

| Shape | File | Addition |
|---|---|---|
| `AccountRecord` (accounts page, overview, posts list, post view) | `src/server/services/accounts.ts` | `engagementReadPermission: ScopePermission \| null` |
| `EngagementAccountView` (inbox notice + filter) | `src/server/services/engagement/inbox.ts` | `readPermission: ScopePermission \| null`, beside the existing `unavailable` |

`listEngagementAccounts` already reads `scope.accounts.list()`, whose rows carry `grantedScopes`
(`src/server/dal/accounts.ts`, `select()` minus credentials), and already calls
`requirePermission(scope, { engagement: ["view"] })` — so FR-037 needs no new gate, only an extended
assertion.

### What the two surfaces do with it

- **Inbox** (`src/app/p/[projectSlug]/inbox/page.tsx`): a **second** notice block for accounts whose
  `readPermission?.kind !== "ok"` and is non-null, worded as something a reconnect may fix rather than
  a platform limitation, and able to appear alongside the existing `unavailable` block for different
  accounts (FR-034). The account filter excludes an account that is `unavailable` **or** not `ok`
  (FR-035) — it can never produce an item.
- **Accounts** (`src/app/p/[projectSlug]/accounts/page.tsx`): one more line in the same
  `permission?.kind === "not_granted"` pattern the two insights surfaces already use, labelled for
  the inbox, with `ReconnectGroupButton` shown only when `canManage && permission.canReconnect`
  (FR-036, FR-030).

---

## 8. Mock scripting — one setting and one helper

| Addition | File | Purpose |
|---|---|---|
| `engagementReadScopes: z.array(z.string()).default([])` | `src/providers/mock/settings.ts` | G40's counterpart to `insightsPostScopes`/`insightsAccountScopes`: drives a test's `EngagementProviderRule` from a scripted account, with no real provider |
| `mockEngagementRuleFor(settings)` | `src/providers/mock/engagement.ts` | Builds `{ providerKey: "mock", readScopes }` from those settings, mirroring `mockInsightsRuleFor` |

`mockEngagement.declaration` itself gains **no** `readScopes`, so the default mock account behaves
exactly as 077 specified (FR-022). The declaration-driven paths (registry assertions, both UI
surfaces) are exercised with `registerTestProvider({ ...mockProvider, key: "…", engagement: { …,
declaration: { …, readScopes, missingReadScopes } } })` — the pattern
`tests/integration/insights/no-reconnect-safety.test.ts:24-37` established for the same job on the
insights side.

---

## 9. Research answer — the one entity that is a document, not a type

One cell of `docs/research/engagement.md` §2. No code reads it; the next two entries do.

| Field | Values | Rule |
|---|---|---|
| surface | Facebook Page comments \| Instagram comments \| Threads replies \| Threads mentions | four, answered separately; mentions never inferred from replies (FR-001) |
| question | one of nine | the seven already in §2 plus deleted/edited presentation and per-account-vs-per-post listability (FR-002, FR-003) |
| answer | prose, or `unverified` | no plausible-sounding guess, ever (FR-005) |
| source | URL on an official Meta documentation domain | required for every answered cell; a third-party URL is never proof (FR-004) |
| checked | `YYYY-MM-DD` | required for every answered cell (FR-004) |
| evidence | `page` \| `search-summary` | how it was checked — see [research.md](./research.md) §1 and [contracts/research-section-2.md](./contracts/research-section-2.md) |
| tried | prose | required for every `unverified` cell (FR-005) |

Plus, per surface, one **consequence** line: buildable by a later entry, or must ship
declared-but-`unavailable` and for which specific reason (FR-006).
