---

description: "Task list for Facebook Page video (Page video posts and Reels)"
---

# Tasks: Facebook Page video

**Input**: Design documents from `/specs/021-facebook-video/`

**Prerequisites**: plan.md, spec.md, research.md (P1–P22), data-model.md (§1–§6), contracts/ (`after-publish-steps.md`, `facebook-capabilities.md`, `facebook-publishing.md`), quickstart.md

**Tests**: Required. The spec (FR-029, FR-030) and constitution II demand an automated test for every behaviour, with mocked Graph and rupload (`tests/helpers/fake-graph.ts`) and the pinned DB clock (`atTime`). No test makes a live call.

**Execution environment**: Implementation is headless. Every check below is a Vitest run, `tsc`, lint or build. Nothing needs a browser or the network. Live Facebook checks are the one human-owned task (T036).

**Organization**: Tasks are grouped by user story. Foundational work (the generic engine change G23, the generic summary fix, and shared Facebook request/state modules) comes first because all stories depend on it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- Run `pnpm vitest run <paths>` for targeted checks; the full `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` pass happens once, in the final phase.

## Path Conventions

Single Next.js app. Provider code in `src/providers/`, scheduler in `src/server/scheduler/`, tests in `tests/` and beside sources as `*.test.ts`. No migration, no UI/component change.

---

## Phase 1: Setup

**Purpose**: Confirm the baseline before changing anything.

- [X] T001 Run `pnpm vitest run src/providers/facebook src/providers/meta src/providers/requirements.test.ts src/server/scheduler tests/integration/facebook tests/integration/scheduler tests/integration/meta` and record that it passes on the untouched branch (baseline for SC-008). No file change.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Generic engine change G23, the generic summary-notes fix, Meta rupload helper, and the Facebook state/request modules. MUST complete before any story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### G23 — steps after publishing (contracts/after-publish-steps.md, data-model §1)

- [X] T002 Add `StepInfo.afterPublish?: true` and `credentialsInvalid?: true` on the `ambiguous` `StepResult` member in `src/providers/types.ts` (data-model §1). Both optional; keep `advance`'s five result kinds.
- [X] T003 [P] Add the optional `afterPublish` input to `applyStepResult` in `src/server/scheduler/record.ts`: a `retryable_error` reaching `maxAttempts` records `status: "ambiguous"`, outcome `"ambiguous"` with " The post may already be live; check before retrying." appended; below max still retries; `fatal_error` still fails. Extend `src/server/scheduler/record.test.ts` with those three cases.
- [X] T004 [P] Add `opts.afterPublish` to `recoverExpiredLease` in `src/server/scheduler/recovery.ts`: at `maxAttempts` settle `ambiguous` with "Publishing was interrupted too many times after the post was sent; check before retrying." instead of failed. Add/extend `src/server/scheduler/recovery.test.ts` with and without the option at max.
- [X] T005 In `src/server/scheduler/publishing.ts` implement the engine rule (depends on T002–T004): (a) store `afterPublish: info.afterPublish === true` on the in-memory lease at claim; (b) in the `execute` catch, `MediaUnavailable`, `CredentialsUnreadable` and `SettingsInvalid` become `ambiguous` when `lease.afterPublish`, else `fatal_error` as today (`PostGone` unchanged); (c) pass `afterPublish` into `applyStepResult`; (d) compute `credentialsInvalidReason` for `fatal_error` **or** `ambiguous` with `credentialsInvalid`, set `lastError` to `<provider error> Reconnect <displayName> to publish again.` for ambiguous, and call `markInvalidEmitting(repos, account.id, { expectedCiphertext, reason })` once; (e) in the claim's recovery branch, only when recovery would settle `failed`, derive the step (settings parse, `ctx.contentShape(target)`, `provider.stepFor`) and, if it has `afterPublish`, call recovery again with `{ afterPublish: true }`; a throw or no shape keeps `failed`.
- [X] T006 Write `tests/integration/scheduler/after-publish.test.ts` with a test provider whose step 2 has `afterPublish`: media deleted after step 1 → ambiguous; 8 provider timeouts → ambiguous; 8 stale leases → ambiguous; a provider `fatal_error` → failed; ambiguous with `credentialsInvalid` flags the account `needs_reauth`, emits the event once, keeps the target ambiguous. Run it plus `pnpm vitest run tests/integration/scheduler tests/integration/meta/engine-unchanged.test.ts` (existing suites must stay green).
- [X] T007 [P] Document G23 (`afterPublish`, `ambiguous.credentialsInvalid`, the engine rule) in `docs/adding-a-provider.md` so `tests/integration/docs/provider-guide.test.ts` passes; run that test.

