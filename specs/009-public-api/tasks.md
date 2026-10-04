---

description: "Task list for Public API, API keys, idempotency, webhooks and OpenAPI"
---

# Tasks: Public API, API keys, idempotency, webhooks and OpenAPI

**Input**: Design documents from `/specs/009-public-api/` (plan.md, spec.md, research.md, data-model.md, contracts/{http-api,services,webhooks,ui}.md, quickstart.md)

**Prerequisites**: plan.md, spec.md. Read `node_modules/next/dist/docs/01-app/` before writing route handlers or pages (AGENTS.md). Use the `docket-ui` skill for any screen.

**Tests**: REQUIRED. The spec (FR-046–FR-048) and the constitution's quality bar demand them. Tests run with Vitest against real Postgres (`export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test`), call the route module directly with `Request` objects, use local `node:http` receivers, the fake LLM and the mock provider. No live network, no browser, no dev server, no `curl`. Every verification below is a `pnpm vitest run …`, `pnpm tsc --noEmit`, `pnpm lint` or `pnpm db:check` command.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 API keys · US2 idempotency · US3 n8n flow · US4 posts/queue/jobs endpoints · US5 webhooks · US6 OpenAPI
- Contract details live in `specs/009-public-api/contracts/*.md`; task text cites the file, it does not repeat it.

---

## Phase 1: Setup

- [X] T001 Read `specs/009-public-api/{research,data-model}.md` and `contracts/*.md`; confirm baseline is green by running `pnpm tsc --noEmit && pnpm vitest run` and record any pre-existing failures in the implement notes (no file change)
- [X] T002 [P] Add `tests/helpers/api.ts` with `createKey(scope, permissions, opts)`, `api(method, path, {key, body, headers, idem})` (calls the route module with a `Request`) and `world()` (two projects, each with account+slots, image, post with targets, job with items, keys), per quickstart header
- [X] T003 [P] Add `tests/helpers/webhook-receiver.ts` (local `node:http` receiver with scriptable statuses and recorded requests) and `tests/helpers/image-server.ts` (local image server with redirect chains, slow and oversize modes)

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: schema, repos, scope actor, errors, access statements, pipeline skeleton.

- [X] T004 Add `src/server/db/schema/api.ts` (`api_keys`, `api_idempotency_keys`) and `src/server/db/schema/webhooks.ts` (`webhook_endpoints`, `webhook_events`, `webhook_deliveries`, `webhook_delivery_attempts`) with enums, indexes and unique constraints per data-model.md; export from `src/server/db/schema/index.ts`
- [X] T005 Add attribution columns `created_by_api_key_id` to `posts`, `media_assets`, `generation_jobs`; `cancelled_by_api_key_id`, `open`, `closed_at` and the relaxed item-count check on `generation_jobs`; new `membership_action` audit enum values, in `src/server/db/schema/{posts,media,jobs,audit}.ts`
- [X] T006 Register the six new tables in `src/server/db/project-owned.ts`; generate migration `drizzle/0006_*.sql` with `pnpm db:generate`; verify with `pnpm db:check` ("Migrations are current")
- [X] T007 Add access statements `api_key: ["manage"]` and `webhook: ["manage"]` (owner, admin) in `src/server/auth/access.ts`
- [X] T008 [P] Add new DAL error types (e.g. job closed, media reserved, item limit, key invalid) in `src/server/dal/errors.ts` and export via `src/server/dal/index.ts`
- [X] T009 Implement `src/server/dal/api-keys.ts`: `generateKey` (`dkt_` prefix, high entropy), sha256 hash, repo (create, list, revoke, lookup by hash wrapped in `crossProject` with a reason, rate-limit atomic UPDATE, last_used throttled to once a minute), and `forApiKey` building a `ProjectScope` per contracts/services.md
- [X] T010 Extend `src/server/dal/scope.ts`: `ProjectScope.actor`, `can()` derived from key permissions, key-still-valid re-check inside `transaction()`, `actorColumns()` for attribution; keep existing user behaviour unchanged. Run `pnpm vitest run` on existing DAL/scope tests to confirm still green
- [X] T011 [P] Implement `src/server/dal/idempotency.ts` (claim under unique index, complete, release, takeover of expired hold, purge) per contracts/services.md
- [X] T012 [P] Implement `src/server/dal/webhooks.ts` (endpoints, events, deliveries, attempts, claim with `SKIP LOCKED`, recovery) per contracts/webhooks.md
- [X] T013 Write attribution at create sites: `createdByApiKeyId` in `src/server/services/posts/index.ts` (`createDraft` forces origin `api` for key actors), `src/server/services/media.ts`, `src/server/services/jobs/create.ts`, `src/server/services/generation/save.ts`
- [X] T014 [P] Add `src/lib/validation/api.ts` (key, webhook, idempotency, upcoming-slot schemas) and `src/lib/api/schemas.ts` (output schemas: Account, Media, Post, Target, TargetValidation, TargetResult, Occurrence, JobSummary, Job, JobItem, Error), registered as OpenAPI components
- [X] T015 [P] Add shared presenters `src/server/services/views/{post,job,media,account}.ts` used by both API responses and webhook event bodies
- [X] T016 Verify foundation: `pnpm tsc --noEmit && pnpm db:check && pnpm vitest run tests/integration` (existing suites stay green)

