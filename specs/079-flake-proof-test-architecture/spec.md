# Feature Specification: Flake-proof integration-test architecture

**Feature Branch**: `079-flake-proof-test-architecture`

**Created**: 2026-10-17

**Status**: Draft

**Input**: User description: "Rethink Docket's integration-test architecture so CI flakes are structurally impossible rather than fixed one at a time. Evidence from a full day of investigation on 2026-10-17: (1) tick sections silently claim nothing when short of wall-clock budget and still return success — generation.ts needs minCallMs+persistReserveMs (11s) and token-refresh.ts needs providerTimeoutMs (10s) to remain before startedAt+timeBudgetMs, leaving a ~14s window at env defaults that a four-core CI runner with three vitest workers on one Postgres closes but a dev machine never does; now reported via counts.outOfBudget and enforced by tests/lint/tick-budget.test.ts after pinning 216 runTick calls across 92 files, and SCHEDULER_TICK_BUDGET_SECONDS cannot fix it from the environment because it is capped at 25. (2) Global unscoped claims are limit-bounded and get squeezed by leftover rows from other tests: claimDueEngagementReads orders by read_not_before then random uuid and takes limit 10, claimRefreshAccounts caps per tick, claimDuePeople is global; mitigated today by a fragile parkAll* family (parkAllJobs, parkAllEmail, parkAllDueTargets, parkAllStandingSeries, parkAllEngagementReads) spread across 169 test files, where parking existing rows was not enough because the claim creates state rows lazily. (3) Isolation is per worker, not per file: tests/setup/global-setup.ts clones one database per vitest worker and files within a worker share it sequentially, so leftovers leak between files AND between tests inside one file. Per-file cloning measured at 35-56ms, roughly 5s per shard for ~100 db-touching files. (4) Load-sensitive tests time out under full-suite parallelism and pass in isolation: bluesky/publish-e2e, tick-endpoint, jobs/credit-outage (122 real ticks, 13s alone but exceeded a 120s timeout beside 79 files). (5) Zero-slack capacity assertions, e.g. email tick serving 500 people in 10 ticks at 50 per tick is exactly 500 with no spare capacity, so one skip fails the test outright. (6) Two flakes remain live and unexplained after five disproven hypotheses each: email/tick.test.ts returns claimed 500 sent 499 skipped 1, and scheduler/refresh.test.ts returns tokenRefresh failed 0 with the budget pinned so it is not the deadline gate. Both now carry per-disposition diagnostics in their assertion messages. Required outcomes: a way to enumerate every flaky test empirically from repeated CI runs instead of discovering them one run at a time; structural isolation that makes leftover interference impossible rather than parked around; tests that never depend on wall-clock windows or exact capacity; and production sections that can never report a skip indistinguishable from idle."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enumerate every flaky test at once, from evidence (Priority: P1)

A maintainer wants the complete list of non-deterministic tests in one sitting. They ask the project
to run the whole suite repeatedly under the same contention CI applies, and get back a single report
naming every test that passed on some repetitions and failed on others, with how many times each
outcome occurred and the failure message for each distinct failure. Today the only way to learn a
test is flaky is to merge, wait for a red run, and read one failure out of a four-shard log — so the
backlog of flakes is discovered one per day rather than enumerated once.

**Why this priority**: Every other story in this feature needs a list of what is actually broken and
a way to prove a fix worked. Without repeated-run evidence, "fixed" means "did not fail the next
time I looked", which is how the current situation was reached.

**Independent Test**: Run the repeated-suite report against today's code and confirm it names at
least the two known-live flakes (the email tick disposition flake and the token-refresh flake)
without anyone having told it they exist, plus pass/fail counts per test. Delivers value on its own:
the list is actionable even if nothing else in this feature ships.

**Acceptance Scenarios**:

1. **Given** a suite containing a test that fails roughly one run in ten, **When** the maintainer
   requests a repeated-run report, **Then** the report lists that test as non-deterministic with its
   pass count, fail count and failure messages, and does not list tests that passed every repetition.
2. **Given** a test that fails on every repetition, **When** the report is produced, **Then** that
   test is reported as consistently failing and clearly distinguished from a flaky one, so a genuine
   regression is never filed as a flake.
3. **Given** a repeated run, **When** it finishes, **Then** the report is retrievable without reading
   raw per-shard logs and without re-running anything.
4. **Given** the report has been produced for a candidate fix, **When** the previously flaky test
   passes every repetition, **Then** the report shows zero failures for it, which is what counts as
   proof that the flake is closed.

