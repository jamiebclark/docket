# Contract: routes, states and exact copy

The strings here are the target copy (spec Assumptions). In them:

- `{M}` is `askManagers(managers, "or")`;
- `{M&}` is `askManagers(managers, "and")`;
- `{O}` is `askOwners(managers, "or")`;
- `{O&}` is `askOwners(managers, "and")`.

"Button" means a `Link`, or an `<a>` for external docs, styled with `buttonStyles({ variant })`. Its focus ring comes
from `buttonStyles` (FR-071). The variant rule is research D19: `primary` when it's the page's only next step,
otherwise `secondary`.

No editor-facing state contains an environment variable name, a command, an `/api/` path, a redirect address, a
member email, or a link to connect, reconnect, manage slots, create a voice profile or set up the server (FR-072,
SC-002).

Headings stay as they are: PageHeader adoption belongs to entry 3. Routes are under `src/app/p/[projectSlug]/`.

---

## Accounts: `accounts/page.tsx`

| State | Who | Output |
|---|---|---|
| No accounts | `canManageAccounts` | EmptyState "You don't have any accounts yet. Connect one below to start scheduling posts." No action (the section is directly below, and the header has "Add an account") |
| No accounts | others | EmptyState "No accounts yet. Ask {M} to connect one." No action |
| Add an account section | `canManageAccounts` only | `id="add-account"`. Order: configured groups, mock form, credential forms, then the owner disclosure |
| Owner disclosure | owner, and at least one unconfigured group | `<details>` (closed) `<summary>Not set up on this server ({n})</summary>`, holding each unconfigured group's `ConnectGroupSection` (setup guide and redirect address), stacked in one column |
| Admin with nothing connectable | admin, with no configured group, no mock and no credential provider | inside the section: `<p>` "No platforms are set up on this server yet. Ask {O} to set one up." |
| Section | editors | not rendered: no connect button, token field, setup-guide link or redirect address anywhere |

The `summary` gets `cursor-pointer rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2
focus-visible:ring-focus`, the same classes as `Checklist`'s summary. The account cards and the header action are
unchanged (FR-006).

## Calendar: `calendar/page.tsx`

`calendarState(...)` (data-model.md §5) picks one row. The h1 (title and time zone) is always shown.

| Kind | Toolbar | Grid | Who | Copy | Action |
|---|---|---|---|---|---|
| `no_accounts` | hidden | hidden | `canManageAccounts` | "No accounts yet. Connect an account to see posts and open posting slots here." | primary "Connect an account" to `/accounts#add-account` |
| `no_accounts` | hidden | hidden | others | "No accounts yet. Ask {M} to connect one." | none |
| `no_slots` | shown | replaced by EmptyState | `canManageSlots` | "Add posting slots to see open times here." | primary "Add posting slots" to `/accounts#account-{id}-slots` |
| `no_slots` | shown | replaced | others | "No posting slots yet. Ask {M} to add some." | none |
| `no_slots_line` | shown | shown | `canManageSlots` | one `<p>` above the grid: "Add posting slots to see open times here." | secondary `sm` "Add posting slots" beside it |
| `no_slots_line` | shown | shown | others | one `<p>`: "No posting slots yet. Ask {M} to add some." | none |
| `empty_period` | shown | replaced | everyone | "No posts or open posting slots in this period." | secondary "Today" to the page's `href({ date: today })` |
| `content` | shown | shown | everyone | none | none |

There's no link to Accounts in `empty_period` or `content` (FR-013).

## Compose: `compose/Composer.tsx` (both `compose` and `compose/[postId]`)

See contracts/components.md `Composer` for the action-bar table.

| State | Who | Copy | Action |
|---|---|---|---|
| No accounts | `canManageAccounts` | "No accounts are connected yet. Connect an account to start composing posts." | primary "Connect an account" to `/accounts` |
| No accounts | others | "No accounts are connected yet. Ask {M} to connect one." | none |
| Hint `all` | `canManageSlots` | "Add to queue needs posting slots." followed by the inline link "Add slots in Accounts" | to `/accounts#account-{id}-slots` |
| Hint `all` | others | "Add to queue needs posting slots. Ask {M} to add some." | none |
| Hint `some` | everyone | "{names} has no posting slots, so Add to queue can't place it." or "{names} have no posting slots, so Add to queue can't place them." | none |

## Posts: `posts/page.tsx`

`total` is the "All" tab count (`list.counts` without `needs_decision`).

| State | Tabs | Copy | Action |
|---|---|---|---|
| `total === 0`, no `status` | hidden | "No posts yet. Write your first post to see it here." | `canWritePosts`: secondary "Write a post" to `/compose` (the header has the primary "New post") |
| `status` set, no items | shown | "No posts match this filter." | secondary "Show all posts" to `/posts` |
| List failed | shown, without counts (as today) | the existing error alert | none |

`ProblemsCallout` and the "New post" header action are unchanged.

## Failures: `failures/page.tsx`

`noPosts` is `countPosts(scope) === 0`, read only when the list is empty and unfiltered (research D4).

| State | Counts line, tabs, account filter, Retry all | Copy | Action |
|---|---|---|---|
| empty, unfiltered, `noPosts` | hidden | "Posts that fail to publish will show up here." | `canWritePosts`: primary "Write a post" to `/compose` |
| empty, unfiltered, posts exist | shown | "Nothing needs attention. Every post that was due went out or is still scheduled." | secondary "View posts" to `/posts` |
| empty, filtered (`status`, `account` or `target`) | shown | "No posts match this filter." | secondary "Clear filters" to `/failures` |

