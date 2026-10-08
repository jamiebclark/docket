# Research: Threads video

Phase 0 for `specs/023-threads-video/spec.md`. External facts come only from `docs/research/meta-video.md` (Threads section) and `docs/research/meta.md` (Threads section); this phase cannot fetch the web. Code facts (F*) were read from the repository on branch `023-threads-video` (base `c73ea6f`, entries 018, 019 and 021 merged). Plan decisions (P*) settle every open point in the spec.

No item in Technical Context is left as NEEDS CLARIFICATION. Three external facts stay UNVERIFIED by design (spec "Not stated for Threads"):

- whether a video carousel item must be `FINISHED` before the parent is created (decided conservatively: checked first, D5, P9);
- how long a video takes to process (decided with a 60-minute ceiling, D6, P10);
- the exact value of `error_message` for a refused video (matched as a whole token, P13).

Each is kept in one named constant or function, covered by mocked tests, and listed as an owed live check (FR-027).

## Research check (constitution I)

Every external fact in the spec was compared with `docs/research/meta-video.md` lines 252–287 ("Threads") and the "Specs per post type" table. They agree:

- `POST /{threads-user-id}/threads` with `media_type=VIDEO`, `video_url` (required) and optional `text`, then `threads_publish` with `creation_id`. `alt_text` is not mentioned for video.
- Carousel items: `is_carousel_item=true` with `media_type=VIDEO`. 2 to 20 items, mixed. One post against the 250 cap.
- The spec table: MOV or MP4; HEVC or H.264; AAC, 48 kHz, 1–2 channels; 23–60 fps; at most 1,920 horizontal pixels; 100 Mbps VBR; 128 kbps audio; over 0 s and at most 300 s; 1 GB; aspect 0.01:1 to 10:1, 9:16 recommended.
- Status: request `fields=status,error_message`. The values are `IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED`. Guidance: "once per minute, for no more than 5 minutes" and "on average 30 seconds". Error messages: `FAILED_DOWNLOADING_VIDEO`, `FAILED_PROCESSING_VIDEO`, `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE`, `INVALID_ASPEC_RATIO`.
- No new permission. Resumable upload is not documented (UNVERIFIED).

The brief and the constitution list video as out of scope "until a spec says otherwise"; this spec says otherwise for Threads video posts and video carousel items only.

## Code facts

- **F1 — Threads' step machine today.** `src/providers/threads/steps.ts` `threadsStepFor(state, content)` reads only `content.mediaCount`:
  - 0 → `TEXT`, 1 → `IMAGE`, 2 or more → `CAROUSEL` (`mediaTypeFor`, `state.ts`);
  - steps `create_container` | `create_item_<k>` … `create_carousel` → `check_status` → `check_quota` → `publish`;
  - more than 20 items or a non-finite count → `invalid`.
  - `validState(state, count)` restarts from the first create step when the saved state does not fit.
  - `index.ts` passes the engine's `StepContent` through unchanged, so `kinds` (019) already reaches it.
- **F2 — Threads' state.** `threadsStateSchema` is `{ v: 1, mediaType: TEXT|IMAGE|CAROUSEL, items: id[] (≤20), container, createdAt, checks, ready, quotaChecked, recreations (≤2) }`. Ids must match `^\d{1,40}$`. There is no per-item progress.
- **F3 — `advanceThreads` re-derives the step** from `{ text, mediaCount }` and fails "The post changed while publishing." on a mismatch. Whatever `stepFor` reads must also be readable from `PublishContext` (`content.media[].kind`).
- **F4 — Threads already reads `fields=status,error_message`** on every `check_status` (`publish.ts` line 127, asserted by `tests/integration/threads/publish-e2e.test.ts`).
  - `ERROR` fails with "Threads could not process the post: <reason>." or "… (status ERROR).", with the reason scrubbed of the token.
  - The attempt summary records `statusCode`, `checks`, `recreations` and `containerId`, but not `error_message` (FR-014 gap).
