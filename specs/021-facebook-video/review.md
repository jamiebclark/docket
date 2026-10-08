# Review: Facebook Page video (Page video posts and Reels)

**Second review: re-review after Phase 9 remediation (T038–T040).** Per the constitution's "Review is exhaustive once, then scoped" rule, this round checks only two things: that the first review's blocking findings (F1–F3) are fixed, and that the files the remediation changed introduced no regression. Anything else is recorded as MINOR at most.

Reviewed 47 implementation file(s) in the **uncommitted working tree**: 36 modified and 11 untracked source and test files. They sit on top of 2 commits (`0839858` spec, `10018b8` plan), against `91f471b`, the merge-base with `origin/main`. No implementation commit exists yet, so the evidence is `git diff HEAD` plus the untracked files.

**Read in full this round** (the files remediation touched):

- `src/server/scheduler/publishing.ts`: the claim `decide`, `stepIsAfterPublish`, `refuse` and `execute`.
- `src/providers/facebook/publish.ts`, `src/providers/facebook/validate.ts`, `src/providers/facebook/validate.test.ts`.
- `tests/integration/scheduler/after-publish.test.ts`, `tests/integration/facebook/reel-failures.test.ts`.
- The `docs/limits.md` and `docs/feature-map.md` diffs.
- Supporting code: `src/server/scheduler/{record,recovery}.ts`, `src/providers/facebook/{steps,state,settings}.ts`, `src/providers/types.ts`, `src/providers/validation.ts` (the audio codes), and `src/server/services/posts/index.ts:88,238,358` (the edit lock on started targets).

**Sampled:** `src/providers/facebook/publish.test.ts` (the credentials and invalid-state cases), `tests/integration/facebook/page-video.test.ts` (titles), and `origin/main`'s changes to `src/server/scheduler/publishing.ts` and `src/server/services/activity/classify.ts` (for F6).

**Not re-read:** files the remediation did not touch. The first review read them in full, and its conclusions on them stand (F9).

**Run by this review:**

- **Targeted tests:** 108 files, **1,175 passed**, with `DATABASE_URL=postgres://docket:docket@localhost:5433/docket_test`. They cover `src/providers`, `src/server/scheduler`, `media-fit`, `requirements-ui`, `tests/integration/{facebook,scheduler,meta,docs,limits}`, the API and compose post-type tests, and `tests/helpers`.
- **`pnpm typecheck`: FAILS with 4 errors** (F10). Normally a review reads implement's result instead of re-running this. But the remediation pass recorded "`tsc` ran with the full suite in the background; I did not read its output", so there was no result to read.
- **`pnpm lint`:** 0 errors, 12 warnings.
- **The 3 files the remediation pass reported failing** (F13), re-run in isolation.

## Verdict

**Not yet mergeable, for one trivial but hard reason.**

The three blocking findings from the first review are genuinely fixed:

- **F1:** The claim-time refusals now settle a step after finish as `ambiguous`, never `failed`. Tests cover this through both the generic engine and a real Facebook Reel.
- **F2:** Reel audio refusals now carry Facebook's wording and the Page video suggestion.
- **F3:** `docs/limits.md` has its four note rows, and `docs/feature-map.md` records Facebook video as built, with the unowned items listed.

However, the F1 fix introduced a **type error**. The new `refuse` helper types `outcome` as `string`, where the attempt log needs the `AttemptOutcome` union. So `pnpm typecheck`, CI's typecheck step and `next build` all fail. That breaks the constitution's quality gates and SC-008.

The fix is one type annotation (T041). Two small residues remain, neither blocking:

- **F11:** the provider-side half of F1's fix is dead code under the real engine, though it guards a path that cannot practically occur.
- **F12:** the feature-map table placement and one note-row citation are slightly off.

Fix F10, re-run `pnpm typecheck`, and this is ready for a human to merge.

## Findings

