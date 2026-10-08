# Tasks: Activity history — one log of publish successes and failures, per project and across projects

**Input**: Design documents in `/specs/020-activity-history/` (plan.md, spec.md, research.md, data-model.md, quickstart.md, contracts/services.md, contracts/ui.md, contracts/http-api.md)

**Prerequisites**: plan.md, spec.md

**Tests**: Required. Spec FR-027 and quickstart §1 map every requirement to a Vitest suite against real Postgres (run-scoped DBs, mock provider, mocked HTTP, `atTime` clock). No live platform calls.

**Execution environment**: Implementation is headless (`claude -p`): no browser, no dev server, no `curl`. Every check below is a Vitest/RTL test, `pnpm typecheck`, `pnpm lint`, `pnpm db:check` or `pnpm build`. Run suites with `pnpm vitest run <file>`.

**Before writing any route**: read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/{page,loading,error}.md` (AGENTS.md: this Next.js has breaking changes; `searchParams` is a Promise).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 from spec.md
- Paths are repo-root relative

## User stories (from spec.md)

- **US1 (P1)** See what happened in one project
- **US2 (P1)** Narrow it down and share the view
- **US3 (P1)** Know at a glance how a period went
- **US4 (P2)** See every project at once
- **US5 (P1)** The log can be trusted (written in the same transaction, backfilled, append-only, no secrets)
- **US6 (P2)** Automations can read the log (`GET /api/v1/activity`)

---

## Phase 1: Setup

- [x] T001 [P] Add the `activity` icon: add it to `scripts/generate-icons.mjs`, run `pnpm icons`, and confirm `src/components/icons/icons.generated.ts` (or the existing generated icons file) contains it
- [x] T002 [P] Create shared pure vocabulary `src/lib/activity/outcomes.ts`: the 7 outcomes, kinds ↔ outcomes (`KIND_OUTCOME`), presets (successes/problems), badge labels and tones per data-model §2
- [x] T003 [P] Create `src/lib/activity/text.ts` (`clipMessage(s, 500)` by code points with "…", `resolvedMessage(details)`, `activityActorLabel`, `outcomeLabel`) and `src/lib/activity/details.ts` (`activityDetailsSchema(kind)`, strict per-kind union per data-model §3)
- [x] T004 [P] Create `src/lib/accounts/connect-banner-text.ts` (`CONNECT_BANNER`, `HINTED_CODES`, `connectBannerText({ code, own, hint })`) by moving the constants out of `src/app/p/[projectSlug]/accounts/page.tsx`, and make that page import them with unchanged behaviour

---

## Phase 2: Foundational (blocks all stories)

**⚠️ No user story starts until this phase is done.**

- [x] T005 Create `src/server/db/schema/activity.ts` (table `activity_events`, 2 enums, CHECKs, 4 indexes, FKs per data-model §1: project cascade, actor FKs like `publish_attempts`, no FKs to posts/targets/accounts, identity `seq`); export it from `src/server/db/schema/index.ts` and add it to `projectOwnedTables` in `src/server/db/project-owned.ts`
- [x] T006 Generate migration `0012` with `pnpm db:generate` (under `drizzle/`), review the SQL against data-model §1, then run `pnpm db:check`
- [x] T007 Create `src/server/dal/activity.ts`: `NewActivityEvent`, `ActivityRepo` (`insert` / `list` / `summary` only — no update or delete), `BranchQuery`, `createActivityRepo(db, projectId)`; one `UNION ALL` branch per window, each pinned `project_id = $k`, with the joins, `(occurred_at, seq)` cursor predicate, outcome/platform (`provider_keys @>`)/account filters; reject foreign-project windows before running SQL (contracts/services §1)
- [x] T008 Wire the repo: add `activity` to `createSchedulingRepos` in `src/server/dal/scope.ts`, export from `src/server/dal/index.ts`
- [x] T009 [P] Create pure `src/server/services/activity/cursor.ts` (`encodeActivityCursor`, `decodeActivityCursor` → value | `null`) and `src/server/services/activity/cursor.test.ts`
- [x] T010 [P] Create pure `src/server/services/activity/filters.ts` (`parseActivityFilter(raw, { mode: "lenient" | "strict", allowProjects })`, `windowFor` using Temporal per project zone, `summaryLabel`, `filterToSearchParams`) and `src/server/services/activity/filters.test.ts` (lenient vs strict, presets, repeated/comma values, NY spring-forward 23 h and fall-back 25 h days, "today" at 00:30 local, `7d`/`30d` include today, `from > to`)
- [x] T011 [P] Create pure `src/server/services/activity/links.ts` (`activityLink(row, projectSlug)`: Failures while target is failed/ambiguous, else post, else accounts for account rows; research P15)
- [x] T012 [P] Create pure `src/server/services/activity/classify.ts` (`eventForStep`, `eventForDecision`, `resolvedEvent`, `needsReauthEvent`, `connectFailedEvent` with secret redaction) and `src/server/services/activity/classify.test.ts` (every step outcome/decision/action/refusal maps to a kind or `null`; continue, deferral-only, lease-only, stale, no-free-slot map to `null`; exhaustion → "Gave up after N attempts")
- [x] T013 [P] Create `src/lib/activity/text.test.ts` and `src/lib/activity/details.test.ts` (clip at 500 code points, strict details reject extra keys, actor labels, `resolvedMessage` per action)
- [x] T014 Create `src/server/services/activity/record.ts` (`recordTargetEvent`, `recordAccountNeedsReauth`, `recordConnectFailed`: thin wrappers over `tx.activity.insert`, no-op on a `null` event)
- [x] T015 Create `src/server/services/activity/index.ts` read side for the project scope: `listProjectActivity(scope, raw)` returning `ActivityPage` (rows via data-model §4 row view, summary, filter, `invalidRange`, `newer`/`older` cursors, accounts and platforms options, page size 50; throws `ForbiddenError` without `post: view`; malformed cursor → first page)

**Checkpoint**: table, repo, pure rules and project-scope reader exist; events can be seeded in tests via `activity.insert`.

---

## Phase 3: User Story 5 — The log can be trusted (Priority: P1) 🎯 data source for everything else

**Goal**: Every publish/failure/recovery/needs-reauth/connect-failure state change writes exactly one event in the transaction that makes the change; a rollback or non-applying change writes none; history survives deletions; no secrets stored; existing data is backfilled.

**Independent Test**: `tests/integration/activity/{scheduler-events,recovery-events,rollback,needs-reauth-events,connect-events,backfill,retention}.test.ts` and the extended secret-scan suite pass.

### Tests for US5

- [x] T016 [P] [US5] `tests/integration/activity/scheduler-events.test.ts`: one event per applied step result (published, fatal, G15 validation, retryable, exhaustion, ambiguous); none for continue/stale (lost lease); engine settles, lease recovery, deferral with no event
- [x] T017 [P] [US5] `tests/integration/activity/recovery-events.test.ts`: retry now, requeue, at; none for no-free-slot; resolve published / not published / no free slot (→ failed) / requeued; bulk retry only retried targets with `bulk_retry`; API actions carry `actor_api_key_id`
- [x] T018 [P] [US5] `tests/integration/activity/rollback.test.ts`: a throw after the target update inside `withLockedTarget` and inside `recordStepResult` leaves 0 events; two concurrent resolves leave exactly 1 event from the winner
- [x] T019 [P] [US5] `tests/integration/activity/needs-reauth-events.test.ts`: scheduled renewal refusal, publish-time refusal, G7 credentials invalid, token-refresh catch path; already-`needs_reauth` account and lost lease write none
- [x] T020 [P] [US5] `tests/integration/activity/connect-events.test.ts` (mocked HTTP): OAuth `platform_error` (stored message identical to banner text), `exchange_failed` thrown and refused, `no_candidates`, `too_many`; paste refused/unreachable/none/too many; credentials refused/unreachable/different account; **none** for cancelled, forged, unknown, expired, reused or foreign state, `not_allowed`, field validation, empty or expired chooser
- [x] T021 [P] [US5] `tests/integration/activity/backfill.test.ts`: seed published, failed (provider, engine, resolved-not-published), ambiguous targets and a `needs_reauth` account; run `drizzle/0013_*.sql` twice → 1 event each at real times with the right actor, re-run adds 0, a target with a live event gets no backfill row, whole-ms times
- [x] T022 [P] [US5] `tests/integration/activity/retention.test.ts`: soft-deleting a post and removing an account keep events ("Post deleted", "Removed account"); deleting a project removes them; `ActivityRepo` exposes no update/delete

### Implementation for US5

- [x] T023 [US5] Edit `src/server/scheduler/record.ts`: `RecordInput` gains optional `socialAccountId`, `providerKey`, `postId`; when `applied`, insert `eventForStep(...)` in the same transaction
- [x] T024 [US5] Edit `src/server/dal/scheduler.ts`: `ClaimDecision.activity?: NewActivityEvent`, inserted by `claimDueTargets` via `createActivityRepo(exec, row.projectId)` right after the attempts, in the claim transaction
- [x] T025 [US5] Edit `src/server/scheduler/publishing.ts`: `decide()` attaches `activity: eventForDecision(...)` to settled, failed and recovered-retry decisions; `execute()` passes the account to `recordStepResult`
- [x] T026 [P] [US5] Edit `src/server/scheduler/credentials.ts`: when `changed && previousStatus === "active"`, both helpers also call `recordAccountNeedsReauth(tx, id, reason)` (`renewal_refused` / `credentials_invalid`)
- [x] T027 [P] [US5] Edit `src/server/services/posts/retry.ts` (`retryLockedTarget(tx, target, now, input, opts?: { via?: "bulk" })` inserts `resolvedEvent` after each successful update, none on no-free-slot) and `src/server/services/posts/retry-all.ts` (`retryOne` passes `{ via: "bulk" }`)
- [x] T028 [US5] Edit `src/server/services/posts/index.ts`: each of the four `resolveAmbiguous` branches inserts `resolvedEvent` after its guarded update succeeds
- [x] T029 [P] [US5] Edit `src/server/services/connect.ts`: `handleOAuthCallback`'s `finish` writes the event and `complete` in one `scope.transaction` for the D4 codes; `pasteConnectToken` records its four refusals; both use `connectBannerText`; redact against code/state/pasted token
- [x] T030 [P] [US5] Edit `src/server/services/accounts.ts`: `connectWithCredentials` records `credentials_refused`, `credentials_unreachable`, `different_account` (redacted message), not `fieldErrors` validation
- [x] T031 [US5] Generate the custom backfill migration (`pnpm drizzle-kit generate --custom --name backfill_activity_events`), write idempotent `NOT EXISTS` SQL in `drizzle/0013_backfill_activity_events.sql` per data-model §6, then `pnpm db:check`
- [x] T032 [US5] Extend `tests/integration/security/secret-scan.test.ts` (SC-006): a provider error, refresh reason, credential-connect message and OAuth `error_description` each echo a token/password/app secret; stored `message`/`details` contain none
- [x] T033 [US5] Run guard suites for changed call sites: `pnpm vitest run` on the existing 002/012/015/016 scheduler, retry, resolve and connect suites plus T016–T022; fix regressions

**Checkpoint**: events are produced and backfilled; US1+ can read real data.

---

## Phase 4: User Story 1 — See what happened in one project (Priority: P1)

**Goal**: `/p/[projectSlug]/activity` lists events newest first with outcome, platform/account, post excerpt, message, actor and a recovery link, with Older/Newer paging.

**Independent Test**: `tests/integration/activity/project-list.test.ts` and `ui.test.tsx` pass.

- [x] T034 [P] [US1] `tests/integration/activity/project-list.test.ts`: newest-first, stable ties, Older/Newer with no repeats or gaps while events are inserted between loads, links (Failures while failed/ambiguous, post after moving on, accounts for account rows), foreign-account filter → empty
- [x] T035 [P] [US1] `tests/integration/activity/ui.test.tsx` (RTL): outcome badge text; row variants (live target, moved-on target, deleted post, removed account, former member, removed API key, group connect failure); empty state; labelled controls
- [x] T036 [P] [US1] Create `src/components/ui/CursorPagination.tsx` (`<nav aria-label="Pagination">`, "Newer" `rel="prev"`, "Older" `rel="next"`, disabled span for a missing direction)
- [x] T037 [P] [US1] Create `src/components/activity/ActivityRow.tsx` and `src/components/activity/ActivityList.tsx` (table with sr-only caption, `th scope="col"`, `LocalTime` in the row's project zone, Badge, ProviderIcon, post link / "Post deleted" / "—", details as text, actor, optional Project column, visible link label)
- [x] T038 [US1] Create `src/app/p/[projectSlug]/activity/page.tsx` (`force-dynamic`, `metadata.title` "Activity", awaits `searchParams`, `PageHeader` with zone, list + pagination, empty/no-filter state with "Compose a post") and `src/app/p/[projectSlug]/activity/loading.tsx` (Skeleton)
- [x] T039 [US1] Add "Activity" (slug `activity`, group Publish, icon `activity`) directly after Failures in `src/components/shell/LeftNav.tsx`; extend `tests/integration/failures/nav.test.ts`
- [x] T040 [US1] Edit `src/server/services/failures.ts` (`failuresQuerySchema.target`), `src/server/dal/targets.ts` (`listAttention({ targetId })`) and `src/app/p/[projectSlug]/failures/page.tsx` (`?target=` shows one entry, "Show all failures" link, row `id="target-<id>"`); extend the failures tests

**Checkpoint**: US1 works alone.

---

## Phase 5: User Story 2 — Narrow it down and share the view (Priority: P1)

**Goal**: Filter by outcome, preset, platform, account, date range; the URL is the shareable state.

**Independent Test**: filter cases in `project-list.test.ts` and `ui.test.tsx` pass.

- [X] T041 [P] [US2] Extend `tests/integration/activity/project-list.test.ts` with each filter alone and combined, `from > to` (empty, no rows), Older/Newer keeping filters
- [X] T042 [US2] Create `src/components/activity/ActivityFilters.tsx` (GET form: outcome checkbox fieldset, "All / Successes / Problems" `FilterTabs`, `ChoiceField` Platform/Account with `autoSubmit` + `<noscript>` Apply, From/To date inputs with "Days in {zone}" help, Today/7 days/30 days links with `aria-current`, "Clear filters"; changing a filter drops `before`/`after`)
- [X] T043 [US2] Wire filters into `src/app/p/[projectSlug]/activity/page.tsx`: render `ActivityFilters`, `role="alert"` message "The start date is after the end date.", "No activity matches these filters." empty state with "Clear filters"
- [X] T044 [US2] Extend `tests/integration/activity/ui.test.tsx`: labelled controls, keyboard operation of filters, range message, filtered-empty state

---

## Phase 6: User Story 3 — Summary of a period (Priority: P1)

**Goal**: One summary line "{label}: N successes · M problems", links to presets, counts ignoring only the outcome filter.

**Independent Test**: summary cases in `project-list.test.ts` and `ui.test.tsx`.

- [x] T045 [P] [US3] Extend `tests/integration/activity/project-list.test.ts`: summary counts for a range, counts ignore only the outcome filter, counts respect platform/account/date
- [x] T046 [US3] Create `src/components/activity/ActivitySummary.tsx` (`aria-live="polite"`, counts link to presets keeping other filters, "(counts ignore the outcome filter)" when an outcome filter is active); render it in `src/app/p/[projectSlug]/activity/page.tsx`
- [x] T047 [US3] Extend `tests/integration/activity/ui.test.tsx` for the summary label and links

---

## Phase 7: User Story 4 — See every project at once (Priority: P2)

**Goal**: `/activity` shows events across all of the caller's current projects, each row naming its project, with a project filter and per-project time zones.

**Independent Test**: `my-projects.test.ts`, extended scope-check suites and nav tests pass.

- [x] T048 [P] [US4] `tests/integration/activity/my-projects.test.ts`: member of A and B sees no C events, rows name their project; project filter of C matches nothing; removal from B hides B on the next call including counts and a stored `before` cursor; no projects → empty; each project's "Today" uses its own zone
- [x] T049 [US4] Edit `src/server/db/cross-project.ts` (`runForProjectSet`, `currentProjectSet`) and `src/server/db/client.ts` (query logger records `projectSet`)
- [x] T050 [US4] Create `src/server/dal/my-projects.ts` (`forMyProjects(session)`: membership read in `crossProject`, `ProjectSetScope` with `activity.list`/`summary` each run in `runForProjectSet` and joining `member` for the caller, `memberNames`, `apiKeyName`); export from `src/server/dal/index.ts`
- [x] T051 [US4] Extend the scope harness: `tests/helpers/scope-check.ts` and `tests/setup/scope-recorder.ts` (project-set pins must be in the caller's ids; summary counts project-set reasons); extend `tests/helpers/scope-check.test.ts` and `tests/integration/scope-check.test.ts` (outside pin → violation, inside passes, unpinned `activity_events` → violation, real `forMyProjects` list and summary pass)
- [x] T052 [US4] Add `listMyActivity(set, raw)` to `src/server/services/activity/index.ts` (same rows, filters, counts; `project` slug filter outside the set matches nothing; `projects` option list)
- [x] T053 [US4] Create `src/app/activity/page.tsx`, `loading.tsx`, `error.tsx` (session required → redirect `/login?next=/activity`; `SignedInHeader` without switcher; Project column and project checkbox list; "You are not a member of any project yet." empty state; error text "Activity could not be loaded." with "Try again")
- [x] T054 [P] [US4] Add "All activity" before "Create project" in `src/components/shell/ProjectSwitcher.tsx` / `switcher-logic.ts` and an Activity link in `src/components/shell/UserMenu.tsx`; extend `src/components/shell/switcher-logic.test.ts` and `tests/integration/signed-in-header.test.ts`

---

## Phase 8: User Story 6 — Automations can read the log (Priority: P2)

**Goal**: `GET /api/v1/activity` with strict filters and a cursor, `read` scope, documented in OpenAPI.

**Independent Test**: `tests/integration/api/endpoints/activity.test.ts`, extended `scope-enforcement` and `openapi` suites pass.

- [X] T055 [P] [US6] `tests/integration/api/endpoints/activity.test.ts`: every filter, `400` per bad field and cursor, unknown parameter, `from > to`; cursor walk returns each event once while events are inserted mid-walk; never another project's events; 401 missing/revoked key, 403 without `read`; response shape
- [X] T056 [US6] Add `ApiActivityEvent`, `ApiActivityPage` and the query schema (with examples) to `src/lib/api/schemas.ts`
- [X] T057 [US6] Add `listActivityForApi(scope, query)` to `src/server/services/activity/index.ts` (strict filter → `ValidationError` with details, older-only cursor, `limit` 1–100)
- [X] T058 [US6] Create `src/server/api/operations/activity.ts` (`listActivity`) and register it in `src/server/api/operations/index.ts`
- [X] T059 [US6] Extend `tests/integration/api/scope-enforcement.test.ts` and `tests/integration/api/openapi.test.ts` to cover `listActivity` and its examples

---

## Phase 9: Polish & cross-cutting

- [x] T060 [P] Create `tests/integration/activity/performance.test.ts` (SC-004): seed with `generate_series` in a `crossProject` section — 100k events in one project and 200k across 20 projects for one member; time `listProjectActivity`/`listMyActivity` across the filter combinations in quickstart §6, assert first page + counts < 1 s, log `EXPLAIN (ANALYZE, BUFFERS)` for the slowest
- [x] T061 [P] Write `docs/activity.md`; link from `docs/index.md` and `mkdocs.yml`; add n8n recipe "8. Read activity" to `docs/n8n.md`; update `docs/failures.md` (`?target=`), `docs/design-system.md` (`CursorPagination` atom) and the README feature list
- [x] T062 Confirm `docs/decisions.md` contains `## 020` (plan phase wrote it); add any decisions taken during implementation
- [x] T063 Final pass (front end, 2026-10-08): `pnpm build` passes once the worktree's `node_modules` symlink is replaced by a real `pnpm install --frozen-lockfile` (Turbopack refuses a symlink outside the root). Lint, typecheck, activity tests and db:check also pass; the full suite runs in CI
- [x] T064 `.claude/skills/docket-ui/SKILL.md` Structure lists `/activity` and the Activity nav item (added by the front end)
- [ ] T065 🛑 BLOCKED (browser part only): needs a human with a running stack (`docker compose up`, `MOCK_PROVIDER_ENABLED=true`) and a browser — run the quickstart §3 walk-through and §5 backfill check once on a pre-feature database and record the result in the PR — §5 backfill DONE by the front end 2026-10-08: a scratch DB migrated to origin/main and seeded with published, failed and ambiguous targets (one with a 2,048-character external_url) and a needs_reauth account; this branch's migrations backfilled 5 events with real outcomes and messages, the long URL was dropped from details, and re-running added none. Still owed: the §3 browser walk-through

