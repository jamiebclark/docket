# Research: Per-target video formatter

Phase 0 for `specs/024-video-target-formatter/spec.md`. External facts come only from `docs/research/ffmpeg.md` and `docs/research/meta-video.md`; this phase cannot fetch the web. Code facts (F*) were read from the repository on branch `024-video-target-formatter` (base `bab2e89`, entries 017–023 merged). Plan decisions (P*) settle every open point in the spec and in Technical Context.

No item in Technical Context is left as NEEDS CLARIFICATION. Two kinds of fact stay UNVERIFIED by design:

- **Exact ffmpeg option spellings** that `docs/research/ffmpeg.md` marks UNVERIFIED (`-preset` names, `-crf` range, `-maxrate`/`-bufsize` quotes, `boxblur` radius limits, colour syntax, autorotation on re-encode, `-tag:v`). ffmpeg is **not installed on the planning machine** (`which ffmpeg` finds nothing), so they cannot be checked against the tool's own help here. P6 makes the implement phase confirm each one with a CI-only test that reads `ffmpeg -h …` from the installed tool before the builder relies on it (constitution I: "the installed package's own docs").
- **Platform behaviour on adapted files** (that Instagram, Facebook and Threads accept Docket's H.264/AAC MP4). The encode is the research's "safe common encode", so this is low risk. It is covered by mocked tests and listed as owed live checks (FR-043).

## Research check (constitution I)

Every external fact in the spec was compared with the two research files. They agree.

- **`meta-video.md`.**
  - Reel spec: index ("moov atom") at the front, closed GOP, 4:2:0; AAC ≤ 48 kHz, 1–2 channels; VBR ≤ 25 Mbps; audio 128 kbps; 9:16 recommended.
  - Threads: the same rules, with VBR ≤ 100 Mbps and 9:16 recommended.
  - Facebook Reel: AAC 48 kHz stereo "128 kbps+", 9:16, 1080 × 1920 recommended, min 540 × 960. Facebook Page video: nothing stated.
  - "Safe common encode": H.264 High, yuv420p, closed GOP, AAC 48 kHz stereo 128 kbps, 30 fps, MP4 with `faststart`.
- **`ffmpeg.md`.**
  - The filters are verified from source: `crop` (w, h, x, y; centred by default), `pad` (w, h, x, y, `color`, default black), `boxblur` (`luma_radius`, `luma_power`), `overlay` (x/y expressions with `main_w` etc.) and `fps`.
  - Options: `-ss` before `-i` with `-t DURATION` (the research's safest trim); `-movflags +faststart` (a second pass, about 2× the output size on disk); `-fs` truncates and must not be used to fit a size; libx264 needs even dimensions and `yuv420p`.
  - Fixtures come from `lavfi` `testsrc`. Suites skip when the tool is missing.
  - The research recommends computing crop and pad numbers in Node rather than relying on in-filter expressions (`ow`/`oh` and `force_original_aspect_ratio` are UNVERIFIED). The plan follows that (P3, P7).
- **Readings recorded as decisions in the spec**: "Audio bitrate 128 kbps" is the encode target (D7). Facebook's "between 16x9 and 9x16" error text does not widen the declared 9:16.

The brief and the constitution list video as out of scope "until a spec says otherwise". This spec says otherwise for adapting video per target.

## Code facts

- **F1 — The image planner** (`src/providers/media.ts` `planImage`) is pure. It returns `original | derive{steps, output, notes} | refuse{issues}`.
  - `src/server/services/media-variants.ts` wraps it:
    - `planFor` returns `original` for every video;
    - `adaptedMediaFor` serves the gate and the composer (with `preview` standing in for a missing variant);
    - `prepareVariants` runs before the scheduling transaction;
    - `resolvePublishMedia` serves the engine and rebuilds a vanished variant inline (sharp, in the tick).
  - Variants are keyed by `constraintsHash` (`src/server/media/hash.ts`, with `VARIANT_PIPELINE_VERSION`) in `media_variants` (unique `(media_asset_id, constraints_hash)`).
- **F2 — One validator.** `validateAgainstCapabilities` (`src/providers/validation.ts`) checks a ready video item's `video` facts plus `width`/`height`/`bytes` against `videoLimitsFor(caps, postType)`. A null frame rate is never refused.
  - The three provider wrappers append the suffix:
    - `validateInstagram`: "… for an Instagram <type>. Docket does not crop, trim or convert video yet.";
    - `validateFacebook`: the same, plus the Reel aspect "Docket does not crop video yet." and the "Post it as a Page video instead." suggestion;
    - `validateThreads`: "… for Threads. Docket does not crop, trim or convert video yet.".
  - The suffix appears in 8 files across `src`, `tests` and `docs`.
- **F3 — Video facts today.**
  - `media_assets` has `width`, `height` (displayed, rotation applied), `byte_size` (bigint), `duration_ms`, `frame_rate`, `video_codec`, `audio_codec` and `container`.
  - There is no bitrate, sample rate, channel count or index position.
  - `parseProbe` (`src/server/video/probe.ts`) reads `-show_streams -show_format` JSON but drops `bit_rate`, `sample_rate` and `channels`.
  - `videoFieldsOf` (`src/server/media/item.ts`) maps a row to `MediaItem.video`.
- **F4 — Entry 2's worker.**
  - `src/server/video/loop.ts` `processNext` claims one `processing` video with `FOR UPDATE SKIP LOCKED` on `media_assets`. It uses a 120 s lease renewed every 30 s and at most 3 attempts.
  - It works in an `mkdtemp` directory and checks the lease token on every write (`src/server/dal/media-processing.ts`). It cleans up written objects when the asset is deleted or the lease is lost.
  - `src/worker.ts` runs `runLoop(runTick)` and `runMediaLoop` side by side.
  - `runTool` (`spawn.ts`) is the only `child_process` importer. It calls `assertWorkerProcess()`, and `tests/lint/no-ffmpeg-in-web.test.ts` fails if anything the web process loads reaches `src/server/video/`.
- **F5 — Entry 2's clean step** (`clean.ts`) remuxes with `-c copy -map_metadata -1`. It re-applies rotation with `-display_rotation`, falling back to a `rotate` tag, and verifies the output by probing it.
  - It does **not** pass `-movflags +faststart`, so a stored original keeps its index wherever the camera put it (D18).
- **F6 — The publishing engine** (`src/server/scheduler/publishing.ts`).
  - `claimDueTargets` takes `FOR UPDATE SKIP LOCKED` and calls `decide(target, account, ctx)` inside the claim transaction.
  - A decision may set columns and append attempt rows. The publish-limit deferral, for example, sets `nextAttemptAt` and writes a `deferred` attempt row.
  - After the lease, `execute()` calls `resolvePublishMedia` outside any transaction (bounded by `withinBudget`). It then re-validates on the first step (G15), reads credentials and calls `advance`.
  - `release()` gives a lease back uncounted, but writes a `released` attempt row.
- **F7 — Scheduling paths.**
  - `addToQueue`, `scheduleAt`, `publishNow` and `updatePost` (on a media change) call `prepareForScheduling` → `prepareVariants` **before** their transaction, because the slot time is only known inside it.
  - The API's queue and schedule operations call the same.
  - Retry lives in `src/server/services/posts/retry.ts` (`retryTarget`, `retryLockedTarget`) and `retry-all.ts`.
- **F8 — Post media.**
  - `post_media` has PK `(post_id, position)` and unique `(post_id, media_asset_id)`.
  - `PostsRepo.setMedia` deletes and re-inserts every row, so per-video data cannot live on `post_media` without being lost on every save.
- **F9 — Composer.**
  - `Composer.tsx` (client) debounces `POST /p/[slug]/compose/check` → `checkComposition`, which "writes nothing" and returns a `TargetCheck` per account.
  - It polls `mediaProcessingStatusAction` every `MEDIA_POLL_MS` while media is processing.
  - Saving goes through `saveDraftAction` → `createDraft`/`updatePost`. Their zod schemas are `postInputSchema` (shared with the check) plus a patch schema.
  - The public API builds its own body schema (`src/server/api/operations/posts.ts`) and maps it, so new composer fields never reach the API (FR-046).
- **F10 — Fit badges.**
  - `fitOf` (`src/server/services/media-fit.ts`) returns `fits | converted | refused`. `videoFitOf` runs `provider.validate` on the stored item.
  - `fit-ui.ts` words them "fits", "will be converted" and "will be refused".
- **F11 — Requirements summary.** `requirementsOf` (`src/providers/requirements.ts`) is pure. Its `video` part lists every declared bound, with labels from `video-labels.ts`.
- **F12 — Capabilities.**
  - Instagram declares `INSTAGRAM_REEL_VIDEO` as its base, with a carousel override (aspect 0.8–1.91, 10 videos).
  - Facebook declares `FACEBOOK_PAGE_VIDEO` (containers only) with a `reel` override (3–90 s, min 540×960, aspect 0.556–0.569, 24–60 fps).
  - Threads declares `THREADS_VIDEO` with a carousel override.
  - The mock declares 1 video, MP4/MOV, H.264, AAC, 50 MB, 1–60 s, aspect 9/16–16/9 and ≤ 60 fps.
  - `assertVideoCapabilities` runs at registry load.
- **F13 — Limits inventory.**
  - `docs/limits.md` rows are checked against declarations by `tests/integration/docs/limits-inventory.test.ts`, with a fixed category vocabulary.
  - "Enforced in" names the suite that proves each row.
  - `tests/helpers/limit-rows.ts` `videoRows` generates one "refused" row per declared video bound. `tests/integration/limits/enforcement.test.ts` runs them through the real gate.
- **F14 — Test helpers.**
  - `tests/helpers/ffmpeg.ts` `requireFfmpeg()` skips locally and throws in CI.
  - `tests/helpers/video-fixtures.ts` builds clips with `lavfi` at 320×180, 15 fps, ultrafast.
  - `createVideoAsset` (`tests/helpers/factories.ts`) inserts ready video rows with 1280×720, 20 s, 30 fps, H.264/AAC and MP4 defaults, with no ffmpeg.
  - CI installs ffmpeg with apt (Ubuntu). The `docker` job runs `ffmpeg -version`, a `libx264` encoder check and `scripts/video-smoke.ts` inside the built image (Debian bookworm, ffmpeg 5.1).
- **F15 — Housekeeping** (`src/server/scheduler/housekeeping.ts`) runs at the end of every tick, wherever the tick runs (web or worker). It is bounded in batches, and every storage call has a 5 s timeout.
- **F16 — Storage keys** come only from `mediaKeys(projectId, assetId)`: `original.*`, `thumb.webp`, `v/<hash>.<ext>` and `original.mp4|mov`.
  - `deleteMedia` soft-deletes the asset, deletes its variant rows and deletes their objects after commit.
- **F17 — Environment.**
  - `src/server/env.ts` declares `int(min, max, default)` settings. Media settings include `MEDIA_MAX_VIDEO_MB` (≤ 4,096) and `MEDIA_MAX_VIDEO_SECONDS` (≤ 3,600, default 900).
  - Each setting is documented in `.env.example`.
  - The worker loop's interval is `WORKER_INTERVAL_SECONDS` (default 60).
- **F18 — Heartbeats.** `writeHeartbeat(name, at, counts)` stores the last run of each loop in `scheduler_heartbeats` (not project-owned).
- **F19 — The rotated poster.** The poster frame is taken from the cleaned file by decoding, and `makeThumbnail` turns it into `thumb.webp`. Its orientation is the displayed one: the facts' `width`/`height` already have rotation applied, and the 018 suites check this on the rotated fixture.
- **F20 — Local tools.** The planning machine has Docker and Homebrew but no ffmpeg. Unless the implement phase can install ffmpeg (or runs the suites in the built image), every ffmpeg suite skips locally and only CI runs it.

## Decisions

### Planning (the one answer)

- **P1 — One pure planner, `planVideo`, in `src/providers/video-plan.ts`** beside `planImage`.
  - **Input:**
    - a `VideoSource`: the item's facts, including the new ones, plus `factsVersion`;
    - the merged limits from `videoLimitsFor(caps, postType)`;
    - the `VideoEdit`;
    - `{ index, platform, typeLabel }`.
  - **Output:** a `VideoPlan`, with exactly one of four kinds:
    - `original`;
    - `derive { mode: "rewrap" | "encode", steps, recipe, output, notes }`;
    - `refuse { issues }`;
    - `checking { notes }` (facts this entry needs are not recorded yet, FR-010).
  - **Callers.** It is the only code that decides (FR-005). They are:
    - `adaptedMediaFor` (gate and composer);
    - `fitOf` (badges);
    - the composer's per-target video view;
    - the scheduler's claim-time gate (P13);
    - `resolvePublishMedia`;
    - `syncVideoVersions` (P14);
    - housekeeping (P17).
  - The worker builds from the stored recipe, never re-plans, so it cannot disagree with the plan.
- **P2 — A version is identified by its recipe, not by raw limits.**
  - **Recipe.** It is a canonical, fully numeric description of the output:
    - `mode`;
    - the container;
    - trim start and kept duration in ms;
    - the frame operation: `none`, `crop{x,y,w,h}`, or `pad{canvasW, canvasH, frameW, frameH, x, y, fill: "blur" | "#rrggbb"}`;
    - the output width and height;
    - the output frame rate, or null for unchanged;
    - the video rate caps `{maxBitrate|null, maxBytes|null}` and the size floor `{minWidth, minHeight}`;
    - audio `{sampleRate, channels, bitrate}` or null;
    - `indexAtFront`.
  - **Key.** `videoRecipeKey(kind, recipe)` is `sha256(JSON.stringify([VIDEO_PIPELINE_VERSION, kind, canonical recipe]))` in `src/server/media/hash.ts`.
  - **What follows.**
    - Two targets with identical limits and the same edit always share a version (D8, FR-011).
    - Targets whose different limits produce the same output also share.
    - An edit field that does not change the output (the focal point when padding, the pad colour when cropping) does not rebuild.
    - Bumping `VIDEO_PIPELINE_VERSION` rebuilds everything ("the formatter's output changes").
  - **Stale results.** A result built for an old edit lives under the old key, so the new edit's lookup never finds it (FR-023 by construction). Stale versions are collected by P17.
- **P3 — Geometry, in integers, computed in Node** (research §4.4–4.5). `W×H` is the displayed source size; `a = W/H`.
  1. **Target shape `t`** (D2). A reframe happens when `a` is outside `[min, max]` (ε = 1e-9), or when the edit asks for the recommended shape and the limits declare `recommendedAspectRatio`.
     - `t` is the recommended shape when it is declared and inside the range; otherwise `clamp(a, min, max)`.
     - A reframe whose `|t − a| ≤ 0.005·a` is no reframe. This rounding tolerance keeps a 1080×1920 clip from being "reframed" to 0.5625.
  2. **Crop** (D3).
     - If `t < a`, `cw = even(round(H·t))` and `ch = H`; otherwise `cw = W` and `ch = even(round(W/t))`.
     - `x = clamp(round(fx·W − cw/2), 0, W − cw)` and `y = clamp(round(fy·H − ch/2), 0, H − ch)`, made even.
     - The kept area never leaves the frame, and a focal point at an edge makes the area touch that edge (US2 #1–#2).
  3. **Pad** (D3, D4).
     - The canvas is the smallest of shape `t` containing the frame at source size: if `t < a`, `(W, round(W/t))`; otherwise `(round(H·t), H)`.
     - **Canvas ceiling:** the canvas's long side is limited to `max(source long side, 1920)`, which reduces canvas and frame together.
     - The frame is centred: `x = (cw − fw)/2` and `y = (ch − fh)/2`, made even.
     - *Why the ceiling:* D4 allows a canvas larger than the source in one direction. Without a bound, a 1920×1080 clip padded to 9:16 would be 1920×3413, about three times the pixels of the platforms' recommended 1080×1920, with no benefit and a large size and encode cost. The bound keeps D4's guarantee: the picture is never enlarged, and a small source still gets a canvas larger than itself (a 640×360 clip becomes 640×1138 and meets Facebook's 540×960). Recorded in decisions.
  4. **Reduce** to the limits' `maxWidth`/`maxHeight` by one uniform factor ≤ 1. Then make each side even with `floor(x/2)·2`, at least 2. Without a reframe, the output is the source reduced the same way.
  5. **Too small** (D4). If the output is below `minWidth`/`minHeight`, refuse `video_too_small`: "Video 1 is 360×640; a Facebook Reel needs at least 540×960." The picture is never enlarged.
  6. **Re-encode or not.** A video that is not reframed, not reduced and of odd size goes as is when nothing else requires a re-encode. If it is re-encoded for another reason, its size is made even (down by 1 px), with no "resize" step and no "resize" note.
- **P4 — Trim** (D5).
  - **The edit.** It stores `trimStartMs` and `trimEndMs | null`. Both are multiples of 100 ms. `null` is the end of the video.
  - **No trim.** `start = 0` and `end` null, or `end ≥ durationMs − 50`, is treated as no trim (Edge Cases).
  - **Kept part.** `keptMs = min(end − start, maxDurationSeconds·1000)`.
    - When the maximum cuts it, add a `cut` step. The note reads: "Video 1 will be cut to the first 1:30 of your selection for a Facebook Reel." With no trim, it reads "… cut to the first 1:30 …".
    - `keptMs < minDurationSeconds·1000` refuses `video_too_short`, using the selection's length and the minimum (US3 #3).
  - **Any trim or cut re-encodes** (D5): `-ss <start> -i <src> -t <kept>` (research §4.6).
- **P5 — As is, rewrap or re-encode** (D6). Decided in this order.
  1. **Encode** when any of these holds:
     - there is a trim or cut;
     - there is a reframe or a reduction;
     - the video codec is not allowed;
     - the audio codec is not allowed;
     - the frame rate is outside `[minFrameRate, maxFrameRate]`;
     - the effective video bitrate is above `maxVideoBitrate`;
     - the audio sample rate is above `maxAudioSampleRate`;
     - the audio channels are above `maxAudioChannels`;
     - the bytes are above `maxBytes`.
  2. **Rewrap** when none of those holds, but the container is not allowed, or `indexAtFront` is required and the file's index is not at the front.
     - The output container is the source's when it is allowed, otherwise MP4.
     - The target must accept the chosen container; otherwise refuse. No current provider lacks MP4.
     - A rewrap reuses entry 2's verified remux (`clean.ts`): `-c copy`, rotation re-applied, plus `-movflags +faststart`. A rewrap never changes codecs, duration or dimensions (US1 #5).
  3. **Otherwise as is**: the stored original, byte for byte (FR-009, FR-026, FR-040).
  - **Effective video bitrate.** It is the stream's `bit_rate` when ffprobe reports one. Otherwise it is the format bitrate minus the audio bitrate, otherwise `bytes·8/duration`. That last value is an upper bound, so the rule never assumes a fit.
  - **Silence.** A silent source stays silent (`-an`), and a target that forbids silence keeps refusing it.
- **P6 — Encode settings** (FR-018; research §4.2, §4.7, §4.8; the meta-video "safe common encode").
  - **Video:** `-c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 23`, with a keyframe every 2 s (`-g`) and closed GOPs.
  - **Caps:** `-maxrate <cap> -bufsize <2·cap>` only when a cap exists.
  - **Frame rate:** an `fps=<n>` filter only when the source is outside the range, to the nearest limit. A variable frame rate inside the range is kept.
  - **Audio:** `-c:a aac -b:a <audioBitrate|128k> -ar <min(src, maxAudioSampleRate|48000)> -ac <min(src, maxAudioChannels|2)>`.
  - **Container:** `-movflags +faststart -f mp4`.
  - **Readback.** The output is 8-bit 4:2:0, so HDR and 10-bit sources are converted with no tone mapping (Edge Cases). Rotation is applied by decoding, and the readback (P11) catches a decoder that did not autorotate (UNVERIFIED in research §4.2).
  - **Spellings.** Every option spelling the builder uses is listed once in `src/server/video/ffmpeg-args.ts` as `USED_OPTIONS`. A CI-only test (`tests/integration/video/ffmpeg-options.test.ts`, `requireFfmpeg()`) asserts that each appears in the installed tool's help: `ffmpeg -h encoder=libx264`, `-h encoder=aac`, `-h filter=crop|pad|scale|boxblur|overlay|fps|split|setsar|format`, `-h muxer=mp4`. That is how the research's UNVERIFIED items are confirmed (research §6 items 1, 3).
  - *Why `veryfast`:* it bounds CPU time on a small home server. Size is controlled by `-maxrate`/`-bufsize` and P8, not by the preset.
- **P7 — Blurred pad graph** (research §4.3), with numbers computed in Node:
  - the background is split off, scaled to cover a quarter-size canvas, cropped to it, and blurred with `boxblur=luma_radius=r:luma_power=2`, where `r = max(1, min(10, floor(min(bw, bh)/4)))` stays inside boxblur's radius limit;
  - it is then scaled up to the canvas;
  - the foreground is scaled to `fw×fh` and overlaid at `x:y`;
  - finally `setsar=1,format=yuv420p`.
  - A colour pad is `scale=fw:fh,pad=cw:ch:x:y:color=0xRRGGBB,setsar=1,format=yuv420p`. Crop is `crop=w:h:x:y,scale=ow:oh,…`.
  - In every case `fps=` comes first when it applies.
  - `src/server/video/ffmpeg-args.ts` builds them all as pure functions (FR-037). It is under `src/server/video/`, so the web process cannot import it, and it needs no tool to test.
- **P8 — Size fitting** (D14, FR-019).
  - **Plan time.** For a target with `maxBytes`, `budget = floor(maxBytes·8·0.95 / keptSeconds) − audioBitrate`, capped at `maxVideoBitrate`. Below a floor of 150 kbps, the planner refuses: "Video 1 could not be made smaller than 300 MB for Instagram." This catches hopeless cases before scheduling.
  - **Build time.** The worker encodes with `-maxrate budget`.
    - If the output is over `maxBytes`, it retries at `bitrate·(maxBytes/actual)·0.9`, at most twice.
    - It then reduces the resolution to 0.75× (even, never below the minimum) once more.
    - At most 4 encodes per attempt; then it fails with the same sentence.
    - `-fs` is never used.
- **P9 — New facts and old videos** (FR-014, FR-014a, FR-010).
  - **Columns.** `media_assets` gains `video_bitrate`, `audio_bitrate` (bits/s, bigint), `audio_sample_rate`, `audio_channels`, `index_at_front` (boolean), `facts_version` (smallint) and `facts_attempts`.
  - **Recording.** `parseProbe` also reads `bit_rate`, `sample_rate` and `channels`. A new pure box walker (`src/server/video/boxes.ts`) reads only the top-level ISO-BMFF box headers of the file: whether `moov` comes before the first `mdat`. New videos get `facts_version = 2`.
  - **Migration.** The column default is 2, and the migration sets every existing video row to 1. Rows the old pipeline made are marked unknown, and rows inserted afterwards (including test factories) are current.
  - **Rescan.** The media loop claims `kind='video' AND processing_state='ready' AND facts_version < 2 AND facts_attempts < 3` only when no `processing` row is waiting. Used videos go first. It reuses the `processing_lease_*` columns, which are idle on a ready row, and the same token-guarded writes.
    - It downloads the stored original and probes it. It records the facts and sets the version to 2 **without rewriting the stored file** (FR-014a).
    - After 3 failed reads, the planner refuses: "Docket could not read this video's details; upload it again."
  - **Until then,** the planner answers `checking` (badge "checking", composer "Docket is still reading this video's details."). The gate treats it as a note, not an error, and the claim-time gate waits on it like a version (P13).
- **P10 — Video edits live in `post_video_edits`** (D1, F8): one row per `(post_id, media_asset_id)`.
  - It is not on `post_media`, which is rewritten on every save.
  - `setMedia` deletes the edits of assets no longer attached. No row means the default edit (whole video, blurred pad, black, centre, recommended shape off).
  - Generated, bulk and API posts therefore get the default with no write.

### Building (worker)

- **P11 — `video_versions`: one table for full versions and previews** (`kind = 'full' | 'preview'`). Unique `(media_asset_id, kind, key)`.
  - **States:** `queued → building → ready | failed`, with `attempts ≤ 3`, `lease_until`/`lease_token`, `error`, `due_at`, `requested_at`, `checked_at`, the frozen `recipe` (jsonb), `steps`, the stored object's key and URL, and the probed output facts.
  - **Readback** (D13) probes the output and checks:
    - the container;
    - the codecs (`h264`, and `aac` or none);
    - width and height equal to the recipe;
    - duration within 100 ms of `keptMs`;
    - frame rate inside the limits;
    - bytes ≤ `maxBytes`;
    - stream bitrate ≤ `maxVideoBitrate`;
    - the index at the front when required.
  - A mismatch is a failed attempt, and nothing is stored (FR-021).
- **P12 — The worker loop.** `runVideoVersionLoop` (`src/server/video/versions-loop.ts`) runs beside the two existing loops in `src/worker.ts`, with `VIDEO_ENCODE_CONCURRENCY` lanes (1–4, default 1, FR-017).
  - **Claim.** Each lane claims with `FOR UPDATE SKIP LOCKED`, ordered by `due_at ASC NULLS LAST, created_at` ("due soonest first"). A preview's `due_at` is the moment it was requested, so a preview requested now runs before a version for a post due tomorrow, and after an overdue one.
  - **Lease.** 120 s, renewed every 30 s, as in F4. `attempts > 3` → `failed`.
  - **Time limit per attempt.**
    - Full: `min(60 min, 120 s + 2 s per kept second)`.
    - Preview: `min(15 min, 60 s + 0.5 s per kept second)`.
  - **Writes.**
    - The worker writes to a local temp file. It uploads to the final key only after the readback.
    - It marks `ready` only while it still holds the lease and the asset is live.
    - Otherwise it deletes what it uploaded (FR-016, Edge Cases "deleted while building", US5 #5).
    - A killed worker's lease expires and another lane starts from scratch. Partial files are local and never stored.
  - **Failures** get a plain reason:
    - "Docket could not read the video.";
    - "The original video is no longer available.";
    - "Video tools are not installed in the worker.";
    - "Media storage is not set up.";
    - "The video could not be made smaller than … for …";
    - "Adapting the video took too long.".
  - **Heartbeat.** The loop writes a `video` heartbeat at most once a minute (F18), so the tick can tell whether any worker is adapting video (P13).
- **P13 — The scheduler's claim-time video gate** (D11, FR-024, FR-025, FR-027).
  - **Where.** In `decide()`, on the **first step only** (`stepState === null`), after the account checks and before the publish-limit deferral. `ClaimContext.videoGate(target, provider)` reads, inside the claim transaction:
    - the post's video assets;
    - their edits;
    - the chosen post type;
    - the matching `video_versions` rows.
  - It plans each video with `planVideo` (pure), so no tool or storage call is made (SC-004).
  - **Answers:**
    - **ready**, every video `original` or its full version `ready` → the lease proceeds as today;
    - **waiting**, a version `queued`/`building`/missing (a missing row is inserted `queued`, due now), or a `checking` plan → the patch is `nextAttemptAt = now + 60 s` and `videoWaitSince = videoWaitSince ?? now`, with **no attempt row** (US5 independent test "no attempt is recorded") and no lease. The status stays `scheduled`. The UI shows "Preparing video for <platform>" from `videoWaitSince`;
    - **failed**, a version `failed` → status `failed` with `lastError` "The video could not be adapted for <platform>: <reason>", plus one `fatal_error` attempt row on step `engine-video`;
    - **too long**, waiting and `now − videoWaitSince > 2 h` → failed in the same way with "… it took too long." When no `video` heartbeat is younger than 10 minutes, the reason is instead "… video adapting needs the worker process, which is not running." (Edge Cases, "host with no separate worker").
  - **Planner refusals** (a capability lowered after scheduling) still fail through the existing G15 re-check in `execute()`, with the provider's wording.
  - **Lost object.** `resolvePublishMedia` uses a ready version's URL and probed facts. When the object has vanished, it marks the version `queued` again and calls `release()`. This rare path records one `released` attempt row and never builds in the tick (D10, FR-022). A version is never built in the tick.
  - Image handling is unchanged.
- **P14 — `syncVideoVersions(scope, postId, { requeueFailed })` queues full versions** (D10, FR-022).
  - **What.** It upserts a `queued` full version for every `(video, target)` whose plan is `derive`, for targets in `scheduled` or `publishing` status, with `due_at = least(due_at, scheduledAt)`. With `requeueFailed`, `failed` rows go back to `queued` with 0 attempts.
  - **When.** It runs **after** the transaction commits, in:
    - `addToQueue`, `scheduleAt` and `publishNow` (`requeueFailed: true`);
    - `updatePost` (edits, media or targets changed);
    - `retryTarget`, `retryLockedTarget`'s callers and `retryAllFailed` (`requeueFailed: true`).
  - The API operations and the generation `add_to_queue` path reach it through those services.
  - Drafts get no full versions.
  - It is best effort. P13's claim-time insert heals any miss (a crash between the commit and the sync).
  - It runs after the commit because the slot time is only known inside the scheduling transaction (F7).
- **P15 — The two-hour clock is `post_targets.video_wait_since`.**
  - It is set on the first wait.
  - It is cleared by retry, requeue, cancel, rescheduling and the lease (publishing starts).
  - "Two hours after the target fell due" is measured from the first tick that found it due and waiting, which is within one tick of falling due.

### Previews, cleanup and UI

- **P16 — Previews** (D12, FR-028, FR-029).
  - **When a preview row is made.** Only for `derive` plans with mode `encode`.
    - A `rewrap` target shows the original, marked "rewrapped as MP4 (no visible change)": its streams are identical.
    - An `original` target shows the original, marked "fits as is".
  - **Recipe.** The preview recipe is the full recipe scaled so its long side is ≤ 640 px (even). It keeps the full recipe's trim, frame operation and audio. The frame rate is capped at 30, with no byte fitting, CRF 30 and `-maxrate 1M`.
  - **Composer view.** `checkComposition` (still writing nothing) adds `videos: VideoTargetView[]` to every `TargetCheck`. Each entry carries the plan's kind, steps, words and planned duration and size, the preview key, and any existing preview row's state and URL.
  - **Requesting.** `requestVideoPreviewsAction` (editor or above) upserts `queued` preview rows for the current composer state, including an unsaved edit, with `due_at = now`. `retry: true` resets `failed` rows. The composer calls it when the preview panel opens and, debounced, when an edit changes.
  - **Polling.** `videoPreviewStatusAction` polls every 2 s while any is preparing.
  - **Shared and replaced.** Previews are shared by key (US4 #4). A changed edit means a new key, so the old preview is simply no longer shown (US4 #2).
  - **Not a gate.** Scheduling never reads preview rows (US4 #3).
- **P17 — Cleanup** (D16, FR-033) runs in housekeeping and needs no ffmpeg.
  - **Batch.** Each tick takes at most 20 `video_versions` rows that are not `building`, with `checked_at` and `requested_at` older than 24 h (null first).
  - **Wanted.** For each, it recomputes the keys wanted by every post that uses the asset (`postsUsing`): for every target of those posts, the full key and the preview key of its current plan, whatever the target's status.
  - **Wanted rows** get `checked_at = now`. Others are deleted, then their object, with a 5 s timeout, as F15.
  - **Deleting a video** deletes its rows and objects with it (`deleteMedia`, F16).
  - The 24-hour grace keeps previews of unsaved composer edits alive while someone is still working.
  - A removed version is rebuilt when a failed target is retried (P14).
- **P18 — Badges, summary and messages** (D15, FR-030–FR-032).
  - **Fit state.** `FitState` gains `adapted` ("will be adapted") and `checking` ("checking"). `converted` stays for images, with its wording unchanged.
  - **Video fits.** `fitOf` for a video plans the default edit with the post type a single video gets. `adapted` lists the steps' words, for example "will be adapted: cut to 15:00".
  - **Summary.** `RequirementsSummary.video` gains `adapts: string[]` and `cannot: string[]`, written from capabilities:
    - adapts: "Longer videos are cut to 1:30.", "Other shapes are padded or cropped to 9:16.", "Larger videos are resized to fit 1,920 px.", "Other codecs and frame rates are converted to H.264 at 24 to 60 fps.";
    - cannot: "Videos must be at least 3 seconds long.", "Videos must be at least 540×960.".
    - `RequirementsSummary` renders both lists.
  - **Suffix removed** from all three provider wrappers (F2), including Facebook's Reel aspect sentence. Remaining refusals keep the has/needs wording.
  - **Step words** live in one place, `src/providers/video-labels.ts`: cut, cropped, padded, resized, frame rate changed, re-encoded, rewrapped.
- **P19 — The gate's view of a video plan.**
  - `derive` adds its notes (severity `info`) and the **planned** item: H.264/AAC MP4 with the planned size, duration, frame rate and `bytes = min(source, maxBytes)`. The provider's own validation sees what will be published, as images do.
  - `checking` adds an `info` note and the planned item when it can be planned, else the stored item.
  - `refuse` adds errors.
  - Missing versions never fail the gate, because versions are built after scheduling. This differs from images, whose missing variant is `variant_failed`.
- **P20 — The composer edit UI** (FR-002, FR-003, constitution accessibility, `docket-ui` skill).
  - **Opening the dialog.** Each attached video gets an "Edit video" button that opens a `Dialog`.
  - **Trim.** Start and end fields in `m:ss.s` use pure parse and format helpers (`src/lib/video/edit.ts`). An invalid entry shows a field error and keeps the previous edit.
  - **Fit.** A `SegmentedControl` offers "Pad with a blurred copy", "Pad with a colour" and "Crop".
    - A colour field (an `input type="color"` with a text twin) is shown for colour pad.
    - A "Use each platform's recommended shape" checkbox sits below.
  - **Focal point picker.** The poster image is overlaid with a focusable marker (`role="slider"`-like two-axis control, with an `aria-label` and `aria-valuetext` such as "20% across, 50% down").
    - Pointer click or drag sets it.
    - Arrow keys move it by 5% (Shift + arrow: 1%), and Home centres it.
    - Changes are announced through `LiveRegion`.
    - Its note says it is used when cropping.
  - **Preview panel.** Each target card gets a "Preview" disclosure showing state text and a `<video controls>` element, with duration, size and steps, and "Retry" on failure.
  - **Saving.** Edits travel in the composer state as `videoEdits: Record<mediaId, VideoEdit>`. They are sent with the check and with saves (`postInputSchema.videoEdits`, optional, default `{}`), so the public API never sees them (F9).
- **P21 — The edit is validated on the server** (FR-003, FR-004).
  - **Shape.** A zod `videoEditSchema`: integer ms, multiples of 100, ≥ 0; the end null or above the start; the fit an enum; the colour `#rrggbb`; the focal values in 0..1; a boolean.
  - **Against the video**, in `createDraft`/`updatePost`/`checkComposition`: the end within the video's duration, the kept part at least 1 s, and only for a video actually attached.
  - **Who.** Editing requires `post: ["edit"]` (owner, admin, editor) and is refused once publishing has started. These are the existing `updatePost` rules.

### Configuration, docs and tests

- **P22 — The only new setting is `VIDEO_ENCODE_CONCURRENCY`** (int 1–4, default 1), read by the worker. The exact `.env.example` edit is in quickstart.md and must be quoted in the PR and in `docs/deployment.md` (FR-036).
  - **No `docker-compose.yml` change is required.** Temp disk per encode is about the source plus twice the output (research §3.5), so up to about 3 GiB for a 1 GiB source. The optional `/tmp` volume edit already documented in `docs/deployment.md` §3 is restated with the new figure.
  - **No new npm dependency, image package or infrastructure** (ffmpeg with libx264 and the native AAC encoder is already in the image; CI checks `libx264`).
- **P23 — D18 in `clean.ts`.** `remux` gains `-movflags +faststart` (mp4 and mov muxers), so every original stored from now on has its index at the front. The existing 018 clean and verification tests keep passing. New tests assert `index_at_front = true` on a fixture made with its index at the end.
- **P24 — Declarations** (D7, FR-013).
  - **Instagram** (base and carousel): `maxVideoBitrate 25_000_000`, `audioBitrate 128_000`, `maxAudioSampleRate 48_000`, `maxAudioChannels 2`, `indexAtFront true`. `byPostType.video` and `byPostType.reel` add `recommendedAspectRatio 9/16`, not the carousel, whose range excludes it.
  - **Threads**: `100_000_000`, 128 kbps, 48 kHz, 2 channels, index at front, and `byPostType.video.recommendedAspectRatio 9/16`.
  - **Facebook `reel`**: 128 kbps, 48 kHz, 2 channels, and `recommendedAspectRatio 9/16`, which lies within 0.556–0.569. Page video declares none of them.
  - **The mock**, a full small set: `maxVideoBitrate 8_000_000`, 128 kbps, 48 kHz, 2 channels, `indexAtFront true`, `maxWidth 1920`, `maxHeight 1920` and `recommendedAspectRatio 9/16`, plus its existing limits.
  - **`assertVideoCapabilities`** refuses non-positive values and a `recommendedAspectRatio` outside the merged range of the block it is declared in.
  - **The factory.** `createVideoAsset` gains fitting defaults for the new facts (2 Mbps, 128 kbps, 48 kHz, 2 channels, index at front, facts version 2), so every existing test that uses it keeps its as-is outcome.
- **P25 — Enforcement rows and `docs/limits.md`** (FR-013, FR-042).
  - **The new categories** (`video max bitrate`, `audio bitrate`, `audio max sample rate`, `audio max channels`, `video recommended aspect`, `index at front`, each also per post type) join the inventory vocabulary.
  - **Split rows.** `videoRows` now splits each declared bound into a *refuse* row for bounds the formatter cannot meet:
    - too short;
    - too small;
    - too many videos;
    - video with images;
    - silence required.
  - **Adapt rows** cover the rest: too long, too big, aspect, frame rate, codecs, container, bytes, bitrate, audio and index. Each asserts the plan's `derive` with the expected step through the real gate (no error) and the planned item's facts.
  - **"Enforced in"** becomes `video planner` for adapt rows, and that suite is added to `suitesFor`.
  - **Why this is allowed.** Semantics change for these generated rows only. SC-001 requires that what was refused is now adapted. FR-042's "changed only where a message loses the suffix or a badge's wording changes" is read as applying to hand-written tests. Every hand-written test that asserted a now-adaptable refusal is updated, and each such change is listed in the tasks.
- **P26 — CI.**
  - The existing `test` job's apt ffmpeg runs the new worker suites, which cannot skip in CI (F14).
  - The `docker` job's `video-smoke` gains a formatter run: pad, crop and trim of a generated 30 s 1080×1920 clip to the mock's limits, with readback, and a preview whose time is printed. It runs as `docker run --cpus=2 …` for SC-007's two-core measurement. The result is recorded in `docs/decisions.md` in the implement phase; a miss is reported.
- **P27 — Owed and unowned.**
  - **Owed live checks** in `docs/meta-setup.md` (FR-043): an adapted Instagram Reel and Feed video, an adapted Facebook Reel, an adapted Threads video, a padded and a cropped version, and a trimmed version.
  - **Unowned, recorded in `docs/feature-map.md`** (FR-044, FR-046):
    - burned-in captions, subject-tracking crop and per-platform cover frames;
    - per-target edits;
    - API video edit fields;
    - generator video;
    - HDR tone mapping;
    - enlarging;
    - joining, splitting, speed, filters and audio replacement;
    - adding a silent track;
    - matching carousel items to the first item's shape.
  - **Owned elsewhere:** Bluesky video (entry 7) and TikTok (entry 8), which get the formatter by declaring limits (`docs/adding-a-provider.md`).

## Alternatives considered

- **Key versions by `(asset, constraints hash, edit hash)` like images.** Rejected for P2: the recipe key shares strictly more, and it makes a result for a stale edit unreachable without extra bookkeeping. It is still a function of the video, the limits and the edit, as D8 states.
- **Wait for versions in `execute()` with `release()`.** Rejected for P13: every tick would write a `released` attempt row for up to two hours (about 120 rows per target). It also sets `publishStartedAt` and `firstStepAt` and holds a lease, which violates US5 #1 ("no attempt used") and skews publish-limit counting.
- **Build versions in `prepareForScheduling` like variants.** Rejected: an encode takes minutes, and `prepareForScheduling` runs in the web process, where ffmpeg is forbidden (D9, F4).
- **A job queue or Redis.** Rejected (constitution VI). Postgres `FOR UPDATE SKIP LOCKED` leases already run entry 2's loop.
- **Store edits on `post_media`.** Rejected (F8): `setMedia` rewrites the rows on every save.
- **An unbounded padded canvas** (D4's literal "may be larger"). Rejected for P3's ceiling (cost and size; see P3.3).
- **A preview of every target, including rewraps.** Rejected for P16: a rewrap is visually identical, and encoding it would cost CPU for nothing.
- **Re-encode videos whose new facts are unknown** instead of `checking`. Rejected: FR-010 forbids assuming, and a rescan is cheap (P9).
- **Two-pass encoding for exact size.** Rejected: UNVERIFIED in research §4.7, and slower. P8's bounded retry is the research's recommended pattern.
- **`-fs` to cap size.** Rejected by the research: it truncates.
