# Review: Empty states that name the next step, and role awareness

This review covers 62 files against base `4d7218f` (`git merge-base HEAD origin/main`). Nine of them are spec artifacts
in 2 commits (`bf435b0` spec, `d87a847` plan). The other 53 are the implementation, and **none of it is committed**:
37 modified tracked files and 16 new files exist only in the working tree (see F4). So this reviews the working tree
against the base (`git diff 4d7218f` plus the untracked files), not `base...HEAD`. `HEAD` alone holds only spec and
plan.

**Read in full:**

- the new modules `src/lib/roles/{names,slots,calendar,prerequisites}.ts`;
- the new and changed services: `src/server/services/generation/readiness.ts`, `src/app/p/[projectSlug]/generate/prerequisites.ts`, the `members.ts`, `slots.ts`, `posts/list.ts`, `posts/index.ts` and `overview.ts` diffs, `src/server/llm/index.ts` and `src/lib/overview/derive.ts`;
- the banners `SchedulerHealth.tsx` and `ReauthBanner.tsx`, and `layout.tsx`;
- every route diff: accounts, calendar, compose (`page`, `[postId]/page`, `Composer.tsx`, `composer-logic.ts`), posts, failures, review, generate, jobs, `jobs/new`, `jobs/new/csv`, media and voice;
- every test diff and new test: `tests/integration/roles/*`, `tests/helpers/role-copy.ts`, `src/lib/roles/*.test.ts`, and `Composer.test.ts`, `generate.test.tsx`, `review.test.tsx`, `voice.test.tsx`, `accounts-ui.test.ts`, `failures/ui.test.tsx`, `jobs/ui.test.tsx`, `scheduler-health.test.ts`, `ReauthBanner.test.ts`, `llm/index.test.ts`;
- the `docs/design-system.md` and `docs/decisions.md` diffs;
- the spec, plan, data-model, the three contracts, tasks and the constitution.

**Sampled for context:**

- `Checklist.tsx`, `ConnectGroupSection.tsx`, `jobs/new/form-data.ts` and `jobs/create.ts` (`previewJob`);
- `voice.ts`, `dal/voice.ts`, `media.ts` (`listMedia`), `src/lib/docs.ts` and `tests/helpers/jobs-env.ts`.

**Not reviewed:** `research.md` and `quickstart.md` in detail (only grepped for R12 and the decisions list), and the
spec checklist.

