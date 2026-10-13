---

description: "Task list for Hold a project's tagline, description and website as project data"
---

# Tasks: Hold a project's tagline, description and website as project data

**Input**: Design documents from `specs/069-brand-profile-fields/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/{validation,services,prompt,ui}.md

**Tests**: Included. The spec's Test obligations and quickstart §3 require migration, validation,
authorization, audit, prompt-composition and UI tests as part of this entry — they are not optional here.

**Organization**: Tasks are grouped by user story (US1, US2, US3) from spec.md, in priority order, after
one shared Foundational phase that both P1 stories need.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet dependency)
- **[Story]**: US1, US2 or US3 — omitted for Setup, Foundational and Polish tasks
- File paths are exact, taken from plan.md's Project Structure and the contracts

## Path Conventions

Single Next.js application at the repository root: `src/`, `tests/`, `drizzle/`, `docs/`. No new
directory is introduced by this feature.

---

## Phase 1: Setup

No tasks. This feature adds no new project scaffolding, runtime dependency, infrastructure or
environment variable (plan.md Technical Context) — it extends files that already exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The schema, the shared validation modules and the unified project-column list that both
User Story 1 (storage/settings) and User Story 2 (generation) depend on.

**⚠️ CRITICAL**: No user story task can begin until this phase is complete.

- [X] T001 Add nullable `tagline`, `description`, `websiteUrl` text columns to `src/server/db/schema/projects.ts`, placed after `defaultVoiceProfileId` (data-model.md §1)
- [X] T002 [P] Add the `project_brand_update` value to the `membershipAction` pgEnum in `src/server/db/schema/audit.ts`, appended after `llm_credential_update` (data-model.md §2)
- [X] T003 Run `pnpm db:generate` to produce migration `0026` (one `ALTER TYPE … ADD VALUE` plus three `ALTER TABLE "projects" ADD COLUMN … text`, no data step), review the SQL by hand against data-model.md §3, commit it with its `meta/`/journal entries under `drizzle/`, and confirm `pnpm db:check` is green (depends on T001, T002)
- [X] T004 [P] Create `src/lib/validation/link.ts`: `LINK_URL_MAX`, `LINK_URL_LENGTH_MESSAGE`, `HTTP_LINK_MESSAGE`, `isHttpUrl`, `linkUrlSchema`, extracted verbatim from the existing rule in `src/lib/validation/voice.ts` (contracts/validation.md §1)
- [X] T005 Update `src/lib/validation/voice.ts`: `preferredLinks`'s `url` field imports `linkUrlSchema` from `./link.ts` in place of its inline check; confirm `src/lib/validation/voice.test.ts` passes unedited (depends on T004)
- [X] T006 Create `src/lib/validation/brand.ts`: `TAGLINE_MAX = 200`, `BRAND_DESCRIPTION_MAX = 1000`, `normaliseBrandLine`, `normaliseBrandText`, `taglineSchema`, `brandDescriptionSchema`, `brandWebsiteSchema` (the last built on `linkUrlSchema`) (contracts/validation.md §2; depends on T004)
- [X] T007 [P] Update `src/lib/validation/index.ts` to re-export `./link` and `./brand` (depends on T004, T006)
- [X] T008 [P] Create `src/server/dal/project-columns.ts` exporting the single `projectColumns` definition (data-model.md §4, P3)
- [X] T009 Update `src/server/dal/scope.ts` to import `projectColumns` from `./project-columns.ts` in place of its inline list; `ProjectScope["project"]` gains `tagline`, `description`, `websiteUrl` (depends on T001, T008)
- [X] T010 Update `src/server/dal/api-keys.ts`'s `findActiveKeyByHash` to import `projectColumns` from `./project-columns.ts` in place of its inline copy (depends on T008)
- [X] T011 Update `src/server/dal/projects.ts`: `ProjectRecord` and `ProjectSettingsPatch` gain `tagline`, `description`, `websiteUrl` as optional `string | null` keys (depends on T001)

**Checkpoint**: Schema, shared validation and the unified column list exist — User Story 1 and User
Story 2 can now proceed, in parallel if staffed.

---

## Phase 3: User Story 1 - An owner records what the brand is (Priority: P1) 🎯 MVP

**Goal**: An owner or admin can set the tagline, description and website in project settings, see them
persisted, and see one activity-log row per changed field.

**Independent Test**: Sign in as owner, fill the three fields, save, reload and see the values; open the
activity log and see one row per changed field naming the previous and new value (spec.md US1).

- [X] T012 [P] [US1] Write `src/lib/validation/brand.test.ts`: each field at its limit (200/1000/500) and one over, refused with that field's message; newline-collapsing for the tagline; paragraph-preserving normalisation for the description; whitespace-only input normalising to `null`; the website's accept/refuse table (contracts/validation.md §1-2) (depends on T006)
- [X] T013 [US1] Update `src/server/services/projects.ts`: `updateSettingsSchema` gains `tagline`, `description`, `websiteUrl` as `.optional()`; build the patch only from brand keys whose parsed value is `!== undefined`; inside the existing `scope.transaction(…, { lockProject: true })`, read `before = await tx.projects.get()` after the lock statement, perform the update, then write one audit row per field whose normalised value actually changed — in the fixed order tagline → description → website — with `action: "project_brand_update"`, `actorUserId: tx.membership.userId || null`, `details: { field, previous, next }` (contracts/services.md §1; depends on T006, T009, T011)
- [X] T014 [US1] Update `src/app/p/[projectSlug]/settings/actions.ts`: pass `tagline`, `description`, `websiteUrl` to `updateProjectSettings` only when the submitted `FormData` has that key, `undefined` otherwise (contracts/services.md §4; depends on T013)
- [X] T015 [US1] Update `src/app/p/[projectSlug]/settings/settings-form.tsx`: add a `Field` (tagline), a `TextareaField` (description, `minRows={4} maxRows={12}`) and a `Field` (website, `inputMode="url"`, `spellCheck={false}`) directly after "URL name" and before "Time zone", each labelled with hint text naming its limit from `src/lib/validation/{brand,link}.ts`, `disabled={!canEdit}`, `error={errors.<field>}`, no `maxLength`, no `type="url"` (contracts/ui.md §1-2; depends on T006)
- [X] T016 [US1] Update `src/app/p/[projectSlug]/settings/page.tsx`: pass `tagline`, `description`, `websiteUrl` from `scope.project` into `SettingsValues`, and change the header description to "The project's name, what the brand is, its time zone, and how new posts are approved and scheduled." (contracts/ui.md §4; depends on T009, T015)
- [X] T017 [US1] Update `src/app/p/[projectSlug]/settings/members/activity-list.tsx`: add `LABEL["project_brand_update"] = "changed the brand"`, add the missing `LABEL["llm_credential_update"] = "changed this project's model credential"`, and extend `detailSubject` to return the unquoted field name (`tagline`, `description`, `website`) for a `project_brand_update` row (contracts/ui.md §5)
- [X] T018 [US1] Update `src/app/p/[projectSlug]/settings/members/page.tsx`: extend its `detailSubject` matching to handle `project_brand_update` the same way as T017 (depends on T017)
- [X] T019 [P] [US1] Write `src/app/p/[projectSlug]/settings/members/activity-list.test.tsx`: assert every `membershipAction.enumValues` member has a `LABEL` entry, and that a `project_brand_update` row renders "changed the brand tagline" (depends on T017)
- [X] T020 [US1] Write `tests/integration/project-brand.test.ts` (owner/admin scenarios): three fields saved from empty record `previous: null`; changing only the tagline writes exactly one audit row and leaves the other two untouched; clearing the website writes one row recording the previous link; a save with no brand change writes no brand row; an invalid website, an over-length tagline and an over-length description are each refused with that field's error, nothing written, no audit row; a set → cleared → set round-trip writes a row at each step; two concurrent saves record a truthful `previous` chain (not a stale one); a slug conflict leaves the tagline unchanged and writes no brand row; `assertAuditDetailsSafe` accepts all three fields' `details` (contracts/services.md §1-3; depends on T013)
- [X] T021 [P] [US1] Update `src/app/p/[projectSlug]/settings/settings-form.test.tsx`: for an owner, render the three new fields with their current values, editable, and surfacing field errors (depends on T015)
- [X] T022 [P] [US1] Update `tests/integration/terminology/page-headers.test.tsx` with the new settings page header description (depends on T016)
- [X] T023 [P] [US1] Update `tests/integration/notifications/ui.test.tsx` with the same new header description (depends on T016)

**Checkpoint**: User Story 1 is fully functional and testable independently of generation.

---

## Phase 4: User Story 2 - A generated post can say what the product is and link it (Priority: P1)

**Goal**: Every generation entry point composes a labelled `BRAND` section, before `VOICE`, from
whichever brand fields are set, and emits nothing when none are.

**Independent Test**: Build prompts for every combination of set/unset brand fields and assert the
composed system prompt's brand section, position and content; assert byte-identical output to the
recorded golden prompts for the all-unset case (spec.md US2).

- [X] T024 [US2] Update `src/server/services/generation/prompt.ts`: add the `BrandContext` interface, an optional `brand?: BrandContext | null` on `PromptInput` and on the series-plan input, `brandOf(project)` returning `null` when every value is empty, a `BRAND` section (tagline → description → website, blank-line-joined, only the set values, no placeholders) positioned immediately before `VOICE`, and one conditional `OUTPUT RULES` bullet between the alt-text rule and the posting-instructions rule (contracts/prompt.md §1,3,4; depends on T011)
- [X] T025 [US2] Update `src/server/services/generation/core.ts`: add `brand: brandOf(scope.project)` to the `base` object `buildGenerationPrompt` consumes (contracts/prompt.md §2; depends on T024)
- [X] T026 [US2] Update `src/server/services/generation/series.ts`: add `brand: brandOf(scope.project)` to `planSeries`'s `base` object that `buildSeriesPlanPrompt` consumes (contracts/prompt.md §2; depends on T024)
- [X] T027 [P] [US2] Extend `src/server/services/generation/prompt.test.ts`: all eight set/unset combinations render the right lines in the right order with no placeholders; `BRAND` precedes `VOICE` precedes `POSTING INSTRUCTIONS` precedes `PLATFORM RULES`; the output-rules bullet appears iff the section does; a brand with an entirely empty voice profile emits no `VOICE` header; a brand website alongside a voice `preferredLinks` entry shows both, in their own sections; a series-plan prompt carries the same section in the same position; a description containing `</source_material>` leaves exactly one `<source_material>` pair intact (contracts/prompt.md §6; depends on T024, T025, T026)
- [X] T028 [US2] Run `pnpm vitest run src/server/services/generation/prompt.golden.test.ts` and confirm it passes with `__fixtures__/cases.ts` and `__fixtures__/pre-011-prompts.json` unedited, and that `__snapshots__/prompt.test.ts.snap`'s existing entries stay unedited — the all-unset case must remain byte-identical (FR-027, SC-003; depends on T024, T025, T026)
- [X] T029 [P] [US2] Write `tests/integration/generation/brand-context.test.ts`: for a project with brand fields set, assert the composed prompt carries the `BRAND` section for a single generation, a regenerate, voice "Try it", a batch job item and a series plan (FR-029, SC-002; depends on T025, T026)

**Checkpoint**: User Story 1 and User Story 2 both work, independently of each other and of US3.

---

## Phase 5: User Story 3 - An editor can read the brand but not change it (Priority: P2)

**Goal**: An editor sees the brand fields, disabled, and any hand-built save attempt is refused
server-side with nothing written.

**Independent Test**: As an editor, load the settings page and see values/disabled inputs/the existing
note/no save button; separately call the settings save with brand values and assert it is refused and
nothing is written (spec.md US3).

- [X] T030 [US3] Extend `src/app/p/[projectSlug]/settings/settings-form.test.tsx`: for an editor, assert the three brand fields render their current values, disabled, under the existing owner/admin note, with no save button (depends on T015, T021)
- [X] T031 [US3] Extend `tests/integration/project-brand.test.ts`: an editor's hand-built save (including brand values) is refused server-side with nothing written and no audit row; an admin's save naming another project is refused and that project's brand values are unchanged (depends on T013, T020)

**Checkpoint**: All three user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and the whole-repository checks that prove nothing else moved.

- [ ] T032 [P] Record decision **058 — A project's tagline, description and website** in `docs/decisions.md`: B1-B14 and P1-P28, stating how brand context and the voice profile are ordered, why, and exactly what an empty field does (FR-033)
- [ ] T033 [P] Update `docs/generator.md`: add a **Brand context** section (the three fields, who may set them, how they reach a post) and update the existing "Prompt order" paragraph in place to state the distinction between the brand's website and a voice profile's preferred links (FR-034)
- [ ] T034 [P] Run `pnpm vitest run tests/integration/api` and confirm the generated API document and every API test are unchanged (FR-038, SC-008)
- [ ] T035 Run the final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` (depends on all prior tasks)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: no dependency on Setup; BLOCKS User Story 1 and User Story 2
- **User Story 1 (Phase 3)**: depends on Foundational; independent of User Story 2
- **User Story 2 (Phase 4)**: depends on Foundational; independent of User Story 1
- **User Story 3 (Phase 5)**: depends on Foundational and on the service/UI changes User Story 1 makes (T013, T015), since it tests the refusal of the same write path and the disabled rendering of the same form
- **Polish (Phase 6)**: depends on all desired user stories being complete

