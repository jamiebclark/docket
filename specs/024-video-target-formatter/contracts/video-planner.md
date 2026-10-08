# Contract: the video planner and capabilities

Covers FR-005–FR-014, FR-030–FR-032, FR-034, FR-037 (pure parts) and FR-038. Types are in [data-model.md](../data-model.md) §5–§6, and decisions in [research.md](../research.md) P1–P9, P18, P19, P24 and P25.

## `planVideo(src, limits, edit, ctx)`: behaviour

The planner is pure and total, and never throws for any input of the declared types. It works in this order:

1. **Facts.**
   - `src.facts.factsVersion === 1` (or absent `factsVersion`, with the item marked as recorded before this entry) gives `checking`, with the note `video_checking`: "Docket is still reading Video 1's details."
   - `factsUnreadable` gives `refuse` with `video_facts_unreadable`: "Docket could not read Video 1's details; upload it again."
2. **Trim** (P4).
   - The kept part is `min(selection, maxDurationSeconds)`.
   - Below `minDurationSeconds`, the planner refuses: "Video 1 is 2 seconds long; an Instagram Reel needs at least 3 seconds." With a trim, the sentence reads "Your selection of Video 1 is 2 seconds long; …".
3. **Shape** (P3.1). The planner works out whether to reframe, and to which shape `t`.
4. **Geometry** (P3.2–P3.5). Crop or pad numbers, the canvas ceiling, the reduction to the maximum, evenness, and refusal below the minimum.
5. **Mode** (P5). Encode, rewrap or original, in that order of tests.
6. **Size floor** (P8). For an encode with `maxBytes`, a budget below 150 kbps refuses: "Video 1 could not be made smaller than 300 MB for an Instagram Reel."
7. **Result.**
   - **Refusals** are collected; any refusal gives `refuse` with all of them.
   - **`derive`** carries the steps in the order cut, crop/pad, resize, frame_rate, reencode | rewrap, with one note per step.
   - **`original`** when nothing applies.

**Non-video limits.** `maxVideos`, `withImages` and `silentAllowed` stay in the validator. The planner never sees post-level counts.

**Notes.** Each note names the platform and type, like the image planner's notes:

| Step | Note (`info`) |
|---|---|
| cut (no trim) | "Video 1 will be cut to the first 1:30 for a Facebook Reel." |
| cut (trim) | "Video 1 will be cut to the first 1:30 of your selection for a Facebook Reel." |
| crop | "Video 1 will be cropped to 9:16 for a Facebook Reel." |
| pad blur | "Video 1 will be padded to 9:16 with a blurred copy for a Facebook Reel." |
| pad colour | "Video 1 will be padded to 9:16 with #ffffff bars for a Facebook Reel." |
| resize | "Video 1 will be resized to 1080×1920 for a Facebook Reel." |
| frame_rate | "Video 1's frame rate will be changed to 60 fps for Threads." |
| reencode | "Video 1 will be re-encoded as H.264 and AAC for Instagram." (only when no other step explains it) |
| rewrap | "Video 1 will be rewrapped as MP4 for Instagram, without re-encoding." |

**Badge words** (`video-labels.ts` `videoStepWords(plan)`) are short: "cut to 1:30", "padded to 9:16 with a blurred copy", "cropped to 9:16", "resized to 1080×1920", "frame rate changed to 60 fps", "re-encoded", "rewrapped".

## Worked examples (each one is a planner unit test)

