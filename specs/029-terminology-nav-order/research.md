# Research: Terminology, page descriptions and nav order

**Feature**: `029-terminology-nav-order` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

The Technical Context had no `NEEDS CLARIFICATION` items. This entry changes copy, order and the use of existing
primitives, so the research is a code survey: every file and line below was read in the current tree on 2026-10-09.
The one framework fact used (route `metadata.title` with the root `title.template`) is already in use on every page
and is documented in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md:205-251`.
No platform API, dependency or environment variable is involved.

---

## R1 — Nav order, groups and labels

**Decision**: Reorder the `NAV_SECTIONS` array in `src/components/shell/LeftNav.tsx:10-23` and change three fields.
`NAV_GROUPS` (`:8`) stays `["Publish", "Create", "Project"]`. The Overview link (`:93-97`) stays where it is, rendered
first, ungrouped, with `isNavItemActive(…, true)`.

| # | slug | label | group | icon |
|---|---|---|---|---|
| 1 | compose | Compose | Publish | compose |
| 2 | calendar | Calendar | Publish | calendar |
| 3 | posts | Posts | Publish | posts |
| 4 | review | Review | Publish | review |
| 5 | failures | Failures | Publish | failures |
| 6 | generate | Generate | Create | generate |
| 7 | voice | **Brand voice** | Create | voice |
| 8 | media | Media | Create | media |
| 9 | jobs | **Batch jobs** | Create | jobs |
| 10 | accounts | Accounts | Project | accounts |
| 11 | settings | Settings | Project | settings |
| 12 | activity | Activity | **Project** | activity |

With Overview that is 13 links (SC-002). Slugs, and so URLs, are unchanged (FR-004). The phone strip renders from
the same loop (`:98-112`), so its order matches desktop by construction (FR-001, US1 scenario 5).

**Rationale**: The render walks `NAV_GROUPS`, then filters `NAV_SECTIONS` by group, keeping array order within a
group. So array order inside each group is the only thing to change, plus Activity's `group`. Nothing reads
`NAV_SECTIONS` except `LeftNav` and `tests/integration/failures/nav.test.ts` (grep, 2026-10-09). The command palette
and the project switcher don't list nav items.

**Alternatives considered**: a separate `ORDER` array or per-item `order` field. Rejected: two sources for one list.
Hiding items by project state or LLM config. Rejected: FR-003 and "Not included".

## R2 — The nav-order test that pins Activity

**Decision**: In `tests/integration/failures/nav.test.ts:27`, replace
`expect(slugs.indexOf("activity")).toBe(slugs.indexOf("failures") + 1)` with an assertion of Activity's new place:
it is the last item, and its group is `"Project"`. Lines 26 and 28-31 (Review directly above Failures,
"Failures (2)", ">Failures<", no "Failures (") stay unchanged (FR-005). The full order, groups and labels go in a new
test (R19), so this file keeps its narrow purpose.

**Rationale**: FR-005 requires exactly this. `review.test.tsx:142-146` (">Review (3)<", plain "Review" at 0) and
`tests/integration/overview/nav.test.tsx` (Overview first, exact-match active) are untouched and must still pass.

## R3 — Page headers: which pages, and what moves

**Decision**: Each page in FR-012 that has a bare `<h1>` switches to `PageHeader` (`src/components/ui/PageHeader.tsx`).
The page's existing actions go into `actions`. Content that sat beside the heading stays on the page (FR-015). The
per-page mapping, with file and line, is in [contracts/ui.md](./contracts/ui.md) §2. In summary:

- **Plain swaps** (heading → `PageHeader title description`): Review, Media, Series, New voice profile, Voice
  profile history, Project settings, Members & invitations, Webhook, Invitations.
- **Heading row with an action** → `actions`: Posts ("New post"), Brand voice ("New voice profile"), Batch jobs
  (the CSV and Media links), Post detail (Edit, Delete).
- **Content below the header**: Failures (totals line), Generate (mode tabs), Series (brief), API keys (the rest of
  the paragraph, then the two links), Webhooks (the signatures link), Voice profile history (the back link),
  Connect (the expiry sentence, notices, missing list).
- **Back links above the header**: Post detail ("Posts"), Webhook ("All webhooks"). They stay where they are, above
  the title, as now.
- **Badges beside the title**: Post detail, Generated post and Batch job (R4).
- **Compose with no accounts** (`compose/Composer.tsx:248`) uses the same `PageHeader` call as the main form
  (`:330-333`): title "Compose", the same description. The editing route can't reach the empty state with
  `initial` set, but the title expression is shared, so it stays `initial ? "Edit post" : "Compose"`.

Pages that already use `PageHeader` (Overview, Compose, Accounts, Activity, `/activity`, `/notifications`) keep their
title and description (FR-011).

**Rationale**: `PageHeader` already renders the single `<h1>` and the one-line muted description. It's the documented
page anatomy (`docs/design-system.md` §6 "Page anatomy" item 1). Using it everywhere is what FR-010 asks for.

**Alternatives considered**: a description `<p>` under each bare `<h1>`. Rejected: two header patterns, which FR-080
then has to document.

## R4 — Badges beside the title: a small `aside` prop on `PageHeader`

**Decision**: Add one optional prop, `aside?: ReactNode`, to `PageHeader`. It renders right after the `<h1>`, on the
same line, outside the heading (`<div className="flex flex-wrap items-center gap-3"><h1 …/>{aside}</div>`). When it
is absent the markup is exactly as today. Three pages use it:

- **Batch job**: `<StatusBadge status={job.status} />`, plus the "Open: accepting items" marker under its current
  condition (`jobs/[jobId]/page.tsx:65-70`);
- **Generated post**: `<StatusBadge status={detail.post.status} />` (`generate/result/[postId]/page.tsx:62`);
- **Post detail**: `<StatusBadge status={view.post.status} />` (today on its own line under the heading,
  `posts/[postId]/page.tsx:67-69`).

**Rationale**: The spec says "status badge beside it, as now" for the job. Putting a badge inside `title` would put
it inside the `<h1>`, and the heading's accessible name would become "Post Draft". `eyebrow` renders uppercase
above the title, which suits neither a badge nor a back link. A prop on the existing component isn't a new shared
component (spec Assumptions).

**Alternatives considered**: badges in `actions`. Rejected: actions sit right-aligned with buttons, and status isn't
an action. Badges on a line below the header. Rejected for the job, where the spec says "beside it".

## R5 — Focus targets keep their id

**Decision**: Failures and Post detail pass `titleId="page-title"`. `PageHeader` then renders
`<h1 id="page-title" tabIndex={-1}>` (`PageHeader.tsx:25`), the same id and focusability as the bare headings today
(`failures/page.tsx:178`, `posts/[postId]/page.tsx:64`). Both pages keep `<AnnounceProvider focusFallbackId="page-title">`
(FR-014, US2 scenario 3).

## R6 — Spacing

**Decision**: Keep `PageHeader`'s own `mb-6` and the pages' existing `gap-*`/`space-y-*` wrappers. Don't add page-level
margins or change `PageHeader`'s spacing.

**Rationale**: Accounts (`gap-6`) and Overview already combine `PageHeader` with a gap wrapper. One more step of
space under every title is consistent across routes, and changing `PageHeader` itself would move the six pages that
already use it.

## R7 — Calendar title and time zone

**Decision**: `calendar/page.tsx:83-85` becomes
`<PageHeader title={calendar.title} description={`Scheduled posts and open posting slots, in ${calendar.timeZone}.`} />`.
The `· {timeZone}` span goes. It's rendered in every calendar state, including `no_accounts` (FR-016, US2
scenario 2).

**Rationale**: `calendar.title` is the shown period ("October 2026", asserted by `tests/integration/calendar.test.ts:42`),
so it stays the title. The zone appears once, in the description.

## R8 — Readable target statuses on the posts list

**Decision**: Export `statusTone(status: string): BadgeTone` from `src/components/ui/StatusBadge.tsx`, beside the
existing `statusLabel` (`:28-30`), using the same `STATUSES` table and the same `"neutral"` fallback as `StatusBadge`.
`StatusBadge` uses it internally. On the posts list (`posts/page.tsx:150-155`) the hand-picked tone and the
`replaceAll` go:

```tsx
<Badge tone={statusTone(t.status)}>
  {t.accountName}: {statusLabel(t.status)}
  {t.note ? ` · ${t.note}` : ""}
