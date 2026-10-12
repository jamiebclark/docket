# Implementation Plan: Per-kind and per-platform notification preferences

**Branch**: `057-notification-preferences` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/043-notification-preferences/spec.md`

## Summary

Replace `notification_states.muted` with one sparse table, `notification_preferences`: one row per
switch a person has touched for one project, where a switch is an attention kind (the four from N1) or
a platform (a provider key). One nullable column carries all three states — **no row** means the switch
is on with no position of its own, **NULL** means off, and **a value** means "on, and only events after
this position may notify through me" (N27, N35, plan decision Q2). That makes the defaults a fact about
the database rather than a rule every writer has to remember, and it makes the migration a no-op for
every unmuted row.

The eligibility rule — *may this event notify this person?* — is stated once, purely, in
`src/lib/notifications/eligibility.ts`: above the project floor, the kind's switch allows it, and either
the event records no platform or at least one platform it records allows it (FR-003, N28–N30). That
module is what `email-delivery` imports unchanged (FR-014), and `compileEligibility()` is the only input
the SQL builder takes, so the two cannot drift without failing a test.

The SQL stays the capped, index-backed statement it is today. The kind axis is compiled **into the
branch list** — an off kind emits no branch at all, and on kinds are grouped by position with the
outcome list as literals, so the no-preferences case is exactly the statement shipping now (Q5). The
platform axis is one correlated comparison over `unnest(provider_keys)` against a literal map of the
person's platform switches, which expresses "any platform on", "all off" and "none recorded" in a single
comparison with no `OR` and no `NOT` — 022's SQL rules intact (Q6).

Writes reuse R3's transaction verbatim (`SET LOCAL lock_timeout`, the project row `FOR UPDATE`, a
membership re-check, then the write), so the lock order, the absence of deadlocks and the "busy, nothing
written, try again" failure mode are the ones already specified and tested. Turning a switch on records
the newest attention position with that switch and prunes the sparse marks it makes redundant, in the
same transaction (N35, N36); turning one off writes nothing else at all — no position, nothing marked
read, nothing pruned (FR-007). No switch write ever touches `seen_seq`, so "Mark all as read" and the
two problems views remain the only things that move the floor, still covering switched-off kinds and
platforms exactly as N4.1 covered muted projects (N37).

The personal `/notifications` page becomes a six-column grid — one `RowGroup` per project with the four
kinds as columns, a `<details>` platform disclosure in a full-width detail row, and "Turn all off" /
"Turn all on" beside them — and the same per-project control, from the same component, is the "Your
notifications" card on each project's settings page for every member role. Each switch is one form
holding one state-showing submit button, because a checkbox cannot save itself without client JavaScript
and FR-017 requires every change to save and confirm without it (Q18).

One migration: create the table, turn every `muted = true` row into all four kinds off, drop the column
(N26). No reading position, timestamp or sparse mark is touched, and no operator step is needed. No new
dependency, environment variable, infrastructure, route, public-API operation, recurring work or index
on the activity log.

**What this entry does not do**, and who owns it: quiet hours and any email, mailer, digest or delivery
cadence — `email-delivery` (entry 3); real-time transport, with the 60-second refresh staying exactly as
it is — `realtime-updates` (entry 4); changes to which outcomes are attention events — nothing in this
roadmap, N1 stands. Also out: a kind × platform matrix, per-account preferences, an account-wide
preference spanning projects, and any view of or control over anyone else's preferences (FR-026).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router,
standalone output)

**Primary Dependencies**: `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4, Better Auth 1.7,
Tailwind 4. **Nothing added** (constitution VI). `@js-temporal/polyfill` is not needed here: a switch
carries a `seq` position, not a wall-clock time.

**Storage**: Postgres. One new project-owned table (`notification_preferences`); one column dropped
(`notification_states.muted`); **no change at all** to `activity_events` — its two R4 partial attention
indexes still drive every statement, and its `cardinality(provider_keys) >= 1` CHECK is left alone.

**Testing**: Vitest against a real Postgres (`tests/integration/notifications/`), the project-scope
harness (`tests/helpers/scope-check.ts`), the one-date-format lint
(`tests/lint/date-format.test.ts`), a self-contained migration test that builds and drops its own
database (the `marks-migration.test.ts` pattern), and pure unit tests for the eligibility module and
the new wording.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the
connection string changed. No session-level Postgres features; no new recurring work — a preference
takes effect on the next read, and the fresh-start position is written by the request that flips the
switch.

