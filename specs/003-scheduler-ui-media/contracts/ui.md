# Contract: Screens, server actions and the compose-check route

FR-018–FR-039; follows the `docket-ui` skill.

- **Data and errors.** Every page is a server component that resolves `forProject(session, slug)` and reads through services only. On `NotFoundError` it calls `notFound()`.
- **Client components** are leaf-level islands, used only for interactivity.
- **Server actions** return `ActionResult<T>` (`src/lib/action-result.ts`): `ZodError` becomes `validation` with `fieldErrors`, and anything else goes through `failFromError`.
- **Refresh.** Each action calls `refresh()` (or `revalidatePath` for the section) on success, so the page re-renders in the same response (research F7).

## Routes

The new pages replace the placeholders. `calendar`, `posts`, `compose`, `media` and `accounts` are removed from `[section]/page.tsx`'s `PLACEHOLDERS`.

| Route | Page title | Search params (shareable) | Server data | Client islands |
|---|---|---|---|---|
| `/p/[projectSlug]/calendar` | "Calendar" | `view=month\|week`, `date=YYYY-MM-DD`, `account=<uuid>` | `getCalendar`, `listAccounts` | `CalendarBoard` (drag and drop, action menu, move/swap/pull dialogs, `aria-live` announcer) |
| `/p/[projectSlug]/posts` | "Posts" | `status=<post_status>\|needs_decision`, `page=n` | `listPosts` | none (filters and pager are links) |
| `/p/[projectSlug]/posts/[postId]` | "Post" | — | `getPostView` | `TargetActions` (retry, cancel, resolve, delete dialogs) |
| `/p/[projectSlug]/compose` | "Compose" | — | `listAccounts`, `mediaStatus`, provider capabilities via `listConnectableProviders` (names only), project zone | `Composer` |
| `/p/[projectSlug]/compose/[postId]` | "Edit post" | — | `getPostView` as initial state; `editable` / `reviewBlocked` flags | `Composer` |
| `/p/[projectSlug]/media` | "Media" | `tag`, `unused=1`, `missingAlt=1`, `q`, `page` | `mediaStatus`, `listMedia` | `UploadDropzone`, `MediaEditDialog`, `DeleteMediaDialog` |
| `/p/[projectSlug]/accounts` | "Accounts" | — | `listAccounts`, `listSlots` per account, `listConnectableProviders`, `scope.can({account:["manage"]})` | `ConnectMockForm`, `SlotEditor`, `RemoveAccountDialog` |

Each route has a `loading.tsx` skeleton matching its layout. The project-level `error.tsx` already exists, and a route-level one is added only where the message differs.

### Shell changes

- `src/app/p/[projectSlug]/layout.tsx` renders `<ReauthBanner accounts canManage slug />` under the scheduler banner. It is a server component with `role="alert"` and is not rendered when the list is empty (FR-036, SC-008).
- `LeftNav` is unchanged; the sections already exist.

## Compose-check route handler

`src/app/p/[projectSlug]/compose/check/route.ts` handles `POST` only.

- **Request**: a JSON body matching `checkComposition`'s input.
- **Responses**:
  - `200 { ok: true, data: CheckResult }`;
  - `400 { ok: false, error: "validation", fieldErrors }`;
  - `404 { ok: false, error: "not_found" }` for no session, a non-member, or an unknown id (never reveals which);
  - `415` when the content type is not JSON.
- **Headers**: `Cache-Control: no-store`.
- It never echoes request headers. It returns no secrets: account rows go through `AccountView`.
- **Tests** (`tests/integration/compose-check-route.test.ts`): call `POST` directly with a mocked session. They cover member vs non-member, counts for each counting rule (emoji ZWJ sequence, combining marks, multi-byte), and equality with what `addToQueue` reports for the same content (SC-002).

## Server actions (one `actions.ts` per route folder)

All actions take `(slug: string, input: unknown)`, or `(prev, formData)` for progressive `<form>`s.

