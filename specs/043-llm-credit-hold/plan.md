# Implementation Plan: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

**Branch**: `059-llm-credit-hold` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/043-llm-credit-hold/spec.md`

## Summary

Three pieces, in dependency order.

**1. A ninth failure kind.** `credit_exhausted` joins `LlmFailureKind`, both pgEnums
(`llm_failure_kind`, `generation_job_item_error`), the attempt-record Zod enum
(`src/lib/validation/generation.ts`) and the fixed-message map. Each provider gets one named predicate,
`isCreditRefusal(error)`, checked immediately after the timeout branch of `kindOfError` and therefore
**before** `RateLimitError → rate_limited` and before `BadRequestError → bad_request` (FR-003). Both predicates
read the SDK's **structured** fields, never the composed `Error.message`: OpenAI's `APIError.code ===
"insufficient_quota"`, and Anthropic's `APIError.type` — which the installed SDK declares as `billing_error`
**or** `invalid_request_error` whose body message matches `/credit balance/i` (H3; `billing_error` is a verified
member of the SDK's own `ErrorType`, so detection does not rest on wording alone). Anything unmatched keeps
today's kind exactly (FR-004), so a non-billing 400 or 429 cannot stall an install.

**2. A hold the runner obeys, keyed by credential owner.** One install-wide table, `llm_credit_holds`, at most
one row per owner, carrying only `owner`, `held_since`, `last_refusal_at`, `next_probe_at` — no key, no hash, no
prefix (FR-020). One DAL module owns every read and write (FR-030). Who owns a job's credential comes from one
named, **already async and already SQL-aware** seam (`src/server/dal/credential-owners.ts`), today a constant and
a predicate that keeps nothing when the install owner is blocked; entry 2 replaces only that file (FR-012,
SC-010). Inside the claim transaction a gate reads who is held, then takes `FOR UPDATE SKIP LOCKED` on the
held rows that are due a probe and moves `next_probe_at` forward in the same transaction — exactly one probe per
five minutes however many workers tick, with no advisory lock and no wait (FR-015, C10). Blocked owners are
excluded in SQL so they cannot crowd a free owner's jobs out of the tick's `limit`; a probing owner is capped at
one item, and its item is picked from `queued`-and-due rows only, so lease recovery can never count an attempt
or fail a held item as `interrupted` (FR-013, US1 AS5).

**3. Nothing fails, and the screens say why.** A billing refusal in the runner is `release()` plus a recorded
reason: `queued`, `nextAttemptAt = now`, lease cleared, `pendingRetry` cleared, **attempt count untouched**,
status refreshed, counted as its own tick outcome `requeued` (FR-007–FR-009). `credit_exhausted` is in neither
`TEMPORARY` nor the in-request `RETRYABLE` sets, so no backoff path and no correction retry can reach it
(FR-006, FR-010). Recovery is never guessed: one wrapper around the provider — applied inside
`runGenerationStep` and `planSeries`, the only two places a provider is used — upserts the hold on a billing
refusal and deletes it on **any** other outcome, from every caller including interactive generation and
`pnpm llm:check` (FR-017, FR-018). A granted probe that never reaches a model call rewinds `next_probe_at`, so
a tick-budget shortfall never spends the interval (FR-016). Both Batch jobs screens carry one honest notice in
the shape of the two that already live on the job page, naming billing, saying the items are waiting and not
failed, that they resume by themselves, what to do, and since when — in the project's zone and the one date
format. No status enum, badge or derived-status rule moves.

No new dependency, environment variable, infrastructure, public-API operation or `docker-compose.yml` change.
One migration: two `ALTER TYPE … ADD VALUE` and one `CREATE TABLE`. An empty table reproduces `main` to the
row (FR-031, SC-007).

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router, standalone)

**Primary Dependencies**: `@anthropic-ai/sdk` and `openai` (error classes and their declared body shapes read
from `node_modules`, not memory), `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4, Tailwind 4.
Nothing added.