### Generic summary notes (data-model §5, research P3)

- [X] T008 [P] In `src/providers/requirements.ts` make `video.notes` come from `byPostType[shown].notes` for any shown type, not only `carousel`. Extend `src/providers/requirements.test.ts`: notes shown for a non-carousel type, and one Instagram summary per type pinned unchanged.

### Shared Meta + Facebook modules (data-model §3–§4)

- [X] T009 [P] Add `MetaApp.uploadHost` (optional, default `rupload.facebook.com`) and `ruploadRequest({ url, token, headers, signal })` beside `graphRequest` in `src/providers/meta/graph.ts`, reusing `send`: header-only POST, `Authorization: OAuth <token>`, no body, same outcome mapping. Extend `src/providers/meta/graph.test.ts` (headers, no body, token only in `Authorization`, outcome mapping).
- [X] T010 [P] Extend `tests/helpers/fake-graph.ts` to record `headers` (with `authorization` redacted) and `bodyBytes` on each captured request, and to answer `rupload.facebook.com` URLs (research P21). Keep existing suites passing.
- [X] T011 Replace `facebookStateSchema` in `src/providers/facebook/settings.ts` with the `photo | reel` union (data-model §3); the v1 photo shape must still parse.
- [X] T012 [P] Create `src/providers/facebook/state.ts`: pace constants (1 min < 5 min age, 5 min after; ceilings 30 min upload, 60 min publish), `checkDelayMs(age)`, and `validReelState` (invariants from data-model §3). Create `src/providers/facebook/state.test.ts` (old photo state parses, invariants, union, `checkDelayMs` schedule 1,2,3,4,5,10,…).
- [X] T013 [P] Create `src/providers/facebook/requests.ts` (pure): param builders for Page video, `start`, `finish`, status read; `checkUploadUrl(uploadUrl, videoId, uploadHost)` returning `null` unless exactly `https://<uploadHost>/video-upload/<videoId>`; `readReelStatus` (conservative, unexpected shapes → pending); `uploadState` and `publishState` classifiers (`upload_complete`, `processing`, `ready` count as upload-complete; unknown never means complete, published or failed). Create `src/providers/facebook/requests.test.ts` covering wrong host, http, foreign path, mismatched id, and every status shape.

**Checkpoint**: G23, notes fix, rupload helper, state and request modules ready.

---

## Phase 3: User Story 1 — Publish one video to a Facebook Page (Priority: P1) 🎯 MVP

**Goal**: One video on a Facebook target publishes as a Page video with one `POST /{page}/videos` request, default type `video`.

**Independent Test**: With mocked Graph, schedule one landscape video to a Facebook Page with no type chosen, run `runTick`; exactly one Page video request with `file_url` and `description`, no Reels request, target published with the returned id.

