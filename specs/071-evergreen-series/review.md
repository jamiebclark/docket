# Review: Standing content series that keep producing posts on a cadence

Reviewed 95 file(s) changed across 14 commit(s), against `a6fbea3`...HEAD (merge base with
`origin/main`), diff-first.

Read in full: `src/server/services/standing-series/{runner,run,media,manage,read}.ts`,
`src/server/dal/{standing-series,standing-series-claims}.ts`,
`src/server/db/schema/standing-series.ts`, `src/server/scheduler/{standing-series,config,budget}.ts`,
`src/lib/series/{cadence,avoid}.ts`, `src/lib/validation/standing-series.ts`,
`src/app/p/[projectSlug]/jobs/series/{actions,form-data,series-logic}.ts`,
`src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx`,
`src/app/p/[projectSlug]/jobs/series/SeriesRowActions.tsx`, the `jobs/page.tsx` diff, and every
diff hunk in `src/server/{dal,db,llm,auth,services/generation}`. Read as comparison baselines (not
part of the diff): `src/server/services/jobs/runner.ts`, `src/server/services/generation/core.ts`,
`src/server/services/media-generate.ts`, `src/server/llm/usage.ts`, `src/server/dal/scope.ts`.

Sampled: `tests/integration/standing-series/*` (read `parity`, `self-pause`, `edges`, `dal`,
`idempotency` in full; read the test titles of the other eleven),
`src/app/p/[projectSlug]/jobs/series/StandingSeriesForm.tsx` (grepped for the FR-063 copy and the
live region rather than read line by line), `drizzle/0029_cooing_marrow.sql` (verified current via
`pnpm db:check` rather than read), `docs/generator.md` (new section read in full),
`specs/071-evergreen-series/contracts/{services,worker,ui}.md`.

Not reviewed: `drizzle/meta/0029_snapshot.json` (9,713 generated lines),
`docs/decisions.md` (+173 lines of decision prose — presence checked, wording not audited),
`specs/071-evergreen-series/{research,quickstart,data-model}.md` as artefacts in their own right.

Ran, synchronously, on this worktree: `npx vitest run` (**642 files passed, 8 skipped; 6071 tests
passed, 55 skipped**, exit 0), `npx tsc --noEmit` (clean), `npx eslint` (0 errors, 26 warnings — 2
new, both unused variables in `tests/integration/standing-series/idempotency.test.ts`),
`node scripts/check-migrations-current.mjs` ("Migrations are current."), `npx next build` (exit 0).

## Verdict

The architecture is sound and the pieces genuinely fit: one `applyApprovalPolicy` call site, one
`runGenerationStep` call site, a real config snapshot on the run, database-enforced one-run-per-period
and one-post-per-position, a claim that is a faithful copy of the batch claim, and a parity test that
asserts a byte-identical prompt and an identical generation record against a manual Generate.
Isolation, authorization, policy, slot exclusivity and media sourcing are all covered by integration
tests that assert rows rather than timing. The full suite, typecheck, lint, `db:check` and `build`
are green.

What does not hold up is the **run lifecycle**: the producer loop is the only thing that ever closes a
run, and three of its exit paths leave the run in the wrong state. One of them (F1) permanently loses a
post that FR-022 says must be retried; another (F2) leaves a finished run open for a whole period on the
default configuration; a third (F6) means the self-pause check never fires for the two cases FR-053 was
written for. Separately, three places diverge from `jobs/runner.ts` in ways that look like transcription
gaps rather than decisions: the usage recorder is never flushed on a failure path (F3), the
`window < minCallMs` guard before the model call is missing (F4), and an image-generation billing
refusal skips a position instead of requeueing it (F5). None of these are visible to the test suite,
because every integration test sets `standingSeriesMaxPosts: 5` and none exercises a temporary
generation failure (F12).

Fix F1–F7 and re-run; the remaining four are safe to ship.

## Findings

