# Phase 0 research: Instagram Stories as a post type

**Feature**: `078-instagram-stories` | **Date**: 2026-10-16

Two parts: the platform facts this feature rests on (with their sources, per constitution principle I),
and the decisions K1-K20 that resolve everything the spec left to the plan. No `NEEDS CLARIFICATION`
marker from the Technical Context survives; one platform fact is marked `NEEDS RESEARCH` (K17) and
nothing in this feature reads it.

**No live platform call was made, and none is made by any check this feature adds.** Everything below
is either already in `docs/research/` with an official URL, or comes from the spec's fact list dated
2026-10-16 (spec "Assumptions"), which this phase records rather than re-derives. Phases cannot reach
the web.

## Part 1 - Platform facts

### F1. A Story is created as a container with `media_type=STORIES`, then published

- `POST /{ig-id}/media` accepts `media_type` values `CAROUSEL`, `REELS`, `STORIES` (no `VIDEO`).
  Already recorded: `docs/research/meta-video.md` "Single video = Reels only".
  Source: <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media>
- A Story container carries `image_url` (image Story) or `video_url` (video Story), and is then
  published with `POST /{ig-id}/media_publish` and `creation_id`, exactly as an image or Reel is.
  Source: the media reference above and
  <https://developers.facebook.com/docs/instagram-platform/content-publishing>; spec fact list,
  checked 2026-10-16.
- Container status is read with `GET /{container-id}?fields=status_code` returning
  `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED`; publish only on `FINISHED`; unpublished
  containers expire after 24 h. Already recorded: `docs/research/meta-video.md` "Container status and
  polling".

### F2. A Story carries no caption, no alt text, no stickers

- No `caption` parameter applies to a Story container, no `alt_text` applies (the reference documents
  `alt_text` for images and `docs/research/meta.md` records that it does not apply to reels), and
  publishing stickers, links, polls or locations on a Story is not supported.
  Source: the media reference above; spec fact list, checked 2026-10-16, and spec "Out of Scope".
- Consequence for Docket: the post's text and the asset's description are dropped, which is what
  decisions D1 and D2 in the spec settle.

### F3. Story image specs

- No Story-specific format, file-size, width or colour value is published, so an image Story keeps
  Instagram's general image handling: JPEG only, 8 MB, minimum width 320, maximum width 1440, sRGB -
  all already in `docs/research/meta.md` and `docs/limits.md`.
- **9:16 is a recommendation, not a limit:** "We recommended 9:16 to avoid cropping or blank space".
  No hard aspect-ratio range is stated for an image Story.
  Source: the media reference above; spec fact list and spec D3, checked 2026-10-16.
- This is why the feed's 4:5-1.91:1 range must not apply to a Story image (FR-016) and why Docket
  neither crops nor refuses (FR-017, FR-018).

### F4. Story video specs

Already in `docs/research/meta-video.md` ("Permissions", last bullet), sourced to the media reference:
MOV or MP4, 3 to 60 s, 100 MB maximum, displayed ratio 0.1:1 to 10:1. The note calls the spec "not
needed by Docket"; FR-027 requires that parenthetical to go and the entry to become first-class.

The remaining values in FR-020 - H264 or HEVC video, AAC audio, 23 to 60 FPS, 9:16 recommended - are
the same values the Reel specs table already declares and `instagramCapabilities` already encodes; a
Story inherits them rather than restating them (K4).

### F5. Stories count against the publishing limit

- Instagram's `content_publishing_limit` reference does not distinguish post types; Docket treats all
  types as one quota (already recorded, `docs/research/meta-video.md` "Rate limits", marked
  UNVERIFIED as a negative). The documented 50-vs-100 contradiction is already resolved by reading
  `config.quota_total` at publish time; a Story inherits that resolution and does not reopen it
  (spec "Assumptions").
- Each container counts against the 400-containers-per-rolling-24-h creation cap. A Story creates one
  container, so it reserves one unit of the creation allowance, like an image or a Reel.

