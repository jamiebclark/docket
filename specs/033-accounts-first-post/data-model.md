# Data model: Accounts restructure and first-post flow

**Feature**: `033-accounts-first-post` | **Plan**: [plan.md](./plan.md)

**There are no persistent changes.** This entry adds no table, column, enum, index, migration or stored preference,
and writes nothing new. Every entity below is either a view computed per request or a value carried in a URL.
`pnpm db:check` is unaffected.

## 1. Account card section (view)

The fixed order of the blocks inside one card on the Accounts page (FR-001–FR-009). It isn't stored.

| # | Section | Contents | Owner / admin | Editor |
|---|---|---|---|---|
| 1 | Status | ProviderIcon, name (`h3#account-{id}-name`), platform, status Badge, connected time, last error, notes; mock controls (mock only); reconnect controls (`needs_reauth` only) | all | name to notes only |
| 2 | Posting slots | `h4#account-{id}-slots` "Posting slots ({tz})", slot table or "No posting slots yet.", then the add-slot form | table with row actions, plus the form | table without the Actions column |
| 3 | Posting instructions | `<details>` (closed). Summary: "Posting instructions · Set" or "Posting instructions · None" | the form inside | read-only text or "No posting instructions." inside |
| 4 | Remove | `RemoveAccountDialog`, set apart with a top border | shown | absent |

**Anchors kept** (FR-008): `#account-{id}` on the card `<section>`, `#account-{id}-slots` on the slots heading and
`#add-account` on the connect section. All of them keep `scroll-mt-[calc(var(--sticky-top)+1rem)]`.

**Derived value**: `instructionsSet = account.postingInstructions !== null`.

## 2. Connect outcome (value, not stored)

This is built by an action after a successful save, and carried to the page in the URL (research R2, R3).

```ts
interface ConnectOutcome {
  /** Saved accounts in listed order (chooser) or the single account (credentials / mock). */
  saved: readonly { id: string }[];
  /** Ids of the project's active accounts read before the save. */
  priorIds: ReadonlySet<string>;
}

interface ConnectLanding {
  accountId: string;          // first new account, else first saved account
  target: "slots" | "card";   // "slots" when accountId is new
  connected: number;          // saved accounts not in priorIds   (0..500)
  reconnected: number;        // saved accounts in priorIds       (0..500)
}
```

**Rules**:

- `connected + reconnected === saved.length` and `≥ 1`. A save of zero accounts is already a failure ("Nothing was
  connected.", `connect.ts:238`), so it never produces a landing.
- `target === "slots"` exactly when `connected ≥ 1`.
- Mock connect → `{ connected: 1, reconnected: 0 }`. Mock reconnect and credentials with `accountId` →
  `{ connected: 0, reconnected: 1 }`.

**URL form**: `/p/{slug}/accounts?landed={accountId}&connected={n}&reconnected={m}#account-{id}-slots` when the target
is the slots, `#account-{id}` when it is the card.

**Parsed form on the page**: `parseLanding(query)` returns `{ accountId, connected, reconnected }` or `null`. The page
then:

- shows the landing only if the viewer can manage accounts **and** `accountId` is in its own account list;
- otherwise renders exactly as today (FR-018).

`target` isn't trusted from the URL. The page recomputes it as `connected ≥ 1 ? "slots" : "card"`.

**Validation (Zod)**:

- `landed`: a UUID;
- `connected`, `reconnected`: integer strings in `0..500` (`MAX_CANDIDATES`), with a sum `≥ 1`;
- arrays (repeated keys) or any other value → `null`.

## 3. Landing message (view)

`landingMessage({ connected, reconnected }, name)` produces the strings in research R6. `name` is the landed account's
`displayName`, taken from the page's list.

## 4. Chooser listed order (view)

`listedOrder(candidates)`: each root (no `parentKey`, or a parent that isn't offered) in payload order, followed by
its children in payload order. `ChooserForm` and `chooseConnectCandidates` both use it (research R4). It is
idempotent and keeps every element exactly once.

## 5. Prerequisite item (existing, unchanged)

`ChecklistItem` from `src/components/ui/Checklist.tsx`: `key`, `title`, `description`, `optional?`,
`status: done | todo | waiting(on)`, `action?`, `blocked?`, `children?`. `generationPrerequisites` produces the list
(`src/lib/roles/prerequisites.ts`). SetupNotice renders it; nothing about its content changes (FR-024).

## 6. First-post fact (read, never stored)

```ts
countsTowardFirstPost(counts: Partial<Record<PostStatusKey, number>>): boolean
// (scheduled ?? 0) + (publishing ?? 0) + (published ?? 0) + (partially_failed ?? 0) >= 1
```

It is read once per Composer page load as `firstPostDone = await hasFirstPost(scope)`, and only when the viewer can
schedule. Each dialog captures `wasFirst = !firstPostDone` at confirm time.

**Link shown** ⇔ `wasFirst && rows.some(r => r.ok)`.

**Link target**:

- Publish now → `/p/{slug}/calendar`.
- Schedule or Add to queue → `/p/{slug}/calendar?view=month&date={YYYY-MM-DD}`, where the date is the project-zone
  date of `min(rows.filter(ok).scheduledAt)`.
- If no `ok` row carries a `scheduledAt` (defensive), the link falls back to `/p/{slug}/calendar`.

## 7. Doc page (registry)

`DocPage` gains `"getting-started"`. `docsUrl("getting-started")` →
`https://jamiebclark.github.io/docket/getting-started/`. The page must be in the `mkdocs.yml` nav (published-docs
test).

## State transitions

None. No entity here has a lifecycle. The only "transition" is in the browser: when `ConnectLanding` mounts, it
removes `landed`, `connected` and `reconnected` from the URL with `history.replaceState`, so the landing happens once
per connect.
