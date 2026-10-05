# Tasks: Account posting instructions (per-account platform rules separate from the voice)

**Input**: Design documents from `/specs/011-account-posting-instructions/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/{services,prompt,ui,http-api}.md, quickstart.md

**Tests**: Requested (spec FR-028). Test tasks sit beside the code they cover. The LLM is always faked (`tests/helpers/fake-llm.ts`, `setLlmForTests`); Postgres is the real test DB.

**Format**: `- [ ] T### [P?] [US?] Description with path`. `[P]` means a different file with no dependency on an incomplete task.

**Headless note**: Every check below is a Vitest run, `tsc`, lint or build. No dev server, browser or network is needed. Before any UI/route/action code, read `node_modules/next/dist/docs/01-app/` (AGENTS.md) and apply the `docket-ui` skill.

## Path conventions

Single Next.js app: `src/app`, `src/components`, `src/server`, `src/lib`, `tests/`, `drizzle/`, `docs/`.

---

## Phase 1: Setup — golden fixtures (before any prompt change)

**Purpose**: Record today's prompt/schema output so FR-009 / SC-003 (one account per platform is byte-identical) can be proved after the change. This MUST be committed before `prompt.ts` or `schema.ts` is touched (plan D6).

- [x] T001 Read `src/server/services/generation/prompt.ts`, `schema.ts` and their existing tests; write a throwaway-free generator script or test helper at `src/server/services/generation/__fixtures__/record-pre-011.test.ts` (skipped by default via an env flag) that builds prompts and output schemas from the UNCHANGED code for voices with no per-platform guidance and one account per platform (single, series plan, series post, retry context, with and without image note) and writes `src/server/services/generation/__fixtures__/pre-011-prompts.json`
- [x] T002 Run the recorder once against unchanged code, then add `src/server/services/generation/prompt.golden.test.ts` that asserts the current `buildPrompt`/schema output equals `__fixtures__/pre-011-prompts.json` byte for byte; run `pnpm vitest run src/server/services/generation/prompt.golden.test.ts` (must pass on unchanged code) and commit fixture + test

---

## Phase 2: Foundational (blocks all user stories)

**Purpose**: Schema, migrations, DAL, the pure grouping module, validation schemas and the record shape.

- [ ] T003 Add `postingInstructions` (`text`, nullable, check `char_length BETWEEN 1 AND 2000`, name `social_accounts_posting_instructions_len`) to `src/server/db/schema/accounts.ts`; add `postingInstructionsSnapshot` (`jsonb`, nullable) to `src/server/db/schema/jobs.ts`; add enum value `account_posting_instructions_update` to `membership_action` in `src/server/db/schema/audit.ts`
- [ ] T004 Run `pnpm db:generate` to produce `drizzle/0008_*.sql` plus meta; then `pnpm exec drizzle-kit generate --custom --name=copy_platform_guidance` and fill `drizzle/0009_copy_platform_guidance.sql` with the idempotent SQL from data-model.md § Data migration; run `pnpm db:check`
- [ ] T005 [P] Create pure module `src/lib/generation/groups.ts` exporting `GROUP_LIMIT = 16`, `POSTING_INSTRUCTIONS_MAX = 2000`, `GroupAccount`, `VariantGroup`, `normaliseInstructions`, `groupTargets`, `groupLimitMessage` per contracts/services.md (imports nothing from `src/server`)
- [ ] T006 [P] Unit tests `src/lib/generation/groups.test.ts`: whitespace and CRLF differences group together; case and inner-spacing differences do not; null equals null; order follows first appearance; keys use `_n` only for platforms with 2+ groups; `GROUP_LIMIT` is 16; message names count and 16. Run `pnpm vitest run src/lib/generation/groups.test.ts`
- [ ] T007 [P] Extend `src/lib/validation/generation.ts`: `generationRecordSchema.accounts` (`.nullish()` array of `{accountId, displayName, providerKey, instructions, groupKey}`) and `remainingProblems[].groupKey` (`.nullish()`); add `jobInstructionsSnapshotSchema` (`{ v: 1, byAccount: Record<uuid, string|null> }`) to `src/lib/validation/jobs.ts`; confirm old records still parse (extend existing validation tests)
- [ ] T008 Add `setPostingInstructions(id, text)` to `src/server/dal/accounts.ts` (`UPDATE … WHERE project_id AND id AND removed_at IS NULL`, via `mine(id)`), add `postingInstructions` to `SocialAccountRow`/`AccountRecord`; verify `upsertConnected` does not list the column; run the existing DAL scope-check test
- [ ] T009 Create `src/server/services/generation/groups.ts` with `assertGroupLimit` (throws `ValidationIssuesError` code `too_many_groups`, field `targetAccountIds`), `groupsForAccounts(accounts, instructionsOf?)` and `recordAccounts(groups)` per contracts/services.md
- [ ] T010 Migration test `tests/integration/migrations/copy-platform-guidance.test.ts`: throwaway DB migrated from a copy of `drizzle/` with the journal stopped at `0008`; seed project A (default profile latest version with Bluesky + Facebook guidance, older version with Instagram guidance, non-default profile with Threads guidance, accounts Bluesky×2 one with instructions, Facebook, Threads, removed Bluesky) and project B (no default profile); apply `0009`; assert copy / skip-non-empty / non-default and old versions ignored / removed and project B unchanged / no audit rows added / re-running the 0009 SQL changes nothing. Run `pnpm vitest run tests/integration/migrations/copy-platform-guidance.test.ts`

