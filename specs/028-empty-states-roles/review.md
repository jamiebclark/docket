# Review: Empty states that name the next step, and role awareness (re-review after remediation)

This is the second review of entry 028. The constitution's review rule (`.specify/memory/constitution.md:125-128`)
limits it to two checks: each earlier finding is fixed, and the files the remediation changed introduced no
regression. Anything else is MINOR, for the hardening entry.

I reviewed `git diff 4d7218f...HEAD`, where `4d7218f` is `git merge-base HEAD origin/main`. That's 64 files across 7
commits. The work is now committed (`451380b`, `9bc825e`, `5fa6243`, `4f9f42b`, `21a3cb6`), so this time it's a real
`base...HEAD` diff, not the working tree the first review read.

**What the remediation changed.** I traced its tool calls in `.pipeline/implement.result.json`. The Phase 10 pass
edited only:

- `tests/integration/roles/routes.test.tsx`;
- `tests/integration/accounts-ui.test.ts`;
- `tests/integration/jobs/ui.test.tsx`;
- the new `tests/integration/roles/compose-pages.test.tsx`;
- `specs/028-empty-states-roles/tasks.md`.

It then committed everything. It changed no product file, so the first review's product judgements still apply
unchanged.

**Read in full:**

- every file the remediation changed;
- the code those tests exercise:
  - `src/app/p/[projectSlug]/compose/page.tsx` and `compose/[postId]/page.tsx`;
  - `src/lib/roles/prerequisites.ts` and `prerequisites.test.ts`, and `src/lib/roles/names.ts`;
  - `src/app/p/[projectSlug]/generate/prerequisites.ts` and `src/server/services/generation/readiness.ts`;
  - `tests/helpers/role-copy.ts` and `tests/helpers/posts-env.ts`;
- the diffs of `generate.test.tsx` and `review.test.tsx`;
- the file list of each commit, and `review.md` and `tasks.md`;
- spec, plan and constitution.

**Sampled:** `layout.tsx:40-63`, `SchedulerHealth.tsx:95-105`, `Checklist.tsx` (status text), and
`docs/decisions.md:1296-1321`. I sampled these only to confirm the status of the carried MINOR findings.

**Not re-read:** the other route pages and their unchanged tests. The remediation didn't touch them. The first review
read every one of them in full, and its verdict on FR-001 to FR-075 stands.

