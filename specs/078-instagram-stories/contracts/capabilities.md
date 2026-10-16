# Contract: what Instagram declares, and the shared types it needs

The capability declaration is the interface this feature exposes to the composer, the public API, the
scheduling gate, the media planner, the video formatter, the publish engine and the limits ledger.
Everything in this file is pure data or a pure function; a breach is caught at registry load or by a
generated test.

## C1. Shared types (`src/providers/types.ts`)

```ts
export type PostShape = "single_image" | "single_video";

export interface PostTypeOption { type: PostType; label: string; description: string }
export interface PostTypeChoice { shape: PostShape; options: readonly PostTypeOption[]; default: PostType }

export type ImageLimitOverrides = {
  minAspectRatio?: number | null;   // null removes the bound for this post type
  maxAspectRatio?: number | null;
  recommendedAspectRatio?: number;  // width / height; notice only
  notes?: readonly string[];
};

ProviderCapabilities["media"].byPostType?: Partial<Record<PostType, ImageLimitOverrides>>;
```

`ValidationIssue["code"]` gains `story_text_dropped`, `story_alt_text_dropped`, `story_will_crop`.

Each new member name must appear in an inline code span in `docs/adding-a-provider.md`
(`tests/integration/docs/provider-guide.test.ts` enforces this for every member of
`ProviderCapabilities` and its nested literals).

## C2. Pure functions

| Function | Contract |
|---|---|
| `shapeOf(items)` | unchanged: `none` / `single_image` / `single_video` / `multiple`. |
| `choiceFor(caps, items)` | unchanged mechanism; now returns a choice for a single image too. |
| `resolvePostType(caps, items, chosen)` | total, never throws. For `single_image`: the declared choice's `chosen` when `chosen` is one of its options, else `choice.default`; `image` when no choice is declared. All other shapes unchanged. |
| `offeredPostTypes(caps)` | unchanged; for Instagram now yields `image`, `story`, `video`, `reel`. |
| `postTypeLabel(caps, type)` | unchanged; `story` -> "Story" from the option. |
| `imageLimitsFor(caps, type)` **(new)** | pure, total. `caps.media` without `byPostType`, with `byPostType[type]` (minus `notes`) merged over it, `null` mapped to absent. An unknown type returns the base limits. |
| `videoLimitsFor(caps, type)` | unchanged; `story` now resolves to the merged Story limits. |
| `mediaConstraintsOf(caps, postType?)` | with no `postType`, byte-for-byte today's result. With one, built from `imageLimitsFor(caps, postType)`. Throws on an inconsistent declaration (see C4). |

## C3. Instagram's declaration

```ts
postTypes: ["image", "carousel", "video", "reel", "story"]

postTypeChoices: [
  { shape: "single_image", default: "image", options: [
      { type: "image", label: "Feed post", description: "Shown on your profile and in the feed." },
      { type: "story", label: "Story",     description: "Shown for 24 hours in Stories. A Story carries no caption, no link and no stickers." },
  ]},
  { shape: "single_video", default: "video", options: [
      { type: "video", label: "Feed video", description: "Shown on your profile and feed, and in the Reels tab." },  // unchanged
      { type: "reel",  label: "Reel",       description: "Shown in the Reels tab only." },                            // unchanged
      { type: "story", label: "Story",      description: <the same Story sentence as above> },
  ]},
]

media.byPostType: {
  story: {
    minAspectRatio: null,
    maxAspectRatio: null,
    recommendedAspectRatio: 9 / 16,
    notes: ["9:16 is recommended. Instagram crops any other shape or shows blank space; Docket sends the image unchanged."],
  },
}

video.byPostType: {
  video:    INSTAGRAM_RECOMMENDED,   // unchanged
  reel:     INSTAGRAM_RECOMMENDED,   // unchanged
  carousel: { ... },                 // unchanged
  story: {
    maxBytes: 100_000_000,
    maxDurationSeconds: 60,
    minAspectRatio: 0.1,
    recommendedAspectRatio: 9 / 16,
  },
}
```

Invariants a test must assert:

1. The Story option's `description` is identical in both choices (one constant, used twice).
2. `videoLimitsFor(caps, "story")` equals the FR-020 list exactly: MP4/MOV, H264/HEVC, AAC, silent
   allowed, 100 MB, 3-60 s, 0.1:1-10:1, 23-60 FPS, 9:16 recommended.
3. `imageLimitsFor(caps, "story")` has no aspect bound and keeps JPEG, 8 MB, 320-1440 px and the
   1000-character alt-text limit.
4. `imageLimitsFor(caps, "image")` and `videoLimitsFor(caps, t)` for `t` in `image`, `carousel`,
   `video`, `reel` are unchanged from before this feature (SC-009).
5. Facebook (and every other provider) offers no `story`: `offeredPostTypes` for each other provider is
   unchanged, and `postTypeRefusal(key, "story")` returns a message naming the types that provider does
   offer (FR-006, SC-008, FR-005).

## C4. Declaration validation (throws at registry load)

`mediaConstraintsOf` (already called for every provider by `src/providers/registry.test.ts`) additionally
throws when:

- a `media.byPostType` key is not a post type;
- a merged image range has `min > max`;
- `recommendedAspectRatio` is not positive and finite, or lies outside the merged range when that range
  is bounded.

`assertVideoCapabilities` already covers the choice rules this feature leans on: at least two options,
no duplicate option, every option in `postTypes`, the default among the options, one choice per shape.
A test adds `single_image` cases to the existing table in `src/providers/registry.test.ts`.

## C5. Limits ledger (`docs/limits.md`), derived rows

`tests/integration/docs/limits-inventory.test.ts` computes the expected rows from the declaration, so
the ledger must gain exactly:

| Category | Value | Source | Enforced in | Proving test |
|---|---|---|---|---|
| `story min aspect` | none | meta.md Story section; no limit documented, UNVERIFIED as a negative | media planner | generated `instagram: story min aspect` |
| `story max aspect` | none | as above | media planner | generated `instagram: story max aspect` |
| `story recommended aspect` | 0.5625 | meta.md ("We recommended 9:16 to avoid cropping or blank space") | validateResolvedContent | `src/providers/instagram/validate.test.ts` story crop notice |
| `story video bytes` | 100000000 | meta-video.md Story video specs (100 MB, decimal, D5) | video planner | generated `instagram: story video bytes` |
| `story max duration` | 60 | meta-video.md Story video specs | video planner | generated `instagram: story max duration` |
| `story video min aspect` | 0.1 | meta-video.md Story video specs (0.1:1) | video planner | generated `instagram: story video min aspect` |
| `story video recommended aspect` | 0.5625 | meta-video.md Story video specs (9:16 recommended) | video planner | `src/providers/video-plan.test.ts` "recommended shape: only when asked, or when forced by the range" |
| `note: story drops caption and description` | no caption, no alt text | meta.md Story section | Instagram step machine | `tests/integration/instagram/stories.test.ts` |

Test-helper changes this implies (`tests/helpers/limit-rows.ts`): `PlannerRow` gains an optional
`postType`; `planWith` takes an optional post type; `plannerRows` emits one row per image override
(a `null` bound becomes an acceptance row - an image outside the base range must **not** be refused for
that type). `limits-inventory.test.ts` gains the three image categories in `declared()` and the two
`story` aspect rows in its UNVERIFIED list.