- [X] T014 [US1] Add the Facebook video capabilities in `src/providers/facebook/capabilities.ts` (data-model §2): `postTypes` `text, image, carousel, video, reel`; one `single_video` `postTypeChoices` entry (`video` "Page video" default, `reel` "Reel"); base `video` block (one video, no images, MP4/MOV); `byPostType.video` note; `creationAllowance` 30 per 86,400 s "Facebook's daily Reels allowance". The Reel limits are added in T027. Wire `creationAllowance` in `src/providers/facebook/index.ts` and make `stepFor` pass kinds/postType.
- [X] T015 [US1] Extend `facebookStepFor` in `src/providers/facebook/steps.ts`: a single video with no choice or `video` → `publish_video` (`mayPublish: true`); old photo/text cases unchanged. Extend `src/providers/facebook/steps.test.ts`.
- [X] T016 [US1] Add the `publish_video` branch in `src/providers/facebook/publish.ts` per contracts/facebook-publishing.md: `POST /{page}/videos` with `file_url` and non-empty `description`; `done` with `externalId = id`; ambiguous on unreadable/after-send; retryable on before-send/rate-limit; 190 fatal + `credentialsInvalid`; 389 fatal with the public-storage guidance (`docsUrl("storage")`); never send `published`, `title`, `thumb`, `scheduled_publish_time`, `source`, `upload_phase`, `link`. Extend `src/providers/facebook/publish.test.ts` with every row, asserting exact params and absent fields.
- [X] T017 [US1] Add `facebookVideoSetup` (built on `createVideoAsset`, research P22) to `tests/helpers/facebook-publish.ts`.
- [X] T018 [US1] Write `tests/integration/facebook/page-video.test.ts`: default type through `runTick`, one request, outcomes (published, 389, 190 flags account, ambiguous). Run it with the untouched photo suites `tests/integration/facebook` (multi-photo, outcomes, publish-e2e) to confirm SC-008.

**Checkpoint**: US1 works alone — MVP.

---

## Phase 4: User Story 2 — Publish one video as a Facebook Reel (Priority: P1)

**Goal**: A target set to Reel runs `start_reel → upload_reel → check_upload → finish_reel → check_publish` on the step machine, paced 1 min then 5 min.

**Independent Test**: With mocked Graph and rupload and the DB clock, drive start, upload, two "uploading" checks, complete, finish, three "processing" checks, published; each request's content matches the contract and checks happen at the pace; an upload completing within 5 min advances within 2 ticks.

- [X] T019 [US2] Extend `facebookStepFor` in `src/providers/facebook/steps.ts` with Reel derivation over every row of data-model §3 (finished Reel state is always `check_publish` with `afterPublish: true`; `invalid` on a video post returns `afterPublish`). `start_reel` carries `allowance: { units: 1, retryUnits: 1 }`. Extend `steps.test.ts`.
- [X] T020 [US2] Implement `start_reel` and `upload_reel` in `src/providers/facebook/publish.ts` (contract §1–§2): `upload_phase=start`; `upload_reel` runs `checkUploadUrl` first (null → `fatal_error` "Facebook returned an unexpected upload address; nothing was sent or published." with no fetch), then `ruploadRequest` with `file_url` header and no bytes; `continue` with `uploadedAt` and `notBefore = now + 60 s`; error mapping per table. Extend `publish.test.ts` (exact params/headers, `bodyBytes === 0`).
- [X] T021 [US2] Implement `check_upload` and `finish_reel` in `src/providers/facebook/publish.ts` (contract §3–§4): `complete` → continue; pending/unreadable/network → continue with `checkDelayMs` until 30 min then fatal; `finish_reel` sends `video_state=PUBLISHED` and is the only Reel step with `mayPublish: true`; `success === true` → continue with `finishedAt`, `publishChecks: 0`, `notBefore = now + 60 s`; unreadable → ambiguous. Extend `publish.test.ts`.
- [X] T022 [US2] Implement `check_publish` in `src/providers/facebook/publish.ts` (contract §5): `published` → `done` with `externalId = videoId`; never `retryable_error`; only `failed` classification is `fatal_error`; code 190 → `ambiguous` + `credentialsInvalid`; everything else continues until 60 min then ambiguous. Add attempt summaries (`{ step, kind, videoId? }`, `uploadHost` on `upload_reel`, status fields, scrubbed `statusDetail` ≤ 300 chars; never token, full upload address or Authorization header). Handle `invalid` with `afterPublish` → ambiguous without a request. Extend `publish.test.ts`.
- [X] T023 [US2] Write `tests/integration/facebook/reels.test.ts`: the full Reel flow through `runTick` on the DB clock (`atTime`), asserting pace, request contents, SC-004 (≤ 2 ticks for an upload completing within 5 min) and SC-005 check counts (≤ 10 upload, ≤ 16 publish).

