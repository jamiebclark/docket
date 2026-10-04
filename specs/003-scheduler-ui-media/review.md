# Review: Docket Scheduler Screens and Media (003-scheduler-ui-media)

Reviewed 147 file(s) changed across 4 commit(s), against `23b4209` (merge-base with `origin/main`)...working tree.
Most of the feature is **not committed** (see F4), so this reviews the present working tree, not only `HEAD`.
That means the 94 tracked files in `git diff 23b4209`, plus 53 untracked files. Only 2 of the 4 commits contain code (`8796521`, `29c22df`).

**Read in full:**

- Services: `src/server/services/{media.ts,media-variants.ts,calendar.ts}`, `src/server/services/posts/{validate.ts,compose.ts,list.ts,view.ts}`, and the diffs to `posts/index.ts`, `queue/index.ts`, `queue/occurrences.ts` and `accounts.ts`.
- Data access: `src/server/dal/media.ts`; the diffs to `dal/posts.ts` and `dal/accounts.ts`; `dal/targets.ts` (`listInRange`, `tryHoldOccurrence`, `effectiveContent`).
- Storage and media: `src/server/storage/*`, `src/server/media/{process,variants,hash}.ts`, `src/providers/media.ts`, and the diffs to `providers/{types,validation}.ts` and `providers/mock/index.ts`.
- Scheduler: the diff to `src/server/scheduler/publishing.ts`.
- Config: the diffs to `src/server/env.ts`, `next.config.ts`, `package.json`, `.env.example` and `docker-compose.yml`, plus `Dockerfile` and `scripts/storage-init.mjs`.
- Shared libraries: `src/lib/validation/media.ts` and `src/lib/action-result.ts`.
- Screens: every page, action and client component under `src/app/p/[projectSlug]/{compose,calendar,posts,media,accounts}/`, plus `run-action.ts` and the `layout.tsx` and `[section]/page.tsx` diffs.
- Components: `src/components/media/*`, `src/components/shell/ReauthBanner.tsx`, and `src/components/ui/{LocalTime,StatusBadge}.tsx`. `Menu.tsx` was read in part.
- Docs: `docs/storage.md`, and the diffs to `README.md`, `docs/adding-a-provider.md` and `docs/decisions.md`.
- Tests: `tests/integration/{actions-authz,compose-check-route}.test.ts`, `tests/integration/queue/move-to-occurrence.test.ts`, `tests/integration/media/{publish-media,publish-resolution-retry}.test.ts`, `tests/lint/worker-bundle.test.ts`, the `no-plaintext.test.ts` diff, the SC-006 block of `calendar.test.ts`, and `tests/helpers/actions.ts`.

**Sampled** (test titles and greps): `tests/integration/media/{library,upload}.test.ts`, `tests/integration/compose/check.test.ts`, `Composer.test.ts`, `CalendarBoard.test.ts`, `MediaPicker.test.ts`, and `tests/setup/scope-recorder.ts`.

**Not reviewed:**

- `drizzle/0002_*.sql` and its snapshot: generated, and covered by `pnpm db:check`.
- `src/server/db/schema/media.ts` column details.
- `tests/helpers/{images,storage,provider-fixtures}.ts`, `env.test.ts`, `s3.test.ts`, the `process`/`variants` unit tests, `storage-init.test.ts`, `storage-docs.test.ts`, `ui-atoms.test.ts` and the `section-placeholders` test.
- `Pagination`, `FilterTabs` and `LiveRegion`, and the `loading.tsx` files.

Per the constitution I did not re-run the full suite, lint, typecheck or build. I ran two targeted probes instead (below).

**Probes run** (throwaway Vitest files under `$TMPDIR`, nothing written to the repo):

1. The media page's own parse of `?unused=1` and `?missingAlt=1`, passed into `listMedia`, throws a `ZodError` (`expected boolean, received string`). This confirms F1.
2. `z.url()` accepts `javascript:alert(1)`, and React 19's `renderToStaticMarkup` replaces such an `href` with a throwing stub (relevant to F15).

## Verdict