---

### User Story 2 - A test can never see another test's leftovers (Priority: P1)

A maintainer writes a test that creates a handful of rows and runs a scheduler tick. The tick must
act on that test's rows and nothing else, whatever any other test in the suite has left behind, and
whatever order the files ran in. Today a tick's work-claiming is global and capped (ten engagement
reads per claim, a per-tick cap on account refreshes, an uncapped-by-project people claim), so
another test's unparked rows can consume the whole claim and starve the test under inspection. The
mitigation is a family of "park everything else" helpers — 305 call sites across 147 files as
measured on this checkout — and it does not even fully work, because some claims create the state
rows they then claim.

**Why this priority**: This is the single largest source of flakes and the reason the parking
helpers exist. Removing the possibility removes the class.

**Independent Test**: Write two tests that each seed work the other would starve, run them in the
same execution lane in both orders with no parking helpers, and confirm both pass in both orders.

**Acceptance Scenarios**:

1. **Given** a test file that seeds work and runs a tick, **When** another file in the same execution
   lane has already left unparked due work behind, **Then** the first file's assertions are unaffected.
2. **Given** two tests inside one file, **When** the first leaves due work behind, **Then** the second
   starts from a state in which that work cannot be claimed.
3. **Given** a claim that creates its own state rows on first sight of an entity, **When** a test
   runs after a file that created such entities, **Then** those entities are not visible to the claim.
4. **Given** the suite after this story lands, **When** a maintainer searches for the parking helpers,
   **Then** none remain in use and the suite still passes.

---

### User Story 3 - No test depends on the wall clock or on exact capacity (Priority: P1)

A maintainer's test passes or fails on what the code did, never on how fast the machine was or on
whether capacity was consumed to the last unit. Today a tick section quietly does nothing when too
little of its wall-clock budget remains — the generation section needs about eleven seconds left and
the token-refresh section about ten, against a budget whose ceiling the environment cannot raise past
twenty-five seconds — so a loaded four-lane runner sharing one database closes a roughly fourteen
second window that a developer machine never closes. Separately, a capacity assertion with no slack
(five hundred recipients served by ten ticks at fifty per tick) fails outright the moment one item is
skipped for any reason.

**Why this priority**: These two shapes are why the same code is green locally and red in CI. A test
that can be starved by a slow machine is not testing the behaviour it claims to test.

**Independent Test**: Run the suite with the execution lanes deliberately oversubscribed (more lanes
than cores) and with artificial delay added, and confirm the same pass/fail outcome as an unloaded
run.

**Acceptance Scenarios**:

1. **Given** a test that drives scheduler ticks, **When** the machine is loaded so each tick has far
   less wall-clock time than the section minimums, **Then** the test still reaches its assertions and
   still passes.
2. **Given** a test that asserts a volume of work was completed, **When** one item is skipped or
   deferred for a legitimate reason, **Then** the test either tolerates it or drives further ticks
   until the work drains, rather than failing on an off-by-one.
3. **Given** a new test written after this feature, **When** it depends on an unpinned wall-clock
   budget or asserts exactly the available capacity, **Then** an automated guard fails before merge
   and names the offending test and the rule it broke.
4. **Given** an existing test with a legitimate reason to measure timing, **When** the guard runs,
   **Then** that test is explicitly exempt and the exemption is visible in the guard's own record.

---

### User Story 4 - An operator can always tell a skipped section from an idle one (Priority: P2)

Someone watching the production scheduler sees a tick report that a section did nothing. They need to
know whether there was nothing to do or whether the section ran out of time and abandoned work that
is still waiting. Today both look identical: the section returns success with zero counts. On a busy
deployment this hides a section that never runs at all.

**Why this priority**: This is the production-facing half of the same defect, and it is the reason
the test failures were invisible for so long. It is P2 only because the test-side stories unblock the
rest of the work; it is required, not optional.

**Independent Test**: Force a tick in which a section has too little remaining budget to act, and
confirm the tick's own report distinguishes that outcome from an idle section, with no test
instrumentation involved.

**Acceptance Scenarios**:

1. **Given** a tick section with work waiting but too little remaining time to act on it, **When** the
   tick finishes, **Then** its report states that the section declined for lack of time, separately
   from any count of work completed.
2. **Given** a tick section with nothing to do, **When** the tick finishes, **Then** its report shows
   idle, not declined.
3. **Given** a section that declined for lack of time, **When** the next tick runs with time
   available, **Then** the work it declined is still claimable and gets done.
