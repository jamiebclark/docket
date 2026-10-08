# Review: Per-target video formatter (024): re-review after remediation

Reviewed 127 file(s) changed against `69d858a...HEAD` plus the working tree, outside `specs/`: 83 modified and 44 new. HEAD adds only 2 commits (`docs(spec)`, `docs(plan)`). The implementation and its remediation are **uncommitted** in the working tree. So this review covers the working tree against the merge-base, not a commit range.

This is the **second review** of entry 024. The first review found F1 (BLOCKER) and F2–F4 (MAJOR), and the remediation pass ticked T063–T066. Under the constitution's rule ("Review is exhaustive once, then scoped"), this round checks two things: that each earlier finding is fixed, and that the files changed by the remediation introduced no regression. Anything else it noticed is recorded as MINOR for the hardening entry.

**Read in full or by full diff this round.**
- The remediation's files:
  - `src/providers/video-plan.ts`, `src/server/video/readback.ts`, `scripts/video-smoke.ts`;
  - `src/server/services/{review,generation/policy}.ts`;
  - `src/app/p/[projectSlug]/posts/[postId]/page.tsx`, `src/server/services/posts/{view,view.test}.ts`;
  - `tests/integration/compose/video-sync.test.ts`, and the new case in `tests/integration/video/formatter.test.ts`.
- To check for cross-pass fit, again:
  - worker: `src/server/video/{versions-loop,encode,ffmpeg-args,rescan,loop,process,clean}.ts`;
  - DAL: `src/server/dal/{video-versions,video-version-processing,video-housekeeping,scheduler,posts,media-processing}.ts`;
  - services: `src/server/services/{video-versions,video-previews,media-variants,media-fit,media}.ts` and `src/server/services/posts/{index,validate,compose,content,retry,retry-all,cancel}.ts`;
  - scheduler: `src/server/scheduler/{publishing,housekeeping}.ts`;
  - model and labels: `src/lib/video/edit.ts`, `src/server/media/item.ts`, `src/providers/{types,requirements,video-labels}.ts`;
  - UI: the four new compose components, `video-edit-ui.ts`, the diffs of `Composer.tsx` and `fit-ui.ts`;
  - the `0017` migration, the `ci.yml` diff, and the video blocks of the mock, Instagram and Facebook capabilities;
  - the move and swap paths in `src/server/services/queue/index.ts`.

**Sampled:** `src/providers/video-plan.test.ts`, `src/server/video/ffmpeg-args.test.ts`, the video block of `src/server/services/media-fit.test.ts`, and the 024 entries of `docs/decisions.md`.

**Not re-read:** `docs/{limits,feature-map,adding-a-provider,meta-setup,deployment}.md`, `tests/helpers/*`, the other ffmpeg-gated suites and `drizzle/meta/0017_snapshot.json`. Nothing in the remediation touched them, and the first review covered them.

**Probes run** (targeted, as the constitution allows a review):
- **10 test files** with `pnpm vitest run`: the planner, the argument builders, view, labels, hash, `video-sync`, `video-wait`, `video-previews`, `formatter` and `scripts/video-smoke.test.ts`. 10 files passed: 130 tests passed and 15 were skipped (the ffmpeg-gated cases; there is no ffmpeg here).
- **The suites the F4 change touches:** `tests/integration/review`, `tests/integration/generation`, `src/server/services/generation/policy.test.ts`, and `tests/integration/posts/{actions,list}.test.ts`. 20 files and 130 tests passed.
- **`pnpm typecheck`, once: passed.** I ran it because the remediation pass ended `interrupted` with no recorded outcome (`.pipeline/state.json`), `docs/decisions.md` predates it, and CI has not run on this branch. So nothing had type-checked the remediation's edits.
- **`eslint` on the 12 remediation files:** clean.
- **A throwaway pure-planner probe**, bundled into `$TMPDIR` and then deleted, gave the numbers in F12 and F14.
- **The working tree was unchanged** by these runs (`git status` diffed before and after).

## Verdict

**No blocking findings remain. From this review's side, the feature is ready to merge once CI's first ffmpeg run is green.**

- **The four earlier findings are fixed, each with a test** (table below):
  - a cut at a target's maximum now ends 100 ms inside it, and readback refuses anything over the maximum;
  - the `--formatter` smoke builds and times a real SC-007 preview;
  - "Preparing video for <platform>" is shown on the post page;
  - approving a post into the queue queues its versions.
