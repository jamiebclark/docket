# Review: Instagram video (Reels, Feed video, mixed carousels)

**Re-review after remediation (round 2).** Per the constitution's rule "review is exhaustive once, then scoped", this pass checks
only two things: that each finding from the first review is fixed, and that the files the remediation changed introduced no
regression. It opens no new lines of inquiry. The first review's full sweep (69 non-spec files, every FR and SC, every mandatory
category) stands, and its coverage is carried forward below with the remediated items updated.

Reviewed 4 file(s) changed by the remediation pass (Phase 9, T053–T054), across 0 new commits, against `078bda9` (the merge-base
with `origin/main`). The branch still has only the spec (`94d2f47`) and plan (`74e27c4`) commits; **the whole implementation,
remediation included, is uncommitted** in the working tree. So this pass reviewed the present state of the working tree, not a
`078bda9...HEAD` diff, and identified the remediation's files by modification time: every file newer than the first `review.md`.

- **Read in full:** `docs/limits.md` (the Instagram table, `:28`–`:66`) and the `git diff 078bda9` of `docs/feature-map.md`; the new
  cases and changed imports of `tests/integration/instagram/reels.test.ts` (`:1`–`:60` and `:160`–`:203`) and of
  `tests/integration/instagram/video-carousel.test.ts` (`:1`–`:62` and `:140`–`:184`).
- **Read to verify a finding:**
  - `src/server/scheduler/publishing.ts:119`–`:182` (the order of the publish-limit deferral and the allowance reservation);
  - `src/providers/instagram/steps.ts:54`–`:65` (which steps carry an allowance; `publish` has `mayPublish: true`);
  - `tests/integration/scheduler/allowance.test.ts:55`–`:80`, `tests/integration/instagram/outcomes.test.ts:131` and
    `tests/integration/docs/limits-inventory.test.ts:138`, `:162`;
  - `contracts/video-capabilities.md:101`–`:102`;
  - the cited lines of the four open MINORs, F3–F6;
  - the remediation pass's own report, in `.pipeline/implement.result.json`.
- **Not reviewed:** every file the remediation did not touch. Their modification times show no production code changed after the
  first review (`src/` is untouched), so the first review's reading of them still applies.

**What was run** (targeted only, as the constitution asks of review):

- **The remediated suites and the docs gate.** `pnpm vitest run tests/integration/instagram tests/integration/docs
  tests/integration/scheduler/allowance.test.ts`: 19 files and 186 tests, of which 184 pass. Both failures are in
  `tests/integration/instagram/limits.test.ts`, a pre-019 image suite. It is one of the six that must stay byte-for-byte unchanged,
  and it still is. Both failures are machine load, not defects:
  - **The first failure.** "never sends a 51st publish for 150 queued targets…" timed out at its 20 s limit. Re-run alone with
    `--testTimeout=180000`, it passes in 21.1 s, at a load average of about 115 from other sessions on this machine.
  - **The second failure.** "an account-level override stricter than the default still applies" saw 1 publish instead of 2. That
    is fallout from the first test, whose timed-out ticks keep running. Run alone, it passes in 3.4 s.
- **Lint.** `pnpm exec eslint` on the two remediated test files reports nothing.
- **Six untouched suites.** `git diff --stat 078bda9` is empty for the six Instagram suites that must stay unchanged (SC-008).

## Verdict

**Both blocking findings from the first review are fixed, and the remediation introduced no regression. Nothing blocks the merge.**

- **F1 is fixed.** `docs/limits.md` now has the two note rows that FR-029 and the contract require, and `docs/feature-map.md` no
  longer lists Instagram video as unbuilt.
- **F2 is fixed.** The carousel-container `ERROR` with a video, and kill-mid-flight recovery on a Reel `create_container` and a
  carousel `check_item_2`, now have real end-to-end tests through `runTick`. They pass.
- **One owed clause was intentionally not followed, correctly.** The first review asked for the `check_item` recovery to charge
  `retryUnits`. The remediation asserts that it charges nothing, because a check step creates no container. The code and the
  contract agree with the remediation, not with the original wording.
- **What remains.** The four MINORs (F3–F6) are unchanged and still open; they are safe to ship and belong to a hardening entry.
  The NOTEs carry forward.
- **Before a human merges:** commit the implementation in small explicit-path commits, without the stray `tasks.md-E` (F10). Then
  let CI confirm the full suite and the build, which no review pass has seen green.

## Findings

- [x] MAJOR F1 — The FR-029 and FR-030 documentation moves are only half done. **Resolved by T053.**
      where:  docs/limits.md:65, docs/limits.md:66, docs/feature-map.md:16, docs/feature-map.md:46, docs/feature-map.md:71
      why (original): `docs/limits.md` lacked the `note: video processing ceiling` and `note: share to feed` rows, and
              `docs/feature-map.md` still listed Instagram Reels and feed video / mixed carousels as unbuilt.
      verified:
        - **The note rows.** `docs/limits.md:65` adds `note: video processing ceiling | 60 min` (D9; 5 min is guidance), and `:66`
          adds `note: share to feed`. Both match `contracts/video-capabilities.md:101`–`:102`. Each row cites a test name that
          exists verbatim: `tests/integration/instagram/reels.test.ts:83` and `:169`.
        - **The inventory test.** `limits-inventory.test.ts:138` and `:162` skip `note:` rows by design, so the rows add no false
          enforcement claim. The docs suite passes.
        - **The not-built table.** The two Instagram rows are gone from the table at `docs/feature-map.md:44`–`:50`.
        - **The 018 sentence.** `docs/feature-map.md:16` now reads "Instagram publishes video as of 019; no other provider does
          yet".
        - **The suggested order.** `docs/feature-map.md:71` marks item 2 "(built in 019)".
      traces: FR-029, FR-030