**Checkpoint**: `pnpm typecheck && pnpm db:check` pass; T002 golden test still passes.

---

## Phase 3: User Story 1 — Write posting instructions for an account (P1) 🎯 MVP

**Goal**: Owners/admins edit per-account instructions beside posting slots; editors read-only; audit-logged.
**Independent test**: `pnpm vitest run tests/integration/accounts-posting-instructions.test.ts`

- [ ] T011 [US1] Add `postingInstructionsSchema`, `setPostingInstructions(scope, accountId, input)` (uuid check → parse → `account:["manage"]` → `scope.transaction` re-check, `getForUpdate`, no-op returns `changed:false`, else DAL write + `recordAudit` with `{accountId, displayName, previous, next}`) and `AccountView.postingInstructions` in `src/server/services/accounts.ts`
- [ ] T012 [US1] Integration tests `tests/integration/accounts-posting-instructions.test.ts`: owner and admin save (CRLF/surrounding spaces stored normalised) with one audit row (actor, id, name, previous, next); same text again → `changed:false`, no audit; clear → `NULL` and audit; 2,001 chars refused with "Keep posting instructions to 2,000 characters or fewer"; editor → `ForbiddenError`, nothing changes; foreign-project account id → `NotFoundError` on read and write; reconnect keeps instructions
- [ ] T013 [P] [US1] Create `src/app/p/[projectSlug]/accounts/PostingInstructionsForm.tsx` (client leaf: label, textarea rows=5, help text via `aria-describedby`, `{n} / 2,000` counter with too-long state, `aria-live="polite"` error, focus on failed save, right-aligned Save with "Saving…" pending, `LiveRegion` "Saved."/"No changes.") per contracts/ui.md
- [ ] T014 [US1] Add `setPostingInstructionsAction(slug, {accountId, instructions})` via `runAction` in `src/app/p/[projectSlug]/accounts/actions.ts`; render `<h3>Posting instructions</h3>` plus the form (owners/admins) or read-only `whitespace-pre-wrap` text / "No posting instructions." (editors) before the `Posting slots` heading in `src/app/p/[projectSlug]/accounts/page.tsx`
- [ ] T015 [P] [US1] Add `LABEL.account_posting_instructions_update = "changed the posting instructions for"` in `src/app/p/[projectSlug]/settings/members/activity-list.tsx` and extend `detailSubject` in `settings/members/page.tsx` to show `"{details.displayName}"`; extend the existing activity-list test
- [ ] T016 [US1] Component/UI test (extend `tests/integration/accounts-ui.test.ts` or the existing accounts page test): owner page renders the form with label, counter and help text; editor page renders read-only text and no form control

