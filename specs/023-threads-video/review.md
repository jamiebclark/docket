# Review: Threads video (VIDEO posts and video carousel items)

Reviewed 29 implementation file(s): 17 modified and 12 new. They came from 0 implementation commits and 2 spec commits (`c73ea6f` spec, `0039f3d` plan), against `48bd040...HEAD` plus the working tree.

**Evidence note.** The implementation is **uncommitted**. HEAD carries only the spec and plan, so I reviewed `git diff 48bd040` (working tree) plus the untracked files. This matches how earlier entries landed: 019 was committed as one `feat` commit after its review (`47fed46`, `b8d2de8`).

**Read in full:**

- Source:
  - `src/providers/threads/{capabilities,validate,state,steps,publish,requests,video-errors}.ts`;
  - `src/providers/requirements.ts` and `src/providers/video-labels.ts` (the diffs, plus the `requirementsOf` body).
- Test helpers: `tests/helpers/limit-rows.ts` and `tests/helpers/threads-publish.ts` (diffs).
- Tests:
  - `src/providers/threads/{state,video-steps,video-publish,video-validate,video-errors}.test.ts`;
  - `tests/integration/threads/{video,video-carousel,video-failures,video-fit}.test.ts`;
  - `tests/integration/compose/threads-video-summary.test.ts`;
  - the diffs of `requirements.test.ts`, `video-labels.test.ts` and `tests/integration/meta/no-secrets.test.ts`.
- Docs: the diffs of `docs/{limits,feature-map,adding-a-provider,meta-setup,decisions}.md`.
- Spec artifacts: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `contracts/threads-publishing.md` and `contracts/threads-capabilities.md`.

**Read for context (unchanged code the feature relies on):**

- `src/providers/validation.ts`, `src/providers/post-type.ts` and `src/providers/threads/index.ts`;
- the step-content wiring in `src/server/scheduler/publishing.ts:100-125` and `:190-205`, and `src/server/dal/scheduler.ts:137-142`;
- `scrub` in `src/providers/meta/errors.ts:28`;
- `tests/integration/docs/limits-inventory.test.ts`;
- the Instagram and Facebook error readers.

**Sampled:** `research.md`, only the P12/P13 entries at `:154-160`.

**Not reviewed:**

- `quickstart.md` and `checklists/requirements.md`: they are planning aids, and they hold no obligations beyond spec and plan.
- `research.md` beyond P12/P13: its decisions are restated in plan, data-model and contracts.

**Ran here, synchronously, all green:**

- `pnpm vitest run src/providers/threads src/providers/requirements.test.ts src/providers/video-labels.test.ts src/providers/registry.test.ts src/providers/validation.test.ts`: 16 files, 217 tests.
- `pnpm vitest run tests/integration/threads tests/integration/compose/threads-video-summary.test.ts tests/integration/meta/no-secrets.test.ts tests/integration/limits tests/integration/docs`: 25 files, 396 tests, against real Postgres.
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors, and no warnings in any file this feature touches.

## Verdict

**Yes: the feature satisfies the spec and hangs together. Nothing blocks the merge.**

- **Single `VIDEO` posts and mixed or all-video carousels** run on the existing step machine.
  - The step function (`steps.ts`), the request builders and the publish branch agree on one `ThreadsPlan` derived from `media[].kind`. The engine passes `kinds` through, so the step the engine leases and the step `advanceThreads` recomputes cannot drift (`publish.ts:77-83`).
  - Video items are read before the parent (`steps.ts:43-44`, `publish.ts:162-215`).
  - The video pace and 60-minute ceiling are applied in exactly the three places D6 names: a single video, an item, and a parent with video (`publish.ts:197-204`, `:239-249`).
  - `ERROR` messages are explained per code (`video-errors.ts`).
  - The 23-hour guard takes the oldest container (`publish.ts:267-271`).
- **The image and text paths are unchanged.** The existing Threads suites pass untouched.
- **Old state still parses.** `v: 1` state from before this entry parses (`state.test.ts`).
- **Each requirement has a test that exercises it.** The integration tests drive `runTick` against the DB clock with exact request assertions, rather than echoing the implementation back.

I found four MINOR defects:

- two dead or half-wired pieces between passes (F1, F3);
- one sanitising step the plan and `docs/decisions.md` promise but the code skips (F2);
- one small FR-014 gap on `EXPIRED` reads (F4).

