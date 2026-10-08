# Data model: Bluesky video

No table, column or migration changes. Everything below is TypeScript and JSON inside existing rows: capabilities are code, the upload state is JSON in `post_targets.step_state`, attempt summaries are JSON in `publish_attempts`, and allowance reservations are rows in the existing `allowance_uses` ledger. Decisions D* are the spec's; P* are in [research.md](./research.md).

## 1. Capabilities (`src/providers/bluesky/capabilities.ts`, new)

| Member | Value | Source |
|---|---|---|
| `text` | `{ maxLength: 300, countingRule: "graphemes" }` (unchanged) | bluesky.md |
| `media` | unchanged: 4 images, JPEG/PNG, output JPEG, 2,000,000 bytes, not required | bluesky.md |
| `video.maxVideos` | `1` | D1 |
| `video.withImages` | `false` | D1; embed union |
| `video.containers` | `["mp4"]` | D2; embed lexicon `video/mp4` |
| `video.videoCodecs` | `["h264"]` | D2; research "send H.264/AAC MP4" |
| `video.audioCodecs` | `["aac"]` | D2; same |
| `video.silentAllowed` | `true` | D2 ("AAC audio, or no audio") |
| `video.maxBytes` | `300_000_000` | D2; embed lexicon |
| `video.maxDurationSeconds` | `180` | D2; research's conservative product limit |
| `video.byPostType.video.notes` | `["Bluesky allows about 25 videos (or 10 GB) a day per account; Docket checks the live allowance before each upload.", "Accounts hosted by Bluesky need a verified email address to post video."]` | D13 |
| `textOnlyAllowed` | `true` (unchanged) | |
| `postTypes` | `["text", "image", "carousel", "video"]` | D1 |
| `postTypeChoices` | absent | D1 |

On the provider (not capabilities):

| Member | Value | Source |
|---|---|---|
| `creationAllowance` | `{ count: 25, windowSeconds: 86_400, name: "Bluesky's daily video upload allowance" }` | D6 |
| `defaultPublishLimit` | unchanged (1,666 / h, 11,666 / day) | bluesky.md |

Not declared (they refuse nothing, D2): minimum duration, width, height, aspect ratio, frame rate, bitrate, audio bitrate, sample rate, channels, recommended shape, index position.

What entry 6's planner then does (FR-003, no Bluesky code): a MOV with H.264/AAC is rewrapped; any other video or audio codec is re-encoded to H.264/AAC MP4; a selection longer than 180 s is cut to its first 180 s and re-encoded; a file over 300,000,000 bytes is fitted by bitrate; two videos or a video with images is refused (`too_many_videos`, `video_with_images`, F12).

## 2. Step state (`src/providers/bluesky/video-state.ts`, new; joined into `blueskyStateSchema`)

`blueskyStateSchema` stays `v: 1` and gains one optional member, so every state saved before this entry parses and drives the same steps:

```text
BlueskyState = {
  v: 1,
  mentions?: Record<handle, did | null>,     // unchanged
  blobs: ImageBlob[] = [],                   // unchanged
  video?: VideoUpload,                       // new
}
```

`VideoUpload` (every member non-secret; no token, ever):

| Field | Type | Set by | Meaning |
|---|---|---|---|
| `phase` | `"limits" \| "start" \| "parts" \| "finish" \| "job" \| "ready"` | every video step | which step runs next |
| `restarts` | int 0–2, default 0 | restart (P14) | uploads lost so far |
| `limitWaitSince` | ISO datetime? | first refusal (P9) | start of the current limit wait; cleared when an upload starts |
| `limitsCheck` | `"ok" \| "skipped"`? | `check_upload_limits` | outcome of the last check |
| `pdsHost` | hostname? (`^[a-z0-9.-]{1,253}$`) | `check_upload_limits` (P4) | audience host for upload tokens |
| `pdsHostSource` | `"session" \| "configured"`? | same | where the host came from |
| `url` | string? (the media URL) | `start_upload` | file being uploaded (D12) |
| `sizeBytes` | int 1–300,000,000? | `start_upload` | exact size declared (D10) |
| `jobId` | string 1–200? | `start_upload` | the upload's job |
| `partSizeBytes` | int ≥ 1? | `start_upload` | service's part size |
| `partCount` | int 1–10,000? | `start_upload` | service's part count |
| `partsSent` | int 0–`partCount`? | `upload_part_<k>` | parts acknowledged |
| `expiresAt` | ISO datetime? | `start_upload` | the upload's time limit |
| `pollJobId` | string 1–200? | `finish_upload` | job to poll (`completedJobId`) |
| `finishedAt` | ISO datetime? | `finish_upload` | when the upload finished |
| `reads` | int 0–16? | `check_job` | status reads so far |
| `lastReadAt` | ISO datetime? | `check_job` | time of the last read |
| `statusAuth` | `"service" \| "none"`, default `"service"` | `check_job` (P13) | whether reads send a token |
| `blob` | `{ $type: "blob", ref: { $link }, mimeType: "video/mp4", size: int ≥ 1 }`? | finish, a read, or an early blob (P15) | the processed video |

