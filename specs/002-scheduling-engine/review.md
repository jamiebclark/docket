# Review: Docket Scheduling Engine (002), fifth pass

**This reviews the present state, not a branch diff.** Feature 002 was merged long ago (PR #6, `e6cb73c`), and features 003–010 have been built on top of it. Diffing against `origin/main` shows only bookkeeping (`6391f7f...18981ed` changes nothing but `tasks.md`), so it is no evidence about 002.

Instead, this pass reviews three things:
- the current code of 002's modules;
- the two fix commits for the previous pass's blocking findings: `01ca121` (F20) and `417d414` (F19), both merged in PR #6;
- whether any later feature changed how far a carried finding reaches.

**The checkout changed mid-review.** It started on `chore/review-bookkeeping` at `18981ed`. By the time this file was written, it was on `docs/self-hosting-setup` at `915c32d`, which does not contain `18981ed`. Something outside this phase did that. I checked `git diff --stat 18981ed 915c32d -- src tests specs/002-scheduling-engine`: `src/` and `tests/` are byte-identical, so every code finding below holds on both. The only difference is `specs/002-scheduling-engine/tasks.md`: on this branch, T090 and T091 are still **unticked**, because their tick lives only in `18981ed`. Both are fixed in the code (see F19 and F20). The implement pass must not redo them.

- **Read in full:**
  - the fix diffs `01ca121` and `417d414`, with their tests;
  - `src/server/services/queue/index.ts:154-231` (swap, and the pull-forward walk);
  - `src/server/services/posts/cancel.ts`;
  - `src/server/services/posts/index.ts`: lines 180-195 (queue gate), 343-368 (review state, delete), 432-506 (`addToQueue`) and 606-637 (cancel);
  - `src/server/scheduler/publishing.ts:95-112` and `:220-392` (account gate, `execute`);
  - `src/server/scheduler/token-refresh.ts:50-70`;
  - `src/server/dal/accounts.ts:222-250`;
  - `src/server/dal/targets.ts:60-83` and `:223-261`;
  - `tests/integration/scheduler/refresh.test.ts:36-75`;
  - `tests/integration/queue/{actions,concurrency}.test.ts`, at the F19 and F20 cases;
  - `research.md` D11, and `spec.md` FR-029 and the edge cases at :328-330.
- **Sampled:**
  - `src/components/targets/TargetResolution.tsx:120-147`, the Cancel button on draft targets;
  - `src/server/services/generation/save.ts:53` and `src/server/services/jobs/runner.ts:142-160`, which produce `needs_review` posts;
  - `src/server/auth/access.ts`, the role matrix;
  - `contracts/scheduler.md:83-90`.
- **Not re-read this pass:** the remaining 002 modules. The fourth pass read them in full. Since then, the only commits touching 002's modules are the two fixes and later features' additions, and the latter were reviewed in their own entries (003–010).

**Executed:**
- **`pnpm test`:** **306 files and 2611 tests passed, 1 skipped, exit 0.** This was run on `18981ed`, which has the same code as the current checkout.
- **Two scratch tests** against the real test database, through a `$TMPDIR` Vitest config. Nothing was written outside `specs/`.
  - **F19, deleted-slot case:** slots on Mon and Wed; targets queued on Mon 10-05, Wed 10-07 and Mon 10-12; Wed slot deleted; pull forward. Result `moved: []`, with all three times unchanged, so this holds.
  - **F22:** a `needs_review` post with two draft targets; one target cancelled. Result: `reviewState` became `"draft"`, and `addToQueue` then returned `ok: true` for both targets. So F22 still reproduces.

## Verdict

**Not ready to sign off. One MAJOR, F22, which earlier passes graded MINOR.**

**What changed since the fourth pass:**
- **F19 and F20 are fixed correctly.** Both have tests that fail on the old code, and the full suite is green.
- **Later features fixed two carried MINORs:** F21 in `1d127e4`, and F7 in `7198e3c`.

**Why F22 is now MAJOR.** When F22 was found, nothing set `needs_review`, so the defect was unreachable. Features 007 and 008 now create `needs_review` posts as standard practice (`generation/save.ts:53`). The post page offers **Cancel** on draft targets (`TargetResolution.tsx:124`).

So the ordinary review action "don't post this one to Instagram" does three things:
- silently takes the post out of review;
- drops it from the "Needs review" filter;
- makes it queueable without approval.

This contradicts FR-029, which keeps `needs_review` when no live targets remain and returns to `draft` only when *all* targets are cancelled. It is not an authorisation hole: every role that can cancel can also approve. But it is a realistic input producing a spec-contradicting result. The fix is a few lines plus tests, appended as T092.

**Everything else is safe to ship:**
- the carried MINORs F3, F4, F5, F6, F8, F9, F14 and F17, all re-checked at their current lines;
- one new MINOR, F24: T090 is ticked, but the deleted-slot test it asked for was never written.

## Findings

- [ ] MAJOR F22 — (escalated from MINOR) Cancelling one *draft* target of a `needs_review` post resets the post to `draft`, so it leaves review and can be queued without approval. Since entries 007 and 008, generated posts reach this state through ordinary UI use.
      where:  src/server/services/posts/cancel.ts:27-33, src/server/services/posts/index.ts:627-637, src/server/services/accounts.ts:380, src/components/targets/TargetResolution.tsx:124-126, src/server/services/generation/save.ts:53, specs/002-scheduling-engine/spec.md:399, specs/002-scheduling-engine/spec.md:328-330, specs/002-scheduling-engine/research.md:135
      why:    The mechanism:
              - `resetEmptyReview` sets `reviewState = 'draft'` whenever every target is `draft` or `cancelled` (cancel.ts:29-30).
              - Research D11 (research.md:135) read the spec's "all-cancelled returns to draft" as "no live targets remain". That reading also catches a post that never had a live target.
              - FR-029 (spec.md:399) says the opposite: with no live targets, the post "keeps or returns to its editorial status (`draft`, `needs_review` or `approved`; all-cancelled returns to `draft`)".
            Why it is now reachable:
              - Generation saves posts as `needs_review` with draft targets (generation/save.ts:53).
              - The post page shows **Cancel** for draft targets (TargetResolution.tsx:124).
              - A reviewer who drops one platform therefore turns the post into a `draft`. It vanishes from the "Needs review" list, and anyone with `schedule` can queue it with no approval step.
              - `removeAccount` runs the same helper (accounts.ts:380), so removing one account demotes every generated post under review that targeted it.
              - An `approved`-but-unqueued post (auto-approve without add-to-queue) is also demoted to `draft`, against FR-029's "keeps … `approved`".
            Reproduced on current code: a `needs_review` post with targets on accounts A and B; `cancelTarget(A)` gives `reviewState: "draft"`, and `addToQueue` then gives `[ok: true, ok: true]`.
      owed:   Fix the rule:
              - In `resetEmptyReview`, return to `draft` only when **every** target is `cancelled` (the spec's literal "all-cancelled"). Otherwise leave `reviewState` alone and just re-derive status.
              - Correct research D11 (research.md:135) to match.
            Add tests to `tests/integration/posts/actions.test.ts`:
              - (a) `needs_review` post with two draft targets: cancel one; it stays `needs_review` and `addToQueue` is refused with `not_queueable`;
              - (b) the same post with both cancelled returns to `draft`;
              - (c) an `approved` post with two draft targets, one cancelled, stays `approved`;
              - (d) `removeAccount` on one of two accounts leaves a `needs_review` post in review.
      traces: FR-029, edge case "A post in `needs_review`", edge case "All targets of a post cancelled"

- [x] MAJOR F19 — **Resolved** in `417d414`. `pullQueueForward` no longer moves a target later than its current occurrence.
      where:  src/server/services/queue/index.ts:207-212, tests/integration/queue/actions.test.ts:106-120
      why:    When the offered occurrence is later than `from`, the walk releases it and re-holds `from` with the target's own `slot_id` (null after a delete), then sets `after = from`.
              - The paused-slot test fails on the old code: t1 would move from Mon 10-05 to Tue 10-06.
              - The deleted-slot case passed in this pass's scratch test (`moved: []`).
              - Re-holding `from` cannot race: the occurrence was released in this same transaction, so a concurrent insert of that key waits for this commit.

- [x] MAJOR F20 — **Resolved** in `01ca121`. `addToQueue` holds occurrences in `social_account_id` order, then restores the caller's order in the result.
      where:  src/server/services/posts/index.ts:467-470, src/server/services/posts/index.ts:504-505, tests/integration/queue/concurrency.test.ts:42-62
      why:    Every transaction now waits on accounts in the same global order. While it waits on account A, it holds nothing on B, so no cycle can form.
              - The new test runs 10 posts × 10 repetitions, half created in [A, B] order and half in [B, A].
              - It asserts every result is `ok` and 10 distinct occurrences per account. It passed in the full run.

- [x] MINOR F21 — **Resolved** in `1d127e4` (entry 010). Failures before the provider call are now classified as engine failures, not `ambiguous`.
      where:  src/server/scheduler/publishing.ts:289, src/server/scheduler/publishing.ts:318-323, src/server/scheduler/publishing.ts:354, src/server/scheduler/publishing.ts:379
      why:    `providerCalled` is set right before `advance`. Credential, settings, content and media failures each throw a typed error, and they are classified on the `!providerCalled` branch.

- [x] MINOR F7 — **Resolved** in `7198e3c`. The refresh test now creates the due target only after the account is flagged.
      where:  tests/integration/scheduler/refresh.test.ts:66-74

- [ ] MINOR F24 — T090 is ticked, but the deleted-slot test it required was not added. Only the paused-slot case is tested.
      where:  tests/integration/queue/actions.test.ts:106-120, specs/002-scheduling-engine/tasks.md:275
      why:    T090 asked for a paused-slot test "and, separately, delete it". The delete path differs in that it re-holds with a `null` `slot_id` (queue/index.ts:211, `t.slotId as string`). That path is correct today: it passed this pass's scratch test. But no committed test would catch a regression there, for example someone replacing the cast with a non-null assertion that also validates.
      owed:   Add a deleted-slot case beside the paused one in `tests/integration/queue/actions.test.ts`.
      traces: FR-021, edge case "Pausing or deleting a slot" (test integrity)

- [ ] MINOR F14 — (carried) Setting a scheduled post back to `needs_review` leaves its targets scheduled, so the tick still publishes it.
      where:  src/server/services/posts/index.ts:343-354, src/server/dal/scheduler.ts:62-75
      why:    Unchanged. Its reach shrank: `setReviewState` now has no caller outside tests, and entry 007's review flow (`services/review.ts`) does not go through it. So this cannot be reached from the UI today.
      owed:   Refuse `needs_review` while any target is `scheduled`/`publishing`, or delete `setReviewState` if nothing needs it.
      traces: edge case "A post in `needs_review`", FR-029

- [ ] MINOR F3 — (carried) A due target on a removed, `needs_reauth` or unregistered-provider account fails with one generic message.
      where:  src/server/scheduler/publishing.ts:105-110
      why:    All three causes still get "The account is no longer available for publishing." The dead-credentials path (:392) now says "Reconnect … to publish", but this gate does not.
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

- [ ] MINOR F6 — (carried) The DAL exports `releaseLease` and `recordWithLease`, which are dead and diverge from the scheduler's inline versions.
      where:  src/server/dal/scheduler.ts:210, src/server/dal/scheduler.ts:223, src/server/dal/index.ts:49-50
      owed:   Delete both exports.
      traces: constitution IV

- [ ] MINOR F8 — (carried) A `publishing` target whose lease expired during a may-publish step can be cancelled, which erases `in_flight_may_publish`.
      where:  src/server/services/posts/index.ts:628-636, src/server/services/posts/cancel.ts:6-24
      owed:   Treat an expired lease with `in_flight_may_publish = true` as not cancellable, or record it as `ambiguous` when cancelled.
      traces: FR-035, constitution V

- [ ] MINOR F9 — (carried) There is still no way to preview an explicit time's proximity warning: no `previewScheduleAt` exists anywhere in `src/`.
      where:  src/server/services/posts/index.ts:432
      traces: US4-AS10, FR-022

- [ ] MINOR F17 — (carried) The scheduler contract still describes the superseded limit rule, `publish_started_at ??= now`.
      where:  specs/002-scheduling-engine/contracts/scheduler.md:85-89
      owed:   Update it to match `docs/decisions.md`.
      traces: FR-036

- NOTE F23 — (carried) A claim batch made up entirely of rows on accounts locked by another tick comes back empty, and the publishing loop exits. This costs throughput, not correctness.

- NOTE F18 — (carried) A multi-step publish is counted at its first step (D8). Revisit with the first long container → publish flow.

- NOTE F11 — (carried) The tick and the services still have no lock-order cycle. F20's fix adds a consistent per-account order among queue requests.

- NOTE F12 — (carried) The SC-002 test runs on the shared pool, not a dedicated pool of 20. It still uses real parallel connections.

- NOTE F15 — (carried) `scheduleAt`/`publishNow` without `targetIds` skip mid-publish targets silently.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checked |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-048) | 48 | 47 | 1 (FR-029 → F22) | 0 | 0 | 0 |
| Success criteria (SC-001–SC-013) | 13 | 12 | 0 | 0 | 0 | 1 (SC-013, needs Docker) |
| User stories | 7 | 5 (US1, US2, US3, US6, US7) | 2 (US4 → F9; US5 → F3) | 0 | 0 | 0 |
| Edge cases (spec.md:305-354) | 18 | 17 | 1 ("A post in `needs_review`" → F22, F14) | 0 | 0 | 0 |
| Constitution (I–VII + Engineering constraints + Workflow) | 9 | 9 | 0 | 0 | 0 | 0 |

How these were judged:
- **FR-018 and FR-021** moved from Partial to Satisfied. The code was read, the fix tests passed in the full run, and the deleted-slot case was reproduced by hand.
- **FR-029** moved from Satisfied to Partial. F22 is reachable now, so the letter of the requirement is what decides it.
- **All other rows** carry over from the fourth pass. No change to their code since then was found, and the full suite is green.

## What I could not check

- **SC-013 / T084, `docker compose up`.** There is no Docker daemon in this sandbox.
- **Neon / research U1 / T085.** No Neon URL is available.
- **`pnpm build`, `pnpm typecheck` and `pnpm lint`.** Not re-run this pass; only `pnpm test` was. No 002 source file changed since entry 010's CI run.
- **The F22 path in a browser.** I traced it from code: Cancel button → `cancelTargetAction` → `cancelTarget`. I did not click it. The "Needs review" list filtering was inferred from the derived status (`posts/page.tsx:26`), not observed.
- **Which branch these artifacts belong on.** The checkout switched to `docs/self-hosting-setup` during the review (see the header). This file and the T092 append were written into whatever is checked out now. A human should move them to the right branch.