---

## Dependencies & execution order

- Phase 1 → Phase 2 → Phases 3–8 → Phase 9.
- T005 → T006 → T007 → T008; T014 needs T007/T012; T015 needs T007, T010, T011.
- **US5 (Phase 3)** needs Phase 2 only; T023–T030 are independent call-site edits (T023→T025, T024→T025). T031 needs T006.
- **US1** needs Phase 2 (T015); its tests seed via `activity.insert`, so US5 is not strictly required, but run it first so real data flows.
- **US2** and **US3** extend the US1 page (T038): after Phase 4.
- **US4** needs Phase 2 and T038 conventions; independent of US2/US3 except the shared filters component (reuse `ActivityFilters` with a `projects` prop — add it in T053 if needed).
- **US6** needs T015 and T010; independent of the UI.

## Parallel opportunities

- Setup: T001–T004 together.
- Foundational: T009–T013 together after T005.
- US5 tests T016–T022 together; edits T026, T027, T029, T030 together.
- US1: T034–T037 together. US6 can run in parallel with US2–US4 once Phase 2 is done.

## Implementation strategy

- **MVP**: Phases 1–2, US5 (writers + backfill), US1 (per-project list). That ships a trustworthy log with one screen.
- Then US2 (filters), US3 (summary), US4 (all projects), US6 (API); Polish last.
- Commit per task or logical group with explicit paths; run the targeted `pnpm vitest run <file>` per task and the full pass only in T063.

