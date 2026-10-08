import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoRecipe } from "../../providers/video-plan";
import { videoBytesLabel } from "../../providers/video-labels";
import { writeHeartbeat } from "../dal/heartbeats";
import { MAX_VERSION_ATTEMPTS, videoVersionProcessingRepo as repo, type VideoVersionProcessingRepo } from "../dal/video-version-processing";
import { crossProject } from "../dal/scope";
import { abortableSleep } from "../scheduler/loop";
import { getStorage, mediaKeys } from "../storage";
import type { Storage } from "../storage";
import { BuildError, buildFile, reasonFor } from "./encode";
import { probeFile } from "./probe";
import { readBack, type SourceFacts } from "./readback";
import { ToolMissingError } from "./spawn";

const HEARTBEAT_MS = 30_000;
const SECTION_BEAT_MS = 60_000;
const MIME = { mp4: "video/mp4", mov: "video/quicktime" } as const;

const NO_TOOLS = "Video tools are not installed in the worker.";
const NO_STORAGE = "Media storage is not set up.";
const NO_ORIGINAL = "The original video is no longer available.";
const MISMATCH = "The adapted video did not match what was planned.";

const log = (id: string, cause: string) => console.error(`Docket video: ${id}: ${cause}`.slice(0, 2300));
const quietly = (storage: Storage, key: string | null | undefined) =>
  key ? storage.delete(key).catch(() => log("storage", "could not delete an object")) : Promise.resolve();

let lastBeat = 0;
/** At most once a minute per process, idle or not: the tick reads it to tell that a worker is alive (P13). */
async function beat(lanes: number): Promise<void> {
  const now = Date.now();
  if (now - lastBeat < SECTION_BEAT_MS) return;
  lastBeat = now;
  await writeHeartbeat("video", new Date(now), { lanes }).catch(() => undefined);
}

/** Claims and builds one version. Resolves true when a row was claimed, false when there was nothing to do. */
export async function buildNext({ signal }: { signal: AbortSignal }): Promise<boolean> {
  const storage = getStorage();
  if (!storage) return false;
  const claimed = await crossProject("video: claim version", () => repo().claimNext(new Date()));
  if (!claimed) return false;
  const { version, asset } = claimed;
  const { id, leaseToken: token } = version;
  const run = <T>(work: (r: VideoVersionProcessingRepo) => Promise<T>) => crossProject("video: build version", () => work(repo()));
  const recipe = version.recipe as VideoRecipe;
  const preview = version.kind === "preview";

  if (version.attempts > MAX_VERSION_ATTEMPTS) {
    await run((r) => r.finishFailed(id, token, `The video could not be adapted after ${MAX_VERSION_ATTEMPTS} attempts.`));
    return true;
  }
  /** A failure that may pass on a retry goes back to the queue until the budget is spent. */
  const fail = (reason: string, retryable: boolean) =>
    retryable && version.attempts < MAX_VERSION_ATTEMPTS ? run((r) => r.retryLater(id, token)) : run((r) => r.finishFailed(id, token, reason));

  const lost = new AbortController();
  const work = AbortSignal.any([signal, lost.signal]);
  const heartbeat = setInterval(() => {
    run((r) => r.renewLease(id, token, new Date()))
      .then((ok) => ok || lost.abort())
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const written: string[] = [];
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "docket-video-"));
    const srcPath = join(workDir, "source");
    const outPath = join(workDir, "out");
    const fetched = await storage.getToFile(asset.storageKey, srcPath, work);
    if (!fetched) {
      await run((r) => r.finishFailed(id, token, NO_ORIGINAL));
      return true;
    }

    let source: SourceFacts | undefined;
    if (recipe.mode === "rewrap") {
      const p = await probeFile(srcPath, work);
      if ("error" in p) {
        await fail(reasonFor("unreadable"), true);
        return true;
      }
      source = { durationMs: Math.round(p.durationSeconds * 1000), width: p.width, height: p.height, videoCodec: p.videoCodec, audioCodec: p.audioCodec };
    }

    let built: VideoRecipe;
    try {
      built = await buildFile(srcPath, outPath, recipe, { preview, signal: work });
    } catch (err) {
      if (!(err instanceof BuildError)) throw err;
      if (err.stderrTail) log(id, `ffmpeg ${err.code}: ${err.stderrTail}`);
      const tooLarge =
        recipe.video.maxBytes !== null ? `The video could not be made smaller than ${videoBytesLabel(recipe.video.maxBytes)}.` : undefined;
      await fail(reasonFor(err.code, tooLarge), err.code !== "too_large");
      return true;
    }

    const read = await readBack(outPath, built, { preview, ...(source ? { source } : {}) }, work);
    if (!read.ok) {
      log(id, `readback mismatch: ${read.mismatch}`);
      await fail(MISMATCH, true);
      return true;
    }

    const keys = mediaKeys(asset.projectId, asset.id);
    const key = preview ? keys.videoPreview(version.key) : keys.videoVersion(version.key);
    written.push(key);
    await storage.putFile(key, outPath, MIME[recipe.container], work);
    const f = read.facts;
    const ready = await run((r) =>
      r.finishReady(id, token, {
        storageKey: key,
        publicUrl: storage.publicUrl(key),
        container: recipe.container,
        width: f.width,
        height: f.height,
        durationMs: f.durationMs,
        frameRate: f.frameRate,
        videoCodec: f.videoCodec,
        audioCodec: f.audioCodec,
        videoBitrate: f.videoBitrate,
        byteSize: f.byteSize,
      }),
    );
    // The lease was lost, or the asset or row went away while this built: leave nothing behind (FR-023).
    if (!ready) await Promise.all(written.map((k) => quietly(storage, k)));
    return true;
  } catch (err) {
    if (signal.aborted) {
      await run((r) => r.release(id, token)).catch(() => undefined);
      await Promise.all(written.map((k) => quietly(storage, k)));
      return true;
    }
    if (lost.signal.aborted) {
      await Promise.all(written.map((k) => quietly(storage, k)));
      return true;
    }
    await Promise.all(written.map((k) => quietly(storage, k)));
    if (err instanceof ToolMissingError) {
      await run((r) => r.finishFailed(id, token, NO_TOOLS)).catch(() => undefined);
      return true;
    }
    log(id, err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
    await fail(reasonFor("unreadable"), true).catch(() => undefined);
    return true;
  } finally {
    clearInterval(heartbeat);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `concurrency` independent lanes, each claiming under `FOR UPDATE SKIP LOCKED`; idle lanes sleep. Ends when `signal` aborts. */
export async function runVideoVersionLoop({
  signal,
  concurrency,
  idleMs = 2000,
}: {
  signal: AbortSignal;
  concurrency: number;
  idleMs?: number;
}): Promise<void> {
  const lane = async () => {
    while (!signal.aborted) {
      let worked = false;
      try {
        await beat(concurrency);
        worked = await buildNext({ signal });
      } catch (err) {
        console.error(`Docket video: loop error: ${err instanceof Error ? err.message : "unknown"}`);
      }
      if (!worked) await abortableSleep(idleMs, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
}
