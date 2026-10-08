# Contract: Bluesky video capabilities, validation, formatter fit, summary and badges

Covers FR-001–FR-005, FR-017–FR-020 and US3. The declaration is in [data-model.md](../data-model.md) §1; decisions P* are in [research.md](../research.md).

## 1. Declaration

- `src/providers/bluesky/capabilities.ts` (new) exports `BLUESKY_VIDEO`, `BLUESKY_VIDEO_NOTES`, `BLUESKY_VIDEO_ALLOWANCE` and `blueskyCapabilities`. The text, image and publish-limit values are moved there unchanged; `index.ts` uses them and sets `creationAllowance: BLUESKY_VIDEO_ALLOWANCE`.
- `postTypes` gains `video`. No `postTypeChoices` (D1). `byPostType` has only `video: { notes }` (P1).
- `assertCreationAllowance` accepts it (count 25 ≥ 11, window 86,400 ≤ 604,800).
- No other provider's declaration changes (FR-029). No composer, schema, scheduler or formatter code specific to Bluesky (FR-001, FR-003).

## 2. Validation (`validateBluesky`, shared by the composer check, the scheduling gate and the engine's G15 re-check)

Signature unchanged: `(PostContent, ProviderCapabilities) → ValidationIssue[]`.

1. `validateAgainstCapabilities` runs as today, then the 3,000-byte text check, as today.
2. Two shared codes are reworded (P19); code, field, count and limit are kept:
   - `too_many_videos` → `Bluesky takes one video per post; this post has ${count}.`
   - `video_with_images` → `Bluesky takes one video per post with no images alongside it.`
3. Every other issue (text, images, facets-related byte limit, video planner notes) is unchanged (FR-004).

### Expected outcomes (each with 0 requests to Bluesky)

Errors come from `validateBluesky`; the info notes come from entry 6's planner (`video-plan.ts`, e.g. "Video 1 will be cut to the first 3:00 for Bluesky."), as the composer shows them today.

| Content | Result |
|---|---|
| 1 video, H.264/AAC MP4, 40 s, 20 MB | no error; plan **fits as is** |
| 1 video, exactly 180.0 s and 300,000,000 bytes | no error; fits (inclusive) |
| 1 video, H.264/AAC MOV, 40 s | info `video_will_rewrap`; plan rewrap, no re-encode |
| 1 video, HEVC/AAC MOV, 300 s | info `video_will_cut` ("will be cut to the first 3:00") and `video_will_reencode`; plan re-encode to H.264/AAC MP4 ≤ 180 s, ≤ 300,000,000 bytes |
| 1 video, H.264, Opus audio | info `video_will_reencode` |
| 1 silent H.264 MP4 | no error, no audio added |
| 1 video, 400,000,000 bytes, H.264/AAC MP4 | info: fitted by bitrate (024 D14) |
| 1 video, unknown frame rate or dimensions | no error (nothing declared on them) |
| 2 videos | error `too_many_videos` "Bluesky takes one video per post; this post has 2." |
| 1 video + 1 image | error `video_with_images` "Bluesky takes one video per post with no images alongside it." |
| 1 video with alt text of 5,000 characters | no alt-text issue (the shared validator checks alt text on images only; video alt text has no limit, research) |
| text-only, 1–4 images | exactly today's issues |

The info codes and their wording come from entry 6's planner and are not Bluesky's (FR-029). Each error row is proved three ways: the composer check (`canSchedule: false`), the scheduling gate (refuses the target), and the engine's first-step re-check (fails `engine-validate` with no Bluesky request).

## 3. Formatter fit and the file sent (FR-003, FR-017)

- `planVideoFor(asset, blueskyCapabilities, "video", …)` decides `original`, `derive` or `refuse` from the declared limits only.
- `resolvePublishMedia` hands Bluesky the original (`original`) or the ready version (`derive`), and the claim-time gate makes the target wait "Preparing video for Bluesky" while the version is built, with no Bluesky call (US3 #6, unchanged entry 6 behaviour).
- Bluesky uploads `content.media[0].url` with `content.media[0].bytes` declared: the original's when it fits, the version's otherwise (D10). A test with the memory storage asserts the bytes sent are the version's, not the original's.

## 4. Requirements summary (`requirementsOf`, server-side, FR-018)

For a Bluesky account with a video in the post, the summary's `video` part is:

| Field | Value |
|---|---|
| `maxVideos` | 1 |
| `withImages` | false |
| `containers` | `[{ value: "mp4", label: "MP4" }]` |
| `videoCodecs` | `[{ value: "h264", label: "H.264" }]` |
| `audioCodecs` | `[{ value: "aac", label: "AAC" }]` |
| `silentAllowed` | true |
| `maxBytes.label` | "300 MB" |
| `duration` | `{ min: null, max: { value: 180, label: "3 minutes" } }` |
| `width`, `height`, `aspectRatio` | all null |
| `minFrameRate`, `maxFrameRate` | null |
| `postType` | null (no "Post as" row) |
| `notes` | the two notes of data-model §1 |
| `adapts` | `["cut to 3 minutes", "rewrapped or re-encoded"]` |
| `cannot` | `["cannot be made smaller than 300 MB"]` |

`carousel` is null (no carousel video override). The UI renders it through the existing `RequirementsSummary`; the gist line reads "Video: 1 video per post, MP4, H.264, up to 300 MB, up to 3 minutes, not with images" (exact wording from `videoLine`). No limit literal appears in UI code.

## 5. Fit badges (FR-019)

`fitOf(video, blueskyProvider)` (entry 6's `media-fit`) gives "fits", "will be adapted (…steps…)" or "will be refused (…reason…)" from the same plan as §3. Bluesky is no longer in the `maxVideos === 0` group, so the "refuses every provider that does not accept video" test now covers X only, unchanged.

## 6. Tests

- `src/providers/bluesky/capabilities.test.ts` (new): the declared values; no undeclared bound (min duration, size, aspect, frame rate, bitrate); `postTypes`; no choice; the allowance; no byte allowance (data-model §7 notes).
- `src/providers/bluesky/video-validate.test.ts` (new): §2's table, with `planVideo` from the real planner.
- `tests/integration/bluesky/video-fit.test.ts` (new): §2's error rows through the composer check, the scheduling gate and the publish-time re-check with 0 fake-PDS requests; §3's version-is-sent case; US3 #6's wait.
- `tests/integration/compose/bluesky-video-summary.test.ts` (new): §4 through the check route, and the badge words of §5.
- `src/providers/requirements.test.ts`: the "unchanged" loop drops `bluesky`, and a case pins §4 (P20).
- `tests/integration/limits/enforcement.test.ts` and `tests/integration/docs/limits-inventory.test.ts`: no code change; the generated `bluesky: *` rows and the inventory follow the new declaration and `docs/limits.md`.
