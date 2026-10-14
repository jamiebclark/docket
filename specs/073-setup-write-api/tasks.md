---

description: "Task list template for feature implementation"
---

# Tasks: Public API for project setup — projects, voice profiles, posting instructions and slots

**Input**: Design documents from `/specs/073-setup-write-api/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/services.md, quickstart.md

**Tests**: Requested explicitly (FR-048 through FR-052, spec "Tests" section) — included throughout.

**Organization**: Tasks are grouped by user story per spec.md priorities. Foundational work (the method widening, the new permission, the three service growths, the shared schemas) is one-time infrastructure every story needs, so it lives in Phase 2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)

## Path Conventions

Single Next.js app at repository root: `src/`, `tests/`, `drizzle/`, `docs/`.

---

## Phase 1: Setup

- [X] T001 Run `pnpm install` inside this worktree (worktrees have no `node_modules` of their own) and confirm `pnpm db:migrate` applies cleanly against the local Postgres on port 5555

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The widenings every one of the seven operations needs. No operation file can be written until this phase is done.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 Widen `ApiOperation["method"]` to `"GET" | "POST" | "PATCH" | "DELETE"` and widen `resourceParams` to include `"accountId" | "profileId" | "slotId"` in `src/server/api/operations/types.ts`
- [ ] T003 Add `"manage_setup"` to the `apiKeyPermission` pg enum in `src/server/db/schema/api.ts`, appended last after `"manage_jobs"`
- [ ] T004 Run `pnpm db:generate` to write `drizzle/0034_*.sql` (`ALTER TYPE "public"."api_key_permission" ADD VALUE 'manage_setup'`) and confirm `pnpm db:check` passes
- [ ] T005 [P] Add `"manage_setup"` to `API_KEY_PERMISSIONS` in `src/lib/validation/api.ts`
- [ ] T006 [P] Add the `manage_setup` grant (`project: ["view","update"]`, `account: ["view","manage"]`, `slot: ["view","manage"]`, `voice: ["view","manage"]`) to `KEY_GRANTS` in `src/server/dal/scope.ts`
- [ ] T007 [P] Add the `manage_setup` checkbox to `PERMISSIONS` in `src/app/p/[projectSlug]/settings/api-keys/CreateKeyForm.tsx`, with plain-language help text warning it can retime a schedule and rewrite a voice, `defaultChecked` left off (FR-009, FR-046)
- [ ] T008 [P] Add `"manage_setup"` to `ApiPermission`/`ALL_PERMISSIONS` in `tests/helpers/api.ts`, and extend `world()` there to provision a voice profile and a slot id per project for the new endpoint tests to reuse
- [ ] T009 Grow `createProjectSchema` and `create()` in `src/server/services/projects.ts` to accept `defaultApprovalPolicy?`, `defaultSchedulingPolicy?`, `confirmUnreviewedQueue` (default `false`), `tagline?`, `description?`, `websiteUrl?`; refuse an empty `session.user.id` with `ConflictError("This key has no user to own a new project.", { reason: "no_acting_user" })`; apply the unreviewed-queue confirmation rule; return the full `ProjectRecord`
- [ ] T010 Grow `NewProject` in `src/server/dal/projects.ts` to carry the five optional columns (written only when present) and change the unique-violation branch to `ConflictError("That URL name is already taken.", { field: "slug", reason: "slug_taken" })`
- [ ] T011 [P] Grow `setSlotPaused` in `src/server/services/slots.ts` to return `SlotView` instead of `void`
- [ ] T012 [P] Add `.returning()` to `setPaused` in `src/server/dal/slots.ts` and return `row!`, matching `move`
- [ ] T013 Add the request schemas to `src/lib/api/schemas.ts`: `CreateProjectRequestSchema`, `CreateVoiceProfileRequestSchema`, `UpdateVoiceProfileRequestSchema`, `SetPostingInstructionsRequestSchema`, `AddSlotRequestSchema`, `AddWeekSlotsRequestSchema`, `UpdateSlotRequestSchema` (strict objects/union per data-model.md §4, each with `.meta({ id })`)
- [ ] T014 Add the response schemas to `src/lib/api/schemas.ts`: `ProjectSchema`, `VoiceProfileRefSchema`, `AccountPostingInstructionsSchema`, `SlotSchema`, `WeekSlotsResultSchema`, `DeletedSlotSchema`, each transform-free with `.meta({ id })`, and export `ApiProject`, `ApiSlot`, `ApiWeekSlotsResult`, `ApiVoiceProfileRef`, `ApiAccountPostingInstructions`
- [ ] T015 Add `src/server/api/operations/errors-doc.ts`: a shared helper that produces the documented error statuses (400, 401, 403, 404, 409, 422, 429) with one example each, for every new operation to reuse (FR-042)

**Checkpoint**: Foundation ready — every user story phase below can now be implemented.

---

## Phase 3: User Story 1 - Stand a new brand up over HTTP (Priority: P1) 🎯 MVP

**Goal**: `POST /projects` and `POST /voice-profiles` let a workflow create a project with its policy/brand fields and its voice profile in one call each, idempotently.

**Independent Test**: Call project-create and voice-profile-create with a `manage_setup` key, confirm the project and profile exist with the submitted values through existing reads, then replay both with the same `Idempotency-Key` and confirm nothing new is created.

### Tests for User Story 1

- [ ] T016 [P] [US1] Integration tests for `POST /projects` in `tests/integration/api/endpoints/projects-write.test.ts`: happy path (all nine fields, owner membership, response shape), missing-permission 403, cross-project key (slug visible vs. invisible produce byte-identical 409 `slug_taken` — FR-049), validation failures (bad timezone, over-length name/tagline/description, non-http(s) website, unreviewed-queue `confirmation_required`), idempotent replay, and no-acting-user conflict
- [ ] T017 [P] [US1] Integration tests for `POST /voice-profiles` in `tests/integration/api/endpoints/voice-write.test.ts` (create portion): happy path (version 1, `isDefault: true` when no default exists), validation failures (over-length name, over-limit content field naming its `details.path`, bad link URL, malformed hashtag), missing-permission 403, cross-project key, idempotent replay

### Implementation for User Story 1

- [ ] T018 [US1] Create `src/server/api/operations/projects.ts` with the `createProject` operation (`POST /projects`, `permission: "manage_setup"`, `idempotent: true`, `idempotencyMode: "self_commit"`, no `resourceParams`) calling `services/projects.create` and mapping the result to `ProjectSchema`'s nine fields
- [ ] T019 [US1] Create `src/server/api/operations/voice.ts` with the `createVoiceProfile` operation (`POST /voice-profiles`, `permission: "manage_setup"`, `idempotent: true`, no `resourceParams`) calling `services/voice.createVoiceProfile` and mapping `{profileId, version}` to `{id, version, isDefault}`
- [ ] T020 [US1] Register both new operation arrays in `src/server/api/operations/index.ts`

**Checkpoint**: User Story 1 is fully functional and testable independently — a project and its voice profile can be created over HTTP.

---

## Phase 4: User Story 2 - Book a brand's posting week over HTTP (Priority: P1)

**Goal**: `POST /slots`, `POST /slots/week`, `PATCH /slots/{slotId}` and `DELETE /slots/{slotId}` let a workflow book, move, pause/unpause and delete slots, with the whole-week add reporting created-plus-already-set.

**Independent Test**: Against a project with one connected account, add a whole-week time, add a single-weekday time, move it, pause it, unpause it and delete it, checking the account's slots through the existing read path after each step.

### Tests for User Story 2

- [ ] T021 [US2] Integration tests for `POST /slots`, `POST /slots/week`, `PATCH /slots/{slotId}` and `DELETE /slots/{slotId}` in `tests/integration/api/endpoints/slots-write.test.ts`: whole-week add on an empty account (seven created, empty `alreadySet`) and on a partly-booked account including a paused slot (created + named already-set weekdays, paused slot stays paused); single-slot add happy path, 409 conflict on a duplicate with no `Idempotency-Key`, idempotent replay with one; move (same id, new values, scheduled posts keep their time), pause/unpause, a body carrying both or neither intents (400); delete (200 `{id, deleted: true}`, a second delete 404, replayed 200 with the first key); weekday/time validation failures; missing-permission 403
- [ ] T022 [US2] Add the body-borne-account-id isolation test to `tests/integration/api/endpoints/slots-write.test.ts`: a project-B account id and a random UUID both answer byte-identical 404s for `POST /slots` and `POST /slots/week` (contract note — these two don't walk `resourceParams`)

### Implementation for User Story 2

- [ ] T023 [US2] Add the `SlotView` → `Slot` response mapping as one exported helper in `src/server/api/operations/slots.ts` (reused by `addSlot`, `updateSlot`, `addWeekSlots`)
- [ ] T024 [US2] Add the `addSlot` operation (`POST /slots`, no `resourceParams`, account id in body) to `src/server/api/operations/slots.ts` calling `services/slots.addSlot`
- [ ] T025 [US2] Add the `addWeekSlots` operation (`POST /slots/week`, no `resourceParams`, account id in body) to `src/server/api/operations/slots.ts` calling `services/slots.addSlotsForWeek`, mapping `{added, alreadySet}` through the shared slot helper
- [ ] T026 [US2] Add the `updateSlot` operation (`PATCH /slots/{slotId}`, `resourceParams: ["slotId"]`) to `src/server/api/operations/slots.ts` dispatching the strict-union body to `services/slots.moveSlot` or `services/slots.setSlotPaused`, exactly one per request
- [ ] T027 [US2] Add the `deleteSlot` operation (`DELETE /slots/{slotId}`, `resourceParams: ["slotId"]`, no body) to `src/server/api/operations/slots.ts` calling `services/slots.deleteSlot` and returning `{id: params.slotId, deleted: true}`
- [ ] T028 [US2] Register the four new slot operations in `src/server/api/operations/index.ts`

**Checkpoint**: User Stories 1 and 2 both work independently — a brand can be provisioned and scheduled end to end.

---

## Phase 5: User Story 3 - A key that cannot do setup still cannot (Priority: P1)

**Goal**: No existing key gains any new ability, and a `manage_setup`-only key gains no existing ability.

**Independent Test**: Call every new operation with a key holding every permission except `manage_setup`, and call every pre-existing operation with a key holding only `manage_setup`; both directions refuse with 403 naming the missing permission.

### Tests for User Story 3

- [ ] T029 [US3] Create `tests/integration/api/setup-permission.test.ts` (FR-052): a key with every permission except `manage_setup` is refused 403 `missing_permission` (details naming `manage_setup`) by all eight new paths with nothing written; a key with no key at all gets 401; a key holding only `manage_setup` is refused 403 (naming its own permission) by every pre-existing keyed operation
- [ ] T030 [US3] Extend `tests/integration/api/scope-enforcement.test.ts` with project-B fixtures for the `accountId`, `profileId` and `slotId` resource parameters, covering `PATCH /accounts/{accountId}`, `PATCH /voice-profiles/{profileId}` and `PATCH|DELETE /slots/{slotId}`
- [ ] T031 [P] [US3] Extend the existing API-key form test (`tests/integration/api-keys/ui.test.tsx`) to confirm the `manage_setup` checkbox is labelled, carries its help text and warning, and is not checked by default
- [ ] T032 [US3] Run `pnpm vitest run tests/integration/api` and confirm the full pre-existing suite still passes unchanged (SC-005) — no code change expected for this task, a verification gate before closing the story

**Checkpoint**: All P1 stories (US1, US2, US3) are complete — the MVP.

---

## Phase 6: User Story 4 - Set a brand's per-account posting instructions over HTTP (Priority: P2)

**Goal**: `PATCH /accounts/{accountId}` sets posting instructions only, audited exactly as the UI edit is.

**Independent Test**: Set instructions on a connected account, read them back through `GET /accounts`, confirm one `account_posting_instructions_update` activity row attributed to the key's creator.

### Tests for User Story 4

- [ ] T033 [US4] Integration tests for `PATCH /accounts/{accountId}` in `tests/integration/api/endpoints/accounts-write.test.ts`: happy path (200, `changed: true`, one audit row with `previous`/`next`), repeat with identical text (`changed: false`, no second row), over-length (400 quoting 2,000), explicit empty string clears and audits, unknown field (400), another-project account id vs. unknown id (byte-identical 404), missing-permission 403, idempotent replay

### Implementation for User Story 4

- [ ] T034 [US4] Add the `setAccountPostingInstructions` operation (`PATCH /accounts/{accountId}`, `resourceParams: ["accountId"]`) to `src/server/api/operations/accounts.ts` calling `services/accounts.setPostingInstructions` and mapping `{changed, instructions}` to `{accountId, postingInstructions, changed}`
- [ ] T035 [US4] Register the new accounts operation in `src/server/api/operations/index.ts`

**Checkpoint**: Posting instructions are settable over HTTP, audited identically to the browser edit.

---

## Phase 7: User Story 5 - Refine a voice profile without losing its history (Priority: P2)

**Goal**: `PATCH /voice-profiles/{profileId}` appends an immutable version with optimistic-concurrency protection via `baseVersion`.

**Independent Test**: Create a profile, patch it twice, confirm version history shows 1, 2, 3 with earlier content intact; patch with a stale base version and confirm the refusal.

### Tests for User Story 5

- [ ] T036 [US5] Integration tests for `PATCH /voice-profiles/{profileId}` in `tests/integration/api/endpoints/voice-write.test.ts` (patch portion): append happy path (version 2, version 1 unchanged), stale `baseVersion` (409, no new version), identical name/content with current `baseVersion` (200, same version, nothing appended), archived profile (409 telling the caller to restore first), another-project profile id vs. unknown id (identical 404), missing-permission 403, idempotent replay

### Implementation for User Story 5

- [ ] T037 [US5] Add the `updateVoiceProfile` operation (`PATCH /voice-profiles/{profileId}`, `resourceParams: ["profileId"]`) to `src/server/api/operations/voice.ts` calling `services/voice.saveVoiceProfile` and mapping `{version}` to `{id: params.profileId, version}`
- [ ] T038 [US5] Register the updated voice operations array (if not already covered by T020) in `src/server/api/operations/index.ts`

**Checkpoint**: All five user stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the OpenAPI surface, and the whole-suite checks that span every story.

- [ ] T039 [P] Extend `tests/integration/api/openapi.test.ts` to assert every new operation documents a summary, a description ending "Requires the `manage_setup` permission.", its tag, `x-required-permission: "manage_setup"`, the `Idempotency-Key` header, a request example where it takes a body, and a response example for each documented status (FR-042, FR-043)
- [ ] T040 [P] Run `pnpm vitest run tests/lint/api-imports.test.ts` and confirm the new operation files reach no DAL and no database client directly (FR-003) — fix any violation found
- [ ] T041 [P] Run `pnpm vitest run tests/integration/security/secret-scan.test.ts` and confirm it stays green with the new operations and schemas in place (FR-051, SC-009)
- [ ] T042 Add the "Provision a brand" worked example to `docs/n8n.md`, placed after section 7 (`## 7. Recover failed posts`) per the documentation-placement decision: project, voice profile, posting instructions and a week of slots, with an `Idempotency-Key` on every write, stating plainly that creating an API key in the new project is the one step that stays in the browser (FR-044)
- [ ] T043 [P] Rewrite the "What cannot be scripted today" section of `docs/brand-onboarding.md` to name exactly the endpoints this entry adds and which runbook steps can now be driven over HTTP versus which stay in the browser (FR-047)
- [ ] T044 [P] Add a section to `docs/decisions.md` recording: the `manage_setup` permission choice, the project-creation ownership/scope decision, the whole-week slot shape (`POST /slots/week` as its own operation), the slug-conflict behaviour and reason (`slug_taken`), and the global slug uniqueness constraint (FR-045)
- [ ] T045 Create `tests/integration/docs/n8n-provision.test.ts` that replays the `docs/n8n.md` provisioning example end to end: asserts at most five HTTP calls (SC-002), asserts a re-run creates nothing a second time (SC-003), and asserts no response in the flow is `internal_error` (SC-004)
- [ ] T046 Run the full validation pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, per quickstart.md §3

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS every user story. T003 → T004 is sequential (generate the migration from the schema change); T009/T010 and T011/T012 are each service-then-DAL pairs within themselves but independent of each other; T013/T014 (schemas) have no code dependency on the enum/service work and can run alongside it.
- **User Stories (Phase 3–7)**: All depend on Foundational completion. US1, US2 and US4 have no dependency on each other and can proceed in parallel. US3's tests depend on at least the operations under test existing (so in practice run after US1/US2/US4/US5 implementation, though its own task numbering sits at P1 priority). US5 depends on US1's `createVoiceProfile` existing (to have a profile to patch) but is its own operation file addition.
- **Polish (Phase 8)**: Depends on all five user stories being complete.

