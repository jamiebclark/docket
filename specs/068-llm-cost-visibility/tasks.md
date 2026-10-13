---

description: "Task list for LLM cost visibility — show a project what it used"
---

# Tasks: LLM cost visibility — show a project what it used

**Input**: Design documents from `specs/068-llm-cost-visibility/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md) (P1–P17),
[data-model.md](./data-model.md), [contracts/config.md](./contracts/config.md),
[contracts/services.md](./contracts/services.md), [contracts/ui.md](./contracts/ui.md),
[quickstart.md](./quickstart.md)

**Tests**: Included. The spec and plan require them explicitly (constitution II: "nothing is working
unless it ran"; FR-032's extended secret scan; the per-story test files quickstart.md names). Every
usage figure in every test comes from a stubbed provider reporting known counts — no test opens a
socket to a provider (constitution II).

**Organization**: Tasks are grouped by the spec's five user stories. US1 and US5 are both P1 — the
honest half (calls and tokens) and the leak-proofing that must hold from the first row written — and
are built together since US5's guarantees (no leak, no cost to the generation) are properties of the
same recorder US1 introduces. US2 and US3 (money, both P2) ride on US1's ledger. US4 (tracing, P3)
needs only US1's rows to exist, plus one unrelated read of the existing `attempts` blob.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task in this set)
- **[Story]**: US1 / US2 / US3 / US4 / US5, per spec.md
- Every task names an exact file path

## Path Conventions

Existing single Next.js application. `src/server/` (DAL, services, llm provider layer), `src/app/`
(routes), `src/lib/` (shared validation and text), `drizzle/` (migrations), `tests/` (integration),
colocated `*.test.ts` beside the module they test.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The one new table, enum and migration everything else is built on.

- [X] T001 Add the `llmUsagePurpose` pgEnum (the seven values from data-model.md §2) and the
  `llmCallUsage` table (every column, all eight CHECK constraints, the composite foreign keys on
  `(project_id, series_id)` and `(project_id, generation_job_id)`, and the two indexes from
  data-model.md §1) to `src/server/db/schema/generation.ts`, beside `projectLlmSettings`
- [X] T002 Register `{ table: "llm_call_usage", scopeColumn: "project_id" }` in
  `src/server/db/project-owned.ts`
- [X] T003 Generate migration `drizzle/0026_*.sql` (+ `drizzle/meta/`) for T001–T002 with
  `pnpm db:generate`, confirm it matches data-model.md §6 (one `CREATE TYPE`, one `CREATE TABLE` with
  its checks, FKs and indexes, no change to any existing table), and run `pnpm db:check`

**Checkpoint**: the ledger's shape exists in the database; nothing yet writes to it.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The repository, the recorder and the shared text every user story calls. No user story
can start until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Create `src/server/dal/llm-usage.ts`: `LlmUsageLink`, `LlmUsageInsert`, `UsageWindow`,
  `UsageTotals`, `ModelTotals`, `PurposeTotals`, `LlmUsageRepo` (`record` — insert-only, one statement,
  no transaction handle; `summary`, `byModel`, `byPurpose`; `totalsForJob`),
  `createLlmUsageRepo(exec, projectId)` and `llmUsageRepoFor(projectId)` per contracts/services.md §1
  (depends on T001, T002)
- [X] T005 Wire `scope.llmUsage = createLlmUsageRepo(...)` into `ProjectScope` in
  `src/server/dal/scope.ts` (depends on T004)
- [X] T006 [P] Create `src/lib/generation/usage-purpose.ts`: the human label map for the seven
  `UsagePurpose` values ("Single post", "Series plan", "Series post", "Regenerate", "Batch job item",
  "Voice try it", "Credential check"), beside `src/lib/generation/llm-source.ts`
- [X] T007 [P] Create `src/lib/generation/usage-period.ts`: `UsagePeriod`, `USAGE_PERIODS`,
  `DEFAULT_USAGE_PERIOD`, and `usagePeriodWindow(period, timeZone, now)` using
  `PlainDate.toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: "compatible" })` per
  contracts/services.md §4 and research.md §5 (P13) — half-open `[from, to)`, `all` returns
  `{ from: null, to: null }` with no zone lookup
- [X] T008 [P] Write `src/lib/generation/usage-period.test.ts`: unit coverage for `30d`/`month`/
  `last-month`/`all` boundaries, including `last-month` across a DST transition inside the period in
  `America/Santiago` and `America/Havana`, landing on the project's own midnight with
  `disambiguation: "compatible"` resolving a deleted midnight forward (SC-013)
- [X] T009 Create `src/server/llm/usage.ts`: `UsagePurpose`, `UsageRecorder` (`wrap`, `flush`),
  `createUsageRecorder({ projectId, purpose, source, repo? })` mirroring `withCreditHold` exactly —
  buffer every observed call, swallow and log a redacted line on any `flush`/`record` failure, clear
  the buffer on flush, no-op on an empty buffer — per contracts/services.md §2 and research.md §1–2
  (P1, P2, P4) (depends on T004)
- [X] T010 [P] Write `src/server/llm/usage.test.ts`: `wrap` never alters, delays beyond its own
  buffering, or replaces `generate`'s return value; `flush` is a no-op on an empty buffer; a second
  flush writes nothing twice; only calls this recorder observed are written; a forced repo failure is
  swallowed and logged with no prompt, output or credential in the line (depends on T009)
- [X] T011 [P] Add a source-scanning guard test (same technique as
  `src/server/llm/no-model-literal.test.ts`) asserting every `label:` literal reaching `llm.generate`
  in `src/` has a matching `UsagePurpose` passed to a recorder, so a new call site with no purpose
  fails the build instead of losing its tokens silently (research.md P5)

**Checkpoint**: the repository and the recorder exist and are correct in isolation; every user story
below only has to wire them in.

---

## Phase 3: User Story 1 - An owner sees what their project has used (Priority: P1) 🎯 MVP

**Goal**: Every call site that reaches a provider records one row — purpose, provider, model,
credential source, outcome, token counts, latency and timestamp, linked to its generation where one
exists — and a project's owner can read calls, tokens, the per-model/per-purpose breakdown and the
credential-source split for a chosen period, with no rate configured at all.

**Independent Test**: run generations through a stubbed provider that reports known usage across all
seven call sites, then load the Usage screen and assert the calls, input tokens, output tokens,
per-model rows and credential-source split match what the stub reported.

### Tests for User Story 1

- [X] T012 [P] [US1] Write `tests/integration/llm/usage-record.test.ts`: one case per call site from
  quickstart.md §1 — `generate.single` (1 row, `post_id` set); a retry after `invalid_output` (2 rows,
  the first `ok=false, failure_kind='invalid_output'`); `planSeries` + two `writeSeriesPost` calls (1
  plan row with no series link, 2 post rows with `series_id`/`series_position`); `regenerate` (1 row,
  `post_id` set); a 2-item batch job (2 rows with `generation_job_id` and `generation_job_item_id`); a
  job item deferred to a later tick (2 rows, each its own `called_at`, the first not rewritten);
  `tryVoice` and `runLlmCheck` (1 row each, every link null); held-on-billing / over the 16-group
  limit / generation not configured / key unreadable (0 rows each); a stub reporting
  `{ inputTokens: null, outputTokens: null }` (1 row, both columns `NULL`)
- [X] T013 [P] [US1] Write `tests/integration/llm/usage-failure.test.ts`: with `record` forced to
  reject, run the same single generation twice (write succeeding, write failing) and assert the
  generation's outcome, the saved post row and the returned result are identical; assert the write
  happens after the save transaction commits; assert the logged failure line carries no prompt, output
  or credential
- [X] T014 [P] [US1] Write `tests/integration/llm/usage-report.test.ts`: `totals.calls ===
  sum(byModel.calls) === sum(byPurpose.calls)` with input/output sums matching the stub; the
  credential-source split (ten calls on the install's credential, five more after a project key is
  stored, all fifteen appear split 5/10, the first ten keep their attribution after the key is later
  removed); a period containing only no-count calls (`calls` non-zero, both token totals 0,
  `callsWithoutCounts === calls`); a call one millisecond before `from` excluded, one at `from`
  included, one at `to` excluded

### Implementation for User Story 1

- [X] T015 [US1] Update `src/server/services/generation/core.ts`: `runGeneration` creates a
  `UsageRecorder` from the resolved credential's `source` and plumbs it through `StepOptions` so
  `runGenerationStep` wraps the `llm` it is handed before calling it, for both the first call and the
  correction retry (depends on T009)
- [X] T016 [US1] Update `src/server/services/generation/single.ts`: flush `{ postId }` after the save
  transaction commits; on failure or a dedup collision, flush `{}` (P4) (depends on T015)
- [X] T017 [US1] Update `src/server/services/generation/series.ts`: `planSeries` creates its own
  recorder beside `withCreditHold` and flushes `{}` immediately after the call (P3); `writeSeriesPost`
  flushes `{ seriesId, seriesPosition, postId }` after the save, or `{ seriesId, seriesPosition }` on
  failure (depends on T015)
- [X] T018 [US1] Update `src/server/services/generation/regenerate.ts`: flush `{ postId }` — known
  before the call (depends on T015)
- [X] T019 [US1] Update `src/server/services/jobs/runner.ts`: add `recorder` to `StepOptions` beside
  the existing `owner`, and flush `{ generationJobId, generationJobItemId }` on **every** exit of the
  step once the model has been called — deferred, failed, requeued, cancelled, stale or saved —
  keyed off the same flag the runner already keeps for "called the model" (depends on T015)
- [X] T020 [P] [US1] Update `src/server/services/voice.ts`: `tryVoice` flushes `{}` via `runGeneration`
  (depends on T015)
- [X] T021 [P] [US1] Update `src/server/services/generation/check.ts`: `runLlmCheck` creates its own
  recorder beside `withCreditHold(resolved.llm, resolved.owner)` and flushes `{}` in the same `finally`
  that releases the check lease (depends on T009)
- [X] T022 [US1] Create `src/server/services/usage.ts`: `UsagePeriod` re-export, `ESTIMATE_DISCLAIMER`
  (empty placeholder string here — filled in by US2), `UsageTotals`, `ModelUsageRow`, `UsageView`
  (without the `money` field yet), `getProjectUsage(scope, period)` — `requirePermission(scope, {
  llm_credential: ["manage"] })`, resolve the window via `usagePeriodWindow` with
  `scope.project.timezone`, aggregate via `scope.llmUsage`, and shape `byModel`/`byPurpose` per
  contracts/services.md §4 — and `getJobUsage(scope, jobId)` (depends on T005, T007)
- [X] T023 [US1] Create `src/app/p/[projectSlug]/settings/usage/page.tsx` (server component,
  `export const dynamic = "force-dynamic"`, `generateMetadata` resolving the permission per request,
  mirroring `settings/model/page.tsx`): headline `<dl>` (calls, input tokens, output tokens), the
  no-counts and produced-nothing sub-lines, the credential-source split line, `FilterTabs` over
  `?period=`, the by-model and by-purpose tables (money column omitted for now), and the empty state
  (depends on T022)
- [X] T024 [P] [US1] Create `src/app/p/[projectSlug]/settings/usage/loading.tsx`: `Skeleton` blocks
  matching the header, the card and the two tables, copied from `settings/model/loading.tsx`'s shape
- [X] T025 [US1] Update `src/app/p/[projectSlug]/settings/layout.tsx`: add the "Usage" sub-nav item
  behind the existing `canManageLlm` flag, beside "Model & API key" (depends on T023)

**Checkpoint**: at this point, User Story 1 is fully functional and testable independently — every
call site records, and an owner reads calls, tokens and the breakdown with no rate configured.

---

## Phase 4: User Story 5 - The ledger leaks nothing and costs nothing (Priority: P1)

**Goal**: No API key, prompt, model output or provider error text reaches the ledger, the screens, a
log line or a response, in any of the five encodings the secret-scan suite already checks — and a
failure to write a usage row never costs anyone a post. Ridden alongside US1 because the first row
written is the first chance to break it, and the recorder built for US1 is exactly what carries the
guarantee.

**Independent Test**: extend the existing scanned secret-scan run to render the Usage screen for
owner, admin and editor and to dump the new table, and assert no secret appears; separately, force the
usage write to fail and assert the generation still saves and still answers normally (shared with
T013).

### Tests for User Story 5

- [X] T026 [P] [US5] Extend `tests/integration/security/secret-scan.test.ts` (P17): render the Usage
  page for owner and admin and assert `NotFoundSignal` for the editor; render the job page again after
  the generating tick so it carries real token totals; push an `llm_call_usage` dump as one more
  `pieces` entry; keep the corpus assertion and the file's deliberate-leak test passing unchanged
- [X] T027 [P] [US5] Extend `tests/integration/no-plaintext.test.ts` to dump `llm_call_usage` before
  the existing all-tables scan
- [X] T028 [P] [US5] Write `tests/integration/llm/usage-authz.test.ts`: an editor gets `notFound()` for
  `/p/<slug>/settings/usage` and the settings sub-nav renders no Usage item for them; a non-member gets
  the same not-found as for any foreign project; `getProjectUsage` throws `ForbiddenError` for an
  editor's scope even when called directly (SC-010)

### Implementation for User Story 5

- [X] T029 [US5] Confirm `tests/integration/scope-check.test.ts` covers `llm_call_usage` with no new
  test (registration from T002 is sufficient) and run it to prove it; fix in passing if any query added
  in Phase 3 bypassed the scope
- [X] T030 [US5] Re-run `tests/integration/llm/usage-failure.test.ts` (T013) against the final wiring
  from Phase 3 and confirm the logged failure line (`src/server/llm/usage.ts`'s swallow path) carries
  no prompt, output or credential — add the assertion there if T013 did not already cover the exact
  log line's shape

**Checkpoint**: the scanned run proves no leak across every surface this entry adds, and the swallow
rule is proven end to end.

---

## Phase 5: User Story 2 - The operator puts a price on it, and it is labelled as an estimate (Priority: P2)

**Goal**: An operator-configured rate per model, in one install-wide currency, produces a money figure
on the Usage screen equal to tokens × rate, always labelled an estimated upper bound with the fixed
disclaimer sentence; malformed configuration is non-fatal and leaves the install otherwise unchanged.

**Independent Test**: configure rates for one model, generate known usage on it, and assert the money
figure equals tokens × rate, that it is labelled an estimated upper bound, and that removing the rates
removes the money column entirely without touching the token figures.

### Tests for User Story 2

- [X] T031 [P] [US2] Write `src/server/llm/rates.test.ts`: `parseLlmRates` against every row of
  contracts/config.md §3's parse table (unset, valid, missing/malformed currency, malformed entry,
  duplicate pair, negative/non-numeric/>6-decimal price, unknown provider); `rateFor` matches only
  exact `(provider, model)`, never by provider alone; `estimateMicros` exact-integer arithmetic at
  realistic volumes (no float drift); `formatMoney` renders `"12.34 USD"`, `"0.00 USD"` for a
  configured zero, and `"under 0.01 USD"` for a non-zero amount rounding to zero
- [X] T032 [P] [US2] Write `tests/integration/llm/usage-rates.test.ts`: with `LLM_RATES` unset, no
  currency code and no money figure appears on the Usage page, the job page or a post's generation
  detail, while token figures are unchanged (SC-003); one rate configured — the estimate equals
  `inputTokens × inputRate + outputTokens × outputRate` to the micro-unit in the configured currency
  (FR-019); a rate of `0` renders `0.00 <CODE>` plus a "configured as zero" note, distinguishable from
  "no rate configured" (FR-012); reading the report, changing `LLM_RATES`, and re-reading changes the
  past period's estimate with the row count and every row's bytes unchanged (SC-007); a render
  containing a currency code always contains `ESTIMATE_DISCLAIMER`, and "spend"/"cost"/"charged"/
  "billed" never label a figure (SC-005); `validateConfiguration` with a duplicate pair, a negative
  price, a non-numeric price, a missing currency and a malformed currency are each named in
  `warnings`, never in `issues`, `entries` ends up empty, and `runStartup` does not exit (FR-011)

### Implementation for User Story 2

- [X] T033 [P] [US2] Create `src/server/llm/rates.ts`: `ModelRate`, `LlmRates`, `parseLlmRates(source)`
  (pure, never throws, grammar and rejection table from contracts/config.md §2–3), `getLlmRates()`
  (memoised like `getEnv()`, never evaluated at import), `rateFor`, `estimateMicros` (`BigInt`
  arithmetic, research.md P12), `formatMoney` (research.md P11 — shape-only currency validation, no
  `Intl.NumberFormat` currency style)
- [X] T034 [US2] Update `src/server/llm/config.ts`: add `LLM_RATE_VARIABLES` (`LLM_RATES`,
  `LLM_RATE_CURRENCY`), deliberately **not** added to `LLM_VARIABLES` (research.md P9) (depends on
  T033)
- [X] T035 [US2] Update `src/server/startup/validate.ts`: add `warnings: EnvIssue[]` to
  `ConfigValidation`, populated from `parseLlmRates(source).problems`, never placed in `issues`
  (depends on T033)
- [X] T036 [US2] Update `src/server/startup/index.ts`: log each warning as `Docket: <name>: <reason>`
  and, when no rates are usable, log the disabled line "estimated spend is off (LLM_RATES not set or
  not usable)"; the process does not exit on a warning (depends on T035)
- [X] T037 [US2] Extend `tests/lint/env-coverage.test.ts`: add `LLM_RATE_VARIABLES` to `CONFIGURABLE`
  (not to `ACCEPTED_AS_IS`), and widen the "names a malformed value" probe to accept the variable
  appearing in `issues` **or** `warnings` (depends on T034, T035)
- [X] T038 [US2] Update `.env.example`: add `LLM_RATES` and `LLM_RATE_CURRENCY` under the existing
  `# --- Generator (LLM) ---` group, with the exact description blocks from contracts/config.md §1
  (depends on T034)
