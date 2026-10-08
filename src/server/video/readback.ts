import { stat } from "node:fs/promises";
import type { VideoRecipe } from "../../providers/video-plan";
import { indexAtFront } from "./boxes";
import { probeFile, type ProbeResult } from "./probe";

/** What the original is, for a rewrap: its streams must come out unchanged. */
export interface SourceFacts {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
}

/** The facts of a verified output, in the shape `video_versions` stores. */
export interface OutputFacts {
  width: number;
  height: number;
  durationMs: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string | null;
  videoBitrate: number;
  byteSize: number;
}

export type ReadBack = { ok: true; facts: OutputFacts } | { ok: false; mismatch: string };

const DURATION_TOLERANCE_MS = 100;
const FRAME_RATE_TOLERANCE = 0.5;

/**
 * D13, pure: does what ffprobe read from the output match the recipe? The recipe carries the target's limits
 * (bytes, bitrate, index position), so this is also the check against them. A preview skips the limits.
 * A mismatch names the cause for the log; it is never shown to a person.
 */
export function checkOutput(
  probe: ProbeResult,
  bytes: number,
  frontIndex: boolean | null,
  recipe: VideoRecipe,
  opts: { preview: boolean; source?: SourceFacts },
): ReadBack {
  const mismatch = (what: string): ReadBack => ({ ok: false, mismatch: what });
  const rewrap = recipe.mode === "rewrap";
  const src = opts.source;
  if (!rewrap && probe.videoCodec !== "h264") return mismatch(`video codec ${probe.videoCodec}`);
  if (rewrap && src && probe.videoCodec !== src.videoCodec) return mismatch(`video codec ${probe.videoCodec}, expected ${src.videoCodec}`);
  if (!rewrap && probe.audioCodec !== null && probe.audioCodec !== "aac") return mismatch(`audio codec ${probe.audioCodec}`);
  if (!rewrap && (recipe.audio === null) !== (probe.audioCodec === null)) return mismatch("audio presence");
  if (rewrap && src && probe.audioCodec !== src.audioCodec) return mismatch(`audio codec ${probe.audioCodec}, expected ${src.audioCodec}`);
  if (probe.width !== recipe.width || probe.height !== recipe.height) return mismatch(`size ${probe.width}x${probe.height}, expected ${recipe.width}x${recipe.height}`);
  const expectedMs = rewrap && src ? src.durationMs : recipe.keptMs;
  const durationMs = Math.round(probe.durationSeconds * 1000);
  if (Math.abs(durationMs - expectedMs) > DURATION_TOLERANCE_MS) return mismatch(`duration ${durationMs} ms, expected ${expectedMs} ms`);
  if (!rewrap && recipe.video.maxDurationMs != null && durationMs > recipe.video.maxDurationMs) {
    return mismatch(`duration ${durationMs} ms, limit ${recipe.video.maxDurationMs} ms`);
  }
  if (recipe.frameRate !== null && (probe.frameRate === null || Math.abs(probe.frameRate - recipe.frameRate) > FRAME_RATE_TOLERANCE)) {
    return mismatch(`frame rate ${probe.frameRate}, expected ${recipe.frameRate}`);
  }
  if (!opts.preview) {
    if (recipe.video.maxBytes !== null && bytes > recipe.video.maxBytes) return mismatch(`${bytes} bytes, limit ${recipe.video.maxBytes}`);
    const bitrate = probe.videoBitrate ?? probe.formatBitrate;
    if (recipe.video.maxBitrate !== null && bitrate !== null && bitrate > recipe.video.maxBitrate * 1.05) {
      return mismatch(`video bitrate ${bitrate}, limit ${recipe.video.maxBitrate}`);
    }
    if (recipe.indexAtFront && frontIndex !== true) return mismatch("index not at the front");
    if (!rewrap && recipe.audio) {
      if (probe.audioSampleRate !== null && probe.audioSampleRate > recipe.audio.sampleRate) return mismatch(`sample rate ${probe.audioSampleRate}`);
      if (probe.audioChannels !== null && probe.audioChannels > recipe.audio.channels) return mismatch(`${probe.audioChannels} channels`);
    }
  }
  const seconds = Math.max(0.001, durationMs / 1000);
  return {
    ok: true,
    facts: {
      width: probe.width,
      height: probe.height,
      durationMs,
      // ffprobe may report none for an odd stream; the average over the file stands in so the stored fact is never empty.
      frameRate: probe.frameRate ?? recipe.frameRate ?? 30,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      videoBitrate: probe.videoBitrate ?? probe.formatBitrate ?? Math.round((bytes * 8) / seconds),
      byteSize: bytes,
    },
  };
}

/** Probes the output file and checks it against the recipe. An unreadable output is a mismatch. */
export async function readBack(
  path: string,
  recipe: VideoRecipe,
  opts: { preview: boolean; source?: SourceFacts },
  signal: AbortSignal,
): Promise<ReadBack> {
  const probe = await probeFile(path, signal);
  if ("error" in probe) return { ok: false, mismatch: `output ${probe.error}` };
  const [{ size }, front] = await Promise.all([stat(path), indexAtFront(path)]);
  return checkOutput(probe, size, front, recipe, opts);
}
