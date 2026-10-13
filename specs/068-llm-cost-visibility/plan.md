# Implementation Plan: LLM cost visibility — show a project what it used

**Branch**: `068-llm-cost-visibility` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/068-llm-cost-visibility/spec.md`

Roadmap `.specify/roadmaps/llm-credentials.md`, entry **3 of 3**, the last entry.

---

## Summary

`LlmUsage` is already measured on every model call and thrown away after one log line. This entry
persists it: a project-owned, insert-only **call-level ledger** (`llm_call_usage`), written by a
provider decorator that mirrors the existing `withCreditHold` and flushed once per operation with
whatever generation link exists by then — post, series + position, or job + job item. On top of it,
an owner/admin-only **Settings → Usage** screen reports calls, input and output tokens, a per-model
and per-purpose breakdown, and the credential-source split, for a period resolved in the project's
own time zone.

Money is the smaller, more careful half. Docket ships **no prices** and may not assert any
(constitution I; pipeline phases cannot reach the web; the measured 2026-10-12 run was 100% free,
so tokens × list price would have overstated spend by ~100%). Rates are therefore operator-supplied
install environment configuration (`LLM_RATES`, `LLM_RATE_CURRENCY`), empty by default, computed at
render time, never stored on a row — and every figure is an **estimated upper bound** carrying one
fixed sentence. A model with no rate shows its calls and tokens with an explicit "no rate
configured" marker and contributes nothing to a total that names what it left out. With no rates
at all, the money column does not exist.

One migration, one new table, one new enum, no new runtime dependency, no new infrastructure, no new
permission, no change to `logLlmCall` or to either failure-kind `pgEnum`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js (App Router, standalone output), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod, `@js-temporal/polyfill`, Tailwind 4, Vitest. **No new runtime
dependency** (constitution VI) — everything needed is in `package.json`.

**Storage**: Postgres. One new project-owned table `llm_call_usage`, one new `pgEnum`
`llm_usage_purpose`, two indexes, one forward-only SQL migration. No existing table altered.

**Testing**: Vitest — unit tests for the rate parser, the period windows and the money arithmetic;
integration tests against a real Postgres for the ledger, the report, authorization and the extended
secret scan. No test makes a live provider call (constitution II); all usage figures come from
stubbed providers through the existing `setLlmForTests` / `setLlmFactoryForTests` /
`createFakeLlmFetch` seams.

**Target Platform**: Linux server — Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. No session-level Postgres features.

**Project Type**: Web application — Next.js App Router monolith plus a worker, services in
`src/server/services/`, data access in `src/server/dal/`.

**Performance Goals**: the Usage screen answers in under 2 s for a project with 50,000 recorded
calls (**SC-008**) — an index range scan on `(project_id, called_at DESC)` plus a hash aggregate.
The job page's totals are one indexed aggregate, no join.

**Constraints**: the ledger is insert-only and never updated; no prompt, output, provider error
text, key or fingerprint of one may enter a row, a log line, a response or the UI; a failed usage
write is logged and swallowed and must not fail, delay or roll back the generation; the write never
runs inside a caller's transaction; `logLlmCall` keeps its exact fields and shape; period
boundaries resolve in the project's zone through Temporal with **explicit** DST disambiguation; a
malformed rate configuration must **not** stop the process.

**Scale/Scope**: ~1M ledger rows a year on a flat-out install (a 500-item job is 500–1000 rows); one
new page, two existing pages extended by one block each; seven call sites wired.

No `NEEDS CLARIFICATION` and no `NEEDS RESEARCH` remains — see [research.md](./research.md) § 9.

---

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design. Both evaluations below.*

| Principle | How this design satisfies it | Post-design verdict |
|---|---|---|
| **I. Verified facts over memory** (non-negotiable) | Every code fact in [research.md](./research.md) cites the file and line it was read from. **No provider price, and no currency list, is asserted anywhere** — `docs/research/` has none, phases cannot fetch the web, so rates are the operator's (**M8**) and the currency is validated by shape only, never against a remembered ISO list (**P11**). The one external measurement used (2026-10-12: 8 requests, 360 tokens, $0.00) comes from the roadmap and `docs/generator.md`, and is used only to justify the upper-bound label. | **PASS** |
| **II. Nothing is "working" unless it ran** | Every success criterion has a named runnable check in [quickstart.md](./quickstart.md). All provider behaviour is exercised with mocked HTTP and stubbed providers and will be reported as "verified with mocks only". | **PASS** |
| **III. Project isolation enforced in one place** | `llm_call_usage` carries `project_id` and is registered in `src/server/db/project-owned.ts`, so `tests/integration/scope-check.test.ts` fails any unscoped query against it from the first one. All access goes through `createLlmUsageRepo(exec, projectId)` / `scope.llmUsage`; the only caller without a membership scope (`runLlmCheck`, which the CLI uses) gets `llmUsageRepoFor(projectId)` — the **same two-accessor pattern** `project_llm_settings` already uses. Composite foreign keys on `(project_id, series_id)` and `(project_id, generation_job_id)` make a cross-project link impossible at the database level. The screen reuses the existing server-side `llm_credential: ["manage"]` check. | **PASS** |
| **IV. One service layer, many callers** | One recorder (`src/server/llm/usage.ts`), one repository, one report service (`src/server/services/usage.ts`). The seven call sites wire the same recorder; the page, the job page and the post detail read the same service. No per-caller duplication. | **PASS** |
| **V. Providers are plug-ins** | No social provider, scheduler, composer or schema change. The LLM providers are untouched: the recorder is a decorator outside them, exactly like `withCreditHold`. | **PASS** |
| **VI. Boring, few dependencies** | No new runtime dependency and no new infrastructure. One migration. Rates live in environment variables — where every other operator setting already lives — not in a new table with a new admin surface (**M8**). | **PASS** |
| **VII. Secrets never leak** | A row holds ids, provider, model, source, purpose, outcome, two counts, latency and a timestamp — no prompt, output, provider error text, key, hash, prefix or length (**M7**, **FR-004**). The swallowed-failure log line carries none of them either. `tests/integration/no-plaintext.test.ts` dumps the new table automatically; the existing scanned secret-scan run is **extended** (never exempted) to render the Usage page for owner, admin and editor and to dump `llm_call_usage` (**FR-032**, **P17**). | **PASS** |
| **Engineering: Neon-safe, no session-level features** | Plain inserts and selects. No advisory locks, no `LISTEN`. Migration is additive and forward-only. | **PASS** |
| **Engineering: `runTick()` bounded, killable, concurrent-safe** | The flush is at most two rows in one statement, issued **after** the item's save transaction commits, outside any transaction, and swallowed on failure — so it spends the runner's own budget (`JOB_PERSIST_RESERVE_MS = 3_000`) and can never extend a lease or hold a lock. The ledger is insert-only, so two ticks writing while a reader aggregates neither block nor double-count (spec edge case "concurrency"). Killed mid-run: the item behaves exactly as today and the ledger under-counts by the rows not yet written — never over-counts (**M6**). | **PASS** |
| **Engineering: UTC storage, Temporal with explicit DST disambiguation** | `called_at` is `timestamptz`, always UTC. Period boundaries go through `PlainDateTime.toZonedDateTime(tz, { disambiguation: "compatible" })` — explicit, because `PlainDate.toZonedDateTime` accepts no such option (**P13**, verified in the installed polyfill's types). | **PASS** |
| **Engineering: accessibility, server components, `docket-ui`** | Server components only — the page adds **no** client component. `FilterTabs` over search-param links (shareable URLs, works without JavaScript), `Table`/`Row`/`Cell`/`Sub` with real `<th scope>`, four columns maximum with qualifying facts as `Sub` lines, semantic token classes with no `dark:` variants, all four states handled, `formatLocal`/`LocalTime` for every instant, `toLocaleString("en-US")` for every number. See [contracts/ui.md](./contracts/ui.md). | **PASS** |
| **Workflow: commits, quality gates, docs** | Conventional Commits with the required trailer, explicit paths only. `pnpm db:check` and `pnpm build` are in the final pass because the schema and the routes changed. **FR-033**'s four documents are tasks, not afterthoughts. | **PASS** |

**No violations. [Complexity Tracking](#complexity-tracking) is therefore empty.**

Two points worth naming so review judges them rather than discovering them:

1. **A new enum is added** (`llm_usage_purpose`). The spec's assumption forbids changing
   `llm_failure_kind` or `generation_job_item_error`; both are untouched. The new enum is additive
   and its seven values are the complete, closed list of labelled call sites.
2. **`ConfigValidation` gains a field** (`warnings`). This is the only way to satisfy **FR-011**
   ("log it and carry on") given that `issues` exits the process, and it extends the env-coverage
   guard rather than exempting the new variables from it (**P8**).

---

## Project Structure

### Documentation (this feature)

```text
specs/068-llm-cost-visibility/
├── spec.md                 # input
├── plan.md                 # this file
├── research.md             # Phase 0 — decisions P1–P19 with the sources they came from
├── data-model.md           # Phase 1 — the table, the enum, the derived report
├── contracts/
│   ├── config.md           #   rate configuration: grammar, parse table, startup behaviour
│   ├── services.md         #   repository, recorder, per-call-site wiring, report service
│   └── ui.md               #   the Usage page, the job block, the post detail row
├── quickstart.md           # Phase 1 — runnable validation, SC-001…SC-013
└── tasks.md                # Phase 2 — /speckit-tasks, NOT created here
```

### Source code (repository root)

```text
src/
├── server/
│   ├── db/
│   │   ├── schema/generation.ts        # + llmUsagePurpose enum, llmCallUsage table (CHANGED)
│   │   └── project-owned.ts            # + { table: "llm_call_usage", scopeColumn: "project_id" } (CHANGED)
│   ├── dal/
│   │   ├── llm-usage.ts                # NEW  repo: record (insert-only), summary, byModel, byPurpose, totalsForJob
│   │   └── scope.ts                    # + scope.llmUsage (CHANGED)
│   ├── llm/
│   │   ├── usage.ts                    # NEW  createUsageRecorder: wrap() + flush(); mirrors withCreditHold
│   │   ├── rates.ts                    # NEW  parseLlmRates, getLlmRates, rateFor, estimateMicros, formatMoney
│   │   ├── config.ts                   # + LLM_RATE_VARIABLES (deliberately NOT in LLM_VARIABLES) (CHANGED)
│   │   └── log.ts                      # UNCHANGED — FR-031
│   ├── startup/validate.ts             # + warnings channel for rate problems (CHANGED)
│   ├── startup/index.ts                # + log warnings, never exit on them (CHANGED)
│   └── services/
│       ├── usage.ts                    # NEW  getProjectUsage, getJobUsage, ESTIMATE_DISCLAIMER
│       ├── generation/
│       │   ├── core.ts                 # + recorder plumbed through runGeneration / StepOptions (CHANGED)
│       │   ├── single.ts               # + flush({ postId }) after the save (CHANGED)
│       │   ├── series.ts               # + plan flush({}), post flush({ seriesId, seriesPosition, postId }) (CHANGED)
│       │   ├── regenerate.ts           # + flush({ postId }) (CHANGED)
│       │   └── check.ts                # + recorder, flush in the existing finally (CHANGED)
│       ├── voice.ts                    # + flush({}) (CHANGED)
│       └── jobs/runner.ts              # + recorder in StepOptions, flush on every post-call exit (CHANGED)
├── lib/generation/
│   ├── usage-purpose.ts                # NEW  the seven purposes' human labels
│   └── usage-period.ts                 # NEW  usagePeriodWindow — Temporal, explicit disambiguation
└── app/p/[projectSlug]/
    ├── settings/
    │   ├── layout.tsx                  # + "Usage" behind the existing canManageLlm flag (CHANGED)
    │   └── usage/
    │       ├── page.tsx                # NEW  server component, per-request generateMetadata
    │       ├── dto.ts                  # NEW  instants → ISO for the view
    │       └── loading.tsx             # NEW  skeleton matching the layout
    ├── jobs/[jobId]/page.tsx           # + "Model usage" block, "to date" while active (CHANGED)
    └── generate/result/[postId]/page.tsx  # + Tokens row from the existing attempts blob (CHANGED)

