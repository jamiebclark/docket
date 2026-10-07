import { rename, rm } from "node:fs/promises";
import { ToolFailure } from "./clean";
import { runTool } from "./spawn";

export const POSTER_TIMEOUT_MS = 60_000;

/** One frame at `min(1, duration / 2)` seconds as a PNG. Writes `<dst>.tmp`, renames on success. */
export async function posterFile(src: string, dst: string, durationSeconds: number, signal: AbortSignal): Promise<void> {
  const t = Math.min(1, durationSeconds / 2).toFixed(3);
  const tmp = `${dst}.tmp.png`;
  await rm(tmp, { force: true });
  const r = await runTool(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", t, "-i", src, "-frames:v", "1", "-an", "-f", "image2", "-c:v", "png", tmp],
    { timeoutMs: POSTER_TIMEOUT_MS, signal },
  );
  if (r.killed || r.code !== 0) {
    await rm(tmp, { force: true });
    throw new ToolFailure("ffmpeg poster failed", r.stderrTail);
  }
  await rename(tmp, dst);
}