- [X] T039 [US2] Update `src/server/services/usage.ts`: add the real `ESTIMATE_DISCLAIMER` constant and
  the `money` field to `UsageView` (absent when `getLlmRates().entries.length === 0`; `estimateMicros`
  present on a `ModelUsageRow` only when a rate matched exactly; `rateIsZero` when the matched rate is
  `0`), computed per request from `getLlmRates()` and never cached or stored (depends on T022, T033)
- [X] T040 [US2] Update `src/app/p/[projectSlug]/settings/usage/page.tsx`: render the Estimate column
  on the by-model table only when `money` exists; the headline card's estimated-upper-bound figure and
  the disclaimer alert; the "money can be shown once rates are configured" line when `money` is absent
  (depends on T023, T039)

**Checkpoint**: at this point, User Stories 1, 5 and 2 all work independently — rates configured
produce a labelled estimate; rates unset show nothing, by construction.

---

## Phase 6: User Story 3 - An unpriced model never produces a confident wrong number (Priority: P2)

**Goal**: A model with no configured rate keeps reporting its calls and tokens, marked "no rate
configured", contributing nothing to any money total — while the total names what it excludes.

**Independent Test**: configure a rate for model A only, generate usage on A and B, and assert B's row
shows tokens with a "no rate configured" marker, the total covers A alone, and the total names B's
excluded calls and tokens.

