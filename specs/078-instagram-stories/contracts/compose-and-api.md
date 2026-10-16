# Contract: the composer, the public API and the requirements summary

No new endpoint, route, screen or component. Every surface below already renders or returns whatever the
provider declares; this contract fixes what it must now show.

## A1. The per-account "Post as" choice (`TargetCheck.postTypeChoice`)

`checkComposition` already returns
`choice ? { options, selected: resolved, default: choice.default } : null` and `Composer.tsx` renders it
as a `fieldset`/`legend` of labelled radios with each option's description in an `aria-describedby`
span. **Neither file changes.** What changes is what they receive:

| Post media | Options, in declaration order | Pre-selected |
|---|---|---|
| exactly one image | Feed post, Story | Feed post (FR-002) |
| exactly one video | Feed video, Reel, Story | Feed video (FR-003) |
| none, or more than one asset | `postTypeChoice: null` (no choice shown) | - |

- `TargetCheck.postType` is the resolved type, so a story target whose media grows to two assets shows
  `carousel` while the radio group disappears and `chosen_post_type` stays `story` (FR-024, spec edge
  case 1).
- Accessibility is unchanged: one `fieldset` per account, a `legend` of "Post as", each radio labelled
  and described, full keyboard operation, no new control.

## A2. Per-target issues (composer and API)

`TargetCheck.issues` and the API's per-target validation issues are the same array from
`validateTargetContent`. For a story target they include `story_text_dropped`,
`story_alt_text_dropped` and `story_will_crop` with `severity: "info"`, which the composer already
renders as non-blocking notices and `canSchedule` already ignores (it counts errors only).

A story target therefore never blocks `addToQueue` for a reason a Story merely drops (FR-013, FR-015,
SC-002).

## A3. The requirements summary

`requirementsOf(caps, { uploadTypes, postType: resolved, notes })` is already called per target with the
resolved type. Changes:

| Field | For a story target |
|---|---|
| `image.aspectRatio` | `{ min: null, max: null }` -> "Aspect ratio: No limit checked" |
| `image.recommendedAspectRatio` **(new)** | `{ value: 0.5625, label: "9:16" }` -> "Recommended shape: 9:16" |
| `image.notes` **(new)** | the Story's image note -> one "Note" row |
| `video.*` | the Story's video limits (100 MB, 3 s - 1 minute, 0.1:1 - 10:1, 23-60 fps) |
| `video.postType` | `{ value: "story", label: "Story", description: "Shown for 24 hours in Stories. A Story carries no caption, no link and no stickers." }` -> the "Post as" row, and the `aria-live` announcement when the chosen type changes |
| `image.maxImages`, formats, file size, width | unchanged (FR-019) |

`src/components/compose/requirements-ui.ts` renders the two new image fields in `detailRows` (after
"Aspect ratio"), and `RequirementsSummary.tsx` keys repeated rows by index so several "Note" rows
cannot collide on one React key - a pre-existing defect that the image notes would make routine.

(FR-004, FR-023, user story 3 scenario 3.)

### A3a. `shownTypeOf` stays video-centric, deliberately

`requirementsOf`'s `shownTypeOf` picks the type for the **video** block from the `single_video`
choice's options. It is left exactly as it is:

- a story target already resolves correctly, because `story` is an option of that choice;
- the `image` block is keyed separately, on `ctx.postType ?? "image"`, which is what a story image
  needs;
- leaving it alone means an Instagram image, carousel, feed video or Reel target's summary is
  byte-identical to today (SC-009). In particular the existing case "a type that is not an option falls
  back to the default" (`postType: "image"` -> `video.postType` `video`) keeps passing unchanged, even
  though `image` is now an option of the *other* choice.

## A4. The public API

