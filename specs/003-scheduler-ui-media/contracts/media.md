# Contract: Media pipeline, provider media constraints, variants

FR-006–FR-017, research F5, D6–D11.

## Provider contract additions (`src/providers/types.ts`)

```ts
export interface ProviderCapabilities {
  text: { maxLength: number; countingRule: TextCountingRule };
  media: {
    maxImages: number;
    allowedMimeTypes: readonly string[];
    maxBytesPerFile: number;
    required: boolean;
    // New, all optional (D6):
    /** Converted to when an image's type is not allowed. Default: allowedMimeTypes[0]. */
    outputMimeType?: string;
    minWidth?: number; maxWidth?: number;
    minHeight?: number; maxHeight?: number;
    /** width ÷ height, inclusive. */
    minAspectRatio?: number; maxAspectRatio?: number;
    maxAltTextLength?: number;
  };
  textOnlyAllowed: boolean;
  postTypes: readonly PostType[];
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info";   // "info" is new and never blocks
  // codes: existing + media_will_convert | media_will_downscale | media_will_compress
  //        | aspect_ratio_out_of_range | image_too_small | variant_failed | alt_text_too_long | media_unavailable
  ...
}
```

- The engine passes `MediaItem`s that are **already adapted**: the variant's URL, type, dimensions and bytes, plus the asset's alt text. A provider never sees a non-compliant file it declared it cannot take.
- `validateAgainstCapabilities` adds `alt_text_too_long` when `maxAltTextLength` is set and exceeded.
- `docs/adding-a-provider.md` gains a section "Declaring media constraints". It covers:
  - the fields, with the Instagram and Bluesky examples from research;
  - "never crop": out-of-range aspect ratios are refused;
  - that changing the values creates new variants automatically.

## Pure planning (`src/providers/media.ts`, no server imports)

```ts
export const VARIANT_PIPELINE_VERSION = 1;
export function mediaConstraintsOf(caps: ProviderCapabilities): MediaConstraints;   // throws on inconsistent declarations
export type ImagePlan =
  | { kind: "original" }
  | { kind: "derive"; steps: ("convert" | "downscale" | "compress")[];
      output: { mimeType: string; width: number; height: number; maxBytes: number }; notes: ValidationIssue[] }
  | { kind: "refuse"; issues: ValidationIssue[] };
export function planImage(
  asset: { mimeType: string; width: number; height: number; bytes: number },
  c: MediaConstraints,
  ctx: { index: number; platform: string },          // used to word the messages ("Image 2 …")
): ImagePlan;
```

- **Rules**: see the data model, `ImagePlan`.
- **Test**: `src/providers/media.test.ts`, table-driven, uses the instagram-like and bluesky-like constraints. It covers:
  - compliant → original;
  - PNG → convert;
  - 3000 px → downscale;
  - 9 MB → compress;
  - 2:1 aspect → refuse;
  - 300 px wide → refuse;
  - downscale crossing a minimum → refuse;
  - inconsistent declarations → throw.

## Server media modules (`src/server/media/`)

```ts
// process.ts — the upload pipeline (D9). Pure over bytes + limits; sharp only.
export type UploadRejection =
  | { code: "too_large"; message: string }
  | { code: "unsupported_type"; message: string }      // decoder format not jpeg/png/webp
  | { code: "animated"; message: string }
  | { code: "too_many_pixels"; message: string }
  | { code: "unreadable"; message: string };
export async function processUpload(bytes: Buffer, limits: { maxBytes: number; maxPixels: number }):
  Promise<
    | { ok: true; original: { body: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp";
                              width: number; height: number; bytes: number };
        thumbnail: { body: Buffer; width: number; height: number } }
    | ({ ok: false } & UploadRejection)
  >;

// variants.ts — the generic generator (D8). Pure over bytes + constraints; sharp only.
export async function generateVariant(original: Buffer, plan: Extract<ImagePlan, { kind: "derive" }>, c: MediaConstraints):
  Promise<{ ok: true; body: Buffer; mimeType: string; ext: "jpg" | "png" | "webp"; width: number; height: number; bytes: number }
        | { ok: false; message: string }>;
// hash.ts
export function constraintsHash(c: MediaConstraints): string;   // node:crypto sha256, includes VARIANT_PIPELINE_VERSION
```

- **Generation guarantees** (tested in `src/server/media/variants.test.ts` with sharp-generated fixtures; no fixture files are committed except where noted):
  - **Format.** The output decodes with `format` equal to the output type. The output carries no EXIF or XMP, and its colour space is sRGB.
  - **Limits.** Output `bytes ≤ maxBytes`, `width ≤ maxWidth`, `height ≤ maxHeight`, and each side ≥ its minimum. The aspect ratio is preserved to within 1 px of rounding.
  - **No upscaling.** A 400 px image stays 400 px.
  - **Byte targets.** A noisy 4000×3000 PNG (sharp `create` plus per-pixel noise from a seeded buffer) reaches ≤ 2,000,000 bytes as JPEG. A target it cannot reach (e.g. 20,000 bytes with `minWidth` 1000) fails with the message.
  - **Bounded work.** At most 12 encodes. Under the test's clock, a 24 MP input finishes well under the provider timeout (asserted < 10 s).