**Checkpoint**: schema, repos and scope actor in place.

---

## Phase 3: User Story 1 — Scoped API key, called with it (P1) 🎯 MVP

**Goal**: owners/admins create and revoke keys; the key authenticates, is permission-checked, rate-limited, and project-scoped.

**Independent Test**: `pnpm vitest run tests/integration/api-keys tests/integration/api/pipeline.test.ts tests/integration/api/rate-limit.test.ts tests/integration/api/errors.test.ts`

### Tests (US1)

- [X] T017 [P] [US1] `tests/integration/api-keys/show-once.test.ts`: create response secret authenticates; list/detail/page/audit hold only prefix+last4; scan of every text/jsonb column and captured console finds plaintext 0 times, `key_hash` = sha256 once (FR-006, SC-005)
- [X] T018 [P] [US1] `tests/integration/api-keys/revoke.test.ts`: next request after revoke → 401; second revoke `{revoked:false}`; 20 parallel revokes → one audit row; in-flight request revoked before commit commits nothing (SC-004)
- [X] T019 [P] [US1] `tests/integration/api-keys/{expiry,cap,creator-left}.test.ts`: expiry 401 but still listed "expired"; 25-key cap incl. two concurrent creates at 24 → one success; editor refused; creator removed → key works, "(no longer a member)"
- [X] T020 [P] [US1] `tests/integration/api/pipeline.test.ts`: missing/malformed/unknown key 401 with `WWW-Authenticate`; cookie alone 401; differing Bearer vs `X-API-Key` 401; unknown path 404; wrong method 405 with `Allow`; 415, `invalid_json`, 413; `X-Request-Id` on every response
- [X] T021 [P] [US1] `tests/integration/api/rate-limit.test.ts`: limit 3 → 4th is 429 with `Retry-After` 1–60; next minute (DB clock) 200; 50 parallel at limit 10 → exactly 10 non-429; `last_used_at` at most once a minute
- [X] T022 [P] [US1] `tests/integration/api/errors.test.ts`: every error response matches the `Error` schema, code from the documented list, no stack/SQL/key

### Implementation (US1)