**Checkpoint**: US1 and US2 both work.

---

## Phase 5: User Story 3 — A failed or stuck Reel ends cleanly (Priority: P1)

**Goal**: Failure, stalls, restarts and the daily allowance end in the right state; once finish is sent only Facebook's own error report fails the Reel.

**Independent Test**: Mocked responses and the DB clock for: failed upload check; upload never completing; publish check reporting an error; never confirming; allowance used up.

- [X] T024 [US3] Write `tests/integration/facebook/reel-failures.test.ts`: failed upload; stuck upload (10 checks, failed at 30 min); publish error; expired/ceiling (16 checks, ambiguous at 60 min); dropped or unreadable status reads after finish never fail (SC-003); token rejected at each step (fatal before finish, ambiguous + flagged after); restart from saved state at every step; a changed choice before finish restarts; bad upload host makes no request (SC-007). Fix any gap found in `src/providers/facebook/publish.ts` or `steps.ts`.
- [X] T025 [P] [US3] Write `tests/integration/facebook/reels-allowance.test.ts`: the 31st Reel in 24 h waits with the existing G22 message ("30 of 30 used in the last 24 hours"); concurrent targets do not pass 30; photos, text and Page video are never held (SC-006).
- [X] T026 [P] [US3] Extend `tests/integration/meta/no-secrets.test.ts` with a full Reel flow and a Page video flow whose replies echo the token; assert the token is absent from attempts, `lastError` and summaries (SC-007).

**Checkpoint**: US1–US3 complete.

---

## Phase 6: User Story 4 — Choose Page video or Reel and see that type's requirements (Priority: P2)

**Goal**: The composer's declaration-driven "Post as" group offers Page video (default) and Reel, and the summary shows that type's label, limits and notes — all from server declarations.

**Independent Test**: A single-video Facebook target defaults to Page video; switching to Reel is saved on the target and the summary changes.

- [x] T027 [US4] Add `byPostType.reel` limits to `src/providers/facebook/capabilities.ts` (data-model §2, research P1): H.264/HEVC/VP9/AV1 with AAC or no audio; 3–90 s; at least 540 × 960; aspect 0.556–0.569; 24–60 fps; three notes.
- [x] T028 [P] [US4] Add a Facebook declaration assertion (default `video`, every choice in `postTypes`, passes registry checks) to `src/providers/registry.test.ts` and `src/providers/media.test.ts`.
- [x] T029 [P] [US4] Extend `tests/integration/compose/post-type-choice.test.ts` with Facebook cases: default Page video, switching, choice kept per target beside Instagram, summary values from data-model §5, keyboard and polite announcement.
- [x] T030 [P] [US4] Extend `tests/integration/api/post-type.test.ts`: a Facebook single-video target without `postTypes` returns `postType: "video"`; `reel` accepted; `story` gets a 400 naming `video, reel`.
- [x] T031 [P] [US4] Add a Facebook case to the existing `videoFitOf` badge suite (find it with `grep -rl videoFitOf tests/`): a Facebook video is "fits", never "will be converted".
- [x] T032 [P] [US4] Update `docs/limits.md` with the Facebook Page video and Reel rows, then run `pnpm vitest run tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts`.

**Checkpoint**: US4 independently works.

---

## Phase 7: User Story 5 — A video that does not fit a Reel is refused before scheduling (Priority: P2)

**Goal**: Each broken Reel limit gives one blocking issue naming the type, limit and value, via composer check, scheduling gate and engine re-check, with no Facebook request.

