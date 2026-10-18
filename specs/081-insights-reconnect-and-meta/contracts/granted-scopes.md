# Contract — G31 the grant, G32 the optional request, and the one permission decision

[plan.md](../plan.md) · [data-model.md](../data-model.md) · FR-006 … FR-028

---

## §1 G31 — where a grant comes from, per provider

The rule: **a grant is recorded only from what the platform said, never from what Docket asked for**
(FR-008). Each provider contributes `grantedScopes` on its `ConnectCandidate`, or omits it.

| Provider | Source of the list | Today's code | Notes |
|---|---|---|---|
| **facebook** | `/debug_token` → `data.scopes` on the user token | **extended call** in `src/providers/meta/candidates.ts` | See §2 |
| **instagram** | the same reply as its parent Page | same | One login, one permission list, both candidates |
| **threads** | `grantedList(body)` — `permissions` or `scope` from the token reply | `src/providers/threads/oauth.ts:44-45` — **already parsed**, used only for a note | Returns `string[] \| null`; `null` stays `null` |
| **x** | `tokens.scopes` from the token reply's `scope` | `src/providers/x/oauth.ts:71-76` — **already parsed** | Space-separated; already `string[] \| null` |
| **tiktok** | the callback's `scopes`, falling back to the token reply's `scope` | `src/providers/tiktok/connect-group.ts:54-63` — **already parsed** | |
| **pinterest** | its token reply's `scope` **if it carries one** | — | R6 open; if absent, stays `NULL` |
| **bluesky**, **mock** | nothing — not OAuth | — | Stays `NULL`; `requiredScopes` is empty so it does not matter (FR-024) |

Four of the six already parse the list and throw it away into a free-text note. **Those notes stay
exactly as they are** (FR-013): this entry adds a field, it does not move the note.

## §2 Facebook and Instagram — no new round trip

Meta's token reply carries no permission list. `src/providers/meta/candidates.ts` already calls
`/debug_token` for `granular_scopes` (to find Page ids), and that reply carries a flat `scopes`
array for the token as a whole. Two options, and the choice matters:

- **`/debug_token` → `data.scopes`.** No extra round trip — the call is already made. But it needs an
  app token (`{appId}|{appSecret}`), and the existing helper is documented "best effort: any failure
  returns no ids", so a failure degrades silently.
- **`GET /me/permissions` → `data[]` of `{ permission, status }`.** One extra call on the connect
  path only, and it is the surface Meta documents for this question, including the `declined` and
  `expired` statuses that a flat `scopes` list collapses away.

**Decision: extend the existing `/debug_token` read**, because it costs no call, runs on the connect
path where its failure is already tolerated, and describes the same token the candidates were built
from. Filter to strings matching `GRANTED_SCOPE_PATTERN`; on any failure return `undefined` so the
column is left unset — which reads as "Insights need a reconnect" and is recoverable — rather than
`[]`, which would read as "the platform granted nothing" and is a lie. Both the Page and the
Instagram candidate carry the same list, because one login granted it.

Recorded as a judgement call for `docs/decisions.md`, with its reversal: switch to `/me/permissions`
if the flat `scopes` list turns out to include declined permissions.

---

## §3 G32 — the optional request, and the three ways of asking

`OAuthConnectGroup.optionalScopes` (shape in data-model §6). Two groups declare it.

**Meta** (`src/providers/meta/connect-group.ts`):

```ts
optionalScopes: {
  declared: [
    { scope: "read_insights", purpose: "Read a Facebook Page's and its posts' numbers" },
    { scope: "instagram_manage_insights", purpose: "Read an Instagram account's and its posts' numbers" },
  ],
  doc: docsUrl("meta-setup", "insights"),
  requested: (source) => {
    const { config } = parseMetaEnv(source);
    if (!config?.insightsScopes) return [];
    if (config.loginConfigId) return [];          // cannot widen; see cannotWiden
    return ["read_insights", "instagram_manage_insights"];
  },
  cannotWiden: (source) => {
    const { config } = parseMetaEnv(source);
    if (!config?.insightsScopes || !config.loginConfigId) return null;
    return {
      reason:
        "Add read_insights and instagram_manage_insights to your Facebook Login for Business "
        + "configuration in the Meta app dashboard. Docket cannot add them to the login dialog.",
      doc: docsUrl("meta-setup", "insights"),
    };
  },
}
```

**Threads** (`src/providers/threads/connect-group.ts`): the same shape with one scope,
`threads_manage_insights`, and **no** `cannotWiden` — Threads has no Login-for-Business
configuration, so its dialog can always be widened.

### `dialogUrl` (FR-016 … FR-019)