### Tests for User Story 3

- [X] T041 [P] [US3] Extend `tests/integration/llm/usage-rates.test.ts`: rates for model A only, usage
  on A and B — the total covers A, names B verbatim with its excluded calls and tokens, and the test
  fails if the total were A+B's arithmetic (SC-004); rates configured but none matching this period's
  models — no total at all, with the stated reason (FR-024); a rate whose model differs only in case
  or by a trailing suffix does not match, nor does the right provider with a different model (FR-010)

### Implementation for User Story 3

- [X] T042 [US3] Update `src/server/services/usage.ts`: partition `byModel` into `priced`/`unpriced`,
  compute `money.totalMicros` over `priced` only, `money.excluded` listing every unpriced row with its
  calls and tokens, and `money.noPricedUsage` when `pricedModels === 0` but the period has usage
  (depends on T039)
- [X] T043 [US3] Update `src/app/p/[projectSlug]/settings/usage/page.tsx`: render "No rate configured"
  text (not a dash) on an unpriced model's row with the exact unmatched `provider:model` verbatim and a
  pointer to where rates are set; render the total's "Covers N priced model(s). Leaves out …" sentence;
  render "No model used in this period has a rate configured, so no estimate is shown." when
  `money.noPricedUsage` (depends on T040, T042)

