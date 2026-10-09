# Contract: overview service and derivation

Internal TypeScript interfaces. There's no HTTP or public API surface: the public API (`/api/v1`) doesn't change.

## `src/server/services/overview.ts`

```ts
export async function getOverview(scope: ProjectScope): Promise<OverviewFacts>;
```

- **Requires** `scope.can({ project: ["view"] })`. Otherwise it throws `ForbiddenError`.
- **Reads only.** It never writes, audits, or records activity or notifications.
- **Calls only existing services** (research R1). It never imports `@/server/db` (the lint rule and the scope-recorder
  test enforce this).
- **Conditional reads**, so a viewer never triggers a read they don't need or can't make:
  - `listVoiceProfiles` only when `getLlmStatus().configured`.
  - `listMedia` only when `mediaStatus(scope).enabled`.
  - `invitations.listForProject` only when `scope.can({ invitation: ["create"] })`.
  - `listConnectGroups` only when `scope.membership.role === "owner"` and there are no accounts.
- **Errors**: any service error propagates, and the route's `error.tsx` shows the retry. It never catches an error and
  substitutes an empty value, because a partial page that claims something is empty is not allowed (spec edge case).
- **Output hygiene**: the returned object contains no member `email`, no credentials or settings, no `redirectUri`, no
  `paste` help, no env var names and no `lastError` text. A test serialises the output of a seeded project, with known
  member emails, and asserts that none of those emails, `@`-addresses, `process.env` names or `BETTER_AUTH_URL`
  values appear.

## `src/lib/overview/derive.ts` (pure; no I/O, no `server-only`)

```ts
export function deriveOverview(facts: OverviewFacts): OverviewView;
export function joinNames(names: readonly string[], conjunction: "and" | "or"): string;
export function deriveChecklist(facts: OverviewFacts, names: { and: string }): ChecklistView | null;
export function serverSetupItems(facts: OverviewFacts): ServerSetupItem[];   // [] unless owner
export function needsAttention(facts: OverviewFacts, names: { or: string }): AttentionItem[];
export const EXPIRY_WINDOW_DAYS = 14;
```

- It's deterministic in `facts`, and `facts.now` is the only clock.
- The types `OverviewFacts`, `OverviewView`, `ChecklistView`, `ChecklistStep`, `ServerSetupItem` and `AttentionItem`
  live here and are re-exported by the service. Field-level rules are in `data-model.md`.
- Hrefs are built from `facts.project.slug`. Docs links are built with literal `docsUrl("page", "anchor")` calls, so
  `tests/integration/docs/published-docs.test.ts` checks them.

## Test obligations

Each step and section rule in `data-model.md` has at least one unit case in `src/lib/overview/derive.test.ts`. That
includes:

- each step moving from "To do" to "Done" and back (SC-005);
- the "Waiting on" and blocked variants;
- invite hidden for editors;
- the collapse rules and hiding the checklist entirely;
- the server-setup row for owners only, and each of its four items;
- `joinNames` for 0, 1, 2, 3, 4 and 5 names, blank names, and both conjunctions;
- the expiry window edges (exactly 14 days, past, and null);
- D4 and D5.