**Project Type**: web application (one Next.js app; server services + DAL + React server components).

**Performance Goals**: SC-007 — with 100 000 events in a project and 200 000 across a person's 20
projects, the count, the refresh route and the panel each stay under 100 ms, including for a person who
has four kind switches and every platform switched off (the worst case for the platform clause; Q7
names the fallback if the budget is missed).

**Constraints**: counting still stops at 100 and displays "99+" (N9); the sparse-mark cap stays 200 per
person per project (N16); 022's SQL rules hold in every new statement — no `OR`, no `NOT` other than
`IS NULL`/`IS NOT NULL`, every reference pinned to a project, attention outcomes written as SQL
literals so the partial indexes match; preferences gate notifications only, never Activity, the public
API or webhooks (FR-013).

**Scale/Scope**: 4 kinds (fixed), ≤ 7 registered platforms, ~20 projects per person, so ≤ 11 preference
rows per person per project. Touches 1 schema file, 1 migration, 1 new pure module, 4 DAL modules,
2 service modules, 2 `src/lib/notifications` modules, 2 pages, 2 action files, 3 components (2 new),
~14 test files and 4 docs.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design. No violations; no Complexity
Tracking rows.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass** | No platform or library fact is involved, so nothing needs `docs/research/` and nothing is `NEEDS RESEARCH`. Drizzle builders and the `GREATEST`-in-upsert form are read from the installed package and from the identical code already shipping in `src/server/dal/notifications.ts`; Next 16 App Router usage follows `node_modules/next/dist/docs/01-app/`, which the implement phase reads before touching the pages and actions. The Postgres behaviour the rule leans on (`GREATEST` and `min()` ignoring NULLs, `coalesce` over an empty aggregate, `unnest` over `text[]`) is **asserted by a test**, not assumed. |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement has a Vitest check against real Postgres ([quickstart.md](./quickstart.md) §3); no credential is involved anywhere, so nothing is "verified with mocks only". The browser and visual-judgement walk-through is the last task in `tasks.md`, after everything automated (roadmap rule). |
| III. Project isolation in one place | **Pass** | `notification_preferences` is registered in `projectOwnedTables` with `scopeColumn: "project_id"`, so the harness fails any statement that touches it unpinned. Every new statement pins `project_id` and joins `member` for the caller; the cross-project ones (the count, the panel, the preference and platform maps, `nextChangeAt`) run only inside `runForProjectSet` over the caller's own resolved set. No route, action or component imports the database client. A preference is always the session's own `user_id` — there is no code path that takes a user id from input (FR-020, N41). |
| IV. One service layer, many callers | **Pass** | The bell, the panel, `/notifications`, the callout, the project settings card and both routes ask one question through one module (`eligibility.ts`) and one DAL module, so they cannot disagree (FR-010). The switch write lives in exactly one place (`NotificationsRepo.setSwitches`), used by the grid and the settings card alike. |
| V. Providers are plug-ins | **Pass** | The platform axis is keyed by provider key and read from the registry through `platformOptions()`. A platform added by a later release is on for everyone with no row and no migration (N27); the switch list is never a hard-coded array; the `platform` key column is deliberately **not** constrained to the registry so a stored switch outlives a provider being disabled (FR-019). `mock` follows the same enabled-only rule Activity's filter already uses. |
| VI. Boring, few dependencies | **Pass** | No runtime dependency, no infrastructure, no environment variable, no `docker-compose.yml` change, no new UI primitive (`Table`, `Button`, `Card`, `Alert`, `Badge`, `<details>` all exist). One new table, one dropped column, no new index on the log. |
| VII. Secrets never leak | **Pass** | A preference row holds a project id, a user id, two short lowercase keys and a `bigint`. No token, credential, recipient address, account name, post text or message. No payload field is added to either route. The secret-scanning test is unaffected and stays green (spec Assumptions). |
| Engineering: UTC and Temporal | **N/A → Pass** | Nothing here stores or converts a wall-clock time. A switch's position is an `activity_events.seq`, which R2 already chose over a timestamp for exactly this reason. The only instant involved is `nextChangeAt`, which is unchanged in kind and still formatted to whole-millisecond ISO. |
| Engineering: no new recurring work | **Pass** | `runTick()` is untouched. A preference takes effect on the next read; the fresh-start position is written by the same request that flips the switch. |
| Engineering: accessibility, server components | **Pass** | Every control is a real `<button>` in a server-rendered form: keyboard-operable, visibly focused, named with the project and the switch, with state as text as well as colour, and fully working with client JavaScript unavailable — including the `<details>` platform disclosure. Nothing on either screen becomes a client component. Follows `docs/design-system.md` and the `docket-ui` skill; the two deliberate extensions to the design doc (Q18, Q19) are written into it in the same change, as §"Code follows this file" requires. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One migration (0021): create the table, migrate every `muted = true` row to all-kinds-off, drop the column — in that order, because the data step must read `muted` first. Safe on a live install with existing rows, no operator step, no notification state reset, and no `seen_seq`, `seen_at` or sparse mark altered (FR-023, FR-024). The reversal, including the fate of the data, is recorded next to N5/N26. |
| Workflow: docs | **Pass** | FR-025/FR-026: `docs/decisions.md` gets N25–N41 next to N5, N6 and N10 and the plan decisions Q1–Q24 next to 022's R1, R4, R5 and R14; `docs/activity.md` §Notifications replaces its "Muting" bullet with the preferences, the roll-up, the one-click controls and the fresh-start rule; `docs/design-system.md` §7 and the `docket-ui` skill gain the switch and the grid patterns. Each doc also says what this entry does not do and which later entry owns it. |

