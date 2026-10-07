# Contract: provider capabilities, caption rules and the limits inventory

## `ProviderCapabilities` additions (`src/providers/types.ts`)

```ts
text: {
  maxLength: number;
  countingRule: TextCountingRule;
  /** Most hashtags per caption, every occurrence counted (FR-012). Omit when the platform documents none. */
  maxHashtags?: number;
  /** Most @mentions per caption, every occurrence counted (FR-012). Omit when the platform documents none. */
  maxMentions?: number;
};
```

A new provider gets the requirements summary and the fit badges with no code outside its folder (constitution V). `docs/adding-a-provider.md` documents both fields (`tests/integration/docs/provider-guide.test.ts`).

## Counting (`src/providers/text.ts`)

```ts
export function countHashtags(text: string): number;
export function countMentions(text: string): number;
```

Both are pure and total, and never throw. The rules are in research P4. Unit cases (`src/providers/text.test.ts`) include every edge case from the spec and the probe list in research F12.

## Shared validation (`src/providers/validation.ts`)

After the `text_too_long` check:

- if `caps.text.maxHashtags !== undefined` and `countHashtags(text) > maxHashtags`, push a `too_many_hashtags` error;
- if `caps.text.maxMentions !== undefined` and `countMentions(text) > maxMentions`, push a `too_many_mentions` error.

Both use `field: "text"` with `count` and `limit`. Exactly at the limit, nothing is pushed.

## Planner (`src/providers/media.ts`)

`planImage(asset, c, ctx)`: `ctx` gains an optional `label?: string` (default `` `Image ${ctx.index + 1}` ``). Decisions are unchanged, and messages are unchanged when no label is given.

`src/server/services/media-variants.ts` exports `planFor(asset, c, index, platform, label?)`, and the gate's preview branch and `fitOf` share one pure helper that turns a plan into the item to validate.

## Declared values (provider files)

| File | Change |
|---|---|
| `src/providers/instagram/capabilities.ts` | `maxHashtags: 30`, `maxMentions: 20`, `minWidth: 320`, `INSTAGRAM_DEFAULT_PUBLISH_LIMIT` count 50. Comments cite `docs/research/meta.md` "Limits verification, 2026-10-07". |
| `src/providers/facebook/capabilities.ts` | `FACEBOOK_MAX_BYTES_PER_FILE = 10_000_000`. Text and photo-count comments read "UNVERIFIED (not documented by Meta, checked 2026-10-07)". The formats comment cites research (D3). |
| `src/providers/meta/errors.ts` | none (80001 and 80002 already present, FR-021). |

## `docs/limits.md` ↔ tests

- **Vocabulary.** It gains `hashtags` and `mentions`, in the doc and in `declared()` of `tests/integration/docs/limits-inventory.test.ts`.
- **Generated rows.** `tests/helpers/limit-rows.ts` `coreRows` generates `<key>: hashtags` and `<key>: mentions` whenever the provider declares them. `textRows` includes both categories.

Rows after this entry, with only the changed rows shown:

| Section | Category | Value | Source |
|---|---|---|---|
| Facebook | text length | 10000 | UNVERIFIED (not documented by Meta, checked 2026-10-07) |
| Facebook | images | 10 | UNVERIFIED (not documented by Meta, checked 2026-10-07) |
| Facebook | bytes per file | 10000000 | docs/research/meta.md ("Limits verification, 2026-10-07": "Files can not exceed 10MB") |
| Facebook | formats | image/jpeg, image/png | docs/research/meta.md (documented `.jpeg, .bmp, .png, .gif, .tiff`; WebP not listed, so an uploaded WebP is converted to JPEG; BMP, GIF and TIFF cannot be uploaded to Docket) |
| Facebook | media required / text only | no / yes | docs/research/meta.md (text-only Page posts documented) |
| Instagram | text length | 2200 | docs/research/meta.md (2200 characters; counting method not documented, code points kept) |
| Instagram | hashtags | 30 | docs/research/meta.md ("30 hashtags") |
| Instagram | mentions | 20 | docs/research/meta.md ("20 @ tags") |
| Instagram | min width | 320 | docs/research/meta.md ("Minimum width: 320"); narrower is refused (D6) |
| Instagram | max width | 1440 | docs/research/meta.md ("Maximum width: 1440"); wider is downscaled |
| Instagram | publish limit | 50 / 86400 s | docs/research/meta.md (CONTRADICTORY 50 vs 100; 50 is the `content_publishing_limit` value; run-time quota also read) |
| X | publish limit | 100 / 900 s | docs/research/x.md (confirmed 2026-10-07, per user) |

Invariant (SC-005): afterwards, the only rows whose source contains `UNVERIFIED` are Facebook `text length` and `images`. A new assertion in the inventory test checks this list by provider and category, so it cannot silently grow.
