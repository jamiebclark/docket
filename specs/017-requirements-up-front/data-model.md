# Data model: Requirements up front (017)

No table, column or migration changes (research P15). Every entity below is a TypeScript shape that is derived at request time from provider capabilities and existing `media_assets` columns.

## 1. `ProviderCapabilities.text`: caption rules (changed)

`src/providers/types.ts`

| Field | Type | Meaning |
|---|---|---|
| `maxLength` | `number` | unchanged |
| `countingRule` | `TextCountingRule` | unchanged |
| `maxHashtags` | `number?` | **new.** Most hashtags per caption, counted per occurrence (FR-012, D7). Absent means not checked. |
| `maxMentions` | `number?` | **new.** Most @mentions per caption, counted the same way. Absent means not checked. |

Validation: when present, each is a positive integer. `mediaConstraintsOf` is untouched. The registry test asserts that every declared caption cap is an integer ≥ 1.

Declared values after this entry:

| Provider | Field | Before | After | Source |
|---|---|---|---|---|
| Instagram | `text.maxHashtags` | none | **30** | `docs/research/meta.md` "Limits verification, 2026-10-07" |
| Instagram | `text.maxMentions` | none | **20** | same |
| Instagram | `media.minWidth` | none | **320** | same (D6) |
| Instagram | `defaultPublishLimit` | 100 / 86400 s | **50 / 86400 s** | same (D2) |
| Facebook | `media.maxBytesPerFile` | 8,000,000 | **10,000,000** | same (D4) |
| Facebook | `text.maxLength`, `media.maxImages` | 10,000 / 10 | unchanged, comment relabelled UNVERIFIED (D5) | not documented by Meta |
| X | `defaultPublishLimit` | 100 / 900 s | unchanged, doc source confirmed | `docs/research/x.md` |

Threads, Bluesky and mock values do not change.

## 2. `ValidationIssue` codes (new values)

| Code | Severity | Field | `count` / `limit` | Message |
|---|---|---|---|---|
| `too_many_hashtags` | `error` | `text` | hashtags found / `maxHashtags` | "The caption has {count} hashtags; the limit is {limit}." |
| `too_many_mentions` | `error` | `text` | mentions found / `maxMentions` | "The caption has {count} @mentions; the limit is {limit}." |

They are emitted by `validateAgainstCapabilities`, after `text_too_long`, so they reach the composer check, the scheduling gate and the engine re-validation (research F2). Both block scheduling, because `canSchedule` is false when any issue is an `error`.

## 3. `RequirementsSummary` (new)

`src/providers/requirements.ts`, built by `requirementsOf(caps, { uploadTypes })`. It is pure and JSON-safe, since it travels in the check response.

```ts
interface Labelled<T> { value: T; label: string }        // e.g. { value: "image/jpeg", label: "JPEG" }
interface Range { min: Labelled<number> | null; max: Labelled<number> | null }

interface RequirementsSummary {
  text: {
    maxLength: number;                 // = caps.text.maxLength (FR-004)
    countingRule: string;              // = countingRuleName(rule): same string as TargetCheck.countingRule
    unit: string;                      // = countingUnit(rule): "characters" | "graphemes" | "bytes" | custom unit
    maxHashtags: number | null;        // null = no limit Docket checks (D11)
    maxMentions: number | null;
  };
  image: {
    maxImages: number;                 // 0 = images not accepted
    formats: Labelled<string>[];       // caps.media.allowedMimeTypes, in declared order
    convertedTo: Labelled<string> | null;   // output type; null when maxImages = 0
    convertedFrom: Labelled<string>[]; // uploadTypes not in formats, which the planner converts
    maxBytesPerFile: Labelled<number>; // label: decimal MB, e.g. "8 MB"
    width: Range;                      // px; label e.g. "320 px"
    height: Range;
    aspectRatio: Range;                // label e.g. "4:5", "1.91:1"
    maxAltTextLength: number | null;   // null = none documented (D11)
  };
  post: {
    mediaRequired: boolean;            // caps.media.required || !caps.textOnlyAllowed
    textOnlyAllowed: boolean;
    postTypes: PostType[];             // caps.postTypes
  };
  // Entry 2 adds `video` here, as a sibling of `image`. This entry adds no video field (FR-005).
}
```

Rules:

- **Values.** Every value is read from `caps` (FR-003, SC-001). No defaults are invented: an absent optional capability becomes `null` (D11).
- **Label helpers.** These are pure and live in the same module, so the server does all formatting (research P2):
  - `mimeLabel(t)` reads `MIME_LABEL` from `src/lib/media/types.ts` and falls back to the MIME string;
  - `aspectLabel(r)` returns `a:b` for `r < 1` when a fraction with `b ≤ 20` matches, else `r:1`;
  - `bytesLabel(n)` returns decimal MB with at most one decimal place.
