# Review: Standing content series that keep producing posts on a cadence

Second re-review after remediation. 97 file(s) changed across 16 commit(s), against
`a6fbea3`...HEAD (merge base with `origin/main`), diff-first.

Per the constitution's "review is exhaustive once, then scoped" rule, this pass checked (a) that
the re-review's two blocking findings (F1, F2) are actually closed and (b) that the files the
remediation commit `eac7561` touched introduced no regression. It did not re-open either earlier
review's lines of inquiry; the three things it noticed along the way are recorded as MINOR, as that
rule requires.

Read in full: the whole of `eac7561`'s diff — `src/server/services/standing-series/run.ts`,
`tests/helpers/jobs-env.ts`, `tests/integration/standing-series/self-pause.test.ts` — and then the
current state of `src/server/services/standing-series/{run,runner,media}.ts`,
`src/server/scheduler/standing-series.ts`, `src/server/dal/standing-series-claims.ts`,
`src/server/dal/credential-owners.ts`, `src/server/llm/resolve.ts`,
`tests/helpers/standing-series-env.ts`. Read as comparison baselines (not part of this commit):
`src/server/scheduler/{index,generation}.ts`, `tests/integration/jobs/{recovery,processing}.test.ts`.

Sampled: `tests/integration/security/secret-scan.test.ts` (its tick sites and their assertions),
`tests/integration/standing-series/cadence.test.ts` (setup only),
`src/server/services/generation/{series.ts,prompt.golden.test.ts}` and
`src/app/p/[projectSlug]/jobs/series/series-logic.ts` (the five carried-forward MINORs' cited lines,
re-checked so their citations are still true), `spec.md` FR/SC lists, `tasks.md` Phases 9–10.

Not reviewed again (unchanged since the first review, which read them): the UI components, the DAL
beyond the two files above, the migration SQL, `docs/*.md` prose, `drizzle/meta/*`.

Per the constitution's "run checks in proportion to the change", I did **not** re-run the full
suite, lint, typecheck or build this pass. The implement pass ran the full suite synchronously on
this exact commit and its log records the result — **642 files passed (8 skipped), 6077 tests passed
(55 skipped), 0 failures, `EXIT:0`** (`specs/071-evergreen-series/.pipeline/implement.result.json`).
Instead I ran four targeted probes, synchronously, each aimed at one finding:

| Probe | Command | Result |
|---|---|---|
| F2 closed | `vitest run tests/integration/standing-series/self-pause.test.ts` | 4 passed |
| F1 original repro | `DOCKET_TEST_WORKERS=1 vitest run --no-file-parallelism .../standing-series/cadence.test.ts .../jobs/recovery.test.ts` | 12 passed |
| F1 residual, narrow | same two-file form with `.../security/secret-scan.test.ts` in place of the jobs file | 10 passed |
| F1 residual, wide | `DOCKET_TEST_WORKERS=1 vitest run --no-file-parallelism tests/integration/standing-series/ tests/integration/security/secret-scan.test.ts` | 17 files, 109 passed |

## Verdict

Both blocking findings are genuinely closed, and both closures are backed by execution rather than
by reading. F2's fix is three lines in the right place: `closeStale` now returns whether the close
auto-paused the series (`run.ts:93-95`) and `openOrResumeRun` returns `null` instead of opening a
run on a series it has just disabled (`run.ts:121-122`), so the orphan run that defeated Resume a
period later cannot exist. The new test (`self-pause.test.ts:147`) drives the exact path the finding
described — four failing ticks, Resume, then assert the next period produces — and would have failed
against the old code, because the producer re-reads `enabled` at `runner.ts:192-193` and would have
returned with `produced: 0`. F1's fix parks standing series in `parkAllJobs` exactly where that
helper already parks job items, holds and project credentials (`jobs-env.ts:27, 37-41`), and the
two file orderings that failed deterministically before are green now.

No blocking findings. `tasks.md` is unchanged, all 84 tasks are ticked, and the tree is clean. The
feature is ready for a human to merge. Eight MINORs stand: five carried forward unchanged from the
earlier reviews (nobody turned them into tasks, which is correct — only blocking findings do that),
and three noticed this pass, of which one is the remediation's own small tax (a twelfth copy of the
same park-the-series helper) and two are pre-existing gaps that the remediation brought into view
rather than caused.

## Findings

