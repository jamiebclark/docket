# Contract: G40b — `cannotWiden` per surface, and the two engagement opt-ins

**Feature**: `084-meta-engagement-facts-and-scope-gate` | `src/providers/types.ts`,
`src/providers/meta/{config,oauth,connect-group}.ts`,
`src/providers/threads/{config,connect-group}.ts`, `src/server/services/accounts.ts`

Satisfies FR-016, FR-026 to FR-033, and FR-036's "only where reconnecting can succeed".

## 1. `cannotWiden` gains a surface

```ts
/** G40. Docket's own read surfaces an opt-in scope can belong to. Never a platform name. */
export type ScopeSurface = "insights" | "engagement";

// OAuthConnectGroup.optionalScopes
cannotWiden?(
  source: Readonly<Record<string, string | undefined>>,
  surface: ScopeSurface,
): { reason: string; doc?: string } | null;
```

**Why.** Today `cannotWiden` answers once per group, and on Meta it is non-null only when the
*insights* flag is on alongside `META_LOGIN_CONFIG_ID`. An install that opts into engagement only
would be told nothing at all about the login-configuration trap and would be offered a reconnect that
cannot grant anything (spec Constraint 6). The hook has to be answerable per surface or the gate lies.

**Existing answers must not move.** For every combination of flags that exists today — i.e. with both
engagement flags absent — `cannotWiden(source, "insights")` returns exactly what
`cannotWiden(source)` returns now (FR-016). The only call site,
`src/server/services/accounts.ts:70`, passes `"insights"`; the new engagement decision passes
`"engagement"`.

### Meta

| `META_INSIGHTS_SCOPES` | `META_ENGAGEMENT_SCOPES` | `META_LOGIN_CONFIG_ID` | `("insights")` | `("engagement")` |
|---|---|---|---|---|
| off | off | unset | `null` | `null` |
| off | off | set | `null` | `null` |
| on | off | set | the existing insights reason | `null` |
| off | on | set | `null` | the engagement reason |
| on | on | set | the existing insights reason | the engagement reason |
| any | any | unset | `null` | `null` |

The engagement reason names the permissions §2 confirmed, says they must be added to the Facebook
Login for Business configuration in the Meta app dashboard because Docket cannot add them to the
dialog, and links `docsUrl("meta-setup", "engagement")`. It is the insights reason's wording with the
other surface's permissions — the operator who read one recognises the other.

**When §2 confirmed no Meta permission** the declared engagement list is empty; `cannotWiden(…,
"engagement")` then returns `null` whatever the flag says, because there is no scope whose absence
could be explained (FR-031). The flag still parses, still validates, and the documentation says it has
no effect for that surface yet.

### Threads

Threads has no login-configuration mechanism, so `threadsConnectGroup.optionalScopes.cannotWiden`
stays **absent** for both surfaces — a reconnect can always widen a Threads dialog. Unchanged.

## 2. Declared scopes come from §2 and nowhere else

```ts
// src/providers/meta/connect-group.ts
const INSIGHTS_SCOPES_DECLARED = [ /* unchanged */ ] as const;

/**
 * G40. Filled from docs/research/engagement.md §2 and nowhere else (constitution I, FR-010).
 * Empty until §2 confirms a comment-read permission with a source URL — in which state
 * META_ENGAGEMENT_SCOPES still parses and validates but widens the dialog by nothing (FR-031).
 */
const ENGAGEMENT_SCOPES_DECLARED = [ /* { scope, purpose } per §2-confirmed permission */ ] as const;
```

The same shape in `src/providers/threads/connect-group.ts`. Each entry carries the purpose it serves,
as the insights entries do, because `purpose` is rendered in documentation (FR-028).

This plan names **no scope string**. The task that fills these lists is the task that writes §2, and
it may only write what §2 records with a source URL.

**Both Meta surfaces share one connect group.** Facebook Pages and Instagram connect through the
`meta` group, so one flag governs both; where §2 confirms different permissions for the two surfaces,
the group declares both and requests both under that single flag (spec Assumptions).

## 3. `requested()` stays a union

`requested(source)` keeps its signature and returns every opt-in scope the dialog will carry as
configured now — insights plus engagement:

```ts
// src/providers/meta/oauth.ts
export function optionalFor(cfg: MetaConfig): readonly string[] {
  return [
    ...(cfg.insightsScopes ? INSIGHTS_OPT_IN : []),
    ...(cfg.engagementScopes ? ENGAGEMENT_OPT_IN : []),
  ];
}
```

**It is deliberately not narrowed per surface.** `insightsPermissionForAccount` passes
`baseScopes + requested(env)` as `requestedScopes` precisely so that the "not requested" versus "not
granted" distinction is judged against *everything the dialog asks for*; its own comment records that
judging on the opt-ins alone reported "not requested" for scopes the dialog does ask for, leaving the
operator no reconnect control at all. Narrowing it would reintroduce that bug.

The consequence is a cross-surface coupling the spec flags (Constraint 7): turning engagement on
enlarges the `requestedScopes` set the **insights** decision sees. It is harmless because the scope
sets are disjoint — a missing insights scope is still missing, and still in the requested set — and
**FR-033 asserts it rather than assuming it**: a test walks every combination of
`META_INSIGHTS_SCOPES` × `META_ENGAGEMENT_SCOPES` × `META_LOGIN_CONFIG_ID` (and the Threads pair) and
compares each account's insights permission for both surfaces against its pre-change value.

