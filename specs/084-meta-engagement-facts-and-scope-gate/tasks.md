---

description: "Task list template for feature implementation"
---

# Tasks: Confirm the Meta comment facts, and gate the inbox on the permission they need

**Input**: Design documents from `/specs/084-meta-engagement-facts-and-scope-gate/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [quickstart.md](./quickstart.md), and the four files in
[contracts/](./contracts/)

**Tests**: Included. The spec requires offline proof for every FR (SC-009), so test tasks are part of
each story's phase, not optional.

**Organization**: Tasks are grouped by user story (US1–US6, in spec priority order, reordered only
where a real dependency forces it — noted per phase). The spec's own "Task ordering note" governs the
end of this list: the three live acts, plus one conditional live act, are parked after everything else.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unresolved dependency on an earlier incomplete task)
- **[Story]**: US1–US6, from spec.md
- File paths are exact; `src/providers/meta` also covers Facebook Page + Instagram through the shared
  `meta` connect group (spec Assumptions)

---

## Phase 1: Setup

**Purpose**: Confirm the worktree can run the targeted test files this plan relies on. No new
dependency, no migration, no new project structure (plan.md Technical Context).

- [X] T001 Confirm the worktree environment: `pnpm install` inside this worktree (a worktree has no
      `node_modules` of its own), `docker compose up -d postgres` (integration tests need port 5555,
      not the 5432 in `.env.example`), `pnpm db:migrate` < /dev/null

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one shared pure decision and the one shared SQL predicate that US2, US3, US4 and US5
all build on (research.md §2–§3; constitution IV). Moving these first, with zero behaviour change, is
what makes "byte for byte" a thing later tasks can verify rather than assert.

**⚠️ CRITICAL**: No user-story work in Phase 3+ except US1 (pure documentation, no code) can begin
until this phase is complete.

- [X] T002 Create `src/lib/scope-permission.ts` exporting `scopePermissionFor` and `ScopePermission`,
      with the body moved **verbatim** from `src/lib/insights/eligibility.ts`'s
      `insightsPermissionFor`/`InsightsPermission` (branch order unchanged — see
      [contracts/scope-permission.md](./contracts/scope-permission.md) §2). Turn
      `src/lib/insights/eligibility.ts` into a two-line alias module:
      `export { scopePermissionFor as insightsPermissionFor, type ScopePermission as InsightsPermission }`
- [X] T003 Move `src/lib/insights/eligibility.test.ts` to `src/lib/scope-permission.test.ts`, re-point
      the import to `./scope-permission`, and keep every assertion verbatim (contracts/scope-permission.md §1)
- [X] T004 [P] Create `src/server/dal/scope-predicates.ts` exporting `accountHoldsScopes(scopes)` and
      `accountMissingScopes(scopes)` (NULL-handling per [data-model.md](./data-model.md) §5), extracted
      from `eligible()` and `countAccountsMissingInsightsScopes` in
      `src/server/dal/insights-claims.ts`. Update both to call the new functions instead of inlining the
      SQL, with no change in the queries they produce
- [X] T005 [P] Add `export type ScopeSurface = "insights" | "engagement"` to `src/providers/types.ts`
      and add a `surface: ScopeSurface` second parameter to `OAuthConnectGroup.optionalScopes.cannotWiden`.
      Update the one call site, `src/server/services/accounts.ts:70`, to pass `"insights"`. Update
      `src/providers/meta/connect-group.ts`'s `cannotWiden` implementation to accept the new parameter
      and, for `surface === "engagement"`, return `null` for now (US5 fills in the real answer) — every
      existing `cannotWiden(source)` caller and answer for `"insights"` must be unchanged
      (contracts/optional-scopes-per-surface.md §1)

**Checkpoint**: `pnpm vitest run src/lib/scope-permission.test.ts tests/integration/insights` must pass
unedited in behaviour (two expected file changes only: the moved test and its import) before any story
below starts.

---

## Phase 3: User Story 1 - The facts are settled, or honestly recorded as unsettled (Priority: P1)

**Goal**: Replace `docs/research/engagement.md` §2 with a 9×4 grid (sourced answers or `unverified`,
each with an evidence grade) and rewrite the "Phase 9 human task" note.

**Independent Test**: Read §2 with no code running; confirm four surfaces, nine questions, a source URL
+ check date + evidence grade on every answered cell, "what was tried" on every `unverified` cell, and
Threads replies/mentions answered separately (quickstart.md §1).

This phase runs with no code dependency on Phase 2 and may proceed in parallel with it — it touches only
`docs/`. It must finish before US5's connect-group tasks, which are its only downstream consumer
(spec Constraint 2).

- [X] T006 [US1] Research the four comment surfaces — Facebook Page comments, Instagram comments,
      Threads replies, Threads mentions — against the nine questions in
      [contracts/research-section-2.md](./contracts/research-section-2.md) §1, using `WebSearch`
      constrained to official Meta/Threads documentation domains. Record each result as `page` or
      `search-summary` per the admissibility rule in §3, or `unverified` with what was tried
- [X] T007 [US1] Replace `docs/research/engagement.md` §2 (the old 7×3 grid) with the new 9×4 grid from
      T006, each surface closing with its own consequence paragraph (buildable, or
      must-ship-`unavailable` and why — contracts/research-section-2.md §4). The old table is removed,
      not left alongside the new one
- [X] T008 [US1] Rewrite the "Phase 9 human task" note at the end of `docs/research/engagement.md`,
      distinguishing which questions this pass settled (and at which evidence grade) from which
      genuinely still need a live session, a second person and a browser — without deleting the record
      that T083/T084 are unachievable by a headless pipeline
- [X] T009 [P] [US1] Add a one-line cross-reference in `docs/research/meta.md` pointing to
      `docs/research/engagement.md` §2 as where comment-read facts live; update its `Checked` date only
      if the file is otherwise touched

**Checkpoint**: §2 is readable and complete per quickstart.md §1's checklist; the connect-group tasks in
US5 may now consume its confirmed scope strings (or its empty state, if nothing was confirmed).

---

## Phase 4: User Story 3 - A declared surface can exist without being callable (Priority: P1)

**Goal**: A provider can declare `readScopes` on its `engagement` member; an account missing them is
never claimed, leased, decrypted or called; one that holds them is read normally. Proven through `mock`.

**Independent Test**: Script a `mock` account with a matching grant and another with a missing/`NULL`
grant, run the engagement-read section, and assert from the claim's own records that only the permitted
account was claimed and no call was attempted for the other (quickstart.md §3).

Depends on Phase 2 (T002–T005). Does not depend on US1 — the gate is proven entirely through `mock`
and test-registered providers, with no real scope string (spec Constraint 9).

- [X] T010 [US3] Add `readScopes?: readonly string[]` and `missingReadScopes?: { reason: string;
      docsPath?: string }` to `EngagementDeclaration` in `src/providers/types.ts`
      (contracts/engagement-read-scopes.md §1)
- [X] T011 [US3] Add `assertEngagementDeclaration` to `src/providers/registry.ts`, run over every
      provider at module load: `reads` non-empty; `unavailable.reason` 1–300 chars when set;
      `unavailable` and non-empty `readScopes` never both set (naming both fields); non-empty
      `readScopes` requires `missingReadScopes.reason` 1–300 chars; every `readScopes` entry matches
      `GRANTED_SCOPE_PATTERN` from `src/lib/granted-scopes.ts` (contracts/engagement-read-scopes.md §2)
- [X] T012 [US3] Unit test `src/providers/registry.test.ts`: each of T011's five failure messages, and
      a valid declaration loading without error
- [X] T013 [US3] Add `EngagementProviderRule { providerKey: string; readScopes: readonly string[] }` and
      change `claimDueEngagementReads` in `src/server/dal/engagement-read-claims.ts` to take
      `providers: readonly EngagementProviderRule[]` instead of `providerKeys`, applying
      `accountHoldsScopes`/`accountMissingScopes` (T004) inside the one transaction at **both**: the
      lazy-insert left-join select before `INSERT … ON CONFLICT DO NOTHING`, and the due-rows select
      with `FOR UPDATE SKIP LOCKED` (contracts/engagement-read-scopes.md §4)
- [X] T014 [US3] Update `src/server/scheduler/engagement-read.ts` to build `EngagementProviderRule[]`
      from `listProviders()` (filtering providers with `declaration.unavailable`, mapping
      `readScopes ?? []`) and pass it to `claimDueEngagementReads` in place of the old key list
      (data-model.md §4)
- [X] T015 [P] [US3] Add `engagementReadScopes: z.array(z.string()).default([])` to
      `src/providers/mock/settings.ts` and `mockEngagementRuleFor(settings)` to
      `src/providers/mock/engagement.ts`, mirroring `mockInsightsRuleFor` (data-model.md §8). The
      default `mock` declaration itself gains no `readScopes`
- [X] T016 [US3] Extend `tests/integration/insights/eligibility-matrix.test.ts` to add the engagement
      claim as a third subject: walk declared scopes × grant state × requested scopes × `cannotWiden`
      and assert `scopePermissionFor(...).kind === "ok"` iff `claimDueEngagementReads` returns the
      account (FR-023, contracts/scope-permission.md §3)
- [X] T017 [US3] Integration test `tests/integration/engagement/scope-gate.test.ts` (new file), using
      `registerTestProvider` with a scripted `readScopes` + `missingReadScopes`: an account missing one
      declared scope is not returned by the claim, its `read_lease_until`/`read_lease_owner` stay
      `NULL`, `decryptCredentials` is called zero times and the provider's `read` is never invoked; a
      `NULL` grant is treated as not holding the scopes; no `engagement_account_states` row is created
      for the ineligible account; an account that later gains the grant is claimed and read from page
      one on the next run with no manual step
- [X] T018 [US3] Same file, T017: Bluesky and the default `mock` configuration are claimed, read and
      committed exactly as 077 specified (empty `readScopes` ⇒ matched by provider key alone); registry
      load fails when a test provider sets both `unavailable` and a non-empty `readScopes` (message
      names both fields), and when it sets a non-empty `readScopes` with no reason or a scope that fails
      `GRANTED_SCOPE_PATTERN`
- [X] T019 [US3] Same file, T017: an account that loses eligibility keeps every item it already has,
      readable and unchanged, and its status badge, publish limits and `needs_reauth` state are
      untouched (FR-024, FR-025)

**Checkpoint**: `pnpm vitest run tests/integration/engagement/scope-gate.test.ts
src/providers/registry.test.ts tests/integration/insights/eligibility-matrix.test.ts` passes with zero
platform calls and zero credentials.

---

## Phase 5: User Story 2 - An install that does nothing keeps working, exactly as before (Priority: P1)

**Goal**: With both new flags unset, nothing observable changes — this is the load-bearing promise the
rest of the entry is checked against.

**Independent Test**: With both flags unset, compare claimed accounts, inserted items, cursors, state
rows and authorization URLs against pre-change behaviour (quickstart.md §2).

Depends on Phases 2 and 4: there is nothing to compare against "pre-change" until the moves (Phase 2)
and the gate (Phase 4) exist.

- [ ] T020 [US2] Assert in `src/providers/meta/connect-group.test.ts` and
      `src/providers/threads/connect-group.test.ts` that both authorization URLs are byte-identical to
      their pre-change strings, parameter order included, with both engagement flags unset (FR-029)
- [ ] T021 [US2] Run `pnpm vitest run tests/integration/engagement src/lib/insights
      tests/integration/insights` and confirm 077's engagement suite passes with **no edits**, and
      081's insights suite passes with exactly the two expected edits from Phase 2 (T002, T003) and the
      one extension from T016 — and no others. A third edit means something generic broke
- [ ] T022 [US2] Integration test confirming that with both flags unset, the inbox page shows no new
      notice and the account filter offers exactly the accounts it offered before, and that a Bluesky
      account with `granted_scopes` `NULL` is claimed, read and committed as before (US2 scenarios 2, 5)

**Checkpoint**: An untouched install is byte-identical before and after this branch, demonstrated by
tests rather than asserted in prose.

---

## Phase 6: User Story 5 - An operator opts in, deliberately, in one place (Priority: P2)

**Goal**: `META_ENGAGEMENT_SCOPES` / `THREADS_ENGAGEMENT_SCOPES`, parsed and validated like their
insights twins, widen the dialog only with what §2 confirmed, and `cannotWiden` answers truthfully per
surface.

**Independent Test**: Parse each flag from a fixture environment across valid, invalid and absent
values; assert the requested scope list and the authorization URL for each combination of flag and
login configuration id, with no live dialog (quickstart.md §5).

Depends on Phase 3 (US1 — the scope strings, possibly empty, that T025/T026 declare) and Phase 2 (T005
— the `ScopeSurface` parameter).

- [ ] T023 [P] [US5] Add `META_ENGAGEMENT_SCOPES` parsing to `src/providers/meta/config.ts`:
      `MetaConfig.engagementScopes`, default `false`, `true`/`false` validated, anything else an env
      issue naming the variable with no value echoed — mirroring `META_INSIGHTS_SCOPES`
- [ ] T024 [P] [US5] Add `THREADS_ENGAGEMENT_SCOPES` parsing to `src/providers/threads/config.ts`,
      `ThreadsConfig.engagementScopes`, same shape as T023
- [ ] T025 [US5] In `src/providers/meta/connect-group.ts`, add `ENGAGEMENT_SCOPES_DECLARED` (each entry
      `{ scope, purpose }`, filled from §2 and nowhere else — empty if §2 confirmed nothing) and union it
      into `optionalFor(cfg)` in `src/providers/meta/oauth.ts` when `cfg.engagementScopes` is set
      (contracts/optional-scopes-per-surface.md §2–§3)
- [ ] T026 [P] [US5] Same in `src/providers/threads/connect-group.ts`: declare the Threads
      engagement scope(s) from §2 (or none) and add them to `requested(source)`/`authorizationUrl`'s
      scope list when `THREADS_ENGAGEMENT_SCOPES` is on
- [ ] T027 [US5] Implement `cannotWiden(source, "engagement")` in `src/providers/meta/connect-group.ts`
      per the table in [contracts/optional-scopes-per-surface.md](./contracts/optional-scopes-per-surface.md) §1:
      non-null only when `META_ENGAGEMENT_SCOPES` is on **and** `META_LOGIN_CONFIG_ID` is set **and**
      `ENGAGEMENT_SCOPES_DECLARED` is non-empty; `null` whenever §2 confirmed nothing, regardless of the
      flag (FR-031)
- [ ] T028 [US5] Add a `## Engagement` heading to `docs/meta-setup.md` beside the existing `## Insights`
      heading (the slug `docsUrl("meta-setup", "engagement")` resolves to), and a new
      `## 11b. Reading comments (optional)` section beside `## 11a`, without renumbering `## 11a` or
      `## 11`
