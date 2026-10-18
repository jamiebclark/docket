---

description: "Task list template for feature implementation"
---

# Tasks: Persist what a platform granted, then read Instagram, Facebook Page and Threads numbers

**Input**: Design documents from `/specs/081-insights-reconnect-and-meta/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Requested throughout the spec and plan (quickstart.md names the test files directly) — every phase below includes its test tasks, written to run and fail before the implementation task that follows them.

**Organization**: Tasks are grouped by user story per spec.md's priorities (US1–US3 P1, US4–US6 P2, US7 P3). The plan's own "Task ordering note for Phase 2" supplies the dependency order inside and across phases: research before any reader, the pure library and the grant/eligibility machinery before any user-story wiring, the three readers only after their metric tables exist, and — per the project's "park the human task last" rule — every task needing a live consent screen, a real platform account or a browser sits in Phase 11, after every mocked-HTTP, unit, integration and documentation task.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US7)
- Exact file paths are given in every task

---

## Phase 1: Setup

**Purpose**: Per-group/per-provider config knobs every later phase reads. No `src/server/env.ts` change (data-model.md §5 — these follow the `TIKTOK_APP_AUDITED` precedent of living in each provider's own `config.ts`).

- [X] T001 [P] Edit `src/providers/meta/config.ts`: add `insightsScopes` (bool, default `false`, from `META_INSIGHTS_SCOPES`) and `insightsUsageCeiling` (int 1–100, default `80`, from `META_INSIGHTS_USAGE_CEILING`) to `MetaConfig` and `parseMetaEnv`, each declared in `environment.variables` as `{ secret: false, required: false }` with a `"must be true or false"` / range validation issue, matching `TIKTOK_APP_AUDITED` exactly (data-model.md §5)
- [X] T002 [P] Edit `src/providers/threads/config.ts`: add `insightsScopes` (bool, default `false`, from `THREADS_INSIGHTS_SCOPES`) and `insightsUsageCeiling` (int 1–100, default `80`, from `THREADS_INSIGHTS_USAGE_CEILING`) to `ThreadsConfig` and `parseThreadsEnv`, same shape as T001 (data-model.md §5)
- [X] T003 [P] `src/providers/meta/config.test.ts` and `src/providers/threads/config.test.ts`: extend — each new flag parses with its documented default, rejects a non-boolean/out-of-range value as an environment issue (not a crash), per quickstart.md §6 point 6 — depends on T001, T002
- [X] T004 [P] Add the four new variables to `.env.example`, one block per group, each naming the permission it adds, that the permission must *also* be added to the Meta app / Threads app, and the Login-for-Business caveat (FR-017, FR-053, data-model.md §5) — depends on T001, T002

**Checkpoint**: config knobs ready, all defaulting to off/conservative; no existing behaviour changed yet.

---

## Phase 2: Foundational — the research, the pure library, the contract, the schema, the grant and its eligibility (Blocking Prerequisites)

**Purpose**: Everything FR-006 … FR-028 needs, plus the research FR-001 … FR-005 demands *before any reader*. **No user story's implementation starts before this phase is green.** This phase alone already makes US1's safety property and most of US2's recording property true; the user-story phases that follow are mostly the per-provider wiring and the tests that prove it.

### The research, transcribed first (FR-001 … FR-005)

- [X] T005 Edit `docs/research/meta.md`: transcribe research.md §1–§3 into one table per surface — Instagram media insights, Instagram user insights, Facebook Page post insights, Facebook Page insights, Threads media insights, Threads user insights — each row giving the metric name, the required permission, the `period`/`metric_type`, applicable media/post types and the 24–48h processing delay, each with a source URL and a check date; record Instagram's `impressions`→`views` removal with its deprecation citation; record Facebook's `post_impressions`/`page_impressions`/`page_fans` deprecation (2025-11-15) and the unconfirmed `post_media_view`/`page_media_view` replacement as a recorded disagreement with the roadmap (FR-005); record Threads' five corroborated-but-not-official metric names as NOT CONFIRMED; correct §Q6's "Code impact" note — codes 80001/80002 are already classified rate-limited and tested (research.md §5.1) — and state whether Instagram batches multiple media ids (FR-002) and the confirmed 24-hour story window (FR-002, FR-003)
- [X] T006 [P] Edit `docs/decisions.md`: append the research-first decision, the Facebook-metrics disagreement (FR-005), and the six open `NEEDS RESEARCH` rows with their stated fallbacks (spec "Facts recorded against the research notes") — depends on T005

### Pure library — no database, no provider, nothing to mock

- [X] T007 [P] `src/lib/granted-scopes.test.ts` (new): the table in data-model.md §2 case by case — `undefined`/`null` → `null`; non-array → `null`; `[]` → `[]`; a Meta-token-shaped entry (e.g. `EAABw...`) → `null`, **not** a filtered list; a JWT-shaped entry → `null`; 41 entries → `null`; over-1000-bytes joined → `null`; duplicates deduped keeping platform order (FR-009, FR-015) — write first, confirm it fails
- [X] T008 [P] `src/lib/granted-scopes.ts` (new, pure): `GRANTED_SCOPE_PATTERN`, `MAX_GRANTED_SCOPES`, `MAX_GRANTED_SCOPES_BYTES`, `normalizeGrantedScopes` per data-model.md §2's rule table — never throws, whole-list rejection on any failure — depends on T007
- [X] T009 [P] `src/lib/insights/eligibility.test.ts` (new): the five-row ordered decision table of contracts/granted-scopes.md §4 — empty `requiredScopes` → `ok`; held superset → `ok`; `cannotWiden` set → `not_granted, canReconnect: false` (row 3 before row 4); a required-and-missing scope absent from `requestedScopes` → `not_requested`; otherwise → `not_granted, canReconnect: true`; `null` vs `[]` both reach the same *kind* but `missing` is always populated so the screen can name exactly what is absent (FR-021, FR-025) — write first, confirm it fails
- [X] T010 [P] `src/lib/insights/eligibility.ts` (new, pure): `InsightsPermission`, `insightsPermissionFor` per contracts/granted-scopes.md §4 — depends on T009
- [X] T011 [P] `src/lib/insights/schedule.test.ts`: extend — `postPollDecision` with no `ephemeralPostTypes` match is byte-identical to `nextPostPollAt` for every existing case (FR-043); inside an ephemeral window → `due`; at or past `publishedAt + lifetimeMs` → `frozen "expired"`; a dense-cadence candidate that would land past the boundary → `frozen "expired"` instead (FR-039, FR-040); confirm **080's existing `nextPostPollAt`/`nextAccountPollAt` tests are untouched** — write first, confirm it fails
- [X] T012 [P] Edit `src/lib/insights/schedule.ts`: add `PostPollDecision` and `postPollDecision`, delegating to the unchanged `nextPostPollAt` per contracts/provider-insights-081.md §4 — depends on T011
- [X] T013 [P] `src/providers/meta/usage.test.ts` (new): `parseUsageHeader` — `null`/`""`/non-JSON/non-object → `null`; multiple object ids, max of `call_count`/`total_cputime`/`total_time` clamped to `[0,100]`; `estimated_time_to_regain_access` clamped to `[0,1440]`; no usable number → `null`, never `0` (contracts/meta-usage.md §1) — write first, confirm it fails
- [X] T014 [P] `src/providers/meta/usage.ts` (new, pure): `UsageSignal`, `parseUsageHeader` per contracts/meta-usage.md §1 — depends on T013

### The contract — types, registry assertions, mock scripting

- [X] T015 Edit `src/providers/types.ts`: add `grantedScopes?: readonly string[]` to `ConnectCandidate` and to the success arm of `RefreshResult` (G31); add `optionalScopes` (`declared`, `doc?`, `requested()`, `cannotWiden?()`) to `OAuthConnectGroup` (G32); add `requiredScopes?`, `missingScopes?`, `ephemeralPostTypes?` to `InsightsDeclaration` (G33, G34); add the `unqueryable` arm to `PostMetricEntry` — exactly per data-model.md §6 — depends on T008, T010, T012
- [X] T016 Edit `src/providers/registry.ts`: extend `assertInsightsDeclaration` with the five checks of data-model.md §6 — `requiredScopes` non-empty ⇒ `missingScopes.reason` 1–300 chars; every `requiredScopes` entry matches `GRANTED_SCOPE_PATTERN`; every `ephemeralPostTypes.postType` is a known `PostType` in the provider's own `capabilities.postTypes` and unique; every `lifetimeMs` in `[60_000, 30*86_400_000]`; `unavailable` and `requiredScopes` never both set — depends on T008, T015
- [X] T017 [P] `src/providers/registry.test.ts`: extend with the five new assertion rules from T016, one failing declaration per rule — depends on T016
- [X] T018 [P] Edit `src/providers/mock/settings.ts` and `src/providers/mock/insights.ts`: add `insightsRequiredScopes`, `insightsEphemeralLifetimeMs`, `insightsUnqueryableIds`, `insightsUsagePercent`, `insightsRetryAfterMinutes` per contracts/provider-insights-081.md §6 — depends on T015
- [X] T019 [P] `src/providers/mock/insights.test.ts`: extend — each new scripting field is reachable from settings alone, with no change to `mock`'s existing declared keys or behaviour — depends on T018

### Schema and migration

- [X] T020 Edit `src/server/db/schema/accounts.ts`: add `grantedScopes: text("granted_scopes").array()` to `socialAccounts`, the joined-string `social_accounts_granted_scopes_shape` CHECK and the `social_accounts_granted_scopes_idx` GIN index, exactly per data-model.md §1 — depends on T008 (same pattern/bounds)
- [X] T021 Edit `src/server/db/schema/insights.ts`: widen `post_metric_poll_states_frozen_reason_enum` to `('settled', 'gone', 'expired', 'unqueryable')` per data-model.md §3
- [X] T022 Generate migration `drizzle/00XX_*.sql` via `pnpm db:generate` from T020/T021 (never hand-written) and run `pnpm db:check` until green (FR-006, FR-040) — depends on T020, T021
- [X] T023 [P] `tests/integration/db/` (extend the existing CHECK-coverage test, or add one beside it): insert a token-shaped array directly via raw SQL and assert the `social_accounts_granted_scopes_shape` CHECK rejects it; insert 41 entries and assert the same; insert `{}` and assert it is accepted (data-model.md §1, FR-009) — depends on T022
- [X] T024 [P] `tests/integration/db/enum-value-in-batch.test.ts`: extend to confirm the widened `frozen_reason` CHECK is still a text CHECK, not an enum, and the widening needed no `ALTER TYPE` (data-model.md §3) — depends on T022

### The write boundary (G31) and per-account eligibility (G33) — the machinery every story wires into

- [X] T025 Edit `src/server/dal/accounts.ts`: `upsertConnected` calls `normalizeGrantedScopes(candidate.grantedScopes)` and writes the result to `grantedScopes` on both insert and update, leaving every other preserved field (`id`, `postingInstructions`, `publishLimitCount`, `publishLimitWindowSeconds`, `removedAt`, `createdAt`) untouched (FR-010, FR-014) — depends on T008, T015
- [X] T026 Edit `src/server/scheduler/credentials.ts`: `applyRefreshResult` writes `grantedScopes` only when the success arm's `grantedScopes` field is **present**, via `...(normalized !== null ? { grantedScopes: normalized } : {})`, leaving the column untouched when absent (FR-011) — depends on T008, T015
- [X] T027 [P] `tests/integration/accounts/` (new or extended test file for the write boundary): scan the repo and assert `grantedScopes:` appears in an insert/update position in exactly `src/server/dal/accounts.ts` and `src/server/scheduler/credentials.ts` (FR-010) — depends on T025, T026
- [X] T028 [P] `tests/integration/accounts/reconnect-preserves.test.ts` (new): for every OAuth group, create an account with a publish-limit override, posting instructions, a slot assignment, an insights poll state and two snapshots; reconnect through the same group; assert exactly one row, the same `id`, and all five preserved (FR-014, SC-005, US2-AS3); then the two edge cases: the same Page connected twice in a row updates in place; a removed-then-reconnected account gets a new row because the unique index is partial on `removed_at IS NULL` — depends on T025
- [X] T029 [P] `tests/integration/accounts/granted-scopes.test.ts` (new): a refresh returning a token and no permission list leaves the stored value identical, including when it was `[]` (FR-011, US2-AS4); a refresh reporting a list that drops the insight permission replaces the stored value and the account stops being claimable from the next tick, with no error and its snapshots intact (FR-028, US2-AS5) — depends on T025, T026
- [X] T030 Edit `src/server/dal/insights-claims.ts`: add `InsightsProviderRule` (`providerKey`, `requiredScopes`, `ephemeralPostTypes`); change `claimDueAccountMetricPolls`, `claimDuePostMetricPolls` and `countPublishedWithoutExternalId` to take `providers: readonly InsightsProviderRule[]` in place of `providerKeys: readonly string[]`; replace every `inArray(socialAccounts.providerKey, providerKeys)` with the `eligible(rules)` OR-of-ANDs predicate of data-model.md §4; the lazy insert in `claimDuePostMetricPolls` calls `postPollDecision` (T012) instead of `nextPostPollAt` directly and can insert a state row **born frozen** `expired` with no provider call (FR-022, FR-023, FR-041) — depends on T008, T012, T020
- [X] T031 Edit `src/server/dal/insights-claims.ts`: add `countAccountsMissingInsightsScopes(providers)` — non-removed, `active` accounts whose provider has non-empty `requiredScopes` and whose `granted_scopes IS NULL OR NOT (granted_scopes @> requiredScopes)`, wrapped in `crossProject(...)` like its sibling (FR-049, data-model.md §4) — depends on T030
- [X] T032 [P] `tests/integration/insights/eligibility-matrix.test.ts` (new): the cross product of {`null`, `[]`, partial, exact, superset} × {0, 1, 2 required scopes}, asserting for every cell that *the account was claimed* ⟺ *`insightsPermissionFor` returned `ok`* (contracts/granted-scopes.md §4, "pinned to the SQL"); Bluesky and `mock` with `requiredScopes: []` are claimed exactly as 080 specified (FR-024) — write first, confirm it fails, then green against T030 — depends on T010, T030
- [X] T033 [P] `tests/integration/insights/eligibility-matrix.test.ts`: extend — `countAccountsMissingInsightsScopes` reports the ineligible accounts as its own count, never as a failure (US7-AS1); two accounts on one Meta login, one eligible and one not, produce one claimed account and one non-claim (US3-AS6) — depends on T031, T032

### Eligibility surfaces in the panel and the accounts page

- [X] T034 Edit `src/lib/insights/panel.ts`: add `permission: InsightsPermission | null` to the input and the two new states — `permission_not_requested` and `needs_reconnect` — inserted immediately after `unavailable` and before `no_external_id`, per contracts/panel-and-accounts.md §1; neither renders a number, a dash or a zero — depends on T010
- [X] T035 [P] `tests/unit/insights/panel.test.ts`: extend — the two new rows of the decision table, each ordering case (both insertion points), neither state ever carrying a snapshot or a number — write first, confirm it fails — depends on T034
- [X] T036 Edit `src/server/services/accounts.ts`: add `insightsPermission: InsightsPermission | null` to `AccountView`, computed from the account's `grantedScopes`, the provider's declaration and the group's `optionalScopes` via `insightsPermissionFor` — no change to `status`, `notes` or `publishLimit` (FR-013, FR-027) — depends on T010, T015
- [X] T037 Edit `src/app/p/[projectSlug]/accounts/page.tsx`: render the "Insights need a reconnect" line — provider's reason, docs link, existing `ReconnectGroupButton` only when `canReconnect` — shown only for `insightsPermission.kind === "not_granted"`, after `notes` and before the reconnect controls, per contracts/panel-and-accounts.md §3; status badge, `canManage` gating and publishing untouched — depends on T036
- [X] T038 [P] `tests/integration/accounts/` or a new `accounts-page.test.ts`: the line appears only for `not_granted`, not for `not_requested`; the reconnect button appears only when `canReconnect`; an ineligible account's `status` stays `active` and it still publishes (FR-027, US1-AS4, US3-AS2) — depends on T037

**Checkpoint**: the whole grant-and-eligibility half is green. US1's safety property and US2's recording property are provable now, with no reader yet written.

---

## Phase 3: User Story 1 — An install that does nothing keeps working, exactly as before (Priority: P1) 🎯 MVP

**Goal**: Prove the entry's safety property directly against the machinery Phase 2 built, with no new environment variable set.

**Independent Test**: run the full suite with no new environment variable set, accounts whose `granted_scopes` is `NULL`; assert byte-identical authorization URLs, zero Meta/Threads claims, zero failures attributable to them, a reason (not an error) on the panel, and Bluesky unchanged.

- [X] T039 [P] [US1] `src/providers/meta/oauth.test.ts`: extend — with `META_INSIGHTS_SCOPES` unset, `dialogUrl` equals a **literal** expected string identical to today's (FR-018, US1-AS1) — write first, confirm it fails if T040 regresses it
- [X] T040 [US1] Edit `src/providers/meta/oauth.ts`: `dialogUrl` appends `optionalFor(cfg)` to `scope` only in the non-config-id path, per contracts/granted-scopes.md §3 — with the flag unset this is a no-op — depends on T015, T039
- [X] T041 [P] [US1] `src/providers/threads/connect-group.test.ts` or `oauth.test.ts`: extend — with `THREADS_INSIGHTS_SCOPES` unset, the authorization URL is byte-identical to today's literal (FR-018, US1-AS1)
- [X] T042 [P] [US1] `tests/integration/insights/` (new or extended, e.g. `tests/integration/insights/no-reconnect-safety.test.ts`): insert a pre-081 Instagram account with `granted_scopes IS NULL`, run the insights section, assert it is absent from the claim, its lease is untouched, `getCredentialsCiphertext` was not called for it, and no HTTP request was recorded for it (FR-023, SC-003, US1-AS2) — depends on T030
- [X] T043 [P] [US1] `tests/integration/insights/panel.test.tsx` (extend 080's): a Meta account with no permission renders `permission_not_requested` with the guide link and no number, no dash, no zero (US1-AS3) — depends on T034
- [X] T044 [P] [US1] Extend T038's accounts-page test: badge unchanged, no reconnect line, publishing unaffected for a pre-081 account (US1-AS4)
- [X] T045 [US1] Run 080's whole insights suite untouched and confirm green with no edit required (FR-024, FR-043, US1-AS5) — depends on T030, T034, T012

**Checkpoint**: US1 is independently proven — an install that changes nothing sees zero behaviour change.

---

## Phase 4: User Story 2 — The grant is recorded, so Docket can answer "may this account read insights?" (Priority: P1)

**Goal**: Every OAuth provider that can report what it granted does so, through the one write boundary, with reconnect losing nothing.

**Independent Test**: connect each OAuth provider against mocked HTTP whose token/permission replies are scripted; assert the stored value for each; reconnect and assert row identity and preserved fields; script a refresh with and without a permission list.

- [X] T046 [US2] Edit `src/providers/meta/candidates.ts`: extend the existing `/debug_token` read to also surface `data.scopes`, filtered to strings matching `GRANTED_SCOPE_PATTERN`; on any failure return `undefined` (not `[]`); attach the same list to both the Page and the Instagram `ConnectCandidate` (contracts/granted-scopes.md §2) — depends on T008, T015
- [X] T047 [P] [US2] `src/providers/meta/candidates.test.ts`: extend — a scripted `/debug_token` reply with `scopes` populates `grantedScopes` on both candidates; a failed `/debug_token` call leaves `grantedScopes` undefined on both, and the candidates still succeed (US2-AS1) — write first, confirm it fails
- [X] T048 [US2] Edit `src/providers/threads/oauth.ts`: attach the already-parsed `grantedList(body)` to the `ConnectCandidate`'s `grantedScopes` (currently only used for a note) (FR-012, FR-013) — depends on T015
- [X] T049 [P] [US2] `src/providers/threads/oauth.test.ts`: extend — a reply with no permission list yields `grantedScopes` absent and the stored column `NULL`, not `[]` and not the requested list (US2-AS2); the existing missing-publish-permission note is byte-identical (FR-013) — write first, confirm it fails
- [X] T050 [US2] Edit `src/providers/x/oauth.ts`: attach the already-parsed `tokens.scopes` to the `ConnectCandidate`'s `grantedScopes` (FR-012) — depends on T015
- [X] T051 [US2] Edit `src/providers/tiktok/connect-group.ts`: attach the already-parsed callback `scopes` (falling back to the token reply's `scope`) to the `ConnectCandidate`'s `grantedScopes` (FR-012) — depends on T015
- [X] T052 [US2] Edit `src/providers/pinterest/oauth.ts` or `connect-group.ts`: if the token reply carries a `scope` field, attach it to `grantedScopes`; otherwise leave it absent (FR-012, R6) — depends on T015
- [X] T053 [P] [US2] `src/providers/x/oauth.test.ts`, `src/providers/tiktok/connect-group.test.ts`, `src/providers/pinterest/oauth.test.ts` or `connect-group.test.ts`: extend each with a scripted reply carrying a scope list and one carrying none, asserting `grantedScopes` on the candidate (FR-012) — depends on T050, T051, T052
- [X] T054 [US2] Run T028 (`reconnect-preserves.test.ts`) and T029 (`granted-scopes.test.ts`) against every provider wired in this phase and confirm green (SC-005, US2-AS3/4/5) — depends on T046, T048, T050, T051, T052, T028, T029
- [X] T055 [P] [US2] Edit `tests/integration/security/secret-scan.test.ts`: add cases covering `granted_scopes` holding a scripted value from each provider above, and a rejected token-shaped reply, asserting no credential anywhere in the serialized row (FR-015, FR-056) — depends on T046, T048, T050, T051, T052

**Checkpoint**: US1 and US2 both independently functional — the grant is recorded reliably and reconnect preservation is a tested property, with no reader yet written.

---

## Phase 5: User Story 3 — An operator turns the permission on, a member reconnects, and numbers arrive (Priority: P1)

**Goal**: The opt-in flow works end to end for the Meta group, and Instagram — the one platform with a fully confirmed metric vocabulary — proves numbers actually arrive.

**Independent Test**: with the flag on and scripted Graph responses, drive the connect callback with a permission list including the insight scope, run the tick, render the panel.

- [ ] T056 [US3] Edit `src/providers/meta/connect-group.ts`: add `optionalScopes` — `declared: [read_insights, instagram_manage_insights]`, `doc`, `requested()` reading `parseMetaEnv(source).config.insightsScopes`/`loginConfigId`, `cannotWiden()` returning the Login-for-Business reason when a config id is set and the flag is on — per contracts/granted-scopes.md §3 — depends on T001, T015
- [ ] T057 [P] [US3] `src/providers/meta/connect-group.test.ts` or `oauth.test.ts`: extend — flag on, no config id ⇒ dialog carries today's scopes plus exactly `read_insights` and `instagram_manage_insights`, in declaration order, nothing else (US3-AS1); flag on, config id set ⇒ dialog unchanged, `cannotWiden()` returns the Login-for-Business reason (FR-019, US3-AS3) — write first, confirm it fails — depends on T040, T056
- [ ] T058 [US3] Edit `src/providers/threads/connect-group.ts`: add `optionalScopes` with one scope `threads_manage_insights` and no `cannotWiden` — depends on T002, T015
- [ ] T059 [P] [US3] `src/providers/threads/connect-group.test.ts`: extend — flag on ⇒ dialog carries `threads_manage_insights` in addition to today's scopes; flag off ⇒ byte-identical (FR-018, FR-020) — write first, confirm it fails — depends on T041, T058
- [ ] T060 [US3] `docs/research/meta.md` is already extended (T005); `src/providers/instagram/insights.ts` (new): declare `requiredScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"]`, `missingScopes`, `maxPostsPerRead: 1`, `readBudget: { count: 48_000, windowSeconds: 86_400 }` (interim, UNVERIFIED), `ephemeralPostTypes: [{ postType: "story", lifetimeMs: 86_400_000 }]`, the exported `INSTAGRAM_POST_METRICS` / `INSTAGRAM_PROHIBITED_METRICS` constants, the seven post keys and three account keys of contracts/provider-insights-081.md §1, `readPostMetrics`/`readAccountMetrics` via `graphRequest`/`graphList`, mapped per §5's result table — depends on T005, T008, T014, T015
- [ ] T061 [P] [US3] `src/providers/instagram/insights.test.ts` (new, mocked HTTP only): every declared metric traces to the T005 research table; `impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count` are absent from the constant, the declaration and every recorded request (FR-004); result mapping — `page`/metrics, `gone`, `rate_limited` from the usage header at/above `META_INSIGHTS_USAGE_CEILING`, `credentials_invalid` on code 190, `retryable_error`, `fatal_error`; a declared metric with an empty `values` array is absent, not zero (FR-035); never throws, no credential in any message (FR-033, FR-037) — write first, confirm it fails — depends on T060
- [ ] T062 [US3] Edit `src/providers/instagram/index.ts`: add `insights: instagramInsights` — depends on T060, T061
- [ ] T063 [US3] Wire the opt-in flag into the Instagram eligibility test and run the full US3 flow: `tests/integration/insights/` — flag on, scripted permission list including `instagram_manage_insights`, a tick, and the rendered panel showing Instagram's own labels with one "as of" line (US3-AS4, US3-AS5) — depends on T056, T060, T062, T030, T034
- [ ] T064 [P] [US3] Extend T038's accounts-page test: flag on, account not yet granted ⇒ "Insights need a reconnect" with reason, docs link, reconnect button, unchanged status badge (US3-AS2); flag on, config id set ⇒ Login-for-Business reason, no reconnect button (US3-AS3) — depends on T037, T056

