---

description: "Task list for credit hold — stop mass-failing generation jobs when the provider refuses on billing"
---

# Tasks: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

**Input**: Design documents from `specs/043-llm-credit-hold/` (spec.md, plan.md, research.md, data-model.md, contracts/providers.md, contracts/services.md, contracts/ui.md, quickstart.md)

**Tests**: The spec and plan require tests for every requirement (FR-038); they are included below and are not optional for this feature.

**Organization**: Tasks are grouped by user story (US1–US4) per spec.md priorities, after Setup and Foundational phases, per plan.md's dependency order: (1) failure kind, (2) hold/gate/probe, (3) not-failing-items + screens.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4, maps to spec.md user stories
- File paths are exact, from plan.md's Project Structure and contracts/*.md

## Path Conventions

Single Next.js app at repository root: `src/`, `tests/`, `docs/`, `drizzle/`, `scripts/`.

---

## Phase 1: Setup

**Purpose**: Nothing to scaffold — this is an existing, working codebase. The only "setup" is confirming the
tools this plan relies on are available before touching code.

- [X] T001 Confirm `node_modules/@anthropic-ai/sdk/core/error.d.ts`, `node_modules/@anthropic-ai/sdk/resources/shared.d.ts` and `node_modules/openai/core/error.d.ts` exist and match research.md's A1/A2 claims (`APIError.type`/`.error`/`.code`, `ErrorType` including `billing_error`), by reading the files directly — no code change, a guard against drift between research.md and the installed SDKs before any predicate is written

**Checkpoint**: Verified facts still hold; proceed to Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The ninth failure kind must exist everywhere it is persisted or validated before any provider
predicate, DAL module, or screen can refer to it. This phase is plan.md's piece 1.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete — every story's code or test refers to `credit_exhausted`.

- [X] T002 Add `"credit_exhausted"` as the last member of `llmFailureKind` in `src/server/db/schema/generation.ts` (data-model.md §1)
- [X] T003 Add `"credit_exhausted"` as the last member of `generationJobItemError` in `src/server/db/schema/jobs.ts` (data-model.md §1)
- [X] T004 Add the `llmCreditHolds` table (`owner` PK, `heldSince`, `lastRefusalAt`, `nextProbeAt`, all `timestamptz not null`, plus the `llm_credit_holds_owner_nonempty` check) to `src/server/db/schema/generation.ts`, beside `llmFailureKind` (data-model.md §2)
- [X] T005 Add `"llm_credit_holds"` to `notProjectOwned` in `src/server/db/project-owned.ts` (data-model.md §2; required by `project-owned.test.ts`)
- [X] T006 Run `pnpm db:generate` to produce `drizzle/0021_*.sql` (two `ALTER TYPE … ADD VALUE`, one `CREATE TABLE`) and its `meta/`, matching data-model.md §4; do not hand-edit the generated SQL
- [X] T007 Run `pnpm db:migrate` against the local Postgres and confirm `pnpm db:check` is green
- [X] T008 [P] Add `"credit_exhausted"` to the `LlmFailureKind` union and `LLM_FAILURE_KINDS` array in `src/server/llm/types.ts` (data-model.md §1)
- [X] T009 [P] Add the `credit_exhausted` sentence to `LLM_FAILURE_MESSAGES` in `src/server/llm/messages.ts`, exactly the text in contracts/providers.md §5 (H17): "The model provider refused: the account has no credit or quota left. Add credit to the provider account." — do not change the existing `bad_request` sentence (FR-005, C4)
- [X] T010 [P] Update `src/server/llm/messages.test.ts` so the exhaustiveness check covers nine kinds (was eight) and asserts the new sentence names credit and contains no provider name
- [X] T011 [P] Add `"credit_exhausted"` as the last member of the `failureKind` Zod enum in `src/lib/validation/generation.ts` (data-model.md §1; needed so a stored `credit_exhausted` attempt parses on read)
- [X] T012 Run `pnpm db:check` and `pnpm vitest run src/server/llm/messages.test.ts src/server/db/project-owned.test.ts` to confirm the foundational schema and message-map changes are green before any story starts