- [ ] T029 [US5] Unit tests: `src/providers/meta/config.test.ts` + `src/providers/threads/config.test.ts`
      (flag parsing: `true`/`false`/absent/`maybe`, no value echoed); `src/providers/meta/connect-group.test.ts`
      + `.../threads/connect-group.test.ts` (requested union across all four flag combinations;
      `cannotWiden`'s full table including both surfaces; byte-identical URLs reconfirmed with flags on
      but `ENGAGEMENT_SCOPES_DECLARED` empty)
- [ ] T030 [US5] Extend `tests/integration/insights/eligibility-matrix.test.ts` (or a sibling test) to
      walk every combination of `META_ENGAGEMENT_SCOPES` × `META_INSIGHTS_SCOPES` × `META_LOGIN_CONFIG_ID`
      (and the Threads pair) and assert each account's insights permission for both surfaces is
      identical to its pre-change value (FR-033)

**Checkpoint**: An operator can opt in to engagement without moving any insights state, and without a
reconnect loop that cannot grant anything.

---

## Phase 7: User Story 4 - A member is told the truth about why an account is not in their inbox (Priority: P2)

**Goal**: The inbox and accounts page name an ineligible account, state the provider's own reason, and
offer a reconnect only where it can help.

**Independent Test**: Script a `mock` account into each state (grant held, grant missing, grant
unknown, dialog cannot be widened) and assert the inbox notice, the filter contents and the
accounts-page line and button for each (quickstart.md §4).