| Surface | Behaviour |
|---|---|
| `postTypes` map on create/update (`postTypes: { <accountId>: "story" }`) | accepted for an Instagram account; `POST_TYPES` already lists `story` and `assertPostTypesForAccounts` -> `postTypeRefusal` decides (FR-005) |
| the same for a non-Instagram account | `400` with the message from `postTypeRefusal`: `"story" is not offered for <name>; allowed: <types>` (FR-005, user story 3 scenario 4, SC-008) |
| reading a post or target | `postType: "story"` on the target, as `reel` already reads back |
| reading an account's capabilities | `story` among the post types, with the Story option's label and description (user story 3 scenario 1, FR-004) |
| per-target validation issues | as A2, each with its `severity` (user story 3 scenario 2) |

No API schema file changes: `POST_TYPES` in `src/lib/validation/scheduling.ts` already contains
`story`, and the refusal is computed from the provider declaration.

## A5. Everything that must not change (SC-009)

- An Instagram image, carousel, feed video or Reel post: the same options, defaults, labels,
  descriptions, limits, requests, state and messages as before.
- Every other provider: `choiceFor` returns null for `single_image` because none declares one, so
  `resolvePostType` still answers `image`; no provider offers `story`; Facebook shows no Story option
  anywhere (SC-008).
- `media-fit` badges in the media library: computed with no post type, so unchanged.

## A6. Existing checks that must be amended, and why

SC-009 means no *behaviour* of an existing post type changes. A handful of existing tests assert the
shape of the declaration itself, so adding an option necessarily changes them. This is the complete
list; anything beyond it is a regression, not an amendment.

| Test | Amendment | Why it is not a behaviour change |
|---|---|---|
| `src/providers/registry.test.ts` "single_video choice" | option list becomes `["video", "reel", "story"]`; new cases for the `single_image` choice and for an invalid `media.byPostType` declaration | asserts what Instagram declares, which is the feature |
| `src/providers/requirements.test.ts` "keeps one Instagram and one Facebook post type per shown type" | iterate the `single_video` choice's options only (the video block is what the case is about) | `image` is now an option of another choice; the video block's behaviour is unchanged (A3a) |
| `tests/integration/compose/post-type-choice.test.ts` "defaults one video on Instagram ..." | option list becomes `["video", "reel", "story"]` | same |
| `tests/integration/compose/post-type-choice.test.ts` "gives no choice for images, two videos or video plus image" | retitle: a single image now has a choice; the two-video and video-plus-image cases keep asserting `postTypeChoice: null` | the title was describing the old declaration |
| `tests/integration/compose/post-type-choice.test.ts` "refuses a value the provider does not offer" | Instagram's unoffered value becomes `carousel` (never a choice option), expecting `/image, story, video, reel/`; the mock case is unchanged | `story` is now offered - that is FR-001 |
| `tests/integration/compose/post-type-choice.test.ts` `check()` helper | the `postType` parameter's union gains `"image"` and `"story"` | types only |
| `src/components/compose/requirements-ui.test.ts` | the `ig(postType)` union gains `"story"`; new cases for the image note and recommended-shape rows | new fields |
| `tests/integration/docs/limits-inventory.test.ts` | `declared()` learns the three per-post-type image categories; the UNVERIFIED list gains `story min aspect` and `story max aspect` | the ledger must match the declaration |
| `tests/helpers/limit-rows.ts` | `PlannerRow.postType`, `planWith(provider, asset, postType?)`, image-override rows | generated coverage for the new declaration |
| `tests/integration/limits/enforcement.test.ts` | the planner suite passes the row's post type to `planWith`/`mediaConstraintsOf` | same |
| `src/providers/media.test.ts`, `src/providers/post-type.test.ts`, `src/providers/validation.test.ts` | new cases for `imageLimitsFor`, `mediaConstraintsOf(caps, type)`, the `single_image` choice and the image-override assertions | new functions |
| `src/providers/instagram/{validate,steps,state,publish}.test.ts` | new Story cases; existing cases untouched | additive |
| `tests/integration/api/post-type.test.ts` | a case accepting `story` for Instagram and one refusing it for Facebook | FR-005, SC-008 |
