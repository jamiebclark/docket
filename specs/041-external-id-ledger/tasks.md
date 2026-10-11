---

description: "Task list template for feature implementation"
---

# Tasks: External item ID ledger

**Input**: Design documents from `/specs/041-external-id-ledger/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/services.md, quickstart.md

**Tests**: Included — the feature specification's independent tests and quickstart.md map every FR/SC to a real-Postgres test; this plan follows that map.

**Organization**: Tasks are grouped by user story (US1 = P1, US2 = P2, US3 = P3) per spec.md, after a Setup/Foundational phase that carries the schema, DAL, validation and shared helpers every story needs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are exact, taken from plan.md's Scale/Scope table

## Path Conventions

Single Next.js web app plus worker (the layout of 001–040): `src/`, `tests/`, `drizzle/`, `docs/` at repository root.

---

## Phase 1: Setup

**Purpose**: Schema, migration and validation primitives every story depends on. No story-specific behaviour yet.

- [X] T001 Add `unique("posts_project_id_uq").on(project_id, id)` to `posts` in `src/server/db/schema/posts.ts` (data-model.md "Changed table: posts"; F10)
- [X] T002 Add `external_id text` column, its length/trim check, and the `'skipped'` value to `generation_job_item_status` in `src/server/db/schema/jobs.ts` (data-model.md "Changed table: generation_job_items")
- [X] T003 [P] Create `src/server/db/schema/external-claims.ts`: the `external_item_claims` table — primary key `(project_id, source_key, external_id)`, project-composite FK to `posts` with `ON DELETE CASCADE`, `external_item_claims_post_idx` on `(project_id, post_id)`, and the three check constraints (`source_key` shape, `external_id` length, `external_id` trimmed) per data-model.md
- [X] T004 Export the new table from `src/server/db/schema/index.ts`
- [X] T005 Register `{ table: "external_item_claims", scopeColumn: "project_id" }` in `src/server/db/project-owned.ts` (depends on T003, T004)
- [X] T006 Run `pnpm db:generate` to produce `drizzle/0019_external_item_ledger.sql` (and its `meta/` snapshot/journal entries) in the order: enum value, posts unique, job-items column+check, external_item_claims table; verify no backfill `UPDATE` was added (depends on T001-T005)
- [X] T007 Run `pnpm db:check` to confirm schema and migration are in step (depends on T006)
- [X] T008 [P] Add `EXTERNAL_ID_MAX` (200), `SOURCE_KEY_MAX` (64), `DEFAULT_SOURCE_KEY` ("default"), `externalIdSchema` and `sourceKeySchema` to `src/lib/validation/api.ts` (data-model.md "Validation rules")
- [X] T009 [P] Create `src/lib/jobs/skipped.ts` with the pure `alreadyPostedReason(externalId: string): string` helper (contracts/services.md "views/read.ts")
- [X] T010 [P] Create `src/lib/jobs/skipped.test.ts` covering `alreadyPostedReason`'s wording (depends on T009)

**Checkpoint**: Schema, migration and shared validation/wording primitives exist. No DAL or service wiring yet — user stories cannot start until Phase 2 completes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The DAL repository and its wiring into every scope that needs it. This is the one new read/write surface every user story calls through.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T011 Create `src/server/dal/external-claims.ts`: `ExternalClaim` type, `ExternalClaimsRepo` interface, and `createExternalClaimsRepo(exec, projectId)` implementing `find`, `findMany` (empty list short-circuits to an empty map with no query), `findByPostId`, and `insert` — every query filters `project_id = projectId` (contracts/services.md "New DAL repository") (depends on T003-T007)
- [X] T012 Add `readonly externalClaims: ExternalClaimsRepo` to `ProjectScope` and wire `createExternalClaimsRepo` into the scope factory, plus into `createSchedulingRepos`, in `src/server/dal/scope.ts` (depends on T011)
- [X] T013 Add `skipped: number` to `JobCounts` in `src/server/dal/jobs.ts` and initialise it in `emptyCounts()` (depends on T002)

**Checkpoint**: `scope.externalClaims` is reachable from every caller (API operations, services, the job runner, webhook emission) and `JobCounts` knows about `skipped`. User stories can now proceed.

---

## Phase 3: User Story 1 - Post a source record exactly once (Priority: P1) 🎯 MVP

**Goal**: A generate request tagged with an external id makes exactly one post for that id, ever — later calls, from any API key, return the existing post with no model call.

**Independent Test**: Submit a generate request tagged with a record id; submit the identical request again, and again from a different API key. Exactly one post exists, both later calls report `alreadyPosted: true` naming that post, and no model call is made on the later calls.

### Tests for User Story 1

- [X] T014 [P] [US1] Write `tests/integration/generation/external-id.test.ts`: tagged generate makes a post and a claim (FR-001, FR-006, FR-007, FR-008); a second call returns the same post with `alreadyPosted: true` and the fake model records zero calls (FR-013, FR-014); the claim names the post and its `claimedAt`; a different API key in the same project sees the same result (AS1.3); a deleted post then re-submitted answers `409 conflict` with `details.reason: "already_posted_post_deleted"` and does not re-post (AS1.4, FR-010)
- [X] T015 [P] [US1] Write `tests/integration/generation/external-id-race.test.ts`: N concurrent `generateSingle` calls for one unclaimed id → exactly one post, the rest answered as existing, zero errors (FR-015, SC-005, AS1.6)
- [X] T016 [P] [US1] Write `tests/integration/generation/external-id-atomic.test.ts`: a save that throws after the post insert leaves neither post nor claim; a model failure (unusable output, no model configured) leaves the id unclaimed and the next call generates normally (FR-007, FR-009, AS1.5)
- [X] T017 [P] [US1] Write `tests/integration/limits/external-id-validation.test.ts`: blank, whitespace-only, 201-character `externalId` and malformed/standalone `sourceKey` are refused naming the field (FR-004); an untagged request writes no claim (FR-005); `Glen-42` and `glen-42` are two records (D14); the same id in two `sourceKey`s both post, and the same id in two projects both post (FR-012, edge cases)

### Implementation for User Story 1

- [X] T018 [US1] Add optional `external?: { sourceKey: string; externalId: string }` to `saveGeneratedPost` in `src/server/services/generation/save.ts`: after the post, media, targets and derived status are written, insert the claim via `tx.externalClaims.insert` (contracts/services.md "generation/save.ts") (depends on T011, T012)
- [X] T019 [US1] Add `externalId: externalIdSchema.optional()` and `sourceKey: sourceKeySchema.default(DEFAULT_SOURCE_KEY)` to `generateSingleSchema` with a refine refusing a `sourceKey` sent without `externalId`, in `src/server/services/generation/single.ts` (depends on T008)
- [X] T020 [US1] In `generateSingle` (`src/server/services/generation/single.ts`), after the existing `findByRequestId` idempotency check and before `takeVoice`/account loads/model call: look up the claim; on a hit, load the post and return `existingResult(post)`, or throw `ConflictError` with `reason: "already_posted_post_deleted"` when the post is gone (FR-013, FR-014, D4, D5) (depends on T018, T019)
- [X] T021 [US1] Pass `external` into `saveGeneratedPost`'s call inside `generateSingle`'s transaction when `externalId` was supplied (depends on T020)
- [X] T022 [US1] In `generateSingle`'s `catch (unique violation)` recovery, ask `externalClaims.find(sourceKey, externalId)` first (re-reading, not branching on constraint name, D7); fall through to the existing `findByRequestId` recovery when there is no claim (depends on T020)
- [X] T023 [US1] Extend `planSeriesSchema`'s `omit` in `src/server/services/generation/series.ts` to `{ requestId: true, externalId: true, sourceKey: true }` so series planning never claims an id (F14) (depends on T019)
- [X] T024 [US1] Add `alreadyPosted: boolean` to `GeneratedSchema` in `src/lib/api/schemas.ts`, true on both the request-id replay and the ledger-hit paths (D5) (depends on T008)
- [X] T025 [US1] Add `externalId`/`sourceKey` request fields (with `.meta({ description, example })`) and the `alreadyPosted` response field, plus a `409` response entry, to the `generatePost` operation in `src/server/api/operations/generate.ts` (contracts/http-api.md §1) (depends on T020, T024)

**Checkpoint**: User Story 1 is fully functional and independently testable — a tagged generate request de-duplicates permanently, across keys and across post deletion, before any model call.

---

## Phase 4: User Story 2 - Hand Docket a backlog and let it skip what it already posted (Priority: P2)

**Goal**: API-source job ingest (create and append) silently drops already-claimed ids, reports how many were dropped, and a job item whose id is claimed between ingest and execution ends `skipped` rather than failed.

**Independent Test**: Create an API-source job with 10 tagged items and let it run; then append the same 10 items plus 5 new ones. The response reports 5 added and 10 skipped, the job gains exactly 5 items, and 15 posts exist in total.

### Tests for User Story 2

- [X] T026 [P] [US2] Write `tests/integration/jobs/external-id-ingest.test.ts`: 10 items then the same 10 plus 5 → `added: 5`, `skippedAlreadyPosted: 10`, item count 15, 15 posts (SC-002); one call containing an id twice keeps one and counts one skipped (FR-017, AS2.3); an invalid item still refuses the whole call (FR-019); 500 already-posted plus 3 new is accepted, the limit counted after skipping (FR-018, edge case); SC-008 perf assertion — with ~1,000 pre-seeded claims, a 100-item append completes within budget and issues exactly one claim query via the scope recorder
- [X] T027 [P] [US2] Write `tests/integration/jobs/external-id-late-skip.test.ts`: an item whose id is claimed after ingest ends `skipped` with no post (FR-021); the job finishes `completed`, not `completed_with_failures` (AS2.7); `retry-failed` does not pick it up (FR-022); its image is free; a claim landing during the model call still ends as a skip (D7/D9, forced via a second connection claiming between the model call and the save)
- [X] T028 [P] [US2] Extend `src/server/services/jobs/status.test.ts`: `deriveJobStatus` with `skipped` counts reads as finished, not failed; `worked` is true when only skips happened (D10)
- [X] T029 [P] [US2] Extend `tests/integration/jobs/create.test.ts`: `skippedAlreadyPosted` on create (FR-016); a non-open job with everything skipped is refused naming the count (FR-020, AS2.5); an open job with everything skipped is created empty and stays open (AS2.4, edge case)
- [X] T030 [P] [US2] Extend `tests/integration/jobs/reservation.test.ts`: a skipped item's image is left unreserved and another job can take it (FR-018, AS2.6)
- [X] T031 [P] [US2] Extend `tests/integration/jobs/cancel.test.ts`: cancelling a job leaves `skipped` items alone (F6); a cancelled or permanently failed item's id is re-submittable (AS2.8)

### Implementation for User Story 2

- [X] T032 [US2] Add `externalId: string | null` to `SourceItem` in `src/server/services/jobs/sources/types.ts`; set `null` in `src/server/services/jobs/sources/csv.ts` and `src/server/services/jobs/sources/media.ts` (depends on T002)
- [X] T033 [US2] Add `externalId: externalIdSchema.optional()` to `apiItemSchema` and `sourceKey: sourceKeySchema.default(DEFAULT_SOURCE_KEY)` to `apiSourceSchema` in `src/server/services/jobs/sources/api.ts`; create `apiSourceMetaSchema` (`{ open, sourceKey }`) replacing the existing `as` cast; `prepareApiItems` carries `externalId` through and reports invalid ids as `items.<i>.externalId` / `source.items.<i>.externalId` (depends on T008, T032)
- [X] T034 [US2] Create `src/server/services/jobs/claims.ts` with the shared `dropAlreadyPosted(tx, sourceKey, items)`: one `findMany` for the call's distinct ids, then a single pass keeping the first occurrence of each unseen id, returning `{ kept, skipped }` (FR-016, FR-017) (depends on T011, T012, T032)
- [X] T035 [US2] In `src/server/services/jobs/create.ts`: read `sourceKey` from the prepared `apiSourceMetaSchema` result, call `dropAlreadyPosted` after the media filter and before the empty-items check; when `kept.length === 0 && !open`, throw the `already_posted` validation issue naming the skipped count when `skipped > 0`, else today's `emptyMessage`; pass `kept` to `insertItems`, writing `externalId` on each row; add `skippedAlreadyPosted` to `CreateJobResult` (D6, FR-020) (depends on T033, T034)
- [X] T036 [US2] In `src/server/services/jobs/append.ts`: lock the job, read `sourceKey` from `source_meta`, run `prepareApiItems`, `assertRenderedFits`, then `dropAlreadyPosted`, then the `JOB_ITEMS_MAX` check on `job.itemCount + kept.length`, then media checks and `insertItems` on `kept` only; add `skippedAlreadyPosted` to `AppendResult` (FR-018) (depends on T033, T034)
- [X] T037 [US2] In `src/server/services/jobs/status.ts`: add `+ counts.skipped` to `worked`'s derivation; keep `completed_with_failures` keyed on `counts.failed > 0` only; add `counts.skipped` to `insertItems`' `base` position sum (F4, D10) (depends on T013)
- [X] T038 [US2] In `src/server/services/jobs/runner.ts`'s `processClaimedItem`: add the pre-check (after accounts/assets resolve, before the generation budget window) that looks up the claim for `item.externalId` under the job's `sourceKey` (parsed via `apiSourceMetaSchema`) and, on a hit, commits `skipped` with `leaseOwner/leaseUntil/pendingRetry: null` through the existing lease-checked `commit()`, incrementing `counts.skipped`; in the existing `catch (isUniqueViolation)` around `saveGeneratedPost`, ask the ledger first and skip the item when another submission's claim won, else fall through to `posts.findByJobItemId` recovery (D7, D9, FR-021) (depends on T018, T033, T037)
- [X] T039 [US2] Add `skipped: number` to `GenerationCounts` and initialise it in `emptyGenerationCounts()`; ensure the tick heartbeat and the `generation_job_item` log line report `outcome=skipped` with no external id in the log line (depends on T038)
- [X] T040 [US2] Add `skippedAlreadyPosted` to the `createJob`/`addJobItems` response schemas, extend the `status` filter enum with `skipped`, and extend request/response descriptions with the silent-skip rule, in `src/server/api/operations/jobs.ts` (contracts/http-api.md §2, §3) (depends on T035, T036)

**Checkpoint**: User Stories 1 AND 2 both work independently — batch ingest de-duplicates at the door and the runner catches a race that slips through.

---

## Phase 5: User Story 3 - Trace a post back to the record it came from (Priority: P3)

**Goal**: A post, a job item and the ledger all expose which source record produced (or already consumed) an id, and the app renders a skipped item as a neutral, non-alarming state.

**Independent Test**: Generate a post tagged with a record id, read the post back through the API, and confirm the source and record id appear. Append a duplicate item, read the job item back, and confirm the skip is visible with a plain-language reason.

### Tests for User Story 3

- [X] T041 [P] [US3] Extend `tests/integration/api/endpoints/generate.test.ts`: `alreadyPosted` on `201` and `200`; `409 conflict` with `details.reason: "already_posted_post_deleted"` after the post is deleted (FR-010); `Post.source` on the read-back (FR-023); `source: null` for an untagged post (AS3.3)
- [X] T042 [P] [US3] Extend `tests/integration/api/endpoints/jobs.test.ts`: `JobItem.externalId`, `status: "skipped"`, `skipped.reason`/`.postId`, `error: null`; `?status=skipped` filtering; `JobCounts.skipped` (FR-024)
- [X] T043 [P] [US3] Extend `tests/integration/jobs/ui.test.tsx`: a skipped item renders the "Skipped" badge with a neutral tone and its reason in the Detail column, is not styled or counted as a failure, and offers no retry action (FR-025)
- [X] T044 [P] [US3] Extend `tests/integration/api/openapi.test.ts`: `externalId`, `sourceKey`, `alreadyPosted`, `source`, `skipped` and the new `409` appear in the generated document with descriptions (FR-026)
- [X] T045 [P] [US3] Extend `tests/integration/webhooks/emission.test.ts` (and the relevant sibling in `tests/integration/webhooks/`): a `post.published` body carries `source`, and a `job.finished` body carries `counts.skipped` (F9)
- [X] T046 [P] [US3] Extend `tests/integration/api/scope-enforcement.test.ts`: a key for another project sees nothing of this project's ledger; the global scope recorder proves every claim query is project-pinned (FR-012)
- [X] T047 [P] [US3] Extend `src/server/db/project-owned.test.ts`: `external_item_claims` is registered exactly once (depends on T005)
- [X] T048 [P] [US3] Extend `tests/integration/api/idempotency-generate.test.ts`: the "tagged and keyed" case — a retry of the exact request replays the stored answer, a different request carrying an already-posted id is answered from the ledger; the ledger still holds 8 days later (`atTime` clock) and after the original key is revoked and replaced (FR-011, SC-004)
- [X] T049 [P] [US3] Extend `tests/integration/jobs/no-secrets.test.ts` and `tests/integration/generation/no-secrets.test.ts`: no credential appears in the new responses, rows, log lines or views
- [X] T050 [P] [US3] Write `tests/integration/docs/external-id.test.ts`: the fenced `http` blocks of the new `docs/n8n.md` section are replayed against the real API and produce the documented statuses and bodies (FR-026; F19 — the existing `n8n-flow` test stops before section 7)

### Implementation for User Story 3

- [X] T051 [P] [US3] Add `source: { key: string; externalId: string } | null` to `PostViewInput`/`PostSchema`; resolve it in `loadApiPost` (`src/server/services/views/load.ts`) and `webhooks/emit.ts`'s `postData` via `externalClaims.findByPostId`, added to the existing `Promise.all`; pass it through in `toApiPost` (`src/server/services/views/post.ts`) (D11, F9) (depends on T011, T012, T018)
- [X] T052 [P] [US3] Add `externalId: string | null` and `skipped: { externalId, reason, postId } | null` to `JobItemView`/`JobItemSchema`; in `toItemView` (`src/server/services/jobs/read.ts`), fill `skipped` only when `status === "skipped"`, using `alreadyPostedReason` from `src/lib/jobs/skipped.ts` and resolving `postId` via `posts.get(claim.postId)` (null if the post was deleted); map the fields in `toApiJobItem` (depends on T009, T011, T038)
- [X] T053 [US3] Add `"externalClaims"` to `EmitRepos` in `src/server/services/webhooks/emit.ts` and ensure `createSchedulingRepos` supplies it (depends on T012, T051)
- [X] T054 [P] [US3] Add `skipped: { label: "Skipped", tone: "neutral" }` to `StatusBadge`'s table in `src/components/ui/StatusBadge.tsx` (read the `docket-ui` skill first; FR-025) (depends on T052)
- [X] T055 [US3] In `src/app/p/[projectSlug]/jobs/[jobId]/JobItemsTable.tsx`: rename the last-but-one column from `Error` to `Detail`, rendering the error message for a failed item or the skip reason (linking to `skipped.postId` when present) for a skipped item; keep retry limited to `failed` (depends on T052, T054)
- [X] T056 [US3] In `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx`: add a `Skipped` counter to the counts row and a `Skipped` tab to `FilterTabs` (depends on T052)
- [X] T057 [US3] Add `externalId`/`sourceKey`/`alreadyPosted`/`source`/`skipped` descriptions (`.meta({ description, example })`) and extend `generatePost`/`createJob`/`addJobItems` operation descriptions in the OpenAPI generation (`src/server/api/operations/openapi.ts`) (FR-026) (depends on T024, T040, T051, T052)
- [X] T058 [US3] Write the "9. Post each record once" section of `docs/n8n.md`: how to tag submissions, what a duplicate answer looks like, which failures leave an id re-submittable, and that a deleted post does not free its id (FR-026) (depends on T050)
- [X] T059 [P] [US3] Add the skipped item state to `docs/generator.md` § Jobs

**Checkpoint**: All user stories are independently functional — a post, a job item and the API/webhook/UI surfaces all trace an id back to its record.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation of the decision, and the final whole-suite gate.

- [X] T060 [P] Add a `## 041` entry to `docs/decisions.md` summarizing the ledger design (per plan.md "Commits, docs and decisions")
- [ ] T061 Run `pnpm lint && pnpm typecheck && pnpm test`, `pnpm db:check`, and `pnpm build` as the final whole-suite gate (quickstart.md "Running it"; depends on all prior tasks)
- [X] T062 Verified 2026-10-11 against a locally seeded job (`pnpm seed` now creates one with a skipped item; see scripts/seed.ts). Confirmed on the job page: neutral **Skipped** badge distinct from Done/Failed, Detail reading `Already posted: "record-4815" became a post earlier.` with a working **View post** link, SKIPPED counter, the **Skipped** tab filtering via `?status=skipped`, no retry control on the skipped row while the failed row keeps one, and a visible focus ring on keyboard traversal.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (needs the table and columns) — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational. No dependency on US2 or US3.
- **User Story 2 (Phase 4)**: Depends on Foundational. Reuses `saveGeneratedPost`'s `external` argument from US1 (T018) and `JobCounts.skipped` from Foundational (T013); does not require US1's generate-path or API-surface tasks (T019–T025) to be complete.
- **User Story 3 (Phase 5)**: Depends on Foundational, on US1's `saveGeneratedPost`/`generateSingle` changes (for `Post.source` and the generate `409`/`alreadyPosted`), and on US2's runner/ingest changes (for `JobItem.skipped` and the Skipped UI). In practice, US3 is best done after US1 and US2 are functionally complete, even though it is scoped as a separate story.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### Within Each User Story