</Badge>
```

The 7 values of `postTargetStatus` (`src/server/db/schema/posts.ts:43-51`) all have labels in `STATUSES`: Draft,
Scheduled, Publishing, Published, Failed, Needs your decision, Cancelled. Unknown values still fall back to the name
with spaces (Edge Cases). Tones now match the post page: `scheduled` becomes `brand` and `publishing` becomes `info`.
Both were `neutral` on the list before. That's what FR-031 asks for.

**Rationale**: One vocabulary, one tone table (FR-030, FR-031). The post page already uses `StatusBadge` for
targets (`posts/[postId]/page.tsx:114`).

**Other raw renders checked**: `failures/page.tsx:49,109` and `posts/[postId]/page.tsx:204` print publish-attempt
*outcomes*, and `generate/result/[postId]/page.tsx:144` prints a retry reason. They're out of scope (spec "Not
included"). `SlotEditor.tsx:139` prints mock behaviours for the mock provider. The calendar already uses
`StatusBadge` (`CalendarBoard.tsx:91`). No other place shows a target status as text.

**Alternatives considered**: a `prefix` prop on `StatusBadge`. Rejected: it widens a component used in 10 files to
serve one caller. A local tone map in the posts page. Rejected: that's the duplicate FR-031 removes.

## R9 — One source for role names and descriptions

**Decision**: Add a new pure module, `src/lib/roles/roles.ts`, with no server-only imports so the client invite form
can use it:

- `ROLE_OPTIONS`: `editor`, `admin`, `owner`, in that order, each `{ value, label, description }` with the FR-051
  wording;
- `roleLabel(role: string): string`: the display name, or for an unknown key the key with its first letter
  capitalised;
- `roleDescription(role: string): string | undefined`.

The `Role` type comes from `import type { Role } from "@/server/auth/access"`. That's a type-only import, erased at
build. `src/lib/roles/prerequisites.ts:3` already does the same with a server type. Full shape:
[contracts/modules.md](./contracts/modules.md) §1.

**Wording checked against `src/server/auth/access.ts` (FR-051)**. No mismatch, so the spec wording stands unchanged:

| Role | Claim in the description | Permission table |
|---|---|---|
| Editor | writes, schedules and generates posts | `post: view, edit, schedule, delete`; `generation: run` (`:56,58`) |
| Editor | uploads media | `media: view, edit` (`:55`) |
| Editor | can't connect accounts or change posting slots, brand voice or settings | `account: view`, `slot: view`, `voice: view`, `project: view` only. No `api_key`, `webhook` or `invitation` (`:50-59`) |
| Admin | everything an editor can do | every editor permission is in the admin role (`:35-48`) |
| Admin | plus accounts, posting slots, brand voice, settings and invitations | `account/slot/voice: manage`, `project: update`, `api_key`/`webhook: manage`, `invitation: view, create, revoke, regenerate` |
| Admin | can't invite owners or change members' roles | no `invitation: create_owner`, no `member: update_role` (`:37-38`) |
| Owner | full control, including inviting owners, changing roles and transferring ownership | every statement, including `create_owner`, `update_role`, `transfer_ownership` (`:20-33`) |

The descriptions don't cover everything: admins can also remove non-owner members, and only owners can remove
owners. But nothing they say is false. FR-051 corrects wording only on a mismatch.

**Callers** (all switch to the module):

- invite form (`invitations-panel.tsx:101-111`), R10;
- signup summary (`signup/page.tsx:40-44`), R11;
- Invitations (`invitations/page.tsx:33`), R11;
- the pending-invitations table's role cell (`invitations-panel.tsx:145`): it shows the raw key today and becomes
  `roleLabel(inv.role)`;
- the members table: `members-panel.tsx:12-16` (its own `ROLE_OPTIONS`) and `:82` (`capitalize {m.role}`) use the
  module's labels, with no description in the per-row role control. The rendered text is unchanged;
- the overview: `ROLE_LABEL` (`src/lib/overview/derive.ts:143`) becomes `` `an ${roleLabel(role)}` ``. Output is
  identical ("an Owner", "an Admin", "an Editor"), and existing overview tests pin it.

**Rationale**: FR-051 asks for one source used by the three screens. The members table, the pending-invitations
table and the overview also spell role names, and leaving them as separate copies would contradict the "one source"
guidance FR-081 puts in the docket-ui skill. Each of those adoptions keeps its rendered text, except the invitations
table cell, which goes from "editor" to "Editor" (the same raw-key problem the spec fixes elsewhere; no test pins it,
grep 2026-10-09).

**Alternatives considered**: putting the strings in `src/lib/roles/names.ts`. Rejected: that file is about people's
names (`joinNames`, `askManagers`), and a second topic would blur it. A server-only module. Rejected: the invite form
is a client component.

## R10 — The invite form's role cards

**Decision**: `invitations-panel.tsx` renders
`SegmentedControl name="role" label="Role" layout="cards" defaultValue="editor"`, with options
`ROLE_OPTIONS.filter((o) => o.value !== "owner" || canInviteOwner)`. `SegmentedControl` already links each card's
description to its radio with `aria-describedby` (`SegmentedControl.tsx:84,94,108`). Cards stack, so the form
layout changes:

1. the email field, full width;
2. the role cards;
3. the Invite button, `self-start`. The `mb-5` alignment hack (`:112`) goes.

Field names, the action, the error display and the default are unchanged (FR-050).

## R11 — Signup and Invitations

**Decision**:

- **Signup** (`signup/page.tsx:40-44`): the summary reads
  `{inviterName} invited you to <strong>{projectName}</strong> as <strong>{roleLabel(role)}</strong>.` It's followed
  by `<p className="text-sm text-muted-foreground">{roleDescription(role)}</p>`. Both sit inside the one `summary`
  node, so all three states that show it (`signup`, `login_required`, `accept`) get them (FR-052). The "invalid" and
  "other email" states have no summary and are unchanged. Signup keeps the centred card pattern; no `PageHeader`
  (spec Edge Cases).
- **Invitations** (`invitations/page.tsx`): `PageHeader title="Invitations" description="Projects you've been invited
  to join."` replaces the `<h1>` (`:23`). Each item reads "Join as **{roleLabel}**. Invited by …", followed by the
  description as a muted line (FR-053). The UTC expiry string stays (spec "Not included").