- [x] 🛑 BLOCKER F10 — RESOLVED (refuse now takes `outcome: AttemptOutcome`; tsc clean, 223 scheduler and Facebook tests pass). Was: `pnpm typecheck` fails: T038's `refuse` helper types the attempt `outcome` as `string`
      where:  src/server/scheduler/publishing.ts:132, src/server/scheduler/publishing.ts:137, src/server/scheduler/publishing.ts:143, .github/workflows/ci.yml:45
      why:    `refuse` takes `failed: { lastError: string; outcome: string; error: string }` (line 132) and puts `failed.outcome` into a `ClaimDecision["attempts"]` entry. That entry's `outcome` is the `AttemptOutcome` union (src/server/dal/attempts.ts:6). `tsc --noEmit` reports 4 × TS2322 at publishing.ts:137, 138, 143 and 144. They are the only type errors in the tree. The first review found `pnpm typecheck` clean, so T038 introduced them. CI runs `pnpm typecheck` (.github/workflows/ci.yml:45), and `next build` type-checks too, so the PR cannot go green. The tests pass because Vitest does not type-check.
      owed:   Type the parameter as `outcome: AttemptOutcome` (import the type from `../dal/attempts`), or as the literal union `"account_unavailable" | "did_not_complete"`. Then run `pnpm typecheck` and `pnpm lint src/server/scheduler/publishing.ts`, and read the output.
      traces: SC-008, constitution "Quality gates (CI must be green before merge): … `pnpm typecheck` … `pnpm build`", T037

- [x] 🛑 BLOCKER F1 — RESOLVED. Claim-time engine checks no longer fail a Reel after `finish_reel` was sent.
      where:  src/server/scheduler/publishing.ts:93, src/server/scheduler/publishing.ts:132, src/server/scheduler/publishing.ts:149, src/server/scheduler/publishing.ts:156, src/server/scheduler/publishing.ts:178
      why:    A new `refuse` helper is now used by all three claim-time refusals:
              - account unavailable (line 149);
              - `maxPublishDurationMs` exceeded (line 156);
              - settings rejected at claim (line 178).
              It derives the step through `stepIsAfterPublish` (line 93), now shared with the recovery branch. An `afterPublish` step settles `ambiguous` with `AFTER_PUBLISH_SUFFIX`. With no provider, or no content shape, it stays `failed`, as the finding allowed. Providers that never set `afterPublish` see the same outcomes, attempt rows and messages as before.
              Verified by tests:
              - tests/integration/scheduler/after-publish.test.ts:112: an account flagged `needs_reauth` ends ambiguous, with no provider call.
              - tests/integration/scheduler/after-publish.test.ts:123: `maxPublishDurationMs` exceeded ends ambiguous.
              - tests/integration/facebook/reel-failures.test.ts:184: a finished Reel whose account is flagged ends ambiguous, with no new request and still only one `start`.
              The last test flags the account directly rather than through a second Reel. The engine path is the same.
              Untested: the settings-rejected path. Facebook's `z.object({}).strip()` settings schema cannot fail, so for Facebook it is unreachable anyway. The provider-side clause of T038 is not effective; see F11.
      traces: FR-010, D9, SC-003, US3, constitution V

- [x] MAJOR F2 — RESOLVED. Reel audio refusals now use Facebook's wording.
      where:  src/providers/facebook/validate.ts:7, src/providers/facebook/validate.ts:27, src/providers/facebook/validate.test.ts:56
      why:    `isVideoRule` now also matches `audio_*` codes (`audio_codec_not_allowed`, `audio_required`), so they get the type name, "Docket does not crop, trim or convert video yet." and the Page video suggestion. The suggestion test also uses `isVideoRule`, which does not change it for Facebook: the Page video route declares no audio limits. The new MP3-audio Reel case asserts the type, the suffix and the suggestion, and it passes.
      traces: FR-018, US5

- [x] MAJOR F3 — RESOLVED. FR-023 and FR-025 docs are complete; a cosmetic residue is noted in F12.
      where:  docs/limits.md:41, docs/limits.md:44, docs/feature-map.md:16, docs/feature-map.md:23
      why:    In `docs/limits.md`:
              - The Facebook section has four `note:` rows (lines 41–44): Page video limits, the Reel size limit, the 30-minute upload ceiling and the 60-minute publish ceiling. Each cites a real test title.
              - "aspect 9:16 ±1%" now appears only on the two aspect rows.
              In `docs/feature-map.md`:
              - Line 16 now says Facebook publishes video as of 021.
              - A "Facebook video (021)" bullet sits under "Already built" (line 23) and records as unowned: multiple videos or video with images in one Facebook post, cover frames, optional Reel fields and resumable upload.
              - The table row at line 51 records byte or chunked upload, Page video status checks and the optional title, place and thumbnail fields.
              `tests/integration/docs/limits-inventory.test.ts` and `tests/integration/limits/enforcement.test.ts` pass.
      traces: FR-023, FR-025, FR-033

