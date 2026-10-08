# Contract: queueing versions, waiting at publish time, failing clearly

Covers FR-022, FR-024–FR-027, FR-040 and FR-041 (scheduler parts), and SC-002, SC-004 and SC-005. Decisions: [research.md](../research.md) P13–P15, P19.

## `syncVideoVersions(scope, postId, opts)`: `src/server/services/video-versions.ts`

```ts
export async function syncVideoVersions(
  scope: Pick<ProjectScope, "posts" | "targets" | "accounts" | "media" | "videoVersions"> & { project: { id: string } },
  postId: string,
  opts: { requeueFailed?: boolean; targetIds?: string[] } = {},
): Promise<void>;
```

- **Outside any transaction, after the caller's commit.** It never throws: failures are logged, and the claim-time gate heals them.
- **Which targets.** Only targets in `scheduled` or `publishing` status (drafts get none, D10). `targetIds` narrows them.
- **What.** For each `(video, target)` whose plan is `derive`, it calls `ensureQueued({ kind: "full", key, recipe, steps, dueAt: target.scheduledAt })`. `ON CONFLICT` keeps the earliest `due_at` and refreshes `requested_at`. With `requeueFailed`, a `failed` row goes back to `queued` with `attempts = 0` and `error = null`.

**Called from** (all after their `scope.transaction` returns successfully):

| Service | opts |
|---|---|
| `addToQueue`, `scheduleAt`, `publishNow` (`src/server/services/posts/index.ts`) | `{ requeueFailed: true, targetIds }` |
| `updatePost` (any change to text, media, targets or `videoEdits`) | `{}` |
| `retryTarget`, and each target retried by `retryAllFailed` (`retry.ts`, `retry-all.ts`) | `{ requeueFailed: true, targetIds: [id] }` |

The public API operations (`queue`, `schedule`, `retry`) and the generation `add_to_queue` path call these services, so they need nothing extra.

## The claim-time gate: `decide()` in `src/server/scheduler/publishing.ts`

The gate runs only when `target.stepState === null` (first step), after the account and duration checks and before the publish-limit deferral.

```ts
type VideoGate =
  | { kind: "none" }                       // no video on the post, or every video is `original`
  | { kind: "ready" }                      // every adapted video has a ready full version
  | { kind: "waiting"; platform: string }  // queued/building/missing version, or a `checking` plan
  | { kind: "failed"; reason: string };    // a version failed (reason is its error)

ClaimContext.videoGate(target: { id; projectId; postId; chosenPostType }, provider: SocialProvider): Promise<VideoGate>;
```

`videoGate` reads, using the claim transaction's executor:

- the post's media in order;
- `post_video_edits`;
- the `video_versions` rows by key.

It plans each video with `planVideo`. A `derive` plan with no row inserts one, `queued` and due now. The gate makes no storage, tool or provider call.

**Decisions:**

| Gate | Patch | Attempt rows | Counts |
|---|---|---|---|
| `none`, `ready` | continue to the deferral and the lease, as today; the lease patch also sets `videoWaitSince: null` | as today | as today |
| `waiting`, within 2 h of `videoWaitSince` | `{ nextAttemptAt: now + 60 s, videoWaitSince: target.videoWaitSince ?? now }` (status unchanged, no lease) | **none** | `waitingForVideo++` |
| `waiting`, over 2 h | `{ status: "failed", nextAttemptAt: null, videoWaitSince: null, lastError }` | one `{ step: "engine-video", outcome: "fatal_error", error: lastError }` | `failed++` |
| `failed` | same as above | same | `failed++` |

**`lastError`** is one of:

- "The video could not be adapted for <platform>: <reason>" (FR-025, D11);
- "The video could not be adapted for <platform>: it took too long.";
- "The video could not be adapted for <platform>: video adapting needs the worker process, which is not running.", when no `video` heartbeat is younger than 10 minutes.

`<platform>` is the provider's display name. It does not include the type label ("Facebook", not "Facebook Reel"), matching US5's "Preparing video for Facebook".

**Activity.** A failure decision uses `eventForDecision` as other claim-time failures do, so it appears in the activity log and in notifications (entry 022) like any failed target. A wait writes no event.

**Bounds** (SC-004). The gate adds at most four indexed reads per claimed target with video and one insert. Planning is pure arithmetic. `runTick`'s budget is unchanged.

## Publishing the version: `resolvePublishMedia`

This is in `src/server/services/media-variants.ts`, runs in `execute()` outside any transaction, and is extended for video items:

- **`original`**: the stored item, unchanged (FR-026, SC-002). The stored object must still exist (as today).
- **`derive`** with a `ready` full row: `storage.exists(row.storageKey)`.
  - The object exists → the item is the version's public URL and probed facts (`mimeType` from the container, `bytes = byte_size`, and `video` facts from the row).
  - The object has vanished → `videoVersions.requeue(row.id)` and return `{ ok: false, notReady: true }`. `execute()` then calls `release("Preparing video again.")`, which records one `released` row, and the next tick's gate waits (FR-022).
- **`derive`** with no `ready` row on a later step (a race) → `notReady`, as above.
- **`refuse`** → `{ ok: false, error: <first issue> }`, which is fatal before any provider call (as today).
- **`checking`** → `notReady`.

Video is never built here (D9). Image handling is unchanged.

**The G15 re-check** in `execute()` runs on the resolved content, so a version's own facts are validated against the provider's current limits before the first provider call. Outcome rules are unchanged (FR-027): every new path is before `advance`, so none can be ambiguous.

## Retry and the waiting state

- **Retry.** `retryTarget`, `retryLockedTarget`, `retryAllFailed` and the API retry set `videoWaitSince = null`. Their callers then run `syncVideoVersions(…, { requeueFailed: true })`, so a failed or removed version is queued again (FR-025, D16).
- **Cancel and reschedule.** These clear `videoWaitSince`.
- **What people see.** `PostTargetView.preparingVideo` and `PostViewTarget.preparingVideo` are true while the target is `scheduled` with `videoWaitSince` set. The post page, the posts list badge and the composer's target status show "Preparing video for <platform>" (data-model §2). The calendar shows the target as scheduled, unchanged.

## Tests

All use the DB clock (`tests/helpers/clock.ts`) and the mock provider or mocked Graph. None needs ffmpeg: version rows are set directly.

- **`tests/integration/scheduler/video-wait.test.ts`** (US5):
  - **A due target waits.** It is due and its version is `queued`: ticks make no provider call, add no attempt row, leave `attemptCount` 0 and `status` `scheduled`, set `videoWaitSince`, and set `preparingVideo` in the post view (US5 #1).
  - **The version becomes ready.** Mark it `ready` with a stored object: the next tick publishes, the mock's request summary shows the version's URL, and `videoWaitSince` is cleared (US5 #2).
  - **The version fails.** Mark it `failed` ("Docket could not read the video."): the next tick fails the target with "The video could not be adapted for Mock: Docket could not read the video.", with one `engine-video` attempt and no provider call. A retry gives `queued`, attempts 0, and the target scheduled again (US5 #3).
  - **It waits too long.** Still `queued`, with the clock 2 h 1 min past the first wait → "it took too long". With the heartbeat removed, the worker-not-running reason is used instead (US5 #4, Edge Cases).
  - **A missing row** is inserted `queued` by the tick (self-heal).
  - **A `checking` video** waits.
  - **Two targets** with identical limits share one row (US1 #6).
- **`tests/integration/media/video-as-is.test.ts`** (FR-040, SC-002): a video inside every limit, with the default edit, goes to the mock and to mocked Instagram. The provider receives the stored original's URL, and the object's bytes are unchanged. No `video_versions` row exists and no tool runs (`runTool` is spied, never called).
- **`tests/integration/media/video-publish-adapted.test.ts`** (US1, SC-001, mocks).
  - **Setup.** A too-long and too-wide video goes to the mock and to mocked Facebook Reel and Instagram.
  - **Versions.** `syncVideoVersions` queues one row per distinct recipe. The test sets the rows `ready` with stored objects.
  - **Result.** Each target publishes its version's URL, and the as-is target publishes the original.
  - **With ffmpeg** (`requireFfmpeg()`), a second case runs `buildNext` for real and probes the published object against the target's limits (SC-003).
- **`tests/integration/media/video-version-vanished.test.ts`**: a `ready` row whose object is deleted → `released`, then `queued`, and the target waits. Nothing is published without its file.
- **`tests/integration/compose/video-sync.test.ts`**:
  - `addToQueue`, `scheduleAt`, `publishNow` and `updatePost` (an edit change) queue the right keys;
  - drafts queue none;
  - an edit change queues a new key and the old one is no longer wanted;
  - retry requeues failed rows.
- **Stale result** (FR-041, `tests/integration/scheduler/video-stale.test.ts`): a version for edit A becomes ready after the post's edit changed to B. The target waits for B's version and never publishes A's.
- **Existing suites.** `tests/integration/scheduler/*` and every provider suite pass unchanged. Only messages that lose the removed suffix change (FR-042).
