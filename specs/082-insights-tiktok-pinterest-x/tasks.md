---

description: "Task list template for feature implementation"
---

# Tasks: TikTok and Pinterest numbers, and a priced opt-in for X

**Input**: Design documents from `/specs/082-insights-tiktok-pinterest-x/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Requested throughout the spec and plan (quickstart.md names the test files directly) — every phase below includes its test tasks, written to run and fail before the implementation task that follows them.

**Organization**: Tasks are grouped by user story per spec.md's priorities (US1, US2 P1; US3, US4 P2; US5, US6 P3). The plan's own "Implementation order" table supplies the dependency order inside and across phases: the migration and the three generic hooks (G35, G36, G37) and the FR-050 honesty fix before any user-story wiring; the identifier repair (US1) before the reader that needs it (US2); each platform's reader independent of the other two; and — per the project's "park the human task last" rule — every task needing a live consent screen, a real platform account or a funded key sits in the final phase, after every mocked-HTTP, unit, integration and documentation task.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US6)
- Exact file paths are given in every task

---

## Phase 1: Setup

**Purpose**: Per-provider config knobs every later phase reads, following the `META_INSIGHTS_SCOPES`/`TIKTOK_APP_AUDITED` precedent of living in each provider's own `config.ts` (data-model.md, plan.md "four new environment variables"). No `src/server/env.ts` change.

- [X] T001 [P] Edit `src/providers/tiktok/config.ts`: add `insightsScopes` (bool, default `false`, from `TIKTOK_INSIGHTS_SCOPES`) to `TikTokConfig`'s parse result and `parseTikTokEnv`, declared in `environment.variables` as `{ secret: false, required: false }`, with a `"must be true or false"` issue on an invalid value — matching the `TIKTOK_APP_AUDITED` parse exactly (plan.md "four new environment variables")
- [X] T002 [P] Edit `src/providers/pinterest/config.ts`: add `insightsScopes` (bool, default `false`, from `PINTEREST_INSIGHTS_SCOPES`) to `PinterestConfig`'s parse result and `parsePinterestEnv`, same shape as T001
- [X] T003 [P] Edit `src/providers/x/config.ts`: add `parseXInsightsEnv(source): { enabled: boolean; readCeiling: number; issues: ProviderEnvIssue[] }` — `X_INSIGHTS_ENABLED` (bool, default `false`) and `X_INSIGHTS_READ_CEILING` (integer 100–1,000,000, default `8000`), each surfacing a `ProviderEnvIssue` naming the variable and never its value on an invalid value (FR-062, contracts/x-metered-reads.md §2)
- [X] T004 [P] `src/providers/tiktok/config.test.ts`, `src/providers/pinterest/config.test.ts`, `src/providers/x/config.test.ts`: extend/new — each new flag parses with its documented default, rejects a non-boolean/out-of-range value as an environment issue naming the variable (never the value), not a crash — depends on T001, T002, T003
- [X] T005 [P] Add `TIKTOK_INSIGHTS_SCOPES`, `PINTEREST_INSIGHTS_SCOPES`, `X_INSIGHTS_ENABLED`, `X_INSIGHTS_READ_CEILING` to `.env.example` (near the existing `TIKTOK_APP_AUDITED`/`META_INSIGHTS_SCOPES` blocks), each with its default and one line naming what it adds (FR-062) — depends on T001, T002, T003

**Checkpoint**: config knobs ready, all defaulting to off/conservative; no existing behaviour changed yet.

---

## Phase 2: Foundational — the migration, G35, G36, G37, and the FR-050 honesty fix (Blocking Prerequisites)

**Purpose**: Everything every user story below needs. **No user story's implementation starts before this phase is green.** This phase alone makes the eligibility, identifier-routing and run-time-unavailable machinery provable with the `mock` provider and no platform code; the user-story phases that follow are the per-platform wiring and the tests that prove it against real request/response shapes.

### Schema and migration (FR-005 … FR-009, FR-050, FR-063)

- [X] T006 Edit `src/server/db/schema/posts.ts`: add `publicPostId: text("public_post_id")` to `postTargets`, plus the CHECK `post_targets_public_post_id_len`: `public_post_id IS NULL OR char_length(public_post_id) BETWEEN 1 AND 64`, exactly per data-model.md §1 — no index, no other column change
- [X] T007 Edit `src/server/db/schema/insights.ts`: add `unavailableReason: text("unavailable_reason")` and `unavailableDocsPath: text("unavailable_docs_path")` to **both** `postMetricPollStates` and `accountMetricPollStates`, plus on each table the three CHECKs of data-model.md §2 (`*_unavailable_reason_len` ≤ 500, `*_unavailable_docs_pair`, `*_unavailable_docs_path_len` ≤ 100)
- [X] T008 Generate migration `drizzle/0044_*.sql` via `pnpm db:generate` from T006/T007 (never hand-written), then **hand-append** the backfill statement of data-model.md §3 (the `UPDATE post_targets … FROM (SELECT DISTINCT ON …) src …` over `publish_attempts.response_summary->'publicPostIds'->>0`, guarded by `jsonb_typeof(...) = 'object'`, `t.public_post_id IS NULL` and the `char_length` bound) to the same migration file — depends on T006, T007
- [X] T009 Run `pnpm db:check` until green against T008's migration (FR-063)
- [X] T010 [P] `tests/integration/insights/public-post-id.test.ts` (new): the backfill recovers the **first** id of the **most recent** attempt row that carries one; leaves null where no attempt row survives; never overwrites an existing value (run the statement twice, assert unchanged); rejects a 300-character id (assert null, no migration failure); `grep -c tiktok` on the migration file is 0 (contracts/public-post-id.md §4, FR-008, FR-009) — depends on T008, T009
- [X] T011 [P] `tests/integration/db/` (extend the existing CHECK-coverage test, or add one beside it): insert a `public_post_id` of 0 and of 65 characters directly via raw SQL and assert the CHECK rejects both; insert a 500-character `unavailable_reason` and a 101-character `unavailable_docs_path` on each poll-state table and assert both rejected; insert a non-null `unavailable_docs_path` with a null `unavailable_reason` and assert the pair CHECK rejects it (data-model.md §1, §2) — depends on T008, T009

### G35 — the declared identifier source (FR-015)

- [X] T012 Edit `src/providers/types.ts`: add `postIdSource?: "externalId" | "publicPostId"` (default `"externalId"`) and `missingPostId?: { reason: string; docsPath?: string }` to `InsightsDeclaration`, per contracts/provider-insights-082.md §1 — depends on T006
- [X] T013 Edit `src/providers/registry.ts`'s `assertInsightsDeclaration`: `postIdSource === "publicPostId"` ⇒ `missingPostId.reason` must be 1–300 characters, mirroring the existing `requiredScopes`/`missingScopes` check (contracts/provider-insights-082.md §1 rule 3) — depends on T012
- [X] T014 [P] `src/providers/registry.test.ts`: extend — a declaration with `postIdSource: "publicPostId"` and no `missingPostId` throws at registry load; one with both present is accepted — depends on T013
- [X] T015 Edit `src/server/dal/insights-claims.ts`: add `postIdSource: "externalId" | "publicPostId"` and `missingPostId: { reason: string; docsPath?: string } | null` to `InsightsProviderRule`; add an `idColumn(rule)` helper returning `postTargets.externalId` or `postTargets.publicPostId`; `claimDuePostMetricPolls`'s claim query gains `isNotNull(idColumn(rule))` inside the existing per-provider `OR`-of-`AND`s (not just `isNotNull(postTargets.externalId)`, which stays for every provider); the lazy insert's `missing` select applies the same per-provider id predicate and, for a target with `postIdSource: "publicPostId"` and a null column, inserts the state row **already frozen**: `nextPollAt: null, frozenAt: now, frozenReason: "unqueryable", unavailableReason: rule.missingPostId!.reason` — one row, zero calls (contracts/provider-insights-082.md §2, data-model.md §4) — depends on T012
- [X] T016 Edit `src/server/dal/insights-claims.ts`: add `targetsSkippedNoPublicPostId` as a new companion count — published, insights-eligible, provider's `postIdSource` is `"publicPostId"`, column is null — alongside `countPublishedWithoutExternalId` (data-model.md §4 "The companion counts", FR-053) — depends on T015

### G36 — a public post id on the publish result (FR-016)

- [X] T017 Edit `src/providers/types.ts`: add `publicPostId?: string` to the `{ kind: "done" }` arm of `StepResult`, per contracts/provider-insights-082.md §3 — depends on T012
- [X] T018 Edit `src/server/scheduler/record.ts`: `applyStepResult`'s `"done"` case adds `publicPostId: result.publicPostId ?? null` to the `published` patch — one line, pure, no provider key (data-model.md §6) — depends on T017
- [X] T019 [P] `src/server/scheduler/record.test.ts`: extend — a `done` result carrying `publicPostId` writes it to the patch; a `done` result without it writes `null`; every existing case in the file is unaffected — write first, confirm it fails — depends on T018

### G37 — per-surface eligibility (FR-017)

- [X] T020 Edit `src/providers/types.ts`: in `InsightsDeclaration`, **remove** `requiredScopes`/`missingScopes` and add `postScopes?: readonly string[]`, `missingPostScopes?: { reason: string; docsPath?: string }`, `accountScopes?: readonly string[]`, `missingAccountScopes?: { reason: string; docsPath?: string }`, per contracts/provider-insights-082.md §1 — depends on T012
- [X] T021 Edit every existing provider's `insights.ts` that set `requiredScopes`/`missingScopes` (`src/providers/instagram/insights.ts`, `src/providers/facebook/insights.ts`, `src/providers/threads/insights.ts`) to set both `postScopes`/`missingPostScopes` **and** `accountScopes`/`missingAccountScopes` to the same values they used before, so no current behaviour changes (contracts/provider-insights-082.md §1 "Migration of 081's field") — depends on T020
- [X] T022 Edit `src/providers/registry.ts`'s `assertInsightsDeclaration`: replace the single `requiredScopes`/`missingScopes` check with one per surface (`postScopes`/`missingPostScopes`, `accountScopes`/`missingAccountScopes`), each with the same 1–300-character and `GRANTED_SCOPE_PATTERN` rules as before; `unavailable` set ⇒ neither surface's scopes may be set — depends on T020, T021
- [X] T023 [P] `src/providers/registry.test.ts`: extend — the existing `requiredScopes`/`missingScopes` assertion-failure cases are replaced with one pair per surface; `unavailable` alongside either surface's scopes still throws — depends on T022
- [X] T024 Edit `src/lib/insights/eligibility.ts`: no signature change to `insightsPermissionFor` (it is called once per surface, per contracts/provider-insights-082.md §4) — add a short comment-free pass-through confirmation only if a type needs updating; otherwise this task is "no code change, confirmed by T032's matrix" — depends on T020
- [X] T025 Edit `src/server/dal/insights-claims.ts`: `InsightsProviderRule` gains `postScopes`, `accountScopes` (replacing `requiredScopes`), `postMetricsDeclared: boolean`, `accountMetricsDeclared: boolean`, exactly the shape of data-model.md §4; `claimDuePostMetricPolls`'s `eligible()` predicate is built from `postScopes` over providers with `postMetricsDeclared`; add `claimDueAccountMetricPolls`'s own `eligible()` predicate built from `accountScopes` over providers with `accountMetricsDeclared` (replacing the shared `requiredScopes` predicate the two claims used before) — depends on T015, T020
- [X] T026 Edit `src/server/dal/insights-claims.ts`: `countAccountsMissingInsightsScopes` reports an account missing **either** surface's scopes, deduplicated by account id, over providers that declare that surface (data-model.md §4 "The companion counts") — depends on T025
- [X] T027 [P] `tests/integration/insights/eligibility-matrix.test.ts`: extend — the existing rows (081's single-scope-set cases) still pass unedited against the new `postScopes`/`accountScopes` fields set equal; new rows cover the four quadrants (post scope held only / account scope held only / both / neither) × (`granted_scopes` null / narrow / wide), asserted against **both** claims' actual output and against `insightsPermissionFor` called once per surface (contracts/provider-insights-082.md §4) — write first, confirm it fails — depends on T025, T026
- [X] T028 Edit `src/server/scheduler/insights-poll.ts`: the `providers` array built from `listProviders()` maps `postScopes`, `accountScopes`, `postIdSource`, `missingPostId`, `postMetricsDeclared: p.insights!.declaration.post.length > 0`, `accountMetricsDeclared: p.insights!.declaration.account.length > 0` instead of the single `requiredScopes` (plan.md "Project Structure", data-model.md §4) — depends on T015, T025
- [X] T029 Edit `src/server/services/accounts.ts`: `insightsPermissionForAccount` takes a `surface: "post" | "account"` parameter, reads `postScopes`/`missingPostScopes` or `accountScopes`/`missingAccountScopes` accordingly, and `AccountView` carries **two** fields (one per surface, e.g. `insightsPostPermission`/`insightsAccountPermission`) instead of one `insightsPermission` (contracts/provider-insights-082.md §4 "the accounts page", FR-017) — depends on T025
- [X] T030 Edit `src/server/services/posts/view.ts`: the post panel's `permission` is computed from the **post** surface only — `insightsPermissionForAccount(account, provider, "post")` (contracts/provider-insights-082.md §4 "`buildTargetInsightsView`") — depends on T029
- [X] T031 Edit `src/app/p/[projectSlug]/accounts/page.tsx`: render one "Insights need a reconnect" line **per waiting surface** (post, account), each naming which surface and its own reason/docs link, in place of the single line (contracts/provider-insights-082.md §4 "the accounts page") — depends on T029
- [X] T032 [P] `tests/integration/accounts/accounts-page.test.ts` or extend the existing accounts-page test: an account missing only the post scope shows one line naming "post"; an account missing only the account scope shows one line naming "account"; an account missing both shows two lines; an account missing neither shows none — depends on T031

### FR-050 — persist and render a run-time `unavailable` (not a hook)

- [X] T033 Edit `src/server/scheduler/insights-poll.ts`'s `commitPostBatch` and `commitAccountResult`: on `case "unavailable"`, also write `unavailableReason: redact(reason, secrets)` and `unavailableDocsPath: docsPath ?? null`; on a successful `"page"` commit, **clear** both columns; on any freeze (`gone`, `settled`, `expired`, `unqueryable`), clear both too (contracts/provider-insights-082.md §5) — depends on T007
- [X] T034 Edit `src/lib/insights/panel.ts`: `BuildTargetInsightsViewInput.pollState` gains `unavailableReason: string | null` and `unavailableDocsPath: string | null`; `buildTargetInsightsView` adds a branch **after** `failing` (frozenReason/consecutiveFailures checks) and **before** `not_polled_yet`: a non-null `unavailableReason` renders the existing `unavailable` state with that reason and docs path, per the full ordering in contracts/provider-insights-082.md §5 "The full panel ordering after this entry" — depends on T033
- [X] T035 Edit `src/server/services/posts/view.ts`: pass `pollState.unavailableReason`/`unavailableDocsPath` through to `buildTargetInsightsView` (the row already reads the poll-state table; no new query) — depends on T034
- [X] T036 [P] `tests/unit/insights/panel.test.ts`: extend — the run-time `unavailable` state renders after `failing` and before `not_polled_yet` for both insertion points; a cleared pair after a successful read is reflected (no `unavailable` state once a snapshot exists); the declaration-level `unavailable` and the run-time one produce byte-identical rendering of the `unavailable` state shape — write first, confirm it fails — depends on T034
- [X] T037 [P] `tests/integration/insights/panel.test.tsx`: extend — a Pinterest 403 and an X opt-in-off case both reach the post panel as `unavailable` with reason and docs link (FR-050, SC-003) — depends on T035

### The `mock` provider scripts every new shape (FR-052)

- [X] T038 Edit `src/providers/mock/settings.ts`: add `insightsPostIdSource: z.enum(["externalId", "publicPostId"]).default("externalId")`; replace `insightsRequiredScopes` with `insightsPostScopes` and `insightsAccountScopes` (both `z.array(z.string()).default([])`); add `insightsMissingPostIdDocsPath`, `insightsUnavailableDocsPath` (both nullable strings); keep `insightsAccountReadBehaviour` scripting a run-time `unavailable` on the account surface alone (contracts/provider-insights-082.md §6)
- [X] T039 Edit `src/providers/mock/insights.ts`: `mockInsightsRuleFor` returns the extended `InsightsProviderRule` of data-model.md §4 (`postScopes`, `accountScopes`, `postIdSource`, `missingPostId`, `postMetricsDeclared: true`, `accountMetricsDeclared: true`); the declaration itself gains `postIdSource`/`missingPostId` driven by settings so a test target can be built with or without a queryable id — depends on T038
- [X] T040 [P] `src/providers/mock/insights.test.ts`: extend — each new scripting field reachable from settings alone, with no change to `mock`'s existing declared keys or default behaviour — depends on T039

**Checkpoint**: the whole generic-hooks half is green — the migration, G35, G36, G37 and the FR-050 honesty fix. Every behaviour above is provable against the `mock` provider alone, with no platform code written yet.

---

## Phase 3: User Story 1 — A published TikTok post has an identifier its numbers can be asked for (Priority: P1) 🎯 MVP

**Goal**: Every TikTok target Docket publishes after this entry carries a queryable public post id; every recoverable older target gets one from the migration's backfill; every unrecoverable one says so honestly and is never polled.

**Independent Test**: publish a TikTok target through the mocked-HTTP publish path whose status fetch returns `publicaly_available_post_id`, confirm it lands only in the new column; run the backfill against a target with a surviving attempt row and one without; confirm the frozen state and its wording.

- [X] T041 [P] [US1] `src/providers/tiktok/publish.test.ts`: extend — a `PUBLISH_COMPLETE` reply carrying `publicaly_available_post_id` adds `publicPostId` (the **first** id) to the `done` result alongside the unchanged `externalId: s.publishId`; a reply with an empty or absent list omits `publicPostId` entirely; a 300-character id in the list is **not** sent as `publicPostId` (`plausiblePublicPostId` rejects it); the full list is still recorded in `summary.response.publicPostIds`, unchanged (contracts/public-post-id.md §3) — write first, confirm it fails
- [X] T042 [US1] Edit `src/providers/tiktok/publish.ts`: add the pure `plausiblePublicPostId(v: unknown): string | null` function (non-empty string, 1–64 characters, no whitespace, else `null`) and call it in `checkStatus`'s `PUBLISH_COMPLETE` branch, spreading `...(publicPostId ? { publicPostId } : {})` into the `{ kind: "done", ... }` return, with **no change** to `externalId`, `summary`, or any publish precondition (contracts/public-post-id.md §3, FR-007, FR-011) — depends on T017, T041
- [X] T043 [P] [US1] `src/providers/tiktok/publish.test.ts` (same file as T041, or a `plausiblePublicPostId.test.ts` beside it): unit-test `plausiblePublicPostId` directly against the CHECK bound (1 char, 64 chars, 65 chars, empty, whitespace-containing) — depends on T042
- [X] T045 [P] [US1] `tests/integration/insights/public-post-id.test.ts` (extend T010's file): a target with `public_post_id` null and `postIdSource: "publicPostId"` is **never claimed**, is lazily inserted **already frozen** `unqueryable` with the declaration's `missingPostId.reason`, and no provider call is ever made for it (contracts/public-post-id.md §5, FR-010, FR-015) — depends on T015, T039
- [X] T046 [P] [US1] `tests/integration/insights/public-post-id.test.ts`: a TikTok target published by hand with no `external_id` at all continues to be skipped and counted under `targetsSkippedNoExternalId`, never failed (FR-014, `post_targets_published_has_id` already permits it) — depends on T045
- [X] T047 [P] [US1] Extend `tests/integration/tiktok/unaudited.test.ts` or `unaudited-ui.test.tsx`: an unaudited install (`TIKTOK_APP_AUDITED` false) publishes `SELF_ONLY`, so `checkStatus` never sets `publicPostId`; the target reaches the FR-010 frozen state with the same wording as any other missing-id target (FR-012) — depends on T042, T045
- [X] T048 [US1] Edit `docs/tiktok-setup.md`: where the audit is already explained, add one sentence that an unaudited install's posts have no readable numbers and why (FR-012) — depends on T047

**Checkpoint**: US1 is independently proven — TikTok's identifier repair is complete and tested, with no reader written yet.

---

## Phase 4: User Story 2 — TikTok numbers appear on the post that earned them (Priority: P1)

**Goal**: With the opt-in on and `video.list` granted, TikTok's post and account numbers are read on the decay schedule and rendered under TikTok's own labels; before the reconnect, nothing is called.

**Independent Test**: mock `/v2/video/query/` with `video.list` recorded as granted; run the poll tick over 25 claimed TikTok targets on one account and assert two calls of 20 and 5 ids, one snapshot row per target, each metric under TikTok's own label.

- [X] T049 [P] [US2] `src/providers/tiktok/connect-group.test.ts`: extend — with `TIKTOK_INSIGHTS_SCOPES` unset, `authorizationUrl` produces a **byte-for-byte** identical URL to today's literal (FR-019, assert the full string) — write first, confirm it fails
- [X] T050 [US2] Edit `src/providers/tiktok/connect-group.ts`: add `optionalScopes` to `tiktokConnectGroup` — `declared: [{ scope: "video.list", purpose: "Read a TikTok video's likes, comments, shares and views" }, { scope: "user.info.stats", purpose: "Read a TikTok account's followers, likes and video counts" }]`, `doc: docsUrl("tiktok-setup", "insights")`, `requested(source)` reading `parseTikTokEnv(source).config?.insightsScopes` — following `src/providers/meta/connect-group.ts`'s shape exactly (contracts/platform-readers-082.md §1, FR-019) — depends on T001
- [X] T051 [US2] Edit `tiktokConnectGroup.authorizationUrl` to append `optionalScopes`'s requested scopes into the `scope` search param (the same pattern `dialogUrl`/T040 of 081 used for Meta) — depends on T050
- [X] T052 [P] [US2] `src/providers/tiktok/connect-group.test.ts`: extend — flag on ⇒ dialog carries today's scopes plus exactly `video.list` and `user.info.stats`, in declaration order, nothing else; flag off ⇒ byte-identical to today's literal (FR-019) — depends on T051
- [X] T053 [US2] `src/providers/tiktok/insights.test.ts` (new, mocked HTTP only): every case of contracts/platform-readers-082.md §1 and §4 — happy page via `POST /v2/video/query/` with `fields=like_count,comment_count,share_count,view_count,id` and body `{"filters":{"video_ids":[...]}}`; an id the response omits a `videos` entry for → one `unqueryable` entry with the two-possibility reason; a declared metric the response omitted is absent, not zero; `expired`/`access_token_invalid` → `credentials_invalid`; `rate` → `rate_limited` with `retryAt`; `cap`/`transient`/`lost` → `retryable_error`; `refused` + `scope_not_authorized` → `unavailable` naming `video.list` with `docsPath: "tiktok-setup#insights"`; any other `refused` → `fatal_error`; a token planted in TikTok's error text never appears in the returned string — write first, confirm it fails
- [X] T054 [US2] `src/providers/tiktok/insights.ts` (new): declare `post: [like_count→Likes, comment_count→Comments, share_count→Shares, view_count→Views]`, `account: [follower_count→Followers, likes_count→Likes, video_count→Videos]`, `maxPostsPerRead: 20`, `postIdSource: "publicPostId"`, `missingPostId: { reason: "...", docsPath: "tiktok-setup#insights" }`, `postScopes: ["video.list"]`, `missingPostScopes`, `accountScopes: ["user.info.stats"]`, `missingAccountScopes`, `readBudget: { count: 600, windowSeconds: 60 }` (PARTLY CONFIRMED, per-app token); `readPostMetrics` via `tiktokRequest` + `inspect` per contracts/platform-readers-082.md §1's error table; `readAccountMetrics` via `GET /v2/user/info/?fields=follower_count,likes_count,video_count` — depends on T012, T020, T042, T053
- [X] T055 [US2] Edit `src/providers/tiktok/index.ts`: add `insights: tiktokInsights` — depends on T054
- [X] T056 [P] [US2] `tests/integration/insights/batching.test.ts` (new): 25 due targets with `public_post_id` set on one TikTok account produce **two** provider calls of **20** and **5** ids, every id in each call belonging to that one account (contracts/platform-readers-082.md §4, FR-021, SC-006) — depends on T054, T055
- [X] T057 [P] [US2] `tests/integration/insights/eligibility-matrix.test.ts`: extend — an account that connected before `TIKTOK_INSIGHTS_SCOPES` was turned on is **never claimed**, never leased, its credentials never decrypted, and zero `fetch` calls are recorded for it (FR-020, assert zero `decryptCredentials` calls, not merely zero snapshots) — depends on T025, T054, T055
- [X] T058 [P] [US2] `tests/integration/insights/panel.test.tsx`: extend — a metric TikTok's response omitted is absent from the rendered panel — no row, no dash, no zero (FR-024) — depends on T054, T055
- [X] T059 [US2] Edit `docs/limits.md`: add TikTok's `note: insights read budget` row — 600/min, PARTLY CONFIRMED per-app token, source `docs/research/tiktok.md`, enforcement point `src/server/scheduler/insights-budget.ts`, test `src/providers/tiktok/insights.test.ts` (FR-026, contracts/platform-readers-082.md §1) — depends on T054
- [X] T060 [P] [US2] `tests/integration/docs/limits-inventory.test.ts`: extend to assert T059's new row exists — depends on T059

**Checkpoint**: US1 and US2 are both independently functional — TikTok's headline journey (opt in, reconnect, see numbers) works end to end against mocked HTTP.

---

## Phase 5: User Story 3 — Pinterest numbers, with the half that needs no permission arriving immediately (Priority: P2)

**Goal**: Pinterest account numbers (`follower_count`, `monthly_views`) begin accruing for every connected account with no reconnect and no flag; pin analytics wait behind `pins:read`; Pinterest's documented refusals become stated reasons.

**Independent Test**: mock `/v5/user_account` and run the account poll for an account whose stored grant has only today's three scopes; assert a snapshot with `follower_count`/`monthly_views` and no pin-analytics call. Separately, assert the 403 and Trial-invisibility paths.

- [X] T061 [P] [US3] `src/providers/pinterest/window.test.ts` (new): `pinterestAnalyticsWindow({ publishedAt, now })` — `end` is always the UTC calendar date of `now`; `start` is `max(UTC date of publishedAt, end − 90 days)`; a post published two years ago still clamps to 90 days; `start ≤ end` always; no clock read inside the function (contracts/platform-readers-082.md §2, FR-030) — write first, confirm it fails
- [X] T062 [US3] `src/providers/pinterest/window.ts` (new, pure): `pinterestAnalyticsWindow` per T061 — depends on T061
- [X] T063 [P] [US3] `src/providers/pinterest/connect-group.test.ts`: extend — with `PINTEREST_INSIGHTS_SCOPES` unset, `authorizationUrl` is byte-for-byte today's literal (FR-027) — write first, confirm it fails
- [X] T064 [US3] Edit `src/providers/pinterest/connect-group.ts`: add `optionalScopes` — `declared: [{ scope: "pins:read", purpose: "Read a pin's analytics (impressions, clicks, saves)" }]`, `doc: docsUrl("pinterest-setup", "insights")`, `requested(source)` reading `parsePinterestEnv(source).config?.insightsScopes` — depends on T002
- [X] T065 [US3] Edit `pinterestConnectGroup.authorizationUrl` to append `optionalScopes`'s requested scopes into the `scope` search param, alongside the existing `PINTEREST_SCOPES` — depends on T064
- [X] T066 [P] [US3] `src/providers/pinterest/connect-group.test.ts`: extend — flag on ⇒ dialog carries today's scopes plus `pins:read`; flag off ⇒ byte-identical (FR-027) — depends on T065
- [X] T067 [US3] `src/providers/pinterest/insights.test.ts` (new, mocked HTTP only): every case of contracts/platform-readers-082.md §2 and §4 — happy page via `GET /v5/pins/{pin_id}/analytics?start_date=…&end_date=…&metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE` reading `summary_metrics` only; a declared metric omitted is absent; `PINNER_DATA_ACCESS_DENIED` (string-token match on the 403 body's `message`) → `unavailable` with the business-account reason and `docsPath: "pinterest-setup#insights"`, **not** `credentials_invalid`, account never flagged; a pin whose analytics return no declared metric renders as `nothing_reported` (not an error); 401 → `credentials_invalid`; 429 → `rate_limited` from `x-ratelimit-reset`; 404 → `gone`; 5xx/network → `retryable_error`; other 4xx → `fatal_error`; the account read via `GET /v5/user_account` requires no scope beyond what every account already holds and returns `follower_count`/`monthly_views`; an account whose `granted_scopes` is **null** still gets account numbers and still gets no pin-analytics call — write first, confirm it fails — depends on T062
- [X] T068 [US3] `src/providers/pinterest/insights.ts` (new): declare `post: [IMPRESSION→Impressions, PIN_CLICK→Pin clicks, OUTBOUND_CLICK→Outbound clicks, SAVE→Saves]`, `account: [follower_count→Followers, monthly_views→Monthly views]`, `maxPostsPerRead: 1`, `postIdSource: "externalId"`, `postScopes: ["pins:read"]`, `missingPostScopes`, `accountScopes: []`, `readBudget: { count: 1000, windowSeconds: 86_400 }` (`org_read` Trial figure); `readPostMetrics` calling `pinterestAnalyticsWindow` (never reading a clock itself), mapping `PINNER_DATA_ACCESS_DENIED` as a documented **message-token** exception (recorded in `docs/decisions.md`, T075) living only in this file; `readAccountMetrics` via `GET /v5/user_account` — depends on T012, T020, T062, T067
- [X] T069 [US3] Edit `src/providers/pinterest/index.ts`: add `insights: pinterestInsights` — depends on T068
- [X] T070 [P] [US3] `tests/integration/insights/eligibility-matrix.test.ts`: extend — an account whose stored grant is exactly `user_accounts:read, boards:read, pins:write` gets an account snapshot with no pin-analytics call attempted; the same account's post panel names the missing `pins:read` with a link to `docs/pinterest-setup.md` (US3-AS1/2, FR-028, FR-035) — depends on T025, T068, T069
- [X] T071 [P] [US3] `tests/integration/pinterest/availability.test.ts`: extend — the 403 path backs off rather than retrying tightly and does not flag the account (FR-031) — depends on T068, T069
- [X] T072 [US3] Edit `docs/pinterest-setup.md`: explain Trial-access invisibility (a Trial app's content is invisible to anyone but its own creator) and that a pin with no reported numbers is not an error (FR-032) — depends on T068
- [X] T073 [US3] Edit `docs/limits.md`: add Pinterest's `note: insights read budget` row — 1000/day `org_read` Trial figure, source `docs/research/pinterest.md`, enforcement `src/server/scheduler/insights-budget.ts`, test `src/providers/pinterest/insights.test.ts` (FR-033) — depends on T068
- [X] T074 [P] [US3] `tests/integration/docs/limits-inventory.test.ts`: extend to assert T073's new row exists — depends on T073
- [X] T075 [P] [US3] Edit `docs/decisions.md`: record the `PINNER_DATA_ACCESS_DENIED` message-token exception to the publishing path's "status only, never a numeric code" rule, with its reversal (plan.md "Post-design re-check" item V) — depends on T068

**Checkpoint**: US1, US2 and US3 are all independently functional. Pinterest's account numbers accrue with zero operator action, and pin analytics wait correctly behind the opt-in.

---

## Phase 6: User Story 4 — X is available, priced, and off until someone says yes (Priority: P2)

**Goal**: X's reader is built and works, and is off by default; turning on one environment variable makes X posts' public metrics arrive on the decay schedule, inside a per-account per-cycle ceiling enforced by the existing reserve.

**Independent Test**: with the opt-in unset, run the tick and assert zero X calls and a panel naming the metered read. With it set and a mocked response, assert snapshots write and the ceiling defers further reads without failing anything.

- [X] T076 [US4] `src/providers/x/insights.test.ts` (new, mocked HTTP only): every case of contracts/platform-readers-082.md §3 and x-metered-reads.md — with `X_INSIGHTS_ENABLED` unset, the declaration is `unavailable` with the metered-read reason and `docsPath: "x-setup#insights"`; with it set, `GET /2/tweets?ids=…&tweet.fields=public_metrics` returns a happy page under X's six labels including `impression_count`; a `data` entry → metrics; an `errors` entry whose title/type is not-found → `gone`; an id in neither array → no entry, left due; 401/token-invalid → `credentials_invalid`; **429** → `rate_limited` with `retryAt` from `x-rate-limit-reset`; 403 → `fatal_error`; 5xx/network → `retryable_error`; other 4xx → `fatal_error`; `readAccountMetrics` always returns `{ kind: "unavailable", reason: X_ACCOUNT_UNPRICED, docsPath: "x-setup#insights" }` and `account: []` so the account claim never reaches it; no token or bearer header ever appears in a returned string — write first, confirm it fails
- [X] T077 [US4] `src/providers/x/insights.ts` (new): declare `post: [like_count→Likes, reply_count→Replies, retweet_count→Reposts, quote_count→Quotes, bookmark_count→Bookmarks, impression_count→Impressions]`, `account: []`, `maxPostsPerRead: 100`, `postIdSource: "externalId"`, `postScopes: ["tweet.read"]`, `missingPostScopes`, `accountScopes: []`, `unavailable` set conditionally (per `parseXInsightsEnv`) to the opt-in-off reason of contracts/x-metered-reads.md §1, else `readBudget: { count: xInsightsReadCeiling(), windowSeconds: 2_592_000 }` per T003; `readPostMetrics` via `xRequest`/`readRate`/`problemText`; **never** requests `non_public_metrics`, `organic_metrics` or `promoted_metrics` (FR-044) — depends on T003, T012, T020, T076
- [X] T078 [US4] Edit `src/providers/x/index.ts`: add `insights: xInsights` — depends on T077
- [X] T079 [P] [US4] `tests/integration/insights/eligibility-matrix.test.ts`: extend — with the opt-in unset, the provider carries `declaration.unavailable`, so `runInsightsPoll`'s existing FR-003-style filter excludes it before either claim runs: zero X accounts/targets claimed, zero leases, zero `decryptCredentials` calls, zero `fetch` calls in a full tick (contracts/x-metered-reads.md §1, SC-005) — depends on T025, T077, T078
- [X] T080 [US4] `tests/integration/insights/x-ceiling.test.ts` (new): with the opt-in on, drive the tick repeatedly for one X account past the **realised** ceiling (`X_INSIGHTS_READ_CEILING / 2` under the default 0.5 reserve) and assert reads stop, `deferredForAllowance` rises, no target gains a failure, and a scheduled publish for the same account in the same tick still goes out (contracts/x-metered-reads.md §3, FR-039, FR-040, SC-005, SC-007) — depends on T077, T078
- [X] T081 [P] [US4] `tests/integration/insights/x-ceiling.test.ts`: extend — flipping the opt-in back off after snapshots exist leaves them in place, the panel keeps showing the last "as of" time, no further call is made, nothing errors (spec edge case) — depends on T080
- [X] T082 [US4] Edit `docs/x-setup.md`: the full checklist of contracts/x-metered-reads.md §4 — the $0.001 Owned Read price with source URL and date 2026-10-18; the worked monthly estimate (~32 reads/post over 28 days, 100 posts/month ≈ 3,200 resources ≈ $3.20); the $20 promotional-credit note; the default ceiling and its $4.00/account/cycle realised figure; that insights are off until the opt-in is set; that no new permission is needed (`tweet.read` already requested); that impressions are included (a public metric) and `non_public_metrics` is deliberately not requested, naming the two parked billing questions; that account numbers are not read and why (FR-041) — depends on T077
- [X] T083 [US4] Edit `docs/limits.md`: add X's two rows — `note: insights read budget` (8000/2,592,000s, realised 4,000, derived from the $0.001 price, enforcement `src/server/scheduler/insights-budget.ts`, test `src/providers/x/insights.test.ts`) and `note: platform post-read cap` (3,000,000/cycle, `docs/research/x.md:19-41`) (FR-045) — depends on T077
- [X] T084 [P] [US4] `tests/integration/docs/limits-inventory.test.ts`: extend to assert T083's two new rows exist — depends on T083
- [X] T085 [P] [US4] `tests/integration/x/no-secrets.test.ts`: extend to the insights reader — a token planted in a scripted X error never reaches a snapshot row, `last_error`, `unavailable_reason` or a rendered page (FR-046) — depends on T077, T078

**Checkpoint**: US1–US4 are all independently functional. X's reader exists, is off by default, and is bounded by a ceiling that cannot be exceeded under any schedule configuration.

---

## Phase 7: User Story 5 — An operator can find out what to grant and what it will cost (Priority: P3)

**Goal**: Each of the three setup guides lets an operator go from "insights unavailable" to numbers on a post by reading it alone.

**Independent Test**: read all three guides and confirm each names its permission/opt-in, its flag, what it buys, what still will not work and why; the docs tests confirm every named variable exists and every anchor resolves.

- [X] T086 [P] [US5] Edit `docs/pinterest-setup.md`: the extra permission (`pins:read`), the `PINTEREST_INSIGHTS_SCOPES` flag, what Docket can read once granted (pin analytics) and once connected at all (account numbers, no flag needed), and what still will not work (Trial invisibility, per T072) (FR-058) — depends on T068
- [X] T087 [P] [US5] Confirm `docs/tiktok-setup.md` (edited in T048) also states the `TIKTOK_INSIGHTS_SCOPES` flag, the `video.list`/`user.info.stats` permissions and what each buys, alongside the existing audit note (FR-058) — depends on T054
- [X] T088 [P] [US5] Confirm `docs/x-setup.md` (written in T082) satisfies FR-058's general shape (permission/opt-in, flag, what it buys, what still will not work) on top of its X-specific checklist — depends on T082
- [X] T089 [US5] `tests/integration/docs/tiktok-docs.test.ts`, `pinterest-docs.test.ts`, `x-docs.test.ts`: extend each — every environment variable the guide names exists in `.env.example` with the same default; every anchor Docket's in-app links point at (`tiktok-setup#insights`, `pinterest-setup#insights`, `x-setup#insights`) resolves to a real heading (FR-058, SC-010) — depends on T005, T086, T087, T088
- [X] T090 [P] [US5] Edit `docs/insights.md`: the supported-platforms table gains TikTok, Pinterest and X with their permissions and honest gaps; the named-gaps section gains this entry's gaps (unrecoverable TikTok ids, the `gone`-vs-`unqueryable` conflation, the X parked billing questions) (FR-059) — depends on T054, T068, T077