Mostly yes. The engine-facing half is solid and fits together:

- the storage interface;
- the upload pipeline;
- the pure planner and the variant generator;
- the single validation path that the check route and every gate share;
- `moveTargetToOccurrence`, with a real 20× race test and the savepointed unique index;
- the pull-forward preview by rollback;
- the post-first lock order for media delete and attach;
- the needs-reauth banner;
- the authorization table.

Four things block the merge:

1. **F1:** two passes disagree on a schema, so the media library's "Unused" and "Missing alt text" filter links (FR-008, a P1 story) render "The library could not be loaded" every time.
2. **F2:** the post list cannot filter by four of the eight post statuses, including the "partially failed" the spec names (FR-029).
3. **F3:** publish-time media resolution has no deadline or timeout, although the contract and the ticked T054/T055 say it does. This breaks the bounded-tick constraint.
4. **F4:** roughly half the feature (76 files) is uncommitted.

All four are small, local fixes. I would run one remediation pass and re-review only those. The 14 MINOR items can go to the hardening entry.

## Findings

- [ ] MAJOR F1 — The media library's "Unused" and "Missing alt text" filters always fail with "The library could not be loaded."
      where:  src/app/p/[projectSlug]/media/page.tsx:36, src/app/p/[projectSlug]/media/page.tsx:50, src/lib/validation/media.ts:25, src/server/services/media.ts:164
      why:    The page parses search params with `mediaSearchParamsSchema` (T024), whose `flag` is `z.literal("1")`, so `?unused=1` becomes `{ unused: "1" }`. It passes that object straight to `listMedia` (T046), whose `listSchema` requires `unused`/`missingAlt` to be `boolean`. The resulting `ZodError` is caught at page.tsx:51 and shown as a load failure. This was confirmed by probe. The service tests call `listMedia({ unused: true })` directly and the picker sends booleans, so nothing exercises the page's path. The filter is the generator's future "unused images" entry point.
      owed:   Map the parsed params to the service's input in one place: either `unused: filter.unused === "1"` (and the same for `missingAlt`) in the page, or make `listMedia` accept the search-param shape. Then add a test that feeds `mediaSearchParamsSchema` output into `listMedia`.
      traces: FR-008, US3-AS5, T024/T046/T049

- [ ] MAJOR F2 — The post list offers filters for only 4 of 8 post statuses, and drops any other `?status=` to "All".
      where:  src/app/p/[projectSlug]/posts/page.tsx:23, src/app/p/[projectSlug]/posts/page.tsx:52, src/lib/validation/media.ts:49
      why:    `FILTERS` lists All, draft, scheduled, published, failed and needs_decision. `needs_review`, `approved`, `publishing` and `partially_failed` are missing. `known` (line 52) only accepts keys from `FILTERS`, so a shared link such as `?status=partially_failed` silently shows every post. The service (`list.ts:12`) and the unused `postSearchParamsSchema` (T024) both support every status. The page re-implemented the parsing instead of using them. US6's story and independent test name "partially failed" explicitly ("filter the list by each status").
      owed:   Build the tabs and the param parsing from one list of every post status plus `needs_decision`, e.g. `POST_LIST_STATUSES` and `postSearchParamsSchema`, with counts from `list.counts`. Add a test that `?status=partially_failed` is honoured.
      traces: FR-029, US6-AS1, T071

