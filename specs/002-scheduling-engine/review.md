# Review: Docket Scheduling Engine (002), third pass after remediation

Reviewed 124 implementation files outside `specs/` (51 of them tests) plus the spec artifacts. That is the working tree diffed against the merge-base `a74a9cc` with `origin/main`. The branch has 2 commits (`875ff61` spec, `30f44f5` plan), and both hold only spec artifacts. The whole implementation is **still uncommitted** in the working tree (F10). So this reviews the present working tree against the merge-base, not a committed `a74a9cc...HEAD` diff.

This is the **third** review:
- The first review (F1–F12) appended T086 (F1, BLOCKER) and T087 (F2, MAJOR).
- The second review (F13–F15) appended T088 (F13, MAJOR).
- One implement pass then ran for T088. It touched exactly 3 files outside `specs/`, found by mtime against the previous `review.md`: `src/server/scheduler/publishing.ts`, `tests/integration/scheduler/limits-retry.test.ts` and `docs/decisions.md`.

**Read in full this pass:**
- **Scheduler:** `src/server/scheduler/{publishing,recovery,limits,record,config,index,http,in-process}.ts` and `src/app/api/internal/tick/route.ts`.
- **DAL:** `src/server/dal/scheduler.ts`.
- **Services:** `src/server/services/posts/{index,cancel}.ts` and `src/server/services/queue/index.ts`.
- **Tests:** `tests/integration/scheduler/limits-retry.test.ts`.

**Sampled:**
- `src/server/scheduler/token-refresh.ts:40-91` and `src/server/dal/accounts.ts:135-165`, for the F4 and F5 re-check;
- `src/server/services/posts/index.ts:271-281`, for the F14 re-check;
- the indexes in `drizzle/0001_fixed_susan_delgado.sql:167-178`;
- the "Limit counting" entry of `docs/decisions.md`;
- `specs/002-scheduling-engine/contracts/scheduler.md:84-92`;
- `tests/helpers/db.ts`, `tests/integration/{bootstrap,anonymous-entry}.test.ts` and the `pg-pool` 3.14.0 source, to trace F16.

**Not re-read this pass:** the providers, the schema TS, the remaining DAL repos, `SchedulerHealth.tsx` and the layout, the remaining tests, and `docs/adding-a-provider.md`. The first review read all of them in full. No implement pass has touched them since, so their verdicts stand. Every carried-over MINOR was re-checked at its cited lines and is still present.

**Executed during this review** (nothing outside `specs/` was modified; build outputs are git-ignored and `git status` was the same before and after):
- **`pnpm vitest run`, twice:** 77 files and **550 tests passed** both times, but both runs **exited 1** on an unhandled Postgres error (F16).
- **`bootstrap.test.ts` alone, three times:** exit 0 each time.
- **The other gates:** `pnpm typecheck`, `pnpm lint`, `pnpm db:check` and the full `pnpm build` are all green. `.next/standalone/worker.mjs` is present and has 0 `next` imports.

## Verdict

**Not ready to merge, but the feature code is. The one blocker is in the test harness.**

