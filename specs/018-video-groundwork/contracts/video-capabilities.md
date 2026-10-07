# Contract: video capabilities, validation, summary, badges, mock, API

Decisions P16–P18, P24 and P25 in [../research.md](../research.md). The types are in [../data-model.md](../data-model.md) §3 and §5.

## Capabilities

- `ProviderCapabilities.video: VideoCapabilities` is **required**.
- Real providers (Instagram, Facebook, Threads, Bluesky, X) declare `video: { maxVideos: 0 }` in their own `capabilities.ts`. Nothing else in their capabilities changes (FR-028).
- The mock's declaration is in data-model §3 (FR-030).
- `docs/adding-a-provider.md` documents every `VideoCapabilities` member in a code span. `tests/integration/docs/provider-guide.test.ts` already requires every capability member to appear there (017 F9).

## Validator (`src/providers/validation.ts`, `validateAgainstCapabilities`)

The order is stable: text, then postType, then media, then media.0, media.1 and so on, as today.

1. Split `content.media` into images (`kind !== "video"`) and videos.
2. Run today's image rules over **images only**, with `too_many_images` counting images, and the messages unchanged.
3. Any item with `status` `processing` or `failed` produces `media_processing` or `media_failed` on `media.<i>`, and no other rule runs for that item.
4. If videos exist and `video.maxVideos === 0`, each video produces `video_not_accepted`, and `unsupported_post_type` is not added for `"video"`.
5. Otherwise:
   - more videos than `maxVideos` gives `too_many_videos` (`media`);
   - images and videos together without `withImages` gives `video_with_images` (`media`);
   - per ready video, with its facts, each declared bound is checked: container, video codec, audio codec or `silentAllowed`, `maxBytes`, duration min and max, width and height min and max (displayed), aspect min and max (`width / height`, inclusive, with a 1e-9 tolerance), and `maxFrameRate` (an unknown frame rate passes, since the bound cannot be judged).
6. `inferPostType` returns `"video"` when any item is a video, so `unsupported_post_type` applies to providers whose `postTypes` lack it and whose `maxVideos > 0`.
7. Alt text: `missing_alt_text` (a warning) and `alt_text_too_long` apply to images only. Videos have no alt-text rule in this entry.

Messages name the limit and the value with server-side labels (data-model §6). Numeric issues carry `count` and `limit`.

## Where items come from