- **F5 — Threads pace today.** `FIRST_CHECK_DELAY_MS` 30 s, `CHECK_INTERVAL_MS` 60 s, and `PROCESSING_CAP_MS` 5 min from `createdAt`, after which `IN_PROGRESS` fails "Threads did not finish processing the post." `CONTAINER_SAFE_AGE_MS` 23 h is checked at `check_quota` against the parent's `createdAt` only.
- **F6 — Create-step refusals.** A fatal create whose message mentions fetch, download, retrieve or url gets " Images must be at a public URL (see <storage guide>)." appended.
- **F7 — Threads declares no video.** `capabilities.ts` has `video: { maxVideos: 0 }`, `postTypes: ["text", "image", "carousel"]`, `maxImages: 20`, and no `postTypeChoices` or `creationAllowance`. `docs/limits.md` has `threads: videos` with value 0.
- **F8 — `validateThreads` runs the image planner on every item with a width and height**, videos included. Once video is accepted, a video narrower than 320 px would get the image error `image_too_small`. It then removes `mime_not_allowed` and `file_too_large` for adaptable images.
- **F9 — The shared validator** (`src/providers/validation.ts`):
  - It counts images and videos separately: `too_many_images` against `media.maxImages`, and `too_many_videos` and `video_with_images` against `videoLimitsFor(caps, postType)`.
  - There is **no total-items check**, so 11 images plus 10 videos would raise neither. Instagram adds its own `too_many_items` in `validateInstagram`.
  - Video issues are labelled "Video <position>". Alt text is checked, and `missing_alt_text` raised, for images only.
- **F10 — Post type resolution.** `resolvePostType`:
  - one video with no declared choice → `video`;
  - two or more items → `carousel`;
  - so a carousel's videos use `videoLimitsFor(caps, "carousel")`.
- **F11 — Requirements summary** (`src/providers/requirements.ts`):
  - `carousel` is non-null only when `byPostType.carousel` is declared, with `maxItems = max(maxImages, carousel maxVideos)`.
  - `video.postType` is non-null whenever the provider declares a choice **or any `byPostType` entry** (`hasChoice`). The summary UI (`requirements-ui.ts`) then renders a "Post as" row and labels the video gist with the type label.
  - For a provider with only a carousel override and no choice, this would show "Post as: video" (lowercase, from `postTypeLabel`), which contradicts US4 #1 ("no 'Post as' choice is shown").
  - `video.notes` come from `byPostType[shown].notes` (021 fix).
- **F12 — `videoBytesLabel`** prints decimal megabytes only, so Threads' 1,000,000,000 bytes would read "1000 MB". It is used by the validator message and the summary only, and no test pins a value at or above 1 GB.
- **F13 — The enforcement-row generator** (`tests/helpers/limit-rows.ts` `videoRows`):
  - For a provider with no choice it always emits `<key>: videos` (`maxVideos + 1` videos) and `<key>: video with images` (a video plus an image), with `postType: "video"`.
  - The enforcement test then creates a real draft, where those media resolve to `carousel`. For a provider whose carousel override allows them (Threads: 20 videos, mixed), the draft is accepted and the row fails.
  - With a choice (Instagram, Facebook) the two rows are already skipped as "carousel rows".
- **F14 — Docket's own post cap is 10 items.** `POST_MEDIA_MAX = 10` (`src/lib/validation/scheduling.ts`) bounds `mediaIds` in the composer, the post services, the public API, generation and the media picker.
  - It predates Threads and Bluesky. Even an image-only Threads carousel cannot hold more than 10 items today.
  - The enforcement test already stops an over-10 row at the core.
- **F15 — Fit badges.** `videoFitOf` (`src/server/services/media-fit.ts`) calls `provider.validate` for a single video and lists its media errors. Threads' badge therefore follows `validateThreads` and the base video block with no code change, once F8 is fixed.
- **F16 — The engine already supplies `kinds`** (`dal/scheduler.ts` `contentShape`), runs the G15 re-check on a target's first step, and treats `continue` as resetting `attemptCount` (021 F6). The media variant planner skips videos (`media-variants.ts` line 30).
- **F17 — Edits while publishing are refused** (021 F12), so D10's restart is defensive, as in 019 and 021.
- **F18 — Test harness.**
  - `tests/helpers/threads-publish.ts` provides `threadsSetup` (JPEGs only), `scriptThreads` (`create`, `status`, `quota`, `publish`) and the token `THREADS_TOKEN`.
  - `instagramVideoSetup` (`tests/helpers/instagram-publish.ts`) shows how to attach ready videos with `createVideoAsset` and a stored object.
  - `tests/helpers/fake-graph.ts` records params with `access_token` redacted.
- **F19 — The provider guide test** (`tests/integration/docs/provider-guide.test.ts`) fails if a member of `src/providers/types.ts` is not documented. This entry adds **no** contract member, so no new G number is needed.

