# Contract: Instagram Reels, Feed video and mixed carousels (step machine)

Covers FR-001–FR-005, FR-011–FR-018, FR-032, FR-033, US1, US4, US5, D1, D8, D9, D11–D13. Decisions: research P14–P21. State, plan and transitions: [data-model.md](../data-model.md) §4.

## 1. Inputs

- **`stepFor`** receives `StepContent` with `kinds` and `postType`, resolved by the engine (post-type-choice.md §2). The mock and the other providers ignore the new fields.
- **`advance`** recomputes the expected step from `ctx.content.media` (kinds), `ctx.postType` and `ctx.state`. It fails "The post changed while publishing." when the result differs from `ctx.step.name` (unchanged rule, F3).
- **`ctx.content.media[i].url`** is the public URL of the stored original for videos (D11) and of the adapted variant for images, as today.

## 2. Requests (pure builders in `src/providers/instagram/requests.ts`)

| Step | Method, path | Params |
|---|---|---|
| `create_container` (IMAGE) | `POST /{ig}/media` | unchanged: `image_url`, `caption?`, `alt_text?` |
| `create_container` (REELS) | `POST /{ig}/media` | `media_type=REELS`, `video_url`, `caption?` (when text is not empty), `share_to_feed=true` (Feed video) or `share_to_feed=false` (Reel) |
| `create_item_<n>` (image) | `POST /{ig}/media` | unchanged: `image_url`, `is_carousel_item=true`, `alt_text?` |
| `create_item_<n>` (video) | `POST /{ig}/media` | `video_url`, `is_carousel_item=true`, plus `media_type=REELS` **only if** `VIDEO_ITEM_MEDIA_TYPE` is set (it is `null`: omitted, P14) |
| `create_carousel` | `POST /{ig}/media` | unchanged: `media_type=CAROUSEL`, `children=<ids in post order>`, `caption?` |
| `check_item_<k>` | `GET /{item id}` | `fields=status_code,status` |
| `check_status` (holds video) | `GET /{container}` | `fields=status_code,status` |
| `check_status` (image only) | `GET /{container}` | `fields=status_code` (unchanged, P16) |
| `check_quota` | `GET /{ig}/content_publishing_limit` | unchanged |
| `publish` | `POST /{ig}/media_publish` | unchanged: `creation_id` |

**Never sent:**

- `media_type=VIDEO` or `STORIES`, in any request;
- `alt_text`, a caption or `share_to_feed` on a video item;
- `cover_url`, `thumb_offset`, `audio_name`, `collaborators`, `location_id`, `user_tags`, `trial_params` or `is_ai_generated` (FR-002).

**Attempt summary.** `request.mediaType` carries the plan's type (`IMAGE`/`REELS`/`CAROUSEL`). Other request fields:

- `shareToFeed` for REELS;
- `itemIndex` and `itemKind` for item steps (`imageIndex` stays for image items, unchanged);
- `containerId` for checks.

The response gains `statusDetail` when present.

## 3. Pace and ceilings (D9, P17)

| Container | First check | Then | Ceiling (from its own creation) |
|---|---|---|---|
| Image or image carousel | +10 s | `checkIntervalMs(checks)` (10 s doubling to 5 min), unchanged | 60 min: "Instagram did not finish processing the media." (unchanged) |
| Reel, video item, carousel with a video | +60 s | +60 s while age < 5 min, then +5 min | 60 min: "Instagram did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again." |

Each check is one Graph read in one step. There is no in-process waiting (FR-015). With a tick at least once a minute, a container that stays `IN_PROGRESS` is checked at most 16 times and fails within 65 min (SC-005). A `FINISHED` read continues with no delay, so the quota step and the publish follow on the next ticks (SC-004).

## 4. State changes mid-publish (D13, FR-018)

These cases make `validState` return `null`, so the target restarts at its first create step:

- a different item kind;
- a different count;
- a different post type (REELS `shareToFeed` differs);
- a change between REELS and CAROUSEL.

The restart creates new containers and reserves the whole need again (creation-allowance.md); the abandoned ones stay counted. The check runs before every step, including just before `publish`. Since `publish` is the only step that may publish, a restart can never double-post.

## 5. Results and messages

