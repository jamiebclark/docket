# Review: Bluesky video (025), re-review after remediation

Reviewed 37 implementation file(s) (15 modified, 22 new) and the spec artifacts, against `dfce47c` (the merge-base with `origin/main`).
The branch has 2 commits (spec and plan). **The implementation is still uncommitted** in the working tree. This review therefore covers
the present state of the tree (`git diff dfce47c` plus the untracked files), not a committed diff.

This is the second review of entry 025. The first review found three MAJOR findings. Phase 8 (T041–T043) was then built to fix them.
The constitution limits a re-review (`.specify/memory/constitution.md:125-128`): check that each earlier finding is fixed and that the
remediation caused no regression. Anything else it notices "is recorded as MINOR for the hardening entry, not BLOCKER/MAJOR". This
review follows that rule.

**Read in full:**

- Source: `src/providers/bluesky/video-publish.ts`, `video-errors.ts`, `video-service.ts`, `video-state.ts`, `media-range.ts`,
  `pds-host.ts`, `capabilities.ts` and `publish.ts`.
- Diffs: `steps.ts`, `settings.ts`, `index.ts`, `validate.ts`, `src/providers/types.ts`, `src/server/scheduler/record.ts`,
  `record.test.ts`, `src/providers/requirements.test.ts` and `tests/integration/limits/enforcement.test.ts`.
- Tests: `src/providers/bluesky/video-publish.test.ts`, `tests/helpers/bluesky-video.ts`, and `tests/integration/bluesky/video.test.ts`,
  `video-failures.test.ts`, `video-limits.test.ts` and `video-no-secrets.test.ts`.
- Docs: the five doc diffs.
- Feature artifacts: `spec.md`, `plan.md`, `data-model.md`, `contracts/bluesky-video-publishing.md`, `tasks.md` and the first `review.md`.
- The last implement pass's report (`.pipeline/implement.result.json`).
- `XRPCError` in `@atproto/xrpc` 0.8.14, to check F12.

**Sampled** (test titles only, by grep): `capabilities.test.ts` and `video-errors.test.ts`.

**Not re-read:** `video-state.test.ts`, `video-steps.test.ts`, `video-service.test.ts`, `pds-host.test.ts`, `video-validate.test.ts`,
`video-fit.test.ts`, `compose/bluesky-video-summary.test.ts`, `contracts/bluesky-video-capabilities.md`, `research.md` and
`quickstart.md`. The first review read them, none of them bears on an earlier finding, and their suites pass (below).

**Ran.** Targeted runs only, since the constitution bars review from re-running the full gates:

- `pnpm vitest run src/providers/bluesky src/server/scheduler/record.test.ts src/providers/requirements.test.ts tests/integration/bluesky
  tests/integration/compose/bluesky-video-summary.test.ts tests/integration/limits/enforcement.test.ts tests/integration/docs/limits-inventory.test.ts`:
  30 files and 501 tests, all passed.
- Every other test file that mentions Bluesky (62 files, 548 tests): 546 passed. Two failed on time thresholds:
  `tests/integration/activity/performance.test.ts` and `tests/integration/notifications/performance.test.ts`. Each passes when run
  alone (2/2 and 2/2). `docs/decisions.md` (024) already lists both as load-sensitive.
- The other suites that 024 lists as load-sensitive, run alone (`jobs/budget`, `failures/retry-all-cap`,
  `api/endpoints/retry-failed-targets` and `scheduler/budget`): 4 files and 18 tests, all passed.
- A throwaway probe in `$TMPDIR` (outside the repo, deleted afterwards). It drives `advance` with refusals that carry no `message` (F12).

## Verdict

**Yes, with one condition.** The three blocking findings of the first review are fixed. I found no regression from the remediation. The
feature can go to a human to merge **once CI on the PR shows the full gates green**.

That condition matters. The last implement pass ran the full suite and it ended with 6 failed tests in 4 files, which the pass could
not name (F13). Everything I could run that the remediation could affect passes. The only failures I reproduced were two timing
benchmarks, and both pass when run alone. That points to machine load, not this feature, but I have not proved it.

**One new defect is worth fixing before merge** even though the re-review rule makes it MINOR: F12. When Bluesky refuses without a
`message`, Docket shows the error code as the message. A `DailyLimitExceeded` wait then reads "DailyLimitExceeded. Docket checks
again in an hour…" instead of FR-008's default text. Refusals read "(VideoTooLong: VideoTooLong)". The fix is one line.

The other MINORs are carried over from the first review and can wait for a hardening pass.

## Findings

### Earlier blocking findings (first review)

