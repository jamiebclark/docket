# Contract: one scope-permission decision, two surfaces, two forms

**Feature**: `084-meta-engagement-facts-and-scope-gate` | `src/lib/scope-permission.ts`,
`src/lib/insights/eligibility.ts`, `src/server/dal/scope-predicates.ts`,
`src/server/services/accounts.ts`, `src/server/services/engagement/inbox.ts`

Satisfies FR-023 (one pure implementation, pinned against the claim's query), FR-018, FR-021,
FR-034 to FR-037. Constitution IV is the reason this contract exists at all.

## 1. The move, and what must not change

081's `insightsPermissionFor` is already surface-agnostic in everything but its name: its inputs are
scopes and dialogs, its four outcomes are properties of grants, and the word "insights" appears
nowhere in its body. Engagement asks the same question of a different scope list.

```text
src/lib/scope-permission.ts            NEW   scopePermissionFor, ScopePermission   (body moved verbatim)
src/lib/insights/eligibility.ts        now   export { scopePermissionFor as insightsPermissionFor,
                                                      type ScopePermission as InsightsPermission }
```

**The aliases are deliberate and permanent-for-now.** The pure function has one production caller
(`insightsPermissionForAccount`, `src/server/services/accounts.ts:62`) and three importing test files
(`src/lib/insights/eligibility.test.ts`, `tests/integration/insights/eligibility-matrix.test.ts`,
`tests/integration/insights/instagram-reader.test.ts`). The aliases keep the production caller and the
two **integration** tests compiling and passing with their imports untouched, which is how "behaviour
unchanged byte for byte" is *demonstrated* rather than claimed. Only the unit test moves, because the
truth table it covers is no longer an insights fact — its assertions are carried over verbatim and
only its import line changes. A reviewer looking for a behaviour change finds two export lines, a
moved file and a re-pointed import.

`src/lib/insights/eligibility.test.ts` moves to `src/lib/scope-permission.test.ts` with its
assertions untouched (imports re-pointed), because the truth table is no longer an insights fact.

## 2. The decision

```ts
export type ScopePermission =
  | { kind: "ok" }
  | { kind: "not_requested"; missing: readonly string[]; reason: string; docsPath?: string }
  | { kind: "not_granted"; missing: readonly string[]; reason: string; docsPath?: string;
      canReconnect: boolean };

export function scopePermissionFor(input: {
  requiredScopes: readonly string[];
  grantedScopes: readonly string[] | null;   // null = never recorded
  requestedScopes: readonly string[];        // EVERY scope the dialog will ask for: base + opt-ins on
  cannotWiden: { reason: string; doc?: string } | null;
  missingScopes: { reason: string; docsPath?: string } | null;
}): ScopePermission;
```

The branch order is load-bearing and is **not** touched:

| # | Condition | Result |
|---|---|---|
| 1 | `requiredScopes` empty | `ok` — nothing is required, nothing to say |
| 2 | grant non-null **and** nothing missing | `ok` |
| 3 | `cannotWiden` non-null | `not_granted`, `canReconnect: false`, `cannotWiden`'s reason and doc — **before** the requested check, because an unwidenable dialog makes "is it requested" moot (081's test names this case) |
| 4 | some missing scope is not in `requestedScopes` | `not_requested` — this install does not ask for it; nothing for a member to do |
| 5 | otherwise | `not_granted`, `canReconnect: true` |

`grantedScopes: null` reaches rows 3–5 with every required scope missing: `NULL` means "not known",
never "holds everything" (FR-021). An empty array behaves identically here and differs only in
meaning — "granted nothing" — which is why the UI never implies refusal (spec Constraint 8: every
pre-081 account has `NULL`, so this is the common case, not an edge case).

## 3. The SQL form, and the pin between them

`src/server/dal/scope-predicates.ts` is the SQL half of rows 1, 2 and their negation — extracted from
`insights-claims.ts`'s `eligible()` and its two companion counts, which are the only SQL in the repo
that answers this question:

```ts
export function accountHoldsScopes(scopes: readonly string[]): SQL | undefined;
//   []        → undefined       (no condition; provider key alone matches)
//   otherwise → granted_scopes IS NOT NULL AND granted_scopes @> $scopes::text[]

export function accountMissingScopes(scopes: readonly string[]): SQL;
//   granted_scopes IS NULL OR NOT (granted_scopes @> $scopes::text[])
```

Four callers after this entry, no fifth: `insights-claims.ts`'s `eligible()`,
`countAccountsMissingInsightsScopes`, `engagement-read-claims.ts`'s eligibility, and
`countAccountsMissingEngagementScopes`.

**The pin** (FR-023). `tests/integration/insights/eligibility-matrix.test.ts` is **extended, not
duplicated**. It already walks required-set × grant-state and asserts the insights claims and
`insightsPermissionFor` agree; it gains the engagement claim as a third subject:

| Axis | Values |
|---|---|
| declared scopes | `[]`, `["scope_a"]`, `["scope_a","scope_b"]` |
| recorded grant | `null`, `[]`, partial, exact, superset |
| requested scopes | contains the missing scope / does not |
| `cannotWiden` | `null` / set |

