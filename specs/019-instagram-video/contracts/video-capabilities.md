# Contract: per-type video limits, frame-rate floor, summary, badges and limits.md (G20, G21)

Covers FR-022–FR-029, FR-034, US3, D4–D7. Decisions: research P8–P13 and P26.

## 1. Instagram's declaration (`src/providers/instagram/capabilities.ts`)

```ts
export const INSTAGRAM_REEL_VIDEO = {
  maxVideos: 1,
  withImages: false,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  maxBytes: 300_000_000,          // "300 MB", decimal (D5)
  minDurationSeconds: 3,
  maxDurationSeconds: 900,
  maxWidth: 1920,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  minFrameRate: 23,
  maxFrameRate: 60,
} as const;

video: {
  ...INSTAGRAM_REEL_VIDEO,
  byPostType: {
    carousel: {
      maxVideos: 10,
      withImages: true,
      minAspectRatio: 0.8,
      maxAspectRatio: 1.91,
      notes: ["Reels cannot be carousel items."],
    },
  },
},
```

- **Comments.** Each value's comment cites `docs/research/meta-video.md` ("Reel specs", "Carousel with video").
- **Not declared.** Bitrate, sample rate, channels, scan type, GOP and moov position are not declared (D5): Docket has no facts for them.
- **Unchanged.** Text and image capabilities stay as they are.

## 2. Shared validator (`src/providers/validation.ts`)

- **Limits per type.** `validateAgainstCapabilities(content, caps)` sets `type = content.postType ?? resolvePostType(caps, content.media, null)` and `v = videoLimitsFor(caps, type)`. Every video rule that read `caps.video` reads `v` instead, so count, `withImages` and each `videoIssues` bound follow the type.
- **Post type support.** `unsupported_post_type` checks `type` against `postTypes`, with today's exception for refused video.
- **G21.** After `maxFrameRate`: when `v.minFrameRate !== undefined && f.frameRate !== null && f.frameRate < v.minFrameRate - EPS`, raise `video_frame_rate_too_low` with "Video 1 is 15 fps; the minimum is 23 fps.", `count` and `limit`.
- **Inclusive bounds.** Every bound stays inclusive with `EPS`: 3.0 s, 900.0 s, 300,000,000 bytes, 1,920 px, 23 and 60 fps, and 0.8 and 1.91 are all accepted.
- **Other providers.** They have no `byPostType` and no `minFrameRate`, so their output is byte-for-byte unchanged (tested).

## 3. Instagram validator (`src/providers/instagram/validate.ts`)

- **Image rules.** The image aspect, conversion, compression and downscale loop runs only over `kind !== "video"` items, and numbers its labels by post position, as today.
- **`carousel_crop`.** It collects ratios from every item with width and height, videos included (D7).
- **`media_required` / `text_only_not_allowed`.** The message becomes "Instagram posts need at least one image or video."
- **`too_many_items`.** Raised when `media.length > 10`: "The post has 11 items; Instagram allows 10."
- **Video error wording.** Every error whose code starts with `video_` is rewritten to `${message.replace(/\.$/, "")} for an Instagram ${postTypeLabel(caps, type)}. Docket does not crop, trim or convert video yet.`
  - Here `type` is the resolved type, and `postTypeLabel` gives "Feed video", "Reel" or "carousel item".
  - Examples:
    - "Video 1 is 16 minutes long; the limit is 15 minutes for an Instagram Reel. Docket does not crop, trim or convert video yet."
    - "Video 2 is 9:16; allowed is 4:5 to 1.91:1 for an Instagram carousel item. Docket does not crop, trim or convert video yet."
  - `video_not_accepted`, `media_processing` and `media_failed` are not rewritten.

## 4. Requirements summary (`src/providers/requirements.ts`, `src/components/compose/requirements-ui.ts`)

- **Signature.** `requirementsOf(caps, { uploadTypes, postType? })` builds the shapes in data-model §5.
- **Shown type.** If `postType` is `carousel`, or is an option of a `single_video` choice, the video part shows that type. Otherwise it shows the type a single video would get (`resolvePostType(caps, [{ kind: "video" }], null)`).
- **`video.postType`.** It is the shown type with its option label and description, or `{ label: "carousel item", description: null }` for a carousel. It is `null` for providers without choices or per-type limits, so their summary is unchanged.
- **`carousel`.** Present when `postTypes` includes `carousel` and the carousel's merged video limits have `maxVideos > 0`; otherwise `null`. Mock, Facebook, Threads, Bluesky and X get `null`.
- **`videoLine(r)`.** It prefixes the type label ("Reel: …"), adds `minFrameRate` as a range ("23 fps – 60 fps"), and adds the description ("Shown in the Reels tab only.").
- **New `carouselLine(r)`.** "Carousel: up to 10 items; images and videos may be mixed; video items 4:5 – 1.91:1; Reels cannot be carousel items."
- **`detailRows(r)`.** It adds "Post as" (label and description), "Video frame rate" as a range, "Carousel items", "Carousel video aspect ratio" and the notes.
- **`RequirementsSummary.tsx`.** It renders `carouselLine` when `carousel` is present, plus the polite live line (post-type-choice.md §5).
- **Text and images.** These parts are unchanged.

