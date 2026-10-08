import { providerPublishLimits } from "../../src/providers/limits";
import { mediaConstraintsOf, planImage, type ImagePlan, type MediaConstraints, type PlannedAsset } from "../../src/providers/media";
import type { MediaItem, PostType, ProviderCapabilities, PublishLimit, SocialProvider } from "../../src/providers/types";
import { videoLimitsFor } from "../../src/providers/validation";
import type { VideoStep } from "../../src/providers/video-plan";
import type { VideoAssetOptions } from "./factories";
import { UPLOAD_MIME_TYPES } from "../../src/server/services/media";
import { validateResolvedContent } from "../../src/server/services/posts/validate";

/**
 * The limit rows `tests/integration/limits/enforcement.test.ts` generates, one per provider and docs/limits.md
 * category, each built from the provider's own declared values. `tests/integration/docs/limits-inventory.test.ts`
 * reads the same rows, so a citation in docs/limits.md must name a test that really exists and breaks that limit.
 * Every title is `<providerKey>: <category>` (publish limits add the value: `<providerKey>: publish limit <value>`).
 */

export type Suite = "core" | "text" | "planner" | "limits" | "video" | "adapt";

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

export interface VideoRow {
  title: string;
  category: string;
  /** Ready video rows to attach, built from facts that break exactly this limit by one unit. */
  videos: VideoAssetOptions[];
  /** Attach one stored image as well. */
  withImage?: boolean;
  /** The error the gate must refuse with; with `codes`, any one of those. */
  code: string;
  codes: readonly string[];
  /** The post type the target is set to, for a provider that offers a choice. Absent = none chosen. */
  chosenPostType?: PostType;
  /** The type the post resolves to, so the row is checked against that type's limits. */
  postType: PostType;
  /** Set on a row the formatter adapts instead of refusing (P25): the plan must be `derive` with one of these steps. */
  adapt?: readonly VideoStep[];
}

const CONTAINERS = ["mp4", "mov"] as const;

/** The `MediaItem` a stored video row with these facts becomes, with the same defaults as `createVideoAsset`. */
export function videoItem(o: VideoAssetOptions = {}): MediaItem {
  const container = o.container ?? "mp4";
  return {
    url: "http://localhost:3000/media/x.mp4",
    mimeType: container === "mov" ? "video/quicktime" : "video/mp4",
    width: o.width ?? 1280,
    height: o.height ?? 720,
    bytes: o.byteSize ?? 5_000_000,
    altText: "",
    kind: "video",
    video: {
      container,
      durationSeconds: o.durationSeconds ?? 20,
      frameRate: o.frameRate === undefined ? 30 : o.frameRate,
      videoCodec: o.videoCodec ?? "h264",
      audioCodec: o.audioCodec === undefined ? "aac" : o.audioCodec,
      videoBitrate: o.videoBitrate === undefined ? 2_000_000 : o.videoBitrate,
      audioBitrate: o.audioCodec === null ? null : o.audioBitrate === undefined ? 128_000 : o.audioBitrate,
      audioSampleRate: o.audioCodec === null ? null : o.audioSampleRate === undefined ? 44_100 : o.audioSampleRate,
      audioChannels: o.audioCodec === null ? null : o.audioChannels === undefined ? 2 : o.audioChannels,
      indexAtFront: o.indexAtFront === undefined ? true : o.indexAtFront,
      factsVersion: 2,
    },
  };
}

/** The post a row builds, as the validator sees it: the image (if any) first, then the videos. */
export function videoRowContent(provider: SocialProvider, row: VideoRow): { text: string; media: MediaItem[]; postType: PostType } {
  const media: MediaItem[] = [];
  if (row.withImage) media.push(image({ mimeType: provider.capabilities.media.allowedMimeTypes[0] ?? "image/jpeg" }));
  media.push(...row.videos.map(videoItem));
  return { text: "hi", media, postType: row.postType };
}

/**
 * One row per declared video category that can be broken. A list that already allows every value Docket accepts
 * (the mock's containers) or a bound that cannot be crossed (`silentAllowed: true`) has no refusing fact; those
 * rows are proved by `src/providers/validation.test.ts` instead, and docs/limits.md names that test.
 *
 * A provider with a `single_video` choice gets every base row once per option type (`<key>: <category>` for the
 * default, `<key>: <category> (<type>)` for the others), and one row per bound a `byPostType` entry overrides.
 */
