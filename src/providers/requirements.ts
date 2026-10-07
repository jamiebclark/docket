import { MIME_LABEL } from "@/lib/media/types";
import { countingRuleName, countingUnit } from "./text";
import type { PostType, ProviderCapabilities } from "./types";

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

export function requirementsOf(caps: ProviderCapabilities, ctx: { uploadTypes: readonly string[] }): RequirementsSummary {
  const m = caps.media;
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
    post: {
      mediaRequired: m.required || !caps.textOnlyAllowed,
      textOnlyAllowed: caps.textOnlyAllowed,
      postTypes: [...caps.postTypes],
    },
  };
}
