# Implementation Plan: Problem notifications — an unread-problems bell, a recent-problems panel and a per-project callout

**Branch**: `022-problem-notifications` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/022-problem-notifications/spec.md`

## Summary

This feature tells each signed-in person about new problems in their projects without them going to look. It builds on 020's `activity_events`.

**State (R1, R2, R6).**

- **Storage.** A new project-owned table, `notification_states`, has one row per membership: a `seen_seq` position, a `muted` flag and timestamps. There are no per-event rows.
- **Membership FK.** A composite FK to `member (organization_id, user_id) ON DELETE CASCADE` deletes the row with remove member, leave project, and project or user deletion, in the same statement. A rejoin therefore starts fresh.
- **Starting points.**
  - A row is created with the membership: in `createProject`, and in `MembersRepo.insert` under the existing project lock.
  - A custom migration starts every existing member at the current global `max(seq)`.

**Exact marking (R3).** This closes the P5 bound the spec asked about.

- `ActivityRepo.insert` takes `FOR KEY SHARE` on the project row before drawing `seq`. The FK already takes the same lock, but after `seq`.
- Marking read runs one short transaction per project: `lock_timeout 2s`, project row `FOR UPDATE`, membership re-check, newest attention `seq`, then a `GREATEST` upsert.
- As a result, a problem whose writer started before the mark is waited for and covered. A problem whose writer starts after the mark gets a larger `seq` and counts.
- The design is deadlock-free and forward-only. It does nothing when nothing is new.

**Counting (R4, R5).**

- **Indexes.** Two small partial indexes are added to `activity_events`: member-wide problems by `(project_id, seq)`, and connect failures by `(project_id, actor_user_id, seq)`.
- **The count.** It is one statement over the caller's resolved set, run through `forMyProjects`'s project-set section. Each project contributes two branches, each re-joining `member` and the unmuted state and capped at 100, under an outer cap of 100.
- **The panel.** It reuses 020's outcome/time index with one branch per outcome, limited before the display joins.

**Marking paths (R7–R9).**

- **"Mark all as read"** is a server action.
- **Opening the problems view** means exactly `?outcome=problems` with no other filter and no cursor, on `/p/{slug}/activity` or `/activity`.
  - **Once per request.** The view is detected by a request-cached `ensureProblemsViewMarked()`, called by the header bell before it counts and by both pages before they list. It reads the URL the proxy forwards in `x-docket-path`. The no-JS count is then correct even though the project header renders in the layout.
  - **Prefetches.** Router prefetches (`next-router-prefetch`, `next-router-segment-prefetch`) and browser preloads (`Sec-Purpose`/`Purpose: prefetch`) never mark. Every link to a problems view also sets `prefetch={false}`.

**UI (R10, R12–R16; contracts/ui.md).**

- **The bell.**
  - **Without JavaScript** it is a link to the new `/notifications` page, which carries the same panel, "Mark all as read" and the per-project on/off forms.
  - **With JavaScript** it becomes a disclosure button. Its non-modal panel loads `GET /api/me/notifications/recent` on open.
  - **Refresh.** A pure poller refreshes the count from `GET /api/me/notifications` every 60 s while the tab is visible. It announces politely only when the count rises.
- **The callout.** "Problems since you last looked" (a polite warning `Alert`) heads the project home and Posts.
- **Project settings** gains a "Your notifications" card for every role.
- **New atom.** A `RelativeTime` atom shares `SchedulerHealth`'s relative wording.

**Endpoints (R11; contracts/http.md).** Both are session-cookie only. API keys get 401. They read no input, and send `private, no-store` and `Vary: Cookie`. `/api/me/` joins the auth gate's public prefixes so that the routes answer 401 themselves.

**Docs.** A "Notifications" section in `docs/activity.md` (with webhooks via `docs/n8n.md` for delivery outside Docket), `## 022` in `docs/decisions.md` (this phase), `docs/design-system.md` and the README.

There is no new dependency, environment variable, API operation, webhook, permission or `docker-compose.yml` change.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed.

- **Next.js 16.3.8.**
  - New: `/notifications` (page, loading, error, actions) and two route handlers under `src/app/api/me/notifications/`.
  - Changed: the proxy.
  - Read `node_modules/next/dist/docs/01-app/02-guides/prefetching.md` (F9) and `03-api-reference/03-file-conventions/{route,page,loading,error}.md` and `04-functions/headers.md` before coding (AGENTS.md).
