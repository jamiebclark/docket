# Contract: TikTok capabilities, validation and publishing

The host for API calls is `https://open.tiktokapis.com`. Every call sends `Authorization: Bearer <access token>` and `Content-Type: application/json; charset=UTF-8`, except the chunk `PUT`, which goes to TikTok's upload address with no bearer token. Envelope parsing follows research P12.

## 1. Capabilities (`src/providers/tiktok/capabilities.ts`, P18)

```ts
export const TIKTOK_TEXT_RULE: CustomCountingRule = { kind: "custom", name: "utf16", unit: "UTF-16 units", count: (s) => s.length };

export const tiktokCapabilities: ProviderCapabilities = {
  text: { maxLength: 2200, countingRule: TIKTOK_TEXT_RULE },
  media: {
    maxImages: 35, allowedMimeTypes: ["image/jpeg", "image/webp"], outputMimeType: "image/jpeg",
    maxBytesPerFile: 20_000_000, maxWidth: 1080, maxHeight: 1920, required: true,
  },
  video: {
    maxVideos: 1, withImages: false, containers: ["mp4", "mov"], videoCodecs: ["h264", "hevc", "vp8", "vp9"],
    maxBytes: 4_000_000_000, maxDurationSeconds: 300,
    minWidth: 360, maxWidth: 4096, minHeight: 360, maxHeight: 4096, minFrameRate: 23, maxFrameRate: 60,
  },
  textOnlyAllowed: false,
  postTypes: ["image", "carousel", "video"],
};
export const TIKTOK_DEFAULT_PUBLISH_LIMIT = { count: 15, windowSeconds: 86_400 };
```

The image planner (entry 1) converts PNG to JPEG and downscales anything over 1080 × 1920. The video formatter (entry 6) rewraps, re-encodes, cuts to 5:00, resizes and changes the frame rate from these limits alone (FR-008). There is no TikTok planner or formatter code. Docket's 10-item post cap applies before 35.

## 2. `validateTikTok(content, caps)` (P19)

The result is `validateAgainstCapabilities(content, caps)` with TikTok's wording for `video_with_images` ("TikTok posts a video on its own, without images.") and `too_many_videos` ("TikTok takes one video per post."), plus the issues below. `values` and `details` come from `content.posting` (G25). On an unaudited install, `audited` is false (P11).

| Condition | Code | Field | Message |
|---|---|---|---|
| `content.posting` absent or `values` null | `posting_required` | `posting` | Open this post in the composer to choose TikTok's settings and agree before scheduling. |
| `privacy` null | `privacy_required` | `posting.privacy` | Choose who can see this TikTok post. |
| `!audited && privacy !== "SELF_ONLY"` | `privacy_not_private` | `posting.privacy` | This TikTok app is set as not audited, so it can only post privately. |
| `audited && details && !details.privacyOptions.includes(privacy)` | `privacy_not_offered` | `posting.privacy` | TikTok doesn't offer '<label>' for <nickname>. Choose again. |
| `!audited && details && !details.privacyOptions.includes("SELF_ONLY")` | `private_not_offered` | `posting.privacy` | <nickname> can't post through this app: it only posts privately, and TikTok doesn't offer 'Only me' for this account. |
| `brandedContent && privacy === "SELF_ONLY"` | `branded_private` | `posting.privacy` | Branded content can't be private. |
| `disclosure && !yourBrand && !brandedContent` | `disclosure_incomplete` | `posting.disclosure` | Choose 'Your brand', 'Branded content' or both. |
| `allowComments && details?.commentDisabled` | `interaction_disabled` | `posting.allowComments` | <nickname> has turned off comments on TikTok. |
| video and `allowDuets && details?.duetDisabled` | `interaction_disabled` | `posting.allowDuets` | <nickname> has turned off duets on TikTok. |
| video and `allowStitches && details?.stitchDisabled` | `interaction_disabled` | `posting.allowStitches` | <nickname> has turned off stitches on TikTok. |
| photo and `photoTitle.length > 90` | `photo_title_too_long` | `posting.photoTitle` | The photo title is <n> UTF-16 units; TikTok allows 90. |
| video and `details?.maxVideoSeconds` and the planned duration is greater | `creator_duration_exceeded` | `media.0` | This TikTok account can post videos up to <N> seconds. |
| photo and any media URL not `https:` | `photo_url_not_https` | `media` | TikTok fetches photos only over HTTPS. |

`<label>` is the plain privacy word (P21). `<nickname>` falls back to "this TikTok account" when details are null. The composer check additionally reports the details read failure (contracts/composer-ui.md), and the consent issue is added by G27 (P5).

