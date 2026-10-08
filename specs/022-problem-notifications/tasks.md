---

description: "Task list for 022 problem notifications"
---

# Tasks: Problem notifications — an unread-problems bell, a recent-problems panel and a per-project callout

**Input**: `specs/022-problem-notifications/` — plan.md, spec.md, research.md, data-model.md, contracts/{services,http,ui}.md, quickstart.md

**Tests**: Requested (FR-023). Every test names its file from quickstart §1. Tests run with `pnpm vitest run <file>` against real Postgres (run-scoped DBs); there is no DOM environment, so UI is tested with `renderToStaticMarkup` and client logic as pure functions.

**Before coding**: read `node_modules/next/dist/docs/01-app/02-guides/prefetching.md`, `03-api-reference/03-file-conventions/{route,page,loading,error}.md` and `04-functions/headers.md` (AGENTS.md: this Next.js has breaking changes).

**Headless note**: no task needs a browser or network. The manual walk-through (quickstart §5) and the `.claude/skills/docket-ui/SKILL.md` edit are listed as 🛑 BLOCKED tasks at the end.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US7 from spec.md

---

## Phase 1: Setup

- [X] T001 Add `bell` and `slidersHorizontal` to `scripts/generate-icons.mjs`, then run `pnpm icons` to regenerate `src/components/ui/icons.generated.ts`
- [X] T002 [P] Create pure `src/lib/notifications/attention.ts`: `ATTENTION_MEMBER_OUTCOMES = ["failed","ambiguous","needs_reauth"] as const`, `CONNECT_FAILED`, `UNREAD_CAP = 100`, `isAttentionFor(event, userId)` (connect_failed counts only for its actor; null actor counts for nobody), per contracts/services.md §2.4
- [X] T003 [P] Create pure `src/lib/notifications/text.ts`: `unreadDisplay` (`""`,`"1"`…`"99"`,`"99+"`), `unreadLabel` ("No unread problems", "1 unread problem", "3 unread problems", "More than 99 unread problems"), `calloutCountText`, `mutedConfirmation(name, on)`
- [X] T004 [P] Create pure `src/lib/time/relative.ts` exporting `relativeTimeText(from, now)` extracted from `SchedulerHealth`'s `ago` helper (same wording: `45 s ago`, `12 min ago`, `1 hour ago`, `3 hours ago`, `4 days ago`); change `src/components/shell/SchedulerHealth.tsx` to import it with unchanged output
- [X] T005 [P] Tests in `src/lib/notifications/attention.test.ts`, `src/lib/notifications/text.test.ts`, `src/lib/time/relative.test.ts` (cases in quickstart §1); confirm `tests/integration/scheduler-health.test.ts` still passes

---

## Phase 2: Foundational (blocks all stories)

**⚠️ No user story can start until this phase is complete.**