**Storage**: Postgres. One new **install-wide** table, `llm_credit_holds` (registered in `notProjectOwned`,
beside `scheduler_heartbeats` and `install_state`). Two existing pgEnums gain one value each. No project-owned
table changes; no new index on any existing table.

**Testing**: Vitest against a real Postgres. Provider detection goes into the shared scenario table
(`tests/helpers/llm-scenarios.ts`, run for both providers) over `createFakeLlmFetch` — mocked HTTP only,
never a live call (constitution II). Runner, hold, probe and multi-hour-outage behaviour in
`tests/integration/jobs/`; the two screens in `tests/integration/jobs/ui.test.tsx`; secrets in
`tests/integration/security/secret-scan.test.ts` and `tests/integration/no-plaintext.test.ts`.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the connection
string changed. No session-level Postgres feature: the probe's single-flight is a row lock taken and released
inside the claim transaction.

**Project Type**: web application (one Next.js app; provider layer + DAL + services + React server components).

**Performance Goals**: SC-002 — at most 12 model calls an hour per credential owner during an outage, against
≈120 today. The gate adds two short statements to the claim transaction when a hold exists and **one** when the
table is empty (a scan of a table with zero rows); the hold write adds one upsert or one delete per model call.

**Constraints**: no provider call inside a held transaction (unchanged); the claim must not wait (the gate uses
`SKIP LOCKED`, and a row it cannot lock is treated as held-and-not-probing); the probe interval is a documented
constant, not an environment variable (FR-014); `credit_exhausted` must never be added to `TEMPORARY` or
`RETRYABLE`; no provider error text, account identifier or key may enter a log line, a stored row, a response
or the UI (FR-032).