### F6. The read-back field that identifies a Story

- The field is `media_product_type`: a published reel reads back as `media_type=VIDEO` with
  `media_product_type=REELS` (already recorded, `docs/research/meta-video.md`, sourced to the
  content-publishing page).
- **The value for a published Story is `NEEDS RESEARCH`** (see K17). Nothing in this feature reads it.

## Part 2 - Decisions

### Offering the post type

**K1 - `PostShape` gains `single_image`, and `resolvePostType` consults a declared choice for it.**
Today `PostShape = "single_video"` and `resolvePostType` returns `image` unconditionally for a single
image, so no provider can offer a choice there. Both widen; the `single_image` case becomes the same
three lines the `single_video` case already is (choice? honour `chosen` when it is an option, else
`choice.default`).
*Rationale*: FR-002 needs the choice for an image, and this is the only place that decides what a
target publishes as - the composer, the API, the gate, the engine and the formatter all call it.
*Alternatives*: an Instagram branch in shared code (breaks principle V); a posting field instead of a
post type (the type must reach `stepFor`, `advance`, `chosen_post_type` and `postTypeRefusal`).
*Blast radius*: providers that declare no `single_image` choice are unaffected, because `choiceFor`
returns null and the default stays `image`. Only Instagram declares one.

**K2 - Instagram declares two choices, and `story` is an option of both.**
`{ shape: "single_image", default: "image", options: [image, story] }` and the existing
`single_video` choice gains a third option `story`, keeping `default: "video"` (FR-002, FR-003).
`postTypes` gains `story`. `assertVideoCapabilities` already refuses a choice whose option is not in
`postTypes`, a duplicated option, a second choice for the same shape, or a default outside the options,
so the declaration is validated at registry load.

**K3 - The option labels and descriptions, written once in `capabilities.ts`.**
- `image` / "Feed post" / "Shown on your profile and in the feed."
- `story` / "Story" / "Shown for 24 hours in Stories. A Story carries no caption, no link and no stickers."
The Story description is the one sentence FR-004 requires. It is shown under the radio in the composer,
in the requirements summary's "Post as" row, and in the capability declaration the API returns - all
three read the same `PostTypeOption` (FR-004, FR-015, user story 3 scenario 1).
*Note*: the existing options' wording ("Feed video", "Reel") is not touched (SC-009).

**K4 - The Story's video limits are declared as `video.byPostType.story`, overriding only what differs.**
`{ maxBytes: 100_000_000, maxDurationSeconds: 60, minAspectRatio: 0.1, recommendedAspectRatio: 9/16 }`.
Everything else - MP4/MOV, H264/HEVC, AAC, 3 s minimum, 23-60 FPS, 10:1 maximum, 1920 px maximum
width, bitrate, sample rate, channels, index at front - is inherited from the base block, which
already carries the identical value (F4). `videoLimitsFor(caps, "story")` therefore returns exactly the
FR-020 list, and every message built from it quotes the Story's numbers, never the Reel's (FR-021,
FR-022, SC-005).
*Rejected*: restating the inherited values, which would add ledger rows that merely duplicate the base
and invite drift.

**K5 - Image limits gain `byPostType`, mirroring the video block.**
New type in `src/providers/types.ts`:
```ts
export type ImageLimitOverrides = {
  /** `null` removes the bound for this post type. */
  minAspectRatio?: number | null;
  maxAspectRatio?: number | null;
  /** width / height; the shape the platform recommends. Notice only - Docket never reshapes an image. */
  recommendedAspectRatio?: number;
  /** Plain sentences shown in the requirements summary for this type. */
  notes?: readonly string[];
};
```
`media.byPostType?: Partial<Record<PostType, ImageLimitOverrides>>`, read through
`imageLimitsFor(caps, type)` in `src/providers/validation.ts` beside `videoLimitsFor`, which merges the
override over `caps.media` and maps `null` to "no bound".
*Why this narrow surface*: the Story needs exactly these; a wider surface would need ledger rows and
proving tests for bounds no provider declares.
*Why not `maxImages: 1` for a story*: a two-asset post resolves to `carousel`, never `story`, so a
`too_many_images` refusal for a Story is unreachable and the generated ledger row could not be proved
(K20 keeps the one-asset truth where it can be stated: the option description and `planOf`).