- **Media required.** `mediaRequired` is true when an image is needed for the post to be accepted. Instagram has `required: true` and `textOnlyAllowed: false`, which gives `true`.

Expected summaries (the SC-001 test compares each with capabilities and `docs/limits.md`):

| | Instagram | Facebook | Threads | Bluesky | X |
|---|---|---|---|---|---|
| text | 2200 characters, ≤30 #, ≤20 @ | 10000 characters | 500 (custom rule unit) | 300 graphemes | 280 (custom rule unit) |
| images | 10 | 10 | 20 | 4 | 4 |
| formats → converted to | JPEG → JPEG (PNG, WebP converted) | JPEG, PNG → JPEG (WebP converted) | JPEG, PNG → JPEG (WebP) | JPEG, PNG → JPEG (WebP) | JPEG, PNG, WebP (none converted) |
| bytes | 8 MB | 10 MB | 8 MB | 2 MB | 5 MB |
| width | 320–1440 px | null | 320–1440 px | null | null |
| aspect | 4:5 – 1.91:1 | null | 1:10 – 10:1 | null | null |
| alt text | 1000 | null | 1000 | null | 1000 |
| media required / text only | yes / no | no / yes | no / yes | no / yes | no / yes |

## 4. `TargetCheck` (changed)

`src/server/services/posts/compose.ts`

| Field | Change |
|---|---|
| `requirements` | **new**: `RequirementsSummary \| null`. It is `null` exactly when `limit` is `null` (provider not registered). It is present with no text and no media (FR-002). |

All other fields are unchanged. `requirements.text.maxLength === limit` and `requirements.text.countingRule === countingRule` always hold (FR-004), and a test asserts both.

## 5. `PlatformFit` (new)

`src/server/services/media-fit.ts`

```ts
type FitState = "fits" | "converted" | "refused";

interface PlatformFit {
  providerKey: string;
  providerName: string;      // provider.displayName
  state: FitState;
  steps: ImageStep[];        // "convert" | "downscale" | "compress"; empty unless state = "converted"
  /** The planner's own sentences, written with the label "This image" (research P6). Empty when state = "fits". */
  details: string[];
  /** For "converted": the output type label, e.g. "JPEG", when steps include "convert". */
  convertedTo: string | null;
}
```

Derivation (`fitOf(asset, provider)`, research P5):

| Planner plan (`planFor`) | Provider check of the planned item (`media.0`, alt text codes excluded) | `state` | `details` |
|---|---|---|---|
| `refuse` | not run | `refused` | `plan.issues[].message` |
| `derive` | no error | `converted` | `plan.notes[].message` |
| `derive` | error | `refused` | the error messages |
| `original` | no error | `fits` | none |
| `original` | error (only reachable for a row without dimensions) | `refused` | the error messages |

State transitions: none. A fit is recomputed on every list call from the stored row and the current capabilities, and nothing is cached or stored.

## 6. Library list result (changed)

`listMedia(scope, filter)` in `src/server/services/media.ts`:

| Part | Change |
|---|---|
| input `fit` | **new, optional**: `{ accountIds: uuid[] (≤ 50) }` (picker) or `{ active: true }` (library page) |
| result `platforms` | **new**: `{ key: string; name: string }[]`, deduplicated by provider (D8) and sorted by name. Empty without `fit`, or when no account qualifies (D9). |
| item `fit` | **new**: `PlatformFit[]`, one per entry of `platforms`, in the same order. `[]` when `platforms` is empty. |

`MediaView` gains an optional `fit?: PlatformFit[]`. Other `toView` callers do not set it.

Which accounts qualify (`fitPlatforms`, research P7):

- **`accountIds`:** each id is read through the project scope. Unknown and foreign ids are ignored, and so are accounts with an unregistered provider.
- **`active`:** every project account with `status = "active"` and a registered provider.

## 7. `docs/limits.md` row (changed vocabulary)

- **Category** gains `hashtags` and `mentions`, in the doc's "How to read a row" list and in the inventory test's `declared()`.
- **Counting** for both reads "per occurrence (FR-012)".
- **Generated tests** are `<key>: hashtags` and `<key>: mentions` in the core suite and the text suite (`tests/helpers/limit-rows.ts`).

## 8. Shared client-safe constants (moved)

`src/lib/media/types.ts` (new):

- `UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const`. The value is unchanged, and `src/server/services/media.ts` re-exports it.
- `MIME_LABEL: Record<string, string>` = `{ "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" }`. It replaces the private maps in `src/providers/media.ts` and `MediaCard.tsx`.
