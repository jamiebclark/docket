# Contract: Facebook video publishing

Covers FR-003 to FR-015 and FR-029 to FR-030. Facts come from `docs/research/meta-video.md` (Facebook Pages). Decisions are in [../research.md](../research.md) (P5–P18), and state and step derivation in [../data-model.md](../data-model.md) §3.

`<graph>` is `https://graph.facebook.com/<version>` (`MetaApp.graphBase` + `graphVersion()`). `<page>` is the account's `externalId`, `<token>` the decrypted Page token, `<url>` the stored video's public address (`ctx.content.media[0].url`), and `<text>` the target's effective text.

## Page video: `publish_video` (`mayPublish: true`)

**Request:** `POST <graph>/<page>/videos`, form body:

| Param | Value |
|---|---|
| `file_url` | `<url>` |
| `description` | `<text>`, only when not empty |
| `access_token` | `<token>` (existing `graphRequest` behaviour) |

Never sent: `published`, `title`, `thumb`, `scheduled_publish_time`, `source`, `upload_phase`, `link`.

| Reply | Result |
|---|---|
| 2xx with a string `id` | `done`, `externalId = id`, no `url` |
| 2xx without an `id`, or unreadable | `ambiguous` "Facebook accepted the request but its reply could not be read." |
| network `after_send`, 5xx, temporary codes | `ambiguous` (through `graphStepError`, `mayPublish: true`) |
| network `before_send`, rate-limit codes | `retryable_error` |
| code 190 | `fatal_error` with `credentialsInvalid` (the engine flags the account) |
| code 389 | `fatal_error`: Facebook's message + " Facebook could not fetch the video. Media storage must be publicly readable (see <docsUrl("storage")>)." |
| any other refusal | `fatal_error` with Facebook's message (scrubbed) |

No status read follows (D11).

## Reel steps

| # | Step | Flags | Request |
|---|---|---|---|
| 1 | `start_reel` | `mayPublish: false`, `allowance: { units: 1, retryUnits: 1 }` | `POST <graph>/<page>/video_reels`, `upload_phase=start` |
| 2 | `upload_reel` | `mayPublish: false` | `POST <checked uploadUrl>`, headers `Authorization: OAuth <token>`, `file_url: <url>`, **no body** |
| 3 | `check_upload` | `mayPublish: false` | `GET <graph>/<videoId>?fields=status` |
| 4 | `finish_reel` | `mayPublish: true` | `POST <graph>/<page>/video_reels`, `upload_phase=finish`, `video_id=<videoId>`, `video_state=PUBLISHED`, `description=<text>` when not empty |
| 5 | `check_publish` | `mayPublish: false`, `afterPublish: true` | `GET <graph>/<videoId>?fields=status` |

Never sent on any Reel request: `title`, `place`, `scheduled_publish_time`, `thumb`, `video_state=DRAFT|SCHEDULED`, `offset`, `file_size`, or file bytes.

### 1. `start_reel`

| Reply | Result |
|---|---|
| 2xx with string `video_id` and `upload_url` | `continue`, a new Reel state (data-model §3), no `notBefore` |
| 2xx missing either one, or unreadable | `retryable_error` "Facebook did not return a Reel upload address; trying again." |
| errors | `graphStepError` (`mayPublish: false`): rate-limit codes retryable; code 190 fatal + `credentialsInvalid`; other refusals fatal with Facebook's message |

The engine reserves one unit of "Facebook's daily Reels allowance" in the claim before this step is leased (G22, unchanged engine code). With no room, the target waits and no request is made.

### 2. `upload_reel`

1. `checkUploadUrl(state.uploadUrl, state.videoId, app.uploadHost)`. When it gives `null`, the result is `fatal_error` "Facebook returned an unexpected upload address; nothing was sent or published.", with **no fetch at all** (D13, SC-007).
2. `ruploadRequest({ url, token, headers: { file_url: <url> }, signal })`.

| Reply | Result |
|---|---|
| any 2xx (body ignored; it is UNVERIFIED) | `continue`, `uploadedAt = now`, `notBefore = now + 60 s` |
| network (either phase), 5xx, 429 | `retryable_error` "Facebook: the video upload did not go through; trying again." |
| Graph-style code 190 | `fatal_error` + `credentialsInvalid` |
| other 4xx or refusal | `fatal_error` "Facebook could not receive the video<: message>. Nothing was published. Media storage must be publicly readable (see <storage doc>)." |

### 3. `check_upload`

The status is read with `readReelStatus` and classified with `uploadState` (research P9).

| Classification or failure | Result |
|---|---|
| `complete` | `continue`, `uploadComplete: true`, `uploadChecks + 1`, no `notBefore` |
| `failed` | `fatal_error` "Facebook could not receive the video<: detail>. Nothing was published. Media storage must be publicly readable (see <storage doc>)." |
| `pending`, an unreadable body, network, 5xx, 429, rate-limit code | if `now − uploadedAt ≥ 30 min`: `fatal_error` "Facebook did not receive the video within 30 minutes; nothing was published." Else `continue`, `uploadChecks + 1`, `notBefore = now + checkDelayMs(now − uploadedAt)` |
| code 190 | `fatal_error` + `credentialsInvalid` |
| other Graph refusal | `fatal_error` "Facebook: <message> (code n)". Nothing was published |

### 4. `finish_reel`

