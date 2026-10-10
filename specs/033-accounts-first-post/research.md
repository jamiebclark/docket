# Research: Accounts restructure and first-post flow

**Feature**: `033-accounts-first-post` | **Date**: 2026-10-09 | **Plan**: [plan.md](./plan.md)

Every decision below was checked against the code on this branch (`bc30999`). Paths are repo-relative; line numbers
are as of that commit. No fact here needs the web: the only external facts are Next.js behaviour (read from
`node_modules/next/dist/docs/`) and the `aria-keyshortcuts` attribute (read from the installed React types).

## Corrections to the spec's context

| Spec says | Code says | Effect |
|---|---|---|
| "No test asserts … the card's internal order" (Context, after the table) | `tests/integration/accounts-ui.test.ts:233` asserts `"Posting instructions</h4>"` and `:240` asserts that `Posting instructions</h4>` comes **before** `Posting slots (` | These two assertions change on purpose (FR-001, FR-004). SC-009 allows it. tasks.md must list them |
| `docs/accounts.md` isn't mentioned | `docs/accounts.md:66` says the posting-instructions field is "just above its posting slots" | Change it to "below its posting slots, in a collapsed section" |
| FR-027: the phase may not be able to write the docket-ui skill | The sandbox lists `.claude/skills` under write-denied paths. Entries 027–029 hit the same refusal (`docs/decisions.md:1294`, `:1321`, `:1352`) | Plan for the owed-edit route. Record the exact line in `docs/decisions.md` |

## R1 — Account card: sections and markup

**Decision**: Split each card (`src/app/p/[projectSlug]/accounts/page.tsx:143-253`) into four sibling blocks, in this
order:

1. **Status** (`<header>` plus the lines after it): `ProviderIcon`, name `<h3 id="account-{id}-name">`, platform name,
   status `Badge`, then connected time, last error, notes, mock controls (managers, mock only), reconnect controls
   (managers, `needs_reauth` only). These are today's lines 149-210, in today's order, except that connected time
   moves above last error to match FR-002's list. The reconnect controls stay inside the status block, so a
   reconnect-banner link (`#account-{id}`) lands with the badge and the control first (US1 scenario 4).
2. **Posting slots**: keep the existing `<h4 id="account-{id}-slots">Posting slots ({tz})</h4>` and its `scroll-mt`,
   then the table or "No posting slots yet.", then, for managers only, `<SlotEditor>` directly below.
3. **Posting instructions**: a native `<details>` that starts closed. Its `<summary>` reads
   `Posting instructions · Set` or `Posting instructions · None`, with the same focus-ring classes as the existing
   Reconnect disclosure (`page.tsx:195`). Inside: `PostingInstructionsForm` for managers; for editors, the read-only
   text or "No posting instructions."
4. **Remove** (managers only): `<div className="flex justify-end border-t border-border pt-4">` holding
   `RemoveAccountDialog`. It is the last child of the card. The divider moves here from the old combined
   editor-and-Remove block (`:246`).

The "Set"/"None" text comes from `account.postingInstructions !== null`, which is already normalised
(`AccountView.postingInstructions`, `src/server/services/accounts.ts:41-42`).

**Rationale**:

- The section order and role gating need no new data: everything is already in `withSlots`.
- A native `<details>` works without JavaScript. It is server-rendered, gets keyboard and screen-reader behaviour for
  free, and the page already uses it twice (`:194`, `:294`).
- React doesn't control `open` when no `open` prop is passed. So a failed save, which doesn't refresh (`mutate` only
  refreshes on success, `actions.ts:13-17`), leaves the section open with the form's existing error and focus
  handling (`PostingInstructionsForm.tsx:44-45`). That covers FR-005. A successful save also leaves it open, because
  `refresh()` re-renders without remounting. Only a full reload closes it, which the spec accepts.
