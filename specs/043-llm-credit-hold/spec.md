# Feature Specification: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

**Feature Branch**: `059-llm-credit-hold`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/llm-credentials.md in full — in particular its preamble (the goal paragraph and the 'Behaviour on main that every entry builds on' bullets covering the provider layer in src/server/llm/, LlmFailureKind and its two pgEnums, the jobs runner's TEMPORARY/retryLater/fail behaviour, the env-only secrets invariant, and usage being captured but never persisted), the 'Rules for every entry' list, and this entry's own section '1. credit-hold'. Also read docs/generator.md ('Configuring a provider', 'Jobs') and docs/security.md in full, as the roadmap preamble requires of every entry.

Problem as the author verified it: credit exhaustion today permanently fails every job item it touches and points the operator at the wrong thing. Anthropic returns HTTP 400 invalid_request_error ('Your credit balance is too low...'), not 402 or 429; the SDK raises BadRequestError; src/server/llm/anthropic.ts:25-31 maps it to bad_request; that kind is absent from TEMPORARY, so runner.ts:318 calls fail(). The SDK's own maxRetries: 2 does not retry 400s. At defaults (60s worker interval, GENERATION_TICK_MAX_ITEMS=2) this permanently fails roughly 120 items per hour of outage, capped at the 500-item job limit. OpenAI differs only in shape: insufficient_quota arrives as 429 -> RateLimitError -> rate_limited, which *is* temporary, so it burns three doomed retries over about 20 minutes and then fails identically.

Build: detect billing refusal on both providers (Anthropic by inspecting the 400's message, OpenAI by insufficient_quota); give it its own persisted failure kind, which per the preamble means a migration touching both pgEnums (llm_failure_kind in src/server/db/schema/generation.ts and generation_job_item_error in src/server/db/schema/jobs.ts); and stop the runner claiming items while the credential is refusing on billing, resuming automatically when a call succeeds again. The author is explicit that merely adding the kind to TEMPORARY is NOT sufficient: three attempts over about 20 minutes still mass-fails an outage that lasts until someone tops up. Surface the held state honestly on the Batch jobs screens and name billing as the cause.

Design constraint the author imposes for the benefit of entry 2: scope the hold by credential owner from day one, even though there is exactly one credential today. Entry 2 widens that scope to per-project and must not have to rework it.

Must leave the repo working and state in its own docs what it does not do and which later entry owns it. No secret may reach a log, a response or the UI; extend the secret-scan suite (tests/integration/security/secret-scan.test.ts, tests/integration/no-plaintext.test.ts) rather than exempting it.

Does NOT: add per-project keys or settings of any kind — entry 2 (per-project-llm) owns that; persist token usage or cost — entry 3 (llm-cost-visibility) owns that; or change what happens to the already-landed operator message in src/server/llm/messages.ts, which the author marks done and explicitly not to re-spec."

## Context and sources

- Roadmap `.specify/roadmaps/llm-credentials.md` / `.specify/roadmaps/llm-credentials.json`, entry **1 of 3**, slug `credit-hold`. The roadmap's goal: "make Docket's LLM layer survive a provider refusing on billing, then let a project bring its own model and key and see what it spent." Docket is moving to Anthropic `claude-haiku-4-5` against a **shared monthly credit pool that other work also consumes**, so credit exhaustion is a recurring operational event, not an edge case.
- It is first because the current behaviour destroys work at scale, and because its hold needs credential-owner scoping in place before entry 2 widens that scope to per-project.

### Behaviour on `main` that this feature builds on

Read from the roadmap preamble, `docs/generator.md` ("Configuring a provider", "Jobs"), `docs/security.md` and the code itself:

- **The provider layer** is `src/server/llm/`: `anthropic.ts` and `openai.ts` behind `LlmProvider` (`types.ts`), chosen by `parseLlmConfig` (`config.ts:37`) from `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS`. Generation is simply off when `LLM_PROVIDER` is unset; startup logs it and carries on. `generate()` **never throws** for provider or network failure — it returns `{ ok: false, kind }`.
- **`LlmFailureKind`** has eight members (`invalid_output`, `refused`, `incomplete`, `timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`) and is persisted in **two** pgEnums: `llm_failure_kind` (`src/server/db/schema/generation.ts:23`, the `kind` column of `generation_failures`) and `generation_job_item_error` (`src/server/db/schema/jobs.ts:39`, which carries five more runner-only kinds: `internal`, `interrupted`, `image_deleted`, `image_unavailable`, `no_targets`). One fixed sentence per kind lives in `src/server/llm/messages.ts`; SDK error text never reaches a user, and `messages.test.ts` asserts the map is exhaustive.
- **The verified failure chain.** Anthropic returns HTTP 400 `invalid_request_error` ("Your credit balance is too low…"), not 402 or 429; the SDK raises `BadRequestError`; `kindOfError` in `anthropic.ts:25-31` maps `BadRequestError`/`UnprocessableEntityError`/`NotFoundError` to `bad_request`; `bad_request` is absent from the runner's `TEMPORARY` set (`runner.ts:48`), so the dispatch at `runner.ts:320` calls `fail()` — `status: "failed"`, `finishedAt` set, no `nextAttemptAt`: **terminal**. The SDK's own `maxRetries: 2` does not retry 400s. At the documented defaults (60 s worker interval, `GENERATION_TICK_MAX_ITEMS=2`, ≈120 items an hour) that permanently fails ≈120 items per hour of outage, capped at the 500-item job limit.
- **OpenAI differs only in shape.** `insufficient_quota` arrives as 429 → `RateLimitError` → `rate_limited`, which *is* in `TEMPORARY`, so it burns three doomed attempts over ≈20 minutes (backoff 60 s growing to 15 min, `cfg.maxAttempts` 3) and then fails identically.
- **The runner and the claim.** `runGenerationJobs` (`src/server/scheduler/generation.ts`) checks `getLlmStatus().configured` and the tick budget, then `claimDueJobItems` (`src/server/dal/job-claims.ts`) locks jobs with due items (`FOR UPDATE SKIP LOCKED`, least-recently-served first), interleaves them round-robin, keeps `maxItems`, and `processClaimedItem` runs each with one bounded model call. Recovery of a failed item is manual, via `retryFailedItems` (`src/server/services/jobs/manage.ts:37`), which resets attempt counts and never creates a duplicate post. A correction retry that cannot fit in the tick is already **deferred to a later tick without counting an attempt** — the precedent this entry builds on.
- **The in-request correction set is separate.** `RETRYABLE` in `src/server/services/generation/core.ts:66` and `series.ts:81` is `{invalid_output, refused, incomplete, timeout}` — the one in-request retry, unrelated to the runner's `TEMPORARY`.
- **Secrets are env-only today.** `docs/generator.md`: "Keys are read from the environment only and never stored, logged or rendered." `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both named in the secret-scan regression suite (`tests/integration/security/secret-scan.test.ts:156-157`), whose `docs/security.md` rows cover secrets in logs, in responses, in rendered UI and in attempt and audit rows. The runner already redacts the configured key from its own log lines (`logLine` → `src/server/scheduler/redact.ts`).
- **Usage is captured but never persisted.** `LlmUsage` is returned by every call and written to the log line by `logLlmCall` (`src/server/llm/log.ts`). No `usage` column exists anywhere in the generation schema.
- **The Batch jobs screens.** The list (`src/app/p/[projectSlug]/jobs/page.tsx`) shows per-job status and a per-status item breakdown. The detail page (`.../jobs/[jobId]/page.tsx`) auto-refreshes every 5 s while a job is queued or running, and already renders two honest notices of exactly this shape: "Generation is not configured, so these items are waiting. Set: …" from `getLlmStatus()`, and "Jobs cannot run: …" from `jobsRunnable` (the tick-budget check in `src/server/services/jobs/read.ts:160`).
- **The public API already carries item errors.** `JobItemSchema.error` (`src/lib/api/schemas.ts:194`) is `{ kind: string, message: string } | null`, and a `queued` item already carries the error of its last attempt, so a new kind value is not a contract change.

### Facts, and what is not verified

- Verified from the installed SDK types, not memory: OpenAI's `APIError` exposes `status`, `code`, `type` and the parsed `error` body (`node_modules/openai/core/error.d.ts`), and `RateLimitError extends APIError<429>`; Anthropic's `APIError` exposes `status`, the parsed `error` body and `type` ("the `error.type` from the API response body") (`node_modules/@anthropic-ai/sdk/core/error.d.ts`), and `BadRequestError extends APIError<400>`. So both signals can be read from structured fields rather than scraped from a composed message string.
- `docs/research/llm-and-storage.md` records each SDK's retry policy and error classes but **says outright that OpenAI's full error class list was not confirmed**, and it does not record Anthropic's 400 body wording or OpenAI's `insufficient_quota` code. Those two come from the author's own verification against the live APIs and are treated here as the author's facts, not as research. Phases cannot fetch the web, so detection MUST be written to degrade safely (FR-004) and MUST be tested with mocked HTTP only (constitution II: "verified with mocks only").
- No new runtime dependency and no new infrastructure is expected. One migration (two pgEnums, one new table) is expected. No new environment variable is expected.

## Decisions made while specifying

Judgement calls, for planning to record in `docs/decisions.md` as **C1–C14**, next to the generator decisions.

### The failure kind

- **C1 — One new kind, `credit_exhausted`, in both pgEnums.** Named for the condition, not the provider, because both providers mean the same thing by it: the account has no spendable credit or quota left. Not `billing_refused`, because `refused` already means "the model declined to write this post" and the two must not read alike. It joins `llm_failure_kind` (so an interactive generation records it in `generation_failures`) and `generation_job_item_error` (so a job item can say why it is waiting).
- **C2 — Detection is per provider, structured, and conservative.** Anthropic: an `invalid_request_error` whose body message names a credit balance (matched case-insensitively on a short, documented phrase). OpenAI: an error whose `code` is `insufficient_quota`, checked **before** the existing `RateLimitError → rate_limited` mapping so a billing 429 is never mistaken for rate limiting. Each provider gets one named predicate so adding another observed code later is a one-line change.
- **C3 — An unrecognised shape keeps today's behaviour.** Anything not matched stays `bad_request` or `rate_limited` exactly as now. The cost of a missed detection is today's behaviour; the cost of a false positive is a stalled install, so the predicate is narrow.
- **C4 — `bad_request`'s already-landed sentence is untouched.** The author marks it done. The new kind gets its own fixed sentence, which the exhaustive `messages.test.ts` map forces. `credit_exhausted` is **not** added to the in-request `RETRYABLE` sets either: a correction retry cannot buy credit.

### Not failing items, and the hold

- **C5 — A billing refusal never fails a job item.** The item returns to `queued`, immediately due, with **no attempt counted** and its lease released cleanly, so lease recovery cannot later count it as `interrupted` and exhaust `maxAttempts` behind the operator's back. The kind and its sentence are still recorded as the item's last error, so the screens and the public API can say why it waits. This follows the existing deferred-correction-retry precedent.
- **C6 — The hold, not `TEMPORARY`.** Adding `credit_exhausted` to `TEMPORARY` is explicitly rejected, as the roadmap requires: three attempts over ≈20 minutes still mass-fails an outage that lasts until someone tops up. While a credential is refusing on billing the runner claims **nothing** for that credential.
- **C7 — The hold is scoped by credential owner from day one.** Today there is exactly one owner — the install's env-configured credential — so the single hold covers every project. The runner MUST decide claiming **per owner** and MUST NOT assume there is only one: the owner of a job's credential comes from one named function (today a constant), and the claim is filtered by the set of currently held owners. Entry 2 changes only that function and the stored owner values.
- **C8 — No credential value, and no fingerprint of one, is stored.** The hold records *that* an owner is refusing, never *which key* refused. A top-up and a swapped key are therefore indistinguishable and are both detected the same way (C9), within one probe interval. This keeps the env-only invariant in `docs/generator.md` true for this entry and keeps the new table outside the secret-scan's concern.

### Resuming

- **C9 — Recovery is detected by a successful call, never guessed.** While held, the runner lets **one** item through every 5 minutes as a probe. Any outcome other than a billing refusal clears the hold — a success obviously, but also a timeout or an invalid output, because both prove the account is spending again. A probe that is refused on billing again requeues its item under C5 and pushes the next probe out another 5 minutes. 5 minutes is a fixed, documented constant, not a new environment variable: it costs at most 12 refused calls an hour (a 400 or 429 charges no tokens) against the ≈120 items an hour it saves.
- **C10 — The probe is single-flight.** Two workers, or two overlapping ticks, must never both probe. The probe claim is decided inside the same transaction that writes the next probe time, so exactly one tick wins — no advisory lock, in keeping with the Neon transaction-mode pooler constraint.
- **C11 — Interactive generation is not blocked, and acts as a free probe.** A person pressing Generate makes one call and gets one honest sentence back at once, which is better than being told to wait on something they can see for themselves; and that call clears the hold if the account is spending again. Every path — single, series, regenerate, "Try it" on the voice screen, job item, `pnpm llm:check` — sets or refreshes the hold on a billing refusal and clears it on any other outcome.
- **C12 — No give-up timeout.** A hold lasts until credit returns or until someone cancels the job. Nothing is destroyed: items stay queued, reserved images stay reserved, jobs stay queued or running, and the count of failed items does not move. A stalled job that the operator no longer wants is cancelled the way it already is.

### Surfacing, and what nothing changes

- **C13 — Honest notices on both Batch jobs screens, naming billing.** Both screens say that generation is paused because the model provider refused on billing, that waiting items have **not** failed and need no retry, that they resume automatically, and what the operator must do (restore credit on the provider account). The notice follows the two existing notices on the job page in shape and tone. No new job status is introduced: `generation_job_status` and `generation_job_item_status` are unchanged, so no status enum, badge or derived-status rule has to move.
- **C14 — Items already failed by an earlier outage are not touched.** No migration rewrites history: items failed as `bad_request` or `rate_limited` before this release keep their kind. The existing "Retry failed items" is what recovers them, and after this entry it is safe to press during an outage, because the retried items wait instead of failing again.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An outage no longer destroys a batch job (Priority: P1)

An operator starts a 500-item batch job. Two hours in, the shared credit pool runs dry. Today roughly 240 items would be permanently failed by the time anyone noticed. Instead the job stops consuming itself: the items that were in flight go back to the queue untouched, nothing new is claimed, and no item is marked failed.

**Why this priority**: It is the entry. Everything else here exists to make this safe and legible.

**Independent Test**: Run a job with a provider stubbed to refuse on billing for two simulated hours of ticks, then stop refusing. Check that zero items are `failed`, that no item's attempt count rose, that the job's status never became `completed_with_failures`, and that every item eventually produced exactly one post.

**Acceptance Scenarios**:

1. **Given** a queued job and a provider that refuses on billing, **When** the tick claims an item and the call is refused, **Then** the item is `queued` and immediately due again, its attempt count is unchanged, its lease is released, and its recorded error is the new kind with its one fixed sentence.
2. **Given** that first refusal, **When** the next tick runs within the probe interval, **Then** it claims no item for that credential owner at all, and records in its summary that the section was held.
3. **Given** two items claimed in the same tick and both refused on billing, **When** the tick ends, **Then** both are queued with no attempt counted and exactly one hold exists.
4. **Given** 120 minutes of ticks under a continuous billing outage, **When** the outage ends, **Then** at most 24 calls were made (one probe per 5 minutes), no item is `failed`, and no item has reached `maxAttempts`.
5. **Given** an item held under a billing outage, **When** its lease would otherwise expire, **Then** no lease recovery counts an attempt for it and it is never failed as `interrupted`.
6. **Given** a provider that refuses with a 400 or a 429 that is *not* a billing refusal, **When** the call is made, **Then** behaviour is exactly today's: `bad_request` fails the item, `rate_limited` retries it with backoff, and no hold is created.

---

### User Story 2 - It resumes by itself after a top-up (Priority: P1)

The operator adds credit to the provider account. Nobody opens Docket, nobody retries anything. Within minutes the job is generating again and finishes.

**Why this priority**: A hold that needs a human to lift it has only moved the outage, not survived it. "Resuming automatically when a call succeeds again" is the roadmap's wording.

**Independent Test**: Hold a job on billing, stop the stub refusing, advance the clock one probe interval, and check the next tick resumes full throughput with no human action and no retry.

**Acceptance Scenarios**:

1. **Given** a hold, **When** a probe call succeeds, **Then** the hold is gone and the next tick claims up to `GENERATION_TICK_MAX_ITEMS` again.
2. **Given** a hold, **When** a probe call fails for any non-billing reason (timeout, invalid output, unavailable), **Then** the hold is also cleared and that item follows its ordinary path for that kind.
3. **Given** a hold whose probe is not yet due, **When** a person generates a single post and that call succeeds, **Then** the hold is cleared and the runner resumes on its next tick without waiting for the probe.
4. **Given** a hold, **When** the operator instead replaces the key or switches provider and restarts, **Then** the next successful probe clears the hold; no operator action inside Docket is needed and no stale hold survives a configuration change.
5. **Given** two worker processes ticking at once under a hold, **When** a probe is due, **Then** exactly one probe call is made.
6. **Given** a cleared hold, **When** the provider refuses on billing again later, **Then** a fresh hold is created and the cycle repeats with no residue from the previous one.

---

### User Story 3 - The Batch jobs screens say what is wrong, and it is billing (Priority: P1)

Someone opens Batch jobs and sees nothing happening. The screen tells them the provider has refused on billing, that the waiting items have not failed, that nobody needs to retry them, and what to do about it.

**Why this priority**: The roadmap names this explicitly, and the old behaviour's second harm was pointing the operator at the wrong thing. Silence while held would repeat that harm.

**Independent Test**: With a hold in place, render the Batch jobs list and a job's page and check both name billing as the cause, say the items are waiting rather than failed, say it resumes by itself, and pass the `docket-ui` rules.

**Acceptance Scenarios**:

1. **Given** a hold covering the viewer's project, **When** the Batch jobs list is rendered, **Then** it carries a notice that names billing as the cause, states that queued items are waiting and have not failed, and states that they resume automatically when credit is restored.
2. **Given** a hold, **When** a queued or running job's page is rendered, **Then** it carries the same notice alongside the existing not-configured and tick-budget notices, and it says since when generation has been paused, in the project's time zone and the project's date format.
3. **Given** a hold, **When** an item's row is rendered, **Then** the row reads as waiting, with the new kind's fixed sentence as its reason and no retry action offered for it — it is not presented as a failure.
4. **Given** a hold is lifted while a job page is open, **When** the page's existing auto-refresh fires, **Then** the notice disappears without a manual reload.
5. **Given** a hold, **When** the notices are read with assistive technology and with the keyboard only, **Then** they are reachable, conveyed as text and not by colour alone, and announced no more aggressively than the notices that exist today.
6. **Given** no hold, **When** either screen is rendered, **Then** it is what it is today, with no new element and no changed wording.
7. **Given** a hold, **When** any screen, notice, log line or API response is inspected, **Then** no API key, no provider error text and no account identifier from the provider appears anywhere in it.

---

### User Story 4 - A person generating one post, and an operator checking the configuration (Priority: P2)

Interactive generation still answers at once, with a sentence that names credit rather than blaming the model or the request. `pnpm llm:check` reports the same condition by name.

**Why this priority**: Lower than the job path because one person losing one click is not the harm the entry exists to fix, but it is the same misdiagnosis, and the hold's recovery depends on these calls being allowed through.

**Independent Test**: With a stub refusing on billing, run a single generation and `pnpm llm:check`, and check the recorded failure kind, the message shown, and the printed outcome.

**Acceptance Scenarios**:

1. **Given** a billing refusal, **When** a single, series, regenerate or voice "Try it" generation is run, **Then** it returns the new kind's one fixed sentence, which names credit, and does not retry in-request.
2. **Given** a billing refusal in a saved generation failure, **When** the failure is stored and later displayed, **Then** its kind is the new one and its message is the fixed sentence — never the provider's text.
3. **Given** a billing refusal, **When** `pnpm llm:check` runs, **Then** its `outcome=` names the new kind and its exit behaviour is the existing one for a failed check.
4. **Given** a public-API caller polling a held job, **When** it reads the job's items, **Then** a waiting item reports status `queued` with the new error kind and the fixed sentence, the job counts show them as queued rather than failed, and the response schema is unchanged.

---

### Edge Cases

- **The outage starts mid-tick.** One item of the tick is refused and the other is still mid-call: the second item is judged on its own outcome, and whichever refusals happen set or refresh the same single hold.
- **The outage starts between the claim and the call.** An item already claimed when the hold appears finishes its call; if it succeeds it is saved normally and clears the hold.
- **A probe that cannot fit in the tick budget.** The existing minimum-call and persist-reserve rules win: nothing is claimed, the probe is not consumed, and the next probe time does not move.
- **Generation is not configured at all** (`LLM_PROVIDER` unset). The existing not-configured path runs first and nothing about holds applies; the not-configured notice is what shows.
- **The tick budget is too short** (`SCHEDULER_TICK_BUDGET_SECONDS` below the minimum). The existing not-runnable path is unchanged, and its notice is what shows.
- **A held job is cancelled.** Cancellation works exactly as it does today: queued items become `cancelled`, images are released, the hold is unaffected because it belongs to the credential, not the job.
- **"Retry failed items" pressed during an outage.** The reset items become due, the next probe may claim one, and it waits rather than failing again. No item is failed by pressing it.
- **An item tagged with an `externalId` already claimed elsewhere.** The existing skip check runs before the model call, so a held outage never affects skip behaviour.
- **A job reaches the 500-item limit while held.** Nothing special: items wait. An open job can still accept items.
- **A hold older than any outage anyone remembers** (for example the credential was abandoned). Items wait indefinitely by C12; the screens keep saying why, and the only cure is credit or cancellation.
- **The clock moves backwards, or the next probe time is in the past at startup.** The first tick after startup probes once; a missed probe window never queues up two probes.
- **Two credential owners, one held** (not reachable today, reachable in entry 2). The claim for the held owner yields nothing while the other owner's jobs continue; the test harness must be able to express this now even though only one owner exists.

## Requirements *(mandatory)*

### Functional Requirements

**Detecting a billing refusal**

- **FR-001**: The provider layer MUST classify a provider's refusal to spend — an account with no credit or no remaining quota — as a distinct failure kind, `credit_exhausted`, returned from `generate()` in the existing `{ ok: false, kind }` shape. `generate()` MUST still never throw for it.
- **FR-002**: For Anthropic, the classification MUST recognise the verified shape: HTTP 400 `invalid_request_error` whose body message names a credit balance. It MUST read the provider's structured error fields rather than scraping a composed message string, and MUST match the phrase case-insensitively.
- **FR-003**: For OpenAI, the classification MUST recognise an error whose code is `insufficient_quota`, and MUST test for it **before** mapping a 429 to `rate_limited`, so a billing 429 is never reported as rate limiting (C2).
- **FR-004**: Any error that does not match either predicate MUST keep exactly today's mapping (`bad_request`, `rate_limited`, `auth`, `timeout`, `unavailable`), and MUST NOT create a hold (C3). Each predicate MUST live in one named place per provider.
- **FR-005**: `credit_exhausted` MUST have its own fixed sentence in the failure-message map, naming credit as the cause and what to do, and MUST NOT change the existing `bad_request` sentence (C4). No provider error text, account identifier or key MUST appear in it.
- **FR-006**: `credit_exhausted` MUST NOT be added to the in-request correction-retry sets, so no generation retries itself in-request on it (C4).

**Not failing items**

- **FR-007**: A job item whose model call is refused on billing MUST NOT be failed. It MUST return to `queued`, immediately due, with its attempt count unchanged, its lease released, and any pending in-request correction state cleared (C5).
- **FR-008**: That item MUST record `credit_exhausted` and its fixed sentence as its last error, so every surface can say why it waits, and its job's derived status MUST be recomputed so no job is reported as finished-with-failures because of a billing outage.
- **FR-009**: The requeue MUST be lease-checked exactly as every other post-claim write is, MUST count in the tick summary as its own outcome (neither `failed` nor `retried`), and MUST leave an item whose post was already saved alone.
- **FR-010**: `credit_exhausted` MUST NOT be added to the runner's `TEMPORARY` set, and MUST NOT reach the ordinary retry-with-backoff path, so no billing outage can ever exhaust an item's attempts (C6).

**Holding and resuming**

- **FR-011**: A billing refusal MUST record a hold against the **credential owner** of the credential that refused. Today exactly one owner exists (the install's env-configured credential) and one hold therefore covers every project; the design MUST permit more owners without changing the hold's meaning or the shape of the claim (C7).
- **FR-012**: The owner of the credential a job would use MUST come from one named function, today a constant, so that entry 2 changes only that function and the stored owner values.
- **FR-013**: While an owner is held, the runner MUST claim no job items for that owner, and MUST claim normally for every owner that is not held. A held owner MUST NOT consume the tick's item budget.
- **FR-014**: Every 5 minutes while held, the runner MUST let exactly one item through as a probe. The 5-minute interval MUST be a documented constant and MUST NOT add an environment variable (C9).
- **FR-015**: Exactly one probe MUST be made per interval however many workers or overlapping ticks there are: the decision to probe and the write of the next probe time MUST happen in one transaction, with no session-level Postgres feature (C10).
- **FR-016**: A probe whose call is refused on billing again MUST requeue its item under FR-007 and push the next probe out one interval. A probe that is not made because the tick budget is too short MUST NOT consume the interval.
- **FR-017**: Any call outcome other than a billing refusal MUST clear the hold for that owner, from any caller — job item, probe, single, series, regenerate, voice "Try it" or the configuration check (C9, C11).
- **FR-018**: Interactive generation MUST NOT be blocked by a hold: it makes its one call and returns the fixed sentence for whatever it gets (C11).
- **FR-019**: A hold MUST NOT expire on its own, MUST NOT fail or cancel anything, and MUST NOT release reserved images. It ends only when a call succeeds (FR-017) (C12).
- **FR-020**: The hold MUST record no credential value and no fingerprint, hash or prefix of one; it MUST record only the owner, when the hold began, when a refusal was last seen and when the next probe is due (C8).
- **FR-021**: The tick summary and heartbeat MUST report that the generation section was held and whether a probe was made, in the same shape as the existing not-configured and not-runnable flags, so an operator can see a hold without reading the database.

**The Batch jobs screens**

- **FR-022**: While the viewer's project is covered by a hold, the Batch jobs list and each queued or running job's page MUST carry a notice that: names billing (a credit or quota balance on the provider account) as the cause; states that queued items are waiting and have **not** failed; states that they resume automatically when credit is restored and that nobody needs to retry them; and says what the operator must do. It MUST say since when generation has been paused, in the project's time zone and the project's date format.
- **FR-023**: The notice MUST coexist with the existing not-configured and tick-budget notices without duplicating them, MUST follow their shape and tone, and MUST disappear on the job page's existing auto-refresh once the hold is lifted.
- **FR-024**: A waiting item's row MUST read as waiting with the fixed sentence as its reason, MUST NOT be presented as a failure, and MUST NOT offer a retry action; the per-status counts MUST keep counting it as queued.
- **FR-025**: No new job or item status MUST be introduced, and no existing status, badge or derived-status rule MUST change (C13).
- **FR-026**: Both screens MUST meet the `docket-ui` rules: full keyboard use, visible focus, status conveyed as text and not colour alone, server components except where interactivity already demands otherwise, and announcements no more aggressive than today's. With no hold, both screens MUST be unchanged.
- **FR-027**: Every role that can already view Batch jobs MUST see the notice; it MUST reveal nothing about the credential beyond the fact that the provider account has no spendable credit.

**Data and migration**

- **FR-028**: `credit_exhausted` MUST be added to **both** pgEnums — `llm_failure_kind` and `generation_job_item_error` — in one committed SQL migration, with `pnpm db:check` green.
- **FR-029**: The migration MUST be safe to apply to a live, populated installation, MUST NOT rewrite or reclassify any existing row, and MUST NOT require any operator action. Items failed by an earlier outage keep their existing kind (C14).
- **FR-030**: The hold's storage MUST be install-wide state, like the scheduler heartbeats, not project-owned data, and MUST be read and written through one module which the runner uses inside its claim path. Project-owned tables and the project-scope rules MUST be untouched.
- **FR-031**: An empty hold table MUST reproduce today's behaviour exactly, so an upgrade with no outage in progress changes nothing observable.

**Secrets**

- **FR-032**: No API key, no provider error text and no provider account identifier MUST reach a log line, a stored row, an API response or the UI on any path this entry adds — detection, the hold, the probe, the notices or the item reason. The redaction the runner already applies to its log lines MUST continue to cover every new line.
- **FR-033**: The secret-scan suite MUST be **extended, not exempted** (roadmap rule): `tests/integration/security/secret-scan.test.ts` MUST include a billing-refusal path whose provider error body contains the configured API key, and `tests/integration/no-plaintext.test.ts` MUST cover the new table in its all-tables scan so neither a key nor a hash of one can ever appear there. `docs/security.md` MUST gain or extend the rows that name these tests, keeping `tests/integration/docs/security-findings.test.ts` green.

**Docs**

- **FR-034**: `docs/generator.md` MUST document, under "Configuring a provider" and "Jobs": what a billing refusal is and that it is not a lasting failure; that generation pauses per credential and resumes automatically; the 5-minute probe; that nothing is failed, cancelled or unreserved while paused; and that `pnpm llm:check` names the condition. The env-only sentence MUST be left true and unchanged by this entry.
- **FR-035**: `docs/decisions.md` MUST record C1–C14 next to the generator decisions, including why `TEMPORARY` was rejected and why the hold is scoped by credential owner before there is more than one owner.
- **FR-036**: `docs/n8n.md` § 4 MUST note in one or two sentences that a job item can sit `queued` carrying a `credit_exhausted` error, that it needs no retry, and that the response schema is unchanged.
- **FR-037**: The docs MUST state what this entry does not do and which later roadmap entry owns each of those things, matching this spec's Out of Scope section (roadmap rule).

**Tests**

- **FR-038**: Tests MUST cover, all with mocked HTTP and never a live call (constitution II):
  - both providers' detection: the Anthropic 400 body wording, OpenAI's `insufficient_quota` on a 429, each provider's non-billing 400 and 429 keeping today's kind, and a malformed or empty error body;
  - an item refused on billing: queued, due, attempt count unchanged, lease released, error recorded, job status not finished-with-failures;
  - a simulated multi-hour outage: zero failed items, at most one call per probe interval, no item reaching `maxAttempts`, and every item producing exactly one post after recovery;
  - resumption by a successful probe, by a non-billing probe outcome, and by an interactive call before the probe is due;
  - probe single-flight with two concurrent ticks, and a probe skipped for tick budget not consuming the interval;
  - lease recovery never counting an attempt for a held item, and never failing one as `interrupted`;
  - cancel, "Retry failed items" and an open job accepting items, all during a hold;
  - a second credential owner that is not held continuing to be claimed while the held one is not (expressible today with one owner value in the test harness);
  - the migration applied to a populated database: no row reclassified, both enums carrying the new value, `pnpm db:check` green;
  - the two screens rendered held and not held, including the notice wording, the waiting-item row, the absence of a retry action, the auto-refresh clearing it, and the `docket-ui` accessibility rules;
  - the public API's job and job-item payloads for a held job, with the schema unchanged;
  - the secret-scan extension of FR-033, proven able to fail by a deliberate leak, as the existing scan is.

### Key Entities

- **`credit_exhausted` (new failure kind)**: the provider refused to spend because the account has no credit or quota left. Persisted in both enums; carries one fixed sentence; never retried in-request; never a lasting job-item failure.
- **Credential owner**: who owns the credential a call would spend. Exactly one value today — the install's env-configured credential — and the unit the hold is keyed by. Entry 2 adds per-project owners.
- **Credit hold**: install-wide state, at most one per credential owner. Records the owner, when the hold began, when a refusal was last seen and when the next probe is due. Records no credential value or fingerprint. Created by any billing refusal, deleted by any other outcome, never expiring on its own.
- **Probe**: the one item a held owner is allowed every 5 minutes, decided single-flight inside the claim transaction. Its only job is to find out whether the account is spending again.
- **Waiting item** (existing job item, new reason): `queued`, immediately due, attempt count unchanged, carrying `credit_exhausted` as its last error. Counted as queued everywhere, offered no retry.
- Existing entities referenced, unchanged in meaning: generation job, job item, job claim and lease, generation failure, tick budget, heartbeat, voice profile, media reservation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A simulated two-hour billing outage across a 500-item job permanently fails **zero** items, against roughly 240 today, and raises no item's attempt count.
- **SC-002**: During that outage Docket makes at most 12 model calls an hour per credential owner (one per 5 minutes), against the ≈120 it makes today.
- **SC-003**: After credit is restored, generation resumes with no human action inside Docket and no retry, within one probe interval plus one worker interval — under 6 minutes at the documented defaults — and the job then finishes with exactly one post per item.
- **SC-004**: An operator looking at Batch jobs during a hold can tell, without reading a log or the database, that the pause is a billing one, that nothing has failed, that nobody needs to retry anything, and roughly how long it has lasted.
- **SC-005**: A person who runs a single generation during an outage is told that the provider account is out of credit, in one sentence, with no provider error text, in 100% of tested cases — not that the model declined or the request was invalid.
- **SC-006**: Zero secrets appear in logs, stored rows, API responses or rendered UI on any path this entry adds, proven by the extended secret-scan suite with a provider error body that contains the configured key, and the scan still demonstrably fails on a deliberate leak.
- **SC-007**: With no hold in place, every observable behaviour — claim order, throughput, item outcomes, both screens, the public API payloads, the existing failure kinds and messages — is identical to `main`, demonstrated by the existing suites staying green with no assertions relaxed.
- **SC-008**: Applying the migration to a copy of a populated installation reclassifies no row, requires no operator action, and leaves `pnpm db:check` green.
- **SC-009**: A non-billing 400 and a non-billing 429 behave exactly as they do today in 100% of tested cases, so no stall is introduced by a false positive.
- **SC-010**: Entry 2 can widen the hold to per-project credentials by changing the credential-owner function and the stored owner values, without changing the hold's meaning, the probe, the notices or the claim's shape — demonstrated by a test that exercises two owners, one held and one not.

## Assumptions

- The author's two observations — Anthropic's 400 `invalid_request_error` whose message names a credit balance, and OpenAI's `insufficient_quota` — are the shapes worth detecting. They are not in `docs/research/`, so detection is narrow by design (C3) and tested with mocks only. If a provider changes wording, the consequence is today's behaviour, not a stall.
- A 400 or a 429 charges no tokens, so probing costs nothing but a request.
- 5 minutes is a judgement call, not a measured figure: short enough that a top-up is noticed quickly, long enough that a day-long outage costs a few hundred requests rather than a few thousand. It is a constant the plan may name once.
- A billing refusal affects every call made with that credential, so one refusal is enough evidence to hold; this is why no threshold or failure count is required before holding.
- An operator who tops up credit does not necessarily open Docket, which is why recovery must not need a click.
- The install's single env-configured credential is the only credential owner that exists today, so a hold today pauses generation for every project. That is correct behaviour for a shared pool, and entry 2 is what makes it finer-grained.
- Nothing in the codebase reaps old running jobs, so an indefinitely held job is safe to leave: it will not be aged out or quietly failed.
- The Batch jobs job page already auto-refreshes every 5 s while a job is queued or running, so no new polling is needed for the notice to clear.
- No new environment variable, runtime dependency, infrastructure, public-API operation or `docker-compose.yml` change is expected. One migration and one install-wide table are.
- The already-landed `bad_request` sentence stays exactly as it is; this entry only stops that kind being reached by a billing refusal in the first place.

## Dependencies

- `main` as of this spec: the provider layer and `parseLlmConfig`; the eight-member `LlmFailureKind` and its two pgEnums; the exhaustive failure-message map and its test; the jobs runner's claim, lease, `TEMPORARY`, `retryLater`, `fail`, deferred-retry and skip paths; `refreshJobStatus`; `retryFailedItems` and `cancelJob`; the Batch jobs list and job pages with their two existing notices and auto-refresh; the heartbeat summary; the public API's job and job-item payloads; the log-line redaction.
- The secret-scan regression suite and `docs/security.md`'s findings table, with `tests/integration/docs/security-findings.test.ts` enforcing that every row names tests that exist.
- The Neon constraint from the constitution: no advisory locks and no session-level Postgres features, which is why the probe is decided inside the claim transaction.

## Out of Scope

Each named with the entry that owns it, as the roadmap's rules require.

- **Per-project or per-user LLM keys, models, providers or settings of any kind**, and any storage of a key — owned by roadmap entry 2, `per-project-llm`. This entry deliberately leaves the env-only invariant in `docs/generator.md` true, and provides the credential-owner seam that entry 2 widens (C7, SC-010).
- **Persisting token usage or cost, and any spend reporting** — owned by roadmap entry 3, `llm-cost-visibility`. Usage stays logged and unpersisted.
- **Budgets, caps or throttling on spend** — out of the roadmap entirely; entry 3 names them out of scope too.
- **Re-specifying the operator message for `bad_request`** in `src/server/llm/messages.ts`. The author marks it done; this entry adds one new sentence for one new kind and changes nothing else in that map.
- **Notifying anyone about a hold** — no problem notification, webhook, email or bell count for it. The Batch jobs screens are the surface this entry adds. The notifications roadmap owns attention events, and a hold is install-wide operator state rather than a per-project problem.
- **A hold notice anywhere outside the Batch jobs screens** (the generate, compose, review, voice or overview screens). Interactive generation is unblocked and answers with its own sentence, which is the honest surface there.
- **An operator control to lift, force or inspect a hold**, and any admin or health screen for it. Recovery is a successful call; the tick summary and heartbeat carry the fact (FR-021).
- **A give-up timeout, or failing items after a long hold** (C12), and **retro-classifying items failed by outages before this release** (C14).
- **Changing any status enum, badge or derived-status rule**, the claim's round-robin fairness, the 500-item limit, `maxAttempts`, the backoff curve, the tick budget rules, or the `GENERATION_TICK_MAX_ITEMS` default.
- **Detecting any other provider condition** — expired cards, suspended accounts, organisation-level spend limits or regional restrictions — beyond the two verified shapes. Anything unmatched keeps today's behaviour (FR-004).
- **Image generation**, which remains an unimplemented interface, and **any provider beyond `openai` and `anthropic`**.