- [X] T023 [US1] Implement `src/server/services/api-keys.ts` (`createApiKey`, `listApiKeys`, `revokeApiKey`, 25 active-key cap, audit rows without the key, owner/admin only) per contracts/services.md
- [X] T024 [US1] Implement pipeline pieces in `src/server/api/{auth,errors,respond,pagination,handle}.ts`: key extraction, permission check, per-key rate limit, request id, error mapping to the shared shape, body limits and content-type checks, cursor pagination
- [X] T025 [US1] Implement `src/server/api/router.ts` and `src/server/api/operations/index.ts` (the single operation table type with permission, idem flag, resourceParams, input/output schemas) plus `src/server/api/operations/accounts.ts` (`listAccounts`, FR-026) and the catch-all `src/app/api/v1/[[...path]]/route.ts` exporting GET/POST/PUT/PATCH/DELETE
- [X] T026 [US1] Add `/api/v1/` to the public prefixes in `src/lib/auth-gate.ts` and extend its test `src/lib/auth-gate.test.ts`
- [X] T027 [US1] Settings UI for API keys per contracts/ui.md and `docket-ui`: `src/app/p/[projectSlug]/settings/api-keys/{page.tsx,loading.tsx,actions.ts,CreateKeyForm.tsx,RevokeKeyDialog.tsx}`, `src/components/ui/ShowOnceDialog.tsx`; add owner/admin-only link in `src/app/p/[projectSlug]/settings/layout.tsx`; audit labels in `src/app/p/[projectSlug]/settings/members/activity-list.tsx`
- [X] T028 [US1] `tests/integration/api-keys/ui.test.tsx` (component/render test: four states, show-once dialog, revoke confirm names the key, editor not offered) and add rows to `tests/integration/actions-authz.test.ts`
- [X] T029 [US1] Run the US1 tests listed above and `pnpm tsc --noEmit`; fix failures

**Checkpoint**: keys work end to end; `GET /api/v1/accounts` callable.

---

## Phase 4: User Story 2 — Retried writes never duplicate (P1)

**Goal**: `Idempotency-Key` on every write: replay, 422 conflict, 409 in progress, single effect under concurrency.

**Independent Test**: `pnpm vitest run tests/integration/api/idempotency.test.ts tests/integration/api/idempotency-generate.test.ts`

- [x] T030 [US2] Implement `src/server/api/idempotency.ts`: canonical JSON body hash (multipart: file bytes + canonical text fields), claim-first, effect+result in one transaction, takeover after hold expiry (`max(300 s, 2×LLM_TIMEOUT_SECONDS+120 s)`), 5xx not stored, early refusals store nothing, `Idempotent-Replayed`, 7-day retention; wire into `handle.ts` (research D8–D10)
- [x] T031 [US2] Add the `generate` mode: effect linked to the key through 007's unique `generation_request_id`, result stored right after; takeover returns the same post with 200 and no second model call
- [x] T032 [US2] Add idempotency purge to the housekeeping path (cross-project, with reason) in `src/server/scheduler/` and a test line in the existing scheduler housekeeping test
- [x] T033 [P] [US2] `tests/integration/api/idempotency.test.ts`: replay (incl. key order), 422 conflict, 20 parallel ×5 → exactly 1 post and others replay/409 with `Retry-After`, scoping per key/route, forced-500 rollback, expired hold takeover, lost hold commits nothing, early refusals store nothing (uses `POST /posts` once T036 lands; until then a test-only operation seam)
- [x] T034 [P] [US2] `tests/integration/api/idempotency-generate.test.ts`: 20 parallel identical `/generate` → 1 post and 1 fake-LLM call; kill between save and store then retry → same post, 200; refused → 422 replayed; timeout → 503 not stored

---

## Phase 5: Endpoints — media, posts, generate, slots (serves US3 and US4, P1/P2)

**Goal**: the minimum endpoint set over existing services. Depends on Phases 3–4.

### Service changes

- [x] T035 [US4] Split `uploadMedia` into `prepareUpload` + `commitUpload` (behaviour unchanged) and add optional `limit`/`offset` to `listMedia` in `src/server/services/media.ts`; existing media tests stay green
- [x] T036 [P] [US4] Implement `src/server/net/safe-fetch.ts` (`node:http(s)` with validating `lookup`, `net.BlockList`, ≤3 redirects, 30 s, size cap, re-validation per redirect) with `src/server/net/safe-fetch.test.ts`
- [x] T037 [US4] Implement `src/server/services/media-from-url.ts` (`registerMediaFromUrl`, `fetchForUpload`) using safe-fetch and the upload pipeline
- [x] T038 [P] [US4] Export `prepareForScheduling` and add `listUpcomingOccurrences` in `src/server/services/queue/index.ts` plus `targets.heldOccurrences` in `src/server/dal/targets.ts`

