# Review: Docket Scheduler Screens and Media (003-scheduler-ui-media), re-review after remediation

**This is the scoped re-review that constitution v1.4.0 ("Review is exhaustive once, then scoped") calls for.** It checks only two things:

- that each blocking finding from the first review (F1–F4) is fixed;
- that the files the remediation changed introduced no regression.

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR.

The first review's full text, including its file list and sweep, is in git at `27c700b` and `df499cb`. Its findings are kept below unchanged, with a `re-review:` line added to F1–F4.

**What I reviewed.** The feature merged to `main` as PR #8 (`e542733`). Its 16 commits run from `9aa85e8` to `7198e3c`, merged from base `23b4209`. The remediation was folded into the area commits made for T090:

- `2fe4f8e` (F1);
- `a2d9400` (F2);
- `b3ee426` (F3);
- `569c810`…`f46bf68` (F4).

Later entries (004–010) have since changed some of the same files, and each had its own review. So I read the **present state** of the remediated code on `docs/self-hosting-setup` (HEAD `915c32d`, merge-base with `origin/main` `6391f7f`), plus the remediation diffs themselves.

**Read in full:**

- `git show b3ee426`;
- `src/server/scheduler/publishing.ts:200–400`;
- `src/app/p/[projectSlug]/media/page.tsx:1–80`;
- `src/app/p/[projectSlug]/posts/page.tsx:1–80`;
- `src/lib/validation/media.ts`;
- `src/server/services/posts/list.ts:1–70`;
- `src/server/services/media.ts:205–217`;
- `tests/integration/media/{library,publish-resolution-retry}.test.ts` (the F1/F3 parts);
- `src/lib/validation/post-search.test.ts`;
- `contracts/services.md:80–87`.

**Not re-reviewed:**

- MINOR F5–F17: out of scope for a re-review, and deferred to the hardening entry;
- code that later entries added to these files.

**Run:** following the constitution, I did not re-run the full suite, lint, typecheck or build.

- **Targeted tests.** `pnpm vitest run src/lib/validation/post-search.test.ts tests/integration/media/library.test.ts tests/integration/media/publish-resolution-retry.test.ts`: 3 files, 20 tests, all passed.
- **One probe.** A throwaway Vitest file and config under `$TMPDIR`; nothing was written to the repo. `resolvePublishMedia` was mocked to never return, with `runTick({ config: { timeBudgetMs: 4000, providerTimeoutMs: 1000 } })`. The tick returned in 3057 ms with counts `{ claimed: 1, retried: 1, released: 0, ambiguous: 0 }` and zero `advance` calls. The target ended `scheduled` with `attemptCount: 1` and `lastError: "Preparing media took too long; will retry."`

## Verdict

Yes. All four blocking findings are fixed, and the remediation introduced no regression in the files it touched.

- **F1 (media filters):** fixed at a single mapping point, with a test that goes through the page's own parse.
- **F2 (post-list statuses):** fixed by deriving the tabs and the parsing from one shared list, with a test for every status.
- **F4 (uncommitted work):** resolved; the work merged as Conventional Commits in PR #8.
- **F3 (publish-time media resolution):** the tick is now bounded and no provider call can follow a hung or failed resolution. I confirmed this by probe. Two deviations from what the remediation task asked for remain, both recorded as MINOR:
  - an overrun is *retried* (it uses an attempt) rather than *released* (uncounted), so the contract wording has drifted (F20);
  - the overrun branch has no test, and there is no re-check between resolution and the provider call (F21).

Neither deviation affects correctness or safety.

Nothing blocks. The open MINORs (F5–F17, F20–F21) belong to the hardening entry. Rather than inventing them, I note that the open checkboxes T090–T093 in `tasks.md` are bookkeeping (F22).

## Findings

