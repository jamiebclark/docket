# Contract: building versions and previews in the worker

Covers FR-014–FR-021, FR-023, FR-033, FR-037 (argument builders) and FR-039–FR-041 (worker parts). Decisions: [research.md](../research.md) P5–P9, P11, P12, P17, P22, P23, P26.

Every file below lives under `src/server/video/`, so the web process cannot import it (`tests/lint/no-ffmpeg-in-web.test.ts`). Every tool runs through `runTool`, which calls `assertWorkerProcess()`.

## Pure argument builders: `ffmpeg-args.ts` (FR-037)

```ts
export const USED_OPTIONS: { encoders: Record<"libx264" | "aac", string[]>; filters: Record<string, string[]>; muxers: Record<"mp4" | "mov", string[]> };
export function filterGraph(recipe: VideoRecipe): { graph: string; complex: boolean };
export function encodeArgs(src: string, dst: string, recipe: VideoRecipe, rate: { videoBitrate: number | null }, opts: { preview: boolean }): string[];
export function rewrapArgs(src: string, dst: string, recipe: VideoRecipe, rotation: 0 | 90 | 180 | 270, mode: "none" | "display" | "tag"): string[];
export function encodeTimeoutMs(keptMs: number, preview: boolean): number;   // P12
```

- **Encode argument order.**
  - The common prefix is `-nostdin -hide_banner -loglevel error -y`.
  - Then `-ss <start s, 3 decimals>` (only when `startMs > 0`) and `-i <src>`.
  - Then `-t <kept s, 3 decimals>` (always, so a cut is exact).
  - Then the video filter (`-vf <graph>`, or `-filter_complex <graph> -map [v]`) and `-map 0:a:0?`.
  - Then the video encoder flags (P6), the audio flags or `-an`, and `-movflags +faststart -f mp4 <dst>`.
- **Crop:** `crop=w:h:x:y,scale=W:H,setsar=1,format=yuv420p`. `scale` is left out when the size is unchanged.
- **Colour pad:** `scale=fw:fh,pad=cw:ch:x:y:color=0xrrggbb,setsar=1,format=yuv420p`.
- **Blurred pad** (`-filter_complex`):

  ```text
  [0:v]split=2[bg][fg];[bg]scale=BW:BH,crop=QW:QH,boxblur=luma_radius=R:luma_power=2,scale=CW:CH[b];[fg]scale=FW:FH[f];[b][f]overlay=X:Y,setsar=1,format=yuv420p[v]
  ```

  - `QW×QH` is the canvas ÷ 4, made even and at least 2.
  - `BW×BH` covers `QW×QH` at the source aspect.
  - `R` is defined in P7.
- **Frame rate:** a leading `fps=<n>` in the chain, only when the recipe sets a rate.
- **No reframe and no resize:** `format=yuv420p` only.
- **Rewrap:** entry 2's `remux` arguments with `-c copy`, `-movflags +faststart`, and `-f <container>`. Metadata is **kept**, because the source is the already-cleaned original. Rotation follows clean's `display`, then `tag`, fallback.
- **The source size** in every builder is the *displayed* size. ffmpeg's decoder applies rotation before the filters. That is UNVERIFIED (research §4.2), so the readback below checks it, and the rotated fixture covers it.

## Facts: `probe.ts` and `boxes.ts` (FR-014)