## Review: `review/page.tsx`

| State | Copy | Action |
|---|---|---|
| Queue empty | "Generated posts wait here for approval before they're scheduled. Posts you write yourself don't come here." | `canRunGeneration`: primary "Generate a post" to `/generate`. Otherwise none |

## Generate: `generate/page.tsx`

- The h1 and mode tabs are always shown.
- When `generationPrerequisites(...)` isn't `null`, it renders
  `<Checklist title="Before you can generate" items=… />` in place of `GenerateForm` and Recent failures.
- Otherwise the page is unchanged.

Expected lists for the spec's fixture (owner "Robin", admin "Sam"; nothing set up):

| Viewer | AI item | Account item | Voice item |
|---|---|---|---|
| owner | To do. "Set LLM_PROVIDER, LLM_MODEL, OPENAI_API_KEY on the server, then reload this page." with "Open the setup guide" | To do, with "Connect an account" | To do, with "Create a voice profile" |
| admin | Waiting on Robin. "The server needs an AI provider before posts can be generated." | To do, with "Connect an account" | To do, with "Create a voice profile" |
| editor | Waiting on Robin | Waiting on Robin and Sam | Waiting on Robin and Sam |

The setting names shown are whatever `missingLlmSettings` returns for the test environment. Tests assert on that
function's output, not on a fixed list.

## New job from media: `jobs/new/page.tsx`

The page still returns `notFound()` without `generation: ["run"]`. It then works out readiness, and the preview,
which needs no LLM. The `images` item (data-model.md §4) is added when the preview throws or `itemCount === 0`.

When the list isn't `null`, it renders the h1 and the Checklist in place of the form. Otherwise the page is
unchanged. The "Back to Media" text link and the per-gate EmptyStates are removed: the `images` item's action
replaces them.

## New job from CSV: `jobs/new/csv/page.tsx`

The same list, without the `images` item. When it isn't `null`, it renders in place of `CsvJobForm`.

## Jobs: `jobs/page.tsx`

| State | Header actions | Above the table | Empty state |
|---|---|---|---|
| ready, `canRunGeneration` | primary "New job from CSV" (`/jobs/new/csv`), plus secondary "Choose images in Media" (`/media`) when storage is configured | none | "No generation jobs yet. Start one from a CSV file, or choose images in Media." (without storage: "No generation jobs yet. Start one from a CSV file."). No actions |
| not ready | hidden | the Checklist (the bespoke `rounded-md` box is removed) | not shown when there are no jobs (research D15) |
| any, `!canRunGeneration` | hidden | none | the same copy, no actions |

Existing jobs stay listed below the Checklist (FR-046).

## Media: `media/page.tsx`

| State | Shown | Copy | Action |
|---|---|---|---|
| Storage off | EmptyState only | owner: "Media storage is not set up, so images and videos can't be uploaded yet." Others: the same, then " Ask {O} to set it up." | owner: primary "Set up storage" (`<a href={docsUrl("storage")} target="_blank" rel="noreferrer">`). Others: none |
| Library empty (`list.total === 0`), unfiltered | the dropzone (`canEditMedia`), then EmptyState. No search, tabs, generate link or note | `canEditMedia`: "No images or videos yet. Upload your first one above." Others: "No images or videos yet." | none |
| Filtered, no matches | every control | "No images or videos match these filters." | none |
| Has items, nothing unused, `canRunGeneration` | every control | `<p className={alertStyles("info") + " self-start"}>No unused images to generate for</p>` in place of the pill | none |

## Voice: `voice/page.tsx`

`anyProfile` is `profiles.length > 0`. When the active list is empty and the archived tab isn't open, it's
`(await listVoiceProfiles(scope, { includeArchived: true })).length > 0` instead.

| State | Tabs | Copy | Action |
|---|---|---|---|
| `!anyProfile` | hidden | managers: "No voice profile yet. Create one so generated posts sound like you." Others: "No voice profile yet. Ask {M} to create one." | managers: secondary "Create a voice profile" to `/voice/new` (the header has the primary "New voice profile") |
| Only archived, Active tab | shown | the same copy | the same |

## Project layout banners: `layout.tsx`

See contracts/components.md. Nothing is stored. When the scheduler recovers, the banner disappears for everyone.

## Narrow screens (SC-008)

At 390 px, no touched page scrolls sideways.

- The disclosure and the Checklist stack in one column. `Checklist` already wraps (`basis-56`).
- The Calendar's `no_slots_line` wraps its text and button (`flex flex-wrap gap-2`).
- The ActionBar already wraps.

## Docs (FR-090)

- **`docs/design-system.md` §8 States**, add three bullets:
  - empty-state actions are always `buttonStyles` (primary when they're the only next step), never underlined text;
  - an unfiltered empty list hides its filter, search and bulk controls, while a filtered one keeps them so the
    filter can be cleared;
  - "ask" copy names people by display name ("Ask Robin or Sam to …"), owners only for server pieces, never by
    email.
- **`docs/design-system.md` §7**, in the `Checklist` row: "also used for prerequisite lists (Generate, Jobs)".
- **`.claude/skills/docket-ui/SKILL.md` "States"**, one line: "Empty-state actions use `buttonStyles`; unfiltered
  empty lists hide their filters; prerequisite lists use `Checklist`; 'ask' copy names owners/admins by display name."
- **`docs/decisions.md`**: "## 028 — Empty states and role awareness (2026-10-09)", with D1–D20 from research.md.
