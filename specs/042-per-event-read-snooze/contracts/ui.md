# Contract: the row actions, the panel, the list and the callout

Follows the `docket-ui` skill and `docs/design-system.md`. **No new UI primitive**: `Button`,
`buttonStyles`, `Badge`, `Alert`, `LiveRegion` and a native `<details>` / `<summary>` disclosure (already
used in `accounts/page.tsx` and `Composer.tsx`) cover everything (FR-028, M18).

## 1. Where the row actions appear

One component, `NotificationRowActions`, rendered by the shared `NotificationList` for every row, so the
bell's panel, `/notifications` and anywhere else the list is used get the same controls (FR-015).

```text
NotificationList({ items, now, returnTo?, onRowDone? })
  └── per item: NotificationRowActions({ item, returnTo?, onDone? })   "use client"
```

- `/notifications` is a server page: it passes `returnTo="/notifications"` and no callback, so the actions
  redirect back with a confirmation.
- `NotificationPanel` is a client component: it passes `onRowDone` and no `returnTo`, so a result comes back
  in place and the popover does not navigate (FR-017).
- The callout, the bell badge and Activity render no row actions.

## 2. The controls

Per row, after the message:

| Control | Markup | Accessible name |
|---|---|---|
| Mark read | `<form>` with one `Button type="submit"` and a hidden `eventId` | "Mark read" + `<span className="sr-only">` naming the problem, e.g. " — Failed, Acme, Bluesky · @acme.bsky.social" |
| Snooze | `<details>` whose `<summary>` is styled with `buttonStyles({ variant: "ghost", size: "sm" })`, containing one `<form>` with three `<button name="choice" value="hour\|tomorrow\|next_week">` submits | the summary is "Snooze" + the same sr-only problem name; each button is its `SNOOZE_LABEL` ("1 hour", "Tomorrow morning", "Next week") + the same sr-only problem name |

- **Keyboard.** Everything is a real `<button>` or `<summary>` in the normal Tab order with the project's
  `focus-visible:ring-2 focus-visible:ring-focus` ring. `<summary>` opens with Enter or Space natively. No
  hover-only or pointer-only affordance (FR-015).
- **No JavaScript.** Every control is a submit inside a form bound to a server action, with
  `<input type="hidden" name="returnTo" value="/notifications">` rendered **only until hydration**
  (`useSyncExternalStore`, the trick `NotificationBellClient` already uses). So a JavaScript-less post
  redirects and is confirmed on the reloaded page with the right count (FR-016, US1-AS6, US2-AS9), and a
  hydrated one stays put (M18).
- **Pending.** `Button pending={…} pendingLabel="Saving…"`; the submit is disabled only while pending.
- **At the cap.** When `item.actionsAvailable` is false, the row renders no controls and instead a `Sub`-style
  line: the at-cap sentence (§4) with a "Mark all as read" submit beside it, which posts the existing
  `markAllRead` action (FR-020, US4-AS3).
