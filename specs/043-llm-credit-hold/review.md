# Review: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

Third review pass. Reviewed the feature as two pieces of evidence, because that is how it now exists on disk:

1. **The landed body**, 66 files over 4 non-merge commits, read as `git diff 84e752e^1 84e752e` — the
   contribution that PR #91 (`059-llm-credit-hold`) merged into `main` at `84e752e`. This resolves the
   previous pass's MAJOR F1: the work is committed, pushed, and CI was green on it (`commitlint`, `guard`,
   `static`, `test (1–4)`, `build`, `docker`, `docs-build` all SUCCESS; `deploy`/`release`/`edge`/`image`
   skipped).
2. **The second remediation**, 13 uncommitted working-tree paths on branch `062-credit-hold-test-integrity`
   (T076–T079), read as `git diff HEAD`. This branch has **no commits of its own** —
   `git merge-base HEAD origin/main` is `84e752e`, which is `HEAD` — so there is no branch diff and no CI run
   for these changes. That is finding F1 below.

Read in full: `src/server/dal/credit-holds.ts`, `src/server/dal/credential-owners.ts`,
`src/server/dal/job-claims.ts`, `src/server/services/generation/credit.ts`,
`src/server/services/jobs/runner.ts` (the credit paths and the whole `processClaimedItem` control flow),
`src/server/services/jobs/read.ts`, `src/server/scheduler/generation.ts`, `src/server/llm/anthropic.ts`,
`src/server/llm/openai.ts`, `src/server/llm/messages.ts`, `src/server/llm/types.ts`,
`src/server/db/schema/generation.ts`, `drizzle/0023_chemical_elektra.sql`, `src/lib/jobs/credit-hold.ts`,
`src/app/p/[projectSlug]/jobs/JobNotice.tsx`, `src/app/p/[projectSlug]/jobs/CreditHoldNotice.tsx`, both jobs
pages, `JobItemsTable.tsx`, `scripts/llm-check.ts`, `scripts/check-migrations-current.mjs`,
`tests/helpers/jobs-env.ts`, `tests/helpers/llm-scenarios.ts`, `tests/integration/jobs/credit-hold.test.ts`,
`credit-outage.test.ts`, `credit-probe.test.ts`, `dal.test.ts`, `recovery.test.ts`, `cancel.test.ts`,
`tests/integration/jobs/ui.test.tsx`, `tests/integration/no-plaintext.test.ts`,
`tests/integration/security/secret-scan.test.ts` (the new section), `src/server/llm/anthropic.test.ts`,
`openai.test.ts`, `messages.test.ts`, `src/server/dal/credential-owners.test.ts`,
`src/lib/jobs/credit-hold.test.ts`, and the whole of `spec.md`'s requirements, `plan.md`, `research.md`
H1–H19, `contracts/services.md`, `data-model.md`, `docs/decisions.md` C1–C14 and H1–H19,
`docs/generator.md`, `docs/n8n.md`, `docs/security.md`.

Sampled: `tests/integration/api/endpoints/jobs.test.ts`, `tests/integration/generation/*.test.ts`,
`tests/integration/voice/try-it.test.ts` (read their new cases only), `drizzle/meta/0023_snapshot.json`
(checked the journal entry and the table/enum shape, not the 8,177-line snapshot line by line),
`quickstart.md`, `checklists/requirements.md`.

Not reviewed: the 132 files in the base-branch diff that belong to features 057/060/061 (notification
preferences, email delivery, email test isolation) — they are not this feature's work; `node_modules`.

