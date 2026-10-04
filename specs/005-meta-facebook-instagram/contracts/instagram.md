# Contract: `instagram` provider (`src/providers/instagram/`)

The provider is one folder and one registry line. Files: `index.ts`, `capabilities.ts`, `settings.ts`, `state.ts`, `steps.ts`, `publish.ts`, `quota.ts`, `validate.ts`, plus `*.test.ts` alongside.

```ts
export const instagramProvider: SocialProvider<InstagramSettings, InstagramState> = {
  key: "instagram",
  displayName: "Instagram",
  capabilities: {
    text: { maxLength: 2_200, countingRule: "code_points" },          // R1 interim
    media: {
      maxImages: 10,
      allowedMimeTypes: ["image/jpeg"],
      outputMimeType: "image/jpeg",
      maxBytesPerFile: 8_000_000,
      maxWidth: 1440,
      minAspectRatio: 0.8,
      maxAspectRatio: 1.91,
      maxAltTextLength: 1000,
      required: true,
    },
    textOnlyAllowed: false,
    postTypes: ["image", "carousel"],
  },
  defaultPublishLimit: { count: 100, windowSeconds: 86_400 },
  connect: { strategy: "oauth", group: metaConnectGroup },
  settingsSchema: z.object({ pageId: z.string().regex(/^\d{1,40}$/).optional() }).strip(),
  validate: validateInstagram,
  stepFor: (state, _s, content) => instagramStepFor(state, content),
  advance: advanceInstagram,
};
```

## Validation (`validateInstagram`)

| Input | Issue |
|---|---|
| no images | `media_required` (error), replacing the shared `text_only_not_allowed`: "Instagram posts need at least one image." |
| 11 images | `too_many_images`, limit 10 (shared) |
| alt text 1,001 characters | `alt_text_too_long` (shared) |
| caption over 2,200 code points | `text_too_long` (shared) |
| carousel images with aspect ratios differing by more than 0.01 | `carousel_crop` (info): "Instagram crops every image to the first image's shape (W:H)." |
| PNG / over 8 MB / wider than 1,440 px; aspect outside 0.8–1.91 | from `planImage` via `validateTargetContent` (info notes, `aspect_ratio_out_of_range` error) |

Edges tested: exactly 10 images, 1,000-character alt text, aspect exactly 0.8 and 1.91, and exactly 8,000,000 bytes, all allowed.

## Steps and requests

The step table and transitions are in [data-model §4](../data-model.md). Requests, using `{ig}` = `ctx.account.externalId`:

| Step | Request | Params |
|---|---|---|
| `create_container` | `POST /{ig}/media` | `image_url`; `caption` (when non-empty); `alt_text` (when non-empty) |
| `create_item_<i>` | `POST /{ig}/media` | `image_url`; `is_carousel_item` = `"true"`; `alt_text` (when non-empty) |
| `create_carousel` | `POST /{ig}/media` | `media_type` = `"CAROUSEL"`; `children` = `items.join(",")`; `caption` (when non-empty) |
| `check_status` | `GET /{container}` | `fields` = `"status_code"` |
| `check_quota` | `GET /{ig}/content_publishing_limit` | `fields` = `"quota_usage,config"` (R5) |
| `publish` | `POST /{ig}/media_publish` | `creation_id` = container |

`image_url` is always the item URL `ctx.content.media[i].url`, which the engine has already resolved to the Instagram variant (JPEG, ≤ 8 MB, ≤ 1,440 px wide) by 003's `resolvePublishMedia`. The provider never sends an original.

**Timing constants** (`steps.ts`, exported for tests):

```ts
export const FIRST_CHECK_DELAY_MS = 10_000;
export const MAX_CHECK_INTERVAL_MS = 300_000;
export const PROCESSING_CAP_MS = 60 * 60_000;
export const CONTAINER_SAFE_AGE_MS = 23 * 3_600_000;   // research: containers expire after 24 h
export const MAX_RECREATIONS = 2;
export const QUOTA_RETRY_MS = 3_600_000;               // R5 interim
```

## Results specific to Instagram

| Step | Outcome | Result |
|---|---|---|
| create steps | 2xx `{ id }` | `continue` (see transitions) |
| create steps | 2xx without an id | `retryable_error` (not `mayPublish`) |
| `check_status` | 2xx with an unknown or missing `status_code` | `retryable_error` "Instagram returned an unknown media status." |
| `check_quota` | any non-ok outcome except Graph 190 | `continue` `{ quotaChecked: true }`, summary `quota: "unknown"` |
| `publish` | 2xx `{ id }` | `done`, `externalId = id`, no URL (R5) |
| `publish` | 2xx without an id, timeout, reset, 5xx, temporary code | `ambiguous` |
| `publish` | Graph rejection (e.g. the container expired) | `fatal_error` with Meta's message and the hint " Retry the post to create the media again." Never recreated automatically. |

Everything else follows [meta.md](./meta.md) `graphStepError` with `platform: "Instagram"`. A rejection on a create step that looks like a fetch failure gets the public-URL hint, as for Facebook.

## Extensibility (US4 AS10)

`mediaType` is a union in `state.ts`. Adding `VIDEO` or `REELS` later means:

- a new create step (`create_video`);
- a per-kind polling cadence (`checkIntervalFor(mediaType, checks)`);
- possibly a longer cap.

Each is a branch in `steps.ts`/`publish.ts`, with no change to the engine or schema.