**Scale/Scope**: one credential owner today, designed for many. Touches 1 schema file, 1 migration, 2 provider
files, 3 `src/server/llm` files, 1 lib validation file, 2 new DAL modules, 1 DAL claim module, 3 generation
service files, 1 jobs service file, 1 jobs runner, 1 scheduler section, 3 app files (2 pages + 2 notice
components) + 1 item table, 1 script, 4 docs and ~14 test files.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design. No violations; Complexity Tracking is empty.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass** | Every SDK fact is read from the installed packages and recorded in [research.md](./research.md): `APIError.status/.type/.error` and `ErrorType` (including `billing_error`) from `node_modules/@anthropic-ai/sdk/core/error.d.ts` and `resources/shared.d.ts`; `APIError.code/.type/.error` from `node_modules/openai/core/error.d.ts`; and the asymmetry that Anthropic hands `APIError.error` the **whole** body while OpenAI hands it the inner `error` object (`core/error.js`). The two wording facts the spec attributes to the author (Anthropic's credit-balance message, OpenAI's `insufficient_quota`) are not in `docs/research/`, so detection is narrow by design, degrades to today's behaviour when unmatched (FR-004), and is proven with mocked HTTP only. Next 16 App Router usage follows `node_modules/next/dist/docs/01-app/`, read by the implement phase before the pages are touched. Nothing is guessed and nothing is left `NEEDS RESEARCH`. |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement has a Vitest check listed in [quickstart.md](./quickstart.md), all with mocked HTTP. No live provider call anywhere. The simulated two-hour outage is a real tick loop against real Postgres with a pinned clock, not a unit stub. |
| III. Project isolation in one place | **Pass** | `llm_credit_holds` is **not** project-owned: it goes in `notProjectOwned`, like `scheduler_heartbeats`, so `project-owned.test.ts` keeps passing and the scope harness is unaffected. No project-owned table, no `project_id` and no role rule changes. The screens read the hold through `src/server/services/jobs/read.ts` (which already reads install-wide state via `getLlmStatus()` and `schedulerConfig`), never the database client; the claim's gate runs inside the existing `crossProject("scheduler: claim due job items")` section. Every role that can view Batch jobs sees the notice, and it reveals only that the provider account has no spendable credit (FR-027). |
| IV. One service layer, many callers | **Pass** | One DAL module (`src/server/dal/credit-holds.ts`) is the only reader and writer of the hold (FR-030). One seam (`src/server/dal/credential-owners.ts`) is the only place an owner is decided (FR-012). One wrapper (`withCreditHold`) is the only place an outcome becomes a hold change, applied at the two points where a provider is actually used, so the job runner, single, series, series-plan, regenerate, voice "Try it" and `pnpm llm:check` all behave identically with no per-caller logic (FR-017). One predicate per provider (FR-004). |
| V. Providers are plug-ins | **N/A** | Social providers, the scheduler's publishing section, the composer and their schema are untouched. The LLM layer is not the social-provider plug-in system. |
| VI. Boring, few dependencies | **Pass** | No runtime dependency, no infrastructure, no queue, no Redis, no environment variable, no new `src/components/ui/` primitive. One table, one migration, and two route-local notice components that render the markup the job page already uses. |
| VII. Secrets never leak | **Pass** | The hold row is four columns: an owner identity and three instants — no credential value and no fingerprint, hash or prefix of one (FR-020), and the owner is a project/install identity by construction, never derived from a key. Detection reads the provider's body but puts only `kind` into the result; `llmFailureMessage` supplies the sentence, `logLlmCall` logs only the fixed fields it logs today, and the runner's `logLine` redaction already covers every new line. The secret-scan suite is **extended, not exempted**: a billing refusal whose body embeds the configured key, scanned through logs, service results, stored rows and both rendered screens, plus the two keys and their SHA-256 hex added to `no-plaintext`'s all-tables scan with a hold row present (FR-033). |
| Engineering: Neon, no session-level features | **Pass** | The probe's single-flight is `SELECT … FOR UPDATE SKIP LOCKED` plus an `UPDATE` inside the claim transaction — transaction-scoped and pooler-safe. No advisory lock, no `LISTEN`. Migrations still run on the direct URL. |
| Engineering: bounded, concurrent, killable tick | **Pass** | The gate adds two statements to an existing transaction; no provider call moves inside it. Two concurrent ticks make exactly one probe, and a tick killed mid-probe leaves a `running` item that the hold itself protects from recovery (US1 AS5). A granted probe that never calls the model rewinds the interval, so a kill costs one interval at most. |
| Engineering: UTC and Temporal | **Pass** | All three hold instants are `timestamptz` in UTC, written from the engine clock (`src/server/dal/clock.ts`) so tests can simulate hours of ticks. No wall-clock arithmetic and no DST decision is involved — the probe interval is a fixed duration. The notice renders `held_since` through `LocalTime` in the project's zone. |
| Engineering: accessibility, server components | **Pass** | Both notices are plain text in a server component with `role="note"` — conveyed as text, not colour; reachable and readable with the keyboard alone; announced **no more aggressively than today's** (deliberately not `Alert`, whose warning tone defaults to `role="alert"`). The waiting row gains a `Sub` line and offers no retry control. Follows the `docket-ui` skill and `docs/design-system.md`; the instant goes through `LocalTime`, so `tests/lint/date-format.test.ts` stays green. With no hold, both screens render markup identical to `main`. |
| Workflow: migration committed, `db:check` green | **Pass** | One generated SQL migration: two `ALTER TYPE … ADD VALUE` and one `CREATE TABLE`, the same combination migration `0004` already ships. The new label is added but never *used* in the same transaction, so it is safe inside drizzle's transactional migration on Postgres 12+. No row is rewritten or reclassified; no operator action (FR-029, C14). |
| Workflow: docs | **Pass** | FR-034–FR-037: `docs/generator.md` under the existing "Configuring a provider" and "Jobs" headings (headings unchanged — `published-docs.test.ts` pins anchors); `docs/decisions.md` records the spec's C1–C14 and this plan's H1–H19 next to the generator decisions; `docs/n8n.md` § 4; `docs/security.md` rows extended so `security-findings.test.ts` stays green. Each doc states what this entry does not do and which later entry owns it. |

