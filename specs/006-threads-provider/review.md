# Review: Threads provider (Meta, part 2), re-review after remediation

**This is the scoped re-review that constitution v1.4.0 calls for** ("Review is exhaustive once, then scoped", `.specify/memory/constitution.md:115-128`). It checks only two things:

- whether each blocking finding from the first review (🛑 BLOCKER F1, MAJOR F2) is fixed;
- whether the files the remediation changed introduced a regression.

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR, for the hardening entry.

The first review's full text is in git at `cc8c3dd` (`git show cc8c3dd:specs/006-threads-provider/review.md`). Its file list, the gates it ran and its coverage notes are there. Its findings are kept below, with a `re-review:` line added to each one in scope.

**What I reviewed.** The feature merged to `main` as PR #11 (`8b634cd`), from base `4285587`, 25 commits. The remediation is two commits inside that PR:

- `28a229d` (F1): `tests/integration/threads/refresh.test.ts`, +5 lines;
- `9c945ea` (F2): `src/providers/threads/connect-group.ts` and `tests/integration/threads/paste.test.ts`, +7 lines.

Since the merge, only `3afae28` (008, webhooks and housekeeping) has touched code near these paths, in `src/server/scheduler/{credentials,token-refresh}.ts`. Neither remediated file changed after the merge, so I judged them against the present state of `main` (HEAD `69cff5d`).

**Read in full:**

- `git show 28a229d 9c945ea`;
- `src/providers/threads/connect-group.ts` (whole file);
- `tests/integration/threads/refresh.test.ts:1-80` and the count assertions in the cases;
- `tests/integration/threads/paste.test.ts:80-98`;
- `src/server/dal/scheduler.ts:160-185`, the refresh claim query the F1 fix depends on;
- `src/server/services/connect.ts:170-185` and `src/server/services/accounts.ts:55-80`, to see where candidate notes go;
- `tests/setup/worker-db.ts:1-8` and `tests/setup/global-setup.ts:40-48`, for database isolation per worker.

**Not re-reviewed:**

- MINOR F3–F4 and NOTE F5–F7: out of scope for a re-review.
- Everything 007–010 changed outside the remediated files.

**Run:** following the constitution, I did not re-run the full suite, lint, typecheck or build. I read their results instead:

- CI on PR #11: `test`, `build`, `static`, `docker` and `commitlint` all **pass**;
- the latest run on `main` (`69cff5d`, PR #17 merge): **success**.

I also ran one targeted probe to recreate the condition that caused F1: `pnpm vitest run --no-file-parallelism tests/integration/threads tests/integration/meta/no-secrets.test.ts`. That puts every Threads file, plus the Meta secrets file, on a single worker and a single database, so the refresh file runs after the files that leave Threads accounts behind. Result: 10 files and 136 tests, all passed.

## Verdict

**Both blocking findings are fixed, nothing in the remediated files regressed, and no merge-blocking findings remain.** The feature satisfies its spec, within the limits the first review already recorded: mocks only, with live Threads behaviour and the local HTTPS walk still owed by the owner. It has already merged as PR #11, and CI is green on both the PR and current `main`.

- **F1 (fixed).** The refresh test no longer sweeps accounts that other files created. It took a different route from the one T054 prescribed, but that route is sound and was proven on one shared database.
- **F2 (fixed).** The chooser now shows the "estimated expiry" note for a pasted token that is saved as is. The new assertion would fail without the fix.

One new MINOR covers bookkeeping only. T054 and T055 are still unticked in `tasks.md`, although the work is done. This phase may not tick existing tasks.

## Findings

- [x] 🛑 BLOCKER F1 — The full `pnpm test` run fails: `tests/integration/threads/refresh.test.ts` asserts global refresh counts at a 2030 clock.
      where:  tests/integration/threads/refresh.test.ts:33, tests/integration/threads/refresh.test.ts:29, tests/integration/threads/refresh.test.ts:84 (same pattern at :99, :120, :123, :131, :139, :146, :156, :157)
      why:    (first review) `T0` is 2030-01-01 and `refreshMaxAccounts` is 1000. As a result, `runTokenRefresh` claimed every Threads account that other files had left in the worker's database with a real-time expiry. It marked them `needs_reauth`, and the global counts were wrong (`failed: 12` instead of `0`).
      re-review: **Fixed, by a different route than T054 prescribed.**
        - **What changed.** `beforeEach` now pushes every `social_accounts.credentials_expires_at` in the worker's database to 2100 (tests/integration/threads/refresh.test.ts:45). After that, the claim's `lte(credentialsExpiresAt, now + window)` filter (src/server/dal/scheduler.ts:175) sees only the account the current case creates. Rows with a null expiry never match `lte`, so none slip through. `T0` stays at 2030 (refresh.test.ts:34), and the global `refreshTick` counts stay.
        - **Why that is safe.** It is safe only because each Vitest worker has its own database clone (tests/setup/worker-db.ts:8, tests/setup/global-setup.ts:40), and the files on one worker run one after another. So the bulk update cannot disturb a test running at the same time. `clearRecordedQueries()` (refresh.test.ts:46) keeps the deliberate cross-project write out of the scope recorder.
        - **Evidence.** CI `test` passed on PR #11. My single-worker probe (above) also passed, 136 of 136. That probe reproduces the exact cross-file condition the first review saw fail.
        - **Not done as written.** T054's literal steps were not followed: moving `T0` to now, and replacing the counts with per-account assertions. The finding's `owed` allowed filtering the counts to this account, and the bulk update has that effect.
      owed:   Nothing further for the merge. See F8 for the task bookkeeping.
      traces: SC-010, FR-034 (renewal), constitution Development Workflow (quality gates), T054

- [x] MAJOR F2 — A pasted token saved with an estimated expiry shows no "estimated" note in the chooser.
      where:  src/providers/threads/connect-group.ts:69, src/providers/threads/connect-group.ts:20
      why:    (first review) US7 scenario 3 says "the chooser and the account say the expiry is estimated". The save-as-is candidate set no `notes`, so only the account card said it.
      re-review: **Fixed.**
        - **The fix.** `candidateFor` adds the note "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days." whenever `credentials.expiryEstimated` is set (src/providers/threads/connect-group.ts:35-37). Only the save-as-is branch sets that flag (connect-group.ts:74). The renewed and OAuth paths set it to `false` (connect-group.ts:54, :123), so they get no note.
        - **The text is accurate.** "60 days" matches `THREADS_LONG_LIVED_SECONDS` (src/providers/threads/config.ts:9).
        - **Where the note goes.** It reaches the chooser through `CandidateView.notes` (src/server/services/connect.ts:182). It is display-only: it is not stored on the account, so the account card does not show it twice. The card keeps its own G13 note (src/server/services/accounts.ts:66-80).
        - **The test can fail.** tests/integration/threads/paste.test.ts:89-90 calls `getConnectChoice` and asserts the note. `CandidateView` carries no settings, so the string can only come from `notes`, and the assertion would fail without the fix. The existing account-note assertion (paste.test.ts:98) still passes.
      owed:   Nothing further.
      traces: FR-015, US7 scenario 3, T055

- [ ] MINOR F3 — A rate limit never uses a platform not-before time, and the test named for it cannot fail.
      where:  src/providers/meta/errors.ts:99, tests/integration/threads/outcomes.test.ts:125
      why:    US3 scenario 4 says a rate limit is retried "with the platform's not-before time when given, and the engine's backoff otherwise". `graphStepError` never reads a not-before value: rate limits go through `retry(msg)` with no `notBefore`. The test "a rate limit carries the platform's not-before when it gives one" stubs no such value, and only checks `nextAttemptAt > T0`, which engine backoff alone satisfies. R4 gives no interim not-before field, so for Threads the behaviour is probably right today. The test's name, though, claims coverage that does not exist.
      owed:   Either rename the test to what it proves (engine backoff on a rate limit) and add a sentence to decisions.md saying no platform not-before is read (R4), or read one where the Graph reply provides it and test that value.
      traces: US3 scenario 4, FR-028
      re-review: not in scope; unchanged.

- [ ] MINOR F4 — Threads OAuth reclassifies Graph errors with its own copy of the rate-limit and temporary codes, and refresh detects an empty reply by matching a string literal.
      where:  src/providers/threads/oauth.ts:31, src/providers/meta/errors.ts:7, src/providers/threads/refresh.ts:7, src/providers/threads/refresh.ts:42, src/providers/threads/oauth.ts:77
      why:    The codes `[4, 17, 32, 613]` and 1/2 are copied from `GRAPH_ERROR_TABLE` instead of going through `classifyGraphError`. If the shared table changes (it is marked R3/R4 interim), Threads connect and renewal will classify errors differently from publishing. `refreshThreads` also recognises "unreadable success" by comparing `reason` to the literal `"Threads returned no token"`, which oauth.ts defines separately. Rewording either copy silently turns a transient result into `needs_reauth`. Both work today.
      owed:   Classify through `classifyGraphError`. Have `readLongLived` return a typed `{ ok: false, transient: true, kind: "no_token" }` (or export the constant) instead of matching on the message text.
      traces: FR-001 (reuse the shared module), FR-018
      re-review: not in scope; unchanged.

- [ ] MINOR F8 — T054 and T055 are still unticked in `tasks.md`, although both fixes merged in PR #11.
      where:  specs/006-threads-provider/tasks.md:204, specs/006-threads-provider/tasks.md:205
      why:    The remediation commits (`28a229d`, `9c945ea`) and the review update (`cc8c3dd`) marked F1 and F2 resolved, but never ticked the matching tasks. As a result, `tasks.md` now says two tasks are open when they are not. A reader, or a later implement pass, could take the feature as unfinished or redo T054 literally. Doing T054 literally would mean rewriting a test that already isolates correctly (see F1). This phase may not re-tick existing tasks.
      owed:   Tick T054 and T055. When ticking T054, add a short note that the fix isolated the test by pushing other accounts' expiry past `T0` (tests/integration/threads/refresh.test.ts:45), not by moving `T0`.
      traces: T054, T055

- NOTE F5 — `check_quota` continues on a rate limit, 5xx, network failure or rejection, and stops only on a 190 (src/providers/threads/publish.ts:167–176). This settles a real tension in the spec: US3 scenarios 4 and 6 say "any step" retries, while US6 scenario 3 says an unreadable quota never blocks. The code sides with US6. That is reasonable, because the `publish` step that follows turns a rate limit into a retryable result anyway. The outcome matrix (tests/integration/threads/outcomes.test.ts:91) encodes this behaviour on purpose. It is recorded under R7 in decisions.md, but only as "unknown never blocks", not as an exception to US3. (Carried over, not re-reviewed.)

- NOTE F6 — The token, and for `th_exchange_token` also the app secret, travel in GET query strings (src/providers/threads/oauth.ts:88–94, :104–110). FR-033 asks for request bodies "wherever the platform allows". This is recorded as a limitation (D10), and the URL is never shown anywhere, so it is not a defect. It is still worth checking during the owner's live survey (T053) whether POST is accepted. (Carried over, not re-reviewed.)

- NOTE F7 — The G11 parking (src/server/scheduler/credentials.ts:47–54 at the time of the first review) holds the refresh lease for up to 24 h. Take a future provider that both returns a transient `retryAt` from refresh and defines `needsRefresh`. Publish-time refresh would see `busy` and keep releasing targets until the hold ends. No current provider does both, so nothing misbehaves today. `docs/adding-a-provider.md` should probably say so. (Carried over, not re-reviewed. `3afae28` has since edited `credentials.ts`, so the line numbers may have moved.)

## Coverage

This re-review covers only the earlier blocking findings and the remediated files:

| Checked | Count | Fixed / clean | Partly fixed | Open | Regressed |
|---|---|---|---|---|---|
| Blocking findings from the first review (F1, F2) | 2 | 2 | 0 | 0 | 0 |
| Files changed by the remediation | 3 | 3 | 0 | 0 | 0 |

The first review's coverage still stands for everything else (`git show cc8c3dd:specs/006-threads-provider/review.md`). That review checked 40 of 40 FRs as satisfied, 55 of 57 acceptance scenarios, 7 of 10 success criteria, 8 of 9 constitution principles, and G9–G13 wired. With F1 and F2 fixed:

- US7 scenario 3, SC-010 and the Workflow quality gate move to satisfied.
- US3 scenario 4's platform not-before (F3) is still partial and MINOR.
- SC-001 and SC-002 still cannot be checked here.

## What I could not check

- **Live Threads behaviour:** connect, `th_exchange_token`, `th_refresh_token`, container creation, status polling, the quota read and `threads_publish` against the real API. All of it is verified with mocks only. This is T053, owner-only.
- **Local HTTPS:** the walk itself (hosts file, mkcert, `pnpm dev:https`) and whether the Threads dashboard accepts the port-3000 redirect (R8). This is T052.
- **The chooser in a browser:** I confirmed the F2 note reaches `getConnectChoice`'s candidates and that `ChooserForm` maps `notes` (src/app/p/[projectSlug]/accounts/connect/[attemptId]/ChooserForm.tsx:44). I did not render the page.
- **The full suite locally:** not re-run, per the constitution. I relied on CI for PR #11 and `main` plus the targeted probe above.
- **SC-001 and SC-002 timings,** which need a human and real credentials.
