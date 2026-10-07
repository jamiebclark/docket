# Review: Video groundwork (018), re-review after remediation

This is the second review of 018. It follows one remediation pass (Phase 10, T057–T062). The constitution scopes a re-review: it "checks ONLY that each earlier finding is fixed and that the files changed by the remediation introduced no regression". Anything else it notices is MINOR (constitution, Development Workflow). This review keeps to that scope.

**Base and evidence.** The review runs against `c7d4c17`, the merge-base with `origin/main`. The branch has two commits, `4d072af` (spec) and `03452ff` (plan). All implementation is still uncommitted, so this review reads the **present working tree against the base**, not a commit range. That is 146 paths outside `specs/`: 85 tracked files changed and 50 untracked new files (one more than the first review, `scripts/video-smoke.test.ts`).

**Read in full: the 14 files the remediation changed.** I identified them by modification time after the remediation pass started (18:32Z):

- `.github/workflows/ci.yml`
- `scripts/video-smoke.ts` and `scripts/video-smoke.test.ts`
- `src/components/media/upload/UploadPanel.tsx`, `upload-ui.ts` and `upload-ui.test.ts`
- `src/lib/upload/engine.ts` and `engine.test.ts`
- `src/server/video/loop.ts`
- `src/server/services/media.ts`
- `src/components/media/MediaPicker.tsx`
- `src/app/p/[projectSlug]/media/actions.ts`
- `tests/integration/video/loop.test.ts` and `tests/integration/media/library.test.ts`

**Re-read for the fixes' context:**

- `src/server/services/uploads.ts` (the completion path F5 now relies on)
- `src/server/dal/media.ts` (the list filter F6 uses)
- `src/server/dal/media-processing.ts` (the lease checks behind F4 and F17)
- `Dockerfile` and the `build:video-smoke` script in `package.json` (F2, F3)
- `tests/helpers/ffmpeg.ts`, `tests/helpers/video-fixtures.ts` and `src/server/video/guard.ts`
- `docs/decisions.md` §018 and `docs/deployment.md:102`

**Not re-read:** everything else. The first review read it, the remediation did not touch it, and the constitution scopes a re-review to what changed.

**Ran here:**

- **Targeted tests for the remediation:** `src/lib/upload/engine.test.ts`, `src/components/media/upload/*`, `scripts/video-smoke.test.ts`, `tests/integration/video/loop.test.ts` and `tests/integration/media/library.test.ts`. That is 6 files: 41 passed, 2 skipped. The 2 skips are the ffmpeg half of `loop.test.ts`, because there is no ffmpeg here.
- **A smoke bundle probe:** I bundled `scripts/video-smoke.ts` with the package's own esbuild flags into `$TMPDIR` and ran it against the repo's `node_modules`. It got past the worker guard and stopped while generating fixtures, for want of ffmpeg. That proves the bundle loads and F3's guard mark runs first. The crash text was "Cannot read properties of undefined (reading 'slice')": `tests/helpers/video-fixtures.ts:13` reads `r.stderr`, which is empty when the binary is missing. In the image, this cannot be reached before `ci.yml:114` has already checked that ffmpeg runs.
- **`.next/standalone` from T050:** it contains `scripts/video-smoke.mjs` and `node_modules/sharp`, so the image's `node scripts/video-smoke.mjs` can resolve its external.
- **Not re-run:** the full suite, lint, typecheck and build, because the constitution says review does not re-run them. The implement pass reported `tsc` clean and no eslint errors. It also reported the full suite green except `tests/integration/failures/retry-all-cap.test.ts`, which timed out once under load and passed alone. That test is outside this feature.

## Verdict

**There are no unresolved BLOCKER or MAJOR findings. The branch is ready for the runner to commit, push and open the PR. The merge must still wait for that PR's CI.**

All six blocking findings from the first review are addressed:

- **F1, F3, F4, F5 and F6 are fixed**, each with a test. F1's test is indirect (see F18).
- **F2 is fixed in code.**
  - The `test` job installs ffmpeg.
  - The `docker` job loads the image as `docket:ci` and logs its size. It then runs `ffmpeg -version`, `ffprobe -version`, the libx264 check and the video smoke script, all as uid 1001.
  - `requireFfmpeg()` throws under `CI` when ffmpeg is missing, so these suites cannot pass silently there.

What F2 is still owed is **evidence**: no real ffmpeg code path of this feature has run anywhere yet. That includes probe, clean, poster, the ffmpeg half of the loop, the US4 publish test and the in-image smoke. The PR's CI is where that evidence comes from, and the runner merges only when every check on the PR is green. Keeping F2 open here would block the very push that settles it. If CI's `test` or `docker` job fails, that failure is the next thing to fix, and T044 and T058 stay open until then.