### Operations

- [x] T039 [US4] Operations `listMedia`, `getMedia`, `uploadMedia` (multipart), `registerMediaFromUrl` in `src/server/api/operations/media.ts`
- [x] T040 [US4] Operations `createPost`, `getPost`, `getPostTarget`, `queuePost`, `schedulePost` in `src/server/api/operations/posts.ts` (RFC 3339 with offset; per-target `TargetResult`)
- [x] T041 [US4] Operation `generatePost` in `src/server/api/operations/generate.ts` (permission `generate` + `auto_approve`; `confirmation_required`; `generation_failed` 422 / `generation_unavailable` 503 mapping)
- [x] T042 [US4] Operation `listUpcomingSlots` in `src/server/api/operations/slots.ts` (default 14 days, max 60)

### Tests

- [x] T043 [P] [US4] `tests/integration/api/endpoints/media.test.ts` per quickstart §4 (upload, from-url, redirects 3 ok/4 refused, private/metadata/`[::1]` blocked under production policy, `file:`/credentials, 413, 415, `url_timeout`, 503, `unused=true`)
- [x] T044 [P] [US4] `tests/integration/api/endpoints/posts.test.ts` (origin `api`, creator = key, validation per target, queue/`not_queueable`/`no_active_slots`, schedule `+02:00`/`in_past`/warnings, no tokens in shapes)
- [x] T045 [P] [US4] `tests/integration/api/endpoints/generate.test.ts` (fake LLM origin `generated`; `auto_approve` permission rules; `confirmation_required`; 503 no LLM)
- [x] T046 [P] [US4] `tests/integration/api/endpoints/slots-accounts.test.ts` (free/taken in UTC+local, 61 days → 400, accounts list has capabilities and no credentials)
- [x] T047 [US4] `tests/integration/api/scope-enforcement.test.ts` driven by the operation table (FR-048): no key 401; key missing the permission 403 naming it; key with it not 401/403; other-project id → 404 identical to a random uuid; fails if an operation lacks fixtures. Re-run after T062 adds job operations

---

## Phase 6: User Story 3 — Reproduce the old n8n flow (P1)

**Goal**: documented loop (from-url → generate → queue) re-runs without duplicates.

**Independent Test**: `pnpm vitest run tests/integration/docs/n8n-flow.test.ts`

- [x] T048 [US3] Write `docs/n8n.md`: key creation and permissions, n8n credential, the worked three-step flow as fenced `http` blocks with `{{template}}` variables and row-derived idempotency keys, retry settings, handling 409/422/429, optional `post.published` webhook trigger, "Verifying webhook signatures" (recipe, 5-minute tolerance, constant-time compare, Node snippet), link to `/api/v1/openapi.json`; link it from `README.md`
- [x] T049 [US3] `tests/integration/docs/n8n-flow.test.ts`: parse the `http` blocks from `docs/n8n.md`, fill three rows, run the sequence twice with mock provider + fake LLM; assert 3 media, 3 posts, 3 queued targets per account each in its own slot, second run all replays, 0 duplicates (SC-001)
- [ ] T050 [US3] 🛑 BLOCKED: needs the owner's real n8n instance and a deployed Docket — run the documented flow once live and a first call within 2 minutes (SC-010, quickstart §9); owed by the owner

---

## Phase 7: User Story 4 — Posts, queue and generation jobs over HTTP (P2)

**Goal**: API-submitted job items via open jobs.

**Independent Test**: `pnpm vitest run tests/integration/api/endpoints/jobs.test.ts`

