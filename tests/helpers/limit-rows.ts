import { providerPublishLimits } from "../../src/providers/limits";
import { mediaConstraintsOf, planImage, type ImagePlan, type MediaConstraints, type PlannedAsset } from "../../src/providers/media";
import type { MediaItem, PublishLimit, SocialProvider } from "../../src/providers/types";
import { UPLOAD_MIME_TYPES } from "../../src/server/services/media";
import { validateResolvedContent } from "../../src/server/services/posts/validate";

/**
 * The limit rows `tests/integration/limits/enforcement.test.ts` generates, one per provider and docs/limits.md
 * category, each built from the provider's own declared values. `tests/integration/docs/limits-inventory.test.ts`
 * reads the same rows, so a citation in docs/limits.md must name a test that really exists and breaks that limit.
 * Every title is `<providerKey>: <category>` (publish limits add the value: `<providerKey>: publish limit <value>`).
 */

export type Suite = "core" | "text" | "planner" | "limits";

export const image = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "http://localhost:3000/media/x.jpg",
  mimeType: "image/jpeg",
  width: 1000,
  height: 1000,
  bytes: 1000,
  altText: "",
  ...over,
});

/** A refusal must carry one of `codes` as an error; an acceptance must carry none of them. */
export type Expectation = { refuse: readonly string[] } | { accept: readonly string[] };

export interface ContentRow {
  title: string;
  category: string;
  text: string;
  media: MediaItem[];
  expect: Expectation;
}

const TEXT_ONLY_CODES = ["media_required", "text_only_not_allowed"] as const;

/** Whether the provider's own validation lets an oversize file through for the planner to compress (D15). */
export function compressesOversize(provider: SocialProvider): boolean {
  const { media } = provider.capabilities;
  if (media.maxImages === 0) return false;
  const big = image({ mimeType: media.allowedMimeTypes[0]!, bytes: media.maxBytesPerFile + 1 });
  return !validateResolvedContent(provider, { text: "hi", media: [big] }).some((i) => i.code === "file_too_large" && i.severity === "error");
}

/** Rows the shared validation core (`validateResolvedContent`, used by the scheduling gate and the engine) decides. */
export function coreRows(provider: SocialProvider): ContentRow[] {
  const { text, media, textOnlyAllowed } = provider.capabilities;
  const key = provider.key;
  const ok = image({ mimeType: media.allowedMimeTypes[0] ?? "image/jpeg" });
  const withMedia = media.required ? [ok] : [];
  const rows: ContentRow[] = [
    { title: `${key}: text length`, category: "text length", text: "a".repeat(text.maxLength + 1), media: withMedia, expect: { refuse: ["text_too_long"] } },
  ];
  if (text.maxHashtags !== undefined) {
    rows.push({ title: `${key}: hashtags`, category: "hashtags", text: Array.from({ length: text.maxHashtags + 1 }, (_, i) => `#tag${i}`).join(" "), media: withMedia, expect: { refuse: ["too_many_hashtags"] } });
  }
  if (text.maxMentions !== undefined) {
    rows.push({ title: `${key}: mentions`, category: "mentions", text: Array.from({ length: text.maxMentions + 1 }, (_, i) => `@user${i}`).join(" "), media: withMedia, expect: { refuse: ["too_many_mentions"] } });
  }
  if (media.maxImages > 0) {
    rows.push({ title: `${key}: images`, category: "images", text: "hi", media: Array.from({ length: media.maxImages + 1 }, () => ok), expect: { refuse: ["too_many_images"] } });
    if (!compressesOversize(provider)) {
      rows.push({ title: `${key}: bytes per file`, category: "bytes per file", text: "hi", media: [{ ...ok, bytes: media.maxBytesPerFile + 1 }], expect: { refuse: ["file_too_large"] } });
    }
  }
  if (media.maxAltTextLength !== undefined) {
    rows.push({ title: `${key}: alt text length`, category: "alt text length", text: "hi", media: [{ ...ok, altText: "a".repeat(media.maxAltTextLength + 1) }], expect: { refuse: ["alt_text_too_long"] } });
  }
  // A text-only post: refused where media is required or text-only is not allowed, accepted otherwise.
  rows.push({ title: `${key}: media required`, category: "media required", text: "hi", media: [], expect: media.required ? { refuse: TEXT_ONLY_CODES } : { accept: TEXT_ONLY_CODES } });
  rows.push({ title: `${key}: text only`, category: "text only", text: "hi", media: [], expect: textOnlyAllowed ? { accept: TEXT_ONLY_CODES } : { refuse: TEXT_ONLY_CODES } });
  return rows;
}

/** Rows driven end to end (refused by `addToQueue`, and again by the engine at publish time). Refusals only. */
export function textRows(provider: SocialProvider): ContentRow[] {
  return coreRows(provider).filter((r) => "refuse" in r.expect && (["text length", "hashtags", "mentions"].includes(r.category) || r.media.length === 0));
}

export interface PlannerRow {
  title: string;
  category: string;
  asset: PlannedAsset;
  /** What the planner must decide for `asset`. */
  check: (plan: ImagePlan, c: MediaConstraints) => void;
  /** An asset just inside the limit, which must not trip the same rule. */
  inside?: PlannedAsset;
}

type Assert = (cond: boolean, message: string) => void;

/**
 * Rows the media planner decides (`planImage` over `mediaConstraintsOf(provider.capabilities)`): conversions,
 * downscales and compressions are adaptations; geometry it cannot fix is refused.
 */