```ts
// src/providers/meta/oauth.ts
if (cfg.loginConfigId) url.searchParams.set("config_id", cfg.loginConfigId);
else url.searchParams.set("scope", [...META_SCOPES, ...optionalFor(cfg)].join(","));
```

where `optionalFor(cfg)` is `[]` unless `cfg.insightsScopes`. Three properties, each a test:

1. **Flag unset ⇒ byte-identical URL** (FR-018, US1-AS1). Asserted for every OAuth group by
   comparing against a **literal** expected string, not against a re-computation — a test that
   recomputes the URL the same way the code does would pass through any change to both.
2. **Flag set, no config id ⇒ today's scopes plus exactly the declared optional scopes, in
   declaration order, and nothing else** (US3-AS1).
3. **Config id set ⇒ unchanged whatever the flag's value** (FR-019, US3-AS3), because `config_id`
   and `scope` are mutually exclusive on Meta's dialog.

### What the flag governs, and what it does not (FR-020)

The flag governs **the request**, never **the right**. Turning it off after accounts have granted the
permission changes nothing stored and nothing claimed: those accounts stay eligible, because the
platform really did grant it. New connections simply stop asking. This is asserted directly, because
the opposite — treating the flag as a kill switch over stored grants — is the intuitive wrong
implementation and would silently stop a working reader.

---

## §4 G33's pure half — `insightsPermissionFor`

New pure module `src/lib/insights/eligibility.ts`. **One decision, three consumers** — the panel, the
accounts page, and (mirrored in SQL) the claim. This is constitution IV applied to a question that is
otherwise easy to answer three slightly different ways.

```ts
export type InsightsPermission =
  /** Every required scope is held, or none is required. Reads may be attempted. */
  | { kind: "ok" }
  /** This install does not ask for the permission at all. Nothing for a member to do. */
  | { kind: "not_requested"; missing: readonly string[]; reason: string; docsPath?: string }
  /** The install asks; this account has not granted it. A reconnect may or may not help. */
  | { kind: "not_granted"; missing: readonly string[]; reason: string; docsPath?: string;
      canReconnect: boolean };

export function insightsPermissionFor(input: {
  /** From the provider's insights declaration. Empty ⇒ always `ok`. */
  requiredScopes: readonly string[];
  /** The stored column. `null` means "never recorded", which is **not** the same as `[]`. */
  grantedScopes: readonly string[] | null;
  /** From the group's `optionalScopes.requested(env)`: the scopes the dialog will ask for now. */
  requestedScopes: readonly string[];
  /** From the group's `optionalScopes.cannotWiden(env)`. */
  cannotWiden: { reason: string; doc?: string } | null;
  /** The provider's `missingScopes` declaration — what to say when they are not held. */
  missingScopes: { reason: string; docsPath?: string } | null;
}): InsightsPermission;
```

### The ordered decision table

| # | Condition | Result |
|---|---|---|
| 1 | `requiredScopes` is empty | `ok` |
| 2 | `grantedScopes !== null` and contains every required scope | `ok` |
| 3 | `cannotWiden !== null` | `not_granted`, `canReconnect: false`, reason from `cannotWiden` |
| 4 | some required-and-missing scope is **not** in `requestedScopes` | `not_requested` |
| 5 | otherwise | `not_granted`, `canReconnect: true`, reason from `missingScopes` |

- **Row 3 before row 4** is the whole of FR-019. With the flag on and a config id set, `requested`
  is `[]`, so row 4 would say "this install does not ask for it" — false, and unactionable. The
  operator *did* ask; Docket cannot pass it on. Saying so, with the dashboard instruction and no
  reconnect button, is the difference between a fixable state and the loop spec constraint 4 warns
  about.
- **Row 2 before everything** is FR-020: a held grant wins over any configuration.
- **`missing` is always the required scopes this account lacks**, so the screen can name them. That
  is what makes SC-002 ("under 10 seconds, without reading a log") achievable, and it is also the
  mitigation for the §2 risk that Meta reports a permission under a name Docket did not expect — the
  line says exactly which identifier is missing, so the operator can see the mismatch.
- `grantedScopes === null` and `grantedScopes === []` both fall past row 2 to the same *state*, but
  FR-007 requires them to **read** differently. That difference is rendered, not decided: the
  accounts page appends "Docket has not recorded what this account granted — reconnect to record it"
  for `null`, and "the platform reported granting nothing for insights" for `[]`.

### Pinned to the SQL

`tests/integration/insights/eligibility-matrix.test.ts` builds the cross product of
{`null`, `[]`, partial, exact, superset} × {0, 1, 2 required scopes} and asserts, for every cell,
that *the account was claimed* ⟺ *`insightsPermissionFor` returned `ok`*. Research §6 explains why
this test, rather than shared code, is the contract between the two expressions: the SQL cannot call
the function, so the only available guarantee is a test that fails when they disagree.