- `itemOf(asset, variant?)` (`media-variants.ts`) and `targets.effectiveContent` (`dal/targets.ts`) set:
  - `kind`;
  - `status` (the row's `processing_state`);
  - `failureReason` (`processing_error`);
  - `video` (from `duration_ms / 1000`, `frame_rate`, `video_codec`, `audio_codec` and `container`) for ready videos.
- `planFor` returns `{ kind: "original" }` for videos.
- `prepareVariants` skips them.
- `resolvePublishMedia` checks the stored object exists and passes the item through. Its messages say "Video N" for videos.

## Requirements summary (`requirementsOf`)

`video` part as in data-model §5. `RequirementsSummary.tsx` adds one line and a `<details>` group "Video":

- `maxVideos = 0`: "Video: not accepted yet" (US3 AS2).
- Otherwise, "Video: {maxVideos} per post, {containers}, {codecs}, up to {maxBytes}, {duration range}, aspect {min} to {max}, up to {fps}{, not with images}". In the list, each undeclared field reads "{label}: no limit Docket checks" (US3 AS1, D11 of 017).

The `text`, `image` and `post` parts are unchanged, which `src/providers/requirements.test.ts` asserts with the existing expectations kept verbatim.

## Fit badges (`fitOf`, `listMedia`)

- Video not `ready` → `listMedia` item `fit: []`, and the card says "Badges appear when processing finishes".
- Ready video → `validateAgainstCapabilities({ text: "x", media: [item] }, caps)`. Media errors are kept and alt codes ignored. "Video 1" is reworded to "This video". The result is `refused` with those details, or `fits`. **Never** `converted` (FR-027).
- Examples, as in US3:
  - "Mock: will be refused: This video is 3:42 long; the limit is 1 minute."
  - "Instagram: will be refused: This account does not accept video yet."
  - "Mock: fits" (a 20 s H.264 clip).

## Mock steps (`src/providers/mock/index.ts`)

| `stepFor(state, settings, { videoCount })` | Step | `mayPublish` | `advance` result |
|---|---|---|---|
| `videoCount > 0`, `state?.video` unset | `upload_video` | false | `continue`, state `{ done: 0, video: "uploaded" }` |
| `state.video === "uploaded"` | `check_video` | false | `continue`, `notBefore = now + 1 s`, state `{ …, video: "polled" }`; summary `response.status: "processing"` |
| `state.video === "polled"`, or `videoCount = 0` | today's steps (`create_container` × `steps` for `multi_step`, then `publish`) | as today | the account's `behaviour` |

Attempt summaries carry `request.mediaKinds` (`["video"]`) and `request.step`. The engine's first-step re-check (`engine-validate`) runs before `upload_video`, as for images (US4 AS2).

## Public API (`src/lib/api/schemas.ts`, `src/server/services/views/media.ts`, `src/server/api/operations/media.ts`)

- `MediaSchema` gains `kind`, `processingState`, `processingError` and `video` (data-model §5). The OpenAPI document regenerates from Zod, and the existing OpenAPI validation test covers it.
- The `uploadMedia` and `importMediaFromUrl` descriptions say "Images only; upload video in the app".
- A video body gets `415 unsupported_media_type` with "Video upload is available in the Docket app; the API accepts images only." (FR-044). It is detected by `sniffMedia` before sharp runs.

## Generator (P25)

- `listIdsForSelection` returns only `kind = 'image' AND processing_state = 'ready'`.
- `ensureVariant` refuses a video: "Videos are not sent to the model."

`tests/integration/generation/*` gains one case: a library holding a ready video and an image sends only the image.

## `docs/limits.md` rows (FR-039)

New categories go into the vocabulary in the doc's "How to read a row" and into `declared()` in `tests/integration/docs/limits-inventory.test.ts`:

- `videos` (every provider);
- `video with images`, `video containers`, `video codecs`, `audio codecs` and `silent video`;
- `video bytes`, `min duration` and `max duration`;
- `video min width`, `video max width`, `video min height` and `video max height`;
- `video min aspect`, `video max aspect` and `max frame rate`.

Every row except `videos` appears only when declared.

| Provider | Rows |
|---|---|
| Instagram, Facebook, Threads, Bluesky, X | `videos` with value `0`; source "not accepted in Docket yet (018 D4); researched limits arrive with entries 3, 4, 5 and 7" (X: "X video is not on the roadmap"); enforced in `validateResolvedContent`; test "`<key>: videos`" |
| Mock | one row per declared category, source "test double", enforced in `validateResolvedContent`, test "`mock: <category>`" |

`tests/helpers/limit-rows.ts` generates the video rows. Each row is a ready video asset row built by a factory (`createVideoAsset({ facts })`, no ffmpeg needed) whose facts break exactly that limit by one unit. `tests/integration/limits/enforcement.test.ts` then proves that the scheduling gate refuses with the row's code and that the provider's `advance` is never called (FR-039, SC-008).

## Tests

| Test file | Covers |
|---|---|
| `src/providers/validation.test.ts` | each video code at its boundary; processing and failed items; images unaffected by videos; `video_not_accepted` replacing `unsupported_post_type` |
| `src/providers/requirements.test.ts` | the video part for the mock and for every `maxVideos: 0` provider; the existing text, image and post expectations unchanged |
| `src/providers/registry.test.ts` | inconsistent video declarations are rejected |
| `src/providers/mock/mock.test.ts` | video steps, then the behaviours at publish |
| `src/server/services/media-fit.test.ts` | video fits and refused cases; never `converted`; not ready gives no badges |
| `tests/integration/compose/check.test.ts` | a processing video gives `media_processing`, which clears when the row turns ready (US3 AS5); the long video gives blocking issues for mock and Instagram (US3 AS4) |
| `tests/integration/media/video-publish.test.ts` (ffmpeg) | US4: upload through the services, `processNext`, schedule to mock, ticks → `upload_video`, `check_video` (processing), `publish`, then published; an out-of-limits video is refused at scheduling; an already-queued one fails on `engine-validate` (SC-009) |
| `tests/integration/api/media-video.test.ts` | list and get show video fields; upload and import of a video give 415 with the message |