- **Focus after acting.** Marking read leaves the row in place, so focus stays on the button
  (`aria-disabled` is not used; the button simply becomes "Read"). Snoozing removes the row in the panel, so
  focus moves to the panel heading through the existing `focusAfterMark` helper (the same rule "Mark all as
  read" already follows).

## 3. What changes on screen

| Surface | Mark read | Snooze |
|---|---|---|
| The row | loses its "New" `Badge`, stays in the list (N20) | leaves the panel / list at once (N20, FR-010) |
| The bell | count and accessible name update from the action's `unread`, with no refetch (FR-017) | the same, and the next-change timer is re-armed from `unread.nextChangeAt` |
| The panel summary | the same number as the bell (US5-AS1) | the same |
| The project callout | recomputed on its next render from the same count (FR-019) | the same |
| Activity (both screens) | nothing — the event stays, with its real outcome, for everyone (N5's spirit, US2-AS3) | nothing |

`docket:notifications-changed` is dispatched after every real change, so any other bell on the page
re-counts; this is the existing mechanism (R12).

## 4. Wording

All of it in `src/lib/notifications/text.ts`, pure and unit-tested; every instant goes through `formatLocal`
in the project's zone, the app's one date format (design system §4, enforced by
`tests/lint/date-format.test.ts`).

| Function | Text |
|---|---|
| `markedReadConfirmation(count)` | "Marked as read. 2 unread problems." / "Marked as read. No unread problems." (reuses `unreadLabel`) |
| `snoozedConfirmation(until, timeZone)` | "Snoozed until Mon, Oct 12, 9:00 AM EDT." |
| `markAllConfirmation(snoozesCleared)` | "Marked as read." and, when any snooze was cleared, "Marked as read. 2 snoozed problems were cleared too." (FR-013, US3-AS2) |
| `markCapText()` | "Per-problem actions are unavailable for this project until it is marked read." (FR-020) |
| `rowErrorText(code)` | `busy` → "Could not save just now. Try again." · `not_found` → "That problem could not be found." · `at_cap` → `markCapText()` · `invalid` → "That change was not understood. Try again." |

`rowErrorText`'s `not_found` is the same sentence for an unknown id, a foreign project's id and a
non-attention event, and it reveals nothing about which (N23, US1-AS7).

## 5. Announcements

- Each `NotificationRowActions` renders its own `LiveRegion message={announcement}` (polite,
  `role="status"`), because `AnnounceProvider` is page-local in this codebase and the header is not inside
  one (M18).
- The message is set **only on a real change** (N12, FR-017): `markedReadConfirmation` or
  `snoozedConfirmation`. A `noop` result (the floor already covers the event) and a failure announce
  nothing; a failure is shown as a danger `Alert` instead.
- Never `assertive`, never an `alert` (FR-017).
- The bell's own poll announcement is untouched: it still fires only when the count rises, which a row
  action never does.

## 6. The panel and the personal list

- `NotificationPanel` keeps every behaviour from 022 — non-modal `role="dialog"`, Escape and outside-click
  closing, the heading focused on open, "Mark all as read", "View all problems", "Notification settings",
  and opening or closing it marks nothing. It gains: `onRowDone` handling (drop a snoozed row, clear a read
  row's "New"), and a "Mark all as read" confirmation that names the cleared snoozes.
- `/notifications` keeps its two cards and its no-JavaScript project toggles, and gains the row-action
  confirmations and errors from the redirect parameters
  ([services.md §9](./services.md#9-redirect-parameters-on-notifications-no-javascript)).
- The empty and all-muted states are unchanged. A person in no projects, or whose only memberships are
  muted, sees no row actions, because there are no rows (spec Edge Cases).
- A connect failure attempted by somebody else is not in this person's list at all, so it has no row action
  (N1).

## 7. The next-change refresh

`poll.ts` keeps its injectable `PollEnv` and its pure shape (R12), and gains `setTimeout` / `clearTimeout`:

- `startPolling(initial: UnreadSummary, env, handlers)` — it now takes the whole summary, so the one-shot
  timer is armed from the server-rendered bell, before any fetch.
- After each successful refresh the one-shot is cleared and re-armed from the new `nextChangeAt`; an instant
  already in the past refreshes immediately.
- The one-shot is armed only while the page is visible and cleared when it is hidden; the existing
  become-visible refresh covers a snooze that ran out while the tab was away.
- `nextChangeAt: null` arms nothing, so the behaviour with no snooze is exactly today's 60-second and
  become-visible behaviour (FR-022, US5-AS6).

Tested without a DOM, as `poll.test.ts` already is: a fake clock, a fake visibility source and a recorded
fetch.

## 8. Accessibility checklist (SC-009)

- Full keyboard use: every control is a `<button>` or `<summary>`, in document order, with a visible focus
  ring.
- Controls are labelled with the problem they act on, in their accessible name, not only visually.
- Status is text as well as colour: the "New" `Badge` has the word "New"; the outcome `Badge` has its label.
- Polite announcements only on real change; no `aria-live` region is created together with its text.
- Everything works with no client JavaScript on `/notifications`; the bell remains a plain link there.
- The whole surface is checked once by hand in a browser as the **last** task of the implement phase, after
  every automated check (roadmap rule).