export function videoRows(provider: SocialProvider): VideoRow[] {
  const caps = provider.capabilities;
  const key = provider.key;
  const choice = caps.postTypeChoices?.find((c) => c.shape === "single_video");
  if (caps.video.maxVideos === 0) {
    return [{ title: `${key}: videos`, category: "videos", videos: [{}], code: "video_not_accepted", codes: ["video_not_accepted"], postType: "video" }];
  }
  const rows: VideoRow[] = [];
  const types: (PostType | null)[] = choice ? choice.options.map((o) => o.type) : [null];
  for (const chosen of types) {
    const postType: PostType = chosen ?? "video";
    const v = videoLimitsFor(caps, postType);
    // A type with limits of its own is named like a `byPostType` row (`facebook: reel min duration`); one that shares the base is not.
    const own = chosen !== null && chosen !== choice!.default && Object.keys(caps.video.byPostType?.[chosen] ?? {}).some((k) => k !== "notes" && k !== "recommendedAspectRatio");
    const suffix = chosen && chosen !== choice!.default && !own ? ` (${chosen})` : "";
    const adapt = (category: string, step: VideoStep | readonly VideoStep[], videos: VideoAssetOptions[], withImage = false): VideoRow => ({
      ...row(category, "", videos, withImage),
      code: "",
      codes: [],
      adapt: typeof step === "string" ? [step] : step,
    });
    const row = (category: string, code: string | readonly string[], videos: VideoAssetOptions[], withImage = false): VideoRow => ({
      title: own ? `${key}: ${chosen} ${category}` : `${key}: ${category}${suffix}`,
      category: own ? `${chosen} ${category}` : category,
      videos,
      withImage,
      code: typeof code === "string" ? code : code[0]!,
      codes: typeof code === "string" ? [code] : code,
      ...(chosen ? { chosenPostType: chosen } : {}),
      postType,
    });
    // With a choice, a second video or an image makes a carousel, so these two are carousel rows below.
    if (!choice && !caps.video.byPostType?.carousel) {
      rows.push(row("videos", "too_many_videos", Array.from({ length: v.maxVideos + 1 }, () => ({}))));
      if (v.withImages === false && caps.media.maxImages > 0) rows.push(row("video with images", "video_with_images", [{}], true));
    }
    const otherContainer = CONTAINERS.find((c) => v.containers && !v.containers.includes(c));
    if (otherContainer) rows.push(adapt("video containers", "rewrap", [{ container: otherContainer }]));
    const otherCodec = ["hevc", "vp9", "mpeg4"].find((c) => v.videoCodecs && !v.videoCodecs.includes(c));
    if (otherCodec) rows.push(adapt("video codecs", "reencode", [{ videoCodec: otherCodec }]));
    if (v.audioCodecs && !v.audioCodecs.includes("opus")) rows.push(adapt("audio codecs", "reencode", [{ audioCodec: "opus" }]));
    if (v.silentAllowed === false) rows.push(row("silent video", "audio_required", [{ audioCodec: null }]));
    if (v.maxBytes !== undefined) rows.push(adapt("video bytes", "reencode", [{ byteSize: v.maxBytes + 1 }]));
    if (v.minDurationSeconds !== undefined) rows.push(row("min duration", "video_too_short", [{ durationSeconds: Math.max(0, v.minDurationSeconds - 0.5) }]));
    if (v.maxDurationSeconds !== undefined) rows.push(adapt("max duration", "cut", [{ durationSeconds: v.maxDurationSeconds + 1 }]));
    if (v.minWidth !== undefined) rows.push(row("video min width", "video_too_small", [{ width: v.minWidth - 1 }]));
    if (v.maxWidth !== undefined) rows.push(adapt("video max width", "resize", [{ width: v.maxWidth + 1 }]));
    if (v.minHeight !== undefined) {
      // The width keeps the video inside the aspect range, so padding cannot rescue it: it is refused, never enlarged.
      const lo = v.minAspectRatio ?? 0;
      const hi = v.maxAspectRatio ?? Number.POSITIVE_INFINITY;
      rows.push(row("video min height", "video_too_small", [{ height: v.minHeight - 1, width: Math.floor((v.minHeight - 1) * Math.min(hi, Math.max(lo, 1))) }]));
    }
    if (v.maxHeight !== undefined) rows.push(adapt("video max height", "resize", [{ height: v.maxHeight + 1 }]));
    if (v.minAspectRatio !== undefined) rows.push(adapt("video min aspect", "pad", [{ width: Math.floor(v.minAspectRatio * 1000) - 1, height: 1000 }]));
    if (v.maxAspectRatio !== undefined) rows.push(adapt("video max aspect", "pad", [{ width: Math.ceil(v.maxAspectRatio * 1000) + 1, height: 1000 }]));
    if (v.minFrameRate !== undefined) rows.push(adapt("min frame rate", "frame_rate", [{ frameRate: v.minFrameRate - 1 }]));
    if (v.maxFrameRate !== undefined) rows.push(adapt("max frame rate", "frame_rate", [{ frameRate: v.maxFrameRate + 1 }]));
    // Bitrate, sample rate, channels and index position are adapted too (P24). `audioBitrate` is an encode target and
    // `recommendedAspectRatio` only changes a shape when asked, so neither has a refusing fact: video-plan.test.ts proves them.
    if (v.maxVideoBitrate !== undefined) rows.push(adapt("video max bitrate", "reencode", [{ videoBitrate: v.maxVideoBitrate + 1 }]));
    if (v.maxAudioSampleRate !== undefined) rows.push(adapt("audio max sample rate", "reencode", [{ audioSampleRate: v.maxAudioSampleRate + 1 }]));
    if (v.maxAudioChannels !== undefined) rows.push(adapt("audio max channels", "reencode", [{ audioChannels: v.maxAudioChannels + 1 }]));
    if (v.indexAtFront === true) rows.push(adapt("index at front", "rewrap", [{ indexAtFront: false }]));
  }
  // Per-type overrides: a post of that type's shape (a carousel is an image plus a video), breaking only the overridden bound.
  for (const [type, over] of Object.entries(caps.video.byPostType ?? {}) as [PostType, NonNullable<ProviderCapabilities["video"]["byPostType"]>[PostType]][]) {
    if (!over || choice?.options.some((o) => o.type === type)) continue;
    const row = (category: string, code: string | readonly string[], videos: VideoAssetOptions[], withImage: boolean): VideoRow => ({
      title: `${key}: ${type} ${category}`,
      category: `${type} ${category}`,
      videos,
      withImage,
      code: typeof code === "string" ? code : code[0]!,
      codes: typeof code === "string" ? [code] : code,
      postType: type,
    });
    const adaptOver = (category: string, step: VideoStep, videos: VideoAssetOptions[]): VideoRow => ({
      ...row(category, "", videos, true),
      code: "",
      codes: [],
      adapt: [step],
    });
    if (over.maxVideos !== undefined) rows.push(row("videos", ["too_many_videos", "too_many_items"], Array.from({ length: over.maxVideos + 1 }, () => ({})), false));
    if (over.minAspectRatio !== undefined) rows.push(adaptOver("video min aspect", "pad", [{ width: Math.floor(over.minAspectRatio * 1000) - 1, height: 1000 }]));
    if (over.maxAspectRatio !== undefined) rows.push(adaptOver("video max aspect", "pad", [{ width: Math.ceil(over.maxAspectRatio * 1000) + 1, height: 1000 }]));
    if (over.maxBytes !== undefined) rows.push(adaptOver("video bytes", "reencode", [{ byteSize: over.maxBytes + 1 }]));
    if (over.maxDurationSeconds !== undefined) rows.push(adaptOver("max duration", "cut", [{ durationSeconds: over.maxDurationSeconds + 1 }]));
    if (over.minFrameRate !== undefined) rows.push(adaptOver("min frame rate", "frame_rate", [{ frameRate: over.minFrameRate - 1 }]));
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

export interface AllowanceRow {
  title: string;
  count: number;
  windowSeconds: number;
  name: string;
}

/** One row for a provider that declares a creation allowance (docs/limits.md category `creation allowance`). */
export function allowanceRows(provider: SocialProvider): AllowanceRow[] {
  const a = provider.creationAllowance;
  return a ? [{ title: `${provider.key}: creation allowance`, count: a.count, windowSeconds: a.windowSeconds, name: a.name }] : [];
}

/** Every generated title in the enforcement test, by suite. */
export function generatedTitles(provider: SocialProvider): { suite: Suite; title: string }[] {
  const noop: Assert = () => {};
  return [
    ...coreRows(provider).map((r) => ({ suite: "core" as const, title: r.title })),
    ...textRows(provider).map((r) => ({ suite: "text" as const, title: r.title })),
    ...plannerRows(provider, noop).map((r) => ({ suite: "planner" as const, title: r.title })),
    ...limitRows(provider).map((r) => ({ suite: "limits" as const, title: r.title })),
    ...allowanceRows(provider).map((r) => ({ suite: "limits" as const, title: r.title })),
    ...videoRows(provider).map((r) => ({ suite: r.adapt ? ("adapt" as const) : ("video" as const), title: r.title })),
  ];
}
