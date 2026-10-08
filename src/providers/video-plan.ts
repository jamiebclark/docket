import type { VideoEdit } from "../lib/video/edit";
import type { ValidationIssue, VideoCapabilities, VideoContainer, VideoFacts } from "./types";
import { clockLabel, durationLabel, fpsLabel, ratioLabel, videoBytesLabel } from "./video-labels";

/** Bumped when the formatter's output changes; part of every recipe key, so versions rebuild. */
export const VIDEO_PIPELINE_VERSION = 1;

export type VideoStep = "cut" | "crop" | "pad" | "resize" | "frame_rate" | "reencode" | "rewrap";

export interface VideoSource {
  /** Displayed size (rotation applied). */
  width: number;
  height: number;
  bytes: number;
  facts: VideoFacts;
}

export type FrameOp =
  | { kind: "none" }
  | { kind: "crop"; x: number; y: number; w: number; h: number }
  | { kind: "pad"; canvasW: number; canvasH: number; frameW: number; frameH: number; x: number; y: number; fill: "blur" | `#${string}` };

/** A fully numeric description of one output; the worker builds only from this. */
export interface VideoRecipe {
  mode: "rewrap" | "encode";
  container: VideoContainer;
  /** Encode only; a rewrap keeps the whole file (startMs 0, keptMs = duration). */
  startMs: number;
  keptMs: number;
  frame: FrameOp;
  /** Output size; even when encoding. */
  width: number;
  height: number;
  /** null = unchanged. */
  frameRate: number | null;
  video: { maxBitrate: number | null; maxBytes: number | null; minWidth: number; minHeight: number; maxDurationMs?: number | null };
  /** null = silent (or, for a rewrap, copied untouched). */
  audio: { sampleRate: number; channels: number; bitrate: number } | null;
  indexAtFront: boolean;
}

/** What the provider's validation sees for a derived video. */
export interface PlannedVideo {
  container: VideoContainer;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number | null;
  maxBytes: number | null;
}

export type VideoPlan =
  | { kind: "original" }
  | { kind: "derive"; mode: "rewrap" | "encode"; steps: VideoStep[]; recipe: VideoRecipe; output: PlannedVideo; notes: ValidationIssue[] }
  | { kind: "refuse"; issues: ValidationIssue[] }
  | { kind: "checking"; notes: ValidationIssue[] };

export interface VideoPlanContext {
  index: number;
  platform: string;
  /** The target as a noun phrase, article included: "a Facebook Reel". Default: the platform. */
  typeLabel?: string;
}

const EPS = 1e-9;
/** Under this a reframe is only rounding (1080×1920 is not "reframed" to 0.5625). */
const SHAPE_TOLERANCE = 0.005;
/** Below this video bitrate a size-limited encode cannot work (P8). */
const MIN_BUDGET_BPS = 150_000;
/** An encode ends this far under the target's maximum: the last frame runs past `-t`, and the limit is strict (G15). */
const DURATION_MARGIN_MS = 100;
const DEFAULT_AUDIO_BITRATE = 128_000;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CHANNELS = 2;
const CANVAS_FLOOR = 1920;