**Checkpoint**: all three of US1, US5, US2 and US3 are independently functional — an unpriced model
never contributes a silent zero or a silent drop.

---

## Phase 7: User Story 4 - A surprising total can be traced to the generation that caused it (Priority: P3)

**Goal**: A batch job's page shows that job's own calls and tokens (labelled "to date" while running),
and a generated post's generation detail shows each attempt's token counts beside its latency — both
money-free.

**Independent Test**: run a two-item batch job and one single generation with known usage, then assert
the job page's totals equal those two items' calls and the post's detail shows its own call's counts.

### Tests for User Story 4

- [X] T044 [P] [US4] Write/extend an integration test asserting: a completed 2-item batch job's page
  shows the job's own call count and input/output token totals (via `getJobUsage`); a job still running
  shows the same totals labelled "to date"; a job with no calls yet shows "No model calls yet", not
  zeros; a cancelled job keeps its figures; no money figure appears on the job page under any rate
  configuration (P19)
- [X] T045 [P] [US4] Extend the existing generation-detail test for
  `src/app/p/[projectSlug]/generate/result/[postId]/page.tsx`: each attempt's row shows its input/output
  token counts beside its latency, read from the existing `attempts` blob; an attempt with null counts
  renders "no counts reported", never `0`; both rows list attempts in the same order; no money figure
  appears here either