- **React 19.2.8**: `cache()` for the per-request mark; `useActionState` for the panel's action.
- **Drizzle ORM 0.45.3 / drizzle-kit 0.31.11**: a composite `foreignKey` to `member`'s unique index, and partial indexes with `.where(sql\`…\`)`.
- **zod 4.6.5**: the action input schemas.
- **lucide-static 1.52.0**: `bell` and `sliders-horizontal`, through `pnpm icons`.

**Storage**: PostgreSQL 17.

- The new table `notification_states`.
- Two new partial indexes on `activity_events`.
- Migrations `0015` (generated) and `0016_notification_states_start.sql` (custom).
- Column changes to existing tables: none.

**Testing**: Vitest against real Postgres (run-scoped DBs).

- Uses the scope recorder, `tests/helpers/actions.ts` mocks (session, navigation, cache) plus a `next/headers` mock for `x-docket-path` and the prefetch headers, two pooled connections for lock tests, and fake timers for the poller.
- **Suites.** 13 new and 2 extended; the map is in [quickstart.md](./quickstart.md) §1.
- **No DOM environment.** Client logic is tested as pure functions.

**Target Platform**: the existing web container (and worker, unchanged except for the insert lock) on Docker Compose (Unraid) and Neon. Only transaction-scoped Postgres features are used (`SET LOCAL lock_timeout`, row locks), so it is safe behind the transaction-mode pooler.

**Project Type**: the single Next.js app plus worker, in the layout of 001–020.

**Performance Goals**: SC-003.

- With 100,000 events in a project and 200,000 across 20 projects, the header count, the refresh handler and the panel each answer in under 100 ms (median of 5).
- Shown by a seeded timing test that asserts the plan uses the new partial indexes (quickstart §4).

**Constraints**:

- Exactness of marking (FR-005) without any table-wide lock.
- No `OR` in pinned queries, and every statement inside a scope or project-set section.
- No database writes in GET handlers. Marks happen only in actions and in the qualifying page render.
- The header never fails a page.
- No `router.refresh()`, which would re-mark a problems view.
- Times in UTC. The absolute display uses the project zone.

**Scale/Scope**:

| Area | New | Edited |
|---|---|---|
| Schema and migrations | `schema/notifications.ts`, `0015_*`, `0016_notification_states_start.sql` | `schema/index.ts`, `schema/activity.ts` (2 indexes), `db/project-owned.ts` |
| DAL | `dal/notifications.ts` | `dal/activity.ts` (insert lock, `listAttention`), `dal/members.ts`, `dal/projects.ts`, `dal/scope.ts`, `dal/my-projects.ts`, `dal/index.ts` |
| Services | `services/notifications/{index,view-mark,panel}.ts` | `services/activity/index.ts` (factor shared row helpers) |
| Shared lib | `lib/notifications/{attention,text}.ts`, `lib/time/relative.ts` | `lib/auth-gate.ts` |
| Routes | `app/api/me/notifications/route.ts`, `app/api/me/notifications/recent/route.ts`, `app/notifications/{page,loading,error,actions}.tsx/ts` | `app/activity/page.tsx`, `app/p/[projectSlug]/{page,posts/page,activity/page,settings/page,settings/actions}.tsx/ts`, `proxy.ts` |
| UI | `components/notifications/{NotificationBell,NotificationBellClient,NotificationPanel,NotificationList,ProblemsCallout,NotificationToggle}.tsx`, `components/notifications/{poll,request}.ts`, `components/ui/RelativeTime.tsx` | `shell/SignedInHeader.tsx`, `shell/UserMenu.tsx`, `shell/SchedulerHealth.tsx`, `activity/ActivitySummary.tsx`, `scripts/generate-icons.mjs`, `ui/icons.generated.ts` |
| Tests | quickstart §1 | `src/lib/auth-gate.test.ts`, `tests/integration/scheduler-health.test.ts` (unchanged output) |
| Docs | none | `docs/activity.md`, `docs/decisions.md` (this phase), `docs/design-system.md`, `README.md` |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No platform facts. Behaviour is read from the code (research F1–F12). Next's prefetch behaviour and header names were read in `node_modules/next` (F9). The lucide icons and Drizzle abilities were checked in `node_modules`. Postgres lock semantics (`FOR KEY SHARE` vs `FOR UPDATE`, FK checks after row formation, READ COMMITTED per-statement snapshots) are standard documented behaviour, and they are **proved by tests** (quickstart §2) rather than asserted. No `NEEDS RESEARCH`. | PASS |
| II. Nothing is "working" unless it ran | Every FR-023 item maps to a real-Postgres or pure test (quickstart §1). The concurrency claims of R3 are exercised with two connections. SC-003 is a seeded timing test. The manual walk-through (§5) is listed separately and not claimed. | PASS |
| III. Project isolation in one place | `notification_states` joins `projectOwnedTables`. Per-project access goes through `ProjectScope.notifications` (pinned project and the caller's own user id). Cross-project access goes only through `forMyProjects` in a named project-set section, and every statement re-joins `member` for the caller. Routes, actions and pages import services only. Callers never pass a user id. Ids outside the set throw before any SQL. Job-runner and API-key scopes are refused. | PASS |
| IV. One service layer, many callers | One attention rule (two SQL branches plus one pure predicate). One `unreadSummary` serves the header, the refresh endpoint and the panel. One `write()` serves mark, mute and unmute. Panel rows reuse Activity's link, platform and account logic (factored out, not copied). One `NotificationList` serves the popover and `/notifications`. | PASS |
| V. Providers are plug-ins; ambiguous never auto-retried | No provider or scheduler-decision change. Platform names come from the registry. Ambiguous rows only link to Failures. | PASS |
| VI. Boring, few dependencies | No new dependency, infrastructure or environment variable. Polling is a plain `fetch` every 60 s. Lock waits are capped by `SET LOCAL lock_timeout`. | PASS |
| VII. Secrets never leak | Panel and endpoints expose only stored, already-scrubbed messages plus names: no `details`, tokens or post text. Responses are `private, no-store`. The extended secret-scan assertion covers `/api/me/notifications/recent`. | PASS |
| Neon / transaction-mode pooler | Only transaction-scoped features: row locks and `SET LOCAL`. No advisory locks, `LISTEN` or session settings. | PASS |
| Scheduler constraints | `runTick` keeps its bounds. The writer's only change is taking the FK's own `FOR KEY SHARE` one statement earlier: the same lock, row and transaction, so no new lock edge. A mark holds the project row for a few milliseconds, and waits at most 2 s before giving up. No provider call happens in any new transaction. | PASS |
| Times in UTC, Temporal with DST | No wall-time arithmetic is added. Relative text is a difference of instants. The absolute display uses `Intl` with the project zone, as `LocalTime` does. | PASS |
| Accessibility / `docket-ui` | The bell is a labelled link or button with `aria-expanded`. The panel moves focus on open, closes on Escape and returns focus. Live announcements happen only on increase. Statuses are text plus colour. The page uses a real table with `th scope`. Forms work without JavaScript. Loading and error files exist for the new route. No native select. Existing tokens only. | PASS |
| Commits, docs and decisions | This phase commits the plan artifacts and `## 022` in `docs/decisions.md` with explicit paths. Docs updates are planned (quickstart §6). | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:

- one table and two partial indexes;
- one `FOR KEY SHARE` statement in `ActivityRepo.insert`;
- one optional reader method (`listAttention`);
- one `notifications` member on `ProjectScope` and on `ProjectSetScope`;
- one nullable field on `MyProject`;
- one proxy request header;
- one auth-gate prefix.

Existing callers compile and behave as before, and the 020 activity suites and the membership suites guard that.

Two judgement calls carry operational notes, recorded in `docs/decisions.md`:

- the identity sequence must keep `CACHE 1` (R3);
- the callout's `role="status"` is polite but not announced at load by most screen readers, so its first-in-`main` placement is what makes it found (R15).

**Not writable from the pipeline**: `.claude/skills/docket-ui/SKILL.md` is outside the sandbox's writable paths. Adding `/notifications` and the bell to its Structure list is owed to the operator. `docs/design-system.md` carries the change instead.

## Project Structure

### Documentation (this feature)

```text
specs/022-problem-notifications/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F12, decisions R1–R17
├── data-model.md        # Phase 1: notification_states, indexes, migrations, derived concepts, panel item
├── quickstart.md        # Phase 1: test map, concurrency cases, final pass, SC-003 method, walk-through, docs
├── contracts/
│   ├── services.md      # DAL repos/readers, services, request glue, changed call sites, harness use
│   ├── http.md          # GET /api/me/notifications and /recent
│   └── ui.md            # bell, panel, /notifications, actions, callout, RelativeTime, settings card, menu
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
drizzle/
├── 0015_<generated>.sql                       # NEW: notification_states (+PK, member FK cascade, CHECK), 2 partial indexes
├── 0016_notification_states_start.sql         # NEW (custom): every existing member starts at max(seq)
└── meta/                                      # snapshot + journal
src/
├── proxy.ts                                   # + x-docket-path request header
├── lib/
│   ├── auth-gate.ts                           # + "/api/me/" public prefix (route answers 401 itself)
│   ├── notifications/{attention,text}.ts      # NEW pure: attention rule, cap, display/labels/copy
│   └── time/relative.ts                       # NEW pure: relativeTimeText (from SchedulerHealth's ago)
├── server/
│   ├── db/
│   │   ├── schema/notifications.ts            # NEW
│   │   ├── schema/activity.ts                 # + 2 partial indexes
│   │   ├── schema/index.ts, project-owned.ts
│   ├── dal/
│   │   ├── notifications.ts                   # NEW: NotificationsRepo, NotificationsSetReader, newestAttentionSeq, busy error
│   │   ├── activity.ts                        # insert takes FOR KEY SHARE first; listAttention
│   │   ├── members.ts, projects.ts            # state row with the membership
│   │   ├── scope.ts, my-projects.ts, index.ts # notifications on ProjectScope / ProjectSetScope
│   └── services/
│       ├── notifications/{index,view-mark,panel}.ts   # NEW
│       └── activity/index.ts                  # shared row helpers factored out
├── components/
│   ├── notifications/
│   │   ├── NotificationBell.tsx               # NEW server: mark-once, count, render client leaf
│   │   ├── NotificationBellClient.tsx         # NEW client: link → button, badge, live region, poller
│   │   ├── NotificationPanel.tsx              # NEW client: popover, fetch on open, mark all
│   │   ├── NotificationList.tsx               # NEW shared: rows, empty states
│   │   ├── NotificationToggle.tsx             # NEW server: per-project on/off form
│   │   ├── ProblemsCallout.tsx                # NEW server
│   │   ├── poll.ts                            # NEW pure poller + announcement rule
│   │   └── request.ts                         # NEW server-only: ensureProblemsViewMarked (React cache)
│   ├── ui/RelativeTime.tsx                    # NEW atom
│   ├── shell/{SignedInHeader,UserMenu,SchedulerHealth}.tsx
│   └── activity/ActivitySummary.tsx           # prefetch={false} on preset links
└── app/
    ├── api/me/notifications/route.ts          # NEW GET count
    ├── api/me/notifications/recent/route.ts   # NEW GET panel
    ├── notifications/{page,loading,error}.tsx, actions.ts   # NEW
    ├── activity/page.tsx                      # ensureProblemsViewMarked() first
    └── p/[projectSlug]/
        ├── page.tsx, posts/page.tsx           # ProblemsCallout
        ├── activity/page.tsx                  # ensureProblemsViewMarked() first
        └── settings/{page.tsx,actions.ts}     # "Your notifications" card + action
scripts/generate-icons.mjs                     # + bell, slidersHorizontal
tests/
└── integration/notifications/*.test.ts(x)     # NEW (quickstart §1)
docs/
├── activity.md                                # + "Notifications"
├── design-system.md                           # header, atoms
└── decisions.md                               # ## 022 (written in this phase)
```

**Structure Decision**: the existing single-app layout.

- Rules (attention, counting, marking, starting points) live in `src/server/dal/notifications.ts` and `src/server/services/notifications/`.
- Pure vocabulary shared by the server, the client and tests lives in `src/lib/notifications/` and `src/lib/time/`.
- The UI is server components, apart from the bell's client leaf and its panel.

## Complexity Tracking

No violations. Nothing to justify.
