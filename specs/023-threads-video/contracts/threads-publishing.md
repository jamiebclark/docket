# Contract: Threads video publishing

Covers FR-006–FR-017, FR-026, US1–US3. State and steps are in [data-model.md](../data-model.md) §2–§3. Every request goes through `graphRequest(threadsApp(), …)` with the user's token, to the configured Threads Graph base only (FR-017). The token is form-encoded on POST and in the query on GET, and is redacted from everything recorded.

## 1. Steps

| Post | Steps (in order; `*` = repeated until done) | mayPublish |
|---|---|---|
| text | `create_container`, `check_status`*, `check_quota`, `publish` | publish only |
| one image | the same | publish only |
| **one video** | `create_container`, `check_status`*, `check_quota`, `publish` | publish only |
| image carousel | `create_item_1..n`, `create_carousel`, `check_status`*, `check_quota`, `publish` | publish only |
| **carousel with ≥ 1 video** | `create_item_1..n`, `check_item_<k>`* for each video item k (first unready first), `create_carousel`, `check_status`*, `check_quota`, `publish` | publish only |

## 2. Requests

Every create request is `POST /{threads-user-id}/threads`. The params, besides `access_token`, are listed below.

| Step | Params | Never sent |
|---|---|---|
| `create_container`, one video | `media_type=VIDEO`, `video_url=<public URL of the stored original>`, `text=<target text>` only if the text is not empty | `image_url`, `alt_text`, `is_carousel_item`, `children` |
| `create_item_<k>`, video | `media_type=VIDEO`, `video_url`, `is_carousel_item=true` | `text`, `alt_text`, `image_url` |
| `create_item_<k>`, image | `media_type=IMAGE`, `image_url`, `is_carousel_item=true`, `alt_text` only if not blank (unchanged) | `text` |
| `create_carousel` | `media_type=CAROUSEL`, `children=<item ids in post order, comma-joined>`, `text` if not empty (unchanged) | `alt_text` |
| text / one image | unchanged | — |

The other requests:

- **Status read** (`check_item_<k>` and `check_status`): `GET /{container-id}?fields=status,error_message`.
- **`check_quota`**: `GET /{threads-user-id}/threads_publishing_limit?fields=quota_usage,config` (unchanged).
- **`publish`**: `POST /{threads-user-id}/threads_publish` with `creation_id=<parent or single container id>` (unchanged).

## 3. Pace (DB clock; `notBefore` only, never sleeping)

| Container | First read | Then | Ceiling (`IN_PROGRESS` at or after this age fails) |
|---|---|---|---|
| text, image, image-only carousel parent | 30 s after creation | every 60 s | 5 min (unchanged message "Threads did not finish processing the post.") |
| one video; carousel parent with a video | 30 s after creation | every 60 s while younger than 5 min, then every 5 min | 60 min |
| video item | its `createdAt + 30 s`; due once the last item is created (research P11) | as for a video | 60 min, from the item's own creation |

At most 17 reads per video container if each read falls on time (research P10).

## 4. Status reply handling (every read)

`readStatus(body, [token])` → `{ status, errorMessage }` (data-model §4). The attempt summary has:

- request: `{ step, mediaType, containerId, itemIndex?, itemKind? }`;
- response: `{ …graphSummary, statusCode, checks, recreations, errorMessage? }`.

`errorMessage` is only present when it is not empty (FR-014).

| `status` | Single / parent | Video item k |
|---|---|---|
| `FINISHED` | `continue`, `ready: true` | `continue`, `itemProgress[k].ready = true`, `notBefore` = next unready item's `createdAt + 30 s` if any |
| `IN_PROGRESS`, under the ceiling | `continue`, `checks + 1`, `notBefore` per §3 | `continue`, `itemProgress[k].checks + 1`, `notBefore = now + videoCheckDelayMs(age)` |
| `IN_PROGRESS`, at or past the ceiling | `fatal_error` (§5) | `fatal_error` (§5) |
| `ERROR` | `fatal_error` (§5; image text unchanged) | `fatal_error` (§5) |
| `EXPIRED` | recreate the whole post (`initialState(plan)`, `recreations + 1`); at 2 → `fatal_error` "Threads media expired before it could be published (tried 3 times). Retry the post." (unchanged) | the same |
| `PUBLISHED` | `ambiguous` "Threads reports this post as already published." (unchanged) | `ambiguous`, the same message |
| anything else, or an unreadable body | `retryable_error` "Threads returned an unknown container status." (unchanged) | the same |

A Graph or transport failure on a read goes through `graphStepError` with `mayPublish: false`. The result is retryable or fatal, never ambiguous (FR-013). A token rejection is fatal with `credentialsInvalid`, which flags the account.

## 5. Messages (exact)

`<reason>` is `errorMessage` with any final period removed. When it is empty, the text is `(status ERROR)` with no colon. `<explanation>` is from `videoErrorExplanation(errorMessage)` and is omitted when null. The figures come from `THREADS_VIDEO`; `<storage>` is `docsUrl("storage")`.

| Case | Message |
|---|---|
| `ERROR`, one video | `Threads could not process the video: <reason>. <explanation> Nothing was published; retry the post after fixing the video.` |
| `ERROR`, video item k | `Threads could not process the video in item <k> of the carousel: <reason>. <explanation> Nothing was published; retry the post after fixing the video.` |
| `ERROR`, parent with video | `Threads could not process the video carousel: <reason>. <explanation> Nothing was published; retry the post after fixing the video.` |
| `ERROR`, image or text container | unchanged: `Threads could not process the post: <reason>.` / `Threads could not process the post (status ERROR).` |
| video ceiling (single, item or parent) | `Threads did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again.` |
| create refused with a fetch/download/url message, post has a video | `<Threads' message> Media must be at a public URL (see <storage>).` |
| the same, image-only post | unchanged: `… Images must be at a public URL (see <storage>).` |