4. **Given** a deployment where a section declines on every tick, **When** an operator looks at the
   scheduler's own output, **Then** that condition is visible without reading application logs line by
   line.

---

### User Story 5 - Heavy tests pass under full parallelism (Priority: P2)

A maintainer running the whole suite must not have tests fail purely because the suite is big. Three
tests are known to pass alone and fail beside the rest: a Bluesky end-to-end publish, the tick
endpoint, and a credit-outage job test that drives one hundred and twenty-two real ticks and takes
about thirteen seconds alone but exceeded a two-minute limit when run beside seventy-nine other
files.

**Why this priority**: Fewer tests affected than the first three stories, but each one is a recurring
red run, and the credit-outage shape (hundreds of real ticks) will recur as the scheduler grows.

**Independent Test**: Run the three named tests inside the full suite twenty times and confirm twenty
passes.

**Acceptance Scenarios**:

1. **Given** the full suite at its normal parallelism, **When** the three named tests run as part of
   it, **Then** none of them exceeds its time limit.
2. **Given** a test that needs to drive a very large number of ticks, **When** it runs, **Then** it
   reaches its assertions without depending on how many other tests share the machine.
3. **Given** the whole suite, **When** total wall-clock time is measured before and after this
   feature, **Then** the increase is small enough to keep the gate practical to run on every push.

---

### User Story 6 - The two live unexplained flakes are closed with a reason (Priority: P3)

Two failures remain live after five disproven hypotheses each: a test in which the email tick claims
five hundred recipients and reports four hundred and ninety-nine sent with one skipped, and a token
refresh test that reports zero failures where it expects some, with the wall-clock budget already
pinned so the deadline gate is ruled out. Both now print per-disposition diagnostics when they fail.
A maintainer needs each one either explained and fixed, or demonstrated to be impossible under the new
architecture.

**Why this priority**: Last, because the structural work in the earlier stories may well eliminate
both, and the repeated-run report from Story 1 is what proves it either way. Guessing at them first
is what consumed the investigation day.

**Independent Test**: Run the repeated-run report on the finished feature and confirm zero failures
for both tests across the full repetition count, with a written cause or a written argument for why
the shape can no longer occur.

**Acceptance Scenarios**:

1. **Given** the completed feature, **When** the repeated-run report runs at its full repetition
   count, **Then** neither test records a failure.
2. **Given** either test does fail during that run, **When** it fails, **Then** its message names the
   disposition of every item it processed, so the next investigation starts from data rather than from
   a hypothesis.
3. **Given** the feature is complete, **When** a maintainer reads the record for each of the two
   flakes, **Then** they find either the cause or the reason the shape is now impossible — not
   "stopped reproducing".

---

### Edge Cases

- **A test genuinely needs shared state across its own cases.** Isolation must be strong between
  tests by default, but a file that builds expensive state once and makes several assertions against
  it must still be expressible, and must still be isolated from other files.
- **A test deliberately exercises the out-of-time path.** The guard that forbids wall-clock
  dependence must not forbid testing the budget logic itself; such a test pins the clock rather than
  racing it.
- **The repeated-run report finds a test that fails only in one shard position.** Ordering- and
  sharding-dependent failures must be reported as non-deterministic, not hidden because each
  individual shard was internally consistent.
- **The repeated-run report itself fails** — the whole run fails to start, or an execution lane dies.
  An infrastructure failure must be reported as such and must not be attributed to whichever test was
  running at the time.
- **A new test added after this feature reintroduces a global unscoped claim assumption.** The
  isolation guarantee must hold for tests nobody has written yet, without each author having to know
  the rule.
- **Isolation setup cost on a tiny run.** Running a single test file must not pay the setup cost of
  the whole suite.
- **A production section declines for a reason other than time** (configuration off, provider
  disabled, nothing claimable). Each non-idle reason must be distinguishable from idle and from the
  others, not collapsed into one declined flag.
- **Two sections contend for the same remaining budget in one tick.** The report must attribute the
  decline to the section that declined, not to the tick as a whole.
- **The suite runs on a developer machine with many cores and no contention.** The new guarantees
  must not be achievable only under CI's contention profile; the same test outcomes must hold in both.

## Requirements *(mandatory)*

### Functional Requirements

#### Empirical flake enumeration

- **FR-001**: The project MUST provide a way to execute the entire test suite a configurable number of
  times, under the same contention profile the gating run uses, in one invocation.