**Checkpoint**: US1 fully working and testable alone.

---

## Phase 4: User Story 2 — Generate one post following each account's instructions (P1)

**Goal**: Grouped variants, new prompt order, per-group checks and retry, record snapshot, per-group editing.
**Independent test**: `pnpm vitest run src/server/services/generation tests/integration/generation/posting-instructions.test.ts`

- [ ] T017 [US2] In `src/server/services/generation/prompt.ts`: replace `PLATFORM GUIDANCE` with a `POSTING INSTRUCTIONS` section between `VOICE` and `PLATFORM RULES` per contracts/prompt.md (group key, platform, account names, instructions; omitted when no target has instructions and every platform has one group); `platformRulesFor(providerKeys)` drops the `voice` arg and `guidance`; the prompt never reads `voice.platformGuidance`; retry context names groups
- [ ] T018 [US2] In `src/server/services/generation/schema.ts`: build the output schema from group keys (required properties only, no unions, no length/count constraints); `checkGenerationOutput` takes `groups` and returns problems `{groupKey, providerKey, message}`; add `problemLine` (`<key>: msg` when key equals platform, else `<key> (<Platform>: <names>): msg`)
- [ ] T019 [US2] In `src/server/services/generation/core.ts`: replace `CoreRequest.providerKeys` with `groups: VariantGroup[]`; schema from `groups.map(g => g.key)`; per-group validation; retry asks for the same groups
- [ ] T020 [US2] Update `src/server/services/generation/single.ts` (`generateSingle`: `groupsForAccounts` → `assertGroupLimit` before `runGeneration`; `buildRecord` takes `groups` and writes `record.accounts`) and `save.ts` (`saveGeneratedPost` takes `groups`; target `overrideText` is its group's variant, `baseText` the first account's group variant); keep `distinctProviderKeys` only for `assertMediaFits`
- [ ] T021 [P] [US2] Tests in `src/server/services/generation/prompt.test.ts` and `schema.test.ts` for prompt invariants P1–P8 in contracts/prompt.md (section order voice → posting instructions → platform rules → one-off → inputs; old-version guidance absent from prompt; schema zero optional and zero union parameters); the T002 golden test must still pass byte for byte (FR-009)
- [ ] T022 [US2] Integration tests `tests/integration/generation/posting-instructions.test.ts` (fake LLM): (a) two Bluesky accounts identical instructions → one variant `bluesky`, both targets share it; (b) different instructions → `bluesky_1`/`bluesky_2`, each target gets its own text, prompt lists key with account name; (c) one account per platform, no instructions → same keys/texts/prompt as before; record `accounts[]` per target; later account edit leaves the record unchanged; retry names `bluesky_2 (Bluesky: …)` and asks for the same keys
- [ ] T023 [US2] Create `src/server/services/posts/variant-groups.ts` (`variantGroupsForPost` per contracts/services.md); change `variantEditsSchema` in `src/server/services/posts/index.ts` and `approveSchema.edits` + `buildItem`/`ReviewVariant` in `src/server/services/posts/review.ts` to `{accountIds, text}` keyed edits; `updatePostVariants` problems become `{accountIds, targetId, issues}`
- [ ] T024 [US2] Update result screen `src/app/p/[projectSlug]/generate/result/[postId]/*` (cards from `variantGroupsForPost`, heading "{providerName}: {accountNames}", "Posting instructions used" list with None / Not recorded, `VariantEditor` sends `{accountIds, text}`) and `src/app/p/[projectSlug]/review/{ReviewList.tsx,actions.ts}` (one entry per group)
- [ ] T025 [US2] Tests: extend `src/app/p/[projectSlug]/generate/result/result.test.tsx`, `tests/integration/review` and `tests/integration/generation/overrides.test.ts` — two Bluesky groups show two labelled cards with `used / limit`; editing one card changes only that group's targets; old records (no `accounts`) group by platform and show "Not recorded"