**Invariants per phase** (a parseable state that breaks them is unreadable → `invalid_state`, P18):

- `limits`: nothing else required.
- `start`: `pdsHost` set.
- `parts`: `pdsHost`, `url`, `sizeBytes`, `jobId`, `partSizeBytes`, `partCount`, `expiresAt` set; `0 ≤ partsSent < partCount`; P7's size relation holds.
- `finish`: as `parts`, with `partsSent = partCount`.
- `job`: `pollJobId` and `finishedAt` set; `reads ≤ 16`.
- `ready`: `blob` set.

**State transitions:**

```text
(none) ─▶ limits ──canUpload / skipped──▶ start ──ok──▶ parts ──last part──▶ finish ──ok──▶ job ──blob──▶ ready ──create──▶ done
           ▲  │                              │  │                    │            │  │           │
           │  └─canUpload false (wait 1 h)───┘  └─DailyLimitExceeded─┘            │  └blob──────┐ └─FAILED / ceiling / 16 reads─▶ failed
           │     ≥ 23 h since first refusal ─▶ failed     (wait 1 h, back to limits) │             ▼
           └──── restart (expiry, lost upload, size changed; ≤ 2) ◀────────────────┘           ready
any phase ── post's media changed (P18) ─▶ { v: 1 } (first step again)
```

Every arrow except `ready ─create─▶` is a non-publishing step: a timeout, dropped connection, 429 or 5xx on it is `retryable_error` (never ambiguous), and a refusal is `fatal_error` with nothing published (D11).

## 3. Step derivation (`stepForContent`, pure and total)

Input: `state`, `content.text`, `content.mediaCount`, `content.kinds`.

1. State unparseable → `invalid_state` (unchanged).
2. `isVideo = kinds` is exactly `["video"]`. `fitState` (P18) replaces a state that does not fit the content with `{ v: 1 }`.
3. Mentions in the text and `mentions` absent → `resolve_mentions` (unchanged, also for video).
4. Not a video → today's image path (`upload_image_<n>` while `blobs.length < mediaCount`, then `create_post`), byte for byte.
5. A video, by `video?.phase ?? "limits"`:

| Phase | Step | `mayPublish` | `allowance` |
|---|---|---|---|
| `limits`, no `limitWaitSince` | `check_upload_limits` | false | `{ units: 1, retryUnits: 0 }` (P2) |
| `limits`, `limitWaitSince` set | `check_upload_limits` | false | none |
| `start` | `start_upload` | false | `{ units: 0, retryUnits: 1 }` (P2) |
| `parts` | `upload_part_<partsSent + 1>` | false | none |
| `finish` | `finish_upload` | false | none |
| `job` | `check_job` | false | none |
| `ready` | `create_post` | **true** | none |

`advance` derives the same step from `ctx.content` (kinds from `media[].kind`), and fails "Publishing state is unreadable. Use Retry to start again." on `invalid_state`, or retries "The post changed while publishing; will retry." when the leased step is not the derived one, as today (F3).

## 4. Pace and ceilings (`video-state.ts` constants)

| Constant | Value | Rule |
|---|---|---|
| `SERVICE_TOKEN_TTL_SECONDS` | 300 | `exp` of every service token (D4, P3) |
| `LIMIT_RETRY_MS` | 3,600,000 | next limits check after a refusal (D5) |
| `LIMIT_GIVE_UP_MS` | 82,800,000 (23 h) | a refusal this long after the first fails (P9) |
| `EXPIRY_MARGIN_MS` | 60,000 | restart when `now ≥ expiresAt − margin` (P14) |
| `MAX_RESTARTS` | 2 | then fail (D11) |
| `FIRST_READ_DELAY_MS` | 30,000 | first status read after `finishedAt` (D7) |
| `FAST_READ_INTERVAL_MS` | 60,000 | until `finishedAt + FAST_PHASE_MS` |
| `FAST_PHASE_MS` | 600,000 | 10 minutes |
| `SLOW_READ_INTERVAL_MS` | 300,000 | after that |
| `PROCESSING_CEILING_MS` | 1,800,000 | no blob at a read at or after this → fail (D7, P12) |
| `MAX_JOB_READS` | 16 | the 16th read without a blob fails |

