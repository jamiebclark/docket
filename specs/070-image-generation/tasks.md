---

description: "Task list for implementing image generation into the media library"
---

# Tasks: Generate images into the media library, behind the existing ImageGenerator extension point

**Input**: Design documents from `/specs/070-image-generation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/config.md, contracts/services.md, contracts/ui.md, quickstart.md

**Tests**: Requested by the spec (per-feature test list) and included below, following quickstart.md's mapping to success criteria.

**Organization**: Tasks are grouped by user story. The Foundational phase (schema, configuration, adapter, hold extraction, usage recorder, authorization, validation) is the blocking prerequisite the plan calls out — no user story work can begin until it is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5, mapping to spec.md's priorities (US1/US2 = P1, US3/US4 = P2, US5 = P3)
- File paths are exact; contract/data-model section references are inline for traceability

---

## Phase 1: Setup

- [X] T001 [P] Add `LLM_IMAGE_PROVIDER` and `LLM_IMAGE_MODEL` documentation blocks (description, optional/required marker, default) to `.env.example`, in the existing `# --- Generator (LLM) ---` group (contracts/config.md §2)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, configuration, the vendor-neutral provider contract, the OpenAI adapter, credential resolution, the shared credit-hold rule, the usage recorder, authorization and input validation — everything the generator service and the UI are written against.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Schema and migration

- [X] T002 [P] Add `generated_at`, `generation_prompt`, `generation_provider`, `generation_model` columns and the four CHECK constraints (`..._all_or_none`, `..._prompt_shape`, `..._model_shape`, `..._provider_shape`) to `media_assets` in `src/server/db/schema/media.ts` (data-model.md §1)
- [X] T003 [P] Add the `'image.generate'` value to the `llmUsagePurpose` pgEnum in `src/server/db/schema/generation.ts` (data-model.md §2)
- [X] T004 Generate the Drizzle migration for T002+T003 with `pnpm db:generate`, commit the SQL file under `drizzle/`, and confirm `pnpm db:check` is green (depends on T002, T003)
- [X] T005 [P] Add the four provenance columns to `NewMedia` in `src/server/dal/media.ts` (depends on T002)

### Configuration

- [X] T006 [P] Add `LlmImageProviderName`, `LlmImageConfig`, `parseLlmImageConfig`, `LLM_IMAGE_VARIABLES` and `llmImageEnvIssues` to `src/server/llm/config.ts`, reusing the existing `intIn`/`limitsFrom`/`KEY_NAME` helpers (contracts/config.md §3)
- [X] T007 [P] Add unit tests for `parseLlmImageConfig` and `llmImageEnvIssues` covering every row of the parse table, including "no reason ever contains a value", in `src/server/llm/config.test.ts` (contracts/config.md §3)
- [X] T008 Wire `llmImageEnvIssues(source)` into the startup issue list and add the "image generation is off (LLM_IMAGE_PROVIDER not set)" disabled line in `src/server/startup/validate.ts` (depends on T006) (contracts/config.md §4)
- [X] T009 [P] Add `LLM_IMAGE_VARIABLES` to the `CONFIGURABLE` list in `tests/lint/env-coverage.test.ts` (depends on T006, T001)

### Contract vocabulary, provider interface and failure sentences

- [X] T010 [P] Add `ImageAspect`, `IMAGE_ASPECTS`, `DEFAULT_IMAGE_ASPECT`, `IMAGE_PROMPT_MAX` and `NO_REAL_PEOPLE` to `src/server/llm/image-generation.ts`; rewrite `src/server/llm/image-generation.test.ts` to assert the module exports exactly this vocabulary and no vendor value (contracts/services.md §1)
- [X] T011 [P] Create `ImageProviderRequest`, `ImageProviderResult`, `ImageProvider` and the registry (`createImageProviderForConfig`, `getImageProvider`, `getImageStatus`, `currentImageProviderTestOverride`, `setImageProviderForTests`, `setImageProviderFactoryForTests`) in `src/server/llm/image-provider.ts` (contracts/config.md §6, contracts/services.md §2)
- [X] T012 [P] Create `IMAGE_FAILURE_MESSAGES` and `imageFailureMessage()` in `src/server/llm/image-messages.ts`, with a test in `src/server/llm/image-messages.test.ts` asserting the map is keyed by every value of `LLM_FAILURE_KINDS` (contracts/services.md §3)
- [X] T013 [P] Export `kindOfError` from `src/server/llm/openai.ts` with no behaviour change, for reuse by the image adapter (contracts/services.md §4)

