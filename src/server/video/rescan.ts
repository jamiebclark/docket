import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaProcessingRepo as repo, type MediaProcessingRepo } from "../dal/media-processing";
import { crossProject } from "../dal/scope";
import { getStorage } from "../storage";
import { indexAtFront } from "./boxes";
import { probeFile } from "./probe";
import { derivedVideoBitrate } from "./process";

const log = (id: string, cause: string) => console.error(`Docket media: rescan ${id}: ${cause}`.slice(0, 2300));

/**
 * Reads the details of one video stored before the formatter and records them (P9). It only reads: the stored bytes never
 * change. A missing object or an unreadable file gives the lease back; the attempt is already counted, and at 3 the planner
 * refuses. Resolves true when a row was claimed, false when there was none.
 */
export async function rescanNext({ signal }: { signal: AbortSignal }): Promise<boolean> {
  const storage = getStorage();
  if (!storage) return false;
  const row = await crossProject("media: claim rescan", () => repo().claimRescan(new Date()));
  if (!row) return false;
  const { id, processingLeaseToken: token } = row;
  const run = <T>(work: (r: MediaProcessingRepo) => Promise<T>) => crossProject("media: rescan video", () => work(repo()));
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "docket-rescan-"));
    const path = join(workDir, "original");
    const fetched = await storage.getToFile(row.storageKey, path, signal);
    if (!fetched) {
      log(id, "the stored video is missing");
      await run((r) => r.releaseRescan(id, token));
      return true;
    }
    const probe = await probeFile(path, signal);
    if ("error" in probe) {
      log(id, `unreadable (${probe.error})`);
      await run((r) => r.releaseRescan(id, token));
      return true;
    }
    const front = await indexAtFront(path);
    await run((r) =>
      r.finishRescan(id, token, {
        videoBitrate: probe.videoBitrate ?? derivedVideoBitrate(probe),
        audioBitrate: probe.audioBitrate,
        audioSampleRate: probe.audioSampleRate,
        audioChannels: probe.audioChannels,
        indexAtFront: front,
      }),
    );
    return true;
  } catch (err) {
    log(id, err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
    await run((r) => r.releaseRescan(id, token)).catch(() => undefined);
    return true;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