- [X] T051 [US4] Open jobs in 008 services: `open`/`closed_at` handling in `src/server/dal/jobs.ts`, `deriveJobStatus` open branch in `src/server/services/jobs/status.ts` (never completed while open), `cancelJob` closes the job, `refreshJobStatus` unchanged otherwise (research D18)
- [X] T052 [US4] Add `src/server/services/jobs/append.ts` (`appendItems`: 1–100 items, 500 cap → `job_item_limit`, all-or-nothing, reserved/deleted/foreign media refused naming items, closed job → `job_closed`) and `closeJob` in `manage.ts` (empty job → conflict), `getJobItem` in `read.ts`, optional `limit`/`offset` on `listJobs`/`listJobItems`; export from `jobs/index.ts`
- [X] T053 [US4] Add the `api` item source in `src/server/services/jobs/sources/api.ts`, register in `sources/index.ts`, add optional `PreparedSource.mediaRules` in `sources/types.ts` (default = 008 behaviour); validate ≤50 field names usable as placeholders, ≤50,000 chars per item, media as image input, reservations per 008 FR-007
- [X] T054 [US4] `createJob` accepts `source.kind: "api"` with `open` and initial items, and `media`; `csv` refused with the documented message, in `src/server/services/jobs/create.ts`
- [X] T055 [US4] Operations `listJobs`, `createJob`, `getJob`, `listJobItems`, `getJobItem`, `addJobItems`, `closeJob`, `cancelJob`, `retryFailedJobItems` in `src/server/api/operations/jobs.ts`
- [X] T056 [US4] Job page: "Open: accepting items" state and "Close job" action: `src/app/p/[projectSlug]/jobs/[jobId]/{page.tsx,CloseJobDialog.tsx}`, `src/app/p/[projectSlug]/jobs/actions.ts`
- [X] T057 [P] [US4] `tests/integration/api/endpoints/jobs.test.ts` per quickstart §4 (open job with `product`/`price`, two batches with a media id, repeat add with same idempotency key adds nothing, close, ticks with fake model → completed, post per item with right prompt values, `job_closed`, `media_reserved` naming item, 501 → `job_item_limit`, undeclared field 400, empty close 409, media `unused` source, csv refused)
- [X] T058 [P] [US4] Regression: `pnpm vitest run` on existing 008 job tests (UI and CSV/media jobs still created closed and derive as before); fix any break

---

## Phase 8: User Story 5 — Webhooks (P2)

**Goal**: signed, retried, logged outgoing events per project.

**Independent Test**: `pnpm vitest run tests/integration/webhooks src/server/services/webhooks/sign.test.ts`