T088 fixes F13 properly:
- Every first-step lease now re-stamps `publish_started_at` (`src/server/scheduler/publishing.ts:162`), so the call that can actually publish is the one counted.
- The own-row exclusion (`:120`) stops a retry deferring itself, and the release path (`:217`) restores the prior stamp.
- The new test reproduces the second review's exact case: B is deferred to `A's retry + 1 h`.
- I re-traced it against limit 2 and against recovery; no new gap.

With that fix, every FR is satisfied, and so is every SC that can be checked here.

What still blocks is the merge gate (F16). `pnpm test` exits 1 in both full runs this pass, even though every test passes:
- **Cause:** the throwaway-database teardown in `tests/helpers/db.ts:35-36` races `pg-pool`. `pool.end()` resolves before its clients have closed, so the forced `drop database` kills a live backend. The pool then emits an `error` that nothing listens for.
- **Where it lives:** the race is in 001 code, but CI runs `pnpm test` (`.github/workflows/ci.yml:63-64`). The constitution requires a green CI before merge (`.specify/memory/constitution.md:96`). T083 records the gate as green.
- **Fix:** a few lines in the test helper, appended as T089.

Ten MINORs remain:
- **Carried over:** F3–F10 and F14, all still present and all safe to ship.
- **New:** F17, contract drift.

## Findings

- [x] MAJOR F16 — `pnpm test` exits 1 although every test passes: tearing down a throwaway database leaves an unhandled `57P01` error, so the CI gate is red
      resolved: pool `error` listener in `src/server/db/client.ts` (commit "fix(db): keep the process alive when an idle database connection drops"); regression test `tests/integration/db-pool-error.test.ts` fails without it. Full suite 550/551 locally, the one failure an ESLint cold-start timeout fixed in "test(lint): allow for ESLint cold start".
      where:  tests/helpers/db.ts:34-37, tests/integration/anonymous-entry.test.ts:18-23, tests/integration/bootstrap.test.ts:15-17, node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:133-142, node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:172-188, node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:50-61, .github/workflows/ci.yml:63-64, .specify/memory/constitution.md:96-100, specs/002-scheduling-engine/tasks.md:229
      why:    What happened:
              - Both full `pnpm vitest run` invocations this pass ended `Test Files 77 passed / Tests 550 passed / Errors 1 error`, with exit code 1.
              - The error was `FATAL 57P01 terminating connection due to administrator command`, on a client of a `docket_tmp_…_test` database. Vitest attributed it to `bootstrap.test.ts` in run 1 and to `anonymous-entry.test.ts` in run 2.
              - Run alone, `bootstrap.test.ts` exits 0 in 3 of 3 runs. It is a timing race, and with this suite it fired 2 of 2 times.
            The mechanism, read from the `pg-pool` 3.14.0 source:
              - `drop()` runs `await pool.end()` and then `drop database … with (force)`.
              - While the pool is ending, `_pulseQueue` calls `_remove(item.client)` for idle clients with no callback. `_remove` drops the client from `_clients` synchronously and only *starts* `client.end()`.
              - So `pool.end()` resolves while the backend connections are still open. The forced drop then terminates them.
              - The pool's idle `error` listener (`makeIdleListener`, :50-61) re-emits the error as `pool.emit('error')`. No `error` listener is attached, so it is an uncaught exception.
            Why it blocks:
              - The cause is 001 test infrastructure, outside this diff. 002 roughly doubled the suite, which changes the timing.
              - CI runs `pnpm test` as a required step, and the constitution's quality gates require CI to be green before merge.
              - T083 ("`pnpm test` … all green") is ticked, so `tasks.md` currently overstates the gate.
      owed:   In `createThrowawayDb` (tests/helpers/db.ts:30-37), make the teardown immune to the race:
              - attach `pool.on("error", () => {})` to the throwaway pool before ending it, since the database is being destroyed and its connection errors are expected; or
              - wait for every client's `remove` event before the forced drop.
              Then confirm that two consecutive full `pnpm test` runs exit 0.
      traces: constitution "Development Workflow" (quality gates), T083

- [x] MAJOR F13 — **Resolved.** A publish-limit start is now counted at the attempt that may publish, not at the target's first-ever lease
      where:  src/server/scheduler/publishing.ts:116-121, src/server/scheduler/publishing.ts:161-162, src/server/scheduler/publishing.ts:213-217, tests/integration/scheduler/limits-retry.test.ts:60-81, docs/decisions.md:162-169
      why:    How the fix works:
              - `publishStartedAt: firstStep ? now : target.publishStartedAt` re-stamps every lease whose `step_state` is null: automatic retries, recovery retries, and a `continue` that returned no state.
              - Later steps of a multi-step publish keep the original stamp.
              - The deferral path never touches the stamp. A deadline release restores `lease.before.publishStartedAt` (:217), so work that never reached the provider is not counted.
            Verified by tracing:
              - **Limit 1/h, the F13 case:** A fails at 09:00 and publishes at 09:30. B is due at 10:00:30 and is deferred to exactly 10:30, which is what the new test asserts at :80.
              - **Limit 2/h:** B starts at 09:00:10 and A's retry at 09:01, so C is deferred to 10:00:10. Never 3 in any hour.
              - **Recovery:** a step with `mayPublish = false` whose lease expired goes through `recoverExpiredLease` kind `retry` and is re-stamped. One with `mayPublish = true` becomes `ambiguous` and keeps its stamp, so it stays counted.
              All three `limits-retry.test.ts` cases pass in the full runs above.
      traces: FR-036, SC-009, US5-AS1

- [x] 🛑 BLOCKER F1 — **Resolved** (second review; untouched since). Cancel, delete, move, schedule-at and update refuse a target the scheduler has just claimed.
      where:  src/server/services/posts/index.ts:81-87, src/server/services/queue/index.ts:126-131, src/server/services/posts/index.ts:442-462, tests/integration/posts/claim-race.test.ts:21-55
      why:    Re-confirmed in this pass:
              - `lockPost` and `lockPostsOf` lock the post's target rows right after the post row.
              - `scheduleExplicit` still checks its guarded update (:459-462).
              - `claim-race.test.ts` passed in both full runs.
      traces: FR-021, FR-024, FR-026, FR-028, edge case "Cancelling a target mid-flight", constitution V

- [x] MAJOR F2 — **Resolved** (second review; refined by T088). An automatic retry is not deferred by its own start, and a user retry counts again.
      where:  src/server/scheduler/publishing.ts:119-121, src/server/dal/scheduler.ts:89-101, src/server/services/posts/index.ts:388-395, src/server/services/posts/index.ts:547-551
      why:    Both F2 reproductions are tests (limits-retry.test.ts:21-58), and both pass.
      traces: FR-033, FR-036, SC-008, SC-009

- [ ] MINOR F17 — The scheduler contract still describes the superseded limit rules (`publish_started_at ??= now`, and no own-row exclusion)
      where:  specs/002-scheduling-engine/contracts/scheduler.md:84-89, specs/002-scheduling-engine/research.md:69, specs/002-scheduling-engine/research.md:108, docs/decisions.md:162-169
      why:    The contract and the research doc (D8) disagree with the code in two ways:
              - **Stamp:** they say to stamp `publish_started_at` only when it is null, and the code re-stamps every first-step lease (T088).
              - **Count:** they count every target of the account, and the code excludes the checked target's own row (T087).
            `docs/decisions.md` records both changes, so the code is not undocumented. But `contracts/` is what a later entry (a real provider, or a second scheduler path) will build against, and it now reads as the old rule.
      owed:   Update `contracts/scheduler.md:85` and `:89`, and D8 in `research.md`, to match the decisions entry. Or add a pointer from each to `docs/decisions.md` "Limit counting".
      traces: FR-036, contracts/scheduler.md

- [ ] MINOR F14 — (carried over, unchanged) A scheduled post moved back to `needs_review` is still published by the tick
      where:  src/server/services/posts/index.ts:271-281, src/server/dal/scheduler.ts:62-75, specs/002-scheduling-engine/spec.md:329-330
      why:    `setReviewState` writes `review_state` but leaves `scheduled` targets as they are, and the claim never reads review state. The second review reproduced this: `{status: "scheduled", review: "needs_review"}` was then `published` by `runTick`. It has no caller in this feature; contracts/services.md:101 calls it a "minimal hook".
      owed:   Make `needs_review` refuse while any target is `scheduled` or `publishing`, or cancel those targets. Test the chosen behaviour and record it in `docs/decisions.md`.
      traces: edge case "A post in needs_review", FR-029

- [ ] MINOR F3 — (carried over, unchanged) A due target on a `needs_reauth` or unregistered-provider account fails with one generic message that never says to reconnect
      where:  src/server/scheduler/publishing.ts:101-106, docs/decisions.md:175
      why:    Removed accounts, `needs_reauth` accounts and missing providers all get "The account is no longer available for publishing.". US5-AS5 and contracts/providers.md each want a specific message, and the decisions log describes a message the code does not produce.
      owed:   Give each cause its own message, matching the service gate (posts/index.ts:137-146). Correct the decisions entry. Add a `runTick` test with an unknown `providerKey`.
      traces: FR-038, US5-AS5, US7-AS1, FR-048

- [ ] MINOR F4 — (carried over, unchanged) A token refresh in flight can write credentials back onto an account that was removed or reconnected meanwhile
      where:  src/server/scheduler/token-refresh.ts:64-77, src/server/dal/accounts.ts:142-155
      why:    `recordRefresh` is guarded only by `refresh_lease_owner`, and neither `markRemoved` nor `upsertConnected` clears that lease.
      owed:   Guard `recordRefresh` with `removed_at IS NULL`, and have remove and reconnect clear the refresh lease.
      traces: FR-037, FR-001

- [ ] MINOR F5 — (carried over, unchanged) `refreshCredentials` has no hard timeout, unlike `advance`
      where:  src/server/scheduler/token-refresh.ts:55-60, src/server/scheduler/publishing.ts:241-258, src/server/scheduler/index.ts:39-42
      why:    Token refresh passes only an `AbortSignal`. A provider that ignores the signal holds up `runTick` with no time bound.
      owed:   Wrap the call in the same `withTimeout` race that `advance` uses.
      traces: FR-030, FR-037

- [ ] MINOR F6 — (carried over, unchanged) The DAL's `releaseLease` and `recordWithLease` are dead, and the scheduler re-implements both inline with different behaviour
      where:  src/server/dal/scheduler.ts:189-213, src/server/scheduler/publishing.ts:213-220, src/server/scheduler/record.ts:126
      why:    The exported `releaseLease` restores neither `status`, `first_step_at` nor `publish_started_at`. After T088, a caller that used it would leave a re-stamped start counted against the limit.
      owed:   Delete both exports, or route `publishing.ts` and `record.ts` through them with the restore semantics.
      traces: constitution IV, contracts/dal.md

- [ ] MINOR F7 — (carried over, unchanged) `refresh.test.ts` depends on which of the two concurrent sections claims the account first
      where:  tests/integration/scheduler/refresh.test.ts:40-59, src/server/scheduler/index.ts:39-42
      why:    It is a latent CI flake. It did not fire in either run this pass.
      owed:   Run the refresh in its own tick before creating the due target, or set `needs_reauth` directly for the FR-038 half.
      traces: FR-037, FR-038 (test integrity)

- [ ] MINOR F8 — (carried over, unchanged) A `publishing` target whose lease expired during a step that may have published can be cancelled before recovery marks it `ambiguous`
      where:  src/server/services/posts/cancel.ts:16-23, src/server/services/posts/index.ts:529-535, specs/002-scheduling-engine/data-model.md:241
      why:    Cancel clears `in_flight_may_publish`, so the "may have gone out" signal is lost (FR-035).
      owed:   Treat an expired lease with `in_flight_may_publish = true` as not cancellable, or as ambiguous on cancel.
      traces: FR-035, constitution V

- [ ] MINOR F9 — (carried over, unchanged) No way to preview an explicit time's proximity warning before scheduling
      where:  src/server/services/posts/index.ts:323-353, src/server/services/posts/index.ts:468
      why:    US4-AS10 wants the warning "when the user schedules **or previews**". The warning is computed only after the write.
      owed:   A read-only `previewScheduleAt(scope, postId, { at, targetIds? })`.
      traces: US4-AS10, FR-022, FR-025

- [ ] MINOR F10 — (carried over, unchanged) The implementation is entirely uncommitted, contrary to the constitution's per-task commit rule
      where:  .specify/memory/constitution.md:84-86
      why:    `git rev-list --count a74a9cc..HEAD` is 2, and both commits are spec artifacts. All 124 implementation files are uncommitted or untracked.
      owed:   After the remediation implement pass, commit by task group with explicit paths and conventional types.
      traces: constitution "Development Workflow"

- NOTE F18 — A multi-step publish is counted at its **first** step (research D8, "publishes started"), not at its later `mayPublish` step:
  - So a target whose first step is more than one window old drops out of the count while it is still in flight. Example: a container created at 09:00 is held up by `rate_limited` replies on its publish step until 10:15, so another target may start at 10:01.
  - This matches FR-036 as written, and no shipped provider has a long multi-step flow, so it is not a defect today.
  - The code comment at src/server/scheduler/publishing.ts:161 ("the attempt that may publish is what counts") holds only for single-step providers.
  - Worth revisiting when the first real multi-step provider (e.g. container → publish) lands: count in-flight targets regardless of how old their start is.

- NOTE F11 — (re-confirmed) Lock order, read across every caller in this pass, has no cycle between the tick and any service:
  - **Services:** post, then that post's targets (src/server/services/posts/index.ts:81-87, src/server/services/queue/index.ts:126-131).
  - **Record step:** post, then target (src/server/scheduler/record.ts:125-126).
  - **Claim:** `SKIP LOCKED` on targets and accounts, and no post lock (src/server/dal/scheduler.ts:75, :84).

- NOTE F12 — (carried over) The SC-002 test (`tests/integration/scheduler/concurrency.test.ts:45`) runs its 5 parallel ticks on the shared pool, not the pool of 20 that T043 described. It still gives real parallel connections and 0 duplicate `done` rows.

- NOTE F15 — (carried over) `scheduleAt` / `publishNow` without `targetIds` silently skip a target that is mid-publish (src/server/services/posts/index.ts:422). Passing `targetIds` reports it as `not_queueable`. Entry 3's composer should pass `targetIds` if it needs a result row per target.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checked |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-048) | 48 | 48 | 0 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-013) | 13 | 12 | 0 | 0 | 0 | 1 (SC-013, needs Docker) |
| User stories (acceptance scenarios) | 7 | 5 (US1, US2, US3, US6, US7) | 2 (US4 → F9; US5 → F3) | 0 | 0 | 0 |
| Edge cases (spec.md:305-354) | 18 | 17 | 1 ("A post in needs_review" → F14) | 0 | 0 | 0 |
| Constitution (I–VII + Engineering constraints + Workflow) | 9 | 8 | 1 (Workflow → F16 quality gate, F10 commits) | 0 | 0 | 0 |

How each was judged:
- **Satisfied:** the code path was read in this pass or an earlier one, and a test that exercises it ran in this pass. All 550 tests passed in both full runs. The exit code 1 comes from F16's teardown error, not from any assertion.
- **Partial:** a reproduced or code-cited defect in an otherwise implemented obligation.
- **Moved since the second review:**
  - FR-036 and SC-009 moved from Partial to Satisfied (F13 resolved).
  - US5 is still Partial, now for F3 alone.
  - Constitution "Workflow" is still Partial, now for F16 as well as F10.

## What I could not check

- **SC-013 / T084, `docker compose up`.** There is no Docker daemon access from this sandbox, so the web healthcheck, the worker start-up and the indicator showing a tick within two minutes are unobserved.
- **Neon / research U1 / T085.** No Neon URL is available, so transaction-mode pooling is unverified end to end.
- **How often F16 fires in CI.** It fired in 2 of 2 local full runs this pass and 0 of 1 in the second review. CI's Postgres service has different timing. The fix makes the rate irrelevant, but I have not observed a CI run.
- **The in-process loop under a real `next start`, and the tick endpoint over real HTTP.** Neither ran; only their unit and handler tests did (`src/server/scheduler/http.test.ts`, `tests/integration/tick-endpoint.test.ts`).
- **Contention behaviour of the post-service target locks under load.** It was not measured.
- **Visual and assistive-technology checks of the health banner.** Not done in a browser.
