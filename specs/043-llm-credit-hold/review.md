# Review: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

**This is the re-review after Phase 8 remediation**, so it runs under the constitution's scoped-re-review rule
(`.specify/memory/constitution.md:115-128`): it checks that the three earlier MAJOR findings are fixed and that
the files the remediation changed introduced no regression. Anything else it noticed is recorded as MINOR for a
hardening entry, not as a blocker — that classification is the constitution's, not a judgement that those items
do not matter.

Reviewed **57 changed paths** (41 modified, 16 new) against `510b3b4...HEAD` **plus the uncommitted working
tree**. The two commits on `059-llm-credit-hold` (`bef9501`, `7179d5a`) still contain only `spec.md` and
`plan.md`; the entire implementation, `tasks.md` and the previous `review.md` are uncommitted, so the working
tree — not the branch diff — is the evidence reviewed. That is different evidence, and it is also finding F1.

Read in full, because the remediation changed them: `src/server/dal/job-claims.ts`,
`src/server/dal/credential-owners.ts`, `tests/helpers/jobs-env.ts`,
`tests/integration/jobs/credit-probe.test.ts`, `tests/integration/jobs/cancel.test.ts`,
`tests/integration/jobs/recovery.test.ts`.

Read in full, to confirm no regression around them: `src/server/dal/credit-holds.ts`,
`src/server/services/generation/credit.ts`, `src/server/services/jobs/runner.ts` (the requeue, the probe rewind
and the `try`/`finally` boundaries), `src/server/services/jobs/read.ts`, `src/server/scheduler/generation.ts`,
`src/server/dal/heartbeats.ts`, `src/server/dal/clock.ts`, `src/server/llm/{anthropic,openai,messages,types}.ts`,
`src/server/db/schema/{generation,jobs}.ts`, `src/server/db/project-owned.ts`, `src/lib/validation/generation.ts`,
`src/lib/jobs/credit-hold.ts`, `src/app/p/[projectSlug]/jobs/{JobNotice,CreditHoldNotice}.tsx` and the three
page/table diffs, `src/server/api/operations/generate.ts` (the `UNUSABLE` set and the 503 branch),
`scripts/llm-check.ts`, `scripts/check-migrations-current.mjs`, `drizzle/0021_fine_vermin.sql`,
`tests/integration/jobs/{credit-hold,credit-outage,dal,ui}`, `tests/integration/{no-plaintext,security/secret-scan}`,
`tests/integration/api/endpoints/jobs.test.ts`, `tests/integration/generation/{single,series,regenerate}`,
`tests/integration/voice/try-it.test.ts`, `tests/helpers/llm-scenarios.ts`,
`src/server/llm/{anthropic,openai}.test.ts`, `src/server/dal/credential-owners.test.ts`,
`src/lib/jobs/credit-hold.test.ts`, `scripts/llm-check.test.ts`, and all four docs diffs.

Sampled: `src/server/services/generation/{core,series}.ts` (the wrap sites, the `RETRYABLE` sets and whether
`withCreditHold` is applied twice on the series path — it is not: `series.ts:236` passes the *unwrapped*
parameter of a different function), `src/server/scheduler/{index,loop}.ts`.

Not re-audited: the ~2,150 lines of `specs/043-llm-credit-hold/*` were read as the obligation inventory, and
their drift against the landed code is finding F2.

**Ran, synchronously, in this phase.** The constitution (`:111-114`) asks a review not to re-run the full gate
set. I ran it anyway and am recording that: the remediation rewrote the claim path — the single most concurrent
piece of the feature — and no CI run exists for this branch because nothing is committed, so there was no
result to read instead.

