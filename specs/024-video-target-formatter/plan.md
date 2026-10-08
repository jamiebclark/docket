# Implementation Plan: Per-target video formatter

**Branch**: `024-video-target-formatter` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/024-video-target-formatter/spec.md`

## Summary

Entry 6 of the video roadmap. One master video reaches every video-publishing target (mock, Instagram, Facebook, Threads), each through its own adapted file. The worker crops around a focal point or pads (with a blurred copy or a colour), trims to a start and end and to each target's maximum, and encodes H.264/AAC MP4 within each target's bitrate, frame-rate and size limits. A low-resolution preview per target is available before publishing. It follows the image planner's pattern: one pure plan per (video, target), used everywhere. Code facts F1–F20 and decisions P1–P27 are in [research.md](./research.md).

**Planning (US1–US3, US6; FR-005–FR-014).**

- **One answer.** The pure `planVideo` (in `src/providers/video-plan.ts`, beside `planImage`) returns `original`, `derive{rewrap|encode, steps, recipe, output, notes}`, `refuse{issues}` or `checking`. The planner is the single source of truth for:
  - the composer;
  - the fit badges;
  - the requirements summary;
  - the scheduling gate;
  - the tick's claim-time gate;
  - publishing;
  - housekeeping.
- **Shape and size.**
  - Reframing happens only when the shape is out of range, or the person asks for the platform's recommended shape (D2).
  - Crop and pad numbers are computed in Node in even integers (P3). A padded canvas is bounded at `max(source long side, 1920)`.
  - The picture is never enlarged, and the output is refused below the minimum (D4).
- **Trim and mode.** A trim is cut at each target's maximum, with a note (D5). The mode is as is, rewrap or re-encode, in a fixed order (P5).
- **Sharing.** A version's key is the hash of its numeric recipe (P2). Identical requests share one version, and a stale edit's result is never looked up.
- **Facts.** New probe facts are recorded: bitrates, sample rate, channels and index position (P9). Videos stored before this entry are re-read once by the worker; until then their plan is `checking`.
- **Declarations.** Providers declare the new limits (D7, P24). The "Docket does not crop, trim or convert video yet." suffix is removed (FR-032).

**Building (US1, US4, US5; FR-015–FR-023).**

- **The loop.** A new worker-only loop, `runVideoVersionLoop`, builds rows of a new `video_versions` table (`full` or `preview`).
  - It runs `VIDEO_ENCODE_CONCURRENCY` lanes (default 1), each claiming under `FOR UPDATE SKIP LOCKED` with a lease, due soonest first (P12).
  - An attempt has a time limit that grows with the kept length, and there are at most 3 attempts.
- **Builders.** Pure ffmpeg argument builders cover crop, blurred pad, colour pad, trim, fps and scale. The encode is x264 High yuv420p `veryfast`, AAC and faststart (P6, P7). The size fit is bounded by bitrate and resolution retries, never `-fs` (P8).
- **Readback and storage.** Every output is read back against the plan and the target's limits before it is stored (D13). Partial and stale results are never stored or used.
- **Entry 2's clean step** now writes the index at the front (D18, P23).

**Publishing (US5; FR-024–FR-027).**

- **Queueing.** `syncVideoVersions` queues full versions after a post is scheduled, queued, published now, edited or retried (P14).
- **The claim-time gate.** In the tick's claim decision (first step only, inside the claim transaction, no tool or storage call), the gate waits while a version is not ready (P13):
  - no provider call and no attempt row;
  - `video_wait_since` drives "Preparing video for <platform>".
- **Failures.** The target fails with "The video could not be adapted for <platform>: <reason>" when the version fails, or after 2 hours ("took too long", or "needs the worker process" when no worker heartbeat exists).
- **Publishing the version.** `resolvePublishMedia` publishes a ready version's public URL. It requeues a version whose object vanished and never builds in the tick.

**Composer (US2–US4, US6; FR-001–FR-004, FR-028–FR-031).**

- **Edits.** A per-video edit (`post_video_edits`; default whole video, blurred pad, black, centre, recommended shape off) is set in an accessible dialog:
  - trim fields to a tenth of a second;
  - fit method;
  - colour;
  - a keyboard-operable focal-point picker on the poster frame;
  - the recommended-shape checkbox.
- **Previews.** A per-target preview panel requests a ≤ 640 px preview, polls until it is ready, and shows "fits as is", "rewrapped" or the refusal otherwise.
- **Badges and summary.** Badges gain "will be adapted" (with step words) and "checking". The requirements summary lists what Docket adapts and what it cannot fix.

**Not built here** (FR-044–FR-046):

- burned-in captions, subject-tracking crop and per-platform cover frames (not on this roadmap);
- Bluesky video (entry 7) and TikTok (entry 8), which get the formatter by declaring limits;
- video on X;
- per-target edits;
- API edit fields or video upload;
- generator video;
- HDR tone mapping;
- enlarging;
- joining, splitting, speed, filters, audio replacement or adding silent audio;
- matching Instagram carousel items to the first item's shape.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency (spec assumption 1).

- **ffmpeg/ffprobe** (Debian bookworm 5.1 in the image; Ubuntu apt build in CI), run only through `runTool` in the worker. Every option spelling the builders use is confirmed by a CI test against the installed tool's own help (P6), because `docs/research/ffmpeg.md` marks several UNVERIFIED and the planning machine has no ffmpeg (F20).
- **Next.js 16.3.8 / React 19.2.8.**
  - The changes are two new server actions, new client components and extended server data. No route handler or config change.
  - Before writing the actions and client components, the implement phase reads `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`, `05-server-and-client-components.md` and `02-guides/server-and-client-boundary.md` (AGENTS.md).
- **zod 4.6.5** for `videoEditSchema` and the extended composer schemas.
- **drizzle-orm 0.45.3 / drizzle-kit 0.31.11** for one migration.
- **Vitest 5.0.3.**

**Storage**: PostgreSQL. One migration (`0017`):

- new table `post_video_edits`;
- new table `video_versions`;
- seven new columns on `media_assets`;
- one new column on `post_targets` (`video_wait_since`);
- a hand-added `UPDATE` marking existing videos `facts_version = 1`.

Versions and previews are stored in the existing public S3-compatible bucket under `projects/<p>/media/<asset>/vv|vp/<key>.mp4` (data-model §7).

**Testing**: Vitest against real Postgres with run-scoped databases. See [quickstart.md](./quickstart.md).

- Pure unit tests run with no DB or tools: the planner, the hash, the ffmpeg argument builders, the box walker, the probe parser, edit parsing and the UI helpers.
- DB integration tests run through `runTick` and the services, with version rows set directly (no ffmpeg): waiting, failure, two hours, retry, sharing, sync, as is, previews and collection.
- Worker suites behind `requireFfmpeg()` run on generated fixture clips: they skip locally without ffmpeg and are mandatory in CI.
- The docker job runs the formatter smoke and the SC-007 timing with `--cpus=2`.

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid, or a container host with Neon. Encoding runs only in the `worker` process.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **SC-007.** A preview of a 30 s 1080×1920 clip is ready in ≤ 60 s on 2 cores with no other encode.
- **US5.** A ready version publishes within one tick interval plus 60 s of becoming ready (the wait re-check).
- **SC-004.** The tick adds at most four indexed reads and one insert per claimed video target and stays within its existing budget.

**Constraints**:

- No video tool in the web process or the tick (D9, enforced by `tests/lint/no-ffmpeg-in-web.test.ts` and `assertWorkerProcess`).
- No provider or storage call inside a held transaction.
- The DB clock everywhere.
- Never `-fs`.
- No limit literals in UI code.
- An as-is target's file is byte-for-byte the stored original.
- Neon-compatible: no advisory locks and no LISTEN; leases are columns.

**Scale/Scope**:

- **New source files: about 20.**
  - `src/providers/video-plan.ts`;
  - `src/lib/video/edit.ts`;
  - `src/server/video/{ffmpeg-args,boxes,encode,readback,versions-loop,rescan}.ts`;
  - `src/server/dal/{video-versions,video-version-processing}.ts`;
  - `src/server/services/{video-versions,video-previews}.ts`;
  - 5 components and helpers under `src/components/compose/`;
  - the migration.
- **Edited source files: about 30.**
  - types and validation;
  - the three provider validators and four capability files;
  - requirements and labels;
  - media item, probe, clean, process and loop;
  - the scheduler (publishing and DAL);
  - the post services (index, validate, compose, retry, retry-all, view);
  - media-variants and media-fit;
  - media delete and housekeeping;
  - env, storage keys, schema and project-owned;
  - the worker entry;
  - the composer, actions, fit-ui and `RequirementsSummary`.
- **Tests: about 25 new files**, plus about 15 extended (the validators' expected strings, fit, requirements, registry, limit-rows/enforcement, the inventory and the factories helper).
- **Docs: 7 files**, plus `.env.example`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Platform limits come only from `docs/research/meta-video.md` and tool behaviour from `docs/research/ffmpeg.md`, checked in research.md. The research's UNVERIFIED option spellings are not trusted: P6's CI test asserts each against the installed ffmpeg's own `-h` output before use, as the spec requires. In-filter expressions the research could not verify (`ow`/`oh`, `force_original_aspect_ratio`) are avoided by computing numbers in Node (P3, P7). Next.js APIs are read from `node_modules/next/dist/docs/`. Nothing is marked NEEDS RESEARCH. |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has a test: pure, DB integration, or ffmpeg fixture (quickstart §1–§3). The ffmpeg suites cannot skip in CI. The planning machine has no ffmpeg, so the implement phase reports those suites as passing only from a run that executed them (CI, or the built image). Real publishing of adapted files is reported as verified with mocks only, with owed live checks (FR-043, quickstart §8). SC-007 is measured in the docker job and recorded, and a miss is reported. |
| III. Project isolation | PASS | Both new tables carry `project_id`, are listed in `project-owned.ts`, and are reached through scoped repos (`posts.listVideoEdits/setVideoEdits`, `videoVersions`). Cross-project access is limited to the worker's claim repo and the tick's claim context, both inside `crossProject(…)` with fixed reasons, as entry 2's media loop and the scheduler already do. Edits require `post: ["edit"]` on the server. |
| IV. One service layer | PASS | One planner serves every caller (P1). One `syncVideoVersions` serves all scheduling paths, the API and generation, through the existing services (P14). One preview service serves the composer. Publishing keeps one implementation (`resolvePublishMedia` plus the engine). |
| V. Providers are plug-ins | PASS | Providers change only by declaring the new limits (D7, P24) and dropping the suffix (FR-032, FR-034). The formatter reads capabilities only, so Bluesky and TikTok get it by declaring limits. The engine change (the claim-time video gate) is generic, adds no provider hook, keeps `advance`'s five result kinds and keeps ambiguity rules intact: every new path runs before the first provider call (FR-027). |
| VI. Boring, few dependencies | PASS | No new npm package, image package or infrastructure. ffmpeg (with libx264 and native AAC) is already in the image (018, justified there). The queue is Postgres rows with `FOR UPDATE SKIP LOCKED` and leases, the same as entry 2's media loop. One new env var, documented. |
| VII. Secrets never leak | PASS | No credential is involved. Failure reasons stored on `video_versions` and in `lastError` are fixed sentences. Tool stderr is logged truncated, never stored and never shown. Storage keys and URLs never appear in error messages. |
| Engineering constraints | PASS (with the 018 exception, unchanged) | `runTick` stays bounded: the gate is DB reads and pure arithmetic; it never waits and never runs a tool, and a lost version object only requeues. Encoding runs outside `runTick` in the worker, under the same exception 018 justified (see Complexity Tracking). Accessibility: keyboard focal point, labelled controls, live announcements and visible focus (P20, the `docket-ui` skill). Times are UTC on the DB clock. Video is lifted from "out of scope" by this spec, for per-target adapting. |
| Workflow | PASS | Conventional commits with explicit paths. `docs/decisions.md` `## 024` is written in this phase. Checks run in proportion: targeted tests per task, then one final pass including `db:check` and `build`, because the schema and the server/client boundary change. |