## R12 — Voice editor hints, linked to their fields

**Decision**: `VoiceEditor.tsx` passes `hint` to the four `Area`s in the "Voice" group (`:190-193`), using the FR-060
strings. `Area` (`:46-75`) already renders a hint, but nothing links it to the field. So:

- the hint `<p>` gets `id={`${id}-hint`}`;
- the error `<p>` gets `id={`${id}-error`}`;
- the `<textarea>` gets `aria-describedby` listing whichever of the two are present. This is the same pattern as
  `Combobox.tsx:156` and `SegmentedControl.tsx:60`.

The hint renders whatever `readOnly` is, so editors see it too. The error still shows under the field when present.
The "Voice" group legend stays (FR-008, and `voice.test.tsx:129`).

**Rationale**: FR-060 says "linked to its field". Linking the error at the same time costs nothing and follows the
control rules in `docs/design-system.md` §7. Other `Area` callers (examples, name) get the linkage too, at no visible
change.

## R13 — The posting-slot definition

**Decision**: In `accounts/page.tsx`, inside the connected-accounts section, right after its `<h2>` (`:120-122`)
and only when `withSlots.length > 0`, render:

```tsx
<p id="posting-slots-definition" className="text-sm text-muted-foreground">
  <span className="font-medium text-foreground">Posting slots:</span> Weekly times this account posts at. Add to queue
  fills the next free slot.
</p>
```

