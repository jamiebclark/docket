# Contract: Bluesky video publishing

Covers FR-005–FR-017, FR-026 and US1, US2, US4. State, phases and constants are in [data-model.md](../data-model.md) §2–§5; decisions P* are in [research.md](../research.md).

## 1. Files

| File | Role |
|---|---|
| `src/providers/bluesky/video-state.ts` (new) | `videoUploadSchema`, pace constants, `fitState`, `partRange(k)`, `nextReadAt` |
| `src/providers/bluesky/pds-host.ts` (new) | `pdsHostOf(didDoc): string \| null` (P4) |
| `src/providers/bluesky/video-service.ts` (new) | `VIDEO_SERVICE_URL = "https://video.bsky.app"`, `VIDEO_SERVICE_DID = "did:web:video.bsky.app"`, `serviceToken`, `getUploadLimits`, `startUpload`, `uploadPart`, `finishUpload`, `getJobStatus`, `VideoServiceError` (P5) |
| `src/providers/bluesky/media-range.ts` (new) | `readRange(url, first, last, signal)`, `storedSize(url, signal)` (P6) |
| `src/providers/bluesky/video-errors.ts` (new) | explanations of §7, `sanitiseMessage(text, secrets)` (P17) |
| `src/providers/bluesky/video-publish.ts` (new) | the five video step handlers |
| `src/providers/bluesky/settings.ts` | `blueskyStateSchema` gains `video: videoUploadSchema.optional()` |
| `src/providers/bluesky/steps.ts` | `stepForContent` reads `kinds` and the upload phase (data-model §3) |
| `src/providers/bluesky/publish.ts` | dispatches video steps; `createPost` adds the video embed (§4.6) |
| `src/providers/types.ts`, `src/server/scheduler/record.ts` | G24 `continue.wait` (§8) |

## 2. Service tokens (D4, P3)

Before each video service call the step sends:

```http
GET <settings.pdsUrl>/xrpc/com.atproto.server.getServiceAuth?aud=<aud>&lxm=<lxm>&exp=<floor(now/1000)+300>
Authorization: Bearer <session accessJwt>
```

`aud` and `lxm` per call are in research P3. The reply's `token` is used once, as `Authorization: Bearer <token>` on the request to `https://video.bsky.app`, and never leaves the step. Outcomes of the token request:

| Reply | Outcome |
|---|---|
| 200 with `token` | the video call is made |
| 401, or 400 `ExpiredToken` | `retryable_error`, `credentialsExpired: true` (refresh, then retry; never ambiguous) |
| 429 | `retryable_error` with `Retry-After` |
| 5xx, timeout, dropped connection, unreadable 200 | `retryable_error` |
| other 4xx (e.g. `BadExpiration`, `InvalidRequest`) | for the limits check: skipped (P10); otherwise `fatal_error` "Bluesky refused to issue a video upload credential (<code>); nothing was published." |

## 3. The PDS host (P4)

At `check_upload_limits`, when the upload has no `pdsHost`:

```http
GET <settings.pdsUrl>/xrpc/com.atproto.server.getSession
Authorization: Bearer <session accessJwt>
```

- 200 with a `didDoc` whose `service[]` has `{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://<host>…" }` → `pdsHost = <host>`, `pdsHostSource = "session"`.
- 200 without a usable entry, or a 4xx other than 401 / `ExpiredToken` / 429 → `pdsHost = new URL(settings.pdsUrl).hostname`, `pdsHostSource = "configured"`.
- 401 / `ExpiredToken` → `credentialsExpired` retry; 429, 5xx, timeout → retry.

Upload tokens then use `aud = did:web:<pdsHost>`.

## 4. Steps, exact requests and outcomes

Every step: first derive the step and fit the state (data-model §3, P18); if the saved `url` or `sizeBytes` differs from `content.media[0]`, return `continue` with `{ v: 1 }` (the post changed). Video service requests go to `https://video.bsky.app/xrpc/<method>` with the service token, the step's signal and nothing else.