### Adapter

- [X] T014 Create `createOpenAiImageProvider` in `src/server/llm/openai-image.ts`: client with `maxRetries: opts.maxRetries ?? 0`, the aspect→size table, explicit-size pass-through, the request body (`model`, `prompt`, `n: 1`, `size`, `output_format: "png"`), `b64_json` reading, usage/timeout/`logLlmCall`, `OPENAI_IMAGE_REFUSAL_TYPES`/`_CODES` (empty, named, extensible) and `imageFailureKindOf` delegating to `kindOfError` (depends on T010, T011, T012, T013) (contracts/services.md §4)
- [X] T015 [P] Unit tests for the adapter with `createFakeLlmFetch` in `src/server/llm/openai-image.test.ts`: exact request body, aspect-to-size mapping, explicit size, response reading (success, empty `data`, missing `b64_json`), error classification for every observed status/kind including the `markers` parameter, and `maxRetries: 0` producing exactly one HTTP call per attempt (depends on T014) (quickstart.md §7)

### Resolution

- [X] T016 Add `resolveImageLlmForProject` and `missingLlmImageSettings` to `src/server/llm/resolve.ts`, following the four-step order in contracts/config.md §5 (test override → install config → project credential → install fallback), with `key_unreadable` never falling back (depends on T006, T011)

### Shared credit hold and usage recorder