Depends on Phase 4 (US3 — the declaration and eligibility plumbing) and Phase 2 (T005).

- [ ] T031 [US4] Add `engagementPermissionForAccount(account, provider)` to
      `src/server/services/accounts.ts` (contracts/scope-permission.md §4) and
      `engagementReadPermission: ScopePermission | null` to `AccountRecord`
- [ ] T032 [US4] Add `readPermission: ScopePermission | null` to `EngagementAccountView` in
      `src/server/services/engagement/inbox.ts`, computed inside `listEngagementAccounts` from the
      account's `grantedScopes` and the provider's declaration
- [ ] T033 [P] [US4] In `src/app/p/[projectSlug]/inbox/page.tsx`, render a second notice block for
      accounts whose `readPermission` is set and `kind !== "ok"`, worded as something a reconnect may
      fix (distinguishable from the existing `unavailable` wording), able to appear alongside it for
      different accounts; exclude such accounts from the account filter alongside `unavailable` ones
      (FR-034, FR-035)
- [ ] T034 [P] [US4] In `src/app/p/[projectSlug]/accounts/page.tsx`, add an "Inbox needs a reconnect."
      line with the provider's reason and a docs link, showing `ReconnectGroupButton` only when
      `canManage && permission.canReconnect` — no control at all, reason only, when it cannot be
      widened (FR-030, FR-036, SC-008)