**K6 - Instagram declares `media.byPostType.story` as the aspect exemption plus the recommendation.**
```ts
story: {
  minAspectRatio: null,
  maxAspectRatio: null,
  recommendedAspectRatio: 9 / 16,
  notes: ["9:16 is recommended. Instagram crops any other shape or shows blank space; Docket sends the image unchanged."],
}
```
This single declaration drives all four behaviours: the planner stops refusing a 9:16 image (FR-016),
nothing reshapes it (FR-017 - `planImage` has no crop or pad step at all), `validateInstagram` raises
the shape notice by comparing against `recommendedAspectRatio` (FR-018), and the requirements summary
reports "no limit checked" plus the note (FR-023).

**K7 - `mediaConstraintsOf(caps, postType?)`; only the two post-aware callers pass a type.**
`adaptedMediaFor` (which already receives `opts.postType`) and `resolvePublishMedia` (which already
computes the post type for the video planner) pass it. `prepareVariants`, `media-fit`, `ensureVariant`,
the LLM image path and the test helpers do not: with no argument the function behaves exactly as today
(SC-009). `mediaConstraintsOf` also asserts each image override at registry load - keys must be post
types, and the merged range must stay consistent - in the same style as `assertVideoCapabilities`.

**K8 - `constraintsHash` stops hashing the aspect bounds.**
`MediaConstraints.minAspectRatio`/`maxAspectRatio` are read by `planImage` only to refuse; they never
change the derived file's type, size or dimensions. Hashing them would give a Story and a feed post
different variant identities for byte-identical output, and `prepareVariants` - which groups by
provider, not by target post type - would never build the Story's copy, so `adaptedMediaFor` would
raise `variant_failed` when scheduling a Story whose image needs conversion or compression.
*Consequence, accepted and recorded in `docs/decisions.md`*: every existing cached image variant hashes
differently once and is rebuilt lazily. Variants are a cache; `resolvePublishMedia` rebuilds a missing
one at publish time, so no scheduled post can fail because of the change. A test asserts two
constraint sets differing only in aspect share one hash.
*Rejected*: making `prepareVariants` post-type aware (duplicates every adapted file for identical
bytes); bumping `VARIANT_PIPELINE_VERSION` instead (same rebuild, and it would hide why).

### Text, description and shape notices

**K9 - The Story's request is built in one function, so the caption and the alt text cannot leak.**
`storyContainerParams(item, kind)` in `src/providers/instagram/requests.ts` returns
`{ media_type: "STORIES", image_url | video_url: item.url }` and takes no `text` argument at all - the
strongest available guarantee for FR-011 and FR-012, since there is no parameter to pass the caption
through. `advanceInstagram`'s create branch calls it for a `STORIES` plan. A test asserts the request
params are exactly those two keys for both kinds (SC-004).

**K10 - Three `info` issues, raised by `validateInstagram` only for a story target.**

| Code | When | Field | Wording |
|---|---|---|---|
| `story_text_dropped` | `content.text.trim()` is non-empty | `text` | "The post text will not appear on an Instagram Story; a Story carries no caption." |
| `story_alt_text_dropped` | the asset's `altText.trim()` is non-empty | `media.0` | "The image description will not appear on an Instagram Story." |
| `story_will_crop` | the asset has both dimensions and its ratio is not the recommended shape | `media.0` | "Image 1 is 1:1; Instagram will crop it to 9:16 or show blank space. Docket sends it unchanged." |

