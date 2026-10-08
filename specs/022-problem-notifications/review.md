# Review: Problem notifications — an unread-problems bell, a recent-problems panel and a per-project callout

Reviewed 79 file(s) of implementation (33 modified, 46 new, including `tasks.md`), on top of 2 commits (`03ffe93` spec, `0b7becb` plan), against `9e9ac5f...HEAD` plus the working tree. **None of the implementation is committed.** The branch holds only the spec and plan commits, so the code was reviewed as it stands in the working tree (`git diff 9e9ac5f` plus untracked files), not as a commit diff.

- **Read in full:**
  - schema, migrations and DAL: `src/server/db/schema/notifications.ts`, `drizzle/0015_massive_ezekiel.sql`, `drizzle/0016_notification_states_start.sql`, `src/server/dal/notifications.ts`, and the diffs of `src/server/dal/{activity,my-projects,scope,members,projects,index}.ts`, `src/server/db/{project-owned,schema/activity,schema/index}.ts`;
  - services: `src/server/services/notifications/{index,panel,view-mark}.ts` and the `src/server/services/activity/index.ts` diff;
  - shared pure code: `src/lib/notifications/{attention,text,types}.ts`, `src/lib/time/relative.ts`;
  - components: every file in `src/components/notifications/`, `src/components/ui/RelativeTime.tsx`, and the diffs of `src/components/shell/{SignedInHeader,UserMenu,SchedulerHealth}.tsx` and `src/components/activity/ActivitySummary.tsx`;
  - routes and pages: both route handlers under `src/app/api/me/notifications/`, `src/app/notifications/{page,actions,loading,error}`, the diffs of the five changed pages and `settings/actions.ts`, `src/proxy.ts`, `src/lib/auth-gate.ts`;
  - tests: `tests/integration/notifications/{count,mark-read,membership,mute,scope,routes,view-mark,ui,start-migration,performance}.test.ts(x)`, `src/server/services/notifications/view-mark.test.ts`, `tests/helpers/notifications.ts`, and the diffs of the test files that changed;
  - docs: the diffs of `docs/activity.md`, `docs/design-system.md` and `README.md`.
- **Read for cross-checks:** `src/components/activity/{ActivityFilters,ActivityRow}.tsx`, `src/components/ui/FilterTabs.tsx`, `src/server/services/activity/classify.ts`, the connect-failed call sites in `src/server/services/{connect,accounts}.ts`, `tests/helpers/factories.ts`, `.specify/extensions.yml`.
- **Sampled (signatures and assertions only):** `tests/integration/notifications/mark-all.test.ts`, `src/components/notifications/poll.test.ts`, `src/lib/notifications/{attention,text}.test.ts`, `src/lib/time/relative.test.ts`, and `docs/decisions.md` (only checked that `## 022` and N1–N12 are there).
- **Not reviewed:**
  - `drizzle/meta/0015_snapshot.json`, `drizzle/meta/0016_snapshot.json`, `src/components/ui/icons.generated.ts`: all generated. Implement reports `pnpm db:check` clean.
  - `scripts/generate-icons.mjs`: two added icon names.
- **Probe run:** `pnpm vitest run tests/integration/notifications/performance.test.ts` passed, 2 of 2, in 19.7 s. Following the constitution, I did not re-run the full suite, lint, typecheck or build.

## Verdict

The core of the feature is right and hangs together well.

- **Read state.** The `notification_states` table and its FK cascade to `member` do what the spec asks.
- **Marking.** The R3 locking makes marking exact, and two-connection tests in `mark-read.test.ts` prove it.
- **Counting.** The count runs as one capped statement inside the project-set section, and it re-checks membership and mute itself.
- **Prefetches.** The view mark is guarded against them.
- **Membership.** All three join paths create the starting position, and removal, leave and both cascades delete it. Membership is tested on the real flows.
- **Refresh.** The poller matches FR-016, and the endpoints are session-only and `no-store`.

It is not ready to merge, for three reasons.

1. **None of the implementation is committed** (F1). There is nothing on the branch to push, run CI on or merge. The constitution requires a commit per task.
2. **"Mark all as read" does not work without JavaScript** (F2). The `/notifications` page, which the no-JS bell links to, has no "Mark all as read" form. The action's `returnTo` redirect exists and is tested, but nothing in the UI uses it, so FR-014 and SC-007 are only partly met.
3. **The panel labels connect failures "Removed account"** (F3). The panel builder uses `null` to mean "no account". The list component renders `null` as "Removed account". So every failed OAuth or paste connect, which is the one attention kind shown only to the person who tried it, says "Removed account", unlike Activity. A test asserts this.

