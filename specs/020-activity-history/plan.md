# Implementation Plan: Activity history — one log of publish successes and failures, per project and across projects

**Branch**: `020-activity-history` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-activity-history/spec.md`

## Summary

A new append-only, project-owned table, `activity_events`, records one row for each target or account state change and each failed connect. Each row is written in the transaction that makes the change. Three readers share one service: a per-project Activity screen, an all-projects Activity screen and `GET /api/v1/activity`.

**Writing (research P1–P3).**

- A pure classifier (`services/activity/classify.ts`) turns what each site already computed into an event, or into nothing.
- Each site inserts that event in the transaction it already holds:
  - `recordStepResult` covers provider results, retry exhaustion, G15 validation and the fatal paths;
  - `claimDueTargets` decisions cover engine settles and lease recovery;
  - `retryLockedTarget` covers retry and bulk retry;
  - `resolveAmbiguous`'s four branches;
  - the two `account.needs_reauth` helpers;
  - the OAuth callback, token paste and credential connect refusals.
- A rolled-back change therefore leaves no event, and a change that does not apply writes none.

**Storage (P4–P9).**

- **Foreign keys.** The project FK cascades, and the actor FKs match `publish_attempts`. There are deliberately no FKs to posts, targets or accounts. This lets history outlive deletions and adds no lock edge.
- **Ordering.** Events are ordered by `occurred_at DESC, seq DESC`. `seq` is an identity tie-breaker, and times are kept to whole milliseconds. Paging uses an opaque keyset cursor, so new events never shift pages.
- **Indexes.** Four indexes serve time, outcome, account and target lookups.
- **Platforms.** A `provider_keys[]` array lets a group connect failure match each of its platforms.
- **Excerpts.** Excerpts are read from the post at render time with `excerptOf`, so no content is copied.
- **Messages.** Messages are scrubbed at source and clipped to 500 code points. `details` is a strict per-kind union.

**Reading (P11–P13, P15–P17).**

- **Query builder.** One builder emits a `UNION ALL` of single-project branches. Each branch is pinned to one project id and has its own Temporal-computed day window, so each project's own time zone applies (D7).
- **All-projects view.** This view resolves the caller's memberships per request (`forMyProjects`). Each branch also joins `member` for the caller.
- **Scope harness.** The harness learns a named "project set" section. In it, every project pin must be one of the caller's resolved ids.
- **Filters.** Filters are one parser with lenient (screens) and strict (API) modes.
- **Counts.** Summary counts ignore only the outcome filter.
- **Failures link.** Failures gains a `?target=` link target. Activity links there while the target is still failed or ambiguous, and otherwise to the post or the accounts screen.

**Backfill (P14).** A custom SQL migration (`0013`) inserts one event per currently published, failed or ambiguous target, and one per account that needs reauth today, at their real times. It is idempotent via `NOT EXISTS`, so it never duplicates a live event.

**Docs (P18).** A new `docs/activity.md`, linked from the index and nav. An n8n recipe, "8. Read activity". `## 020` is added to `docs/decisions.md` in this phase.

