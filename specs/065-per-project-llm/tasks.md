---

description: "Task list for Per-project LLM — a project can bring its own model and API key"
---

# Tasks: Per-project LLM — a project can bring its own model and API key

**Input**: Design documents from `specs/065-per-project-llm/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md) (L1–L33),
[data-model.md](./data-model.md), [contracts/resolution.md](./contracts/resolution.md),
[contracts/services.md](./contracts/services.md), [contracts/ui.md](./contracts/ui.md),
[contracts/cli.md](./contracts/cli.md), [quickstart.md](./quickstart.md)

**Tests**: Included. The spec and plan require them explicitly (constitution II: "nothing is working
unless it ran"; FR-030's extended secret scan; the per-story test files quickstart.md names). Every
live-provider behaviour is verified with **mocked HTTP only** — no test in this feature opens a socket to
a provider.

**Organization**: Tasks are grouped by the four P1 user stories in spec.md. All four are priority P1 —
this entry has no MVP subset smaller than itself (US1 is the core; US2, US3 and US4 are each a roadmap
requirement named by sentence in the spec, not an enhancement). They are ordered US1 → US2 → US3 → US4 to
match the spec's own ordering and because US2's check and US3's hold reuse US1's resolution, and US4's
surface is how US1–US3 are reached by a person.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task in this set)
- **[Story]**: US1 / US2 / US3 / US4, per spec.md
- Every task names an exact file path

## Path Conventions

Existing single Next.js application. `src/server/` (DAL, services, llm provider layer), `src/app/`
(routes), `src/lib/` (shared validation and text), `scripts/` (operator CLI), `drizzle/` (migrations),
`tests/` (integration), colocated `*.test.ts` beside the module they test.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The one new table and its migration, which everything else is built on.

- [X] T001 Add the `projectLlmSettings` table definition (`project_id` PK/FK CASCADE, nullable
  `provider`/`model`/`api_key_encrypted`, `updated_at`, `updated_by_user_id`, `last_check_at`,
  `check_lease_until`, and the four CHECK constraints from data-model.md §1) in
  `src/server/db/schema/generation.ts`, beside `llmCreditHolds`
- [X] T002 [P] Add the `llm_credential_update` value to the `membershipAction` pgEnum in
  `src/server/db/schema/audit.ts`
- [X] T003 Register `project_llm_settings` in `projectOwnedTables` with `scopeColumn: "project_id"` in
  `src/server/db/project-owned.ts`
- [X] T004 Generate migration `drizzle/0024_*.sql` (+ `drizzle/meta/`) for T001–T003 with `pnpm db:generate`,
  confirm it matches data-model.md §6 (one `ALTER TYPE … ADD VALUE`, one `CREATE TABLE`, two FKs, no
  `UPDATE`/`ALTER` of an existing column), and run `pnpm db:check`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one resolution function, the DAL it reads through, and the permission/validation/text
building blocks every user story's work calls. No user story can start until this phase is green.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T005 [P] Add `parseLlmLimits(source)` to `src/server/llm/config.ts` and make `parseLlmConfig`
  delegate to it, fixing in passing the hard-coded 90000 `llmTimeoutMs()` falls back to whenever the
  provider group is incomplete (L8)
- [ ] T006 [P] Add `setLlmFactoryForTests(fn)` to `src/server/llm/index.ts`, consulted only when
  `setLlmForTests`'s override is unset; `getLlm()`/`getLlmStatus()`/`missingLlmSettings()` keep their exact
  signatures and behaviour (L13)
- [ ] T007 Create `src/server/dal/project-llm.ts`: `ProjectLlmRow`, `ProjectLlmStatusRow`,
  `ProjectLlmRepo` (`read`, `status`, `save`, `clear`, `claimCheck`, `releaseCheck`),
  `createProjectLlmRepo(exec, projectId)`, and `anyProjectHasCredential(exec?)` per
  contracts/resolution.md §4 and the claim/release statements in data-model.md §5
- [ ] T008 Wire `scope.projectLlm = createProjectLlmRepo(...)` into `ProjectScope` in
  `src/server/dal/scope.ts` (depends on T007)
- [ ] T009 Create `src/server/llm/resolve.ts`: the `ResolvedLlm` discriminated union and
  `resolveLlmForProject(projectId)` implementing the algorithm in contracts/resolution.md §1 — test
  override first, then the project's decrypted credential (never falling back to the install credential on
  `SecretDecryptionError`), then the install via `parseLlmConfig`/`getLlm()`, with `limits` always from
  `parseLlmLimits` (depends on T005, T006, T007)
- [ ] T010 [P] Widen `credentialOwnerFor` to read `project_llm_settings` (owner becomes `project:<id>` when
  a credential is set) and add the batch sibling `credentialOwnersFor(projectIds, exec?)` in
  `src/server/dal/credential-owners.ts`, keeping `INSTALL_CREDENTIAL_OWNER` and `jobsExcludingProjects`
  unchanged
- [ ] T011 [P] Add an optional `exec` parameter to `clearCreditHold(owner, exec?)` in
  `src/server/dal/credit-holds.ts`, the way `rewindCreditProbe` already has one
- [ ] T012 [P] Add the `llm_credential: ["manage"]` permission statement to
  `src/server/auth/access.ts`, granted to `owner` and `admin` only, absent from `editor`
- [ ] T013 [P] Add `LLM_API_KEY_MAX`, `llmModelIdSchema` and `projectLlmCredentialSchema` to
  `src/lib/validation/generation.ts` per contracts/services.md §4 (model rule matches
  `parseLlmConfig`'s own; no message quotes a submitted value)
- [ ] T014 [P] Create `src/lib/generation/llm-source.ts` with `LLM_KEY_UNREADABLE`, `LLM_CHECK_BUSY`,
  `LLM_SOURCE_INSTALL` and `LLM_SOURCE_PROJECT`
- [ ] T015 [P] Add `CREDIT_HOLD_ACCOUNT_PROJECT` to `src/lib/jobs/credit-hold.ts`, keeping its five
  existing constants unchanged
- [ ] T016 Extend `src/server/llm/key-reads.test.ts` (or a named sibling) asserting `apiKeyEncrypted` /
  `api_key_encrypted` appears only in the schema, `src/server/dal/project-llm.ts` and
  `src/server/llm/resolve.ts`, and that `decryptSecret` is applied to it only in `resolve.ts` (depends on
  T007, T009)

**Checkpoint**: Foundation ready — `resolveLlmForProject` exists and is correct in isolation; every user
story below only has to call it.

---

## Phase 3: User Story 1 - A project brings its own model and key (Priority: P1) 🎯 Core

**Goal**: Every generation path in a project resolves to that project's stored credential when it has one,
and to the install default otherwise, with no restart and no stale cache.

**Independent Test**: Set a project credential through `setLlmFactoryForTests` with a stubbed provider per
key, run one single generation and one job item in that project and one of each in a project without an
override, and check that each call used the credential its own project resolves to.

### Tests for User Story 1

- [ ] T017 [P] [US1] Write `src/server/llm/resolve.test.ts` covering AS1 (env-only unchanged), AS3 (no
  restart/no cache), AS4 (`LLM_PROVIDER` unset: project with credential available, project without still
  not-configured), AS5 (removal reverts to install), AS6 (install-wide limits apply from either source)
- [ ] T018 [P] [US1] Write `tests/integration/llm/per-project-resolution.test.ts`: two projects on two
  `setLlmFactoryForTests` stubs, one single generation, one series plan, one regenerate, one "Try it", one
  job item and one public-API generation in each project, asserting each call carried its own project's
  key (AS2)

### Implementation for User Story 1

- [ ] T019 [P] [US1] Update `src/server/services/generation/core.ts`: `runGeneration`'s default resolves
  via `resolveLlmForProject(scope.project.id)`; `runGenerationStep` calls
  `withCreditHold(llm, resolved.owner)` instead of a second `credentialOwnerFor` call (L11)
- [ ] T020 [P] [US1] Update `src/server/services/generation/series.ts`: `planSeries`'s default resolves via
  `resolveLlmForProject`
- [ ] T021 [P] [US1] Update `src/server/services/generation/regenerate.ts`: its optional `llm` parameter is
  still passed through unchanged; its default now resolves
- [ ] T022 [P] [US1] Update `src/server/services/jobs/runner.ts`: per item,
  `ctx.llm ?? (await resolveLlmForProject(job.projectId))`; a non-`ok` resolution calls the existing
  `release()` (item returns to `queued`, no attempt counted, nothing failed) and increments a new
  `notConfigured` per-item counter; `llmTimeoutMs()` uses `parseLlmLimits(process.env)`; `logLine()` redacts
  the resolved key, not only the environment's (L8, L27, L30)
- [ ] T023 [P] [US1] Update `src/server/services/jobs/create.ts`: resolve per scope instead of calling
  `getLlmStatus()`
- [ ] T024 [P] [US1] Update `src/server/services/generation/readiness.ts`: `getGenerationReadiness`'s `ai`
  field becomes `{ configured, source, provider, model, missingSettings, keyUnreadable }` from resolution
- [ ] T025 [P] [US1] Update `src/server/services/overview.ts`: `getOverview`'s LLM facts come from
  resolution, so a project with its own credential reports generation available even when the install has
  none
- [ ] T026 [P] [US1] Update `src/server/scheduler/generation.ts`: the early-return gate becomes
  `!getLlmStatus().configured && !(await anyProjectHasCredential())`
- [ ] T027 [US1] Confirm `src/server/services/voice.ts`'s "Try it" path needs no direct change (it resolves
  through `runGeneration`'s default from T019) and add a regression assertion for it in
  `per-project-resolution.test.ts` if one is not already present

**Checkpoint**: User Story 1 is independently functional — single, series, regenerate, "Try it", job items
and the scheduler all resolve per project, and an env-only install is observably unchanged.

---

## Phase 4: User Story 2 - A key can be checked before a 500-item job (Priority: P1)

**Goal**: One check implementation, callable from the settings surface and from the command line, that
makes one bounded live call and reports source, provider, model, outcome and latency without saving
anything.

**Independent Test**: With the provider stubbed to succeed, then to refuse on auth, then to time out, run
the check through the service and through the command line for the same project and compare the reported
outcome in each case.

### Tests for User Story 2

- [ ] T028 [P] [US2] Write `tests/integration/llm/check.test.ts` covering AS1–AS6 (success reports and
  saves nothing; a wrong key reports the one fixed sentence; no credential checks the install default; at
  most one check at a time with the cooldown refusing a second; a billing refusal sets then clears the
  project's hold) and SC-003 (the call's timeout is `min(installTimeoutMs, LLM_CHECK_TIMEOUT_MS)`)
- [ ] T029 [P] [US2] Extend `scripts/llm-check.test.ts` for the `--project <slug>` path (prints
  `source=… provider=… model=… outcome=… latency_ms=…`, exits non-zero on failure) while asserting the
  no-argument path's lines and exit codes are byte-identical to today; extend the guard test from T016 to
  assert `runLlmCheck` is imported only by `check.ts`'s own siblings and `scripts/llm-check.ts`

### Implementation for User Story 2

- [ ] T030 [US2] Create `src/server/services/generation/check.ts`: `LLM_CHECK_COOLDOWN_MS` (30000),
  `LLM_CHECK_LEASE_MS` (60000), `LLM_CHECK_TIMEOUT_MS` (30000), `LlmCheckResult`,
  `runLlmCheck(projectId, repo)` (resolve → claim-or-refuse-as-busy → one call through
  `withCreditHold(resolved.llm, resolved.owner)` → release in `finally` → map to the fixed sentence) and
  `checkProjectLlm(scope)` (`need(scope)` then `runLlmCheck`), per contracts/services.md §3 (depends on
  T007, T009)
- [ ] T031 [US2] Update `scripts/llm-check.ts`: add the optional `--project <slug>` argument (usage error on
  a bad flag, exit 2), resolve the slug to a project id via a named
  `crossProject("llm:check: resolve project", …)` read with no session, call the same `checkProjectLlm`
  path (`runLlmCheck` with a pinned repo), print the one `key=value` line, and keep the no-argument path
  byte-identical (depends on T030)

**Checkpoint**: User Story 2 is independently functional from both the service layer and the CLI, with the
same verdict vocabulary in both places.

---

## Phase 5: User Story 3 - One project running dry does not hold another's jobs (Priority: P1)

**Goal**: A credit hold is scoped to the credential's owner, so a project on its own key that runs dry does
not pause a project on the install default, and vice versa; each owner has its own probe schedule; a fixed
credential clears its own hold at once; an orphaned hold row is swept.

**Independent Test**: Queue jobs in two projects with different credentials, stub one provider to refuse on
billing, run ticks, and check that the funded project's throughput is unchanged while the dry project's
items stay queued with no attempt counted and none failed.

### Tests for User Story 3

- [ ] T032 [P] [US3] Write `tests/integration/llm/hold-scope.test.ts` covering AS1–AS7 (isolation,
  install-default projects held together, independent probe schedules, a save clearing the hold at once,
  the notice naming whose account, no notice in a different funded project, deletion leaving nothing
  behind) and SC-006 (unchanged throughput for the funded project)
- [ ] T033 [P] [US3] Extend `tests/integration/jobs/credit-hold.test.ts` to confirm entry 1's full suite
  (probe single-flight, rewind, kill-recovery, no-retry-on-ambiguous, nothing failed while held) passes
  unchanged with the widened owner

### Implementation for User Story 3

- [ ] T034 [P] [US3] Update `src/server/dal/job-claims.ts`: `resolveBlockedProjectIds` uses
  `credentialOwnersFor` (T010) instead of one round trip per candidate project, so the claim transaction's
  statement count stops growing with project count
- [ ] T035 [US3] Update `src/server/services/jobs/read.ts`: `generationCreditHold(scope)` returns
  `{ since, scope: "project" | "install" }`; `getJobView`'s `creditHold` field carries that scope (depends
  on T034)
- [ ] T036 [US3] Update `src/app/p/[projectSlug]/jobs/CreditHoldNotice.tsx`: add a `scope` prop that picks
  `CREDIT_HOLD_ACCOUNT_PROJECT` for `"project"` and keeps the existing `CREDIT_HOLD_ACTION` for `"install"`
  (depends on T015, T035)
- [ ] T037 [US3] Update `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx`: pass the resolved `scope` through
  to the notice, and add the `key_unreadable` branch rendering `LLM_KEY_UNREADABLE` instead of the
  "Set: …" list (depends on T036)
- [ ] T038 [P] [US3] Add `pruneOrphanCreditHolds()` (`ORPHAN_HOLD_BATCH = 100`) to
  `src/server/scheduler/housekeeping.ts` and `orphanHoldsPruned` to `HousekeepingCounts`, through the
  existing named `crossProject` hatch the other purges use

**Checkpoint**: User Story 3 is independently functional — hold isolation, per-owner probes, instant
recovery on save, and no orphaned hold rows after a project is deleted.

---

## Phase 6: User Story 4 - A key never leaks, and only owners and admins can touch it (Priority: P1)

**Goal**: The settings surface to set, check and remove a project's credential, restricted to owner and
admin, renders no character of the key anywhere, and the extended secret scan proves it end to end.

**Independent Test**: Run the extended secret scan over a scanned run that stores a project key, renders
the settings page for owner, admin and editor, runs a check, runs a tick that generates, and takes a
billing refusal whose provider error body embeds that key; then dump every table and assert the key
appears nowhere in any form.

### Tests for User Story 4

- [ ] T039 [P] [US4] Write `tests/integration/llm/credential-authz.test.ts`: an editor's sub-nav has no
  item, the page 404s, and `saveProjectLlm`/`removeProjectLlm`/`checkProjectLlm` each throw `ForbiddenError`
  with nothing changed; the rendered page for owner and admin contains neither the key nor any 4-character
  substring of it
- [ ] T040 [P] [US4] Extend `tests/integration/security/secret-scan.test.ts` with the project-key section
  (L32): set, change and remove through the real server actions; the settings page rendered for owner,
  admin and editor; a check; a tick that generates on that credential; a billing refusal whose provider
  error body embeds that key — scanned in raw, base64, base64url, URL-encoded and hex across console,
  responses, rendered pages, audit rows and every database column, with nothing exempted, and the file's
  deliberate-leak test still failing on a planted leak
- [ ] T041 [P] [US4] Extend `tests/integration/no-plaintext.test.ts` to include the stored project key and
  its SHA-256 hex, and to dump `project_llm_settings` before the existing all-tables scan

### Implementation for User Story 4

- [ ] T042 [US4] Create `src/server/services/generation/credential.ts`: `ProjectLlmView`,
  `getProjectLlm(scope)` (via `scope.projectLlm.status()`, which cannot return a ciphertext),
  `saveProjectLlm(scope, input)` (parse → `need(scope)` → decide the key per FR-015/K8 →
  one `scope.transaction({ lockProject: true })` doing save + audit + `clearCreditHold("project:<id>", tx)`)
  and `removeProjectLlm(scope)` (same transaction shape, nulling the credential) per
  contracts/services.md §2 (depends on T008, T009, T011, T012, T013)
- [ ] T043 [US4] Create `src/app/p/[projectSlug]/settings/model/page.tsx` (server component: calls
  `getProjectLlm(scope)`, `notFound()` on `ForbiddenError`/no access) (depends on T042)
- [ ] T044 [P] [US4] Create `src/app/p/[projectSlug]/settings/model/loading.tsx` (`Skeleton`, matching the
  api-keys page)
- [ ] T045 [US4] Create `src/app/p/[projectSlug]/settings/model/ModelPanel.tsx` (client component: the
  "in use now" line, "Last changed by … on …" via `LocalTime`, the `SegmentedControl` provider choice, the
  write-only `type="password"` model/key `Field`s with `keyMaxLength` from the server view, the save form,
  "Check this credential" with its `role="status"` outcome, and the confirmed remove `Dialog`) per
  contracts/ui.md §2 (depends on T043)
- [ ] T046 [US4] Create `src/app/p/[projectSlug]/settings/model/actions.ts`: `saveProjectModel`,
  `removeProjectModel`, `checkProjectModel`, each through the existing `runAction` helper, calling
  `saveProjectLlm`/`removeProjectLlm`/`checkProjectLlm` and `revalidatePath`ing the settings page (depends
  on T030, T042, T045)
- [ ] T047 [US4] Update `src/app/p/[projectSlug]/settings/layout.tsx`: add the "Model & API key" sub-nav
  item behind `scope.can({ llm_credential: ["manage"] })`, beside the existing `canManageApi` check
  (depends on T012)

**Checkpoint**: User Story 4 is independently functional — the surface exists, is role-gated server-side as
well as in the UI, and the extended secret scan proves no leak in any of the forms it already checks.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: The documentation obligations the roadmap attaches to this entry by name, and the full-suite
proof that the repository is left working.

- [ ] T048 [P] Update `docs/generator.md`: replace "Keys are read from the environment only and never
  stored, logged or rendered" in place, under its existing headings, with what is now true; add the
  "Per-project provider, model and key" subsection (resolution, who may set one, the check, the
  undecryptable case); widen the "Jobs" hold paragraph for per-owner scope (FR-031)
- [ ] T049 [P] Add `docs/decisions.md` § 046 — Per-project LLM, carrying K1–K16 and L1–L33 next to the
  generator decisions and entry 1's C/H sets, with its own line stating that an install that only ever used
  environment variables needs to do nothing and behaves exactly as before (FR-031)
- [ ] T050 [P] Update `docs/security.md`: update the four existing secret rows to name the stored project
  key and its new places, and add one row for the credential at rest naming the tests that prove it
  (FR-031, checked by `tests/integration/docs/security-findings.test.ts`)
- [ ] T051 [P] Update `.env.example`'s generator block to note that a project may also store its own
  credential, adding no new variable (FR-031, checked by `tests/lint/env-coverage.test.ts`)
- [ ] T052 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`; the whole existing
  suite — `src/server/llm/*.test.ts`, `scripts/llm-check.test.ts`, every `tests/integration/jobs/*.test.ts`,
  every generation golden/snapshot file — must pass **unchanged**, not re-snapshotted (SC-001, FR-032);
  fix any regression found rather than adjusting its expectation
