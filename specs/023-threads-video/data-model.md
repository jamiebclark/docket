# Data model: Threads video

No database change, no migration and no new contract member in `src/providers/types.ts` (research F19, P18, P21). Everything below is provider-local TypeScript (capabilities, step state, pure step and request functions), plus two generic tweaks to existing pure helpers (P2, P3) and one to a test helper (P6).

## 1. Threads capabilities (`src/providers/threads/capabilities.ts`)

```ts
// docs/research/meta-video.md "Threads". Decimal gigabyte (D2). Bitrates, sample rate, channels, scan, GOP,
// chroma, edit lists and moov placement are not declared: Docket does not probe them (FR-005).
export const THREADS_VIDEO = {
  maxVideos: 1,
  withImages: false,
  containers: ["mp4", "mov"],
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  silentAllowed: true,
  maxBytes: 1_000_000_000,
  maxDurationSeconds: 300,
  maxWidth: 1920,
  minAspectRatio: 0.01,
  maxAspectRatio: 10,
  minFrameRate: 23,
  maxFrameRate: 60,
} as const satisfies VideoCapabilities;

export const THREADS_MAX_ITEMS = 20; // carousel: 2 to 20 items, images and videos together
```

`threadsCapabilities` changes only in these members:

| Member | Before | After |
|---|---|---|
| `video` | `{ maxVideos: 0 }` | `{ ...THREADS_VIDEO, byPostType: { video: { notes: ["9:16 (vertical) is recommended."] }, carousel: { maxVideos: 20, withImages: true, notes: ["A carousel holds 2 to 20 items, images and videos counted together."] } } }` |
| `postTypes` | `["text", "image", "carousel"]` | `["text", "image", "carousel", "video"]` |

The text, media (image) block, `textOnlyAllowed` and the publish limit (250 / 86,400 s) are unchanged. There are no `postTypeChoices` and no `creationAllowance`. The registry checks in `assertVideoCapabilities` pass: `video` is in `postTypes`, both `byPostType` keys are post types, the minimum frame rate is below the maximum, and `withImages` has images to share with.

**Effective limits** (`videoLimitsFor`):

| Post type | maxVideos | withImages | Other bounds |
|---|---|---|---|
| `video` (one video, nothing else) | 1 | no | `THREADS_VIDEO` |
| `carousel` (2+ items) | 20 | yes | `THREADS_VIDEO` (no carousel-only bounds, D3) |

The total of 2–20 items is enforced by `validateThreads` `too_many_items` (mixed posts) together with `too_many_images` and `too_many_videos` (research P4), and by `threadsStepFor` returning `invalid` above 20.

## 2. Threads step state (`src/providers/threads/state.ts`)

```ts
const id = z.string().regex(/^\d{1,40}$/);
const progress = z.object({ createdAt: z.iso.datetime(), checks: z.number().int().min(0), ready: z.boolean() });

export const threadsStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["TEXT", "IMAGE", "VIDEO", "CAROUSEL"]),     // + VIDEO
  /** CAROUSEL with at least one video only: every item's kind, in post order. Absent = all images. */
  kinds: z.array(z.enum(["image", "video"])).min(2).max(20).optional(),
  /** Aligned with `items` when `kinds` is set. Images are saved ready. */
  itemProgress: z.array(progress).max(20).optional(),
  items: z.array(id).max(20),
  container: id.nullable(),
  createdAt: z.iso.datetime().nullable(),
  checks: z.number().int().min(0),
  ready: z.boolean(),
  quotaChecked: z.boolean(),
  recreations: z.number().int().min(0).max(2),
});
```

**Compatibility**: every state saved before this entry (TEXT, IMAGE, CAROUSEL without `kinds` or `itemProgress`) parses unchanged and drives the same steps (FR-015, SC-008).

**Plan** (derived from the content on every call, never stored on its own):

```ts
export interface ThreadsPlan {
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";
  /** CAROUSEL only: kind of every item, in post order. */
  kinds?: readonly ("image" | "video")[];
}
/** planOf: 0 → TEXT; 1 → IMAGE or VIDEO by kind; 2–20 → CAROUSEL with kinds; otherwise null (invalid). */
```

`kinds` from `StepContent` (or `content.media[].kind` in `advanceThreads`) is used only when its length equals `mediaCount`. Otherwise all items are images, as for callers before 019.

`initialState(plan)` gives `{ v: 1, mediaType, items: [], container: null, createdAt: null, checks: 0, ready: false, quotaChecked: false, recreations: 0 }`. When the plan is a carousel with a video, it also has `kinds` and `itemProgress: []`. `initialState(count: number)` stays, for existing callers and tests.

**Constants** (new values; the existing ones are unchanged):

