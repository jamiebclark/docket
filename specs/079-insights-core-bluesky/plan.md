# Implementation Plan: Post and account insights, with Bluesky as the pilot platform

**Branch**: `079-insights-core-bluesky` | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/079-insights-core-bluesky/spec.md`

## Summary

Docket learns to record numbers. One optional provider member (`insights`, generic change **G30**)
declares what a platform reports for a post and for an account, in that platform's own words; two
append-only snapshot tables store `(subject, captured_at, metrics)` rows that nothing ever updates;
two poll-state tables carry a lease, a backoff and a freeze reason per target and per account; a pure
decaying schedule (hourly for a day, daily to a week, weekly to 28 days, then frozen) decides what is
due; a new bounded `runInsightsPoll` section of `runTick()` claims, calls, commits and counts; and one
honest performance panel on the post detail page shows the latest snapshot with the platform's own
labels and a single "as of" line.

Bluesky is the pilot because it cannot block it: the post's `external_id` is already its at-URI, the
account's is already its DID, and reading `app.bsky.feed.getPosts` and `app.bsky.actor.getProfile`
needs no permission beyond the app-password session Docket already holds for publishing and for the
077 inbox (FR-056). Both calls, their fields, and the **confirmed absence of any views or reach
field**, are read from the installed `@atproto/api` — research §1.

The product rule everything here serves: **a metric is a snapshot, never a current value, and a
metric a platform does not report is absent, never zero.** It is enforced in the data layer, not in
the component: the provider declares `{ key, label }` pairs, the DAL drops undeclared keys, the view
builder emits a row only for a key actually present, and no module outside `src/providers/` names a
provider key or a metric key at all.

### What this entry delivers, and what it does not

| Story | In this entry | Why |
|---|---|---|
| US1 (the spine, provider → tables → panel, proved on `mock`) | **Yes** | The whole point; fully testable with no platform credentials |
| US2 (Bluesky's own numbers, no new permission) | **Yes**, with mocked HTTP | The facts are in the installed package; the live confirmation is one parked task (§"Task ordering") |
| US3 (decay, bounds, publishing wins) | **Yes** | Pure functions plus a clock-pinned tick test |
| US4 (the section is visible, or visibly idle) | **Yes** | Its own `SectionResult`, its own counts, its own heartbeat |
| Account metric snapshots | **Captured and stored; shown nowhere** | FR-015/FR-051 require the capture; FR-062…FR-070 ask only for a *post* panel. Flagged below and published as a gap (FR-079) |
| Any OAuth scope, Instagram/Facebook/Threads/TikTok/Pinterest/X | **No** | Entries 2 and 3 |
| Any chart, trend, delta, comparison, API or MCP surface | **No** | Entry 4 |

The one asymmetry worth stating plainly before implementation starts: **this entry stores account
numbers that nothing displays.** That is what the spec asks for — the capture is required by FR-015,
FR-051 and US2-AS3, and the panel requirements are per-target throughout — and it is the right call,
because entry 4 owns account trends and needs the history to already exist. It is recorded in
`docs/insights.md` and in `docs/feature-map.md` as a named gap rather than left as a surprise.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16 (App Router, standalone), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, Better Auth, `@atproto/api` (installed; both
`app.bsky.feed.getPosts` and `app.bsky.actor.getProfile` are already in the dependency), Vitest.
**No new runtime dependency and no new infrastructure.**

**Storage**: Postgres via Drizzle. Four new project-owned tables in a new schema module
(`post_metric_snapshots`, `account_metric_snapshots`, `post_metric_poll_states`,
`account_metric_poll_states`), one migration (`drizzle/0041_*.sql`), **no new enum**, **no new
activity or notification label**, **no change to any existing table**.

**Testing**: Vitest. Unit tests for the pure parts (the two schedule functions, the budget check, the
panel decision table); integration tests against real Postgres (port 5555 locally) for claims,
concurrency, kill-recovery, idempotency, the allowance reserve, retention, cross-project isolation
and the rendered panel; provider tests with **mocked HTTP only** — no live calls (constitution II).

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed; migrations on the direct URL; no session-level Postgres features.

**Project Type**: Web application — Next.js App Router monolith with a worker running the same
`runTick()`.

**Performance Goals**: `runTick()` stays well under 30 s with a backlog present; the insights section
takes at most `INSIGHTS_TIME_SHARE` (0.3) of the tick budget and stops calling once less than
`providerTimeoutMs` remains; the post detail page gains exactly two batched queries, both on a
covering index; at most **32** provider calls per post over its whole life (SC-006).

**Constraints**: no provider call inside a held transaction; claims take `FOR UPDATE SKIP LOCKED` on
the poll-state rows only; a publish is never deferred by a poll (FR-048); no secret on any insights
path (FR-075); `src/providers/**` imports nothing from `src/server/**` (FR-012); no API, MCP or
OpenAPI surface (so `OPERATIONS` is untouched and the enumerated-surface tests need no edit).

**Scale/Scope**: a project with 50 live targets produces ~1,200 post snapshots a day; four new
tables; nine new env knobs; one new provider member; one new tick section; one new panel on an
existing page; 400-day default retention, operator-configurable.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see "Post-design re-check".*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory** | Every Bluesky fact is read from the installed `@atproto/api` — the generated types and the bundled lexicon `schemaDict` — and re-verified line by line in research §1, including the **confirmed negative** that no views/impressions/reach property exists. The one thing that cannot be confirmed (does the public AppView answer unauthenticated, and at what read limit) is marked `NEEDS RESEARCH`, is recorded in `docs/research/bluesky.md` as unverified, and **nothing in the design depends on its answer**: reads go through the account's own session (research §2). The declared read budget is marked interim/unverified in `docs/limits.md` (research §3) | PASS |
| **II. Nothing is "working" unless it ran** | The Bluesky reader is covered by mocked-HTTP tests and reported as "verified with mocks only" until the live check runs; that check is one human task parked at the very end of `tasks.md` (quickstart §10). Provider tests make no live call | PASS |
| **III. Project isolation in one place** | All four tables carry `project_id` with `ON DELETE CASCADE`; every read and write goes through new scoped repos registered in `ProjectScope` and `createSchedulingRepos`; the only cross-project readers are the two claims and the two prune functions, each wrapped in `crossProject(reason, …)` as every other scheduler claim is; quickstart §7 proves the cascade directly rather than leaning on a suite that research §13 found does not exist | PASS |
| **IV. One service layer, many callers** | The budget maths is **imported**, not re-implemented: `stricterBudget` and `reserveFloor` come from `scheduler/engagement-budget.ts` unchanged (FR-049). Backoff (`nextRetryAt`), redaction (`redact`/`secretValues`), the needs-reauth path (`markInvalidEmitting`), the heartbeat (`writeHeartbeat`), the window count (`writesStartedSince`) and the account limits (`effectiveLimits`) are all reused. One view builder decides the panel's state, for the one caller that needs it | PASS |
| **V. Providers are plug-ins** | Insights is one optional member on `SocialProvider`. A provider that omits it is absent from the poller and the panel with no error. No shared code names a provider key or a metric key — a provider-seam test asserts it (SC-013), so entry 3 adds a folder and nothing else | PASS |
| **VI. Boring, few dependencies** | No new package, no queue, no Redis, no advisory lock, no `LISTEN`, no second deployable. One more section of `runTick()`, claimed with `FOR UPDATE SKIP LOCKED` plus a lease column. No new counter table either — the window count reads rows that already exist (research §4) | PASS |
| **VII. Secrets never leak** | Credentials are decrypted only inside the section's read step, exactly as publishing and the 077 inbox do; both metrics schemas are closed objects of optional numbers, so a string value cannot be stored at all; every error is `redact`ed against the account's own secret values before it is written, logged or rendered; the secret scan is extended to the poller **and** the panel with no exemption (FR-075, SC-011) | PASS |
| **Engineering constraints** | UTC storage with the "as of" line rendered in the project's time zone; `runTick()` bounded, concurrent-safe, kill-safe; `docket-ui` skill and `docs/design-system.md` for the panel; server component, keyboard reachable, heading order preserved | PASS |
| **Out-of-scope list ("analytics")** | This entry is the spec that changes it. The constitution's Engineering Constraints line and `docs/build-prompt.md`'s "Out of scope for now" are amended in a `docs(constitution):` commit with a version bump, recording that **metric capture is in scope and charts, trends and comparisons are not** (FR-082) | PASS (by amendment) |

No violation needs justifying, so Complexity Tracking stays empty. Four choices that *look* like new
mechanism are argued in research rather than waved through: the window count with no new ledger (§4),
`gone` as a per-entry outcome inside a successful read rather than a seventh error kind (§9), a text
CHECK instead of a pg enum for the freeze reason (data-model §3), and the 400-day retention default
(§11).

## Architecture

### Where the work runs

```text
runTick()
├── publishing                                      ─┐
├── token refresh, generation, housekeeping, …        │  concurrent, one shared deadline
├── webhooks, email, standing series                  │
├── engagement read                                   │
├── insights poll             NEW, concurrent        ─┘
└── engagement send           (awaited after publishing, unchanged)
```

The new section is **concurrent, not sequenced after publishing**. Insights only reads, so unlike
`engagement-send` it does not compete for the account's write path, and the allowance reserve is the
whole of the protection FR-048 requires. Its time share defaults to 0.3 against engagement's 0.8,
because it is the least urgent section in the tick and a section that works to the very end of the
budget starves the ones that predate it. Full flow, result mapping and transaction boundaries:
[contracts/scheduler-insights.md](./contracts/scheduler-insights.md).

### How "absent, never zero" is made structural

```text
provider declares  { key: "likeCount", label: "Likes" }      ← the platform's own word
        │
        ▼ readPostMetrics → { kind: "metrics", metrics: { likeCount: 4 } }   ← omitted keys stay omitted
        │
        ▼ caller validates against the provider's own schema, then DROPS undeclared keys (FR-018)
        │
        ▼ post_metric_snapshots.metrics = { likeCount: 4 }    ← no quoteCount key at all
        │
        ▼ buildTargetInsightsView walks the DECLARED list, emits a row only for a PRESENT key
        │
        ▼ panel renders "Likes 4". No Quotes row. No dash. No zero. One "as of" line.
```

Four separate places refuse to invent a value, so no single bug can turn an absence into a zero. The
generic layer holds no metric-key constant of its own, which is what makes "never sum across
platforms" a property of the data layer rather than a rule a future chart has to remember.

### The freeze, in two expressions at once

A frozen target has `next_poll_at = NULL` **and** `frozen_at`/`frozen_reason` set, with a CHECK
(`frozen_at IS NULL OR next_poll_at IS NULL`) making the inconsistent pair unstorable and the claim
predicate requiring `next_poll_at IS NOT NULL`. So a frozen target is invisible to the claim whatever
a future caller forgets, and "frozen" is never a far-future date some later bug can reach.

## Project Structure

### Documentation (this feature)

```text
specs/079-insights-core-bluesky/
├── spec.md
├── plan.md                           # this file
├── research.md                       # Phase 0 — §1…§14
├── data-model.md                     # Phase 1 — tables, DAL, view type, config, retention
├── quickstart.md                     # Phase 1 — how to run it and prove each requirement
├── contracts/                        # Phase 1
│   ├── provider-insights.md          #   G30: the declaration, both reads, every rule
│   ├── scheduler-insights.md         #   runInsightsPoll: flow, counts, result mapping, locking
│   └── panel.md                      #   the view type, the eight states, the rendering rules
├── checklists/requirements.md
└── tasks.md                          # Phase 2, written by /speckit-tasks — NOT by this phase
```

### Source Code (repository root) — new and touched

```text
src/
├── lib/insights/                        NEW pure helpers, no clock, no database
│   ├── schedule.ts                      nextPostPollAt, nextAccountPollAt (FR-024 … FR-030)
│   └── panel.ts                         buildTargetInsightsView — the eight-state table (FR-065)
├── providers/
│   ├── types.ts                         + insights?: InsightsSupport (G30)
│   ├── registry.ts                      + assertInsightsDeclaration, called at load (FR-004)
│   ├── bluesky/insights.ts              NEW getPosts + getProfile readers (FR-050 … FR-058)
│   ├── bluesky/index.ts                 + insights: blueskyInsights
│   ├── mock/insights.ts                 NEW scripted fixture (FR-059 … FR-061)
│   ├── mock/settings.ts                 + eight insights scripting fields
│   └── mock/index.ts                    + insights: mockInsights
├── server/
│   ├── db/schema/insights.ts            NEW four tables
│   ├── db/schema/index.ts               + the new exports
│   ├── dal/insights.ts                  NEW four repos + two prune functions
│   ├── dal/insights-claims.ts           NEW two claim functions (FOR UPDATE SKIP LOCKED)
│   ├── dal/scope.ts                     + repos on ProjectScope and createSchedulingRepos
│   ├── env.ts                           + nine INSIGHTS_* variables
│   ├── scheduler/config.ts              + INSIGHTS_DEFAULTS, insightsConfig(), the EnvLike pick
│   ├── scheduler/insights-poll.ts       NEW the section (claim → read → commit → count)
│   ├── scheduler/insights-budget.ts     NEW the per-account reserve check, reusing engagement-budget
│   ├── scheduler/housekeeping.ts        + two prune passes, two counts
│   ├── scheduler/index.ts               + one section, one TickSummary field
│   ├── services/insights/retention.ts   NEW the two bounded prune passes
│   └── services/posts/view.ts           + insights on PostViewTarget, two batched reads
├── components/targets/PerformancePanel.tsx   NEW server component (FR-062 … FR-070)
└── app/p/[projectSlug]/posts/[postId]/page.tsx   + the panel inside each target section

drizzle/0041_*.sql                       one migration, generated by pnpm db:generate (FR-023)
tests/                                   see quickstart.md §2–§8 for the full list
tests/helpers/scheduling.ts              + parkAllInsightsPolls()
docs/
├── insights.md                          NEW page + mkdocs nav entry (FR-076)
├── adding-a-provider.md                 + the G30 row and a worked section (FR-077)
├── decisions.md                         + G30 and every decision this spec records (FR-078)
├── feature-map.md                       + what shipped and what no entry owns (FR-079)
├── limits.md                            + the Bluesky insights read budget, interim/unverified (FR-080)
├── research/bluesky.md                  + the confirmed fields, the confirmed negative, the gap (FR-081)
└── build-prompt.md                      the "analytics" out-of-scope line amended (FR-082)
.specify/memory/constitution.md          the same amendment + version bump (FR-082)
.env.example                             + the nine knobs with ranges and defaults (FR-071)
```

**Structure Decision**: the existing single-app layout is kept. Insights adds one pure library
folder, one schema module, two DAL modules, one service folder, two scheduler modules, one provider
member and one component — no new top-level directory, no second deployable, no new route.

## Phase 0 — research

See [research.md](./research.md). It records the Bluesky facts read from the installed package and
the confirmed negatives (§1), the transport decision and the one open `NEEDS RESEARCH` (§2), the
interim read budget (§3), the allowance window computed from rows that already exist (§4), the
schedule arithmetic and its 32-call budget (§5), the section's place and time share in the tick (§6),
the four-table shape (§7), capture idempotency (§8), the result vocabulary and why `gone` is a
per-entry outcome (§9), how absence reaches the screen (§10), retention (§11), the deliberate absence
of any activity event, notification or permission (§12), a correction to one line of the spec (§13),
and the resolution of every question the Technical Context could have marked unknown (§14).

Every `NEEDS CLARIFICATION` is resolved. One `NEEDS RESEARCH` remains open and is published as
unverified; no requirement, test or default depends on its answer.

## Phase 1 — design

- [data-model.md](./data-model.md) — the four tables with every column, constraint and index; lazy
  row creation; both state machines; the DAL interfaces; the panel's view type; the nine config knobs
  with the reasoning for each default; and retention.
- [contracts/provider-insights.md](./contracts/provider-insights.md) — G30: the declaration, its
  registry-load validation rules, both read calls, the full result vocabulary, what the caller does
  so a provider need not, and both the Bluesky and the `mock` implementations.
- [contracts/scheduler-insights.md](./contracts/scheduler-insights.md) — the section: where it runs,
  its counts, its flow, the result-mapping table, its transaction and locking boundaries, and the
  test helper.
- [contracts/panel.md](./contracts/panel.md) — the view type, the ordered eight-state decision table,
  the nine rendering rules, and what is deliberately absent.
- [quickstart.md](./quickstart.md) — how to run it and prove each requirement, requirement by
  requirement, ending with the one parked human task.

## Post-design re-check

The design adds no infrastructure, no dependency, no second implementation of budget maths, publish
limits, backoff, redaction or the heartbeat, and no new error vocabulary. Five points were
re-examined after the design settled; each is a judgement call for `docs/decisions.md`:

1. **The allowance window is counted from the snapshot rows themselves.** A poll's cost is already
   recorded — one row per successful read — so a counter table or counter column would be a second
   source of truth for a number already stored, and would put a second row in the commit transaction
   with it a lock-order pair to get wrong. The honest limitation, recorded rather than hidden: a
   *failed* read leaves no row and is not counted; `consecutive_failures` and the existing backoff
   bound it instead.
2. **"The platform no longer returns this post" is a per-entry outcome inside a successful read, not
   an error.** `getPosts` answers 200 with the dead post simply absent, so an error kind would be a
   fiction, and a retry loop on a dead at-URI would run hourly for 28 days while the panel claimed a
   failure that never happened.
3. **The freeze reason is a text CHECK, not a Postgres enum.** 077 paid for an enum label added
   beside a partial index (`docs/decisions.md`: a partial-index predicate cannot cast an enum to text,
   and cannot name a label added in the same transaction). Entries 2 and 3 will want more freeze
   reasons; a CHECK widens with no `ALTER TYPE` and no index rebuild.
4. **The section is concurrent, not sequenced behind publishing.** FR-048 is about the account's
   *allowance*, not about wall-clock ordering, and the reserve check satisfies it before any call is
   made. Sequencing a read-only section behind the slowest section in the tick would buy nothing and
   cost it its time share.
5. **Account snapshots are captured and shown nowhere in this entry.** Required by FR-015, FR-051 and
   US2-AS3; the panel requirements are per-target throughout; entry 4 owns account trends and needs
   history that already exists. Published as a named gap in `docs/insights.md` and
   `docs/feature-map.md` (FR-079) rather than left for a reader to discover.

## Task ordering note for Phase 2

Carried from the spec, and the standing lesson of 077: **park every task that needs a live platform
account, a browser or a human judgement at the very end of `tasks.md`.** A judgement task in an early
phase starves the implement loop; a remediation task landing *after* one does the same thing twice.

This entry is deliberately designed to have almost none: it asks for no OAuth scope and no consent
screen, so every requirement above is provable from the `mock` provider and mocked HTTP. The single
exception is the live Bluesky verification — confirming a real account's real post returns the counts
this spec expects, and recording whether the public AppView answers anonymously (research §2) — and
it must be the **last** item, after every mocked test, every doc and the panel. Until it runs, the
Bluesky reader is reported as "verified with mocks only" (constitution II).

A reasonable phase order for `/speckit-tasks`:

1. The pure library (`lib/insights/schedule.ts`, `lib/insights/panel.ts`) with its unit tests — no
   database, no provider, nothing to mock.
2. The contract (`providers/types.ts`, the registry assertion) and the `mock` implementation, so
   everything downstream has a fixture.
3. The schema, the migration and the DAL, with the storage and isolation tests.
4. The section, the config knobs, the budget check and housekeeping, with the tick, concurrency,
   allowance and retention tests.
5. The Bluesky reader, with mocked HTTP only.
6. The panel and `getPostView`, with the rendered-page tests and the extended secret scan.
7. Every doc, the `.env.example` block, and the constitution + build-prompt amendment.
8. **Last**: the live Bluesky check and the `docs/research/bluesky.md` answer.

## Complexity Tracking

*No constitution violation requires justification.*
