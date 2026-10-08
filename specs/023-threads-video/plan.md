# Implementation Plan: Threads video

**Branch**: `023-threads-video` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-threads-video/spec.md`

## Summary

Entry 5 of the video roadmap. Threads gains `media_type=VIDEO` posts and video items in carousels, on the existing resumable step machine. The work reuses entry 2's video library and validator and entry 3's per-type limits (G20) and frame-rate floor (G21). It adds no contract member, schema, migration or engine change. Code facts F1–F19 and decisions P1–P21 are in [research.md](./research.md).

**Capabilities and validation (US4; FR-001–FR-005, FR-018–FR-020).**

- **Declaration.** Threads declares `THREADS_VIDEO` (D2) as its base block: one video, no images, MP4/MOV, H.264/HEVC, AAC or silent, 1 GB, 300 s, 1,920 px, aspect 0.01–10, 23–60 fps.
  - `byPostType.carousel` allows 20 videos mixed with images (D3), with a note.
  - `byPostType.video` carries a "9:16 recommended" note.
  - `postTypes` gains `video`. There is no post type choice (D1) and no creation allowance (D11) (P1).
- **`validateThreads`** stops running the image planner on video items (F8). It words every video refusal "… for Threads. Docket does not crop, trim or convert video yet." and adds `too_many_items` for mixed posts over 20 (P4).
- **Three small generic fixes** (P2, P3, P6):
  - the summary shows "Post as" only for a provider with a declared choice;
  - `videoBytesLabel` prints GB from 1e9;
  - the enforcement-row generator skips the single-video `videos` and `video with images` rows when a carousel override exists.
- **Badges and the summary** follow the declaration with no Threads-specific UI code.

**Publishing (US1–US3; FR-006–FR-017).**

- **Requests.** A new pure `requests.ts` builds them:
  - a `VIDEO` container with `video_url` and optional `text`;
  - a video carousel item with `media_type=VIDEO`, `video_url` and `is_carousel_item=true`, without text or alt text.
  - Image, text and parent requests are byte-for-byte unchanged (P7).
- **State.** It stays `v: 1` with optional `kinds` and `itemProgress`, and `mediaType` gains `VIDEO` (P8). In-flight image targets resume unchanged.
- **Steps.**
  - A single video: `create_container` → `check_status`* → `check_quota` → `publish`.
  - A carousel with video: `create_item_*` → `check_item_<k>`* for each video item → `create_carousel` → `check_status`* → `check_quota` → `publish` (D5, P9).
  - Only `publish` may publish.
- **Pace.** A video container is read 30 s after its creation, once a minute until 5 minutes, then every 5 minutes. It fails at 60 minutes after at most 17 reads (D6, P10, P11). Image and text pace and the 5-minute cap are unchanged.
- **Errors.** `ERROR` gives "Threads could not process the video…" with Threads' `error_message` (scrubbed) and a plain explanation for each documented code, matched as a whole token (D7, P13). The attempt log records `errorMessage` (P12).
- **Unchanged rules** (P15–P17):
  - `EXPIRED` recreates the whole post, at most twice;
  - the 23-hour guard measures from the oldest container;
  - `PUBLISHED` while checking is ambiguous;
  - a changed post restarts from the first create step.

**Not built here** (FR-028–FR-031):

- cropping, trimming or encoding (entry 6);
- Bluesky video (entry 7) and TikTok (entry 8);
- no change to Instagram, Facebook or X;
- resumable or byte upload, covers, alt text for video, API video upload and generator video (unowned);
- replies, quotes and polls;
- raising Docket's 10-item post cap (P5, unowned).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency.

- **zod 4.6.5.** The extended `threadsStateSchema`.
- **Next.js 16.3.8 / React 19.2.8.** No route, component or server action changes. The composer summary changes only through the shared `requirementsOf` output (P2), which is rendered by the existing `RequirementsSummary`. Nothing needs reading in `node_modules/next/dist/docs/` for this entry, because no Next.js API is touched.
- **Vitest 5.** Mocked Graph through `tests/helpers/fake-graph.ts`, with the clock pinned by `atTime`.

**Storage**: PostgreSQL, unchanged. There is no migration. Step state is JSON in the existing `post_targets.step_state`, and the new fields are optional (P8). Videos are fetched by Threads from the existing public bucket by `video_url` (D8).

**Testing**: Vitest against real Postgres with run-scoped databases.

- Unit tests for the pure step, request, state and error functions.
- Integration tests through `runTick` with mocked Threads replies.
- Video rows come from `createVideoAsset` facts, so no ffmpeg is needed.
- New test files only. Every existing Threads, Instagram, Facebook and Bluesky test file is byte-for-byte unchanged (P19, SC-008). See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid or Neon. Publishing runs in `runTick`.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **Fast publish (SC-004).** A video finished within 5 min publishes within 2 ticks of `FINISHED` (quota, then publish).
- **Slow processing (SC-005).** At most 17 reads per video container, and failure by about 61 min plus tick lag.
- **Mixed carousel (SC-006).** 0 parent requests while any video item is unready, and 0 reads of image items.

**Constraints**:

- One Graph call per step, with waits as `notBefore` and no sleeping (FR-011).
- No provider call inside a held transaction (unchanged engine).
- DB clock everywhere.
- Image and text requests, pace and messages are unchanged (US1 #7).
- No limit literals in UI code (FR-018).
- The token never reaches `lastError`, attempts, summaries or snapshots (VII, FR-017).

**Scale/Scope**: 1 provider changed (Threads), plus 3 small generic fixes.

- **New source files:** 2: `src/providers/threads/requests.ts` and `src/providers/threads/video-errors.ts`.
- **Edited source files:** 7:
  - Threads `capabilities.ts`, `state.ts`, `steps.ts`, `publish.ts` and `validate.ts`;
  - `src/providers/requirements.ts`;
  - `src/providers/video-labels.ts`.
- **Tests:**
  - about 9 new files: 5 unit, 4 integration, and 1 compose;
  - about 6 extended: `limit-rows.ts`, `threads-publish.ts` (helper addition), `requirements.test.ts`, `video-labels.test.ts`, `no-secrets.test.ts`, and limits-inventory only if needed.
- **Docs:** 5 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every Threads fact comes from `docs/research/meta-video.md` ("Threads", and the specs table), checked line by line in research.md. Three facts are UNVERIFIED in the research: whether items must finish before the parent, the processing time, and the exact `error_message` form. Each is decided conservatively (D5, D6, P13), kept in one named constant or function, covered by mocked tests only, and listed as an owed live check. Code facts F1–F19 were read from the repository in this phase. The research's "no more than 5 minutes" is read as guidance, not a hard stop, as 019 did (D6). |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test with mocked Graph replies (quickstart §1–§4). Real Threads publishing is reported as "verified with mocks only", with live checks owed (quickstart §6, `docs/meta-setup.md`). |
| III. Project isolation | PASS | No new table, query or DAL code. The step state lives on the project-owned `post_targets` row behind the existing scheduler repo. |
| IV. One service layer | PASS | One validator (`validateResolvedContent` → `validateThreads`) still serves the composer, the scheduling gate, the engine's G15 re-check and the badges. One `requirementsOf` serves the summary. Publishing has one implementation (`advanceThreads`). |
| V. Providers are plug-ins | PASS | Threads' behaviour lives in `src/providers/threads/`. There is no composer, schema, engine or contract change (FR-001). The three generic fixes (P2, P3, P6) change existing generic helpers so they behave correctly for a provider with a carousel override and no choice. They add no member, are inert for every existing provider (tests pin this), and are recorded in `docs/decisions.md`. `advance` keeps the five result kinds, `publish` stays the only step that may publish, and an unknown publish outcome stays ambiguous. |
| VI. Boring, few dependencies | PASS | No new package and no infrastructure. |
| VII. Secrets never leak | PASS | `error_message` is sanitised and scrubbed of the token before it reaches `lastError`, summaries or `publish_attempts` (P12). `no-secrets.test.ts` is extended with an `error_message` that echoes the token. There is no new env var. |
| Engineering constraints | PASS | `runTick` stays bounded at one Graph call per step, with waits as `nextAttemptAt` and never sleeping. Times are UTC on the DB clock. There is no UI component change, so `docket-ui` rules are untouched. Video: "out of scope until a spec says otherwise". This spec says otherwise for Threads video posts and video carousel items only. |
| Workflow | PASS | Conventional commits with explicit paths. `docs/decisions.md` `## 023` is written in this phase. Checks run in proportion: targeted tests per task, then one final pass (`lint`, `typecheck`, `test`, `build`; no `db:check`, because there is no schema change). |