| Name | Value | Use |
|---|---|---|
| `VIDEO_FIRST_CHECK_DELAY_MS` | 30,000 | first read of a video container or item, from its creation |
| `VIDEO_SLOW_AFTER_MS` | 300,000 | age after which reads are 5 min apart |
| `VIDEO_SLOW_INTERVAL_MS` | 300,000 | the slow interval |
| `VIDEO_PROCESSING_CAP_MS` | 3,600,000 | `IN_PROGRESS` at or beyond this age fails |
| `videoCheckDelayMs(age)` | 60,000 if age < 5 min, else 300,000 | the next read after `IN_PROGRESS` |

The existing constants keep their values: `FIRST_CHECK_DELAY_MS` 30 s, `CHECK_INTERVAL_MS` 60 s, `PROCESSING_CAP_MS` 5 min, `CONTAINER_SAFE_AGE_MS` 23 h and `MAX_RECREATIONS` 2.

### Validity (`validState(state, plan)`)

It returns the parsed state, or null to restart from the first create step. Null when any of these hold:

1. it does not parse;
2. `mediaType ≠ plan.mediaType`;
3. a non-carousel has `items.length > 0`;
4. for a carousel:
   - the saved kinds (absent = all images) differ from `plan.kinds` (length or any position);
   - `items.length > kinds.length`;
   - with a video: `itemProgress?.length ≠ items.length`, or a container exists while any `itemProgress` is not ready;
   - a container exists while `items.length < kinds.length`;
5. `ready && !container`;
6. `quotaChecked && !ready`.

Rules 2, 3 and 4 (image-only) and 5–6 are today's rules, so every existing case in `steps.test.ts` gives the same answer.

### State transitions

```text
TEXT / IMAGE / VIDEO:
  create_container ──ok──▶ {container, createdAt=now}  notBefore = now + 30 s
  check_status ──IN_PROGRESS──▶ checks+1, notBefore = now + (video ? videoCheckDelayMs(age) : 60 s)
               ──FINISHED────▶ ready
               ──ERROR / IN_PROGRESS past the cap──▶ fatal
               ──EXPIRED─────▶ initialState(plan) with recreations+1 (fatal after 2)
               ──PUBLISHED───▶ ambiguous
  check_quota ──age ≥ 23 h──▶ recreate ; ──quota full──▶ retryable (1 h) ; ──ok/unknown──▶ quotaChecked
  publish ──id──▶ done ; ──timeout/unreadable──▶ ambiguous

CAROUSEL with video (kinds has "video"):
  create_item_k ──ok──▶ items+id, itemProgress+{createdAt: now, checks: 0, ready: kind === "image"}
                        (after the last item: notBefore = first unready item's createdAt + 30 s)
  check_item_k  (k = first unready) ──IN_PROGRESS──▶ progress.checks+1, notBefore = now + videoCheckDelayMs(age_k)
                                    ──FINISHED────▶ progress.ready; notBefore = next unready's createdAt + 30 s, if any
                                    ──ERROR / past 60 min──▶ fatal (names item k)
                                    ──EXPIRED─────▶ recreate whole post
                                    ──PUBLISHED───▶ ambiguous
  create_carousel ──ok──▶ {container, createdAt=now}  notBefore = now + 30 s
  check_status / check_quota / publish as above, video pace; the 23 h age is measured from the oldest container
```

An image-only carousel follows today's path exactly: no `kinds`, no `itemProgress`, no `check_item_*`, the image pace and the 5-minute cap.

## 3. Step function (`src/providers/threads/steps.ts`)

`threadsStepFor(state, content)` is pure and total:

| Saved state (after `validState ?? initialState(plan)`) | Step | mayPublish |
|---|---|---|
| plan null (count < 0, > 20 or not finite) | `invalid` | false |
| no container, plan not CAROUSEL | `create_container` | false |
| no container, carousel, `items.length < kinds.length` | `create_item_<items.length + 1>` | false |
| no container, carousel, some `itemProgress` not ready | `check_item_<first unready + 1>` | false |
| no container, carousel, all items ready (or image-only) | `create_carousel` | false |
| container, not ready | `check_status` | false |
| ready, quota not checked | `check_quota` | false |
| quota checked | `publish` | true |

No `allowance` is returned (D11).

## 4. Requests (`src/providers/threads/requests.ts`, new)

These are pure builders. Their exact shapes and the absent keys are in [contracts/threads-publishing.md](./contracts/threads-publishing.md) §2.