All four are safe to ship and can be fixed later. One spec acceptance scenario (US2 #5: 20 items end to end) is met only at provider level, by a deliberate, recorded plan decision (F5). Recommendation: merge once CI's full `pnpm test` and `pnpm build` are green, and pick up F1–F4 as follow-ups.

## Findings

- [ ] MINOR F1 — Four request builders in `requests.ts` are never called; `publish.ts` still builds those requests inline.
      where:  src/providers/threads/requests.ts:24, src/providers/threads/requests.ts:33, src/providers/threads/requests.ts:37, src/providers/threads/requests.ts:41; src/providers/threads/publish.ts:99-102, src/providers/threads/publish.ts:107-109, src/providers/threads/publish.ts:119-124, src/providers/threads/publish.ts:298
      why:    T013 (ticked) says the image, text, parent and publish builders live in `requests.ts` "byte-for-byte as today" (P7). But `publish.ts:22` imports only `itemParams`, `readStatus`, `STATUS_FIELDS` and `videoContainerParams`. `imageContainerParams`, `textContainerParams`, `carouselParams` and `publishParams` have no caller and no test anywhere in `src/` or `tests/`. So each of those four requests now exists twice. The copies agree today, so nothing misbehaves. But someone who later edits `carouselParams`, believing it is the live path, changes nothing that is sent.
      owed:   route `create_container` (image and text), `create_carousel` and `publish` in `publish.ts` through the builders, or delete the four unused exports.
      traces: P7, T013

- [ ] MINOR F2 — `readStatus` neither strips control characters nor caps `error_message` at 300 characters, although P12 specifies it and `docs/decisions.md` says it does.
      where:  src/providers/threads/requests.ts:44-50; docs/decisions.md:1000; specs/023-threads-video/research.md:156; compare src/providers/instagram/publish.ts:51 and src/providers/facebook/requests.ts:73
      why:    `error_message` is third-party text. `readStatus` passes it through `scrub` alone, which removes the token and cuts at 500 characters (`src/providers/meta/errors.ts:28-33`) but keeps control characters. The text then goes verbatim into `lastError` through `videoErrorText` (`src/providers/threads/video-errors.ts:59`) and into the attempt summary. Nothing downstream in `src/server/scheduler` cleans it. Example: a 450-character Threads message with embedded newlines reaches the failure banner and the attempt log as is. Instagram and Facebook both strip control characters and cap at 300. The token is still removed, so FR-012/FR-017 hold and this is not a leak. The defect is the inconsistency, plus a decisions entry that describes behaviour that does not exist.
      owed:   in `readStatus`, before `scrub`, apply Instagram's `replace(/[\u0000-\u001f\u007f]+/g, "")`, then `.trim().slice(0, 300)`. Add a `readStatus` unit test with a newline and a 400-character message.
      traces: FR-014, P12

- [ ] MINOR F3 — `VIDEO_FIRST_CHECK_DELAY_MS` controls only carousel items; a single video and a video carousel parent use the image and text constant.
      where:  src/providers/threads/state.ts:31-33; src/providers/threads/publish.ts:156 (vs src/providers/threads/publish.ts:149 and src/providers/threads/publish.ts:192)
      why:    The comment at `state.ts:31` and data-model §2 define this constant as the first read of "a video container or carousel item". But both `create_container` (for `VIDEO`) and `create_carousel` set `notBefore` from `FIRST_CHECK_DELAY_MS`, the image and text constant. Both are 30 s today, so nothing differs. But D6's stated reversal is "one ceiling value and one cadence function". Tuning the video first read would move item reads only, and would silently miss single videos and parents.
      owed:   at `publish.ts:156`, use `isVideo ? VIDEO_FIRST_CHECK_DELAY_MS : FIRST_CHECK_DELAY_MS`.
      traces: D6, FR-011

- [ ] MINOR F4 — The attempt summary for an `EXPIRED` status read carries no container id and no error message.
      where:  src/providers/threads/publish.ts:66, src/providers/threads/publish.ts:208-209, src/providers/threads/publish.ts:256-257
      why:    FR-014 says every status read records the container id, the status and any error message. The other branches meet this. The `EXPIRED` branches return `recreate(state, plan, "EXPIRED")`, whose summary is only `{ response: { statusCode, recreations } }`. That drops the `containerId`, `itemIndex` and `itemKind` request fields, and the `errorMessage` the other branches carry. The image `check_status` path did the same before 023, and the new `check_item_<k>` path copied it. So in a carousel's attempt log, nothing shows which item expired.
      owed:   let `recreate` take the read's summary (or its request part and `errorMessage`) from the two status-read callers. Keep the `AGED` call as it is.
      traces: FR-014

- NOTE F5 — US2 #5 ("a carousel of 20 items mixing images and videos … succeeds") and FR-002's 20-item total hold only at provider level.
  - `POST_MEDIA_MAX = 10` (`src/lib/validation/scheduling.ts:36`) refuses an 11th item for every provider before Threads is reached.
  - The plan recorded this as P5, and it is disclosed at `docs/decisions.md:996` and `docs/feature-map.md:27-31`.
  - 20 items are proved in `src/providers/threads/video-publish.test.ts:197` (`children` order) and `src/providers/threads/video-validate.test.ts:72` (20 accepted, 21 refused).
  - Raising the cap is a cross-provider product change with no owner, not a defect in this entry. A human merging this should know the scenario is not met end to end.

- NOTE F6 — The gigabyte label fix (P3) is not quite "inert for every provider", as `docs/decisions.md:983` says.
  - `src/providers/validation.ts:60` labels the video's own size with `videoBytesLabel` as well as the limit.
  - So an Instagram video between 1 GB and Docket's 1,024 MiB upload cap now reads "Video 1 is 1.05 GB; the limit is 300 MB" instead of "… 1050 MB …".
  - The wording is better and no test pins the old text, so this is not a defect. But it is a visible text change on Instagram, which FR-029 otherwise leaves alone.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-031) | 31 | 29 | 2 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 7 | 1 | 0 | 0 |
