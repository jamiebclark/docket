import type { VideoContainer } from "./types";
import type { VideoPlan } from "./video-plan";

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

/** Decimal megabytes with at most one decimal place; decimal gigabytes with at most two from 1 GB up. */
export const videoBytesLabel = (n: number) =>
  n >= 1_000_000_000 ? `${Number((n / 1e9).toFixed(2))} GB` : `${Number((n / 1_000_000).toFixed(1))} MB`;

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

/** "1:30", "15:00", "1:05:00": clock time for a position or length in milliseconds. */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The nearest small `a:b` to `r` (within half a percent), else `r:1`: 608÷1080 reads "9:16". */
export function nearRatioLabel(r: number): string {
  let best: [number, number] | null = null;
  for (let b = 1; b <= 20; b++) {
    for (let a = 1; a <= 21; a++) {
      if (Math.abs(a / b - r) <= 0.005 * r && (best === null || a + b < best[0] + best[1])) best = [a, b];
    }
  }
  return best ? `${best[0]}:${best[1]}` : ratioLabel(r);
}

/** Short badge words for what a derived plan does, in step order: "cut to 1:30", "padded to 9:16 with a blurred copy". */
export function videoStepWords(plan: Extract<VideoPlan, { kind: "derive" }>): string[] {
  const { recipe } = plan;
  return plan.steps.map((step) => {
    switch (step) {
      case "cut":
        return recipe.startMs > 0
          ? `cut to ${clockLabel(recipe.startMs)}–${clockLabel(recipe.startMs + recipe.keptMs)}`
          : `cut to ${clockLabel(recipe.keptMs)}`;
      case "crop":
        return `cropped to ${nearRatioLabel(recipe.width / recipe.height)}`;
      case "pad": {
        const fill = recipe.frame.kind === "pad" && recipe.frame.fill !== "blur" ? `${recipe.frame.fill} bars` : "a blurred copy";
        return `padded to ${nearRatioLabel(recipe.width / recipe.height)} with ${fill}`;
      }
      case "resize":
        return `resized to ${recipe.width}×${recipe.height}`;
      case "frame_rate":
        return `frame rate changed to ${fpsLabel(recipe.frameRate ?? 0)}`;
      case "reencode":
        return "re-encoded";
      case "rewrap":
        return "rewrapped";
    }
  });
}