**Checkpoint**: US1 + US2 work independently.

---

## Phase 5: User Story 3 — Refuse requests with too many groups (P1)

**Goal**: >16 groups refused before any model call on every caller, and live in the forms.
**Independent test**: `pnpm vitest run tests/integration/generation/group-limit.test.ts`

- [ ] T026 [US3] Wire `groupsForAccounts` + `assertGroupLimit` into `src/server/services/generation/series.ts` (`planSeries`, `startSeries` refusing before saving the series, `writeSeriesPost`) and `regenerate.ts` (live targets with current instructions; each draft target gets `variants[groupOf(account).key]`)
- [ ] T027 [P] [US3] Add `postingInstructions` to `AccountOption` in `src/app/p/[projectSlug]/generate/generate-logic.ts`, filled in `generate/page.tsx`, `jobs/new/form-data.ts` and the voice page from `AccountView`
- [ ] T028 [US3] Live group-limit message in `src/app/p/[projectSlug]/generate/GenerateForm.tsx` and `src/app/p/[projectSlug]/jobs/new/JobForm.tsx` (also used by the CSV form): `groupTargets(selected).length > 16` shows `groupLimitMessage(n)` under the account fieldset (`role="status"`, `aria-live="polite"`); submit stays enabled; server error shown next to picker (field `targetAccountIds`); add the account-fieldset hint from contracts/ui.md
- [ ] T029 [US3] Integration tests `tests/integration/generation/group-limit.test.ts`: 17 groups refused on single, series plan, series start, series post, regenerate, Try it, job creation, `POST /api/v1/generate` and `POST /api/v1/jobs`, each message naming 17 and 16, fake model `requests.length === 0`, no post / failure row / job / idempotency-result for a model call created; exactly 16 groups proceed; API response is 400 `validation_failed` with detail code `too_many_groups`
- [ ] T030 [P] [US3] Form-logic component tests for the live message in `GenerateForm` and `JobForm` (extend existing tests under `src/app/p/[projectSlug]/generate/` and `jobs/new/`)

**Checkpoint**: Requests over the limit never reach the model.

---

## Phase 6: User Story 4 — Existing guidance moves to accounts (P2)

**Goal**: Voice editor/new versions drop per-platform guidance; history shows old guidance read-only; migration already built in Phase 2.
**Independent test**: `pnpm vitest run src/lib/validation/voice.test.ts 'src/app/p/[projectSlug]/voice/voice.test.tsx'` plus T010

- [ ] T031 [US4] In `src/lib/validation/voice.ts` add `voiceContentInputSchema = voiceContentSchema.omit({ platformGuidance: true })` (strips, not refuses a stray `platformGuidance` key); in `src/server/services/voice.ts` switch `createSchema`/`saveSchema` to it and compare the save no-op check against `voiceContentInputSchema.parse(current.content)`; `VersionView.content` stays `VoiceContent`
- [ ] T032 [P] [US4] Remove the platform-guidance fieldset and form field from `src/app/p/[projectSlug]/voice/VoiceEditor.tsx` and `voice-logic.ts`; add the one-line note linking to `/p/{slug}/accounts` under the hashtags field
- [ ] T033 [P] [US4] In `src/app/p/[projectSlug]/voice/[profileId]/history/page.tsx` show `Platform guidance (no longer used)` read-only only when the old version's guidance is non-empty, with the pointer to Accounts
- [ ] T034 [US4] Tests: extend `src/lib/validation/voice.test.ts` and `src/app/p/[projectSlug]/voice/voice.test.tsx` and the voice service integration test — `platformGuidance` in input is not stored; unchanged save of a pre-upgrade version creates no new version; editor has no guidance field; history shows old guidance labelled "no longer used" with link; old rows untouched