All three are small, mechanical fixes. Remediation tasks T054–T056 are appended to `tasks.md`. The minor findings below can ship and be fixed later.

## Findings

- [ ] 🛑 BLOCKER F1 — The whole implementation is uncommitted; the branch holds only the spec and plan commits
      where:  git working tree (33 modified, 46 untracked paths, e.g. src/server/dal/notifications.ts:1, src/app/notifications/page.tsx:1); .specify/extensions.yml:149 (the `after_implement` commit hook is optional and did not run)
      why:    `git log 9e9ac5f..HEAD` shows only `03ffe93` (spec) and `0b7becb` (plan). Every source, test, migration and doc change is uncommitted. The constitution's Development Workflow says to commit after each completed task with explicit-path Conventional Commits. Its quality gates need CI on the pushed branch, and semantic-release needs `feat:`/`fix:` commits. As things stand, nothing can be pushed, CI cannot run on the work, and a merge would ship nothing. 020 landed as per-area commits (`50d67f5`, `16e03c3`, `11bf52e`, …); 022 has none.
      owed:   Commit the implementation in small, logical Conventional Commits (for example db/schema+migrations, DAL, services, UI, routes, tests, docs), staging explicit paths only, never `git add -A` or `.`. End each commit with the Co-Authored-By trailer. Then commit the remediation in this phase the same way.
      traces: Constitution · Development Workflow (Commits, Quality gates)

- [ ] MAJOR F2 — "Mark all as read" cannot be used without JavaScript: `/notifications` has no Mark-all form, and its `marked`/`busy` confirmations are never shown
      where:  src/app/notifications/page.tsx:53-66 (the "Recent problems" card has only "View all problems"), src/app/notifications/page.tsx:31 (only `?changed` is read); src/app/notifications/actions.ts:31 (the `returnTo=/notifications` redirect is reachable only from tests/integration/notifications/mark-all.test.ts:61-67); src/components/notifications/NotificationPanel.tsx:114-120 (the only Mark-all form, rendered only after hydration)
      why:    Without JavaScript the bell is `<a href="/notifications">` (NotificationBellClient.tsx:79-85), and the panel with its form never renders. FR-014 says "Mark all as read" MUST work without client JavaScript. SC-007 requires the same for marking read. US2's independent test repeats the flow with JavaScript disabled. contracts/ui.md §4 puts `[Mark all as read] (form with returnTo=/notifications)` in this card, with the "Marked as read." and "Could not mark Acme as read; try again." confirmations. The T031 pass built the redirect for this. The T024 pass built the page without the form. So the redirect is a dead end, and T024's "no-JS fallbacks per contracts/ui.md §4" is ticked but not done.
      owed:   In the "Recent problems" card, when `panel.unread.count > 0`, render a server form posting to `markAllRead` with a hidden `returnTo=/notifications`. The action already has the `(prev, formData)` signature, so either wrap it the way NotificationToggle does or bind it. Read `?marked=1` (and `&busy=`) and show `Alert tone="success"` with "Marked as read." plus the busy wording from contracts/ui.md §4. Extend tests/integration/notifications/ui.test.tsx to cover the form, its hidden field, and both confirmations.
      traces: FR-014, FR-012, SC-007, US2 (independent test, no-JS), contracts/ui.md §4, R13

- [ ] MAJOR F3 — Every connect failure in the panel and on `/notifications` is labelled "Removed account", because the producer and the consumer read `accountName: null` differently
      where:  src/components/notifications/NotificationList.tsx:30 (`item.accountName ?? "Removed account"`); src/server/services/notifications/panel.ts:19 (`recordAccount(record)?.name ?? null`: null means *no account*, and a removed account is already the string "Removed account" via src/server/services/activity/index.ts:82-90); src/server/services/connect.ts:336-345 and :409-418 (OAuth and paste connect failures carry no `accountId`); src/components/activity/ActivityRow.tsx:62 (Activity shows no account line in this case); tests/integration/notifications/ui.test.tsx:85-88 (asserts "Removed account" for `accountName: null`)
      why:    The data model (§4) defines `accountName` as `"Removed account"` when removed, and `null` for a group connect failure. panel.ts follows that. NotificationList, written in a different pass, treats `null` as removed. Connect failed is the one attention kind shown only to the person who tried the connect (N1). So when someone's Facebook/Instagram OAuth or a pasted token fails, their own bell shows "Facebook and Instagram · Removed account" for an account that never existed. That contradicts FR-011, which wants the account name or "Removed account" for an account, and the edge case, which wants the panel to match Activity. The test bakes the wrong reading in.
      owed:   In NotificationList, render the account segment (and its " · " separator) only when `accountName !== null`; panel.ts already supplies "Removed account" for removed accounts. In ui.test.tsx, split the case: a removed account (`accountName: "Removed account"`) still shows "Removed account". A connect failure (`outcome: "connect_failed"`, `accountName: null`, two platforms) shows "Facebook and Instagram" and does not contain "Removed account".
      traces: FR-011, Edge Cases (removed account; platform-group connect failure), data-model §4