It renders once whatever the number of accounts, for every role, and doesn't render in the empty state (FR-020).
Each card's "Posting slots ({tz})" heading (`:219`) and the page description (`:104`) are unchanged (FR-021).

**Rationale**: The audit's sentence is kept verbatim. The lead-in names the term it defines, because the sentence
alone ("Weekly times this account posts at.") doesn't say which word it explains when it sits above several cards.
This placement survives entry 4's card restructure (spec Assumptions).

**Alternatives considered**: `aria-describedby` from each slot table to the definition. Rejected: a table
description that repeats on every card would be read once per account, which is the repetition FR-020 avoids.

## R14 — `/p/new`

**Decision**: `src/app/p/new/page.tsx:19` becomes "Next you'll connect a social account and choose when it posts."
In `new-project-form.tsx:69`, `TimeZoneField` gets `hint="Posting times and the calendar use this zone."`. The
default hint in `TimeZoneField.tsx:35` stays, so Project settings is unchanged (FR-070, FR-071). `Combobox` links
the hint with `aria-describedby` (`Combobox.tsx:156,164-165`).

## R15 — Renames in headings and tab titles

**Decision**:

| File | Today | After |
|---|---|---|
| `voice/page.tsx:14` metadata, `:35` heading | "Voice" | "Brand voice" |
| `voice/loading.tsx:4`, `voice/[profileId]/loading.tsx:4` | `<h1>Voice</h1>` | `<h1>Brand voice</h1>` (the loading screens keep their bare pattern; `aria-label`s unchanged) |
| `jobs/page.tsx:20` metadata, `:62` heading | "Jobs" | "Batch jobs" |
| `jobs/page.tsx:49` link | "New job from CSV" | "New batch job from CSV" |
| `jobs/new/page.tsx:13` metadata, `:53` heading | "New job" | "New batch job" |
| `jobs/new/csv/page.tsx:11` metadata, `:31` heading | "New job from CSV" | "New batch job from CSV" |
| `jobs/[jobId]/page.tsx:42` `generateMetadata` | `` `Job: ${summary}` `` | `` `Batch job: ${summary}` `` |
| `jobs/[jobId]/page.tsx:108` | "Targets" | "Accounts" (FR-040) |