| Acceptance scenarios (US1 7, US2 6, US3 8, US4 7) | 28 | 27 | 1 | 0 | 0 |
| Edge cases (spec §Edge Cases) | 15 | 15 | 0 | 0 | 0 |
| Plan touch-points (7 edited and 2 new source files, test helpers, 5 docs) | 16 | 16 | 0 | 0 | 0 |
| Constitution (I–VII, Engineering constraints, Workflow) | 9 | 9 | 0 | 0 | 0 |

**Edge cases satisfied by inheritance:** two of the 15 need no code of their own here. A rotated phone video uses entry 2's displayed-frame facts. A post created through the API or the generator goes through the shared `resolvePostType`, which gives `video` with no choice. In both cases no Threads-specific code was needed, and I did not test them separately.

**Partial items:**

- **FR-002**: the 20-item total is not reachable through Docket (F5, recorded as P5).
- **FR-014**: `EXPIRED` reads drop the container id (F4).
- **US2 #5**: the same cause as FR-002 (F5).
- **SC-008**: counted partial only because I did not re-run the full `pnpm test` or `pnpm build` (see below). Every Threads, limits, docs and no-secrets suite passes, and lint and typecheck are clean. Under P19, no existing Threads, Instagram, Facebook or Bluesky test file changed. The exception is `src/providers/requirements.test.ts:252`, whose "unchanged providers" loop rightly drops `threads` now that Threads declares per-type limits; the Threads summary is pinned by the new case at `:101`.

**Constitution:**

- **II.** Real publishing is reported as "verified with mocks only" (`docs/meta-setup.md` "Threads video: owed live checks").
- **VII.** The token stays out of every result and log: `video-publish.test.ts` "never leaks", and the `no-secrets.test.ts` extension covers a single video and a carousel item.
- **V.** No engine, schema, composer or contract-member change. The generic edits are limited to P2, P3 and P6.

**Items I traced end to end:**

- the request shapes and absent keys (FR-007, FR-009);
- the reads at 30, 90 and 150 s (`video.test.ts`);
- 0 parent requests and 0 image reads while a video item is unready (SC-006, `video-carousel.test.ts`);
- at most 17 reads and the 5-minute pace after 5 minutes (SC-005). I also did the arithmetic: reads at 30, 90, 150, 210, 270, 330, then every 300 s to 3,630 s gives exactly 17;
- the whole-token, case-sensitive code matching, including `INVALID_ASPEC_RATIO`;
- the changed-post restart through `validState` (D10);
- `too_many_items` only for mixed posts over 20.

## What I could not check

- **The full `pnpm test` and `pnpm build`.** I did not re-run them, per the constitution's "run checks in proportion" rule. T035 records a full run of 3,905 passed and 4 failed under load. On a quiet re-run only `failures/retry-all-cap` failed, a DB-timing suite outside this feature. CI must confirm both, plus the Docker image build and commitlint once the work is committed.
- **Live Threads behaviour (T036, owed by the operator).** Five checks need a connected Threads tester account, the public bucket and the network: a single video; a mixed carousel; whether items must finish before the parent (D5); real processing time against the 60-minute ceiling (D6); and the exact `error_message` form, which `videoErrorExplanation` assumes contains the bare code (P13). All three UNVERIFIED research facts are covered by mocks only.
- **The UI in a browser.** I did not see the composer summary or the media-library badge rendered. They are checked through `checkComposition` and `fitOf` service-level tests only. No UI component changed.
- **Whether Threads accepts the stored, non-re-encoded originals.** Bitrate, GOP, moov placement and the other limits Docket does not probe (FR-005) can only be checked live.
- **The commit history.** The implementation is uncommitted, so no conventional-commit messages or per-task commits exist yet to check against the Workflow rule.