| Situation | Kind | Message (`lastError`) |
|---|---|---|
| Reel `ERROR` | fatal | `Instagram could not process the video: <detail>. Check its format, codec, frame rate and bitrate; nothing was published.` (`: <detail>` omitted when empty) |
| Video item `ERROR` | fatal | `Instagram could not process video <k> of the carousel (item <k>): <detail>. Check its format, codec, frame rate and bitrate; nothing was published.` The carousel container is never created. |
| Carousel container `ERROR` with a video | fatal | `Instagram could not process the carousel: <detail>. Check each video's format, codec, frame rate and bitrate; nothing was published.` |
| Image container `ERROR` | fatal | unchanged |
| Video ceiling | fatal | §3 |
| `EXPIRED` on any item or container; 23 h guard | continue (rebuild) / fatal after 2 | unchanged texts |
| `PUBLISHED` found while checking | ambiguous | unchanged |
| Unknown status | retryable | unchanged |
| Create refused because Instagram cannot fetch the URL | fatal | Graph message + " Media must be at a public URL (see <storage doc>)." |
| Timeout, network drop or 5xx on a create or check | retryable (engine, `mayPublish: false`) | unchanged |
| Same on `publish` | ambiguous, never retried automatically | unchanged |
| Graph rate limit on create | retryable wait | unchanged (FR-021) |

**`<detail>`** is the Graph `status` string, read defensively (strings only). Control characters are stripped and the text is cut to 300 characters. The engine's `redact` removes the token before it is stored in `lastError` or in `publish_attempts` (constitution VII).

## 6. Tests (mocked Graph only; the DB clock is advanced, never slept)

**Unit tests** (`src/providers/instagram/*.test.ts`, no DB):

| File | Proves |
|---|---|
| `steps.test.ts` | The plan table and step derivation for one image, a Feed video, a Reel, a carousel of image+video+image, and an all-video carousel; `check_item_<k>` order; `allowance` on each step; v1 image states from before 019 stay valid; mismatched kinds, count or `shareToFeed` restart; totality on garbage state. |
| `publish.test.ts` | Exact params for each §2 row via `createFakeGraph`; no logged request has `media_type=VIDEO`; no `alt_text` on video; `share_to_feed=false` for a Reel; `children` in post order; the image status read is still exactly `{ fields: "status_code" }`. |
| `state.test.ts` (new) | `videoCheckDelayMs` boundaries (4:59 → 60 s, 5:00 → 300 s); schema accepts old and new shapes; `recreated()` keeps the plan. |

**Integration tests** through `runTick` with `atTime` (`tests/integration/instagram/`):

| File | Proves |
|---|---|
| `reels.test.ts` (new) | Feed video and Reel: create → three `IN_PROGRESS` reads about 60 s apart → `FINISHED` → quota → one publish; `externalId` and `externalUrl` stored (FR-004). `IN_PROGRESS` past 5 min moves to the 5-minute pace. At 60 min: failed, the ceiling message, ≤ 16 status reads, no publish. `ERROR` with a detail: message and attempt `statusDetail`, no token in it. `EXPIRED` rebuild up to twice. Timeout or network drop on create and on check → retryable; on publish → ambiguous, no retry. Kill and restart at every step resumes from saved state. Switching to Reel before publish restarts at `create_container` with `share_to_feed=false`. |
| `video-carousel.test.ts` (new) | image, video, image: three item creates in order, video item polled until `FINISHED` before `create_carousel`, carousel polled at the video pace, one publish. All-video carousel: every item is polled first. Item `ERROR` → fails naming item 2, no `create_carousel`. Item `EXPIRED` → rebuild from item 1, at most twice. 23 h guard measured from the first video item. 11 items refused before any request. |
| `publish-e2e.test.ts`, `carousel.test.ts`, `container-status.test.ts`, `outcomes.test.ts`, `quota.test.ts`, `limits.test.ts` | **Unchanged and passing** (FR-005, SC-008). |
| `tests/integration/meta/no-secrets.test.ts` | Extended with a video `ERROR` whose detail contains the token: no token in `lastError`, the attempts or logs. |

**Helper.** `tests/helpers/instagram-publish.ts` gains `instagramVideoSetup(storage, text, kinds, { postType? })`. It attaches `createVideoAsset` rows (ready, Reel-valid facts) and images in the given order, using the existing `metaSetup` account.
