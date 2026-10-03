# Review: Docket Scheduling Engine (002), fourth pass

Reviewed 140 files changed across 18 commits, diffed against `a74a9cc...HEAD` (merge-base with `origin/main`; `git fetch` was refused, so the local `origin/main` ref was used). This is the first review of the implementation **as committed**: the prior three reviewed an uncommitted working tree (old F10). This is a fresh read of the whole body, not a delta.

- **Read in full:**
  - **Scheduler:** `src/server/scheduler/{publishing,record,recovery,limits,index,config,token-refresh,http,loop,in-process,schema-wait,redact,backoff}.ts`, `src/worker.ts`, `src/instrumentation.ts`, `src/app/api/internal/tick/route.ts`.
  - **DAL:** `src/server/dal/{scheduler,targets,accounts,posts,slots,scope,clock,attempts,heartbeats,schema-ready,media,index,errors}.ts`.
  - **Services:** `src/server/services/posts/{index,cancel,status,content}.ts`, `src/server/services/queue/{index,occurrences}.ts`, `src/server/services/{accounts,slots,media,scheduler-health}.ts`.
  - **Providers:** `src/providers/{types,validation,registry,text,errors}.ts`, `src/providers/mock/{index,settings}.ts`.
  - **Schema:** `src/server/db/schema/{posts,accounts}.ts`.
  - **UI:** `src/components/shell/SchedulerHealth.tsx`.
  - **Diffs:** the diffs of `src/server/{env,db/client,db/project-owned,auth/access}.ts`, `src/lib/{auth-gate,action-result}.ts`, `src/app/p/[projectSlug]/layout.tsx`, `docker-compose.yml`, `README.md`, `docs/decisions.md`.
  - **Spec artifacts:** `spec.md`, `plan.md`, `tasks.md`, `contracts/{scheduler,dal}.md`, the constitution.
- **Sampled:**
  - tests: `tests/integration/scheduler/{concurrency,budget,refresh}.test.ts`, `tests/integration/queue/{actions,concurrency}.test.ts`, `tests/helpers/{scheduling,posts-env,db}.ts`, `tests/setup/global-setup.ts`;
  - `drizzle/0001_fixed_susan_delgado.sql` (checks and indexes);
  - `research.md` D8.
- **Not reviewed this pass:**
  - `drizzle/meta/0001_snapshot.json` (generated; `pnpm db:check` vouches for it);
  - `docs/adding-a-provider.md`, `.env.example`, `contracts/{providers,services,env}.md`, `data-model.md`, `quickstart.md`;
  - the remaining test files.

  The first review read all of these in full, and no commit since then touches them except a one-line edit to `contracts/providers.md`.

**Executed during this review.** Nothing was written outside `specs/`. Scratch tests lived only in `$TMPDIR`, and `git status` was clean before and after.

- **The gates:**
  - `pnpm typecheck`, `pnpm lint` and `pnpm db:check` all exit 0.
  - `pnpm test`: **78 files and 551 tests passed, exit 0.** So F16 is resolved in practice.
  - `pnpm build` was not re-run. Per a teammate's request, CI owns it.
- **Four scratch tests** against the real test database, run through a `$TMPDIR` Vitest config. They reproduced F19, F20, F21 and F22 below; the exact numbers are quoted in each finding.

## Verdict

**Not ready to merge: two MAJOR defects in the queue, both reproduced. The scheduler tick itself holds up.**

**What holds up.** I re-traced the cross-pass seams that earlier reviews fixed, and they are coherent in the committed code:
- **Claim → lease → advance → record.** The lease token guards the record; the claim skips locked rows.
- **Lock order** has no cycle between the tick and the post services.
- **Limit counting** follows T087/T088.
- **Status derivation** runs after every target change.

Every FR has an implementation, and the tick's guarantees (concurrency, kill-recovery, budget, no retry of ambiguous targets) are tested with real assertions.

**What blocks.** Both blockers are in the queue (US4), and both break a rule the spec states in absolute terms:
- **F19, pull-forward.** "Pull the queue forward" moves targets **later**, and cascades the delay down the queue, whenever one of them holds an occurrence of a slot that has since been paused or deleted. This contradicts FR-021 ("never later than their current time") and the paused-slot edge case.
- **F20, multi-account queueing.** Queueing multi-account posts concurrently **deadlocks**: 25 of 60 requests failed with `40P01` in my reproduction. This contradicts FR-018 / US4-AS1 ("none fails because of the race"). The SC-003 test missed it because it only queues single-account posts.