For each cell the test asserts: `scopePermissionFor(...).kind === "ok"` **if and only if**
`claimDueEngagementReads` returns the account — and, for the non-`ok` cells, that
`countAccountsMissingEngagementScopes` counts it exactly once. A disagreement in any cell fails.

Because both halves now have one implementation each, this test pins two functions rather than four,
and a drift between the insights and engagement answers is impossible rather than merely tested for.

## 4. The engagement consumer

`src/server/services/accounts.ts`, beside `insightsPermissionForAccount`:

```ts
export function engagementPermissionForAccount(
  a: Pick<AccountRecord, "grantedScopes">,
  provider: SocialProvider | undefined,
): ScopePermission | null {
  const requiredScopes = provider?.engagement?.declaration.readScopes ?? [];
  if (requiredScopes.length === 0) return null;          // nothing to say — not `ok`
  const group = provider?.connect.strategy === "oauth" ? provider.connect.group : undefined;
  return scopePermissionFor({
    requiredScopes,
    grantedScopes: a.grantedScopes ?? null,
    requestedScopes: [...(group?.baseScopes ?? []), ...(group?.optionalScopes?.requested(process.env) ?? [])],
    cannotWiden: group?.optionalScopes?.cannotWiden?.(process.env, "engagement") ?? null,
    missingScopes: provider?.engagement?.declaration.missingReadScopes ?? null,
  });
}
```

`null` rather than `ok` when nothing is declared, so a consumer renders "nothing to say" without a
second condition — the same convention `insightsPermissionForAccount` uses.

**A provider that is not an OAuth group** (`mock`) has no `group`, so `requestedScopes` is `[]` and
`cannotWiden` is `null`: a declared-but-unrequested scope reads as `not_requested`, with no reconnect
control, which is correct — there is no mock reconnect dialog to widen. The "reconnect can help"
versus "cannot help" distinction is therefore exercised through the Meta and Threads groups' pure
scope computations and through this function with a stubbed group, not through a mock button (spec
Assumptions).

## 5. The two display surfaces

### Inbox — `src/server/services/engagement/inbox.ts` + `inbox/page.tsx`

`EngagementAccountView` gains `readPermission: ScopePermission | null`, computed in
`listEngagementAccounts` from the account's `grantedScopes` (already on the row) and the provider's
declaration. The permission check there is unchanged — `requirePermission(scope, { engagement:
["view"] })` already guards it, so FR-037 needs an extended assertion, not a new gate.

The page renders a **second** notice block, after the existing `unavailable` one:

| Block | Condition | Wording |
|---|---|---|
| existing | `a.unavailable` | "{account} ({provider}) is not available for the inbox yet: {reason}" + optional "Learn more" — a platform limitation |
| **new** | `a.readPermission && a.readPermission.kind !== "ok"` | names the account and provider, states the provider's own reason, links the setup guide where `docsPath` is declared, and points at a **reconnect** rather than at a platform limit (FR-034) |

Both can appear at once for different accounts (FR-034, US4 scenario 3), which is why they are two
blocks rather than one list with a branch.

The account **filter** excludes `a.unavailable || (a.readPermission && a.readPermission.kind !==
"ok")` (FR-035): an ineligible account can never produce an item, so offering it would offer a filter
that always returns nothing.

### Accounts page — `src/app/p/[projectSlug]/accounts/page.tsx`

`AccountRecord` gains `engagementReadPermission: ScopePermission | null`. The page renders one more
line in the pattern the two insights surfaces already use (`accounts/page.tsx:194-219`), labelled
**"Inbox needs a reconnect."**, with the provider's reason, a docs link, and
`ReconnectGroupButton` shown only when `canManage && permission.canReconnect` (FR-036) — so a state
where reconnecting cannot grant the permission offers **no** control at all and the reason says why
instead (FR-030, SC-008).

An account missing the comment permission keeps its status badge and its publishing exactly as before;
it is never marked `needs_reauth` by this entry (FR-025, US4 scenario 6, SC-011).

## 6. Tests

| What | Where | Asserts |
|---|---|---|
| the truth table | `src/lib/scope-permission.test.ts` (moved) | all five branch rows, unedited from 081 |
| nothing moved | 081's two integration tests that import the pure function, and 077's whole engagement suite | pass **unedited** |
| pure ↔ SQL | `tests/integration/insights/eligibility-matrix.test.ts` (extended) | §3's matrix across insights **and** engagement |
| inbox notice + filter | `tests/integration/engagement/scope-gate.test.ts` | both notices together for different accounts, distinguishable wording, the ineligible account absent from the filter |
| accounts line | same | reason + docs link + reconnect when `canReconnect`; reason + **no** button when not |
| permission boundary | `tests/integration/engagement/permissions.test.tsx` (extended) | a member without `engagement: ["view"]` sees no notice, no reason, no count and no account name — and none is reachable through an API key, the public API or an MCP tool (FR-037) |
| no secrets | `tests/integration/security/secret-scan.test.ts` (extended) | the new notice, reason and count carry no credential or token (FR-039) |