**One regression.** The remediation introduced one regression, in a narrow multi-worker case. Since F4, the media loop also deletes the staged source when `finishReady` returns false. That also happens when another worker has taken over the lease, so the new owner can lose the file it is about to read (F17, MINOR).

**Two new MINORs:**

- Nothing would catch a revert of F1's fix (F18).
- The decision log still says Phases 1–8 landed as planned and the gate is green, while T044 is open (F19).

**Still open, as expected:** the seven earlier MINORs (F7–F13) were not in the remediation's scope. They belong to the hardening entry.

## Findings

- [x] 🛑 BLOCKER F1 — **Fixed.** The library's upload panel no longer throws away its rows when the media page refreshes.
      where:  src/components/media/upload/UploadPanel.tsx:132, src/components/media/upload/UploadPanel.tsx:134, src/components/media/upload/UploadPanel.tsx:170, src/components/media/upload/upload-ui.ts:138, src/app/p/[projectSlug]/media/upload-actions.ts:32, src/components/media/upload/UploadPanel.tsx:188
      fixed:  The engine's `useMemo` now depends on `[slug, stableLimits]`. `stableLimits` keeps its identity as long as `limitsIdentity(limits)` (`JSON.stringify`) is unchanged.
              - The library page's `status.limits` is rebuilt by `libraryLimits(env)` on every render, from the same settings and in the same key order, so the key is identical across refreshes.
              - Neither the action's `refresh()` (upload-actions.ts:32) nor the batch-settled `router.refresh()` (UploadPanel.tsx:188) rebuilds the engine any more.
              - Rows, progress, Retry, Cancel and the `beforeunload` guard (which reads the same `engine`) survive both refreshes.
              - The picker was never affected: it keeps `limits` in state.
              This is reasoned from React's memo rules; it was not observed in a browser. The only test is of the key helper (see F18).
      traces: FR-002, FR-006, FR-007, FR-008, FR-012, US1 AS1/AS5/AS6/AS8

- [x] 🛑 BLOCKER F2 — **Fixed in code; the run itself is owed to the PR's CI.**
      where:  .github/workflows/ci.yml:75, .github/workflows/ci.yml:76, .github/workflows/ci.yml:107, .github/workflows/ci.yml:108, .github/workflows/ci.yml:113, .github/workflows/ci.yml:117, tests/helpers/ffmpeg.ts:15, docs/deployment.md:102
      fixed:  The workflow now matches contracts/operations.md:
              - the `test` job runs `apt-get install -y --no-install-recommends ffmpeg` before `pnpm test` (ci.yml:75–76);
              - the `docker` job sets `load: true` and `tags: docket:ci` (ci.yml:107–108), logs the image size (ci.yml:113), and runs ffmpeg, ffprobe, the libx264 encoder check and `scripts/video-smoke.mjs` as `--user 1001` (ci.yml:114–117).
              The `docker` job builds a single platform, so `load: true` is valid. The image's `WORKDIR` is `/app` and the standalone output holds `scripts/video-smoke.mjs` and `node_modules/sharp`. `docs/deployment.md:102` ("CI logs the exact size of every build") is now true.
      still owed (not review-blocking): the ffmpeg suites and the in-image smoke must pass in the PR's CI. The runner's merge gate requires every check to be green, and these suites cannot skip there. T044 and T058 remain open for exactly this. The decision log's overclaim is F19.
      traces: FR-034, FR-032, US5 AS1, SC-005, SC-009, Constitution I and II, plan P22/P23

- [x] MAJOR F3 — **Fixed.** The in-image smoke script now marks itself as the worker process before it runs the pipeline.
      where:  scripts/video-smoke.ts:32, scripts/video-smoke.test.ts:5
      fixed:  `main()` calls `markWorkerProcess()` first (video-smoke.ts:32). `scripts/video-smoke.test.ts` checks that the call appears before `createVideoFixtures()` in `main()`. The check reads the source text, which is the guard F3 asked for at minimum. The bundle probe above confirms that the built script gets past the guard.
      traces: plan P21/P22, US5 AS1, FR-032

