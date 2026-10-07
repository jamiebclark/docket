# Review: "Retry all failed" on the Failures page (015-bulk-retry-failed)

**Re-review after remediation (round 2).** Reviewed 34 file(s) changed across 8 commit(s), against `7df8475...HEAD` (`7df8475` is the merge-base, PR #32). The implementation is now committed (`5f4d074` feat, `33badf8` test, `9fbbd21` docs, `e03db66` tasks), so this round's evidence is the committed diff, not the working tree. `origin/main` is at `7c414f7` (#33, X provider), which is not part of this diff. `git merge-tree --write-tree HEAD origin/main` merges cleanly, with no conflicts.

**Scope of this round.** The constitution (Development Workflow, "Review is exhaustive once, then scoped") limits a re-review to two questions: is each earlier finding fixed, and did the files the remediation changed introduce a regression? Anything new is MINOR for the hardening entry. Round 1 was the exhaustive sweep, and this round does not repeat it.

**Read in full:**

- **The remediated files:** `tests/integration/failures/retry-all-concurrency.test.ts`, `tests/integration/failures/retry-all-cap.test.ts`, and the `docs/decisions.md` diff (`:546-575`).
- **Code and test files re-read in full** to confirm that every round-1 citation still points at the same code (they all do; the remediation changed no source file):
  - `src/server/services/posts/retry-all.ts`;
  - the diffs of `retry.ts`, `posts/index.ts`, `services/failures.ts` and `dal/targets.ts`;
  - `src/server/services/posts/locked.ts`;
  - `failures/actions.ts` and the `page.tsx` diff;
  - `RetryAllFailed.tsx`, `RetryAllDialog.tsx`, `retry-all-ui.ts` and `src/lib/failures/retry-all-text.ts`;
  - `retry-all.test.ts` and `retry-all-requeue.test.ts`;
  - the diffs of `authz.test.ts`, `list.test.ts` and `ui.test.tsx`;
  - the diffs of `docs/failures.md`, `docs/index.md` and `README.md`.
- **Spec artifacts:** `spec.md`, `plan.md`, `contracts/services.md`, `contracts/ui.md`, `tasks.md`, the constitution and the round-1 `review.md`.

**Sampled:** `src/server/dal/attempts.ts:44` and `src/server/scheduler/record.ts:137` (where attempt timestamps come from, for F11), `src/server/scheduler/limits.ts` and `src/providers/limits.ts` (whether a publish limit could make the new tick-race fixture flaky), and `tests/helpers/retry.ts`.

**Not reviewed:** `research.md`, `data-model.md`, `quickstart.md` and `checklists/requirements.md` (unchanged since round 1, and with no code obligations of their own), and `.specify/roadmaps/failure-recovery-completeness-roadmap-th.json` (the roadmap runner's state file, untracked, not feature work).

**Run during this review** (targeted only, per the constitution's review rule):

- `pnpm vitest run` on the 9 feature test files (the 4 new integration files, `authz`, `list`, `ui`, `retry-all-ui.test.ts` and `retry-all-text.test.ts`): **9 files, 88 passed**.
- The cap timing case on its own (`-t "wall time"`): it logged **`requeue press of 100 attempts: 2846 ms (count 100)`**.
- `pnpm eslint` on the two remediated test files: 0 problems.
- `git merge-tree --write-tree HEAD origin/main`: clean.

## Verdict

The feature satisfies the spec and hangs together, and nothing blocks the merge any more. All three round-1 MAJORs are fixed.

- **F1:** the implementation is committed in four Conventional Commits with explicit paths.
- **F2:** the tick-race test now uses a `succeed` account and runs a second tick. It asserts exactly one `done` entry and `published` for each retried target, and at most one terminal tick attempt per target after its retry, so it can now fail on the property it is named for.
- **F3:** the timed requeue press now really attempts 100 targets (`count === 100`, `no_free_slot === 0`). `docs/decisions.md:574` records the corrected measurement and explains where the old figure came from.

The remediation touched no source file, and its two test files pass and lint clean. One new MINOR (F11): one of the new assertions cannot fail under the frozen clock. The six round-1 MINORs (F4–F9) are still open, as they were expected to be, and belong in the hardening entry. I would merge once CI is green on the pushed branch, and leave T033 (the manual keyboard and browser walk-through) to a human.

## Earlier findings, re-checked

These are resolved, so they are listed without checkboxes.

- **F1 (round 1 MAJOR): fixed.** `git log 7df8475..HEAD` now holds `5f4d074 feat(failures): bulk retry of failed targets` (the 12 source files), `33badf8 test(failures): …` (the 8 test files), `9fbbd21 docs(failures): …` (`README.md`, `docs/*`) and `e03db66 docs(tasks): …`. `git status` shows only the untracked roadmap state file, which was left alone as T034 asked. One small thing: `src/lib/failures/retry-all-text.test.ts` went into the `feat` commit rather than the `test` one. That is cosmetic, and commitlint does not care.
- **F2 (round 1 MAJOR): fixed.** The fixture now includes a `succeed` account with two targets (`retry-all-concurrency.test.ts:62-66`), plus a second `runTick()` after the race (`:71`). The test asserts:
  - one `retry_requested` per target (`:75`);
  - at most one terminal tick attempt (`done` or `fatal_error`) per target after its retry (`:79-80`);
  - exactly one `done` and status `published` for both `succeed` targets (`:82-86`).

  Each of these can fail: a double attempt, a missed claim or a lost retry would turn one red. The mock provider declares no `defaultPublishLimit` (`src/providers/limits.ts:4-7`), so the two `succeed` targets on one account cannot be deferred by a publish limit, and the fixture is not flaky on that account. The "never claims a still-failed target" property is guarded indirectly: had the tick claimed a still-failed target, the bulk step would meet it as `no_longer_failed`, and the target would have zero `retry_requested` entries, failing `:75`. The ordering assertion added at `:78` is weaker than it looks (F11).
- **F3 (round 1 MAJOR): fixed.** The test seeds 100 targets alternating over two accounts, 50 each, which is within each account's roughly 52 free occurrences (`retry-all-cap.test.ts:77-79`). It asserts `count === 100` and `skipped.no_free_slot === 0` (`:83-84`). `docs/decisions.md:574` now reads "about 2.0–2.7 s … over three runs, under the 5 s threshold, so `RETRY_ALL_CAP` stays 100", and it explains the old 1,369 ms / 52-attempt figure. My run measured 2,846 ms, a little above the recorded range but well under P6's 5 s line, so the decision to keep the cap at 100 stands.

## Findings

- [ ] MINOR F11 — The tick-race test's "no engine entry precedes the retry" check cannot fail, because the frozen clock gives both entries the same timestamp
      where:  tests/integration/failures/retry-all-concurrency.test.ts:76-78, src/server/dal/attempts.ts:44, src/server/scheduler/record.ts:137, src/server/services/posts/retry.ts:93
      why:    Attempt entries are stored with `createdAt: entry.at` (`attempts.ts:44`). Both the tick (`record.ts:137`, `at: input.now`) and the retry (`retry.ts:93`, `at: now`) take `at` from the clock that `atTime(LATER, …)` freezes. Every entry made during the race therefore has `createdAt === LATER`, and `>= retry.createdAt` at `:78` always holds. The `succeed` targets have no tick entries from before the race, so `:78` has nothing it could ever reject. The comment at `:76` says ordering "is checked by time (never earlier)", which overstates what this line does. The property itself is still guarded by `:75` (see F2 above), so this is a misleading assertion, not an unproven requirement.
      owed:   Delete `:78` and say in the comment that `:75` covers this property, or make the check real. For example, give the race and the follow-up tick distinct frozen instants, or assert on `tickId` sets: each `succeed` target's `done` entry carries the `tickId` of a tick that ran after the bulk step committed.
      traces: US4 AS2, FR-011, SC-002 (test integrity only)

- [ ] MINOR F4 — (round 1, still open) The ordering tests cannot tell D2 order (intended time) from creation or `updated_at` order, and `NULLS LAST` is not exercised
      where:  tests/integration/failures/retry-all-requeue.test.ts:31-50, tests/integration/failures/retry-all-requeue.test.ts:20-25, tests/integration/failures/retry-all-cap.test.ts:16-27, src/server/dal/targets.ts:156
      why:    Every ordering fixture creates its targets in the same order as their intended times. If `ORDER BY scheduled_at ASC NULLS LAST` at `targets.ts:156` regressed to `updated_at` or `id`, every test would stay green. The code is correct today.
      owed:   Add a fixture whose intended times run opposite to creation order, plus one target with `scheduled_at = NULL`. Assert that slots follow intended time and that the null target comes last.
      traces: D2, SC-003, FR-023

- [ ] MINOR F5 — (round 1, still open) The page's hidden control and the actions' `forbidden` mapping for a scope without `post:schedule` are untested
      where:  tests/integration/failures/ui.test.tsx:188-203, tests/integration/failures/authz.test.ts:82-128, src/app/p/[projectSlug]/failures/page.tsx:204
      why:    T027 (ticked) asks for a page-level "no control without `schedule`" case, and FR-023 asks for refusal "at the server action". Only the service-level refusal (stub scope, read-only key) and the action's `not_found` are tested. The gate at `page.tsx:204` and `runAction`'s `forbidden` are correct by inspection. Every current role holds `schedule`, so this cannot be reached today.
      owed:   Render the page and call both actions with a scope whose `can()` lacks `post:schedule`. Assert that the markup has no "Retry all" and that both actions return `{ ok: false, error: "forbidden" }`.
      traces: US6 AS1, FR-015, FR-023, T027

- [ ] MINOR F6 — (round 1, still open) The per-account summary keys its list items by display name, which collides for several removed accounts or for same-named accounts
      where:  src/components/targets/RetryAllFailed.tsx:58, src/components/targets/retry-all-ui.ts:54-63, src/server/services/posts/retry-all.ts:49, src/server/services/posts/retry-all.ts:74
      why:    Every removed account is named "Removed account", and two platforms often share a display name. `summaryAccounts` drops `accountId`, so `<li key={a.name}>` duplicates. React then warns, and two lines can read identically.
      owed:   Carry `accountId` through `summaryAccounts` and key on it. Optionally add the platform to tell same-named accounts apart.
      traces: FR-019, US1 AS4

- [ ] MINOR F7 — (round 1, still open) After Escape or Back during a run, reopening the dialog accepts a second submit, and the first run's callbacks then close the new dialog
      where:  src/components/targets/RetryAllFailed.tsx:33-36, src/components/targets/RetryAllFailed.tsx:41-43, src/components/targets/RetryAllDialog.tsx:47, src/components/targets/RetryAllDialog.tsx:67-90
      why:    The `submitting` guard is a ref on one dialog instance. Reopening bumps `dialogKey`, which mounts a fresh instance with a fresh guard. The server stays safe (D7), but this misses FR-018's "MUST NOT accept a second submit" across instances.
      owed:   Lift the in-flight flag to `RetryAllFailed`. Either disable the button while a run is outstanding, or ignore late callbacks from a stale `dialogKey`.
      traces: FR-018

- [ ] MINOR F8 — (round 1, still open) With an account filter on a removed account, the label and the preview say "all accounts", while the run is scoped to that one account
      where:  src/server/services/posts/retry-all.ts:156-159, src/components/targets/retry-all-ui.ts:20, src/app/p/[projectSlug]/failures/page.tsx:209
      why:    `previewRetryAll` returns `scope: null` both when there is no filter and when the filter names an account that is not in `accounts.list()` (soft-removed accounts are not). The page also passes `accountName: null` for it. Confirm is disabled, because every such target is `account_removed`, so the only harm is misleading text.
      owed:   Tell "no filter" apart from "filter on an unlisted account". For example, return `scope: { accountId, accountName: "Removed account" }` when the filter is set and rows exist, and have the page pass that same name.
      traces: FR-016, FR-017, D8

- [ ] MINOR F9 — (round 1, still open) `docs/failures.md` calls the bulk requeue mode "Next free slot", but the dialog labels it "Requeue into next free slots"
      where:  docs/failures.md:19, docs/failures.md:21, src/components/targets/RetryAllDialog.tsx:127
      why:    "Next free slot" is the single-retry dialog's label. A reader will not find the docs' wording in the bulk dialog.
      owed:   Use "Requeue into next free slots" in the "Retrying every failed post" section.
      traces: FR-022, FR-017

- NOTE F10 — (round 1, carried) D5's premise ("the answer cannot change within the run") does not quite hold for a failed target that holds its own future occurrence. That occurrence counts as free for it (012 D2, `src/server/services/posts/retry.ts:112`). If an earlier target of the same account exhausts the account, `retry-all.ts:94-97` counts this one as `no_free_slot`, where a single requeue would have kept its slot. This is a spec-level edge case, and research F7 notes that failed targets normally hold only past occurrences. It is worth a sentence in `docs/decisions.md` if D5 is ever revisited.

## Coverage

"Satisfied" means both the code and its evidence hold. "Partial" means one of them falls short, and each partial row maps to a finding. This round re-checked only the rows that round 1 marked partial or absent, plus the remediated files. All other rows carry over from round 1, whose citations I confirmed still point at unchanged code.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-023) | 23 | 22 | 1 (FR-023: F4, F5, both MINOR) | 0 | 0 |
| Success criteria (SC-001–SC-007) | 7 | 7 | 0 | 0 | 0 |
| User-story acceptance scenarios (US1–US6) | 21 | 21 | 0 | 0 | 0 |
| Plan decisions (P1–P14) | 14 | 14 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Engineering constraints and workflow (Neon/no advisory locks, scheduler constraints, UTC/Temporal, accessibility, commits, quality gates, docs) | 7 | 7 | 0 | 0 | 0 |

What moved since round 1:

- **SC-002 and US4 AS2:** partial → satisfied (F2 fixed).
- **SC-004, P6 and constitution II:** partial → satisfied (F3 fixed; local test-database evidence only, see below).
- **Commits:** absent → satisfied (F1 fixed).
- **FR-023:** stays partial, but only for MINOR test-strength gaps (F4, F5). F11 does not move it, because the property it misstates is covered by another assertion.

Rows that pass but come close, unchanged from round 1:

- **FR-018:** F7 is the reopen path.
- **FR-016 and FR-017:** F8 is the removed-account filter.
- **FR-019:** F6 is the duplicate key.
- **FR-019, FR-020 and SC-007:** these hold by inspection and static markup only (see below).

## What I could not check

- **Browser and keyboard behaviour (T033, still owed to a human).** That covers Tab, arrow and Escape through the dialog, focus returning to the control or falling back to the "Failures" heading after `refresh()`, the live-region announcement matching the visible summary, and how the summary renders. There is no browser in this phase. The focus logic copies the 012 pattern (`RetryAllDialog.tsx:62-65`, `:75-79`).
- **SC-004 on the reference deployment.** I only have local test-database timings: 2.0–2.7 s recorded, and 2.85 s in my run, for 100 requeue attempts. A real press on Docker Compose or Neon, and the server action's time budget there, are unmeasured.
- **The full gates** (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:check`, `pnpm build`). Per the constitution's review rule I did not re-run them. T031 says implement ran them in round 1, but I have no transcript showing they were re-run after the T035/T036 test edits. The two edited files pass and lint clean, but they have not been typechecked in this phase.
- **CI.** The branch has no upstream, so CI has not run on these commits. It has also not run against the merge with `origin/main` (`7c414f7`, #33 X provider). The merge is textually clean, but whether the merged suite is green is unverified.
- **Behaviour against a live scheduler worker.** The races were checked only as forced in-process `Promise.allSettled` races against a real Postgres, not as two processes on a real pooler.