## 4. The two flags

| Flag | Group | Parsed in | Default |
|---|---|---|---|
| `META_ENGAGEMENT_SCOPES` | `meta` | `parseMetaEnv` → `MetaConfig.engagementScopes` | `false` |
| `THREADS_ENGAGEMENT_SCOPES` | `threads` | `parseThreadsEnv` → `ThreadsConfig.engagementScopes` | `false` |

Parsed, validated and reported **exactly** as their insights twins (FR-026, FR-027): lower-cased;
`"true"` ⇒ on; `"false"` ⇒ off; absent ⇒ off; anything else pushes
`{ name: "<FLAG>", reason: "must be true or false" }` onto `issues`, which `providerEnvIssues`
surfaces at startup by name with **no value echoed** (FR-039, US5 scenario 4). Each is added to its
group's `environment.variables` as `{ secret: false, required: false }`.

Deployment flags, not per-connect choices: the permission must **also** be added to the Meta or
Threads app itself, which no member can do from a web form, so a per-connect checkbox would offer a
choice that cannot work on its own. Same reasoning and same precedent as `META_INSIGHTS_SCOPES` and
`TIKTOK_APP_AUDITED`; recorded in `docs/decisions.md`.

## 5. The dialogs

| Condition | Meta authorization URL | Threads authorization URL |
|---|---|---|
| both flags off/absent | **byte-identical** to today, parameter order included (FR-029) | **byte-identical** (FR-029) |
| flag on, no `META_LOGIN_CONFIG_ID` | `scope` = `META_SCOPES` + insights opt-in (if on) + engagement opt-in, in that order | `scope` = `threads_basic`, `threads_content_publish`, insights opt-in (if on), engagement opt-in |
| flag on, `META_LOGIN_CONFIG_ID` set | **unchanged** — `config_id` is sent and no `scope` parameter at all; the reason from §1 is shown instead and **no reconnect control is offered** (FR-030, SC-008) | n/a |
| flag on, §2 confirmed nothing | unchanged — the opt-in list is empty, so the union adds nothing (FR-031) | unchanged |

Meta's URL is built in one place (`dialogUrl`, `src/providers/meta/oauth.ts:26-35`) from
`[...META_SCOPES, ...optionalFor(cfg)]`, so §3's change is the whole of it. Threads builds its scope
list inline in `authorizationUrl` (`src/providers/threads/connect-group.ts`) and gains one more
conditional spread there, matching the order `requested` returns.

**Turning a flag off revokes nothing** (FR-032): it governs the *request* for new consents only. An
account that already granted the permission keeps its recorded grant, stays eligible and keeps being
read. A refresh that restates no scopes leaves the stored grant alone, exactly as 081 requires, so
eligibility does not flap and a working reader does not stop a few days after it started.

**A group that is not configured at all** (no app id or secret) parses and validates the flag, reports
no issue for it, and has no dialog to widen — `environment.configured(source)` stays false and nothing
claims to be ready (spec Edge Cases).

**An operator who sets the flag but never adds the permission to the Meta app**: the dialog asks for a
permission the app cannot grant, the account connects with the grant it actually received, and the
accounts page reports it as not granted — never as granted (spec Edge Cases). Nothing special is coded
for this; it is what recording the platform's own answer already does.

## 6. Tests

| What | Where | Asserts |
|---|---|---|
| flag parsing | `src/providers/meta/config.test.ts`, `src/providers/threads/config.test.ts` | `true` / `false` / absent / `maybe` (issue by name, no value echoed) |
| `requested` | `src/providers/meta/connect-group.test.ts`, `…/threads/…` | union across all four flag combinations; exactly today's list with both engagement flags off |
| `cannotWiden` | same | §1's full table, both surfaces, every flag × login-config combination |
| byte-identical URLs | same | the full URL string with both flags off, parameter order included (FR-029) |
| insights unmoved | `tests/integration/insights/eligibility-matrix.test.ts` (extended) | FR-033: every combination of engagement flag × insights flag × login config id leaves both insights permissions identical |
| empty-declared state | `src/providers/meta/connect-group.test.ts` | with `ENGAGEMENT_SCOPES_DECLARED` empty, flag `true` adds no scope and `cannotWiden(…, "engagement")` is `null` (FR-031) |
| env issue surfaced | `src/providers/meta/config.test.ts` + `tests/integration/threads/connect.test.ts` (the existing `providerEnvIssues` caller) | an invalid flag appears in the group's `issues` and in `providerEnvIssues` by name, with no value |

## 7. The anchor these reasons link to

Every engagement reason and docs path above resolves through
`docsUrl("meta-setup", "engagement")` → `…/meta-setup/#engagement`. `docsUrl` builds a GitHub-style
heading slug and nothing validates it at runtime, so `docs/meta-setup.md` **must** gain a heading
whose slug is exactly `engagement` — a `## Engagement` heading, placed beside the existing
`## Insights` (line 329), which is what `#insights` already resolves to.

The opt-in walkthrough itself goes in a new `## 11b. Reading comments (optional)` **beside** `## 11a`
rather than replacing it (FR-044), and must not renumber 11a or `## 11. Media needs a public bucket`:
docs links are only checked in CI, so a renumbered heading breaks inbound anchors silently.