- [ ] MINOR F4 — A failed mute or unmute (busy lock, not found, bad input) is silently discarded; the person sees no message
      where:  src/components/notifications/NotificationToggle.tsx:8-11; src/app/p/[projectSlug]/settings/page.tsx:56-60
      why:    Both forms wrap the action in an inline server action that `await`s it and drops the returned `ActionResult`. On `NotificationsBusyError` (the 2 s lock timeout, src/server/dal/notifications.ts:164) the page re-renders unchanged, with no "Could not save. Try again." (research R3, R13). It fails safe: the On/Off badge still shows the real state.
      owed:   Make the forms client components with `useActionState`, or redirect with an error query (for example `?error=busy`) and render it as an `Alert`.
      traces: FR-008, research R3/R13

- [ ] MINOR F5 — With JavaScript, following the callout to a project's Problems view leaves the bell showing the old count for up to 60 s
      where:  src/app/p/[projectSlug]/activity/page.tsx:36 (marks read); src/app/p/[projectSlug]/layout.tsx:45 (the header lives in the layout, which a client-side navigation inside the project does not re-render); no dispatch of `docket:notifications-changed` outside src/components/notifications/NotificationPanel.tsx:51
      why:    The server state is right, and the no-JS count is right because a full load re-renders the layout (R8). With JavaScript, `/p/a` → "See the problems" is a soft navigation. The page marks A read, but the layout's bell keeps its `initial` until the next poll, so the person looks at the problems while the bell still says "2". `/activity` is unaffected because it renders its own header.
      owed:   When the view qualifies, render a tiny client leaf on the activity pages that dispatches `docket:notifications-changed` on mount. The poller already refreshes on that event.
      traces: US3, US5-AS3, FR-016

- [ ] MINOR F6 — After "Mark all as read" in the panel, keyboard focus is lost
      where:  src/components/notifications/NotificationPanel.tsx:114-120
      why:    The form only renders while `unread > 0`. A successful mark sets `unread` to 0 and unmounts the focused submit button, so focus falls to `<body>`. The panel stays open, but the next Tab starts from the top of the page.
      owed:   Move focus to the panel heading (`heading.current?.focus()`) when the mark succeeds, or keep the button and disable it.
      traces: FR-013

- [ ] MINOR F7 — The callout has no "Problems since you last looked" title, and its wording differs from the spec and contract
      where:  src/components/notifications/ProblemsCallout.tsx:16-22; tests/integration/notifications/ui.test.tsx:177
      why:    US5-AS1 and FR-017 describe a callout *titled* "Problems since you last looked" that says "2 problems". contracts/ui.md §6 specifies that title, then "2 problems in Acme. View problems". The component renders one line, "2 problems since you last looked. See the problems". The meaning and the polite `role="status"` are right; the title and link text are not.
      owed:   Render the title and body as contracts/ui.md §6 specifies, and update the test strings.
      traces: FR-017, US5-AS1, research R15