- [ ] MINOR F11 — T038's provider-side fix is dead code: `advanceFacebook` reads `ctx.step.afterPublish`, which the engine never sets
      where:  src/providers/facebook/publish.ts:45, src/server/scheduler/publishing.ts:432
      why:    The new branch `if (ctx.step.afterPublish)` (publish.ts:45) turns an unreadable Page token into `ambiguous` with `credentialsInvalid`. But the engine builds the context with `step: { name: lease.step, mayPublish: lease.mayPublish }` (publishing.ts:432) and drops `afterPublish`. So in production, a `check_publish` lease with an unreadable token still returns `fatal_error`, and the target ends `failed`. No test covers lines 45–47. The only `afterPublish: true` context in `publish.test.ts` (line 371) exercises the invalid-state branch at line 57.
              This is MINOR, not MAJOR, because the input is not realistic. A stored blob that fails to decrypt is already turned ambiguous by the engine's `CredentialsUnreadable` path (G23, publishing.ts:443). A blob that decrypts but does not parse as a Page token, on an active account with a Reel in flight, has no writer.
      owed:   In `advanceFacebook`, derive `expected` before the token check and test `expected.afterPublish`. Or have the engine pass `afterPublish: lease.afterPublish || undefined` in `step`. Then add a `publish.test.ts` case: finished Reel state, `credentials: {}`, expect `ambiguous` with `credentialsInvalid`.
      traces: FR-010, D9

- [ ] MINOR F12 — Facebook rows still sit in the "not built" video table, and one `note:` row cites a Reel test for a Page video fact
      where:  docs/feature-map.md:28, docs/feature-map.md:50, docs/feature-map.md:51, docs/limits.md:41
      why:    The "Already built" bullet now exists, but the "Facebook Page Reels" and "Facebook Page video" rows remain under "## Video (other platforms not built)", tagged "(Built, 021)". When Instagram's video was built (019), its rows were removed from that table. Separately, "note: page video limits" (limits.md:41) cites `reel-failures.test.ts` "a processing error fails with the causes", which is a Reel test. The relevant Page video test is `tests/integration/facebook/page-video.test.ts` "code 389 fails the target with the public-storage guidance".
      owed:   Drop the two Facebook rows from the not-built table, moving the line 51 unowned list into the 021 bullet, and re-point the citation at limits.md:41. Then re-run `tests/integration/docs/limits-inventory.test.ts`.
      traces: FR-023, FR-025

- [ ] MINOR F4 — Carried, unchanged. Removing an account (or a direct `cancelTarget` call) marks a Reel `cancelled` after finish was sent.
      where:  src/server/services/accounts.ts:419, src/server/services/posts/index.ts:601
      why:    `removeAccount` and `cancelTarget` accept a `publishing` target without a live lease. Between ticks, that includes a Reel in `check_publish`, for up to 60 minutes after finish. The target ends `cancelled` with its step state cleared while the Reel may be live. The UI offers Cancel only for scheduled and draft targets (src/components/targets/TargetResolution.tsx:130).
      owed:   A human decision: either refuse removal or cancel while an open target's derived step has `afterPublish`, or settle those targets `ambiguous`.
      traces: D9, SC-003

- [ ] MINOR F5 — Carried, unchanged. Some FR-029 and T029 test cases are thin. The code paths are shared and correct.
      where:  src/providers/facebook/publish.test.ts:323, src/providers/facebook/publish.test.ts:247, tests/integration/scheduler/after-publish.test.ts:141, tests/integration/compose/post-type-choice.test.ts:61
      why:    The gaps:
              - Finish refused with each listed Reel error: only 1363127 is asserted.
              - "Start without a video id": only a missing `upload_url` is tested.
              - US3-8: no Facebook-specific test of a worker killed during finish or a check.
              - "Emits the event once" asserts `advanceCalls`, not the event count.
              - Facebook keyboard and polite-announcement composer cases are missing.
              - The summary test does not pin the Reel duration, size, aspect or fps values.
      owed:   Add the cases when convenient.
      traces: FR-029, FR-030, US3-8, US4-2, US4-6