## 5. Fit badges (`src/server/services/media-fit.ts`)

There is no code change. `videoFitOf` validates `{ media: [video] }` without a `postType`, so Instagram resolves it to `video` (Feed video) with the Reel limits. A fitting video shows "fits", and an out-of-range one shows "will be refused" with the rewritten reason, starting "This video …" (FR-028). A test pins both.

## 6. `docs/limits.md` and its inventory test

**Instagram rows added or replaced.** The `videos 0` row is replaced. Unprefixed rows apply to Feed video and Reel.

| Category | Value | Source | Enforced in |
|---|---|---|---|
| videos | 1 | meta-video.md "Single video = Reels only" | validateResolvedContent |
| video with images | no | single video only; mixes are carousels | validateResolvedContent |
| video containers | mp4, mov | meta-video.md "Reel specs" | validateResolvedContent |
| video codecs | h264, hevc | same | validateResolvedContent |
| audio codecs | aac | same | validateResolvedContent |
| silent video | yes | same (no audio requirement stated, D5) | validateResolvedContent |
| video bytes | 300000000 | same ("300 MB", decimal, D5) | validateResolvedContent |
| min duration / max duration | 3 / 900 | same | validateResolvedContent |
| video max width | 1920 | same | validateResolvedContent |
| video min aspect / video max aspect | 0.01 / 10 | same | validateResolvedContent |
| min frame rate / max frame rate | 23 / 60 | same | validateResolvedContent |
| carousel videos | 10 | meta-video.md "Carousel with video" | validateResolvedContent |
| carousel video with images | yes | same ("a mix of the two") | validateResolvedContent |
| carousel video min aspect / max aspect | 0.8 / 1.91 | same, conservative approach, UNVERIFIED (no carousel video spec) | validateResolvedContent |
| creation allowance | 400 / 86400 s | meta-video.md "Rate limits" (400 containers / rolling 24 h) | engine allowance deferral |
| note: video processing ceiling | 60 min | meta-video.md "Container status and polling" (5 min is guidance, not a hard stop, D9) | Instagram step machine |
| note: share to feed | Feed video = Reel with share_to_feed=true | meta-video.md "Single video = Reels only" | Instagram step machine |

**The inventory test** (`tests/integration/docs/limits-inventory.test.ts`):

- **Vocabulary.** It gains `min frame rate`, `creation allowance`, and `<type> <video category>` for every `byPostType` key.
- **`declared()`.** It emits base rows, plus one prefixed row per overridden field (`carousel videos`, `carousel video min aspect` …), plus `creation allowance` from `provider.creationAllowance`.
- **Enforcement point.** "engine allowance deferral" maps to the allowance suite file.
- **Every provider.** Facebook, Threads, Bluesky and X keep `videos 0`. The mock gains no rows.

## 7. Generated enforcement rows (`tests/helpers/limit-rows.ts`, `tests/integration/limits/enforcement.test.ts`)

- **Base rows.** `videoRows(provider)` keeps building base rows. For a provider with a `single_video` choice, it builds every base row once per option type, with `chosenPostType` set. Titles are `<key>: <category>` for the default type and `<key>: <category> (<type>)` for the others, for example `instagram: max duration (reel)`.
- **Frame-rate floor.** A new `min frame rate` row uses `frameRate: minFrameRate - 1`, giving `video_frame_rate_too_low`.
- **Per-type rows.** For each `byPostType` entry there is a row per overridden bound, built as a post of the type's shape. For Instagram's carousel that is an image plus a video at `floor(0.8 × 1000) − 1 : 1000` or `ceil(1.91 × 1000) + 1 : 1000`, titled `instagram: carousel video min aspect`. `carousel videos` uses 11 videos and expects `too_many_videos` or `too_many_items`.
- **Paths driven.** Each row runs through `validateResolvedContent` and `addToQueue` with stored video rows (`createVideoAsset`), as 018 did. It also runs the publish-time re-check (G15) on a first-step target whose video was swapped after scheduling (US3-5): the target fails on `engine-validate` and the fake Graph logs no request.
- **Accepted rows.** Videos exactly at each bound are accepted (Edge Cases).
- **Unknown frame rate.** A `frameRate: null` video is not refused on frame rate.
