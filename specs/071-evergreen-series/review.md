# Review: Standing content series that keep producing posts on a cadence

Re-review after remediation. 97 file(s) changed across 15 commit(s), against
`a6fbea3`...HEAD (merge base with `origin/main`), diff-first.

Per the constitution's "review is exhaustive once, then scoped" rule, this pass checked (a) that
each of the previous review's seven blocking findings is actually closed and (b) that the files the
remediation commit `75cb757` touched introduced no regression — it did not re-open the first
review's lines of inquiry.

Read in full: the whole of `75cb757`'s diff (`src/server/dal/standing-series.ts`,
`src/server/services/media-generate.ts`, `src/server/services/standing-series/{media,run,runner}.ts`,
`tests/integration/standing-series/{edges,run-lifecycle,self-pause}.test.ts`), and then the current
state of `src/server/services/standing-series/{runner,run,media,manage}.ts`,
`src/server/dal/{standing-series-claims,credential-owners}.ts`,
`src/server/scheduler/{standing-series,budget}.ts`, `src/server/llm/{usage,resolve}.ts`. Read as
comparison baselines (not part of the diff): `src/server/services/jobs/runner.ts`,
`src/server/scheduler/generation.ts`, `tests/helpers/jobs-env.ts`,
`tests/integration/jobs/{recovery,processing}.test.ts`.

Sampled: `docs/generator.md` (the standing-series section and both billing paragraphs),
`.env.example`, `src/app/p/[projectSlug]/jobs/series/series-logic.ts` and `[seriesId]/page.tsx`
(FR-064 copy only), `specs/071-evergreen-series/contracts/{services,ui}.md`, `research.md` S31–S33.

Not reviewed again (unchanged since the first review, which read them): the UI components, the DAL
beyond the two files above, the migration SQL, `docs/decisions.md` prose, `drizzle/meta/*`.

Ran, synchronously, on this worktree: `npx tsc --noEmit` (clean), `npx eslint` (0 errors, 26
warnings — unchanged), `node scripts/check-migrations-current.mjs` ("Migrations are current."),
and `npx vitest run` (**640 files passed, 2 failed, 8 skipped; 6074 tests passed, 2 failed, 55
skipped**). The constitution tells a review not to re-run the full suite; I did, and it is the only
reason F1 below was found, so I am recording that rather than hiding it. Both failures were then
reproduced deterministically with targeted runs (see F1).

## Verdict

The seven blocking findings are genuinely closed, not papered over: `closeRun` is now one function
that every close site reaches, it decides the outcome from `countByStatus` rather than from
`nextDue` returning `null`, the per-tick cap exit closes a finished run before leaving the loop, the
usage recorder is flushed on every exit, media resolution is budget-wrapped with a second
`window >= minCallMs` check before the model call, an image billing refusal requeues instead of
skipping, and `shouldSelfPause` counts produced posts instead of reading the outcome enum. The two
regression tests the first review asked for are real tests that would fail against the old code, and
`docs/generator.md`'s billing paragraph now matches what the code does.

Two things do not hold. The remediation made `closeStale` auto-pause — but `closeStale` runs inside
`openOrResumeRun`, which then opens another run anyway, and that orphan run is what defeats the
Resume button a period later (F2). And the full suite is no longer green: the new worker section
picks up standing series that earlier test files left enabled in the same worker database, which
breaks two **pre-existing** batch-job tests — the exact thing FR-066 and SC-011 exist to prevent
(F1). Both are reproducible; neither is visible from a single targeted run.

Fix F1 and F2 and re-run. The five MINORs are safe to ship; four of them are carried forward
unchanged from the first review, which is expected — only blocking findings became tasks.

## Findings