- [x] MAJOR F1 — The media library's "Unused" and "Missing alt text" filters always fail with "The library could not be loaded."
      where:  src/app/p/[projectSlug]/media/page.tsx:36, src/app/p/[projectSlug]/media/page.tsx:50, src/lib/validation/media.ts:25, src/server/services/media.ts:164
      why:    The page parses search params with `mediaSearchParamsSchema` (T024), whose `flag` is `z.literal("1")`, so `?unused=1` becomes `{ unused: "1" }`. It passes that object straight to `listMedia` (T046), whose `listSchema` requires `unused`/`missingAlt` to be `boolean`. The resulting `ZodError` is caught at page.tsx:51 and shown as a load failure. This was confirmed by probe. The service tests call `listMedia({ unused: true })` directly and the picker sends booleans, so nothing exercises the page's path. The filter is the generator's future "unused images" entry point.
      owed:   Map the parsed params to the service's input in one place: either `unused: filter.unused === "1"` (and the same for `missingAlt`) in the page, or make `listMedia` accept the search-param shape. Then add a test that feeds `mediaSearchParamsSchema` output into `listMedia`.
      traces: FR-008, US3-AS5, T024/T046/T049

      re-review: **fixed.** `toMediaListInput` (src/lib/validation/media.ts:38) is the one place the URL flags become booleans, and the page now calls it (src/app/p/[projectSlug]/media/page.tsx:54). tests/integration/media/library.test.ts:78 feeds `mediaSearchParamsSchema` output into `listMedia`. It passed when I re-ran it.

- [x] MAJOR F2 — The post list offers filters for only 4 of 8 post statuses, and drops any other `?status=` to "All".
      where:  src/app/p/[projectSlug]/posts/page.tsx:23, src/app/p/[projectSlug]/posts/page.tsx:52, src/lib/validation/media.ts:49
      why:    `FILTERS` lists All, draft, scheduled, published, failed and needs_decision. `needs_review`, `approved`, `publishing` and `partially_failed` are missing. `known` (line 52) only accepts keys from `FILTERS`, so a shared link such as `?status=partially_failed` silently shows every post. The service (`list.ts:12`) and the unused `postSearchParamsSchema` (T024) both support every status. The page re-implemented the parsing instead of using them. US6's story and independent test name "partially failed" explicitly ("filter the list by each status").
      owed:   Build the tabs and the param parsing from one list of every post status plus `needs_decision`, e.g. `POST_LIST_STATUSES` and `postSearchParamsSchema`, with counts from `list.counts`. Add a test that `?status=partially_failed` is honoured.
      traces: FR-029, US6-AS1, T071

      re-review: **fixed.** The tabs and the parsing both come from `POST_LIST_STATUSES` (src/app/p/[projectSlug]/posts/page.tsx:38, :60). `src/lib/validation/post-search.test.ts:5` keeps every status, including `partially_failed`, and passed when I re-ran it. (`rejected` was added to the list later by 007.)

- [x] MAJOR F3 — Publish-time media resolution is not bounded by the tick deadline, and its storage calls have no timeout.
      where:  src/server/scheduler/publishing.ts:217, src/server/scheduler/publishing.ts:244, src/server/services/media-variants.ts:222, src/server/services/media-variants.ts:233
      why:    The deadline is checked once, before resolution (line 217). `resolvePublishMedia` then runs unbounded:
      - one `storage.exists` per image;
      - one per variant;
      - on a vanished object, a full regeneration of up to 12 sharp encodes, plus a GET and a PUT;
      - none of these storage calls has a timeout.

      After that, the provider call still gets its full `providerTimeoutMs`. So a slow or hanging bucket, or a few regenerations, pushes `runTick` past its budget. The constitution requires "bounded (well under 30 s)". contracts/services.md:85 requires "if resolution finishes past `deadline − providerTimeout`, the lease is released as 002 does". T054 and T055 are ticked for exactly that clause ("deadline respected"), but no test covers it: `media/publish-media.test.ts` and `publish-resolution-retry.test.ts` only test regeneration, a deleted original and retry.
      owed:   After resolution, re-check `now + providerTimeoutMs > deadline` and release the lease exactly as lines 217–231 do. Give the resolution step a time bound, for example an abort or timeout on the storage calls, or race it against the remaining budget, so a hung bucket cannot hold the tick. Add the missing "deadline respected" test: slow storage double, release, no provider call.
      traces: FR-016, Constitution "Engineering Constraints" (runTick bounded), contracts/services.md "Scheduler change", T054, T055

      re-review: **fixed in substance, not as the contract words it.** Resolution now races a budget of `deadline − now − providerTimeoutMs`, and an overrun or error becomes a retryable result with no provider call (src/server/scheduler/publishing.ts:300–304, :363). I confirmed this with a probe: a resolution that never returns, under `timeBudgetMs: 4000, providerTimeoutMs: 1000`, returned in 3.06 s with `retried: 1` and no `advance` call. Two gaps remain, both safe to ship (see F20 and F21).

