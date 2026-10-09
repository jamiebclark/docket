# Research: Empty states that name the next step, and role awareness

**Feature**: `specs/028-empty-states-roles/spec.md` | **Date**: 2026-10-09

Every line and file cited here was read in the current tree on 2026-10-09, after entry 1 (`027-project-overview`)
merged. There are no platform API facts in scope. The only framework behaviour this entry relies on is cited from
`node_modules/next/dist/docs/` (R10).

The Technical Context had no `NEEDS CLARIFICATION` items. The spec settles every copy and role question. This file
records where each fact comes from, and the design choices the spec leaves to the plan (D1–D20).

---

## R1. Who can do what (the role rules this entry reads)

**Source**: `src/server/auth/access.ts` (statements and the three roles).

| Capability | Check | owner | admin | editor |
|---|---|---|---|---|
| Manage accounts (connect, reconnect, remove) | `scope.can({ account: ["manage"] })` | yes | yes | no |
| Manage slots | `scope.can({ slot: ["manage"] })` | yes | yes | no |
| View slots | `scope.can({ slot: ["view"] })` | yes | yes | yes |
| Manage voice profiles | `scope.can({ voice: ["manage"] })` | yes | yes | no |
| Run generation | `scope.can({ generation: ["run"] })` | yes | yes | yes |
| Edit media (upload) | `scope.can({ media: ["edit"] })` | yes | yes | yes |
| Write posts | `scope.can({ post: ["edit"] })` | yes | yes | yes |
| Schedule posts | `scope.can({ post: ["schedule"] })` | yes | yes | yes |
| View members | `scope.can({ member: ["view"] })` | yes | yes | yes |
| Server pieces (scheduler, AI, storage, platform apps) | `scope.membership.role === "owner"` | yes | no | no |

There's no permission statement for server setup. Entry 1 already gates the server-setup row on
`facts.viewer.role !== "owner"` (`src/lib/overview/derive.ts:160`). This entry uses the same check, so that FR-073
holds: no access rule changes.

**Decision D1**: every role check in this entry is one of the `scope.can(...)` calls above, or the owner check, made on
the server in the page. Client components get booleans (`canManageSlots`), never the role.

## R2. People to ask: names and ordering

**Sources**:

- `src/server/services/members.ts:26-41`: `list(scope)` needs `member: ["view"]`, which every role has. It returns rows
  with `name`, `role`, `email` and others.
- `src/server/services/overview.ts:91-95`: managers are owners and admins, ranked owners first and then in list
  order, reduced to `{ name, role }`.
- `src/lib/overview/derive.ts:131-140`: `joinNames(names, conjunction)` trims names, drops blank ones, joins "A",
  "A or B", "A, B or C", "A, B, C or n others", and falls back to "an owner or admin".

FR-070 needs two lists (managers, and owners only) and two fallbacks ("an owner or admin", "an owner").
`joinNames`'s fallback is hard-coded.

**Decision D2**:

- Move `joinNames` to a new pure module `src/lib/roles/names.ts` with a third parameter, `fallback`, which defaults to
  `"an owner or admin"`. `src/lib/overview/derive.ts` re-exports it, so `derive.test.ts` and every overview import
  still work unchanged.
- Add a pure `managersOf(rows)` to the same module: the filter-and-rank logic from `overview.ts:91-95`, moved there.
  Plus `askManagers(managers, conj)` and `askOwners(managers, conj)`, built on `joinNames`, with fallbacks
  "an owner or admin" and "an owner".
- Add a service `listManagers(scope)` in `src/server/services/members.ts`: `managersOf(await list(scope))`.
- `getOverview` keeps its single `members.list` call (it also needs `memberCount`) and calls `managersOf(memberRows)`.
  The ranking then exists once (Constitution IV).

Emails never leave the service: `managersOf` returns only `{ name, role }` (FR-070, SC-002).

**Alternatives rejected**:

- A second copy of the ranking in each page: duplicates logic.
- Passing whole `MemberView` rows to client components: that would ship emails to the browser.

## R3. Account slot state ("has an active slot")

**Sources**:

- `src/server/services/slots.ts:11-16`: `listSlots(scope, accountId)` needs `slot: ["view"]`, which every role has.
  It returns `paused` per slot.
- `src/server/services/overview.ts:62-76`: per-account loop, counting `active` and `paused`.
- `src/lib/overview/derive.ts:181`: slots only count when `providerAvailable`.
- Spec edge cases: an unregistered provider's slots don't count as active. All slots paused means no active slots.

**Decision D3**:

- Add `listSlotCounts(scope)` to `src/server/services/slots.ts`. It returns
  `{ accountId, providerAvailable, active, paused }[]` in `listAccounts` order, using one `listSlots` per account (the
  per-account loop FR-014 allows).
- `getOverview` switches its loop to this function, so the counting happens once.
- The rule "has an active slot" is the pure `hasActiveSlot({ providerAvailable, active })` in `src/lib/roles/slots.ts`
  (`providerAvailable && active >= 1`). Calendar, Compose and the overview's `slotsDone` all use it.

**Alternatives rejected**:

- `listEmptySlots` (`src/server/services/queue/index.ts:346`): it only covers a bounded range from now on, so it's
  wrong for "any active slot" (spec: Calendar's slot read).
- A new DAL query that counts slots project-wide: the spec doesn't ask for it, and entry 1 rejected the same idea
  ("a project-wide slot-count service (no entry)").

## R4. Post counts ("the project has no posts at all")

**Sources**:

- `src/server/services/posts/list.ts:43-71`: `listPosts` returns `counts` from `scope.posts.counts()`. These are
  project-wide and include every status. `needs_decision` is an overlay.
- `src/server/dal/posts.ts:155-170`: the counts exclude soft-deleted posts.
- `src/app/p/[projectSlug]/posts/page.tsx:76`: the "All" tab total is the sum of every status except
  `needs_decision`.

Posts already loads `list.counts`, so it needs no new read. Failures doesn't load posts.

**Decision D4**:

- Add a read-only `countPosts(scope)` to `src/server/services/posts/list.ts`, exported from `posts/index.ts`. It
  checks `post: ["view"]` and returns the same total as the "All" tab (every status except `needs_decision`).
- Failures calls it only when the unfiltered list is empty, so a project with failures pays nothing extra.
- "No posts at all" means `total === 0`. Rejected and draft posts count, since they're posts.

**Alternatives rejected**:

- Calling `listPosts` from Failures: that loads 25 rows and their targets just to read a count.
- Using Failures' own `totals`: those cover only ambiguous and failed targets, so they can't tell "no posts" from
  "nothing failed".

## R5. Generation readiness (one list of prerequisites)

**Sources**:

- `src/server/llm/index.ts:20-28`: `getLlmStatus()` returns `{ configured: false, problems: EnvIssue[] }`.
- `src/server/llm/index.ts:33-37`: `getLlm()` expands a lone `LLM_PROVIDER` problem to
  `["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY"]`, so the owner sees every setting at once.
- `src/server/services/voice.ts:90-95`: `listVoiceProfiles(scope)` excludes archived profiles by default and needs
  `voice: ["view"]`, which every role has.
- `src/app/p/[projectSlug]/generate/page.tsx:49-91`: today's three gates, in the order LLM, voice, accounts.
- `src/app/p/[projectSlug]/jobs/new/page.tsx:59-107` and `jobs/new/form-data.ts:15-16`: the job pages read voice
  profiles and accounts the same way.
- `src/server/services/jobs/create.ts:221-246`: `previewJob` needs `generation: ["run"]` and `post: ["view"]` but not
  the LLM. So New job from media can work out "Images to generate for" even when AI isn't set up.

**Decision D5**:

- Extract the expansion in `getLlm()` into an exported `missingLlmSettings(problems): string[]` in
  `src/server/llm/index.ts`. `getLlm()` keeps its behaviour by calling it.
- Add `getGenerationReadiness(scope)` in `src/server/services/generation/readiness.ts`. It returns
  `{ ai: { configured, missingSettings }, accounts, voiceProfiles }`. `missingSettings` is non-null only when the
  viewer is an owner and AI isn't configured (FR-043): the names never reach a non-owner's page, even by mistake.
  Counts come from `listAccounts` and `listVoiceProfiles` (non-archived).
- The pure `generationPrerequisites(...)` in `src/lib/roles/prerequisites.ts` turns readiness, the viewer's
  capabilities, the people to ask and an optional images item into `ChecklistItem[]`, or `null` when nothing is
  missing (FR-040–FR-043).

**Alternatives rejected**:

- Keeping three early returns: that's the bug the spec fixes (SC-003).
- Putting setting names in the pure module's input for everyone and filtering at render time: one forgotten branch
  would leak them. The service drops them instead.

## R6. Scheduler-health and reauth banners

**Sources**:

- `src/components/shell/SchedulerHealth.tsx:32-79`: a pure component with no role. The stale headline is "The
  scheduler last ran {when}. Scheduled posts are not going out.", and the never-run headline is "The scheduler has
  never run. Scheduled posts will not go out.". Three remedies follow.
- `src/app/p/[projectSlug]/layout.tsx:36-55`: renders both banners. It already has `scope`, and calls
  `getSchedulerHealth` and `listAccountsNeedingReauth` on every request.
- `src/components/shell/ReauthBanner.tsx:45`: "Ask an owner or admin to reconnect it/them."
- `tests/integration/scheduler-health.test.ts:71-103` pins the remedies and both headlines.
  `src/components/shell/ReauthBanner.test.ts:23,30` pins the editor line.
- The deployment guide anchor `9-is-the-scheduler-running` is already linked from `src/lib/overview/derive.ts:162`
  and checked by `tests/integration/docs/published-docs.test.ts`.

**Decision D6 (banner copy for non-owners)**: FR-060 keeps "their headline sentence for everyone". FR-061 replaces the
remedies with "Scheduled posts are not going out. Ask {owner names} to start the scheduler." Keeping both full
headlines would print the same fact twice ("…will not go out. Scheduled posts are not going out."). So for admins and
editors the banner reads:

- **stale**: "The scheduler last ran {when}." (bold), then "Scheduled posts are not going out. Ask {owners} to start
  the scheduler."
- **never**: "The scheduler has never run." (bold), then the same second sentence.

Owners see today's headline and remedies unchanged, plus a "How to fix this" link to the deployment guide's anchor.
The FR-061 sentence appears exactly as specified, and the headline's fact (when it last ran) is kept for everyone.
This is logged in `docs/decisions.md`.

**Decision D7 (component props)**:

- `SchedulerHealth` gains a required `viewer: { kind: "owner" } | { kind: "ask"; owners: string }`. It's required,
  so no caller can default to the owner view by accident. The two existing render helpers in
  `scheduler-health.test.ts` pass `{ kind: "owner" }`: this is the FR-084 update to pinned tests.
- `ReauthBanner` gains `askNames: string`, already joined with "or".

**Decision D8 (cost)**: the layout calls `listManagers(scope)` only when a banner needs names: the scheduler isn't
`ok` and the viewer isn't an owner, or some account needs reconnecting and the viewer can't manage accounts. A healthy
project pays nothing extra on each page.

## R7. Accounts page: connect section and unconfigured platforms

**Sources**:

- `src/app/p/[projectSlug]/accounts/page.tsx:99-100`: the empty copy. `:222` gates the section on
  `canManage || groups.length > 0`. `:231-270` renders groups in registry order, then the mock, then the credential
  providers.
- `src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:72-88`: the unconfigured branch (setup-guide link and
  redirect address), checked before `canManage`.
- `tests/integration/accounts-ui.test.ts:149-157` renders as the owner (`postsEnv` owner) and pins
  "is not configured on this server". It passes unchanged once the owner's disclosure contains the same section
  (a closed `<details>` is still in the markup).

**Decision D9**:

- The "Add an account" section renders only when `canManage` is true (FR-002).
- Inside it, the order is:
  1. configured groups;
  2. the mock form;
  3. credential forms;
  4. last, owners only, one `<details>` (closed, native) with
     `<summary>Not set up on this server ({n})</summary>`, containing each unconfigured group's existing
     `ConnectGroupSection`.
  This meets FR-003 and FR-004. `ConnectGroupSection` itself is unchanged. Only its caller filters.
- **Admin fallback** (a gap in the spec): when an admin's section has no configured group, no mock and no credential
  provider, it shows one line: "No platforms are set up on this server yet. Ask {owners} to set one up." This is a
  server-level item, so it names owners only (FR-070). Without it, the admin would see an empty "Add an account"
  heading. Logged in `docs/decisions.md`.
- The empty state's copy (FR-001), by `canManage`:
  - managers: "You don't have any accounts yet. Connect one below to start scheduling posts.";
  - everyone else: "No accounts yet. Ask {managers} to connect one."

## R8. Calendar states

**Sources**:

- `src/app/p/[projectSlug]/calendar/page.tsx:56,105-115`: `hasContent` and today's EmptyState, which sits above the
  grid.
- `src/server/services/calendar.ts:95`: `calendar.accounts` has no slot data and no `providerAvailable`.
- `:118`: the empty-slot items only run from now on (D17 of the scheduling entry).

**Decision D10**: a pure `calendarState(...)` in `src/lib/roles/calendar.ts` returns one of the following.

| State | When | Toolbar | Grid | Copy and action |
|---|---|---|---|---|
| `no_accounts` | `accounts.length === 0` | hidden | hidden | FR-010 |
| `no_slots` | accounts, no `hasActiveSlot` anywhere, `!hasContent` | shown | replaced | FR-011 |
| `no_slots_line` | accounts, no `hasActiveSlot` anywhere, `hasContent` | shown | shown | one line above the grid (FR-012) |
| `empty_period` | some active slot, `!hasContent` | shown | replaced | FR-013, "Today" |
| `content` | otherwise | shown | shown | none |

- "Any active slot" is project-wide, even when the Account filter is set (FR-011 says "on any of them"). A filtered
  view of a slotless account in a project that has slots falls into `empty_period`.
- "First account without an active slot" is the first in `listAccounts` order that has `providerAvailable`, falling
  back to the first account, as `deriveChecklist` does (`derive.ts:184`).
- The Calendar page calls `listSlotCounts(scope)` only when `calendar.accounts.length > 0`.

## R9. Compose: the slot hint

**Sources**:

- `src/app/p/[projectSlug]/compose/Composer.tsx:238-255`: the empty state. `:257-260` sets `blocked`. `:536-549` is the
  ActionBar: Save draft, Publish now…, Schedule…, and Add to queue… (`cta`, last).
- `src/components/ui/ActionBar.tsx`: "actions right-aligned (primary last)", with an optional `message`.
- `src/app/p/[projectSlug]/compose/composer-logic.ts:65-77`: `scheduleBlockedReason`.
- `src/app/p/[projectSlug]/compose/Composer.test.ts:18-21`: fixtures build `AccountOption` without slot data.
  `:183-189` pins `href="/p/demo/accounts"` for the owner and "Ask an owner or admin" for the editor.

**Decision D11**:

- `AccountOption` gains an optional `hasActiveSlot?: boolean | null`. `undefined` or `null` means unknown: no hint,
  and Add to queue behaves as today (spec edge case: a failed read never disables the action). Existing fixtures
  compile and pass unchanged.
- The compose pages (new and edit) call `listSlotCounts(scope)` inside a `try`. On error they pass `null` for every
  account.
- `Composer` gains `canManageSlots: boolean` and `managersToAsk?: string` (joined with "or", defaulting to
  "an owner or admin").
- A pure `queueSlotHint({ selectedIds, accounts, canManageSlots, managersToAsk, slug })` in `composer-logic.ts`
  returns `{ kind: "none" } | { kind: "all"; text; link } | { kind: "some"; text }`.

**Decision D12 (button order and priority)**:

- If `blocked` is set, the bar is exactly as today. The message is the blocking reason and every scheduling button is
  disabled. No slot text is shown, because FR-024 gives the blocking reason priority.
- `all` (FR-021, FR-022): the message is the hint. Add to queue… becomes `secondary`, disabled, and
  `aria-describedby` the hint. Schedule… becomes `cta` and moves last, since ActionBar puts the primary action last.
  The order is Save draft, Publish now…, Add to queue…, Schedule….
- `some` (FR-023): the message is the note. Add to queue… stays `cta` and enabled, and the order is unchanged.
- The hint's link ("Add slots in Accounts") is an inline link inside the bar's message, underlined like other inline
  links. It's not an empty-state action, so FR-071 doesn't apply to it.
- The note's grammar: one name gives "{A} has no posting slots, so Add to queue can't place it.". More gives
  "{A and B} have no posting slots, so Add to queue can't place them." (names joined with "and").

**Decision D13 (empty state link)**: "Connect an account" becomes a `buttonStyles({ variant: "primary" })` `Link` to
`/p/{slug}/accounts`. The href stays exactly as today, so `Composer.test.ts:185` passes unchanged. With no accounts,
the Accounts page's connect section sits directly under the empty state.

## R10. Framework facts used

- **Hash links**: `next/link` scrolls to an element `id` in the target URL's hash
  (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:687-695`, "Scrolling to an `id`"). Every
  "slot section" link uses `/p/{slug}/accounts#account-{id}-slots`, which entry 1 added (`accounts/page.tsx:188`).
- **Server components by default**: every page edited here is already an async server component. The only client
  components touched are `Composer` (already client) and none of the new code. `<details>` and `<summary>` are native
  and work without JavaScript (spec Assumptions).

## R11. Docs links (owner only)

All of these already exist and are checked by `tests/integration/docs/published-docs.test.ts`. That test only finds
literal calls, so it requires the literal form `docsUrl("page", "anchor")`.

| Use | Link |
|---|---|
| Scheduler banner, owners | `docsUrl("deployment", "9-is-the-scheduler-running")` |
| "Set up AI generation", owners | `docsUrl("generator", "configuring-a-provider")` |
| Media "Set up storage", owners | `docsUrl("storage")` |
| Platform setup guides, owners | each group's own `setupDoc` (unchanged) |

## R12. Tests whose pinned copy changes (FR-084)

Found by searching `tests/` and `src/**/*.test.*` for every replaced string:

| Test | Line(s) | Change |
|---|---|---|
| `tests/integration/scheduler-health.test.ts` | 60-61 (render helper) | passes `viewer: { kind: "owner" }`; existing assertions stay; new by-role cases added |
| `tests/integration/failures/ui.test.tsx` | 70 | that case seeds no posts, so it now expects "Posts that fail to publish will show up here." A new case keeps the old copy with a published post |
| `src/app/p/[projectSlug]/review/review.test.tsx` | 55 | "Nothing to review" becomes the FR-033 explanation |
| `src/app/p/[projectSlug]/generate/generate.test.tsx` | 70, 82, and the "links to Accounts" case | the LLM gate becomes the prerequisite list. "Ask an owner or admin to create one" becomes "Waiting on {names}". "Go to Accounts" becomes "Connect an account" |
| `src/app/p/[projectSlug]/voice/voice.test.tsx` | 57 | becomes "No voice profile yet. Ask {names} to create one." (`:183` is the Try-it panel, which is unchanged) |
| `src/components/shell/ReauthBanner.test.ts` | 30 | passes `askNames` and expects "Ask {names} to reconnect it." |
| `tests/integration/accounts-ui.test.ts` | 154 | passes unchanged for the owner. Admin and editor cases are added |
| `tests/integration/jobs/ui.test.tsx` | 64, 89, 92-95 | the empty copy is FR-045. The not-configured box becomes the list. "Shows the start links to an editor" now configures the fake LLM first, because FR-044 hides the actions until generation is ready |

Strings that look related but are untouched: `jobs/reservation.test.ts:33` and `jobs/create.test.ts:71,90` (service
error messages), `jobs/ui.test.tsx:142,164` (job detail and media note text, which is unchanged), and
`docs/deployment.test.ts:65` (docs, not UI).

---

## Decisions summary (for `docs/decisions.md`, entry "028")

| # | Decision |
|---|---|
| D1 | Role checks use the existing `scope.can` statements and, for server pieces, `role === "owner"`. Client components get booleans |
| D2 | `joinNames` moves to `src/lib/roles/names.ts` with a fallback parameter. `managersOf` and `listManagers` give one ranking of owners and admins |
| D3 | `listSlotCounts(scope)` with the pure rule `hasActiveSlot` (available provider and at least one unpaused slot), shared with the overview |
| D4 | `countPosts(scope)` for Failures' "no posts at all", read only when the unfiltered list is empty |
| D5 | `getGenerationReadiness(scope)` drops setting names for non-owners. `missingLlmSettings` gives the full list at once |
| D6 | Non-owner scheduler banner: the headline's first sentence, then the exact FR-061 sentence |
| D7 | `SchedulerHealth` has a required `viewer` prop; `ReauthBanner` has `askNames` |
| D8 | The layout reads managers only when a banner needs names |
| D9 | Accounts: section for managers only. Order: configured groups, mock, credentials, then the owner-only disclosure. Admin fallback line when nothing is connectable |
| D10 | Calendar has five derived states; "any active slot" is project-wide, regardless of the account filter |
| D11 | `hasActiveSlot` is optional on `AccountOption`; unknown means no hint |
| D12 | A blocking reason wins. When no selected account has slots, Add to queue is disabled and secondary, and Schedule… is the headline action, placed last |
| D13 | The compose empty-state href is unchanged (`/accounts`), now button-styled |
| D14 | Review's action is "Generate a post", shown when the viewer can run generation, never linking to Voice or Accounts |
| D15 | Jobs, when prerequisites are missing and no jobs exist: the list only, with no empty state. With jobs: the list above the table |
| D16 | Prerequisite card title: "Before you can generate". New job from media adds item 4 last, reusing today's selection messages |
| D17 | Media: the "No unused images" note becomes `alertStyles("info")` on a `<p>`, with no live role (it's static) |
| D18 | Voice reads archived profiles only when the active list is empty and the archived tab isn't open |
| D19 | Empty-state action variants: `primary` when it's the page's only next step, `secondary` when the header already has a primary action or when it's a navigation aid (contracts/ui.md lists each) |
| D20 | Pinned tests updated, as in R12 |