## 3. Creator info

`POST /v2/post/publish/creator_info/query/` with an empty JSON body `{}` (the research lists no body). The reply data fields are those of data-model §4.

| Reply | Read result |
|---|---|
| 2xx, no error code, data fits the schema | `ok`, details |
| any status with code `spam_risk_too_many_posts` or `reached_active_user_cap` | `cap` |
| any status with `spam_risk_user_banned_from_posting` | `banned` |
| 401 or `access_token_invalid` | `expired` |
| `scope_not_authorized` | `refused` ("TikTok did not grant permission to post. Connect again and allow posting.") |
| 429 / `rate_limit_exceeded` | `rate` (`Retry-After` or 60 s) |
| 5xx, network, timeout, unreadable 2xx | `transient` |
| other 4xx or other code | `refused`, explained (§8) |

The reader `readCreatorInfo` is shared by connect (`exchangeCode`), the composer (`accountDetails.read`) and the `check_creator` step.

## 4. Steps and exact requests

### `check_creator` (`mayPublish: false`)

1. Read creator info.
2. Compare with the stored values (P35). Any of the following fails with nothing posted:
   - privacy no longer offered: "TikTok no longer allows '<label>' for <nickname>; nothing was posted. Choose again and reschedule.";
   - unaudited install, privacy not `SELF_ONLY`: "This TikTok app is set as not audited, so it can only post privately; nothing was posted.";
   - unaudited install, the options lack `SELF_ONLY`: "TikTok doesn't offer 'Only me' for <nickname>, and this app can only post privately; nothing was posted.";
   - an allowed interaction now disabled: "<nickname> has turned off <comments|duets|stitches> on TikTok; nothing was posted.";
   - the video (as planned) is longer than `max_video_post_duration_sec`: "<nickname> can now post videos up to <N> seconds on TikTok; nothing was posted.";
   - banned: "TikTok has blocked <nickname> from posting right now; nothing was posted. (TikTok: spam_risk_user_banned_from_posting)".
3. A posting cap waits (P29) with "TikTok's daily posting limit has been reached for <nickname>; Docket will try again.", and fails with the same message once 23 hours have passed since `capWaitSince`.
4. Otherwise `continue` to `start` with `nickname`. `summary.response = { nickname, privacyOptions, maxVideoSeconds }`.

### `start_upload` (video, `mayPublish: false`)

- Before the request: `storedSize(fileUrl) === media.bytes` (P32), and `chunkPlan(bytes)` (P24).
- `POST /v2/post/publish/video/init/` (shown with every toggle off and the disclosure off; each `disable_*` is the opposite of its toggle, each `brand_*` follows its box, P34):

```json
{
  "post_info": {
    "privacy_level": "<SELF_ONLY when unaudited, else the stored privacy>",
    "title": "<effective text>",
    "disable_comment": true, "disable_duet": true, "disable_stitch": true,
    "brand_content_toggle": false, "brand_organic_toggle": false
  },
  "source_info": { "source": "FILE_UPLOAD", "video_size": 20000000, "chunk_size": 5242880, "total_chunk_count": 3 }
}
```

- 2xx with `publish_id` (≤ 64) and an `https:` `upload_url` (≤ 256): `continue` to `chunks`, with `publishId`, `sealedUploadUrl` (P25), `uploadIssuedAt = now`, `chunksSent = 0`, and the file and plan. Summary: privacy, the flags, the sizes and `publish_id`. Never the address.
- Errors: a posting cap waits (P29). `access_token_invalid` is `retryable_error` with `credentialsExpired`. 429 is `retryable_error` with `notBefore`. 5xx, timeout or unreadable is `retryable_error`. Any other 4xx or code is a `fatal_error` (§8). An `upload_url` that is not `https:` fails: "TikTok returned an upload address Docket can't use; nothing was published."

### `upload_chunk_<k>` (video; `mayPublish` only for `k = N`)

- Before sending:
  - unseal the address; on failure, restart (P25);
  - if `now − uploadIssuedAt ≥ 55 min`, restart (P28);
  - read bytes `[first, last]` with `readRange` (P32).
- `PUT <upload address>` with headers `Content-Type: <media.mimeType>`, `Content-Length: <last − first + 1>` and `Content-Range: bytes <first>-<last>/<size>`, and the chunk bytes as the body. No `Authorization`.
- Outcomes (P26):