- [X] T006 Create `src/server/db/schema/notifications.ts` (`notification_states`: composite PK `(project_id, user_id)`, `seen_seq` bigint, `muted` bool default false, timestamps, CHECK, composite FK `(organization_id, user_id)` → `member` `ON DELETE CASCADE`, per data-model §1); export from `src/server/db/schema/index.ts`; add to `projectOwnedTables` in `src/server/db/project-owned.ts`
- [X] T007 Add the two partial indexes to `src/server/db/schema/activity.ts`: `activity_events_attention_seq_idx` on `(project_id, seq)` for member-wide problem outcomes and `activity_events_connect_failed_actor_idx` on `(project_id, actor_user_id, seq)` where outcome = `connect_failed` (data-model §2)
- [X] T008 Run `pnpm db:generate` to create `drizzle/0015_*`; then `pnpm drizzle-kit generate --custom --name notification_states_start` and paste data-model §3 SQL into `drizzle/0016_notification_states_start.sql` (every existing member starts at global `max(seq)`, idempotent); run `pnpm db:check`
- [X] T009 Create `src/server/dal/notifications.ts` per contracts/services.md §1.1: `createNotificationsRepo` (`get`, `unreadCount`, `createAtCurrentPosition`, `write` with `SET LOCAL lock_timeout '2s'`, project row `FOR UPDATE`, membership re-check, `newestAttentionSeq`, `GREATEST` upsert, skip lock when nothing newer), `createNotificationsSetReader` (`countUnread` as UNION ALL of two capped branches per project with outer cap, `projectsWithUnread`), `newestAttentionSeq`, `NotificationsBusyError` (55P03), `setNotificationsLockTimeoutForTests`; no `OR`, every statement pinned
- [X] T010 In `src/server/dal/activity.ts`: `insert` first runs `SELECT 1 FROM projects WHERE id=$1 FOR KEY SHARE` as its own statement before drawing `seq`; add reader method `listAttention({projectIds,userId,limit})` (four equality-outcome branches per project via a new internal `listBranch` option, UNION ALL, order `occurred_at DESC, seq DESC`, limit; throws before SQL for ids outside the allowed set); `list`/`summary` SQL unchanged
- [X] T011 [P] In `src/server/dal/members.ts` make `MembersRepo.insert` call `createNotificationsRepo(...).createAtCurrentPosition()` on the same executor; in `src/server/dal/projects.ts` make `createProject` insert the owner's `notification_states` row with `seen_seq = 0` in its transaction
- [X] T012 In `src/server/dal/scope.ts` add `notifications: NotificationsRepo` to `ProjectScope` (member: pinned to own user id; job-runner and API-key scopes: methods throw `ForbiddenError`); in `src/server/dal/my-projects.ts` LEFT JOIN `notification_states` into resolution (`MyProject.notifications: {muted, seenSeq} | null`) and add `ProjectSetScope.notifications` (`countUnread`, `recent`, `projectsWithUnread`, `write`) inside `runForProjectSet({reason:"notifications: my projects", projectIds})`, ids outside the set throw `NotFoundError` before SQL; export from `src/server/dal/index.ts`
- [X] T013 [P] Factor the row-building helpers (platform, account, link logic) out of `src/server/services/activity/index.ts` for reuse, with no behaviour change; verify `tests/integration/activity/*.test.ts` still pass
- [X] T014 Create `src/server/services/notifications/index.ts` (`unreadSummary`, `recentPanel`, `markAllRead`, `markProblemsView`, `setNotificationsBySlug`, `setMyProjectNotifications`, `projectUnread`, `myProjectStates`, `myStateForProject`; zod input `{projectSlug, on: "true"|"false"}`; job-runner/API-key scopes → `ForbiddenError`) and pure `panel.ts` (`toNotificationItem` reusing T013 helpers) per contracts/services.md §2 and data-model §4
- [X] T015 [P] Create pure `src/server/services/notifications/view-mark.ts`: `problemsViewScope(pathname, search)` (exactly `?outcome=problems`, no other filter or cursor, on `/p/{slug}/activity` or `/activity`; ignoring `_rsc`; `project=` repeats allowed on `/activity`) and `isPrefetch(headers)` (`next-router-prefetch`, `next-router-segment-prefetch`, `Sec-Purpose`/`Purpose: prefetch`)
- [X] T016 [P] Tests `src/server/services/notifications/view-mark.test.ts` (all qualifying/non-qualifying URLs and prefetch headers from quickstart §1)
- [X] T017 Run existing regression suites that the DAL changes touch: `pnpm vitest run tests/integration/activity tests/integration/members.test.ts tests/integration/invitation-accept.test.ts tests/helpers/scope-check.test.ts src/server/db/project-owned.test.ts` and fix any breakage

**Checkpoint**: schema, DAL and services exist; user stories can start.

---

## Phase 3: User Story 1 — Know there is a problem without looking (P1) 🎯 MVP

**Goal**: A header bell shows the unread count of attention events across the person's unmuted projects, correct without JavaScript.

**Independent Test**: Seed a user in two projects with events of all 7 kinds before/after their position; the count equals exactly the attention events after the position.