## Plan decisions

### Capabilities and validation (spec D1–D4, D12; FR-001–FR-005, FR-018, FR-019)

- **P1 — Declaration shape.** One exported constant, `THREADS_VIDEO`, holds the base block:
  - `maxVideos: 1`, `withImages: false`;
  - `containers: ["mp4", "mov"]`, `videoCodecs: ["h264", "hevc"]`, `audioCodecs: ["aac"]`, `silentAllowed: true`;
  - `maxBytes: 1_000_000_000`, `maxDurationSeconds: 300` (no minimum);
  - `maxWidth: 1920`, `minAspectRatio: 0.01`, `maxAspectRatio: 10`;
  - `minFrameRate: 23`, `maxFrameRate: 60`.

  `byPostType` adds two entries:
  - `video: { notes: ["9:16 (vertical) is recommended."] }`, for the summary only;
  - `carousel: { maxVideos: 20, withImages: true, notes: ["A carousel holds 2 to 20 items, images and videos counted together."] }`.

  `postTypes` becomes `["text", "image", "carousel", "video"]`. There are no `postTypeChoices` (D1) and no `creationAllowance` (D11).
  - *Why the base block is the single video:* a single video can only ever hold one video and no image (any second item makes a carousel). The carousel override then states the mix and the count, which gives the summary its carousel line (F11) through the existing mechanism.
  - *Rejected:* a base block of `maxVideos: 20, withImages: true` with no override. The summary would say "up to 20 per post" for a single video, and there would be no carousel line.