| Source | Limits | Edit | Plan |
|---|---|---|---|
| 1920×1080, 120 s, 30 fps, H.264/AAC, 48 kHz 2 ch, 12 Mbps, index front, MP4 | Instagram `video` | default | `original` (US1) |
| same | Facebook `reel` | default | `encode`: cut 0–90 000 ms; pad blur; canvas 1920×3413 → ceiling 1080×1920; frame 1080×606 at 0,656 (sides and offsets floored to even); out 1080×1920; steps cut, pad |
| same | Facebook `reel` | crop, focal 0.2 | crop w=608 h=1080 x=80 y=0 (608 is `even(1080·9/16 = 607.5)`; x = clamp(round(0.2·1920 − 304) = 80)); out 608×1080 → below 540×960? 608×1080 ≥ 540×960 ✓ |
| same | Facebook `reel` | crop, focal 0.0 / 1.0 | x = 0 / x = 1312 (touches the edge) |
| 2560×1080 (21:9), 10 s | mock | default | pad blur to 16:9 (the nearest end): canvas long side ≤ max(2560, 1920) = 2560 → 2560×1440 → mock max 1920 → 1920×1080; frame 1920×810 at 0,134 |
| 1080×1920, 40 s | mock | recommended on | `original` (already 9:16 within 0.5%) |
| 360×640, 10 s | Facebook `reel` | default | `refuse` `video_too_small` "Video 1 is 360×640; a Facebook Reel needs at least 540×960." |
| 1280×720, 2 s | Facebook `reel` | default | `refuse` `video_too_short` |
| 1280×720, 600 s, trim 135 000–240 000 | Threads | trim | `encode`: start 135 000, kept 105 000; step cut (a user trim is a cut too); note "Video 1 will be trimmed to 2:15–4:00 for Threads."; badge words "cut to 2:15–4:00" |
| same trim | Facebook `reel` | trim | kept 90 000; step cut, note "… first 1:30 of your selection …" |
| trim 0 to the end exactly | Instagram | trim equal to whole | `original` |
| MOV, H.264/AAC, everything fits, index front | target containers `["mp4"]` | default | `rewrap` to MP4, step rewrap |
| MP4 with index at end | Instagram (`indexAtFront`) | default | `rewrap` MP4 |
| MP4 with index at end | Facebook Page video | default | `original` (no index requirement) |
| HEVC, 50 Mbps | Instagram | default | `encode` (bitrate 50 > 25 Mbps): steps reencode |
| 120 fps | Threads | default | `encode`, `frameRate: 60`, step frame_rate |
| 15 fps | Instagram (min 23) | default | `encode`, `frameRate: 23` |
| VFR 29.97, in range | Instagram | default | `original` |
| 96 kHz, 6 channels | Instagram | default | `encode`, audio 48 000 / 2 / 128 000 |
| silent | Instagram | default | audio `null`, stays silent |
| 900 s at 1080p, 350 MB | Instagram (300 MB) | default | `encode`, `maxBytes 300_000_000`, `maxBitrate min(25e6, floor(300e6·8·0.95/900) − 128e3)` |
| 3840×2160, 900 s, 900 MB | Instagram | default | resize to 1920×1080, encode |
| `facts_version = 1` | any | any | `checking` |
| identical facts and edit, two Instagram accounts | Instagram ×2 | default | same recipe, same `videoRecipeKey` (FR-011, US1 #6) |
| crop vs pad colour with a different colour | same | — | crop key is unchanged by `padColor`; pad key is unchanged by the focal point (P2) |

## Gate integration (P19)

`adaptedMediaFor(tx, caps, platform, assets, { postType, edits, preview })` handles each video item in post order:

- **`original`:** the stored item.
- **`derive`:** `plannedVideoItem(asset, plan)`, an H.264/AAC MP4 with the planned facts (`bytes = min(asset.bytes, maxBytes ?? asset.bytes)`), plus its notes.
- **`checking`:** the stored item, plus the note.
- **`refuse`:** the stored item, plus the errors. The provider's own errors on that field are dropped, as for images.

The post type resolves first: `resolvePostType(caps, kinds, chosen)`. Then `videoLimitsFor(caps, type)` applies. A carousel's videos use the carousel limits (Edge Cases, Instagram carousel).

`validateTargetContent` gains the post's edits (`TargetContent.videoEdits`), loaded by `loadTargetContent` from `post_video_edits`. The composer check passes the unsaved edits instead.

## Fit badges (P18, FR-030)

```ts
export type FitState = "fits" | "converted" | "adapted" | "refused" | "checking";
```

`fitOf(asset, provider)` handles a video like this:

- plan with `DEFAULT_VIDEO_EDIT` for the type a single video resolves to;
- `refuse` → `refused`, with the issue messages ("This video …");
- `checking` → `checking`;
- `derive` → `adapted`, with `steps` set to the step words and `details` set to the notes, plus any provider error on the planned item (→ `refused`);
- `original` → `fits`.

`fit-ui.ts` WORDING adds `adapted: "will be adapted"` and `checking: "checking"`, and TONE adds `adapted: "info"` and `checking: "neutral"`. `fitText` for `adapted` appends `: <steps joined by ", ">`, for example "Instagram: will be adapted: cut to 15:00" (US6 #1).

## Requirements summary (P18, FR-031)

`RequirementsSummary.video` gains `adapts: string[]` and `cannot: string[]`.

- **`adapts`** has one sentence per adaptable declared bound of the shown type, in a fixed order:
  - duration max: "Longer videos are cut to 1:30.";
  - aspect: "Other shapes are padded or cropped to fit 9:16." (the recommended shape, or "to fit 0.01:1 to 10:1");
  - width or height max: "Larger videos are resized to fit 1,920 px wide.";
  - codecs, frame rate, bitrate, audio, container and index: "Other formats are converted to H.264 and AAC MP4."
- **`cannot`** covers bounds Docket cannot meet:
  - min duration: "At least 3 seconds.";
  - min size: "At least 540×960.";
  - silence when `silentAllowed === false`: "Needs audio.";
  - count and mixing: the existing sentences.

`RequirementsSummary.tsx` (via `requirements-ui.ts`) renders "Docket adapts:" and "Docket cannot fix:" lists under the video part. UI code contains no limit literal (`tests/lint/ui-limit-literals.test.ts` stays green).

## Provider messages (FR-032)

The suffix "Docket does not crop, trim or convert video yet." (and Facebook's "Docket does not crop video yet.") is removed from:

- `src/providers/instagram/validate.ts`;
- `src/providers/facebook/validate.ts`;
- `src/providers/threads/validate.ts`.

Each remaining refusal ends at the has/needs sentence plus the type phrase, for example "Video 1 is 2 seconds long; the minimum is 3 seconds for a Facebook Reel." A repository test (`tests/lint/no-video-yet-suffix.test.ts`) fails if the phrase appears anywhere under `src/` or `docs/` outside `docs/decisions.md`.

## Declarations (D7, P24)

| Provider / type | maxVideoBitrate | audioBitrate | maxAudioSampleRate | maxAudioChannels | indexAtFront | recommendedAspectRatio |
|---|---|---|---|---|---|---|
| Instagram (base; carousel inherits) | 25 000 000 | 128 000 | 48 000 | 2 | true | — |
| Instagram `video`, `reel` | (base) | (base) | (base) | (base) | (base) | 9/16 |
| Threads (base) | 100 000 000 | 128 000 | 48 000 | 2 | true | — |
| Threads `video` | | | | | | 9/16 |
| Facebook `reel` | — | 128 000 | 48 000 | 2 | — | 9/16 |
| Facebook Page video | — | — | — | — | — | — |
| mock | 8 000 000 | 128 000 | 48 000 | 2 | true | 9/16 (+ `maxWidth`/`maxHeight` 1920) |

- Each value carries a code comment citing `docs/research/meta-video.md` and its section, or "test double".
- Each one gets a row in `docs/limits.md` (new categories, P25), with "Enforced in" set to `video planner`.

## Registry checks (FR-012)

`assertVideoCapabilities` throws on:

- a new number that is ≤ 0 or not finite;
- `maxAudioChannels` that is not an integer;
- `recommendedAspectRatio` outside the merged `[min, max]` of the block (base or `byPostType[type]`) where it is declared.

`src/providers/registry.test.ts` covers each throw.

## Tests (FR-037, FR-038; no tool run)

- **`src/providers/video-plan.test.ts`** covers every row of the worked-examples table.
  - It also covers each declared bound of every video-publishing provider and type (mock; Instagram video, reel, carousel; Facebook video, reel; Threads video, carousel) with an *as is*, an *adapt* and (where the bound cannot be adapted) a *refuse* case.
  - Plus unknown facts, unreadable facts, a trim equal to the whole video, and identical limits sharing one key.
- **`src/server/media/hash.test.ts`**: the key is stable across field order, changes with `VIDEO_PIPELINE_VERSION`, and differs between `full` and `preview`.
- **`src/providers/requirements.test.ts`** (extended): `adapts` and `cannot` for Instagram, Facebook Reel, Facebook Page video, Threads and the mock.
- **`src/server/services/media-fit.test.ts`** (extended): the `adapted` and `checking` states. US6 #1–#3 wording.
- **`src/providers/{instagram,facebook,threads}/validate.test.ts`** and the integration fit tests: the expected strings lose the suffix (FR-042).
- **`tests/helpers/limit-rows.ts` and `enforcement.test.ts`**: adapt rows and refuse rows (P25).
- **`tests/integration/docs/limits-inventory.test.ts`**: the new categories.