**Checkpoint**: The kind exists in both enums, the validation schema, the types union, and has its fixed sentence. `pnpm db:check` is green. Foundational work complete — user stories can now proceed in plan dependency order (US1→US2→US3→US4, since each later story's code depends on the runner/hold pieces the earlier ones add).

---

## Phase 3: User Story 1 - An outage no longer destroys a batch job (Priority: P1) 🎯 MVP

**Goal**: Detect a billing refusal on both providers, hold the credential owner instead of claiming for it, and
requeue (never fail) any item refused on billing — so a multi-hour outage fails zero items.

**Independent Test**: Run a job with a provider stubbed to refuse on billing for two simulated hours of ticks, then stop refusing. Zero items `failed`, no attempt count rose, job status never `completed_with_failures`, every item eventually produces exactly one post.

### Tests for User Story 1 ⚠️

- [X] T013 [P] [US1] Add `creditRefusal(keyEcho?)` and `nonBillingAtSameStatus()` to the `LlmWire` interface and both providers' wire tables in `tests/helpers/llm-scenarios.ts`, per contracts/providers.md §6's exact bodies for Anthropic (`invalid_request_error` wording match, and the `billing_error` second signal) and OpenAI (`insufficient_quota`)
- [X] T014 [P] [US1] Add a `FakeStep` to `tests/helpers/fake-llm.ts` that fails as `credit_exhausted`
- [X] T015 [P] [US1] Add `seedCreditHold(owner, { heldSince, nextProbeAt })`, `readHold(owner)`, `clearHolds()` (wired into `parkAllJobs`) to `tests/helpers/jobs-env.ts`, and a way to make `credentialOwnerFor` answer two owners for the SC-010 test (quickstart.md "Test helpers this needs")
- [X] T016 [P] [US1] Write `src/server/llm/anthropic.test.ts` additions: `isCreditRefusal` true for `billing_error` type and for `invalid_request_error` matching `/credit balance/i`; false for a non-billing 400, a malformed/empty body, and a non-`APIError`; `kindOfError` returns `credit_exhausted` before `bad_request`
- [X] T017 [P] [US1] Write `src/server/llm/openai.test.ts` additions: `isCreditRefusal` true for `code === "insufficient_quota"`; false for a 429 with no code or `rate_limit_exceeded`, a malformed body, a non-`APIError`; `kindOfError` returns `credit_exhausted` before `rate_limited`
- [X] T018 [US1] Write `tests/integration/jobs/credit-hold.test.ts` (NEW): AS1 (refused item queued/due/unattempted/unleased with reason), AS2 (next tick within interval claims nothing, `counts.held===1`), AS3 (two items refused in one tick → one hold row), AS6 (non-billing 400/429 behave exactly as today, no hold created) — per quickstart.md US1 table
- [X] T019 [US1] Write `tests/integration/jobs/credit-outage.test.ts` (NEW): AS4, the simulated two-hour (120 one-minute ticks) outage — fake provider's request count `≤ 24`, no item `failed`, no item reaches `maxAttempts`, then recovery with exactly one post per item; and the SC-001 500-item independent test (items seeded directly, not through 500 model calls)
- [X] T020 [US1] Add to `tests/integration/jobs/recovery.test.ts`: AS5, lease recovery never counts an attempt for a held item and never fails it as `interrupted` (force an item to `running` with an expired lease while held, run ticks past the lease)

### Implementation for User Story 1

- [X] T021 [US1] Add `ANTHROPIC_CREDIT_PHRASES` and `isCreditRefusal(error)` to `src/server/llm/anthropic.ts`, and call it in `kindOfError` immediately after the timeout branch, before `RateLimitError`/`BadRequestError` mapping — exact fields and logic per contracts/providers.md §1 and §3
- [X] T022 [US1] Add `OPENAI_CREDIT_CODES` and `isCreditRefusal(error)` to `src/server/llm/openai.ts`, and call it in `kindOfError` immediately after the timeout branch, before `RateLimitError` mapping — exact fields and logic per contracts/providers.md §2 and §3
- [X] T023 [US1] Create `src/server/dal/credential-owners.ts` (NEW): `INSTALL_CREDENTIAL_OWNER = "install"`, `credentialOwnerFor(projectId): Promise<string>` (today the constant), `jobsExcludingOwners(owners): SQL | undefined` (today `undefined` for empty, a never-matching predicate otherwise) — per contracts/services.md §1
- [X] T024 [P] [US1] Write `src/server/dal/credential-owners.test.ts` (NEW): the five invariants in contracts/services.md §1 (resolves to the constant for any input; `jobsExcludingOwners([])` is `undefined`; `jobsExcludingOwners([INSTALL_CREDENTIAL_OWNER])` matches nothing; an unknown owner blocks nothing; no API key ever appears in or derives the owner value)
- [X] T025 [US1] Create `src/server/dal/credit-holds.ts` (NEW): `CREDIT_PROBE_INTERVAL_MS`, `CreditHold` type, `holdCredit`, `clearCreditHold`, `gateCreditHolds`, `rewindCreditProbe`, `readCreditHold`, `readCreditHolds` — exact statements per data-model.md §5 and contracts/services.md §2 (upsert on refusal, delete on clear, the two-step `SKIP LOCKED` gate that never waits, update-only rewind)
- [X] T026 [US1] Update `src/server/dal/job-claims.ts`: `ClaimedJobItem` gains `owner`/`probe`; `claimDueJobItems` returns `ClaimResult {items, held, probing}`; inside the existing transaction call `gateCreditHolds`, compute `blocked = held \ probing`, add `jobsExcludingOwners(blocked)` to the job `SELECT` (omitted when empty), choose `queuedDue` vs `itemDue` per job by whether its owner is probing, apply `budgetFor(owner)` in the round-robin keep, stamp each kept item's `owner`/`probe`, and call `rewindCreditProbe` for any probing owner that ended with zero kept items — per contracts/services.md §4 and data-model.md §6.1–6.3
- [X] T027 [US1] Update `tests/integration/jobs/dal.test.ts` for the new `ClaimResult` shape (`.items`) — mechanical, no assertion relaxed
- [X] T028 [US1] Update `tests/integration/jobs/recovery.test.ts` call sites for the new `ClaimResult` shape (`.items`) — mechanical, no assertion relaxed (distinct from T020's new assertions in the same file)
- [X] T029 [US1] Update `src/server/services/jobs/runner.ts`: three-way dispatch (`credit_exhausted` → new `requeueForCredit()`; `TEMPORARY` → `retryLater`; else → `fail`), `requeueForCredit()` exactly per contracts/services.md §6 (queued, `nextAttemptAt=now`, lease released, `pendingRetry: null`, `lastErrorKind`/`lastError` set, attempt count untouched, `counts.requeued++`); `TEMPORARY` set itself is NOT modified (FR-010, C6)
- [X] T030 [US1] Update `src/server/scheduler/generation.ts`: `GenerationCounts` gains `requeued`, `held`, `probed`; `runGenerationJobs` reads `claim.items`/`claim.held`/`claim.probing` and sets the two new flags, with the existing `getLlmStatus().configured` / tick-budget / deadline checks staying first (per contracts/services.md §5)
- [X] T031 [US1] Run `pnpm vitest run src/server/llm/anthropic.test.ts src/server/llm/openai.test.ts src/server/llm/messages.test.ts src/server/dal/credential-owners.test.ts tests/integration/jobs/credit-hold.test.ts tests/integration/jobs/credit-outage.test.ts tests/integration/jobs/recovery.test.ts tests/integration/jobs/dal.test.ts` and confirm all green

**Checkpoint**: A billing refusal on either provider holds the owner, requeues the item with no attempt counted, and a simulated two-hour outage fails zero items. User Story 1 is independently functional and testable.

---

## Phase 4: User Story 2 - It resumes by itself after a top-up (Priority: P1)

**Goal**: Recovery is detected by any successful (or non-billing) call outcome, from every caller, with a
single-flight probe every 5 minutes while held — never guessed, never needing a human click.

**Independent Test**: Hold a job on billing, stop the stub refusing, advance the clock one probe interval, and check the next tick resumes full throughput with no human action and no retry.

### Tests for User Story 2 ⚠️

- [X] T032 [P] [US2] Write `tests/integration/jobs/credit-probe.test.ts` (NEW): AS1 (successful probe clears the hold, `counts.probed===1`, next tick claims up to `jobMaxItems`), AS2 (non-billing probe failure also clears it: `timeout`/`invalid_output`/`unavailable`, each following its ordinary path), AS5 (two concurrent ticks make exactly one probe call and advance `nextProbeAt` by exactly one interval), AS6 (refuse→clear→refuse yields a fresh `heldSince` and still exactly one row) — per quickstart.md US2 table
- [X] T033 [P] [US2] Add to `tests/integration/jobs/credit-probe.test.ts`: the tick-budget rewind case (a probe granted when the budget is too short leaves `nextProbeAt<=now`), the `finish`-claim rewind case, and the clock-jump/long-stop case (`nextProbeAt` far in the past yields exactly one probe) — per H7 and quickstart.md "Also asserted here"
- [X] T034 [US2] Write a test for AS3 (an interactive call clears the hold before the probe is due, and the next tick resumes without waiting for the probe) in `tests/integration/jobs/credit-hold.test.ts` or `credit-probe.test.ts`, using `runGenerationStep`/`generateSingle` against a held owner
- [X] T035 [US2] Write a test for AS4 (swapped key or provider needs no Docket action: change the stub to succeed, let the next probe succeed, confirm the hold clears with no stale residue) alongside T032

### Implementation for User Story 2

- [X] T036 [US2] Create `src/server/services/generation/credit.ts` (NEW): `withCreditHold(llm, owner): LlmProvider` — delegates `generate` unchanged, awaits `holdCredit` on `credit_exhausted`, awaits `clearCreditHold` on every other outcome including `ok`, swallows write errors — per contracts/services.md §3 (pulled forward into Phase 3: US1's own AS2/AS3 acceptance scenarios require the hold to actually be written on a refusal, which only happens through this wrapper, so Phase 3's tests could not pass without it)
- [X] T037 [US2] Wrap the `llm` argument in `runGenerationStep` (`src/server/services/generation/core.ts`) with `withCreditHold(llm, await credentialOwnerFor(scope.project.id))`, once at the top (pulled forward with T036, same reason; also updated `core.test.ts`/`core-step.test.ts` mock scopes to carry `project.id`)
- [X] T038 [US2] Wrap the `llm` argument in `planSeries` (`src/server/services/generation/series.ts`) the same way
- [X] T039 [US2] Update `scripts/llm-check.ts` to wrap `getLlm()` with `withCreditHold(llm, INSTALL_CREDENTIAL_OWNER)`, confirming it still tolerates no `DATABASE_URL` (write errors swallowed) — per contracts/services.md §3 and H13
- [X] T040 [US2] Add the probe rewind to `src/server/services/jobs/runner.ts`: track whether the model was actually called for a claimed item, and in the existing `finally` call `rewindCreditProbe(claimed.owner, now)` when `claimed.probe && !calledModel` — per contracts/services.md §6 "The probe rewind"
- [X] T041 [P] [US2] Write `scripts/llm-check.test.ts` additions: with an injected provider failing as `credit_exhausted`, output contains `outcome=credit_exhausted` and exits non-zero; with no `DATABASE_URL`, behaves identically
- [X] T042 [US2] Run `pnpm vitest run tests/integration/jobs/credit-probe.test.ts tests/integration/jobs/credit-hold.test.ts scripts/llm-check.test.ts src/server/services/generation/core.test.ts` and confirm all green

**Checkpoint**: Both US1 and US2 work independently — an outage fails nothing, and a top-up resumes it with no human action, within one probe interval plus one worker interval.

---

## Phase 5: User Story 3 - The Batch jobs screens say what is wrong, and it is billing (Priority: P1)

**Goal**: Both Batch jobs screens carry one honest, accessible notice naming billing while a hold covers the
viewer's project, and a waiting item's row reads as waiting, not failed — with no change at all when there is
no hold.

**Independent Test**: With a hold in place, render the Batch jobs list and a job's page and check both name billing as the cause, say the items are waiting rather than failed, say it resumes by itself, and pass the `docket-ui` rules.

### Tests for User Story 3 ⚠️

- [X] T043 [P] [US3] Write `src/lib/jobs/credit-hold.test.ts` (NEW): the five fixed strings exist, are non-empty, and together contain no provider name, no key-shaped string, and name "credit" and "quota"
- [X] T044 [US3] Add to `tests/integration/jobs/ui.test.tsx`: held-list render contains the five fixed strings and the formatted instant with `role="note"` present once; held job-page render shows the notice beside the two existing ones, and a `completed`/`cancelled` job shows none; waiting-row shows the fixed sentence, "Queued", no retry control, and its unchanged attempt count; counts show `Failed: 0` and `Queued` including waiting items; not-held render is byte-identical to the hold row deleted; `AutoRefresh` still renders `active intervalMs={5000}`; an editor sees the same notice as the owner; no secret (distinctive key value) appears in either screen's markup — per contracts/ui.md §8

### Implementation for User Story 3

- [X] T045 [US3] Create `src/lib/jobs/credit-hold.ts` (NEW): the five fixed strings `CREDIT_HOLD_CAUSE`, `CREDIT_HOLD_WAITING`, `CREDIT_HOLD_RESUME`, `CREDIT_HOLD_ACTION`, `CREDIT_HOLD_SINCE_LABEL`, exact text per contracts/ui.md §2
- [X] T046 [US3] Create `src/app/p/[projectSlug]/jobs/JobNotice.tsx` (NEW, server component): `<p role="note" className="rounded-md border border-warning-border p-3 text-sm">` per contracts/ui.md §1
- [X] T047 [US3] Create `src/app/p/[projectSlug]/jobs/CreditHoldNotice.tsx` (NEW, server component): composes the five strings with `<LocalTime value={since} timeZone={…} />`, rendered inside `JobNotice`, per contracts/ui.md §1–§2
- [X] T048 [US3] Add `generationCreditHold(scope): Promise<{since: Date} | null>` to `src/server/services/jobs/read.ts`, implemented as `readCreditHold(await credentialOwnerFor(scope.project.id))` mapped to `{since: heldSince}`, gated by the existing `canView(scope)`/`post: ["view"]` check — per contracts/services.md §7
- [X] T049 [US3] Add a `creditHold: {since: Date} | null` field to `getJob()`'s return in `src/server/services/jobs/read.ts`, beside `generationConfigured` and `jobsRunnable` — per contracts/services.md §7
- [X] T050 [US3] Update `src/app/p/[projectSlug]/jobs/page.tsx`: call `generationCreditHold(scope)` and render `<CreditHoldNotice>` after the page header and existing prerequisites notice, before the table/empty state, shown regardless of whether any job is queued — per contracts/ui.md §3
- [X] T051 [US3] Update `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx`: route the two existing notices through `JobNotice` (identical markup), and add the third `<CreditHoldNotice>` gated on `active && job.creditHold` — per contracts/ui.md §4
- [X] T052 [US3] Update `src/app/p/[projectSlug]/jobs/[jobId]/JobItemsTable.tsx`'s `Detail` function: add the `item.status === "queued" && item.error?.kind === "credit_exhausted"` branch rendering the fixed sentence as a `Sub` line — per contracts/ui.md §5
- [X] T053 [US3] Run `pnpm vitest run src/lib/jobs/credit-hold.test.ts tests/integration/jobs/ui.test.tsx tests/lint/date-format.test.ts` and confirm all green; run `node scripts/check-contrast.mjs` if it is invoked standalone in this repo, otherwise confirm it runs as part of `pnpm build`

**Checkpoint**: Both screens tell an operator, in plain accessible text, that a billing refusal is paused, that nothing failed, and that it resumes by itself — with zero change to either screen when there is no hold.

---

## Phase 6: User Story 4 - A person generating one post, and an operator checking the configuration (Priority: P2)

**Goal**: Interactive generation (single, series, regenerate, voice "Try it") and `pnpm llm:check` answer at
once with the one fixed sentence naming credit, never retrying in-request, and the public API reports a
waiting item as `queued` with the unchanged schema.

**Independent Test**: With a stub refusing on billing, run a single generation and `pnpm llm:check`, and check the recorded failure kind, the message shown, and the printed outcome.

### Tests for User Story 4 ⚠️

- [X] T054 [P] [US4] Confirm (by inspection and a targeted assertion in `src/server/services/generation/core.test.ts`) that `RETRYABLE` in `core.ts` and `series.ts` does not contain `credit_exhausted`, and that a `credit_exhausted` result makes exactly one call — no in-request correction retry (FR-006) — add the assertion if the existing suite does not already force it
- [X] T055 [P] [US4] Write AS1 coverage: single, series, regenerate and voice "Try it" generation each return `credit_exhausted` with the one fixed sentence when the stub refuses on billing, with the fake provider recording exactly one request — extend the existing per-path tests in `src/server/services/generation/` rather than adding a new file
- [X] T056 [P] [US4] Write AS2 coverage: a stored `generation_failures` row has `kind='credit_exhausted'` and `message` equal to the fixed sentence, its `attempts` blob parses through `generationRecordSchema`, and neither provider text nor the key appears in the row — extend `src/server/services/generation/__fixtures__`-backed tests or the relevant existing failure-recording test
- [X] T057 [US4] Write AS4 coverage in `tests/integration/api/endpoints/jobs.test.ts`: `GET /v1/jobs/{id}/items` for a held job returns `status: "queued"` with `error.kind === "credit_exhausted"` and the fixed message, validating against the unchanged `JobItemSchema`; `GET /v1/jobs/{id}` counts them as `queued` with `failed` unchanged; and a `POST /v1/generate` call during a refusal returns 503 `generation_unavailable` with `details.kind === "credit_exhausted"` — per contracts/services.md §8

### Implementation for User Story 4

- [X] T058 [US4] Verify (no code expected; FR-006/H14 is the absence of a change) that `RETRYABLE` in `src/server/services/generation/core.ts:66` and `src/server/services/generation/series.ts:81` is unmodified by T037/T038's wrapping — the wrapper changes only which `LlmProvider` is passed in, not the retry sets
- [X] T059 [US4] Confirm `src/server/api/operations/generate.ts`'s `UNUSABLE` set is unmodified, so `credit_exhausted` falls to the existing 503 `generation_unavailable` branch with `details.kind` set and the fixed sentence as the message — per contracts/services.md §8 and H18 (no code expected; add a test only if the existing branch does not already cover an unlisted kind generically)
- [X] T060 [US4] Run `pnpm vitest run src/server/services/generation/core.test.ts tests/integration/api/endpoints/jobs.test.ts` and confirm all green

**Checkpoint**: All four user stories are independently functional. An operator or a single caller is told about credit, never about a bad request or a declined model; the public API is unchanged in shape.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Secrets (FR-032/FR-033), docs (FR-034–FR-037), and the full-suite / SC-007 regression proof that
nothing observable moved with no hold in place.

- [X] T061 [P] Extend `tests/integration/security/secret-scan.test.ts` with a generation section inside the same scanned run: a real `createAnthropicProvider`/`createOpenAiProvider` over `createFakeLlmFetch` answering a billing refusal whose body message embeds `ENV.ANTHROPIC_API_KEY`/`ENV.OPENAI_API_KEY`, the service result pushed as a scanned piece, a tick run against a held job, and both Batch jobs screens rendered held and pushed as pieces — confirm the file's existing "reports a deliberately leaked secret" test still fails as designed (FR-033, H19)
- [X] T062 [P] Extend `tests/integration/no-plaintext.test.ts`: add the two API keys and their SHA-256 hex to the `secrets` list, and seed a hold row before the existing all-tables `information_schema` dump so `llm_credit_holds` is exercised (FR-033, H19)
- [X] T063 [P] Extend `docs/security.md`'s "Secrets in logs", "Secrets in responses", "Secrets in rendered UI" and "Secrets in attempt logs and audit rows" rows' *What was checked* cells to name the billing-refusal path and the new table, keeping the `Accepted:`/`Fixed:` prefix `tests/integration/docs/security-findings.test.ts` enforces
- [X] T064 [P] Update `docs/generator.md` under "Configuring a provider" and "Jobs": what a billing refusal is and that it is not a lasting failure; that generation pauses per credential and resumes automatically; the 5-minute probe; that nothing is failed, cancelled or unreserved while paused; that `pnpm llm:check` names the condition; leaving the env-only sentence true and unchanged (FR-034)
- [X] T065 [P] Record C1–C14 (spec.md) and H1–H19 (research.md) in `docs/decisions.md`, next to the generator decisions, including why `TEMPORARY` was rejected and why the hold is scoped by credential owner before there is more than one owner (FR-035)
- [X] T066 [P] Add one or two sentences to `docs/n8n.md` § 4: a job item can sit `queued` carrying a `credit_exhausted` error, it needs no retry, and the response schema is unchanged (FR-036)
- [X] T067 State in `docs/generator.md` and/or `docs/decisions.md` what this entry does not do and which later roadmap entry owns each (per-project keys → entry 2; token usage/cost → entry 3; a give-up timeout, retro-classifying old failures, an admin hold control, notifications, screens outside Batch jobs — none owned, out of the roadmap or this entry's own Out of Scope), matching spec.md's Out of Scope section (FR-037)
- [X] T068 Run `pnpm vitest run tests/integration/jobs tests/integration/generation src/server/db/project-owned.test.ts tests/lint/date-format.test.ts tests/integration/docs/security-findings.test.ts` and confirm no existing assertion was relaxed (SC-007)
- [X] T069 Add/confirm a test that with an empty `llm_credit_holds` table, the claim's emitted SQL statement is byte-identical to `main`'s (SC-007, invariant 5) — add to `tests/integration/jobs/dal.test.ts` if not already covered by T027
- [X] T070 Run the full final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, all green
- [X] T071 Run the `psql` checks from quickstart.md's "Apply the migration" section against a database seeded with jobs, items and failures before the migration, confirming both enums list `credit_exhausted`, `llm_credit_holds` is empty, and the `last_error_kind` histogram is unchanged by the migration (SC-008)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (the kind must exist in both enums, the validation schema and the message map before any predicate, DAL module or screen refers to it)
- **User Story 1 (Phase 3)**: Depends on Foundational. This is the MVP: detection + hold + requeue.
- **User Story 2 (Phase 4)**: Depends on Foundational and on US1's `src/server/dal/credit-holds.ts`, `credential-owners.ts` and the runner's three-way dispatch (T025, T023, T029) — it wraps the same provider call sites and adds the probe rewind to the same runner function.
- **User Story 3 (Phase 5)**: Depends on Foundational and on US1's hold/claim (T025, T026) and US2's `generationCreditHold` precursor concept — in practice it needs `readCreditHold`/`credentialOwnerFor` (US1) to exist; it does not need US2's probe-rewind code.
- **User Story 4 (Phase 6)**: Depends on Foundational and on US2's `withCreditHold` wrapper being in place at the two call sites (T037, T038) — it tests the same wrapped paths plus the public API, which depends only on US1's kind existing (T002/T003) and the runner's requeue (T029).
- **Polish (Phase 7)**: Depends on all four user stories being complete — secrets-scan and no-plaintext need the hold, the hold-write and both rendered screens to exist; the SC-007 regression pass needs every piece landed.

### User Story Dependencies (plan.md's build order)

- US1 is the foundation every later story's tests exercise against (the predicates, the hold table, the gated claim, the requeue).
- US2 adds the observation point and the probe rewind on top of US1's runner and DAL.
- US3 reads the hold US1/US2 create; it adds no new write path.
- US4 is lower priority (P2) and mostly proves that paths wrapped in US2 behave correctly for interactive callers and the public API — it can run in parallel with US3 once US2's T036–T040 land, since neither touches the other's files.

### Parallel Opportunities

- T008–T011 (Foundational, different files) in parallel.
- T013–T017 (US1 tests, different files) in parallel; T016/T017 can run alongside T021/T022's implementation review but should be written first per TDD framing.
- T024 (US1) in parallel with T021/T022.
- T032–T035 (US2 tests) in parallel with each other.
- T043 (US3 pure wording test) in parallel with T044.
- T054–T056 (US4 tests) in parallel with each other.
- T061–T066 (Polish, different doc/test files) in parallel.
- Once Foundational is done, US3's screen work (T045–T052) and US4's interactive-path work (T055, T056) have no file overlap with each other and could proceed in parallel if staffed, though both depend on US1/US2 landing first per the dependency note above.

---

## Parallel Example: User Story 1

```bash
# Tests, launched together:
Task: "Add creditRefusal()/nonBillingAtSameStatus() to tests/helpers/llm-scenarios.ts"
Task: "Add a credit_exhausted FakeStep to tests/helpers/fake-llm.ts"
Task: "Add seedCreditHold/readHold/clearHolds to tests/helpers/jobs-env.ts"
Task: "Write src/server/llm/anthropic.test.ts additions"
Task: "Write src/server/llm/openai.test.ts additions"

# Implementation, launched together once the above compile:
Task: "Add isCreditRefusal to src/server/llm/anthropic.ts"
Task: "Add isCreditRefusal to src/server/llm/openai.ts"
Task: "Write src/server/dal/credential-owners.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — the kind must exist everywhere it is persisted before anything else)
3. Complete Phase 3: User Story 1 — detection, the hold table, the gated claim, the requeue
4. **STOP and VALIDATE**: run the US1 independent test (two simulated hours of ticks, zero failed items)
5. This alone fixes the harm the entry exists for; US2–US4 make it resume itself, say so on screen, and behave correctly for interactive callers

### Incremental Delivery

1. Setup + Foundational → the kind exists, `pnpm db:check` green
2. US1 → an outage no longer destroys a job (MVP!)
3. US2 → it resumes by itself after a top-up
4. US3 → the screens say what is wrong
5. US4 → interactive paths and the public API behave correctly
6. Polish → secrets extended (not exempted), docs complete, full suite and migration proven safe

### Notes

- This feature's dependency order is stricter than the template's "stories are independent by default": plan.md
  is explicit that this is three pieces built in sequence (kind → hold/gate/probe → requeue/screens), and the
  spec's own priorities (US1–US3 are all P1) reflect that US1's safety net must exist before US3's screens can
  truthfully describe it. Treat the "Parallel Opportunities" section as the realistic concurrency, not "all
  four stories at once."
- Tests are not optional for this feature (FR-038) — every implementation task above has a preceding or
  paired test task.
- Commit after each task or logical group; stop at any checkpoint to run that story's independent test.

---

## Phase 8: Review remediation

**Purpose**: Close the blocking findings from [review.md](./review.md). Each task carries its finding id and
location so a fresh implement pass can act without this review's reasoning.

- [X] T072 Give a probing credential owner a probe candidate when it has no `queued`-and-due item: stop excluding lease-expired `running` rows from the probe's item `SELECT` and instead gate the recovery branch (`attemptCount + 1`, and the `interrupted` failure) on `!probingSet.has(owner)`, so US1 AS5 stays true while the probe can still fire. Add a regression test: seed a hold, force the owner's only item to `running` with an expired lease, run ticks past several probe intervals, and assert exactly one model call per interval and that a successful probe clears the hold — review F1 (MAJOR), src/server/dal/job-claims.ts:87, src/server/dal/job-claims.ts:136, src/server/dal/job-claims.ts:160
- [X] T073 Resolve SC-010 by making `jobsExcludingOwners` genuinely per-owner (DECIDED by the author: do NOT take the deferral arm, and do NOT delete `routeCredentialOwners`). Resolve blocked owners to their project ids and exclude on `generation_jobs.project_id`, keeping `jobsExcludingOwners([])` -> `undefined` so the SC-007 SQL-identity assertion in `tests/integration/jobs/dal.test.ts:64` stays green. Write the two-owner integration test from `quickstart.md:164` using the already-built `routeCredentialOwners` helper: one owner held yields nothing while the other is claimed at full budget. This honours C7 so roadmap entry 2 replaces only `src/server/dal/credential-owners.ts` and never widens the claim SQL - review F2 (MAJOR), tests/helpers/jobs-env.ts:63, src/server/dal/credential-owners.ts:25
- [X] T074 Cover FR-038's missing bullet in `tests/integration/jobs/cancel.test.ts`, all three under a seeded hold: cancelling a held job leaves the hold row untouched and still releases reserved images; `retryFailedItems` resets failed items to `queued` and the next tick fails none of them (C14's promise that it is safe to press during an outage); an open job still accepts items while held. Assert `readHold(INSTALL_CREDENTIAL_OWNER)` is unchanged in each — review F3 (MAJOR), tests/integration/jobs/cancel.test.ts:1

---

## Phase 9: Review remediation

**Purpose**: Close the blocking finding from [review.md](./review.md). Its finding id and location are carried
in the task text so a fresh implement pass can act without this review's reasoning.

- [ ] T075 Commit the entire feature: `git status --porcelain` lists 57 uncommitted paths (41 modified, 16 untracked) and the only two commits on `059-llm-credit-hold` carry `spec.md` and `plan.md`, so there is no diff to review, nothing to push and nothing a human can merge — and no CI has ever run on this code. Stage explicit paths only (never `git add -A`, `git add .` or `git commit -a`) in Conventional Commits, each message ending with the required `Co-Authored-By:` trailer; suggested split: `feat(llm)` for the kind, the two `isCreditRefusal` predicates, the message map and the Zod enum; `feat(db)` for the schema, `drizzle/0021_fine_vermin.sql` + its snapshot + `_journal.json`, and `notProjectOwned`; `feat(jobs)` for `credit-holds.ts`, `credential-owners.ts`, `job-claims.ts`, `credit.ts`, `runner.ts`, `read.ts` and `scheduler/generation.ts`; `feat(jobs)` for `JobNotice.tsx`, `CreditHoldNotice.tsx`, `src/lib/jobs/credit-hold.ts` and the three page/table changes; `test(jobs)` for every test file and helper; `docs` for `generator.md`, `decisions.md`, `n8n.md` and `security.md`; and `docs(tasks)` / `docs(review)` for `tasks.md` and `review.md`. Then push the branch and open the PR so CI runs the full gate set — including the timing-budget step, the Docker image build, commitlint and `pnpm db:check` on Linux, none of which this phase could run — review F1 (MAJOR), specs/043-llm-credit-hold/tasks.md:279, .specify/memory/constitution.md:86
