# Contract: Threads video capabilities, validation, summary and badges

Covers FR-001–FR-005, FR-018–FR-020 and US4. The declaration is in [data-model.md](../data-model.md) §1.

## 1. Declaration

- `threadsCapabilities.video` is `THREADS_VIDEO` plus two `byPostType` entries:
  - `video`: notes only;
  - `carousel`: `maxVideos: 20`, `withImages: true`, a note.
- `postTypes` gains `video`.
- There are no `postTypeChoices` (D1) and no `creationAllowance` (D11).
- The publish limit stays 250 / 86,400 s. A video post or a carousel counts once (it is one target).
- No other provider's declaration changes (FR-029).

## 2. Validation (`validateThreads`, shared by the composer check, the scheduling gate and the engine's G15 re-check)

Inputs and outputs are the same as today: `(PostContent, ProviderCapabilities) → ValidationIssue[]`.

1. **Image planner loop.** The loop runs only for items with `kind !== "video"`. Image notes and refusals are unchanged.
2. **Shared issues pass through, except:**
   - `mime_not_allowed` and `file_too_large` on adaptable images are dropped (today's rule).
   - Every `video_*` code except `video_not_accepted` is rewritten:
     `message = shared.replace(/\.$/, "") + " for Threads. Docket does not crop, trim or convert video yet."`
     The code, field, count and limit are kept.
3. **Mixed total.** Raise this when the post has at least one image, at least one video and more than `THREADS_MAX_ITEMS` items:
   ```ts
   { severity: "error", code: "too_many_items", field: "media", count: n, limit: 20,
     message: `The post has ${n} items; a Threads carousel holds at most 20 images and videos together.` }
   ```
4. Nothing is cropped, padded, trimmed, resized or re-encoded, and no video note ("will be converted") is ever produced (FR-003, FR-019).

### Expected issues (each with no Threads request)

| Content | Codes (errors) | Message contains |
|---|---|---|
| 1 video, 360 s | `video_too_long` | "6 minutes long; the limit is 5 minutes for Threads. Docket does not crop, trim or convert video yet." |
| 1 video, 1,050,000,000 B | `video_too_large` | "1.05 GB; the limit is 1 GB for Threads" |
| 1 video, 2,560 px wide | `video_too_big` | "2560 px wide; the limit is 1920 px" |
| 1 video, VP9 | `video_codec_not_allowed` | "VP9; allowed video codecs are H.264, HEVC" |
| 1 video, Opus audio | `audio_codec_not_allowed` | "Opus audio" |
| 1 video, 15 fps / 120 fps | `video_frame_rate_too_low` / `video_frame_rate_too_high` | "the minimum is 23 fps" / "the limit is 60 fps" |
| 1 video, aspect 0.009 or 10.001 | `video_aspect_out_of_range` | "allowed is 1:100 to 10:1" |
| 1 video, no audio | none | — |
| 1 video, frame rate unknown | none on frame rate (G21) | — |
| 1 video, 300.0 s, 1e9 B, 1920 px, aspect 0.01 / 10, 23 / 60 fps | none (inclusive) | — |
| 1 video, 300 px wide | none (the image planner no longer runs on video) | — |
| 1 video with alt text of 2,000 characters | none (`alt_text_too_long` is for images only, D4) | — |
| image, video, image (item 3 is 120 fps) | `video_frame_rate_too_high` on `media.2` only | "Video 3 is 120 fps" |
| 20 items mixed | none | — |
| 21 items mixed (11 images, 10 videos) | `too_many_items` | "21 items" |
| 21 images | `too_many_images` (as today; no `too_many_items`) | — |
| 21 videos | `too_many_videos` (no `too_many_items`) | — |
| a video still processing / failed in Docket | `media_processing` / `media_failed` (entry 2, unchanged) | — |
| existing image and text cases in `validate.test.ts` | unchanged | — |

## 3. Requirements summary (generic fixes P2, P3)

- **P2.** `requirementsOf(caps, ctx)` sets `video.postType` only when `caps.postTypeChoices` has at least one entry. Before, a `byPostType` entry also turned it on.
  - Instagram and Facebook: unchanged (`src/providers/requirements.test.ts` cases stay green).
  - Threads: `postType: null`. The summary has no "Post as" row, and the video gist starts "Video:".
- **P3.** `videoBytesLabel(n)`:
  - `n ≥ 1_000_000_000` → `${Number((n / 1e9).toFixed(2))} GB`;
  - else today's MB label.
  - Tests: 1e9 → "1 GB", 1.05e9 → "1.05 GB", 300e6 → "300 MB", 50e6 → "50 MB".
- **Threads output** is in data-model §7.
  - The composer's gist line reads: "Video: MP4, MOV, H.264, HEVC, AAC, up to 1 GB, up to 5 minutes, aspect 1:100 – 10:1, 23 fps – 60 fps, not with images". The exact order is that of `videoGist`.
  - The carousel line reads: "Carousel: up to 20 items; images and videos may be mixed; video items 1:100 – 10:1; A carousel holds 2 to 20 items, images and videos counted together."
  - Every value comes from the declaration on the server, so no literal is added to UI code (FR-018).

## 4. Fit badges

There is no code change. `videoFitOf` uses `validateThreads` on a single video, so its result is `fits` or `refused` with the §2 messages, with "Video 1" replaced by "This video". It is never `converted` (FR-019). Test: a Threads account in `tests/integration/media/` or the existing fit test file's pattern, in a **new** test file `tests/integration/threads/video-fit.test.ts`, with one fitting and one 120 fps video.

## 5. Enforcement rows (generic fix P6)

- **Change.** In `tests/helpers/limit-rows.ts` `videoRows`, the condition for the base `videos` and `video with images` rows becomes `!choice && !caps.video.byPostType?.carousel`.
- **Threads rows generated.** `threads: video codecs`, `audio codecs`, `video bytes`, `max duration`, `video max width`, `video min aspect`, `video max aspect`, `min frame rate`, `max frame rate` and `carousel videos`.
  - The carousel row has 21 videos, so the draft stops at the core: Docket's 10-item cap (P5).
  - The `video` notes-only override yields no row.
- **Unchanged.** Mock, Instagram, Facebook, Bluesky and X rows.

## 6. `docs/limits.md` and its inventory test

The rows are listed in data-model §6. `tests/integration/docs/limits-inventory.test.ts` must pass with them. If it derives expected rows from `byPostType`, it must ignore a notes-only entry, the same way it ignores notes today. That generic one-line change, if needed, is part of this contract.

## 7. Tests (new files unless stated)

- `src/providers/threads/video-validate.test.ts`: every row of §2's table, plus the issue order (text, postType, media).
- `src/providers/requirements.test.ts` (extended): Threads summary per data-model §7, with `postType: null` and the carousel part. Instagram and Facebook assertions are unchanged.
- `src/providers/video-labels.test.ts` (extended): P3 values.
- `tests/integration/limits/enforcement.test.ts`: the rows are generated, and the file itself is unchanged.
- `tests/integration/threads/video-fit.test.ts`: badges.
- `tests/integration/compose/` new file `threads-video-summary.test.ts`:
  - the composer check for a post with one video and a Threads account returns the summary with video limits and no `postTypeChoice`;
  - a 6-minute video gives the §2 message and cannot be queued (`addToQueue` → `validation`).