| Code (whole token, case-sensitive) | `<explanation>` |
|---|---|
| `FAILED_DOWNLOADING_VIDEO` | `Threads could not fetch the video; media storage must be publicly readable (see <storage>).` |
| `FAILED_PROCESSING_VIDEO` | `Threads could not process the file, usually because of its encoding.` |
| `INVALID_DURATION` | `Threads videos can be at most 300 seconds.` |
| `INVALID_FRAME_RATE` | `Threads videos must be 23 to 60 frames per second.` |
| `INVALID_BIT_RATE` | `The video's bitrate is above Threads' limit, which Docket does not check.` |
| `INVALID_ASPEC_RATIO` | `Threads videos must have an aspect ratio between 1:100 and 10:1.` |
| any other | none; Threads' text is shown as sent, scrubbed |

No message, summary or log contains the token (FR-017, SC-007).

## 6. Quota step and age

- `check_quota` recreates the post (reason `AGED`) when the **oldest** of the parent's `createdAt` and every `itemProgress[].createdAt` is 23 hours old or more.
- Image-only carousels and single containers are unchanged.
- The quota read, the 1-hour retry when full, and "unknown quota continues" are unchanged.

## 7. Publish

The request is unchanged:

- An id means `done` with the id.
- An unreadable 2xx, a network failure after sending, or a timeout is `ambiguous`, never retried (FR-013).
- Any other refusal is fatal with " Retry the post to create it again." (unchanged).

## 8. Changed post

- `advanceThreads` derives `kinds` from `ctx.content.media[].kind` and recomputes `threadsStepFor(ctx.state, { text, mediaCount, kinds })`. A different step name from the lease → `fatal_error` "The post changed while publishing." (unchanged).
- When the media no longer fit the saved state, `validState` returns null. The engine then leases the first create step, and old containers are left unused (D10). Examples:
  - an item is added, removed or reordered;
  - an item is swapped between image and video;
  - an image post becomes a video post.

## 9. Tests (mocked Graph only; DB clock via `atTime`; new files)

**Unit tests, with a stubbed `graphRequest` via the fake Graph and no DB:**

- `src/providers/threads/state.test.ts`:
  - every pre-023 state shape parses;
  - VIDEO, kinds and itemProgress bounds;
  - `videoCheckDelayMs` at 0, 299,999 and 300,000 ms.
- `src/providers/threads/video-steps.test.ts`:
  - a single video from empty and from every saved state;
  - mixed (image, video, image), all-video (2) and 20-item carousels, through every step;
  - `check_item_<first unready>`;
  - state that no longer fits: kinds changed, image↔video swapped, item removed, parent with unready items, misaligned progress → first create step;
  - more than 20 items → `invalid`;
  - only `publish` may publish;
  - garbled state and content are total.
- `src/providers/threads/video-errors.test.ts`:
  - each code alone and inside a sentence;
  - `INVALID_ASPECT_RATIO` (the corrected spelling) does not match;
  - lowercase does not match;
  - the figures come from `THREADS_VIDEO`.
- `src/providers/threads/video-publish.test.ts`: `advanceThreads` with fake Graph replies for each request shape of §2 (exact params and absent keys) and each row of §4 and §5. It also covers:
  - the 20-item mixed carousel's `children` order;
  - the token absent from every result.

**Integration tests, through `runTick` with the real scheduler** (`threadsVideoSetup(storage, text, kinds)`):

- `tests/integration/threads/video.test.ts` (US1):
  - one 1,080 × 1,920, 30 s video with text: the exact create request; three `IN_PROGRESS` reads at about 30 s, 90 s and 150 s; `FINISHED`; quota; publish with `creation_id`; the target published with Threads' id;
  - no text → no `text` param;
  - a timeout on create and on a read is retried;
  - a timeout after publish was sent, and an unreadable publish reply, are ambiguous and not retried.
- `tests/integration/threads/video-carousel.test.ts` (US2):
  - image, video, image: three item requests in order, and only item 2 is read;
  - "creates the carousel only after every video item is finished": no `CAROUSEL` request while item 2 is `IN_PROGRESS`;
  - then the parent at the video pace, quota, and publish;
  - an all-video pair, where both items are read and the second item is read only after the first finishes;
  - the image-only carousel is unchanged: no item reads, and the parent is read at the 60 s pace with the 5-minute cap.
- `tests/integration/threads/video-failures.test.ts` (US3):
  - each documented code on a single video and on item 2, with the §5 messages and no `CAROUSEL` or publish request;
  - an unknown message shown as sent;
  - "moves to the 5-minute pace after 5 minutes, and fails at 60 minutes within 17 reads" (single video), and the same for a video item;
  - `EXPIRED` on a single video and on an item recreates the post from the first item, and fails on the third expiry;
  - `PUBLISHED` while checking an item → ambiguous;
  - an unknown status is retried;
  - a token rejection on a read → failed, and the account is flagged;
  - a worker killed mid-step (stale lease) resumes at the saved step;
  - the post changed between ticks (video swapped for an image) restarts at `create_item_1` / `create_container`;
  - the 23-hour guard measured from the oldest item.
- `tests/integration/meta/no-secrets.test.ts` (extended): a Threads video `ERROR` whose `error_message` echoes the token. The token appears in no attempt, `lastError` or summary.

All existing files in `tests/integration/threads/`, `src/providers/threads/*.test.ts` and the Instagram, Facebook and Bluesky suites pass unchanged (SC-008).