- [ ] MINOR F1 — The park-the-series helper the remediation added is the twelfth implementation of the same four-line job; eleven test files keep their own copy.
      where:  tests/helpers/jobs-env.ts:37, tests/integration/standing-series/cadence.test.ts:33, tests/integration/standing-series/credit-hold.test.ts:39, tests/integration/standing-series/edges.test.ts:35, tests/integration/standing-series/idempotency.test.ts:33, tests/integration/standing-series/isolation.test.ts:44, tests/integration/standing-series/media.test.ts:45, tests/integration/standing-series/parity.test.ts:34, tests/integration/standing-series/policy.test.ts:35, tests/integration/standing-series/self-pause.test.ts:34, tests/integration/standing-series/slots.test.ts:35, tests/integration/standing-series/claim.test.ts:16
      why:    Every one of these is `runCrossProject("test: park standing series", …)` around an update of
              `standing_series` — the same label, string for string. The new shared
              `parkAllStandingSeries` differs from the eleven private `parkOtherSeries` copies in two
              ways: it has no `WHERE enabled = true` and it also clears `lease_owner`/`lease_until`. So the
              shared one is the better version and the eleven are now a weaker duplicate of it, which is
              the wrong way round: the next person to fix a leak of this kind has twelve places to find.
              This is test-support code only — no product behaviour depends on it, which is why it is MINOR
              and not a blocker.
      owed:   Have the eleven files import `parkAllStandingSeries` from `tests/helpers/jobs-env` (or move it
              beside `standingSeriesEnv`) and delete their copies.

- [ ] MINOR F2 — FR-047's "series auto-paused" count misses two of the four close sites, so a tick that auto-pauses a series on either of them reports nothing.
      where:  src/server/services/standing-series/runner.ts:119, src/server/services/standing-series/runner.ts:101, src/server/services/standing-series/run.ts:181
      why:    `counts.autoPaused` is incremented in exactly one place — `closeRunCounted`
              (runner.ts:97-101) — which the producer-loop close and the plan-failure close reach. The other
              two closes go through `closeRun` directly: the stale close inside `openOrResumeRun`
              (run.ts:121) and the blocked-reason close (run.ts:181). The F2 fix makes the first of those
              more visible, because `processClaimedSeries` now returns at runner.ts:119 the moment a stale
              close auto-pauses, so that tick reports neither `runsClosed` nor `autoPaused` for a series it
              just disabled; the blocked path reports `blocked` (runner.ts:125) but likewise never
              `autoPaused`. FR-047 names "series auto-paused" as a count the section MUST report in the tick
              summary and heartbeat. Nothing asserts `counts.autoPaused` anywhere in the suite, which is why
              the gap is invisible — grep it: the only hits for `autoPaused` in `tests/` are
              `autoPausedReason` on DB rows. The *state* is always right (the three self-pause tests prove
              that); only the reported count is short. Pre-existing in both close sites, not caused by
              `eac7561`.
      owed:   Have `closeRun` report the auto-pause to the caller it already returns `autoPaused` to, and
              tally it at runner.ts:119 and run.ts:181 as `closeRunCounted` does; add one assertion on
              `counts.autoPaused` so it cannot silently go back to zero.
      traces: FR-047

- [ ] MINOR F3 — `secret-scan.test.ts` scripts single-step fake models around `runTick` and parks nothing, so it is the one file still open to the leak F1 fixed everywhere else.
      where:  tests/integration/security/secret-scan.test.ts:94, tests/integration/security/secret-scan.test.ts:532, tests/integration/security/secret-scan.test.ts:561, tests/integration/security/secret-scan.test.ts:632, src/server/scheduler/index.ts:49
      why:    F1's fix parks series inside `parkAllJobs`, so every file that calls it is now safe. This file
              — added by this feature — imports `clearHolds, clearProjectCredentials, jobsEnv, modelOk` from
              the same helper and deliberately not `parkAllJobs` (line 94), then scripts exactly one model
              step before each `runTick` (lines 532, 561) and exactly two before its standing-series tick
              (line 632). `runTick` runs its sections in one `Promise.all` (scheduler/index.ts:49), so the
              generation section and the standing-series section race for whichever scripted step comes
              first, and a series another file left `enabled` with a past `next_run_at` can take it. I could
              not make this fail: both residual probes above are green, because the scan asserts that no
              secret appears in what it collected, not that a post was produced. The failure mode is
              therefore a *vacuous* scan — line 529's "so the job page carries real token totals" stops
              being true and the page it scans has nothing in it — rather than a red suite.
      owed:   `beforeEach(parkAllJobs)` here too, or at least `parkAllStandingSeries()`.
      traces: FR-066, SC-011