drizzle/
└── <n>_llm_call_usage.sql              # NEW  pnpm db:generate, committed

tests/
├── integration/llm/
│   ├── usage-record.test.ts            # NEW  every call site; and no row when no call
│   ├── usage-failure.test.ts           # NEW  SC-009 — a forced write failure changes nothing
│   ├── usage-report.test.ts            # NEW  SC-001, FR-015, SC-006
│   ├── usage-rates.test.ts             # NEW  SC-003, SC-004, SC-005, SC-007, FR-011, FR-012
│   └── usage-authz.test.ts             # NEW  SC-010
├── integration/security/secret-scan.test.ts  # EXTENDED — Usage page ×3 roles, llm_call_usage dump
├── lint/env-coverage.test.ts           # EXTENDED — CONFIGURABLE + rate vars; probe accepts warnings
├── integration/docs/security-findings.test.ts # passes against the updated docs/security.md rows
└── (unit) src/server/llm/rates.test.ts, src/lib/generation/usage-period.test.ts  # NEW

docs/
├── generator.md                        # + Usage surface, where rates live, no prices ship, upper bound
├── security.md                         # + / updated rows for the new table and screens (FR-033)
├── decisions.md                        # + "## 058 — LLM cost visibility" with M1–M19 and P1–P19
└── .env.example                        # + LLM_RATES, LLM_RATE_CURRENCY in the Generator group
```

**Structure Decision**: the existing single-app layout, unchanged. The ledger is a DAL repository
plus a schema table; the recorder sits in `src/server/llm/` beside `log.ts` and `resolve.ts`, which
is where the other non-DAL-scoped LLM code already lives; the report is one service; the screen is
a settings sub-route beside `settings/model`, which is the surface it shares a permission with.

---

## Plan decisions

Recorded in `docs/decisions.md` as **P1–P19** under a new `## 058 — LLM cost visibility` heading,
after the spec's **M1–M19**. Full rationale and the sources each came from are in
[research.md](./research.md); P18 and P19 are new here.

