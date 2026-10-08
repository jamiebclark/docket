# Data model: Facebook Page video

There is **no database migration** in this entry (P20). Everything below is a TypeScript contract, a provider declaration or a JSON shape stored in the existing `post_targets.step_state` column. The existing generic storage is reused:

- `post_targets.chosen_post_type` (G19, migration 0012) holds the Facebook choice;
- `allowance_uses` (G22, migration 0012) holds the Reel start reservations.

## 1. Contract changes in `src/providers/types.ts` (G23)

```ts
export interface StepInfo {
  name: string;
  mayPublish: boolean;
  allowance?: { units: number; retryUnits: number };
  /**
   * A step that may publish has already been sent for this target. Requires `mayPublish: false`.
   * The engine never fails such a lease on its own: an outcome it would record as failed is ambiguous.
   * A provider's own `fatal_error` still fails.
   */
  afterPublish?: true;
}

export type StepResult = (
  | { kind: "continue"; state: unknown; notBefore?: Date }
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date; credentialsExpired?: boolean }
  | { kind: "fatal_error"; error: string; credentialsInvalid?: true }
  /** `credentialsInvalid`: the platform rejected the credentials; the account is flagged, and the target stays ambiguous. */
  | { kind: "ambiguous"; error: string; credentialsInvalid?: true }
) & { summary?: AttemptSummary };
```

There are no other contract changes. `PostTypeChoice`, `VideoLimitOverrides.notes`, `minFrameRate` and `CreationAllowance` already exist (019).

### Engine behaviour for `afterPublish` (contract: [contracts/after-publish-steps.md](./contracts/after-publish-steps.md))

| Where | Today | With `afterPublish` on the lease |
|---|---|---|
| `execute` catch: `MediaUnavailable`, `CredentialsUnreadable`, `SettingsInvalid` | fatal → failed | ambiguous, with the message plus " The post may already be live; check before retrying." |
| `execute` catch: `PostGone` | fatal | unchanged (the post is deleted, and its targets with it) |
| `execute` catch: a lost provider call | retryable | unchanged (retryable, checked again) |
| `applyStepResult`: `retryable_error` at `maxAttempts` | failed | ambiguous, with the same suffix |
| `recoverExpiredLease` at `maxAttempts` | failed ("Publishing was interrupted too many times.") | ambiguous ("Publishing was interrupted too many times after the post was sent; check before retrying.") |
| `ambiguous` with `credentialsInvalid` | (not possible) | the account is flagged as for fatal, and `lastError` gets " Reconnect <account> to publish again." |

## 2. Facebook capabilities (`src/providers/facebook/capabilities.ts`)

```ts
// docs/research/meta-video.md "Regular Page video": no size, length or format limits published (D4).
export const FACEBOOK_PAGE_VIDEO = { maxVideos: 1, withImages: false, containers: ["mp4", "mov"] } as const satisfies VideoCapabilities;

// docs/research/meta-video.md "Reels Publishing API" specs table; aspect 9:16 ±1% (D3).
export const FACEBOOK_REEL_VIDEO = {
  videoCodecs: ["h264", "hevc", "vp9", "av1"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  minDurationSeconds: 3,
  maxDurationSeconds: 90,
  minWidth: 540,
  minHeight: 960,
  minAspectRatio: 0.556,
  maxAspectRatio: 0.569,
  minFrameRate: 24,
  maxFrameRate: 60,
} as const satisfies VideoLimitOverrides;

export const FACEBOOK_REELS_PER_DAY = 30; // "30 API-published posts within a 24-hour moving period"
```

`facebookCapabilities` changes. Text and media are unchanged.

```ts
video: {
  ...FACEBOOK_PAGE_VIDEO,
  byPostType: {
    video: { notes: ["Facebook publishes no length or size limits for Page videos; Docket's upload limits apply."] },
    reel: {
      ...FACEBOOK_REEL_VIDEO,
      notes: [
        "9:16 (vertical) only.",
        "Facebook publishes no size limit for Reels; Docket's upload limit applies.",
        "Facebook allows 30 Reels per Page a day.",
      ],
    },
  },
},
postTypes: ["text", "image", "carousel", "video", "reel"],
postTypeChoices: [{
  shape: "single_video",
  default: "video",
  options: [
    { type: "video", label: "Page video", description: "A video post on your Page. Any shape or length Facebook accepts." },
    { type: "reel", label: "Reel", description: "A vertical 9:16 video of 3 to 90 seconds, shown in Reels." },
  ],
}],
```