- [x] MAJOR F1 — Fixed: reply codes are now sanitised, and the no-secrets suite echoes the token
      where:  src/providers/bluesky/video-publish.ts:51-52, src/providers/bluesky/video-errors.ts:13-19, src/providers/bluesky/video-errors.ts:49,
              src/providers/bluesky/video-publish.ts:388, tests/integration/bluesky/video-no-secrets.test.ts:40,
              tests/integration/bluesky/video-no-secrets.test.ts:66-80
      what:   `codeOf` now passes every code through `sanitiseCode`. A code is kept as is only when it matches `^[A-Za-z0-9_.-]{1,64}$`
              and contains no secret; otherwise it gets `sanitiseMessage`. Every `codeOf` call passes the step's secrets, including
              the service token once it is minted (:113, :205, :260, :308, :346, :393). `jobFailureText` and `check_job`'s
              `failureCode` are sanitised too. The suite now echoes the service token in the `error`, `message` and `failureCode` of the
              limits, start, part, finish and job replies. It asserts the token is absent from the target row, the attempts, the console
              and the activity events. All of these pass.
      residual: the rendered target view is not asserted separately. It is built from the row the suite checks.

- [x] MAJOR F2 — Fixed: `docs/limits.md` has the five Bluesky note rows
      where:  docs/limits.md:161-165
      what:   The rows cover the daily bytes (not modelled), the upload limits check (it fails 23 h after the first refusal, per P9), the
              processing ceiling, the verified email and the client duration ceiling. Each cites a test title that exists
              (`capabilities.test.ts:7` and `:28`, `video-limits.test.ts:46`, `video-failures.test.ts:83`, `video-errors.test.ts:11`).
              `tests/integration/docs/limits-inventory.test.ts` passes.

- [x] MAJOR F3 — Fixed: the attempt log records `limitsCheck` on every outcome, and job `progress`
      where:  src/providers/bluesky/video-publish.ts:188, src/providers/bluesky/video-publish.ts:195, src/providers/bluesky/video-publish.ts:200-201,
              src/providers/bluesky/video-publish.ts:205, src/providers/bluesky/video-publish.ts:53, src/providers/bluesky/video-publish.ts:334,
              tests/integration/bluesky/video-limits.test.ts:71, tests/integration/bluesky/video-failures.test.ts:76-81
      what:   The `check_upload_limits` response records `ok`, `refused` or `skipped` on every path that ends the step. The
              `finish_upload` and `check_job` responses record `progress` when it is a number. The tests assert
              `"limitsCheck":"skipped"` and `"progress":42`.

### Found in this review (MINOR under the re-review rule)

