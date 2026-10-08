import { MIME_LABEL } from "@/lib/media/types";
import { countingRuleName, countingUnit } from "./text";
import { choiceFor, postTypeLabel, resolvePostType } from "./post-type";
import type { PostType, ProviderCapabilities } from "./types";
import { videoLimitsFor } from "./validation";
import {
  CONTAINER_LABEL,
  audioCodecLabel,
  durationLabel,
  fpsLabel,
  ratioLabel,
  videoBytesLabel,
  videoCodecLabel,
} from "./video-labels";

export interface Labelled<T> {
  value: T;
  label: string;
}

export interface Range {
  min: Labelled<number> | null;
  max: Labelled<number> | null;
}

/** What one account accepts, read from its capabilities. Pure and JSON-safe: it travels in the check response. `null` = no limit Docket checks. */
export interface RequirementsSummary {
  text: {
    maxLength: number;
    countingRule: string;
    unit: string;
    maxHashtags: number | null;
    maxMentions: number | null;
  };
  image: {
    /** 0 = images not accepted. */
    maxImages: number;
    formats: Labelled<string>[];
    convertedTo: Labelled<string> | null;
    /** Upload types the provider does not take as they are, which the planner converts. */
    convertedFrom: Labelled<string>[];
    maxBytesPerFile: Labelled<number>;
    width: Range;
    height: Range;
    aspectRatio: Range;
    maxAltTextLength: number | null;
  };
  video: {
    /** 0 = video not accepted yet. */
    maxVideos: number;
    withImages: boolean;
    /** `[]` = no limit Docket checks. */
    containers: Labelled<string>[];
    videoCodecs: Labelled<string>[];
    audioCodecs: Labelled<string>[];
    silentAllowed: boolean;
    maxBytes: Labelled<number> | null;
    /** Seconds. */
    duration: Range;
    width: Range;
    height: Range;
    aspectRatio: Range;
    minFrameRate: Labelled<number> | null;
    maxFrameRate: Labelled<number> | null;
    /** The type these limits are for; null when the provider declares no choice and no per-type limits. */
    postType: { value: PostType; label: string; description: string | null } | null;
    notes: string[];
  };
  /** Null when the provider has no carousel post type or does not accept video. */
  carousel: {
    maxItems: number;
    /** Images and videos may share one carousel. */
    mixed: boolean;
    videoAspectRatio: Range;
    notes: string[];
  } | null;
  post: {
    mediaRequired: boolean;
    textOnlyAllowed: boolean;
    postTypes: PostType[];
  };
}

export function mimeLabel(type: string): string {
  return MIME_LABEL[type] ?? type;
}

/** `a:b` for ratios below 1 when a small fraction matches (0.8 → "4:5"), else `r:1` (1.91 → "1.91:1"). */
export function aspectLabel(r: number): string {
  if (r < 1) {
    for (let b = 1; b <= 20; b++) {
      const a = Math.round(r * b);
      if (a >= 1 && Math.abs(a / b - r) < 1e-9) return `${a}:${b}`;
    }
  }
  return `${Number(r.toFixed(2))}:1`;
}

/** Decimal megabytes with at most one decimal place. */
export function bytesLabel(n: number): string {
  return `${Number((n / 1_000_000).toFixed(1))} MB`;
}

const labelled = (type: string): Labelled<string> => ({ value: type, label: mimeLabel(type) });

function range(min: number | undefined, max: number | undefined, label: (n: number) => string): Range {
  const one = (n: number | undefined) => (n === undefined ? null : { value: n, label: label(n) });
  return { min: one(min), max: one(max) };
}

const px = (n: number) => `${n} px`;

/** The video part's type: the chosen one when it is a carousel or an option of a choice, else what a single video would get. */
function shownTypeOf(caps: ProviderCapabilities, postType: PostType | undefined): PostType {
  const options = choiceFor(caps, [{ kind: "video" }])?.options ?? [];
  if (postType === "carousel" || (postType !== undefined && options.some((o) => o.type === postType))) return postType!;
  return resolvePostType(caps, [{ kind: "video" }], null);
}