- [X] T017 Extract `applyCreditOutcome(owner, kind)` in `src/server/services/generation/credit.ts` and add `withImageCreditHold(image, owner)`, rewriting `withCreditHold` to delegate to `applyCreditOutcome` with its existing tests passing unchanged (depends on T011) (contracts/services.md §5)
- [X] T018 [P] Add `"image.generate"` to `UsagePurpose` and add `wrapImage(image)` to `UsageRecorder` in `src/server/llm/usage.ts`, buffering the same row shape `wrap` does (depends on T011) (contracts/services.md §6)
- [X] T019 [P] Add the `"Generated image"` label for `"image.generate"` to `USAGE_PURPOSE_LABELS` in `src/lib/generation/usage-purpose.ts` (depends on T018)
- [X] T020 Widen the closed call-site list from seven to eight in `src/server/llm/no-missing-usage-purpose.test.ts` (depends on T018, T019) — NOTE: by design (per the guard's own comment and data-model.md §2) this file's second test stays red until T025 adds the `label: "image.generate"` call site in Phase 3; it is not expected to pass until then.

### Storage constant, authorization and validation

- [X] T021 [P] Export `MEDIA_STORAGE_NOT_SET_UP = "Media storage is not set up."` from `src/server/storage/index.ts`; update `src/server/llm/images.ts` to import it instead of its private `NOT_SET_UP` constant, with a test asserting both callers return the identical string (contracts/services.md §9)
- [X] T022 [P] Add `"generate"` to the `media` statement in `src/server/auth/access.ts`, granted to `owner` and `admin` only (`editor` keeps `["view", "edit"]`); update the matrix in `src/server/auth/access.test.ts` (contracts/services.md §10)
- [X] T023 [P] Add `generateImageSchema` (prompt trimmed 1–1000 characters, aspect one of `IMAGE_ASPECTS`, optional positive-integer `size`) to `src/lib/validation/media.ts` (depends on T010)

**Checkpoint**: Foundational phase complete — schema, configuration, adapter, resolution, hold, ledger, authorization and validation all exist and are tested in isolation. User story work can now begin.

---

## Phase 3: User Story 1 - An owner generates an image into the library (Priority: P1) 🎯 MVP

**Goal**: An owner on the Media page types a prompt, picks an aspect, and gets a usable image in the library in one action, with the outcome announced to a screen reader.

**Independent Test**: Sign in as an owner on an install with storage and an image provider configured, generate an image with a mocked provider returning known bytes, and see the asset in the library on the same page, with a thumbnail, the right dimensions for the chosen aspect, and the outcome announced.

### Implementation for User Story 1

- [X] T024 [US1] Add `GenerationProvenance` and extend `uploadMedia`/`commitUpload`/`toView` in `src/server/services/media.ts` to accept and persist `generation` metadata in the same insert as the rest of the row (depends on T005) (contracts/services.md §8)
- [X] T025 [US1] Create `imageGenerationEnabled`, `createImageGenerator` and `generateImage` in `src/server/services/media-generate.ts`, implementing the nine-step order of operations in contracts/services.md §7 (permission → cross-project check → schema validation → storage check → resolution → recorder/hold wrapping → provider call → `uploadMedia` → result) (depends on T016, T017, T018, T021, T022, T023, T024)
- [X] T026 [P] [US1] Integration tests for the happy path and every refusal (empty/over-length prompt, provider failure of each kind, oversized bytes) in `tests/integration/media/generate.test.ts`, asserting no orphaned storage object on any failure path (depends on T025) (quickstart.md §1)
- [X] T027 [P] [US1] Integration test driving the whole generator through a non-OpenAI stub `ImageProvider` installed via `setImageProviderForTests`, proving a complete asset with provenance is produced with no vendor-specific code above the adapter, in `tests/integration/media/generate-provider-swap.test.ts` (depends on T025) (quickstart.md §10)
- [X] T028 [P] [US1] Integration test asserting the prompt sent to the provider always ends with `NO_REAL_PEOPLE` and contains nothing else beyond the person's words, for a plain prompt, a prompt already mentioning a person, and a prompt at the 1000-character limit, in `tests/integration/llm/image-prompt.test.ts` (depends on T025) (quickstart.md §6, SC-010)
- [X] T029 [US1] Add `generateImageAction` to `src/app/p/[projectSlug]/media/actions.ts`, following the existing `runAction` shape and calling `refresh()` only on success (depends on T025) (contracts/ui.md §6)
- [X] T030 [US1] Create `src/app/p/[projectSlug]/media/GenerateImageDialog.tsx`: `TextareaField` prompt (labelled, hinted, `maxLength=1000`), `ChoiceField` aspect selector (three options, default square), submit with `pending`/`pendingLabel`, cancel, and a kept-mounted `LiveRegion` announcing in-flight/success/failure states (depends on T029) (contracts/ui.md §4-5)
- [X] T031 [US1] Wire `canGenerateImage` (storage enabled AND `media:["generate"]` AND `imageGenerationEnabled`) and render the trigger in both storage-on branches of `src/app/p/[projectSlug]/media/page.tsx` (depends on T030) (contracts/ui.md §2-3)

**Checkpoint**: User Story 1 is fully functional and independently testable — an owner can generate an image into the library end to end.

---

## Phase 4: User Story 2 - A generated image is an ordinary asset (Priority: P1)

**Goal**: A generated image is indistinguishable from an uploaded one to every downstream path — fit checks, variants, filters, search, attachment and deletion.

**Independent Test**: Generate an asset with a mocked provider, then assert against it: platform fit information for every registered provider, a derived variant for a provider whose constraints need one, attachment to a post, the "Unused" filter, search by filename, and deletion.

### Implementation for User Story 2

- [ ] T032 [US2] Integration tests proving fit parity (`fitOf` deeply equal to an uploaded image of identical dimensions/format/byte size), variant derivation via `ensureVariant`, the "Unused" filter, filename search, post attachment, and `deleteMedia` removing provenance with the row, in `tests/integration/media/generated-is-ordinary.test.ts` (depends on T025) (quickstart.md §2)

**Checkpoint**: User Stories 1 and 2 together prove SC-001 and SC-002 — the generation flow works and a generated asset is ordinary everywhere downstream.

---

## Phase 5: User Story 3 - A billing refusal pauses, it does not fail loudly (Priority: P2)

**Goal**: A billing refusal from the image provider takes the same credit-hold path as a text refusal; nobody clears state by hand.

**Independent Test**: With a mocked provider raising the provider's own quota error, assert the hold row for the resolved credential owner, the fixed sentence returned to the caller, and that a subsequent success clears the hold.

### Implementation for User Story 3

- [ ] T033 [US3] Integration tests for hold write on `credit_exhausted`, hold refresh without moving `held_since`, hold clear on success, the hold write being swallowed on a forced database failure, the project-vs-install owner split, and the undecryptable-key refusal never falling back, in `tests/integration/llm/image-hold.test.ts` (depends on T025) (quickstart.md §3)

**Checkpoint**: All three P1/P2 happy-path and resilience behaviours are proven.

---

## Phase 6: User Story 4 - Nothing is offered that cannot work (Priority: P2)

**Goal**: An install without storage, without an image provider, or with only an editor signed in, sees no dead control and gets one fixed sentence if called anyway.

**Independent Test**: Load the Media page in each of the three states and assert what is rendered; separately call the action in each state and assert the refusal and that nothing was written.

### Implementation for User Story 4

- [ ] T034 [US4] Integration tests for the three gate states — storage off, storage on with no image provider, and an editor on a fully configured install — across both page render and direct server-action call, plus the cross-project refusal, in `tests/integration/media/generate-gates.test.tsx` (depends on T031) (quickstart.md §4)

**Checkpoint**: SC-006 and SC-008 are proven; all four P1/P2 user stories are complete.

---

## Phase 7: User Story 5 - Anyone can see what was generated, and what it cost (Priority: P3)

**Goal**: A generated image is marked and readable in the library; an owner's Usage figures include the image calls.

**Independent Test**: Generate an asset, then read it back: the card marks it as generated, the stored prompt/provider/model are exactly as used, and the project's usage figures include one image call.

### Implementation for User Story 5

- [ ] T035 [P] [US5] Add the "Generated" badge and the prompt `<details>` disclosure to `src/components/media/MediaCard.tsx`, rendered only when `item.generated` is set (depends on T024) (contracts/ui.md §7)
- [ ] T036 [P] [US5] Integration tests for provenance persistence (prompt as typed/trimmed, provider, model, `generated_at`), the all-or-none CHECK rejecting a hand-built partial insert, an uploaded asset's four nulls, and project isolation (list, search, direct get, provenance read) in `tests/integration/media/generated-provenance.test.ts` (depends on T025) (quickstart.md §5)
- [ ] T037 [P] [US5] Integration tests for one `llm_call_usage` row per image call that reached the provider (provider, model, outcome, credential source, token counts only when reported) and no row for a call that never reached the provider, in `tests/integration/llm/image-usage.test.ts` (depends on T025) (quickstart.md §5)

**Checkpoint**: All five user stories are independently functional. SC-001–SC-010 are each covered by a runnable check.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the secrets guard, the final quality gates, and the one check that needs a real provider and a browser.

- [ ] T038 [P] Extend `tests/integration/security/secret-scan.test.ts` and `tests/integration/no-plaintext.test.ts` to generate one image through a fake provider and render the Media page for owner, admin and editor, asserting no fake key, SDK error text or raw provider payload appears anywhere (quickstart.md §8)
- [ ] T039 [P] Update `docs/generator.md`: add "Generating images" covering configuration, the real-people rule and the billing-refusal behaviour; remove image generation from the "Out of scope" list
- [ ] T040 [P] Update `docs/storage.md`: image generation requires storage and obeys the same upload limits
- [ ] T041 [P] Update `docs/security.md`: one row each for the provenance columns and the `media:["generate"]` action
- [ ] T042 [P] Append G1–G26 (spec) and P1–P24 (plan) to `docs/decisions.md` under a new `## 060 — Generated images in the media library` heading
- [ ] T043 Run the quickstart §10 leak check — `grep -rn "1024x1024\|1536x1024\|1024x1536\|b64_json\|output_format" src/ --include=*.ts --include=*.tsx | grep -v "openai-image"` — and confirm zero hits outside `src/server/llm/openai-image.ts` and its test (depends on T014)
- [ ] T044 Run the full gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, and fix anything that fails (depends on all prior tasks)
- [ ] T045 [HUMAN — needs a funded OpenAI key, a browser session signed in as an owner, and `pnpm dev`; this cannot run inside a pipeline phase] Perform the real-app walkthrough in quickstart.md once: generate an image, confirm the live-region announcements, the new tile with its badge and prompt, one new "Generated image" row in Settings → Usage, and that a signed-in editor sees no control anywhere on Media. Record the outcome (pass, with specifics, or fail) directly against quickstart.md's "Done when" checklist. If this window closes (e.g. no funded key is ever made available) mark this task as unachievable with that reason, rather than leaving it open indefinitely — do not write it as a before/after comparison against any state this feature changes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: T001 (Setup) feeds T009 only; everything else in Foundational can start immediately. Foundational **blocks** every user story.
- **User Stories (Phase 3–7)**: All depend on Foundational completion. US1 (Phase 3) must land before US2, US3, US4 and US5, because each of those phases' tests exercise assets or gates that T025 (`generateImage`) creates. Within that constraint, US2/US3/US4/US5 are independent of each other and may proceed in any order or in parallel.
- **Polish (Phase 8)**: Depends on all five user stories being complete.

### Within the Foundational Phase

- Schema (T002, T003) → migration (T004) → `NewMedia` (T005).
- Config (T006) → startup wiring (T008) and env-coverage (T009); config test (T007) can run alongside T006's implementation once the shape is drafted.
- Vocabulary (T010), provider interface (T011) and message map (T012) are independent of each other and of T013; the adapter (T014) depends on all three plus T013.
- Resolution (T016) depends on config (T006) and the provider interface (T011).
- Hold extraction (T017) and the usage recorder (T018, then T019, T020) each depend only on T011.
- Storage constant (T021), authorization (T022) and validation (T023) are independent of everything else in the phase except T023's dependency on T010.

### Within User Story 1

- T024 (media service) and T025 (generator service) must land before any test task (T026–T028) or UI task (T029–T031).
- T029 → T030 → T031 is a strict chain (action, then dialog, then page wiring).

### Parallel Opportunities

- All Setup tasks marked [P] (just T001).
- Within Foundational: T002/T003/T005, T006/T007, T010/T011/T012/T013, T018/T019, T021/T022/T023 can each run in parallel within their group.
- Within US1: T026, T027, T028 (all test files) can run in parallel once T025 lands.
- US2 (T032), US3 (T033) and US4 (T034) can be staffed in parallel once US1's checkpoint is reached.
- Within US5: T035, T036, T037 can run in parallel.
- Within Polish: T038–T042 can run in parallel; T043 and T044 are sequential gates; T045 is the final, human-only step.

---

## Parallel Example: Foundational Phase

```bash
# Launch independent vocabulary/interface/message tasks together:
Task: "Add IMAGE_ASPECTS, NO_REAL_PEOPLE etc. to src/server/llm/image-generation.ts"
Task: "Create ImageProviderRequest/Result/Provider and the registry in src/server/llm/image-provider.ts"
Task: "Create IMAGE_FAILURE_MESSAGES in src/server/llm/image-messages.ts"
Task: "Export kindOfError from src/server/llm/openai.ts"
```

## Parallel Example: User Story 1 tests

```bash
# Once generateImage exists, launch its test files together:
Task: "Integration tests for the happy path and refusals in tests/integration/media/generate.test.ts"
Task: "Provider-swap integration test in tests/integration/media/generate-provider-swap.test.ts"
Task: "Real-people prompt assertion in tests/integration/llm/image-prompt.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (schema, config, adapter, resolution, hold, ledger, auth, validation) — **blocks everything**.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run quickstart.md §1 and §6–§7; confirm an owner can generate an image end to end with the outcome announced.

### Incremental Delivery

1. Setup + Foundational → foundation ready, nothing user-visible yet.
2. Add US1 → test independently → this is SC-001, the MVP.
3. Add US2 → test independently → SC-002 confirmed, nothing new to build.
4. Add US3 and US4 (any order, can be parallel) → SC-003, SC-006, SC-008 confirmed.
5. Add US5 → SC-004, SC-009, SC-010 confirmed.
6. Polish: docs, secret-scan extension, full gate, and the one human-owned real-app walkthrough.

### Notes

- [P] tasks touch different files with no dependency on an incomplete task.
- Commit after each task or logical group, per this project's workflow guidance (the implement phase never auto-commits — leave nothing uncommitted).
- `pnpm db:check` must be green before any Foundational task depending on the schema (T005 onward) is considered complete.
- No task in this list makes a live provider call except T045, which is explicitly human-owned and out of every pipeline phase's reach.