There is no new dependency, environment variable, webhook type, key permission or `docker-compose.yml` change.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed (research F15).
- **Next.js 16.3.8**: two new routes. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/{page,loading,error}.md` first (AGENTS.md).
- **Drizzle ORM 0.45.3 / drizzle-kit 0.31.11**: no index `INCLUDE`; `generatedAlwaysAsIdentity` available.
- **zod 4.6.5 / zod-openapi 6.0.2**: strict query and details schemas, plus examples.
- **`@js-temporal/polyfill`**: per-project day windows.
- **lucide-static**: the `activity` icon, via `pnpm icons`.

**Storage**: PostgreSQL 17.
- New table `activity_events`, with 4 indexes, 2 enums and the CHECKs in [data-model.md](./data-model.md).
- Migration `0012` (generated) and `0013` (custom backfill SQL).
- No change to existing tables.

**Testing**: Vitest against real Postgres (run-scoped DBs), with:
- the mock provider and mocked HTTP for the connect groups;
- the `atTime` clock;
- `tests/helpers/api.ts`;
- the scope recorder.

There are 14 new suites and 7 extended ones. The map is in [quickstart.md](./quickstart.md) §1. No live calls.

**Target Platform**: the existing web and worker containers on Docker Compose (Unraid) and Neon. No session-level Postgres features are used: row locks, FKs and plain statements only.

**Project Type**: a single Next.js app plus worker, in the same layout as 001–018.

**Performance Goals**: SC-004. The first page plus counts must take under 1 s with 100k events in one project, and with 200k events across 20 projects. This is shown by a seeded test that logs `EXPLAIN ANALYZE` (quickstart §6).

**Write cost**: one extra `INSERT` per state change, inside the existing transaction, with no extra lock.

**Constraints**:
- Events are written in the state-change transaction (FR-003).
- History is append-only (FR-008).
- No secrets and no post content beyond a read-time excerpt (FR-007).
- No `OR` in pinned queries (scope harness).
- Times in UTC; wall-time maths only via Temporal (constitution).
- The scheduler's lock order is unchanged.

**Scale/Scope**:

| Area | New | Edited |
|---|---|---|
| Schema/migrations | `schema/activity.ts`, `0012_*`, `0013_backfill_activity_events.sql` | `schema/index.ts`, `db/project-owned.ts` |
| DAL | `dal/activity.ts`, `dal/my-projects.ts` | `dal/scope.ts` (`createSchedulingRepos`), `dal/scheduler.ts` (`ClaimDecision.activity`), `dal/targets.ts` (`listAttention.targetId`), `dal/index.ts`, `db/cross-project.ts`, `db/client.ts` |
| Services | `services/activity/{classify,record,filters,cursor,links,index}.ts` | `scheduler/{record,publishing,credentials}.ts`, `posts/{retry,retry-all,index}.ts`, `connect.ts`, `accounts.ts`, `failures.ts` |
| Shared lib | `lib/activity/{outcomes,details,text}.ts`, `lib/accounts/connect-banner-text.ts` | `lib/api/schemas.ts` |
| API | `api/operations/activity.ts` | `operations/index.ts` |
| UI | `app/p/[projectSlug]/activity/{page,loading}.tsx`, `app/activity/{page,loading,error}.tsx`, `components/activity/*`, `components/ui/CursorPagination.tsx` | `LeftNav.tsx`, `UserMenu.tsx`, `switcher-logic.ts` and `ProjectSwitcher.tsx`, `accounts/page.tsx` (imports banner text), `failures/page.tsx` (`?target=`), `scripts/generate-icons.mjs`, `icons.generated.ts` |
| Tests | see quickstart §1 | `tests/helpers/scope-check.ts`, `tests/setup/scope-recorder.ts` |
| Docs | `docs/activity.md` | `docs/index.md`, `mkdocs.yml`, `docs/n8n.md`, `docs/failures.md`, `docs/design-system.md`, `docs/decisions.md` (this phase), README feature list |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No platform facts are involved. Every behaviour is read from the code (research F1–F16). Library abilities were probed in `node_modules`: no Drizzle `INCLUDE` (so none is planned), identity columns, lucide `activity.svg`, Temporal start-of-day, Next file-convention docs. No `NEEDS RESEARCH`. | PASS |
| II. Nothing is "working" unless it ran | Every FR-027 item maps to a real-Postgres test (quickstart §1). SC-004 is shown by a seeded timing test, not asserted. Connect paths are verified with mocked HTTP only, and the report says so. The manual walk-through is listed separately and not claimed. | PASS |
| III. Project isolation in one place | `activity_events` joins `projectOwnedTables`. The per-project repo pins `project_id = $n` and refuses foreign windows. The only cross-project surface is `forMyProjects`. It resolves membership per request in a named section, and runs each statement in a recorded project-set section whose every pin the extended harness checks against the caller's ids. Each branch also joins `member` for the caller in the same statement. Routes, actions and the API import services only (lint rule). Permission `post: view` is checked on the server for every reader. | PASS |
| IV. One service layer, many callers | One classifier, one filter parser, one query builder (one branch or many) and one row view serve both screens and the API. Recovery is linked, not re-implemented (FR-014). The banner text moves to one shared function, used by the page and the connect service. | PASS |
| V. Providers are plug-ins; ambiguous never auto-retried | No provider or scheduler-decision change: events only observe decisions. A group connect failure lists the group's providers from the registry, with no hard-coded platform list. Ambiguous rows only link to Failures. | PASS |
| VI. Boring, few dependencies | No new runtime or dev dependency, no infrastructure, no environment variable. One additive table plus a data migration in the 0009 style. | PASS |
| VII. Secrets never leak | Messages come from already-redacted sources. Connect messages are additionally redacted against the code, state or pasted token, then clipped. `details` is a strict union with no slot for payloads. No content is stored beyond read-time excerpts. The secret-scan test is extended to storage, both screens and the API (SC-006). | PASS |
| Neon / transaction-mode pooler | Plain inserts and selects inside existing transactions. No advisory locks, `LISTEN` or session variables. | PASS |
| Scheduler constraints | `runTick` stays bounded: one insert per changed target, inside its existing transaction. No new FK lock edge (no account or post FKs, P4). No provider call in any transaction. Claims keep `SKIP LOCKED`. | PASS |
| Times in UTC, Temporal with DST | `occurred_at` is UTC to the ms. Day windows come from `PlainDate.toZonedDateTime` per project, and DST days are tested. No SQL `AT TIME ZONE`. | PASS |
| Accessibility / `docket-ui` | Filters are GET search parameters with labelled controls, `ChoiceField` (no native select), checkbox fieldsets and link presets. Real tables with `th scope`. Badges carry text. All four states are covered. The zone is always shown, with `LocalTime` titles. Keyboard tests are in `ui.test.tsx`. | PASS |
| Commits, docs and decisions | This phase commits the plan artifacts and `## 020` in `docs/decisions.md` with explicit paths. Docs updates are planned (P18). | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:
- one table and two enums;
- one optional field on `ClaimDecision`;
- one optional `opts.via` on `retryLockedTarget`;
- three optional fields on `RecordInput`;
- one optional `target` filter on Failures;
- one project-set marker in the harness.

Existing callers compile and behave as before, and the 002/012/015/016 suites guard that. Webhooks are untouched. One judgement call needs a note: the cursor bound for events that commit after a walk passed their position (research P5). It is documented for API users and does not affect the screens' no-repeat/no-gap guarantee for committed history.

**Not writable from the pipeline**: `.claude/skills/docket-ui/SKILL.md` is outside the sandbox's writable paths. Adding "Activity" to its Structure list is owed to the operator. `docs/design-system.md` carries the new atom instead.

## Project Structure

### Documentation (this feature)

```text
specs/020-activity-history/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F16, decisions P1–P18
├── data-model.md        # Phase 1: table, enums, details shapes, read model, writes by path, backfill
├── quickstart.md        # Phase 1: test map, final pass, manual walk-through, SC-004 method
├── contracts/
│   ├── services.md      # DAL repos, project-set scope, services, changed call sites, harness extension
│   ├── http-api.md      # GET /api/v1/activity: query, 200, errors, OpenAPI
│   └── ui.md            # routes, URL query, layout, states, navigation
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
drizzle/
├── 0012_<generated>.sql                    # NEW: activity_events, enums, checks, 4 indexes
├── 0013_backfill_activity_events.sql       # NEW (custom): idempotent backfill (P14)
└── meta/                                   # snapshot + journal
src/
├── lib/
│   ├── activity/{outcomes,details,text}.ts # NEW pure: kinds↔outcomes, presets, labels, strict details, clip, actor label
│   ├── accounts/connect-banner-text.ts     # NEW pure: banner texts + connectBannerText (moved from accounts page)
│   └── api/schemas.ts                      # + ApiActivityEvent, ApiActivityPage, query schema
├── server/
│   ├── db/
│   │   ├── schema/activity.ts              # NEW
│   │   ├── schema/index.ts, project-owned.ts
│   │   ├── cross-project.ts                # + runForProjectSet, currentProjectSet
│   │   └── client.ts                       # logger records projectSet
│   ├── dal/
│   │   ├── activity.ts                     # NEW: ActivityRepo (insert/list/summary), branch SQL
│   │   ├── my-projects.ts                  # NEW: forMyProjects → ProjectSetScope
│   │   ├── scope.ts                        # createSchedulingRepos + activity
│   │   ├── scheduler.ts                    # ClaimDecision.activity inserted in the claim tx
│   │   ├── targets.ts                      # listAttention({ targetId })
│   │   └── index.ts
│   ├── scheduler/{record,publishing,credentials}.ts
│   ├── services/
│   │   ├── activity/{classify,record,filters,cursor,links,index}.ts   # NEW
│   │   ├── posts/{retry,retry-all,index}.ts
│   │   ├── connect.ts, accounts.ts, failures.ts
│   └── api/operations/{activity,index}.ts  # NEW listActivity
├── components/
│   ├── activity/{ActivityFilters,ActivitySummary,ActivityList,ActivityRow}.tsx   # NEW
│   ├── ui/CursorPagination.tsx             # NEW atom
│   └── shell/{LeftNav,UserMenu,ProjectSwitcher}.tsx, switcher-logic.ts
└── app/
    ├── activity/{page,loading,error}.tsx   # NEW all-projects
    └── p/[projectSlug]/
        ├── activity/{page,loading}.tsx     # NEW
        ├── failures/page.tsx               # ?target=
        └── accounts/page.tsx               # imports connect-banner-text
scripts/generate-icons.mjs                  # + activity
tests/
├── helpers/scope-check.ts, setup/scope-recorder.ts   # project-set rule
└── integration/activity/*.test.ts(x)       # NEW (quickstart §1)
docs/
├── activity.md                             # NEW "History and activity"
├── index.md, mkdocs.yml, n8n.md (§8), failures.md, design-system.md
└── decisions.md                            # ## 020 (written in this phase)
```

**Structure Decision**: the existing single-app layout.
- Rules (classification, filters, windows, queries) live in `src/server/services/activity/` and `src/server/dal/`.
- Pure vocabulary shared by pages, the API and tests lives in `src/lib/activity/`.
- The UI is server components, apart from the existing `ChoiceField` leaf.

## Complexity Tracking

No violations. Nothing to justify.