- [x] MAJOR F2 — FR-032's required step-machine cases were partly untested, and T035 claimed a restart test that did not exist.
      **Resolved by T054.**
      where:  tests/integration/instagram/video-carousel.test.ts:154, tests/integration/instagram/video-carousel.test.ts:168,
              tests/integration/instagram/reels.test.ts:188
      why (original): the carousel-container `ERROR` branch (`src/providers/instagram/publish.ts:248`) and kill-mid-flight
              recovery on a video step had no tests.
      verified:
        - **Carousel ERROR.** `video-carousel.test.ts:154` drives image, video, image to a carousel container `ERROR`. It asserts
          the message "Instagram could not process the carousel: Error: bad item", `"statusDetail":"Error: bad item"` in the
          attempts, and zero publishes.
        - **Kill on a Reel `create_container`.** `reels.test.ts:188` writes an expired lease with `inFlightStep: "create_container"`
          and `inFlightMayPublish: false`. It then asserts `recovered: 1, ambiguous: 0`, one create, one publish and allowance
          rows `[1]`.
          - For a single video the whole need is also 1, so this assertion alone cannot tell `units` from `retryUnits`.
          - That distinction is pinned engine-side, by `tests/integration/scheduler/allowance.test.ts:69`: the provider declares
            `units: 5, retryUnits: 1`, and the recovery reserves `[1]`.
        - **Kill on a carousel `check_item_2`.** `video-carousel.test.ts:168` kills the step after the three item creates. It
          asserts recovery, one publish and allowance rows `[4]`: one reservation up front, and nothing for the retried check.
          - This contradicts the first review's owed wording, which asked for a `retryUnits` charge, but it is correct.
          - Only create steps carry an `allowance` (`src/providers/instagram/steps.ts:54`, `:60`), and a check creates no
            container.
        - **Kill on `publish`.** The owed "a publish killed mid-flight still settling as ambiguous" has no video-specific case.
          It is covered structurally:
          - video and images share one `publish` step, with `mayPublish: true` (`src/providers/instagram/steps.ts:65`);
          - the engine decides ambiguity from the stored `inFlightMayPublish`, which `tests/integration/instagram/outcomes.test.ts:131`
            already pins for Instagram.
        - **No assertions weakened.** The pre-existing cases moved by exactly the 4 added import lines (`externalUrl: null` from
          `:74` to `:78`; the switch case from `:165` to `:169`). That is consistent with only additions.
        - **Passing.** Both files pass and lint clean.
      traces: FR-032, SC-003, T035

- [ ] MINOR F3 — The "Post as" radio shows the server's last answer, not the person's click. **Still open, unchanged.**
      where:  src/app/p/[projectSlug]/compose/Composer.tsx:379, src/app/p/[projectSlug]/compose/Composer.tsx:381
      why:    `checked` is driven by `t.postTypeChoice!.selected`, while `onChange` writes `postTypes[accountId]`. So the
              radio snaps back until the debounced check returns. After a failed check (`fetchCheck` returns `null`), it keeps
              showing Feed video while Save sends `reel`.
      owed:   drive `checked` from `postTypes[accountId] ?? t.postTypeChoice.selected`.
      traces: FR-007, US2-6, SC-007

- [ ] MINOR F4 — The radios sit inside the preview's polite live region, against the contract. **Still open, unchanged.**
      where:  src/app/p/[projectSlug]/compose/Composer.tsx:339, src/app/p/[projectSlug]/compose/Composer.tsx:371
      why:    the fieldset renders inside `<div aria-live="polite">`. `contracts/post-type-choice.md:103` says the card's live
              region does not repeat the radios, and the new "Showing requirements for …" line nests one polite region in
              another.
      owed:   render the fieldset outside the live container, or mark the card body `aria-live="off"`.
      traces: US2-6, constitution (accessibility constraint)

- [ ] MINOR F5 — Allowance pruning loops until the backlog is gone, breaking housekeeping's one-batch rule. **Still open, unchanged.**
      where:  src/server/scheduler/housekeeping.ts:54, src/server/scheduler/housekeeping.ts:61
      why:    `pruneAllowanceUses` runs `for (;;)` until a short batch, while `runHousekeeping` promises "at most one batch per
              table".
      owed:   delete one batch per tick.
      traces: constitution (runTick bounded), contracts/creation-allowance.md §4

