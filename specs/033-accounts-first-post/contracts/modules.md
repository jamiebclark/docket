# Module contract: code this entry adds or changes

This covers signatures and behaviour only; bodies belong to the implement phase. The rationale for each item is in
[research.md](../research.md), and the shapes are in [data-model.md](../data-model.md).

## 1. `src/lib/accounts/connect-landing.ts` (new, pure, client-safe)

```ts
export const LANDING_MAX = 500; // = MAX_CANDIDATES; re-declared here so this file has no server import

export interface ConnectLanding {
  accountId: string;
  target: "slots" | "card";
  connected: number;
  reconnected: number;
}

/** Split saved accounts into new and reconnected by the ids that were active before the save (R3). `null` when `saved` is empty. */
export function classifyConnect(saved: readonly { id: string }[], priorIds: ReadonlySet<string>): ConnectLanding | null;

/** `/p/{slug}/accounts?landed=…&connected=…&reconnected=…#account-{id}-slots` (target "slots") or `#account-{id}` ("card"). */
export function landingHref(slug: string, landing: ConnectLanding): string;

/** Validates the page's search params (Zod). Returns `null` for anything missing, repeated, malformed or out of range. */
export function parseLanding(query: Record<string, string | string[] | undefined> | undefined):
  { accountId: string; connected: number; reconnected: number } | null;

/** The FR-013 sentence for the landed account (table in research R6). */
export function landingMessage(counts: { connected: number; reconnected: number }, accountName: string): string;
```

**Rules**:

- No import from `@/server/*`.
- `classifyConnect` picks `accountId` as the first saved id **not** in `priorIds`, else the first saved id.
- `slug` is URL-encoded in `landingHref`; ids are UUIDs.
- `parseLanding` never returns a `target`, so the page recomputes it (data-model §2).

**Callers**: `accounts/actions.ts` (four actions) and `accounts/page.tsx`.

## 2. `src/lib/accounts/chooser-order.ts` (new, pure, client-safe)

```ts
/** Roots in input order, each followed by its children in input order (R4). Keeps every element exactly once. */
export function listedOrder<T extends { key: string; parentKey: string | null }>(candidates: readonly T[]): T[];
```

**Callers**:

- `ChooserForm.tsx`, which replaces its inline `roots`/`childrenOf`. The rendered markup is unchanged.
- `chooseConnectCandidates` in `src/server/services/connect.ts`. It sorts `chosen` before saving and maps each
  payload candidate to `{ key: candidateKey(...), parentKey: … }` for the sort.

## 3. `src/app/p/[projectSlug]/accounts/actions.ts` (changed)

```ts
export type ConnectedAccount = accounts.AccountView & { landing: string };

export async function connectMockAction(slug, input): Promise<ActionResult<ConnectedAccount>>;
export async function reconnectMockAction(slug, input): Promise<ActionResult<ConnectedAccount>>;
export async function connectCredentialsAction(slug, input): Promise<ActionResult<ConnectedAccount>>;
export async function chooseConnectCandidatesAction(slug, input): Promise<ActionResult<{ saved: number }>>; // unchanged type; redirects to landingHref on success
```

**Rules**:

- Inside the same `runAction` callback: read `priorIds` with `accounts.listAccounts(scope)` **before** the service
  call. Then call the service exactly as today, then `classifyConnect`.
- The mock connect may skip the pre-read: it is always new.
- `reconnectMockAction` classifies as reconnected without the read.
- Every failure path returns exactly what it returns today: same `error`, `message` and `fieldErrors`. It returns no
  `landing`, makes no redirect, and its `refresh()` behaviour is unchanged.
- No new activity entry, audit row or notification (FR-017). Results never echo `input.fields` (the existing
  authz test).
- `startOAuthConnectAction` and `pasteConnectTokenAction` don't change.

## 4. `src/app/p/[projectSlug]/accounts/ConnectLanding.tsx` (new, page-local client component)

```tsx
"use client";
export function ConnectLanding(props: {
  /** Element scrolled to the top (respects its scroll-margin): `account-{id}-slots` or `account-{id}`. */
  scrollId: string;
  /** Element focused with preventScroll: a CSS selector, e.g. `input[name="slot-day-{id}"]:checked` or `#account-{id}-name`. */
  focusSelector: string;
  /** The FR-013 sentence; announced through a LiveRegion after focus moves. */
  message: string;
}): JSX.Element; // renders <LiveRegion message={announced} />
```

**On mount, once**:

1. scroll;
2. focus;
3. set the announced message (empty until now);
4. `history.replaceState(null, "", location.pathname + location.hash)`.

It must not throw if either element is missing (the account was removed between render and mount).

## 5. Client forms (changed)

- `ConnectCredentialsForm`: on `res.ok`, clear the values (as today), set the status text (as today), then
  `router.push(res.data.landing)`.
- `ConnectMockForm`: on `res.ok`, clear the name, then `router.push(res.data.landing)`.
- `ReconnectMockButton` (`SlotEditor.tsx`): on `res.ok`, `router.push(res.data.landing)`.
- `ChooserForm`: unchanged, apart from using `listedOrder`. Its comment ("On success the action redirects") stays
  true.

## 6. `src/components/ui/Checklist.tsx` (changed, additive)

```tsx
export function checklistStatusText(status: ChecklistStatus): string; // was the private statusText
/** The ordered rows. Shared by Checklist and SetupNotice so they can't drift. */
export function ChecklistRows({ items }: { items: readonly ChecklistItem[] }): JSX.Element;
export function Checklist(props: { title: string; items: readonly ChecklistItem[]; collapsedSummary?: string;
  /** Rendered after the list and outside the collapsed `<details>`, so it shows in both forms. */
  footer?: ReactNode }): JSX.Element;