- [x] MAJOR F4 — **Fixed.** Deleting a video that is not ready now removes its staged source, and so does the worker's "deleted mid-run" branch.
      where:  src/server/services/media.ts:413, src/server/video/loop.ts:96, tests/integration/video/loop.test.ts:67, tests/integration/video/loop.test.ts:187
      fixed:  `deleteMedia` adds `asset.sourceStorageKey` to `doomed` (media.ts:413). The loop's `!ready` branch now deletes `row.sourceStorageKey` along with `written` (loop.ts:96).
              - The new test "deleting a queued video" (loop.test.ts:67–73) ran here and passes.
              - The added mid-run assertion (loop.test.ts:187) is in the ffmpeg suite and has not run.
              - Deleting while the worker is processing is covered by `deleteMedia` itself, because `sourceStorageKey` is set until `finishReady` or `finishFailed` clears it.
              See F17 for a side effect of the loop's half of this fix.
      traces: Spec edge case "Deleting a video", FR-017, D9, plan P27

- [x] MAJOR F5 — **Fixed.** Retry after a lost completion response now reaches the completed asset.
      where:  src/lib/upload/engine.ts:298, src/lib/upload/engine.ts:301, src/server/services/uploads.ts:193, src/server/services/uploads.ts:198, src/lib/upload/engine.test.ts:221
      fixed:  When `listUploadedParts` answers `upload_finished`, the engine now calls `complete(row, run)` (engine.ts:298–301). For a `completed` session, `completeUpload` returns that session's asset (uploads.ts:193, 198), so the row reaches processing or ready and `uploaded` fires, which lets the picker attach it (FR-014).
              - For a cancelled, expired or refused session, the server answers `upload_finished` again. The row is interrupted with that message, as before; nothing loops on its own.
              - The test "completes on Retry when the server finished but the answer was lost" (engine.test.ts:221–231) ran here and passes.
      traces: FR-008, FR-014, plan P4

- [x] MAJOR F6 — **Fixed.** The composer's picker no longer offers failed videos.
      where:  src/components/media/MediaPicker.tsx:194, src/server/services/media.ts:283, src/server/services/media.ts:300, src/server/dal/media.ts:148, src/app/p/[projectSlug]/media/actions.ts:36, tests/integration/media/library.test.ts:32
      fixed:  The picker asks for `states: ["processing", "ready"]` (MediaPicker.tsx:194). The filter passes through `listSchema` (media.ts:283) and `listMedia` (media.ts:300) to the repo's shared `searchCond` (dal/media.ts:148), which serves both the rows and the count.
              - The library page calls `listMedia` without `states`, so failed items stay visible there with Delete.
              - Processing items remain attachable, as D8 intends.
              - The test at library.test.ts:32–42 ran here and passes.
      traces: FR-017, US2 AS3, plan P26