| Action | Service call(s) | Permission |
|---|---|---|
| **media/actions.ts** | | |
| `uploadMediaAction(slug, formData{file})` | `uploadMedia` | media:edit |
| `updateMediaAction(slug, {id, altText?, tags?})` | `updateMedia` | media:edit |
| `deleteMediaAction(slug, {id})` | `deleteMedia` | media:edit |
| `deleteMediaImpactAction(slug, {id})` | `deleteMediaImpact` (read; used by the dialog) | media:view |
| **compose/actions.ts** | | |
| `saveDraftAction(slug, {postId?, baseText, mediaIds, targets})` | `createDraft` \| `updatePost` → `{ postId }` | post:edit |
| `previewQueueAction(slug, {postId})` | `previewQueue` | post:view |
| `addToQueueAction(slug, {postId, targetIds?, expected})` | `addToQueue` | post:schedule |
| `previewExplicitTimeAction(slug, {postId, local})` | `previewExplicitTime` | post:view |
| `scheduleAtAction(slug, {postId, at, targetIds?})` | `scheduleAt` | post:schedule |
| `publishNowAction(slug, {postId, targetIds?})` | `publishNow` | post:schedule |
| `uploadMediaAction` (re-exported from media) | `uploadMedia` | media:edit |
| **posts/actions.ts** | | |
| `retryTargetAction(slug, {targetId})` | `retryTarget` | post:schedule |
| `cancelTargetAction(slug, {targetId})` | `cancelTarget` | post:schedule |
| `resolveTargetAction(slug, {targetId, outcome, url?})` | `resolveAmbiguous` | post:schedule |
| `deletePostAction(slug, {postId})` | `deletePost` → redirect to `/posts` | post:delete |
| **calendar/actions.ts** | | |
| `moveToOccurrenceAction(slug, {targetId, slotId, scheduledAt})` | `moveTargetToOccurrence` | post:schedule |
| `moveToNextFreeAction(slug, {targetId})` | `moveToNextFreeSlot` | post:schedule |
| `swapTargetsAction(slug, {targetIdA, targetIdB})` | `swapQueuedTargets` | post:schedule |
| `listQueuedForAccountAction(slug, {accountId})` | `listQueuedForAccount` | post:view |
| `listEmptySlotsAction(slug, {accountId, from, to})` | `listEmptySlots` | slot:view |
| `previewPullForwardAction(slug, {accountId})` | `previewPullQueueForward` | post:schedule |
| `pullForwardAction(slug, {accountId, expected})` | `pullQueueForward` | post:schedule |
| **accounts/actions.ts** | | |
| `connectMockAction(prev, formData{displayName, behaviour})` | `connectMock` | account:manage |
| `reconnectMockAction(slug, {accountId})` | `reconnectMock` | account:manage |
| `setMockBehaviourAction(slug, {accountId, behaviour})` | `updateAccountSettings` | account:manage |
| `removeAccountAction(slug, {accountId})` | `removeAccount` | account:manage |
| `accountRemovalImpactAction(slug, {accountId})` | `accountRemovalImpact` | account:view |
| `addSlotAction(prev, formData{accountId, weekday, localTime})` | `addSlot` | slot:manage |
| `setSlotPausedAction(slug, {slotId, paused})` | `setSlotPaused` | slot:manage |
| `deleteSlotAction(slug, {slotId})` | `deleteSlot` | slot:manage |

**Authorization test** (`tests/integration/actions-authz.test.ts`, research D19) is one table of every action above. For each action × {owner, admin, editor, non-member} it asserts:

- `ok` or a domain failure for allowed roles;
- `forbidden` for an editor on account and slot actions;
- `not_found` for a non-member.

It also asserts that no action result or thrown message contains an account token or a storage secret (SC-011).

## Component behaviour rules (from the spec + docket-ui)

### Composer

- **Fieldsets**:
  1. "Accounts": a checkbox group showing platform and status. Accounts that are `needs_reauth` or have an unavailable provider are disabled, with the reason shown.
  2. "Text": a `<textarea>` labelled "Post text".
  3. "Media": `MediaPicker`.
  4. "Per-account text": one disclosure per selected target with an override `<textarea>`. An empty override means none, so the "Use base text" button clears it.
  5. "Preview": one card per target.
- **Per-target status** comes **only** from the compose-check response:
  - the `used / limit` counter, with an error state when `count > limit`;
  - issues grouped by severity (error, warning, info), with `aria-live="polite"`.
- **Actions**:
  - the action bar holds "Save draft", "Add to queue…", "Schedule…" and "Publish now…";
  - scheduling actions are disabled, with the reason, when no target has `canSchedule`, when `reviewBlocked`, or when `!editable`;
  - every confirmation is a `Dialog` (existing component) that names the accounts and lists per-target times or failures, with the zone name;
  - after "Add to queue", the dialog shows the assigned times and highlights `changedFromPreview` with the text "Changed: another post took the previewed slot".