`severity: "info"` never blocks (`ValidationIssue` contract), so a post can target a Story and a
captioned Facebook Page at once (FR-013, acceptance scenario 6). All three reach the composer and the
API through the one validation path `validateTargetContent` -> `validateResolvedContent`, so FR-015 and
SC-002 are satisfied by construction, not by a second implementation.
*Edge cases from the spec*: no text -> no text notice; no description -> no description notice; no
stored dimensions -> no crop notice (the ratio cannot be computed, so it is omitted, never guessed).

**K11 - A story target drops the feed's aspect error and both alt-text issues.**
`validateInstagram` keys its own aspect check on `imageLimitsFor(caps, type)`, so with no bounds the
check cannot fire (FR-016). It also filters the shared `missing_alt_text` warning and the
`alt_text_too_long` error for a story: a Story can carry no description at all, so asking for one is
noise and refusing a Story because an otherwise-correct description is too long would be perverse.
*Derived from FR-012* (the description is never sent) and consistent with `media-fit`'s existing rule
that alt text "is the person's to write, not a property of the image". Recorded as a decision because
the spec does not state it.

**K12 - A 9:16 image stays refused for a feed post, with the feed range in the message.**
No change is needed: `imageLimitsFor(caps, "image")` returns the feed bounds, so the same asset is
refused the moment the target is not a story, with "allowed 0.8-1.91" in the text (spec edge case 2,
SC-007). A test asserts both outcomes for one asset.

### Publishing

**K13 - The plan: a single asset on a story target is `{ mediaType: "STORIES" }`, whatever its kind.**
`planOf` gains one branch before the existing single-asset branches: `count === 1 && postType === "story"`
-> `{ mediaType: "STORIES" }`. `shareToFeed` is not part of a Story plan (it is a Reel-only parameter),
and `kinds` is not either (a Story is one asset). More than one asset or none keeps today's behaviour,
so a story target whose media grows publishes as a carousel while `chosen_post_type` stays `story` in
the database - which is exactly FR-024 and the spec's first edge case, and is the behaviour the Reel
choice already has.

**K14 - `InstagramState.mediaType` gains `"STORIES"`, and a state saved for another kind is discarded.**
`validState` already returns null when `s.mediaType !== plan.mediaType`, which restarts at
`create_container`. The schema stays at `v: 1`: adding an enum member parses every state already
stored, and a state written for `IMAGE`/`REELS`/`CAROUSEL` is rejected for a `STORIES` plan by the
existing guard rather than by a version bump (Key Entities: "a state saved for one kind is never
reused for another").

**K15 - The step sequence is the existing one, with no new step.**
`create_container` (1 allowance unit) -> `check_status` -> `check_quota` -> `publish`. `hasVideo` is
derived from the media kinds, not from the plan, so a video Story automatically gets the video status
fields and the 60 s / 5 min polling cadence while an image Story keeps the 10 s doubling cadence
(FR-007, FR-008). Container expiry (`EXPIRED` -> recreate within `MAX_RECREATIONS`), the 60-minute
`PROCESSING_CAP_MS` ceiling, the 23-hour age guard before publishing, `PUBLISHED` -> `ambiguous` and
the quota deferral all apply unchanged (FR-009, FR-026, SC-006, SC-010).

**K16 - A `STORIES` container reads `status_code,status` and names the Story in its ERROR message.**
Images today read `status_code` alone and fail with "Instagram could not process the media (status
ERROR)". The spec's edge case requires a Story to fail "with what Instagram said about it" and to tell
the person to check the asset, so a `STORIES` container reads the same `VIDEO_STATUS_FIELDS` a video
container does and fails with "Instagram could not process the Story's media{: detail}. Check the
asset's format, size and shape; nothing was published." Feed images are untouched (SC-009).

**K17 - `media_product_type`'s Story value is recorded as `NEEDS RESEARCH`, not guessed.**
FR-027 requires the read-back field that identifies a Story to be recorded. The field name and the
reels value are documented; the Story value is not available to this phase and is written into
`docs/research/meta.md` as `NEEDS RESEARCH` / UNVERIFIED with the field name, the reels precedent and
the content-publishing URL. Reading a Story back is explicitly out of scope, so no behaviour depends on
it, and no test asserts a value.