### Within Each Phase

- Schema before migration generation (T001, T002 → T003)
- `link.ts` before `brand.ts` and before `voice.ts`'s edit (T004 → T005, T006)
- Validation barrel after both new modules (T004, T006 → T007)
- `project-columns.ts` before its two importers (T008 → T009, T010)
- Service changes before the action, the form's data flow, and all service-level tests (T013 → T014, T016, T020, T031)
- Prompt composer changes before its two call sites and all prompt tests (T024 → T025, T026 → T027, T028, T029)

### Parallel Opportunities

- T002, T004, T007, T008 can run in parallel with each other and with T001 (different files, no shared dependency within the pair)
- T012, T019, T021, T022, T023 (US1 tests, different files) can run in parallel once their respective implementation tasks land
- T027, T029 (US2 tests, different files) can run in parallel once T024-T026 land
- T032, T033, T034 (Polish, different files/no code dependency) can run in parallel

---

## Parallel Example: Foundational phase

```bash
# After T001 (schema) lands, these can proceed together:
Task: "Add project_brand_update to membershipAction enum in src/server/db/schema/audit.ts"
Task: "Create src/lib/validation/link.ts"
Task: "Create src/server/dal/project-columns.ts"
```

## Parallel Example: User Story 1 tests

```bash
Task: "Write src/lib/validation/brand.test.ts"
Task: "Write src/app/p/[projectSlug]/settings/members/activity-list.test.tsx"
Task: "Update tests/integration/terminology/page-headers.test.tsx"
Task: "Update tests/integration/notifications/ui.test.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (schema, migration, shared validation, unified column list)
2. Complete Phase 3: User Story 1 — the brand has a durable, auditable home
3. **STOP and VALIDATE**: run `tests/integration/project-brand.test.ts` and the settings-form test; sign in as owner and walk quickstart.md §2 steps 1-6
4. Deploy/demo if ready — the brand already has value before any post reads it

### Incremental Delivery

1. Foundational → User Story 1 (MVP: brand is stored and audited)
2. User Story 2 (brand reaches every generated prompt) — independent of US1's UI, can be built in parallel by a second contributor once Foundational lands
3. User Story 3 (editor refusal proven) — rides US1's write path and form, so it follows US1
4. Polish — docs and the whole-repository checks

### Parallel Team Strategy

With two contributors: one takes Foundational, then User Story 1; the other takes User Story 2 once
Foundational's schema and `dal/projects.ts` land (T001, T009, T011), since generation only needs
`scope.project` to carry the three columns, not the settings UI. User Story 3 waits for User Story 1's
service and form changes.

---

## Notes

- `[P]` tasks touch different files with no unmet dependency.
- `[US1]`/`[US2]`/`[US3]` map each task to its user story for traceability.
- `prompt.golden.test.ts`, `__fixtures__/cases.ts`, `__fixtures__/pre-011-prompts.json` and the existing
  entries in `__snapshots__/prompt.test.ts.snap` are **never edited** by this feature (T028) — that is
  the point of `brand` being optional (research.md P17).
- `src/lib/validation/voice.test.ts` is **never edited** by this feature (T005) — it is the proof the
  shared link-rule extraction changed no preferred-link behaviour (FR-031).
- No task touches `src/server/auth/access.ts` or anything under `src/server/api/` (FR-038, SC-008).