- [x] MAJOR F4 — 76 of the feature's files are uncommitted, against the constitution's commit-per-task workflow.
      where:  specs/003-scheduler-ui-media/tasks.md:103, src/app/p/[projectSlug]/media/page.tsx:1, src/server/services/calendar.ts:1
      why:    `git status` shows 23 modified tracked files and 53 untracked files. They cover:
      - all of Phases 4–11: schedule and publish now, media screens, scheduler media, calendar, posts, accounts, offline profile and docs;
      - the tick marks in `tasks.md`.

      Only Phases 1–3 were committed (`8796521`, `29c22df`). A PR from `HEAD` would ship a composer that imports `MediaPicker`, but none of the calendar, posts, media or accounts routes. semantic-release would also see none of these `feat` commits. The constitution says to commit after each completed task, with explicit paths.
      owed:   Commit the existing work in small Conventional Commits by area, staging explicit paths only, before or separately from the remediation fixes. Suggested groups:
      - `feat(compose)`: schedule and publish now;
      - `feat(media)`: library screens;
      - `feat(scheduler)`: adapted media at publish;
      - `feat(calendar)`;
      - `feat(posts)`;
      - `feat(accounts)`;
      - `build(compose)`: offline profile;
      - `docs`;
      - (`tasks.md`, including its ticks, and this `review.md` are committed by the review phase itself.)
      traces: Constitution "Development Workflow — Commits"

      re-review: **fixed.** Phases 4–11 landed as area commits `569c810`…`f46bf68` and merged in PR #8 (`e542733`). `git status` shows no uncommitted 003 file.

- [ ] MINOR F5 — A variant generation failure reaches the editor as a generic "could not be adapted", without the generator's reason.
      where:  src/server/services/posts/index.ts:160, src/server/services/media-variants.ts:192
      why:    `prepare()` discards `prepareVariants`' `failures`, which carry messages like "The image could not be reduced to 2,000,000 bytes." or "Media storage is not set up." The gate then emits only "Image N could not be adapted for <platform>." D8 says the `variant_failed` issue carries the generator's message. US4-AS5 asks for a clear message.
      owed:   Pass the failures into the gate, or record the message, so `variant_failed` carries the reason.
      traces: FR-016, US4-AS5

- [ ] MINOR F6 — The calendar chip menu's "Cancel" item does nothing.
      where:  src/app/p/[projectSlug]/calendar/CalendarBoard.tsx:121
      why:    `{ label: "Cancel", onSelect: () => {} }`. contracts/ui.md lists Cancel as cancelling the target. A user can reasonably believe they cancelled a post.
      owed:   Wire it to `cancelTargetAction` behind a confirmation naming the account, or remove the item.
      traces: contracts/ui.md "Calendar"

- [ ] MINOR F7 — Calendar navigation loses the date being viewed.
      where:  src/app/p/[projectSlug]/calendar/page.tsx:50, src/app/p/[projectSlug]/calendar/page.tsx:83
      why:    The Month/Week links (`o.date ?? calendar.today`) and the account filter form (hidden `date = calendar.today`) both jump back to today. Filtering next month by account shows this month.
      owed:   Carry the current anchor date (the `date` param, or the range start) instead of `today`.
      traces: FR-024

- [ ] MINOR F8 — A published target is filtered by `published_at` but placed on the day of `scheduled_at`.
      where:  src/server/dal/targets.ts:73, src/server/services/calendar.ts:120
      why:    `listInRange` selects by `CASE WHEN published THEN published_at ELSE scheduled_at`, but `getCalendar` buckets by `scheduledAt ?? publishedAt`. A target that published after a retry or backoff across a range boundary is fetched and then dropped, because its bucket date is not in `days`. Otherwise it shows on a different day from the one that selected it.
      owed:   Use the same instant in both places.
      traces: FR-025

- [ ] MINOR F9 — The post detail page does not show a target's attempt count.
      where:  src/server/services/posts/view.ts:23
      why:    FR-030 and US6-AS3 list "attempt count" separately from the attempt log. `PostViewTarget` has no `attemptCount`, and the page renders only the log.
      owed:   Add `attemptCount` to the view and to the target's `<dl>`.
      traces: FR-030