| # | Decision |
|---|---|
| **P1** | The ledger is written by a provider decorator, not derived from the `attempts` blob — `attempts` has no per-call timestamp and carries a resumed step's earlier attempts forward, so deriving would mis-stamp and double-write. |
| **P2** | `UsageRecorder.wrap(llm)` mirrors `withCreditHold(llm, owner)`: wrap, observe, swallow, return unchanged. One reviewed idiom, not a second one. |
| **P3** | The series **plan** call carries no series link: `planSeries` runs before `startSeries` writes the row, and the person may never start it. **FR-003** allows it; inventing a series row would be the worse lie. |
| **P4** | Rows are buffered and flushed once, when the link is known. A dedup collision flushes with **no** post link — the call produced no post of its own. |
| **P5** | `purpose` is an explicit argument, never parsed from `label`, plus a source-scanning guard test — otherwise a new call site would lose its tokens silently under the swallow rule. |
| **P6** | Outcome is `ok boolean` + nullable `failure_kind llm_failure_kind` with `CHECK (ok = (failure_kind IS NULL))`: reuses the enum untouched, and "produced nothing" is one predicate. |
| **P7** | The ledger records the **provider's** outcome, not Docket's acceptance of it. A call the provider answered but whose output failed Docket's platform checks reads `ok`. Stated in `docs/generator.md` so nobody reads `ok` as "this output was used". |
| **P8** | Rate problems are **non-fatal**: `ConfigValidation` gains `warnings`, logged by name and reason and never exiting. The env-coverage probe is extended to accept `warnings` — extended, not exempted. |
| **P9** | The rate variables sit in a new `LLM_RATE_VARIABLES`, **outside** `LLM_VARIABLES`, because `llmEnvIssues` would otherwise demand `LLM_PROVIDER` — and after entry 2 an install may have no install default while its projects spend their own keys. |
| **P10** | Format: `<provider>:<model>=<input>/<output>`, whitespace- or comma-separated; provider split at the first `:`, prices at the last `=`. Whitespace is provably safe — no model string may contain one. |
| **P11** | The currency is validated by **shape** (three ASCII letters), never against a remembered code list, and `Intl.NumberFormat`'s `style: "currency"` is not used because a shaped-but-unassigned code throws. |
| **P12** | Money arithmetic is exact integer `BigInt` micro-units; `tokens × price` overflows a double at realistic volumes. A non-zero amount rounding to `0.00` renders "under 0.01", so a **configured zero** stays distinct. |
| **P13** | A dedicated `usagePeriodWindow` with explicit `disambiguation: "compatible"`, not Activity's `windowFor` whose disambiguation is implicit and whose range vocabulary belongs to Activity. |
| **P14** | Two accessors, like `project_llm_settings`: `scope.llmUsage` and `llmUsageRepoFor(projectId)` for `runLlmCheck`, which has a project id and no scope. |
| **P15** | `(project_id, called_at DESC)` plus a partial `(project_id, generation_job_id)`. **No rollup table** and no unique index — a duplicate-suppressing key would turn a swallowed retry into an over-count, the one direction **M6** rules out. |
| **P16** | `generation_job_id` is stored beside `generation_job_item_id`, so **FR-028** is one indexed aggregate on the busiest screen instead of a join. |
| **P17** | The secret scan **extends the existing scanned run** — it does not add a second one — with the Usage page for all three roles and a `llm_call_usage` dump. |
| **P18** | **FR-029 reads the existing `attempts` blob, not the ledger.** It already carries `usage` per attempt, it is already loaded with the post, and it covers posts generated before this entry shipped — so the post generation detail needs no query, no migration and no backfill. |
| **P19** | **Money appears only on the Usage surface.** The job page and the post generation detail show calls and tokens alone. **FR-019** scopes money to "the surface" and **FR-028**/**FR-029** ask only for calls and tokens; keeping money behind the owner/admin gate makes **SC-003** hold by construction on both pages and keeps **SC-005** (never a figure without the sentence) provable in one place. Consequence, stated: an editor who can already read a job page sees that job's token counts — facts about work they did, already sitting beside the latency the page shows today — but never a money figure or a project total. |

### Two things the spec says that the code does not allow, resolved

Named here so the next phase does not have to rediscover them, and so review can judge the
resolution rather than the surprise.

1. **"A series … all tied to the same series" (spec edge case).** The plan call happens before the
   series exists. Resolved by **P3**: the plan row has no series link and is attributed by purpose.
   **FR-003** explicitly permits it.
2. **`M1–M19` collides with an existing `M1–M18`.** `docs/decisions.md:1554` already has a
   `### Plan decisions (M1–M18)` block, belonging to entry **056 — Per-event read state and
   snooze**. **FR-033** requires this entry's decisions to be recorded as M1–M19, so the labels
   stay; the new heading reads `### Spec decisions (M1–M19 — this entry's; the M1–M18 under 056 are
   a different set)`, and plan decisions take the unused letter **P**. Changing the spec's labels
   would be worse: every cross-reference in spec.md points at them.

---

## Phase 0 — Outline & Research

**Output**: [research.md](./research.md) — complete.

Seventeen decisions (**P1–P17**; **P18** and **P19** are design choices made in this file), each
with a *Decision / Rationale / Alternatives considered* and the file and line the facts were read
from: where usage exists today and where it dies; what each of
the seven call sites knows when its call returns; how the outcome reuses the failure enum without
changing it; where rates can and cannot live, and the three existing tests that constrained the
answer; period boundaries and the exact Temporal API available in the installed polyfill; project
scoping and the one caller with no scope; volume against the 2-second budget; and the secret-scan
extension. § 9 lists what Docket deliberately does **not** know — no price, no currency list, no way
to tell a free call from a billed one — and records that no `NEEDS CLARIFICATION` or `NEEDS
RESEARCH` remains.

## Phase 1 — Design & Contracts

**Outputs**: [data-model.md](./data-model.md), [contracts/config.md](./contracts/config.md),
[contracts/services.md](./contracts/services.md), [contracts/ui.md](./contracts/ui.md),
[quickstart.md](./quickstart.md) — complete.

- **data-model.md** — `llm_call_usage` column by column with its eight CHECK constraints, composite
  foreign keys and two indexes; what is deliberately absent and why; the `llm_usage_purpose` enum;
  `ModelRate`/`LlmRates` as configuration rather than a table; `UsageReport` as a derived answer
  with six invariants, each tied to a success criterion; the relationship to everything that already
  exists; and the migration, with "no backfill" stated.
- **contracts/config.md** — the two environment variables with their `.env.example` blocks, the
  grammar, a row-by-row parse table including every rejection, the non-fatal startup behaviour and
  the extended env-coverage probe, and the lookup and arithmetic signatures.
- **contracts/services.md** — the repository (insert-only, two accessors), the recorder's signature
  and its seven guarantees, the wiring table for all seven call sites including the runner's
  every-exit rule, the report service's shapes, the period windows, and the money rules as
  code-level invariants. Ends with what is **not** added.
- **contracts/ui.md** — the route, its access table, the period control, the layout, both tables at
  four and three columns, all four states, the accessibility rules, and the wording rules a test
  enforces; then the job page block and the post detail row, both money-free.
- **quickstart.md** — seven runnable checks mapping **SC-001** – **SC-013** to commands and
  expected assertions, plus a real-app walkthrough and a "done when" list.

## Phase 2 — Tasks

**Not produced by this command.** `/speckit-tasks` generates `tasks.md` from these artifacts.
Suggested ordering, following the spec's own priorities: schema + migration + repo → recorder and
the seven call sites (US1, US5 — both P1) → the report service and period windows → the Usage page
→ rates, startup and the money rules (US2, US3 — P2) → the job block and the post detail row
(US4 — P3) → the secret-scan extension and **FR-033**'s four documents.

The honest half (US1) must land first and stand alone: it needs no unverifiable fact, and
**FR-023** means an install that never configures a rate gets a complete, useful screen.

---

## Complexity Tracking

No constitution violations, so this section is empty by design.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | | |

---

## What this plan does not do

Carried from the spec's own out-of-scope list, which the roadmap leaves with **no later owner** —
this is the last entry.

- No budgets, caps, throttling or blocking generation on spend. The ledger would be the natural
  input to it; that is a reason to keep it clean, not to build it.
- No billing, invoices, plans, seats or payment.
- No reconciliation against a provider's billing or usage API, and no estimate of what share of
  usage was free — `service_tier` is processing priority, not billing attribution.
- No per-project rates, no currency conversion, no rates that vary over time.
- No backfill from existing `generation_metadata` blobs.
- No export, API, webhook, notification or email; no install-wide or cross-project report; no
  per-user attribution.
- No change to entry 1's hold mechanics or entry 2's credential storage, resolution, check or
  audit.
- No pruning, archiving or rollup of usage rows.
- Nothing for image generation — `src/server/llm/image-generation.ts` is an extension point with no
  implementation, so there is nothing to record.