### Implementation for User Story 4

- [X] T046 [US4] Update `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx`: add the "Model usage" block
  from `getJobUsage(scope, jobId)` beside the existing counts, "to date" while `job.status` is `queued`
  or `running` (the same `active` flag `AutoRefresh` already uses), "No model calls yet" when empty, no
  money (depends on T022)
- [X] T047 [US4] Update `src/app/p/[projectSlug]/generate/result/[postId]/page.tsx`: add a **Tokens**
  row beside the existing **Latency** row in the generation details `<dl>`, reading
  `record.attempts.map(a => a.usage)` from the same blob (`src/lib/validation/generation.ts:96`) —
  no ledger query, no migration (P18) — rendering "no counts reported" for a null-count attempt

**Checkpoint**: every user story is now independently functional; a surprising total is traceable on
both the job page and the post detail.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: The documentation obligations FR-033 attaches to this entry by name, and the full-suite
proof that the repository is left working.

- [ ] T048 [P] Update `docs/generator.md`: document the Usage surface (what it shows, where, who may
  see it), "Configuring a provider"/Jobs sections widened with where rates live (`LLM_RATES`,
  `LLM_RATE_CURRENCY`), that Docket ships no prices and never fetches any, that the money figure is an
  estimated upper bound, and the P7 note that an `ok` row means the provider answered, not that Docket
  accepted the output (FR-033)
