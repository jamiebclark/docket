---

description: "Task list for 016 — public API to retry, bulk-retry and resolve failed and ambiguous targets"
---

# Tasks: Public API to retry, bulk-retry and resolve failed and ambiguous targets

**Input**: Design documents from `/specs/016-api-retry-resolve/` (plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/services.md, quickstart.md)

**Tests**: Requested (spec FR-030, quickstart test map). Run with `pnpm vitest run <files> < /dev/null` against real Postgres (run-scoped DBs), using the mock provider and `tests/helpers/api.ts`. No browser, no network, no live calls. Run the full suite once, in the final phase.

**Format**: `[ID] [P?] [Story] Description` — [P] = different files, no dependency on an incomplete task.

**Notes for the implementer**: AGENTS.md says this Next.js has breaking changes — read the relevant guide in `node_modules/next/dist/docs/01-app/` before editing the two server pages. Every change to existing services is additive; UI callers pass no new args and must see identical behaviour (FR-003). Operations import only `ProjectScope` and services (see `tests/lint/api-imports.test.ts`). No new dependency, no new permission value, no new webhook event. Commit with explicit paths, conventional commits. The manual `pnpm dev` + curl walk-through in quickstart.md is NOT a task (no server/curl in the implement phase).

## Phase 1: Setup

- [x] T001 Add the two nullable columns to the Drizzle schema: `actorApiKeyId: uuid("actor_api_key_id")` with composite FK `publish_attempts_api_key_fk` `(project_id, actor_api_key_id) → api_keys(project_id, id)` in `src/server/db/schema/attempts.ts`; `resolvedByApiKeyId: uuid("resolved_by_api_key_id")` with FK `post_targets_resolver_api_key_fk` in `src/server/db/schema/posts.ts` (`postTargets`). Both `ON DELETE no action`. Avoid an import cycle (`api.ts` must not import `attempts.ts`). See data-model.md §1.
- [x] T002 Run `pnpm db:generate --name api_key_attribution < /dev/null` to produce `drizzle/0010_api_key_attribution.sql`, `drizzle/meta/0010_snapshot.json` and the `_journal.json` entry; then `pnpm db:check < /dev/null` must pass. Commit the generated files (depends on T001).

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ No user story work starts until this phase is complete.**