- [ ] MINOR F8 — Test integrity: the "API key" and "expired session" refresh cases only test the mocked no-session case, and the page wiring of the view mark is never rendered
      where:  tests/integration/notifications/routes.test.ts:27-35 (`actAs(null)` plus a Bearer header: the handler never sees the header, so this is the no-session case again; there is no expired-session case); tests/integration/notifications/view-mark.test.ts:42-45, :85-91 (calls `ensureProblemsViewMarked()` directly; never renders `src/app/p/[projectSlug]/activity/page.tsx`, `src/app/activity/page.tsx` or `NotificationBell`, so the "header count in the same request" case just counts again afterwards)
      why:    FR-023 asks for the refresh's authentication cases "none, expired, API key". quickstart §1 says the expired case uses a real Better Auth session row (`helpers/auth.ts`), and that the problems view is tested by rendering the pages and the layout under a prefetch header. The behaviour is correct by construction: no bearer plugin is configured, and both pages call `ensureProblemsViewMarked()` first (page.tsx:36, activity/page.tsx:34). But a later change to session handling or to the page wiring would not fail any test.
      owed:   Add an expired-session case through the real `getSession` with a past `expires_at`. Render the two activity pages (and `NotificationBell`) under the `next/headers` mock, and assert the mark and the in-request header count.
      traces: FR-023, FR-015, FR-006, quickstart §1

- [ ] MINOR F9 — Two pieces were implemented twice by different passes
      where:  src/components/notifications/poll.ts:4 and src/components/notifications/NotificationPanel.tsx:16 (`"docket:notifications-changed"` declared twice); src/app/p/[projectSlug]/settings/page.tsx:56-68 repeats src/components/notifications/NotificationToggle.tsx:5-19 (the same hidden fields and the same button with sr-only " notifications for {name}")
      why:    If the event name is changed in one place, the poller silently stops hearing the panel. The two on/off forms can drift in copy and accessible name. Constitution IV prefers one implementation.
      owed:   Import `CHANGED_EVENT` from `poll.ts` in the panel. Give `NotificationToggle` an `action` prop, or a settings variant, and use it on the settings card.
      traces: Constitution IV

- [ ] MINOR F10 — The docs misplace the bell and do not quite say what FR-022 asks
      where:  docs/design-system.md:189 ("between the project switcher and the user menu"; it sits between Invitations and the user menu, src/components/shell/SignedInHeader.tsx:38-40); docs/activity.md:63 ("Webhooks for the same events are described in n8n; notifications are the in-app view")
      why:    FR-022 asks the Notifications section to state that delivery outside Docket (email, chat, phones) is done with webhooks, linking to `docs/n8n.md`. The section links n8n but never says that. The `/notifications` page does say it (src/app/notifications/page.tsx:94-96).
      owed:   Correct the header position in design-system.md. Add one sentence to docs/activity.md: "Docket only notifies you inside Docket; to get problems by email, chat or phone, send its webhooks to a tool such as n8n (see n8n.md)."
      traces: FR-022

- NOTE F11 — The panel's 100 ms budget has little margin. Run alone, `tests/integration/notifications/performance.test.ts:111-113` passed both cases for me. Implement reported the 20-project `recentPanel` at 120 ms and 168 ms in earlier runs, and failing under the full parallel `pnpm test`. SC-003 only budgets the count and the refresh, which have margin; the panel budget comes from the plan. If CI flakes on line 113, the fix is either the test's budget or `listAttention`'s plan (src/server/dal/activity.ts:242-258). It is not a reason to lower the count/refresh assertions.
- NOTE F12 — The Activity filter's own "Problems" tab (src/components/activity/ActivityFilters.tsx:53 → src/components/ui/FilterTabs.tsx:15) is a `Link` with the default prefetch. R9 said every problems-view link would set `prefetch={false}` as a second layer. The first layer, the header guard (src/server/services/notifications/view-mark.ts:40-43, src/components/notifications/request.ts:16), is what stops a prefetch from marking, and it is tested. So this is defence in depth, not a defect.
- NOTE F13 — `recent()` (src/server/dal/my-projects.ts:99) filters mutes from the resolved set only. Unlike `countUnread` (src/server/dal/notifications.ts:79), its SQL does not re-check `muted = false`, which contracts/services.md §1.5 says both do. It also includes projects with no state row, which the count excludes (my-projects.ts:84). Both gaps are reachable only by a mute committed mid-request, or by a membership written outside the DAL. Worth aligning when F3 touches this area; harmless today.
- NOTE F14 — Implement's own report says the full `pnpm test` was not re-run after its last fixes (8 failures, then files re-run in isolation). CI on the first push (after F1) is the first full run of this code.
- NOTE F15 — T052 (the manual browser walk-through, quickstart §5) and T053 (the `docket-ui` SKILL.md Structure list) are 🛑 BLOCKED and owed to a human. They are correctly left unticked.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-023) | 23 | 19 | 4 (FR-011 F3, FR-014 F2, FR-022 F10, FR-023 F8) | 0 | 0 |
| Success criteria (SC-001–SC-007) | 7 | 6 | 1 (SC-007 F2) | 0 | 0 |
| User stories (US1–US7) | 7 | 6 | 1 (US2 F2, F3) | 0 | 0 |
| Plan decisions (R1–R17) | 17 | 14 | 3 (R9 F12, R13 F2, R15 F7) | 0 | 0 |
| Constitution principles and constraints (I–VII, Neon pooler, scheduler, UTC/Temporal, accessibility, commits, docs) | 13 | 11 | 1 (docs F10) | 0 | 1 (commits F1) |