| Reply | Result |
|---|---|
| 2xx with `success === true` | `continue`, `finishedAt = now`, `publishChecks: 0`, `notBefore = now + 60 s` |
| 2xx otherwise, or unreadable | `ambiguous` "Facebook accepted the Reel but its reply could not be read; check the Page before retrying." |
| network `after_send`, 5xx, temporary codes | `ambiguous` (`graphStepError`, `mayPublish: true`) |
| network `before_send`, rate-limit codes | `retryable_error` |
| code 190 | `fatal_error` + `credentialsInvalid` |
| 100, 1363040, 1363127, 1363128, 1363129, other refusals | `fatal_error` with Facebook's message (scrubbed). Nothing was published |

### 5. `check_publish`

The status is read with `readReelStatus` and classified with `publishState`. **No path here returns `retryable_error`, and the only `fatal_error` is the `failed` classification** (D9, FR-010).

| Classification or failure | Result |
|---|---|
| `published` | `done`, `externalId = videoId` |
| `failed` | `fatal_error` "Facebook could not process the Reel and it was not published<: detail>. Check its shape (9:16), length (3–90 s), frame rate (24–60 fps), resolution (at least 540 × 960) and codec." |
| code 190 | `ambiguous` + `credentialsInvalid` "Facebook rejected the Page token after the Reel was sent; check the Page before retrying." |
| `pending`, an unreadable body, network, any HTTP status, any other Graph error | if `now − finishedAt ≥ 60 min`: `ambiguous` "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying." Else `continue`, `publishChecks + 1`, `notBefore = now + checkDelayMs(now − finishedAt)` |

### Invalid or out-of-date state

- **`invalid` with `afterPublish`** (unreadable state on a video post): `ambiguous` "Docket could not read this Reel's saved progress; check the Page before retrying." No request is made.
- **`invalid` on an image post:** unchanged (`fatal_error` "The post changed while publishing.").
- **Mismatch.** A `ctx.step.name` different from `facebookStepFor(ctx.state, content-from-ctx)` gives the existing `fatal_error` "The post changed while publishing.", except when the derived step is `check_publish`. The engine always leases what `stepFor` returns, so a mismatch cannot happen after finish.

## Pace (D8, research P10)

`checkDelayMs(age) = age < 5 min ? 1 min : 5 min`. The first check is due 1 min after the upload or finish request. Measured on `ctx.now`:

| Check | Due at (min after request) | Most checks | Ceiling result |
|---|---|---|---|
| upload | 1, 2, 3, 4, 5, 10, 15, 20, 25, 30 | 10 | failed at ≥ 30 min |
| publish | 1, 2, 3, 4, 5, 10, 15, …, 60 | 16 | ambiguous at ≥ 60 min |

## Attempt summaries (FR-012, P18)

- **Request side:** `{ step, kind: "reel" | "video", videoId? }`. `upload_reel` adds `uploadHost`.
- **Response side:** `graphSummary(outcome)`, plus for status reads `{ videoStatus, uploadingStatus, processingStatus, publishingStatus, publishStatus, checks }` (null values omitted) and `statusDetail` (sanitised, `scrub`bed, at most 300 characters).
- **Never recorded:** the token, the full upload address or the `Authorization` header.

## Tests (FR-029, FR-030)

The table maps tests to files. Every test uses mocked Graph and rupload (`fake-graph`) and the pinned DB clock (`atTime`); none makes a live call.

| Area | File |
|---|---|
| `facebookStepFor` over every row of data-model §3, plus the old photo cases unchanged | `src/providers/facebook/steps.test.ts` (extended) |
| state schema: old photo state parses, invariants, union | `src/providers/facebook/state.test.ts` (new) |
| `checkUploadUrl`, `readReelStatus`, `uploadState`, `publishState`, param builders | `src/providers/facebook/requests.test.ts` (new) |
| every row of every table above, unit-level, with exact params, headers, `bodyBytes === 0` for the upload, and absent fields | `src/providers/facebook/publish.test.ts` (extended) |
| `ruploadRequest`: headers, no body, token only in `Authorization`, outcome mapping | `src/providers/meta/graph.test.ts` (extended) |
| Page video end to end through `runTick`, including the default type and its outcomes | `tests/integration/facebook/page-video.test.ts` (new) |
| Reel end to end: start → upload → 2× uploading → complete → finish → 3× processing → published, with pace on the DB clock (SC-004) | `tests/integration/facebook/reels.test.ts` (new) |
| failed upload; stuck upload (10 checks, then failed at 30 min); publish error, expired, ceiling (16 checks, then ambiguous at 60 min); dropped or unreadable reads after finish never fail; token rejected at each step; restart from saved state at every step; changed choice before finish restarts; bad upload host makes no request (SC-003, SC-005) | `tests/integration/facebook/reel-failures.test.ts` (new) |
| 30-Reel allowance: the 31st waits with the message; concurrent targets do not pass 30; photos, text and Page video are never held (SC-006) | `tests/integration/facebook/reels-allowance.test.ts` (new) |
| token absent from attempts, `lastError` and summaries across a full Reel and Page video flow whose replies echo it (SC-007) | `tests/integration/meta/no-secrets.test.ts` (extended) |
| existing Facebook suites pass unchanged (SC-008) | `src/providers/facebook/publish.test.ts` (existing cases), `tests/integration/facebook/{multi-photo,outcomes,publish-e2e}.test.ts` |