| Reply | `k < N` | `k = N` (final) |
|---|---|---|
| 206 | `continue`, `chunksSent = k` | `fatal_error` "TikTok did not receive the whole video; nothing was published." |
| 201 | `continue` to `status`, `sentAt = now` (TikTok finished early) | `continue` to `status`, `sentAt = now` |
| 403 | restart | restart |
| other 4xx | repeat (`attempt > 1`): restart. First send: `fatal_error` (§8). | `fatal_error` (§8), nothing published |
| 429 | `retryable_error`, `notBefore` ≥ 60 s | `continue` to `status` |
| 5xx, timeout, reset | `retryable_error` | `continue` to `status` |
| range read failed | `retryable_error` (storage), nothing sent | `retryable_error`, nothing sent |

A restart returns `continue` with `{ phase: "creator", restarts: restarts + 1 }`, clearing the upload fields. When `restarts` is already 2, it fails instead with "TikTok's upload expired before it finished; nothing was published. A smaller file, a faster connection or a longer provider time limit helps."

### `publish_photos` (photo, `mayPublish: true`)

`POST /v2/post/publish/content/init/`:

```json
{
  "media_type": "PHOTO",
  "post_mode": "DIRECT_POST",
  "post_info": {
    "title": "<photo title, omitted when empty>",
    "description": "<effective text>",
    "privacy_level": "<as for video>",
    "disable_comment": true,
    "brand_content_toggle": false, "brand_organic_toggle": false
  },
  "source_info": { "source": "PULL_FROM_URL", "photo_images": ["https://media.example/a.jpg", "…"], "photo_cover_index": 0 }
}
```

| Reply | Result |
|---|---|
| 2xx with `publish_id` | `continue` to `status`, `sentAt = now` |
| a posting cap code | wait (P29); nothing was posted |
| 401 / `access_token_invalid` | `retryable_error` with `credentialsExpired` (refused, so nothing was posted) |
| 429 | `retryable_error`, `notBefore` (refused) |
| other 4xx with a code (`url_ownership_unverified`, `invalid_param`, `unaudited_client_can_only_post_to_private_accounts` …) | `fatal_error` (§8), nothing posted |
| 5xx, timeout, reset, unreadable 2xx | `ambiguous`: "TikTok did not confirm the photo post; it may be live. Check TikTok before retrying." |

### `check_status` (`afterPublish: true`)

- Before `nextReadAt(state)`: `continue` with `notBefore = nextReadAt` and the wait text (no call).
- `POST /v2/post/publish/status/fetch/` with `{ "publish_id": "<id>" }`.

| Status | Result |
|---|---|
| `PUBLISH_COMPLETE` | `done` with `externalId = publish_id` and no `url`. `summary.response.publicPostIds` = `publicaly_available_post_id` when present. |
| `FAILED` | `fatal_error`, `fail_reason` explained (§8). `auth_removed` sets `credentialsInvalid: true`. |
| `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD` | `continue`, `reads + 1`, `lastReadAt`, `notBefore = nextReadAt`, `wait` = "TikTok is processing the post; it may take a few minutes to be visible." |
| `SEND_TO_USER_INBOX`, unknown | `ambiguous`: "TikTok did not report this as posted; check TikTok before retrying." |
| a non-final status at or after `sentAt + 60 min` | `ambiguous`: "TikTok did not confirm the post within 60 minutes; it may be live. Check TikTok before retrying." |
| `access_token_invalid` | `retryable_error` with `credentialsExpired` |
| 429, 5xx, network, unreadable | `retryable_error` (G23: never failed by the engine) |
| `invalid_publish_id`, `token_not_authorized_for_specified_publish_id` | `ambiguous`: "TikTok would not report on this post; check TikTok before retrying." |

An unreadable state routed here (P23) is `ambiguous`: "Docket lost track of this TikTok post's progress; check TikTok before retrying."

## 5. Ambiguity summary (SC-003)

- Never more than one publishing request per target. The final chunk is sent once; after it, only status reads happen. A photo `init` is sent once; uncertainty after it is ambiguous at once.
- The engine's own safety nets stay as they are. A lost lease or timeout on a `mayPublish` step is ambiguous, and G23 applies to `check_status`. See P31 for the final-chunk race.
- Nothing that happens before the publishing request is ambiguous.

## 6. Unaudited behaviour (US6)

- `privacy_level` is always `SELF_ONLY`.
- Steps and checks are as above.
- The account card note, the summary note and the "Private on TikTok" target note come from data-model §2–§3.
- TikTok's own `unaudited_client_can_only_post_to_private_accounts` is explained per §8 on either install type.

## 7. Secrets (FR-005, constitution VII)