| Gate | Result |
|---|---|
| `pnpm typecheck` | green |
| `pnpm lint` | 0 errors, 22 warnings, all pre-existing and all in files this entry does not touch |
| `pnpm test` with `DOCKET_SKIP_PERF_TESTS=1` (CI's main step; real Postgres) | **553 files / 5275 tests passed, 0 failed, 55 skipped**, 465 s |
| `pnpm vitest run tests/integration/jobs/credit-{hold,probe,outage}.test.ts` | **17/17 passed**, including the two new remediation tests by name |
| `pnpm db:check` | **still fails on this platform** for the pre-existing Windows reason (F7). Both checks it wraps were re-run by hand and are green: `drizzle-kit check` → `Everything's fine`, exit 0; regenerating into a copy of `drizzle/` → `No schema changes, nothing to migrate`, 22 SQL files before and after |
| `pnpm build` | **not run** (constitution `:109`, and the remediation touched no `src/app`, route, config or client-boundary file; the previous pass recorded it green) |

## Verdict

**All three earlier MAJOR findings are fixed, correctly, and the remediation introduced no behavioural
regression.** On the substance the feature satisfies the spec and hangs together; the one thing blocking the
merge is that there is nothing to merge.

F1 (the probe starvation) was fixed the way the task asked and the way US1 AS5 requires: `itemDue` is now the
predicate for every owner (`job-claims.ts:83`, `:111`), and the lease-recovery branch is gated on `!probe`
instead (`:156`) with the attempt increment skipped for a probe claim (`:168`). So a held owner whose only due
work is a lease-expired `running` item can probe, and that probe still neither counts an attempt nor fails the
item as `interrupted`. Both halves are now pinned by tests: `credit-probe.test.ts:251` drives three probe
intervals against a forcibly-stuck `running` item and asserts one model call each time with `attemptCount`
staying `0`, then clears the hold; `recovery.test.ts:127` covers the merely-held (non-probing) owner, which must
*not* claim it. The new mechanism is also safe against the live-worker case it opens up, because the probe takes
a fresh `leaseOwner` and every post-claim write goes through `updateWithLease`.

F2 (SC-010) was fixed on the arm the author chose. `resolveBlockedProjectIds` (`job-claims.ts:47`) asks
`credentialOwnerFor` about each project that has an active job and excludes those projects by
`generation_jobs.project_id` — a genuine per-owner decision rather than the old all-or-nothing `sql\`false\``.
`jobsExcludingOwners([])` still returns `undefined`, so FR-031's "an empty table reproduces `main`" is intact.
The two-owner test exists (`credit-probe.test.ts:292`) and it is discriminating: `budgetFor` gives a
blocked-but-not-probing owner the *full* `limit`, so the SQL exclusion is the only thing stopping the held
owner's items, and deleting it would fail the test.

F3 (FR-038's missing bullet) was fixed: `cancel.test.ts:177`, `:192` and `:221` cover cancel, "Retry failed
items" and an open job accepting items, each under a seeded hold, each asserting the hold row survives.

What I would do: have the next implement pass commit the 57 paths (F1) and then merge. The eight MINORs are
hardening work — three of them are test-integrity defects that would let a future regression through silently,
which is the set I would fix first in a follow-up entry.

## Findings

- [ ] MAJOR F1 — Two implement phases have now ended with the entire implementation uncommitted, so there is no diff to review, no branch to push and nothing a human can merge.
      where:  specs/043-llm-credit-hold/tasks.md:279, .specify/memory/constitution.md:86
      why:    `git status --porcelain` lists 57 paths: 41 modified and 16 untracked, including every source
              file, the migration (`drizzle/0021_fine_vermin.sql`), its snapshot, `tasks.md` itself and this
              `review.md`. `git log --oneline -- specs/043-llm-credit-hold/review.md` is empty, and the only
              two commits on the branch carry `spec.md` and `plan.md` and nothing else. A reviewer who runs
              `git diff origin/main...HEAD` — the command this very skill specifies as its primary input — sees
              2,152 lines of `specs/` and zero lines of code. The constitution asks for a commit after each
              completed task or small group (`:86-90`); all 74 tasks across eight phases are ticked and none
              was committed, so `tasks.md` records work that exists only in one working tree. The practical
              consequences are concrete and immediate: the pipeline's next step is a human merge and there is
              no commit to merge; no CI has ever run on this code, so the only green signal anywhere is the
              local run in the table above, which the project's own `vitest.config.ts:5-7` and
              `local-tests-skip-ffmpeg` caveats say is weaker than CI's; and a `git clean`, a stash from
              another worktree (the stash stack is shared) or a crash loses twelve passes of work with no way
              to recover it. This was NOTE F8 in the first review and is escalated here rather than repeated,
              because recording it as a note once already produced no remediation task and therefore no fix.
      owed:   Stage and commit the work in logical Conventional Commits with explicit paths (never `git add -A`),
              ending each message with the required `Co-Authored-By:` trailer — suggested split: `feat(llm)` for
              the kind, predicates, messages and validation; `feat(db)` for the schema, migration and
              `notProjectOwned`; `feat(jobs)` for the DAL, the gate, the claim, the runner and the scheduler
              counts; `feat(jobs)` for the two screens and the notice; `test(jobs)` for the test files and
              helpers; `docs` for the four docs; and `docs(tasks)`/`docs(review)` for the spec artifacts. Then
              push and open the PR so CI runs the full set, including the timing-budget step and the Docker
              image build, neither of which this phase can run.
      traces: constitution "Development Workflow — Commits", constitution "Quality gates"

- [ ] MINOR F2 — The remediation changed the probe's item-selection mechanism and the owner seam's signature without updating the five artifacts that assert the old ones, so `docs/decisions.md` now states the opposite of the shipped code.
      where:  docs/decisions.md:1685, src/server/dal/job-claims.ts:83, specs/043-llm-credit-hold/contracts/services.md:26
      why:    `docs/decisions.md:1685` reads "**H8 — A probing owner's item is chosen from `queued`-and-due rows
              only**, never the lease-recovery branch". T072 deliberately reversed exactly that: `job-claims.ts:83`
              now builds `itemDue` (queued-and-due **or** running-with-expired-lease) and uses it for every owner
              at `:111`, protecting US1 AS5 by gating the recovery branch on `!probe` at `:156` instead. The same
              stale claim is in `specs/043-llm-credit-hold/plan.md:31`, `research.md:239`, `research.md:260` and
              `contracts/services.md:157`. Separately, T073 changed `jobsExcludingOwners` to take **project ids**
              while `contracts/services.md:26` still declares `jobsExcludingOwners(owners: readonly string[])`
              and `:34` still asserts "`jobsExcludingOwners([INSTALL_CREDENTIAL_OWNER])` is a predicate that
              matches nothing" — which is now false (`project_id NOT IN ('install')` matches every job), as is
              `data-model.md:232`'s "returns `sql\`false\`` otherwise". The function's own name is now wrong
              too: it excludes projects, not owners. Why this is not cosmetic: the constitution's opening
              paragraph (`:1-7`) instructs every later spec and plan to read `docs/decisions.md` before
              specifying anything, and roadmap entry 2 (`per-project-llm`) is the entry whose whole job is to
              rewrite `src/server/dal/credential-owners.ts`. It will read H8 and a contract signature that
              describe a design this branch does not have, and the first thing it will plan against is the one
              invariant the remediation had to break.
      owed:   Update `docs/decisions.md:1685` (H8) to state the shipped mechanism — a probing owner may claim a
              lease-expired `running` item, and the lease-recovery attempt increment and `interrupted` failure
              are what is gated on `!probe` — keeping the FR-013/US1 AS5 justification. Correct
              `contracts/services.md:26`/`:34`/`:157`, `data-model.md:232`, `research.md:144`/`:239`/`:260` and
              `plan.md:31` to match, and rename `jobsExcludingOwners` to say what it now takes (e.g.
              `jobsExcludingProjects`), updating its three call sites and `credential-owners.test.ts`.
      traces: FR-012, FR-035, SC-010, constitution I

- [ ] MINOR F3 — `no-plaintext.test.ts`'s four new LLM secrets can never be found, because nothing in the test ever gives them to anything.
      where:  tests/integration/no-plaintext.test.ts:47, tests/integration/no-plaintext.test.ts:54
      why:    FR-033 requires this file to "cover the new table in its all-tables scan so neither a key nor a
              hash of one can ever appear there". The additions are `OPENAI_API_KEY_CANARY`,
              `ANTHROPIC_API_KEY_CANARY` and their SHA-256 hex, pushed into `secrets` at `:47-50`, plus
              `holdCredit(INSTALL_CREDENTIAL_OWNER, new Date())` at `:54` so a row exists for the dump at
              `:82`. But those two canary strings are string literals that are never passed to a provider, a
              config, an env var or `holdCredit` — `grep -n CANARY` shows them only in the declaration and the
              secrets array. The scan therefore asserts the absence of four values that never entered the
              system, which is true by construction. The real configured keys (`process.env.ANTHROPIC_API_KEY`,
              `process.env.OPENAI_API_KEY`) are *not* in this file's `secrets` list, unlike
              `secret-scan.test.ts:168-169` where they are. So if a future change did start storing a key or a
              hash of one in `llm_credit_holds`, this test — the one FR-033 names for that table — would still
              pass. The substantive FR-033/SC-006 proof does hold, but it lives entirely in
              `secret-scan.test.ts`, whose new pieces embed the *configured* key in both providers' error
              bodies and whose scanner is proven able to fail by the deliberate-leak test at `:184`.
      owed:   Add `process.env.ANTHROPIC_API_KEY!`, `process.env.OPENAI_API_KEY!` and their `sha256Hex` to
              `secrets`, and drive one real billing refusal through `withCreditHold` (or write a hold for an
              owner derived from nothing but the constant) before the scan, so the assertion has a path that
              could produce a hit. Keep the canaries if you like, but they are not what makes it a regression
              guard.
      traces: FR-033, SC-006, constitution VII

- [ ] MINOR F4 — The SC-007 "claim SELECT is byte-identical" test rebuilds the statement by hand instead of asking `claimDueJobItems` for it, so it cannot detect the drift it exists to prevent.
      where:  tests/integration/jobs/dal.test.ts:64
      why:    The test is named "with no holds, the claim's job SELECT is byte-identical to main's (SC-007,
              invariant 5)" but it never imports or calls `claimDueJobItems`. It constructs two queries from
              literals inside the test — one with `jobsExcludingOwners([])` and one without — and asserts their
              `toSQL()` are equal. Since `jobsExcludingOwners([])` returns `undefined` and drizzle's `and()`
              drops `undefined`, the assertion reduces to "`undefined` does not change a query", i.e. it tests
              the helper, not the claim. If a later pass added a clause to the real job `SELECT` at
              `job-claims.ts:84-96` — the exact regression SC-007 ("every observable behaviour ... identical to
              `main`") is written to catch — this test would stay green, because the hand-built copy would not
              have changed. The feature's real protection for SC-007 is the 5,275 passing existing assertions,
              which is substantial; this particular test just does not add to it.
      owed:   Either assert the helper honestly (rename it to "`jobsExcludingOwners([])` does not change a
              statement") or make it real: export the claim's job-`SELECT` builder, or snapshot
              `claimDueJobItems`' statement via a query-recording hook (`tests/setup/scope-recorder.ts` already
              records queries) and compare the no-hold statement against a committed expected string.
      traces: SC-007, FR-031

- [ ] MINOR F5 — The FR-015 single-flight test still cannot fail: `FOR UPDATE SKIP LOCKED` on the job row already guarantees its assertion.
      where:  tests/integration/jobs/credit-probe.test.ts:131
      why:    Carried unchanged from the first review (F6) — correctly, since it is not blocking. "AS5: two
              concurrent ticks make exactly one probe call" seeds one asset, so one job with one item, and runs
              two ticks at `jobMaxItems: 1`. The pre-existing `FOR UPDATE SKIP LOCKED` at `job-claims.ts:96`
              already means only one of two concurrent ticks can lock that job, so `probing.requests` would
              have length 1 even if `gateCreditHolds`' lock-and-advance (`credit-holds.ts:54-63`) were deleted
              outright. The test cannot distinguish the mechanism it is named for from one that was already
              there. Two jobs with one due item each would make it discriminating, because each tick could then
              lock a different job and only the hold-row lock would stop the second probe. T032 also specified
              that this test assert the ticks "advance `nextProbeAt` by exactly one interval"; it instead
              asserts the hold is gone (the successful probe deleted the row), so the interval arithmetic under
              contention is never checked anywhere.
      owed:   Give the test two jobs with one due item each and assert exactly one model request across both
              ticks; add a variant where the probe is refused again, so `nextProbeAt` is still readable and can
              be asserted equal to `t1 + CREDIT_PROBE_INTERVAL_MS` exactly — not two intervals.
      traces: FR-015, C10, US2 AS5

- [ ] MINOR F6 — Three test files now leave an `llm_credit_holds` row behind, so a later file in the same vitest worker can be silently held.
      where:  tests/integration/voice/try-it.test.ts:93, tests/integration/jobs/cancel.test.ts:221, tests/integration/jobs/ui.test.tsx:341
      why:    Carried from the first review (F4), where one file leaked; the remediation added a second
              (`cancel.test.ts`'s last test seeds a hold and the file's only teardown is `afterAll(closeDb)`)
              and `ui.test.tsx`'s last test is a third. Worker databases are shared across the files a worker
              runs, and only the jobs suites clear holds (`parkAllJobs` → `clearHolds`,
              `tests/helpers/jobs-env.ts:24`) — which runs in `beforeEach`, so it protects the *next* test in
              the same file, never the next file. I measured the blast radius rather than guessing it: of the
              77 files that call `runTick` without `parkAllJobs`, exactly one also touches generation jobs
              (`tests/integration/security/secret-scan.test.ts`), and it would still pass, because its
              assertions are all negative. So this is latent, not live — the suite is green today. It stays
              worth fixing because the quickstart's own helper contract
              (`specs/043-llm-credit-hold/quickstart.md:183`) promises `clearHolds()` is called "so one file's
              hold cannot leak into another's ticks", and three files now break that promise.
      owed:   Add `await clearHolds()` in an `afterAll` in each of the three files (or inside the assertions
              that seed a hold), so the invariant the helper documents is actually true.
      traces: constitution II, quickstart.md helper contract

- [ ] MINOR F7 — `pnpm db:check` cannot pass on Windows, and misreports the reason, so two ticked tasks assert a gate that never ran on a developer machine.
      where:  scripts/check-migrations-current.mjs:13
      why:    Carried from the first review (F5) and re-confirmed here. `spawnSync("pnpm", [...])` without
              `shell: true` cannot resolve `pnpm.cmd` on Windows: `status` comes back `null` with
              `error.code: "ENOENT"` and both `stdout` and `stderr` `undefined`, which is why the run prints
              `drizzle-kit check failed: migration history is inconsistent.` followed by the literal
              `undefinedundefined` (line `:22` interpolates two undefined values). The diagnosis is actively
              wrong — the migration history is fine. Pre-existing, outside this feature, and CI on Linux is
              unaffected; flagged because T007 and T070 claim a gate that cannot execute here. I verified the
              substance by hand instead, with the spawn fixed: `drizzle-kit check` exits 0, and generating into
              a copy of `drizzle/` reports "No schema changes, nothing to migrate" with 22 SQL files before and
              after. So FR-028 and SC-008's migration-currency clause do hold.
      owed:   Add `shell: process.platform === "win32"` to the `spawnSync` options, and report
              `result.error.message` when `status` is `null`, so a spawn failure stops masquerading as a
              migration-history failure. Note that `out` must stay a path drizzle-kit can resolve from the cwd
              it runs in — an absolute Windows path with a drive letter is prepended to the cwd and fails.
      traces: FR-028, SC-008

- [ ] MINOR F8 — The per-owner exclusion emits one bind parameter per active-job project, where the old all-or-nothing predicate emitted a constant.
      where:  src/server/dal/job-claims.ts:47, src/server/dal/credential-owners.ts:27
      why:    Introduced by T073. With one credential owner — today's only configuration — a hold on `"install"`
              makes `resolveBlockedProjectIds` return *every* project id that has a `queued` or `running` job,
              and `jobsExcludingOwners` turns that into `project_id NOT IN ($1 … $N)`. So on each held tick the
              claim transaction runs an extra `SELECT DISTINCT project_id FROM generation_jobs WHERE status IN
              ('queued','running')` and then a predicate whose parameter count grows with the install, to
              express a condition that is always simply "exclude everything". plan.md's Performance Goals
              budgeted "two short statements ... when a hold exists"; this is three, one of them unbounded. At
              realistic scale (tens of projects with active jobs) the cost is negligible, which is why this is
              MINOR; at Postgres's 65,535 bind-parameter ceiling it would error outright, and well before that
              the statement stops being plan-cacheable because its shape changes with every tick.
      owed:   Short-circuit when every candidate project is blocked — if `blockedProjects.length` equals the
              distinct-project count, emit the old constant-false predicate — or invert to an allow-list of
              unblocked projects, which is bounded by the free owners rather than the held ones. Either keeps
              `jobsExcludingOwners([])` returning `undefined` so F4's and FR-031's no-hold identity is intact.
      traces: FR-013, plan.md Performance Goals

- [ ] MINOR F9 — A throw before `processClaimedItem`'s `try` spends the probe interval without rewinding it, because the rewind lives in that `try`'s `finally`.
      where:  src/server/services/jobs/runner.ts:87, src/server/services/jobs/runner.ts:415
      why:    The probe rewind that implements FR-016 ("a probe that is not made because the tick budget is too
              short MUST NOT consume the interval") is `if (claimed.probe && !calledModel) await
              rewindCreditProbe(...)` in the `finally` at `:415`. The `try` it belongs to opens at `:233`. One
              statement runs before it: `:87`, `item.externalId ? apiSourceMetaSchema.parse(job.sourceMeta).sourceKey
              : null`. If that `parse` throws — an API-sourced item whose job's `sourceMeta` does not satisfy
              `apiSourceMetaSchema` — the function exits before the `try`, so neither the `catch`'s
              `retryLater("internal")` recovery nor the `finally`'s rewind runs: `next_probe_at` keeps the
              interval `gateCreditHolds` just wrote, and the item stays `running` holding a fresh lease. This
              was route (b) of the first review's F1; F1's starvation is gone, because the next probe can now
              claim that lease-expired `running` item, so the worst case is bounded — one wasted interval per
              occurrence, and for a permanently malformed row, one wasted interval per lease period with no
              model call ever made, which leaves only an interactive call able to clear the hold. Reachable only
              from a corrupt or hand-edited `generation_jobs.source_meta`, which is why it is MINOR.
      owed:   Move the `sourceKey` derivation inside the `try` (it needs nothing that is set up before it), or
              hoist the probe rewind into its own `try`/`finally` wrapping the whole function body.
      traces: FR-016, H7

- NOTE F10 — `counts.probed` still reports a probe that was *granted*, not one that was *made*. At
  `src/server/scheduler/generation.ts:92` it is `claim.probing.length > 0 ? 1 : 0`, so a tick whose probe was
  rewound because no item was claimable (`job-claims.ts:98`, `:182`) or because the budget was too short
  (`runner.ts:415`) still reports `probed: 1` on the tick summary and in the heartbeat's `last_summary`. This
  matches `contracts/services.md:§5` verbatim and the field's own doc comment, so it is deliberate; FR-021 asks
  the summary to report "whether a probe was made". Now that F1 is fixed the misreading is much less
  consequential than it was — an operator seeing `held=1 probed=1` every tick is now usually right — but the
  wording and the semantics still differ. Confirmed that both new fields do reach the heartbeat:
  `writeHeartbeat("generation", now, { ...counts })` at `src/server/scheduler/generation.ts:69` serialises the
  whole counts object, so FR-021's "tick summary **and** heartbeat" is satisfied in the same shape as
  `notConfigured`/`notRunnable`.

- NOTE F11 — The timing-budget tests were excluded from this phase's suite run (`DOCKET_SKIP_PERF_TESTS=1`),
  which is the step CI uses for the main run; `vitest.config.ts:5-7` says in as many words that CI runs them
  separately because "beside thousands of parallel tests they measure contention, not the query". The previous
  pass ran them inline and saw `tests/integration/notifications/performance.test.ts` measure 108.9 ms against a
  100 ms assertion — a feature-042 test that touches nothing this entry changes. Whether CI's dedicated step
  passes is not determinable from here, and will not be until F1 is fixed and the branch is pushed.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-038) | 38 | 35 | 3 | 0 | 0 |
| Success criteria (SC-001…SC-010) | 10 | 9 | 1 | 0 | 0 |
| Constitution principles and engineering/workflow constraints | 14 | 12 | 0 | 0 | 1 |
| User stories / acceptance scenarios | 4 stories, 23 scenarios | 22 | 1 | 0 | 0 |

Partial or contradicted, named:

- **FR-016** partial — the rewind is correct for the tick-budget case it was written for
  (`credit-probe.test.ts:172` and `:196` both assert `nextProbeAt <= now`), but an exception before
  `processClaimedItem`'s `try` skips it (F9).
- **FR-033** partial — the `secret-scan.test.ts` half is real and strong; the `no-plaintext.test.ts` half
  searches for four values that never enter the system (F3).
- **FR-038** partial — eleven of its twelve bullets are covered, several well. The missing one is "the migration
  applied to a populated database: no row reclassified" — there is no automated test for it, only the
  structural argument that `drizzle/0021_fine_vermin.sql` contains two `ALTER TYPE … ADD VALUE` and one
  `CREATE TABLE` and no `UPDATE` or `DELETE`, plus T071's manual `psql` histogram check, which left no artifact
  I can re-run. The two bullets the first review found absent — cancel/retry/open-job (F3 then) and the second
  credential owner (F2 then) — are now both present and passing.
- **SC-008** partial — the migration-currency half is verified (see the gate table, run by hand because of F7);
  the "applying the migration to a copy of a populated installation reclassifies no row" half rests on the same
  structural argument as above.
- **Constitution, Development Workflow → Commits** contradicted — F1. Nothing was committed, so the rule that
  every completed task ends in a small, logical commit with explicit paths was not followed once in 74 tasks.
- **US3 AS5** partial — "read with assistive technology and with the keyboard only" is checked here only as
  server-rendered markup: exactly one `role="note"` on the list (`ui.test.tsx:289`), `JobNotice` is a plain
  `<p role="note">` with no interactive child and no `"use client"`, `AutoRefresh` still renders
  `active intervalMs={5000}` while held (`ui.test.tsx:332`), and no colour-only signal. No real AT or keyboard
  walk — see "What I could not check".
- **Constitution V (Providers are plug-ins)** — N/A, as plan.md says: the social-provider plug-in system is
  untouched. Counted in the 14, not in the 12.

Verified positively in this pass, with citations, rather than taken from the previous review:

- The F1 fix holds the invariant it had to preserve. `itemDue` at `job-claims.ts:83` is used for every owner at
  `:111`; the `interrupted` branch at `:156` is gated on `!probe`; the increment at `:168` is skipped for a
  probe. `credit-probe.test.ts:251` asserts one model call per interval, `attemptCount === 0` and
  `lastErrorKind !== "interrupted"` across three intervals, then a successful probe clearing the hold;
  `recovery.test.ts:127` asserts the merely-held owner claims nothing and the item is never failed.
- The F2 fix is discriminating, not decorative. `budgetFor` (`job-claims.ts:118`) hands a blocked-but-not-probing
  owner `opts.limit`, not `0`, so the SQL exclusion at `:91` is the only thing that stops its items — removing
  it would fail `credit-probe.test.ts:292`. `routeCredentialOwners` (`tests/helpers/jobs-env.ts:63`) is no
  longer dead code; it is imported at `credit-probe.test.ts:18` and used at `:296`, and the spy on the ESM
  export does work under this Vitest version (the test passes by name).
- No double-wrap of `withCreditHold`. It is applied at `core.ts:111` (inside `runGenerationStep`, the only path
  to a provider for single/regenerate/job/series-post) and at `series.ts:86` (`planSeries`, which calls
  `llm.generate` directly at `:105`). `writeSeriesPost` at `:236` passes its own *unwrapped* `llm` parameter to
  `runGeneration`, so the wrap happens exactly once on that path. `scripts/llm-check.ts:91` wraps too, and its
  write failures are swallowed inside `withCreditHold`'s `try` (`credit.ts:16-24`) — including
  `clock.now()`, which reads the database — which is what makes `pnpm llm:check` work with no `DATABASE_URL`
  (`scripts/llm-check.test.ts:38-51`).
- `credit_exhausted` is absent from every retry set: `TEMPORARY` (`runner.ts:49`), `RETRYABLE` in both
  `core.ts:68` and `series.ts:83`, and `UNUSABLE` (`api/operations/generate.ts:43`), so FR-006/FR-010 hold and
  the public API falls to the 503 branch at `:91`, which passes `result.message` — the fixed sentence — as the
  error message. FR-018 is therefore satisfied in substance, not just in status code.
- Detection reads the right field for each provider's different shape: Anthropic's `isCreditRefusal`
  (`anthropic.ts:26-33`) reads `error.type` (`:28`) then the body's `error.message` (`:31`), and OpenAI's
  (`openai.ts:21-22`) reads `error.code` — and it is checked *before* `RateLimitError` in both (`anthropic.ts:39` precedes `:40`;
  `openai.ts:29` precedes `:30`). Both predicates are exercised against the SDKs' own real error classes via
  `APIError.generate` (`anthropic.test.ts:107`, `openai.test.ts:71`), including malformed and empty bodies and
  non-`APIError` inputs, and through `createFakeLlmFetch` wire bodies in the shared table.
- SC-009's "exactly today's kind" is pinned by the pre-existing `test.each` at `llm-scenarios.ts:103-113`
  (429 → `rate_limited`, 400 → `bad_request`, run for both providers), not only by the new
  `nonBillingAtSameStatus` test, which asserts the weaker "not `credit_exhausted`".
- The migration is transaction-safe and rewrites nothing: `drizzle/0021_fine_vermin.sql` is two
  `ALTER TYPE … ADD VALUE` and one `CREATE TABLE` that uses neither new label, so the "cannot use a new enum
  value in the transaction that added it" rule is not engaged. `llm_credit_holds` is four columns and a
  non-empty-owner check, is registered in `notProjectOwned` (`project-owned.ts:52`), and the read path is
  behind the existing `canView` (`read.ts:59`).
- The screens' no-hold path is markup-identical: the job page's two existing notices were refactored into
  `JobNotice` with byte-identical output (`<p role="note" className="rounded-md border border-warning-border
  p-3 text-sm">`), the waiting-row branch is scoped to `queued` + `credit_exhausted`
  (`JobItemsTable.tsx:10`), the retry control is still offered to `failed` items only (`:77`), and
  `ui.test.tsx:323-327` asserts the four notice-only strings vanish when the hold row is deleted.

## What I could not check

- **A real browser.** No keyboard walk, no focus-visible check, no screen-reader announcement test, no contrast
  measurement on the rendered notice. FR-026 and the `docket-ui` rules are checked here only as server-rendered
  markup and by `ui.test.tsx`. `scripts/check-contrast.mjs` was not run; neither was `pnpm build`, which T053
  treats as the fallback gate for the pages (the remediation touched no file under `src/app`, which is why I
  judged skipping it safe rather than cheap).
- **CI.** Nothing is committed (F1), so no CI run exists for this code: not the timing-budget step, not the
  Docker image build, not commitlint, not `pnpm db:check` on Linux. Every green result in this review comes
  from one Windows machine.
- **A live provider.** By design (constitution II) every detection test is mocked HTTP. The two wording facts
  the feature rests on — Anthropic's `/credit balance/i` message and OpenAI's `insufficient_quota` — are the
  author's observations and are not in `docs/research/`. I verified from the installed packages that the
  *fields* exist and that `billing_error` is a declared `ErrorType`; I could not verify the provider actually
  sends those bodies. If the wording changes, FR-004 means the consequence is today's mass-failing behaviour,
  which is a silent regression nothing here would catch.
- **A populated production database.** T071's `psql` `last_error_kind` histogram comparison across the
  migration is not reproducible from this phase; the structural argument (no `UPDATE`, no `DELETE`) is what
  stands in for it.
- **Concurrency under real load.** The probe's single-flight was reasoned through `FOR UPDATE SKIP LOCKED` plus
  EvalPlanQual semantics and exercised by the two-tick test that F5 shows is not discriminating. Two real
  worker processes against one database were not run, and the new `resolveBlockedProjectIds` read introduces a
  second statement-level snapshot inside the claim transaction that I reasoned about but did not race: a job
  committed between the `SELECT DISTINCT` and the job `SELECT` would escape the exclusion for one tick, be
  refused, and be requeued without failing — self-healing, but it does cost model calls the 5-minute budget did
  not plan for.