- **The remediation introduced no regression I could find.** Typecheck, lint on the changed files and the affected suites all pass.
- **What remains is MINOR: 11 items (4 carried from the first review, 7 new) and 3 notes.**
- **Two deserve a look before merging:**
  - **F12.** F1's margin does not cover an untrimmed video that ends at the maximum. The window is narrow and the effect is computed, not measured. It now fails loudly and never publishes a wrong file.
  - **F15.** A storage outage when the worker starts can permanently mark every pre-entry video "could not read; upload it again". It is recorded as MINOR only because the constitution caps new findings in a re-review at MINOR; on a first review I would rate it MAJOR.
- **None of the ffmpeg suites, nor the docker smoke, has ever executed** (F11). CI's first run is their first run, and SC-007's figure is still owed (T061).

### Earlier findings, re-checked

| ID | Was | Now | Evidence |
|---|---|---|---|
| F1 | blocker | fixed (residual edge in F12) | The planner ends a cut at the maximum, or a trim near it, 100 ms inside (src/providers/video-plan.ts:73, src/providers/video-plan.ts:117–120). The recipe carries `maxDurationMs` (src/providers/video-plan.ts:287), and readback refuses an output over it (src/server/video/readback.ts:56–58). Tests: `keptMs 89 900` (src/providers/video-plan.test.ts:119, src/providers/video-plan.test.ts:205); `-t 89.900` and `29.900` (src/server/video/ffmpeg-args.test.ts:106, src/server/video/ffmpeg-args.test.ts:116); a 29.97 fps cut-at-maximum ffmpeg case (tests/integration/video/formatter.test.ts:149), never executed. Badge words still read "cut to 1:30", because `clockLabel` rounds (src/providers/video-labels.ts:57). |
| F2 | major | fixed (unexecuted) | The smoke generates a 30 s 1080×1920 clip **with audio** (scripts/video-smoke.ts:48–57), plans it for the mock with `planVideo` (scripts/video-smoke.ts:78–82), and makes a ≤ 640 px `previewRecipe` (scripts/video-smoke.ts:85–86). It then times `buildFile` with `preview: true`, reads the output back, and prints the figure (scripts/video-smoke.ts:88–93). Traced by reading: the plan is a rewrap (or an encode, if the bitrate is over 8 Mbps); the preview is 360×640 with audio; and every readback check passes. The optional pad, crop and trim builds of research P22 were not added. |
| F3 | major | fixed | The post page shows "Preparing video for <provider>…" beside the status badge (src/app/p/[projectSlug]/posts/[postId]/page.tsx:115), and the wording helper is tested (src/server/services/posts/view.ts:36, src/server/services/posts/view.test.ts). No other view shows a target's in-progress state (`inProgress` is rendered only at src/app/p/[projectSlug]/posts/[postId]/page.tsx:116), so nothing else was owed. |
| F4 | major | fixed | `approvePost` syncs after its transaction commits (src/server/services/review.ts:158–161), and `bulkApprove` goes through it (src/server/services/review.ts:261). `applyApprovalPolicy` does too (src/server/services/generation/policy.ts:127). The new approve-into-queue case passes (tests/integration/compose/video-sync.test.ts:95–104). |

## Findings

- [ ] MINOR F12 — F1's margin does not cover an untrimmed video that ends at (or just under) a target's maximum, so its encode ends exactly at the limit
      where:  src/providers/video-plan.ts:118, src/providers/video-plan.ts:120, src/server/video/readback.ts:56, src/providers/video-plan.ts:316, src/server/video/process.ts:85
      why:    `keptMs` gets the 100 ms margin only when `cutByMax`, or when the video is *trimmed* within the margin (video-plan.ts:120). An untrimmed video whose probed length is in (max − 100 ms, max] keeps `keptMs` equal to its whole length. Probed: an untrimmed 16:9 clip of 90.000 s for a Facebook Reel (it needs a pad) gives `keptMs 90000` with `maxDurationMs 90000`. If the re-encoded output comes out even 1 ms long, readback now refuses it (readback.ts:56). The likely cause is AAC end padding; this is computed, not measured, because the formatter's 29.97 fps case is silent. Each attempt is then a full encode, and after three the target fails with "The video could not be adapted for Facebook: The adapted video did not match what was planned.", which gives no hint that trimming 0.1 s fixes it. Instagram is the same at 900.0 s, and Docket's default upload ceiling accepts exactly that (process.ts:85). T063 asked for the margin "when a selection ends within that margin of it", and the default selection is the whole video. Two smaller points. The margin is a judgement against "exactly the maximum" (US1 AS1, US3 AS2) that is not in `docs/decisions.md`. And a trim that ends inside the margin is noted as "trimmed to a–b", but the version ends 100 ms before b (video-plan.ts:316).
      owed:   Whenever encoding with a finite maximum, use `keptMs = min(selectionMs, maxMs − margin)`. Add a planner case for an untrimmed video at exactly the maximum. Record the 100 ms margin in `docs/decisions.md`.
      traces: FR-008, FR-021, US1 AS1, T063