- [x] T059 [P] [US5] `src/server/services/webhooks/sign.ts` (HMAC-SHA256 of `<ts>.<raw body>`, multi-`v1=` header, `timingSafeEqual` verify, 5-minute tolerance) with `sign.test.ts` (good, wrong secret, changed byte, 301 s stale, two values)
- [x] T060 [US5] `src/server/services/webhooks/{index,endpoints}.ts`: endpoint CRUD (max 10, owner/admin, audit without `url`/`secret`), secret generation shown once, stored `enc:v1` with AAD, rotation with 24 h overlap and second-rotation rule, `ping`/resend
- [x] T061 [US5] `src/server/services/webhooks/emit.ts` and hook-ins in the same transaction: `applyDerivedStatus` (published/failed/partially_failed) in `src/server/services/posts/status.ts`, `refreshJobStatus`/`cancelJob` (`job.finished`) in jobs services, account flagging; change `accounts.recordRefresh`/`markCredentialsInvalid` to return `{changed, previousStatus}` and run their four scheduler call sites in a transaction (`src/server/scheduler/{credentials,token-refresh,publishing}.ts`); widen `createSchedulingRepos` with `webhooks`
- [x] T062 [US5] `src/server/services/webhooks/deliver.ts` and `src/server/scheduler/webhooks.ts`: fourth independent `runTick()` section (≤10 deliveries, 4 concurrent, send only with 11 s budget left, claim/lease/outcome, 8 attempts with 1 min doubling to 6 h, 10 s timeout, manual redirects = failure, 410 disables `gone`, 20 failed deliveries disables `failing`, attempt log with 1,000-char redacted excerpt, 30-day purge); register in `src/server/scheduler/{index,config}.ts` with heartbeat and `TickSummary.webhooks`
- [x] T063 [US5] Settings UI per contracts/ui.md: `src/app/p/[projectSlug]/settings/webhooks/{page,loading,actions,EndpointForm,EndpointRowActions}` and `[endpointId]/{page,loading,DeliveryLog,RotateSecretDialog}`; links, empty states, show-once secret, delete confirm naming the endpoint
- [x] T064 [P] [US5] `tests/integration/webhooks/emission.test.ts` (one event+delivery per subscribed endpoint, none for unsubscribed/disabled, rollback leaves no event, job.finished on complete/cancel/retry, needs_reauth only on change)
- [x] T065 [P] [US5] `tests/integration/webhooks/delivery.test.ts` (headers/body, doc snippet verifies, 500/500/200 with 1 then 2 min spacing, 8 failures → failed, 410, 20 failed → disabled and re-enable does not resend, 3xx failure, timeout, lease recovery, two concurrent ticks never double-send)
- [x] T066 [P] [US5] `tests/integration/webhooks/outage.test.ts` (60-minute outage on DB clock, every event delivered by the 63-minute attempt, endpoint still enabled; SC-008)
- [x] T067 [P] [US5] `tests/integration/webhooks/rotation.test.ts` and `settings.test.ts` (overlap two signatures then one, second rotation drops earliest, `enc:v1:` at rest, audit has no `url`/`secret`, cap 10, editor refused, resend/test queue deliveries)

---

## Phase 9: User Story 6 — OpenAPI document (P3)

**Goal**: generated, served, validated, complete.

**Independent Test**: `pnpm vitest run tests/integration/api/openapi.test.ts`

- [x] T068 [US6] `src/server/api/openapi.ts` and `src/server/api/operations/openapi.ts`: `createDocument` (zod-openapi, 3.1.0) from the operation table; security schemes (bearer, `X-API-Key`), per-operation `x-` required permission, `Idempotency-Key` on writes, `Idempotent-Replayed`/`X-Request-Id`/`Retry-After` headers, shared Error schema with documented codes; built once per process; `GET /api/v1/openapi.json` unauthenticated, cacheable
- [x] T069 [US6] `tests/integration/api/openapi.test.ts`: all `$ref` resolve, operation ids unique, documented operations equal routes served, each op has security + permission + request schema + error responses, changing a fixture route schema changes the document
- [x] T070 [US6] (dependency installed: @seriousme/openapi-schema-validator 2.11.0 is in devDependencies) add it with `pnpm add -D @seriousme/openapi-schema-validator` and enable the full-validity assertion in `tests/integration/api/openapi.test.ts`; if the install is impossible (no network), leave the assertion skipped with that reason and say so in the final notes

---

## Phase 10: Polish & cross-cutting

- [x] T071 [P] `tests/lint/api-imports.test.ts`: fail if any file under `src/app/api/v1` or `src/server/api` imports `src/server/dal` or `src/server/db` (FR-044); confirm `pnpm lint` passes
- [x] T072 [P] Append 009 entries to `docs/decisions.md` (own hashed key table vs `@better-auth/api-key` with reasons, multipart hash, `/generate` idempotency linkage, 5xx not stored, two added error code groups, failed-delivery counting, empty-close refusal, each generic change with how to reverse) and add API + n8n links to `README.md`; add a comment to `.env.example` pointing at the constants (no new variables)
- [x] T073 Run all gates: `pnpm tsc --noEmit && pnpm lint && pnpm db:check && pnpm vitest run`; fix every failure
- [x] T074 Re-run `tests/integration/api/scope-enforcement.test.ts` and `openapi.test.ts` after all operations exist, confirming SC-003 and SC-009 (every operation covered and documented)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks everything).
- Phase 3 (US1) needs Phase 2. Phase 4 (US2) needs Phase 3's pipeline (T024/T025).
- Phase 5 needs Phases 3–4. T033's end-to-end cases need `POST /posts` (T040); until then it uses a test-only operation seam.
- Phase 6 (US3) needs T039–T041 and T048 before T049.
- Phase 7 (US4 jobs) needs Phase 5; T047 re-runs after T055.
- Phase 8 (US5) needs Phase 2 and the job/post status paths (T051–T052 for job events); the settings UI (T063) needs T060.
- Phase 9 (US6) needs all operations (T040–T042, T055).
- Phase 10 last.