### Records and the surfaces that read them

**K18 - The limits ledger gains the rows the generators demand, and only those.**
`tests/integration/docs/limits-inventory.test.ts` derives the expected rows from the capabilities, so
the new declarations fix the ledger's contents exactly:
- From `video.byPostType.story`: `story video bytes` 100000000, `story max duration` 60,
  `story video min aspect` 0.1, `story video recommended aspect` 0.5625. Because `story` is an option of
  the `single_video` choice with overrides of its own, `videoRows` generates
  `instagram: story <category>` titles for every bound of the merged limits, so the first three rows
  cite `tests/integration/limits/enforcement.test.ts`; the recommended shape has no refusing fact and
  cites `src/providers/video-plan.test.ts`, as the `reel`/`video` recommended rows already do.
- From `media.byPostType.story`: `story min aspect` none, `story max aspect` none,
  `story recommended aspect` 0.5625. The inventory test's `declared()` and `plannerRows` are extended
  for image overrides: a `none` bound is proved by a planner row asserting a 9:16 image is *not*
  refused for a story, and the recommended shape cites the Instagram validate test that raises
  `story_will_crop`.
- The inventory test's "marks only ... UNVERIFIED" list gains `story min aspect` and `story max aspect`:
  "no aspect limit documented for an image Story" is a negative, and the repository's convention is to
  mark negatives UNVERIFIED (as `carousel video min/max aspect` already are).
- `plannerRows` rows gain an optional `postType`, and `planWith` an optional post type, so the planner
  suite can plan with `mediaConstraintsOf(caps, type)`.

**K19 - The requirements summary reports the Story's own image limits.**
`requirementsOf` builds its `image` block from `imageLimitsFor(caps, ctx.postType ?? "image")` instead
of `caps.media`, and gains `image.recommendedAspectRatio` and `image.notes`. The video block already
keys on the shown type, and because `story` is an option of the `single_video` choice, `shownTypeOf`
returns `story` for a story target, so the Story's video limits and the Story's "Post as" description
appear (FR-023, user story 3 scenario 3). **`shownTypeOf` itself is deliberately left alone** - it reads
the `single_video` choice only, which keeps every existing target's summary byte-identical (SC-009);
see `contracts/compose-and-api.md` A3a and the complete list of existing checks that must be amended in
A6. `requirements-ui.ts` renders the two new image fields;
`RequirementsSummary.tsx` keys repeated rows by index so a third source of "Note" rows cannot collide
(a pre-existing React key defect that story notes would make routine).

**K20 - The judgement calls recorded in `docs/decisions.md`.**
The spec's D1 (text dropped, not refused), D2 (description dropped) and D3 (pass a non-9:16 image
through) are recorded as FR-029 requires, together with the plan's own calls: K8 (aspect bounds leave
the variant hash), K11 (a Story drops both alt-text issues), K16 (a Story container reads `status`),
K5/K6 (per-post-type image limits as a declaration rather than a flag) and the constitution amendment.
Also corrected, as the spec's closing section requires: the "not needed by Docket" parenthetical in
`docs/research/meta-video.md`, and the constitution's blanket "stories" exclusion.

## Open items

| Item | State | Effect on this feature |
|---|---|---|
| `media_product_type` value for a published Story | `NEEDS RESEARCH` (K17) | None - reading a Story back is out of scope. |
| Story-specific image width or colour values | None published (F3) | None - the general image handling applies (FR-019); if a later check finds Story-specific values they are a change to one declaration. |
| Whether Stories count differently against the publishing limit | UNVERIFIED as a negative (F5) | None - all types share one quota, already Docket's model, and the run-time quota is read anyway. |
| Live Instagram verification | Owed, as for every Meta feature (`docs/meta-setup.md`) | The feature is reported as "verified with mocks only". |