- [ ] MINOR F4 — An image billing refusal requeues forever when the image credential owner is not the series' credential owner, because only the latter gates the claim. (Carried forward: re-review F3, unchanged.)
      where:  src/server/services/standing-series/media.ts:63, src/server/dal/standing-series-claims.ts:62, src/server/llm/resolve.ts:136, src/server/llm/resolve.ts:151, src/server/dal/credential-owners.ts:25
      why:    `credit_exhausted` now requeues with no attempt and the hold stops the series being claimed —
              correct for the normal case. But the two owners are computed differently.
              `credentialOwnerFor` answers `project:<id>` whenever the project has any stored provider
              (credential-owners.ts:25-32), while `resolveImageLlmForProject` uses the project's key only
              when its provider equals the install's image provider (resolve.ts:127-136) and otherwise
              returns `owner: INSTALL_CREDENTIAL_OWNER` (resolve.ts:151). A project whose own provider
              differs from `LLM_IMAGE_PROVIDER` therefore holds `install` on a refusal while the claim gate
              asks about `project:<id>`, so the series is claimed again every time its lease expires, makes
              another refused image call, requeues again, and the run never closes. The text path cannot
              drift this way (resolve.ts:49-60 matches `credentialOwnerFor` exactly).
      traces: FR-050, FR-051, SC-007

- [ ] MINOR F5 — A media skip names the platform, not the account, so it cannot say which of two accounts on that platform failed. (Carried forward: first review F8, re-review F4, unchanged.)
      where:  src/app/p/[projectSlug]/jobs/series/series-logic.ts:81
      why:    `problemLine` renders `${sentence} — ${problem.account.providerName} needs one`. The view
              model carries `displayName` and the position stores `skip_account_id`, so the information is
              to hand. FR-038 asks for "the account whose requirement failed"; a project with two Instagram
              accounts cannot tell them apart, and a removed account renders an empty `providerName`.
      traces: FR-038

- [ ] MINOR F6 — The series lease is never released after a tick, so a multi-tick run waits out the full lease between batches and every ordinary continuation is reported as `recovered`. (Carried forward: first review F9, re-review F5, unchanged.)
      where:  src/server/services/standing-series/runner.ts:435, src/server/dal/standing-series-claims.ts:121
      why:    Nothing clears `lease_owner`/`lease_until` on a normal finish — the producer ends at
              runner.ts:435 with a log line and returns, and `standing-series-claims.ts` exports only
              `claimDueStandingSeries`, no release. The batch runner commits `UNLEASED`
              (jobs/runner.ts:51, 96). The remediation's own test has to space its three ticks six minutes
              apart and says why in a comment (tests/integration/standing-series/edges.test.ts:201). With
              the shipped defaults a 10-post period is five claims five minutes apart, and because
              `recovered` is `lease_until <= now` at select time (claims.ts:121), each ordinary continuation
              is counted and reported as a lease recovery.
      traces: FR-047

- [ ] MINOR F7 — A golden-prompt test asserts nothing: it compares `buildSeriesPlanPrompt(x)` with `buildSeriesPlanPrompt(x)`. (Carried forward: first review F10, re-review F6, unchanged.)
      where:  src/server/services/generation/prompt.golden.test.ts:49
      why:    `standingSeriesPlanPrompt` (line 51) and `oneOffSeriesPlanPrompt` (line 52) are built from the
              identical object, so the test asserts only that a pure function is deterministic, while its
              title claims it proves FR-018's standing-series/one-off parity. The two tests above it are
              real.
      traces: FR-018

- [ ] MINOR F8 — A 14-line ternary in `planSeries` duplicates an entire `llm.generate` call to vary one string literal. (Carried forward: first review F11, re-review F7, unchanged.)
      where:  src/server/services/generation/series.ts:131
      why:    The branches differ only in `label: "generate.standing_series_plan"` versus
              `"generate.series_plan"` — every other argument, including the `buildSeriesPlanPrompt` spread,
              is written out twice. One call with the label chosen by a ternary would do the same thing and
              would stop the two prompt constructions drifting apart.

- NOTE F9 — The re-review's F1 and F2 are closed, and I checked each against the code and then by
  execution rather than against the commit message. F2: `closeStale` returns `autoPaused`
  (run.ts:93-95) and `openOrResumeRun` returns `null` on it (run.ts:121-122) before it can advance
  `last_run_at`/`next_run_at` or spend a planning call; the regression test at self-pause.test.ts:147
  presses Resume on that exact path and asserts the next period produces (`counts.produced` is 1),
  which the old code could not do because runner.ts:192-193 re-reads `enabled`. F1:
  `parkAllStandingSeries` (jobs-env.ts:37) is called from `parkAllJobs` (jobs-env.ts:27), it clears
  the lease as well as the flag, and the two orderings that failed deterministically in the last pass
  are green — see the probe table above. No other caller of `openOrResumeRun` is affected: the only
  product caller is runner.ts:118, and the five test call sites all pass.

