# Contract: Facebook video capabilities, validation, summary and badges

Covers FR-001, FR-002 and FR-016 to FR-022. The declaration values are in [../data-model.md](../data-model.md) §2, and the rationale in [../research.md](../research.md) P1–P4.

## Declaration (reuses G19, G20, G21, G22)

- **`postTypes`:** `text`, `image`, `carousel`, `video`, `reel`.
- **`postTypeChoices`:** one `single_video` choice, `video` "Page video" (the default) and `reel` "Reel". It passes the registry checks in `src/providers/media.ts`.
- **`video` base (Page video):** one video, no images, MP4 or MOV.
- **`video.byPostType.reel`:**
  - H.264, HEVC, VP9 or AV1 video, with AAC audio or none;
  - 3–90 s;
  - at least 540 × 960;
  - aspect 0.556–0.569;
  - 24–60 fps;
  - three notes.
- **`video.byPostType.video`:** one note.
- **`creationAllowance`:** 30 per 86,400 s, "Facebook's daily Reels allowance".
- **No Facebook-specific code** in the composer, the schema or the engine (FR-001). The composer's "Post as" group, the API's `postTypes` values and their 400s are all derived from the declaration (019 G19).

## Validation (`src/providers/facebook/validate.ts`)

`validateFacebook(content, caps)`:

1. `issues = validateAgainstCapabilities(content, caps)`. The resolved type comes from `content.postType ?? resolvePostType(caps, content.media, null)`.
2. **`too_many_videos` and `video_with_images`:** the message becomes "A Facebook post can carry one video and no images.", with code, field, count and limit kept.
3. **`video_aspect_out_of_range` when the type is `reel`:** the message becomes "Video 1 is <ratioLabel>; Facebook Reels must be 9:16 (vertical). Docket does not crop video yet."
4. **Any other `video_*` code except `video_not_accepted`:** the message becomes "<message without its final full stop> for a Facebook <postTypeLabel>. Docket does not crop, trim or convert video yet."
5. **The Page video suggestion.** When the type is `reel`, the post holds exactly one video, and `validateAgainstCapabilities({ ...content, postType: "video" }, caps)` has no error whose code starts with `video_`, every rewritten Reel `video_*` error ends with " Post it as a Page video instead."
6. **Everything else** passes through unchanged (FR-019).

**The same validator is used everywhere.** It goes through `validateResolvedContent`, so the composer check, the scheduling gate and the engine's first-step re-check (G15) all give the same issue (FR-018, US5-5).

**Edges, each covered by a generated or unit test:**

- **Inclusive bounds:** 3.0 s, 90.0 s, 540 × 960, 24 and 60 fps, and aspects 0.556 and 0.569 are all accepted.
- **Unknown frame rate:** not refused on frame rate (G21).
- **Rotation:** the displayed frame is used (018).
- **A video still processing or failed in Docket:** `media_processing` or `media_failed`, as today.

## Requirements summary

- **The generic fix** (`src/providers/requirements.ts`): `video.notes` is `byPostType[shown].notes` for any shown type. Instagram's output is unchanged; `requirements.test.ts` pins one Instagram summary per type.
- **Server-derived.** The Facebook summary for each type is in data-model §5. Every value comes from `requirementsOf` on the server; there are no literals in UI code. The existing UI-literal test covers `src/components/compose/*`.
- **Live updates.** The summary updates without a reload when the choice or the post's shape changes. That is existing composer behaviour; `post-type-choice.test.ts` gains Facebook cases.

## Fit badges

`videoFitOf` validates a one-video post with no chosen type, so it resolves to `video` (the base limits).

- **"fits":** an MP4 or MOV.
- **"will be refused":** a container that is not allowed (unreachable today, since the library holds only MP4 and MOV), or a video still processing or failed.
- **Never "will be converted"** for video (FR-022).

## Tests

| Case | File |
|---|---|
| declaration passes the registry, has the default `video`, and every option is in `postTypes` | `src/providers/registry.test.ts`, `src/providers/media.test.ts` (existing generic checks, plus a Facebook assertion) |
| each wording rule above, including "Post it as a Page video instead." present and absent, and a 1,080 × 1,918 Reel accepted | `src/providers/facebook/validate.test.ts` (extended) |
| one generated refusal per declared bound per type, through `validateResolvedContent` | `tests/integration/limits/enforcement.test.ts` (generated from `limit-rows`, no edit needed beyond the declaration), with the docs rows checked by `tests/integration/docs/limits-inventory.test.ts` |
| summary notes for any type; Instagram unchanged | `src/providers/requirements.test.ts` (extended) |
| Facebook "Post as" group: default Page video, switching, kept per target beside Instagram, keyboard and polite announcement | `tests/integration/compose/post-type-choice.test.ts` (extended) |
| API: a Facebook single-video target without `postTypes` returns `postType: "video"`; `reel` is accepted; `story` gets a 400 naming `video, reel` | `tests/integration/api/post-type.test.ts` (extended) |
| badge for a Facebook video is "fits" (`videoFitOf`, `src/server/services/media-fit.ts`) | the existing badge suite under `tests/integration/video/` or `tests/integration/media/` that covers `videoFitOf`; add a Facebook case there |
| text, image and carousel validation unchanged (FR-019) | existing `src/providers/facebook/validate.test.ts` cases |
