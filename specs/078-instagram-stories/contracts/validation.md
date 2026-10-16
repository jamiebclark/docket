# Contract: validation issues for a Story target

One implementation: `validateInstagram(content, caps)` in `src/providers/instagram/validate.ts`, reached
by the composer, the public API and the publish engine through
`validateResolvedContent` -> `provider.validate` (constitution IV). Nothing below is computed twice
anywhere else.

`content.postType` is the target's resolved type; when absent it falls back to
`resolvePostType(caps, content.media, null)`. `const story = type === "story"`.

## V1. Issues a story target adds

| Code | Severity | Field | Condition | Message |
|---|---|---|---|---|
| `story_text_dropped` | `info` | `text` | `story` and `content.text.trim() !== ""` | "The post text will not appear on an Instagram Story; a Story carries no caption." |
| `story_alt_text_dropped` | `info` | `media.<i>` | `story` and the asset's `altText.trim() !== ""` | "The image description will not appear on an Instagram Story." |
| `story_will_crop` | `info` | `media.<i>` | `story`, both dimensions known, and the ratio differs from `recommendedAspectRatio` by more than the existing `RATIO_EPSILON` | "Image 1 is 1:1; Instagram will crop it to 9:16 or show blank space. Docket sends it unchanged." - the shape is named with `aspectLabel(ratio)`, so a 1:1 asset says "1:1" and a 4:5 asset says "4:5" |

All three are `info`, so they never block scheduling: a post may target an Instagram Story and a
captioned Facebook Page at the same time (FR-013, acceptance scenario 6, SC-002).

Omissions required by the spec's edge cases:

- no text -> no `story_text_dropped`;
- no description -> no `story_alt_text_dropped`;
- `width` or `height` null -> no `story_will_crop` (never guessed), and the Story still publishes;
- a 9:16 asset -> no `story_will_crop`.

## V2. Issues a story target must **not** produce

| Code | Why |
|---|---|
| `aspect_ratio_out_of_range` | `imageLimitsFor(caps, "story")` declares no bound, so neither `validateInstagram`'s own check nor `planImage` can raise it (FR-016, acceptance scenario 3). |
| `missing_alt_text` | A Story carries no description at all; asking for one is noise (K11, derived from FR-012). Filtered from the shared issues for a story target. |
| `alt_text_too_long` | The description is never sent, so its length cannot refuse a Story (K11). Filtered likewise. |
| `unsupported_post_type` | `story` is in `postTypes`, so the shared check passes. |

Everything else a Story image is subject to is unchanged and still fires: `media_will_convert`,
`media_will_compress`, `media_will_downscale`, `image_too_small`, `media_processing`, `media_failed`,
`media_unavailable`, `too_many_items` (FR-019).

## V3. Video messages quote the Story's numbers

`validateAgainstCapabilities` reads `videoLimitsFor(caps, postType)`, and `validateInstagram` appends
" for an Instagram {typeLabel}" to every `video_*` message, where `typeLabel` is
`postTypeLabel(caps, "story")` = "Story". So:

| Case | Expected |
|---|---|
| 90 s video on a story target | the formatter adapts: "will be cut to 1 minute" (never 15 minutes) |
| 2 s video | `video_too_short`, error: "the minimum is 3 seconds ... for an Instagram Story" |
| > 100 MB video that cannot be re-encoded small enough | refused quoting 100 MB (never 300 MB) |
| ratio outside 0.1:1-10:1 | padded to an accepted shape where possible, else refused quoting 0.1:1-10:1 |

(FR-020-FR-022, SC-005, user story 2 scenarios 2-5.)

## V4. Ordering and transport

`validateTargetContent` merges the provider's issues with the planner's notes and sorts by field rank
(`text`, `postType`, `media`, `media.0`, `media.1`, ...), keeping insertion order within a field. Each
issue travels to the composer and to the public API with its `severity`, so a caller can tell a
non-blocking notice from a refusal (FR-015, user story 3 scenario 2). No new transport field is needed.

## V5. The gate and the engine agree

`addToQueue` (scheduling gate) and the engine's first-step re-check both call
`validateResolvedContent`, so a Story that schedules is a Story the engine accepts, and a Story whose
media changed into something refused fails on `engine-validate` with the same sentence a person would
have seen - with no platform request made (the existing `D14` behaviour, asserted by the generated
limits suite for the new `story` rows).