**Independent Test**: For each declared Reel bound, validate a Reel target breaking exactly that bound.

- [x] T033 [US5] Implement the wording rules in `src/providers/facebook/validate.ts` (contracts/facebook-capabilities.md Validation 1–6): one-rule message for `too_many_videos`/`video_with_images`; Reel aspect message "…Facebook Reels must be 9:16 (vertical). Docket does not crop video yet."; other `video_*` codes name the type and "Docket does not crop, trim or convert video yet."; append " Post it as a Page video instead." only when a Page video would accept the file; everything else unchanged. Extend `src/providers/facebook/validate.test.ts`: each rule, suggestion present and absent, 1,080 × 1,918 Reel accepted, inclusive bounds (3.0 s, 90.0 s, 540 × 960, 24/60 fps, aspects 0.556/0.569), unknown frame rate not refused, text/image/carousel cases unchanged.
- [x] T034 [US5] Confirm the shared path gives the same issue at the scheduling gate and engine re-check (G15): add a case in `tests/integration/limits/enforcement.test.ts` (or a Facebook sibling file) asserting a refused Reel makes no Graph or rupload request through `runTick`.

**Checkpoint**: All five stories functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T035 [P] Docs: `docs/adding-a-provider.md` Facebook worked example (reuses G19–G22); `docs/feature-map.md` mark Facebook video Built and record the unowned items from FR-025 (byte/chunked upload, Page video status checks, optional fields, Facebook-side scheduling, API video upload, generator video); `docs/meta-setup.md` (no new permission, mocks only, owed live checks from quickstart §6); `docs/decisions.md` implementation outcome under `## 021`; README feature list if it names Facebook formats. Note "no docker-compose change" (FR-028).
- [ ] T036 🛑 BLOCKED: needs a real Facebook Page, a live Page token and a browser — run quickstart §6 together: (1) publish a landscape Page video and note whether it shows as a Reel; (2) publish a 9:16 Reel and record what `rupload.facebook.com` returns for a `file_url` header; (3) record real `GET /<video-id>?fields=status` replies at each stage and compare with `readReelStatus`; (4) make a Page video fail processing and see whether `fields=status` reports it. Record results in `docs/meta-setup.md`.
- [x] T037 Final pass, once: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`. Fix anything red; confirm `db:check` shows no migration and that existing Facebook and Instagram suites pass unchanged (SC-008).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (1)** → **Foundational (2)** blocks everything.
- Within Phase 2: T002 → T003/T004 [P] → T005 → T006; T007, T008, T009, T010, T012, T013 are independent of the engine chain (T012/T013 need T011 only if they import the union — do T011 first).
- **US1 (3)** needs Phase 2. **US2 (4)** needs US1's T014–T017 (same files) and Phase 2. **US3 (5)** needs US2. **US4 (6)**: T027 needs T014; the rest follow T027. **US5 (7)** needs T027.
- **Polish (8)** after all stories; T037 last.

### Within Each Story

Unit tests accompany each implementation task; the integration test closes the story. Same-file tasks (`publish.ts`, `steps.ts`, `capabilities.ts`) are sequential.

### Parallel Opportunities

- T003, T004 together; then T007, T008, T009, T010, T012, T013 alongside.
- US4 tasks T028–T032 in parallel after T027; US3's T025 and T026 in parallel.
- US4/US5 (validation, composer, docs) can proceed alongside US2/US3 once T014 and T027 land, since they touch different files.

### Parallel Example: Foundational

```text
Task: "Add afterPublish input to applyStepResult in src/server/scheduler/record.ts"
Task: "Add opts.afterPublish to recoverExpiredLease in src/server/scheduler/recovery.ts"
Task: "Create src/providers/facebook/requests.ts and requests.test.ts"
Task: "Add ruploadRequest to src/providers/meta/graph.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1, then Phase 2 (G23 and shared modules).
2. Phase 3: Page video. Run `pnpm vitest run tests/integration/facebook`.
3. Stop and validate; Page video is shippable alone.