**Checkpoint**: US1, US2 and US3 all independently functional — the headline journey (opt in, reconnect, see Instagram numbers) works end to end against mocked HTTP. This is a shippable increment beyond the MVP.

---

## Phase 6: User Story 4 — Three platforms, three vocabularies, never added together (Priority: P2)

**Goal**: Facebook (reduced to its non-deprecated metrics) and Threads (per FR-003's confirmed-or-unavailable rule) join Instagram, each with the Facebook video-id rule honoured, and the panel proves no platform's number is ever summed, averaged or relabelled by generic code.

**Independent Test**: a rendering test over one post with four targets and four scripted snapshots, asserting the labels, the per-account grouping, the absence of any aggregate, and the absence of any row for a metric the response omitted.

- [ ] T065 [US4] `src/providers/facebook/insights.ts` (new): declare `requiredScopes: ["pages_read_engagement", "read_insights"]`, `missingScopes`, `maxPostsPerRead: 1`, `readBudget` (interim, UNVERIFIED), post keys `post_reactions_by_type_total`→"Reactions" and `post_clicks`→"Clicks", account keys `page_post_engagements`→"Engagements" and `page_follows`→"Follows"; the exported `FACEBOOK_PROHIBITED_METRICS` constant covering the deprecated views/impressions/fans family; the `PAGE_POST_ID` classifier returning `{ kind: "unqueryable", reason }` for a bare video id **without issuing a request**, per contracts/provider-insights-081.md §2 — depends on T005, T008, T014, T015
- [ ] T066 [P] [US4] `src/providers/facebook/insights.test.ts` (new, mocked HTTP only): every declared metric traces to the T005 research table; `post_impressions*`, `page_impressions*`, `page_fans*`, `page_posts_impressions*` and the parked `*media_view*` names are absent from every declaration and request (FR-004 analogue); a video-id external id returns `unqueryable` with no HTTP request recorded (FR-036); result mapping per §5; no credential in any message — write first, confirm it fails — depends on T065
- [ ] T067 [US4] Edit `src/providers/facebook/index.ts`: add `insights: facebookInsights` — depends on T065, T066
- [ ] T068 [US4] `src/providers/threads/insights.ts` (new): per the research.md §3 outcome recorded in T005 — if the official metric enum is confirmed, declare post keys `views`/`likes`/`replies`/`reposts`/`quotes` with `requiredScopes: ["threads_manage_insights"]`, `missingScopes`, `account: []`, `readBudget: { count: 48_000, windowSeconds: 86_400 }` (sourced, §Q5's floor of 10); otherwise ship `unavailable: { reason, docsPath }` with `post: []`, `account: []` — either way `threads_manage_insights` is still requested under `THREADS_INSIGHTS_SCOPES` and the grant is still recorded (contracts/provider-insights-081.md §3) — depends on T005, T008, T014, T015
- [ ] T069 [P] [US4] `src/providers/threads/insights.test.ts` (new, mocked HTTP only): matches whichever shape T068 shipped — either every declared metric traces to T005 with correct result mapping, or the module declares `unavailable` and is excluded from the claim with no call ever made; `shares` is absent from the declaration either way (research §3, R3) — write first, confirm it fails — depends on T068
- [ ] T070 [US4] Edit `src/providers/threads/index.ts`: add `insights: threadsInsights` — depends on T068, T069
- [ ] T071 [P] [US4] `tests/unit/insights/panel.test.ts` or a new `tests/integration/insights/four-platform.test.tsx`: one post with four targets (Instagram, Facebook, Threads, Bluesky) and four scripted snapshots — each account's block uses its own platform's labels, no total/average/combined figure appears anywhere; a Threads response omitting `quotes` produces no Quotes row; Facebook's reactions stay broken out by type under Facebook's own names (SC-006, US4-AS1/2/3) — write first, confirm it fails
- [ ] T072 [P] [US4] `tests/integration/insights/provider-seam.test.ts` or extend 080's: a module-scan assertion that the three new providers' declared metric keys and labels are disjoint, provider-local declarations with no shared mapping table, and that no module outside `src/providers/` names a metric key (FR-034) — asserts **keys** are provider-local; deliberately does not assert labels are unique

**Checkpoint**: US1–US4 all independently functional. All three readers exist and the "never sum across platforms" rule is proven structurally, not just by convention.

---

## Phase 7: User Story 5 — A story is read while it exists, then frozen (Priority: P2)

**Goal**: An Instagram story is polled densely inside its 24-hour window and frozen `expired` at the boundary, with no catch-up capture for a story already dead when first seen.

**Independent Test**: pure unit tests over the schedule function (done in Phase 2, T011/T012), plus an integration test driving a story target through its window and past it against the mock provider.

- [ ] T073 [P] [US5] `tests/integration/insights/ephemeral.test.ts` (new): on `mock` with `insightsEphemeralLifetimeMs`, a story target is read through its window on the dense first-band cadence, never scheduled past the boundary, then frozen `expired` with zero calls after (SC-007, US5-AS1/2); a story already past its lifetime when first seen is inserted **born frozen** with no provider call and no catch-up capture (FR-041, US5-AS3); a non-ephemeral target on the same account follows 080's unchanged decaying schedule (US5-AS5) — write first, confirm it fails — depends on T012, T030, T018
- [ ] T074 [US5] Edit `src/server/scheduler/insights-poll.ts`: `commitPostBatch` calls `postPollDecision` (T012) after a successful capture, with `counts.targetsFrozenExpired++` on `"expired"` and `counts.targetsFrozenSettled++` on `"settled"`, and `ClaimedPostMetricPoll` gains `chosenPostType` (already selected for the lazy insert) per contracts/scheduler-insights-081.md §3 — depends on T012, T030
- [ ] T075 [P] [US5] `tests/integration/insights/panel.test.tsx`: extend — a frozen-`expired` target shows every snapshot captured while it lived, with "as of" times, plus "this story has expired; these numbers are final", and **no failure styling** (US5-AS4, FR-042) — depends on T034, T074
- [ ] T076 [US5] Confirm 080's existing schedule tests (`tests/unit/insights/schedule.test.ts` from 080) pass **untouched** — the proof that FR-043 holds (US5-AS5) — depends on T012

**Checkpoint**: US1–US5 all independently functional. Stories are read and frozen correctly, never burning an allowance on a dead subject.

---

## Phase 8: User Story 6 — Polling respects Meta's own limit and never starves a publish (Priority: P2)

**Goal**: The live `X-Business-Use-Case-Usage` signal backs off insights reads before Meta's own exhaustion, on top of the unchanged per-account reserve, without ever deferring a scheduled publish.

**Independent Test**: scripted Graph responses carrying the usage header at various percentages and `estimated_time_to_regain_access`, plus scripted 80001/80002 errors, asserted against the read result, the recorded backoff and the section counts; plus the existing reserve tests extended to the new providers.

- [ ] T077 [US6] Edit `src/providers/meta/graph.ts`: `send()` reads `res.headers.get("x-business-use-case-usage")` through T014's `parseUsageHeader` and attaches `usage?: UsageSignal` to every response-bearing `GraphOutcome` arm; `graphSummary` gains `usagePercent` when present — every existing caller and existing Graph test unaffected (contracts/meta-usage.md §2) — depends on T014
- [ ] T078 [P] [US6] `src/providers/meta/graph.test.ts`: extend — a mocked response carrying the usage header yields `outcome.usage` with the parsed signal; a response with no header yields `usage: undefined`; every existing test in the file still passes unedited — write first, confirm it fails — depends on T077
- [ ] T079 [US6] Edit `src/providers/instagram/insights.ts` and `src/providers/facebook/insights.ts`: after a successful read, when `outcome.usage.maxPercent >= metaUsageCeiling()`, the **next** call returns `rate_limited` with `retryAt` derived from `retryAfterMinutes` — the already-read batch's numbers are still committed (contracts/meta-usage.md §3) — depends on T001, T060, T065, T077
- [ ] T080 Edit the Threads request layer (`src/providers/threads/requests.ts`) and `src/providers/threads/insights.ts` (if shape (a) shipped in T068): apply the same usage-header read and ceiling check with `THREADS_INSIGHTS_USAGE_CEILING`, importing T014's parser — depends on T002, T014, T068
- [ ] T081 [P] [US6] `tests/integration/insights/budget.test.ts` (new): a 200 whose header reports at or above the ceiling ⇒ the batch's numbers are still committed and the next call is not made, result `rate_limited` with `retryAt` from the header (US6-AS1); codes 80001/80002 are already rate-limited and already tested (`src/providers/meta/errors.test.ts`) — assert this remains true, no new code needed (research §5.1, FR-046); an account at its window limit via the unchanged `checkInsightsAllowance` ⇒ poll deferred and counted `deferredForAllowance`, a publish for the same account in the same tick proceeds (FR-047, US6-AS3, SC-008); no header at all ⇒ the declared floor and reserve still bound the work (US6-AS4); every recorded reason/percentage/retry time is scrubbed and length-bounded (FR-048, US6-AS5) — write first, confirm it fails — depends on T077, T079, T080

**Checkpoint**: US1–US6 all independently functional. Meta's impressions-based limit is respected from its own live signal, and publishing is never starved.

---

## Phase 9: User Story 7 — An operator can see what the readers did (Priority: P3)

**Goal**: The insights section's counts distinguish every new outcome — no-permission skips, each freeze reason, unqueryable targets, allowance deferrals — and a starved section stays distinguishable from an idle one. One latent re-claim bug this entry makes reachable is fixed here.

**Independent Test**: assert the section's counts over scripted fixtures covering each outcome, and assert a heartbeat is written on every path including the empty one.

- [ ] T082 [US7] Edit `src/server/scheduler/insights-poll.ts`: replace the provider-wide `providerKeys` filter with the `InsightsProviderRule` list (T030) passed into both claims; add `accountsSkippedNoPermission` (from `countAccountsMissingInsightsScopes`, T031), `targetsFrozenExpired`, `targetsUnqueryable`, `targetsFrozenSettled` to `InsightsPollCounts`, keeping `targetsFrozen` as their total (contracts/scheduler-insights-081.md §1, §2) — depends on T030, T031, T074
- [ ] T083 [US7] Edit `src/server/scheduler/insights-poll.ts`'s `commitPostBatch`: add the `unqueryable` arm beside the `gone` arm — `counts.targetsUnqueryable++`, `counts.targetsFrozen++`, freeze with `nextPollAt: null, frozenAt: now, frozenReason: "unqueryable"` and **clear** `lastError`, `consecutiveFailures`, `failingSince` (contracts/scheduler-insights-081.md §3) — depends on T065, T082
- [ ] T084 [US7] Edit `src/server/scheduler/insights-poll.ts`: fix the latent `unavailable`-arm bug in `commitPostBatch` and `commitAccountResult` — advance `nextPollAt` via `nextRetryAt(now, consecutiveFailures + 1, config)` instead of leaving it due, so a per-read `unavailable` result backs off instead of being re-claimed every tick, without incrementing `consecutiveFailures` or counting as a failure (contracts/scheduler-insights-081.md §4) — depends on T082
- [ ] T085 [P] [US7] `tests/integration/scheduler/insights-counts.test.ts` (new): each new count separately observable over scripted fixtures — accounts ineligible for want of permission counted under their own field, not as a failure (US7-AS1); a target frozen `expired` and another frozen `settled` each counted under its own reason (US7-AS2); a Facebook video-id target counted under `targetsUnqueryable`, no call made, no failure (US7-AS3); a repeated per-read `unavailable` is not re-claimed on the next tick (contracts/scheduler-insights-081.md §4); a heartbeat is written on the no-eligible-providers path, the out-of-budget path and the normal path, and `outOfBudget > 0` with zero claims is distinguishable from nothing-to-do (US7-AS4, FR-050) — write first, confirm it fails — depends on T082, T083, T084
- [ ] T086 [P] [US7] `tests/integration/security/secret-scan.test.ts`: extend — the rendered panel with `needs_reconnect`/`permission_not_requested`/`expired`/`unqueryable` states, and a tick running all three new readers against accounts holding the distinctive fake credentials, with no exemption added (FR-015, SC-010) — depends on T034, T082

**Checkpoint**: All seven user stories independently functional. The section is fully observable and no outcome silently reports as nothing happening.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the `docs/limits.md` test-checked rows, the constitution amendment, and the final whole-suite pass.

- [ ] T087 [P] Edit `docs/insights.md`: the supported-platforms table, the permission each platform needs and how to grant it, the reconnect state, the story-expiry rule, and the named gaps (Facebook video-id targets; no account-metric screen yet) (FR-051)
- [ ] T088 [P] Edit `docs/adding-a-provider.md`: record G31, G32, G33, G34 in the "Generic hooks index" and in the relevant worked sections (FR-052)
- [ ] T089 [P] Edit `docs/meta-setup.md`: the extra permission for each surface, the opt-in environment flag, the Login-for-Business configuration case, and what the install gets for it (FR-053) — depends on T056, T058
- [ ] T090 [P] Edit `docs/limits.md`: add one `insights read budget` row per new reader (Instagram, Facebook, Threads), each with its source and enforcement pointer, each Meta-family row marked **interim, UNVERIFIED** with the note that the floor binds nothing on its own (research §4) (FR-054) — depends on T060, T065, T068
- [ ] T091 [P] `tests/integration/docs/limits-inventory.test.ts`: extend to assert T090's three new rows exist and the existing test stays green (FR-054) — depends on T090
- [ ] T092 [P] Edit `docs/feature-map.md`: record what this entry shipped and the named gaps it leaves (Facebook video-id repair, Facebook views/impressions family, Threads account metrics, parked R1–R4) (FR-055)
- [ ] T093 [P] Edit `.specify/memory/constitution.md`'s scope sentence to name this entry alongside 080, with a `docs(constitution):` commit and a version bump (FR-055)
- [ ] T094 [P] Confirm `docs/decisions.md` (started in T006) carries every decision in spec.md's "Decisions made while specifying" and plan.md's "Post-design re-check", each with its reversal (FR-052) — depends on T006
- [ ] T095 Run the full final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` — depends on every task above except Phase 11

---

## Phase 11: Human tasks — the live consent screens and the parked research (US3)

**Needs a real Meta/Threads consent screen, a real connected account, and a browser — none of which a pipeline phase has.** Scheduled last so nothing above depends on it (spec "Task ordering note for planning", plan.md "Task ordering note for Phase 2", quickstart.md §11).

- [ ] T096 [US3] **Human task.** Approve the extra permission (`read_insights`, `instagram_manage_insights`) on a live Meta consent screen with `META_INSIGHTS_SCOPES=true` and confirm the reported grant lands in `granted_scopes` for both the Page and the Instagram account.
- [ ] T097 [US3] **Human task.** The same for Threads with `THREADS_INSIGHTS_SCOPES=true`: approve `threads_manage_insights` and confirm the reported grant is recorded.
- [ ] T098 **Human task — R2 (research.md §7), one minute.** In Graph API Explorer against a real Page on Graph v26.0, find which of `post_media_view` and `post_total_media_view_unique` answers (or neither), and add Facebook's views metric to `src/providers/facebook/insights.ts` and `docs/research/meta.md` if confirmed; otherwise record the surface as still unconfirmed. If the window to check this closes before anyone does, mark it unachievable in `docs/research/meta.md` and state why.
- [ ] T099 **Human task — R1, R3, R4 (research.md §7).** Confirm Instagram's user-level `views` field, the Threads media-insights metric enum (including whether `shares` exists) and the Threads `user_insights` enum from their official pages; declare whatever is confirmed in the relevant provider's `insights.ts` and `docs/research/meta.md`. If Threads' enum becomes confirmed here, upgrade `src/providers/threads/insights.ts` from shape (b) to shape (a) (contracts/provider-insights-081.md §3) — no reconnect needed for anyone who already granted the permission.
- [ ] T100 **Human task.** On real Instagram, Facebook Page and Threads accounts (with the flags on), confirm the declared metrics are actually returned on a published post, and that a story's insights behave as `docs/research/meta.md` says inside and after its 24-hour window (SC-004, quickstart.md §11.5). If this window closes before it can run, mark it unachievable in `docs/research/meta.md` and state why.
- [ ] T101 [US3] **Human task.** Browser walk-through of the accounts page's reconnect flow end to end: click Reconnect, approve the extra permission, land back on the same account, confirm the "Insights need a reconnect" line disappears and numbers begin appearing on the next tick (quickstart.md §11.6).

Until T096–T101 run, all three readers remain reported as **"verified with mocks only"** (constitution II, FR-037, SC-011).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Phase 1 (config knobs) — **blocks every user story**
- **US1 (Phase 3)**: depends on Phase 2 only — proves the safety property over the grant-and-eligibility machinery
- **US2 (Phase 4)**: depends on Phase 2 (the write boundary and reconnect-preservation tests already scaffolded there); wires each remaining OAuth provider
- **US3 (Phase 5)**: depends on Phase 2 (eligibility, panel states) and Phase 1 (the opt-in flags); ships the first reader (Instagram)
- **US4 (Phase 6)**: depends on Phase 2 (contract, registry) and reuses US3's panel wiring; ships Facebook and Threads
- **US5 (Phase 7)**: depends on Phase 2 (T011/T012's `postPollDecision`, T030's born-frozen insert) and US3's Instagram module for the end-to-end test (`mock` alone suffices for the pure parts)
- **US6 (Phase 8)**: depends on Phase 2 (T014's parser) and US3/US4's readers to attach the ceiling check to
- **US7 (Phase 9)**: depends on Phase 2 (T030/T031) and US4/US5's freeze arms existing to count
- **Polish (Phase 10)**: depends on all of Phases 2–9
- **Human tasks (Phase 11)**: depends on nothing in this list completing first; nothing in Phases 1–10 depends on it

### Within Phase 2

T005 → T006. T007 → T008. T009 → T010. T011 → T012. T013 → T014. T015 (depends on T008, T010, T012) → T016 → T017. T018 (depends on T015) → T019. T020 (depends on T008) and T021 → T022 → T023, T024. T025, T026 (depend on T008, T015) → T027, T028, T029. T030 (depends on T008, T012, T020) → T031 → T032, T033. T034 (depends on T010) → T035. T036 (depends on T010, T015) → T037 → T038.

### Parallel opportunities

- Phase 1: T001, T002 in parallel; then T003, T004
- Phase 2: the research chain (T005→T006), the pure-library chains (T007→T008, T009→T010, T011→T012, T013→T014), the schema chain (T020/T021→T022→T023/T024) and the mock-fixture chain (T018→T019, after T015) can proceed in parallel once their own prerequisites are met; the contract (T015) gates the write-boundary and eligibility chains
- Phase 3: T039, T041, T042, T043, T044 in parallel once their dependencies are met; T045 last
- Phase 4: T046/T047, T048/T049, T050, T051, T052/T053 in parallel per provider; T054, T055 after all land
- Phase 5: T056/T057 and T058/T059 in parallel; T060/T061→T062 in sequence; T063, T064 after
- Phase 6: T065/T066→T067 and T068/T069→T070 in parallel; T071, T072 after
- Phase 7: T073 standalone; T074→T075; T076 standalone
- Phase 8: T077→T078; T079, T080 in parallel after; T081 after both
- Phase 9: T082→T083→T084 in sequence; T085, T086 in parallel after
- Phase 10: T087–T094 are nearly all [P] — independent doc edits; T095 last
- Phase 11: T096–T101 can run in any order once a tester has the relevant consent screen available

---

## Parallel Example: Phase 2 foundational work

```bash
# Launch independent foundational tracks together once Phase 1 is green:
Task: "docs/research/meta.md transcription"                               # T005
Task: "src/lib/granted-scopes.ts + test"                                   # T007, T008
Task: "src/lib/insights/eligibility.ts + test"                             # T009, T010
Task: "src/lib/insights/schedule.ts: postPollDecision + test"              # T011, T012
Task: "src/providers/meta/usage.ts: parseUsageHeader + test"               # T013, T014
Task: "src/server/db/schema/accounts.ts + insights.ts"                     # T020, T021

# Each then continues its own chain:
Task: "providers/types.ts: G31–G34 (after T008, T010, T012)"               # T015
Task: "providers/registry.ts: five new assertions (after T015)"           # T016, T017
Task: "pnpm db:generate migration (after T020, T021)"                      # T022
Task: "dal/insights-claims.ts: InsightsProviderRule + predicate"          # T030, after T008, T012, T020
```

---

## Implementation Strategy

### MVP first

1. Phase 1 (Setup) → Phase 2 (Foundational) — blocking, must be green
2. Phase 3 (US1, the safety property) → **stop and validate independently** (quickstart.md §2) — proves an existing install is untouched

### Incremental delivery after the MVP

3. Phase 4 (US2, the grant is recorded) → **stop and validate independently** (quickstart.md §3, §4)
4. Phase 5 (US3, opt in and see Instagram numbers) → **stop and validate independently** (quickstart.md §5, §6, §7) — the headline journey
5. Phase 6 (US4, Facebook and Threads, never summed) → **stop and validate independently** (quickstart.md §7)
6. Phase 7 (US5, stories) → **stop and validate independently** (quickstart.md §8)
7. Phase 8 (US6, Meta's own budget) → **stop and validate independently** (quickstart.md §9)
8. Phase 9 (US7, visibility) → **stop and validate independently** (quickstart.md §10)
9. Phase 10 (Polish) — docs, constitution amendment, final whole-suite pass
10. Phase 11 (human tasks) — runs whenever live consent screens and real accounts are available; resolves R1–R4 and the "verified with mocks only" caveat

### Notes

- [P] tasks touch different files with no unmet dependency
- Every test task is written and confirmed failing before its matching implementation task
- Commit after each task or logical group
- Research (T005) gates every reader (US3 onward) but gates nothing in Phase 2's grant/eligibility machinery or in US1/US2 — the plan's own stated exception
- The human tasks (Phase 11) are deliberately last despite US3 being P1 in spec priority — every mocked-HTTP behaviour above them is independently provable, and a judgement task needing a live consent screen starves the implement loop if placed earlier