- **"Schedule…"** shows date (`type=date`) and time (`type=time`) inputs labelled with the zone. Preview text appears for `gap` ("09:30 does not exist on that day; it will post at 10:30") and `overlap`. Near-queued warnings are shown but do not block. A past time disables confirm and offers "Publish now".
- **No accounts**: an empty state that links to Accounts for admins and owners, or tells editors to ask an owner or admin (US1-AS8).

### MediaPicker

- A dialog over `listMedia` with search, tag and unused filters (the filters are client state only inside the picker, because it is a modal, not a page).
- It also offers inline upload, reordering (up/down buttons, so it is keyboard-operable; drag is optional), removal and an inline alt-text editor.
- When storage is disabled, it shows the "Media storage is not set up" state (FR-011).

### Media library

- **Upload**:
  - the dropzone also has a visible "Choose files" button;
  - files upload one at a time;
  - each file gets a row reading "uploading / accepted / rejected: <reason>", announced through a live region.
- **Grid of cards**: each card is an `<article>` with the thumbnail `<img alt={altText || ""}>`, dimensions, size, type, tags, an "In use" or "Unused" badge, and a "Missing alt text" badge (text plus colour).
- **Filters** are links that change search params. Pagination is links.
- **Delete** first loads the impact:
  - if blocked: a dialog explaining why, with links to the posts;
  - else: a confirmation naming the image and the affected posts.

### Calendar

- **Toolbar**:
  - a heading with the period and the zone name ("October 2026 · Europe/London");
  - links for Previous, Today and Next, and for Month and Week;
  - an account filter (`<form method="get">` with a `Select`).
- **Month view**: a `<table>` with 7 `<th scope="col">` weekday headers and one `<td>` per day. **Week view**: 7 columns with per-hour groups.
- **Post chip**: a `<button>` with the time, account and status (badge). It is `draggable` when `movable`. Activating it opens an action menu (`role="menu"`) with:
  - Open post;
  - Move to slot…;
  - Move to next free slot;
  - Swap with…;
  - Cancel.
- **Empty-slot placeholder**: a dashed-border `<button>` reading "Empty slot · <account> · 09:00".
  - It is a drop target, accepting only chips of the same account. Other accounts get the visual "not allowed" state and an announced refusal.
  - Activating it while a post is "picked up" (keyboard mode: the "Move to slot…" dialog) moves the post there.
- **Per-account "Pull queue forward…"** is in the account filter area. It opens a confirmation listing the moves from `previewPullForwardAction`.
- **After any move**: focus returns to the moved chip (by `data-target-id` after refresh), and the live region announces "Moved to Tue 6 Oct 09:00 Europe/London".
- **Stale action** ("That slot was just taken.", or a published or deleted post): the message is shown and the page is refreshed (`router.refresh()`).
- **Empty range**: an `EmptyState` saying "No posts or posting slots in this period. Posting slots are set per account." with a link to Accounts (US5-AS10).

### Posts

- The list is a `<table>` with columns Post, Status, Accounts and When.
- Status filter tabs are links, with counts from `counts`. "Needs your decision" is amber.
- The detail page has one `<section>` per target, holding:
  - a `<dl>` of account, status, scheduled time with zone and kind, external link and last error;
  - an attempt log `<table>` with columns Time, Step, Outcome, Request and Response. The summaries are rendered as `<code>` key/value pairs, already redacted.
- **Ambiguous targets** have an amber panel reading "Needs your decision" with the explanation, plus:
  - "Mark as published" (with an optional URL field);
  - "Mark as not published".

### Accounts

- Each account is a `<section id="account-<id>">` with its name, platform, a status badge, the last error, its connected date and the slot table (Weekday, Time (zone), State, Actions).
- **Admins and owners also get**:
  - an add-slot form (a weekday `Select` and a `type=time` field);
  - pause/resume and delete buttons;
  - a "Connect a mock account" form with a display name and a behaviour `Select` of `mockBehaviours`, shown only when the mock provider is enabled;
  - Reconnect (for mock accounts that need it);
  - Change behaviour;
  - Remove (a dialog with the `accountRemovalImpact` count).
- **Editors** get the same content with no mutation controls.