export function plannerRows(provider: SocialProvider, assert: Assert): PlannerRow[] {
  const { media } = provider.capabilities;
  if (media.maxImages === 0) return [];
  const c = mediaConstraintsOf(provider.capabilities);
  const key = provider.key;
  const jpeg = (width: number, height: number, bytes = 1000): PlannedAsset => ({ mimeType: c.outputMimeType, width, height, bytes });
  const derives = (step: string) => (plan: ImagePlan) => {
    assert(plan.kind === "derive" && plan.steps.includes(step as never), `${key}: expected a "${step}" adaptation, got ${JSON.stringify(plan)}`);
  };
  const refuses = (code: string) => (plan: ImagePlan) => {
    assert(plan.kind === "refuse" && plan.issues.some((i) => i.code === code && i.severity === "error"), `${key}: expected ${code}, got ${JSON.stringify(plan)}`);
  };
  const rows: PlannerRow[] = [];

  if (compressesOversize(provider)) {
    rows.push({
      title: `${key}: bytes per file`,
      category: "bytes per file",
      asset: jpeg(1000, 1000, c.maxBytes + 1),
      inside: jpeg(1000, 1000, c.maxBytes),
      check: (plan) => {
        derives("compress")(plan);
        assert(plan.kind === "derive" && plan.output.maxBytes === c.maxBytes, `${key}: compression target is not ${c.maxBytes}`);
      },
    });
  }

  const foreign = UPLOAD_MIME_TYPES.find((t) => !c.acceptedMimeTypes.includes(t));
  if (foreign) {
    rows.push({
      title: `${key}: formats`,
      category: "formats",
      asset: { mimeType: foreign, width: 1000, height: 1000, bytes: 1000 },
      inside: jpeg(1000, 1000),
      check: (plan) => {
        derives("convert")(plan);
        assert(plan.kind === "derive" && plan.output.mimeType === c.outputMimeType, `${key}: not converted to ${c.outputMimeType}`);
      },
    });
  }

  if (c.minWidth !== undefined) {
    rows.push({ title: `${key}: min width`, category: "min width", asset: jpeg(c.minWidth - 1, c.minWidth - 1), inside: jpeg(c.minWidth, c.minWidth), check: refuses("image_too_small") });
  }
  if (c.minHeight !== undefined) {
    rows.push({ title: `${key}: min height`, category: "min height", asset: jpeg(c.minHeight - 1, c.minHeight - 1), inside: jpeg(c.minHeight, c.minHeight), check: refuses("image_too_small") });
  }
  if (c.maxWidth !== undefined) {
    const max = c.maxWidth;
    rows.push({
      title: `${key}: max width`,
      category: "max width",
      asset: jpeg(max + 560, max + 560),
      inside: jpeg(max, max),
      check: (plan) => {
        derives("downscale")(plan);
        assert(plan.kind === "derive" && plan.output.width === max, `${key}: not downscaled to ${max}`);
      },
    });
  }
  if (c.maxHeight !== undefined) {
    const max = c.maxHeight;
    rows.push({
      title: `${key}: max height`,
      category: "max height",
      asset: jpeg(max + 560, max + 560),
      inside: jpeg(max, max),
      check: (plan) => {
        derives("downscale")(plan);
        assert(plan.kind === "derive" && plan.output.height === max, `${key}: not downscaled to ${max}`);
      },
    });
  }
  // Aspect rows use a 10000-pixel side so the other side stays an integer just past the limit.
  const SIDE = 10_000;
  if (c.minAspectRatio !== undefined) {
    const w = Math.ceil(c.minAspectRatio * SIDE);
    rows.push({ title: `${key}: min aspect`, category: "min aspect", asset: jpeg(w - 1, SIDE), inside: jpeg(w, SIDE), check: refuses("aspect_ratio_out_of_range") });
  }
  if (c.maxAspectRatio !== undefined) {
    const h = Math.ceil(SIDE / c.maxAspectRatio);
    rows.push({ title: `${key}: max aspect`, category: "max aspect", asset: jpeg(SIDE, h - 1), inside: jpeg(SIDE, h), check: refuses("aspect_ratio_out_of_range") });
  }
  return rows;
}

export const planWith = (provider: SocialProvider, asset: PlannedAsset): ImagePlan =>
  planImage(asset, mediaConstraintsOf(provider.capabilities), { index: 0, platform: provider.displayName });

export interface LimitRow {
  title: string;
  /** The limit that must be full: the provider's own, or (with none declared) an account-level one. */
  limit: PublishLimit;
  accountLevel: boolean;
  /** The other limits that apply, so start times can sit outside every shorter window. */
  all: readonly PublishLimit[];
}

/** An account-level limit for providers that declare none: docs/limits.md says it "still applies". */
export const ACCOUNT_LIMIT: PublishLimit = { count: 3, windowSeconds: 3600 };

export function limitRows(provider: SocialProvider): LimitRow[] {
  const own = providerPublishLimits(provider);
  if (own.length === 0) return [{ title: `${provider.key}: publish limit none`, limit: ACCOUNT_LIMIT, accountLevel: true, all: [ACCOUNT_LIMIT] }];
  return own.map((limit) => ({ title: `${provider.key}: publish limit ${limit.count} / ${limit.windowSeconds} s`, limit, accountLevel: false, all: own }));
}

/** Every generated title in the enforcement test, by suite. */
export function generatedTitles(provider: SocialProvider): { suite: Suite; title: string }[] {
  const noop: Assert = () => {};
  return [
    ...coreRows(provider).map((r) => ({ suite: "core" as const, title: r.title })),
    ...textRows(provider).map((r) => ({ suite: "text" as const, title: r.title })),
    ...plannerRows(provider, noop).map((r) => ({ suite: "planner" as const, title: r.title })),
    ...limitRows(provider).map((r) => ({ suite: "limits" as const, title: r.title })),
  ];
}