- **`parseProbe`** also returns:
  - `videoBitrate` (the stream's `bit_rate`, else null);
  - `formatBitrate` (the format's `bit_rate`);
  - `audioBitrate`;
  - `audioSampleRate` (`sample_rate`);
  - `audioChannels` (`channels`).
  - Unparseable values become null.
- **`indexAtFront(path)`** reads only box headers: a 32-bit size plus type, a 64-bit `largesize` when the size is 1, and "to end of file" when the size is 0. It returns `true` when `moov` comes before the first `mdat`, `false` when `mdat` comes first or `moov` is missing, and `null` when the file is unreadable.
  - Box headers are read at most 64 times.
  - The walk is pure on a file handle and needs no tool.
- **`processVideoFile`** and the rescan record the five facts from the cleaned file, with `facts_version = 2`.

## Entry 2's clean step (D18, FR-014a)

`remux` in `clean.ts` adds `-movflags +faststart`. The verification is unchanged and additionally reads `indexAtFront`. Originals stored earlier are never rewritten (the rescan only reads).

## The rescan (P9)

`runMediaLoop` → `processNext` claims a `processing` row first. When none is queued, it calls `rescanNext`:

1. Claim (data-model §1).
2. `getToFile` into a temp directory.
3. `probeFile` and `indexAtFront`.
4. `finishRescan`.

A missing object or an unreadable file only clears the lease. After 3 claims, `facts_attempts = 3` and the planner refuses with `video_facts_unreadable`.

## The version loop: `versions-loop.ts` (FR-015–FR-017, FR-021, FR-023)

```ts
export async function buildNext({ signal }: { signal: AbortSignal }): Promise<boolean>;
export async function runVideoVersionLoop({ signal, concurrency, idleMs = 2000 }: { signal: AbortSignal; concurrency: number; idleMs?: number }): Promise<void>;
```

`src/worker.ts` adds `runVideoVersionLoop({ signal, concurrency: getEnv().media.videoEncodeConcurrency })` to its `Promise.all`. There are `concurrency` independent lanes. Each lane runs these steps:

1. **Claim.** `crossProject("video: claim version", () => repo().claimNext(now))`. Null → sleep `idleMs`.
2. **Too many attempts.** `attempts > 3` → `finishFailed(…, "<last reason> after 3 attempts")`, done.
3. **Heartbeat.** Renew every 30 s. A lost lease aborts the work signal, as in entry 2.
4. **Work.** `mkdtemp(tmpdir(), "docket-video-")`, then `getToFile(asset.storageKey)`.
   - A missing object → `finishFailed("The original video is no longer available.")`, with no retry.
5. **Build.** `rewrap`: run `rewrapArgs` through clean's mode loop. `encode`: run `encodeArgs` under `encodeTimeoutMs`, with the size-fit loop (P8: ≤ 4 encodes, never `-fs`).
6. **Readback** (D13). `probeFile(out)` and `indexAtFront(out)`, then compare against the recipe:
   - container;
   - `h264`, and `aac` or none (rewrap: the source's codecs unchanged);
   - width and height exact;
   - `|duration − keptMs| ≤ 100 ms` (rewrap: within 100 ms of the source);
   - frame rate (when set: `|fps − rate| ≤ 0.5`; else unchanged within 0.5);
   - bytes ≤ `maxBytes`;
   - `videoBitrate ≤ maxBitrate`;
   - index at the front when required.
   - A preview is checked for size, duration and codecs only.
   - **A mismatch is a failed attempt:** `retryLater`, nothing uploaded, and the cause logged without paths.
7. **Store.** `putFile(storageKey, out, "video/mp4" | "video/quicktime", signal)`, then `finishReady(id, token, probed facts, storageKey, publicUrl)`.
   - **When `finishReady` returns false** (the lease was lost, or the asset was deleted or the row removed), delete the uploaded object (FR-023, Edge Cases).
8. **Always:** clear the heartbeat and remove the temp directory. On a shutdown abort, `release` (the attempt is refunded) and delete anything uploaded.

**Failure reasons** are plain and stored in `video_versions.error` (≤ 300 characters). The full tool output is logged, never stored.

| Cause | Reason |
|---|---|
| `ToolMissingError` | "Video tools are not installed in the worker." |
| storage not configured | "Media storage is not set up." |
| original missing | "The original video is no longer available." |
| decode error, non-zero exit, unreadable output | "Docket could not read the video." |
| timeout | "Adapting the video took too long." |
| size loop exhausted | "The video could not be made smaller than 300 MB for Instagram." |
| readback mismatch | "The adapted video did not match what was planned." |

**Ordering and fairness.** `due_at ASC NULLS LAST, created_at`. A preview is due when it is requested; a full version is due at its earliest target (P14).

**Heartbeat.** `writeHeartbeat("video", now, counts)` is written at most once per minute per process, including while idle, so the tick can tell that a worker is alive (P13).

## Housekeeping collection (P17, FR-033)

`collectVideoVersions(now)` is in `src/server/scheduler/housekeeping.ts` and is added to `runHousekeeping`'s counts as `videoVersionsRemoved`.

- It takes at most 20 rows per tick.
- For each, it plans every target of every post that uses the asset, using the posts' saved edits (pure planner, no tool).
- A row that is still wanted gets `markChecked`. Otherwise it is deleted, then its object, with a 5 s timeout.
- It never touches `building` rows.
- `deleteMedia` deletes all the asset's rows and objects in its existing post-commit step.

## Tests

- **`src/server/video/ffmpeg-args.test.ts`** (pure, FR-037). It covers:
  - crop with the focal point at the centre, near each edge and at each edge;
  - blurred pad (the graph string and its numbers);
  - colour pad (`color=0xffffff`);
  - trim: start only, start and end, and a cut at the maximum (`-ss`/`-t` values);
  - the frame-rate change (`fps=60` first);
  - a downscale (`scale=1920:1080`);
  - evenness;
  - the audio flags (`-ar 48000 -ac 2 -b:a 128k`, and `-an` when silent);
  - `-maxrate`/`-bufsize` only with a cap;
  - `+faststart` always;
  - no `-fs` anywhere;
  - `encodeTimeoutMs` bounds.
- **`src/server/video/boxes.test.ts`** (pure, synthetic buffers): `moov` first, `mdat` first, a 64-bit `largesize`, a size-0 last box, and truncated or garbage input.
- **`src/server/video/probe.test.ts`** (extended): the bitrate, sample-rate and channel parsing, and nulls.
- **`tests/integration/video/ffmpeg-options.test.ts`** (`requireFfmpeg()`): every `USED_OPTIONS` entry appears in the installed tool's `-h encoder=…`, `-h filter=…` and `-h muxer=…` output (P6).
- **`tests/integration/video/formatter.test.ts`** (`requireFfmpeg()`, FR-039).
  - **Fixtures** are generated at test time: landscape 320×180, portrait, square 240×240, silent, MOV, 60 fps, a 21:9 clip, a rotated clip, and an index-at-end MP4 (made without `+faststart`, with the precondition asserted by `indexAtFront`).
  - **Each check** runs `encode` or `rewrap` from a planner recipe and probes the output's dimensions, duration (±0.1 s), container, codecs, frame rate and size:
    - crop at focal 0, 0.5 and 1 (by sampling a pixel column of a `color`-split fixture, so the kept side is known);
    - blurred pad and colour pad (the canvas size, and a corner pixel equal to the colour for colour pad);
    - a trim with `start > 0`;
    - a cut at the maximum;
    - 60 fps → 30 fps;
    - a 21:9 clip → 16:9;
    - a MOV rewrap (codecs and duration unchanged, `-c copy`);
    - an index-at-end rewrap (`indexAtFront` true afterwards);
    - a rotated clip (the output's displayed size matches the plan);
    - silent stays silent;
    - a size limit forcing the retry loop (a `maxBytes` that the first encode overshoots → a second encode under the limit).
- **`tests/integration/video/versions-loop.test.ts`** (`requireFfmpeg()`, with `MemoryStorage` and a real DB):
  - one version claimed by two lanes is built once;
  - a lease-expiry takeover after a simulated kill (an abort mid-encode, then the lease expires, then another lane rebuilds from scratch, and no partial object exists) (US5 #5, FR-041);
  - a deleted asset mid-build → nothing stored;
  - a readback mismatch (a recipe tampered to expect another width) → `retryLater`, then `failed` after 3, and never `ready` (FR-041);
  - a missing original → failed "The original video is no longer available.";
  - a missing tool (PATH emptied) → "Video tools are not installed in the worker.";
  - the ordering by `due_at`;
  - `VIDEO_ENCODE_CONCURRENCY=2` runs two at once.
- **`tests/integration/media/rescan.test.ts`** (`requireFfmpeg()`): a v1 video gets its facts and version 2 with the stored object byte-for-byte unchanged (FR-014a), and 3 failures → `video_facts_unreadable`.
- **`tests/integration/media/clean-faststart.test.ts`** (`requireFfmpeg()`): an index-at-end upload is stored with its index at the front, and the existing clean verification still passes.
- **`tests/integration/video/collect.test.ts`** (no ffmpeg): unwanted rows older than 24 h are removed with their objects, wanted ones are kept, `building` rows are untouched, and a deleted video removes its rows.
- **`scripts/video-smoke.ts`** (docker CI job, `--cpus=2`): pad, crop and trim of a generated 30 s 1080×1920 clip to the mock limits, with readback, plus a preview whose time is printed (SC-007).