### 4.1 `check_upload_limits`

1. Resolve the PDS host if missing (§3).
2. Token: `aud = did:web:video.bsky.app`, `lxm = app.bsky.video.getUploadLimits`.
3. `GET /xrpc/app.bsky.video.getUploadLimits`.

| Reply | Outcome |
|---|---|
| `canUpload: true` | `continue`, phase `start`, `limitsCheck: "ok"`; summary records `remainingDailyVideos`, `remainingDailyBytes` |
| `canUpload: false`, first refusal | `continue`, phase stays `limits`, `limitWaitSince = now`, `notBefore = now + 1 h`, `wait` = limit wait text (§7) |
| `canUpload: false`, `now − limitWaitSince < 23 h` | same, `limitWaitSince` kept |
| `canUpload: false`, `now − limitWaitSince ≥ 23 h` | `fatal_error`, limit failure text (§7) (P9) |
| 4xx other than 429; refused token (§2); unreadable 200 | `continue`, phase `start`, `limitsCheck: "skipped"`, summary `error` = code (P10) |
| 429, 5xx, timeout, dropped connection | `retryable_error` |

### 4.2 `start_upload`

1. `storedSize(url)`: `GET <url>` with `Range: bytes=0-0`; the `Content-Range` total must equal `item.bytes`, else `retryable_error` "The stored video's size does not match its record; will retry." (D10, P6). `item.mimeType` must be `video/mp4`, else `fatal_error` "The video is not an MP4 file Bluesky accepts; nothing was published." (defence in depth behind G15.)
2. Token: `aud = did:web:<pdsHost>`, `lxm = com.atproto.repo.uploadBlob`.
3. Request:

```http
POST /xrpc/app.bsky.video.startUpload
Content-Type: application/json

{ "sizeBytes": <item.bytes>, "mimeType": "video/mp4", "name": "<target id>.mp4",
  "durationMs": <round(video.durationSeconds × 1000)>, "width": <item.width>, "height": <item.height> }
```

`durationMs`, `width` and `height` are left out when unknown.

| Reply | Outcome |
|---|---|
| 200, usable (P7) | `continue`, phase `parts`, saves `url`, `sizeBytes`, `jobId`, `partSizeBytes`, `partCount`, `partsSent: 0`, `expiresAt`; clears `limitWaitSince` |
| 200, unusable | `retryable_error` "Bluesky gave an unusable answer when starting the upload; will retry." |
| non-2xx whose body carries a video blob (P15) | `continue`, phase `ready`, `blob` |
| `DailyLimitExceeded` | as `canUpload: false` in §4.1 (phase back to `limits`, `wait`, 23 h rule) |
| `TooManyOpenUploads`, `ServiceOverloaded`, 429, 5xx, timeout | `retryable_error` (with `Retry-After` when given) |
| `UnsupportedContentType`, `VideoTooLarge`, `VideoTooLong`, `BadAspectRatio`, `UploadForbidden` | `fatal_error`, §7 start refusal text |
| 401 / 403 from the video service | `fatal_error` "Bluesky's video service did not accept Docket's upload credential (<code>); nothing was published." |
| any other 4xx | `fatal_error` "Bluesky refused the video upload (<code>: <message>); nothing was published." |

### 4.3 `upload_part_<k>`

1. If `now ≥ expiresAt − 60 s`: restart (§6), no call.
2. `readRange(url, first, last)` for part `k` (P7): `206`, length `last − first + 1`, `Content-Range` total `= sizeBytes`. A `200` is cancelled unread → `retryable_error` (P6). A different total → restart (§6). A fetch failure or 5xx from storage → `retryable_error` "Could not read part <k> of the video; will retry."
3. Token: as §4.2.
4. Request:

```http
POST /xrpc/app.bsky.video.uploadPart?jobId=<jobId>&partNumber=<k>
Content-Type: application/octet-stream
Content-Length: <exactly the part's length>

<the part's bytes>
```

| Reply | Outcome |
|---|---|
| 200 with `partNumber = k` | `continue`, `partsSent = k`; after the last part, phase `finish` |
| `UploadAlreadyCompleted` | `continue`, `partsSent = partCount`, phase `finish` |
| `UploadExpired`, `UploadNotFound`, `UploadAborted`, `PartSizeMismatch` | restart (§6) |
| `UploadNotReady`, `ServiceOverloaded`, 429, 5xx, timeout, dropped connection, 200 with another `partNumber` | `retryable_error`, same `k` next time (FR-010); a timeout uses P21's text |
| `UploadFailed`, `InvalidPartNumber`, 401 / 403, other 4xx | `fatal_error` "Bluesky refused part <k> of the video (<code>: <message>); nothing was published." |

### 4.4 `finish_upload`

1. Expiry check as §4.3.
2. Token as §4.2. `POST /xrpc/app.bsky.video.finishUpload` with `{ "jobId": "<jobId>" }`.

| Reply | Outcome |
|---|---|
| 200, `jobStatus.state = JOB_STATE_FAILED` | `fatal_error`, §7 job failure text |
| 200 with `jobStatus.blob` | `continue`, phase `ready` (no status read, FR-011) |
| 200 otherwise | `continue`, phase `job`, `pollJobId = completedJobId` (differs from `jobId` on deduplication), `finishedAt = now`, `reads: 0`, `notBefore = now + 30 s` |
| non-2xx with a video blob in the body (P15) | `continue`, phase `ready` |
| `UploadExpired`, `UploadNotFound`, `UploadAborted`, `MissingParts` | restart (§6) |
| `UploadNotReady`, `ServiceOverloaded`, 429, 5xx, timeout | `retryable_error` |
| `UnsupportedContentType` | `fatal_error`, §7 start refusal text |
| `UploadFailed`, other 4xx | `fatal_error` "Bluesky could not finish the video upload (<code>: <message>); nothing was published." |

### 4.5 `check_job`

1. If `statusAuth = "service"`: token `aud = did:web:video.bsky.app`, `lxm = app.bsky.video.getJobStatus`.
2. `GET /xrpc/app.bsky.video.getJobStatus?jobId=<pollJobId>` (with the token, or with no `Authorization` when `statusAuth = "none"`).

`reads` increases on every 2xx (readable or not). Then, in order (P12, P16):

| Reply | Outcome |
|---|---|
| `state = JOB_STATE_FAILED` | `fatal_error`, §7 job failure text |
| a usable blob | `continue`, phase `ready`, `blob`, `notBefore` now |
| no blob, and `now ≥ finishedAt + 30 min` or `reads = 16` | `fatal_error` "Bluesky did not finish processing the video within 30 minutes; nothing was published" |
| no blob (any other state, unknown state, unreadable body) | `continue`, `lastReadAt = now`, `notBefore = nextReadAt` (data-model §4) |
| 401 / 403 with `statusAuth = "service"` | `continue`, `statusAuth = "none"`, `notBefore = nextReadAt` (P13; not counted) |
| 401 / 403 with `statusAuth = "none"` | `fatal_error` "Bluesky refused to report the video's processing status (<code>); nothing was published." |
| other 4xx | `fatal_error` "Bluesky refused to report the video's processing status (<code>: <message>); nothing was published." |
| 429, 5xx, timeout, dropped connection | `retryable_error` (not counted as a read) |

### 4.6 `create_post` (the only step that may publish)