---

## Phase 7: User Story 5 — Jobs keep the instructions they were created with (P2)

**Goal**: Snapshot at creation; runner uses it; pre-feature jobs use current instructions.
**Independent test**: `pnpm vitest run tests/integration/jobs/posting-instructions.test.ts`

- [ ] T035 [US5] `src/server/services/jobs/create.ts`: after `loadAccounts`, build snapshot `{v:1, byAccount}`, `assertGroupLimit(groupsForAccounts(accounts, a => snapshot.byAccount[a.id] ?? null))` before preparing/writing the source, and insert `postingInstructionsSnapshot` with the job (covers UI, CSV, API)
- [ ] T036 [US5] `src/server/services/jobs/runner.ts` (`processClaimedItem`): parse snapshot with `jobInstructionsSnapshotSchema.nullable()`; `instructionsOf` from snapshot or current account; `groupsForAccounts`; if over `GROUP_LIMIT` call `fail("bad_request", groupLimitMessage(n))` with no model call; pass `groups` to `runGenerationStep`, `buildRecord`, `saveGeneratedPost`
- [ ] T037 [US5] `src/server/services/jobs/read.ts` (`getJob`): each target gains `instructions: string | null | "not_recorded"`; show "Posting instructions (as of job creation)" list in `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx` (removed accounts as "Removed account"; pre-feature jobs "Not recorded: uses each account's current instructions")
- [ ] T038 [US5] Integration tests `tests/integration/jobs/posting-instructions.test.ts`: UI/CSV/API-created jobs store a snapshot; after editing an account mid-job, `runTick` items (including API-appended, deferred correction retry and manually retried items) use the snapshot in prompt and record; second job uses new text; removed account dropped while others keep snapshot; seeded pre-feature job (`NULL`) uses current instructions and records what was used; >16 groups refused at creation; job page shows snapshot / "Not recorded"

---

## Phase 8: User Story 6 — Try it and series use the chosen accounts (P2)

**Goal**: Try it chooses accounts instead of platforms; series covered via Phase 5 wiring.
**Independent test**: `pnpm vitest run tests/integration/generation/try-it-accounts.test.ts`

- [ ] T039 [US6] `src/server/services/voice.ts`: replace `tryVoiceSchema` with `accountIds` (uuid array, min 1, max `TARGET_ACCOUNTS_MAX`, unique, optional) + `draft: voiceContentInputSchema.optional()` + `versionId`; `tryVoice` resolves accounts (`loadAccounts` for given ids, else project accounts in list order while groups stay within the limit; none → `ConflictError("Connect an account to try the voice.")`), groups, `assertGroupLimit`, `runGeneration`, writes nothing; `TryItVariant` becomes `{key, providerKey, providerName, accountNames, text, count, limit, countingRule, issues}`; remove `TRY_IT_PLATFORMS_MAX`
- [ ] T040 [US6] `src/app/p/[projectSlug]/voice/TryItPanel.tsx` and `voice/page.tsx`: "Accounts" fieldset (checkbox per account "{displayName} ({providerName})", default selection within the limit via `groupTargets`, live group-limit message), props `accounts: AccountOption[]`, `EmptyState` "Connect an account to try this voice. Go to Accounts" linking to Accounts, sample cards headed "{providerName}: {accountNames}", "Samples are not saved." kept
- [ ] T041 [US6] Tests `tests/integration/generation/try-it-accounts.test.ts` (two Bluesky accounts, different instructions → two samples labelled by account; post/failure/version counts unchanged; no accounts → ConflictError) and extend the TryItPanel component test (empty state, default selection, live limit message); add a series test in `tests/integration/generation/posting-instructions.test.ts` asserting plan and each series post prompt contains the section and each post record carries the snapshot

---

## Phase 9: User Story 7 — Integrations read posting instructions (P3)