Each needs a few lines plus a test, appended as T090 and T091.

**What remains, and is safe to ship.**
- **New MINORs:**
  - F21: an engine-side failure before the provider call is recorded as `ambiguous`.
  - F22: cancelling a draft target silently clears `needs_review`.
- **Carried MINORs, all re-checked at their lines:** F3–F9, F14 and F17.

## Findings

- [ ] MAJOR F19 — `pullQueueForward` moves queued targets *later* when one holds an occurrence of a paused or deleted slot, and every target after it moves later too
      where:  src/server/services/queue/index.ts:192-205, src/server/services/queue/index.ts:39, src/server/services/slots.ts:38, specs/002-scheduling-engine/spec.md:207, specs/002-scheduling-engine/spec.md:312-314, tests/integration/queue/actions.test.ts:87-116
      why:    How the walk works:
              - `pullQueueForward` releases every queued occurrence (:192), then re-allocates each target in order with `allocateNextFree(…, { after })` (:197).
              - It accepts whatever comes back (:198-200). Its only fallback is for "nothing free in the horizon" (:201-205).
              - `allocateNextFree` draws candidates from `listActiveForAccount` (:39), so an occurrence of a **paused** slot is never offered. A **deleted** slot's occurrence is not offered either: `slot_id` goes NULL by the FK (slots.ts:38).
              - So a target sitting on such an occurrence cannot get its own time back. It takes the next active occurrence, which can be later, and then `after` pushes every later target later as well.
            Reproduced (UTC project, now = Thu 2026-10-01 12:00, slots Mon 09:00 and Wed 09:00):
              - queued t1 = Mon 10-05, t2 = Wed 10-07, t3 = Mon 10-12;
              - paused the Wed slot, then pulled forward;
              - result `moved` = t2 10-07 → **10-12**, and t3 10-12 → **10-19**.
            Why it matters:
              - This breaks FR-021, US4-AS9 ("no target moves later than it was") and the edge case "Pausing or deleting a slot … those targets keep their times".
              - Entry 3 will put this action behind a button, and pausing a slot is an ordinary owner action.
              - No test covers a paused or deleted slot (actions.test.ts:87-116).
      owed:   Never accept a candidate later than the target's current instant `from`:
              - peek first; if the earliest free occurrence after `after` is later than `from`, or there is none, re-hold `from` (with its current `slot_id`, which may be null) and set `after = from`.
              - Add tests to `tests/integration/queue/actions.test.ts` for a paused-slot target and a deleted-slot target: both keep their times, and the targets after them still move only earlier.
      traces: FR-021, US4-AS9, edge case "Pausing or deleting a slot"

- [ ] MAJOR F20 — Concurrent `addToQueue` calls for posts aimed at two or more shared accounts deadlock, and the losing request fails with `40P01` instead of taking the next occurrence
      where:  src/server/services/posts/index.ts:369-383, src/server/dal/targets.ts:62-67, src/server/dal/targets.ts:114-133, src/server/services/queue/index.ts:85-90, tests/integration/queue/concurrency.test.ts:25-40
      why:    The mechanism:
              - `addToQueue` allocates a post's targets in `listForPost` order: `created_at, id` (targets.ts:62-67).
              - Targets inserted by one `insertMany` share `created_at`, so the account order is effectively random per post (random UUIDs).
              - Each `tryHoldOccurrence` (targets.ts:114-133) writes a uniquely indexed `(account, instant)`. A second transaction that wants the same instant waits for the first to commit, which is how FR-018 is meant to work.
              - But take tx1 holding (A, X) and wanting (B, Y), while tx2 holds (B, Y) and wants (A, X). That is a wait cycle.
              - Postgres aborts one of them with `40P01`. `tryHoldOccurrence` only maps `23505`, so the error escapes and the whole request fails.
            Reproduced:
              - 2 mock accounts with 21 weekly slots each, and 5 bursts of 12 concurrent `addToQueue` calls, each post targeting both accounts.
              - **25 of 60 requests rejected with `40P01 deadlock detected`.**
            Why it matters:
              - US4-AS1 and FR-018 require that a request losing the race moves on and does not fail. Posts aimed at several accounts are the product's core case.
              - "A person and a generation job" queueing at once is the spec's own example (spec.md:172-174).
              - The SC-003 test queues single-account posts only, so it cannot see this.
      owed:   Acquire occurrences in one global order:
              - in `addToQueue`, process the chosen targets sorted by `social_account_id` (one target per account per post, so this removes the cross-account cycle);
              - optionally, retry the transaction once on `40P01`/`40001` as a backstop.
              Test it: add a case to `tests/integration/queue/concurrency.test.ts` with ≥ 10 concurrent posts each aimed at the same 2–3 accounts, repeated, asserting every result is `ok: true` and no occurrence is held twice.
      traces: FR-018, US4-AS1, SC-003