- NOTE F10 — `buildScope` grants `media: ["generate"]` to every `job_runner` actor
  (src/server/dal/scope.ts:106), which widens the batch job runner's authority as well as the
  standing-series producer's. Nothing changes today because no batch path calls `generateImage`; it is
  worth knowing the grant is not scoped to standing series. (First review F13, re-review F9.)

- NOTE F11 — T075, the real-app browser walkthrough, is still ticked as "unachievable in this pass"
  (specs/071-evergreen-series/tasks.md:190). Nothing in this feature has been exercised through a
  browser, a real clock boundary or a live provider. It is the one piece of the spec that needs a
  human at a keyboard, and it is correctly parked last. (First review F14, re-review F10.)

- NOTE F12 — `withinBudget` does not abort the work it races, so a media resolution abandoned on
  `Overran` (src/server/services/standing-series/runner.ts:218) keeps running: its image upload and
  `claimMedia` land after the producer has returned, and a late rejection has no handler. That is the
  same shape as `src/server/services/jobs/runner.ts:265`'s `imagesForModel` wrap, so it is the
  sanctioned pattern rather than a new defect — but the standing-series wrap encloses a provider call
  and two writes, which is more than the batch one does. (Re-review F11.)

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 67 | 63 | 4 | 0 | 0 |
| Success criteria | 12 | 10 | 2 | 0 | 0 |
| Constitution principles and engineering rules | 11 | 11 | 0 | 0 | 0 |

Partial FRs: FR-038 (F5), FR-047 (F2 and F6), FR-050 and FR-051 (F4). Partial SCs: SC-006 (F5),
SC-007 (F4). Nothing is contradicted or absent any more: FR-066 and SC-011 — contradicted in the last
pass because the suite was red — are satisfied now (the two failing jobs tests pass unchanged, and
the fix went into the shared test helper rather than into them), and FR-053, FR-054 and SC-007's
resume half are satisfied now that one Resume survives the next tick. The constitution row that was
contradicted last pass was "quality gates (CI must be green before merge)"; the full suite the
implement pass ran on this commit is green, so it is satisfied — subject to CI confirming it.

Re-checked while reading the remediation, all still true: `parkAllStandingSeries` runs inside
`runCrossProject` with a label, like every other cross-project write in the helper (jobs-env.ts:38);
no file calls `parkAllJobs` after creating a series it still needs (`actions-authz.test.ts:455` parks
per-test, before its own `createStandingSeries` calls); `standingSeriesEnv` does not park, so nothing
in the standing-series suite disables its own series mid-test (standing-series-env.ts:7); `closeRun`
is still the single close site every path reaches (run.ts:39-56) and still decides on produced
counts; the section's swallow-and-count is the batch section's line for line
(`scheduler/standing-series.ts:44` vs `scheduler/generation.ts:100`, both `counts.staleResults++`);
and the claim's due predicate (standing-series-claims.ts:63-79) still matches an open run with due
work independently of `next_run_at`, unchanged — the fix removes the orphan run rather than narrowing
the predicate, which is the right place for it.

## What I could not check

- **Anything through a browser.** No route rendered, no form submitted, no keyboard path walked.
  T075 is still unperformed (F11).
- **Any live provider call.** Every provider interaction in the suite is a stub, so F4's livelock and
  F6's lease arithmetic are reasoned from the shipped defaults and the code, not measured.
- **F3's failure mode as a red test.** I ran two file orderings designed to expose it and both are
  green; the finding is that the hazard remains, not that it fails today, and the reason it cannot
  fail is spelled out in the finding. A review phase may not add the missing `beforeEach` to prove it.
- **The full suite on this commit, first-hand.** I read the implement pass's synchronous run
  (642 files, 6077 tests, 0 failures, `EXIT:0`) rather than repeating it, per the constitution's
  proportionality rule, and ran four targeted probes instead. CI on the PR is the independent
  confirmation and has not run yet.
- **ffmpeg-dependent video tests**, which this machine skips, so local green is weaker than CI green
  there. Nothing in this feature touches video.
- **Multi-worker behaviour at real concurrency**, and the migration SQL line by line (`db:check` was
  green in the implement pass and the suite ran against a database migrated from it).