- [ ] T035 [US4] Integration tests in `tests/integration/engagement/scope-gate.test.ts` and
      `tests/integration/engagement/permissions.test.tsx`: both notices appear together for different
      accounts with distinguishable wording; the ineligible account is absent from the inbox filter; the
      accounts-page line and button appear/disappear correctly per `canReconnect`; a member without
      `engagement: ["view"]` sees no notice, reason, count or account name, and none is reachable
      through an API key, the public API or an MCP tool (FR-037)
- [ ] T036 [P] [US4] Extend `tests/integration/security/secret-scan.test.ts` to cover the new notice,
      reason and count, asserting none carries a credential or token (FR-039)

**Checkpoint**: A member can tell, from the page alone, which account is affected, why, and whether
reconnecting would help (SC-007).

---

## Phase 8: User Story 6 - An operator can see what the gate skipped (Priority: P3)

**Goal**: The engagement-read run's own counts gain `accountsSkippedNoPermission`, distinct from
`unavailable`, `failed` and `rateLimited`.

**Independent Test**: Run the section with a mix of eligible and ineligible accounts and assert the
recorded counts, including that an account missing two declared scopes is counted exactly once
(quickstart.md §6).

Depends on Phase 4 (US3 — `EngagementProviderRule` and the claim it feeds).