- [ ] MINOR F10 — "Connect a mock account" cannot choose a behaviour.
      where:  src/app/p/[projectSlug]/accounts/ConnectMockForm.tsx:18
      why:    FR-034 and US7-AS2 say connect takes a display name *and* a behaviour. The form sends only `displayName`; the behaviour can be changed only afterwards with "Change behaviour".
      owed:   Add the behaviour `Select` (`mockBehaviours`) to the connect form and pass it as `settings`.
      traces: FR-034, US7-AS2

- [ ] MINOR F11 — An account whose provider is no longer registered shows as "Connected" on Accounts.
      where:  src/app/p/[projectSlug]/accounts/page.tsx:20
      why:    The spec edge case "Unregistered provider" wants a clear status. The `STATUS` map only knows `active` and `needs_reauth`, and `providerAvailable` is ignored here. The composer does disable such accounts.
      owed:   Show an "Unavailable platform" badge when `!account.providerAvailable`.
      traces: Edge case "Unregistered provider"

- [ ] MINOR F12 — The server treats an empty override as empty text, while the compose check treats it as "use base text".
      where:  src/server/services/posts/compose.ts:66, src/server/services/posts/index.ts:216, src/server/dal/targets.ts:243
      why:    Two sides disagree on the empty-string override `""`:
      - `checkComposition` uses `overrideText ? override : base`, so `""` means use the base text;
      - `createDraft` and `updatePost` store `""` (`!= null`), and `effectiveContent` returns `overrideText ?? baseText`, so the target's text is `""`.

      The composer normalises `""` to `null`, so the UI is safe. A service or API caller (the public-api entry) would get `empty_post` on submit after a clean check, breaking SC-002 and the edge case "an empty override is treated as no override".
      owed:   Normalise `""` (or whitespace-only) overrides to `null` in the target input schema or at write time.
      traces: SC-002, Edge case "Override longer than base"

- [ ] MINOR F13 — The offline MinIO setup has an inconsistent default password and an unresearched healthcheck.
      where:  docker-compose.yml:62, docker-compose.yml:69, .env.example:157, specs/003-scheduler-ui-media/contracts/env.md:32
      why:    There are two problems.
      - **Password mismatch.** Compose and `docs/storage.md` default the password to `docket-dev-secret`, but `.env.example` and contracts/env.md say `docket-dev-password`. An operator who uncomments the `.env.example` line gets a MinIO whose password differs from the `S3_SECRET_ACCESS_KEY` that `docs/storage.md` tells them to set.
      - **Healthcheck.** The healthcheck runs `curl` inside a frozen third-party image. research F9/U2 never establishes that the image ships `curl`, and the stack was never run (quickstart-verification §3). If `curl` is absent, `minio` never becomes healthy, so `storage-init` (`depends_on: service_healthy`) never prepares the bucket, and FR-004 fails.
      owed:
      - Use one default password everywhere.
      - Verify the healthcheck against the pinned image. Otherwise drop the dependency on image contents: use `service_started`, and have `storage-init` retry `CreateBucket` with backoff.
      traces: FR-004, US8-AS2, Constitution I

- [ ] MINOR F14 — Two test gaps.
      where:  tests/lint/worker-bundle.test.ts:15, src/app/p/[projectSlug]/media/actions.ts:56
      why:    There are two gaps.
      - **Worker bundle.** The worker-bundle test passes its own `external: ["pg-native", "sharp"]` to esbuild instead of reading `build:worker` from `package.json`. Deleting `--external:sharp` from the real build would leave it green, so it asserts its own setup rather than the build (T057).
      - **Authorization table.** `listMediaAction`, the picker's library query, is a server action missing from the `actions-authz.test.ts` table that SC-009 says covers every action.
      owed:   Derive the externals from `package.json`'s `build:worker` script, or run that script and inspect its metafile. Add `listMediaAction` to `CASES`.
      traces: SC-009, T057, T083

- [ ] MINOR F15 — The "Mark as published" link accepts any URL scheme and is rendered as an `href`.
      where:  src/server/services/posts/index.ts:583, src/app/p/[projectSlug]/posts/[postId]/page.tsx:129
      why:    `z.url()` accepts `javascript:` and `data:` (probed). The value is user input from the resolve dialog, rendered for every member as `<a href={t.externalUrl} target="_blank">`. React 19 neutralises `javascript:` (probed), so this is defence-in-depth rather than a live XSS.
      owed:   Restrict `url` to `http(s)`.
      traces: FR-031