**Goal**: `GET /api/v1/accounts` returns `postingInstructions`; OpenAPI valid.
**Independent test**: `pnpm vitest run tests/integration/api/endpoints tests/integration/api/openapi.test.ts`

- [ ] T042 [P] [US7] Add `postingInstructions: z.string().nullable().meta({description})` to `AccountSchema` in `src/lib/api/schemas.ts` and `postingInstructions: a.postingInstructions` to `toApiAccount` in `src/server/services/views/account.ts` (webhook `account.*` bodies share it)
- [ ] T043 [US7] In `src/server/api/operations/generate.ts` make `problems[].message` use the group label (`bluesky: …` or `bluesky_2 (Bluesky: Acme News): …`)
- [ ] T044 [US7] Tests: extend `tests/integration/api/endpoints` accounts test (each item has `postingInstructions` text or `null`; cross-project not visible; `/generate` uses grouping, request shape unchanged; problem label) and `tests/integration/api/openapi.test.ts` (document validates with `@seriousme/openapi-schema-validator`; `components.schemas.Account.properties.postingInstructions` exists, string/null, in `required`)

---

## Phase 10: Polish & cross-cutting

- [ ] T045 [P] Update `docs/generator.md` (voice vs posting instructions, prompt order, grouping, 16-group limit, snapshots in metadata and jobs, migration) and `docs/accounts.md` (new field, who can edit it)
- [ ] T046 [P] Add a `## 011` section to `docs/decisions.md` with all FR-027 entries: job snapshot decision, migration and removal of per-platform guidance from the voice, 16-group limit and its UNVERIFIED R1 basis, 2,000-char limit, "identical" rule, pre-existing jobs use current instructions, regenerate uses current instructions, plus plan readings (a) stray `platformGuidance` stripped and (b) `/generate` limit 400 replayed under its idempotency key
- [ ] T047 Final pass, run synchronously: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`; fix any failures; confirm the `pre-011-prompts.json` golden test still passes unmodified and that grep finds no remaining read of `platformGuidance` in `src/server/services/generation/` (`rg platformGuidance src/server/services/generation`)

---

## Dependencies & execution order

- **Phase 1** → **Phase 2** → all stories. T001–T002 must land before T017/T018.
- **US1** (Phase 3) needs T003, T004, T008 only; it is the MVP and can ship alone.
- **US2** (Phase 4) needs Phase 2 (T005, T007, T009) and T002; it is the core value.
- **US3** (Phase 5) needs US2's `single.ts` wiring (T020) for the single caller; series/regenerate wiring (T026) follows T019. The Try it, job and API legs of T029 are asserted after US5/US6/US7 land, so write T029 last in its phase and finish it after T035, T039 and T042 (its cases for those callers may be added then).
- **US4** needs T031 before US6 (T039 uses `voiceContentInputSchema`).
- **US5** needs T009 and T019/T020 (`groups` threaded through `runGenerationStep`, `buildRecord`, `saveGeneratedPost`).
- **US6** needs T031 and T019.
- **US7** only needs T003 (column), so T042 can run any time after Phase 2.
- **Polish** last.

## Parallel opportunities

- Phase 2: T005, T006, T007 together; then T008, T009, T010.
- US1: T013 and T015 in parallel with T011/T012.
- US2: T021 with T022 once T017–T020 land.
- US4: T032 and T033 together.
- US7: T042 can run alongside any story after Phase 2.
- Polish: T045 and T046 together.

## Implementation strategy

1. **MVP**: Phases 1–3 (golden fixtures, foundation, US1): owners can record instructions with an audit trail.
2. Add US2 and US3 (both P1): grouped generation with the limit guard; this is the full value.
3. Add US4 (voice cleanup, so the prompt has no second source), then US5, US6, US7 as independent increments.
4. Finish with docs, decisions and the full lint / typecheck / test / db:check / build pass.

No task needs a human, browser or deployed surface, so none is marked `🛑 BLOCKED`. Model compliance with the instructions stays "verified with fakes only" (quickstart § What stays unverified).