- **Upload tests** (`src/server/media/process.test.ts`):
  - a JPEG with `Orientation=6`, `Make` and GPS EXIF (built with `withMetadata({ orientation: 6 })` and `withExifMerge`) is stored upright with swapped dimensions, and the output bytes contain neither the camera string nor GPS tags (SC-003);
  - a PNG is accepted;
  - a 21 MB buffer is rejected as `too_large` before decoding;
  - a text file renamed `.jpg` is `unreadable`;
  - a GIF is `unsupported_type`;
  - an animated WebP is `animated`;
  - an image over the pixel limit is `too_many_pixels`.

## Variant service (`src/server/services/media-variants.ts`)

```ts
/** Outside any transaction. Ensures variants for every (image, target provider) pair whose plan is `derive`. */
export async function prepareVariants(scope: ProjectScope, postId: string, opts?: { targetIds?: string[] }):
  Promise<{ failures: { assetId: string; providerKey: string; message: string }[] }>;

/** Inside the gate: adapted media for one target, or issues (missing variant row → variant_failed). */
export async function adaptedMediaFor(
  tx: Pick<ProjectScope, "media">, providerCaps: ProviderCapabilities, platform: string, assets: MediaRow[],
): Promise<{ media: MediaItem[]; issues: ValidationIssue[] }>;

/** Scheduler, outside any transaction: resolve + existence check + regenerate (FR-016, US4-AS7). */
export async function resolvePublishMedia(
  repos: ReturnType<typeof forSchedulerProject>, targetId: string, provider: SocialProvider,
): Promise<{ ok: true; media: MediaItem[] } | { ok: false; error: string }>;
```

- **`prepareVariants`** groups by `(assetId, constraintsHash)`, so two targets on the same provider share one variant. It processes at most 4 pairs concurrently.
  - For each pair: `storage.get(original)`, then `generateVariant`, `storage.put(variantKey)`, and `media.insertVariant` (`ON CONFLICT DO NOTHING`).
  - The failure of one pair never stops the others (edge case "Variant pipeline under load").
- **`resolvePublishMedia`** reads assets and variant rows through `forSchedulerProject`.
  - A deleted asset or missing original returns `{ ok: false, error: "Image N is no longer available." }`.
  - A missing variant object is regenerated, using the same code as `prepareVariants`.
  - The engine turns `ok: false` into a `fatal_error` step result with **no provider call**. The error text is secret-free (it contains no keys or URLs).
- **Tests** (`tests/integration/media/variants.test.ts`, using the F4 in-memory storage double, `createMemoryStorage()` in `tests/helpers/storage.ts`, implementing `Storage`):
  - a second `prepareVariants` reuses the row (no second `put`);
  - changing the test provider's `maxBytesPerFile` makes a new hash and a new variant;
  - deleting the variant object, then running a tick, regenerates it before `advance` is called (spy provider records what it received);
  - a deleted original fails the target with no `advance` call;
  - an out-of-range aspect is refused at `addToQueue` with `aspect_ratio_out_of_range` while another target of the same post queues.

## Media DAL additions (`src/server/dal/media.ts`)

```ts
interface MediaRepo {
  // existing: insert, get, getMany, markUsed, updateAlt — `get`/`getMany` now exclude deleted rows
  getIncludingDeleted(id: string): Promise<MediaRow | null>;
  list(filter: { tag?: string; unused?: boolean; missingAlt?: boolean; q?: string; limit: number; offset: number }):
    Promise<{ rows: (MediaRow & { inUse: boolean })[]; total: number }>;
  listTags(): Promise<string[]>;                                        // distinct, sorted
  update(id: string, patch: { altText?: string; tags?: string[] }): Promise<MediaRow | null>;
  lockForUpdate(id: string): Promise<MediaRow | null>;                  // own statement (002 D11 rule)
  lockShared(ids: readonly string[]): Promise<MediaRow[]>;              // FOR SHARE, live only, id order
  postsUsing(id: string): Promise<{ postId: string; targetStatuses: TargetStatus[] }[]>;
  softDelete(id: string, at: Date): Promise<void>;
  detachFromPosts(id: string, postIds: readonly string[]): Promise<void>;   // deletes rows, renumbers positions
  getVariant(assetId: string, hash: string): Promise<VariantRow | null>;
  listVariants(assetId: string): Promise<VariantRow[]>;
  insertVariant(row: NewVariant): Promise<VariantRow>;                  // ON CONFLICT DO NOTHING + re-select
  deleteVariants(assetId: string): Promise<VariantRow[]>;
}
```

- `q` matches `alt_text ILIKE` or `original_filename ILIKE`, with `%` and `_` escaped.
- `inUse` = `first_used_at IS NOT NULL`.