- [ ] T037 [P] [US6] Add `accountsSkippedNoPermission: number` to `EngagementReadCounts` in
      `src/server/scheduler/engagement-read.ts`
- [ ] T038 [P] [US6] Add `countAccountsMissingEngagementScopes(rules)` (beside
      `src/server/dal/engagement-read-claims.ts` or `scope-predicates.ts`), considering only rules with
      a non-empty `readScopes`, returning `0` with **no query issued** when there are none, using
      `accountMissingScopes` (T004) in an `OR` over per-provider arms, wrapped in
      `crossProject("scheduler: count engagement-ineligible accounts", …)` (data-model.md §6)
- [ ] T039 [US6] Wire T038 into `runEngagementRead` right after the claim, setting
      `accountsSkippedNoPermission` on the run's counts, mirroring where `runInsightsPoll` sets its own
      (`src/server/scheduler/insights-poll.ts:113`)
- [ ] T040 [US6] Integration test `tests/integration/engagement/scope-gate.test.ts -t "skipped"`:
      `accountsSkippedNoPermission` equals the number of accounts missing their declared scopes; an
      account missing two declared scopes is counted exactly once; the count is `0` with no extra query
      when no provider declares read scopes; it is distinct from `unavailable`, `failed` and
      `rateLimited` in the same run's counts