- [ ] 🛑 BLOCKER F1 — A run is closed, and its remaining post lost forever, as soon as one position enters retry backoff while another finishes in the same tick.
      where:  src/server/services/standing-series/runner.ts:198, src/server/dal/standing-series.ts:313, src/server/services/standing-series/run.ts:17
      why:    `nextDue` returns only positions that are `running` or `queued AND next_attempt_at <= now`
              (dal/standing-series.ts:316); the producer treats `null` as "every position is finished" and
              closes the run (runner.ts:199-202). A position put into backoff by a temporary failure
              (runner.ts:321-326; `nextRetryAt` is `now + 60 s` at the default base) is neither. Concretely:
              a 2-post run, position 0 fails `timeout` on tick 1 and is queued for `now + 60 s`; tick 2
              produces position 1, loops, gets `null` from `nextDue`, and closes the run as `incomplete`.
              The claim predicate requires `closed_at IS NULL` (dal/standing-series-claims.ts:69), so
              position 0 is never looked at again: no post, no failure row, and nothing in the run's
              Problems column, which renders only `skipped` and `failed` (read.ts:138-149). The repo's own
              unit test asserts exactly this `nextDue` result shape at
              tests/integration/standing-series/dal.test.ts:154.
      owed:   Close only when no position is `queued`/`running` at all (count, do not ask `nextDue`); return
              from the tick when the only remaining work is in the future.
      traces: FR-022, FR-025, SC-001

- [ ] MAJOR F2 — A run whose final tick produces exactly `STANDING_SERIES_TICK_MAX_POSTS` posts is never closed by the producer and stays open until the next period boundary.
      where:  src/server/services/standing-series/runner.ts:191, src/server/services/standing-series/runner.ts:392
      why:    The loop exits on `producedThisTick < cfg.maxPosts` without any close; `closeRun` is only
              reached through the `nextDue === null` branch inside the loop. With the shipped default
              `STANDING_SERIES_TICK_MAX_POSTS=2` (config.ts:135) every cadence that is a multiple of 2 —
              2, 4, 6, 8, 10 — ends its last tick on the counter. The run then has no due work and
              `next_run_at` is already the following boundary, so the claim predicate
              (dal/standing-series-claims.ts:65-79) never matches it again; it is finally closed a whole
              period later by `closeStale` (run.ts:64). Until then the detail page shows the badge
              "In progress" (series/[seriesId]/page.tsx:145) and the list shows this period's `lastRunAt`
              paired with the *previous* period's outcome (read.ts:61, and the "Runs" cell in jobs/page.tsx).
      owed:   Close the run before leaving the loop whenever no position is left `queued`/`running`.
      traces: FR-025, FR-058, FR-059

- [ ] MAJOR F3 — Model calls that fail, defer or hit a billing refusal never reach the usage ledger: the recorder is flushed only on the success path.
      where:  src/server/services/standing-series/runner.ts:386, src/server/services/standing-series/runner.ts:245
      why:    `createUsageRecorder` buffers each call and persists nothing until `flush` (llm/usage.ts:83-99).
              The producer creates a fresh recorder per position (runner.ts:245) and calls `flush` only at
              runner.ts:386, after a successful save. Every other exit — `step.ok === "retry"` (line 287),
              `credit_exhausted` (line 294), a recorded failure (lines 298-332) and the `"stale"` return
              (line 383) — returns with the buffer still in memory, so the call vanishes.
              `jobs/runner.ts:336` flushes unconditionally, immediately after the step, which is the
              behaviour being mirrored. A series that times out twice and succeeds once bills three provider
              calls and shows one in Settings → Usage. Nothing covers this: `grep -i usage
              tests/integration/standing-series` returns no match.
      owed:   Flush straight after `runGenerationStep` returns, as the batch runner does, and link the post id
              on the success path.
      traces: FR-024, SC-003

