import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaProcessingRepo as repo, type MediaProcessingRepo } from "../dal/media-processing";
import { crossProject } from "../dal/scope";
import { getEnv } from "../env";
import { abortableSleep } from "../scheduler/loop";
import { getStorage, mediaKeys } from "../storage";
import type { Storage } from "../storage";
import { VIDEO_MAX_SIDE } from "@/lib/media/types";
import { COULD_NOT_PROCESS, processVideoFile } from "./process";
import { rescanNext } from "./rescan";

export const MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 30_000;
const MIME = { mp4: "video/mp4", mov: "video/quicktime" } as const;

const log = (id: string, cause: string) => console.error(`Docket media: ${id}: ${cause}`.slice(0, 2300));
const quietly = (storage: Storage, key: string | null | undefined) =>
  key ? storage.delete(key).catch(() => log("storage", "could not delete an object")) : Promise.resolve();

/** Claims and processes one video. Resolves true when a row was claimed, false when the queue was empty. */
export async function processNext({ signal }: { signal: AbortSignal }): Promise<boolean> {
  const storage = getStorage();
  if (!storage) return false;
  const row = await crossProject("media: claim video", () => repo().claimNext(new Date()));
  if (!row) return false;
  const token = row.processingLeaseToken;
  const id = row.id;
  const run = <T>(work: (r: MediaProcessingRepo) => Promise<T>) => crossProject("media: process video", () => work(repo()));

  if (row.processingAttempts > MAX_ATTEMPTS) {
    await run((r) => r.finishFailed(id, token, `${COULD_NOT_PROCESS.slice(0, -1)} after ${MAX_ATTEMPTS} attempts.`));
    await quietly(storage, row.sourceStorageKey);
    return true;
  }

  const lost = new AbortController();
  const work = AbortSignal.any([signal, lost.signal]);
  const heartbeat = setInterval(() => {
    run((r) => r.renewLease(id, token, new Date()))
      .then((ok) => ok || lost.abort())
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const keys = mediaKeys(row.projectId, id);
  const written: string[] = [];
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "docket-media-"));
    const sourcePath = join(workDir, "source");
    const fetched = row.sourceStorageKey ? await storage.getToFile(row.sourceStorageKey, sourcePath, work) : null;
    if (!fetched) {
      log(id, "source object is missing");
      await run((r) => r.finishFailed(id, token, COULD_NOT_PROCESS));
      return true;
    }
    const env = getEnv().media;
    const result = await processVideoFile(
      sourcePath,
      workDir,
      { maxBytes: env.maxVideoBytes, maxSeconds: env.maxVideoSeconds, maxSide: VIDEO_MAX_SIDE },
      work,
    );
    if (!result.ok) {
      if (result.log) log(id, result.log);
      await run((r) => r.finishFailed(id, token, result.reason));
      await quietly(storage, row.sourceStorageKey);
      return true;
    }
    if (!(await run((r) => r.setStep(id, token, "poster")))) return true;
    const f = result.facts;
    const finalKey = row.storageKey;
    const mimeType = MIME[f.container];
    written.push(finalKey);
    const stored = await storage.putFile(finalKey, result.cleanPath, mimeType, work);
    written.push(keys.thumbnail);
    await storage.put(keys.thumbnail, result.thumbnail.body, "image/webp");
    const ready = await run((r) =>
      r.finishReady(id, token, {
        mimeType,
        container: f.container,
        width: f.width,
        height: f.height,
        byteSize: stored.bytes,
        durationMs: Math.round(f.durationSeconds * 1000),
        frameRate: f.frameRate,
        videoCodec: f.videoCodec,
        audioCodec: f.audioCodec,
        videoBitrate: f.videoBitrate,
        audioBitrate: f.audioBitrate,
        audioSampleRate: f.audioSampleRate,
        audioChannels: f.audioChannels,
        indexAtFront: f.indexAtFront,
        thumbnailStorageKey: keys.thumbnail,
        thumbnailUrl: storage.publicUrl(keys.thumbnail),
      }),
    );
    if (!ready) {
      // Deleted while processing, or the lease was lost: leave nothing behind.
      await Promise.all([...written, row.sourceStorageKey].map((k) => quietly(storage, k)));
      return true;
    }
    await quietly(storage, row.sourceStorageKey);
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
    log(id, err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
    await run((r) => r.finishFailed(id, token, COULD_NOT_PROCESS)).catch(() => undefined);
    await Promise.all([...written, row.sourceStorageKey].map((k) => quietly(storage, k)));
    return true;
  } finally {
    clearInterval(heartbeat);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The worker's media loop: claim, process, repeat; sleep when the queue is empty. Ends when `signal` aborts. */
export async function runMediaLoop({ signal, idleMs = 2000 }: { signal: AbortSignal; idleMs?: number }): Promise<void> {
  while (!signal.aborted) {
    let worked = false;
    try {
      worked = await processNext({ signal });
      // Idle: read the details of videos stored before the formatter (P9).
      if (!worked) worked = await rescanNext({ signal });
    } catch (err) {
      console.error(`Docket media: loop error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    if (!worked) await abortableSleep(idleMs, signal);
  }
}
