# Review: "Retry all failed" on the Failures page (015-bulk-retry-failed)

Reviewed 34 file(s) against merge-base `7df8475` (PR #32, 012 retry modes), across 3 branch commits (`760fd96` spec, `c71a822` plan, `d8b1afb` tasks) plus the working tree. **None of the implementation is committed** (see F1), so the evidence is `git diff 7df8475` of the working tree plus 13 untracked files, not `git diff base...HEAD`. `HEAD` itself holds only the spec, plan and tasks. `origin/main` has since moved to `7c414f7` (#33, X provider), which is not part of this diff.

**Read in full:**

- Service and DAL: `src/server/services/posts/retry-all.ts`, the `retry.ts` diff plus the whole file (`retryLockedTarget`, `requeueTarget`), `src/server/services/posts/locked.ts`, and the diffs of `posts/index.ts`, `services/failures.ts` and `dal/targets.ts` (with `attentionWhere` / `livePost` in context).
- Wording: `src/lib/failures/retry-all-text.ts` and its test.
- Actions and UI: `src/app/p/[projectSlug]/failures/actions.ts`, the `page.tsx` diff plus its filter-bar context, `src/components/targets/{RetryAllFailed.tsx,RetryAllDialog.tsx,retry-all-ui.ts,retry-all-ui.test.ts}`. For comparison: `RetryDialog.tsx` and `ui/{Dialog,Alert,Announce}.tsx`.
- Tests: `tests/integration/failures/retry-all{,-requeue,-cap,-concurrency}.test.ts`, the diffs of `authz.test.ts`, `list.test.ts` and `ui.test.tsx`, the helpers `tests/helpers/{retry,failures}.ts`, `tests/setup/scope-recorder.ts` and the relevant part of `tests/integration/scope-check.test.ts`.
- Docs: the diffs of `docs/failures.md`, `docs/decisions.md`, `docs/index.md` and `README.md`.
- Spec artifacts: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/services.md`, `contracts/ui.md`, `tasks.md` and the constitution.

**Sampled:** `src/providers/mock/index.ts` (what the `fatal` behaviour records) and `src/server/scheduler/record.ts` (attempt outcomes).

**Not reviewed:** `quickstart.md` and `checklists/requirements.md` (planning aids with no code obligations), and `.specify/roadmaps/failure-recovery-completeness-roadmap-th.json` (the roadmap runner's state file, not feature work).

**Run during this review** (targeted only, per the constitution's review rule):

- `pnpm vitest run` on the 6 new test files: 63 passed.
- `pnpm vitest run` on `authz`, `list`, `ui`, every 012 `retry*.test.ts`, `retry-ui.test.ts` and `scope-check.test.ts`: 14 files, 113 passed.
- eslint on every changed source and test file: 0 errors. There is 1 warning (`posts/index.ts:8`, unused `TargetPatch`), which was already there at `7df8475`.
- The cap test's timing case on its own, to check what the measurement actually measured (F3). It logged `requeue press of 100 attempts: 1188 ms (count 52)`.

## Verdict

The feature works and hangs together. The cross-pass seams are clean:

- **One code path.** The bulk run calls the 012 single-retry body (`retryLockedTarget`) under the 012 locking helper (`withLockedTarget`), one transaction per target. So FR-005 and FR-009 hold by construction, and the twin tests confirm it.
- **One predicate.** `retryBlockedKey` is the single "blocked" rule, used by the row, the single retry, the preview and the run.
- **Matching shapes.** The result and preview shapes line up exactly between the service, the pure wording module, the UI helpers and the components.
- **Server-side guarantees.** The cap, D5, the D2 order, strict input and authorization are all enforced on the server.

I found no correctness or safety defect that blocks the merge. Three things still block it, all of them about evidence and the record rather than behaviour:

- **F1**: the whole implementation is uncommitted.
- **F2**: the test for a bulk run racing the scheduler tick has assertions that cannot fail with its `fatal` mock accounts, so US4 AS2 (a P1 story) is unproven.
- **F3**: the "100-attempt requeue press" timing that P6 makes the cap depend on actually measured 53 attempts, and `docs/decisions.md` records it as 100.

Each is a small fix. I would remediate those three, then merge. The six MINORs can go to a hardening entry.

## Findings

- [ ] MAJOR F1 — The whole implementation is uncommitted; the branch HEAD contains only the spec, plan and tasks
      where:  `git log 7df8475..HEAD` → only `760fd96`, `c71a822`, `d8b1afb`; untracked src/server/services/posts/retry-all.ts:1, src/components/targets/RetryAllDialog.tsx:1, src/app/p/[projectSlug]/failures/actions.ts:1, src/lib/failures/retry-all-text.ts:1, tests/integration/failures/retry-all.test.ts:1; modified-but-uncommitted src/server/dal/targets.ts:144, src/server/services/posts/retry.ts:43, specs/015-bulk-retry-failed/tasks.md:147
      why:    The constitution's Development Workflow says to commit after each completed task, stage explicit paths only, and have each phase commit the artifacts it writes. The ticked `tasks.md` is uncommitted too. CI runs on pushed commits, so pushing or merging this branch as it stands would ship the spec and plan without the feature, and CI would never see the code. The 012 review raised the same finding (012 review round 1, F1).
      owed:   Commit the implementation in small Conventional Commits with explicit `git add <path>` paths. For example: `feat(failures): …` for the service, DAL, actions and UI; `test(failures): …`; `docs(failures): …` for `docs/*` and `README.md`; `docs(tasks): …` for `tasks.md`. Never use `git add -A` or `.`. Leave `.specify/roadmaps/*.json` alone unless the runner expects it to be committed.
      traces: Constitution — Development Workflow (Commits, Quality gates)

- [ ] MAJOR F2 — The "bulk run racing the scheduler tick" test cannot fail on the property it is named for (US4 AS2)
      where:  tests/integration/failures/retry-all-concurrency.test.ts:61-72 (assertions at :69-70), fixture at :39-45, tests/helpers/retry.ts:9, src/providers/mock/index.ts:81-82
      why:    The fixture's accounts all use the mock `fatal` behaviour (`failedTarget` → `outcomeTarget(env, "fatal")`, and `accB` is `fatal`). The tick can therefore only ever record `fatal_error`, never `done`. That makes `filter(outcome === "done").length <= 1` always `0 <= 1`. The status check at :70 accepts `scheduled`, `publishing`, `published` and `failed`, which covers every outcome a double attempt could leave. Neither assertion can catch the tick attempting a target twice, or attempting one that was still `failed` when claimed, and those are exactly what US4 AS2, FR-011 and SC-002 require. Nothing checks either that the tick claimed anything during the run: it may finish its claim before the first bulk step commits. Only "both settle" and "one `retry_requested` per target" are real assertions.
      owed:   Make the assertions able to fail. Count the tick's engine attempt entries per target (for example entries with a `tickId`, or `fatal_error` outcomes for these accounts) and assert at most one per target. Assert that no engine entry for a target is older than its `retry_requested` entry. Use a fixture in which the tick verifiably claims at least one retried target, for example a `succeed` account with an assertion that some target reached `published`, or a second `runTick()` after the run.
      traces: US4 AS2, FR-011, FR-023 (concurrency), SC-002

- [ ] MAJOR F3 — The cap's recorded evidence says "100 attempts", but the timed press made 53 attempts (D5 stopped the rest)
      where:  tests/integration/failures/retry-all-cap.test.ts:74-82, docs/decisions.md:574, src/server/services/posts/retry-all.ts:94-97, src/server/services/posts/retry-all.ts:110
      why:    The test seeds 100 targets on one account. That account has only about 52 free occurrences in the queue horizon. Target 53 hits `no_free_occurrence`, the account is marked exhausted, and the other 47 are counted under D5 without an attempt (`retry-all.ts:94-97`). I re-ran it and it logged `(count 52)`. P6 makes the cap value depend on "the measured wall time of a 100-attempt requeue press". Both the test name and `docs/decisions.md:574` ("a requeue press of 100 attempts … took 1,369 ms") report a measurement that did not happen. The test asserts only the sum invariant, so it cannot notice. Extrapolating, 100 attempts would probably still be under the 5 s threshold, but the record should say what was measured (constitution II).
      owed:   Seed the timed press so that 100 requeue attempts actually happen, for example 50 targets on each of two accounts with free slots. Assert `count === 100`, or at least that `count + skipped.no_free_slot + skipped.cannot_publish === 100` with no D5 skips. Re-measure, and correct the `docs/decisions.md` "Measured" line with the real figure and attempt count, lowering the cap per P6 if it exceeds 5 s.
      traces: research P6, SC-004, Constitution II

- [ ] MINOR F4 — The ordering tests cannot tell D2 order (intended time) from creation or `updated_at` order
      where:  tests/integration/failures/retry-all-requeue.test.ts:31-50, tests/integration/failures/retry-all-requeue.test.ts:20-25, tests/integration/failures/retry-all-cap.test.ts:17-24, src/server/dal/targets.ts:156
      why:    Every ordering fixture creates and updates its targets in the same order as their intended times. In the requeue test, A1 is at 09:00 (`SLOT`), then A2 at 10:00 and A3 at 11:00; B1 is at 08:00, then B2 at 09:00. The cap seed uses ascending seconds. If `listFailedForRetry`'s `ORDER BY scheduled_at ASC NULLS LAST` regressed to `updated_at` or `id`, every test would stay green. `NULLS LAST` is not exercised at all. The code is correct today (`targets.ts:156`), but SC-003 and FR-023's "requeue ordering per account by intended time" are only weakly proven.
      owed:   Add a fixture whose intended times run opposite to creation order, plus one target with `scheduled_at = NULL`. Assert that slots follow intended time and that the null target comes last.
      traces: D2, SC-003, FR-023

- [ ] MINOR F5 — Two "without post:schedule" refusals are untested at the UI layer: the hidden control and the action's `forbidden`
      where:  tests/integration/failures/ui.test.tsx:188-195, tests/integration/failures/authz.test.ts:83-110, src/app/p/[projectSlug]/failures/page.tsx:204
      why:    T027 asks for a page-level test that shows no control without `schedule`, and it is ticked. Only the ambiguous-tab case was written. FR-023 also asks for refusal "at the server action", but the action tests cover only `not_found` (non-member, foreign slug). The service-level refusal is tested (stub scope, read-only key). The page gate (`canSchedule &&`, `page.tsx:204`) and `runAction`'s `forbidden` mapping are correct by inspection. Every current role holds `schedule`, so this cannot be reached today.
      owed:   Render the page and call `retryAllFailedAction` / `previewRetryAllAction` with a scope whose `can()` lacks `post:schedule`, for example by mocking `forProject` as the stub-scope tests do. Assert that the markup has no "Retry all", and that both actions return `{ ok: false, error: "forbidden" }` with nothing changed.
      traces: US6 AS1, FR-015, FR-023, T027

- [ ] MINOR F6 — The per-account summary keys list items by display name, which collides for several removed accounts or same-named accounts
      where:  src/components/targets/RetryAllFailed.tsx:58, src/components/targets/retry-all-ui.ts:54-63, src/server/services/posts/retry-all.ts:49, src/server/services/posts/retry-all.ts:74
      why:    Every removed account is named "Removed account" (`retry-all.ts:49,74`). Two accounts on different platforms often share a display name ("Acme"). `summaryAccounts` drops `accountId`, and the `<li key={a.name}>` duplicates. React warns and can omit or duplicate items when it re-renders. The two lines also read identically to the user ("Removed account: 0 retried, 2 on removed accounts" twice).
      owed:   Carry `accountId` through `summaryAccounts` and key on it. Optionally add the platform to tell same-named accounts apart.
      traces: FR-019, US1 AS4

- [ ] MINOR F7 — After Escape or Back during a run, reopening the dialog accepts a second submit, and the first run then closes the new dialog
      where:  src/components/targets/RetryAllFailed.tsx:33-36, src/components/targets/RetryAllFailed.tsx:41-43, src/components/targets/RetryAllDialog.tsx:47, src/components/targets/RetryAllDialog.tsx:67-90
      why:    The `submitting` guard is a ref on the dialog instance (`RetryAllDialog.tsx:47`). Back and Escape still close the dialog while a run is pending, as the contract intends. Reopening bumps `dialogKey`, which mounts a fresh instance with a fresh guard and an enabled confirm, while the button is still visible because the refresh has not landed. When the first run resolves, its closures call the parent's `onDone` and `onClose` (`RetryAllDialog.tsx:77-79`). That replaces the summary and closes the second dialog in the middle of the user's interaction. The server stays safe, because D7 handles concurrent presses, so this is a UX defect against FR-018's "MUST NOT accept a second submit".
      owed:   Lift the in-flight flag to `RetryAllFailed`. Either disable the button or keep the dialog in its pending state while a run is outstanding, or ignore late callbacks from a stale `dialogKey`.
      traces: FR-018

- [ ] MINOR F8 — With an account filter for a removed account, the label and preview say "all accounts" while the run is scoped to that one account
      where:  src/server/services/posts/retry-all.ts:156-159, src/components/targets/retry-all-ui.ts:20, src/app/p/[projectSlug]/failures/page.tsx:209
      why:    `previewRetryAll` returns `scope: null` both for "no account filter" and for "an account id not in `accounts.list()`", and soft-removed accounts are not in that list. The data model only anticipated the second case for foreign ids with `inScope: 0`. A removed account still has failed targets in scope. The page also passes `accountName: null` for it. So a stale `?account=<removed id>` URL shows "Retry all 3 failed posts", the title "Retry all failed posts" and "3 failed posts across all accounts.", even though only that account's targets are counted. Confirm is disabled, because every target is `account_removed`, so nothing wrong can happen. The text is misleading, though.
      owed:   Tell "no filter" apart from "filter on an account that is not listed". For example, return `scope: { accountId, accountName: "Removed account" }` when the filter is set and the rows exist, and have the page pass that same name.
      traces: FR-016, FR-017, D8

- [ ] MINOR F9 — `docs/failures.md` calls the bulk requeue mode "Next free slot", but the dialog labels it "Requeue into next free slots"
      where:  docs/failures.md:19, docs/failures.md:21, src/components/targets/RetryAllDialog.tsx:127
      why:    "Next free slot" is the single-retry dialog's label. The bulk dialog's option reads "Requeue into next free slots" (FR-017, contracts/ui.md §3). A reader looking for the docs' wording in the bulk dialog will not find it.
      owed:   Use "Requeue into next free slots" in the "Retrying every failed post" section.
      traces: FR-022, FR-017

- NOTE F10 — D5's premise ("the answer cannot change within the run") does not quite hold for a failed target that holds its own future occurrence. That occurrence counts as free for it (012 D2, `src/server/services/posts/retry.ts:112`). If an earlier target of the same account exhausts the account, `retry-all.ts:94-97` counts this one as `no_free_slot`, where a single requeue would have kept its slot. research F7 notes that failed targets normally hold only past occurrences, so this is a spec-level edge case rather than an implementation defect. It is worth a sentence in `docs/decisions.md` if D5 is ever revisited.

## Coverage

"Satisfied" means both the code and its evidence hold. "Partial" means one of them falls short. Each partial row maps to a finding.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-023) | 23 | 22 | 1 (FR-023: F2, F4, F5) | 0 | 0 |
| Success criteria (SC-001–SC-007) | 7 | 5 | 2 (SC-002: F2; SC-004: F3) | 0 | 0 |
| User-story acceptance scenarios (US1–US6) | 21 | 20 | 1 (US4 AS2: F2) | 0 | 0 |
| Plan decisions (P1–P14) | 14 | 13 | 1 (P6: F3) | 0 | 0 |
| Constitution principles (I–VII) | 7 | 6 | 1 (II: F3) | 0 | 0 |
| Engineering constraints and workflow (Neon/no advisory locks, scheduler constraints, UTC/Temporal, accessibility, commits, quality gates, docs) | 7 | 6 | 0 | 1 (commits: F1) | 0 |

Notes on rows that pass but come close:

- **FR-018** passes within one dialog instance; F7 is the reopen path.
- **FR-016 and FR-017** pass, except for the removed-account edge case in F8.
- **SC-003** passes in code; F4 is about the test's strength.
- **FR-019, FR-020 and SC-007** pass by inspection only. They follow the 012 pattern, whose commit ordering the 012 re-review traced in the framework source. A real browser has not checked them (T033).

What I checked for each sweep category the constitution requires:

- **Concurrency and locking.** Each step takes post → its targets → at most one occurrence of one account. No step holds two posts. The tick only uses `SKIP LOCKED`. An account that flips mid-run is re-read under the lock (`retry-all.ts:133`).
- **Idempotency.** Each target is re-checked as `failed` under its lock, and the write guards carry `statuses: ["failed"]`. The second-press test and the two-run test can both fail.
- **Authorization and scoping.** `need()` runs before parsing and reading, and again inside each transaction. The DAL read is project-scoped through `attentionWhere` / `livePost` (`targets.ts:99-109`), and the global scope recorder checks it on every test query (`tests/setup/scope-recorder.ts`). The isolation test covers a foreign account id.
- **Time zones and DST.** There is no new time maths. Requeue uses the existing allocator.
- **Error and ambiguous paths.** Only `NotFoundError` and `ConflictError` are mapped to a skip, and anything else is rethrown (`retry-all.ts:141-142`). The action rejects, and the dialog shows the FR-013 sentence. `ambiguous` targets are never read.
- **Secrets.** The result carries counts, project account ids and display names only.

## What I could not check

- **Browser and keyboard behaviour.** That covers Tab, arrow and Escape through the dialog, focus returning to the control or falling back to the "Failures" heading after `refresh()`, the live-region announcement matching the visible summary, and how the summary renders. There is no browser in this phase, and T033 remains owed to a human. The focus logic copies the 012 pattern (`RetryAllDialog.tsx:62-65`, `:75-79`), but I did not trace this component's commit ordering in the framework source again.
- **SC-004 on the reference deployment.** I only saw local test-database timings: 1.2–1.4 s for 53 requeue attempts. A real 100-attempt press on Docker Compose or Neon, and the server action's time budget there, are unmeasured. F3 has to land before even the local number means what the record says.
- **The full gates** (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:check`, `pnpm build`). Per the constitution's review rule I did not re-run them. T031 says the implement pass ran them, but I have no transcript of that run. CI has not run, because nothing is committed or pushed (F1).
- **Behaviour against a live scheduler worker.** The races were checked only as forced in-process `Promise.allSettled` races against a real Postgres, not as two processes on a real pooler.
