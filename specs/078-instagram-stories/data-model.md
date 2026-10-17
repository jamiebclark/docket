# Phase 1 data model: Instagram Stories as a post type

**Feature**: `078-instagram-stories` | **Date**: 2026-10-16

No table, column or constraint changes. **There is no migration in this feature.** Everything below is
either an existing database value that gains a new member already permitted by its check constraint, or
an in-memory shape declared in TypeScript.

## 1. Post target (existing table `post_targets`)

| Field | Type | Change |
|---|---|---|
| `chosen_post_type` | `text` nullable, `$type<PostType>()` | **No change.** The check constraint `post_targets_chosen_post_type_known` already allows `'story'` (`src/server/db/schema/posts.ts:256`), and `POST_TYPES` in `src/lib/validation/scheduling.ts:42` already lists it. |

Rules:

- `null` means "the provider's default for this shape of media" - for Instagram, `image` for a single
  image and `video` for a single video.
- `'story'` is accepted for an Instagram account and refused for any account whose provider does not
  offer it, by `postTypeRefusal` (FR-005) - no new check is written; the refusal message lists
  `offeredPostTypes`, which now reads `image, story, video, reel` for Instagram.
- The value is **remembered** when the post's media stops being a single asset: nothing clears it, and
  `resolvePostType` ignores it for a shape with no declared choice, so the target publishes as a
  carousel and returns to a Story if the media returns to one asset (FR-024).

### Resolved post type (derived, never stored)

`resolvePostType(caps, items, chosen)` in `src/providers/post-type.ts`:

| Media shape | Today | After this feature |
|---|---|---|
| `none` | `text` | unchanged |
| `single_image` | `image`, always | the declared `single_image` choice: `chosen` when it is one of the options, else `choice.default`; `image` when the provider declares no choice |
| `single_video` | the declared `single_video` choice | unchanged in mechanism; Instagram's options become `video`, `reel`, `story` |
| `multiple` | `carousel` | unchanged |

`PostShape` (closed union in `src/providers/types.ts`) gains `"single_image"`.

## 2. Media asset (existing table `media_assets`, in-memory `MediaItem`)

No change. A Story uses exactly one asset and ignores its `altText`:

- `altText` is never sent for a Story (K9) and raises an `info` notice when non-empty (FR-014).
- `width`/`height` are nullable; when either is null the crop notice is omitted rather than guessed
  (spec edge case), and the asset still publishes.
- `kind` (`image` | `video`) decides which URL parameter the Story container carries and whether the
  publish path polls on the video cadence.

## 3. Publish state (existing `post_targets.state` JSON, `instagramStateSchema`)

```
v: 1                                  unchanged
mediaType: "IMAGE" | "CAROUSEL" | "REELS" | "STORIES"     <- gains "STORIES"
shareToFeed?: boolean                 REELS only; never set for a Story
kinds?, itemProgress?                 CAROUSEL only; never set for a Story
items: string[]                       [] for a Story (no child containers)
container: string | null              the Story's container id
createdAt: string | null              ISO; polling cap and the 23 h age guard
checks: number                        status reads so far
ready: boolean                        container reported FINISHED
quotaChecked: boolean                 the account's publish quota was read
recreations: 0..MAX_RECREATIONS       containers recreated after EXPIRED or AGED
```

Rules (all already enforced by `validState`, extended only by the new enum member):

- **A state is never reused across kinds.** `s.mediaType !== plan.mediaType` discards the state and the
  sequence restarts at `create_container` - so switching a target between Feed post, Reel and Story
  before publishing can never publish the wrong thing (Key Entities; FR-008).
- `ready` implies `container`; `quotaChecked` implies `ready`; both invariants already hold.
- **The schema version stays `v: 1`.** Adding an enum member parses every state already written, and
  cross-kind reuse is already refused by the guard above, so no migration of stored state is needed.

### State transitions for a Story (identical in shape to a Reel)

```text
(no state) --create_container--> container set, ready=false
          --check_status FINISHED--> ready=true
          --check_status IN_PROGRESS--> same state, checks+1, notBefore = next poll
          --check_status EXPIRED--> fresh state, recreations+1 (fatal past the cap)
          --check_status ERROR--> fatal_error, nothing published
          --check_status PUBLISHED--> ambiguous, never retried
          --check_quota (usage >= total)--> retryable_error, notBefore = +1 h
          --check_quota (ok or unreadable)--> quotaChecked=true
          --publish--> done(externalId) | ambiguous (reply unreadable)
```

## 4. Capability declaration (`ProviderCapabilities`, in-memory)

### 4a. New shared types

