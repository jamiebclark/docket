# Contract: "Retry all failed" on the Failures page

**Feature**: `015-bulk-retry-failed`. This follows the `docket-ui` skill and `docs/design-system.md`. It uses only existing components from `src/components/ui/`.

## 1. Page wiring: `src/app/p/[projectSlug]/failures/page.tsx`

- **Where it renders**: inside the existing filter bar (`div.mt-4.flex.flex-wrap.items-end.gap-4`), after the account form, only when **all** of these hold:
  - `canSchedule`;
  - `query.status !== "ambiguous"`;
  - `list !== null`.

  The page renders:

  ```tsx
  <RetryAllFailed
    key={`${query.status}:${query.account ?? ""}`}
    slug={projectSlug}
    accountId={query.account ?? null}
    accountName={query.account ? list.accounts.find(a => a.id === query.account)?.name ?? null : null}
    failedCount={list.failedInFilter}
  />
  ```

- **Not rendered at all**: for viewers without `post:schedule`, on the "Needs your decision" tab, and when the list failed to load (FR-015).
- **The `key`**: a filter change remounts the component, which clears any summary.

## 2. `src/components/targets/RetryAllFailed.tsx` (new, `"use client"`)

The component renders two flex items as a fragment:

1. **The button** (when `failedCount > 0`):
   - `<Button variant="secondary">` in an `ml-auto` wrapper, with the label `retryAllLabel(failedCount, accountName)`;
   - it opens `RetryAllDialog`;
   - when `failedCount === 0`, there is no button (FR-015).
2. **The summary** (when a result is held): a `basis-full` block with `<Alert tone={result.changed ? "success" : "info"} role="none">`.
   - It holds `result.message`.
   - When `summaryAccounts(result)` has more than one entry, it adds a `<ul>` with one `<li>` per account: "{name}: {n} retried, {phrases…}" (FR-019).
   - `role="none"`, because the page's `LiveRegion` already announces the message, and the text must not be announced twice.
   - The summary stays until the component remounts (filter or navigation) or the next run replaces it.

The component holds `open`, `result` and `dialogKey` (it remounts the dialog per open, as `TargetResolution` does, so the state starts fresh).

## 3. `src/components/targets/RetryAllDialog.tsx` (new, `"use client"`)

**Props**: `{ open, onClose, onDone(result), slug, accountId, accountName }`.

**Title**: `retryAllTitle(accountName)`: "Retry all failed posts for Acme Bluesky" or "Retry all failed posts".

**Body, in order**:

1. **Numbers** (`aria-live="polite"` container):
   - While loading: "Counting failed posts…".
   - Then the lines from `previewLines(preview)`:
     - "{inScope} failed post(s) in scope." ("in Acme Bluesky" / "across all accounts")
     - "{willAttempt} will be retried." (or "Up to 100 will be retried in this step; press again to continue." when `capApplies`)
     - When the blocked total is above zero: "{k} can't be retried yet:" followed by a list using `SKIP_PHRASES` (for example "2 need reconnecting").
   - A preview error shows its message in the alert line (item 4).
2. **Mode**: `<SegmentedControl layout="cards" name="retry-all-mode" label="How should they be retried?" value={mode}>`:
   - `now`, labelled "Retry now", with the description "Each post goes back for the next scheduler pass. Each account's usual spacing still applies." It is preselected (D9).
   - `requeue`, labelled "Requeue into next free slots", with the description "Each post takes its account's next free posting slot. Posts meant to go out earlier get earlier slots. Content is checked first."
   - Both stay enabled. Slot availability is reported per account in the result, not predicted.
3. **Nothing can be attempted** (`preview.willAttempt === 0`): the text "None of these posts can be retried until their accounts are fixed.", and the confirm button is disabled (FR-017, US1 AS2).
4. **Error**: `<p role="alert" className="min-h-4 text-xs text-danger">{error}</p>`.
5. **Actions** (right-aligned): `Back` (secondary), then confirm `<Button pending={pending} pendingLabel="Retrying…" disabled={!canConfirmAll(preview)}>{confirmAllLabel(mode, willAttempt)}</Button>`, where:
   - `now` → "Retry now";
   - `requeue` → "Requeue posts".

**Behaviour**:

- **Open**: load `previewRetryAllAction(slug, { account })` in a separate transition.
- **Confirm**:
  - A `submitting` ref guard plus `Button pending` give one submit only (FR-018).
  - `res = await retryAllFailedAction(slug, { account, mode })` runs in `try/catch`.
  - **`ok`**:
    - `onDone(res.data)`, then `announce(res.data.message)`;
    - set `returnFocus = controlRemains(res.data)`, then `onClose()`;
    - if `!controlRemains`, call `focusFallback()` after close (the 012 `done` pattern).
  - **`ok: false`**: show `res.message` in the alert line and announce it.
  - **Rejected**: show and announce `UNEXPECTED_ERROR` = "Some posts may have been retried. Reload the page to see where things stand.".
- **Keyboard**:
  - Tab order: the radios (arrow keys within the group), Back, confirm.
  - Escape closes through the native `<dialog>`.
  - Focus returns to the opener on cancel.
  - Every control has a visible label (FR-020, SC-007).

## 4. `src/components/targets/retry-all-ui.ts` (new, pure) plus `retry-all-ui.test.ts`

```ts
retryAllLabel(count: number, accountName: string | null): string
//   (4, "Acme Bluesky") → "Retry all 4 failed posts for Acme Bluesky"
//   (1, "Acme Bluesky") → "Retry 1 failed post for Acme Bluesky"
//   (12, null)          → "Retry all 12 failed posts"
//   (1, null)           → "Retry 1 failed post"
retryAllTitle(accountName: string | null): string
previewLines(p: RetryAllPreview): { counts: string[]; blocked: string[] }
canConfirmAll(p: RetryAllPreview | "loading" | null): boolean        // loaded and willAttempt > 0
confirmAllLabel(mode: "now" | "requeue"): string
controlRemains(r: RetryAllResult): boolean                           // P11
summaryAccounts(r: RetryAllResult): { name: string; line: string }[] // only accounts with a skip or remaining; shown when > 1 such account
export const UNEXPECTED_ERROR: string
```

The helpers import runtime values (`SKIP_REASONS`, `skipPhrase`) only from `@/lib/failures/retry-all-text`. From `@/server/services/posts` they import **types only** (`import type`), as `retry-ui.ts` does today, so no DAL code reaches the client bundle. The client components import the actions from `@/app/p/[projectSlug]/failures/actions`, as `RetryDialog` imports `posts/actions`.

## 5. States

| State | What shows |
|---|---|
| Loading page | the existing `loading.tsx` skeleton (unchanged) |
| No failed in filter | no button. The empty state is unchanged. |
| Dialog loading | "Counting failed posts…", confirm disabled |
| All blocked | the explanation, confirm disabled |
| Pending | confirm shows "Retrying…" and is disabled. Back and Escape still close. |
| Done | dialog closed, live-region announcement, visible summary, list refreshed |
| Error | the dialog stays open with a `role="alert"` message |
