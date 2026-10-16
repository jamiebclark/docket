# Contract: the HTTP shape of a Story container and publish

Every request goes through `graphRequest(app, { method, path, params, token, signal })`
(`src/providers/meta/graph.ts`), which prefixes the Graph host and version and sends `access_token`.
The paths below are therefore written without a version segment, exactly as the provider passes them.
**No test may make a live call**: `fetch` is stubbed in every Instagram test, and the limits suite fails
if any request is attempted.

## R1. Create the Story container

`POST /{ig-id}/media`

| Kind | Params - exactly these, nothing else |
|---|---|
| image Story | `media_type=STORIES`, `image_url=<public URL of the asset or its variant>` |
| video Story | `media_type=STORIES`, `video_url=<public URL of the ready video version>` |

Built by `storyContainerParams(item, kind)` in `src/providers/instagram/requests.ts`. The function takes
no text argument, so a caption cannot be passed (FR-011), and never reads `item.altText` (FR-012).

Asserted by test:

- `Object.keys(params).sort()` is exactly `["image_url", "media_type"]` or `["media_type", "video_url"]`.
- Neither `caption` nor `alt_text` appears for a post that has text and a described asset (SC-004).
- `share_to_feed` never appears (that is a Reel parameter).

Response handling is the existing one: `id` present -> state gains `container`, `createdAt = now`,
`checks = 0`, `ready = false`, `quotaChecked = false`, and `notBefore` is `now + 10 s` for an image or
`now + 60 s` for a video; `id` missing -> `retryable_error`; a Graph error -> `graphStepError`, with the
public-URL hint appended when the message is about fetching the file.

## R2. Poll the container

`GET /{container-id}?fields=status_code,status`

A `STORIES` container reads the same fields a video container does, so an `ERROR` carries Instagram's
own explanation (K16). `status` is passed through `scrub(..., [token])`, stripped of control characters
and cut to 300 characters before it reaches any message or summary (principle VII).

| `status_code` | Result |
|---|---|
| `FINISHED` | `continue`, `ready = true`, `checks + 1` |
| `IN_PROGRESS` | `continue`, `checks + 1`, `notBefore` = the kind's cadence (image: 10 s doubling to 5 min; video: 60 s, then 5 min after 5 min); past `PROCESSING_CAP_MS` (60 min) -> `fatal_error` |
| `ERROR` | `fatal_error`: "Instagram could not process the Story's media{: detail}. Check the asset's format, size and shape; nothing was published." |
| `EXPIRED` | recreate the container (fresh state, `recreations + 1`); past `MAX_RECREATIONS` -> `fatal_error` naming the attempts |
| `PUBLISHED` | `ambiguous`: "Instagram reports this media as already published." Never retried (FR-009) |
| anything else | `retryable_error`: "Instagram returned an unknown media status." |

## R3. Check the publishing quota

`GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` - unchanged, and reached by a Story
like every other type (FR-025).

- The container's age is checked first: at or past `CONTAINER_SAFE_AGE_MS` (23 h) the container is
  recreated rather than published against an expiring id.
- `usage >= total` -> `retryable_error` with `notBefore = now + 1 h` (FR-026, SC-006).
- An unreadable reading -> `quotaChecked = true` and the sequence continues (existing behaviour).
- An invalid-token Graph error on this call is surfaced as the credentials failure it is.

## R4. Publish

`POST /{ig-id}/media_publish` with `creation_id=<container id>` - unchanged.

- `id` in the reply -> `done`, `externalId = id` (FR-010).
- No readable `id` -> `ambiguous` ("Instagram accepted the request but its reply could not be read").
- A Graph error on this step is classified by `graphStepError` with `mayPublish: true`, so an unknown
  outcome stays ambiguous and is never retried automatically.

## R5. Step sequence and leases

| Step | `mayPublish` | Allowance |
|---|---|---|
| `create_container` | false | 1 unit (`retryUnits: 1`) |
| `check_status` | false | none |
| `check_quota` | false | none |
| `publish` | **true** | none |

`instagramStepFor(state, content)` returns these for a `STORIES` plan with no new step name, so the
engine's lease, kill-recovery, backoff and ambiguity rules apply unchanged (FR-007, FR-008). A post
whose media or chosen type changed mid-sequence is caught by the existing
"expected step !== leased step" guard and fails with "The post changed while publishing."

## R6. Attempt summaries

`summarize(step, state, outcome, extra, request)` is reused unchanged, so every attempt records
`mediaType: "STORIES"`, the container id, the status code, the check count and the recreation count -
and no token, caption or alt text.
