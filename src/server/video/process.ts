import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { byteLabel, durationLabel } from "@/components/media/upload/upload-ui";
import { sniffMedia } from "@/lib/media/sniff";
import { makeThumbnail } from "../media/process";
import { cleanFile, ToolFailure } from "./clean";
import { posterFile } from "./poster";
import { probeFile } from "./probe";
import { ToolMissingError } from "./spawn";

export interface VideoLimits {
  maxBytes: number;
  maxSeconds: number;
  maxSide: number;
}

export interface VideoProcessed {
  container: "mp4" | "mov";
  durationSeconds: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
  /** Displayed size, rotation applied. */
  width: number;
  height: number;
}

export type ProcessVideoResult =
  | { ok: true; facts: VideoProcessed; cleanPath: string; cleanBytes: number; thumbnail: { body: Buffer; width: number; height: number } }
  | { ok: false; reason: string; log?: string };

const NOT_MP4_OR_MOV = "This is not an MP4 or MOV video.";
const NO_VIDEO = "This file has no video.";
const UNREADABLE = "Docket could not read this video.";
export const COULD_NOT_PROCESS = "Docket could not process this video.";

const fail = (reason: string, log?: string): ProcessVideoResult => ({ ok: false, reason, ...(log ? { log } : {}) });

async function head(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buf, 0, 64, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Probes, checks, cleans and posters one video file. No database and no storage: the loop and `scripts/video-smoke.ts`
 * call it with a local path. A missing binary or a spawn error is a failed result with the cause in `log`.
 */
export async function processVideoFile(
  sourcePath: string,
  workDir: string,
  limits: VideoLimits,
  signal: AbortSignal,
): Promise<ProcessVideoResult> {
  try {
    const size = (await stat(sourcePath)).size;
    if (size > limits.maxBytes) {
      return fail(`Videos can be up to ${byteLabel(limits.maxBytes)}; this one is ${byteLabel(size)}.`);
    }
    const sniffed = sniffMedia(await head(sourcePath));
    if (sniffed?.kind !== "video" || !sniffed.container) return fail(NOT_MP4_OR_MOV);

    const probe = await probeFile(sourcePath, signal);
    if ("error" in probe) return fail(probe.error === "no_video" ? NO_VIDEO : UNREADABLE);
    if (!probe.formatNames.some((n) => n === "mp4" || n === "mov")) return fail(NOT_MP4_OR_MOV);
    if (probe.durationSeconds > limits.maxSeconds) {
      return fail(`Videos can be up to ${durationLabel(limits.maxSeconds)}; this one is ${durationLabel(Math.round(probe.durationSeconds))}.`);
    }
    const side = Math.max(probe.width, probe.height);
    if (side > limits.maxSide) return fail(`Videos can be up to ${limits.maxSide} px on a side; this one is ${side} px.`);

    const container = sniffed.container;
    const cleanPath = join(workDir, `clean.${container}`);
    await cleanFile(sourcePath, cleanPath, probe, container, signal);
    const posterPath = join(workDir, "poster.png");
    await posterFile(cleanPath, posterPath, probe.durationSeconds, signal);
    const thumbnail = await makeThumbnail(await readFile(posterPath));
    return {
      ok: true,
      facts: {
        container,
        durationSeconds: probe.durationSeconds,
        frameRate: probe.frameRate,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        width: probe.width,
        height: probe.height,
      },
      cleanPath,
      cleanBytes: (await stat(cleanPath)).size,
      thumbnail,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof ToolMissingError) return fail(COULD_NOT_PROCESS, err.message);
    if (err instanceof ToolFailure) return fail(COULD_NOT_PROCESS, `${err.message}: ${err.stderrTail}`.slice(0, 2048));
    const code = (err as NodeJS.ErrnoException).code;
    return fail(COULD_NOT_PROCESS, `${code ?? "error"}: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 2048));
  }
}