- [ ] MAJOR F1 — The full test suite is no longer green: the standing-series tick section claims series that earlier test files left enabled in the same worker database, breaking two pre-existing batch-job tests.
      where:  tests/helpers/jobs-env.ts:20, tests/integration/jobs/recovery.test.ts:46, tests/integration/jobs/processing.test.ts:64, src/server/scheduler/standing-series.ts:37
      why:    Vitest gives each worker one database (`tests/setup/worker-databases.ts`) shared by every file
              that worker runs. `parkAllJobs` exists precisely for that — it cancels leftover `queued`/
              `running` job items, clears credit holds and clears project credentials, "whatever ran before
              it in the worker" (jobs-env.ts:64-66). It does not touch `standing_series`, so a series left
              behind by a standing-series file stays `enabled` with `next_run_at` in 2026-01, i.e.
              permanently due. `runTick` now runs the standing-series section too, so the next file that
              calls `runTick` has its scripted `createFakeLlm` steps consumed by somebody else's series.
              Reproduced deterministically, twice:
                DOCKET_TEST_WORKERS=1 npx vitest run --no-file-parallelism \
                  tests/integration/standing-series/cadence.test.ts tests/integration/jobs/recovery.test.ts
                  -> recovery.test.ts:46 "expected [...] to have a length of 1 but got 2"
                DOCKET_TEST_WORKERS=1 npx vitest run --no-file-parallelism \
                  tests/integration/standing-series/ tests/integration/jobs/processing.test.ts
                  -> processing.test.ts:64 "expected {...} to match object { status: 'completed' }"
              Each file passes alone, which is why the first review's single full run happened to be green:
              whether it fails depends on which files land in which worker. FR-066 requires the existing
              batch-job tests to stay "green unchanged" and SC-011 says so in as many words; the
              constitution also makes `pnpm test` a merge gate. I am raising this as MAJOR rather than the
              MINOR the re-review rule would otherwise imply, because a suite that fails cannot be merged —
              downgrade it if you disagree, but it has to be fixed either way.
      owed:   Park standing series in the same place and for the same reason `parkAllJobs` parks job items:
              set `enabled = false` and clear the lease on every row, so a jobs suite starts from the
              install's own configuration whatever ran before it.
      traces: FR-066, SC-011

- [ ] MAJOR F2 — Resuming a self-paused series re-pauses it on the very next tick, because the auto-pause tick leaves behind an orphan run that then closes as "produced nothing".
      where:  src/server/services/standing-series/run.ts:94, src/server/services/standing-series/run.ts:117, src/server/services/standing-series/run.ts:50, src/server/services/standing-series/manage.ts:159
      why:    The remediation routed `closeStale` through the shared `closeRun` (run.ts:94) so FR-053 applies
              to every close — correct in itself. But `closeStale` is called from *inside* `openOrResumeRun`
              (run.ts:117-120), and nothing after it re-reads `enabled`: the function goes on to insert the
              current period's run, advance `last_run_at`/`next_run_at` (run.ts:156-164) and, at cadence >= 2,
              spend a planning model call (runner.ts:130-184), before the producer's only `enabled` check at
              runner.ts:192-193 returns. So the tick that auto-pauses a series also opens a fresh run on it
              and leaves it open with every position `queued` — the state
              `tests/integration/standing-series/self-pause.test.ts:120-145` describes in its own comment and
              tolerates with `expect(closed.length).toBeGreaterThanOrEqual(3)`.
              Now press Resume. `resumeStandingSeries` (manage.ts:152-167) sets `enabled`, clears
              `auto_paused_reason` and moves `next_run_at` to the coming boundary; it does not close that
              orphan run. The claim's due predicate matches an open run with a due position regardless of
              `next_run_at` (standing-series-claims.ts:65-79), so the series is claimed on the next tick,
              `openOrResumeRun` finds the orphan is a prior period's, and `closeStale` closes it with
              `produced = 0`. `recentClosedProduced` then returns that run plus the two zero runs that caused
              the original pause, `shouldSelfPause` is true again (run.ts:50-54), and the series is disabled
              before it writes a single post. One Resume, no posts, paused again — against FR-053's "resume
              it in one action" and US6 AS4. The self-pause tests never press Resume on this path (the one
              that does, self-pause.test.ts:85, paused through the producer's own close, which leaves no
              orphan run), so the suite stays green.
      owed:   Stop `openOrResumeRun` opening a new run when the close it just performed paused the series:
              re-read `enabled` after `closeStale` and return. Closing the orphan on resume, or ignoring runs
              that closed before the resume, would each also break the loop; the first is the smaller change.
      traces: FR-053, FR-054, SC-007