- [ ] T049 [P] Add `docs/decisions.md` a new heading "### Spec decisions (M1–M19 — this entry's; the
  M1–M18 under 056 are a different set)" and "## 058 — LLM cost visibility" carrying P1–P19, next to
  entries 1 and 2's sets (FR-033, plan.md "Two things the spec says that the code does not allow")
- [ ] T050 [P] Update `docs/security.md`: add or update the rows covering `llm_call_usage` and the
  Usage/job/post-detail screens, naming the tests that prove no leak (checked by
  `tests/integration/docs/security-findings.test.ts`) (FR-033)
- [ ] T051 [P] Confirm `.env.example`'s `LLM_RATES`/`LLM_RATE_CURRENCY` blocks (added in T038) carry the
  same "no default on purpose" care as the rest of the Generator group (FR-033, checked by
  `tests/lint/env-coverage.test.ts`)
- [ ] T052 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`; confirm
  `src/server/llm/log.test.ts` is unchanged (FR-031) and no existing generation/jobs/scheduler test
  needed a new stub beyond the recorder wiring itself (SC-012); fix any regression found rather than
  adjusting its expectation

**Checkpoint**: the whole suite is green and the four FR-033 documents are updated.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (needs the table to exist) — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 5 (Phase 4)**: Depends on Foundational and the wiring User Story 1 lands (the recorder
  calls it proves must exist before the secret scan can render them) — built immediately after US1.
- **User Story 2 (Phase 5)**: Depends on Foundational and User Story 1's `getProjectUsage`/page (it adds
  a field and a column to both), but not on User Story 5.
- **User Story 3 (Phase 6)**: Depends on User Story 2 (it rides US2's money machinery exactly as the
  spec states: "it cannot precede it").
- **User Story 4 (Phase 7)**: Depends on Foundational and User Story 1's ledger existing; independent of
  US2/US3 (it shows no money).
- **Polish (Phase 8)**: Depends on all five user stories being complete.

### Within Each User Story

- Tests are written first and must fail before the implementation task that makes them pass.
- US1's seven call-site updates (T016–T021) each touch a different file and have no dependency on one
  another once T015 (the `runGeneration`/`StepOptions` plumbing) lands.
- US2's config chain (T033→T034→T035→T036→T037) is sequential; T038 depends only on T034.

### Parallel Opportunities

- Foundational tasks T004, T006, T007 are mutually independent; T008 depends on T007; T005 depends on
  T004; T009 depends on T004; T010, T011 depend on T009 but not on each other.
- Once T015 lands, T016–T021 (seven different files) can all run in parallel.
- US5's three tasks (T026, T027, T028) are independent of one another.
- US2's test-writing (T031, T032) and US3's extension of T032 can be drafted in parallel with US2's
  implementation, per the usual write-tests-first rule within a story.
- All Polish tasks except T052 are independent documentation edits.

---

## Parallel Example: User Story 1 call-site wiring

```bash
# After T015 (runGeneration / StepOptions plumbing) lands, these can all change in parallel:
Task: "Update src/server/services/generation/single.ts"
Task: "Update src/server/services/generation/series.ts"
Task: "Update src/server/services/generation/regenerate.ts"
Task: "Update src/server/services/jobs/runner.ts"
Task: "Update src/server/services/voice.ts"
Task: "Update src/server/services/generation/check.ts"
```

## Parallel Example: Foundational phase

```bash
Task: "Create src/server/dal/llm-usage.ts"
Task: "Create src/lib/generation/usage-purpose.ts"
Task: "Create src/lib/generation/usage-period.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (the table and migration).
2. Complete Phase 2: Foundational (the repo, the recorder, the period windows — CRITICAL).
3. Complete Phase 3: User Story 1 (every call site records; the honest screen reads calls and tokens
   with no rate configured).
