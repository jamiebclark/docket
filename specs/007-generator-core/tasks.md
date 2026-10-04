---

description: "Task list for the generator core (007)"
---

# Tasks: Generator core (LLM layer, voice profiles, single and series generation, approval policy, review queue)

**Input**: Design documents from `/specs/007-generator-core/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R4, D1–D27), data-model.md, contracts/ (llm, prompt, services, ui), quickstart.md

**Tests**: Requested by the spec (FR-036). Every test is Vitest (`pnpm vitest run <path>`) against real Postgres (the existing harness, per-worker DB clones) with the **fake LLM** (`tests/helpers/fake-llm.ts`) or the **fake transport** (`tests/helpers/fake-llm-http.ts`). **No test makes a live model call** (FR-004). Every task below is executable headless (`pnpm vitest run`, `pnpm typecheck`, `pnpm lint`, `pnpm db:generate`, `pnpm db:check`, `pnpm build`); nothing needs a browser, a dev server or the network. UI behaviour is checked by rendering server components and calling server actions in Vitest, in the style of the existing `tests/integration/accounts-ui.test.ts`. Use the DB clock, never sleeps. The only human-owned task is the live latency measurement (T079), marked `🛑 BLOCKED:`.

**Organization**: Grouped by user story. The LLM layer with OpenAI, the migration, the data-access layer, the posts-service changes, prompt/schema/core and the approval-policy service are Foundational because every story calls them. Anthropic, which is delivered second, lives in US6.

**Rules for every task**:

- Read the named contract/research section before the task. Read `node_modules/next/dist/docs/01-app/` (Server Actions, `redirect`, `loading.tsx`, `error.tsx`) before touching route or action code (AGENTS.md). Read the `docket-ui` skill before any task under `src/app` or `src/components`.
- **No new dependency** (decision #19). If one seems needed, mark the task `NEEDS DEPENDENCY: <pkg>` and continue.
- **No model id literal in `src/`** (T010 greps for one). The fake gets its model name from the test.
- No provider call inside a held DB transaction: model calls and variant building run before `scope.transaction`.
- Keys never appear in prompts, metadata, logs, errors, action results or snapshots (FR-035).
- Commit with conventional commits and explicit paths, in small commits (e.g. `feat(llm): …`, `feat(generation): …`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 (spec.md)

## Phase 1: Setup

**Purpose**: baseline and skeleton

- [X] T001 Run `pnpm typecheck` and `pnpm vitest run tests/integration/posts tests/integration/compose tests/lint src/providers` to record a green baseline; confirm `pnpm install --offline` is a no-op and that `openai`, `@anthropic-ai/sdk`, `zod`, `sharp` and `esbuild` are already in `package.json`. Add nothing
- [X] T002 [P] Create typed stub files exporting the names planned in plan.md § Source Code so later tasks compile: `src/server/llm/{types,config,messages,log,openai,anthropic,images,image-generation,index}.ts`, `src/server/services/generation/{prompt,schema,core,policy,single,series,regenerate,failures,index}.ts`, `src/server/services/{review,voice}.ts`. Do NOT export anything from `src/server/services/index` yet and do not wire any route

---

## Phase 2: Foundational (blocking prerequisites for every story)

**Purpose**: LLM layer with OpenAI, test fakes, migration `0004`, data-access layer, posts-service changes, prompt/schema/core, policy service.

**⚠️ CRITICAL**: no user story work starts until this phase is complete. Existing posts, compose, scheduler and queue tests must keep passing with unchanged expectations.

### LLM layer (contracts/llm.md)

- [ ] T003 Implement `src/server/llm/types.ts` exactly as in contracts/llm.md § Types (`LlmProviderName`, `LlmImage`, `LlmRequest`, `LlmUsage`, `LlmFailureKind`, `LlmResult`, `LlmProvider`), `src/server/llm/messages.ts` (the fixed sentence per failure kind, table in contracts/llm.md) and `src/server/llm/image-generation.ts` (interface only, FR-020). Add `src/server/llm/image-generation.test.ts` asserting the module has no runtime exports (`Object.keys(await import(...))` is empty) and `src/server/llm/messages.test.ts` asserting all eight kinds have a message
- [ ] T004 `src/server/llm/config.ts`: `parseLlmConfig(source)` per contracts/llm.md § Configuration (unset → exactly one problem "LLM_PROVIDER: not set; generation is disabled"; unknown provider "must be openai or anthropic"; required key named; `LLM_TIMEOUT_SECONDS` 10–600 default 90; `LLM_MAX_OUTPUT_TOKENS` 256–32,000 default 4000; the key of the unselected provider ignored; no value ever appears in a message). Write `src/server/llm/config.test.ts` covering each rule, including that a fake key string never occurs in `JSON.stringify(problems)`
- [ ] T005 [P] `src/server/llm/log.ts`: `logLlmCall({ provider, model, label, latencyMs, outcome, usage })` writes one line with fixed fields only, through the existing `redact()`. Write `src/server/llm/log.test.ts` that spies on the logger and asserts a fake key, system text, user text and raw text passed in the call input never appear in the output (research D6)
- [ ] T006 [P] Create `tests/helpers/fake-llm.ts` (`createFakeLlm(steps, opts)` with `requests`, `remaining()`, steps `{ ok } | { raw } | { fail }`, running out of steps throws; the fake runs the same `schema.safeParse` the real providers run) and `tests/helpers/fake-llm-http.ts` (`createFakeLlmFetch(responses)` recording `{ url, body }`, replaying in order, honouring `signal` with an `AbortError`) per contracts/llm.md. Write `tests/helpers/fake-llm.test.ts` self-tests: ordered replay, invalid `raw` JSON → `invalid_output` with `rawText`, a scripted value that breaks the schema → `invalid_output`, exhausted steps throw, `requests` records label/system/user/images/schemaName, abort honoured by the fake fetch
- [ ] T007 `src/server/llm/images.ts` plus `ensureVariant(scope, asset, constraints)` exported from `src/server/services/media-variants.ts` (reuses `buildVariant`; provider variants unchanged): `LLM_IMAGE_CONSTRAINTS`, `LLM_REQUEST_IMAGE_BUDGET_BASE64`, `imagesForModel` per contracts/llm.md § Model-input images (plan with `planImage`; URL mode only for a public `https:` host that is not localhost, `*.localhost`, an IP literal or `*.local`; otherwise bytes via `storage.get`; budget check; "Media storage is not set up." when storage is missing). Write `src/server/llm/images.test.ts` (against real Postgres and the existing in-memory/local storage test setup): oversized PNG becomes a cached `media_variants` row and a second call reuses it; localhost/signed storage → bytes; public https → url; over-budget set refused with the image named; refusal message contains no URL or key. Re-run `pnpm vitest run tests/integration/media` unchanged
- [ ] T008 `src/server/llm/openai.ts` (`createOpenAiProvider(cfg, { fetch? })`): Responses API with `zodTextFormat(schema, schemaName)` as `text.format`, `instructions` for system, one user message of `input_image` parts (`detail: "auto"`) then `input_text`, `max_output_tokens`, client `{ apiKey, timeout, maxRetries: 2, fetch }`, per-call `signal` merged with `AbortSignal.timeout`. Read raw text from `output_text`, `JSON.parse` + `schema.safeParse` yourself (never `.parse()`), detect `refusal` content and `status === "incomplete"` before parsing, map SDK error classes per research D3, `performance.now()` latency around the whole call, call `logLlmCall`. Write `tests/helpers/llm-scenarios.ts` (the shared scenario table from quickstart §1: request body shape, valid answer with usage and latency, bad JSON → `invalid_output` with `rawText`, refusal, incomplete, 429, 500, 401, 400, timeout with the fixed message, key absent from logs, non-https URL image throws) and `src/server/llm/openai.test.ts` running the table against the fake transport with `maxRetries` 0 and a fake key that must not appear in any result or log
- [ ] T009 `src/server/llm/index.ts`: `getLlmStatus()`, `getLlm()` (throws `LlmNotConfiguredError` with the message "Generation is not configured. Set: LLM_PROVIDER, LLM_MODEL, OPENAI_API_KEY." naming only missing settings), `setLlmForTests` (throws unless `NODE_ENV === "test"`), `createOpenAiProvider`, `createAnthropicProvider` (the latter may still be the T002 stub, completed in T067). In `src/lib/action-result.ts` add `LlmNotConfiguredError` → `conflict` and `PolicyNotAllowedError` → `forbidden` to `ERROR_NAME_TO_CODE` and to the keeps-message list; extend that file's existing test. In `src/server/startup/index.ts` log `Docket: generation disabled (<NAME>: <reason>; …)` and continue, never exit; extend the tests under `tests/startup/` (incomplete group → logged, startup resolves). Write `src/server/llm/index.test.ts` for status/selection/test seam
- [ ] T010 [P] Write `src/server/llm/no-model-literal.test.ts`: recursively read `src/**/*.{ts,tsx}` (excluding `*.test.ts`) and assert no match for a regex of known model-id shapes (`gpt-`, `claude-`, `o[134]-`, `chatgpt-`) outside comments; this also guards FR-003

### Database (data-model.md)

- [ ] T011 Add `src/server/db/schema/generation.ts` (`generation_mode` and `llm_failure_kind` enums; tables `voice_profiles`, `voice_profile_versions`, `generation_series`, `generation_failures` with every constraint, composite FK and index in data-model.md) and export it from `src/server/db/schema/index.ts`. Edit `src/server/db/schema/posts.ts` (add `rejected` to `post_review_state` and `post_status`; columns `generation_request_id`, `scheduling_policy`, `series_id`, `series_position`, `reviewed_by_user_id`, `reviewed_at`, `rejection_reason`; the two partial unique indexes, the series CHECK and the review-queue index) and `src/server/db/schema/projects.ts` (`default_voice_profile_id` with composite FK `(id, default_voice_profile_id)` → `voice_profiles(project_id, id)`). Add the four tables to `src/server/db/project-owned.ts`
- [ ] T012 Run `pnpm db:generate` to produce `drizzle/0004_*.sql` and its meta files, then open the SQL and confirm: `ALTER TYPE … ADD VALUE` statements do not use the new value anywhere in the same migration (research D19), the partial unique indexes carry their `WHERE` clauses, the composite FKs exist. Run `pnpm db:check` ("Migrations are current") and `pnpm vitest run tests/integration/auth-schema.test.ts tests/integration/bootstrap.test.ts` to prove the migration applies on a clean database
- [ ] T013 Data-access layer: create `src/server/dal/voice.ts` (profiles repo, and a versions repo with `insert`, `get`, `getByNumber`, `listForProfile` and **no update or delete**), `src/server/dal/series.ts`, `src/server/dal/generation-failures.ts`; wire `voiceProfiles`, `voiceVersions`, `series`, `generationFailures` through `buildScope` in `src/server/dal/scope.ts` and expose `project.defaultVoiceProfileId`; in `src/server/dal/posts.ts` map the new columns and add the review-queue query (newest first, 50 per page, `needs_review`, not deleted), `findByRequestId`, `findBySeriesPosition`; add `PolicyNotAllowedError` (message-carrying, `field`) to `src/server/dal/errors.ts`. Every query carries `project_id`
- [ ] T014 [P] `src/server/auth/access.ts`: add statements `voice: ["view","manage"]` and `generation: ["run","auto_approve"]`; owner and admin get all, editor gets `voice:view` and `generation:run`, viewer-type roles get none. Extend `tests/integration/permissions.test.ts` with the role × statement rows
- [ ] T015 [P] Create `src/lib/validation/voice.ts` (`voiceContentSchema` with every limit in data-model.md: trimmed strings, ≤10 examples, ≤20 links with http(s) URL, ≤30 normalised de-duplicated hashtags, `platformGuidance` keys limited to registered provider keys, empty entries dropped) and `src/lib/validation/generation.ts` (`GenerationInputs`, `GenerationRecord`, `generationMetadataSchema`, approval/scheduling policy schemas reused from existing validation). Write `src/lib/validation/voice.test.ts` and `generation.test.ts` for limits, normalisation and rejecting unknown platform keys
- [ ] T016 Extend `tests/helpers/factories.ts` with `createVoiceProfile(projectId, { content?, versions? })` (writes v1..n through the DAL, sets the project default when first), `createPostInReview(...)` (a generated post with a valid generation record, `needs_review`, a remembered `scheduling_policy`, one target per account with `override_text`), and `createGeneratedFixture` helpers used by later tests. Extend the scope registry test (`tests/helpers/scope-check.ts` consumers) so a query on any of the four new tables without `project_id` fails; run `pnpm vitest run tests/integration` for the isolation tests and confirm they stay green

### Posts-service changes (contracts/services.md § Posts service changes)

- [ ] T017 Extract `queueTargetsInTx(tx, post, targets, opts?)` in `src/server/services/posts/index.ts`: move the body of `addToQueue` after `lockPost` into the exported function, make `addToQueue` call it, change no behaviour. Run `pnpm vitest run tests/integration/posts tests/integration/accounts-slots.test.ts tests/integration/calendar.test.ts` with **no test edits** (research D15)
- [ ] T018 In `src/server/services/posts/` (`index.ts`, `validate.ts`, `list.ts`): narrow `validateTargetContent`'s `account` parameter to `Pick<AccountRecord, "providerKey">` (type only); make `queueableGate` refuse `reviewState === "rejected"` with "This post was rejected."; accept `rejected` in `REVIEW` and `createSchema`; make `setReviewState` refuse `rejected`; add optional `generationRequestId`, `schedulingPolicy`, `seriesId`, `seriesPosition` to `createSchema` (generation service only); `listPosts` accepts `status: "rejected"` and `counts()` includes it. Add `rejected` (neutral grey, text "Rejected") to `src/components/ui/StatusBadge.tsx` and extend its test. Write `tests/integration/posts/rejected-gate.test.ts`: a rejected post cannot be queued, given an explicit time, or published now, and the existing posts tests are unchanged

### Prompt, schema and core (contracts/prompt.md, services.md § Generation core)

- [ ] T019 [P] `src/server/services/generation/prompt.ts`: `platformRulesFor`, `buildGenerationPrompt`, `buildSeriesPlanPrompt`, `describeProblems` as in contracts/prompt.md (fixed section order, empty voice fields have no heading, guidance only for targeted platforms, `<source_material>` with the closing tag neutralised, series and retry sections, 20,000-char truncation of the previous output). Write `prompt.test.ts` beside it: section order, omitted sections, per-platform limit/counting note/media rule from the real registry, source-text injection stays inside the block, retry lists problems, a stable `toMatchSnapshot` for one full prompt
- [ ] T020 [P] `src/server/services/generation/schema.ts`: `generationOutputSchema(providerKeys, imageCount)`, `seriesPlanSchema`, `checkGenerationOutput` (empty text, per-variant `validateTargetContent` with `preview: true` and errors only, alt-text count and length), `checkSeriesPlan` (count, title/description lengths, duplicate titles after case-folding) with the exact problem texts in contracts/prompt.md. Write `schema.test.ts`: one key per targeted platform, all properties required, and `z.toJSONSchema` output contains no `maxLength`, `minItems` or `anyOf`; each check's problem text; warnings never block
- [ ] T021 `src/server/services/generation/core.ts`: `runGeneration(scope, req, llm?)` implementing the algorithm in contracts/services.md § Generation core (images via `imagesForModel` before any call, throwing `ConflictError` on failure; call 1; retry only for `invalid_output | refused | incomplete | timeout` or blocking problems; call 2 with `retry: { previousOutput, problems }`; never a third call; non-retryable kinds return immediately). Write `core.test.ts` with the fake LLM, asserting `requests.length` and `remaining()` in every case: valid → 1 call; Bluesky 312 graphemes then valid → 2 calls and the second user prompt contains "bluesky: Text is 312 graphemes; the limit is 300."; invalid twice → ok with `remainingProblems`; unreadable twice → `ok:false`; refusal then valid → 2; timeout twice → `timeout`; `rate_limited` → 1 call, no retry; image preparation failure → throws before any call (0 requests)
- [ ] T022 `src/server/services/generation/policy.ts`: `decidePolicy` (the 8-row matrix in contracts/services.md; any blocking issue → `needs_review`, `queue:false`, reason "Forced to review: {first message}"), `resolvePolicies(scope, req)` (defaults from `scope.project`; an `auto_approve` override that differs from the default needs `generation:auto_approve` else `PolicyNotAllowedError("Only owners and admins can auto-approve")` with `field: "approval"`; resolved auto + queue without `confirmUnreviewedQueue === true` throws a validation error on `confirmUnreviewedQueue` with "Confirm that posts will be approved and queued without review."), `applyApprovalPolicy(scope, postId, resolved)` (prepareVariants outside a transaction; lock; refuse unless `needs_review`; only `validation` failures from `gate()` are blocking; approve with `reviewed_by_user_id = NULL`; call `queueTargetsInTx` when queueing; `applyDerivedStatus`; write the decision into the latest generation record). Write `policy.test.ts` for `decidePolicy` (every row including a blocking row for each policy pair) and `resolvePolicies` (editor refused, editor with an auto-approve default allowed, owner/admin any combination, missing confirmation refused, nothing mutated on the project)
- [ ] T023 [P] `src/server/services/generation/failures.ts`: `recordFailure(scope, ...)` (fixed message, attempts, inputs; no prompt and no key) and `listRecentFailures(scope, { limit ≤ 20 })` (needs `post:view`). Write `failures.test.ts`: a failure row has inputs and kind, a fake key in the inputs path never appears, a member of another project sees none
- [ ] T024 Add `src/server/services/generation/index.ts` re-exports; write `tests/lint/generation-imports.test.ts` (or extend `tests/lint/worker-bundle.test.ts`) asserting the worker bundle graph does not import `src/server/llm` or `src/server/services/generation`; run `pnpm vitest run tests/lint` and `pnpm typecheck`

**Checkpoint**: LLM layer (OpenAI), fakes, schema, DAL, policy service and generation core are done and tested. User stories can now start.

---

## Phase 3: User Story 1 - Generate a single post for several accounts (Priority: P1) 🎯 MVP

**Goal**: An editor picks a voice profile, writes a brief, picks accounts on several platforms and optionally an image; Docket returns one saved post in review (or policy-applied) with one variant per platform, which can be edited and regenerated.

**Independent Test**: With the fake LLM scripted valid, generate for a Bluesky and a Facebook account with an attached image: one post, origin `generated`, one target per account whose content is its platform variant, image attached, complete generation metadata; the fake received the voice fields, instructions, brief, source text, each platform's limit and counting rule, and the image.

### Tests for User Story 1

- [ ] T025 [P] [US1] `tests/integration/generation/single.test.ts` (fake LLM, real Postgres): Bluesky + Facebook + one image → one post with origin `generated`, `review_state` per project policy, two targets each with its own `override_text`, image attached to image-capable targets, complete `generation_metadata` (prompt, provider, model, voice profile id and version, inputs, usage, per-attempt latency, retried, policies); two accounts on one platform → one variant key in the fake's schema and both targets use it; the same `requestId` twice → one post and `existing: true`; a first answer over the Bluesky limit then valid → 2 calls and a valid post; unreadable twice → `ok:false`, a `generation_failures` row, no post; invalid twice → post saved in review with `remainingProblems`; alt text fills only an empty asset alt text; a voice profile edited mid-call is recorded at the version taken at start; a member removed during the call has the save refused; cross-project profile/account/media id → `NotFoundError`; archived profile refused; over-length brief/instructions/source text refused before any call (0 fake requests); a fake key never appears in the stored metadata or failure row
- [ ] T026 [P] [US1] `tests/integration/generation/regenerate.test.ts`: regenerate appends a second record and keeps the first; content replaced; uses the profile's current version; extra instruction recorded as a separate line in inputs; an invalid result moves an approved/draft post to review; the post is never approved or scheduled by regenerate; refused with "Unschedule this post before regenerating." when a target is scheduled; refused for a post without a generation record; a failed regenerate writes a failure row with `post_id` and leaves the post unchanged
- [ ] T027 [P] [US1] Render tests `src/app/p/[projectSlug]/generate/generate.test.tsx` in the style of `tests/integration/accounts-ui.test.ts`: not-configured state names the missing settings (set via `setLlmForTests(null)` and env), no-voice-profile state differs for owner/admin versus editor, no-accounts state links to Accounts, populated state preselects the default profile and shows account status badges, the Instagram-needs-an-image warning appears only with an Instagram account and no image, double-submit button is disabled and reads "Generating…" while pending, a model failure shows the plain message and "Try again" with a new `requestId`

### Implementation for User Story 1

- [ ] T028 [US1] `src/server/services/generation/single.ts`: `generateSingleSchema` and `generateSingle(scope, input, llm?)` exactly per contracts/services.md § Single mode (need `generation:run` + `post:edit`; `resolvePolicies` before any call; media count check against the most permissive platform's `maxImages`; existing-request short-circuit; profile must be non-archived; current version taken at that moment; `runGeneration`; on failure insert the failure row; one transaction with `need(tx, …)` re-check inserting the post with origin `generated`, `review_state = needs_review`, `scheduling_policy`, `generation_request_id`, per-platform `override_text`, media, `{ v: 1, records: [record] }` and filling empty alt texts; unique violation on `generation_request_id` returns the existing post; then `applyApprovalPolicy`). No model call inside the transaction
- [ ] T029 [US1] `src/server/services/generation/regenerate.ts`: `regeneratePost(scope, postId, input, llm?)` per contracts/services.md § Regenerate and research D21 (replace content, append a record, never approve or schedule, force review on blocking problems)
- [ ] T030 [P] [US1] Add `updatePostVariants(scope, postId, { edits })` to `src/server/services/posts/index.ts` (sets `override_text` on every live target of each provider via the existing `updatePost` and its validation path) with a test in `tests/integration/posts/update-variants.test.ts`: all targets of one provider updated, other providers untouched, blocking problems returned, a scheduled target is not edited
- [ ] T031 [US1] `src/app/p/[projectSlug]/generate/actions.ts` (`"use server"`): `generateSingleAction`, `regenerateAction`, `updatePostVariantsAction`, each through `runAction(slug, fn)` returning `ActionResult<T>`. Add their rows (owner, admin, editor, non-member → `not_found`) to `tests/integration/actions-authz.test.ts`; assert in a test that no action result contains the fake key
- [ ] T032 [US1] Generate page: `src/app/p/[projectSlug]/generate/page.tsx` (server component: non-archived profiles with default preselected, accounts with status, project default policies, `getLlmStatus()`, recent failures from `listRecentFailures`), `loading.tsx`, `GenerateForm.tsx` (client leaf; fields in the order in contracts/ui.md § Generate form with labels, `aria-describedby` help text, counters `n / 2,000` / `n / 50,000`, accounts grouped by platform, `MediaPicker` limited by the most permissive selected platform, the Instagram image warning, hidden `requestId` UUID made on mount and renewed after a completed request, right-aligned **Generate** button disabled while pending, inline error with **Try again**), a mode-tabs link row (`?mode=single` default, `?mode=series` handled in US5). Remove the `generate` placeholder from `src/app/p/[projectSlug]/[section]/page.tsx`. Policy overrides are added in US4; for now the form sends no overrides. Make T027 pass
- [ ] T033 [US1] Result page: `src/app/p/[projectSlug]/generate/result/[postId]/page.tsx` + `loading.tsx` (not found; populated with the decision shown as text such as "In review: Forced to review: Instagram needs an image" or "Approved and queued: …" in the project time zone via `LocalTime`; scheduled/published hides Regenerate with "Unschedule to regenerate"; generation details in a `<details>`: provider, model, voice profile name and version, latency per attempt, retried yes/no and reason), `VariantEditor.tsx` (one card per platform: accounts, textarea, `used / limit` from the existing compose-check route debounced 300 ms, issue list with "Error:" text prefix, **Save**), `RegenerateDialog.tsx` (optional extra instruction ≤ 2,000, primary **Regenerate**). Add a render test `src/app/p/[projectSlug]/generate/result/result.test.tsx` for the four states and the debounced count call
- [ ] T034 [US1] Run `pnpm vitest run src/server/services/generation tests/integration/generation src/app/p/[projectSlug]/generate tests/integration/actions-authz.test.ts` and `pnpm typecheck && pnpm lint`; fix failures. Record in the commit message that US1 is independently shippable (single mode works end to end with the fake LLM)

**Checkpoint**: single-post generation, edit and regenerate work and are tested. This is the MVP.

---

## Phase 4: User Story 2 - Edit voice profiles and tune them with "Try it" (Priority: P1)

**Goal**: Owners and admins create, version, default, archive and restore voice profiles; everyone can view history; a Try it panel generates samples without writing anything.

**Independent Test**: Create a profile (v1), set it default, edit tone (v2); v1 is unchanged and readable, current version is 2, an earlier post still names v1. Try it with unsaved edits returns samples and writes no row anywhere.

### Tests for User Story 2

- [ ] T035 [P] [US2] `tests/integration/voice/voice.test.ts`: create → v1 and the first profile becomes the project default; edit → v2 with v1's `content` byte-identical (`JSON.stringify` equality); stale `baseVersion` → `ConflictError("This profile changed since you opened it")` and no write; a save equal to the current content and name is a no-op returning the current version; rename alone creates a new version; archiving the default is refused ("Make another profile the default first"); setting an archived profile as default refused; archived profile hidden from the generate list and its versions still readable and still named by posts that used them; restore with a name clash → "A profile with this name already exists"; case-insensitive duplicate name among non-archived refused; editors get `ForbiddenError` for create/save/default/archive/restore but can list, get, view history and a version; non-members and other projects → `NotFoundError`; two concurrent saves from the same `baseVersion` → exactly one succeeds
- [ ] T036 [P] [US2] `tests/integration/voice/try-it.test.ts`: with the fake LLM, Try it returns one variant per chosen platform with counts, limits and issues plus latency; a row-count diff over **all** project-owned tables and `posts`/`post_targets`/`media_*` before and after is zero (SC-007); an owner's unsaved draft content is used in the prompt; an editor's draft is ignored and the saved `versionId` is used; a failed call returns the plain message and writes nothing; no more than two calls
- [ ] T037 [P] [US2] Render tests `src/app/p/[projectSlug]/voice/voice.test.tsx`: list empty state differs for owner/admin and editor; populated table shows name, default badge, current version, updated time in the project zone, actions only for owner/admin; archived filter link; editor sees the editor read-only with no Save/Make default/Archive; owner sees the conflict banner "This profile changed since you opened it" with "View version N" and "Reload" and the typed values are kept; the Try it caption "Samples are not saved." is present; history table lists number, author, time and shows a selected version read-only; `/voice/new` is not found for an editor

### Implementation for User Story 2

- [ ] T038 [US2] `src/server/services/voice.ts`: `listVoiceProfiles`, `getVoiceProfile`, `listVersions`, `getVersion`, `createVoiceProfile`, `saveVoiceProfile`, `setDefaultVoiceProfile`, `archiveVoiceProfile`, `restoreVoiceProfile` per contracts/services.md § Voice profiles and research D22–D23 (project lock via `transaction(…, { lockProject: true })` for default/archive; optimistic `baseVersion`; permission checks via `scope.can` and again inside the transaction; Zod-parsed `unknown` input; content validated by `voiceContentSchema` on write and read)
- [ ] T039 [US2] `tryVoice(scope, input, llm?)` in `src/server/services/voice.ts` per research D24: needs `voice:view` and `generation:run`; owners/admins may pass `draft` content, others only a saved `versionId`; builds the prompt with `platformRulesFor`, uses `runGeneration`'s checks, returns `{ variants: { providerKey, text, count, limit, countingRule, issues }[], latencyMs }`; performs **no database write** of any kind (no failure row either)
- [ ] T040 [US2] `src/app/p/[projectSlug]/voice/actions.ts`: `createVoiceAction`, `saveVoiceAction`, `setDefaultVoiceAction`, `archiveVoiceAction`, `restoreVoiceAction`, `tryVoiceAction`, each via `runAction`, with `revalidatePath` where lists change. Add rows to `tests/integration/actions-authz.test.ts` (owner, admin allowed; editor `forbidden` on save/create/default/archive/restore and allowed on try-it; non-member `not_found`)
- [ ] T041 [US2] Voice screens: `src/app/p/[projectSlug]/voice/page.tsx` + `loading.tsx` (table, `?archived=1` filter), `new/page.tsx` (owner/admin only, else `notFound()`), `[profileId]/page.tsx` + `loading.tsx` (not found; archived banner with Restore for owner/admin), `[profileId]/history/page.tsx` (`?v=n`), `VoiceEditor.tsx` (fieldsets Basics / Voice / Examples ≤10 with Add and Remove / Links ≤20 / Hashtags normalised on blur / Platform guidance one textarea per registered provider labelled with its display name; **Save** sends `baseVersion` and announces "Saved as version N"; **Make default**, **Archive** with a confirm `Dialog`, **History**; read-only for editors), `TryItPanel.tsx` (platform checkboxes defaulting to providers of connected accounts, required brief, **Try it** → "Trying…", result cards with `used / limit` and issues, latency, caption "Samples are not saved."; owners/admins send `draft`, editors send `versionId`). Remove the `voice` placeholder from `[section]/page.tsx`. Make T037 pass
- [ ] T042 [US2] Run `pnpm vitest run tests/integration/voice src/app/p/[projectSlug]/voice tests/integration/actions-authz.test.ts tests/integration/permissions.test.ts` and `pnpm typecheck && pnpm lint`; fix failures

**Checkpoint**: voice profiles, versioning and Try it work independently of US3–US6.

---

## Phase 5: User Story 3 - Review queue: approve, edit then approve, reject, regenerate, bulk approve (Priority: P1)

**Goal**: Members see every post waiting for review, newest first, and approve, save-and-approve, reject, regenerate or bulk approve them, safely under concurrency.

**Independent Test**: Seed posts in review (valid, invalid, remembered `add_to_queue`), run each action and check review state, scheduling and messages, including a bulk approve where one selected post is invalid.

### Tests for User Story 3

- [ ] T043 [P] [US3] `tests/integration/review/review.test.ts`: `listReviewQueue` is newest first, paginates at 50 (page 2), shows variants with counts and issues, voice name+version, brief and remembered policy, and excludes other projects' posts; approve a valid post → `approved`, `reviewed_by_user_id` set, queued when the remembered policy is `add_to_queue` and the returned times match the existing queue slots; approve again → `already_reviewed` ("This post was already approved."); approve with blocking issues → `validation` with issues keyed by provider; save-and-approve with a valid edit approves and queues; with an invalid edit keeps the edit and stays in review with the issues; one account without slots → post approved, other targets queued, that target unscheduled with "This account has no posting slots"; reject with and without reason → state `rejected`, `rejection_reason` stored, targets stay `draft`, the queue/explicit-time/publish-now gates refuse it, and `listPosts({ status: "rejected" })` finds it; reject of an already-approved post → `already_reviewed`; viewer-type role refused, editor allowed
- [ ] T044 [P] [US3] `tests/integration/review/bulk-and-concurrency.test.ts`: bulk approve of 20 posts with 1 blocking post and 1 post whose only account has no slots → "approved 19" including the unscheduled note, skipped 1 with its reason; a deleted/other-project id is skipped "Not found"; 0 or >100 ids rejected by Zod; 20 parallel `approvePost` calls on one post (use `Promise.all`) → exactly one `ok:true`, nineteen `already_reviewed`, and at most one occupied slot per target (assert via the slot table); regenerate from the review queue keeps `needs_review`
- [ ] T045 [P] [US3] Render tests `src/app/p/[projectSlug]/review/review.test.tsx`: empty state "Nothing to review" linking to Generate; populated items are `<article>` elements with headings, "Select post: {excerpt}" checkboxes and "Select all on this page"; Approve disabled with a reason for a blocking post; remembered-policy text ("Will be queued on approval" / "Stays a draft on approval"); brief truncated to 200 characters with a `title`; Reject dialog names the post's first 60 characters; sticky bulk bar shows "{n} selected"; the `LiveRegion` summary reads "Approved 18. Skipped 2:" followed by reasons; pagination appears over 50; the nav label shows `Review (3)` and no count at 0; the Posts page has a Rejected tab and `StatusBadge` text "Rejected"

### Implementation for User Story 3

- [ ] T046 [US3] `src/server/services/review.ts`: `listReviewQueue`, `approvePost`, `rejectPost`, `bulkApprove` per contracts/services.md § Review (permissions `post:edit` + `post:schedule` for approve/bulk, `post:edit` for reject; `prepareVariants` outside the transaction; post row lock; edits kept even when blocking issues remain; remembered `add_to_queue` applied through `queueTargetsInTx`; `applyDerivedStatus`; bulk is sequential `approvePost` calls with `NotFoundError` → skipped "Not found")
- [ ] T047 [US3] `src/app/p/[projectSlug]/review/actions.ts`: `approveAction`, `rejectAction`, `bulkApproveAction`, each via `runAction` and `revalidatePath("/p/[slug]/review")`; reuse `regenerateAction` from US1. Add rows to `tests/integration/actions-authz.test.ts` (owner, admin, editor allowed; non-member `not_found`)
- [ ] T048 [US3] Review screen: `src/app/p/[projectSlug]/review/page.tsx` + `loading.tsx` + `ReviewList.tsx` (select boxes, "Select all on this page", sticky bulk bar, per-item `Menu`: Approve / Edit (expands the shared `VariantEditor` with **Save and approve** that calls `approveAction` with edits) / Regenerate… (shared `RegenerateDialog`) / Reject…), `RejectDialog.tsx` (optional reason ≤ 500, destructive secondary styling), `LiveRegion` bulk summary; `?page=n`. Remove the `review` placeholder from `[section]/page.tsx`. Extend `src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx` with the review-only **Save and approve** action
- [ ] T049 [US3] Navigation and Posts list: pass the review count from the project layout to `src/components/shell/LeftNav.tsx` and render `Review (n)` as text when n > 0; add the **Rejected** tab to the Posts `FilterTabs` in `src/app/p/[projectSlug]/posts/page.tsx` (and keep **Needs review**); extend the existing LeftNav and posts-page tests. Make T045 pass
- [ ] T050 [US3] Run `pnpm vitest run tests/integration/review src/app/p/[projectSlug]/review src/components tests/integration/posts tests/integration/actions-authz.test.ts` and `pnpm typecheck && pnpm lint`; fix failures

**Checkpoint**: generated posts can leave review. US1–US3 together are the usable P1 slice.

---

## Phase 6: User Story 4 - Approval and scheduling policies, defaults and overrides (Priority: P2)

**Goal**: The matrix of approval × scheduling × validation is enforced; Generate shows the effective policies and lets members override within their role; auto-approve + add-to-queue is a distinct, confirmed choice on Generate and in project settings.

**Independent Test**: Run the full matrix with the fake LLM and check each resulting state; attempt overrides as each role and confirm the allowed and refused combinations on the server.

### Tests for User Story 4

- [ ] T051 [P] [US4] `tests/integration/generation/policy-matrix.test.ts`: 2 approval × 2 scheduling × {valid, invalid after retry} through `generateSingle`; assert `review_state`, target statuses and the stored decision against the `decidePolicy` table; **0** invalid posts end approved or scheduled (SC-003); auto + queue + valid → targets `scheduled` in their next free slots; invalid + auto + queue → in review, nothing scheduled, reason "Forced to review: …"; Instagram target without media forces review regardless of policy
- [ ] T052 [P] [US4] `tests/integration/generation/overrides.test.ts`: an editor overriding to `auto_approve` → `PolicyNotAllowedError` "Only owners and admins can auto-approve", `failFromError` code `forbidden` keeping the message, and the fake received **0** calls and no post/failure row exists (SC-010); an editor with a project default of `auto_approve` generates without an override and it applies; editor may choose either scheduling policy; auto + queue without `confirmUnreviewedQueue` refused on `generateSingle` with the field error; with it accepted; owner and admin overrides apply to the request only and the project's stored defaults are unchanged afterwards
- [ ] T053 [P] [US4] Extend `tests/integration/project-settings.test.ts`: `updateSettings` with defaults `auto_approve` + `add_to_queue` and no `confirmUnreviewedQueue` → validation error on that field with the same message; with `true` → saved; editor still refused (FR-028); other combinations need no confirmation
- [ ] T054 [P] [US4] Render tests `src/app/p/[projectSlug]/generate/policy.test.tsx` and extend the settings-form test: `PolicyPicker` shows "Use project default (…)", "Review required", "Approve automatically"; for an editor "Approve automatically" is disabled with "Only owners and admins can auto-approve"; when the effective pair is auto + queue the radios collapse into the highlighted "Approve and queue automatically — no review" with the explanation text and the required checkbox "I understand these posts will be queued without review"; when that pair is the project default the label shows at the top of the form before submit; the settings form shows the same explanation and checkbox

### Implementation for User Story 4

- [ ] T055 [US4] `src/app/p/[projectSlug]/generate/PolicyPicker.tsx` (a `<fieldset>` per contracts/ui.md § Generate form item 7, with `aria-describedby` and the `confirmUnreviewedQueue` checkbox) and wire it into `GenerateForm.tsx` so overrides and the confirmation are sent to `generateSingleAction`; pass the effective defaults and the user's `generation:auto_approve` capability from `generate/page.tsx`
- [ ] T056 [US4] `src/server/services/projects.ts` `updateSettings` accepts `confirmUnreviewedQueue` and throws the same validation error as `resolvePolicies` when the new defaults are `auto_approve` + `add_to_queue` and the flag is not `true`; update `src/app/p/[projectSlug]/settings/settings-form.tsx` and `actions.ts` with the labelled explanation and required checkbox. Make T053 and T054 pass
- [ ] T057 [US4] Run `pnpm vitest run tests/integration/generation tests/integration/project-settings.test.ts src/app/p/[projectSlug]` and `pnpm typecheck && pnpm lint`; fix failures

**Checkpoint**: policies, overrides and confirmations are enforced on the server and visible in the UI.

---

## Phase 7: User Story 5 - Generate a series from one brief (Priority: P2)

**Goal**: One brief becomes a plan of N angles that can be edited, then one post per angle, written in order, each idempotent, with per-angle failures that can be retried without duplicates.

**Independent Test**: With the fake LLM, plan N=5, edit one angle, delete one, start; 4 posts are created in plan order, each prompt containing its own angle and the other titles, all in one series with their own metadata and the Story 4 policy outcome.

### Tests for User Story 5

- [ ] T058 [P] [US5] `tests/integration/generation/series.test.ts`: `planSeries` N=5 returns 5 angles and saves no post and no series; unreadable plan twice → a failure row (`mode: series_plan`), no series, no post; wrong angle count after retry → retried once with "Expected 5 angles, got 4."; `startSeries` with 4 edited angles validates 1–10, resolves policies (editor + auto-approve refused; auto + queue without confirmation refused), saves the series with `request.resolved` and makes **0** model calls; `writeSeriesPost` for positions 0..3 in order → 4 posts with `series_id`, `series_position`, each prompt containing its angle and the other three titles and none of its own title under "do not repeat"; no two prompts share an angle (SC-009); calling a written position again returns `existing: true` and creates no duplicate; angle 2 failing leaves the others saved, writes a failure row with `series_id`/`series_position`, and retrying it succeeds with exactly one post at that position; the partial unique index prevents a duplicate under two concurrent calls (`Promise.all`); with `auto_approve` + `add_to_queue` the posts take successive free slots in plan order; `getSeries` returns posts and failures by position; another project's series → `NotFoundError`
- [ ] T059 [P] [US5] Render tests `src/app/p/[projectSlug]/generate/series.test.tsx`: series mode shows "Planning…" while pending; the plan editor edits, reorders (with Move up / Move down buttons, no drag), removes and adds angles within 1–10 and blocks Write posts outside that range; `SeriesWriter` calls `writeSeriesPostAction` sequentially (assert call order with a spy), shows each post or its failure with **Try again**, and states in-progress, done and partial failure

### Implementation for User Story 5

- [ ] T060 [US5] `src/server/services/generation/series.ts`: `planSeries`, `startSeries`, `writeSeriesPost`, `getSeries` per contracts/services.md § Series and research D11 (plan schema through `runGeneration`-style retry with `buildSeriesPlanPrompt` and `checkSeriesPlan`; `startSeries` makes no model call; `writeSeriesPost` returns the existing post or generates with `series: { angle, otherAngles, position, total }`, policy from `series.request.resolved`, unique violation returns the existing post, failure row on error)
- [ ] T061 [US5] Add `planSeriesAction`, `startSeriesAction` (redirects to the series page on success) and `writeSeriesPostAction` to `src/app/p/[projectSlug]/generate/actions.ts`; add rows to `tests/integration/actions-authz.test.ts` (owner, admin, editor allowed; editor with `approval: "auto_approve"` → `forbidden` with the message; non-member `not_found`)
- [ ] T062 [US5] Series UI: handle `?mode=series` in `generate/page.tsx` and `GenerateForm.tsx` (brief, N 2–10, same options and `PolicyPicker`), `SeriesPlanEditor.tsx` (plan → edit → start), `src/app/p/[projectSlug]/generate/series/[seriesId]/page.tsx` + `loading.tsx` + `SeriesWriter.tsx` (writes positions in order, then lists posts linking to their result pages, or each failure's message with **Try again**). Make T059 pass
- [ ] T063 [US5] Run `pnpm vitest run tests/integration/generation src/app/p/[projectSlug]/generate tests/integration/actions-authz.test.ts` and `pnpm typecheck && pnpm lint`; fix failures

**Checkpoint**: series mode works end to end with the fake LLM.

---

## Phase 8: User Story 6 - Swap between OpenAI and Anthropic by configuration (Priority: P2)

**Goal**: The same generation works through either provider selected only by `LLM_PROVIDER`, `LLM_MODEL` and the matching key; a missing or wrong setting disables generation with a clear message and the rest of the app runs.

**Independent Test**: Run the shared scenario table against both implementations over the fake transport, and run the same single-generation scenario with each provider's fake config.

### Tests for User Story 6

- [ ] T064 [P] [US6] `src/server/llm/anthropic.test.ts`: run the **same** `tests/helpers/llm-scenarios.ts` table T008 created against `createAnthropicProvider` over the fake transport (system in `system`, image `source` blocks before the text block, `output_config.format` carries the JSON schema, `stop_reason` `refusal` → `refused`, `max_tokens` and `model_context_window_exceeded` → `incomplete`, 429/500/401/400 mapping, timeout message, usage from `usage.input_tokens`/`output_tokens`, key absent from logs, non-https URL image throws)
- [ ] T065 [P] [US6] `tests/integration/generation/provider-parity.test.ts`: build `createOpenAiProvider` and `createAnthropicProvider` over fake transports returning the same logical answer and run `generateSingle` through each via `setLlmForTests`; assert metadata records `"openai"`/`"anthropic"` and the configured model name, the wire request of each carries the voice, instructions, brief, platform rules and image in that provider's form, usage and latency are stored, and a timeout produces the failure row with "The model took too long to answer." for both (SC-005)
- [ ] T066 [P] [US6] Extend `src/server/llm/index.test.ts` and `tests/startup/` for the Story 6 acceptance scenarios: provider set but model missing → status names `LLM_MODEL`; provider `openai` without key names `OPENAI_API_KEY`; unknown provider named; startup logs `generation disabled (…)` and continues; Generate shows the not-configured state while another route still renders (render test)

### Implementation for User Story 6

- [ ] T067 [US6] Complete `src/server/llm/anthropic.ts` (`createAnthropicProvider`): `messages.create` with `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod` as `output_config.format`, `max_tokens` from config, image blocks before the text, raw text from concatenated `text` blocks, own `JSON.parse` + `safeParse`, stop-reason and error-class mapping per research D3, `performance.now()` latency, `logLlmCall`; read the installed `.d.ts` files in `node_modules/@anthropic-ai/sdk` before writing (research R3). Make T064 pass
- [ ] T068 [US6] Ensure `src/server/llm/index.ts` `getLlm()` selects between the two implementations from `parseLlmConfig` only, caches nothing across a config change in tests, and never reads a key outside `config.ts`; add a test asserting `process.env` key reads occur only in `src/server/llm/config.ts` (grep test). Make T065 and T066 pass
- [ ] T069 [US6] `scripts/llm-check.ts` and the `"llm:check": "esbuild scripts/llm-check.ts --bundle --platform=node --target=node24 --format=esm --outfile=$TMPDIR/llm-check.mjs … && node …"` script in `package.json` (follow how `build:prestart` bundles scripts; use a writable output directory): with config present it makes one sample generation through `getLlm()` and prints `provider=<p> model=<m> outcome=ok latency_ms=<n>` (or the failure kind); without it prints `latency: unmeasured (no LLM key configured)` and exits 0 (FR-037, research D7). Write `scripts/llm-check.test.ts` running the exported `main()` with an injected fake LLM (prints the measured line) and with no config (prints the unmeasured line, exit code 0); run `pnpm llm:check` with the key variables unset and confirm the unmeasured line
- [ ] T070 [US6] Run `pnpm vitest run src/server/llm tests/integration/generation/provider-parity.test.ts tests/startup scripts` and `pnpm typecheck && pnpm lint`; fix failures

**Checkpoint**: both providers pass the same scenarios; generation is configuration-selected.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Docs, security sweeps, project-wide gates

- [ ] T071 [P] `.env.example`: add the LLM section (`LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS`) commented, with no model default and no real key; add a "Generator" section to `README.md` and a new `docs/generator.md` (how to configure either provider, the policy matrix, voice versioning, review queue, what is out of scope: jobs, batch mode, public API, image generation)
- [ ] T072 [P] Add 007 entries to `docs/decisions.md` with how to reverse each: the five "Decisions made while specifying" in spec.md, alt text asked once per image under the strictest limit (research D9), model-input image constraints stricter than the spec's ceilings and UNVERIFIED for OpenAI (R1), the failure row stores inputs not the prompt, regenerate replaces content even if edited meanwhile, and the seven generic changes listed in plan.md § Generic changes to existing code. Leave the live-latency line to T079
- [ ] T073 [P] `tests/integration/generation/no-secrets.test.ts`: run single, series, regenerate, Try it and a failing generation with `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set to a distinctive fake string and the logger spied; assert the string appears in none of: post `generation_metadata`, `generation_failures` rows, `generation_series` rows, any log line, any `ActionResult`, the rendered HTML of the generate/result/review/voice pages (FR-035, constitution VII)
- [ ] T074 [P] Cross-project isolation sweep `tests/integration/generation/isolation.test.ts`: as a member of project A, every service function that takes an id (profile, version, post, series, account, media, failure) given an id from project B returns `NotFoundError` and never reveals existence; the new repositories reject a missing `project_id` through the scope-check helper
- [ ] T075 [P] Accessibility and states sweep: grep-style test `src/app/p/[projectSlug]/ui-conventions.test.ts` asserting every new route folder (`generate`, `generate/result/[postId]`, `generate/series/[seriesId]`, `review`, `voice`, `voice/[profileId]`) has a `loading.tsx`, every `<textarea>`/`<input>` in the new client components has an associated label (render and query by label role), and that no new client component imports from `src/server/llm`, `src/server/services/generation` or `src/server/db` (server-only boundary)
- [ ] T076 [P] Quickstart conformance: write `tests/integration/generation/quickstart.test.ts` that asserts, by running the code, the headline numbers in quickstart.md §2–§3: exactly 2 model calls when the first answer breaks a platform rule and the second is valid (SC-004), 100% of posts from the policy matrix carry complete generation metadata (SC-002), earlier posts still name their original voice version after an edit (SC-006), a bulk approve of 20 valid posts reports 20 approved (SC-008)
- [ ] T077 Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (the whole suite), `pnpm db:check` and `pnpm build`; all must exit 0. Confirm `tests/lint/worker-bundle.test.ts` still passes (the worker bundle does not import `src/server/llm` or `src/server/services/generation`). Fix every failure at its cause; do not skip or loosen a test
- [ ] T078 Run `pnpm vitest run tests/integration/posts tests/integration/compose tests/integration/scheduler tests/integration/accounts-slots.test.ts tests/integration/calendar.test.ts` once more and confirm the pre-existing tests pass with **no edited expectations** (git diff on those test files shows no changes except the additive ones named above)
- [ ] T079 🛑 BLOCKED: needs a real LLM API key and network access — with `LLM_PROVIDER`, `LLM_MODEL` and the matching key set in `.env`, run `pnpm llm:check` and append the printed `provider=… model=… outcome=… latency_ms=…` line to the 007 section of `docs/decisions.md` (FR-037, SC-011). Until then that section must read "latency: unmeasured; live path verified with mocks only". Leave this box unchecked in a headless run; if no key will ever be supplied, mark it as closed with the reason "unachievable: no key" rather than checking it

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup; **blocks every story**.
  - Inside it: T003 → T004/T005/T006/T007 → T008 → T009; T011 → T012 → T013 → T014/T015/T016; T017 → T018; T019/T020 → T021; T018 + T021 → T022; T024 last.