**Post-design re-check (after Phase 1)**: PASS.

- **Old state still parses.** Every new state member is optional, and `mediaType` only gains a value, so every Threads state saved before this entry parses and drives the same steps (data-model §2).
- **Inert generic fixes.** P2 changes `video.postType` only for providers with `byPostType` and no choice; today there are none. P3 changes labels only at 1 GB and above; nothing today reaches that. P6 changes rows only for providers with a carousel override and no choice; today there are none.
- **Two judgement calls against the letter of the spec**, both recorded in decisions:
  - *P5:* US2 #5's 20-item carousel is proved at provider level, because Docket's own `POST_MEDIA_MAX = 10` refuses an 11th item for every provider today. Raising it is a cross-provider product change and is unowned.
  - *P12:* FR-014's `errorMessage` is added to every status read's summary, image reads included. The field is additive and appears only when Threads sends one, so image messages and outcomes are unchanged (US1 #7).

## Project Structure

### Documentation (this feature)

```text
specs/023-threads-video/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: research check, code facts F1–F19, decisions P1–P21
├── data-model.md        # Phase 1: capabilities, state, steps, requests, limits rows, summary
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── threads-capabilities.md   # declaration, validateThreads, summary, badges, generic fixes, limits rows, tests
│   └── threads-publishing.md     # steps, exact requests, pace, status handling, messages, tests
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── requirements.ts                      # P2: video.postType only with a declared choice (+ test)
│   ├── video-labels.ts                      # P3: GB label from 1e9 (+ test)
│   └── threads/
│       ├── capabilities.ts                  # THREADS_VIDEO, THREADS_MAX_ITEMS, byPostType video/carousel, postTypes + video
│       ├── requests.ts                      # NEW: STATUS_FIELDS, videoContainerParams, itemParams, readStatus
│       ├── video-errors.ts                  # NEW: codes, videoErrorExplanation, videoErrorText
│       ├── state.ts                         # VIDEO, kinds, itemProgress, ThreadsPlan, video pace constants (+ new state.test.ts)
│       ├── steps.ts                         # planOf, validState(plan), check_item_<k> (+ new video-steps.test.ts)
│       ├── publish.ts                       # VIDEO and video item creates, item checks, video pace and ceiling,
│       │                                    #   errorMessage in summaries, error texts, oldest-container age (+ new video-publish.test.ts)
│       └── validate.ts                      # planner skips video, Threads wording, too_many_items (+ new video-validate.test.ts)

tests/
├── helpers/
│   ├── threads-publish.ts                   # + threadsVideoSetup(storage, text, kinds) (threadsSetup unchanged)
│   └── limit-rows.ts                        # P6: skip single-video count/mix rows with a carousel override
└── integration/
    ├── threads/{video,video-carousel,video-failures,video-fit}.test.ts      # NEW
    ├── compose/threads-video-summary.test.ts                                # NEW
    ├── meta/no-secrets.test.ts                                              # extended
    └── docs/limits-inventory.test.ts                                        # only if a notes-only byPostType entry needs ignoring

docs/{limits,adding-a-provider,feature-map,meta-setup,decisions}.md
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **Pure logic in `src/providers/threads/`**, mirroring Instagram's `requests.ts` / `state.ts` / `steps.ts` split, so every step and request is unit-tested without a DB.
- **The only generic edits are to existing pure helpers** (`requirements.ts`, `video-labels.ts`) and a test helper (`limit-rows.ts`).
- **Engine, schema, services, API and UI components are untouched.**

## Implementation order (for /speckit-tasks)

1. **Generic fixes first, each with its test** (P2, P3, P6). Every existing test stays green, since no provider uses them yet.
2. **Capabilities and validation (US4).**
   - `THREADS_VIDEO` and the declaration; `validateThreads` (P4).
   - `video-validate.test.ts`, the requirements test and the registry load.
   - `docs/limits.md` rows, then the enforcement and inventory tests.
   - The compose summary test and the fit test.
3. **State and steps.** The `state.ts` schema, plan and pace; `steps.ts` `planOf`/`validState`/`check_item_<k>`; `state.test.ts` and `video-steps.test.ts`. Confirm that `steps.test.ts` passes untouched.
4. **Single video (US1).**
   - `requests.ts` and `video-errors.ts`.
   - `publish.ts`: the `VIDEO` create, video pace and ceiling, `readStatus`, `errorMessage` in summaries, error texts and the media URL hint.
   - `video-publish.test.ts` and `video-errors.test.ts`; `threadsVideoSetup`; `video.test.ts`.
   - Confirm that the existing Threads integration suites pass untouched.
5. **Carousels with video (US2).** Video items, `check_item_<k>` with P11's due times, the parent at the video pace, and the oldest-container age; `video-carousel.test.ts`.
6. **Failures (US3).** `video-failures.test.ts` (codes, ceiling, expiry, `PUBLISHED`, unknown status, token rejection, kill and resume, changed post, 23 h); the `no-secrets` extension.
7. **Docs.**
   - `docs/adding-a-provider.md` §15: the `VIDEO` container, video items checked before the parent, the video pace and ceiling, and the error explanations.
   - `docs/feature-map.md`: Threads video built. Unowned: resumable or byte upload, a cover or thumbnail, posts of more than 10 items, API video upload and generator video.
   - `docs/meta-setup.md`: "Threads video: owed live checks" (no new permission; mocks only; the five checks of quickstart §6).
   - `docs/decisions.md` implementation outcome.
   - FR-025: no `docker-compose.yml` or `.env.example` change.
8. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, once.

## Complexity Tracking

No constitution violation needs justifying. The three generic fixes (P2, P3, P6) are corrections to existing generic helpers, not new hooks. Each is inert for every existing provider and recorded in `docs/decisions.md`.