- [ ] MINOR F3 — An image billing refusal requeues forever when the image credential owner is not the series' credential owner, because only the latter gates the claim.
      where:  src/server/services/standing-series/media.ts:63, src/server/dal/standing-series-claims.ts:62, src/server/llm/resolve.ts:136, src/server/dal/credential-owners.ts:25
      why:    The F5 fix is right for the normal case: `credit_exhausted` requeues with no attempt, the hold
              stops the series being claimed, and the probe resumes it. But the two owners are computed
              differently. `credentialOwnerFor` says `project:<id>` whenever the project has *any* stored
              provider (credential-owners.ts:25-31), while `resolveImageLlmForProject` uses the project's key
              only when its provider equals the install's image provider, and otherwise returns
              `owner: "install"` (resolve.ts:126-152). A project whose own provider differs from
              `LLM_IMAGE_PROVIDER` therefore holds `install` on a refusal while the claim gate asks about
              `project:<id>` — so the series is claimed again every time its lease expires, makes another
              refused image call, requeues again, and the run never closes. The text path cannot drift this
              way (resolve.ts:49-60 matches `credentialOwnerFor` exactly), which is why the mirror reads
              correct.
      traces: FR-050, FR-051, SC-007

- [ ] MINOR F4 — A media skip names the platform, not the account, so it cannot say which of two accounts on that platform failed. (First review F8, unchanged.)
      where:  src/app/p/[projectSlug]/jobs/series/series-logic.ts:81
      why:    `problemLine` renders `${sentence} — ${problem.account.providerName} needs one`. The view model
              carries `displayName` and the position stores `skip_account_id`, so the information is to hand.
              FR-038 asks for "the account whose requirement failed"; a project with two Instagram accounts
              cannot tell them apart, and a removed account renders an empty `providerName`.
      traces: FR-038

- [ ] MINOR F5 — The series lease is never released after a tick, so a multi-tick run waits out the full lease between batches and every ordinary continuation is reported as `recovered`. (First review F9, unchanged.)
      where:  src/server/services/standing-series/runner.ts:425, src/server/dal/standing-series-claims.ts:121
      why:    Nothing clears `lease_owner`/`lease_until` on a normal finish; the batch runner commits
              `UNLEASED` (jobs/runner.ts:51, 96). The remediation's own new test has to space its three ticks
              six minutes apart and says why in a comment — "each tick must outlast the series lease (default
              300s) for the worker to re-claim the same still-open run"
              (tests/integration/standing-series/edges.test.ts:201). With the shipped defaults a 10-post
              period is five claims five minutes apart, and because `recovered` is `lease_until <= now` at
              select time, each ordinary continuation is counted and reported as a lease recovery.
      traces: FR-047

- [ ] MINOR F6 — A golden-prompt test asserts nothing: it compares `buildSeriesPlanPrompt(x)` with `buildSeriesPlanPrompt(x)`. (First review F10, unchanged.)
      where:  src/server/services/generation/prompt.golden.test.ts:49
      why:    `standingSeriesPlanPrompt` and `oneOffSeriesPlanPrompt` are built from the identical object, so
              the test asserts only that a pure function is deterministic, while its title claims it proves
              FR-018's standing-series/one-off parity. The two tests above it are real.
      traces: FR-018

- [ ] MINOR F7 — A 14-line ternary in `planSeries` duplicates an entire `llm.generate` call to vary one string literal. (First review F11, unchanged.)
      where:  src/server/services/generation/series.ts:131
      why:    The branches differ only in `label: "generate.standing_series_plan"` versus
              `"generate.series_plan"`. One call with the label chosen by a ternary would do the same thing
              and would stop the two prompt constructions drifting apart.