- [x] T003 [P] In `src/server/dal/errors.ts` give `ConflictError` an optional `reason` and constructor `opts?: string | { field?: string; reason?: string }` (string still means `field`). In `src/server/api/errors.ts` change `mapServiceError` so a conflict becomes `apiError("conflict", e.message, e.reason ? { reason: e.reason } : undefined)`.
- [x] T004 [P] In `src/server/dal/scope.ts` add `actorRefs(scope)` (member → membership user, no key; API key → creator user id or **null, never `""`**, plus `actor.apiKeyId`; job runner → actorUserId or null), rebuild `actorColumns` on it with unchanged values, and add `attemptActor(scope)` → `{ actorUserId, actorApiKeyId }` and `resolverColumns(scope)` → `{ resolvedByUserId, resolvedByApiKeyId }` (contracts/services.md §3). In `src/server/dal/attempts.ts` add `actorApiKeyId?: string | null` to `AttemptEntry` and write it in `insert` as `?? null`.
- [x] T005 [P] Create the pure module `src/lib/failures/attempt-actor.ts` (no server imports): `AttemptActor` union (`api_key {name: string|null}` | `member {name}` | `system`) and `attemptActorLabel(actor)` → `API key {name}` / `Removed API key` / member name / `System`. Write `src/lib/failures/attempt-actor.test.ts` covering the four labels.
- [x] T006 [P] In `src/lib/failures/retry-all-text.ts` add `retryAllMessage(r, opts?: { continueWith?: "press" | "call" })`; `"call"` replaces only the final sentence with "Call again with a new Idempotency-Key to continue."; default output unchanged. Extend `src/lib/failures/retry-all-text.test.ts` accordingly.
- [x] T007 In `src/server/services/posts/locked.ts` add `opts?: { postId?: string }` to `withLockedTarget`: after the first `tx.targets.get(id)`, a missing row or `first.postId !== opts.postId` throws `NotFoundError` — before `lockPost`, before `fn`, before any write.
- [x] T008 In `src/server/services/posts/retry.ts`: add `opts?: { postId?: string }` to `retryTarget` and pass it to `withLockedTarget` (T007); set `reason` on the existing `ConflictError` throws (`publishing`, `not_failed` for the status check and `lost()`, and the blocked key from `retryBlockedKey` for `account_removed` / `needs_reconnecting` / `provider_unavailable`; sentences unchanged); spread `...attemptActor(tx)` in place of `actorUserId: tx.membership.userId` in all 4 `attempts.insert` calls (depends on T003, T004, T007).
- [x] T009 In `src/server/services/posts/index.ts` `resolveAmbiguous`: add `opts?: { postId?: string }` passed to `withLockedTarget`; set `reason` on throws (`already_resolved` for status check and `lost()`, `cannot_publish` for the requeue gate); use `const common = { ...resolverColumns(tx), resolvedAt: now }`; spread `...attemptActor(tx)` in all 5 attempt inserts; remove the local `actor` variable (depends on T003, T004, T007).
- [x] T010 [P] In `src/server/services/failures.ts` extend `AttemptEntryView.actor` to the `AttemptActor` type (import from T005) and make `toAttemptViews` resolve distinct `actorApiKeyId` values through `scope.apiKeys.get(id)` → name (null when not found); a key always wins over the user column. Render `attemptActorLabel(...)` in `src/app/p/[projectSlug]/failures/page.tsx` (~line 94) and `src/app/p/[projectSlug]/posts/[postId]/page.tsx` (~line 197) (depends on T005).
- [x] T011 [P] Idempotency mode: in `src/server/api/operations/types.ts` make the type `idempotencyMode?: "transaction" | "generate" | "self_commit"` and add `examples?` to `ApiOperation` request body and `responses[status]` (`Record<string, { summary: string; value: unknown }>`); in `src/server/api/idempotency.ts` treat `"self_commit"` exactly like `"generate"` and update the doc comment; in `src/server/api/openapi.ts` (`buildOperation`) copy `examples` onto `content["application/json"].examples` for success and error statuses (operations without examples render exactly as today).
- [x] T012 [P] Move `toIssue` out of `src/server/api/operations/posts.ts` into new `src/server/api/operations/issues.ts` and add `toWarning(w) → { severity: "warning", code, message }`; `posts.ts` imports both. Existing `tests/integration/api` post tests must stay green.
- [x] T013 Add the six shared schemas to `src/lib/api/schemas.ts`, each with `.meta({ id })`: `RetryTargetRequest` (strict discriminated union on `mode`: `now` | `requeue {expected?}` | `at {at}`; RFC 3339 with offset), `RetryTargetResult` (scheduled 200 / not-scheduled `failed` with `reason` ∈ `no_active_slots|no_free_occurrence|in_past|validation|account_unavailable`, `message`, `issues?`), `ResolveTargetRequest` (`published {url?}` | `not_published {requeue: true, expected?}` | `not_published {requeue: false}`; `url` via `externalUrlSchema`), `ResolveTargetResult` (published | scheduled | failed with `reason`), `RetryFailedTargetsRequest` (strict `{accountId?: uuid, mode: "now"|"requeue"}`, no default), `RetryFailedTargetsResult` (`mode, retried, inScope, skipped` with all six keys, `remaining, accounts[], message`). Export `z.infer` types (`ApiRetryTargetResult`, …). Follow contracts/http-api.md exactly.
- [x] T014 Run the unchanged existing suites to prove no UI regression from T003–T012: `pnpm vitest run tests/integration/failures src/lib/failures tests/integration/api tests/lint tests/integration/scope-check.test.ts < /dev/null`, plus `pnpm typecheck < /dev/null`. Fix any regression before continuing.

**Checkpoint**: services, schema and shared shapes are ready; operations can now be built.

---

## Phase 3: User Story 1 - Automation retries a failed post (Priority: P1) 🎯 MVP

**Goal**: `POST /posts/{postId}/targets/{targetId}/retry` retries one failed target in `now`, `requeue` or `at` mode through `retryTarget`.

**Independent Test**: With a key holding `write_posts`, a failed target goes to `scheduled` for each mode; the attempt log matches the UI action.