- [ ] MINOR F12 — When Bluesky's refusal has no message, Docket shows the error code as the message, so FR-008's default limit text never appears and refusals read "(Code: Code)"
      where:  src/providers/bluesky/video-publish.ts:54, src/providers/bluesky/video-publish.ts:265, src/providers/bluesky/video-publish.ts:269,
              src/providers/bluesky/video-publish.ts:272, src/providers/bluesky/video-publish.ts:315, src/providers/bluesky/video-publish.ts:355,
              src/providers/bluesky/video-publish.ts:403, src/providers/bluesky/video-errors.ts:38, src/providers/bluesky/video-errors.ts:66-68,
              node_modules/.pnpm/@atproto+xrpc@0.8.14/node_modules/@atproto/xrpc/dist/types.js:83-84,
              src/providers/bluesky/video-publish.test.ts:393-394
      why:    The two files disagree about what "no message" looks like:
              - `video-errors.ts` expects a missing message to arrive empty. `codeAndMessage` then drops `: <message>`, and
                `limitMessage` falls back to "Bluesky's daily video upload limit has been reached for this account".
              - `video-publish.ts` passes `messageOf(err)`, which is `err.message`. `XRPCError`'s constructor sets that to
                `message || error || <status text>`, so it is never empty.
              The probe showed the results:
              - A start reply of `400 {"error":"DailyLimitExceeded"}` waits with "DailyLimitExceeded. Docket checks again in an hour;
                nothing was uploaded." 23 h later the failure reads "DailyLimitExceeded. Bluesky still refused…".
              - `{"error":"VideoTooLong"}` gives "…(VideoTooLong: VideoTooLong). Nothing was published."
              - The same happens for parts (`UploadFailed: UploadFailed`), finish, status reads and any other 4xx (`Weird: Weird`).
              This contradicts FR-008 ("Bluesky's message or Docket's default") and contract §7 ("drops `: <message>` when Bluesky
              sent none"). No test catches it:
              - The cases whose text includes the message all send one (`video-failures.test.ts:17`).
              - The one message-less refusal that shows the message, finish `UnsupportedContentType` (`video-publish.test.ts:393-394`),
                checks only a prefix with `toContain`.
              The `canUpload: false` path is correct, because it reads `message` from the 200 body. Outcomes are unaffected: the target
              still waits or fails as it should, and nothing is published.
      owed:   Take the message from the reply body, not the error object, for example
              `err instanceof VideoServiceError ? str(asRecord(err.body).message) : undefined`. Then add one no-message case for
              `DailyLimitExceeded` (expect the default text) and one for a start refusal (expect `(VideoTooLong)`).
      traces: FR-008, FR-014, contract §7, US4 #5

- [ ] MINOR F13 — T039 is ticked, but the last full-suite run ended red and no gate result is recorded
      where:  specs/025-bluesky-video/tasks.md:138, docs/decisions.md:1211-1215, specs/025-bluesky-video/.pipeline/implement.result.json
      why:    The remediation pass's report says the full `pnpm vitest run` "ended with 4 failed files and 6 failed tests out of
              4463". It could not name them, and it ends `STATUS: failed`. T039 ("Fix any failure; report exact output if anything
              remains red") is still ticked. The `## 025` "Implementation outcome" records no lint, typecheck, test or build result,
              although 024's does. So SC-008's full-gate clause is unconfirmed. My targeted runs (above) found nothing the remediation
              broke, and the two failures I reproduced are timing benchmarks that pass alone. Machine load is the likely cause, but I
              have not proved it.
      owed:   Let CI on the PR run the full gates. Any failure outside the known timing suites blocks the merge. Record the gate
              results under `## 025` "Implementation outcome".
      traces: SC-008, T039, constitution "Quality gates"

### Carried from the first review (still open, MINOR)

- [ ] MINOR F4 — The Bluesky video docs sit after §17 (Facebook), not in §13 as FR-021 says
      where:  docs/adding-a-provider.md:323, docs/adding-a-provider.md:423
      why:    The content is accurate, but §13 (the Bluesky worked example) still says nothing about video. Someone reading the
              Bluesky example will not find it.
      owed:   Move the subsection under §13, or add a pointer to it from §13.
      traces: FR-021

- [ ] MINOR F5 — Some failure-path tests do not do what their titles say
      where:  tests/integration/bluesky/video-failures.test.ts:158-169, tests/integration/bluesky/video.test.ts:89-106,
              tests/integration/bluesky/video.test.ts:134-157
      why:    - "resumes … after a worker dies mid-part" uses a dropped connection, which the test above it already covers. No video
                test lets a lease expire mid-step.
              - "first read ≥ 30 s after finishing" is a comment at :103 with no assertion.
              - The "timeouts" table uses only `pre-send-failure`.
      owed:   Add a lease-expiry case (for a part and for `create_post`), an aborted-signal case for a non-part step, and an assertion
              on the first read's delay.
      traces: FR-026, US2 #11, US1 #4, US1 #7

- [ ] MINOR F6 — Constants and predicates are duplicated between passes
      where:  src/providers/bluesky/video-state.ts:15, src/providers/bluesky/video-state.ts:38, src/providers/bluesky/capabilities.ts:12,
              src/providers/bluesky/video-publish.ts:106, src/providers/bluesky/video-state.ts:4, src/providers/bluesky/steps.ts:34,
              src/providers/bluesky/publish.ts:49, src/providers/bluesky/publish.ts:138, src/providers/bluesky/video-service.ts:33-34,
              src/providers/bluesky/video-publish.ts:49-50
      why:    - `MAX_VIDEO_BYTES` duplicates `BLUESKY_VIDEO.maxBytes`. If the declaration is raised alone, a saved upload over the old
                bound stops parsing and fails "Publishing state is unreadable".
              - `expiresInSeconds: 300` is a literal next to `SERVICE_TOKEN_TTL_SECONDS`.
              - "Is this one video" is computed three ways.
              - `asRecord` and `str` are copied in two files.
      owed:   Derive the schema bound from `BLUESKY_VIDEO.maxBytes` and the summary TTL from `SERVICE_TOKEN_TTL_SECONDS`. Use one
              `isOneVideo` helper, and share `asRecord` and `str`.
      traces: plan P1, P3

- [ ] MINOR F7 — Attempt summary keys drift from data-model §5
      where:  src/providers/bluesky/video-publish.ts:223, src/providers/bluesky/video-publish.ts:257, src/providers/bluesky/video-publish.ts:282,
              src/providers/bluesky/video-publish.ts:334, src/providers/bluesky/publish.ts:179
      why:    - `start_upload` records `bytes` rather than `sizeBytes`, `mimeType`, `name`, `durationMs`, `width` and `height`. Its
                response has no `jobId` or `expiresAt`.
              - A part records `part`, not `partNumber`.
              - `finish_upload`'s response has no `completedJobId`, `deduplicated` or `blob`.
              - `create_post` records `video: true`, not `video: 1`, and has no `aspectRatio` or `alt`.
      owed:   Align the summaries with data-model §5, keeping the key names clear of the redactor's words.
      traces: data-model §5

### Notes

- NOTE F8 — The engine sends one part per tick (`src/server/scheduler/publishing.ts:94`, `src/providers/bluesky/video-publish.ts:303`).
  A 300 MB file in 5 MB parts takes 60 ticks before `finish_upload`. If Bluesky's `expiresAt` is shorter than that, a large upload
  restarts twice and fails. The owed live checks should record `expiresAt` next to `partSizeBytes`.
- NOTE F9 — A refused service token for the status read is fatal (`src/providers/bluesky/video-publish.ts:371`), as contract §2 says.
  P13's own reasoning would also support falling back to `statusAuth: "none"` there. This is a judgement call, not a defect.
- NOTE F10 — The gate-results half of this note is now F13. The edit to `tests/integration/limits/enforcement.test.ts:256-258` adds
  coverage and weakens nothing, but `docs/decisions.md` still does not record it as an edited existing test.
- NOTE F11 — FR-005's wording ("reserved by the start-upload step") differs from the code, which reserves at `check_upload_limits`
  (`src/providers/bluesky/steps.ts:46-51`). This is recorded as P2 in `docs/decisions.md` and is what US4 #6 needs. I counted FR-005
  as satisfied.
- NOTE F14 — `.pipeline/state.json` records the last implement pass as `"status": "ok"` ("1 of 43 task(s) left"), but that pass's own
  report ends `STATUS: failed` (F13). Anyone who reads only the state file will miss the red suite.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1–F3) | 3 | 3 (fixed) | 0 | 0 | 0 |