- [ ] MINOR F13 — The readback guard behind F1 has no test with a failing input
      where:  src/server/video/readback.ts:37, src/server/video/readback.ts:56, tests/integration/video/formatter.test.ts:149, tests/integration/video/formatter.test.ts:153
      why:    `checkOutput` is pure, but no unit test calls it (`grep checkOutput` finds only its definition). The new "over the maximum" branch, and every other mismatch branch, is exercised nowhere. The only test that touches it is a positive, ffmpeg-gated case that has never executed, and its fixture is silent (`-an`), so it cannot show the audio-padding path in F12. If the maximum check is removed, no test fails.
      owed:   Unit-test `checkOutput` with synthetic probe results: 1 ms over `maxDurationMs` is a mismatch, at the maximum is fine, a rewrap skips the check, and a preview applies it. Add an AAC fixture to the cut-at-maximum formatter case.
      traces: FR-021, FR-041 ("a read-back mismatch never published"), T063

- [ ] MINOR F15 — A short storage outage can permanently mark every pre-entry video unreadable, and a target already scheduled with one then publishes the original unchecked
      where:  src/server/dal/media-processing.ts:104, src/server/video/rescan.ts:30, src/server/video/rescan.ts:33, src/server/video/rescan.ts:55, src/server/video/loop.ts:134, src/server/video/loop.ts:138, src/server/media/item.ts:34, src/server/dal/scheduler.ts:185, src/server/services/media-variants.ts:325, src/server/services/posts/validate.ts:49
      why:    `claimRescan` counts an attempt (media-processing.ts:104). A missing object, or a thrown storage error, only gives the lease back and returns `true` (rescan.ts:33, rescan.ts:55). So the media loop never sleeps (loop.ts:134, loop.ts:138) and reclaims the same video at once. Suppose the bucket is unreachable when the worker starts: right after the upgrade's migration marks every existing video `facts_version = 1`, or while a bucket container is still starting. Then each pre-entry video burns its 3 attempts within moments. It becomes `factsUnreadable` (item.ts:34) and is refused everywhere with "upload it again". Nothing ever resets `facts_attempts`. For a target that was already scheduled, the gate sees `refuse`, which is not `derive` or `checking`, and returns `none` (scheduler.ts:185). `resolvePublishMedia` then passes the stored original through (media-variants.ts:325–326). The G15 re-check runs only the provider's validator on the old facts (validate.ts:49), not the planner as that comment claims. So a file whose index position and bitrates were never read can go out as is. Recorded as MINOR under the re-review rule; on a first review I would rate it MAJOR.
      owed:   Do not count a storage failure as a failed read, or back off before reclaiming. Have the gate fail a target whose plan is `refuse` (and correct the comment at media-variants.ts:325). Give operators a way to reset `facts_attempts`, or reset it when storage recovers.
      traces: FR-010, FR-014, Edge Cases ("Videos processed before this entry")

- [ ] MINOR F14 — Crop to the nearest end of a narrow aspect range can land just outside it, so the plan says "adapted" and the gate then refuses it
      where:  src/providers/video-plan.ts:148, src/providers/video-plan.ts:156, src/providers/video-plan.ts:161, src/providers/video-plan.ts:175, src/providers/validation.ts:94, src/providers/validation.ts:95, src/providers/instagram/capabilities.ts:66
      why:    Pad steps its canvas back inside the range after rounding (video-plan.ts:175–177); crop and its resize have no such step (video-plan.ts:148–164). Probed against Instagram's carousel item limits (0.8 to 1.91, at most 1,920 px wide, no recommended shape), with Crop:
        - 2560×1080 (21:9) becomes 1920×1004, a ratio of 1.9124;
        - 886×1920 (an iPhone screen recording) becomes 886×1108, a ratio of 0.7996.
      The validator's range check is strict to 1e-9 (validation.ts:94–95). So the scheduling gate refuses the planned item with an aspect message ("…allowed is 4:5 to 1.91:1") for a video the planner said it would adapt, which is the disagreement D8 rules out. It applies only to carousel items with Crop: the other declared ranges are wide or ±1%.
      owed:   After computing the crop (and after any resize), step one even pair back inside the range, as pad does, or round the cropped side toward the inside. Add planner cases for the two sources above.
      traces: FR-006, FR-020, D2, D8