- [ ] MINOR F21 — An engine-side failure *before* the provider is called (credential decryption, content load, settings parse) is recorded as `ambiguous` on a may-publish step
      where:  src/server/scheduler/publishing.ts:233-263
      why:    Why it happens:
              - The `try` that classifies a lost call by `mayPublish` (:259-263) also wraps `effectiveContent` (:234-235), `decryptCredentials` (:236-238) and `settingsSchema.parse` (:239).
              - So a failure that never reached the platform is reported as "may have gone out".
            Reproduced:
              - A due target on a mock account whose stored ciphertext cannot be decrypted ended `ambiguous` with "Secret could not be decrypted".
              - The provider was never called. Counts: `ambiguous: 1, done: 0`.
            Impact:
              - Safe, because nothing duplicates. But one misconfigured `CREDENTIALS_ENCRYPTION_KEY` would turn every due post on credentialed accounts into a manual "check the platform" task.
              - It also contradicts the spec's rule that `ambiguous` is for a step whose outcome cannot be known (edge case "A provider throws").
      owed:   Do the pre-call work outside the `try` that wraps `advance`, and record those failures as `fatal_error` (or `retryable_error`) with a clear message. Only a throw or timeout from `advance` itself should use `mayPublish`. Add a `runTick` test with undecryptable credentials.
      traces: FR-011, FR-034, edge case "A provider throws instead of returning a result"

- [ ] MINOR F22 — Cancelling a *draft* target of a `needs_review` post resets the post to `draft`, so it can then be queued without approval
      where:  src/server/services/posts/cancel.ts:26-31, src/server/services/posts/index.ts:527-537, src/server/services/posts/index.ts:159-167, src/server/services/accounts.ts:177, specs/002-scheduling-engine/spec.md:329-330
      why:    Why it happens:
              - `resetEmptyReview` sets `review_state = 'draft'` whenever every target is `draft` or `cancelled`.
              - That is also true when the post never had a live target.
            Reproduced: a `needs_review` post with two draft targets; cancel one, and `reviewState` becomes `draft`, after which `addToQueue` schedules the other (`ok: true`).
            Impact: no caller sets `needs_review` in this feature, and editors can approve directly, so it is safe now. But it is the second hole (with F14) in the review gate that the generator entry will rely on. The same helper runs on `removeAccount`.
      owed:   Reset to `draft` only when the cancel took the post from having a live target (`scheduled`/`publishing`) to none, or never lower `needs_review`. Test both paths.
      traces: edge case "A post in needs_review", edge case "All targets of a post cancelled", FR-029

- [ ] MINOR F17 — (carried over, unchanged) The scheduler contract still describes the superseded limit rules (`publish_started_at ??= now`, no own-row exclusion)
      where:  specs/002-scheduling-engine/contracts/scheduler.md:85, specs/002-scheduling-engine/contracts/scheduler.md:89, specs/002-scheduling-engine/research.md:108, docs/decisions.md:162-169
      why:    The code re-stamps every first-step lease (publishing.ts:162) and excludes the checked target's own row (publishing.ts:120). `docs/decisions.md` records both; `contracts/` and D8 do not.
      owed:   Update `contracts/scheduler.md:85,:89` and research D8, or point both at the decisions entry.
      traces: FR-036

- [ ] MINOR F14 — (carried over, unchanged) A scheduled post moved back to `needs_review` is still published by the tick
      where:  src/server/services/posts/index.ts:271-281, src/server/dal/scheduler.ts:62-75
      why:    `setReviewState` leaves `scheduled` targets in place, and the claim never reads review state.
      owed:   Refuse `needs_review` while any target is `scheduled`/`publishing`, or cancel those targets. Test the chosen behaviour.
      traces: edge case "A post in needs_review", FR-029