- [ ] MINOR F17 — When the lease has been taken over, the media loop now deletes the source that the new lease holder is reading (a regression from F4's fix).
      where:  src/server/video/loop.ts:94, src/server/video/loop.ts:96, src/server/video/loop.ts:40, src/server/dal/media-processing.ts:38, src/server/services/media.ts:413
      why:    `finishReady` returns false in two different cases, because `held()` requires the same lease token and a live row (media-processing.ts:38–39):
              - **The row was deleted.** `deleteMedia` has already deleted the source (media.ts:413), so the loop's new deletion is redundant.
              - **Another worker owns the lease.** Take worker A paused for more than 120 s (container freeze, host sleep, or the database unreachable from A alone). Worker B claims the row with a new token and starts reading the same source. A resumes, finishes `putFile` and calls `finishReady` before its 30 s heartbeat (loop.ts:40) notices the loss. `finishReady` returns false, and A deletes the source B needs. B's `getToFile` then finds nothing, and the video ends "Docket could not process this video."
              Before the remediation, B would have succeeded. The same branch already deleted the final video and poster at the deterministic `media/<a>/…` keys that B also writes. That part is older, but it has the same cause.
              It needs two workers and a lost lease, and the outcome is a failed item with a reason, not silent corruption, so it is MINOR.
      owed:   Tell the two cases apart:
              - if the row is deleted, delete `written` and the source;
              - if only the lease is lost, delete nothing, because the new holder owns those keys.
              Or simply drop the source from this branch, since `deleteMedia` owns it. Add a loop test that swaps the lease token before `finishReady` and asserts that the source and final objects remain.
      traces: FR-021 ("safe to run concurrently with other workers"), plan P8, P27

- [ ] MINOR F18 — F1's fix has no test that would fail if it were reverted.
      where:  src/components/media/upload/UploadPanel.tsx:134, src/components/media/upload/UploadPanel.tsx:170, src/components/media/upload/upload-ui.test.ts:87
      why:    The only new test (upload-ui.test.ts:87–93) checks that `limitsIdentity` returns equal strings for a spread copy. Its second assertion adds a top-level `maxVideoBytes` key that `LibraryLimits` does not have. Putting the engine memo back on `[slug, limits]`, or dropping `stableLimits`, would leave every test green, and the P1 breakage F1 described would come back silently. The implement pass notes that the repo has no DOM renderer, so a re-render test is not available.
      owed:   Either of:
              - a source-text guard in the manner of `scripts/video-smoke.test.ts`;
              - moving the engine's dependency into a tested pure helper (e.g. `engineKey(slug, limits)`) that is the memo's only dependency.
      traces: FR-002, FR-006, FR-012

- [ ] MINOR F19 — The decision log still reports Phases 1–8 as landed and the gate as green, but the ffmpeg suites have only ever been skipped.
      where:  docs/decisions.md:749, specs/018-video-groundwork/tasks.md:111, specs/018-video-groundwork/tasks.md:169
      why:    Line 749 says "All of Phases 1–8 landed as planned. The full gate … is green". But T044 (tasks.md:111) is still open and BLOCKED. Every ffmpeg suite has been skipped wherever it ran: `process.test.ts`, the ffmpeg half of `loop.test.ts`, `video-publish.test.ts` and the ffmpeg cases of `sniff.test.ts`. Constitution II: never report a behaviour as working without executing it. This is the part of F2's "owed" that is still undone. T058 (tasks.md:169) deliberately defers it until CI has run, so that the line can state what actually ran.
      owed:   After the PR's CI runs, rewrite line 749 to say where the ffmpeg suites and the in-image smoke ran and passed, and tick T044 and T058. If CI fails, record the failure instead.
      traces: Constitution II, F2

- [ ] MINOR F7 — Unchanged from the first review. Upload expiry judges a `completing` session by its creation time, so it can abort a completion in progress for any upload that took more than an hour to send.
      where:  src/server/dal/uploads-housekeeping.ts:21, src/server/dal/uploads-housekeeping.ts:33
      owed:   Compare `completing` sessions against `updatedAt`, or record a `completingAt`.
      traces: FR-011, plan P2/P4

- [ ] MINOR F8 — Unchanged. `prepareUpload` has its own cruder video sniffer that treats any `ftyp` file as video. So HEIC, AVIF and M4A uploads through the API get the "Video upload is available in the Docket app." refusal.
      where:  src/server/services/media.ts:192, src/server/services/media.ts:205, src/lib/media/sniff.ts:16
      owed:   Use `sniffMedia(file.bytes)?.kind === "video"`, and delete `looksLikeVideo`.
      traces: FR-022, FR-044, plan P12, Constitution IV

- [ ] MINOR F9 — Unchanged. The video wording helpers exist twice, and the service and the worker import from a client component module.
      where:  src/server/services/media.ts:8, src/server/services/media.ts:156, src/server/services/media.ts:157, src/server/video/process.ts:3, src/providers/video-labels.ts:5, src/providers/video-labels.ts:27, src/components/media/upload/upload-ui.ts:17
      owed:   Keep one labels module and import it everywhere.
      traces: Constitution IV, plan P17

- [ ] MINOR F10 — Unchanged. Cancelling a row while its `createUpload` call is in flight leaves the session open until expiry, holding one of the member's 10 slots.
      where:  src/lib/upload/engine.ts:280, src/lib/upload/engine.ts:492
      owed:   When a superseded `createUpload` returns a session, cancel it.
      traces: FR-009, FR-011, US1 AS7

- [ ] MINOR F11 — Unchanged. The browser's size refusal rounds both numbers down, so a file just over the limit reads "Images can be up to 20 MB; this one is 20 MB."
      where:  src/components/media/upload/upload-ui.ts:8, src/components/media/upload/upload-ui.ts:48
      owed:   Show the file's size with one decimal place, or round it up.
      traces: FR-004

- [ ] MINOR F12 — Unchanged. Import by URL answers a typical video with 413 "too large", not the 415 with the pointer to the app.
      where:  src/server/services/media-from-url.ts:33
      owed:   Sniff the response's first bytes before enforcing the image cap, and answer 415 with `VIDEO_UPLOAD_REFUSAL`.
      traces: FR-044

- [ ] MINOR F13 — Unchanged. The media loop has no 30-minute item deadline, and its storage transfers have no timeout of their own, while the heartbeat keeps renewing the lease.
      where:  src/server/video/loop.ts:38, src/server/video/loop.ts:52, src/server/video/loop.ts:76
      owed:   Combine `AbortSignal.timeout(30 min)` into `work`, and fail the item with `COULD_NOT_PROCESS` when it fires.
      traces: FR-021, plan Constraints

- NOTE F14 — The implementation is still not committed: 85 tracked files changed and 50 untracked, all outside `specs/`. When the runner commits, the untracked files must go in too, including `drizzle/0011_massive_living_tribunal.sql`, `drizzle/meta/0011_snapshot.json`, `NOTICE`, `public/media/video-processing.svg` and the new `scripts/video-smoke.test.ts`. T051 also asks that the last `feat(media)` commit body carry the operator note from contracts/operations.md.

- NOTE F15 — Unchanged. The "making the poster frame" step is set only after `processVideoFile` has made the poster (src/server/video/loop.ts:71 against src/server/video/process.ts:81), so the row shows that step while the cleaned file uploads.

- NOTE F16 — Unchanged. T045's named files and `tests/integration/api/media-video.test.ts` were never created. The API's video refusal is tested in `tests/integration/api/endpoints/media.test.ts:167`. No test lists or gets a video row through the API (FR-044's read half).

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here (owed to CI or live checks) |
|---|---|---|---|---|---|---|
| Earlier blocking findings (F1–F6) | 6 | 6 fixed (F2 in code) | 0 | 0 | 0 | F2's CI run |
| Files changed by the remediation, checked for regressions | 14 | 13 clean | 1 (loop.ts, F17) | 0 | 0 | 0 |
| Functional requirements (FR-001–FR-045) | 45 | 35 | 5 | 0 | 0 | 5 |
| Success criteria (SC-001–SC-011) | 11 | 8 | 0 | 0 | 0 | 3 |
| Constitution principles (I–VII, engineering constraints, workflow) | 9 | 5 | 2 | 0 | 0 | 2 |

**Functional requirements:**

- **Moved to Satisfied (5):**
  - FR-002, FR-006, FR-008 and FR-012: F1 and F5 are fixed.
  - FR-034: the workflow now installs ffmpeg, and the suites cannot skip in CI.
- **Partial (5),** from open MINORs:
  - FR-004 (F11);
  - FR-009 (F10);
  - FR-021 (F13, F17);
  - FR-022 (F8);
  - FR-044 (F12).
- **Not checkable here (5):** FR-016, FR-017, FR-018, FR-019 and FR-020. The code reads correctly and F4 and F6 are fixed, but their real-ffmpeg tests have never run.
- **Satisfied (35):** the 30 the first review found, plus the five above.

**Success criteria:**

- **Not checkable here (3):**
  - SC-005 and SC-009: their tests are ffmpeg-gated and run first in the PR's CI.
  - SC-011: an owed live check.
- **Satisfied (8):** the same eight as the first review.

**Constitution:**

- **Partial (2):**
  - II (F19).
  - IV (F8, F9).
- **Not checkable here (2):**
  - I: the UNVERIFIED ffmpeg facts are now asserted by suites that CI will run, but none has run yet.
  - Workflow: nothing is committed yet.
- **Satisfied (5):** III, V, VI, VII and the engineering constraints. The claim, lease and attempt logic itself is unchanged and sound. F17 is about clean-up after a lost lease.

## What I could not check

- **Any real ffmpeg run.** ffmpeg is not installed here. A `docker` binary is present, but its daemon socket is outside what this phase was given, so I did not build the image. Not run:
  - `tests/integration/video/process.test.ts`;
  - the ffmpeg half of `loop.test.ts`, including F4's mid-run assertion at loop.test.ts:187;
  - `tests/integration/media/video-publish.test.ts` (SC-009);
  - the ffmpeg cases of `src/lib/media/sniff.test.ts`;
  - `scripts/video-smoke.mjs` inside the image.

  Whether the rotation handling (`-display_rotation` and the rotate-tag fallback) behaves on bookworm's ffmpeg 5.1 is still unknown. All of this is owed to the PR's CI (T044, T058).
- **The workflow edits as executed.** I read them and they look correct: the apt step on `ubuntu-latest`, `load: true` with the gha cache, and the `docker run --user 1001` steps. I could not run them.
- **A real browser.** F1's fix is reasoned from React's memo rules and the identical `libraryLimits` output on each render; it was not observed. Also unobserved: XHR progress, `beforeunload`, the `<video>` metadata read, playback under `media-src`, keyboard and screen-reader behaviour.
- **Real buckets, a reverse proxy in front of `via_app`, and the operator's Unraid host.** These are the owed live checks T053–T056.
- **The full suite, lint, typecheck, `db:check` and `build`.** I did not re-run them, per the constitution. I relied on the implement pass's report and ran only the targeted tests listed at the top.
