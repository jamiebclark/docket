# Contract: services and pure modules

Every service here is **read-only**. It calls existing services or scoped DAL reads only, never the raw database
client (Constitution III and IV), and it adds no permission statement (FR-073). Pure modules have no I/O.

## Pure: `src/lib/roles/names.ts` (new)

```ts
export type Manager = { name: string; role: "owner" | "admin" };

/** "A", "A or B", "A, B or C", "A, B, C or n others"; blank names dropped; `fallback` when none remain. */
export function joinNames(names: readonly string[], conjunction: "and" | "or", fallback?: string): string; // default "an owner or admin"

/** Owners and admins only, owners first, otherwise input order; returns only name and role. */
export function managersOf(rows: readonly { name: string; role: string }[]): Manager[];

export function askManagers(managers: readonly Manager[], conjunction: "and" | "or"): string; // fallback "an owner or admin"
export function askOwners(managers: readonly Manager[], conjunction: "and" | "or"): string;   // owners only; fallback "an owner"
```

**Obligations**:

- `joinNames(x, c)` with no third argument gives exactly what entry 1's `joinNames(x, c)` gives. Every case in
  `src/lib/overview/derive.test.ts` passes unchanged.
- `src/lib/overview/derive.ts` re-exports `joinNames` from here (`export { joinNames } from "@/lib/roles/names"`) and
  keeps `names(facts, conj)`.
- `managersOf` never returns an `email` or `userId` property, even when the input rows have them. A unit test asserts
  `Object.keys` of each result.

## Pure: `src/lib/roles/slots.ts` (new)

```ts
export function hasActiveSlot(c: { providerAvailable: boolean; active: number }): boolean;
/** First account (available first) without an active slot, for "Add posting slots" links; null if none. */
export function firstWithoutActiveSlot<T extends { accountId: string; providerAvailable: boolean; active: number }>(
  counts: readonly T[],
): T | null;
```

## Pure: `src/lib/roles/calendar.ts` (new)

```ts
export function calendarState(input: {
  slug: string;
  accounts: readonly { accountId: string; providerAvailable: boolean; active: number }[];
  hasContent: boolean;
  canManageAccounts: boolean;
  canManageSlots: boolean;
  managersToAsk: string; // askManagers(m, "or")
  todayHref: string;
}): CalendarState; // see data-model.md §5; copy in contracts/ui.md "Calendar"
```

## Pure: `src/lib/roles/prerequisites.ts` (new)

```ts
import type { ChecklistItem } from "@/components/ui/Checklist"; // type-only import

export function generationPrerequisites(input: {
  slug: string;
  readiness: GenerationReadiness;
  viewer: { isOwner: boolean; canManageAccounts: boolean; canManageVoice: boolean };
  managers: readonly Manager[];
  /** New job from media only: present when the selection has no usable images. */
  images?: { message: string } | null;
}): ChecklistItem[] | null; // null when every item is done; see data-model.md §4

export const PREREQUISITES_TITLE = "Before you can generate";
```

**Obligations**:

- The output never contains a setting name unless `readiness.ai.missingSettings` is non-null. The service guarantees
  that's owner-only.
- When the viewer is an owner, the output contains no "Waiting on" text.
- Each item has at most one action.

## Pure: `composer-logic.ts` additions (existing file)

```ts
export function queueSlotHint(input: {
  slug: string;
  selectedIds: readonly string[];
  accounts: readonly { id: string; displayName: string; hasActiveSlot?: boolean | null }[];
  canManageSlots: boolean;
  managersToAsk: string;
}): QueueSlotHint; // data-model.md §6
```

`scheduleBlockedReason` and `emptyAccountsAudience` are unchanged.

## Service: `listManagers(scope)` in `src/server/services/members.ts` (addition)

```ts
export async function listManagers(scope: ProjectScope): Promise<Manager[]>; // managersOf(await list(scope))
```

- **Permission**: `member: ["view"]`, through `list`. Every role has it.
- `getOverview` calls `managersOf(memberRows)` instead of its inline ranking (`overview.ts:91-95`). Its output is
  unchanged, and `tests/integration/overview/*` passes unchanged.

## Service: `listSlotCounts(scope)` in `src/server/services/slots.ts` (addition)

```ts
export type AccountSlotCount = { accountId: string; providerAvailable: boolean; active: number; paused: number };
export async function listSlotCounts(scope: ProjectScope): Promise<AccountSlotCount[]>;
```

- **Permission**: `slot: ["view"]`, through `listSlots`, plus `account: ["view"]` through `listAccounts`. Every role
  has both.
- **Cost**: `1 + A` reads, where A is the number of accounts. That's the per-account loop FR-014 allows.
- `getOverview` builds `OverviewAccount.slots` from this instead of its own `listSlots` loop
  (`overview.ts:62-76`), so the overview's output is unchanged.

## Service: `countPosts(scope)` in `src/server/services/posts/list.ts` (addition)

```ts
/** Every live post in the project (all statuses; `needs_decision` is an overlay and not added). */
export async function countPosts(scope: ProjectScope): Promise<number>;
```

- **Permission**: `post: ["view"]`, the same as `listPosts`. Exported from `posts/index.ts`.
- **Implementation**: sums `scope.posts.counts()`, leaving out `needs_decision`. That's the same number as Posts' "All"
  tab.

## Service: `getGenerationReadiness(scope)` in `src/server/services/generation/readiness.ts` (new)

```ts
export async function getGenerationReadiness(scope: ProjectScope): Promise<GenerationReadiness>; // data-model.md §4
```

- **Permission**: `account: ["view"]` and `voice: ["view"]`, through `listAccounts` and `listVoiceProfiles`.
- **Behaviour**: when `getLlmStatus().configured` is false and the viewer is an owner, `missingSettings` is
  `missingLlmSettings(problems)`. In every other case it's `null`.

## `src/server/llm/index.ts` addition

```ts
/** Every setting the owner must set, all at once: a lone LLM_PROVIDER problem expands to provider, model and key. */
export function missingLlmSettings(problems: readonly { name: string }[]): string[];
```

`getLlm()` uses it for `LlmNotConfiguredError`, so its error message is unchanged. That message is pinned by
`src/server/llm/index.test.ts`.

## Tests these contracts require

- **`src/lib/roles/*.test.ts`** (unit):
  - `joinNames` with a fallback;
  - `managersOf` ordering and key set;
  - `askOwners` and `askManagers` fallbacks;
  - `hasActiveSlot` for paused and unavailable accounts;
  - `calendarState`: all five kinds, for a manager and for an editor;
  - `generationPrerequisites`: all missing for owner, admin and editor; a partial set; all done (`null`); the images
    item;
  - an assertion that no non-owner output matches `/[A-Z][A-Z0-9]*_[A-Z0-9_]+/`.
- **`composer-logic` tests**: `queueSlotHint` for `none`, `all` (both roles), `some` (one and two names), and unknown.
- **`tests/integration/roles/services.test.ts`**:
  - `listManagers` returns no emails;
  - `listSlotCounts` counts paused slots as not active;
  - `countPosts` is 0 for an empty project and 1 after one draft;
  - `getGenerationReadiness` gives `missingSettings` to the owner and `null` to an admin or editor, with the LLM
    unset.