```

The markup for existing callers without `footer` is byte-identical.

## 7. `src/components/ui/SetupNotice.tsx` (new, shared, server-compatible)

```tsx
/**
 * A "you can't do this yet" panel: EmptyState's dashed frame and icon, a title, an optional lead sentence and the
 * list of prerequisites (ChecklistRows). Use for prerequisite gates; use Checklist for progress lists.
 */
export function SetupNotice(props: {
  title: string;
  items: readonly ChecklistItem[];
  lead?: string;
  icon?: IconName;          // decorative; default "info"
  headingLevel?: 2 | 3;     // default 2
  id?: string;              // default "setup-notice"; title id is `${id}-title`
}): JSX.Element;
```

**Markup**: `<section aria-labelledby="{id}-title">` → the icon disc (`aria-hidden` through `Icon`) → `<h2|h3 id>` →
the optional `<p>` → `<ChecklistRows>`. It has no client code.

## 8. `src/lib/overview/derive.ts` (changed, additive)

```ts
/** The overview's "Write and schedule your first post" rule (FR-031). */
export function countsTowardFirstPost(counts: Partial<Record<PostStatusKey, number>>): boolean;
```

`deriveChecklist` uses it in place of the inline sum at `:183`. The behaviour is identical.

## 9. `src/server/services/overview.ts` (changed, additive)

```ts
/** Read-only: whether any post counts toward the first-post step. Requires view. */
export async function hasFirstPost(scope: ProjectScope): Promise<boolean>;
```

It is implemented as `countsTowardFirstPost(omit(await scope.posts.counts(), "needs_decision"))`. It goes through the
scoped DAL only (constitution III).

## 10. `src/lib/compose/first-post.ts` (new, pure, client-safe)

```ts
export function firstPostCalendarHref(input: {
  slug: string;
  kind: "queue" | "schedule" | "now";
  rows: readonly { ok: boolean; scheduledAt?: string }[];
  timeZone: string;
}): string;

/** YYYY-MM-DD of an instant in an IANA zone (Intl formatToParts; instant→date is unambiguous). */
export function zonedDate(instant: string | Date, timeZone: string): string;
```

## 11. Composer (changed)

- `Composer` gains the prop `firstPostDone: boolean`, which defaults to `true` so that a missing prop never shows the
  link. It passes the prop to the three dialogs.
- Each dialog:
  - captures `wasFirst` when the user confirms;
  - shows `<Link className={buttonStyles({ variant: "primary" })}>See it on the calendar</Link>` in the footer when
    `done && wasFirst && rows.some(ok)`;
  - resets `wasFirst` on close.
- `compose/page.tsx` and `compose/[postId]/page.tsx` pass `firstPostDone={canSchedule ? await hasFirstPost(scope) : true}`.
- `compose/actions.ts` is **unchanged** (FR-036).

## 12. `src/lib/docs.ts` (changed)

`DocPage` gains `"getting-started"`.

## 13. `src/components/shell/ProjectSwitcher.tsx` (changed)

- The button gains `aria-keyshortcuts="Control+K Meta+K"`.
- The `<kbd>` gains `aria-hidden="true"`.
- Nothing else changes.

## 14. `src/app/setup/setup-form.tsx` (changed)

```tsx
export function SetupField(props: { name: string; label: string; type: string; autoComplete: string; hint?: string; error?: string }): JSX.Element;
```

- The input's `aria-describedby` is `[hint ? "{name}-hint" : null, error ? "{name}-error" : null]`, space-joined, or
  `undefined` when there is neither.
- The hint `<span id="{name}-hint">` is always rendered when `hint` is given.
- `SetupForm` renders three `SetupField`s with today's arguments.
