# Tasks: Hardening for real use: failures view, limits audit, security pass, configuration and deployment

**Input**: Design documents from `/specs/010-hardening-deployment/`
**Prerequisites**: plan.md, spec.md, research.md (D1–D34, F1–F28, U1–U6), data-model.md, contracts/{services,ui,http-security,docs-and-config}.md, quickstart.md

**Tests**: Required. The spec demands a test per limit, per CSRF surface, per tick refusal case, and an end-to-end secret scan. Tests use Vitest against real Postgres with mocked HTTP only (no live network). Every task below is executable headless: no browser, no dev server, no `curl`. Pages are rendered with `renderToStaticMarkup(await Page(...))`; route handlers and `proxy()` are called directly.

**Organization**: grouped by user story. Read `node_modules/next/dist/docs/01-app/` before touching routes, the proxy or `next.config.ts` (AGENTS.md). Read the relevant contract file before each story.

## Format: `- [ ] T### [P?] [Story] Description with file path`

- **[P]**: parallelisable (different files, no dependency on an incomplete task)
- Verification commands: `pnpm vitest run <path>`, `pnpm tsc --noEmit`, `pnpm lint`, `pnpm db:check`

---

## Phase 1: Setup

- [X] T001 Confirm the baseline is green before any change: run `pnpm tsc --noEmit`, `pnpm lint` and `pnpm vitest run` and record failures (if any) at the top of the 010 section of `docs/decisions.md` as pre-existing
- [X] T002 Create the "010 — Hardening" heading in `docs/decisions.md` (FR-041); every later task that makes a judgement call appends a numbered entry under it

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: schema, DAL reads, shared validators and the multi-limit type that several stories rely on.

- [X] T003 Add enum values `resolved_not_published`, `requeued` to `publish_attempt_outcome`, `address_not_allowed` to `webhook_attempt_error`, and the partial index `post_targets_attention_idx` on `(project_id, updated_at DESC, id) WHERE status IN ('ambiguous','failed')` in `src/server/db/schema/{attempts,webhooks,posts}.ts` (data-model §1)
- [X] T004 Generate migration `drizzle/0007_*.sql` (+ meta) with `pnpm db:generate`, check that it only adds the enum values and index, then run `pnpm db:check`
- [X] T005 [P] Add `listAttention`, `countAttention` to `src/server/dal/targets.ts` and `listForTargets` to `src/server/dal/attempts.ts` as scoped methods (contracts/services.md "DAL additions"); extend the scope-check test so the new methods are covered
- [X] T006 [P] Add `externalUrlSchema` (http/https only, no embedded credentials, field error otherwise) to `src/lib/validation/scheduling.ts` with unit tests next to it; add `safeExternalHref` to `src/lib/safe-redirect.ts` with tests
- [X] T007 [P] Change `defaultPublishLimit` in `src/providers/types.ts` to `PublishLimit | readonly PublishLimit[]` (G14); add `providerPublishLimits` in `src/providers/limits.ts` with `src/providers/limits.test.ts`; update every reader of `defaultPublishLimit` (including the engine in `src/server/scheduler/limits.ts` and the looseness warning in `src/server/services/accounts.ts`) to go through it; log G14 in `docs/decisions.md`
- [X] T008 Extract `validateResolvedContent` from the scheduling gate in `src/server/services/posts/validate.ts` so the scheduling gate and the publish engine share it (D11), with a unit test that both callers get identical messages
- [X] T009 Run `pnpm tsc --noEmit` and `pnpm vitest run src/providers src/lib src/server/dal` and fix regressions from T003–T008

**Checkpoint**: foundation ready; US1–US4 may begin.

---

## Phase 3: User Story 1 — See and resolve every post that did not go out (P1) 🎯 MVP

**Goal**: `/p/[slug]/failures` lists ambiguous and failed targets with full attempt logs and lets a member resolve or retry them, atomically.
**Independent test**: `pnpm vitest run tests/integration/failures` passes (quickstart §1): three seeded targets appear with attempt logs, nav badge shows 1, resolving removes the row, another project's member gets not-found.