How each "satisfied" FR was checked:

- **FR-001, FR-019.** `notification_states` with a PK and a composite FK to `member` with `ON DELETE CASCADE` (drizzle/0015_massive_ezekiel.sql:1-12). Exercised by membership.test.ts:99-166.
- **FR-002, FR-003, FR-004.**
  - The SQL is two literal-outcome branches with no `OR`, re-joining `member` and the unmuted state, each `LIMIT`ed under an outer cap (notifications.ts:78-91, :171-179), run inside `runForProjectSet` (my-projects.ts:98).
  - Tests: count.test.ts and scope.test.ts. The scope harness reported no violations.
- **FR-005, FR-006.**
  - The insert takes `FOR KEY SHARE` before `seq` (activity.ts:307). The mark uses `FOR UPDATE`, re-checks membership, reads the newest position, then does a `GREATEST` upsert (notifications.ts:136-167).
  - Tests: mark-read.test.ts cases 1–4. The prefetch guard and the qualifying URLs: view-mark.ts and view-mark.test.ts.
- **FR-007, FR-009.** Unmute marks read (services/notifications/index.ts:76, :85). Foreign and unknown slugs give the same `not_found` (mute.test.ts:94-102).
- **FR-008.** `/notifications` table with `th scope`, plus the settings card for every role. Linked from UserMenu.tsx:35 and NotificationPanel.tsx:124.
- **FR-010, FR-013, FR-016.**
  - Bell placement in SignedInHeader.tsx:39. Badge and labels in text.ts, tested in ui.test.tsx:40-57.
  - Disclosure, Escape and focus in NotificationBellClient.tsx:44-104 and NotificationPanel.tsx:26-28.
  - Poller in poll.ts:27-72.
- **FR-012.** Footer links and empty states in NotificationPanel.tsx:79-127.
- **FR-015.** Route handlers that read no input and send `private, no-store` and `Vary: Cookie`, and the `/api/me/` prefix in auth-gate.ts:6.
- **FR-017.** Callout on both screens, `role="status"`, hidden at zero and when muted. Copy aside (F7).
- **FR-018.** members.ts:62, projects.ts:49, plus membership.test.ts:52-89.
- **FR-020.** drizzle/0016_notification_states_start.sql, run twice in start-migration.test.ts.
- **FR-021.** Only two partial indexes, the insert lock, a new reader method and `prefetch={false}`. `list` and `summary` SQL is unchanged (activity.ts:97-185).

## What I could not check

- **Anything in a browser.** That covers:
  - the 60-second refresh without a reload, and silence while the tab is hidden;
  - the panel's real focus behaviour and screen-reader announcements;
  - the no-JS bell link;
  - whether Next 16.3.8's real prefetch requests carry the `next-router-prefetch` / `next-router-segment-prefetch` headers that the guard expects. Research F9 and the pure tests cover the header names, not live traffic.

  This is T052, owed to a human.
- **The F5 staleness was found by reading the code.** I reasoned that a soft navigation inside `/p/[slug]` does not re-render the layout; I did not watch it happen in a browser.
- **The full `pnpm test`, lint, typecheck, build and `db:check`.** I did not re-run them, per the constitution's review rule. I rely on implement's report (lint, typecheck, `db:check` and build clean; the full suite not re-run after its last fixes) and on CI, which cannot run until F1 is fixed.
- **Lock behaviour under production load.** That includes how long the mark's 2 s `lock_timeout` waits are behind real `runTick` and upload traffic, and the effect on page render time of `markProblemsView` iterating projects one after another (services/notifications/index.ts:62-68). The tests cover correctness, not contention.
- **Migration 0015 builds its two indexes without `CONCURRENTLY`** on `activity_events`, which blocks event writes for the build's duration on a large install. I did not measure how long that takes on real data.
- **`.claude/skills/docket-ui/SKILL.md`** is outside this phase's write and review scope (T053).