**Ran, targeted only** (per the constitution's review rule):

- `pnpm vitest run tests/integration/roles 'src/app/p/[projectSlug]/generate/generate.test.tsx' tests/integration/jobs/ui.test.tsx tests/integration/accounts-ui.test.ts 'src/app/p/[projectSlug]/compose' src/lib/roles`: 13 files, 133 tests, all pass.
- `npx commitlint --from origin/main --to HEAD`: no errors.
- `git show 9bc825e:…` for F10.

## Verdict

**Ready to merge.** All four earlier blocking findings are fixed, and the remediation introduced no regression:

- **F1 (managers not named):** the editor sweep now asserts the literal "Robin" and "Sam" copy.
- **F2 (Compose slot wiring untested):** both Compose pages have prop-level tests, including the failed-read case.
- **F3 (FR-082 half covered):** every setup page has an all-missing case and a partial case that count "Done" and "To do".
- **F4 (nothing committed):** the work is committed in explicit-path Conventional Commits that pass commitlint.

Nothing blocks. Open MINOR items:

- F5–F9 are carried from the first review. The remediation didn't touch them, and none was owed for the merge.
- F10 is new: the commit split leaves `9bc825e` red on its pinned-copy tests. The branch isn't pushed yet, so a
  squash before the PR fixes it cheaply.

## Findings

### Earlier blocking findings: status

| Finding | Status | Evidence |
|---|---|---|
| F1 (MAJOR): the editor sweep never checked that managers are named | **Fixed** | See F1 notes below. |
| F2 (MAJOR): the Compose pages' slot wiring had no test | **Fixed** | See F2 notes below. |
| F3 (MAJOR): FR-082 was half covered | **Fixed** | See F3 notes below. |
| F4 (MAJOR): none of the implementation was committed | **Fixed** | See F4 notes below. |

**F1 notes:**

- `tests/integration/roles/routes.test.tsx:43-56` asserts each route's exact copy, run as the editor at `:89-99`:
  - "No accounts yet. Ask Robin or Sam to connect one." (Accounts, Calendar);
  - "No accounts are connected yet. Ask Robin or Sam to connect one." (Compose);
  - "No voice profile yet. Ask Robin or Sam to create one." (Voice);
  - "Waiting on Robin" and "Waiting on Robin and Sam" (Generate, Jobs, both New job pages).
- The admin case is at `:101-109`.
- The loose regexes are now literal names: `tests/integration/accounts-ui.test.ts:207` and
  `tests/integration/jobs/ui.test.tsx:192` (``Ask ${e.owner.name} to set it up.``, which covers Media for US6 AS2).
- The `PENDING` scaffolding is gone.
- A dropped `managersToAsk` (Compose) or `managers: []` (Generate) would now fail.
- The owners-only rule for the AI item is pinned in `src/lib/roles/prerequisites.test.ts:32,40`.

**F2 notes:**

- `tests/integration/roles/compose-pages.test.tsx:59-97` reads the props each page hands to `Composer`. It covers both
  `compose/page.tsx` and `compose/[postId]/page.tsx`.
- Paused-only → `false` (`:61-68`). Active slot → `true` (`:70-75`).
- `listSlotCounts` rejecting → `null` (`:77-83`), via the module mock at `:9-17`.
- Editor `managersToAsk` = "{owner} or {admin}", and `canManageSlots` false; the owner gets `undefined` (`:85-95`).

**F3 notes:**

- `routes.test.tsx:145-189` covers Generate, Jobs, New job (media) and New job (CSV).
- All three missing: three titles, `>To do<` ×3 (+1 for the media images item), `>Done<` ×0.
- Partial (AI and account set, no voice): `>Done<` ×2, `>To do<` ×1 (+1).
- Jobs' partial case asserts no "New job from CSV" (`:176`), and a separate case covers voice and account present
  with no AI (`:180-188`). Together they cover FR-044.

**F4 notes:**

- Five commits: `451380b refactor(roles)`, `9bc825e feat(empty-states)`, `5fa6243 test(empty-states)`, `4f9f42b docs`
  and `21a3cb6 docs`, each with the trailer.
- `git status` is clean, and commitlint passes.
- The trailer names Sonnet, which matches the implement-phase commits already on `main` (e.g. `3cd51ad`).
- The commit split itself is F10.

### Open items (non-blocking)

- [ ] MINOR F10 — Commit `9bc825e` changes pinned copy without the pinned tests, so the suite is red at that commit
      where:  src/app/p/[projectSlug]/review/page.tsx:39, src/app/p/[projectSlug]/review/review.test.tsx:55, specs/028-empty-states-roles/plan.md:230, specs/028-empty-states-roles/tasks.md:166, specs/028-empty-states-roles/review.md (first review, F4 "owed")
      why:    At `9bc825e`, Review's page no longer contains "Nothing to review" (`git show 9bc825e:…/review/page.tsx`
              has 0 matches), but `review.test.tsx:55` at that commit still asserts it. The same is true of the
              other R12 pinned tests: `failures/ui`, `generate.test`, `voice.test`, `scheduler-health`,
              `ReauthBanner.test` and `jobs/ui`. They're only updated in `5fa6243`. Plan and tasks both say to update
              pinned tests "in the same commit as the copy change (FR-084)". PRs merge with merge commits (`4d7218f`),
              so the red commit would reach `main`'s history and trip `git bisect`. The first review's own F4 "owed"
              text prescribed this `feat` then `test` split, so this one is on the review. The final tree is green,
              and FR-084 holds at PR level.
      owed:   The branch has no upstream yet (`git rev-parse @{u}` fails). Before the PR is opened, squash `5fa6243`
              into `9bc825e`, or fold each pinned-test update into the commit that changes its copy. If the branch is
              already pushed, leave it and keep the rule in later entries.
      traces: FR-084, plan.md "Pinned tests", Constitution, Development Workflow (Commits)

- [ ] MINOR F5 — (carried) The scheduler banner's role tests pass the viewer directly, so the layout's role-to-viewer
      mapping is untested
      where:  src/app/p/[projectSlug]/layout.tsx:50, tests/integration/scheduler-health.test.ts:121-135
      why:    If `isOwner` became `canManage`, admins would get the remedies, and no test would fail. Unchanged by the
              remediation.
      owed:   Extract and test `schedulerViewerFor(scope)`, or render the layout per role.
      traces: FR-083, FR-061