### Tests for US1 (write first, expect failures)

- [X] T010 [P] [US1] Write `tests/integration/failures/list.test.ts`: ordering (ambiguous first, newest first), filters by status and account, pagination at 25, soft-deleted post exclusion, two-project isolation (SC-002)
- [X] T011 [P] [US1] Write `tests/integration/failures/attempts.test.ts`: full attempt log in time order, actor names for user actions, polling runs collapsed with a count by `groupAttemptRuns`
- [X] T012 [P] [US1] Write `tests/integration/failures/resolve.test.ts` and `tests/integration/posts/resolve-url.test.ts`: mark published with and without URL, refuse `javascript:`/`ftp:`/credentialed URLs with a field error, webhook `post.published` fires, derived post status recalculated
- [X] T013 [P] [US1] Write `tests/integration/failures/requeue.test.ts`: slot found → `scheduled` with `resolved_not_published` then `requeued {scheduledAt, slotId}`; no free slot → `failed` with `no_free_slot`; gate failure → unchanged `ConflictError`; "don't requeue" → `failed`
- [X] T014 [P] [US1] Write `tests/integration/failures/concurrency.test.ts`: 20 parallel resolve/requeue calls on one ambiguous target, exactly one succeeds, no occurrence held twice (SC-003)
- [X] T015 [P] [US1] Write `tests/integration/failures/retry.test.ts`: retry on an active account re-arms and resets the count; refused with an actionable message when the account needs reconnecting, was removed, or the provider is unavailable
- [X] T016 [P] [US1] Write `tests/integration/failures/authz.test.ts` and add rows to `tests/integration/actions-authz.test.ts`: non-member and other-project member get not-found for page and every action; API-key scope refused; stubbed `can()` scope without `post:schedule` refused
- [X] T017 [P] [US1] Write `tests/integration/failures/nav.test.ts`: badge shows the ambiguous count when above zero, uses one `count(*)` and no list load
- [X] T018 [P] [US1] Write `tests/integration/scheduler/pre-call-failures.test.ts`: credential decrypt failure and content/settings load failure before the provider call fail the target (never ambiguous); a failure after a may-publish step started stays ambiguous (FR-012)

### Implementation for US1