- **P2 — Generic fix: "Post as" only with a choice** (a fix to G20, like 021's notes fix). `requirementsOf` sets `video.postType` only when the provider declares a `postTypeChoices` entry; `byPostType` alone no longer turns it on.
  - Instagram and Facebook declare choices, so their output is unchanged. Threads gets no "Post as" row, and its gist reads "Video: …" (US4 #1).
- **P3 — Generic fix: gigabyte labels.** `videoBytesLabel(n)` prints `n / 1e9` with at most two decimals and " GB" when `n ≥ 1_000_000_000` ("1 GB", "1.05 GB"). Values below are unchanged ("300 MB"). The validator message and the summary use it.
- **P4 — `validateThreads` changes** (FR-003, FR-004, FR-005). These are the only Threads-specific checks:
  1. **The image planner loop skips video items** (F8). Videos are checked by the shared video bounds only.
  2. **Every `video_*` issue except `video_not_accepted`** gets its message rewritten as `<shared message without the final period> for Threads. Docket does not crop, trim or convert video yet.` For example: "Video 1 is 6 minutes long; the limit is 5 minutes for Threads. Docket does not crop, trim or convert video yet."
  3. **`too_many_items`** (error, field `media`, count and limit 20): "The post has <n> items; a Threads carousel holds at most 20 images and videos together." It is raised only when the post holds **both** images and videos and more than 20 items in total. Image-only and video-only posts are already caught by `too_many_images` and `too_many_videos`, so existing image results do not change (US1 #7).

  Alt text on video is neither sent nor checked (F9 already skips it). Image limits, text limits and the counting rule are unchanged.
- **P5 — Docket's 10-item post cap stays** (F14).
  - Threads declares its real 20-item limit, so validation, the summary and the step machine are correct for 2–20 items. But a post cannot hold more than 10 items anywhere in Docket today, for images or video.
  - The 20-item and 21-item cases of US2 #5 are therefore proved where they can occur: `validateThreads`, `threadsStepFor` and `advanceThreads` unit tests with mocked Graph replies. The enforcement row `threads: carousel videos` (21 videos) stops at the core, as the test already does for over-10 rows.
  - Raising `POST_MEDIA_MAX` touches the composer, the picker, the API schemas and generation for every provider. It is a product change outside this entry. It is recorded as unowned in `docs/feature-map.md` and in `docs/decisions.md`.
  - *Deviation:* US2 #5 says a 20-item carousel "succeeds"; through the composer it is refused at 11 items by Docket's own cap, as it is for images today.
- **P6 — Generic fix: enforcement rows for a carousel override** (F13). In `videoRows`, the base `videos` and `video with images` rows are skipped when the provider declares `byPostType.carousel`, as they already are with a choice, because such posts are carousels. `docs/limits.md` cites `src/providers/validation.test.ts` "limits videos and mixing with images" for those two Threads rows, as Instagram does.
  - The generated Threads rows are:
    - `video codecs`, `audio codecs`, `video bytes`, `max duration`;
    - `video max width`, `video min aspect`, `video max aspect`;
    - `min frame rate`, `max frame rate`;
    - `carousel videos`.
  - Mock, Instagram and Facebook rows are unchanged.

### Publishing (spec D1, D3–D10; FR-006–FR-017)

- **P7 — Request builders in a new `src/providers/threads/requests.ts`** (pure). All exact shapes are in [contracts/threads-publishing.md](./contracts/threads-publishing.md).
  - `videoContainerParams(item, text)` → `{ media_type: "VIDEO", video_url, text? }`.
  - `itemParams(kind, item)`:
    - a video → `{ media_type: "VIDEO", video_url, is_carousel_item: "true" }`;
    - an image → exactly today's `{ media_type: "IMAGE", image_url, is_carousel_item: "true", alt_text? }`.
  - `STATUS_FIELDS = "status,error_message"` for every read. This is unchanged for images (F4).
  - The single-image, text and carousel-parent requests stay inline as today, byte for byte.
- **P8 — State stays `v: 1` with optional fields** (D10, FR-015), so in-flight image and text targets resume unchanged.
  - `mediaType` gains `VIDEO`.
  - Optional `kinds` (2–20, `image | video`) is set only for a carousel with at least one video.
  - Optional `itemProgress`, aligned with `items`, holds `{ createdAt, checks, ready }` per item. Images are saved `ready: true`.
  - The plan is derived from the content, never stored on its own. `planOf({ mediaCount, kinds })` gives `TEXT`, `IMAGE`, `VIDEO` or `CAROUSEL` with kinds. Missing or misaligned `kinds` means all images (callers before 019).
- **P9 — Steps** (D5, FR-006, FR-008).
  - **Single video:** `create_container` → `check_status` → `check_quota` → `publish`.
  - **Carousel with video:** `create_item_1` … `create_item_n` → `check_item_<k>` (the first item whose progress is not ready; one read per step) → `create_carousel` → `check_status` → `check_quota` → `publish`.
  - **Image-only carousels, image and text posts** are unchanged.
  - Only `publish` has `mayPublish: true`.
  - `validState(state, plan)` returns null (restart from the first create step) when any of these hold:
    - the media type differs;
    - the saved kinds differ from the post's kinds;
    - there are more items than planned;
    - with video, `itemProgress` is not aligned with `items`;
    - a parent exists while an item is unready or the item count is short;
    - `ready` is set with no container;
    - `quotaChecked` is set while not ready.
- **P10 — Video pace and ceiling.** These are Threads' own constants in `state.ts`, equal in shape to Instagram's (019 D9), so the two can be tuned apart:
  - `VIDEO_FIRST_CHECK_DELAY_MS = 30_000`, Threads' "on average 30 seconds", the same as today's first image read;
  - `VIDEO_SLOW_AFTER_MS = 300_000`;
  - `VIDEO_PROCESSING_CAP_MS = 3_600_000`;
  - `videoCheckDelayMs(ageMs)` is 60 s while the age is under 5 min, and 300 s after.

  Where they apply:
  - A **video container** is a `VIDEO` container, a video item, or the parent of a carousel with a video. It uses this pace and ceiling, measured from its own creation.
  - Reads fall at about 0.5, 1.5, 2.5, 3.5, 4.5 and 5.5 min (6 reads), then 10.5 … 55.5 min (10), and the read at about 60.5 min is the 17th. If it is still `IN_PROGRESS`, the target fails with "Threads did not finish processing the video within 60 minutes; nothing was published." (SC-005: at most 17 reads, failed by about 61 min plus tick lag, under 65.)
  - Image and text containers keep `CHECK_INTERVAL_MS` and `PROCESSING_CAP_MS` and their message, unchanged.
- **P11 — When item reads fall due** (D5, edge case "a video item finishes, but another is still processing").
  - When the last item is created and some video item is unready, `notBefore` is that first unready item's `createdAt + 30 s`. It may be in the past; the engine uses `max(now, notBefore)`.
  - After `FINISHED` on item k, `notBefore` is the next unready item's `createdAt + 30 s`. When none is left, there is no `notBefore`, and `create_carousel` follows.
  - After `IN_PROGRESS`, `notBefore` is `now + videoCheckDelayMs(age of item k)`.
  - A finished item is never read again. Items created in consecutive ticks process in parallel on Threads' side, so the total wait is roughly the slowest item's, not the sum.
- **P12 — Reading a status reply.** One function, `readStatus(body, secrets)`, returns `{ status, errorMessage }`:
  - `status` is the string, or null;
  - `errorMessage` is a string with control characters removed, trimmed, at most 300 characters, scrubbed of the token, or "" when absent or not a string.
  - Every status read, image or video, adds `errorMessage` to its attempt summary when it is not empty (FR-014). The field is additive and only appears on replies that carry one; image messages and outcomes are unchanged.
- **P13 — Video error explanations** (D7, FR-012). One function, `videoErrorExplanation(errorMessage)`, lives in `src/providers/threads/video-errors.ts`.
  - The documented codes are matched **case-sensitively as whole tokens** (`\b<CODE>\b`), in the documented order, against Threads' `error_message`. So `INVALID_ASPEC_RATIO` matches only Threads' own spelling, and a message that wraps the code in a sentence still matches.
  - The explanation figures come from `THREADS_VIDEO` (300 seconds, 23 to 60 fps, 1:100 to 10:1), never from literals.
  - The message wording is in [contracts/threads-publishing.md](./contracts/threads-publishing.md) §5. Image `ERROR` keeps today's message.
  - *Reverse:* if the live check (FR-027) shows a different `error_message` form, only this function changes.
- **P14 — Create refusals on a post with video** append " Media must be at a public URL (see <storage guide>)." in place of today's " Images must be …". The trigger is the same fetch/download/url test (F6). Image-only posts keep today's hint.
- **P15 — Expiry and age.**
  - `EXPIRED` on a single video, a video item or the parent recreates the whole post with the same plan, at most twice in total, then fails with today's message (D5).
  - The 23-hour guard at `check_quota` measures from the **oldest** container: the parent's `createdAt` and every `itemProgress[].createdAt`. Image carousels have no `itemProgress`, so they are unchanged.
- **P16 — Outcomes are unchanged** (D9, FR-013). The shared `graphStepError` mapping applies to every new request.
  - `PUBLISHED` on any read (item, single or parent) is `ambiguous`.
  - An unknown or unreadable status is `retryable_error`, as today. A token rejection is fatal with `credentialsInvalid`.
  - "Check again" is a `continue` with `notBefore`, so checks never count towards `maxAttempts`, and only the ceilings end them.
  - Only `publish` can be ambiguous on a timeout or an unreadable reply.
- **P17 — A changed post restarts** (D10) through `validState` returning null in `threadsStepFor`. The engine's next lease is then the first create step. A step-name mismatch between the lease and `advanceThreads`'s own derivation is fatal "The post changed while publishing.", as today. Containers already created are left to expire.
- **P18 — No engine, schema, composer or API change.** `kinds` already reaches `stepFor` (F16). Generated, bulk and API posts with one video resolve to `video` with no field to set (D1).

### Tests, docs and deployment (FR-020–FR-027)

- **P19 — Tests go in new files.** Every existing Threads test file stays byte-for-byte unchanged (FR-026, SC-008). New files:
  - unit: `src/providers/threads/video-steps.test.ts`, `video-publish.test.ts`, `video-validate.test.ts`, `video-errors.test.ts`, `state.test.ts`;
  - integration: `tests/integration/threads/video.test.ts`, `video-carousel.test.ts` and `video-failures.test.ts`;
  - the helper `threadsVideoSetup` is added to `tests/helpers/threads-publish.ts` without changing `threadsSetup`.

  Extended files: `tests/integration/meta/no-secrets.test.ts`, the limits inventory, `tests/helpers/limit-rows.ts` (P6), `src/providers/requirements.test.ts` (P2) and `src/providers/video-labels.test.ts` (P3).
- **P20 — Docs.** These follow FR-020–FR-024:
  - `docs/limits.md` Threads rows (data-model §6);
  - `docs/adding-a-provider.md` §15;
  - `docs/feature-map.md`: Threads video built. Unowned: resumable or byte upload, a cover or thumbnail, posts of more than 10 items (P5), API video upload and generator video;
  - `docs/meta-setup.md`: a "Threads video: owed live checks" section;
  - `docs/decisions.md` `## 023`, written in this phase.
- **P21 — No deployment change** (FR-025). `docker-compose.yml`, `.env.example`, migrations and dependencies do not change. ffmpeg and the upload limits arrived with 018, and this entry runs no ffmpeg.