- [ ] T053 Human-owned: the manual walk-through in quickstart.md §4 — needs a signed-in browser session as
  owner, admin and editor against `pnpm dev`. Set a credential, check it, generate, remove it, check again
  as owner; repeat as admin; confirm the editor sees no sub-nav item and the URL 404s; operate every
  control keyboard-only including the `SegmentedControl` and the remove `Dialog`; confirm save/check/remove
  work with client JavaScript disabled; confirm no screen, toast or page source contains any part of the
  key. If this window has closed before the task is picked up, mark it so and state why rather than leaving
  it open.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (needs the table to exist) — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 2 (Phase 4)**: Depends on Foundational only; does not depend on US1 (it calls
  `resolveLlmForProject` and the DAL directly), though in practice it is implemented after US1 lands.
- **User Story 3 (Phase 5)**: Depends on Foundational (T010's `credentialOwnersFor`) and is best done after
  US1 so there is something generating to hold.
- **User Story 4 (Phase 6)**: Depends on Foundational; its actions (T046) also depend on US2's
  `checkProjectLlm` (T030), so US4 is implemented after US2.
- **Polish (Phase 7)**: Depends on all four user stories being complete.

### Within Each User Story

- Tests are written first and must fail before the implementation task that makes them pass.
- US1's resolution call-site updates (T019–T026) each touch a different file and have no dependency on one
  another once Foundational is done.
- US4's surface (T043–T047) is a dependency chain through one feature's own new files: service → page →
  panel → actions → nav.

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel once T001 lands (T002); T003/T004 are sequential on it.
- Foundational tasks T005, T006, T010–T015 are mutually independent and can run in parallel; T007→T008→T009
  and T016 are a short chain.
- Once Foundational is done, US1, US2's tests, and US3's `job-claims.ts` work can all start in parallel; US4
  waits on US2's `check.ts` for its actions file.
- Within US1, T019–T026 (eight different files) can all run in parallel.

---

## Parallel Example: Foundational phase

```bash
# Launch independent foundational tasks together once T001-T004 (Setup) land:
Task: "Add parseLlmLimits to src/server/llm/config.ts"
Task: "Add setLlmFactoryForTests to src/server/llm/index.ts"
Task: "Widen credentialOwnerFor + add credentialOwnersFor in src/server/dal/credential-owners.ts"
Task: "Add optional exec parameter to clearCreditHold in src/server/dal/credit-holds.ts"
Task: "Add llm_credential permission statement to src/server/auth/access.ts"
Task: "Add projectLlmCredentialSchema to src/lib/validation/generation.ts"
Task: "Create src/lib/generation/llm-source.ts"
Task: "Add CREDIT_HOLD_ACCOUNT_PROJECT to src/lib/jobs/credit-hold.ts"
```

## Parallel Example: User Story 1 resolution call sites

```bash
# After T009 (resolveLlmForProject) exists, these eight files can all change in parallel:
Task: "Update src/server/services/generation/core.ts"
Task: "Update src/server/services/generation/series.ts"
Task: "Update src/server/services/generation/regenerate.ts"
Task: "Update src/server/services/jobs/runner.ts"
Task: "Update src/server/services/jobs/create.ts"
Task: "Update src/server/services/generation/readiness.ts"
Task: "Update src/server/services/overview.ts"
Task: "Update src/server/scheduler/generation.ts"
```

---

## Implementation Strategy

### Build order

1. Setup (T001–T004): the table and migration.
2. Foundational (T005–T016): resolution, DAL, permission, validation, text — nothing user-visible yet.
3. US1 (T017–T027): every generation path resolves per project. **Stop and validate**: run
   `tests/integration/llm/per-project-resolution.test.ts` and `src/server/llm/resolve.test.ts` green.
4. US2 (T028–T031): the check, service and CLI. Validate with `tests/integration/llm/check.test.ts` and
   `scripts/llm-check.test.ts`.
5. US3 (T032–T038): hold isolation, notices, housekeeping. Validate with
   `tests/integration/llm/hold-scope.test.ts` and the entry-1 regression file.
6. US4 (T039–T047): the settings surface and its authorization. Validate with
   `tests/integration/llm/credential-authz.test.ts` and the extended secret-scan/no-plaintext suites.
7. Polish (T048–T053): docs, the full gate, the manual walk-through.

### Why this order and not parallel teams

All four stories are P1, but US2 and US4 each depend on earlier work (US4's actions file needs US2's
`checkProjectLlm`), and US3's hold-scope story is only interesting once US1 makes projects actually
generate on different credentials. A single implementer should go in order; a team of two could run US1
and the Foundational-only parts of US3 (T034, T038) in parallel, then converge for US2/US3/US4.

### Final gate

Nothing in this feature is reported done until T052's full gate (`lint`, `typecheck`, `test`, `db:check`,
`build`) is green and T053's manual walk-through has either been performed or explicitly recorded as
unachievable with a reason.
