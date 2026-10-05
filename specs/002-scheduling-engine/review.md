# Review: Docket Scheduling Engine (002), sixth pass

**This reviews the present state on `main` at `86dc1b7`, not a branch diff.** Feature 002 was merged long ago (PR #6, `e6cb73c`), and features 003–010 have been built on top of it. `HEAD` is `main` and equals `origin/main` plus local commits, so a `<base>...HEAD` diff would show nothing about 002.

Instead, this pass covers the changes since the fifth pass (`489e823`). `git diff --stat 489e823 HEAD -- src tests specs` shows 4 files across 2 code commits:
- `d9512a3`, `fix(posts): keep a post in review when only some of its targets are cancelled`. This is the fix for the fifth pass's only blocking finding, F22. It is 002 code.
- `86dc1b7`, `fix(meta): …`, touching `src/providers/meta/connect-group.ts`. This is entry 005's code. It does not touch 002, so I did not review it here.

**Note on FEATURE_DIR.** `check-prerequisites.sh` resolves to `specs/010-hardening-deployment`, the newest feature on `main`. This run was told to review `specs/002-scheduling-engine`, so that is the directory used.

- **Read in full:**
  - the `d9512a3` diff and its test;
  - `src/server/services/posts/cancel.ts` (whole file, 37 lines);
  - both callers of `resetEmptyReview`: `src/server/services/posts/index.ts:627-638` (`cancelTarget`) and `src/server/services/accounts.ts:365-383` (`removeAccount`);
  - `src/server/services/posts/index.ts:262-275`, `updatePost`'s target diff, which cancels without calling `resetEmptyReview`;
  - `src/server/services/posts/status.ts:10-30` (`derivePostStatus`);
  - `spec.md` FR-029 (:399) and edge cases (:328-330);
  - `research.md` D11 (:131-138).
- **Sampled:** none.
- **Not re-read this pass:** the remaining 002 modules. Apart from `cancel.ts`, no 002 file under `src/` or `tests/` changed since `489e823`, so the fifth pass's reading of them still stands. Carried findings below cite the same lines, checked against the unchanged files.

**Executed:**
- **`pnpm test`:** 306 files and **2613 tests passed**, 1 skipped, **exit 0**, with no "Unhandled Errors" section. That is two more tests than the fifth pass: the F22 test and the meta hint test.
- **`pnpm vitest run tests/integration/posts`:** 11 files, 64 tests, all passed.
- **Scratch tests**, run against the real test database through a `$TMPDIR` Vitest config and deleted afterwards. All 4 passed:
  - an `approved` post with two draft targets, one cancelled, stays `approved`, with status `approved`;
  - `removeAccount` on one of a `needs_review` post's two accounts leaves the post `needs_review`, and `addToQueue` refuses every target;
  - `removeAccount` on a `needs_review` post's only account returns it to `draft`;
  - a queued `approved` post stays `approved`/`scheduled` after one of two cancels, then becomes `draft`/`draft` once both are cancelled.
- **Housekeeping:** a 14-byte untracked file named `0` (contents `email set: 18`) appeared in the repo root during the scratch run. No code in the repo writes that string. The tree was clean at session start, so I deleted the file, leaving the tree clean again.

## Verdict

**Ready for a human to sign off. No blocking findings.**

**F22 is fixed correctly.** `resetEmptyReview` now returns a post to `draft` only when it has at least one target and **every** target is `cancelled` (`cancel.ts:33`). That is FR-029's literal "all-cancelled returns to `draft`". Every other case keeps the post's editorial state, so cancelling one platform of a post under review no longer lets it skip approval.

The fix works for both callers, `cancelTarget` and `removeAccount`. The approved-but-unqueued case also keeps `approved` now. I checked this against the code, the committed test (which fails on the old predicate: `[cancelled, draft]` satisfied `every(draft || cancelled)`) and four scratch cases.

**Two gaps in the owed list remain, both MINOR:**
- **F25:** two of the four requested tests were not committed: the `approved` case and the `removeAccount` case.
- **F26:** research D11 still describes the old rule.

**What still needs fixing, none of it blocking:**
- the carried MINORs (F3, F4, F5, F6, F8, F9, F14, F17, F24) remain open and are safe to ship;
- `tasks.md` still shows T090, T091 and T092 unticked, although all three are fixed in code (see F19, F20, F22). This review does not re-tick tasks. A human or the implement pass should tick them, and must not redo the work.

## Findings

- [x] MAJOR F22 — **Resolved** in `d9512a3`. Cancelling some of a post's targets no longer resets its review state. Only an all-cancelled post returns to `draft`.
      where:  src/server/services/posts/cancel.ts:31-37, tests/integration/posts/lifecycle.test.ts:110-122
      why:    The predicate changed from `every(draft || cancelled)` to `length > 0 && every(cancelled)`.
              - The committed test covers the reported path: cancelling one target of a `needs_review` post keeps it in review and unqueueable; cancelling both returns it to `draft`.
              - Scratch tests confirmed the `approved` path and both `removeAccount` paths (accounts.ts:380).
              - `updatePost`'s target removal (posts/index.ts:267) never called `resetEmptyReview`, so it is unaffected.
              - `derivePostStatus` (status.ts:12) still returns the review state when no live target remains, so the derived status follows.
      traces: FR-029, edge cases "A post in `needs_review`" and "All targets of a post cancelled"

- [ ] MINOR F25 — The F22 fix left out two of the four regression tests asked for: an `approved` post keeping `approved`, and `removeAccount` keeping a post in review.
      where:  tests/integration/posts/lifecycle.test.ts:110-122, src/server/services/accounts.ts:380, specs/002-scheduling-engine/tasks.md:280
      why:    T092 owed tests (a)–(d). Only (a) and (b) were committed, in one `lifecycle.test.ts` case.
              - The `removeAccount` path is the one most likely to regress, since it runs `resetEmptyReview` once per affected post (accounts.ts:380).
              - Both paths behave correctly today: they passed this pass's scratch tests. But no committed test would catch a revert of the predicate on them.
      owed:   Add both cases, (c) and (d) from T092, beside the F22 test.
      traces: FR-029 (test integrity)

- [ ] MINOR F26 — Research D11 still states the rule F22 removed: a post with no live targets returns to `draft`.
      where:  specs/002-scheduling-engine/research.md:135, src/server/services/posts/cancel.ts:33
      why:    T092 asked for D11 to be corrected, and it was not.
              - The doc now contradicts both the code and FR-029.
              - A later reader following D11 would re-introduce F22.
      owed:   Change D11's last bullet to: "When a cancel leaves every target `cancelled`, `review_state` becomes `draft`. Otherwise the editorial state is kept."
      traces: FR-029, constitution IV

- [x] MAJOR F19 — **Resolved** in `417d414` (fifth pass). `pullQueueForward` never moves a target later than its current occurrence.
      where:  src/server/services/queue/index.ts:207-212, tests/integration/queue/actions.test.ts:106-120

- [x] MAJOR F20 — **Resolved** in `01ca121` (fifth pass). `addToQueue` holds occurrences in `social_account_id` order.
      where:  src/server/services/posts/index.ts:467-470, tests/integration/queue/concurrency.test.ts:42-62

- [ ] MINOR F24 — (carried) T090 is ticked in code, but the deleted-slot test it required was never added. Only the paused-slot case is tested.
      where:  tests/integration/queue/actions.test.ts:106-120, src/server/services/queue/index.ts:211
      owed:   Add a deleted-slot case beside the paused one.
      traces: FR-021, edge case "Pausing or deleting a slot" (test integrity)

- [ ] MINOR F14 — (carried) Setting a scheduled post back to `needs_review` leaves its targets scheduled. `setReviewState` has no caller outside tests, so the UI cannot reach this.
      where:  src/server/services/posts/index.ts:343-354, src/server/dal/scheduler.ts:62-75
      owed:   Refuse `needs_review` while any target is `scheduled` or `publishing`, or delete `setReviewState`.
      traces: edge case "A post in `needs_review`", FR-029

- [ ] MINOR F3 — (carried) A due target on a removed, `needs_reauth` or unregistered-provider account fails with one generic message.
      where:  src/server/scheduler/publishing.ts:105-110
      owed:   Give each cause its own message, and say "Reconnect" for `needs_reauth`.
      traces: FR-038, US5-AS5

- [ ] MINOR F4 — (carried) `recordRefresh` is guarded only by the refresh lease owner, so a refresh in flight can write credentials onto a removed or reconnected account.
      where:  src/server/dal/accounts.ts:228-237, src/server/dal/accounts.ts:155, src/server/dal/accounts.ts:222
      owed:   Add `removed_at IS NULL` to the guard, and clear the refresh lease in `markRemoved` and `upsertConnected`.
      traces: FR-037, FR-001

- [ ] MINOR F5 — (carried) The background token refresh has no hard timeout. It passes only an `AbortSignal`.
      where:  src/server/scheduler/token-refresh.ts:58-63
      owed:   Wrap the call in the same `withTimeout` race that `advance` uses.
      traces: FR-030, FR-037

- [ ] MINOR F6 — (carried) The DAL's `releaseLease` and `recordWithLease` exports are dead, and they diverge from the scheduler's inline versions.
      where:  src/server/dal/scheduler.ts:210, src/server/dal/scheduler.ts:223, src/server/dal/index.ts:49-50
      owed:   Delete both exports.
      traces: constitution IV

- [ ] MINOR F8 — (carried) A `publishing` target whose lease expired during a may-publish step can be cancelled, which erases `in_flight_may_publish`.
      where:  src/server/services/posts/index.ts:628-636, src/server/services/posts/cancel.ts:6-24
      owed:   Treat an expired lease with `in_flight_may_publish = true` as not cancellable, or record it as `ambiguous` when cancelled.
      traces: FR-035, constitution V

- [ ] MINOR F9 — (carried) There is no way to preview an explicit time's proximity warning: no `previewScheduleAt` exists in `src/`.
      where:  src/server/services/posts/index.ts:432
      traces: US4-AS10, FR-022

- [ ] MINOR F17 — (carried) The scheduler contract still describes the superseded limit rule, `publish_started_at ??= now`.
      where:  specs/002-scheduling-engine/contracts/scheduler.md:85-89
      owed:   Update it to match `docs/decisions.md`.
      traces: FR-036

- NOTE F27 — `tasks.md` T090, T091 and T092 (specs/002-scheduling-engine/tasks.md:275, :276, :280) are unticked, but their fixes are in `main` (`417d414`, `01ca121`, `d9512a3`). Whoever next runs implement on this directory should tick them, not redo them.

- NOTE F23 — (carried) A claim batch made up entirely of rows on accounts locked by another tick comes back empty, and the publishing loop exits. This costs throughput, not correctness.

- NOTE F18 — (carried) A multi-step publish is counted at its first step (D8).

- NOTE F11 — (carried) There is no lock-order cycle between the tick and the services.

- NOTE F12 — (carried) The SC-002 test runs on the shared pool, not a dedicated pool of 20.

- NOTE F15 — (carried) `scheduleAt` and `publishNow` without `targetIds` skip mid-publish targets silently.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checked |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-048) | 48 | 48 | 0 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-013) | 13 | 12 | 0 | 0 | 0 | 1 (SC-013, needs Docker) |
| User stories | 7 | 5 (US1, US2, US3, US6, US7) | 2 (US4 → F9; US5 → F3) | 0 | 0 | 0 |
| Edge cases (spec.md:305-354) | 18 | 17 | 1 ("A post in `needs_review`" → F14, unreachable from UI) | 0 | 0 | 0 |
| Constitution (I–VII + Engineering constraints + Workflow) | 9 | 9 | 0 | 0 | 0 | 0 |

How these were judged:
- **FR-029** moved from Partial to Satisfied. I read the fix, the committed test, the full suite run and four scratch cases.
- **The "All targets of a post cancelled" edge case** was re-checked by scratch test.
- **All other rows** carry over from the fifth pass. Their code has not changed since then (the `git diff --stat` above), and the full suite is green.

## What I could not check

- **SC-013 / T084, `docker compose up`.** There is no Docker daemon in this sandbox.
- **Neon / research U1 / T085.** No Neon URL is available.
- **`pnpm build`, `pnpm typecheck` and `pnpm lint`.** Not run this pass; only `pnpm test` was. The fix is a one-line predicate change in a file the test suite imports, so the type checker would have to object to something the tests compiled cleanly.
- **The F22 path in a browser.** I verified it through the service layer, which is what `cancelTargetAction` calls. I did not click Cancel on a draft target, and I did not watch the "Needs review" list keep the post.
- **Where the stray `0` file came from.** It appeared during a Vitest run with a custom config, and nothing in the repo writes its contents. If it reappears after ordinary `pnpm test` runs, a test helper or local hook is writing to the cwd.