`facebookProvider` (`index.ts`) gains `creationAllowance: { count: 30, windowSeconds: 86_400, name: "Facebook's daily Reels allowance" }`.

**Validation rules** derived from these (with `resolvePostType` and `videoLimitsFor`):

| Post | Resolved type | Limits applied | Refusal codes possible |
|---|---|---|---|
| one video, no choice | `video` | base | `video_container_not_allowed`, `media_processing`, `media_failed` |
| one video, `reel` | `reel` | base + Reel | every `video_*` code above plus `video_codec_not_allowed`, `audio_codec_not_allowed`, `video_too_short`, `video_too_long`, `video_too_small`, `video_aspect_out_of_range`, `video_frame_rate_too_low`, `video_frame_rate_too_high` |
| video + images, or 2 videos | `carousel` | base | `video_with_images` or `too_many_videos`, worded "A Facebook post can carry one video and no images." |
| images only, text only | unchanged | unchanged | unchanged |

## 3. Facebook step state (`src/providers/facebook/settings.ts`, stored in `post_targets.step_state`)

```ts
/** Unchanged: ids of unpublished photos, in image order. */
const photoState = z.object({ v: z.literal(1), photoIds: z.array(z.string().min(1).max(100)).max(10) }).strict();

/** A Reel in progress. Times are ISO strings from the engine clock. */
const reelState = z.object({
  v: z.literal(1),
  kind: z.literal("reel"),
  videoId: z.string().regex(/^\d{1,40}$/),
  uploadUrl: z.string().max(500),
  startedAt: z.string(),
  uploadedAt: z.string().nullable(),
  uploadComplete: z.boolean(),
  uploadChecks: z.number().int().min(0),
  finishedAt: z.string().nullable(),
  publishChecks: z.number().int().min(0),
}).strict();

export const facebookStateSchema = z.union([photoState, reelState]);
```

**Invariants**, checked in `validReelState`. A state that breaks one is unreadable (P14):

- `uploadComplete` ⇒ `uploadedAt !== null`;
- `finishedAt !== null` ⇒ `uploadComplete`;
- `publishChecks > 0` ⇒ `finishedAt !== null`.

The Page video target saves **no state**: its single step is the publishing request.

### State transitions (Reel)

| Step leased | Request | Result → next state |
|---|---|---|
| `start_reel` (state null) | `POST /{page}/video_reels` `upload_phase=start` | ok with `video_id` and `upload_url` → `{ kind: "reel", videoId, uploadUrl, startedAt: now, uploadedAt: null, uploadComplete: false, uploadChecks: 0, finishedAt: null, publishChecks: 0 }`, no wait |
| `upload_reel` (`uploadedAt` null) | address check, then `POST <uploadUrl>` with headers | any 2xx → `uploadedAt: now`, `notBefore: now + 60 s` |
| `check_upload` (`uploadedAt` set, not complete) | `GET /{videoId}?fields=status` | complete → `uploadComplete: true` (no wait). Not yet → `uploadChecks + 1`, wait at the pace. Failed → fatal. Ceiling (30 min since `uploadedAt`) → fatal |
| `finish_reel` (complete, `finishedAt` null) | `POST /{page}/video_reels` `upload_phase=finish` … | `success: true` → `finishedAt: now`, `notBefore: now + 60 s`; anything else → ambiguous or fatal per [contracts/facebook-publishing.md](./contracts/facebook-publishing.md) |
| `check_publish` (`finishedAt` set) | `GET /{videoId}?fields=status` | published → `done` (`externalId = videoId`). Not yet → `publishChecks + 1`, wait at the pace. Failed → fatal. Ceiling (60 min since `finishedAt`) → ambiguous |

### `facebookStepFor(state, content)` (pure and total)