- [ ] MINOR F16 — The composer's inline upload stops the batch on a thrown action.
      where:  src/components/media/MediaPicker.tsx:188
      why:    `upload()` has no `try` around `uploadMediaAction`. A `StorageError` is not mapped by `failFromError`, so it rethrows. That aborts the remaining files with an unhandled rejection and a stale "Uploading…" message. `UploadDropzone` handles the same case. Edge case: "one bad file never discards the others".
      owed:   Catch per file and report "rejected: the upload failed", as `UploadDropzone.tsx` does.
      traces: FR-006, Edge case "Partial batch upload"

- [ ] MINOR F17 — Rules and helpers are duplicated across passes instead of living in the service and shared schemas.
      where:  src/server/services/media.ts:194, src/server/services/calendar.ts:131, src/server/services/queue/index.ts:296, src/server/services/posts/list.ts:35, src/app/p/[projectSlug]/posts/[postId]/page.tsx:46, src/app/p/[projectSlug]/compose/[postId]/page.tsx:53, src/app/p/[projectSlug]/compose/page.tsx:36, src/lib/validation/media.ts:55
      why:    There are four duplications.
      - **Excerpts.** There are four excerpt implementations: graphemes with an ellipsis, code points at 80 and at 140, and UTF-16 `.slice` at 80. The last one can split an emoji surrogate pair.
      - **The "started" rule.** It (`publishing|published|ambiguous`) is re-derived in two pages, instead of coming from `getPostView`'s contracted `editable` and per-target `allowed` flags, which were never implemented.
      - **Media status.** The compose pages read `getStorage()` directly instead of `mediaStatus`.
      - **Dead schemas.** `calendarSearchParamsSchema` and `localDateTimeSchema` are tested but unused, while the calendar and compose code hand-roll the same regexes. F2 is the visible consequence of the same drift.

      Constitution IV says there is to be no duplicated logic per caller.
      owed:   Use one `excerptOf`. Return `editable`/`allowed` from `getPostView` and use them in both pages. Use `mediaStatus` in the compose pages. Use the shared search-param schemas, or delete them.
      traces: Constitution IV, contracts/services.md (`getPostView`)

- NOTE F18 — `previewExplicitTime` drifted from contracts/services.md, and nothing broke. Its consumer in `ScheduleDialogs.tsx` matches the implementation.
  - **Contract:** `(scope, postId, { local })` returning `{ at, localTime, timeZone, kind, inPast, warnings: { targetId, accountId, warnings }[] }`.
  - **Implementation:** `(scope, { local, accountIds, postId? })` returning `{ kind, instant, resolvedLocal, inPast, warnings: Warning[] }`.

  Update the contract before the public-api entry relies on it. Location: src/server/services/posts/compose.ts:106.
- NOTE F19 — The implement pass's own final gate was not fully green. `quickstart-verification.md` records `pnpm test`: 823 passed, 1 failed. The failure is an `afterEach` hook timeout in the pre-existing `scheduler/concurrency.test.ts` under full parallel load, and it passes alone. This feature adds many integration files, so watch for it in CI before merging. Location: specs/003-scheduler-ui-media/quickstart-verification.md:5.

- [ ] MINOR F20 — A media-resolution overrun is retried, which uses an attempt, where the contract says the lease is released, which does not.
      where:  src/server/scheduler/publishing.ts:363, src/server/scheduler/publishing.ts:304, specs/003-scheduler-ui-media/contracts/services.md:85
      why:    The two outcomes differ:
      - `MediaNotReady` maps to `retryable_error`, so `applyStepResult` increments `attemptCount` (the probe ended with `attemptCount: 1`) and applies backoff;
      - contracts/services.md:85 and T093 ask for "released as 002 does": uncounted, with one `released` attempt.

      With a bucket that is slow on every tick, a scheduled post exhausts `maxAttempts` and fails, instead of waiting for storage to recover. That is defensible: it surfaces a broken bucket instead of retrying silently forever. But it is undocumented: `docs/decisions.md` has no entry for it, and the contract still says the other thing.
      owed:   Either log the choice in `docs/decisions.md` and amend contracts/services.md:85 to say "retryable, counted", or switch the overrun case (not the thrown-error case) to `release()`.
      traces: FR-016, contracts/services.md "Scheduler change", T093