**Post-design re-check (after Phase 1)**: PASS.

- **Schema.** The schema is additive. Existing rows stay valid. The factory default for `facts_version` is 2, so existing test helpers' videos remain current, and the migration marks only real pre-entry videos as 1.
- **Behaviour for fitting videos is unchanged.** A video that fits goes as is with no version, so every existing as-is test is unaffected (SC-002).
- **Two judgement calls against the letter of the spec**, both recorded in decisions:
  - **P3, the canvas ceiling.** D4 permits a larger canvas; the plan bounds it at `max(source long side, 1920)`.
  - **P25, generated enforcement rows.** Rows for limits the formatter now adapts change meaning from "refused" to "adapted". This is required by SC-001 and reaches beyond FR-042's "message or badge wording only" for those generated rows. Hand-written tests change only in expected messages and badges, and every changed expectation is listed in tasks.

## Project Structure

### Documentation (this feature)

```text
specs/024-video-target-formatter/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: research check, code facts F1–F20, decisions P1–P27
├── data-model.md        # Phase 1: media_assets facts, post_targets.video_wait_since, post_video_edits, video_versions, capability and planner types
├── quickstart.md        # Phase 1: validation runs, operator-facing edits, owed live checks
├── contracts/
│   ├── video-planner.md     # planVideo, worked examples, gate integration, badges, summary, messages, declarations
│   ├── video-worker.md      # argument builders, facts, clean faststart, rescan, version loop, readback, collection
│   ├── video-publishing.md  # syncVideoVersions, claim-time gate, resolvePublishMedia, retry, tests
│   └── video-composer.md    # edit inputs, check response, preview actions, components, accessibility
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
drizzle/0017_*.sql                                  # NEW (generated + facts_version UPDATE)

src/
├── providers/
│   ├── types.ts                       # VideoCapabilities + 6 fields; VideoFacts + new optional facts
│   ├── media.ts                       # assertVideoCapabilities: new checks
│   ├── validation.ts                  # videoLimitsFor merges new fields (validator rules unchanged)
│   ├── video-plan.ts                  # NEW: planVideo, previewRecipe, VideoRecipe/VideoPlan/VideoStep (+ test)
│   ├── video-labels.ts                # step words, note wording helpers (+ test)
│   ├── requirements.ts                # video.adapts / video.cannot (+ test)
│   ├── instagram/{capabilities,validate}.ts   # D7 values; suffix removed
│   ├── facebook/{capabilities,validate}.ts    # D7 values (reel); suffix removed
│   ├── threads/{capabilities,validate}.ts     # D7 values; suffix removed
│   └── mock/index.ts                  # full small limit set
├── lib/video/edit.ts                  # NEW: VideoEdit, defaults, videoEditSchema, assertEditFits (+ test)
├── lib/validation/scheduling.ts       # postInputSchema.videoEdits
├── server/
│   ├── db/schema/{media,posts}.ts     # new columns and tables; project-owned.ts + 2 lines
│   ├── dal/
│   │   ├── posts.ts                   # listVideoEdits, setVideoEdits; setMedia prunes edits
│   │   ├── targets.ts                 # videoWaitSince in record/patch
│   │   ├── media.ts                   # new facts in NewMedia
│   │   ├── media-processing.ts        # finishReady facts; claimRescan/finishRescan
│   │   ├── video-versions.ts          # NEW scoped repo
│   │   ├── video-version-processing.ts# NEW cross-project worker repo
│   │   ├── scheduler.ts               # ClaimContext.videoGate
│   │   └── scope.ts                   # videoVersions in scoped/scheduling repos
│   ├── media/{item,hash}.ts           # new facts in items; videoRecipeKey (+ test)
│   ├── storage/index.ts               # mediaKeys.videoVersion / videoPreview
│   ├── env.ts                         # VIDEO_ENCODE_CONCURRENCY
│   ├── video/
│   │   ├── probe.ts                   # bitrates, sample rate, channels (+ test)
│   │   ├── boxes.ts                   # NEW indexAtFront (+ test)
│   │   ├── clean.ts                   # +faststart (D18)
│   │   ├── process.ts                 # records new facts
│   │   ├── loop.ts                    # rescan when idle
│   │   ├── ffmpeg-args.ts             # NEW pure builders + USED_OPTIONS (+ test)
│   │   ├── encode.ts                  # NEW encode/rewrap runner with the size-fit loop
│   │   ├── readback.ts                # NEW output check against recipe and limits
│   │   └── versions-loop.ts           # NEW worker loop (lanes, lease, heartbeat)
│   ├── services/
│   │   ├── video-versions.ts          # NEW syncVideoVersions, videoGate core, wanted keys
│   │   ├── video-previews.ts          # NEW request/status
│   │   ├── media-variants.ts          # adaptedMediaFor + resolvePublishMedia for video
│   │   ├── media-fit.ts               # adapted/checking states (+ test)
│   │   ├── media.ts                   # deleteMedia removes versions
│   │   └── posts/{index,validate,compose,retry,retry-all,view,cancel}.ts
│   └── scheduler/{publishing,housekeeping}.ts
├── worker.ts                          # + runVideoVersionLoop
├── components/
│   ├── compose/{VideoEditButton,VideoEditDialog,FocalPointPicker,VideoTargetPreview}.tsx   # NEW
│   ├── compose/video-edit-ui.ts       # NEW pure helpers (+ test)
│   ├── compose/{RequirementsSummary.tsx,requirements-ui.ts}
│   └── media/{fit-ui.ts,FitBadges.tsx}
└── app/p/[projectSlug]/compose/{Composer.tsx,actions.ts}   # videoEdits state, preview actions

tests/
├── helpers/{factories,limit-rows,video-fixtures}.ts        # new facts defaults; adapt/refuse rows; new fixtures
├── lint/no-video-yet-suffix.test.ts                        # NEW
└── integration/
    ├── video/{ffmpeg-options,formatter,versions-loop,collect}.test.ts          # NEW
    ├── media/{rescan,clean-faststart,video-as-is,video-publish-adapted,video-version-vanished}.test.ts  # NEW
    ├── scheduler/{video-wait,video-stale}.test.ts                               # NEW
    ├── compose/{video-sync,video-edits,video-previews}.test.ts                  # NEW
    └── (extended) media/fit, limits/enforcement, docs/limits-inventory, provider validate/fit suites

scripts/video-smoke.ts                 # --formatter run and SC-007 timing
.github/workflows/ci.yml               # docker job runs the smoke with --cpus=2
docs/{limits,feature-map,adding-a-provider,deployment,meta-setup,decisions}.md, .env.example
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **Pure decision logic in `src/providers/`.** `planVideo` sits next to `planImage`. Web and worker both import it.
- **Tool-running code in `src/server/video/`.** It is worker-only and test-enforced. The pure ffmpeg argument builders live there too, since only the worker uses them.
- **Services in `src/server/services/`.** Scoped repos in `src/server/dal/`. UI in `src/components/compose/`, with pure helpers tested in Node.

## Implementation order (for /speckit-tasks)

1. **Foundation.**
   - The schema and migration, including the `UPDATE`, then `db:check`.
   - `project-owned.ts`.
   - The env setting and `.env.example`.
   - `mediaKeys`.
   - The `createVideoAsset` factory defaults.
   - Existing tests stay green: no behaviour change yet.
2. **Capabilities and facts types.**
   - The new `VideoCapabilities`/`VideoFacts` fields, `assertVideoCapabilities` and `videoLimitsFor`, with registry tests.
   - `videoFieldsOf` carries the new facts.
3. **The planner (pure).**
   - `src/lib/video/edit.ts`, `planVideo`, `previewRecipe`, `videoRecipeKey` and the step words, with the full worked-example tests (contracts/video-planner.md).
4. **The worker's pure builders.** `ffmpeg-args.ts` with `USED_OPTIONS`, `boxes.ts` and the probe extension, with their tests. No tool needed.
5. **Facts in the worker.**
   - `processVideoFile` records the new facts.
   - `clean.ts` adds `+faststart`.
   - The rescan runs in the media loop.
   - With the ffmpeg suites `ffmpeg-options`, `clean-faststart` and `rescan` (CI-proved if there is no local ffmpeg).
6. **Gate integration (US1–US3).**
   - `adaptedMediaFor` and `validateTargetContent` with edits.
   - The edit DAL, schemas and service checks.
   - `checkComposition` with `videos[]`.
   - Then the provider declarations (P24) and suffix removal (FR-032), `fitOf` states, the summary, `limit-rows`/enforcement/inventory and `docs/limits.md` rows.
   - Update the hand-written tests whose expected messages or badges change, listing each.
7. **Versions and the worker loop (US1, US5).**
   - The `video_versions` repos, `encode.ts`, `readback.ts` and `versions-loop.ts`.
   - Wire `src/worker.ts`.
   - The `formatter` and `versions-loop` suites.
8. **Publishing (US5).**
   - `syncVideoVersions` and its callers.
   - `ClaimContext.videoGate` and the `decide()` branch with `video_wait_since`.
   - `resolvePublishMedia` for video; retry, cancel and reschedule clearing.
   - `preparingVideo` in views.
   - The `video-wait`, `video-stale`, `video-as-is`, `video-publish-adapted`, `video-version-vanished` and `video-sync` suites.
9. **Previews and composer UI (US2, US4, US6).**
   - The preview service and actions.
   - `video-edit-ui.ts`, the dialog, the focal point picker and the target preview.
   - Composer state and payloads, fit badges and `RequirementsSummary`.
   - The `video-edits` and `video-previews` suites.
10. **Housekeeping and delete.** `collectVideoVersions` and `deleteMedia`, with the `collect` suite.
11. **Packaging and docs.**
    - `scripts/video-smoke.ts --formatter` and the CI docker step with `--cpus=2`.
    - `docs/deployment.md`: CPU, memory and temp disk; the worker requirement; the exact `.env.example` and optional compose edits (FR-036).
    - `docs/adding-a-provider.md`: declaring limits gets the formatter.
    - `docs/feature-map.md`: the formatter moves to Built, with the unowned list.
    - `docs/meta-setup.md`: the owed live checks.
    - `docs/limits.md`.
    - `docs/decisions.md`: the implementation outcome and the SC-007 figure.
    - `tests/lint/no-video-yet-suffix.test.ts`.
12. **Final pass.** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` once. Then push and confirm on CI that the ffmpeg suites ran and the docker smoke passed (SC-009).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Background work outside `runTick()` (constitution, Engineering Constraints: "Scheduler work lives in runTick(): bounded (well under 30 s)"). This is the same exception 018 recorded for its media loop, extended to a second worker loop. | Encoding a version takes minutes, and `runTick` can run in the web process (HTTP tick, `RUN_WORKER_IN_PROCESS`), where video tools are forbidden (D9). The version loop keeps every scheduler rule: `FOR UPDATE SKIP LOCKED` claims, a lease with a token, bounded attempts, a per-attempt time limit, no storage or provider call inside a held transaction, safe to kill (a lost lease is taken over and partial output is never stored), and safe to run concurrently. The tick itself only reads version state and never waits. | Encoding in `runTick` would run ffmpeg in web and blow the 30 s budget. A queue or Redis is new infrastructure (VI). Slicing an encode across ticks is impossible: ffmpeg cannot pause and resume an encode. |
| A generic change to the publishing engine (the claim-time video gate) rather than provider code (V says no scheduler change *to add a provider*) | Waiting for an adapted file before the first provider call is provider-independent. It must not count attempts or hold leases (US5 #1), and the claim decision is the only place that can defer without either (P13). | Waiting inside `execute()` with `release()` would write an attempt row every tick for up to two hours and set `publishStartedAt` (research, Alternatives). A per-provider wait would duplicate logic four times and break "providers need only capabilities" (FR-034). |
