import { MIME_LABEL } from "@/lib/media/types";
import type { ProviderCapabilities, ValidationIssue, VideoCapabilities } from "./types";

/** Bump when the variant generator's output changes, so cached variants are rebuilt. */
export const VARIANT_PIPELINE_VERSION = 1;

const OUTPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface MediaConstraints {
  acceptedMimeTypes: readonly string[];
  outputMimeType: string;
  maxBytes: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** width ÷ height, inclusive. */
  minAspectRatio?: number;
  maxAspectRatio?: number;
  maxAltTextLength?: number;
}

export type ImageStep = "convert" | "downscale" | "compress";

export type ImagePlan =
  | { kind: "original" }
  | {
      kind: "derive";
      steps: ImageStep[];
      output: { mimeType: string; width: number; height: number; maxBytes: number };
      notes: ValidationIssue[];
    }
  | { kind: "refuse"; issues: ValidationIssue[] };

export interface PlannedAsset {
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

function assertRange(name: string, min: number | undefined, max: number | undefined) {
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`Inconsistent media constraints: min${name} (${min}) exceeds max${name} (${max}).`);
  }
}

/** Pure; throws on an inconsistent video declaration so a bad provider fails at registry load. */
export function assertVideoCapabilities(caps: ProviderCapabilities): void {
  const v: VideoCapabilities = caps.video;
  if (!Number.isInteger(v.maxVideos) || v.maxVideos < 0) {
    throw new Error(`Inconsistent video constraints: maxVideos (${v.maxVideos}) must be a non-negative integer.`);
  }
  assertRange("DurationSeconds", v.minDurationSeconds, v.maxDurationSeconds);
  assertRange("Width", v.minWidth, v.maxWidth);
  assertRange("Height", v.minHeight, v.maxHeight);
  assertRange("AspectRatio", v.minAspectRatio, v.maxAspectRatio);
  if (v.withImages && caps.media.maxImages === 0) {
    throw new Error("Inconsistent video constraints: withImages is set but the provider accepts no images.");
  }
  if (v.maxVideos > 0 && !caps.postTypes.includes("video")) {
    throw new Error('Inconsistent video constraints: maxVideos is above 0 but postTypes lacks "video".');
  }
}

/** Pure; throws on an inconsistent declaration so a bad provider fails at registry load. */
export function mediaConstraintsOf(caps: ProviderCapabilities): MediaConstraints {
  assertVideoCapabilities(caps);
  const m = caps.media;
  const output = m.outputMimeType ?? m.allowedMimeTypes[0];
  if (m.maxImages > 0) {
    if (m.allowedMimeTypes.length === 0) {
      throw new Error("Inconsistent media constraints: no allowed mime types for a provider that accepts images.");
    }
    if (m.maxBytesPerFile <= 0) {
      throw new Error("Inconsistent media constraints: maxBytesPerFile must be positive.");
    }
    if (!m.allowedMimeTypes.includes(output!)) {
      throw new Error(`Inconsistent media constraints: outputMimeType ${output} is not an allowed type.`);
    }
    if (!(OUTPUT_TYPES as readonly string[]).includes(output!)) {
      throw new Error(`Inconsistent media constraints: outputMimeType ${output} cannot be produced.`);
    }
  }
  assertRange("Width", m.minWidth, m.maxWidth);
  assertRange("Height", m.minHeight, m.maxHeight);
  assertRange("AspectRatio", m.minAspectRatio, m.maxAspectRatio);
  return {
    acceptedMimeTypes: m.allowedMimeTypes,
    outputMimeType: output ?? "image/jpeg",
    maxBytes: m.maxBytesPerFile,
    minWidth: m.minWidth,
    maxWidth: m.maxWidth,
    minHeight: m.minHeight,
    maxHeight: m.maxHeight,
    minAspectRatio: m.minAspectRatio,
    maxAspectRatio: m.maxAspectRatio,
    maxAltTextLength: m.maxAltTextLength,
  };
}

/** Decide whether an image can go as is, can be adapted, or must be refused. Never crops or upscales. */
export function planImage(
  asset: PlannedAsset,
  c: MediaConstraints,
  ctx: { index: number; platform: string; label?: string },
): ImagePlan {
  const label = ctx.label ?? `Image ${ctx.index + 1}`;
  const field = `media.${ctx.index}` as const;
  const refuse: ValidationIssue[] = [];
  const err = (code: string, message: string) => refuse.push({ severity: "error", code, message, field });

  const { width, height } = asset;
  const ratio = width / height;
  if (c.minAspectRatio !== undefined && ratio < c.minAspectRatio - 1e-9) {
    err(
      "aspect_ratio_out_of_range",
      `${label} is too tall for ${ctx.platform} (aspect ${ratio.toFixed(2)}; allowed ${c.minAspectRatio}–${c.maxAspectRatio ?? "any"}).`,
    );
  } else if (c.maxAspectRatio !== undefined && ratio > c.maxAspectRatio + 1e-9) {
    err(
      "aspect_ratio_out_of_range",
      `${label} is too wide for ${ctx.platform} (aspect ${ratio.toFixed(2)}; allowed ${c.minAspectRatio ?? "any"}–${c.maxAspectRatio}).`,
    );
  }
  if ((c.minWidth !== undefined && width < c.minWidth) || (c.minHeight !== undefined && height < c.minHeight)) {
    err("image_too_small", `${label} is ${width}×${height}; ${ctx.platform} needs at least ${c.minWidth ?? 0}×${c.minHeight ?? 0}.`);
  }

  const scale = Math.min(
    1,
    c.maxWidth !== undefined ? c.maxWidth / width : 1,
    c.maxHeight !== undefined ? c.maxHeight / height : 1,
  );
  const outW = scale < 1 ? Math.max(1, Math.round(width * scale)) : width;
  const outH = scale < 1 ? Math.max(1, Math.round(height * scale)) : height;
  if (
    scale < 1 &&
    refuse.every((i) => i.code !== "image_too_small") &&
    ((c.minWidth !== undefined && outW < c.minWidth) || (c.minHeight !== undefined && outH < c.minHeight))
  ) {
    err("image_too_small", `${label} cannot be resized to fit ${ctx.platform} without becoming too small.`);
  }
  if (refuse.length > 0) return { kind: "refuse", issues: refuse };

  const steps: ImageStep[] = [];
  const notes: ValidationIssue[] = [];
  const note = (code: string, message: string) => notes.push({ severity: "info", code, message, field });
  // A lossless PNG can rarely be compressed enough, so an oversize one is also converted to the output type.
  const convert =
    !c.acceptedMimeTypes.includes(asset.mimeType) ||
    (asset.bytes > c.maxBytes && asset.mimeType === "image/png" && c.outputMimeType !== "image/png");
  const mimeType = convert ? c.outputMimeType : asset.mimeType;
  if (convert) {
    steps.push("convert");
    note("media_will_convert", `${label} will be converted to ${MIME_LABEL[mimeType] ?? mimeType} for ${ctx.platform}.`);
  }
  if (scale < 1) {
    steps.push("downscale");
    note("media_will_downscale", `${label} will be resized to ${outW}×${outH} for ${ctx.platform}.`);
  }
  if (asset.bytes > c.maxBytes) {
    steps.push("compress");
    note("media_will_compress", `${label} will be compressed to fit ${c.maxBytes.toLocaleString("en-US")} bytes for ${ctx.platform}.`);
  }
  if (steps.length === 0) return { kind: "original" };
  return {
    kind: "derive",
    steps,
    output: { mimeType, width: outW, height: outH, maxBytes: c.maxBytes },
    notes,
  };
}