- [ ] MAJOR F4 — The post's model call has no `window < minCallMs` guard, so after a slow image generation it can start with a sub-minimum or negative timeout.
      where:  src/server/services/standing-series/runner.ts:261, src/server/services/standing-series/runner.ts:193
      why:    The only budget check (line 193) happens *before* media resolution. `resolvePositionMedia` then
              makes an unbounded network call for the `generate` source (media.ts:58) and an unbounded
              `imagesForModel` (media.ts:71) — neither wrapped in `withinBudget`, unlike
              `jobs/runner.ts:265`. The window is recomputed at line 261 and passed straight to
              `runGenerationStep` with no check; `jobs/runner.ts:279` has exactly that check
              (`if (window < cfg.minCallMs) return await release()`). With the default
              `SCHEDULER_TICK_BUDGET_SECONDS=20`, an image call taking 15 s leaves a 2 s window — a
              near-certain `timeout` failure with an attempt counted, where the batch runner would have
              released the position untouched. Taking 18 s leaves `-1000`, and `AbortSignal.timeout(-1000)`
              throws `RangeError` (verified on this Node); the throw escapes to the `.catch()` in
              scheduler/standing-series.ts:222, leaving the position `running` to be re-claimed with an
              attempt counted, and failed as `interrupted` at the cap.
      owed:   Budget-wrap media resolution and re-check `window >= cfg.minCallMs` immediately before the call,
              releasing the position to `queued` with no attempt when it fails.
      traces: FR-044

- [ ] MAJOR F5 — An image-generation billing refusal skips the position permanently instead of requeueing it with no attempt counted.
      where:  src/server/services/standing-series/media.ts:62, src/server/services/standing-series/runner.ts:216
      why:    `generateImage` collapses every provider outcome to `{ ok: false, message }`
              (services/media-generate.ts:66), so the `credit_exhausted` kind is gone by the time
              `resolvePositionMedia` sees it; it falls through to `fail("image_generation_failed")`
              (media.ts:62) and the producer marks the position `skipped` (runner.ts:216-223), a terminal
              state. `withImageCreditHold` does set the hold (generation/credit.ts:37-45), so the series
              stops being claimed — but the positions already skipped in that run are never retried. For a
              `generate`-media series whose image provider runs out of credit mid-run, the period's posts
              are lost, the run closes `produced_none`, and three such periods auto-pause the series, which
              is precisely the human intervention SC-007 says is never needed. The "Billing" paragraph added
              to docs/generator.md states the opposite of what the code does.
      owed:   Carry the failure kind out of the image path (or read the hold back) and treat
              `credit_exhausted` as a requeue at `now` with no attempt counted, exactly as the text path
              does at runner.ts:293-297.
      traces: FR-051, SC-007