## Parallel examples

- Phase 2: T008, T011, T012, T014, T015 in parallel after T004–T006.
- US1 tests T017–T022 in parallel.
- Phase 5 tests T043–T046 in parallel; T036 and T038 in parallel with T035.
- US5 tests T064–T067 and T059 in parallel.

## Implementation strategy

1. **MVP**: Phases 1–3 (keys + authenticated pipeline + `GET /accounts`).
2. Add idempotency (Phase 4), the endpoints (Phase 5) and the n8n flow (Phase 6) — the brief's acceptance example.
3. Then jobs (Phase 7), webhooks (Phase 8), OpenAPI (Phase 9), polish (Phase 10).
4. Validate each phase with its Independent Test command before moving on.

---

## Phase 11: Review remediation

From `specs/009-public-api/review.md`. No BLOCKERs; five MAJOR findings. MINOR findings F6–F12 are recorded there for later and are not tasks here.

- [ ] T075 Run the 008 rendered-instructions length check (`JOB_RENDERED_INSTRUCTIONS_MAX`, today inside `checkTemplate`) on appended items in `appendItems` before `insertItems`, refusing with `ValidationIssuesError` naming `items.<i>`; share one helper with `createJob`; add an oversized-append case (400, nothing added) to `tests/integration/api/endpoints/jobs.test.ts` — review F1 (MAJOR), src/server/services/jobs/append.ts:35-41, src/server/services/jobs/create.ts:42-60
- [ ] T076 Make `getMedia` return the asset's active job reservation (`reservedByJobId`) instead of the `toView` default `null`, and assert in `tests/integration/api/endpoints/media.test.ts` that `GET /media/{id}` of a reserved image returns its job id — review F2 (MAJOR), src/server/services/media.ts:257-264
- [ ] T077 In `buildOperation`, keep the shared `Error` schema, code list and headers (`Retry-After` on 503) for every error status an operation declares, merging only its description; give `generatePost`'s 200 the post response schema; extend `tests/integration/api/openapi.test.ts` to require `#/components/schemas/Error` on every response ≥ 400 — review F3 (MAJOR), src/server/api/openapi.ts:62
- [ ] T078 Route the `listJobs`, `listJobItems` and `getJobItem` operations through the job read services (with T052's `limit`/`offset` and `getJobItem`), mapping to `ApiJobItem` in `views/job.ts`, and remove the duplicate item reads in `views/load.ts`; no operation file may call `scope.<repo>` directly; extend `tests/lint/api-imports.test.ts` to fail on `scope.(jobs|jobItems|posts|media|accounts|targets|webhooks|apiKeys).` under `src/server/api/operations` — review F4 (MAJOR), src/server/api/operations/jobs.ts:63
- [ ] T079 Append to the 009 section of `docs/decisions.md`: the spec's "Decisions made while specifying", an interim-limits entry naming each constant and its file (rate limit 60 / 1–1,000, 25 keys, 10 endpoints, 7-day retention, hold formula, 8 MB JSON, 100/500 items, 8 attempts, 1 min→6 h backoff, 10 s timeout, 20-failure disable, 30-day log, 24 h overlap, 3 redirects / 30 s), the `url_*` error codes, and a *Reverse* line for each generic change listed in plan.md — review F5 (MAJOR), docs/decisions.md:357-370