- [X] T019 [US1] Implement `src/server/services/failures.ts` (`listFailures`, `countNeedsDecision`, `previewRequeue`, `groupAttemptRuns`) per contracts/services.md §1, with colocated unit tests for `groupAttemptRuns`
- [X] T020 [US1] Extend `resolveAmbiguous` in `src/server/services/posts/index.ts` to the input union (published with URL / not published + requeue / not published don't requeue) inside `withLockedTarget`, taking the slot through `allocateNextFree`; add `retryBlockedReason`; add the two new outcomes to the attempt writer (D2–D4, D8)
- [X] T021 [US1] Extend the post view in `src/server/services/posts/view.ts` with per-target `attemptCount` and the available actions computed from `retryBlockedReason`
- [X] T022 [US1] Classify engine failures before the provider call as non-ambiguous in `src/server/scheduler/publishing.ts` (fatal causes → `failed`, others → backoff), per contracts/services.md §4 (D22)
- [X] T023 [US1] Move `src/app/p/[projectSlug]/posts/[postId]/TargetActions.tsx` to `src/components/targets/TargetResolution.tsx` (shared dialogs: mark published with URL field, requeue with next-slot preview, don't requeue, retry) per contracts/ui.md §3; follow the `docket-ui` skill
- [X] T024 [US1] Update `src/app/p/[projectSlug]/posts/actions.ts`: `resolveTargetAction` takes the union, add `previewRequeueAction`, all through `runAction`
- [X] T025 [US1] Build `src/app/p/[projectSlug]/failures/page.tsx` and `loading.tsx`: table with rowgroup headers "Needs your decision" / "Failed", native `<details>` attempt logs rendered on the server, GET filter form (status, account) and pagination kept in the URL, empty and error states (contracts/ui.md §1)
- [X] T026 [US1] Add the Failures entry with ambiguous count to `src/components/shell/LeftNav.tsx` and pass `countNeedsDecision` from `src/app/p/[projectSlug]/layout.tsx` (FR-005)
- [X] T027 [US1] Update `src/app/p/[projectSlug]/posts/[postId]/page.tsx`: attempt count, "Who" column, `safeExternalHref` for the external link, `TargetResolution` (FR-011)
- [X] T028 [P] [US1] Write `tests/integration/failures/ui.test.tsx` per contracts/ui.md §6: labelled controls, keyboard-operable `<details>`/dialogs, focus management, live-region result text, four states (FR-013)
- [X] T029 [US1] Run `pnpm vitest run tests/integration/failures tests/integration/posts tests/integration/scheduler tests/integration/actions-authz.test.ts`, then `pnpm tsc --noEmit`, and fix until green

**Checkpoint**: US1 is independently usable and tested.

---

## Phase 4: User Story 2 — Platform limits are enforced before any platform call (P1)

**Goal**: every limit in a written inventory has a passing test proving zero platform requests.
**Independent test**: `pnpm vitest run tests/integration/limits tests/integration/docs/limits-inventory.test.ts`.

- [x] T030 [US2] Run the publish-time validation (G15) on the first step in `src/server/scheduler/publishing.ts` via `validateResolvedContent` before credentials are read; on failure append `fatal_error` on step `engine-validate` and fail the target with `Can't publish to <platform>: <message>`; log G15 in `docs/decisions.md`
- [x] T031 [P] [US2] Declare Bluesky's two approximate publish limits as an array in `src/providers/bluesky/index.ts` / `settings.ts` and fix the BlobRef doc comment, marking the values approximate per research F16/U3
- [x] T032 [US2] Audit every shipped provider's declared limits (text length and counting, media count/carousel minimum, bytes, formats, dimensions/aspect, alt text, media-required, publish rate, login rate) against `docs/research/` and record gaps and NEEDS RESEARCH items (U2, U3) in a scratch list inside `docs/limits.md`
- [x] T033 [US2] Write `docs/limits.md`: one table per provider with value, source (research file or "interim, UNVERIFIED" + decision number), enforcement point, proving test (FR-014, FR-018); no entry may be "unenforced"
- [x] T034 [US2] Write `tests/integration/limits/enforcement.test.ts`: table-driven, one row per inventory entry, fetch spy that fails on any platform host call, asserts both the scheduling-time rejection and the publish-time `failed`/deferral outcome with no attempt counted for rate limits (D14, D15); include the Bluesky "publish does not create a session" test (FR-019)
- [x] T035 [US2] Write `tests/integration/docs/limits-inventory.test.ts`: every inventory row names an existing test file and matches `providerPublishLimits`/capabilities (D13)
- [x] T036 [US2] Fix any enforcement gap the new tests expose, in the shared validation path or the engine (not in provider folders unless declaring limits), and re-run `pnpm vitest run tests/integration/limits tests/integration/docs/limits-inventory.test.ts src/providers`

**Checkpoint**: US2 complete.

---

## Phase 5: User Story 3 — Secrets never leak (P1)

**Goal**: CSRF, headers, tick refusal, body bounds, outbound policy and audit guard hardened; an end-to-end scan proves no secret reaches an output.
**Independent test**: `pnpm vitest run tests/integration/security tests/integration/webhooks tests/integration/tick-endpoint.test.ts tests/integration/docs/security-findings.test.ts`.

### Tests first

- [x] T037 [P] [US3] Write `tests/integration/security/csrf.test.ts`: cross-origin and missing-Origin-with-session requests are refused with no effect for each surface type — server action, session route handler, auth endpoint (SC-006)
- [x] T038 [P] [US3] Write `tests/integration/security/headers.test.ts`: nosniff, frame refusal, referrer policy (signup stays `no-referrer`), CSP with nonce on a page, an API response and the health endpoint; HSTS only when the public URL is https
- [x] T039 [P] [US3] Extend `tests/integration/tick-endpoint.test.ts`: missing secret, wrong secret, secret in query string, no secret configured — all the identical response; presented value never logged
- [x] T040 [P] [US3] Write `src/server/http/body.test.ts` and `tests/integration/security/body-limit.test.ts`: a chunked body without length is rejected as soon as it crosses the limit without buffering the rest
- [x] T041 [P] [US3] Extend `src/server/net/safe-fetch.test.ts` for 6to4, Teredo, documentation ranges and IPv4-mapped refused addresses, plus connection-time (lookup) checking; write `tests/integration/webhooks/destination.test.ts` for save-time and delivery-time refusal (loopback, link-local, unspecified; `http` and private ranges still allowed) and the `address_not_allowed` error
- [x] T042 [P] [US3] Write a test in the DAL tests that every audit write path refuses secret-looking detail keys (token, url, password, secret) (FR-027)
- [x] T043 [P] [US3] Write `tests/integration/security/cookies.test.ts` for session cookie attributes and sign-in rate limiting, recording results for the findings record

### Implementation

- [x] T044 [P] [US3] Add pure `src/lib/http/same-origin.ts` (+ test) and `src/lib/http/security-headers.ts` (+ test) per contracts/http-security.md §1–§2
- [x] T045 [US3] Wire the same-origin guard, per-request CSP nonce and HSTS into `src/proxy.ts`; add static headers to `next.config.ts` with the signup `Referrer-Policy` rule last; make `src/app/layout.tsx` async with `await connection()` (D16, D17); read the Next CSP and proxy docs first
- [x] T046 [P] [US3] Make the tick endpoint give one identical refusal with constant-time comparison in `src/server/scheduler/http.ts` (and its route); log the 404→401 change in `docs/decisions.md` (D18)
- [x] T047 [P] [US3] Implement `readBodyWithin` in `src/server/http/body.ts` and use it in `src/server/api/handle.ts` and `src/app/p/[projectSlug]/compose/check/route.ts` (D19)
- [x] T048 [US3] Extend `src/server/net/safe-fetch.ts`: extra refused ranges, mapped/compat IPv4, lookup-guarded `postGuarded`, new `webhook` policy; use it in `src/server/services/webhooks/deliver.ts`; add the save-time destination check in `src/server/services/webhooks/endpoints.ts` and `src/lib/validation/api.ts` (D20)
- [x] T049 [US3] Move the secret-key guard into `src/server/dal/audit.ts` insert and make `src/server/services/audit.ts` delegate to it (D21)
- [x] T050 [US3] Write `tests/integration/security/secret-scan.test.ts` per D23 and contracts/http-security.md §6: distinctive fake values for every secret, capture logs (web and worker), responses (body and headers), rendered pages, attempt logs, audit rows, webhook payloads, scan for raw/base64/URL-encoded forms, assert the one-time display separately, and include a self-check that deliberately logs a secret and expects the scan to fail (SC-005)
- [x] T051 [US3] Fix any leak the scan or the CSRF/headers tests expose
- [x] T052 [US3] Write `docs/security.md`: findings table (area, what was checked, finding, severity, fix or accepted reason, test) covering every area in FR-028, and `tests/integration/docs/security-findings.test.ts` asserting each row names an existing test and none is left open without a reason (SC-011)
- [x] T053 [US3] Run `pnpm vitest run tests/integration/security tests/integration/webhooks tests/integration/tick-endpoint.test.ts tests/integration/docs/security-findings.test.ts src/lib/http src/server` and `pnpm tsc --noEmit`

**Checkpoint**: US3 complete.

---

## Phase 6: User Story 4 — Configure and start with confidence (P2)

**Goal**: one validator before migrations in every entry point; `.env.example` complete and checked.
**Independent test**: `pnpm vitest run tests/lint/env-coverage.test.ts tests/startup src/server/startup src/server/env.test.ts`.

- [x] T054 [P] [US4] Write `src/server/startup/validate.test.ts`: missing required variable, malformed value, partly-set optional group — all problems listed at once by name and reason with no secret values; wholly absent optional group disables the feature with one log line (FR-031, FR-032)
- [x] T055 [P] [US4] Write `tests/startup/prestart.test.ts`: validation runs before migrate and exit happens without migrating; and a test for `DATABASE_URL_DIRECT=""` falling back (empty means unset, FR-033)
- [x] T056 [US4] Extend `src/server/env.ts` (NODE_ENV, PORT, HOSTNAME, `ENV_VARIABLES`, `directUrlOf`) and `src/server/llm/config.ts` (`llmEnvIssues`, `LLM_VARIABLES`); create `src/server/config-registry.ts` with `INTERNAL_VARIABLES` and `COMPOSE_ONLY_VARIABLES` (D25, D26)
- [x] T057 [US4] Implement `validateConfiguration` in `src/server/startup/validate.ts` and make `runStartup` (`src/server/startup/index.ts`), `src/worker.ts` and `scripts/prestart.mjs` use it before any migration; add `--external:sharp` to `build:prestart` in `package.json`; log the reversal of 007 change 6 in `docs/decisions.md`
- [x] T058 [P] [US4] Switch `drizzle.config.ts` and `tests/setup/global-setup.ts` to `||` for empty-means-unset (D28)
- [x] T059 [US4] Write `tests/lint/env-coverage.test.ts`: static scan of `src/**`, `scripts/**`, `drizzle.config.ts`, `next.config.ts`, `docker-compose.yml` for every variable read; fail if missing from `.env.example` or the validator/registry; also fail on real-looking secrets in `.env.example` (D27, SC-007)
- [x] T060 [US4] Rewrite `.env.example` per contracts/docs-and-config.md §1: grouped by feature, each variable with description, required/optional, default and safe example
- [x] T061 [US4] Run `pnpm vitest run tests/lint tests/startup src/server/startup src/server/env.test.ts src/server/llm` and `pnpm tsc --noEmit`

**Checkpoint**: US4 complete.

---

## Phase 7: User Story 5 — Deploy on my own hardware, following honest docs (P2)

**Goal**: a smoke script and docs that cover local Compose, Unraid, container host + Neon, Render and Netlify.
**Independent test**: `pnpm build:smoke` succeeds and its bundle imports no `next/*`; the doc content tests pass; the Compose run is recorded or reported as not verified.

- [X] T062 [US5] Write `scripts/smoke.ts` per contracts/services.md §9 (sign up the first user, create a project, connect a mock account, publish now, wait for the worker, check the last-tick indicator) and add `build:smoke` to `package.json`; ensure the existing lint test that forbids `next/*` in worker bundles covers it
- [X] T063 [US5] Edit `docker-compose.yml` per D31 and contracts/docs-and-config.md §2: bind web to `127.0.0.1` by default, pass the mock-provider switch through, make the production default of the mock provider explicit (FR-038)
- [X] T064 [US5] Write `docs/deployment.md` per contracts/docs-and-config.md §3: local Compose; Unraid (generic steps, UI specifics marked unverified, U1); container host + Neon (pooled vs direct, second service or external cron with secret, in-process worker); Render free-tier trade-offs; scheduler health and stale-tick warning; backup/restore commands (D30); reverse proxy settings (FR-036); Netlify unsupported
- [X] T065 [US5] Add a docs test (`tests/integration/docs/deployment.test.ts`) asserting `docs/deployment.md` mentions every `docker-compose.yml` service, the tick endpoint path, the encryption-key backup warning and "Netlify", and that every `pnpm` script it cites exists in `package.json`
- [X] T066 [US5] Run `pnpm build:smoke` and `pnpm vitest run tests/integration/docs tests/lint`
- [X] T067 [US5] If `docker info` succeeds in the implementation environment, run quickstart §7 from a clean clone (`git clone` into `$TMPDIR`), the backup and restore steps, and record exact commands, observed results and the date in the "Verified run" section of `docs/deployment.md`; if Docker is unavailable, write "NOT VERIFIED — Docker unavailable where this was implemented" there instead (FR-037, never claim a run that did not happen)
- [ ] T068 [US5] 🛑 BLOCKED: needs a machine with Docker and a human (or a Docker-capable CI runner) — ONE survey run of quickstart §7 and §6 on a clean checkout: `docker compose up`, smoke script, backup and restore, and a browser CSP-console check of the shipped screens (U5, U6); report every finding in one pass and record the dated result in `docs/deployment.md`. Complete only if T067 could not run it

**Checkpoint**: US5 complete or honestly reported.

---

## Phase 8: User Story 6 — Understand and extend from the docs (P3)

**Goal**: README and provider guide match the code, with a test guarding the guide.
**Independent test**: `pnpm vitest run tests/integration/docs/provider-guide.test.ts`.

- [ ] T069 [US6] Write `tests/integration/docs/provider-guide.test.ts`: parse `src/providers/types.ts` with the installed `typescript` compiler API and fail if any provider-contract member (including G1–G14) is not mentioned in `docs/adding-a-provider.md`, or if a 004 F5 contradiction returns (D33)
- [ ] T070 [US6] Refresh `docs/adding-a-provider.md` per contracts/docs-and-config.md §7: every required/optional member, capabilities and counting, connect strategies, step machine and results, limits with a pointer to `docs/limits.md`, refresh and `needs_reauth` (006 F7 note), no-secrets rule, mocked-HTTP testing, worked examples; resolve every 004 F5 contradiction
- [ ] T071 [US6] Rewrite `README.md` in FR-039 order (features, quick start, configuration, architecture overview, links to docs, adding a provider, testing and contributing); link to `docs/deployment.md` instead of duplicating; every command and path must exist (D34)
- [ ] T072 [US6] Add a README check to the docs tests: every relative link and every `pnpm` script it mentions resolves; run `pnpm vitest run tests/integration/docs`
- [ ] T073 [US6] Complete the "010 — Hardening" section of `docs/decisions.md` with every decision, G14/G15 and judgement call made during the build (FR-041)

---

## Phase 9: Polish and final gate

- [ ] T074 Confirm no runtime or dev dependency was added: `git diff main -- package.json` shows only script changes (FR-042)
- [ ] T075 Run the final gate once (quickstart §8): `pnpm tsc --noEmit`, `pnpm lint`, `pnpm db:check`, `pnpm vitest run`, `pnpm build` and `pnpm build:smoke`; fix anything red and record the results in `docs/decisions.md`

---

## Dependencies and execution order

- Phase 1 → Phase 2 → user stories → Phase 9.
- US1 depends on T003–T008. US2 depends on T007, T008 (T030 builds on the same engine file as T022: do T022 first). US3 and US4 depend only on Phase 2; T045 and T057 touch different files and may run in parallel. US5 depends on US4 (the validator and `.env.example`) and on T062 before T067. US6 depends on US2 (limits doc) and US4 for accurate configuration text.
- Within a story, tests are written first and must fail before implementation.
- `src/server/scheduler/publishing.ts` is touched by T022, T030: serialise them.
- `docs/decisions.md` is touched throughout: append only.

## Parallel examples

- Phase 2: T005, T006, T007 together after T004.
- US1 tests T010–T018 together; then T019 → T020 → T021; T023 and T028 in parallel with T022.
- US3 tests T037–T043 together; T044, T046, T047 together.
- US4: T054, T055, T058 together.

## Implementation strategy

- **MVP**: Phase 1, Phase 2, US1 (failures view). It delivers the owner's most urgent need and is demonstrable with the mock provider.
- **Then**: US2 and US3 (both P1, mostly independent), US4, US5, US6.
- **Honesty rule**: anything needing Docker or a browser that the headless run cannot do stays marked `🛑 BLOCKED` or "NOT VERIFIED"; never tick it on assumption.
