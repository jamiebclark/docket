# Contract: UI (failures view, post detail, navigation)

Follows the `docket-ui` skill. Server components are the default. The only client component added is the shared resolution dialog (`TargetResolution`), plus the existing `Dialog` and `Button` atoms. Before writing routes, read `node_modules/next/dist/docs/01-app/` (AGENTS.md).

## 1. Route `/p/[projectSlug]/failures`

Files:

- `src/app/p/[projectSlug]/failures/page.tsx` (server)
- `loading.tsx` (skeleton matching the table)
- the existing project `error.tsx` covers errors

The page sets `metadata.title = "Failures"` and `dynamic = "force-dynamic"`.

- **Data:** `failures.listFailures(scope, searchParams)`. A non-member, a missing project or a malformed id gives `notFound()`, the same as other project pages (FR-006).
- **Header:** `<h1>Failures</h1>`, then a summary sentence: "2 need your decision · 5 failed". It uses `totals`.
- **Filters:** `FilterTabs` links for All, Needs your decision and Failed (`?status=`). Next to them is a GET `<form>` with a labelled account `<select>` and an "Apply" button (`?account=`), so it works without JS. Filters and page are kept in search params, so the URL is shareable (FR-004).
- **Table:** a real `<table>` with `<caption class="sr-only">`. The columns are Account, Post, Meant to go out, How, Last error, Attempts and Actions, with `<th scope="col">`.
  - **Group headers:** one `<tr><th scope="rowgroup" colspan=7>` before the first ambiguous row, reading "Needs your decision", with an amber `Badge` with text. Another before the first failed row, reading "Failed".
  - **Account:** the name plus the provider name, e.g. "Removed account" or "Reconnect needed" shown as text badges.
  - **Post:** the excerpt, linking to `/p/<slug>/posts/<postId>`.
  - **Meant to go out:** `LocalTime` in the project time zone, with the zone shown once in the header cell.
  - **How:** Queue slot, Chosen time or Publish now.
  - **Last error:** plain text.
  - **Attempts:** the number.
- **Row expander:** a second `<tr>` per target with a `colspan` cell holding `<details>`. Its `<summary>` reads "Attempt log (N entries)". Inside is a nested table with Time, Step, Outcome, Who, Request and Response, oldest first.
  - Runs with `count > 1` render as one row ("check status · continue × 14") with a nested `<details>` listing each entry. Nothing is omitted (FR-003).
  - `<summary>` is natively keyboard operable and shows a visible focus ring.
- **Actions cell:** a `TargetResolution` client component (§3) with `variant="row"`.
  - Ambiguous rows offer **Mark published** and **Mark not published…**.
  - Failed rows offer **Retry**, or instead the text `retryBlockedReason` with a link ("Reconnect <account>" → `/p/<slug>/accounts`).
  - When the user lacks `post:schedule`, the cell shows "View only" and no buttons appear.
- **Pagination:** the existing `Pagination` component, preserving `status` and `account`.
- **Empty state:** an `EmptyState` with "Nothing needs attention. Every post that was due went out or is still scheduled." and a link to "View posts".
- **Filtered-empty state:** "No posts match this filter." with a link to clear the filters.
- **Results:** a successful action calls `refresh()` (as the post actions do). The resolved row leaves the list. The outcome is announced through `LiveRegion`, for example "Marked published.", "Scheduled for Thu 9 Oct, 09:00 Europe/London." or "Retry queued for the next tick."

## 2. Navigation

`src/components/shell/LeftNav.tsx`:

- `NAV_SECTIONS` gains `{ slug: "failures", label: "Failures" }` after `review`.
- The component takes `failuresCount` and renders `Failures (2)` when the count is above 0. It is a text count, like Review's.
- `src/app/p/[projectSlug]/layout.tsx` passes `countNeedsDecision(scope)`, which counts ambiguous targets only (FR-005).
- Any other copy of the section list (001 F12) is derived from `NAV_SECTIONS`.

## 3. `src/components/targets/TargetResolution.tsx` (client; moved from `posts/[postId]/TargetActions.tsx`)

Props:

```ts
{
  slug: string; targetId: string; accountName: string;
  status: "ambiguous" | "failed" | "scheduled" | "draft" | string;
  actions: FailureActions;       // from the service
  variant: "row" | "detail";
}
```

The dialogs use the existing `Dialog` (focus trap, Escape, focus return), with labelled controls and errors in `role="alert"`:

- **Mark published**
  - Title: "Mark as published to <account>?"
  - Field: an optional "Link to the post", `type="url"`, with help text "An http or https address." The field error comes from `fieldErrors.url`, and on error focus moves to the field.
  - Buttons: Back and **Mark as published**.
- **Mark not published…**
  - On open, it calls `previewRequeueAction`. While that runs, the dialog shows "Finding the next free slot…" (`aria-busy`).
  - **If a slot was found:** the text reads "It will go out in the next free slot for <account>: Thu 9 Oct, 09:00 Europe/London." The primary button is **Mark not published and requeue**, with a secondary **Don't requeue**.
  - **If no slot was found** (or the account is unavailable or the content fails validation): the dialog gives the message, and the only choice is **Mark not published, don't requeue**.
  - **On a requeue result of `failed / no_free_slot`** (the slot went in a race): the dialog closes and the live region says "No free slot was left, so it's marked failed. Retry or schedule it."
  - **If the slot changed from the preview:** the live region reads "Scheduled for <new time> (the previewed slot was taken)."
- **Retry:** a single button, with the pending label "Retrying…". There is no dialog, matching today's behaviour.
- **Conflict errors** ("This post was already resolved." and the like) appear inline, and the view refreshes.
- The `scheduled` and `draft` **Cancel** action stays here for `variant="detail"`, so the post detail page loses nothing.

## 4. Server actions (`src/app/p/[projectSlug]/posts/actions.ts`)

```ts
retryTargetAction(slug, { targetId }): Promise<ActionResult<void>>;                            // unchanged
resolveTargetAction(slug, { targetId, outcome: "published"; url?: string }
                        | { targetId, outcome: "not_published"; requeue: boolean; expected?: string }): Promise<ActionResult<ResolveResult>>;
previewRequeueAction(slug, { targetId }): Promise<ActionResult<RequeuePreview>>;               // new, no writes
```

All of them go through `runAction`. A non-member gets `not_found`. A member without the right gets `forbidden`, with the message "You don't have permission to do that." (FR-006, US1-AS8).

## 5. Post detail page (`src/app/p/[projectSlug]/posts/[postId]/page.tsx`)

- The `<dl>` per target gains **Attempts** with the count (003 F9).
- The **Link** row renders through `safeExternalHref`. A non-http(s) stored value is shown as text.
- The actions use `TargetResolution` with `variant="detail"` and the target's `actions` (FR-011).
- The attempts table gains a **Who** column and the same run grouping as the failures view.

## 6. Accessibility checks (tests in `tests/integration/failures/ui.test.tsx`)

The tests render HTML (`renderToStaticMarkup(await FailuresPage(...))`) and assert:

- the `<caption>`;
- `th[scope=col]` on every column;
- the two `rowgroup` headers in order;
- one `<details>` per row;
- every button has text;
- the account `<select>` has a `<label>`;
- the empty and filtered-empty texts;
- "View only" for a member without `post:schedule`;
- no `token`, `secret` or `password` values in the markup.