- [ ] MINOR F6 — The six `PostType` values are hand-copied in three places. **Still open, unchanged.**
      where:  src/providers/media.ts:49, src/lib/validation/scheduling.ts:41, src/server/db/schema/posts.ts:195
      why:    `POST_TYPE_KEYS`, `POST_TYPES` and the `post_targets_chosen_post_type_known` CHECK each list the values by hand,
              and nothing ties them to the `PostType` union.
      owed:   one exported constant typed against `PostType`, used by both TypeScript sites, plus a test comparing the SQL CHECK
              with it.
      traces: constitution IV, cross-pass duplication

- NOTE F7 — Carried forward. Feed video and Reel targets end with `externalUrl: null`, because `media_publish` returns an id only
  (`tests/integration/instagram/reels.test.ts:78`). That is parity with images, as FR-004 asks; a permalink read would be a
  separate decision.

- NOTE F8 — Carried forward. A release before Instagram is called keeps `attemptCount` (`src/server/scheduler/publishing.ts:290`),
  so the next lease reserves the whole need again (`publishing.ts:181`). This is accepted over-counting under
  `contracts/creation-allowance.md` §5.
  - Also checked in this pass: targets held by the publish limit reserve nothing. The deferral at `publishing.ts:121`–`:131`
    returns before the allowance block at `:160`–`:181`.

- NOTE F9 — Carried forward. The allowance is counted per Docket account row (`src/server/dal/scheduler.ts:149`), not per
  Instagram account. That is the right trade-off under constitution III, but `docs/limits.md` does not spell it out.

- NOTE F10 — Carried forward, still true. The implementation (T002–T054) is uncommitted, against the workflow rule "commit after
  each completed task". The stray `specs/019-instagram-video/tasks.md-E` (a `sed -i -E` backup, with T030–T040 unticked) is
  still present and must not be committed.

- NOTE F11 — Carried forward. FR-009's "create and update operations": there is no public post update operation (P7), so only
  `createPost` gained `postTypes`. The gap is recorded as unowned at `docs/feature-map.md:22`.

- NOTE F12 — Noticed in this pass; this is not a 019 defect. `tests/integration/instagram/limits.test.ts:68` (150 image targets)
  ran in 21.1 s against its 20 s timeout, at a load average of about 115.
  - 019 adds one allowance range query and one insert per Instagram create-step claim (`publishing.ts:164`, `:181`), so the
    suite may be a little slower than on `main`.
  - This pass did not measure `main` for comparison. If CI flakes on this test, that is the first place to look.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-038) | 38 | 38 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 8 | 0 | 0 | 0 |
| User-story acceptance scenarios (US1–US5) | 27 | 27 | 0 | 0 | 0 |
| Edge cases | 14 | 14 | 0 | 0 | 0 |
| Spec decisions D1–D13 and generic hooks G19–G22 | 17 | 17 | 0 | 0 | 0 |
| Constitution (I–VII, engineering constraints, workflow) | 9 | 8 | 1 | 0 | 0 |
| First-review blocking findings re-checked (F1, F2) | 2 | 2 fixed | 0 | 0 | 0 |
| First-review MINORs re-checked (F3–F6) | 4 | 0 fixed | — | — | — |

**Notes on the counts:**

- **What changed since the first review.** FR-029 and FR-030 (F1) and FR-032 (F2) moved from partial to satisfied. Every other
  row is carried forward from the first review's exhaustive sweep, unchanged, because no production code changed in between.
- **Deviations counted as satisfied**, as before, because each is recorded in `docs/decisions.md`: FR-017 (P16), FR-009 (P7,
  F11) and FR-004 (F7).
- **Constitution partial.** This is the workflow rule (F10). It has no MUST, so it is a NOTE and does not block.
- **The four MINORs** do not block, and none was in the remediation's scope.

## What I could not check

- **Live Instagram (T052).** Four things need the operator's Business account (`docs/meta-setup.md` "Instagram video: owed live
  checks"): whether a carousel video item is accepted with `media_type` omitted (D8); whether a Reel shows only in the Reels tab;
  whether a Feed video shows in the grid; and whether Instagram fetches a 200–300 MB file by `video_url`. Until then, Instagram
  video is verified with mocks only.
- **A green full `pnpm test` and `pnpm build`.** Neither review pass has seen them green:
  - The first review stopped its full run partway (load timeouts that passed on re-run).
  - The remediation pass ran only the Instagram and docs suites and `tsc`.
  - Implement's T051 record is the only claim that the full gate passed, and it predates the remediation. CI on the PR should
    confirm it.
- **Whether `limits.test.ts`'s 21 s is a timing regression against `main` (F12).** I did not run `main` for comparison.
- **A byte-level diff of the two remediated test files** against their pre-remediation versions. Both files are untracked, so git
  has no earlier version. The evidence that no assertion was weakened is indirect: the case list, the exact 4-line offset of the
  pre-existing cases, and the remediation pass's own report.
- **The composer in a real browser and screen reader** (F3, F4). Only `renderToStaticMarkup` assertions exist.
- **Behaviour at production scale.** The allowance query's cost inside the claim transaction, and the prune batch size (F5).
- **The generated `drizzle/meta/0012_snapshot.json`**, which `pnpm db:check` vouches for.