## Project Structure

### Documentation (this feature)

```text
specs/043-notification-preferences/
├── spec.md              # Input
├── plan.md              # This file
├── research.md          # Phase 0: plan decisions Q1-Q24
├── data-model.md        # Phase 1: the table, the invariants, the rule, the statements, the migration
├── quickstart.md        # Phase 1: how to run it and the checks that prove each story
├── contracts/
│   ├── http.md          # The two session routes and the two pages (no new route)
│   ├── services.md      # The pure rule, DAL and service signatures, errors, wording
│   └── ui.md            # The switch, the grid, the settings card, wording, accessibility
├── checklists/          # Existing
└── tasks.md             # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/notifications/
│   ├── eligibility.ts          # NEW  the one rule: thresholds, mayNotify, the roll-up, the compiled plan
│   ├── eligibility.test.ts     # NEW  every combination, pure
│   ├── text.ts                 # + switch confirmations, the roll-up sentence, the help text, parseSwitchChange
│   └── attention.ts            # unchanged (N1 stands)
├── server/
│   ├── db/
│   │   ├── schema/notifications.ts   # + notificationPreferences; - notificationStates.muted
│   │   └── project-owned.ts          # + one registry line
│   ├── dal/
│   │   ├── notifications.ts          # preferences(), setSwitches(), preference-aware branches, nextChangeAt
│   │   ├── activity.ts               # listAttention takes the compiled plan (panel rows)
│   │   ├── accounts.ts               # + platformKeys()
│   │   └── my-projects.ts            # MyProject.preferences, notifyingIds, setSwitches, platformsByProject
│   └── services/notifications/
│       └── index.ts                  # myNotificationPreferences, myPreferencesForProject,
│                                     # setSwitchBySlug, setMySwitchForProject; panel/callout/summary updated
├── app/
│   ├── notifications/
│   │   ├── page.tsx              # the Projects card becomes the grid; new confirmations
│   │   └── actions.ts            # setNotifications takes axis/key/on
│   └── p/[projectSlug]/settings/
│       ├── page.tsx              # "Your notifications" card becomes the per-project control
│       └── actions.ts            # setMyProjectNotifications takes axis/key/on
└── components/notifications/
    ├── NotificationSwitch.tsx          # NEW  one switch = one form = one state-showing submit
    ├── NotificationPreferenceGrid.tsx  # NEW  Table grouped: 4 kind columns + platform DetailRow
    ├── NotificationToggle.tsx          # REMOVED (superseded by NotificationSwitch)
    └── NotificationPanel.tsx           # the all-projects-off sentence keeps its wire state name

drizzle/
└── 0021_*.sql                    # NEW  create the table, migrate muted rows, drop the column (+ meta/)

tests/
├── helpers/notifications.ts      # + seed a switch, seed a muted-equivalent project, events on given platforms
├── integration/notifications/
│   ├── preferences.test.ts            # NEW  counting under every combination; SQL vs the pure rule
│   ├── preferences-platforms.test.ts  # NEW  platform axis, removed accounts, offered set, mock, groups
│   ├── preferences-fresh-start.test.ts# NEW  positions, no backlog, pruning, races, all-on
│   ├── preferences-defaults.test.ts   # NEW  new member, rejoin, new project, platform added later
│   ├── preferences-authz.test.ts      # NEW  own only, foreign/unknown project, API keys, deletion
│   ├── mute-migration.test.ts         # NEW  0021 on a seeded install (own database)
│   ├── mute.test.ts                   # RENAMED to project-switch.test.ts (the roll-up, busy, locking)
│   └── count|mark-all|marks|snooze|routes|scope|membership|performance|ui  # extended
└── lint/date-format.test.ts      # unchanged; the new wording must pass it

docs/
├── decisions.md        # N25-N41 next to N5/N6/N10; plan decisions Q1-Q24 next to R1/R4/R5/R14
├── activity.md         # Notifications: preferences, the roll-up, fresh start, webhooks unchanged
└── design-system.md    # §7 the saving switch (Q18) and the control-matrix columns (Q19)
.claude/skills/docket-ui/SKILL.md     # the same two patterns, for later UI work
```