- [ ] MINOR F6 — (carried) The owner's "How to fix this" docs link opens in the same tab
      where:  src/components/shell/SchedulerHealth.tsx:100-103
      why:    `contracts/components.md` specifies `target="_blank" rel="noreferrer"`, matching the other setup-guide
              links. Unchanged.
      owed:   Add `target="_blank" rel="noreferrer"`.
      traces: FR-060

- [ ] MINOR F7 — (carried) The "generation is ready" rule is written twice
      where:  src/app/p/[projectSlug]/generate/prerequisites.ts:14, src/lib/roles/prerequisites.ts:82
      why:    A later change to an item's done rule in `generationPrerequisites` wouldn't reach the `complete`
              shortcut. Unchanged.
      owed:   Export one `isGenerationReady(readiness, images)` and use it in both places.
      traces: Constitution IV, FR-040

- [ ] MINOR F8 — (carried) Pages read data again that the new services have just read
      where:  src/server/services/generation/readiness.ts:16, src/server/services/slots.ts:54, src/app/p/[projectSlug]/compose/page.tsx:25-26, src/app/p/[projectSlug]/compose/[postId]/page.tsx:30-31
      why:    That's one or two extra queries per request, against plan.md's "reuses the reads those pages already
              make". Compose also reads slot counts when there are no accounts. Unchanged.
      owed:   Let `listSlotCounts` and `getGenerationReadiness` accept rows the page has already loaded.
      traces: plan.md Performance Goals

- [ ] MINOR F9 — (carried) FR-090 and FR-091 docs are incomplete
      where:  docs/decisions.md:1296-1321, .claude/skills/docket-ui/SKILL.md ("States")
      why:    Three gaps remain. The docket-ui skill line is still owed: the sandbox blocks `.claude/skills`, and this
              is logged as an open item at `decisions.md:1319-1321`. The 028 entry has no mixed-accounts note. D20
              says only "as in R12", not which tests' pinned copy changed. Unchanged.
      owed:   A human adds the skill line. Add the FR-023 note to `decisions.md`, and list the updated test files.
      traces: FR-090, FR-091

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1–F4) | 4 | 4 fixed | 0 | 0 | 0 |
| Functional requirements: product (FR-001–FR-075) | 45 | 45 | 0 | 0 | 0 |
| Functional requirements: tests (FR-080–FR-084) | 5 | 4 | 1 | 0 | 0 |
| Functional requirements: docs (FR-090, FR-091) | 2 | 0 | 2 | 0 | 0 |
| Acceptance scenarios (US1–US6) | 34 | 34 | 0 | 0 | 0 |
| Success criteria | 8 | 7 | 0 | 0 | 0 |
| Constitution principles and workflow rules | 10 | 9 | 1 | 0 | 0 |

**Carried from the first review.** The product FRs and acceptance scenarios are carried over, because the
remediation changed no product file. The first review judged each one by reading the code, and ran probes.

**Tests.** FR-080, FR-081, FR-082 and FR-084 are satisfied. FR-084 holds at PR level; F10 is about the commit split.
FR-083 is partial (F5).

**Success criteria.** SC-007 is now satisfied: every touched route has a tested owner and editor empty state.
SC-008, no sideways scroll at 390 px, is **unverified** and not counted.

**Constitution.** The commits rule is now satisfied (F10 is MINOR). The docs rule is still partial (F9).

## What I could not check

- **The quickstart's real-browser walk-through (T036, still open):** focus rings on empty-state actions, keyboard
  open and close of "Not set up on this server", and `scrollWidth <= 390` (SC-008) on Accounts, Calendar, Compose,
  Generate, Jobs and Media. It needs chrome-devtools, which this phase doesn't have.
- **The Compose slot hint in a live browser,** after the composer's automatic check returns.
- **Full lint, typecheck, test and build:** not re-run, per the constitution's review rule.
  - The remediation pass ran `tsc --noEmit` and the changed tests. It didn't run the full suite or lint.
  - The first implement pass reported lint at 0 errors, and typecheck and build passing.
  - CI hasn't run: the branch has no upstream and no PR yet.
- **Red tests at `9bc825e` (F10):** inferred from the commit contents (`git show`), not by running the suite at that
  commit.
- **The docket-ui skill edit (T033):** a human has to make it, because the sandbox can't write `.claude/skills`.
- **Live docs anchors on the published GitHub Pages site:** only the in-repo `published-docs.test.ts` covers them.