### Tests for User Story 1

- [X] T015 [P] [US1] Create `tests/integration/api/endpoints/retry-target.test.ts` covering happy paths: `now`; `requeue` with no `expected`, with a matching `expected`, and with a differing offset-bearing `expected` (`changedFromPreview: true`); `at` in the future (200, `scheduledAt` UTC and `scheduledAtLocal`, `slotId` null); bad bodies → 400 `validation_failed` (missing mode, unknown mode, extra key, `at` without offset, non-RFC-3339 `expected`).

### Implementation for User Story 1

- [X] T016 [US1] Create `src/server/api/operations/targets.ts` exporting `targetOperations` with `retryPostTarget` (`POST /posts/{postId}/targets/{targetId}/retry`, tag `Recovery`, permission `write_posts`, `idempotent: true`, `resourceParams` for `postId` and `targetId`, request `RetryTargetRequest`): `run` makes one call `retryTarget(scope, params.targetId, body, { postId: params.postId })` and maps to `RetryTargetResult` (use `toIssue`/`toWarning` from `issues.ts` for warnings). No `prepare`. Register `targetOperations` after `postOperations` in `src/server/api/operations/index.ts`. Make T015 pass.

**Checkpoint**: US1 works alone.

---

## Phase 4: User Story 2 - Clear refusals when a retry cannot happen (Priority: P1)

**Goal**: Every non-success retry/resolve outcome is a documented non-5xx answer an automation can branch on (`status`/`reason`/`details.reason`).

**Independent Test**: Each refusal returns the documented status, writes no attempt entry (except the single `no_free_slot` entry the service already writes), and never a 500.

### Tests for User Story 2

- [x] T017 [P] [US2] Extend `tests/integration/api/endpoints/retry-target.test.ts` with: `in_past` → 200 `status: "failed"` `reason: "in_past"`; `no_free_occurrence` / `no_active_slots` → 200 with the stored `last_error` and exactly one `retry_requested` attempt; `validation` → 200 with `issues`; `account_unavailable`; 409 with `details.reason` ∈ `publishing`, `not_failed` (scheduled, published, ambiguous, cancelled targets), `account_removed`, `needs_reconnecting`, `provider_unavailable` — each asserting zero new attempt rows and the user-facing `message`; wrong post/target pairing → 404 identical to unknown id with zero writes; deleted post → 404; two concurrent retries with different keys → one 200, one 409 `not_failed`.

### Implementation for User Story 2

- [x] T018 [US2] Fix whatever T017 exposes in `src/server/api/operations/targets.ts` / `src/server/api/errors.ts` (result-to-body mapping, 409 `details.reason`, no leakage of internal detail). Add `examples` for 200 (each alternative), 400, 401, 403, 404, 409, 422, 429 to `retryPostTarget`, using T011's `examples` field, with a 409 description that lists every reason.

---

## Phase 5: User Story 3 - Resolve an ambiguous publish (Priority: P2)

**Goal**: `POST /posts/{postId}/targets/{targetId}/resolve` resolves an `ambiguous` target through `resolveAmbiguous`.

**Independent Test**: An ambiguous target resolves as published, not-requeued, or requeued, with attempt entries matching the UI.

### Tests for User Story 3

- [ ] T019 [P] [US3] Create `tests/integration/api/endpoints/resolve-target.test.ts` covering: `published` with and without `url` (+ `post.published` event when the post becomes published); `not_published` `requeue: false` → `status: "failed"` `reason: "not_requeued"`; `requeue: true` → scheduled with `resolved_not_published` then `requeued` entries, and `changedFromPreview` against an offset `expected` (normalised to UTC); no slot → `no_free_slot` (200, target `failed`); gate refused → 409 `cannot_publish`, target still `ambiguous`; failed target → 409 `already_resolved`; bad `url` → 400 at `path: "url"`; `{outcome:"failed"}` → 400; pairing mismatch → 404.

### Implementation for User Story 3