- NOTE F8 — The first review's F1–F7 are closed, and I checked each against the code rather than against the commit message. F1: runner.ts:195-203 now asks `countByStatus` and returns while work remains, covered by edges.test.ts:224-258. F2: runner.ts:428-433 closes after the cap exit, covered by edges.test.ts:178-213. F3: `recorder.flush()` on every exit (runner.ts:321, 329, 366, 419, 422). F4: media resolution is budget-wrapped (runner.ts:216-228) and the window re-checked at runner.ts:283-290. F5: `generateImageWithKind` keeps the kind (media-generate.ts:45) and runner.ts:230-236 requeues — and docs/generator.md:209 now says the same thing, where before it said the opposite. F6/F7: one `closeRun` (run.ts:39-57) reached by all four close sites, deciding on `produced` counts.

- NOTE F9 — `buildScope` grants `media: ["generate"]` to every `job_runner` actor (src/server/dal/scope.ts:106), which widens the batch job runner's authority as well as the standing-series producer's. Nothing changes today because no batch path calls `generateImage`; it is worth knowing the grant is not scoped to standing series. (First review F13.)

- NOTE F10 — T075, the real-app browser walkthrough, is still recorded as unachievable in a headless pass. Nothing in this feature has been exercised through a browser, a real clock boundary or a live provider. (First review F14.)

- NOTE F11 — `withinBudget` does not abort the work it races, so a media resolution abandoned on `Overran` (runner.ts:218) keeps running: its image upload and `claimMedia` land after the producer has returned, and a late rejection has no handler. That is the same shape as `jobs/runner.ts:265`'s `imagesForModel` wrap, so it is the sanctioned pattern rather than a new defect — but the standing-series wrap encloses a provider call and two writes, which is more than the batch one does.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 67 | 61 | 5 | 0 | 1 |
| Success criteria | 12 | 9 | 2 | 0 | 1 |
| Constitution principles and engineering rules | 11 | 10 | 0 | 0 | 1 |

Partial FRs: FR-038 (F4), FR-047 (F5), FR-050/FR-051 (F3, counted once), FR-053 and FR-054 (F2).
Contradicted: FR-066 (F1). Partial SCs: SC-006 (F4), SC-007 (F2 and F3). Contradicted SC: SC-011
(F1). The contradicted constitution row is "quality gates (CI must be green before merge)", for the
same reason. FR-022, FR-024, FR-025 and FR-044 — partial or contradicted in the first review — are
satisfied now, each with a test that exercises the path rather than the shape.

Verified again while reading the remediation: `recentClosedProduced` is project-scoped on both
statements and orders identically to its two siblings (dal/standing-series.ts:256-277);
`countByStatus` starts from `emptyPositionCounts()`, so `hasOpenWork` can never read `undefined`
(dal/standing-series.ts:327-336); `flush(link?)` is optional, so the new no-argument calls both type
and behave (llm/usage.ts:25, 83-90); `generateImage` keeps its old signature for the server action
and only the new `generateImageWithKind` exposes the kind, so the Media page is untouched; the
scheduler section's swallow-and-count is the batch section's, line for line
(scheduler/standing-series.ts:44 vs scheduler/generation.ts:100); W1–W34 are all present in
`docs/decisions.md`; both `STANDING_SERIES_TICK_MAX_*` are documented in `.env.example`; FR-064's
alert is rendered, not just declared (series-logic.ts:101, [seriesId]/page.tsx:108); and S32 settles
what first looked like an FR-055 violation — a resumed series continuing its open run is the
documented intent ("a period it still owes"), not a defect.

## What I could not check

- **Anything through a browser.** No route rendered, no form submitted, no keyboard path walked.
  T075 is still open (F10).
- **Any live provider call.** Every provider interaction in the suite is a stub, so F3's livelock and
  F5's lease arithmetic are reasoned from the shipped defaults and the code, not measured.
- **F2 end to end.** I confirmed every step from code I read plus the state
  `self-pause.test.ts:120-145` already asserts, and a review phase may not write a test to prove it.
  It is the one finding here with no execution behind it; the three facts it rests on — the orphan run
  exists, the claim predicate matches an open run regardless of `next_run_at`, and
  `recentClosedProduced` counts it — are each checkable in the cited lines.
- **ffmpeg-dependent video tests**, which this machine skips, so local green is weaker than CI green
  there. Nothing in this feature touches video.
- **Multi-worker behaviour at real concurrency**, and the migration SQL line by line (`db:check` is
  green and the whole suite ran against a database migrated from it).