- NOTE F6 — The branch is still behind `origin/main`. `9e9ac5f` (activity history) also edits `src/server/scheduler/publishing.ts` and `src/server/scheduler/record.ts`. On main, the claim's `finish` helper now calls `eventForDecision`, so `refuse` will route through it after the merge. Main's classifier labels any claim-time `ambiguous` decision `target_ambiguous` with `engine: "recovered_ambiguous"` (`origin/main:src/server/services/activity/classify.ts:98–99`). G23's new account-unavailable and did-not-complete ambiguous outcomes would therefore read as "recovered" in Activity. When resolving the merge, decide whether to pass the engine reason through. Also check that the `ambiguous` + `credentialsInvalid` path writes the expected events.
- NOTE F7 — None of the implementation is committed, and `specs/021-facebook-video/tasks.md` and this file are untracked. Whoever commits must stage explicit paths, per the constitution.
- NOTE F13 — The remediation pass reported 6 failures in 3 files on its full-suite run. Re-run in isolation:
  - `tests/integration/api/endpoints/retry-failed-targets.test.ts` and `tests/integration/instagram/limits.test.ts` passed.
  - `tests/integration/failures/retry-all-cap.test.ts` timed out once in its 230-target seeding test, then passed 4/4 on a second run.
  None of the three touches code this feature changed. The failures look like load-sensitive timeouts, not a regression.
- NOTE F9 — Carried from the first review: checked and found correct.
  - `checkUploadUrl` rejects wrong hosts, http, ports, user info, query strings and mismatched ids before any fetch.
  - `ruploadRequest` puts the token only in `Authorization` and sends no body.
  - `check_publish` never returns `retryable_error`, and its only `fatal_error` is Facebook's `failed` classification.
  - The pacing gives at most 10 upload checks and 16 publish checks.
  - Old photo states still parse.
  - Instagram's generated limit rows are unchanged.
  Also confirmed this round: a post cannot be edited while any target is `publishing` (src/server/services/posts/index.ts:238), so D14's "media changed after upload" case cannot occur mid-Reel.

## Coverage

This round re-verified the obligations that the remediation touched. The rest carry over from the first review, whose files the remediation did not change.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-036) | 36 | 35 | 1 (FR-029, F5) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 7 | 0 | 0 | 1 (SC-008: typecheck gate fails, F10) |
| User stories (US1–US5) | 5 | 5 | 0 | 0 | 0 |
| Edge cases | 14 | 14 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Constitution quality gates (lint, typecheck, test, build) | 4 | 2 (lint 0 errors; targeted tests green) | 0 | 0 | 1 (typecheck, F10); build not run, expected to fail on the same errors |
| Earlier blocking findings (F1–F3) | 3 | 3 | 0 | 0 | 0 |

FR-010 is counted as satisfied. Its F11 residue needs credentials that decrypt but fail to parse on an active account, and no code writes those. FR-023 and FR-025 are satisfied, with the cosmetic residue in F12.

## What I could not check

- **Live Facebook** (T036, owed to the owner):
  - real Page video and Reel publishing;
  - the real `fields=status` reply nesting that `readReelStatus` guesses at;
  - whether `rupload.facebook.com` accepts a `file_url` header pointing at Docket's bucket;
  - whether Page videos surface as Reels;
  - whether a Page video processing failure can be read back.
  Everything remains "verified with mocks only".
- **Full gates.** Per the constitution, I did not run `pnpm test` (whole suite), `pnpm build` or `pnpm db:check`. I ran 108 targeted test files, `pnpm typecheck` (which failed, F10) and `pnpm lint`. `pnpm build` will need re-running after F10 is fixed. No full-suite result exists that includes the remediation and passed.
- **Composer in a browser.** The "Post as" keyboard use, focus and polite announcement for Facebook were not exercised (F5).
- **The merge with `origin/main`** (F6). Not attempted, because this phase may not write code.