## Project Structure

### Documentation (this feature)

```text
specs/043-llm-credit-hold/
├── spec.md              # Input (C1-C14)
├── plan.md              # This file
├── research.md          # Phase 0: verified SDK facts + plan decisions H1-H19
├── data-model.md        # Phase 1: the table, the enums, the invariants, the migration, every statement
├── quickstart.md        # Phase 1: how to run it and the checks that prove each user story
├── contracts/
│   ├── providers.md     # Detection: the two predicates, their inputs, and what must not change
│   ├── services.md      # DAL, seam, wrapper, runner and read-service signatures and outcomes
│   └── ui.md            # The notice and the waiting row: wording, shape, keyboard, announcements
├── checklists/          # Existing
└── tasks.md             # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/
│   ├── validation/generation.ts      # + "credit_exhausted" in the attempt-record enum
│   └── jobs/credit-hold.ts           # NEW  the notice's fixed strings (pure, testable)
├── server/
│   ├── db/
│   │   ├── schema/generation.ts      # + "credit_exhausted" in llmFailureKind; + llmCreditHolds table
│   │   ├── schema/jobs.ts            # + "credit_exhausted" in generationJobItemError
│   │   └── project-owned.ts          # + "llm_credit_holds" in notProjectOwned
│   ├── llm/
│   │   ├── types.ts                  # + the kind, in the union and LLM_FAILURE_KINDS
│   │   ├── messages.ts               # + its one fixed sentence
│   │   ├── anthropic.ts              # + isCreditRefusal(), checked after timeout
│   │   └── openai.ts                 # + isCreditRefusal(), checked after timeout
│   ├── dal/
│   │   ├── credit-holds.ts           # NEW  the only reader/writer; the gate; the interval constant
│   │   ├── credential-owners.ts      # NEW  the FR-012 seam: owner + "exclude these owners" SQL
│   │   └── job-claims.ts             # gate inside the transaction; per-owner budget; {items,held,probing}
│   ├── scheduler/generation.ts       # + requeued / held / probed in GenerationCounts
│   └── services/
│       ├── generation/
│       │   ├── credit.ts             # NEW  withCreditHold(llm, owner): the FR-017 observation point
│       │   ├── core.ts               # wraps its llm argument; credit_exhausted stays out of RETRYABLE
│       │   └── series.ts             # wraps its llm argument; same RETRYABLE rule
│       └── jobs/
│           ├── runner.ts             # requeue instead of fail; probe rewind; TEMPORARY untouched
│           └── read.ts               # + getJob().creditHold and generationCreditHold(scope)
└── app/p/[projectSlug]/jobs/
    ├── JobNotice.tsx                 # NEW  the shape the job page's two notices already use
    ├── CreditHoldNotice.tsx          # NEW  the billing notice (server component, LocalTime)
    ├── page.tsx                      # renders the notice when the project is held
    └── [jobId]/
        ├── page.tsx                  # third notice beside not-configured and tick-budget
        └── JobItemsTable.tsx         # a queued credit_exhausted row reads as waiting, with its reason

scripts/
└── llm-check.ts                      # wraps the provider; tolerates no database

drizzle/
└── 0021_*.sql                        # NEW  two ALTER TYPE ADD VALUE + CREATE TABLE llm_credit_holds (+ meta/)

tests/
├── helpers/
│   ├── llm-scenarios.ts              # + billing-refusal and non-billing scenarios, per-provider wire bodies
│   ├── fake-llm.ts                   # + a step that fails as credit_exhausted
│   └── jobs-env.ts                   # + seed/read/clear a hold; run a tick as a second credential owner
├── integration/
│   ├── jobs/
│   │   ├── credit-hold.test.ts       # NEW  requeue, no attempt, hold, no claim, resume, two owners
│   │   ├── credit-probe.test.ts      # NEW  interval, single-flight, rewind, budget, clock jumps
│   │   ├── credit-outage.test.ts     # NEW  the simulated two-hour outage and its recovery
│   │   ├── recovery.test.ts          # claimDueJobItems now returns { items, held, probing }
│   │   ├── dal.test.ts               # same
│   │   ├── cancel.test.ts            # + cancel and "Retry failed items" during a hold
│   │   ├── no-secrets.test.ts        # + a billing refusal whose body carries the configured key
│   │   └── ui.test.tsx               # + both screens held and not held, the waiting row, no retry action
│   ├── generation/provider-parity.test.ts   # + the new kind through the real provider + fake fetch
│   ├── api/endpoints/jobs.test.ts    # + a held job's payloads, schema unchanged
│   ├── security/secret-scan.test.ts  # + the billing-refusal path (FR-033)
│   └── no-plaintext.test.ts          # + the two keys and their hashes; a hold row present
└── (unit) src/server/llm/messages.test.ts, anthropic.test.ts, openai.test.ts,
        src/server/dal/credential-owners.test.ts, src/lib/jobs/credit-hold.test.ts,
        scripts/llm-check.test.ts

docs/
├── generator.md        # "Configuring a provider" + "Jobs": what a billing refusal is and is not
├── decisions.md        # C1-C14 (spec) and H1-H19 (plan), next to the generator decisions
├── n8n.md              # § 4: a queued item carrying credit_exhausted needs no retry
└── security.md         # the rows that name the extended scans
```