- [ ] T020 [US3] Add `resolvePostTarget` (`POST /posts/{postId}/targets/{targetId}/resolve`, tag `Recovery`, `write_posts`, `idempotent: true`, `resourceParams`) to `src/server/api/operations/targets.ts`: one call `resolveAmbiguous(scope, params.targetId, normalised(body), { postId: params.postId })`, with resolve `expected` normalised to UTC before the call (research P9) and the result mapped to `ResolveTargetResult`. Add the same examples set (200 alternatives/400/401/403/404/409/422/429) as T018. Make T019 pass.

---

## Phase 6: User Story 4 - Retry everything that failed (Priority: P2)

**Goal**: `POST /targets/retry-failed` bulk-retries all failed targets (optionally one account) through `retryAllFailed`, with no wrapper transaction.

**Independent Test**: Counts add up (`retried + Σ skipped + remaining = inScope`); unknown/foreign `accountId` is an identical "nothing to retry" 200.

### Tests for User Story 4

- [ ] T021 [P] [US4] Create `tests/integration/api/endpoints/retry-failed-targets.test.ts` covering: counts add up; all six skip keys present (zeros included); `accountId` filter; unknown and foreign `accountId` give identical 200s with `inScope: 0`; `requeue` exhausting an account → `no_free_slot` with earlier failures getting earlier slots; more than 100 eligible → `remaining > 0` and `message` containing "Call again with a new Idempotency-Key"; `targetIds` key, extra key, missing/invalid mode → 400.

### Implementation for User Story 4

- [ ] T022 [US4] Add `retryFailedTargets` (`POST /targets/retry-failed`, tag `Recovery`, `write_posts`, `idempotent: true`, `idempotencyMode: "self_commit"`) to `src/server/api/operations/targets.ts`: one call `retryAllFailed(scope, { ...(body.accountId ? { account: body.accountId } : {}), mode: body.mode })`, map `count → retried`, rebuild `message` with `retryAllMessage(..., { continueWith: "call" })` (T006). No wrapper transaction (FR-014). Add examples as in T018. Make T021 pass.

---

## Phase 7: User Story 5 - Replays never act twice (Priority: P1)

**Goal**: Same `Idempotency-Key` + same body = one effect; replay returns the stored answer.

**Independent Test**: Per operation, a replay leaves attempt count, target row and webhook event count unchanged.

### Tests for User Story 5

- [ ] T023 [P] [US5] Create `tests/integration/api/endpoints/recovery-idempotency.test.ts`, per operation: replay of a 200 and of a stored 409 returns the same body with `Idempotent-Replayed: true`, with unchanged attempt count, target row and webhook event count; same key + different body → 422; in-progress claim → 409 with `Retry-After` (hold the claim as `tests/integration/api/idempotency.test.ts` does); a new key after success → 409 `not_failed`; bulk with the same key after `remaining > 0` replays with no new retries, and a new key continues.

### Implementation for User Story 5

- [ ] T024 [US5] Fix whatever T023 exposes in `src/server/api/idempotency.ts` / `operations/targets.ts` (single retry and resolve use the default `transaction` mode so effect, webhook rows and stored answer commit together; bulk uses `self_commit`). Confirm no `Idempotency-Key` value appears in any stored response or attempt summary.

---

## Phase 8: User Story 6 - Attribution and project isolation (Priority: P1)

**Goal**: Members see "API key {name}" in attempt logs; keys only reach their own project and need `write_posts`.

**Independent Test**: An API action writes the key columns and the creator's user id (or null); another project's ids give 404; a `read` key gets 403.

### Tests for User Story 6

- [ ] T025 [P] [US6] Create `tests/integration/api/endpoints/recovery-attribution.test.ts`: API retry/resolve writes `actor_api_key_id` / `resolved_by_api_key_id` plus the creator's user id; creator left the project → 200 with user id kept; creator's user row deleted → 200 with user id null (F12 regression: no 500, never `""`); the view reads "API key {name}" before and after revoke and after expiry; a member-scope (UI) action writes no key; side-by-side API vs member-service runs give equal target rows and attempt entries (ignoring ids, timestamps, attribution) and the same webhook event types (SC-005).
- [ ] T026 [P] [US6] Extend `tests/integration/api/scope-enforcement.test.ts` with `FIXTURES` for `retryPostTarget`, `resolvePostTarget` and `retryFailedTargets`: `read` key → 403 `missing_permission` naming `write_posts`, nothing written; foreign `postId`/`targetId` → 404 identical to unknown.
- [ ] T027 [P] [US6] Extend `tests/integration/failures/attempts.test.ts`: a key entry → `actor.kind === "api_key"` with its name; a stub `apiKeys.get` returning null → name null; member and system entries unchanged.