- **US1 (P1)**, **US2 (P1)**, **US3 (P1)**: each depends only on Phase 2. US3 reuses `VariantEditor` and `RegenerateDialog` from US1 (T033), and `regeneratePost` (T029), so do US1 first. US2 is independent of US1 and US3 at the service level (US1 tests build profiles with the factory from T016).
- **US4 (P2)**: after US1 (needs `generateSingle` and the form) and after Phase 2's `resolvePolicies`.
- **US5 (P2)**: after US1 (reuses `GenerateForm`, `runGeneration`, result page) and US4's `PolicyPicker` for the form.
- **US6 (P2)**: after Phase 2; T067 can run any time after T008 and is independent of US1–US5. T065 needs US1's `generateSingle`.
- **Polish (Phase 9)**: after all stories; T079 is human-owned and does not block the others.

### Within Each User Story

- Tests are written first, fail, then implementation makes them pass.
- Services before server actions, actions before routes and components.

### Parallel Opportunities

- Phase 2: T005, T006, T010, T014, T015 and T019/T020/T023 are in different files and can run in parallel once their predecessors exist.
- After Phase 2: US1, US2 and US6's T064/T067 can proceed in parallel; US3 starts once T033 and T029 exist.
- All test tasks marked [P] inside one story touch different files.

## Parallel Example: User Story 1

```text
# Write these tests together (different files, all must fail first):
T025 tests/integration/generation/single.test.ts
T026 tests/integration/generation/regenerate.test.ts
T027 src/app/p/[projectSlug]/generate/generate.test.tsx

# Then, in parallel with the services:
T030 updatePostVariants in src/server/services/posts/index.ts
```

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 → Phase 2 (LLM layer with OpenAI, migration, DAL, core, policy).
2. Phase 3 (US1): single-post generation, edit, regenerate.
3. **STOP and VALIDATE** with `pnpm vitest run tests/integration/generation` and the US1 render tests.

### Incremental Delivery

1. Foundation → US1 (MVP) → US2 (voice profiles, Try it) → US3 (review queue): the P1 slice is usable.
2. US4 (policies and overrides) → US5 (series) → US6 (Anthropic and `llm:check`).
3. Polish, final gates, and the human-owned live latency line (T079).

## Notes

- [P] tasks = different files, no dependencies.
- [Story] labels map each task to its user story for traceability.
- Do not stop at a green unit test: each checkpoint names the commands that must pass.
- Avoid: a model call inside a transaction, a model id literal in `src/`, a key in any output, same-file conflicts between [P] tasks.