4. **Stop and validate**: run `tests/integration/llm/usage-record.test.ts`,
   `tests/integration/llm/usage-failure.test.ts` and `tests/integration/llm/usage-report.test.ts`
   green.
5. Deploy/demo if ready — **FR-023** means this is already a complete, useful screen with no rate
   configured anywhere.

### Incremental Delivery

1. Setup + Foundational → the ledger exists.
2. US1 → calls and tokens are recorded and reported (MVP!).
3. US5 → proven to leak nothing and cost nothing (built alongside US1, checkpointed right after).
4. US2 → money appears, labelled as an estimate, when the operator configures it.
5. US3 → an unpriced model never lies by omission or by zero.
6. US4 → a surprising total is traceable to the job or the post that caused it.
7. Polish → the four FR-033 documents and the full gate.

### Final gate

Nothing in this feature is reported done until T052's full gate (`lint`, `typecheck`, `test`,
`db:check`, `build`) is green.

---

## Phase 9: Human verification (runs last, after Polish)

**Positioned last on purpose**: a human-owned task inside an earlier phase starves the implement
loop — the loop cannot finish a phase while a human-only task sits unchecked inside it, so it never
reaches the phases after. The walk-through below needs a signed-in browser session, which no pipeline
phase has.

- [ ] T053 Human-owned: the manual walk-through in quickstart.md §7 — needs a signed-in browser
  session as owner and editor against `pnpm dev`, so no pipeline phase can tick it. Six parts: (1)
  sign in as an owner, confirm "Usage" sits beside "Model & API key" in Settings; (2) with no rates
  set, confirm calls, tokens, the per-model/per-purpose tables and the "money can be shown once rates
  are configured" line, with no currency anywhere; (3) set `LLM_RATES`/`LLM_RATE_CURRENCY` for one
  listed model, restart, reload — confirm the Estimate column appears with the upper-bound sentence
  and the other model reads "No rate configured" with the total naming it; (4) switch the period tabs
  and confirm the URL changes (shareable); (5) sign in as an editor and confirm no Usage sub-nav item
  and that the URL 404s; (6) open a batch job and a generated post's "Generation details" and confirm
  calls and tokens appear with no money figure on either.