- [ ] MINOR F3 — (carried over, unchanged) A due target on a `needs_reauth` or unregistered-provider account fails with one generic message that never says to reconnect
      where:  src/server/scheduler/publishing.ts:101-106, docs/decisions.md:176
      why:    All three causes get "The account is no longer available for publishing." US5-AS5 wants "must be reconnected", and the decisions log quotes a "Reconnect … to publish" message the code does not produce.
      owed:   Give each cause its own message, matching the service gate (posts/index.ts:139-146), and fix the decisions entry.
      traces: FR-038, US5-AS5, US7-AS1

- [ ] MINOR F4 — (carried over, unchanged) A token refresh in flight can write credentials back onto an account that was removed or reconnected meanwhile
      where:  src/server/scheduler/token-refresh.ts:64-77, src/server/dal/accounts.ts:142-155
      why:    `recordRefresh` is guarded only by `refresh_lease_owner`. `markRemoved` and `upsertConnected` do not clear the refresh lease.
      owed:   Guard `recordRefresh` with `removed_at IS NULL`, and clear the refresh lease on remove and on reconnect.
      traces: FR-037, FR-001

- [ ] MINOR F5 — (carried over, unchanged) `refreshCredentials` has no hard timeout, unlike `advance`
      where:  src/server/scheduler/token-refresh.ts:55-60, src/server/scheduler/publishing.ts:193-199
      why:    Only an `AbortSignal` is passed. A provider that ignores it holds `runTick` open with no bound.
      owed:   Wrap the call in the same `withTimeout` race.
      traces: FR-030, FR-037

- [ ] MINOR F6 — (carried over, unchanged) The DAL's `releaseLease` and `recordWithLease` are dead and differ from the inline versions the scheduler actually uses
      where:  src/server/dal/scheduler.ts:189-213, src/server/dal/index.ts:37-38, src/server/scheduler/publishing.ts:213-220, src/server/scheduler/record.ts:126
      why:    The exported `releaseLease` restores neither `status`, `first_step_at` nor `publish_started_at`, so a future caller would leave a start counted against the limit.
      owed:   Delete both exports, or route the scheduler through them with the restore semantics.
      traces: constitution IV

- [ ] MINOR F7 — (carried over, unchanged) `refresh.test.ts` still depends on the token-refresh section flagging the account before the concurrent publishing section claims its due target
      where:  tests/integration/scheduler/refresh.test.ts:40-59, src/server/scheduler/index.ts:39-42
      why:    If publishing claims the target first, it publishes (mock `succeed`) and :56 fails. The second `runTick` added at :54 does not help, because the target is then already `published`. It did not fire this pass.
      owed:   Run the refresh in its own tick before creating the due target, or set `needs_reauth` directly for the FR-038 half.
      traces: FR-037, FR-038 (test integrity)

- [ ] MINOR F8 — (carried over, unchanged) A `publishing` target whose lease expired during a may-publish step can be cancelled before recovery marks it `ambiguous`
      where:  src/server/services/posts/index.ts:527-537, src/server/services/posts/cancel.ts:16-23, src/server/services/accounts.ts:171-176
      why:    Cancel clears `in_flight_may_publish`, so the "may have gone out" signal is lost (FR-035).
      owed:   Treat an expired lease with `in_flight_may_publish = true` as not cancellable, or as ambiguous on cancel.
      traces: FR-035, constitution V

- [ ] MINOR F9 — (carried over, unchanged) No way to preview an explicit time's proximity warning before scheduling
      where:  src/server/services/posts/index.ts:323-353, src/server/services/posts/index.ts:468
      why:    US4-AS10 says "schedules **or previews**". The warning is computed only after the write.
      owed:   A read-only `previewScheduleAt(scope, postId, { at, targetIds? })`.
      traces: US4-AS10, FR-022

- [x] MAJOR F16 — **Resolved.** `pnpm test` exited 1 on an unhandled `57P01` from throwaway-database teardown
      where:  src/server/db/client.ts:31-36, tests/integration/db-pool-error.test.ts:1-29
      why:    The pool `error` listener in `createDatabase` covers the throwaway pools as well (tests/helpers/db.ts:30). The full suite exited 0 this pass (78 files, 551 tests).

- [x] MINOR F10 — **Resolved.** The implementation is now committed in 14 conventional implementation commits (`812668e`…`7a2a4f4`, plus `360913c`).
      where:  .specify/memory/constitution.md:84-86