**Gates run in this phase, on Windows, against a local Postgres 17:**

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | 0 errors, 23 warnings (all pre-existing `_`-prefixed unused params and unused test imports; one is `credential-owners.ts:14`, the deliberate `_projectId`) |
| full `vitest run` with `DOCKET_SKIP_PERF_TESTS=1` (CI's main test step) | **577 files passed, 8 skipped; 5,516 tests passed, 55 skipped** |
| the timing-budget step exactly as CI runs it (`activity/performance.test.ts notifications/performance.test.ts --no-file-parallelism`) | **2 files, 5 tests passed** |
| `drizzle-kit check` | `Everything's fine` — migration history consistent |
| `pnpm db:check` | **false failure on Windows** — see F4 |

## Verdict

**The feature satisfies its spec and hangs together.** Thirty-seven of the 38 functional requirements are
satisfied outright, and the two the previous pass called partial (FR-016's rewind and FR-033's
`no-plaintext` half) are now closed by real tests rather than by argument. The four pieces that twelve
implement passes built separately — the two provider predicates, the hold table and its gate, the claim's
owner/probe plumbing, and the two screens — read as one design on a second pass: one `withCreditHold`
wrapper covering all four model-call sites (`core.ts:111`, `series.ts:86`, `scripts/llm-check.ts:91`, and
the runner through `runGenerationStep`), one `CREDIT_PROBE_INTERVAL_MS`, one `credentialOwnerFor` seam, one
`JobNotice` shape shared by the new notice and the two it sits beside. I found no duplicated abstraction, no
dead code and no data-shape mismatch between producer and consumer; the one interface that *did* drift
between passes (`jobsExcludingOwners` → `jobsExcludingProjects`, and H8's reversed item predicate) is what
T076–T079 have now reconciled across code, contracts, `plan.md`, `research.md`, `data-model.md` and
`docs/decisions.md` — `grep` finds no surviving reference to the old name outside this review's own prose
and the historical text of T023.

**What blocks the merge is not the code — it is that the code is not committed.** For the second time an
implement pass has ticked its tasks (T076–T079 are all `[X]`) and left the result in the working tree. Ten
of the thirteen uncommitted paths are substantive: `credential-owners.ts`, `job-claims.ts`, three test
files, `docs/decisions.md` and four spec artifacts. Everything I ran on them is green, but green on one
Windows machine is not the gate the constitution names, and there is nothing a human can review, push or
merge. The fix is mechanical: commit in logical Conventional Commits with explicit paths, push, open the PR.

Two things deserve a human's attention beyond that. First, `pnpm db:check` — a named quality gate — is
*confidently wrong* on Windows: it prints "migration history is inconsistent" and `undefinedundefined` when
the history is in fact fine, because `spawnSync("pnpm", …)` without `shell` is ENOENT there. Three review
passes have now recorded it and nobody has tasked it; it is a small fix and it deserves a decision rather
than a fourth sighting. Second, `counts.probed` tells the operator a probe was *made* when all it knows is
that one was *granted* — the contract documents it that way, so the honest fix is to change one of the two.

## Findings

- [ ] MAJOR F1 — The second remediation is ticked but entirely uncommitted: branch
      `062-credit-hold-test-integrity` has no commits of its own, so there is nothing to push, nothing to
      merge, and no CI has run on any of it.
      where:  specs/043-llm-credit-hold/tasks.md:299, .specify/memory/constitution.md:84,
              .specify/memory/constitution.md:96
      why:    `git merge-base HEAD origin/main` returns `84e752e`, which is also `HEAD`, so
              `git diff --stat $(git merge-base HEAD origin/main)...HEAD` is empty — the branch is
              byte-identical to `main`. Meanwhile `git status --porcelain` lists 13 modified paths, and
              T076, T077, T078 and T079 are all marked `[X]` (tasks.md:299, :301, :303, :305). Ten of the
              thirteen are substantive work, not just this review's own artifacts:
              `src/server/dal/credential-owners.ts` and `src/server/dal/job-claims.ts` (the
              `jobsExcludingOwners` → `jobsExcludingProjects` rename),
              `src/server/dal/credential-owners.test.ts`, `tests/integration/jobs/dal.test.ts` (a rewritten
              SC-007 test), `tests/integration/jobs/credit-probe.test.ts` (a new FR-015 test),
              `tests/integration/no-plaintext.test.ts` (the FR-033 rewrite), `docs/decisions.md` (H2 and
              H8), and four spec artifacts. The constitution requires a commit after each completed task
              with explicit paths (`:84`) and CI green before merge (`:96`); auto-commit is off for every
              event in `.specify/extensions/git/git-config.yml` (`auto_commit.default: false`), so the
              implement phase owns this and did not do it. This is the same defect the previous pass raised
              as F1 and a human fixed by hand as PR #91 — it has recurred, which is itself worth knowing.
      owed:   Stage explicit paths only — never `git add -A`, `git add .` or `git commit -a` — in
              Conventional Commits, each message ending with the required `Co-Authored-By:` trailer.
              Suggested split: `refactor(jobs)` for `credential-owners.ts`, `job-claims.ts` and
              `credential-owners.test.ts` (the rename); `test(jobs)` for `dal.test.ts`,
              `credit-probe.test.ts` and `no-plaintext.test.ts`; `docs` for `docs/decisions.md`;
              `docs(plan)` for `specs/043-llm-credit-hold/plan.md`, `research.md`, `data-model.md`,
              `quickstart.md` and `contracts/services.md`; and `docs(tasks)` / `docs(review)` for
              `tasks.md` and `review.md`. Then push and open the PR so CI runs `pnpm db:check` on Linux
              (which this machine cannot — F4), the Docker image build, commitlint and the timing-budget
              step.
      traces: constitution "Development Workflow — Commits", constitution "Quality gates"

- [ ] MINOR F2 — `counts.probed` reports a probe that was *granted*, not one that was *made*, so the tick
      summary and the heartbeat tell an operator a model call happened when none did.
      where:  src/server/scheduler/generation.ts:92, src/server/scheduler/generation.ts:38,
              src/server/dal/job-claims.ts:98, src/server/dal/job-claims.ts:182,
              src/server/services/jobs/runner.ts:416
      why:    FR-021 asks the summary to report "whether a probe was **made**". `counts.probed` is
              `claim.probing.length > 0 ? 1 : 0`, which is the gate's *grant*, computed before anything is
              claimed. Three code paths grant a probe and then give the interval straight back without
              calling the model: no claimable job at all (`job-claims.ts:98`), a claimable job whose due
              items were all `SKIP LOCKED` by another tick (`:182`), and a claim whose tick budget is too
              short for a call (`runner.ts:416`). The third is a documented configuration, not a freak
              case, and `credit-probe.test.ts:205` ("a probe granted when the tick budget is too short to
              call the model") exercises it: it asserts `fake.requests` is empty and `nextProbeAt <= now`
              — no call, interval rewound — while `counts.probed` for that tick would still be 1. This is a
              spec/plan disagreement rather than an oversight: `contracts/services.md` §5 and the field's
              own doc comment (`generation.ts:37`) both describe the grant, so one of the two is wrong.
      owed:   Pick one and make both say it. Either rename the field and FR-021's wording to the grant
              (`probeGranted`), or set it from the outcome — the runner already knows, since `calledModel`
              at `runner.ts:324` is exactly "a call was made"; threading that back into `counts` is the
              honest version and costs one assignment.
      traces: FR-021, contracts/services.md §5

- [ ] MINOR F3 — An exception thrown before `processClaimedItem`'s `try` spends a granted probe interval,
      because the rewind that implements FR-016 lives in that `try`'s `finally`.
      where:  src/server/services/jobs/runner.ts:87, src/server/services/jobs/runner.ts:233,
              src/server/services/jobs/runner.ts:416
      why:    Carried unchanged from the previous pass (F9) and re-confirmed by reading the control flow.
              The `try` whose `finally` holds
              `if (claimed.probe && !calledModel) await rewindCreditProbe(...)` opens at `:233`. Line
              `:87` — `const sourceKey = item.externalId ? apiSourceMetaSchema.parse(job.sourceMeta).sourceKey : null`
              — runs before it, and `apiSourceMetaSchema.parse` throws on a `sourceMeta` that does not
              match. `runGenerationJobs` absorbs the throw (`scheduler/generation.ts:95`,
              `.catch(() => counts.staleResults++)`), so a held owner silently loses that 5-minute
              interval: the probe was granted, `nextProbeAt` was pushed to `now + 5 min` inside the claim
              transaction, and nothing gives it back. Reachable only for an API-sourced item
              (`item.externalId` non-null) whose job's `sourceMeta` is malformed, which validated code
              should never write — so the cost is a 5-minute recovery delay in a corrupt-data case, not
              lost work.
      owed:   Move the `sourceKey`/`external` derivation inside the `try` (it depends on nothing set up
              before it), or put the probe rewind in an outer `try`/`finally` around the whole body.
      traces: FR-016, research.md H7

- [ ] MINOR F4 — `pnpm db:check`, a named quality gate, cannot run on Windows and reports the wrong cause
      with confidence.
      where:  scripts/check-migrations-current.mjs:13, scripts/check-migrations-current.mjs:22,
              scripts/check-migrations-current.mjs:36
      why:    Carried from both previous passes (F5, then F7) and this time pinned exactly. `run()` calls
              `spawnSync("pnpm", ["exec", "drizzle-kit", ...])` with no `shell` option; on Windows `pnpm`
              is `pnpm.cmd`, so the call fails with `ENOENT`, `result.status` is `null` and
              `result.stdout` / `result.stderr` are `undefined`. `check.status !== 0` is therefore true and
              the script prints `drizzle-kit check failed: migration history is inconsistent.` followed by
              `undefinedundefined` (`:22` interpolates the two undefineds) and exits 1. I verified both
              halves: `spawnSync` without `shell` gives `{status: null, error: "ENOENT"}`; with
              `shell: true` it gives `status 0` and drizzle-kit's own `Everything's fine`. So the migration
              history is in fact consistent and the gate is lying. The second half of the script fails on
              Windows for an independent reason: the generated config at `:36` embeds absolute paths with
              backslashes, and `drizzle-kit generate` then reports
              `No schema files found for path config [...\src\server\db\schema]`. Not in this feature's
              diff — but FR-028 and SC-008 name this command as their gate, so it is the reason no phase on
              this machine has ever been able to verify them locally. CI runs it on Linux (`ci.yml:114`)
              and it was green on PR #91, so the obligation itself is met; what is broken is a developer's
              ability to check it, and the message they get when they try.
      owed:   Add `shell: process.platform === "win32"` to the `spawnSync` options, report
              `result.error.message` when `result.error` is set (so an ENOENT reads as an ENOENT, not as an
              inconsistent history), and normalise the generated config's paths with
              `pathToFileURL`/forward slashes so the `generate` half resolves the schema directory.
      traces: FR-028, SC-008, constitution "Quality gates"

- [ ] MINOR F5 — During a hold the claim's job `SELECT` grows one bind parameter per project with an active
      job, where the predicate this replaced emitted a constant.
      where:  src/server/dal/job-claims.ts:50, src/server/dal/job-claims.ts:91,
              src/server/dal/credential-owners.ts:27
      why:    Carried from the previous pass (F8). `resolveBlockedProjectIds` reads every distinct project
              id with a `queued`/`running` job (`:50-53`), asks `credentialOwnerFor` about each, and
              `jobsExcludingProjects` turns the blocked ones into `project_id NOT IN ($1 … $N)`
              (`credential-owners.ts:27`). With today's single owner a hold blocks *every* project with
              active work, so N is the number of projects with active jobs — one `SELECT DISTINCT` plus an
              N-parameter `NOT IN` on every tick of the outage, to express a predicate that is semantically
              `false`. `plan.md:77` budgets "two short statements to the claim transaction when a hold
              exists", which this still honours in count but not in width. The design choice is deliberate
              and right — T073 replaced a hard-coded always-false predicate precisely so SC-010's
              two-owner case is real rather than assumed, and `credit-probe.test.ts:325` proves it
              discriminates — so this is about the shape, not the approach. No hold means no extra
              parameter at all: `jobsExcludingProjects([])` returns `undefined`, and `dal.test.ts:82` now
              proves the emitted statement is byte-identical to main's.
      owed:   Short-circuit the all-blocked case: when every project returned by the `SELECT DISTINCT` is
              blocked, emit a constant-false predicate instead of the `NOT IN`, keeping the per-project
              list for the mixed case entry 2 introduces.
      traces: FR-013, plan.md Performance Goals

- NOTE F6 — A *probing* owner's jobs still occupy slots in the job `SELECT`'s `LIMIT`, so for one tick it can
  reduce a free owner's throughput. `job-claims.ts:91` excludes only `blocked = held \ probing`, and the
  `SELECT` is `LIMIT opts.limit` (`:95`); `budgetFor` then caps the probing owner at one *item* in memory
  (`:118`). If a probing owner holds `limit` or more of the oldest due jobs, all `limit` job slots go to it
  and the tick claims one item instead of `limit`. It self-corrects on the next tick, because only the job
  that was actually claimed gets `lastClaimedAt` stamped (`:175`) and `lastClaimedAt ASC NULLS FIRST` puts
  the untouched jobs — including the free owner's — back at the front. Unreachable today (one owner, so
  "crowding out" is crowding out itself) and knowingly chosen: `research.md` H10 says in as many words
  "Blocked owners are excluded in SQL; probing owners are capped in memory at one item". Recording it because
  entry 2 is the change that makes it reachable, and `credit-probe.test.ts:325` covers the
  held-and-not-probing owner rather than this case.

- NOTE F7 — `resolveBlockedProjectIds` adds a second statement-level snapshot inside the claim transaction,
  so a job committed between its `SELECT DISTINCT` (`job-claims.ts:50`) and the job `SELECT` (`:84`) escapes
  the exclusion for one tick. Under READ COMMITTED each statement takes a fresh snapshot, so a project whose
  first active job appears in that window is not in `blockedProjects` and its item is claimed despite the
  hold. Self-healing — the call is refused, `requeueForCredit` puts the item back with its attempt count
  untouched (`runner.ts:142`), and the hold is refreshed — but it costs a model call the 5-minute budget did
  not plan for. The previous pass reasoned about this and could not race it; neither could I. A
  single-statement form (resolving owners inside the job `SELECT` rather than before it) is what entry 2 will
  probably want anyway.

- NOTE F8 — Three gaps the previous pass listed as unverifiable are now closed, and one is not. Closed: CI
  exists and was green on PR #91 for the committed body (`commitlint`, `guard`, `static`, `test (1–4)`,
  `build`, `docker`, `docs-build`); `pnpm db:check` ran green there on Linux (`ci.yml:114`), so FR-028 and
  SC-008's migration-currency half are met in the gate that counts; and the timing-budget step passes here
  too (2 files, 5 tests). Still open and still not automated: FR-038's "the migration applied to a populated
  database reclassifies no row". The structural argument is strong — `drizzle/0023_chemical_elektra.sql` is
  two `ALTER TYPE … ADD VALUE` and one `CREATE TABLE` that uses neither new label, with no `UPDATE` and no
  `DELETE`, and mixing those statement kinds has precedent in `0004`, `0007` and `0019` — but it is an
  argument, not a test.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-038) | 38 | 37 | 1 | 0 | 0 |
| Success criteria (SC-001…SC-010) | 10 | 10 | 0 | 0 | 0 |
| Constitution principles and engineering/workflow constraints | 14 | 12 | 0 | 0 | 1 |
| User stories / acceptance scenarios | 4 stories, 23 scenarios | 23 | 0 | 0 | 0 |
| Spec edge cases | 12 | 12 | 0 | 0 | 0 |
| Plan decisions (research H1…H19) | 19 | 19 | 0 | 0 | 0 |

Partial or contradicted, named:

- **FR-021** partial — "report that the generation section was held **and whether a probe was made**". The
  held half is exact; the probe half reports the grant (F2). Both fields do reach the heartbeat:
  `writeHeartbeat("generation", now, { ...counts })` at `src/server/scheduler/generation.ts:69` serialises
  the whole counts object, in the same shape as `notConfigured`/`notRunnable`.
- **Constitution, Development Workflow → Commits** contradicted — F1. Four completed tasks, no commit.
- **Constitution V (Providers are plug-ins)** — N/A, as `plan.md` says: the social-provider plug-in system is
  untouched. Counted in the 14, not in the 12.

Verified positively in this pass, with citations, rather than carried from the previous reviews:

- **FR-016 is now whole except for F3.** The rewind is correct for all three of its cases and is proven by
  `credit-probe.test.ts:205` (tick budget too short → no call, `nextProbeAt <= now`) and `:229` (a `finish`
  claim that makes no call → same); `job-claims.ts:98` and `:182` cover "no claimable item" inside the
  transaction with the transaction's own handle, which `credit-holds.ts:69-70` explains is required — a
  second connection's plain `UPDATE` would wait on `gateCreditHolds`' row lock forever.
- **FR-033's `no-plaintext` half is real now.** `no-plaintext.test.ts:42-43` stubs both provider keys,
  `:55-58` puts them and their SHA-256 in `secrets`, and `:68-100` drives one Anthropic 400 and one OpenAI
  429 through the *real* provider classes over `createFakeLlmFetch`, with the configured key embedded in each
  error body, through `generateSingle` — which wraps with `withCreditHold` at `core.ts:111`, so a hold row
  exists when the all-tables scan at `:134-137` runs over `testDb()` as well as the throwaway. The scan now
  has a path that could produce a hit; previously it searched for four values nothing in the test ever
  handled. The `voice/try-it.test.ts:103` assertion `{...before, llm_credit_holds: 1}` independently proves a
  billing refusal through the interactive path writes exactly one row and nothing else.
- **SC-007's claim-statement test is no longer self-satisfying.** `dal.test.ts:82` runs the real
  `claimDueJobItems`, pulls its job `SELECT` back out of the query-recording hook (`getRecordedQueries()`,
  `tests/setup/scope-recorder.ts:28`) and compares both `sql` and `params` against a committed expected
  statement. Drift in the claim now fails it; the old version rebuilt both sides by hand and could not. The
  hand-built helper check survives, honestly renamed to "`jobsExcludingProjects([])` does not change a
  hand-built statement" (`:67`).
- **FR-015's single-flight test is now discriminating.** `credit-probe.test.ts:158` gives the two concurrent
  ticks three due jobs with one item each and `jobMaxItems: 1`, so each tick's own `FOR UPDATE SKIP LOCKED`
  on the *job* row would hand it a different job — the only thing that can hold the count to one request is
  `gateCreditHolds`' `FOR UPDATE SKIP LOCKED` on the hold row (`credit-holds.ts:54-58`). It also pins
  `nextProbeAt` to `t1 + CREDIT_PROBE_INTERVAL_MS` exactly, not two intervals, which is FR-016's "push the
  next probe out one interval" rather than "accumulate".
- **The rename is complete, not partial.** `grep -rn jobsExcludingOwners` over `*.ts`, `*.tsx` and `*.md`
  finds it only in this review's own prose and in the historical text of T023 (`tasks.md:82`), which the
  review contract forbids rewriting. The declared signature (`contracts/services.md:26`), the three
  invariants it pins (`:33-34`), `data-model.md:234`, `research.md:143`, H10 (`research.md:261`) and the call
  sites all agree with `credential-owners.ts:25`.
- **H8's reversal is documented everywhere it was asserted.** `docs/decisions.md:2037` now states the shipped
  mechanism; so do `plan.md:31`, `research.md:240`, `contracts/services.md:155` and `data-model.md:243-250`,
  each keeping the FR-013 / US1 AS5 justification and naming the `!probe` gates (`job-claims.ts:156`,
  `:168`) that replace the narrower predicate. `credit-probe.test.ts:284` holds the invariant across three
  intervals (one call each, `attemptCount === 0`, never `interrupted`) and `recovery.test.ts:127` holds it
  for the merely-held owner.
- **No model call escapes the wrapper.** The only four `.generate(` call sites outside the provider adapters
  are `core.ts:140`, `series.ts:105`, `scripts/llm-check.ts:62` and `:92`. The first is inside
  `runGenerationStep`, which wraps at `:111`; `planSeries` wraps at `series.ts:86`; and `llm-check.ts:91`
  wraps once and passes the wrapped provider into `jobsReport` (`:105`), so `:62` is covered too. No path is
  double-wrapped: `writeSeriesPost` hands its own unwrapped parameter to `runGeneration`, which wraps exactly
  once.
- **`credit_exhausted` is in no retry set.** Absent from `TEMPORARY` (`runner.ts:49`), from `RETRYABLE` in
  both `core.ts:68` and `series.ts:83`, and from the API's `UNUSABLE` (`api/operations/generate.ts:43`), so
  FR-006 and FR-010 hold and the public API falls to the 503 branch at `:91` carrying the fixed sentence —
  which `api/endpoints/jobs.test.ts:220` asserts end to end (`503`, `generation_unavailable`,
  `details.kind: "credit_exhausted"`), together with the held item still reading `queued` with
  `counts.failed === 0` over HTTP.
- **Detection reads structured fields and is checked before rate limiting.** Anthropic's predicate
  (`anthropic.ts:26-33`) reads `APIError.type` then the body's `error.message`, never the composed
  `Error.message`; I confirmed against the installed SDK that `APIError.type` exists
  (`node_modules/@anthropic-ai/sdk/core/error.d.ts`) and that `billing_error` is a declared `ErrorType`
  (`resources/shared.d.ts:19`), so the first branch is not speculative. OpenAI's reads `error.code`
  (`openai.ts:21`). Both run immediately after the timeout branch and before `RateLimitError`
  (`anthropic.ts:39` precedes `:40`; `openai.ts:29` precedes `:30`), which is FR-003's "before mapping a 429
  to `rate_limited`". Both are exercised against the SDKs' own error classes via `APIError.generate`
  (`anthropic.test.ts:111`, `openai.test.ts:73`), including malformed and empty bodies and non-`APIError`
  inputs, and over the wire through the shared scenario table.
- **The screens keep their no-hold behaviour and offer no retry.** The waiting-row branch is scoped to
  `queued` + `credit_exhausted` (`JobItemsTable.tsx:10`); the retry control is still `failed`-only (`:77`);
  `JobNotice` is a plain `<p role="note">` with no interactive child, deliberately not `Alert`
  (`JobNotice.tsx:3-7`), so nothing is announced more aggressively than today; `ui.test.tsx:320-329` asserts
  the four notice-only strings vanish when the hold row is deleted while the row's own sentence stays, and
  `:291` asserts exactly one `role="note"` on the list.
- **The hold stores nothing secret and is not project-owned.** Four columns and a non-empty-owner check
  (`schema/generation.ts:40-52`, `drizzle/0023_chemical_elektra.sql:3-9`), registered in `notProjectOwned`
  (`project-owned.ts:56`), read behind the existing `canView` (`read.ts:58-62`), and
  `credential-owners.test.ts:26` pins that the owner value contains no key material.
- **FR-019's "fails or cancels nothing" is tested at the edges, not just asserted.** `cancel.test.ts:180`
  (cancelling a held job releases its images and leaves the hold), `:195` (retry-failed while held re-queues
  and the next tick fails none of them) and `:224` (an open job still accepts items while held) cover the
  three spec edge cases that used to be the gap.

## What I could not check

- **A real browser.** No keyboard walk, no focus-visible check, no screen-reader announcement, no contrast
  measurement on the rendered notice. FR-026 and the `docket-ui` rules are checked here only as
  server-rendered markup and through `ui.test.tsx`. `scripts/check-contrast.mjs` was not run; neither was
  `pnpm build` — the remediation touches no file under `src/app`, and `pnpm build` was green in CI on the
  committed body, so I judged skipping it proportionate rather than cheap. US3 AS5's "read with assistive
  technology and with the keyboard only" rests on that markup evidence.
- **CI for the uncommitted remediation.** By definition (F1): no commit, no push, no run. Every green result
  for those ten substantive paths comes from this one Windows machine — which, per F4, is also the machine
  that cannot run `pnpm db:check`. Nothing in the remediation touches the schema, so that specific gap is
  harmless here, but it is a gap.
- **A live provider.** By design (constitution II) every detection test is mocked HTTP. The two wording facts
  the feature rests on — Anthropic's `/credit balance/i` message and OpenAI's `insufficient_quota` code — are
  the author's own observations and are not in `docs/research/`. I verified from the installed packages that
  the *fields* exist and that `billing_error` is a declared type; I could not verify the providers actually
  send those bodies. If the wording changes, FR-004 means the consequence is today's mass-failing behaviour —
  a silent regression nothing here would catch.
- **A populated production database across the migration.** T071's `psql` `last_error_kind` histogram
  comparison is not reproducible from this phase and left no artifact. The structural argument in NOTE F8
  stands in for it.
- **Concurrency under real load.** The probe's single-flight is now exercised by a test that is genuinely
  discriminating (two ticks, three jobs, one request), but two real worker *processes* against one database
  were not run, and the `resolveBlockedProjectIds` snapshot window in NOTE F7 was reasoned about rather than
  raced.