**Checkpoint**: A tick that claims fewer accounts because of the gate reports that fact, rather than
silently claiming less and still reporting success.

---

## Phase 9: Documentation and the repo (cross-cutting)

**Purpose**: The documentation FR-042 to FR-047 ask for, beyond what T007–T009 and T028 already cover.

- [ ] T041 [P] Update `docs/engagement.md`'s supported-platforms table to state, per Meta surface, what
      the read will need per §2 (naming the permission where confirmed, saying plainly where it is not),
      continuing to state that nothing is read on any Meta surface yet; add the Meta/Threads entries to
      its "Platform permissions" section describing the opt-in flags, the login-configuration
      limitation, and that a missing permission never affects publishing (FR-042, FR-043)
- [ ] T042 [P] Finish documenting both flags in `docs/meta-setup.md` beside the existing insights opt-in
      (not replacing it): where to add the permission in the Meta and Threads dashboards, what the flag
      changes, that it affects only the next connect/reconnect, and the login-configuration caveat
      (FR-044)
- [ ] T043 [P] Document `META_ENGAGEMENT_SCOPES` and `THREADS_ENGAGEMENT_SCOPES` in `.env.example`: both
      commented and `false`, their effect, the login-configuration caveat, and a pointer to
      `docs/meta-setup.md`, in the same shape as the existing insights flags (FR-045)
