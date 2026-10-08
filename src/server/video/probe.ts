import { runTool } from "./spawn";

export interface ProbeResult {
  durationSeconds: number;
  codedWidth: number;
  codedHeight: number;
  /** Counter-clockwise degrees as ffprobe reports them, normalised to 0..270. */
  rotation: 0 | 90 | 180 | 270;
  /** Displayed size, rotation applied. */
  width: number;
  height: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
  /** Bits per second; null when ffprobe does not report one. */
  videoBitrate: number | null;
  /** The container's overall bit rate. */
  formatBitrate: number | null;
  audioBitrate: number | null;
  /** Hz; null with no audio. */
  audioSampleRate: number | null;
  audioChannels: number | null;
  formatNames: string[];
  formatTags: Record<string, string>;
  streamTags: Record<string, string>[];
}

export type ProbeError = { error: "unreadable" | "no_video" };

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  bit_rate?: string | number;
  sample_rate?: string | number;
  channels?: number;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string | number;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}
interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string | number; bit_rate?: string | number; tags?: Record<string, string> };
}

function parseRate(value: string | undefined): number | null {
  if (!value) return null;
  const [n, d] = value.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n)) return null;
  const rate = d === undefined ? n : d && Number.isFinite(d) ? n / d : NaN;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

/** ffprobe prints numbers as strings and "N/A" for unknown; anything not a positive whole number is null. */
function positiveInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim() === "" ? NaN : value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normaliseRotation(degrees: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

function rotationOf(stream: RawStream): 0 | 90 | 180 | 270 {
  const side = stream.side_data_list?.find((d) => typeof d.rotation === "number");
  if (side?.rotation !== undefined) return normaliseRotation(side.rotation);
  const tag = Number(stream.tags?.rotate);
  // The legacy `rotate` tag is clockwise; ffprobe's `rotation` is counter-clockwise.
  return Number.isFinite(tag) ? normaliseRotation(-tag) : 0;
}

/** Pure: turns `ffprobe -of json -show_streams -show_format` output into the facts Docket keeps. */
export function parseProbe(json: unknown): ProbeResult | ProbeError {
  if (!json || typeof json !== "object") return { error: "unreadable" };
  const raw = json as RawProbe;
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) return { error: "no_video" };
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(raw.format?.duration ?? video.duration);
  const codedWidth = video.width ?? 0;
  const codedHeight = video.height ?? 0;
  if (!Number.isFinite(duration) || duration <= 0 || !video.codec_name || codedWidth < 1 || codedHeight < 1) {
    return { error: "unreadable" };
  }
  const rotation = rotationOf(video);
  const swap = rotation === 90 || rotation === 270;
  return {
    durationSeconds: duration,
    codedWidth,
    codedHeight,
    rotation,
    width: swap ? codedHeight : codedWidth,
    height: swap ? codedWidth : codedHeight,
    frameRate: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    videoBitrate: positiveInt(video.bit_rate),
    formatBitrate: positiveInt(raw.format?.bit_rate),
    audioBitrate: audio ? positiveInt(audio.bit_rate) : null,
    audioSampleRate: audio ? positiveInt(audio.sample_rate) : null,
    audioChannels: audio ? positiveInt(audio.channels) : null,
    formatNames: (raw.format?.format_name ?? "").split(",").filter(Boolean),
    formatTags: raw.format?.tags ?? {},
    streamTags: streams.map((s) => s.tags ?? {}),
  };
}

export const PROBE_TIMEOUT_MS = 60_000;

/** Runs ffprobe on a file. A failure to run is `unreadable`; a missing binary throws. */
export async function probeFile(path: string, signal: AbortSignal): Promise<ProbeResult | ProbeError> {
  const r = await runTool("ffprobe", ["-v", "error", "-of", "json", "-show_streams", "-show_format", path], {
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
    maxStdout: 4 * 1_048_576,
  });
  if (r.killed) throw new Error("ffprobe timed out or was aborted");
  if (r.code !== 0) return { error: "unreadable" };
  try {
    return parseProbe(JSON.parse(r.stdout));
  } catch {
    return { error: "unreadable" };
  }
}
