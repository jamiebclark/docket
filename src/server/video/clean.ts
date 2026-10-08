import { rename, rm, stat } from "node:fs/promises";
import { probeFile, type ProbeResult } from "./probe";
import { runTool } from "./spawn";

export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly stderrTail = "",
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}

/** min(10 min, 60 s + 1 s per 20 MB). */
export function cleanTimeoutMs(bytes: number): number {
  return Math.min(600_000, 60_000 + Math.ceil(bytes / 20_000_000) * 1000);
}

const HAS_LOCATION = /\blocation(-\w+)?\b|com\.apple\.quicktime\.location/i;

function leaksMetadata(p: ProbeResult): boolean {
  return [p.formatTags, ...p.streamTags].some((tags) => Object.keys(tags).some((k) => HAS_LOCATION.test(k)));
}

async function remux(src: string, dst: string, container: "mp4" | "mov", rotation: ProbeResult["rotation"], mode: "display" | "tag" | "none", signal: AbortSignal) {
  const bytes = (await stat(src)).size;
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    ...(mode === "display" ? ["-display_rotation:v:0", String(rotation)] : []),
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1",
    ...(mode === "tag" ? ["-metadata:s:v:0", `rotate=${(360 - rotation) % 360}`] : []),
    // The index goes first, so any stored original can go to a platform that wants it there (D18).
    "-movflags", "+faststart",
    "-f", container, dst,
  ];
  const r = await runTool("ffmpeg", args, { timeoutMs: cleanTimeoutMs(bytes), signal });
  return r;
}

/**
 * Remuxes without metadata (location, device, chapters), keeps the first video and audio stream, re-applies a
 * rotation and verifies the result with ffprobe (P10). Writes `<dst>.tmp`, renames on success.
 */
export async function cleanFile(
  src: string,
  dst: string,
  probe: ProbeResult,
  container: "mp4" | "mov",
  signal: AbortSignal,
): Promise<void> {
  const tmp = `${dst}.tmp`;
  const modes: ("none" | "display" | "tag")[] = probe.rotation === 0 ? ["none"] : ["display", "tag"];
  let lastTail = "";
  for (const mode of modes) {
    await rm(tmp, { force: true });
    const r = await remux(src, tmp, container, probe.rotation, mode, signal);
    lastTail = r.stderrTail;
    if (r.killed) throw new ToolFailure("ffmpeg clean timed out or was aborted", r.stderrTail);
    if (r.code !== 0) continue;
    const check = await probeFile(tmp, signal);
    if ("error" in check) continue;
    const sameSize = check.width === probe.width && check.height === probe.height;
    if (!sameSize || leaksMetadata(check) || Math.abs(check.durationSeconds - probe.durationSeconds) > 1) continue;
    await rename(tmp, dst);
    return;
  }
  await rm(tmp, { force: true });
  throw new ToolFailure("ffmpeg clean failed verification", lastTail);
}