- [ ] MINOR F16 — The edit dialog shows a video's length rounded up, so typing that length as the End is refused for about half of all videos
      where:  src/components/compose/video-edit-ui.ts:16, src/components/compose/video-edit-ui.ts:57, src/components/compose/VideoEditDialog.tsx:134
      why:    `lengthText` rounds to the nearest tenth. A 192,460 ms video shows "Length 3:12.5". Entering End "3:12.5" (192,500 ms) is refused with "The end must be inside the video (length 3:12.5).", which quotes the very value that was refused. This happens for any length whose remainder is 50 ms or more. "Whole video" or an empty End still work.
      owed:   Floor the shown length to the tenth (or accept an End within 100 ms past the length and normalise it to `null`), with a helper test.
      traces: FR-003, US3 AS4

- [ ] MINOR F17 — The preview panel says "Preparing preview…" for a render that nobody requested
      where:  src/components/compose/VideoTargetPreview.tsx:63, src/components/compose/VideoTargetPreview.tsx:149, src/components/compose/VideoTargetPreview.tsx:169
      why:    When `disabled` (a read-only composer, for example after publishing has started), the request never runs (VideoTargetPreview.tsx:63). A render in state `none` falls through to `role="status"` "Preparing preview…" (VideoTargetPreview.tsx:149, VideoTargetPreview.tsx:169), indefinitely. The same text shows for the moment before a first request returns, which is fine.
      owed:   Render `none` with nothing pending as "No preview yet" (or hide the Preview button) when the panel cannot request one.
      traces: FR-028, US4 AS1

- [ ] MINOR F18 — The planner's notes never name the post type in production
      where:  src/providers/video-plan.ts:90, src/providers/video-plan.test.ts:99, src/server/services/media-variants.ts:260, src/server/services/media-variants.ts:324, src/server/services/posts/compose.ts:122, src/server/services/video-versions.ts:40, src/server/services/media-fit.ts:59, src/server/dal/scheduler.ts:180
      why:    `typeLabel` is supplied only by the planner tests (video-plan.test.ts:99). Every production caller omits it, so the composer says "Video 1 will be cut to the first 1:30 for Facebook." and "Facebook needs at least 540×960." where the contract's notes table, D5's example and US1 say "for a Facebook Reel". The tests assert wording that production never produces.
      owed:   Pass the type label (from `postTypeLabel(caps, postType)`, as the provider validators do) at the user-facing callers: the gate's `adaptedMediaFor`, `checkComposition` and `fitOf`.
      traces: D5, contracts/video-planner.md "Notes", US1

- [ ] MINOR F5 (carried) — Moving or swapping a waiting target keeps its `video_wait_since`, so it can fail "took too long" the moment it is due again
      where:  src/server/services/queue/index.ts:330, src/server/services/queue/index.ts:176, src/server/services/queue/index.ts:177, src/server/scheduler/publishing.ts:184
      why:    Unchanged since the first review. `moveTargetToOccurrence` resets the attempt fields but not `videoWaitSince`. The swap at queue/index.ts:176–177 has the same gap. A target that waited an hour and was then moved carries the old `since`, fails at once if its version is still not ready when it is next due, and shows "Preparing video" while it sits in the future.
      owed:   Add `videoWaitSince: null` to both patches.
      traces: D11, FR-025

- [ ] MINOR F6 (carried) — With storage not configured in the worker, versions and previews never fail with "Media storage is not set up."
      where:  src/server/video/versions-loop.ts:22, src/server/video/versions-loop.ts:42
      why:    Unchanged. `NO_STORAGE` is unused, and `buildNext` returns before claiming, so rows stay `queued`: previews say "Preparing preview…" forever, and adapted targets fail after two hours with "took too long".
      owed:   Claim and fail the row with `NO_STORAGE`.
      traces: Edge Cases (storage not set up)

- [ ] MINOR F7 (carried) — An unknown audio sample rate or channel count is assumed to fit
      where:  src/providers/video-plan.ts:226, src/providers/video-plan.ts:227
      why:    Unchanged. `sampleHigh` and `channelsHigh` are false when the fact is `null` on a current video with audio.
      owed:   Re-encode when the target declares the limit and the fact is unknown.
      traces: FR-010