- **FR-002**: The repeated run MUST produce a single consolidated report naming every test whose
  outcome varied across repetitions, with pass count, failure count, and the distinct failure messages
  observed for each.
- **FR-003**: The report MUST distinguish three categories: consistently passing, non-deterministic,
  and consistently failing.
- **FR-004**: The report MUST distinguish a test failure from an infrastructure failure (the run or a
  lane failing to start or dying), and MUST NOT attribute an infrastructure failure to a test.
- **FR-005**: The report MUST be obtainable without reading raw per-lane or per-shard logs, and MUST
  be retained with the run that produced it.
- **FR-006**: The repeated run MUST be startable on demand by a maintainer, and MUST NOT be part of
  the per-push gate.
- **FR-007**: The gating test run MUST NOT automatically retry failed tests, so that a flake always
  surfaces rather than being absorbed.

#### Structural isolation

- **FR-008**: A test MUST NOT be able to observe, or be affected by, data created by any other test,
  whether in another file or in an earlier test in the same file.
- **FR-009**: Work-claiming behaviour exercised by a test MUST only ever see work that test created,
  regardless of execution order, lane assignment, or what other tests left behind.
- **FR-010**: The isolation guarantee MUST hold for work-claiming paths that create their own state
  rows on first encounter with an entity, not only for pre-existing rows.
- **FR-011**: The isolation guarantee MUST apply by default to every test that touches persistent
  state, without the test author opting in.
- **FR-012**: The parking helpers used to work around today's leakage MUST be removed from all test
  files once the guarantee holds, and an automated guard MUST prevent their reintroduction.
- **FR-013**: A file that needs expensive shared setup across its own cases MUST have a supported way
  to express that while remaining isolated from all other files.
- **FR-014**: Running a subset of test files MUST pay only the isolation cost of that subset.

#### No wall-clock or exact-capacity dependence

- **FR-015**: No test may depend on how much wall-clock time remains in a scheduler tick budget
  unless it pins that budget explicitly.
- **FR-016**: An automated guard MUST fail the gate when a test drives a scheduler tick without a
  pinned budget, naming the file and the rule it broke.
- **FR-017**: No test may assert a completed volume that exactly equals the available capacity; every
  such assertion MUST either carry slack or drive the work to completion.
- **FR-018**: An automated guard MUST detect and fail zero-slack capacity assertions, with an
  explicit, recorded exemption mechanism for tests whose purpose is to measure a limit.
- **FR-019**: The suite MUST produce the same pass/fail outcome under deliberate oversubscription
  (more execution lanes than available cores, all sharing one database) as on an unloaded machine.

#### Production section reporting

- **FR-020**: Every scheduler tick section MUST report, for each run, whether it was idle, completed
  work, or declined to act — and when it declined, for which reason (insufficient remaining time,
  disabled by configuration, or nothing claimable).
- **FR-021**: A section that declined for insufficient remaining time MUST be distinguishable from an
  idle section in the tick's own output, without reference to application logs.
- **FR-022**: Work a section declined to take MUST remain claimable by a subsequent tick.
- **FR-023**: A section that declines on every tick MUST be visible to an operator from the
  scheduler's own reporting surface.
- **FR-024**: Section reporting MUST NOT include credentials, tokens or other secrets.

#### Load-sensitive tests

- **FR-025**: The three known load-sensitive tests (the Bluesky end-to-end publish, the tick endpoint,
  and the credit-outage job test) MUST pass as part of the full suite at its normal parallelism.
- **FR-026**: A test that must drive a very large number of scheduler ticks MUST have a supported way
  to do so whose completion does not depend on machine contention.

#### Closing the two live flakes

- **FR-027**: Each of the two currently-unexplained flakes MUST be closed either by a stated cause and
  fix, or by a stated reason the failure shape can no longer occur under the new architecture.
- **FR-028**: Both MUST record zero failures across the full repetition count of the repeated-run
  report before the feature is considered done.
- **FR-029**: Assertions in work-volume tests MUST name the disposition of every item processed when
  they fail, so any future failure starts from data rather than from a hypothesis.

### Key Entities

- **Repeated-run report**: The consolidated outcome of running the whole suite N times. Per test:
  identifier, pass count, fail count, distinct failure messages, and category (consistently passing,
  non-deterministic, or consistently failing). Per run: repetition count, contention profile, and any
  infrastructure failures, kept separate from test outcomes.
- **Isolation boundary**: The unit of guaranteed-clean persistent state a test runs inside, and the
  rule for what a test may and may not observe across that boundary.