### User Story Dependencies

- **US1 (P1)**: No dependency on other stories.
- **US2 (P1)**: No dependency on other stories (needs a pre-connected account, not a new-story output).
- **US3 (P1)**: Tests every operation added by US1, US2, US4 and US5 plus every pre-existing one — run its tasks last among the P1/P2 set even though it is itself P1.
- **US4 (P2)**: No dependency on other stories.
- **US5 (P2)**: Needs a profile to patch — depends on US1's `createVoiceProfile` (T019) existing, not on US1's tests passing.

### Within Each User Story

- Tests are written first and must fail before implementation (per the constitution's "nothing is working unless it ran").
- The operation file exists before it is registered in `index.ts`.
- Story complete before moving to the next priority, though stories can be parallelized across contributors given Foundational is done.

### Parallel Opportunities

- T005, T006, T007, T008 (all foundational, different files) in parallel after T003/T004.
- T011 and T012 in parallel with the T009/T010 pair (different services).
- T016 and T017 (different test files) in parallel.
- US1, US2 and US4 implementation can proceed in parallel once Foundational is done.
- T039, T040, T041 (independent verification tasks) in parallel.
- T043 and T044 (independent doc files) in parallel.

---

## Parallel Example: Foundational Phase

```bash
# After T002–T004 land, launch the independent widenings together:
Task: "Add manage_setup to API_KEY_PERMISSIONS in src/lib/validation/api.ts"
Task: "Add the manage_setup grant to KEY_GRANTS in src/server/dal/scope.ts"
Task: "Add the manage_setup checkbox to CreateKeyForm.tsx"
Task: "Add manage_setup to ALL_PERMISSIONS in tests/helpers/api.ts"
```

## Parallel Example: User Story 1

```bash
Task: "Integration tests for POST /projects in tests/integration/api/endpoints/projects-write.test.ts"
Task: "Integration tests for POST /voice-profiles in tests/integration/api/endpoints/voice-write.test.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1, 2, 3)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational — the method widening, the permission, the three service growths, the shared schemas.
3. Complete Phase 3 (US1): project + voice profile creation over HTTP.
4. Complete Phase 4 (US2): slot booking, moving, pausing, deleting over HTTP.
5. Complete Phase 5 (US3): prove no key gains or loses anything it shouldn't.
6. **STOP and VALIDATE**: this is the MVP — a brand's project, voice and schedule can be stood up over HTTP, and the permission boundary holds.

### Incremental Delivery

1. Foundation ready → US1 → US2 → US3 validates the boundary → MVP shippable.
2. Add US4 (posting instructions) → test independently.
3. Add US5 (voice refinement) → test independently.
4. Phase 8 polish (docs, OpenAPI assertions, the n8n provisioning test) closes out FR-041 through FR-052 and every SC.

### Human-Owned Verification Tasks

None. Every acceptance criterion in this entry is checkable against a local dev server and a real (but local) Postgres — API responses, audit rows, the OpenAPI document, and the migration snapshot are all readable without a deployed surface, a browser session, or production data. T032 and T046 are full-suite verification gates run by the same implementer, not deferred human tasks.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- Every new operation calls exactly one service function (FR-002); operation files import no DAL and no database client beyond types and `dal/errors` (FR-003, contracts/services.md).
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently.