- [ ] MINOR F8 (carried) — The edit dialog hard-codes "9:16" as the recommended shape
      where:  src/components/compose/VideoEditDialog.tsx:196
      why:    Unchanged. This is a limit literal in UI code (plan, Constraints), and it becomes wrong when a provider declares another recommended shape.
      owed:   Use neutral wording, or derive it from the check response.
      traces: plan Constraints ("No limit literals in UI code")

- NOTE F9 (carried) — contracts/video-planner.md:50 gives "21:9 on mock → 16:9", but the mock declares `recommendedAspectRatio: 9/16` (src/providers/mock/index.ts:60), so the real mock reframes 21:9 to 9:16. The code follows D2; only the contract's example row is wrong.
- NOTE F10 (carried) — Previews are requested only while the panel is open (src/components/compose/VideoTargetPreview.tsx:62–70), as contracts/video-composer.md specifies. That is narrower than FR-029's "when an edit changes": an edit saved with the panel closed builds no preview until the panel is opened.
- NOTE F11 (carried) — None of the ffmpeg-gated suites (`ffmpeg-options`, `formatter`, `versions-loop`, `rescan`, `clean-faststart`, `video-publish-adapted`), nor `scripts/video-smoke.ts --formatter`, has ever executed. This machine has no ffmpeg, and the branch has not been pushed. The remediation's new 29.97 fps case (tests/integration/video/formatter.test.ts:149) is in the same position. CI's first run is their first run.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-046, FR-014a) | 47 | 40 | 7 (FR-003 F16, FR-006 F14, FR-010 F7/F15, FR-014 F15, FR-025 F5, FR-028 F17, FR-039 unexecuted) | 0 | 0 |
| Success criteria | 9 | 6 (SC-001, 002, 004, 005, 006 by reading, 008) | 2 (SC-003 ffmpeg suites unexecuted, SC-009 CI not yet run) | 1 (SC-007 not measured; T061) | 0 |
| User stories | 6 | 6 | 0 | 0 | 0 |
| Earlier findings F1–F4 | 4 | 4 fixed | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Engineering constraints (Neon/leases, bounded `runTick` with no call in a held transaction, UTC/DB clock, accessibility) | 4 | 4 | 0 | 0 | 0 |

How to read the partial rows:
- **Why partial items are MINOR.** Each partial FR is a MINOR finding. Four were carried at MINOR from the first review, and the constitution caps findings new to a re-review at MINOR. So a partial FR here does not block, which is why the counts differ from the first review's.
- **FR-008 and FR-021** count as satisfied: the 100 ms margin is what makes the strict limit hold, and F12 is a narrow, unmeasured residual.
- **FR-039** counts as partial, as before. The suites exist, but there is no evidence yet that they pass.

Regression check on the remediation's files:
- **The planner change** alters only `keptMs` and adds `maxDurationMs` to encode recipes. It reaches the version key (intended; no versions exist in production yet). It does not change badge words (`clockLabel` rounds 89.9 s to 1:30), the min-duration check or the size budget. A preview recipe inherits the maximum, which its readback also applies.
- **The new readback branch** is skipped for rewraps, which keep the source's length.
- **`approvePost`** syncs inside its per-post serialisation, after its transaction commits. `syncVideoVersions` never throws, so the serialisation chain is unaffected.
- **The post page change** only reads a field that already existed.

## What I could not check

- **Every ffmpeg-dependent behaviour** (F11): real crop, pad and trim output, rewrap stream identity, `+faststart`, the rescan, lease takeover with a real build, `USED_OPTIONS` against the installed help, and the `--formatter` smoke. Whether a re-encoded AAC output overshoots the source length (F12) is computed, not measured. There is no ffmpeg on this machine and no CI run on this branch.
- **SC-007's figure** (a two-core preview in ≤ 60 s): needs the docker job (T061, still blocked).
- **The composer in a browser:** keyboard-only use of the dialog and the focal-point picker (SC-006), live announcements, preview polling, and the new "Preparing video" line on the post page. Checked by reading and by the pure helper tests only.
- **Live platform acceptance of adapted files:** owed live checks T062 and FR-043. Mocks only.
- **FR-036's pull-request call-out** of the `.env.example` change: no PR exists yet. The docs call-out is present.
- **The full `pnpm test`, `pnpm lint`, `pnpm build` and `pnpm db:check` after remediation:** not re-run, per the constitution. The last full pass is the one recorded in `docs/decisions.md` ("024 — Implementation outcome"), before T063–T066. CI will run them on push.