**Structure Decision**: the existing single Next.js app, and no new directory. The rule goes in
`src/lib/notifications/` beside `attention.ts` (pure, so the count and a future mailer share it), the
store in `src/server/db/schema/notifications.ts`, the statements in `src/server/dal/notifications.ts`,
the callers in `src/server/services/notifications/`, and the screens in the existing
`src/components/notifications/` folder — exactly where 022 and 056 put the same concerns.

## Phase 0 — Research

No external fact to fetch and no `NEEDS CLARIFICATION` in the Technical Context: the spec resolved every
product judgement call it needed (N25–N41), and what remained were design choices about this
repository's own code. [research.md](./research.md) records the twenty-four plan decisions **Q1–Q24**,
the alternatives rejected and why, and two things worth stating plainly before implementation starts:

- **Q7** — the two honest costs of the platform clause (one heap fetch per candidate row, and an
  unbounded-by-`LIMIT` scan for a person with every platform off), the extended performance test that
  measures them, and the named fallback if the budget is missed.
- **Q22** — N30's "an event with no platform" is **unreachable** under the log's existing
  `cardinality(provider_keys) >= 1` CHECK. The rule is implemented and tested anyway (pure, and by
  asserting the SQL expression against an empty array) so that the day such an event exists no platform
  switch swallows it. The CHECK is not relaxed.

## Phase 1 — Design

- [data-model.md](./data-model.md): the table, its keys and checks, the ten invariants, the pure rule
  and its compiled plan, the exact shape of every statement that changes, the migration, and the entity
  summary.
- [contracts/services.md](./contracts/services.md): the pure module, DAL and service signatures, the
  Zod boundary, the order in which a bad request is refused, and every new sentence of wording.
- [contracts/http.md](./contracts/http.md): the two session routes (shapes unchanged, meaning changed)
  and the two pages. No new route, parameter or public-API operation.
- [contracts/ui.md](./contracts/ui.md): the switch, the grid, the settings card, the confirmations, the
  required wording, the accessibility checklist, and the docs this entry owes.
- [quickstart.md](./quickstart.md): how to run it, the check that proves each user story, the
  performance case, and the by-hand walk-through that goes last.

**Post-design Constitution re-check**: still passing, with nothing new to justify. The design adds one
table and one pure module; it removes a column and a component. Isolation is enforced by the
project-owned registry plus the existing project-set section; one module owns the rule and one owns the
write; no secret, address or message text enters the new table or either payload; no dependency,
environment variable, index on the log or recurring work appears. The two deliberate departures from
`docs/design-system.md` (a saving switch instead of a checkbox, and a six-column control matrix) are
argued in Q18 and Q19 and are written into that document in the same change, which is what it asks for
rather than a silent exception.

## Complexity Tracking

No constitution violation to justify.