**Structure Decision**: the existing single Next.js app, with every concern in the folder that already owns
it — detection in `src/server/llm/`, the hold and the owner seam in `src/server/dal/`, the observation point in
`src/server/services/generation/`, the claim decision in `src/server/dal/job-claims.ts`, the tick summary in
`src/server/scheduler/generation.ts`, and the notice inside the existing
`src/app/p/[projectSlug]/jobs/` route folder rather than as a new shared UI primitive. No new directory.

## Phase 0 — Research

No `NEEDS CLARIFICATION` and no `NEEDS RESEARCH` remain. The spec resolved every product judgement call
(C1–C14); what was left was (a) exactly what the two installed SDKs expose, which is read from `node_modules`
rather than remembered, and (b) nineteen design choices about this repository's own code.
[research.md](./research.md) records the verified SDK facts with their file paths, the nineteen plan decisions
H1–H19 with the alternative each rejects, and the two places where this plan deliberately goes beyond the
spec's illustration (Anthropic's `billing_error`, and rewinding a probe that never reached a model call).

## Phase 1 — Design

- [data-model.md](./data-model.md): `llm_credit_holds`, the two enum additions, the invariants, the migration
  and its transaction safety, and the exact shape of every statement that is added or changed.
- [contracts/providers.md](./contracts/providers.md): the two detection predicates, the structured fields they
  read, the order they run in, and the mappings that must not move.
- [contracts/services.md](./contracts/services.md): the DAL module, the owner seam, the provider wrapper, the
  claim's new result, the runner's new outcome, the tick summary's new fields and the read service's additions.
- [contracts/ui.md](./contracts/ui.md): the notice's wording and shape on both screens, the waiting row, the
  keyboard and announcement rules, and what must be unchanged when there is no hold.
- [quickstart.md](./quickstart.md): how to run it, and the check that proves each user story and success
  criterion.

**Post-design Constitution re-check**: still passing, with no new risk introduced by the design. The table is
install-wide and outside the project-scope rules; the probe needs no session-level Postgres feature; the owner
seam is async and SQL-aware from day one so entry 2 rewrites one file; detection degrades to today's behaviour
on anything unmatched; nothing new can fail, cancel or unreserve anything; and no path this entry adds can
carry a secret, which the extended secret-scan proves by a deliberate leak. Complexity Tracking stays empty.

## Complexity Tracking

No constitution violation to justify.
