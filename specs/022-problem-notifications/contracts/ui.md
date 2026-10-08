# Contract: UI

This follows the `docket-ui` skill and `docs/design-system.md`. Components are server components by default. The client parts are the bell's leaf (`NotificationBellClient`) and the panel it opens. Copy is final unless a test proves it unclear.

## 1. Routes

| Route | New or changed | Who | Notes |
|---|---|---|---|
| `/notifications` | **New**: `page.tsx`, `loading.tsx`, `error.tsx`, `actions.ts` | Any signed-in user | Outside any project. Renders `SignedInHeader`. Title "Notifications". |
| `/p/[slug]` | Changed | Members | `ProblemsCallout` above the existing content |
| `/p/[slug]/posts` | Changed | Members | `ProblemsCallout` above `PageHeader` |
| `/p/[slug]/settings` | Changed | Every role | "Your notifications" card after `SettingsForm` |
| `/p/[slug]/activity`, `/activity` | Changed | Members | `await ensureProblemsViewMarked()` before listing (R8). No visible change. |
| Every page with `SignedInHeader` | Changed | Signed in | The bell between Invitations and the user menu. The user menu gains a "Notifications" link. |

## 2. Header bell: `src/components/notifications/NotificationBell.tsx` (server) and `NotificationBellClient.tsx` (client)

**Server part.**

1. `await ensureProblemsViewMarked()`.
2. `unreadSummary(await forMyProjects(session))`.
3. Render `NotificationBellClient` with `initial = { count, display, label }`.

If the summary fails, render the bell with no count and log the error. The header never fails a page.

**Rendered without JavaScript, and on first render:**

```html
<a href="/notifications" title="3 unread problems" class="…same as InvitationBadge link…">
  <svg aria-hidden="true">bell</svg>
  <span aria-hidden="true" class="badge">3</span>   <!-- omitted when count = 0 -->
  <span class="sr-only">3 unread problems</span>
</a>
<div role="status" aria-live="polite" class="sr-only"></div>   <!-- LiveRegion, kept mounted -->
```

- **Badge**: the `bg-cta` pill style used for Invitations, `tabular-nums`, and the text `display`. It is hidden at 0 (FR-010, N9).
- **Accessible name** (sr-only text, also the `title`): "No unread problems", "1 unread problem", "N unread problems", or "More than 99 unread problems".

**After mount (JavaScript)** the link becomes:

```html
<button type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="notifications-panel">…same children…</button>
```

**Behaviour after mount:**

- **Polling.** The R12 poller fetches `GET /api/me/notifications`:
  - every 60 s while visible;
  - once on becoming visible;
  - never while hidden;
  - at once on `docket:notifications-changed`.

  Each success updates the badge, the sr-only text and the `title`. When the new count is higher than the old, it sets the live region to the new label. It never announces otherwise. A failure keeps the last value silently.
- **Activation.** Click, Enter or Space toggles the panel (§3).

## 3. Panel: `NotificationPanel.tsx` (client), body `NotificationList.tsx` (shared, no server-only imports)