```ts
export const STATUS_FIELDS = "status,error_message";
export function videoContainerParams(item: Pick<MediaItem, "url">, text: string): Record<string, string>;
export function itemParams(kind: "image" | "video", item: Pick<MediaItem, "url" | "altText">): Record<string, string>;
export function readStatus(body: unknown, secrets: readonly string[]): { status: string | null; errorMessage: string };
```

## 5. Video error explanations (`src/providers/threads/video-errors.ts`, new)

```ts
export const THREADS_VIDEO_ERROR_CODES = [
  "FAILED_DOWNLOADING_VIDEO", "FAILED_PROCESSING_VIDEO", "INVALID_DURATION",
  "INVALID_FRAME_RATE", "INVALID_BIT_RATE", "INVALID_ASPEC_RATIO",
] as const;
/** The plain explanation for the first documented code in the message (whole token, case-sensitive), else null. */
export function videoErrorExplanation(errorMessage: string): string | null;
/** The full target message for an ERROR on a video container (contract §5). */
export function videoErrorText(where: VideoWhere, errorMessage: string): string;
type VideoWhere = { kind: "single" } | { kind: "item"; position: number } | { kind: "carousel" };
```

## 6. `docs/limits.md` Threads rows (FR-020)

The `videos` row changes from 0 to 1. These rows are added after `text only`, before `publish limit`:

| Category | Value | Enforced in | Test |
|---|---|---|---|
| videos | 1 | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| video with images | no | validateResolvedContent | same as above |
| video containers | mp4, mov | validateResolvedContent | `src/providers/validation.test.ts` "refuses a container the provider does not list" |
| video codecs | h264, hevc | validateResolvedContent | enforcement "threads: video codecs" |
| audio codecs | aac | validateResolvedContent | enforcement "threads: audio codecs" |
| silent video | yes | validateResolvedContent | `src/providers/validation.test.ts` "accepts a silent video unless the provider forbids it" |
| video bytes | 1000000000 | validateResolvedContent | enforcement "threads: video bytes" |
| max duration | 300 | validateResolvedContent | enforcement "threads: max duration" |
| video max width | 1920 | validateResolvedContent | enforcement "threads: video max width" |
| video min aspect | 0.01 | validateResolvedContent | enforcement "threads: video min aspect" |
| video max aspect | 10 | validateResolvedContent | enforcement "threads: video max aspect" |
| min frame rate | 23 | validateResolvedContent | enforcement "threads: min frame rate" |
| max frame rate | 60 | validateResolvedContent | enforcement "threads: max frame rate" |
| carousel videos | 20 | validateResolvedContent | enforcement "threads: carousel videos" |
| carousel video with images | yes | validateResolvedContent | `src/providers/validation.test.ts` "limits videos and mixing with images" |
| note: carousel items | 2 to 20, images and videos together | validateResolvedContent | `src/providers/threads/video-validate.test.ts` "a mixed carousel of 21 items is refused and 20 is accepted" |
| note: video processing ceiling | 60 min | Threads step machine | `tests/integration/threads/video-failures.test.ts` "moves to the 5-minute pace after 5 minutes, and fails at 60 minutes within 17 reads" |
| note: video items checked before the carousel | each video item reads FINISHED before `create_carousel` | Threads step machine | `tests/integration/threads/video-carousel.test.ts` "creates the carousel only after every video item is finished" |

"enforcement" means `tests/integration/limits/enforcement.test.ts`. Every Source cell is `docs/research/meta-video.md ("Threads")`, with the decision noted where one applies:

- 1 GB is read as decimal (D2);
- silence is accepted (D2);
- the 60-minute ceiling is a Docket choice, with 5 minutes as guidance, not a hard stop (D6);
- the item checks are UNVERIFIED, a conservative choice (D5).

The note row for the existing carousel minimum stays. The inventory test must accept the notes-only `byPostType.video` entry, which yields no bound rows.

## 7. Requirements summary (generic, P2/P3)

| Field | Threads value |
|---|---|
| `video.maxVideos` / `withImages` | 1 / false |
| `video.containers` | MP4, MOV |
| `video.videoCodecs` / `audioCodecs` | H.264, HEVC / AAC |
| `video.silentAllowed` | true |
| `video.maxBytes.label` | "1 GB" (P3) |
| `video.duration` | max "5 minutes" |
| `video.width` | max "1920 px" |
| `video.aspectRatio` | "1:100" – "10:1" |
| `video.minFrameRate` / `maxFrameRate` | "23 fps" / "60 fps" |
| `video.postType` | **null** (no choice, P2), so no "Post as" row |
| `video.notes` | ["9:16 (vertical) is recommended."] for a single video |
| `carousel` | `{ maxItems: 20, mixed: true, videoAspectRatio: 1:100 – 10:1, notes: ["A carousel holds 2 to 20 items, images and videos counted together."] }` |