**Ran, targeted only** (per the constitution's review rule):

- 26 feature test files, 284 tests: pass.
- 23 more files that import the touched pages: failures, overview nav, secret-scan, tiktok unaudited UI, ui-limit-literals, published-docs, calendar. 162 tests: pass.
- Two throwaway probes in `$TMPDIR`, since removed:
  - every editor and admin route in a project with owner "Robin" and admin "Sam";
  - both Compose pages with an account whose only slot is paused.

## Verdict

The product behaviour holds up. Every product requirement (FR-001 to FR-075) is met in the code, and the pieces fit:

- one names module, adopted by the overview (`managersOf`, re-exported `joinNames`);
- one slot rule (`hasActiveSlot`), shared by the overview, Calendar and Compose;
- one readiness service that drops setting names for non-owners;
- one prerequisite builder, used by Generate, Jobs and both New job pages.

The probes confirmed the P1 stories at page level. Editors are told "Ask Robin or Sam…" or "Waiting on Robin and
Sam", admins get "Waiting on Robin" for AI, and a paused-only account reaches the composer as `hasActiveSlot: false`.
I found no correctness, authz or secret-leak defect in the new code.

What does not hold up is the evidence:

- The P1 editor sweep only checks that things are absent (F1).
- The Compose page wiring for US3 has no test, although T021 is ticked (F2).
- FR-082's prerequisite tests are half there (F3).
- None of the work is committed, so a PR from this branch would ship nothing (F4).

All four are cheap to fix and need no product code change. Fix them, then re-review only those. The MINOR items can
wait for the hardening entry.

## Findings

- [ ] MAJOR F1 — The editor sweep never checks that the managers are named, and no page-level test checks the names on Compose, Generate, Jobs, New job (media) or New job (CSV)
      where:  tests/integration/roles/routes.test.tsx:83-91, tests/integration/accounts-ui.test.ts:207, tests/integration/jobs/ui.test.tsx:192, src/app/p/[projectSlug]/generate/generate.test.tsx:80-93, src/app/p/[projectSlug]/compose/Composer.tsx:96, src/lib/roles/names.ts:7
      why:    Each "ask" site has a fallback: "an owner or admin" (`names.ts:7`, `Composer.tsx:96`) or "an owner" (`names.ts:37`). Those fallbacks pass `expectNoPrivilegedText`. The sweep, the US1 "Independent Test", asserts only what's absent, and its describe title "managers named" isn't backed by any assertion. The regexes in `accounts-ui.test.ts:207` and `jobs/ui.test.tsx:192` (`/Ask .+ to …/`) also accept the fallback. So if `compose/page.tsx:31` stopped passing `managersToAsk`, or `generate/prerequisites.ts:24` passed `managers: []`, editors would read "Ask an owner or admin…" or "Waiting on an owner or admin", and every test would stay green. The spec asks for the names: US1's test says "check for the names 'Robin' and 'Sam'", and FR-080 asks for "the named owners and admins (editor)". Today the pages do render the names (probe), so this is a missing guard, not broken behaviour. The `PENDING` scaffolding (`routes.test.tsx:38-42, 85, 95`) is now dead, and it points to a T045 that doesn't exist.
      owed:   In `routes.test.tsx`, assert each route's exact "ask" copy for the editor with "Robin" and "Sam": Accounts, Calendar, Compose, Voice and Media from US1 AS1–AS4 and US6 AS2; the "Waiting on Robin" and "Waiting on Robin and Sam" statuses on Generate, Jobs and both New job pages (US2 AS3). Add one admin case: the AI item reads "Waiting on Robin", with no setting name. Change the two regexes to the literal names, and delete `PENDING`.
      traces: FR-080, FR-070, SC-007, US1 (AS1–AS4), US2 AS2–AS3

- [ ] MAJOR F2 — The Compose pages' slot wiring has no test. T021 is ticked, but its scenario-5 test (paused-only account → `hasActiveSlot: false`) does not exist for `compose/page.tsx` or `compose/[postId]/page.tsx`
      where:  src/app/p/[projectSlug]/compose/page.tsx:26-31, src/app/p/[projectSlug]/compose/page.tsx:43, src/app/p/[projectSlug]/compose/[postId]/page.tsx:31-36, src/app/p/[projectSlug]/compose/[postId]/page.tsx:54, specs/028-empty-states-roles/tasks.md:91
      why:    `Composer.test.ts:290-313` hands the component `hasActiveSlot` directly. The page code that builds the flag runs in no test: `counts ? (slotById.get(id) ?? false) : null`, plus the failed-read rule `.catch(() => null)` that the spec's edge case requires ("A failed read never disables the action"). Nothing would catch a regression such as a missing entry becoming `null` (the hint vanishes) or the `.catch` being dropped (a slot-read error 500s the composer). The edit page (FR-026) isn't rendered in any test. A probe of both pages with a paused-only mock account showed correct props for owner and editor: `[false]`, `canManageSlots` true and false, and the editor's `managersToAsk` set to the managers' names.
      owed:   Add a page-level test for both pages. Read the `Composer` element's props, or render with a `check`. Cover a paused-only account (`false`), an account with an active slot (`true`), a `listSlotCounts` failure (`null`, Add to queue not disabled), and an editor's `managersToAsk` naming the managers.
      traces: FR-020, FR-026, FR-080, US3 AS5, T021

- [ ] MAJOR F3 — FR-082 is half covered. Jobs never gets an all-three-missing case, and no page test checks a partial set as "Done" and "To do" on Generate, Jobs or either New job page
      where:  tests/integration/jobs/ui.test.tsx:71-78, tests/integration/jobs/ui.test.tsx:93-102, tests/helpers/jobs-env.ts:36-38, src/app/p/[projectSlug]/generate/generate.test.tsx:95-108, tests/integration/roles/routes.test.tsx:104-127
      why:    `jobsEnv` seeds a voice profile and an account (`jobs-env.ts:36-38`), so the Jobs cases toggle only the LLM, and they assert only "Before you can generate". The Generate "partial" case checks that "Connect an account" is still listed and that there's no form, but never checks "Done". Neither New job page has a partial case. Done and To do are only checked by the unit test (`src/lib/roles/prerequisites.test.ts:50-55`). Two page rules are untested as a result: FR-044, that the Jobs header actions hide when only the account or the voice profile is missing (`jobs/page.tsx:45-57`), and US2 AS4 (AI and account Done, voice To do).
      owed:   For each of Generate, Jobs, New job (media) and New job (CSV), add one case with all three missing that asserts the three titles and their statuses, and one partial case (LLM set, account present, no voice) that asserts "Done" twice and "To do" once. In the Jobs partial case, also assert that "New job from CSV" isn't in the header.
      traces: FR-082, FR-044, FR-046, US2 AS4, SC-003

- [ ] MAJOR F4 — None of the implementation is committed. `HEAD` is still the plan commit, so the branch holds only the spec and plan
      where:  `git log` HEAD d87a847 (docs(plan)); `git status` shows 37 modified tracked files and 16 untracked files, including src/lib/roles/, src/server/services/generation/readiness.ts, src/app/p/[projectSlug]/generate/prerequisites.ts, tests/helpers/role-copy.ts, tests/integration/roles/ and specs/028-empty-states-roles/tasks.md; .specify/memory/constitution.md:84-89; .specify/extensions/git/git-config.yml:68-70
      why:    The constitution says to commit after each completed task, as Conventional Commits with explicit paths (`constitution.md:84-89`). The plan names the commit types (`plan.md:244-247`). Automatic commit after implement is off (`git-config.yml:68-70`), so nothing will commit this later. As it stands, a PR from this branch contains none of the feature, CI never runs its tests, and the only copy of the work is a worktree other sessions can touch. Entry 027 committed its implementation (`3cd51ad feat(overview)`, `4e71605 test(overview)`).
      owed:   Commit the work in small explicit-path commits, each with the trailer. Use `refactor(roles)` for moving `joinNames`, `managersOf` and the slot counts into shared modules, `feat(empty-states)` for the routes and banners, then `test(…)` and `docs(…)`. Don't use `git add -A` or `git add .`.
      traces: Constitution, Development Workflow (Commits)

- [ ] MINOR F5 — The scheduler banner's "by role" tests pass the same `{ kind: "ask" }` value for "admin" and "editor", so the code that maps each role to a banner is never tested
      where:  tests/integration/scheduler-health.test.ts:121-135, src/app/p/[projectSlug]/layout.tsx:50
      why:    The spec's decision that admins see no commands (FR-061) lives only in the ternary at `layout.tsx:50`. If it changed to `canManage`, admins would get the docker and `TICK_SECRET` remedies, and no test would fail. T015 allowed skipping a layout case, and both rendered variants are tested, so this is safe to ship.
      owed:   Render the layout per role, or extract and test a `schedulerViewerFor(scope)`. Owners get the remedies; admins and editors get the "ask" copy naming the owners.
      traces: FR-083, FR-061

- [ ] MINOR F6 — The owner's "How to fix this" docs link opens in the same tab. The contract says `target="_blank" rel="noreferrer"`, matching the other setup-guide links
      where:  src/components/shell/SchedulerHealth.tsx:100-105, src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:80
      why:    Clicking it navigates away from the app. `contracts/components.md` ("The docs link is an `<a target="_blank" rel="noreferrer">`") isn't followed.
      owed:   Add `target="_blank" rel="noreferrer"`.
      traces: FR-060

- [ ] MINOR F7 — The rule for "generation is ready" is written twice: `loadPrerequisites` derives it again, separately from `generationPrerequisites`, to skip the managers read
      where:  src/app/p/[projectSlug]/generate/prerequisites.ts:14, src/lib/roles/prerequisites.ts:22, src/lib/roles/prerequisites.ts:42, src/lib/roles/prerequisites.ts:58, src/lib/roles/prerequisites.ts:82
      why:    Suppose a later change tightens an item's done rule in `generationPrerequisites`, for example counting only accounts from a registered provider. The shortcut at `prerequisites.ts:14` would still return `null`, and four routes would show the form where the list would have shown a To do.
      owed:   Export one `isGenerationReady(readiness, images)` and use it in both places. Or call `generationPrerequisites` with managers read lazily.
      traces: Constitution IV, FR-040

- [ ] MINOR F8 — Pages read data again that the new services have just read, although the plan says readiness "reuses the reads those pages already make"
      where:  src/app/p/[projectSlug]/generate/page.tsx:48, src/app/p/[projectSlug]/generate/page.tsx:59-60, src/server/services/generation/readiness.ts:16, src/server/services/slots.ts:54, src/server/services/overview.ts:37, src/server/services/overview.ts:49, src/app/p/[projectSlug]/compose/page.tsx:25-26, src/app/p/[projectSlug]/compose/[postId]/page.tsx:30-31, src/app/p/[projectSlug]/accounts/page.tsx:77
      why:    Generate reads accounts and voice profiles twice. `listSlotCounts` re-runs `listAccounts` on pages that just ran it. Accounts reads the managers on every load, even for an owner who has accounts. That's one or two extra queries per request on small projects. It's a deviation from plan.md's "Performance Goals", not a bug.
      owed:   Let `listSlotCounts` and `getGenerationReadiness` accept rows the page has already loaded. On Accounts, read the managers only when the editor empty state or the admin fallback renders.
      traces: plan.md Performance Goals

- [ ] MINOR F9 — The docs part of FR-090 and FR-091 is incomplete. The docket-ui skill line is missing (T033, blocked by the sandbox). The 028 decisions entry doesn't record the mixed-accounts note, and doesn't say which tests' pinned copy changed: it says only "as in R12", which points into `specs/`
      where:  docs/decisions.md:1296-1321, .claude/skills/docket-ui/SKILL.md ("States"), specs/028-empty-states-roles/tasks.md:143
      why:    FR-091 lists "the mixed-accounts note" and "which tests' pinned copy was updated" as decisions to record in `docs/decisions.md`. FR-090 requires the skill line. The open item at `decisions.md:1319-1321` records the skill gap honestly.
      owed:   A human adds the skill line: the pipeline can't write under `.claude/skills`. In `decisions.md`, add a line for FR-023's mixed-accounts note, and list the updated tests: scheduler-health, `failures/ui`, `review.test`, `generate.test`, `voice.test`, `ReauthBanner.test`, `accounts-ui`, `jobs/ui`.
      traces: FR-090, FR-091

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements: product (FR-001–FR-075) | 45 | 45 | 0 | 0 | 0 |
| Functional requirements: tests (FR-080–FR-084) | 5 | 2 | 3 | 0 | 0 |
| Functional requirements: docs (FR-090, FR-091) | 2 | 0 | 2 | 0 | 0 |
| Acceptance scenarios (US1–US6) | 34 | 34 | 0 | 0 | 0 |
| Success criteria | 8 | 6 | 1 | 0 | 0 |
| Constitution principles and workflow rules | 10 | 8 | 1 | 1 | 0 |

**Functional requirements:**

- FR-081 and FR-084 are satisfied. FR-080, FR-082 and FR-083 are partial (F1–F3, F5). FR-090 and FR-091 are partial (F9).

**Acceptance scenarios:**

- These were judged by reading the code. Where tests don't cover them, the two probes did: US1 AS1–AS4, US2 AS2–AS3 and US3 AS5.

**Success criteria:**

- SC-001 to SC-006 are satisfied.
- SC-007 is partial (F1–F3).
- SC-008, no sideways scroll at 390 px, is **unverified** and not counted above. No browser was available, and the structural test at `tests/integration/roles/routes.test.tsx:131-139` checks only that the New job page contains `flex-wrap`.

**Constitution:**

- Satisfied: I, II, III, IV (with MINOR F7), V, VI, VII, and the accessibility and server-component constraint.
- Partial: the docs workflow rule (F9).
- Absent: the commits workflow rule (F4).

**The constitution's first-review sweep:**

- **Concurrency, locking and idempotency:** not applicable. The feature adds no writes, locks or server actions. Every new service is read-only.
- **Authz and project scoping:** every new read goes through scoped services: `members.list` with `member:view`, `listSlots`, `listAccounts`, `listVoiceProfiles`, `scope.posts.counts`. Role checks are `scope.can` or `scope.membership.role`. No permission changed. No new file imports the DB client.
- **Time zones:** Calendar's "Today" link uses the project-zone `calendar.today`. The banner's `When` still gets the project time zone.
- **Error paths:** Compose's slot read falls back to `null`. Failures' post count falls back to "posts exist". The Calendar and layout reads aren't caught, which is the same failure surface as the reads beside them.
- **Secrets:** setting names reach owners only, and are dropped in the service (`readiness.ts:20`). No values are read. No email leaves `managersOf` (`services.test.ts:18-24` and the probe).
- **FRs and SCs:** each one was checked individually; see the tables above.

## What I could not check

- **The quickstart's real-browser walk-through (T036):**
  - focus rings on the empty-state actions;
  - opening and closing "Not set up on this server" from the keyboard;
  - `scrollWidth <= 390` on Accounts (expanded), Calendar, Compose, Generate, Jobs and Media (SC-008).

  It needs chrome-devtools. Per the user's memory, the owner runs these walk-throughs themselves.
- **The Compose slot hint in a live browser:** whether it appears after the composer's automatic check returns, before any click. Static render shows "Checking…" first, so only the component test with a seeded `check` proves the hint's markup.
- **Real platform OAuth configuration:** the configured and unconfigured connect groups were exercised only through the test environment's `META_APP_*` stubs.
- **Live docs anchors:** `9-is-the-scheduler-running` and `configuring-a-provider` exist in `docs/deployment.md:237` and `docs/generator.md:5`, and `published-docs.test.ts` passes. The published GitHub Pages site was not fetched.
- **The full lint, typecheck, test and build runs:** these were not re-run, per the constitution's review rule. The implement pass reported lint at 0 errors and 20 warnings, typecheck and build passing, and one failure in the full suite: `tests/integration/media/video-publish-adapted.test.ts`, which passes alone and which this feature doesn't touch. CI hasn't run, because nothing is committed (F4).
- **The docket-ui skill edit (T033):** the sandbox can't write `.claude/skills`, so a human has to make it.