All times come from `ctx.now` (the DB clock). No step sleeps; every wait is `continue` with `notBefore`.

## 5. Attempt summaries (keys only; no key contains token, session, secret, password, authorization, cookie or credential, F6)

| Step | `request` | `response` |
|---|---|---|
| `check_upload_limits` | `step`, `pdsHost`, `pdsHostSource`, `serviceAuth: { aud, lxm, expiresInSeconds }` | `status`, `limitsCheck` (`ok` \| `refused` \| `skipped`), `canUpload`, `remainingDailyVideos`, `remainingDailyBytes`, `error`, `waitingSince` |
| `start_upload` | `step`, `sizeBytes`, `mimeType`, `name`, `durationMs`, `width`, `height`, `serviceAuth` | `status`, `jobId`, `partSizeBytes`, `partCount`, `expiresAt`, `error`, `restarts` |
| `upload_part_<k>` | `step`, `jobId`, `partNumber`, `partCount`, `bytes` | `status`, `sizeBytes`, `error`, `restarts` |
| `finish_upload` | `step`, `jobId` | `status`, `completedJobId`, `deduplicated`, `state`, `progress`, `blob` (boolean), `error` |
| `check_job` | `step`, `jobId`, `read`, `statusAuth` | `status`, `state`, `progress`, `failureCode`, `blob` (boolean), `error` |
| `create_post` | today's keys, plus `video: 1`, `aspectRatio` (`"<w>x<h>"` or null), `alt` (boolean) | unchanged |

`error` is Bluesky's error name (e.g. `DailyLimitExceeded`); Bluesky's `message` appears only in the target's `lastError`, sanitised (P17).

## 6. Messages the person sees

The exact strings are in [contracts/bluesky-video-publishing.md](./contracts/bluesky-video-publishing.md) §7. They cover the limit wait (via G24's `wait`, P11), each start refusal and job failure code, the processing ceiling, expiry and lost uploads, the status-read refusal (P13) and part timeouts (P21).

## 7. `docs/limits.md` Bluesky rows (FR-020)

Changed: `videos` from `0` to `1`. Added:

| Category | Value | Source | Enforced in | Test |
|---|---|---|---|---|
| video with images | no | bluesky-video.md (embed is one union member) | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video containers | mp4 | bluesky-video.md (blob `video/mp4`) | video planner | generated `bluesky: video containers` |
| video codecs | h264 | bluesky-video.md ("send H.264/AAC MP4"; codecs not published) | video planner | generated `bluesky: video codecs` |
| audio codecs | aac | same | video planner | generated `bluesky: audio codecs` |
| silent video | yes | D2 | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| video bytes | 300000000 | bluesky-video.md (embed lexicon) | video planner | generated `bluesky: video bytes` |
| max duration | 180 | bluesky-video.md (conservative product limit; UNVERIFIED) | video planner | generated `bluesky: max duration` |
| creation allowance | 25 / 86400 s | bluesky-video.md (about 25 videos a day, help page) | engine deferral | generated `bluesky: creation allowance` |
| note: daily bytes | 10 GB a day, not modelled | D6: 25 × 300 MB = 7.5 GB | — | `src/providers/bluesky/capabilities.test.ts` "declares no byte allowance" |
| note: upload limits check | `getUploadLimits` before each upload; refusals wait an hour, fail after 23 h | D5, P9 | Bluesky step machine | `tests/integration/bluesky/video-limits.test.ts` |
| note: processing ceiling | 30 min, at most 16 reads | D7, P12 | Bluesky step machine | `tests/integration/bluesky/video-failures.test.ts` |
| note: verified email | Bluesky-hosted accounts need one | bluesky-video.md | Bluesky (`UploadForbidden`) | `src/providers/bluesky/video-errors.test.ts` |
| note: client duration ceiling | 10 min, UNVERIFIED as a server limit | D2 | — | `src/providers/bluesky/capabilities.test.ts` "declares 3 minutes" |

The exact quoted test titles are fixed by the tasks phase; the inventory test checks they exist.