These stay: "Voice profile" and "Voice profile history" tab titles; the "Voice" field group (`VoiceEditor.tsx:189`)
and the job page's "Voice" row (`jobs/[jobId]/page.tsx:99`) (FR-008); "Generation jobs" as the jobs table caption;
running text such as "No generation jobs yet…" (Edge Cases); the public API "Jobs" tag; `/voice` and `/jobs` URLs.

**Rationale**: The job-detail tab title is a tab title that names the section (FR-007). "Batch job: …" keeps it
consistent with the heading and nav.

## R16 — Connect

**Decision**: Both branches of `accounts/connect/[attemptId]/page.tsx` use `PageHeader`:

- the expired branch (`:34`): title "Connect accounts";
- the main branch (`:44`): "Connect {choice.groupDisplayName}".

Both have the description "Choose which accounts to add to this project.". In the main branch, the muted sentence
at `:45-47` loses its first sentence, which the description now carries, and reads "This choice is available until
<time>.". The tab title "Choose accounts to connect" (`:10`) stays: it isn't a section name.

## R17 — API keys and Webhooks

**Decision**:

- **API keys** (`settings/api-keys/page.tsx:28-31`): the description is "Keys let tools like n8n use this project's
  API.". "Each key works only in this project, only for the permissions you tick." stays as a `<p>` below, then the
  links paragraph.
- **Webhooks** (`settings/webhooks/page.tsx:28-31`): the description is the existing sentence, verbatim. The
  signatures link stays below.

Both pages are reachable only by managers (`ForbiddenError` → `notFound`), so neither description names an action
the viewer can't take (FR-013).

## R18 — Docs

**Decision**:

- **`docs/design-system.md` §6**: update the shell diagram (`:149-169`) to the FR-001 list, with Activity under
  PROJECT. Update the Sidebar bullet (`:177-185`) the same way, keeping the "Review stays directly above Failures
  (tested)" sentence. Page anatomy item 1 (`:195`) says every page in the project shell (and `/invitations`) has a
  `PageHeader` with a one-line description, with badges in `aside` (FR-080).
- **`.claude/skills/docket-ui/SKILL.md`**: in the app-shell bullet (`:31-33`), the groups and items of FR-001 (and
  "Overview first", still owed from entry 1, `docs/decisions.md:1294`). Add a line: every route has a one-line
  `PageHeader` description, and role names and descriptions come from `src/lib/roles/roles.ts` (FR-081). This
  session's sandbox denies writes under `.claude/skills` (entries 027 and 028 hit the same wall,
  `docs/decisions.md:1294,1321`). If the write is refused, record the exact edit as an open item in
  `docs/decisions.md` and the implement output. Don't skip it silently.
- **`docs/generator.md:55,61`**: "**Jobs → New job**" becomes "**Batch jobs → New batch job from CSV**", and "the Jobs
  screen(s)" becomes "the Batch jobs screen(s)". The `## Jobs` heading (`:53`) stays, because doc anchors are pinned
  by the published-docs test and the heading names the concept.
- **`docs/decisions.md`**: add a "029 — Terminology, page descriptions and nav order" section with D1–D12 (R1–R17
  condensed).

## R19 — Tests

**Decision**:

| Test | Covers |
|---|---|
| **New** `tests/integration/terminology/nav.test.tsx` | Renders `LeftNav` and reads link text in order: the 13 FR-001 labels; group headings Publish/Create/Project in order, each containing its items; Review directly above Failures; "Brand voice" → `/p/x/voice` and "Batch jobs" → `/p/x/jobs` with `aria-current="page"` at those paths; no "Voice"/"Jobs" link text (FR-001–FR-004, FR-006, SC-002, SC-005) |
| **Edit** `tests/integration/failures/nav.test.ts:27` | R2 (FR-005) |
| **New** `tests/helpers/page-header.ts` | `expectPageHeader(html, { title, description })`: exactly one `<h1`, the `<h1>` text contains `title`, and the description is in the `<p>` right after the heading block |
| **New** `tests/integration/terminology/page-headers.test.tsx` | Every FR-012 page that can be rendered with existing factories (`postsEnv`, `jobsEnv`, `createVoiceProfile`, `createJob`, `createPostInReview`, `sessionModule`). For each: `expectPageHeader` with the FR-012 title and description, plus the per-page checks (Calendar zone once; Failures `id="page-title"`; Batch job badge outside the `<h1>`; "Accounts" row on the job page; tab titles via the page module's `metadata`/`generateMetadata`) (FR-006, FR-007, FR-010–FR-016, FR-040, SC-001, SC-005) |
| **Edit** existing per-route UI tests where the fixture is hard to rebuild | Connect choice (`tests/integration/connect/chooser-ui.test.ts`, which already builds a connect attempt), API keys (`tests/integration/api-keys/ui.test.tsx`), Batch job (`tests/integration/jobs/ui.test.tsx` "Job page"), Project settings (`tests/integration/notifications/ui.test.tsx`), Members (`tests/integration/accounts-ui.test.ts`): add `expectPageHeader` beside their current assertions. Series and Generated post have no page-render test today; `page-headers.test.tsx` creates them through the generation services with `createFakeLlm`, as `src/app/p/[projectSlug]/generate/series.test.tsx` and `generate.test.tsx` do |
| **New** unit `src/components/ui/StatusBadge` test (extend `ui-atoms.test.ts`) | For every `postTargetStatus.enumValues`: `statusLabel` has no underscore and isn't the raw key, and `statusTone` equals `StatusBadge`'s tone. `statusLabel("something_new")` fallback unchanged (FR-030, FR-031, SC-003) |
| **New** posts-list case (in `page-headers.test.tsx` or `tests/integration/terminology/posts-statuses.test.tsx`) | One post with targets in all 7 statuses (set with a scoped update in the test): each badge reads "{account}: {label}" and none shows a raw key (US4 scenario 2, SC-003) |
| **New** `src/lib/roles/roles.test.ts` | Order, labels, the exact FR-051 strings, `roleLabel` fallback, `roleDescription(unknown)` is `undefined` |
| **New** `tests/integration/terminology/roles.test.tsx` | Invite form as owner (3 cards, Editor checked) and admin (2 cards, no Owner); signup in the `signup`, `login_required` and `accept` states for an editor, admin and owner invitation; Invitations page for an admin invitation. The same label and description in each (FR-050–FR-053, SC-004) |
| **Edit** `src/app/p/[projectSlug]/voice/voice.test.tsx` | The four hints in edit and read-only mode, each textarea's `aria-describedby` containing its hint id, and an error still shown. The existing `:129` loop stays unchanged (FR-060, FR-090) |
| **New** `/p/new` case | Sentence and hint, hint id in the combobox's `aria-describedby` (FR-070, FR-071) |
| **Accounts** case | Definition present once with 2 accounts, for owner and editor; absent with 0 accounts (FR-020) |
| **SC-007 guard** | One test reads the FR-012 descriptions, role descriptions and hints from the rendered output and asserts no `[A-Z_]{3,}=?`-style env name, no `pnpm`/`docker` command and no `@` |

**Pinned assertions that change** (FR-007, FR-090; same commit as the copy change):

- `tests/integration/failures/nav.test.ts:27`: Activity's place (R2);
- `tests/integration/roles/routes.test.tsx:176,187`: `not.toContain("New job from CSV")` becomes
  `not.toContain("New batch job from CSV")`;
- `tests/integration/jobs/ui.test.tsx:66,107`: `toContain("New job from CSV")`, and `:76`:
  `not.toContain("New job from CSV")`. All three become "New batch job from CSV".

Nothing else may change. The describe/it names in `routes.test.tsx` ("Jobs", "New job (media)") are test labels, not
assertions, and stay. `review.test.tsx:55` and `roles/empty-lists.test.tsx:76` assert Review's empty-state message,
which is unchanged.

## R20 — Scope guard

Nothing in this entry touches the schema, a migration, a service, the DAL, an access rule, a server action, the
public API, an env var or `docker-compose.yml`. `docs/decisions.md` records "no compose change" so the operator
isn't asked to edit their copy.