- [ ] MINOR F21 — The overrun branch has no test, and the provider call can start up to 1 s past the deadline.
      where:  src/server/scheduler/publishing.ts:300, src/server/scheduler/publishing.ts:236, tests/integration/media/publish-resolution-retry.test.ts:10
      why:    There are two parts.
      - **No test.** Both tests in `publish-resolution-retry.test.ts` mock `resolvePublishMedia` to *throw*. Nothing makes it *hang*, so the `withinBudget` timer and its "took too long" message (line 238) are never exercised. T093 asked for exactly that "deadline respected" test. My probe shows the branch works, but no committed test would catch a regression.
      - **1 s overrun.** The budget is floored at `Math.max(1_000, …)`, and resolution is not followed by a `fitsDeadline()` re-check. So a resolution that finishes in its floor second still gets a full `providerTimeoutMs` provider call. The tick can overrun its budget by up to 1 s. That is still bounded, so this is not a constitution breach.
      - **Abandoned storage calls.** The race abandons the storage calls rather than cancelling them, because `src/server/storage/s3.ts` sets no request timeout. A hung socket outlives the tick.
      owed:   Add the hanging-resolution scheduler test: small `timeBudgetMs`, assert `retried` (or `released`, per F20) with no `advance` call and elapsed time under budget. Call `fitsDeadline()` after resolution and `release()` if it fails. Optionally, give the S3 client a request timeout.
      traces: Constitution "Engineering Constraints" (runTick bounded), T055, T093

- NOTE F22 — `tasks.md` on this branch still shows T090–T093 unchecked (specs/003-scheduler-ui-media/tasks.md:253–256), although this re-review confirms all four were done in PR #8. The tick exists as commit `18981ed` on the unmerged branch `chore/review-bookkeeping`. This phase may not re-tick existing tasks, so merging that branch is what closes them. T089 (browser and screen-reader survey) remains 🛑 BLOCKED, on the owner.

## Coverage

Scoped re-review: the denominator is the first review's blocking findings, plus the remediated files.

| Checked | Count | Fixed | Partial | Not fixed | Regressed |
|---|---|---|---|---|---|
| Blocking findings from the first review (F1–F4) | 4 | 4 | 0 (F3's two deviations are MINOR F20/F21) | 0 | 0 |
| Files changed by the remediation, checked for regression | 6 | — | — | — | 0 |

The six files are `media/page.tsx`, `posts/page.tsx`, `lib/validation/media.ts`, `scheduler/publishing.ts`, `publish-resolution-retry.test.ts` and `post-search.test.ts`.

The first review's coverage of every requirement still stands, apart from the items F1, F2 and F3 fixed:

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-041) | 41 | 37 | 4 (FR-016 F5/F20, FR-024 F7, FR-030 F9, FR-034 F10) | 0 | 0 | — (FR-004, FR-039 need Docker / a browser) |
| Success criteria (SC-001–SC-011) | 11 | 9 | 0 | 0 | 0 | 2 (SC-001 timing, SC-007 keyboard-only) |
| Constitution principles + engineering/workflow sections | 9 | 7 | 2 (IV F17; bounded `runTick` holds, with a ≤1 s overrun, F21) | 0 | 0 | — |

## What I could not check

- **CI on PR #8.** `gh pr view 8` failed from this sandbox with a TLS error to `api.github.com`, so I could not read the checks for the merged commit. The first review's F19 (one parallel-load `afterEach` timeout) was addressed by two test-only commits (`480ffcd` and `7198e3c`) before the merge, but I have not seen a green CI run.
- **Everything the first review listed is still unverified:**
  - browser drag and drop, focus return, live regions, keyboard-only use (SC-007, T089 BLOCKED);
  - composer timing (SC-001, SC-002);
  - the offline MinIO stack running for real (F13);
  - real R2/S3 path-style addressing;
  - sharp in the Linux worker image;
  - wall-clock SC-006 and SC-010.
- **Real storage.** The F3 probe used a mocked `resolvePublishMedia`, not a real hung S3 socket. Abandoning a real in-flight SDK request (F21) was not observed.