- [ ] T044 [P] Update `docs/adding-a-provider.md` §20 to describe the new declaration fields and the
      claim-level guarantee; fix the mis-annotation of the engagement `unavailable` field as "(G55)" to
      note it is 077's FR-055 and never was a generic change; add **G40** to the "Generic hooks index"
      (today's last row is G39) naming both halves and the files they touch (FR-017, FR-046)
- [ ] T045 [P] Add a `docs/decisions.md` entry for G40: why the declaration and `cannotWiden` ship as one
      change, the generalisation of the pure decision and SQL predicate with aliases kept, the two env
      flags and their deployment-flag rationale, and how to reverse all of it (plan.md's three judgement
      calls; contracts/engagement-read-scopes.md §6)
- [ ] T046 Run the full suite once: `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm db:check`
      (confirms `drizzle/0047_salty_owl.sql` is still the newest file — no schema change), then
      `pnpm build` (two pages changed) < /dev/null

---

## Parked: the live acts (per the spec's "Task ordering note")

None of these is required for this entry to ship (FR-005). If the resources for one are unavailable,
mark it unachievable here with the reason, rather than leaving it silently open.

- [ ] T047 [P] **Needs a live Meta app, a real Facebook Page, a real Instagram Business account and a
      browser.** Approve the engagement comment permission on a live Meta consent screen and confirm the
      grant Meta reports back matches what T025 declared
- [ ] T048 [P] **Needs a live Threads account and a browser.** Same approval and confirmation on a live
      Threads consent screen, against what T026 declared
- [ ] T049 [P] **Needs a signed-in browser session.** Walk through the accounts page's
      inbox-needs-a-reconnect line and its reconnect control in both the can-widen and cannot-widen
      states (T034), confirming the rendered reason and button match the fixture-driven tests from T035
- [ ] T050 [P] **Conditional — only if any §2 cell from T006 is still `unverified`; needs a live session,
      a second person to comment, and a browser.** Attempt live confirmation of that answer (most likely
      candidate: whether a commenter's identifier is stable across two comments). Not required for this
      entry to ship (FR-005) — if the resources are unavailable, record that here rather than leaving it
      open

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. Blocks every phase below except Phase 3 (US1), which is
  pure documentation and touches no code Phase 2 changes.
- **US1 (Phase 3)**: no code dependency; may run in parallel with Phase 2. Blocks only US5's
  connect-group tasks (T025, T026 need its scope strings, possibly empty).
- **US3 (Phase 4)**: depends on Phase 2 (T002–T005). Does not depend on US1.
- **US2 (Phase 5)**: depends on Phase 2 and Phase 4 — there is nothing to compare "unchanged" against
  until the moves and the gate exist.
- **US5 (Phase 6)**: depends on Phase 2 (T005) and Phase 3 (US1's scope strings).
- **US4 (Phase 7)**: depends on Phase 2 (T005) and Phase 4 (US3's declaration/eligibility plumbing).
- **US6 (Phase 8)**: depends on Phase 4 (US3's `EngagementProviderRule` and claim).
- **Documentation (Phase 9)**: depends on whichever of T025–T027 (US5) and T010–T011 (US3) it describes;
  sequence it after those, before the final full-suite run.
- **Parked (final)**: depends on everything above; never blocks it.

### Within Each Story

- Declaration/type changes before registry assertions before claim changes before counts.
- Implementation before the tests that exercise it, except where a test is explicitly the acceptance
  check for a prior task (e.g., T016 pins T013/T014 against T002).
- Tests touching the same file (e.g., all of `scope-gate.test.ts`) are sequenced, not parallel, even when
  listed as separate tasks.

### Parallel Opportunities

- T004 and T005 (Phase 2) can run together once T001 is done.
- T009 (Phase 3) can run alongside T007/T008 (different file).
- T012, T015 (Phase 4) can run alongside the rest of their phase once their prerequisites land.
- T023/T024 and T025/T026 (Phase 6) are parallel pairs (Meta vs. Threads, different files).
- T033/T034 (Phase 7) are parallel once T031/T032 land (different files, no dependency on each other).
- T037/T038 (Phase 8) are parallel (different files).
- All of Phase 9 (T041–T045) is parallel (five different docs files).
- All four parked tasks (T047–T050) are independent of each other.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# After T001, T002+T003 (sequential pair) can run alongside:
Task: "Create src/server/dal/scope-predicates.ts (T004)"
Task: "Add ScopeSurface + cannotWiden surface parameter (T005)"
```

## Parallel Example: Phase 6 (US5)

```bash
Task: "Add META_ENGAGEMENT_SCOPES parsing in src/providers/meta/config.ts (T023)"
Task: "Add THREADS_ENGAGEMENT_SCOPES parsing in src/providers/threads/config.ts (T024)"
```

---

## Implementation Strategy

### MVP First

1. Phase 1 (Setup) + Phase 2 (Foundational).
2. Phase 3 (US1) — can run in parallel with Phase 2; unblocks US5 later.
3. Phase 4 (US3) — the structural half: a declared surface that is not callable until granted. This is
   the entry's P1 core.
4. **STOP and VALIDATE**: `pnpm vitest run tests/integration/engagement/scope-gate.test.ts` proves the
   gate end to end through `mock` alone (SC-009).

### Incremental Delivery

1. Setup + Foundational + US1 → facts settled, shared decision moved, nothing yet gated.
2. + US3 → the gate exists and is proven through `mock`.
3. + US2 → proven that an untouched install saw none of it.
4. + US5 → an operator can opt in, with real scope strings if §2 confirmed any.
5. + US4 → a member and an operator can see why an account is excluded.
6. + US6 → an operator can see how many accounts the gate skipped.
7. + Documentation (Phase 9) → the six files and the decisions-log entry.
8. Parked live acts, last, marked unachievable with a reason if resources are unavailable.

Each step leaves `main` mergeable: both flags default off, so every increment before US5 changes no
observable behaviour for any real install (FR-029).