```ts
export type PostShape = "single_image" | "single_video";

export type ImageLimitOverrides = {
  /** `null` removes the bound for this post type. */
  minAspectRatio?: number | null;
  maxAspectRatio?: number | null;
  /** width / height; the shape the platform recommends. Notice only - Docket never reshapes an image. */
  recommendedAspectRatio?: number;
  /** Plain sentences shown in the requirements summary for this type. */
  notes?: readonly string[];
};

// inside ProviderCapabilities["media"]
byPostType?: Partial<Record<PostType, ImageLimitOverrides>>;
```

Merge rule, `imageLimitsFor(caps, type)` (new, in `src/providers/validation.ts` beside
`videoLimitsFor`): start from `caps.media` without `byPostType`, apply `byPostType[type]` minus
`notes`, and map any `null` to "no bound". Pure and total; an unknown type returns the base limits.

Declaration validation (in `mediaConstraintsOf`, at registry load, same style as
`assertVideoCapabilities`): every `byPostType` key must be a post type; the merged range must satisfy
`min <= max`; `recommendedAspectRatio`, when present, must be positive and finite and lie inside the
merged range when that range has bounds.

### 4b. Instagram's declaration after this feature

| Field | Value |
|---|---|
| `postTypes` | `["image", "carousel", "video", "reel", "story"]` |
| `postTypeChoices[0]` | `{ shape: "single_image", default: "image", options: [image "Feed post", story "Story"] }` |
| `postTypeChoices[1]` | `{ shape: "single_video", default: "video", options: [video "Feed video", reel "Reel", story "Story"] }` |
| `media.byPostType.story` | `{ minAspectRatio: null, maxAspectRatio: null, recommendedAspectRatio: 9/16, notes: ["9:16 is recommended. ..."] }` |
| `video.byPostType.story` | `{ maxBytes: 100_000_000, maxDurationSeconds: 60, minAspectRatio: 0.1, recommendedAspectRatio: 9/16 }` |

Everything else - text limits, image formats, 8 MB, 320-1440 px, alt-text length, the base video block,
the publish limit and the creation allowance - is unchanged (FR-019, SC-009).

Resulting merged limits for `story`:

- **Image**: JPEG only, converted from PNG/WebP; 8 MB (compressed above it); width 320-1440 (narrower
  refused, wider downscaled); **no aspect bound**; 9:16 recommended.
- **Video**: MP4/MOV, H264/HEVC, AAC, silent allowed, 100 MB, 3-60 s, max width 1920, aspect 0.1:1-10:1,
  23-60 FPS, 25 Mbps, 48 kHz, 2 channels, index at front, 9:16 recommended.

## 5. Validation issue (in-memory `ValidationIssue`)

Three codes added to the documented union (the union also accepts `string & {}`, but listing them keeps
them discoverable and typo-proof):

| Code | Severity | Field | Blocks scheduling |
|---|---|---|---|
| `story_text_dropped` | `info` | `text` | no |
| `story_alt_text_dropped` | `info` | `media.<n>` | no |
| `story_will_crop` | `info` | `media.<n>` | no |

Suppressed for a story target: `missing_alt_text` (warning) and `alt_text_too_long` (error), because a
Story carries no description at all (K11). `aspect_ratio_out_of_range` cannot fire for a story image
because the merged limits declare no bound.

Ordering is unchanged: `validateTargetContent` sorts by field rank (`text`, `postType`, `media`,
`media.0`, ...) and keeps insertion order within a field.

## 6. Requirements summary (in-memory `RequirementsSummary`, serialised to the composer and the API)

| Field | Change |
|---|---|
| `image.*` | now built from `imageLimitsFor(caps, ctx.postType ?? "image")` instead of `caps.media` |
| `image.aspectRatio` | `{ min: null, max: null }` for a story -> rendered "No limit checked" |
| `image.recommendedAspectRatio` | **new**: `Labelled<number> \| null` (`{ value: 0.5625, label: "9:16" }`) |
| `image.notes` | **new**: `string[]`, the image override's notes |
| `video.*` | unchanged mechanism; a story target shows the Story's video limits because `shownTypeOf` returns `story` |
| `video.postType` | `{ value: "story", label: "Story", description: "..." }` for a story target |

## 7. Publishing allowance (existing tables `allowance_uses`, `publish_attempts`)

No change. A Story reserves one unit of Instagram's creation allowance when `create_container` is
leased (400 per rolling 24 h) and is counted by Docket's own 50-per-24-h publish limit, plus the
run-time `content_publishing_limit` read at `check_quota`. A full allowance defers the attempt; a full
run-time quota is a `retryable_error` with `notBefore = +1 h`. Neither path publishes twice, because a
deferral happens before any publishing request (FR-025, FR-026, SC-006).

## 8. Variant cache identity (existing table `media_variants`)

No schema change; the **hash input** changes. `constraintsHash` stops including
`minAspectRatio`/`maxAspectRatio`, which never affect the derived file (K8). Existing rows keep their
old hash and are no longer looked up; the next `prepareVariants` or `resolvePublishMedia` builds the new
one. A Story and a feed post share a single variant for the same asset and provider.