- [x] MAJOR F13 / MAJOR F2 / 🛑 BLOCKER F1 — **Resolved** (earlier passes); re-confirmed in the committed code
      where:  src/server/scheduler/publishing.ts:116-129, src/server/scheduler/publishing.ts:161-162, src/server/services/posts/index.ts:81-87, src/server/services/queue/index.ts:126-131
      why:    Re-confirmed:
              - first-step leases re-stamp `publish_started_at`, and the own-row exclusion holds;
              - post services lock the post's target rows right after the post row, so a claimed target is refused;
              - `claim-race.test.ts` and `limits-retry.test.ts` passed in the full run.

- NOTE F23 — When every row in a claim batch belongs to an account another tick has locked, the batch comes back empty and the publishing loop exits (src/server/scheduler/publishing.ts:168, src/server/dal/scheduler.ts:108).
  - Due targets on *other* accounts, further down the order, then wait for the next tick.
  - This costs throughput (at most one interval of delay), not correctness. Worth revisiting if one account ever floods the head of the due queue.

- NOTE F18 — (carried) A multi-step publish is counted at its first step (research D8). So a target held between steps for longer than the window drops out of the limit count while it is still in flight. No shipped provider has a long multi-step flow; revisit with the first real container → publish provider.

- NOTE F11 — (re-confirmed) Lock order has no cycle between the tick and any service:
  - services lock the post, then its targets (posts/index.ts:81-87);
  - the record step locks the post, then the target (record.ts:125-126);
  - the claim uses `SKIP LOCKED` on targets and accounts and never waits (dal/scheduler.ts:75, :84);
  - `removeAccount` locks the account first, which makes claims skip it (accounts.ts:167).

  F20 is a cycle *among queue requests*, not with the tick.

- NOTE F12 — (carried) The SC-002 test runs its 5 parallel ticks on the shared pool (tests/integration/scheduler/concurrency.test.ts:45), not a dedicated pool of 20 as T043 described. It still gets real parallel connections and asserts 0 duplicate `done` rows across 20 repetitions.

- NOTE F15 — (carried) `scheduleAt` / `publishNow` without `targetIds` silently skip a target that is mid-publish (src/server/services/posts/index.ts:422). Entry 3's composer should pass `targetIds` when it needs a result row per target.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checked |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-048) | 48 | 46 | 2 (FR-018 → F20; FR-021 → F19) | 0 | 0 | 0 |
| Success criteria (SC-001–SC-013) | 13 | 12 | 0 | 0 | 0 | 1 (SC-013, needs Docker) |
| User stories (acceptance scenarios) | 7 | 5 (US1, US2, US3, US6, US7) | 2 (US4 → F19, F20, F9; US5 → F3) | 0 | 0 | 0 |
| Edge cases (spec.md:305-354) | 18 | 16 | 2 ("Pausing or deleting a slot" → F19; "A post in needs_review" → F14, F22) | 0 | 0 | 0 |
| Constitution (I–VII + Engineering constraints + Workflow) | 9 | 9 | 0 | 0 | 0 | 0 |

How each was judged:
- **Satisfied:** the code path was read in this pass, and a test exercising it passed in this pass's full run.
- **SC-003:** counted Satisfied *as measured*, since the 50-way single-account test passes 20 of 20 runs. F20 shows that the property it stands for does not hold for multi-account posts.
- **Constitution "Workflow":** moved to Satisfied. F10 is resolved by the commits and F16 by a green `pnpm test`. `pnpm build` was not re-run here.

## What I could not check

- **SC-013 / T084, `docker compose up`.** There is no Docker daemon in this sandbox, so the web healthcheck, the worker start-up and "indicator shows a tick within two minutes" are unobserved.
- **Neon / research U1 / T085.** No Neon URL is available.
- **`pnpm build` and the `worker.mjs` no-`next` check.** Not re-run this pass, at a teammate's request (CI runs it). The previous pass saw the build green and the bundle free of `next` imports, and no commit since then touches build inputs except `src/server/db/client.ts`.
- **CI itself.** I did not see a CI run of this branch. The local suite was green once this pass; F7 is a known latent flake.
- **The in-process loop under a real `next start`, and the tick endpoint over real HTTP.** Only their unit and handler tests ran.
- **The health banner in a browser.** No visual or assistive-technology check was done; only server-rendered HTML is tested.
- **How often F20 occurs in production.** That depends on real concurrency. I measured it only in a synthetic 12-way burst.