- **Container**: `<div id="notifications-panel" role="dialog" aria-modal="false" aria-labelledby="notifications-panel-title">`, right-aligned under the bell, `w-[min(28rem,calc(100vw-2rem))]`, `rounded-xl border bg-surface shadow-overlay`, `z-40`. It comes directly after the button in the DOM, so Tab order runs button → panel.
- **On open**:
  1. focus moves to the heading `<h2 id="notifications-panel-title" tabindex="-1">Recent problems</h2>`;
  2. the panel fetches `GET /api/me/notifications/recent`;
  3. while loading it shows "Loading recent problems…" (in the panel's own `role="status"` line).
- **Closing**:
  - Escape closes the panel and returns focus to the button;
  - a click outside, or focus leaving the panel and button, closes it without moving focus;
  - opening and closing marks nothing (FR-006, US2-AS8).
- **Body (`NotificationList`)**: a `<ul>` of up to 10 `<li>`, newest first. Each item contains:
  - **the main link**: the `link.href` and the message as its text, or plain text when `link` is null;
  - **"New"**: when `isNew`, `<Badge tone="brand">New</Badge>`, with text and colour (FR-011, US2-AS3);
  - **the project name**;
  - **platform marks**: `ProviderIcon` for each platform (decorative) followed by the platform names as text, joined with " and ";
  - **the account**: its name, or "Removed account"; plus "· Post deleted" when `postDeleted`;
  - **the outcome**: `Badge` with tone `OUTCOME_TONE[outcome]` and text `outcomeLabel`;
  - **when**: `RelativeTime` (§7).
- **Footer**, in this Tab order:
  1. "Mark all as read": a `<form action={markAllRead}>` with a secondary `sm` `Button`, pending label "Marking…". It is shown only when `unread.count > 0`.
  2. "View all problems" → `/activity?outcome=problems` (`prefetch={false}`).
  3. "Notification settings" → `/notifications`.
- **After "Mark all as read"**:
  - the panel clears every "New" and sets the bell to the returned count, which is 0 unless something arrived;
  - it dispatches `docket:notifications-changed`;
  - it does **not** navigate, so the person stays on their page (US2-AS5).

  If some projects were busy, the panel shows `Alert tone="warning"`: "Could not mark Acme as read. Try again."
- **Empty and error states** (FR-012):

  | Panel state | Text |
  |---|---|
  | `no_projects` | "You are not a member of any project yet." |
  | `all_muted` | "Notifications are off for all of your projects." plus the "Notification settings" link |
  | `ok` with no items | "No problems in your projects." |
  | The fetch failed | "Could not load recent problems." plus a "Try again" button; "Notification settings" still shown |

  "View all problems" and "Notification settings" are always present.

## 4. Notifications page: `/notifications`

```
SignedInHeader
<main id="main" class="mx-auto max-w-4xl px-4 py-8">
  PageHeader  title "Notifications"
              description "Problems from your projects, and which projects can notify you. Problems always stay in Activity."
  [Alert success: confirmation from ?marked=1 or ?changed={slug}]
  Card "Recent problems"        → NotificationList (server-rendered, same items as the panel)
                                   actions: [Mark all as read] (form with returnTo=/notifications) · View all problems
  Card "Projects"               → <table> caption "Notifications for each of your projects"
                                   columns: Project (th scope=row) | Notifications | (action)
                                   row: "Acme" | Badge On/Off | form(setNotifications){ hidden projectSlug, hidden on }
                                        <Button variant="secondary" size="sm">Turn off<span class="sr-only"> notifications for Acme</span></Button>
  Note (muted text, no card)    → "Docket only notifies you inside Docket. To get problems by email, chat or phone, send its webhooks to a tool such as n8n (see the docs)."
</main>
```

- **No projects**: `EmptyState` "You are not a member of any project yet." with the action "Back to Docket" (`/`) (US4-AS7). The Projects card is not rendered.
- **Confirmations**:
  - "Marked as read.", followed by " Could not mark Acme as read; try again." when some projects were busy;
  - "Notifications for Acme are off. Its problems still appear in Activity.";
  - "Notifications for Acme are on. Earlier problems are marked as read."

  An unknown `changed` slug shows no confirmation.
- **States**:
  - `loading.tsx`: skeletons of the two cards;
  - `error.tsx`: "Notifications could not be loaded." plus "Try again".
- **No JavaScript**: everything works. The forms post to server actions, which redirect back here.

## 5. Server actions

| Action | File | Input | Result |
|---|---|---|---|
| `markAllRead(prev, formData)` | `src/app/notifications/actions.ts` | optional `returnTo` | With `returnTo=/notifications`: `redirect("/notifications?marked=1[&busy=…]")`. Otherwise `ActionResult<{ count: number; busy: string[] }>`. |
| `setNotifications(prev, formData)` | same | `projectSlug`, `on` | `redirect("/notifications?changed={slug}")`. On `NotFoundError`: `fail("not_found", "That project could not be found.")`. |
| `setMyProjectNotifications(prev, formData)` | `src/app/p/[projectSlug]/settings/actions.ts` | `projectSlug` (the route's), `on` | `redirect("/p/{slug}/settings?notifications=on\|off")` |

- **No session**: redirect to `/login?next=…`.
- **Cross-site POST**: refused by the proxy with 403 before running (R13).
- **No user id**: no action takes one.

## 6. Callout: `src/components/notifications/ProblemsCallout.tsx` (server)

Props: `{ scope: ProjectScope }`. The component calls `projectUnread(scope)` and renders nothing at 0, which includes a muted project. Otherwise:

```html
<Alert tone="warning" role="status" class="mb-6">
  <p class="font-semibold">Problems since you last looked</p>
  <p>2 problems in Acme. <Link href="/p/acme/activity?outcome=problems" prefetch={false} class="underline">View problems</Link></p>
</Alert>
```

- **Count text**: "1 problem", "N problems", or "More than 99 problems".
- **Placement**: first child of the page's content on `/p/[slug]` and `/p/[slug]/posts` (N11).
- **Announcement**: polite (`role="status"`), never `alert` (FR-017).

## 7. New UI atom: `src/components/ui/RelativeTime.tsx`

```tsx
/** A relative time ("12 min ago") whose absolute time and zone are the tooltip and screen-reader text. Pure: `now` is a prop. */
export function RelativeTime({ value, timeZone, now }: { value: Date | string; timeZone: string; now: Date }): JSX.Element;
```

It renders `<time dateTime={iso} title="{formatLocal(value, zone)} ({zone})">{relativeTimeText(value, now)}<span class="sr-only">, {formatLocal(value, zone)} ({zone})</span></time>`. The wording comes from `src/lib/time/relative.ts`, the extracted `SchedulerHealth` `ago()`. It is listed in `docs/design-system.md` §7.

## 8. Settings card: "Your notifications"

On `/p/[slug]/settings`, after `SettingsForm`, visible to owner, admin and editor alike (US4-AS5):

- **Card**: title "Your notifications", description "Only you see this. Problems in this project always stay in Activity."
- **Contents**: "Notifications for this project are **on** / **off**." with the same On/Off `Badge`, and a form (`setMyProjectNotifications`) with the button "Turn off" or "Turn on" (sr-only " notifications for {project}").
- **Confirmation**: `?notifications=on|off` shows `Alert tone="success"` with the §4 wording.
- **Owner/admin form**: `SettingsForm`'s `canEdit` is unchanged.

## 9. User menu

`UserMenu` gains a link between "Activity" and "Sign out": `Notifications` → `/notifications`, icon `slidersHorizontal`, with a label that collapses to sr-only below `sm`, like its siblings.

## 10. Accessibility checklist (SC-007)

- **The bell** is a labelled link, and with JavaScript a labelled button with `aria-expanded` and `aria-controls`. Focus is visible (`focus-visible:ring-2 ring-focus`).
- **The panel** gets focus on open (its heading). Tab order is logical, Escape returns focus, and every status is text plus colour ("New", outcome labels, On/Off).
- **Live region**: the count is announced politely, and only when it rises.
- **Callout**: polite, with a text count and a text link.
- **Notifications page**:
  - a real `<table>` with `th scope`;
  - every control's accessible name contains the project name;
  - confirmations use `role="status"`;
  - it works without JavaScript.
- **Contrast** uses the existing tokens only. There are no `dark:` variants and no new colours.