const floorEven = (n: number) => Math.max(2, Math.floor(n / 2 + EPS) * 2);
const nearEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const floorEven0 = (n: number) => Math.max(0, Math.floor(n / 2 + EPS) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Decide whether a video goes as is, is rewrapped, is re-encoded to fit one target's limits, or must be refused.
 * Pure and total. Non-video limits (counts, mixing, silence) stay in the validator.
 */
export function planVideo(src: VideoSource, limits: VideoCapabilities, edit: VideoEdit, ctx: VideoPlanContext): VideoPlan {
  const label = `Video ${ctx.index + 1}`;
  const target = ctx.typeLabel ?? ctx.platform;
  const field = `media.${ctx.index}` as const;
  const f = src.facts;
  const info = (code: ValidationIssue["code"], message: string): ValidationIssue => ({ severity: "info", code, message, field });
  const refusals: ValidationIssue[] = [];
  const refuse = (code: ValidationIssue["code"], message: string) => refusals.push({ severity: "error", code, message, field });

  // 1. Facts
  if (f.factsVersion === 1) return { kind: "checking", notes: [info("video_checking", `Docket is still reading ${label}'s details.`)] };
  if (f.factsUnreadable) {
    return {
      kind: "refuse",
      issues: [{ severity: "error", code: "video_facts_unreadable", message: `Docket could not read ${label}'s details; upload it again.`, field }],
    };
  }

  // 2. Trim (P4)
  const durationMs = Math.max(0, Math.round(f.durationSeconds * 1000));
  let start = edit.trimStartMs;
  let end = edit.trimEndMs ?? durationMs;
  if (end >= durationMs - 50) end = durationMs;
  if (start < 0 || start >= end) {
    start = 0;
    end = durationMs;
  }
  const trimmed = start > 0 || end < durationMs;
  const selectionMs = end - start;
  const maxMs = limits.maxDurationSeconds !== undefined ? Math.round(limits.maxDurationSeconds * 1000) : Number.POSITIVE_INFINITY;
  const cutByMax = selectionMs > maxMs;
  const limitMs = maxMs - DURATION_MARGIN_MS;
  const keptMs = cutByMax || (trimmed && selectionMs > limitMs) ? limitMs : selectionMs;
  if (limits.minDurationSeconds !== undefined && keptMs < limits.minDurationSeconds * 1000 - EPS) {
    refuse(
      "video_too_short",
      `${trimmed ? `Your selection of ${label}` : label} is ${durationLabel(keptMs / 1000)} long; ${target} needs at least ${durationLabel(limits.minDurationSeconds)}.`,
    );
  }

  // 3–4. Shape and geometry (P3)
  const W = src.width;
  const H = src.height;
  const a = W / H;
  const minA = limits.minAspectRatio;
  const maxA = limits.maxAspectRatio;
  const rec = limits.recommendedAspectRatio;
  const outOfRange = (minA !== undefined && a < minA - EPS) || (maxA !== undefined && a > maxA + EPS);
  let t: number | null = null;
  if (outOfRange || (edit.recommendedShape && rec !== undefined)) {
    t = rec !== undefined ? rec : clamp(a, minA ?? 0, maxA ?? Number.POSITIVE_INFINITY);
    if (!outOfRange && Math.abs(t - a) <= SHAPE_TOLERANCE * a) t = null;
  }
  const limW = limits.maxWidth ?? Number.POSITIVE_INFINITY;
  const limH = limits.maxHeight ?? Number.POSITIVE_INFINITY;

  let frame: FrameOp = { kind: "none" };
  let outW: number;
  let outH: number;
  let resized = false;
  if (t !== null && edit.fit === "crop") {
    let cw: number;
    let ch: number;
    if (t < a) {
      cw = Math.min(floorEven(W), nearEven(Math.round(H * t)));
      ch = floorEven(H);
    } else {
      cw = floorEven(W);
      ch = Math.min(floorEven(H), nearEven(Math.round(W / t)));
    }
    const x = floorEven0(clamp(Math.round(edit.focalX * W - cw / 2), 0, W - cw));
    const y = floorEven0(clamp(Math.round(edit.focalY * H - ch / 2), 0, H - ch));
    frame = { kind: "crop", x, y, w: cw, h: ch };
    const k = Math.min(1, limW / cw, limH / ch);
    resized = k < 1 - EPS;
    outW = resized ? floorEven(cw * k) : cw;
    outH = resized ? floorEven(ch * k) : ch;
  } else if (t !== null) {
    const letterbox = t < a;
    const canvasW = letterbox ? W : Math.round(H * t);
    const canvasH = letterbox ? Math.round(W / t) : H;
    const ceiling = Math.max(Math.max(W, H), CANVAS_FLOOR) / Math.max(canvasW, canvasH);
    const limit = Math.min(1, limW / canvasW, limH / canvasH);
    const k = Math.min(1, ceiling, limit);
    resized = limit < Math.min(1, ceiling) - EPS;
    outW = floorEven(canvasW * k);
    outH = floorEven(canvasH * k);
    // Flooring to even can leave the canvas a hair outside the range it was built for (562×1000 for 9:16): step one pair back in.
    if (minA !== undefined && outW / outH < minA - EPS && (outW + 2) / outH <= (maxA ?? Number.POSITIVE_INFINITY) + EPS) outW += 2;
    else if (maxA !== undefined && outW / outH > maxA + EPS && outW / (outH + 2) >= (minA ?? 0) - EPS) outH += 2;
    const frameW = floorEven(W * k);
    const frameH = floorEven(H * k);
    frame = {
      kind: "pad",
      canvasW: outW,
      canvasH: outH,
      frameW,
      frameH,
      x: floorEven0((outW - frameW) / 2),
      y: floorEven0((outH - frameH) / 2),
      fill: edit.fit === "pad_color" ? (edit.padColor as `#${string}`) : "blur",
    };
  } else {
    const k = Math.min(1, limW / W, limH / H);
    resized = k < 1 - EPS;
    outW = resized ? floorEven(W * k) : W;
    outH = resized ? floorEven(H * k) : H;
  }

  const belowW = limits.minWidth !== undefined && outW < limits.minWidth;
  const belowH = limits.minHeight !== undefined && outH < limits.minHeight;
  if (belowW || belowH) {
    const need =
      limits.minWidth !== undefined && limits.minHeight !== undefined
        ? `${limits.minWidth}×${limits.minHeight}`
        : limits.minWidth !== undefined
          ? `${limits.minWidth} px wide`
          : `${limits.minHeight} px tall`;
    const was = t === null && !resized ? `${label} is ${W}×${H}` : `${label} would be ${outW}×${outH}`;
    refuse("video_too_small", `${was}; ${target} needs at least ${need}.`);
  }

  // 5. Mode (P5)
  const reframed = frame.kind !== "none";
  const videoOk = !limits.videoCodecs || limits.videoCodecs.includes(f.videoCodec);
  const hasAudio = f.audioCodec !== null;
  const audioOk = !hasAudio || !limits.audioCodecs || limits.audioCodecs.includes(f.audioCodec!);
  let frameRate: number | null = null;
  if (f.frameRate !== null) {
    if (limits.maxFrameRate !== undefined && f.frameRate > limits.maxFrameRate + EPS) frameRate = limits.maxFrameRate;
    else if (limits.minFrameRate !== undefined && f.frameRate < limits.minFrameRate - EPS) frameRate = limits.minFrameRate;
  }
  let videoBitrate = f.videoBitrate ?? null;
  if (videoBitrate === null && limits.maxVideoBitrate !== undefined && f.durationSeconds > 0) {
    // An upper bound (it includes audio and container overhead), so it never assumes a fit.
    videoBitrate = (src.bytes * 8) / f.durationSeconds - (f.audioBitrate ?? 0);
  }
  const tooFast = limits.maxVideoBitrate !== undefined && videoBitrate !== null && videoBitrate > limits.maxVideoBitrate;
  const sampleHigh = limits.maxAudioSampleRate !== undefined && f.audioSampleRate != null && f.audioSampleRate > limits.maxAudioSampleRate;
  const channelsHigh = limits.maxAudioChannels !== undefined && f.audioChannels != null && f.audioChannels > limits.maxAudioChannels;
  const tooBig = limits.maxBytes !== undefined && src.bytes > limits.maxBytes;
  const cut = trimmed || cutByMax;
  const encode = cut || reframed || resized || !videoOk || !audioOk || frameRate !== null || tooFast || sampleHigh || channelsHigh || tooBig;

  const containerOk = !limits.containers || limits.containers.includes(f.container);
  const needsIndex = limits.indexAtFront === true && f.indexAtFront !== true;
  const rewrap = !encode && (!containerOk || needsIndex);
  if (!encode && !rewrap) {
    return refusals.length > 0 ? { kind: "refuse", issues: refusals } : { kind: "original" };
  }

  let container: VideoContainer = f.container;
  if (encode || !containerOk) {
    container = !encode && containerOk ? f.container : "mp4";
    if (limits.containers && !limits.containers.includes(container)) {
      refuse("video_container_not_allowed", `${label} cannot be converted to a container ${target} accepts.`);
    }
  }
  if (encode && limits.videoCodecs && !limits.videoCodecs.includes("h264")) {
    refuse("video_codec_not_allowed", `${label} cannot be converted to a video codec ${target} accepts.`);
  }
  if (encode && hasAudio && limits.audioCodecs && !limits.audioCodecs.includes("aac")) {
    refuse("video_codec_not_allowed", `${label} cannot be converted to an audio codec ${target} accepts.`);
  }

  // 6. Recipe, and the size floor (P8)
  const audio =
    encode && hasAudio
      ? {
          sampleRate: Math.min(f.audioSampleRate ?? Number.POSITIVE_INFINITY, limits.maxAudioSampleRate ?? DEFAULT_SAMPLE_RATE),
          channels: Math.min(f.audioChannels ?? Number.POSITIVE_INFINITY, limits.maxAudioChannels ?? DEFAULT_CHANNELS),
          bitrate: limits.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
        }
      : null;
  let maxBitrate = limits.maxVideoBitrate ?? null;
  if (encode && limits.maxBytes !== undefined) {
    const budget = Math.floor((limits.maxBytes * 8 * 0.95) / (keptMs / 1000)) - (audio?.bitrate ?? 0);
    if (budget < MIN_BUDGET_BPS) {
      refuse("video_too_large", `${label} could not be made smaller than ${videoBytesLabel(limits.maxBytes)} for ${target}.`);
    }
    maxBitrate = maxBitrate === null ? budget : Math.min(maxBitrate, budget);
  }
  if (refusals.length > 0) return { kind: "refuse", issues: refusals };

  const recipe: VideoRecipe = encode
    ? {
        mode: "encode",
        container: "mp4",
        startMs: start,
        keptMs,
        frame,
        width: reframed || resized ? outW : floorEven(outW),
        height: reframed || resized ? outH : floorEven(outH),
        frameRate,
        video: {
          maxBitrate,
          maxBytes: limits.maxBytes ?? null,
          minWidth: limits.minWidth ?? 2,
          minHeight: limits.minHeight ?? 2,
          maxDurationMs: Number.isFinite(maxMs) ? maxMs : null,
        },
        audio,
        indexAtFront: true,
      }
    : {
        mode: "rewrap",
        container,
        startMs: 0,
        keptMs: durationMs,
        frame: { kind: "none" },
        width: W,
        height: H,
        frameRate: null,
        video: { maxBitrate: null, maxBytes: null, minWidth: limits.minWidth ?? 2, minHeight: limits.minHeight ?? 2 },
        audio: null,
        indexAtFront: true,
      };

  // 7. Steps and notes
  const steps: VideoStep[] = [];
  const notes: ValidationIssue[] = [];
  const say = (step: VideoStep, code: ValidationIssue["code"], message: string) => {
    steps.push(step);
    notes.push(info(code, message));
  };
  if (encode) {
    if (cut) {
      if (!cutByMax) {
        say("cut", "video_will_cut", `${label} will be trimmed to ${clockLabel(start)}–${clockLabel(end)} for ${target}.`);
      } else {
        const of = trimmed ? " of your selection" : "";
        say("cut", "video_will_cut", `${label} will be cut to the first ${clockLabel(maxMs)}${of} for ${target}.`);
      }
    }
    if (frame.kind === "crop") {
      say("crop", "video_will_crop", `${label} will be cropped to ${ratioLabel(t!)} for ${target}.`);
    } else if (frame.kind === "pad") {
      const how = frame.fill === "blur" ? "with a blurred copy" : `with ${frame.fill} bars`;
      say("pad", "video_will_pad", `${label} will be padded to ${ratioLabel(t!)} ${how} for ${target}.`);
    }
    if (resized) say("resize", "video_will_resize", `${label} will be resized to ${outW}×${outH} for ${target}.`);
    if (frameRate !== null) {
      say("frame_rate", "video_will_change_frame_rate", `${label}'s frame rate will be changed to ${fpsLabel(frameRate)} for ${target}.`);
    }
    if (steps.length === 0) say("reencode", "video_will_reencode", `${label} will be re-encoded as H.264 and AAC for ${target}.`);
  } else {
    say("rewrap", "video_will_rewrap", `${label} will be rewrapped as ${container === "mp4" ? "MP4" : "MOV"} for ${target}, without re-encoding.`);
  }

  const output: PlannedVideo = encode
    ? {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: audio ? "aac" : null,
        width: recipe.width,
        height: recipe.height,
        durationSeconds: keptMs / 1000,
        frameRate: frameRate ?? f.frameRate,
        maxBytes: limits.maxBytes ?? null,
      }
    : {
        container,
        videoCodec: f.videoCodec,
        audioCodec: f.audioCodec,
        width: W,
        height: H,
        durationSeconds: f.durationSeconds,
        frameRate: f.frameRate,
        maxBytes: null,
      };
  return { kind: "derive", mode: recipe.mode, steps, recipe, output, notes };
}

const PREVIEW_LONG_SIDE = 640;
const PREVIEW_FPS = 30;

/** The cheap look-alike the composer shows: ≤ 640 px on the long side, ≤ 30 fps, no byte fitting. */
export function previewRecipe(full: VideoRecipe, sourceFrameRate: number | null = null): VideoRecipe {
  const k = Math.min(1, PREVIEW_LONG_SIDE / Math.max(full.width, full.height));
  const sized = (n: number) => (k < 1 ? floorEven(n * k) : n);
  const frame: FrameOp =
    full.frame.kind === "pad"
      ? (() => {
          const p = full.frame;
          if (k >= 1) return p;
          const canvasW = sized(p.canvasW);
          const canvasH = sized(p.canvasH);
          const frameW = sized(p.frameW);
          const frameH = sized(p.frameH);
          return { ...p, canvasW, canvasH, frameW, frameH, x: floorEven0((canvasW - frameW) / 2), y: floorEven0((canvasH - frameH) / 2) };
        })()
      : full.frame;
  const rate = full.frameRate ?? sourceFrameRate;
  return {
    ...full,
    mode: "encode",
    container: "mp4",
    frame,
    width: sized(full.width),
    height: sized(full.height),
    frameRate: rate !== null && rate > PREVIEW_FPS ? PREVIEW_FPS : full.frameRate,
    video: { ...full.video, maxBitrate: null, maxBytes: null },
    audio: full.audio ?? (full.mode === "rewrap" ? { sampleRate: DEFAULT_SAMPLE_RATE, channels: DEFAULT_CHANNELS, bitrate: DEFAULT_AUDIO_BITRATE } : null),
    indexAtFront: true,
  };
}