- [ ] MAJOR F3 — Publish-time media resolution is not bounded by the tick deadline, and its storage calls have no timeout.
      where:  src/server/scheduler/publishing.ts:217, src/server/scheduler/publishing.ts:244, src/server/services/media-variants.ts:222, src/server/services/media-variants.ts:233
      why:    The deadline is checked once, before resolution (line 217). `resolvePublishMedia` then runs unbounded:
      - one `storage.exists` per image;
      - one per variant;
      - on a vanished object, a full regeneration of up to 12 sharp encodes, plus a GET and a PUT;
      - none of these storage calls has a timeout.

      After that, the provider call still gets its full `providerTimeoutMs`. So a slow or hanging bucket, or a few regenerations, pushes `runTick` past its budget. The constitution requires "bounded (well under 30 s)". contracts/services.md:85 requires "if resolution finishes past `deadline − providerTimeout`, the lease is released as 002 does". T054 and T055 are ticked for exactly that clause ("deadline respected"), but no test covers it: `media/publish-media.test.ts` and `publish-resolution-retry.test.ts` only test regeneration, a deleted original and retry.
      owed:   After resolution, re-check `now + providerTimeoutMs > deadline` and release the lease exactly as lines 217–231 do. Give the resolution step a time bound, for example an abort or timeout on the storage calls, or race it against the remaining budget, so a hung bucket cannot hold the tick. Add the missing "deadline respected" test: slow storage double, release, no provider call.
      traces: FR-016, Constitution "Engineering Constraints" (runTick bounded), contracts/services.md "Scheduler change", T054, T055

- [ ] MAJOR F4 — 76 of the feature's files are uncommitted, against the constitution's commit-per-task workflow.
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

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-041) | 41 | 35 | 6 (FR-008 F1, FR-016 F3/F5, FR-024 F7, FR-029 F2, FR-030 F9, FR-034 F10) | 0 | 0 | — (FR-004, FR-039 code present; behaviour needs Docker / a browser) |
| Success criteria (SC-001–SC-011) | 11 | 9 | 0 | 0 | 0 | 2 (SC-001 timing, SC-007 keyboard-only in a browser) |
| User-story acceptance scenarios (US1–US8) | 66 | 60 | 6 (US3-AS5, US4-AS5 F5, US5-AS3 date, US6-AS1, US6-AS3, US7-AS2) | 0 | 0 | — |
| Edge cases | 16 | 13 | 3 (partial batch in picker F16, empty override F12, unregistered provider F11) | 0 | 0 | — |
| Constitution principles + engineering/workflow sections | 9 | 6 (I, II, III, V, VI, VII) | 3 (IV F17, bounded `runTick` F3, commits F4) | 0 | 0 | — |

The constitution's mandated first-review categories were all swept. In each, the specific finding is noted and everything else held.

- **Concurrency and locking:** the media delete and attach lock order and the move-to-occurrence race hold, as do the pull-preview rollback and variant insert races.
- **Idempotency and retries:** variant cache and `markUsed` hold.
- **Authorization and scoping:** checked every action, the check route, storage keys and cross-project ids. One gap is in F14.
- **Time zones and DST:** checked `resolveLocalDateTime`, calendar ranges and 23/25-hour days. Navigation is F7.
- **Error, timeout and ambiguous paths:** see F3, F5 and F16; the media-unavailable path is `fatal_error` with no provider call.
- **Secrets:** checked `MediaView`, `StorageError`, delete and orphan logs, and the SC-011 scans.
- **Requirements:** every FR and SC was checked one by one.

## What I could not check

- **Anything that needs a browser:**
  - real HTML5 drag and drop between calendar slots;
  - focus returning to the moved chip after `router.refresh()`;
  - live-region announcements with a screen reader;
  - keyboard-only completion of every screen (SC-007, T089, still 🛑 BLOCKED);
  - the composer staying under 0.5 s while typing (SC-002 timing), and the 2-minute composing flow (SC-001).
- **The offline stack:**
  - `docker compose --profile offline up` was never run;
  - nobody checked that the pinned MinIO tag pulls, has `curl` for its healthcheck (F13), or serves objects anonymously after `PutBucketPolicy` (research U2);
  - `tests/integration/storage-minio.test.ts` is skipped without `S3_TEST_ENDPOINT`.
- **Real R2 or S3:** path-style addressing (U1) and the checksum settings are verified against an in-memory request handler only.
- **sharp on Linux:** `sharp` resolving inside the Linux Docker image's worker bundle (U3) was inspected on darwin only during planning.
- **Wall-clock performance:** SC-006 (the test guards the query count, not the time) and SC-010 (operator setup time).
- **The full gate set and CI:** I did not re-run them (constitution). No PR exists yet to read CI from, and F19 records one failing test in implement's last full run.
