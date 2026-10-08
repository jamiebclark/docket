import type { VideoContainer } from "./types";

/** Server-side wording for video limits, shared by the validator and the requirements summary. */

export const VIDEO_CODEC_LABEL: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  vp9: "VP9",
  av1: "AV1",
  mpeg4: "MPEG-4",
};
export const AUDIO_CODEC_LABEL: Record<string, string> = {
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  ac3: "AC-3",
  vorbis: "Vorbis",
};
export const CONTAINER_LABEL: Record<VideoContainer, string> = { mp4: "MP4", mov: "MOV" };

export const videoCodecLabel = (c: string) => VIDEO_CODEC_LABEL[c] ?? c.toUpperCase();
export const audioCodecLabel = (c: string) => AUDIO_CODEC_LABEL[c] ?? c.toUpperCase();

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "1 second", "1 minute", "15 minutes", "1:15". */
export function durationLabel(seconds: number): string {
  if (seconds % 60 === 0 && seconds >= 60) return plural(seconds / 60, "minute");
  if (seconds < 60) return plural(Number(seconds.toFixed(1)), "second");
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Decimal megabytes with at most one decimal place. */
export const videoBytesLabel = (n: number) => `${Number((n / 1_000_000).toFixed(1))} MB`;

/** `a:b` for a small exact fraction (0.5625 → "9:16", 16/9 → "16:9"), `1:n` for a tiny one (0.01 → "1:100"), else `r:1`. */
export function ratioLabel(r: number): string {
  for (let b = 1; b <= 20; b++) {
    for (let a = 1; a <= 21; a++) {
      if (Math.abs(a / b - r) < 1e-9) return `${a}:${b}`;
    }
  }
  if (r > 0 && r < 1 / 20) {
    const n = Math.round(1 / r);
    if (n <= 1000 && Math.abs(1 / n - r) < 1e-9) return `1:${n}`;
  }
  return `${Number(r.toFixed(2))}:1`;
}

export const fpsLabel = (n: number) => `${Number(n.toFixed(2))} fps`;