- The summary text is the heading for the section. A heading inside `<summary>` is valid HTML, but some screen readers
  drop heading semantics inside the summary's button role. So the old `<h4>Posting instructions</h4>` becomes the
  summary text, and the form keeps its own label "Posting instructions for {name}".

**Alternatives considered**: keeping an `<h4>` above an always-open form (rejected: FR-004); a client-side toggle
(rejected: FR-025's spirit and more code); putting Remove in a menu (rejected: changes the confirmation flow, FR-006).

## R2 — How the page knows where to land

**Decision**: Carry the landing in the URL: `/p/{slug}/accounts?landed={accountId}&connected={n}&reconnected={m}`,
plus a hash, either `#account-{id}-slots` (a new account) or `#account-{id}` (reconnect or refresh only). One pure
module builds and parses it: `src/lib/accounts/connect-landing.ts` (contracts/modules.md §1).

- **Chooser**: `chooseConnectCandidatesAction` redirects to the landing URL instead of `/p/${slug}/accounts`
  (`actions.ts:128`).
- **In-page forms** (credentials connect and reconnect, mock connect, mock reconnect): the action returns the landing
  URL in its result, and the form calls `router.push(landing)`.

The Accounts page parses the query. It ignores it unless all of these hold: the viewer can manage accounts,
`landed` is a UUID that matches an account in the page's own list, and the counts are integers from 0 to 500 with
at least one count above 0. Otherwise the page renders exactly as today (FR-018).

**Rationale**:

- It works with JavaScript off. The browser jumps to the fragment, and the visible message is server-rendered (spec
  edge case "JavaScript is off").
- Next scrolls to the element whose id matches the hash on navigation
  (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:687-702`). The client component also
  scrolls explicitly, as a backstop (R5).
- No new storage. A flash cookie can't be cleared from a Server Component render, so it would replay on reload.
  `sessionStorage` would need JavaScript and a client-only message.
- The account name in the message comes from the page's own account list (the platform's display name), never from
  the URL. A forged link can therefore only produce a message from a fixed template, about a real account in a
  project the viewer manages, with a wrong count at worst. The URL carries no free text, so there is nothing to
  inject (constitution VII: nothing secret is involved either).

**Alternatives considered**:

- A sealed token like the connect banner's (`openBannerMessage`). Rejected: that seal exists because the banner
  carries platform text, and nothing here is platform text.
- Comma-separated id lists instead of counts. Rejected: up to 500 candidates (`MAX_CANDIDATES`) would make URLs of
  about 18 KB.
- Leaving the in-page forms as they are. Rejected: FR-014.

## R3 — New versus reconnected

**Decision**: In each connect action, read the ids of the project's active accounts (`accounts.listAccounts(scope)`)
**before** the save, inside the same `runAction` callback. After the save, an account whose id wasn't in that set is
**new**; every other saved account is **reconnected**, which includes "refreshed while already connected". The pure
`classifyConnect(saved, priorIds)` does the split (contracts/modules.md §1).

- Mock connect: always new (its external id is a fresh UUID, `accounts.ts:156`).
- Mock reconnect: always reconnected.
- Credentials with `accountId`: reconnected. Credentials without `accountId`: classified by the pre-read, because
  connecting a handle that is already connected updates it in place (`upsertConnected`, `src/server/dal/accounts.ts:157-184`).
- Chooser: classified by the pre-read.

A removed account that is connected again gets a **new** row: `upsertConnected` matches only rows where
`removedAt` is null (`dal/accounts.ts:166`). That matches the chooser, which shows it as `new`
(`connect.ts:186`).

**Rationale**: It needs no DAL, schema or service-signature change (FR-017). It adds one read, which every manager is
already allowed to do. The only race is a second owner connecting the same account between the read and the save,
and its only effect is the wording of the message and whether the slot editor or the name gets focus.

**Alternatives considered**: returning `created` from `upsertConnected` (rejected: it widens the DAL contract and
`AccountRecord` for a navigation concern); trusting the chooser's candidate `state` from the client (rejected:
client-supplied, and the credentials and mock forms have no such state).

## R4 — "First, in the order the chooser listed them"

**Decision**: Add a pure helper, `listedOrder(candidates)`, in `src/lib/accounts/chooser-order.ts`. It returns each
root in payload order with its children directly after it. `ChooserForm` uses it in place of its inline
`roots`/`childrenOf` grouping (`ChooserForm.tsx:69-71`). `chooseConnectCandidates` sorts `chosen` with it before
saving (`src/server/services/connect.ts:237-240`). The first **new** account in `saved` is then the first one the
chooser showed.

**Rationale**: Today's saved order is payload order. For Meta that already matches the screen, because each
Instagram child directly follows its Page (`src/providers/meta/candidates.ts:32-52`). A future provider might not
order them that way, and one shared helper keeps the screen and the landing in step. Changing the save order has no
data effect, since the saves are independent upserts in one transaction.

**Alternatives considered**: sorting in the action (rejected: `AccountView` doesn't carry the external id needed to
match candidates); documenting the assumption only (rejected: it would break silently).

## R5 — Focus, scroll and announcement after landing

**Decision**: A page-local client component, `src/app/p/[projectSlug]/accounts/ConnectLanding.tsx`. It isn't a
shared component (FR-061), and it sits inside the landed card. On mount it does four things, in order:

1. `document.getElementById(scrollId)?.scrollIntoView({ block: "start" })`. For a new account, `scrollId` is the
   slots heading `account-{id}-slots`; for a reconnect, the card `account-{id}`. Both already carry
   `scroll-mt-[calc(var(--sticky-top)+1rem)]`, so they stop below the sticky header (spec edge case).
2. It moves focus with `{ preventScroll: true }`:
   - new account → the checked weekday radio, `input[name="slot-day-{id}"]:checked`. That is the add-slot form's
     first control (`SlotEditor.tsx:31-37`), and the spec's assumption names the weekday choice;
   - reconnect → the name heading `account-{id}-name`, which the page renders with `tabIndex={-1}` **only** on the
     landed card.
3. It sets the message into a `LiveRegion` that was mounted empty. LiveRegion's own comment explains that a region
   added together with its text is often not announced (`src/components/ui/LiveRegion.tsx:1-4`).
4. It calls `window.history.replaceState(null, "", pathname + hash)` to drop the `landed`, `connected` and
   `reconnected` parameters. A reload or a later `refresh()` then doesn't replay the landing. Next integrates native
   `replaceState` with its router (`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md:343-347`).

The **visible** message is server-rendered by the page as `<p className={alertStyles("success")}>` inside the
landed section: directly under the Posting slots heading for a new account, or at the end of the status block for a
reconnect. It has no live role, so screen readers don't hear it twice on load. The `LiveRegion` copy is the
announcement (FR-013).

**Rationale**: Focus has to move, because after a reconnect the control that had focus (Reconnect) disappears with
the `needs_reauth` state. Scrolling the section, not the radio, keeps the heading and the message in view.

**Alternatives considered**:

- `autoFocus` on the radio. Rejected: React's `autoFocus` only applies on the client's first mount and doesn't
  scroll the heading into view.
- `Alert` with `role="status"`. Rejected: present at load, so not reliably announced, and it would double the
  announcement.
- The page-level `AnnounceProvider`. Rejected: it wraps the whole page as a client boundary, for one message.

## R6 — Message copy (FR-013)

`landingMessage({ connected, reconnected }, name)`, where `name` is the landed account's display name:

| connected | reconnected | Message |
|---|---|---|
| 1 | 0 | `Connected {name}. Add posting slots so Add to queue can schedule it.` |
| n > 1 | 0 | `Connected {n} accounts. Add posting slots for each.` |
| 0 | 1 | `Reconnected {name}.` |
| 0 | m > 1 | `Reconnected {m} accounts.` |
| 1 | m ≥ 1 | `Connected {name} and reconnected {m} {account\|accounts}. Add posting slots so Add to queue can schedule it.` |
| n > 1 | m ≥ 1 | `Connected {n} accounts and reconnected {m}. Add posting slots for each new account.` |

Numbers use `formatCount` style (plain integers here, since at most 500). Names are platform display names from the
DB (FR-013: never derived from an email).

## R7 — In-page forms: what the action returns

**Decision**: `connectMockAction`, `reconnectMockAction` and `connectCredentialsAction` return
`ActionResult<ConnectedAccount>`, where `ConnectedAccount = AccountView & { landing: string }`. On success:

- `ConnectCredentialsForm` clears its values as it does today, then calls `router.push(res.data.landing)`. It keeps
  its own `role="status"` text ("Connected {name}") for the moment before the navigation.
- `ConnectMockForm` clears its name, then calls `router.push(res.data.landing)`.
- `ReconnectMockButton` calls `router.push(res.data.landing)`.

**Rationale**: The authz test asserts `r.ok === true` for `connectCredentialsAction`
(`tests/integration/actions-authz.test.ts:368`), so redirecting from these actions would break it. A redirect would
also skip the form's success branch, which clears non-secret values. Returning the URL keeps today's result plus one
field, and the `AccountView` fields stay where callers read them (`res.data.displayName`). The actions still call
`refresh()`, so the new card appears even if the push is interrupted.

**Alternatives considered**: `redirect()` in each action (rejected above); computing the landing on the client
(rejected: the client can't tell new from refreshed, R3).

## R8 — Failed and cancelled connects (FR-015, FR-016)

No change. The callback route (`src/app/connect/callback/route.ts:21-27`) still redirects to the chooser on success
and to `/accounts?connect=…` on failure. That route is pinned by `tests/integration/connect/callback-hint.test.ts:54`.
Every failing result from the actions above returns as today, with no `landing`. The chooser's "Cancel" link still
goes to `/p/{slug}/accounts`.

## R9 — SetupNotice

**Decision**: Add `src/components/ui/SetupNotice.tsx`, a server-compatible component:

```ts
SetupNotice({ title, items, lead?, icon = "info", headingLevel = 2, id = "setup-notice" })
```

- **Frame**: EmptyState's dashed panel and decorative icon disc (`EmptyState.tsx:7-11`). The icon disc, the title
  `<h2 id="{id}-title">` (or `<h3>`) and the optional lead are centred. The list below them is left-aligned at
  `max-w-xl`, because a centred list of steps is hard to scan.
- **Root element**: `<section aria-labelledby="{id}-title">`.
- **Rows**: the same markup as Checklist rows. `Checklist.tsx` gains an exported `ChecklistRows({ items })` (today's
  `list` const, `:41-68`), and both components render it. Status stays in words through the same `statusText`. Each
  row still has at most one action, or a blocked reason.
- **Icon**: any existing `IconName` (decorative). The default is `info`. Generate passes `generate`, and the three
  job pages pass `jobs`: the same icons as their nav items (`src/components/shell/LeftNav.tsx:16`). No new icon is
  added.

**Gates**: the four pages swap `<Checklist title={PREREQUISITES_TITLE} items={…} />` for
`<SetupNotice title={PREREQUISITES_TITLE} items={…} />`: `generate/page.tsx:55`, `jobs/page.tsx:63`,
`jobs/new/page.tsx:75` and `jobs/new/csv/page.tsx:34`. `loadPrerequisites` and `generationPrerequisites` are
untouched, so titles, statuses, actions and owner-only content are byte-identical (FR-024). The four test files that
assert "Before you can generate" keep passing.

**Rationale**: FR-020 asks for an EmptyState variant. EmptyState itself takes one `message` sentence
(`EmptyState.tsx:5`); widening it into a list would change every caller's contract. Sharing `ChecklistRows` means the
prerequisite rows can't drift from the overview's. FR-061 counts shared components, and `ChecklistRows` is the
existing Checklist list exported, not a new primitive. The design doc records it under the Checklist row.

**Alternatives considered**: adding a `variant="notice"` to Checklist (rejected: C1 asks for an EmptyState variant,
and it would keep the progress-tracker card look); duplicating the row markup (rejected: drift).

## R10 — Calendar link after a first post

**Decision**:

- **One rule** (FR-031). Export `countsTowardFirstPost(counts)` from `src/lib/overview/derive.ts`. It is the existing
  expression at `:183`, `scheduled + publishing + published + partially_failed >= 1`, and `deriveChecklist` calls it
  in place of the inline sum.
- **One read**. `hasFirstPost(scope)` in `src/server/services/overview.ts` returns
  `countsTowardFirstPost(await scope.posts.counts())`. `scope.posts.counts()` already exists
  (`src/server/dal/posts.ts:63,155`) and is project-scoped. It requires `view`.
- **Passed down**. `compose/page.tsx` and `compose/[postId]/page.tsx` call it only when the viewer can schedule. They
  pass `firstPostDone: boolean` to `Composer`, which hands it to the three dialogs.
- **Captured at confirm**. Each dialog stores `const wasFirst = !firstPostDone` in state **when the user confirms,
  before the await**. The action's `refresh()` and the Composer's `router.refresh()` flip the prop to `true` as the
  result arrives, so reading the prop after the await would hide the link at once.
- **Shown when**: `wasFirst` and at least one row has `ok: true` (FR-030, FR-033).
- **Destination**, from the pure `firstPostCalendarHref({ slug, kind, rows, timeZone })` in
  `src/lib/compose/first-post.ts`:
  - `kind: "now"` → `/p/{slug}/calendar` (the calendar defaults to today's month, `calendar/page.tsx:40-47`);
  - otherwise → `/p/{slug}/calendar?view=month&date={YYYY-MM-DD}`, where the date is the project-zone calendar date
    of the earliest `scheduledAt` among the `ok` rows.
- **Markup**: `<Link href={…} className={buttonStyles({ variant: "primary" })}>See it on the calendar</Link>`, in the
  dialog footer before Close. The outcome list, the `aria-live` region and the Close button are unchanged (FR-035).

**Instant to date**: use `Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })`
with `formatToParts`. Going from an instant to a wall date is unambiguous, because DST disambiguation only arises in
the other direction. The client already formats project-zone instants with `Intl` (`formatLocal`,
`src/components/ui/LocalTime.tsx:2`). Pulling `@js-temporal/polyfill` into the client bundle for one date isn't
worth it. This is recorded in `docs/decisions.md` because the constitution says wall-time conversion goes "only via
Temporal". The spirit of that rule (no ambiguous wall→instant guesses) is kept.

**Rationale**: The action results stay byte-identical. Tests assert `data[0]` on all three
(`tests/integration/compose/actions.test.ts:78-115`), and FR-036 says no action's result changes. The read happens
on page load, which the Composer page already does.

**Accepted trade-off**: a Composer tab opened before someone else scheduled the project's first post still shows
the link once. That is the spec's "two members" edge case, widened to "an open tab". SC-004 holds for one person
working in one tab.

**Alternatives considered**:

- A `firstPost` flag on the action results. Rejected: it changes the result shape the tests pin.
- A read-only "is first" action called at confirm. Rejected: an extra round trip with the same staleness window,
  only smaller.
- A calendar `at=` parameter. Rejected: it changes the calendar page.

## R11 — Getting-started page and the checklist link

**Decision**:

- Write `docs/getting-started.md` (outline in contracts/ui.md §5).
- Add it to `mkdocs.yml` nav as the first item under "Using Docket": `- Getting started: getting-started.md`. Also add
  a line to `docs/index.md` under "Using Docket" and to the README's docs list, if it has one.
- Add `"getting-started"` to `DocPage` (`src/lib/docs.ts:6-17`).
- Give `Checklist` an optional `footer?: ReactNode`, rendered after the list **outside** the `<details>`, so it shows
  in both the full and the collapsed form (FR-046).
- The overview passes
  `footer={<a href={docsUrl("getting-started")} className="text-sm underline" target="_blank" rel="noreferrer">Read the getting-started guide</a>}`.
  That is the same element style as the server-setup doc links (`(overview)/page.tsx:52-55`).

**Strict build**: relative links only (`deployment.md`, `accounts.md`, …), and no anchors into other pages unless the
heading exists. `mkdocs` isn't installed in the sandbox (spec assumption), so the docs workflow on the PR runs the
strict build. Locally, `tests/integration/docs/published-docs.test.ts` checks that `docsUrl("getting-started")` names
a nav page.

**Rationale**: the guide link belongs to the card, so it disappears with the card (US5 scenario 4). A `footer` prop is
an additive change to an existing primitive, not a new component.

**Alternatives considered**: making the link an extra checklist step (rejected: it isn't a step, and it would change
the step counts); putting it in the PageHeader (rejected: it would stay after setup is done).

## R12 — Switcher accessible name (FR-050–052)

**Decision**: On the button in `src/components/shell/ProjectSwitcher.tsx:78-88`, add
`aria-keyshortcuts="Control+K Meta+K"`. On the `<kbd>`, add `aria-hidden="true"`. The chevron `Icon` already renders
`aria-hidden="true"` (`src/components/ui/Icon.tsx`). Nothing visual changes.

**Source**: the attribute is typed in the installed React types: `"aria-keyshortcuts"?: string`, "Indicates keyboard
shortcuts that an author has implemented…" (`@types/react@19.3.0/index.d.ts:2691-2692`). The value format
(space-separated alternatives, `Control`/`Meta` modifier names) is the one the spec gives in FR-051.

## R13 — Setup password hint (FR-053–055)

**Decision**: Keep `setup-form.tsx`'s wrapping-`<label>` pattern, but change three things:

- the hint renders `<span id="{name}-hint">` and **always** shows;
- `aria-describedby` becomes the hint id plus the error id when an error exists;
- the `field` closure becomes an exported `SetupField({ name, label, type, autoComplete, hint, error })` component,
  so a test can render the error state without driving `useActionState`.

The labels, `name`s, `autoComplete` values, `required`, the error ids (`{name}-error`) and the submit behaviour stay
as they are.

**Rationale**: Switching to `Field` would change the label structure (`htmlFor` and new ids) and add an always-present
`aria-live` error paragraph. FR-055 allows it but doesn't need it, and the in-place fix is smaller.

**Alternatives considered**: using `Field` (acceptable, but a larger diff).

## R14 — Roadmap rules and scope

- **Role-aware**: landing only for managers. The calendar link goes to owners, admins and editors (all can
  schedule). SetupNotice content is unchanged from entry 2. The guide has no commands or environment variable names.
- **Display names only**: account names come from the platforms. No member names are added.
- **Existing primitives**: `Alert` styles, `Badge`, `ProviderIcon`, `LiveRegion`, `buttonStyles`, `Checklist` and
  `EmptyState`'s frame. SetupNotice is the only new shared component.
- **Activity, notifications, video**: no new screens. Existing `#account-{id}` links from the reconnect banner and the
  overview now land on status-first cards. The guide names Activity and the bell, and covers video in its media step.
  The calendar link applies to video posts like any other.
- **Not included** (FR-062): dismissible checklist (C2), deep links from activity entries, focus moves for other slot
  links, a calendar link outside the Composer, and any change to connect data, permissions, activity, notifications
  or callback targets. No later roadmap entry owns them. Record this in `docs/decisions.md`.
- **No changes** to schema, migrations, env vars, dependencies, the public API, webhooks or `docker-compose.yml`. No
  compose-file notice is owed to the operator.
