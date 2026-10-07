# Contract: video processing in the worker

Decisions P8–P12, P21 and P23 in [../research.md](../research.md). Everything under `src/server/video/` is worker-only: no file under `src/app/`, `src/proxy.ts`, `src/instrumentation.ts` or `src/server/scheduler/index.ts` may reach it (P21).

## Files

| File | Role |
|---|---|
| `src/server/video/guard.ts` | `markWorkerProcess()`, `assertWorkerProcess()` (a `globalThis` symbol) |
| `src/server/video/spawn.ts` | `runTool(bin, args, { timeoutMs, signal, maxStdout, stderrTail })` → `{ code, signal, stdout, stderrTail, killed }`. The **only** importer of `node:child_process`. It calls `assertWorkerProcess()`. |
| `src/server/video/probe.ts` | `probeFile(path, signal)` (runs ffprobe) and the pure `parseProbe(json)` → `ProbeResult \| { error: "unreadable" \| "no_video" }` |
| `src/server/video/clean.ts` | `cleanFile(src, dst, probe, signal)`: remux without metadata, then verify (P10) |
| `src/server/video/poster.ts` | `posterFile(src, dst, durationSeconds, signal)`; `makeThumbnail(png)` reuses the image thumbnail code |
| `src/server/video/process.ts` | `processVideoFile(sourcePath, workDir, limits, signal)` → `{ ok: true, facts, cleanPath, thumbnail } \| { ok: false, reason, log? }`. No DB, no storage. Used by the loop and by `scripts/video-smoke.ts`. |
| `src/server/video/loop.ts` | `runMediaLoop({ signal, idleMs = 2000 })` and `processNext({ signal })` (one claim and process, for tests) |
| `src/server/dal/media-processing.ts` | the cross-project claim repo (data-model §1) |

## `ProbeResult`

```ts
interface ProbeResult {
  durationSeconds: number;      // > 0, finite
  codedWidth: number; codedHeight: number;
  rotation: 0 | 90 | 180 | 270; // normalised from side data / tags
  width: number; height: number; // displayed, rotation applied
  frameRate: number | null;     // avg_frame_rate, fallback r_frame_rate; null when neither parses
  videoCodec: string;           // codec_name
  audioCodec: string | null;
  formatNames: string[];        // format.format_name split on ","
  formatTags: Record<string, string>;
  streamTags: Record<string, string>[];
}
```

## Commands (argument arrays, never a shell)

| Step | Binary | Arguments | Time limit |
|---|---|---|---|
| probe | `ffprobe` | `-v error -of json -show_streams -show_format <file>` | 60 s |
| clean | `ffmpeg` | `-nostdin -hide_banner -loglevel error -y -i <source> -map 0:v:0 -map 0:a:0? -c copy -map_metadata -1 -map_chapters -1 -f <mp4\|mov> <clean.tmp>` | min(10 min, 60 s + 1 s per 20 MB) |
| clean, rotation re-applied | `ffmpeg` | as above, with `-display_rotation:v:0 <deg>` before `-i`, or `-metadata:s:v:0 rotate=<deg>` after the maps (whichever the binary accepts; P10) | same |
| poster | `ffmpeg` | `-nostdin -hide_banner -loglevel error -y -ss <t> -i <clean> -frames:v 1 -an -f image2 -c:v png <poster.tmp.png>` | 60 s |

`t = min(1, durationSeconds / 2)`, formatted with 3 decimals. All of these:

- write to a `.tmp` name and rename on exit code 0 only;
- are killed with `SIGTERM` on timeout or abort, then `SIGKILL` after 5 s;
- treat any non-zero code or signal as failure.

## Failure reasons (stored in `processing_error`, shown on the row)

| Cause | Reason |
|---|---|
| sniff is not mp4/mov, or `format_name` has neither | "This is not an MP4 or MOV video." |
| no video stream | "This file has no video." |
| ffprobe failed, or duration unreadable | "Docket could not read this video." |
| over the library limits | "Videos can be up to {N}; this one is {M}." (duration, size, side) |
| clean or verify failed, poster failed, binary missing, not enough disk, storage error | "Docket could not process this video." The operator log names the cause, the asset id and the stderr tail. |
| attempts exhausted | "Docket could not process this video after 3 attempts." |

Log lines have the form `Docket media: <asset id>: <cause>`. They never contain storage keys, URLs, credentials, or more than 2 KB of stderr.

## Claim loop (P8)

```text
loop until signal aborted:
  row = crossProject("media: claim video", claimNext)       // FOR UPDATE SKIP LOCKED, lease 120 s, attempts+1, step probing
  if none: abortableSleep(2000, signal); continue
  if row.attempts > 3: finishFailed(...after 3 attempts); delete source; continue
  heartbeat every 30 s: renewLease(id, token) → false ⇒ abort this run (lost lease)
  work: getToFile(source) → processVideoFile → set step poster (conditional on token) → putFile(final) → put(thumb)
  ok    ⇒ finishReady(id, token, facts) → if false (deleted or lease lost): delete written objects
         else delete source_storage_key object
  fail  ⇒ finishFailed(id, token, reason); delete source and anything written
  abort by shutdown ⇒ release(id, token)  (lease null, attempts−1, step queued)
```

`src/worker.ts` calls `markWorkerProcess()` first. It then runs `runMediaLoop({ signal: controller.signal })` concurrently with `runLoop(runTick)`, and waits for both before `closeDb()`.

## Tests

ffmpeg suites go through `tests/helpers/ffmpeg.ts`, so they skip locally without ffmpeg and fail in CI.

| Test file | Covers |
|---|---|
| `src/server/video/probe.test.ts` (pure, no ffmpeg) | `parseProbe` on recorded JSON samples written by the CI run: avg vs r frame rate, rotation from side data and from tags, attached pictures ignored, audio absent, a bad duration |
| `tests/integration/video/process.test.ts` | landscape, portrait, silent and MOV fixtures → facts match within 0.1 s; rotated → displayed 180×320 and a portrait poster; located → no `location` tag and the coordinate string absent from the clean bytes; corrupt → "could not read"; audio-only → "no video"; over the limits (with the limits set low) → the reason names the limit (SC-005, US2 AS3 and AS5) |
| `tests/integration/video/spawn.test.ts` | timeout kills, abort kills, the `.tmp` output is never renamed, the stderr tail is bounded, `ENOENT` gives a clear error; the guard throws without `markWorkerProcess()` |
| `tests/integration/video/loop.test.ts` | `processNext` against the DB and `MemoryStorage`: queued → probing → poster → ready, with objects at the final keys and the source deleted; failure removes bytes; two concurrent `processNext` calls claim different rows; an expired lease is re-claimed with attempts counted; abort releases with the attempt refunded; the 4th claim fails the item; a deleted-mid-run row leaves no objects |
| `tests/lint/no-ffmpeg-in-web.test.ts` | P21 import walk and the `child_process` allow-list (SC-007) |
