# Implementation Plan: Per-event read state and snooze

**Branch**: `056-per-event-read-snooze` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/042-per-event-read-snooze/spec.md`

## Summary

Keep `notification_states.seen_seq` as a **floor** and add one sparse table, `notification_event_marks`,
holding at most one row per person, project and attention event **above** that floor. Each row carries a
single `counts_again_at` instant: `infinity` means "read for ever", a finite instant means "snoozed until
then". Every read of the state is therefore one comparison against `now()` (N15), so the count stays the
capped, index-backed statement it is today, with one extra primary-key probe per candidate event.

Growth is bounded three ways (N16): a mark can only exist above the floor; every write that moves the floor
deletes every mark at or below the new floor in the same transaction; and a hard cap of 200 marks per person
per project refuses further row actions and points at "Mark all as read". Marking one event read also *pulls
the floor up* as far as the oldest still-uncovered attention event allows, so clearing problems in any order
drains the sparse table rather than filling it.

The row actions reuse the existing exact-marking transaction (R3: `SET LOCAL lock_timeout`, the project row
`FOR UPDATE`, a membership re-check, then the write), so no new deadlock or lost update is possible. They name
an event by its activity id alone; the server resolves which of the caller's projects owns it, inside the
project-set section, and a foreign, non-attention or missing id is the same "not found" (N23).

The UI adds "Mark read" and a `<details>` "Snooze" disclosure with three submit buttons to each row of the one
shared problems list, so both work as plain form posts with no client JavaScript and as in-place
`useActionState` updates with it. The count payload gains `nextChangeAt`, the soonest instant one of the
caller's snoozes runs out, and the poller arms a one-shot refresh for it (N22) — the shape
`realtime-updates` will carry later.

No new dependency, environment variable, infrastructure, public-API operation or UI primitive. One migration
that creates one empty table: an empty table reproduces today's behaviour to the row (N24).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router, standalone)

**Primary Dependencies**: `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4, Better Auth 1.7,
`@js-temporal/polyfill` 0.5 (the snooze's wall-clock maths), Tailwind 4. Nothing added.

**Storage**: Postgres. One new project-owned table (`notification_event_marks`); **no change at all** to
`activity_events` — its two partial attention indexes from R4 already drive every new statement.

**Testing**: Vitest against a real Postgres (`tests/integration/notifications/`), the project-scope harness
(`tests/helpers/scope-check.ts`), the one-date-format lint (`tests/lint/date-format.test.ts`), pure unit
tests for the snooze resolver and the poller.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the connection
string changed. No session-level Postgres features; no new recurring work — a snooze expires by the passage
of time, which every read already compares against.

**Project Type**: web application (one Next.js app; server services + DAL + React components).

**Performance Goals**: SC-006 — with 100 000 events in one project, 200 000 across a person's 20 projects and
the full 200 marks in each, the count, the refresh route and the panel each answer in under 100 ms (the same
budget 022 met without per-event state). The row action is one short locked transaction.

**Constraints**: counting still stops at 100 (N9); the sparse table is capped at 200 rows per person per
project; the count must not join to posts, targets or accounts (N18); the marking SQL keeps 022's rules — no
`OR`, no `NOT` other than `IS NULL`/`IS NOT NULL` anti-joins, every reference pinned to a project, attention
outcomes as SQL literals so the partial indexes match.

**Scale/Scope**: ~20 projects per person, 4 attention outcomes, 10 panel rows, 3 snooze choices. Touches
1 schema file, 1 migration, 3 DAL modules, 2 service modules, 4 `src/lib/notifications` modules, 2 route
handlers, 1 actions file, 1 page and 6 components.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design. No violations; no Complexity Tracking rows.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass** | No platform or library facts are involved, so nothing needs `docs/research/`. Temporal's `disambiguation: "compatible"` is read from the installed polyfill and matches the rule already shipped in `resolveLocalDateTime` (020/queue, research D2). Next 16 App Router usage follows `node_modules/next/dist/docs/01-app/`; the implement phase reads it before touching the route handlers and the server actions. Postgres `'infinity'::timestamptz` and `date_trunc` behaviour is asserted by a test, not assumed. |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement has a Vitest test against real Postgres ([quickstart.md](./quickstart.md)); the browser walk-through is the last task, after everything automated (roadmap rule). |
| III. Project isolation in one place | **Pass** | `notification_event_marks` is registered in `projectOwnedTables` with `scopeColumn: "project_id"`, so the harness fails any statement that touches it unpinned. Every new statement pins `project_id` and joins `member` for the caller; the cross-project ones (count, panel, mark counts, next change, event resolution) run only inside `runForProjectSet` over the caller's own resolved set. No route, action or component imports the database client. Row actions are personal: the `user_id` is always the session's. |
| IV. One service layer, many callers | **Pass** | The bell, the panel, `/notifications`, the callout and both routes call the same `src/server/services/notifications` functions, which call one DAL module. The floor-follow and the prune live in exactly one place (`NotificationsRepo`), used by row actions, "Mark all as read" and the problems views alike. |
| V. Providers are plug-ins | **N/A** | No provider, scheduler, composer or schema change touches providers. |
| VI. Boring, few dependencies | **Pass** | No runtime dependency, no infrastructure, no environment variable, no new UI primitive (`<details>`/`<summary>` is already used in `accounts/page.tsx` and `Composer.tsx`). One new table, no new index on `activity_events`. |
| VII. Secrets never leak | **Pass** | The marks hold a project id, a user id, an event id, a `bigint` and an instant. No message text, token, account or post data. The routes' payloads gain one ISO instant; nothing is logged. The secret-scan test stays green. |
| Engineering: UTC and Temporal | **Pass** | Marks are stored as `timestamptz` in UTC. The two wall-clock choices are resolved once, at the moment of snoozing, through `Temporal.PlainDateTime.toZonedDateTime(zone, { disambiguation: "compatible" })` in the project's zone, and stored as an absolute instant — nothing recomputes them later (N17, FR-009). |
| Engineering: no new recurring work | **Pass** | Expiry is a comparison, not a job. `runTick()` is untouched. |
| Engineering: accessibility, server components | **Pass** | Row actions are real controls in the normal Tab order, named with the problem they act on, working with no JavaScript through a form post, announced politely through `LiveRegion` only on a real change. The list stays a server-renderable component; only the row-action leaf is a client component. Follows the `docket-ui` skill and `docs/design-system.md`; all times go through `formatLocal`/`LocalTime` in the project's zone. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One generated SQL migration creating an empty table; safe on a live install; no existing `notification_states` row altered; no operator action (FR-026, N24). |
| Workflow: docs | **Pass** | FR-028: `docs/decisions.md` records N13–N24 next to N2/N3 plus the plan decisions M1–M18; `docs/activity.md` §Notifications is rewritten for the row actions; `docs/design-system.md` and the `docket-ui` skill get the row-action pattern (no new primitive to list). |

## Project Structure

### Documentation (this feature)

```text
specs/042-per-event-read-snooze/
├── spec.md              # Input
├── plan.md              # This file
├── research.md          # Phase 0: plan decisions M1-M18
├── data-model.md        # Phase 1: the table, the invariants, the statements
├── quickstart.md        # Phase 1: how to run and prove it
├── contracts/
│   ├── http.md          # The two session routes' payloads
│   ├── services.md      # DAL and service signatures
│   └── ui.md            # Row actions, wording, keyboard and announcements
├── checklists/          # Existing
└── tasks.md             # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/notifications/
│   ├── attention.ts            # + EVENT_MARK_CAP = 200
│   ├── snooze.ts               # NEW  the three choices, resolved with Temporal (pure)
│   ├── snooze.test.ts          # NEW  DST gap/overlap, next Monday, always future
│   ├── text.ts                 # + row-action confirmations, at-cap text, row error text
│   └── types.ts                # + UnreadSummary.nextChangeAt, NotificationItem.actionsAvailable
├── server/
│   ├── db/
│   │   ├── schema/notifications.ts   # + notificationEventMarks
│   │   └── project-owned.ts          # + one registry line
│   ├── dal/
│   │   ├── notifications.ts          # marks, floor-follow, prune, cap, nextChangeAt
│   │   ├── activity.ts               # listAttention: exclude snoozed, report readness
│   │   └── my-projects.ts            # set scope: resolveEvent, markEvent, markCounts, nextChangeAt
│   └── services/notifications/
│       ├── index.ts                  # markEventRead, snoozeEvent, summary/panel/mark-all changes
│       └── panel.ts                  # toNotificationItem: isNew from the mark, actionsAvailable
├── app/
│   ├── api/me/notifications/route.ts         # payload gains nextChangeAt
│   ├── api/me/notifications/recent/route.ts  # items gain actionsAvailable, snoozed excluded
│   └── notifications/
│       ├── actions.ts                # NEW markEventRead / snoozeEvent server actions
│       └── page.tsx                  # row-action confirmations and errors (no JavaScript)
└── components/notifications/
    ├── NotificationList.tsx          # renders the row actions
    ├── NotificationRowActions.tsx    # NEW  Mark read + <details> Snooze, JS-optional
    ├── NotificationPanel.tsx         # in-place row updates, mark-all names cleared snoozes
    ├── NotificationBellClient.tsx    # passes the whole summary to the poller
    └── poll.ts                       # one-shot refresh at nextChangeAt

drizzle/
└── 0020_*.sql                        # NEW  create notification_event_marks (+ meta/)

tests/
├── helpers/notifications.ts          # + seed a mark / a snooze / fill to the cap
├── integration/notifications/
│   ├── marks.test.ts                 # NEW  count mixes, floor-follow, pruning
│   ├── cap.test.ts                   # NEW  the 200 bound, per project, surfaced and refused
│   ├── snooze.test.ts                # NEW  expiry, retried target, floor wins, next change
│   └── count|mark-all|mark-read|membership|routes|scope|performance|ui   # extended
└── lint/date-format.test.ts          # unchanged; the snooze wording must pass it

docs/
├── decisions.md        # N13-N24 next to N2/N3; plan decisions M1-M18
├── activity.md         # Notifications section rewritten
└── design-system.md    # the row-action pattern in a list
.claude/skills/docket-ui/SKILL.md     # the same pattern, for later UI work
```

**Structure Decision**: the existing single Next.js app. This feature adds no directory: the state lives in
`src/server/db/schema/notifications.ts` and `src/server/dal/notifications.ts`, the rules in
`src/lib/notifications/`, the callers in `src/server/services/notifications/`, and the UI inside the existing
`src/components/notifications/` folder — exactly where 022 put the same concerns.

## Phase 0 — Research

No external facts to fetch and no `NEEDS CLARIFICATION` in the Technical Context: the spec resolved every
judgement call it needed (N13–N24) and the rest are design choices about this repository's own code.
[research.md](./research.md) records the eighteen plan decisions (M1–M18), the alternatives rejected, and the
two places where the plan deliberately differs in wording from the spec's illustrations.

## Phase 1 — Design

- [data-model.md](./data-model.md): the new table, its keys, its checks, the four invariants, the migration,
  and the exact shape of every statement that changes.
- [contracts/http.md](./contracts/http.md): the two session routes.
- [contracts/services.md](./contracts/services.md): DAL and service signatures, errors and outcomes.
- [contracts/ui.md](./contracts/ui.md): the row actions, their wording, keyboard behaviour and announcements,
  with and without client JavaScript.
- [quickstart.md](./quickstart.md): how to run it and the checks that prove each user story.

**Post-design Constitution re-check**: still passing. The design adds one table, no dependency, no
environment variable and no index on the log; isolation is enforced by the registry plus the existing
project-set section; one DAL module owns the floor-follow and the prune; every new instant goes through
`formatLocal`; no secret or message text enters the new table or the new payload fields.

## Complexity Tracking

No constitution violation to justify.