- Tests are written first and must fail before implementation.
- Schema/DAL before services; services before API operation wiring; API wiring before UI.

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel once T001-T002 (schema edits) are in; T003 is independent of T001/T002.
- All four US1 test files (T014-T017) can be written in parallel; all US2 test files (T026-T031) can be written in parallel; all US3 test files (T041-T050) can be written in parallel.
- Within US3's implementation, T051, T052, T054, T059 touch different files and can run in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write tests/integration/generation/external-id.test.ts"
Task: "Write tests/integration/generation/external-id-race.test.ts"
Task: "Write tests/integration/generation/external-id-atomic.test.ts"
Task: "Write tests/integration/limits/external-id-validation.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (schema, migration, validation primitives).
2. Complete Phase 2: Foundational (the DAL repository, `JobCounts.skipped`).
3. Complete Phase 3: User Story 1 — a tagged generate request de-duplicates permanently.
4. **STOP and VALIDATE**: run `tests/integration/generation/external-id*.test.ts` and `tests/integration/limits/external-id-validation.test.ts` independently.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add User Story 1 → validate independently (an integration can stop retrying single-record generate calls).
3. Add User Story 2 → validate independently (an integration can re-send its whole backlog through jobs).
4. Add User Story 3 → validate independently (the ledger's decisions become visible in the API, webhooks and the app).
5. Polish: docs/decisions.md, final whole-suite gate, then the one parked human browser check.

### Notes

- [P] tasks touch different files with no dependency between them.
- Avoid: a second place that inserts a claim, a second place that drops already-posted ids, a second wording for "why was this skipped" (constitution IV — one service layer, many callers).
- Per quickstart.md, run only the tests a task touched (`pnpm vitest run <file>`); reserve the full `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` gate for T061 at the end.