| Functional requirements | 30 | 27 | 3 | 0 | 0 |
| Success criteria | 8 | 7 | 1 | 0 | 0 |
| Acceptance scenarios (US1–US4) | 33 | 33 | 0 | 0 | 0 |
| Edge cases | 14 | 14 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |

- **Partial FRs:** FR-008 (F12), FR-021 (F4) and FR-026 (F5). FR-007, FR-012 and FR-020 are now satisfied (F1–F3).
- **Partial SC:** SC-008, because the full gates are unconfirmed (F13). SC-007 is now satisfied (F1).
- **Scenarios:** US4 #4 is now satisfied (F3). US4 #5 holds when Bluesky sends a message; when it sends none, see F12 under FR-008.
- **Principles:** VII is now satisfied (F1). The workflow's quality gates are covered by F13 rather than counted as a principle.
- **Regression check of the remediation's files.** I read `video-publish.ts`, `video-errors.ts`, `video-no-secrets.test.ts`,
  `video-limits.test.ts`, `video-failures.test.ts` and `docs/limits.md` in full. No earlier assertion was weakened. `sanitiseCode`
  leaves every code the handlers compare against unchanged (`DailyLimitExceeded`, `UploadAlreadyCompleted`, the restart codes and
  the rest), so no branch changed.
- **Where the other counts come from.** They are carried from the first review, which checked each FR one by one against code and a
  passing test. Under the constitution's rule, this re-review did not re-derive them. It re-checked the FRs the earlier findings named,
  plus FR-008 and FR-014 for F12.

## What I could not check

- **The full gates** (lint, typecheck, the full `pnpm test` and build). The constitution bars review from re-running them. The last
  implement run of the full suite was red, with 6 unidentified failures (F13). CI on the PR must show every gate green before merge.
- **Typecheck of the remediation's edits.** Vitest strips types, so none of my runs would catch a type error in `video-publish.ts` or
  `video-errors.ts`. CI's `pnpm typecheck` is the check.
- **Real Bluesky behaviour** (unchanged from the first review). The following are all mocked only and are owed live checks (T040,
  `docs/accounts.md`):
  - the parts host and its auth;
  - the token audiences for the limits and status calls;
  - `getSession`'s `didDoc` through the entryway;
  - the shape of an "already processed" reply;
  - `partSizeBytes`, `expiresAt`, the processing time and the duration ceiling;
  - whether the video service's refusals carry a `message` (F12).
- **Network behaviour I cannot reach from here:** whether the operator's public media URL answers `Range` with a 206, and whether
  Node's `fetch` sends the explicit `content-length` and a `Uint8Array` body exactly as the video service expects.
- **The rendered target view and activity feed in a browser** for a waiting or failed Bluesky video.