As today (text, `createdAt`, facets with resolved mentions, `createRecord` on the session's PDS, AtUri check, outcomes), with:

```json
"embed": {
  "$type": "app.bsky.embed.video",
  "video": <blob exactly as saved>,
  "aspectRatio": { "width": <item.width>, "height": <item.height> },
  "alt": "<item.altText>"
}
```

`aspectRatio` only when both are known; `alt` only when not empty after trimming; never `captions` or `presentation` (D9, FR-013). A timeout, dropped connection or unreadable reply after sending is `ambiguous` (unchanged).

## 5. Pace (D7, P12)

`nextReadAt(readAt, finishedAt) = readAt + (readAt < finishedAt + 10 min ? 60 s : 5 min)`. The first read is due at `finishedAt + 30 s`. Driven by the DB clock in tests (`atTime`): a blob returned at the third read is created within the next tick (SC-004); a job never finishing fails at the read made at or after `finishedAt + 30 min`, at most 16 reads (SC-005).

## 6. Restarts and changed posts (D11, D12, P14, P18)

- **Restart:** if `restarts < 2`, return `continue` with `{ v: 1, mentions, video: { phase: "limits", restarts: restarts + 1 } }` and `notBefore` now; the summary records `restarts` and the reason. If `restarts = 2`, return `fatal_error` with the expiry text (an expiry) or the lost-upload text (any other reason).
- **Changed post:** `continue` with `{ v: 1 }`, `notBefore` now; the next tick starts at the first step. Nothing is aborted: an unreferenced upload or blob expires unused.
- **Retry after failure** (the person's Retry): the engine clears the state, so a new upload starts (unchanged).

## 7. Messages (exact)

Limit wait, `wait` text: `<M>. Docket checks again in an hour; nothing was uploaded.`
Limit failure: `<M>. Bluesky still refused video uploads after a day of hourly checks; nothing was published.`
where `<M>` is Bluesky's `message` (sanitised) or `Bluesky's daily video upload limit has been reached for this account`.

Start refusals: `Bluesky refused the video: <explanation> (<code>: <message>). Nothing was published.`

| Code | Explanation |
|---|---|
| `UnsupportedContentType` | it is not an MP4 file Bluesky accepts |
| `VideoTooLarge` | it is over Bluesky's 300 MB limit |
| `VideoTooLong` | it is longer than Bluesky allows; Docket cuts videos to 3 minutes for Bluesky, so Bluesky's limit is lower than expected |
| `BadAspectRatio` | Bluesky does not accept its shape |
| `UploadForbidden` | Bluesky does not allow this account to upload video; accounts hosted by Bluesky must verify their email address first |

Job failures: `Bluesky could not process the video: <explanation> (<failureCode>: <message>). Nothing was published.`

| `failureCode` | Explanation |
|---|---|
| `validation_failure` | Bluesky found the file invalid |
| `encoding_failure` | Bluesky could not process the file's encoding |
| `pds_upload_failure` | Bluesky's video service could not store the video on the account's server; try again later |
| `pds_upload_unsupported_blob_size` | the account's server does not accept a file this large (common on self-hosted servers) |
| `generic_failure` | Bluesky could not process the video |
| other or none | `Bluesky could not process the video (<failureCode or "no code">: <message>). Nothing was published.` |

`(<code>: <message>)` drops `: <message>` when Bluesky sent none. Ceiling: `Bluesky did not finish processing the video within 30 minutes; nothing was published`. Expiry: `Bluesky's upload expired before it finished; nothing was published`. Lost upload: `Bluesky lost the upload before it finished (<code>); nothing was published.` Part timeout: P21.

## 8. G24 — `continue` with a wait message (P11)

```ts
| { kind: "continue"; state: unknown; notBefore?: Date; /** Shown as the target's status until the next result (G24). */ wait?: string }
```

`applyStepResult` for `continue` sets `lastError: result.wait ? redact(result.wait, secrets) : null`; everything else is unchanged (`attemptCount: 0`, `nextAttemptAt`). Tests: `src/server/scheduler/record.test.ts` adds "a continue with a wait message shows it and uses no attempt" and "a continue without one still clears lastError".

## 9. Secrets (FR-007, SC-007, constitution VII)

- The service token is held in one local variable per step. It is never written to state, a summary, `lastError`, a `wait` text, a thrown error or a log. Every message the step builds from Bluesky's reply passes `sanitiseMessage(text, [token, accessJwt])`.
- Summary keys avoid the words the engine's redactor drops (F6); `serviceAuth` records `aud`, `lxm` and `expiresInSeconds`, never the token.
- `tests/integration/bluesky/video-no-secrets.test.ts` (new) drives a video through every step, with a fake video service that echoes the bearer token in its `message` and failure replies, and asserts no session token, service token or app password appears in `post_targets`, `publish_attempts`, activity events, console output or the rendered target view.

## 10. Tests (mocked HTTP only, FR-026)

Unit (no DB):

- `src/providers/bluesky/video-state.test.ts`: schema; old states parse; invariants per phase; `fitState` (video ↔ images, inconsistent upload → unreadable); `partRange` (one part, exact multiple, remainder); `nextReadAt`.
- `src/providers/bluesky/video-steps.test.ts`: `stepForContent` from an empty state and from every phase, with and without mentions and a limit wait; allowance per step (P2); `create_post` is the only `mayPublish`; existing `steps.test.ts` passes untouched.
- `src/providers/bluesky/pds-host.test.ts`: a did:plc document, a missing or wrong-type entry, a non-https endpoint, junk.
- `src/providers/bluesky/video-service.test.ts`: exact method, URL, headers and body per call; `VideoServiceError` keeps the body, status, name and `Retry-After`; a 200 that does not parse.
- `src/providers/bluesky/video-errors.test.ts`: every explanation of §7; sanitising and token scrubbing.
- `src/providers/bluesky/video-publish.test.ts`: each step handler against a fake `fetch`, every row of §4's tables, the 23 h rule, restarts and the third loss, P15's early blob, P16, P13, P21.

Integration (`runTick`, real Postgres, fake PDS + fake video service + byte-range media server, DB clock pinned):

- `tests/integration/bluesky/video.test.ts` (US1): the full path of the spec's Independent Test (12,000,000 bytes, 5,000,000-byte parts → 3 parts), asserting every request (token `aud`/`lxm`/`exp`, `sizeBytes`, `mimeType`, part numbers and lengths, job ids, the embed's blob, aspect ratio 1080 × 1920, alt, no `captions`), the read pace, and the published target; a one-part video; a video with no text and one with a mention; a timeout at each pre-create step retried; a timeout after `createRecord` ambiguous; image and text posts still send exactly today's requests.
- `tests/integration/bluesky/video-failures.test.ts` (US2): each start refusal and failure code, an unknown code, an unknown state and unreadable reply, the 30-minute ceiling with ≤ 16 reads, the switch to the 5-minute pace after 10 minutes, deduplication on finish, an already-processed blob, expiry restarting twice then failing, a part timing out and resent, a killed worker resuming at its step (and ambiguous when killed in `create_post`), a changed post restarting.
- `tests/integration/bluesky/video-limits.test.ts` (US4): `canUpload: false` with and without a message (the target's status shows it, no upload request), allowed an hour later, the 23 h failure, the check refused and skipped, a 5xx on the check retried, `DailyLimitExceeded` on start, 25 reservations in 24 h deferring with "Waiting for Bluesky's daily video upload allowance" and 0 Bluesky requests and no attempt used.
- `tests/integration/bluesky/video-no-secrets.test.ts`: §9.

Helpers: `tests/helpers/bluesky-video.ts` (new) with `blueskyVideoSetup(…)` (account, video asset, stored bytes of a given size, due target), `routeVideoService(pds, script)` and `rangeFetch(storage)` (serves `https://media.example.test/<key>` honouring `Range`, answering 206 with `Content-Range`). `tests/helpers/fake-pds.ts` is unchanged.