- **Section outcome**: What one scheduler tick section reports for one tick — idle, completed (with
  counts), or declined (with a reason). Replaces today's "success with zero counts", which conflates
  idle with declined.
- **Guard rule**: An automated pre-merge check with a name, the thing it forbids, the message it
  prints, and an explicit list of recorded exemptions. Covers pinned tick budgets, zero-slack capacity
  assertions, and reintroduced parking helpers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can obtain the complete list of non-deterministic tests from one request,
  in under one working session, without reading raw logs — replacing today's rate of roughly one flake
  discovered per red run.
- **SC-002**: Twenty consecutive full-suite gating runs on unchanged code all pass.
- **SC-003**: The suite produces the same pass/fail outcome on an unloaded many-core machine and on a
  four-lane runner sharing one database, across twenty runs of each.
- **SC-004**: Zero test files rely on parking other tests' work, down from 305 call sites across 147
  files today, and the suite still passes.
- **SC-005**: Zero tests depend on an unpinned scheduler tick budget, and a deliberately
  budget-dependent test added as a probe is rejected by the guard before merge.
- **SC-006**: Zero capacity assertions equal exactly the available capacity, and a deliberately
  zero-slack assertion added as a probe is rejected by the guard before merge.
- **SC-007**: Total gating-suite wall-clock time increases by no more than 10% against today's
  measured time, so it remains practical on every push.
- **SC-008**: 100% of scheduler tick sections report an outcome from which an operator can tell idle
  from declined, and declined-for-time from declined-for-configuration.
- **SC-009**: Each of the three known load-sensitive tests passes twenty consecutive times as part of
  the full suite, within its time limit.
- **SC-010**: Both currently-live unexplained flakes record zero failures across the full repetition
  count of the repeated-run report, and each has a written cause or a written reason it can no longer
  occur.
- **SC-011**: A new test written by someone who has not read this spec inherits the isolation
  guarantee automatically — demonstrated by a probe test that seeds work, runs after a file that
  leaves work behind, and passes with no isolation code of its own.

## Assumptions

- **The 2026-10-17 investigation work is a dependency, not part of this feature.** The per-section
  out-of-budget reporting, the budget-pinning across 216 tick calls in 92 files, the budget guard, and
  the per-disposition diagnostics currently live on an unmerged branch
  (`fix/tick-budget-bulletproof`, three commits) and are not on `main`. This feature assumes that work
  lands first, or is carried forward as part of it; the spec treats it as the starting state rather
  than re-specifying it.
- **Isolation granularity**: strong isolation is required *between* tests, and the default assumption
  is a clean persistent-state boundary per test file plus a guaranteed reset between tests within a
  file. Per-file setup was measured at 35–56 ms, roughly 5 s per shard for about 100 state-touching
  files, which fits inside the 10% wall-clock allowance in SC-007. A different granularity is
  acceptable if it delivers FR-008 through FR-011 inside the same budget.
- **Repetition count**: "the full repetition count" means twenty repetitions of the whole suite unless
  a measurement shows a different number is needed to surface a one-in-ten flake with confidence.
- **The repeated-run report runs on demand and on a schedule, never on every push.** Twenty full
  suite runs per push is not affordable; a push gets one run with no retries (FR-007).
- **Retries are rejected as a mitigation.** Automatic retry of failed tests would make every criterion
  here unmeasurable, so it stays out even though it would turn CI green sooner.
- **"Structurally impossible" means a test author cannot opt out by accident.** A convention that
  must be remembered is not a structure; every guarantee here is either enforced by the default
  execution path or by a guard that fails the gate.
- **Production behaviour change is limited to reporting and to the honesty of the reporting.** This
  feature does not change what work the scheduler does, how it claims work, or its 30-second tick
  bound; it changes what a tick says about sections that declined. If a plan finds that honest
  reporting requires changing claim scoping in production code, that is a decision for plan.md with an
  entry in `docs/decisions.md`.
- **The environment cannot fix the budget.** The tick budget's configured ceiling (25 s) is below what
  would be needed to close the ~14 s window by configuration alone, so the fix is in the test
  architecture and the reporting, not in an environment variable.
- **Scope excludes** rewriting tests that are already deterministic, changing the four-shard CI
  layout, adding new infrastructure (queues, Redis, a second database engine), and any product-visible
  behaviour change. The constitution's dependency rule applies: no new runtime dependency without a
  justification in plan.md.