### Implementation for User Story 6

- [ ] T028 [US6] Fix whatever T025–T027 expose in `src/server/dal/scope.ts`, `src/server/services/failures.ts` and the operations (e.g. `resourceParams` declarations in `targets.ts`). Run `pnpm vitest run tests/integration/api tests/integration/failures < /dev/null` until green.

---

## Phase 9: User Story 7 - Documented recipe, OpenAPI and secrets (Priority: P3)

**Goal**: A builder can follow the docs end to end; the OpenAPI document describes everything with examples; no secret leaks.

**Independent Test**: OpenAPI test and secret-scan test pass; docs contain the recipe.

### Tests for User Story 7

- [ ] T029 [P] [US7] Extend `tests/integration/api/openapi.test.ts`: the three operations exist under tag `Recovery` with request schemas and examples, examples on 200/400/401/403/404/409/422/429, the 409 description lists every reason, all `$ref`s resolve and the document still validates.
- [ ] T030 [P] [US7] Extend `tests/integration/security/secret-scan.test.ts`: call all three operations with a key and an `Idempotency-Key`, then scan the response bodies, the `publish_attempts` rows written and the rendered Failures-page attempt log for the raw key, its hash, its `last4`, the idempotency key value and any env secret.

### Implementation for User Story 7

- [ ] T031 [P] [US7] Add a "7. Recover failed posts" recipe to `docs/n8n.md` (subscribe to `post.failed`, verify signature, `GET /posts/{postId}`, per `failed` target call retry `now`/`requeue`, never retry `ambiguous`, derive a stable `Idempotency-Key` from event id + target id, use a new key to continue a bulk call) and add the new 409 `details.reason` values to its errors table.
- [ ] T032 [P] [US7] Add a "Through the API" note to `docs/failures.md` (same actions available via API; shown as "API key {name}"); add the one-clause mention to `README.md`; add/complete a `## 016` section in `docs/decisions.md` recording D1–D10 and the plan's P1–P15 judgement calls (permission reuse of `write_posts`, `self_commit` mode, attribution columns, pairing 404).
- [ ] T033 [US7] Make T029 and T030 pass: adjust `examples`/descriptions in `src/server/api/operations/targets.ts` and `src/server/api/openapi.ts` as needed.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T034 Run the final pass once, synchronously: `pnpm lint < /dev/null && pnpm typecheck < /dev/null && pnpm test < /dev/null && pnpm db:check < /dev/null && pnpm build < /dev/null`. Fix any failure (including the 012/015 suites, which prove FR-003).
- [ ] T035 Confirm no operation imports a DAL or raw DB module (`tests/lint/api-imports.test.ts` green) and that `git status` shows only intended files; commit with explicit paths.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T014)** → user stories → **Polish**.
- Within Foundational: T003, T004, T005, T006, T011, T012 are independent [P]; T007 is standalone; T008 needs T003+T004+T007; T009 needs T003+T004+T007; T010 needs T005; T013 is independent of services; T014 last.
- **US1 (T015–T016)** needs Foundational. **US2** extends the US1 file and operation. **US3** (resolve) and **US4** (bulk) are independent of each other and of US1 beyond sharing `targets.ts` (sequence the edits to that file). **US5/US6/US7** verify across all three operations, so run them after US1, US3 and US4 exist.
- Story order: US1 → US2 → US3 → US4 → US5 → US6 → US7.

## Parallel Opportunities

- Foundational: `T003 T004 T005 T006 T011 T012` together; then `T008 T009 T010`.
- Test files per story (T015, T019, T021, T023, T025–T027, T029, T030) are different files and can be written in parallel.
- Docs T031 and T032 in parallel.

## Implementation Strategy

- **MVP**: Phases 1–3 (US1): single retry through the API with attribution plumbing in place.
- Then US2 (refusals), US3 (resolve), US4 (bulk), then the cross-cutting verification stories US5–US7, then Polish.
- Tick tasks as they finish; commit after each logical group.