Let `kinds = content.kinds`, with absent meaning all images, as today. `isVideo` is `mediaCount === 1 && kinds[0] === "video"`, and `type` is `content.postType`.

1. A valid Reel state with `finishedAt !== null` → `check_publish`, with `afterPublish: true`, **whatever the content**.
2. Non-null state on a video post that is neither valid shape → `{ name: "invalid", mayPublish: false, afterPublish: true }`.
3. If `isVideo && type === "reel"`, use a valid unfinished Reel state, or start over when there is none:
   - none → `start_reel` (allowance 1/1);
   - `uploadedAt === null` → `upload_reel`;
   - not `uploadComplete` → `check_upload`;
   - else → `finish_reel` (`mayPublish: true`).
4. If `isVideo` and the type is not `reel` → `publish_video` (`mayPublish: true`). Any unfinished Reel state is ignored.
5. Otherwise, today's photo machine, unchanged. An unfinished Reel state counts as `null`. Any other unparseable state → `invalid` (fatal), as today.

## 4. Requests module (`src/providers/facebook/requests.ts`, new, pure)

| Export | Shape |
|---|---|
| `RUPLOAD_HOST` | `"rupload.facebook.com"` |
| `pageVideoParams(item, text)` | `{ file_url, description? }` |
| `reelStartParams()` | `{ upload_phase: "start" }` |
| `reelFinishParams(videoId, text)` | `{ upload_phase: "finish", video_id, video_state: "PUBLISHED", description? }` |
| `ruploadHeaders(fileUrl)` | `{ file_url }`. The Authorization header is added by `ruploadRequest`, never here |
| `checkUploadUrl(raw, videoId, host = RUPLOAD_HOST)` | `URL \| null` (rules in research P7) |
| `readReelStatus(body)` | `{ videoStatus, uploading, processing, publishing, publishStatus, detail }` (strings or null) |
| `uploadState(r)` | `"complete" \| "failed" \| "pending"` |
| `publishState(r)` | `"published" \| "failed" \| "pending"` |

`src/providers/meta/graph.ts` gains:

```ts
/** One POST to a checked upload address; the token goes only in the Authorization header. No body. */
export function ruploadRequest(input: { url: URL; token: string; headers: Record<string, string>; signal: AbortSignal }): Promise<GraphOutcome>;
```

`MetaApp` gains `uploadHost?: string` (default `RUPLOAD_HOST`).

## 5. Requirements summary (G20 fix, `src/providers/requirements.ts`)

`video.notes = [...(caps.video.byPostType?.[shown]?.notes ?? [])]`. For `shown === "carousel"` this gives exactly today's `carouselNotes`. There is no shape change to `RequirementsSummary`. The Facebook summary values that follow:

| Field | Page video (default) | Reel |
|---|---|---|
| `video.postType` | `{ value: "video", label: "Page video", description: … }` | `{ value: "reel", label: "Reel", description: … }` |
| `maxVideos` / `withImages` | 1 / false | 1 / false |
| `containers` | MP4, MOV | MP4, MOV |
| `videoCodecs` / `audioCodecs` | `[]` / `[]` | H.264, HEVC, VP9, AV1 / AAC |
| `silentAllowed` | true | true |
| `maxBytes` | null | null |
| `duration` | – | 3 s – 1 min 30 s (or as `durationLabel` renders it) |
| `width` / `height` min | – | 540 px / 960 px |
| `aspectRatio` | – | 0.556 – 0.569 (as `ratioLabel` renders it) |
| frame rate | – | 24 – 60 fps |
| `notes` | the Page video note | the three Reel notes |
| `carousel` | null | null |

## 6. Test fixtures

- **`GraphRequest`** (`tests/helpers/fake-graph.ts`) gains `headers: Record<string, string>` (lower-cased, with `authorization` set to `[redacted]`) and `bodyBytes: number`.
- **`facebookVideoSetup(storage, text, opts?: { postType?: PostType; video?: Partial<VideoAssetOptions> })`** goes in `tests/helpers/facebook-publish.ts`. It returns `metaSetup`'s fields plus `postId`, `videoUrl` and `setPostType`.
