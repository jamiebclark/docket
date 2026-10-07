# Contract: UI

Every screen follows the `docket-ui` skill and `docs/design-system.md`:

- server components by default, with client components only at the leaves;
- visible labels, with help text through `aria-describedby`;
- one right-aligned primary action that shows its own pending state;
- semantic colour tokens only;
- keyboard-only flows.

Before touching any route or action code, read `node_modules/next/dist/docs/01-app/` (Next.js 16.3.8; AGENTS.md).

Only existing UI parts are used: `Dialog`, `Button`, `SegmentedControl` (`cards`), `Field`, `LiveRegion`, `formatLocal`. There is no new dependency.

## Where it appears (FR-015)

| Page | Render site | New props passed |
|---|---|---|
| Failures, one row per target | `src/app/p/[projectSlug]/failures/page.tsx` (`variant="row"`) | `accountId={row.account.id}`, `timeZone={tz}` |
| Post page, each target | `src/app/p/[projectSlug]/posts/[postId]/page.tsx` (`variant="detail"`) | `accountId={t.accountId}`, `timeZone={tz}` |

`TargetResolution` (`src/components/targets/TargetResolution.tsx`) gains the required props `accountId: string` and `timeZone: string`. Everything else it renders keeps its behaviour: cancel, mark published, mark not published, the blocked reason with the reconnect link (FR-020), and "View only".

## The control

- `status === "failed" && actions.canRetry`: one `Button` labelled **"Retry…"**, which opens `RetryDialog`. This replaces the old "Retry" button.
- `status === "failed" && actions.retryBlockedReason`: the reason and the "Reconnect {account}" link, with no Retry control (unchanged, FR-020).

## `RetryDialog`: `src/components/targets/RetryDialog.tsx` (new, client)

Props: `{ open, onClose, onDone(result), slug, targetId, accountId, accountName, timeZone }`.

**Title**: `Retry the post to {accountName}` (D1; it names the account, as the other target dialogs do).

### On open

1. The mode is set to `"now"` (D1), and the error and the time fields are cleared.
2. The requeue preview starts: `previewRequeueAction(slug, { targetId })`, with `preview` set to `"loading"` until it returns.
   - **Action failure**: `{ ok: false, code: "account_unavailable", message: res.message }`. This handling is the same as in `openNotPublished`. It covers both the D6 conflict and a network error.

### Body

1. **Mode choice**: `SegmentedControl` with `layout="cards"`, `label="When should it go out?"`, `name="retry-mode-{targetId}"`, and three options:

   | value | label | description (`aria-describedby` on the radio) | disabled |
   |---|---|---|---|
   | `now` | Now | "Tries again on the next scheduler pass." | never |
   | `requeue` | Next free slot | loading: "Finding the next free slot…"<br>ok: "{localTime} — the next free slot for {accountName}."<br>failed: `preview.message` | while loading or `!preview.ok` (FR-016) |
   | `at` | Pick a time | "Choose a date and time in {timeZone}." | never |

2. **When `mode === "at"`**: two `Field` inputs, which reuse the composer's labels:
   - `Date ({timeZone})`, `type="date"`, id `retry-date-{targetId}`;
   - `Time ({timeZone})`, `type="time"`, id `retry-time-{targetId}`.

   Once both have values, call `previewExplicitTimeAction(slug, { local: \`${date}T${time}\`, accountIds: [accountId] })`. Discard stale responses with the `live` flag, as `ScheduleAtDialog` does. Below the fields, in an `aria-live="polite"` container:
   - `inPast`: `<p role="alert">That time has passed. Pick a later time, or use Retry now.</p>`;
   - otherwise: `explicitTimeText(preview, timeZone)`, which gives the gap and overlap sentences, word for word as in the composer;
   - each `warnings[i].message` in `text-warning`.

3. **Error line**: `<p role="alert" className="min-h-4 text-xs text-danger">{error}</p>`, the same pattern as the other dialogs.

### Footer

The footer is right-aligned:

- **Back** (`secondary`) closes the dialog;
- **primary** (`pending`, `pendingLabel="Retrying…"`):
  - label: "Retry now" for `now`, "Retry in next free slot" for `requeue`, and "Retry at this time" for `at`;
  - disabled while `!canConfirm(...)`.

### Confirm

`retryTargetAction(slug, input)`, where `input` is one of:

- `{ targetId }` for `now`;
- `{ targetId, mode: "requeue", expected: preview.scheduledAt }`;
- `{ targetId, mode: "at", at: timePreview.instant }`. This is the very instant shown before confirming (SC-004).

**The result**:

- **`ok && data.status === "scheduled"`**: close; `announce(retryAnnouncement(data))`; `onDone(data)`; focus as described below.
- **`ok && data.status === "failed"`**: stay open; `setError(data.message)`; `announce(data.message)` (FR-018). For a `requeue` refusal, the preview is re-fetched so that the option shows the current state.
- **`!ok`** (conflict, forbidden, validation, not_found): stay open; `setError(res.message)`; `announce(res.message)`.

**Escape** closes the dialog (native `<dialog>`, through `Dialog`).

**Keyboard**:

- Tab: opener → modes (arrow keys move within the group) → date → time → Back → primary.
- The focus ring is visible everywhere (design-system focus tokens).

## Pure helpers: `src/components/targets/retry-ui.ts` (new, client-safe, unit-tested)

```ts
export type RetryMode = "now" | "requeue" | "at";
export function canConfirm(mode: RetryMode, preview: RequeuePreview | "loading" | null, timePreview: ExplicitTimePreview | null): boolean;
// now → true; requeue → preview is an object and preview.ok; at → timePreview !== null && !timePreview.inPast
export function retryAnnouncement(result: Extract<RetryResult, { status: "scheduled" }>): string;
// now:     "Retry queued for the next tick."
// requeue: "Retry scheduled for {localTime} in the next free slot." + (changedFromPreview ? " The previewed slot was taken, so the time changed." : "")
// at:      "Retry scheduled for {localTime}." + warnings.map(w => " " + w.message).join("")
export function confirmLabel(mode: RetryMode): string;
```

## Shared text: `src/components/schedule/explicit-time-text.ts` (new; moved, not rewritten)

```ts
export function explicitTimeText(p: { kind: "exact" | "gap" | "overlap"; instant: string; resolvedLocal: string }, timeZone: string): string;
```

This is the body of `previewText` from `compose/ScheduleDialogs.tsx`, moved without changes. `ScheduleAtDialog` imports it, so the composer output is unchanged.

## Announcements and focus: `src/components/ui/Announce.tsx` (new, client)

```tsx
export function AnnounceProvider({ focusFallbackId, children }: { focusFallbackId: string; children: ReactNode }): JSX.Element;
// Renders children plus one <LiveRegion message={…} /> that stays mounted for the page's lifetime.
export function useAnnounce(): { announce(message: string): void; restoreFocus(): void } | null;
// restoreFocus(): after the next paint, if document.activeElement is <body> or not connected,
// focus #focusFallbackId (tabIndex -1).
```

- **Pages**: the Failures page and the post page wrap their content in `<AnnounceProvider focusFallbackId="page-title">`.
  - `PageHeader` gains optional `titleId`. When it is given, the `<h1>` gets that `id` and `tabIndex={-1}`.
- **`TargetResolution`**: `const ctx = useAnnounce()`.
  - **Provider present**: it calls `ctx.announce` and, after a successful retry, `ctx.restoreFocus()`.
  - **No provider**: it keeps rendering its own `LiveRegion`, as today. This keeps `tests/integration/failures/ui.test.tsx`'s `role="status"` check valid.
  - The existing ambiguous-dialog announcements also go through `announce`, with the same strings.

## Server-rendered checks (static markup)

These can be checked with `renderToStaticMarkup`:

- a failed, retryable target renders a button whose text is `Retry…`, and no `>Retry<`;
- a blocked target renders the reason and the link, and no `Retry…`;
- `RetryDialog` rendered with `open` contains:
  - the three radio labels;
  - `name="retry-mode-…"`, with `checked` on `now`;
  - the title with the account name;
  - `disabled` on the requeue radio while loading.