### Incremental Delivery

1. Add US2 (Reels) → US3 (failure handling and allowance) — all P1.
2. Add US4 (composer choice and summary) and US5 (validation wording) — P2.
3. Docs, then the single final full check; the live checks (T036) remain owed to the owner and Facebook video is reported "verified with mocks only" until they run.

---

## Notes

- Every task is executable headless: Vitest, `tsc`, lint, build. No dev server or browser.
- No migration, no new dependency, no component change (if a task finds it must touch a component, read `node_modules/next/dist/docs/` first per AGENTS.md).
- Commit per task or logical group with conventional commits and explicit paths.

---

## Phase 9: Review remediation

**Purpose**: Close the blocking findings in `review.md`. Each task names its finding and the location.

- [x] T038 Make the claim-time checks in `runPublishing`'s `decide` settle an `afterPublish` step `ambiguous` (with `AFTER_PUBLISH_SUFFIX`) instead of `failed`. Three checks are affected: account not active or removed (publishing.ts:130), `maxPublishDurationMs` exceeded (publishing.ts:137) and settings rejected at claim (publishing.ts:166). Derive the step first, reusing `stepIsAfterPublish` (publishing.ts:93) or a shared helper; keep `failed` only when no provider or shape exists to derive it. Also make `advanceFacebook`'s unreadable-token result `ambiguous` with `credentialsInvalid` when the derived step is `check_publish` (src/providers/facebook/publish.ts:43). Add tests:
  - `tests/integration/scheduler/after-publish.test.ts`: an account flagged `needs_reauth` by another target ends ambiguous; `maxPublishDurationMs` exceeded ends ambiguous.
  - `tests/integration/facebook/reel-failures.test.ts`: two Reels in `check_publish` when the token is revoked; the second ends ambiguous, not failed, and no second `start` is sent.

  — review F1 (BLOCKER), src/server/scheduler/publishing.ts:130
- [x] T039 Reword `audio_codec_not_allowed` (and `audio_required`) for Facebook like the other Reel video refusals in `validateFacebook`: name the type ("for a Facebook Reel"), add "Docket does not crop, trim or convert video yet.", and append " Post it as a Page video instead." when a Page video would take the file. Add an MP3- or Opus-audio Reel case to `src/providers/facebook/validate.test.ts`. — review F2 (MAJOR), src/providers/facebook/validate.ts:25
- [x] T040 Complete the FR-023 and FR-025 docs.
  - `docs/limits.md`: add Facebook `note:` rows for the unpublished Page video limits, the unstated Reel size limit, the 30-minute upload check ceiling and the 60-minute publish check ceiling. Cite real test titles in `tests/integration/facebook/reel-failures.test.ts`. Trim the "aspect 9:16 ±1%" text repeated on the non-aspect `reel …` rows.
  - `docs/feature-map.md`: add a "Facebook video (021)" bullet under "## Already built"; correct "no other provider does yet" (line 16); record "multiple videos or video with images in one Facebook post" as unowned.
  - Run `pnpm vitest run tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts`.

  — review F3 (MAJOR), docs/limits.md:39

---

## Phase 10: Review remediation

**Purpose**: Close the blocking finding of the second review in `review.md`.

- [ ] T041 Fix the type error T038 introduced. Type the `outcome` field of `refuse`'s parameter as `AttemptOutcome` (import it from `../dal/attempts`) or as `"account_unavailable" | "did_not_complete"`, instead of `string`. Then run `pnpm typecheck` and read its output; it must report no errors (4 × TS2322 at publishing.ts:137, 138, 143 and 144 today). Also run `pnpm lint src/server/scheduler/publishing.ts` and `pnpm vitest run tests/integration/scheduler/after-publish.test.ts tests/integration/facebook/reel-failures.test.ts`. — review F10 (BLOCKER), src/server/scheduler/publishing.ts:132