**Checkpoint**: US1–US5 are all independently functional. Every capability above is discoverable by reading its guide alone.

---

## Phase 8: User Story 6 — A renewed or narrowed grant does not go stale (Priority: P3)

**Goal**: TikTok's and Pinterest's credential refresh record the reply's scope list, so a narrowed or renewed grant is reflected without a reconnect.

**Independent Test**: refresh a TikTok and a Pinterest account with a mocked token reply whose `scope` differs from the stored grant; assert the stored grant now matches. Refresh with a reply carrying no scope and assert nothing changes.

- [X] T091 [P] [US6] `src/providers/tiktok/refresh.test.ts`: extend — a refresh reply whose `scopes` list omits a previously granted insight scope updates the account's stored `grantedScopes`; a reply carrying no scope field (`out.scopes` absent) leaves it unchanged (FR-056, FR-057) — write first, confirm it fails
- [X] T092 [US6] Edit `src/providers/tiktok/refresh.ts`: `refreshTikTok`'s success arm adds `...(out.scopes ? { grantedScopes: out.scopes } : {})` to the returned `RefreshResult`, per G31's existing `grantedScopes` field — depends on T091
- [X] T093 [P] [US6] `src/providers/pinterest/refresh.test.ts`: extend — a refresh reply whose `scopes` differs from the stored grant updates it; a reply with no `scope` field leaves it unchanged (FR-056, FR-057) — write first, confirm it fails
- [X] T094 [US6] Edit `src/providers/pinterest/refresh.ts`: `refreshPinterest`'s success arm adds `...(out.scopes ? { grantedScopes: out.scopes } : {})` to the returned `RefreshResult` — depends on T093
- [X] T095 [P] [US6] `tests/integration/accounts/granted-scopes.test.ts` (081's file): extend to cover TikTok and Pinterest refresh — a narrowed grant moves the affected surface to "needs a reconnect" with no call attempted on the next tick — depends on T092, T094

**Checkpoint**: All six user stories are independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: The tick's new counts, the secret scan, remaining docs, and the final whole-suite pass.

- [X] T096 Edit `src/server/scheduler/insights-poll.ts`: add `targetsSkippedNoPublicPostId` to `InsightsPollCounts`/`emptyInsightsPollCounts`, sourced from T016's new DAL count, so the section's heartbeat distinguishes it from `targetsSkippedNoExternalId` (FR-053) — depends on T016
- [X] T097 [P] `tests/integration/scheduler/insights-counts.test.ts`: extend — `targetsSkippedNoPublicPostId` is observable over a fixture with a TikTok target lacking the column, counted separately from `targetsSkippedNoExternalId` and from a failure; `accountsSkippedNoPermission` counts an account missing either surface's scopes exactly once (FR-053) — depends on T096, T026
- [X] T098 Edit `tests/integration/security/secret-scan.test.ts`: extend to cover `post_targets.public_post_id`, both poll-state tables' `unavailable_reason`/`unavailable_docs_path`, and all three new providers' snapshot payloads and error strings with the scan's fake credentials — nothing exempted (FR-013, FR-054) — depends on T054, T068, T077
- [X] T099 [P] `tests/integration/insights/four-platform.test.tsx`: extend — a post with targets on TikTok, Pinterest, X and Bluesky at once renders each platform's block under its own words with nothing summed, averaged or compared; a metric any one platform omitted produces no row for it (FR-047, SC-009) — depends on T054, T068, T077
- [X] T100 [P] `tests/integration/insights/provider-seam.test.ts`: extend to confirm TikTok's, Pinterest's and X's declared metric keys stay provider-local and disjoint, and that `src/providers/**` still imports nothing from `src/server/**` for the three new modules (FR-018, constitution V) — depends on T054, T068, T077
- [X] T101 [P] Edit `docs/adding-a-provider.md`: record G35, G36, G37 in the "Generic hooks index" (continuing from G34) and explain each in §21, including the FR-050 "change to how an existing hook's output is used" note (FR-060) — depends on T015, T018, T025
- [X] T102 [P] Edit `docs/decisions.md`: append G35, G36, G37 with their reversals (contracts/provider-insights-082.md §2-§4), the four new FR-050 columns vs. inference, the Pinterest message-token exception (already in T075), and the X ceiling default — each with its reversal (FR-060) — depends on T101, T075
- [X] T103 [P] Edit `docs/feature-map.md`: record what this entry shipped (TikTok, Pinterest, X readers; the identifier repair; the FR-050 honesty fix) and the named gaps it leaves (FR-064) — depends on T054, T068, T077
- [ ] T104 Run the full final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` — depends on every task above except Phase 10

---

## Phase 10: Human tasks — the live consent screens and the parked research (US3, US4)

**Needs a real TikTok/Pinterest consent screen, a funded X key, or a browser — none of which a pipeline phase has.** Scheduled last so nothing above depends on it (spec "Parked human tasks", plan.md "Implementation order" phase 14, `speckit-human-task-deadlock`).

- [ ] T105 **Human task — X billing, question 1.** One live call against a funded key: does `public_metrics` on a post the app itself published bill as **one resource per post** at the Owned Read rate of $0.001? Read the answer off the developer console's usage page and record it in `docs/research/x.md` with the source URL and the date.
- [ ] T106 **Human task — X billing, question 2.** Same method: is `non_public_metrics` (impressions) included at the owned rate, or billed as a standard read? Record in `docs/research/x.md`. Until answered, FR-044 forbids requesting it.
- [ ] T107 [US2] **Human task — TikTok consent.** On a live consent screen with `TIKTOK_INSIGHTS_SCOPES=true`, confirm `video.list` appears as a separately declinable permission and that declining it leaves posting working. Record in `docs/research/tiktok.md`.
- [ ] T108 [US3] **Human task — Pinterest grant reporting.** On a live connect with `PINTEREST_INSIGHTS_SCOPES=true`, confirm the token reply's `scope` carries `pins:read` when granted. Record in `docs/research/pinterest.md`.
- [ ] T109 [US3] **Human task — Pinterest business/Trial reality.** Confirm the exact `PINNER_DATA_ACCESS_DENIED` body on a real non-business account, and whether a Trial app's own pins return analytics to their own creator. Record in `docs/research/pinterest.md`; if either account type is unobtainable in the available window, mark it unachievable there and state why.
- [ ] T110 **Human task.** On real TikTok, Pinterest and (if opted in) X accounts, confirm the declared metrics are actually returned on a published post (SC-011's "verified with mocks only" caveat lifting). If this window closes before it can run, mark it unachievable in the relevant `docs/research/*.md` and state why.

Until T105–T110 run, all three readers remain reported as **"verified with mocks only"** (constitution II, SC-011).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Phase 1 (the flags Phase 1 declares) — **blocks every user story**
- **US1 (Phase 3)**: depends on Phase 2 (G35, G36) — the identifier repair itself
- **US2 (Phase 4)**: depends on Phase 3 (a queryable id to poll) and Phase 2 (G37, the mock-proven eligibility machinery)
- **US3 (Phase 5)**: depends on Phase 2 only (G37's per-surface split is what makes Pinterest's account-without-pins story expressible); independent of US1/US2
- **US4 (Phase 6)**: depends on Phase 2 only (the opt-in-as-`unavailable` pattern, the existing reserve); independent of US1/US2/US3
- **US5 (Phase 7)**: depends on US2, US3 and US4's readers existing (the docs describe them) and on Phase 1's flags being in `.env.example`
- **US6 (Phase 8)**: depends on Phase 2 only (G31's `grantedScopes` field already exists); independent of every reader
- **Polish (Phase 9)**: depends on Phases 2–8
- **Human tasks (Phase 10)**: depends on nothing in this list completing first; nothing in Phases 1–9 depends on it

### Within Phase 2

T006, T007 → T008 → T009 → T010, T011. T012 (depends on T006) → T013 → T014. T012 → T015 → T016. T012 → T017 → T018 → T019. T012 → T020 → T021 → T022 → T023. T020 → T024 (no-op, confirmed later). T015, T020 → T025 → T026 → T027. T015, T025 → T028. T025 → T029 → T030, T031 → T032. T007 → T033 → T034 → T035 → T036, T037. T038 → T039 → T040.

### Parallel opportunities

- Phase 1: T001, T002, T003 in parallel; then T004, T005
- Phase 2: the schema chain (T006/T007→T008→T009→T010/T011), G35's chain (T012→T013→T014, T012→T015→T016), G36's chain (T012→T017→T018→T019) and the mock-fixture chain (T038→T039→T040) can proceed in parallel once their own prerequisites are met; G37's chain (T020→…→T032) and FR-050's chain (T007→T033→…→T037) are each sequential internally but independent of each other and of G35/G36 once T012/T020 land
- Phase 3: T041→T042→T043 in sequence; T045, T046, T047 in parallel once T042/T039 land; T048 last
- Phase 4: T049→T050→T051→T052 in sequence; T053→T054→T055 in sequence; T056, T057, T058 in parallel after T055; T059→T060 after
- Phase 5: T061→T062 and T063→T064→T065→T066 in parallel; T067→T068→T069 in sequence; T070, T071 in parallel after; T072, T073→T074, T075 in parallel
- Phase 6: T076→T077→T078 in sequence; T079, T080→T081, T085 in parallel after; T082, T083→T084 in parallel
- Phase 7: T086, T087, T088 in parallel; T089 after all three; T090 in parallel with T089
- Phase 8: T091→T092 and T093→T094 in parallel; T095 after both
- Phase 9: T096→T097; T098, T099, T100 in parallel once their readers exist; T101→T102 after T075; T103 in parallel; T104 last
- Phase 10: T105–T110 can run in any order once the relevant live account or funded key is available

---

## Parallel Example: Phase 2 foundational work

```bash
# Launch independent foundational tracks together once Phase 1 is green:
Task: "schema: post_targets.public_post_id + poll-state columns, then migration"   # T006, T007, T008
Task: "G35: InsightsDeclaration.postIdSource + registry assertion"                 # T012, T013, T014
Task: "G36: StepResult.publicPostId + record.ts one-liner"                         # T017, T018, T019
Task: "mock: insightsPostIdSource + insightsPostScopes/accountScopes"              # T038, T039, T040

# Each then continues its own chain:
Task: "G37: InsightsDeclaration split + registry + claims + eligibility"           # T020 → T025, after T012
Task: "FR-050: commit persistence + panel branch + view wiring"                    # T033 → T034 → T035, after T007
```

---

## Implementation Strategy

### MVP first

1. Phase 1 (Setup) → Phase 2 (Foundational) — blocking, must be green
2. Phase 3 (US1, the identifier repair) → **stop and validate independently** (quickstart.md §1) — the only part that repairs stored data

### Incremental delivery after the MVP

3. Phase 4 (US2, TikTok numbers) → **stop and validate independently** (quickstart.md §2) — the headline journey
4. Phase 5 (US3, Pinterest) → **stop and validate independently** (quickstart.md §3) — value with zero operator action
5. Phase 6 (US4, X priced opt-in) → **stop and validate independently** (quickstart.md §4) — the only place Docket spends money
6. Phase 7 (US5, setup guides) → **stop and validate independently** (quickstart.md §5)
7. Phase 8 (US6, refreshed grants) → **stop and validate independently** (quickstart.md §6)
8. Phase 9 (Polish) — counts, secret scan, docs, final whole-suite pass
9. Phase 10 (human tasks) — runs whenever live consent screens, real accounts or a funded key are available; resolves the parked billing questions and the "verified with mocks only" caveat

### Notes

- [P] tasks touch different files with no unmet dependency
- Every test task is written and confirmed failing before its matching implementation task
- Commit after each task or logical group
- The migration (T008) gates everything; G35/G36/G37 (Phase 2) gate every reader; US1 (Phase 3) gates US2 (Phase 4) specifically because TikTok's reader has nothing to poll without a public post id
- The human tasks (Phase 10) are deliberately last despite naming US2/US3 in their labels — every mocked-HTTP behaviour above them is independently provable, and a judgement task needing a live consent screen or a funded key starves the implement loop if placed earlier