- [ ] MAJOR F6 — Two of the four ways a run produces nothing close it outside `closeRun`, so the self-pause check never runs for a blocked or all-failed series.
      where:  src/server/services/standing-series/run.ts:149, src/server/services/standing-series/run.ts:66
      why:    `shouldSelfPause` is consulted only from `closeRun` (runner.ts:103-108). A run blocked by a
              missing voice profile or no usable target is closed inside `openOrResumeRun` (run.ts:149) and
              the producer returns at runner.ts:127-130 without reaching it. A run whose every position took
              a lasting failure returns at runner.ts:332 and is closed a period later by `closeStale`
              (run.ts:66), which also bypasses it. So a series whose voice profile has been archived produces
              nothing, period after period, and never pauses itself — the exact case FR-053 exists for.
              tests/integration/standing-series/self-pause.test.ts:66-68 documents the gap in a comment
              ("unlike a blocked-reason or per-position immediate failure, neither of which route through
              it") and then picks the one path that does work, so the suite stays green.
      owed:   Run the self-pause check from one place that every close goes through.
      traces: FR-053

- [ ] MAJOR F7 — `shouldSelfPause` counts any `incomplete` run as "produced nothing", so a series that produced posts every period can still be auto-paused.
      where:  src/server/services/standing-series/run.ts:27
      why:    `deriveRunOutcome` returns `incomplete` whenever anything is still open, "regardless of what
              was produced" (run.ts:19, and the test name at run-lifecycle.test.ts:53). `shouldSelfPause`
              then treats `incomplete` as a zero-post run without looking at the counts, because
              `recentClosedOutcomes` selects only `outcome` (dal/standing-series.ts:245-253). A
              10-posts-a-day series on a busy worker that is cut off at each boundary with 7 of 10 posts
              written is paused after three days and needs an owner to resume it. FR-053 says "each produced
              no post" and contracts/services.md § 7.5 says "`incomplete` with nothing produced"; the
              qualifier was dropped in the code.
      owed:   Decide on produced counts, not on the outcome enum alone.
      traces: FR-053

- [ ] MINOR F8 — A media skip names the platform, not the account, so it cannot say which of two accounts on that platform failed.
      where:  src/app/p/[projectSlug]/jobs/series/series-logic.ts:81
      why:    `problemLine` renders `${sentence} — ${problem.account.providerName} needs one`, e.g. "No
              unused images left in the pool — Instagram needs one". `StandingSeriesAccountView` carries
              `displayName` (read.ts:33) and the position stores `skip_account_id`, so the information is
              to hand. FR-038 asks for "the account whose requirement failed"; a project with two Instagram
              accounts cannot tell them apart, and a removed account renders an empty `providerName`.
      traces: FR-038

- [ ] MINOR F9 — The series lease is never released after a tick, so a multi-tick run waits out the full lease between batches and every ordinary continuation is reported as `recovered`.
      where:  src/server/services/standing-series/runner.ts:392, src/server/dal/standing-series-claims.ts:121
      why:    Nothing clears `lease_owner`/`lease_until` on a normal finish; the batch runner commits
              `UNLEASED` (jobs/runner.ts:51, 96). With the defaults (`SCHEDULER_LEASE_SECONDS=300`,
              `WORKER_INTERVAL_SECONDS=60`, `STANDING_SERIES_TICK_MAX_POSTS=2`) a 10-post period takes five
              claims five minutes apart — about 20 minutes of waiting rather than of work. And because
              `recovered` is `lease_until <= now` at select time (standing-series-claims.ts:121), each of
              those ordinary continuations is counted and reported as a lease recovery, which is what
              FR-047 means to use for killed processes.
      traces: FR-047

- [ ] MINOR F10 — A golden-prompt test asserts nothing: it compares `buildSeriesPlanPrompt(x)` with `buildSeriesPlanPrompt(x)`.
      where:  src/server/services/generation/prompt.golden.test.ts:49
      why:    `standingSeriesPlanPrompt` and `oneOffSeriesPlanPrompt` are built from the identical object, so
              the test asserts only that a pure function is deterministic, while its title claims it proves
              FR-018's standing-series/one-off parity. The two tests above it are real; this one should
              either compare the two call sites' actual argument construction or go.
      traces: FR-018

- [ ] MINOR F11 — A 14-line ternary in `planSeries` duplicates an entire `llm.generate` call to vary one string literal.
      where:  src/server/services/generation/series.ts:131
      why:    The two branches differ only in `label: "generate.standing_series_plan"` versus
              `"generate.series_plan"`. One call with `label: purpose === "generate.standing_series_plan" ? …
              : …` would do the same thing and would stop the two prompt constructions drifting apart.

- [ ] MINOR F12 — No test exercises the per-tick post bound or a temporary generation failure, which is why F1, F2 and F3 are invisible to a green suite.
      where:  tests/integration/standing-series/parity.test.ts:31
      why:    All ten integration configs set `standingSeriesMaxPosts: 5` against cadences of 1–3, so the
              `producedThisTick < cfg.maxPosts` exit (runner.ts:191) is never taken and FR-044's documented
              per-tick bound is never asserted. `grep -rn 'retried' tests/integration/standing-series` finds
              nothing either: the `TEMPORARY`-with-backoff branch (runner.ts:315-327), which is the whole of
              FR-022, has no test.
      traces: FR-022, FR-044

- NOTE F13 — `buildScope` now grants `media: ["generate"]` to every `job_runner` actor (src/server/dal/scope.ts:106 and 236-243), which widens the batch job runner's authority as well as the standing-series producer's. The comment says why and no batch path calls `generateImage`, so nothing changes today; it is worth knowing the grant is not scoped to standing series.

- NOTE F14 — T075, the real-app browser walkthrough, is recorded in tasks.md as unachievable in a headless pass. Nothing in this feature has been exercised through a browser, a real clock boundary or a live provider; every provider interaction in the suite is a stub.

- NOTE F15 — The composite `posts → standing_series_positions` foreign key is `ON DELETE SET NULL` over `(project_id, standing_series_position_id)`, which would null a `NOT NULL` column, so `clearPostLinksForRuns` (dal/standing-series.ts:350) is load-bearing for both delete paths. I probed the remaining worry — a project delete cascading to both tables at once — against the test Postgres and it succeeds, so the key is safe as written.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 67 | 60 | 6 | 0 | 1 |
| Success criteria | 12 | 7 | 4 | 0 | 0 |
| Constitution principles and engineering rules | 11 | 10 | 1 | 0 | 0 |

Partial FRs: FR-022, FR-024, FR-038, FR-044, FR-051, FR-053. Contradicted: FR-025.
Partial SCs: SC-001, SC-003, SC-007, SC-010. SC-012 is counted satisfied on the plan's own terms — it
is a structural property of the producer reading nothing but the run's `config`, `plan` and positions,
and no test here can verify it; its check belongs with `dated-series`. The one partial constitution row
is "`runTick()` bounded, killable, concurrent-safe" (F4): claimed, killed and concurrent are all
genuinely covered, bounded is the half that slipped.

Verified clean while reading: no `pg_advisory`, `LISTEN` or `NOTIFY` anywhere in the new code or the
migration; no provider call inside a held transaction (the plan call, the post call, the image call and
`prepareVariants` are all between transactions); `package.json` and `pnpm-lock.yaml` untouched
(constitution VI); the three new tables are registered in `project-owned.ts`; exactly one
`applyApprovalPolicy` call site, asserted by `tests/integration/standing-series/policy.test.ts:163`;
`SCHEDULING_POLICIES` has no explicit-time value at all, so FR-033 is structural rather than enforced;
the image prompt is `prompt + NO_REAL_PEOPLE` and nothing else (FR-036); the unknown-placeholder message
is byte-identical to `services/jobs/create.ts:54` (FR-003); and SC-011 holds — every pre-existing test
passed unchanged, with the only edits to existing tests being additive (new enum values, a longer log
line, one renamed test title).

## What I could not check

- **Anything through a browser.** No route was rendered in a browser, no form submitted, no keyboard
  path walked. FR-062's focus order, visible focus and announced errors were read in the component
  source and in `ui.test.tsx`'s render assertions, not operated. T075 is still open (F14).
- **Any live provider call.** Latency, the planner's actual obedience to "titles to avoid", real image
  generation timing — which is what makes F4 bite — and real billing refusals are all stubbed. The plan
  chose this and I agree with the choice; it does mean F4's severity is reasoned from the 20 s default
  budget and the ~1.3 s/call figure already recorded in `docs/generator.md`, not measured.
- **ffmpeg-dependent video tests**, which this machine skips, so local green is weaker than CI green
  there. Nothing in this feature touches video, and `claimPoolImage` pins `kind = "image"`.
- **`docs/decisions.md`'s W1–W34 and S1–S40 completeness.** I confirmed the section exists and is 173
  lines; I did not check every decision id against spec.md and plan.md.
- **Multi-worker behaviour at real concurrency.** `slots.test.ts` and `idempotency.test.ts` race two
  un-awaited ticks against one Postgres, which is the right shape, but not a multi-process install.
- **The migration SQL line by line.** `pnpm db:check` reports the committed SQL matches the schema, and
  both `next build` and the full suite ran against a database migrated from it; I did not read all 138
  lines.