export function requirementsOf(
  caps: ProviderCapabilities,
  ctx: { uploadTypes: readonly string[]; postType?: PostType },
): RequirementsSummary {
  const m = caps.media;
  const shown = shownTypeOf(caps, ctx.postType);
  const v = videoLimitsFor(caps, shown);
  const hasChoice = (caps.postTypeChoices?.length ?? 0) > 0 || Object.keys(caps.video.byPostType ?? {}).length > 0;
  const option = caps.postTypeChoices?.flatMap((c) => c.options).find((o) => o.type === shown);
  // Only a provider that declares carousel video limits has a carousel part.
  const carouselLimits = caps.postTypes.includes("carousel") && caps.video.byPostType?.carousel ? videoLimitsFor(caps, "carousel") : null;
  const carouselNotes = [...(caps.video.byPostType?.carousel?.notes ?? [])];
  const accepts = m.maxImages > 0;
  const output = m.outputMimeType ?? m.allowedMimeTypes[0];
  return {
    text: {
      maxLength: caps.text.maxLength,
      countingRule: countingRuleName(caps.text.countingRule),
      unit: countingUnit(caps.text.countingRule),
      maxHashtags: caps.text.maxHashtags ?? null,
      maxMentions: caps.text.maxMentions ?? null,
    },
    image: {
      maxImages: m.maxImages,
      formats: m.allowedMimeTypes.map(labelled),
      convertedTo: accepts && output ? labelled(output) : null,
      convertedFrom: accepts ? ctx.uploadTypes.filter((t) => !m.allowedMimeTypes.includes(t)).map(labelled) : [],
      maxBytesPerFile: { value: m.maxBytesPerFile, label: bytesLabel(m.maxBytesPerFile) },
      width: range(m.minWidth, m.maxWidth, px),
      height: range(m.minHeight, m.maxHeight, px),
      aspectRatio: range(m.minAspectRatio, m.maxAspectRatio, aspectLabel),
      maxAltTextLength: m.maxAltTextLength ?? null,
    },
    video: {
      maxVideos: v.maxVideos,
      withImages: v.withImages ?? false,
      containers: (v.containers ?? []).map((c) => ({ value: c, label: CONTAINER_LABEL[c] })),
      videoCodecs: (v.videoCodecs ?? []).map((c) => ({ value: c, label: videoCodecLabel(c) })),
      audioCodecs: (v.audioCodecs ?? []).map((c) => ({ value: c, label: audioCodecLabel(c) })),
      silentAllowed: v.silentAllowed ?? true,
      maxBytes: v.maxBytes === undefined ? null : { value: v.maxBytes, label: videoBytesLabel(v.maxBytes) },
      duration: range(v.minDurationSeconds, v.maxDurationSeconds, durationLabel),
      width: range(v.minWidth, v.maxWidth, px),
      height: range(v.minHeight, v.maxHeight, px),
      aspectRatio: range(v.minAspectRatio, v.maxAspectRatio, ratioLabel),
      minFrameRate: v.minFrameRate === undefined ? null : { value: v.minFrameRate, label: fpsLabel(v.minFrameRate) },
      maxFrameRate: v.maxFrameRate === undefined ? null : { value: v.maxFrameRate, label: fpsLabel(v.maxFrameRate) },
      postType: !hasChoice
        ? null
        : shown === "carousel"
          ? { value: shown, label: postTypeLabel(caps, shown), description: null }
          : { value: shown, label: option?.label ?? postTypeLabel(caps, shown), description: option?.description ?? null },
      notes: shown === "carousel" ? carouselNotes : [],
    },
    carousel:
      carouselLimits && carouselLimits.maxVideos > 0
        ? {
            maxItems: Math.max(m.maxImages, carouselLimits.maxVideos),
            mixed: carouselLimits.withImages ?? false,
            videoAspectRatio: range(carouselLimits.minAspectRatio, carouselLimits.maxAspectRatio, ratioLabel),
            notes: carouselNotes,
          }
        : null,
    post: {
      mediaRequired: m.required || !caps.textOnlyAllowed,
      textOnlyAllowed: caps.textOnlyAllowed,
      postTypes: [...caps.postTypes],
    },
  };
}