- The access and refresh tokens exist only in `Authorization` headers and token form bodies. The upload address exists only as the `PUT` URL and sealed in the state.
- `scrubTikTok(text, secrets)` replaces every secret (and the address's query string) in any message built from a reply before it is returned.
- `tests/integration/tiktok/no-secrets.test.ts` drives every step with a fake TikTok that echoes the token and the upload address in error bodies. It asserts that neither appears in `step_state` (except sealed), `last_error`, `publish_attempts`, activity, summaries or logs.

## 8. Refusals explained (`src/providers/tiktok/errors.ts`, spec D13, P36)

The format is "<sentence> (TikTok: <code>[: <scrubbed message ≤ 200>])".

| Code | Sentence |
|---|---|
| `unaudited_client_can_only_post_to_private_accounts` | TikTok only lets an unaudited app post to a private account. Set the TikTok account to private, or, if your app has passed its audit, check `TIKTOK_APP_AUDITED`. |
| `url_ownership_unverified` | TikTok could not confirm you own the address your photos are served from. Verify your media domain in your TikTok app; see the setup doc (<docsUrl("tiktok-setup","photo-posts-and-domain-verification")>). |
| `spam_risk_too_many_posts` | TikTok's daily posting limit has been reached for this account. |
| `reached_active_user_cap` | TikTok's daily limit on accounts posting through this app has been reached. |
| `spam_risk_user_banned_from_posting` | TikTok has blocked this account from posting right now. |
| `invalid_param` | TikTok refused the post's settings. |
| `file_format_check_failed` | TikTok could not read the video's format. |
| `duration_check_failed` | TikTok refused the video's length. |
| `frame_rate_check_failed` | TikTok refused the video's frame rate. |
| `picture_size_check_failed` | TikTok refused a photo's size. |
| `video_pull_failed` | TikTok could not fetch the video. |
| `photo_pull_failed` | TikTok could not fetch the photos from your media storage. |
| `publish_cancelled` | The post was cancelled on TikTok. |
| `auth_removed` | Docket's access was removed in TikTok. Reconnect the account. |
| `internal` | TikTok had an internal error and did not post. |
| anything else | TikTok refused the post. |

Codes are matched exactly. An HTTP 200 body carrying a code is that error (P12).

## 9. Tests (mocked HTTP only)

Unit tests (`src/providers/tiktok/*.test.ts`):

- `capabilities` (the declaration, `utf16` counting);
- `validate` (every row of §2 and every declared edge);
- `posting` (`view` per audited and unaudited install, per post type, per details, and the "Branded content" rule; `targetNote`; `summaryNotes`; `declaration`);
- `state` (`chunkPlan` with every row of data-model §7 and SC-006, the parse invariants, `fitState`, `nextReadAt`);
- `steps` (every row of data-model §6, from empty and from every saved state, including unfit and unreadable ones);
- `sealed` (round trip, a wrong AAD, a rotated secret);
- `errors` (each code, scrubbing);
- `http` (the envelope reader on HTTP 200 error bodies);
- `publish` (each step's request and outcome table).

Integration tests through `runTick` with a fake TikTok (`tests/helpers/fake-tiktok.ts`) and a byte-range media server (`tests/helpers/bluesky-video.ts`'s `rangeFetch`, or a TikTok copy):

- `video.test.ts` (US3): 20,000,000 bytes, three chunks, each request and `Content-Range`, the read pace against the DB clock, `mayPublish` only on the last chunk, `done` with `publish_id`; a video under 5 MB as one chunk; a public post id going to the summary only;
- `photo.test.ts` (US4): `PULL_FROM_URL` body, `PROCESSING_DOWNLOAD`, done; `url_ownership_unverified`; a timeout after `init` is ambiguous; `photo_pull_failed`; PNG → JPEG and > 1080 px downscaled (planner);
- `failures.test.ts` (US5): every D10 mismatch with no upload request; the cap wait and the 23-hour failure; every §8 code; a non-final chunk timeout repeated; a refused repeat restarting; a 403 restarting twice and then failing; the 55-minute renewal; a hanging final chunk going to status checks (P31); `FAILED`; `SEND_TO_USER_INBOX`; the 60-minute ceiling; `access_token_invalid` refresh then retry; a refused refresh leading to `needs_reauth`;
- `unaudited.test.ts` (US6): `privacy_level = SELF_ONLY` whatever the options, the audited → unaudited flip failing at publish;
- `no-secrets.test.ts` (§7);
- `tests/integration/limits/enforcement.test.ts` generated rows (F21).
