# Contract: routes, page structure, nav and loading

## Routes and files

| Path | Change |
|---|---|
| `src/app/p/[projectSlug]/page.tsx` | **Moved** to `(overview)/page.tsx` (research R2). The URL `/p/{slug}` doesn't change |
| `src/app/p/[projectSlug]/(overview)/page.tsx` | The overview: a server component that calls `getOverview` then `deriveOverview` and renders. `export const dynamic = "force-dynamic"` as on Accounts |
| `src/app/p/[projectSlug]/(overview)/loading.tsx` | The overview skeleton (FR-047) |
| `src/app/p/[projectSlug]/loading.tsx` | **Unchanged**. It's the generic state for Settings and Members (D8) |
| `src/app/p/[projectSlug]/accounts/page.tsx` | Adds only `id="account-{id}-slots"` and `scroll-mt-[calc(var(--sticky-top)+1rem)]` on the "Posting slots" heading (R5) |
| `src/components/overview/*.tsx` | Section components (server): `NeedsAttentionCard`, `ComingUpCard`, `AccountsCard`, `PostsByStatusCard`, `ContentToolsCard`, `OverviewSkeleton` |
| `src/components/ui/Checklist.tsx` | New (see `checklist-component.md`) |
| `src/components/shell/LeftNav.tsx` | Overview item and `isNavItemActive` (below) |
| `scripts/generate-icons.mjs` and `src/components/ui/icons.generated.ts` | New icons `overview` (Lucide `layout-dashboard`) and `circle` (Lucide `circle`), generated with `pnpm icons` |

## Metadata (FR-004, SC-008)

`generateMetadata({ params })` returns `{ title: scope.project.name }`, so the title reads "{name} · Docket" through the
root template. With no session or on `NotFoundError` it returns `{}`. It never falls back to the slug.

## Page order (top to bottom)

1. `ProblemsCallout` (unchanged, FR-005).
2. `PageHeader`: the title is the project name (the page's only `h1`) and the description comes from
   `OverviewView.description`. `actions` holds exactly one `Link` with `buttonStyles({ variant: "primary" })`, never
   `cta` (FR-003).
3. The Getting started `Checklist`, when `checklist !== null` (FR-015).
4. Needs attention `Card`, when it isn't null.
5. A two-column grid from `lg` (one column below), with the cards Coming up, Accounts, Posts by status and Content
   tools (when not null).

Every card uses `Card` with an `h2` title. Empty variants use `EmptyState` with `action` as a `Link` styled with
`buttonStyles(...)`, never an underlined text link (FR-045). The page contains no `"use client"` code of its own.

## Copy (exact strings)

**Header**
- Header description: "Times in {timezone}. You're an {Owner|Admin|Editor}."
- Primary action: "Connect an account" or "Write a post".

**Checklist**
- Card title: "Getting started". When collapsed, the summary is "Setup complete".
- Step titles: "Connect an account", "Add posting slots", "Write and schedule your first post", "Create a voice
  profile", "Upload images or videos", "Invite a teammate", and "Server setup" (the owner's row).
- Step 2 description: "Weekly times Docket uses when you Add to queue."
- Status text: "Done", "To do", "Waiting on {names}", plus the "Optional" label.
- Blocked text: "Needs an account first".
- Server-setup labels: "The scheduler isn't running", "AI generation isn't set up", "Media storage isn't set up" and
  "{Platform} isn't set up".

**Needs attention**
- Card title: "Needs attention".
- Items: "Awaiting review", "Needs your decision" and "Failed".
- Footer link: "See all activity".

**Coming up**
- Card title: "Coming up".
- Populated: the list, then "Open calendar".
- Empty with an account: "No scheduled posts yet. Write one and schedule it.", with the action "Write a post".
- Empty without an account: "No scheduled posts yet. Connect an account first."
  - Managers get the action "Connect an account".
  - Editors get no action, and the message adds " Ask {names, or} to connect one."

**Accounts**
- Card title: "Accounts".
- Empty, for managers: "You don't have any accounts yet.", with the action "Add an account".
- Empty, for editors: "No accounts yet. Ask {names, or} to connect one."

**Posts by status**
- Card title: "Posts by status".
- Labels: "Drafts", "Needs review", "Approved but not scheduled" and "Scheduled", linking to
  `/posts?status=draft|needs_review|approved|scheduled`.
- Empty: "No posts yet.", with the action "Write a post".

**Content tools**
- Card title: "Content tools".
- Voice:
  - With profiles: "{n} voice profile(s)", linking to `/voice`.
  - Without: "No voice profile yet. Generated posts need one."
    - Managers get the action "Create a voice profile" (`/voice/new`).
    - Editors get no action, and the message adds " Ask {names, or} to create one."
- Media:
  - With items: "{n} images and videos", linking to `/media`.
  - Without: "No images or videos yet.", with the action "Upload images or videos" (`/media`).

## Nav (FR-050 to FR-053)

```ts
export function isNavItemActive(pathname: string, href: string, exact: boolean): boolean;
// exact:  pathname === href || pathname === `${href}/`
// prefix: pathname === href || pathname.startsWith(`${href}/`)   (today's rule, unchanged)
```

- "Overview" is rendered before the `NAV_GROUPS` loop, in its own `<ul>`, with no group label. Its href is
  `/p/{slug}`, its icon is `overview`, and it's matched exactly. It has the same classes, indicator bar and
  `aria-current` handling as the other items, and is the first item in the phone strip.
- `NAV_SECTIONS` and `NAV_GROUPS` don't change, so the existing tests pass unchanged (SC-007).
- Tests check `aria-current="page"` on exactly one item for `/p/acme`, `/p/acme/`, `/p/acme/calendar` and
  `/p/acme/settings/members` (SC-006).
- `docs/design-system.md` §6 (diagram and sidebar text) and `.claude/skills/docket-ui/SKILL.md` (the App shell bullet)
  list Overview first.

## Loading (FR-047)

`(overview)/loading.tsx` renders `<div role="status" aria-busy="true">`. Inside it, a screen-reader-only
`<span class="sr-only">Loading overview</span>` gives assistive technology a status to read, followed by `Skeleton`
blocks in this order:

- a header (title bar, description bar, action pill);
- a checklist card with 3 rows;
- 4 section cards in the same grid as the page.

`Skeleton` already pulses only under `motion-safe`. There's no visible "Loading…" text. A test reads the file and
checks that Settings and Members still use `[projectSlug]/loading.tsx` and not the overview skeleton.