---

## Phase 10: Review remediation

- [x] T066 Attach `activity: eventForDecision({ decision: { patch, attempts }, target, account, now })` to the re-lease return in `decide()` when the attempts include `recovered_retry`, so an interrupted safe step that is retried writes one `target_retry_scheduled` (`interrupted: true`) event. Add integration cases to `tests/integration/activity/scheduler-events.test.ts` for an expired lease on a may-publish step (`target_ambiguous`), on a safe step that is re-leased (`target_retry_scheduled` interrupted) and on interruption exhaustion (`target_failed`, `engine: "interrupted"`) — review F1 (MAJOR), src/server/scheduler/publishing.ts:175
- [x] T067 Carry the active quick `range` through the GET filter form, for example as a hidden input, and make a submitted non-empty From/To replace it, so changing Platform or Account (auto-submit) or pressing Apply keeps the period. Add a `tests/integration/activity/ui.test.tsx` case that serializes the rendered form with `range=7d` and a new platform, parses it with `parseActivityFilter` and gets the same range back — review F2 (MAJOR), src/components/activity/ActivityFilters.tsx:52
- [x] T068 Show the post excerpt (unlinked) next to "Post deleted" in `ActivityRow` when it is non-empty (D9). Use a non-empty excerpt in the deleted-post fixture in `tests/integration/activity/ui.test.tsx`, and assert `post.excerpt` after `deletePost` in `tests/integration/activity/retention.test.ts` — review F3 (MAJOR), src/components/activity/ActivityRow.tsx:71
- [x] T069 Add "What is not recorded" (no publish content beyond an excerpt, no secrets, no engagement metrics) and "Retention" (kept until the project is deleted; about 0.5 KB per event, so 100,000 events ≈ 50 MB; date filters are index-backed) sections to `docs/activity.md` per FR-026 — review F4 (MAJOR), docs/activity.md:10
- [x] T070 Make the activity log unable to block a valid change (review F5, promoted to must-fix by the front end): in `src/server/services/activity/classify.ts` (`eventForStep`, `resolvedEvent`) keep `details.url` only when it is <= 1,900 characters (drop it otherwise; the post keeps its own URL), and in `drizzle/0013_backfill_activity_events.sql` apply the same rule so every backfilled `details` fits the 2,000-byte CHECK. Add tests: resolve with a 2,048-character link succeeds and records an event without `url`; a `recordStepResult` with a 2,000-character `externalUrl` commits; the backfill over a target whose `external_url` is 2,048 characters completes. Run `pnpm vitest run tests/integration/activity` — review F5, src/server/services/activity/classify.ts:54