- [X] T018 [P] [US1] Test `tests/integration/notifications/count.test.ts` (FR-002/003/004: mixed kinds, other member's connect failure, null actor, mute/unmute, non-member project, 150 unread → 100 with `LIMIT` in recorded SQL)
- [X] T019 [P] [US1] Test `tests/integration/notifications/scope.test.ts` (scope recorder: statements in project-set section, pins in caller's set, foreign id throws before SQL, member removed between resolve and count excluded)
- [X] T020 [P] [US1] Create `src/components/ui/RelativeTime.tsx` atom (uses `relativeTimeText`, sr-only absolute time in the project zone via `Intl`)
- [X] T021 [US1] Create `src/components/notifications/NotificationBell.tsx` (server: resolves session and project set, calls `ensureProblemsViewMarked()` then `unreadSummary`, never fails the page) and `NotificationBellClient.tsx` (client leaf: no-JS `<a href="/notifications">` with badge hidden at zero, accessible name from `unreadLabel`)
- [X] T022 [US1] Create `src/components/notifications/request.ts` with `ensureProblemsViewMarked = cache(...)` reading `x-docket-path` and prefetch headers via `next/headers`, calling `markProblemsView`; never throws; add `x-docket-path` (overwriting any client value) beside `x-nonce` in `src/proxy.ts`
- [X] T023 [US1] Render `NotificationBell` between `InvitationBadge` and `UserMenu` in `src/components/shell/SignedInHeader.tsx`
- [X] T024 [US1] Create the `/notifications` route: `src/app/notifications/page.tsx`, `loading.tsx`, `error.tsx` with the panel list and no-JS fallbacks per contracts/ui.md §4 (table with `th scope`, empty states `no_projects`/`all_muted`/none)
- [X] T025 [US1] Create shared `src/components/notifications/NotificationList.tsx` (rows: project, platform mark, account or "Removed account", message, `RelativeTime`, "New" on unread rows, link to post/Failures/"Post deleted"; empty variants)
- [X] T026 [US1] Test `tests/integration/notifications/ui.test.tsx` part 1: `renderToStaticMarkup` of bell at 0/1/3/150, `NotificationList`, `/notifications` page, `SignedInHeader` order

**Checkpoint**: Bell and count work with no JavaScript.

---

## Phase 4: User Story 2 — See the recent problems and act on them (P1)

**Goal**: Opening the bell shows the 10 newest attention events with "View all", "Mark all as read" and a link to Notifications.

**Independent Test**: With 12 unread problems the panel shows 10 newest-first; "Mark all as read" zeroes the count and returns to the page.

- [X] T027 [P] [US2] Test `tests/integration/notifications/mark-read.test.ts`: exactness and concurrency cases 1–4 from quickstart §2 (two pooled connections, lowered timeout via `setNotificationsLockTimeoutForTests`, test hook pausing after the project lock), forward-only position, no `FOR UPDATE` when nothing new
- [X] T028 [P] [US2] Test `tests/integration/notifications/mark-all.test.ts` (muted and unmuted projects, `busy` result, `returnTo=/notifications` redirect, no `returnTo`)
- [X] T029 [P] [US2] Create `src/app/api/me/notifications/route.ts` and `src/app/api/me/notifications/recent/route.ts` per contracts/http.md (session cookie only, API keys 401, no input read, `Cache-Control: private, no-store`, `Vary: Cookie`); add `/api/me/` public prefix in `src/lib/auth-gate.ts`
- [X] T030 [P] [US2] Test `tests/integration/notifications/routes.test.ts` (401 without/expired/API-key session, empty `no_projects`, crafted params ignored, headers, ≤10 newest-first items, no `details`) and extend `src/lib/auth-gate.test.ts` for the `/api/me/` prefix
- [X] T031 [US2] Create `src/app/notifications/actions.ts` (`markAllRead` server action with optional `returnTo` restricted to same-origin paths; mute action in US4) per contracts/ui.md §5
- [X] T032 [US2] Create client `src/components/notifications/NotificationPanel.tsx` (non-modal disclosure, fetches `/api/me/notifications/recent` on open, focus to "Recent problems" heading, Escape closes and returns focus, `useActionState` for "Mark all as read", "View all" → `/activity?outcome=problems` with `prefetch={false}`, link to `/notifications`); wire into `NotificationBellClient.tsx` so JavaScript turns the link into a button with `aria-expanded`
- [X] T033 [US2] Add the "Notifications" link (`/notifications`, icon `slidersHorizontal`) to `src/components/shell/UserMenu.tsx`

**Checkpoint**: Panel and mark-all work.

---

## Phase 5: User Story 3 — Looking at a project's problems clears them (P1)

**Goal**: Opening Activity filtered to exactly Problems marks that project (or the shown projects) read; nothing else marks.

**Independent Test**: `/p/a/activity?outcome=problems` marks A only; prefetch and other filters mark nothing; the header count rendered in that request is already correct.

- [x] T034 [US3] Add `await ensureProblemsViewMarked()` first in `src/app/p/[projectSlug]/activity/page.tsx` and `src/app/activity/page.tsx` (before listing, and before the latter renders the header)
- [x] T035 [P] [US3] Add `prefetch={false}` to preset links in `src/components/activity/ActivitySummary.tsx` and to every problems-view link added by this feature
- [x] T036 [US3] Test `tests/integration/notifications/view-mark.test.ts` (pages rendered with `next/headers` mocked for `x-docket-path` and prefetch headers, per quickstart §1 row N4; layout alone with a prefetch header marks nothing; later problem counts)

---

## Phase 6: User Story 4 — Hear about only the projects that matter to me (P2)

**Goal**: Per-project on/off, default on, from `/notifications` and project settings.

**Independent Test**: Muting B removes it from count, panel and callout but not from Activity; unmuting marks it read.

- [x] T037 [US4] Add the per-project mute action in `src/app/notifications/actions.ts` (`setNotificationsBySlug`, confirmation text, same `not_found` for unknown and foreign slugs, no-session → login redirect)
- [x] T038 [P] [US4] Create `src/components/notifications/NotificationToggle.tsx` (server form, labelled button, works without JavaScript); use it in the `/notifications` page table
- [x] T039 [US4] Add the "Your notifications" card (every role) to `src/app/p/[projectSlug]/settings/page.tsx` and `setMyProjectNotifications` action in `src/app/p/[projectSlug]/settings/actions.ts`
- [x] T040 [US4] Test `tests/integration/notifications/mute.test.ts` (defaults, hide from count/panel/callout while Activity still lists, unmute → 0 then later 1, editor can mute, foreign vs nonexistent slug identical, no session)
- [x] T041 [US4] Extend `tests/integration/notifications/ui.test.tsx`: `/notifications` per-project button names and confirmations, settings card for an editor

---

## Phase 7: User Story 5 — A nudge inside the project (P2)

**Goal**: "Problems since you last looked" callout atop project home and Posts.

**Independent Test**: Callout shows 2 / "More than 99", hidden at 0 and when muted, links to the project's Problems view.

- [x] T042 [US5] Create `src/components/notifications/ProblemsCallout.tsx` (server, polite warning `Alert` with `role="status"`, count text with 99+ cap, link to `/p/{slug}/activity?outcome=problems`, `prefetch={false}`); render first in `main` in `src/app/p/[projectSlug]/page.tsx` and `src/app/p/[projectSlug]/posts/page.tsx`
- [x] T043 [US5] Extend `tests/integration/notifications/ui.test.tsx`: callout shown (2, "More than 99"), hidden at 0 and when muted, `role="status"`, link `prefetch` off

---

## Phase 8: User Story 6 — Joining and leaving never leaks (P1)

**Goal**: Membership lifecycle creates, keeps and deletes the state row correctly.

**Independent Test**: Accept an invitation after 20 earlier problems → count 0; remove member → row gone in the same transaction.

- [X] T044 [P] [US6] Test `tests/integration/notifications/membership.test.ts` (project creation row at 0; accept by id/token/sign-up start at current position; remove/leave delete in same transaction; forced failure and last-owner refusal keep the row; project/user delete cascades; rejoin fresh; role change keeps row; count/panel exclude project after removal)
- [X] T045 [P] [US6] Test `tests/integration/notifications/start-migration.test.ts` (run `drizzle/0016_*.sql` twice; every member one row at `max(seq)`; count 0; later event counts 1)

---

## Phase 9: User Story 7 — The refresh is safe (P1)

**Goal**: 60-second visible-only poll that never leaks or marks.

**Independent Test**: Fake timers show polling only while visible; announcements only on increase.

- [X] T046 [P] [US7] Create pure `src/components/notifications/poll.ts` (60 s while visible, one fetch on becoming visible and on `docket:notifications-changed`, failure keeps last count silently, announce only when count rises) and use it in `NotificationBellClient.tsx` with a polite live region; never call `router.refresh()`
- [X] T047 [P] [US7] Test `src/components/notifications/poll.test.ts` (fake timers and visibility, cases in quickstart §1)

---

## Phase 10: Polish & Cross-Cutting

- [x] T048 [P] Test `tests/integration/notifications/performance.test.ts` per quickstart §4 (100k/200k seeded events, medians under 100 ms, `EXPLAIN` uses the two new partial indexes, no seq scan of `activity_events`)
- [x] T049 [P] Extend the secret-scan assertion to cover `/api/me/notifications/recent` (no `details`, tokens or post text)
- [x] T050 [P] Docs: add "Notifications" section to `docs/activity.md` (N1/N2, N4, N5/N6, N7, 60 s refresh, webhooks via `docs/n8n.md`), bell/atoms in `docs/design-system.md` (§6 header, §7 `RelativeTime`, `NotificationList`, `ProblemsCallout`), feature mention in `README.md`; confirm `## 022` exists in `docs/decisions.md`
- [x] T051 Final pass (quickstart §3): `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`; fix every failure
- [ ] T052 🛑 BLOCKED: needs a human with a browser, Docker and a mock provider — run quickstart §5 manual walk-through (60 s refresh without reload, hidden-tab silence, keyboard/Escape focus, no-JS bell, invited-user starts at zero)
- [ ] T053 🛑 BLOCKED: `.claude/skills/docket-ui/SKILL.md` is outside the pipeline's writable paths — operator adds `/notifications` and the bell to its Structure list

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks everything) → stories → Phase 10.
- US1 first (MVP; defines bell, `request.ts`, `NotificationList`, `/notifications`). US2 needs US1's bell/list. US3 needs `request.ts` (T022). US4 needs the `/notifications` page (T024) and `actions.ts` (T031). US5, US6, US7 depend only on Phase 2 (US7 also on the bell client from T021).
- `ui.test.tsx` is extended across US1, US4, US5: do these sequentially.
- Within Phase 2: T006→T007→T008; T009 after T006; T010 independent of T009; T012 after T009/T010; T014 after T012/T013.

## Parallel Examples

- Phase 1: T002, T003, T004 together.
- Phase 2: T011, T013, T015, T016 together once their prerequisites land.
- US2: T027, T028, T029 together.
- US6 tests T044 and T045 together.

## Implementation Strategy

1. Phases 1–2, then US1 for the MVP (count and bell, no JS) and validate with `count.test.ts`, `scope.test.ts`, `ui.test.tsx`.
2. Add US2 and US3 (the P1 interaction), then US6 and US7 (P1 safety), then US4 and US5 (P2).
3. Finish with Phase 10 and the final pass; the BLOCKED tasks are owed, not missing.

---

## Phase 11: Review remediation

- [x] T054 (done by the front end, 2026-10-08: commits 44e5640..15c577a, explicit paths, commitlint clean) Commit the uncommitted 022 implementation as small, logical Conventional Commits (e.g. db schema + migrations, DAL, services, UI, routes, tests, docs), staging explicit paths only (never `git add -A`/`.`/`commit -a`), each ending with the `Co-Authored-By` trailer; then commit each remaining task in this phase the same way — review F1 (BLOCKER), git working tree (e.g. src/server/dal/notifications.ts:1, src/app/notifications/page.tsx:1)
- [x] T055 Add the no-JavaScript "Mark all as read" to `/notifications`: in the "Recent problems" card, when `panel.unread.count > 0`, render a server form posting to `markAllRead` with hidden `returnTo=/notifications`; read `?marked=1` and `&busy=` and show the contracts/ui.md §4 confirmations ("Marked as read." plus "Could not mark {names} as read; try again."); extend `tests/integration/notifications/ui.test.tsx` for the form, its hidden field and both confirmations — review F2 (MAJOR), src/app/notifications/page.tsx:53
- [x] T056 Stop labelling account-less events "Removed account": in `NotificationList` render the account segment (and its " · ") only when `accountName !== null` (panel.ts already supplies "Removed account" for removed accounts), and split the `ui.test.tsx` case into a removed account (`accountName: "Removed account"`) and a two-platform `connect_failed` with `accountName: null` that must not contain "Removed account" — review F3 (MAJOR), src/components/notifications/NotificationList.tsx:30
- [x] T057 Show a failed mute or unmute (review F4, promoted by the front end): redirect the toggle and settings forms with an error query (for example `?notifications=busy|not_found|invalid`) and render it as an `Alert` on both pages, or make them client components with `useActionState`. Add a test for each error. Commit with explicit paths — review F4, src/components/notifications/NotificationToggle.tsx:8
- [ ] T058 Refresh the bell after a view marks a project read (review F5, promoted): on the activity pages, when the view qualifies as a problems view, render a small client leaf that dispatches `docket:notifications-changed` on mount, reusing the event-name constant the panel already uses (one definition only, see F9). Test that the leaf renders exactly when the page marks read. Commit with explicit paths — review F5, src/app/p/[projectSlug]/activity/page.tsx:36
- [ ] T059 Keep keyboard focus after "Mark all as read" in the panel (review F6, promoted): move focus to the panel heading (give it `tabIndex={-1}` and a ref) when the mark succeeds. Test the focus target. Commit with explicit paths — review F6, src/components/notifications/NotificationPanel.tsx:114
- [x] T060 Give the callout the "Problems since you last looked" title and the body from contracts/ui.md §6 (review F7, promoted), and update tests/integration/notifications/ui.test.tsx. Commit with explicit paths — review F7, src/components/notifications/ProblemsCallout.tsx:16
- [ ] T061 Fix the docs (review F10, promoted): in docs/design-system.md the bell sits between Invitations and the user menu (src/components/shell/SignedInHeader.tsx:38-40); add to docs/activity.md: "Docket only notifies you inside Docket; to get problems by email, chat or phone, send its webhooks to a tool such as n8n (see n8n.md)." Commit with explicit paths — review F10, docs/design-system.md:189

Front end note for T055–T061: commit each task's own files by explicit path with a Conventional Commit subject in lower case (commitlint rejects a subject that starts with an upper-case id such as "SC-004"), ending with the Co-Authored-By trailer.

