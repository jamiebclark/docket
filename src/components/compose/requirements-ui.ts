import type { Labelled, Range, RequirementsSummary } from "@/providers/requirements";

const number = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`;

const NO_LIMIT_CHECKED = "No limit checked";
const NO_LIMIT_DOCUMENTED = "No limit documented";

/** "2,200 characters (code points)"; the rule's name is left off where it only repeats the unit. */
export function textLimitText(t: RequirementsSummary["text"]): string {
  const rule = t.countingRule.replace(/_/g, " ");
  const base = `${number(t.maxLength)} ${t.unit}`;
  return rule === t.unit ? base : `${base} (${rule})`;
}

const list = (items: Labelled<string>[]) => items.map((i) => i.label).join(", ");

/** "320 px – 1440 px", "at least 320 px", "at most 1440 px", or "No limit checked". */
export function rangeText(r: Range): string {
  if (r.min && r.max) return `${r.min.label} – ${r.max.label}`;
  if (r.min) return `at least ${r.min.label}`;
  if (r.max) return `at most ${r.max.label}`;
  return NO_LIMIT_CHECKED;
}

/** The always-visible gist, e.g. "2,200 characters · up to 10 images · JPEG". Every value comes from the summary. */
export function summaryLine(r: RequirementsSummary): string {
  const text = `${number(r.text.maxLength)} ${r.text.unit}`;
  if (r.image.maxImages === 0) return `${text} · no images`;
  return `${text} · up to ${plural(r.image.maxImages, "image", "images")} · ${list(r.image.formats)}`;
}

/** The video gist: "Video: not accepted yet" or "Video: 1 per post, MP4, MOV, H.264, up to 50 MB, 1 second – 1 minute, aspect 9:16 – 16:9, up to 60 fps". */
export function videoLine(r: RequirementsSummary): string {
  const v = r.video;
  if (v.maxVideos === 0) return "Video: not accepted yet";
  const parts = [`${plural(v.maxVideos, "video", "videos")} per post`];
  if (v.containers.length > 0) parts.push(list(v.containers));
  if (v.videoCodecs.length > 0) parts.push(list(v.videoCodecs));
  if (v.maxBytes) parts.push(`up to ${v.maxBytes.label}`);
  if (v.duration.min || v.duration.max) parts.push(rangeText(v.duration));
  if (v.aspectRatio.min || v.aspectRatio.max) parts.push(`aspect ${rangeText(v.aspectRatio)}`);
  if (v.minFrameRate && v.maxFrameRate) parts.push(`${v.minFrameRate.label} – ${v.maxFrameRate.label}`);
  else if (v.maxFrameRate) parts.push(`up to ${v.maxFrameRate.label}`);
  else if (v.minFrameRate) parts.push(`at least ${v.minFrameRate.label}`);
  if (!v.withImages) parts.push("not with images");
  if (v.postType?.description) parts.push(v.postType.description.replace(/\.$/, ""));
  return `${v.postType ? `${v.postType.label}` : "Video"}: ${parts.join(", ")}`;
}

/** The carousel gist, or null: "Carousel: up to 10 items; images and videos may be mixed; video items 4:5 – 1.91:1; Reels cannot be carousel items." */
export function carouselLine(r: RequirementsSummary): string | null {
  const c = r.carousel;
  if (!c) return null;
  const parts = [`up to ${plural(c.maxItems, "item", "items")}`];
  if (c.mixed) parts.push("images and videos may be mixed");
  if (c.videoAspectRatio.min || c.videoAspectRatio.max) parts.push(`video items ${rangeText(c.videoAspectRatio)}`);
  parts.push(...c.notes.map((n) => n.replace(/\.$/, "")));
  return `Carousel: ${parts.join("; ")}.`;
}

/** "PNG and WebP uploads are converted to JPEG", or null when nothing is converted. */
export function conversionText(r: RequirementsSummary): string | null {
  const { convertedFrom, convertedTo } = r.image;
  if (convertedFrom.length === 0 || !convertedTo) return null;
  const from = convertedFrom.map((f) => f.label);
  const names = from.length > 1 ? `${from.slice(0, -1).join(", ")} and ${from[from.length - 1]}` : from[0]!;
  return `${names} uploads are converted to ${convertedTo.label}`;
}

export interface DetailRow {
  term: string;
  detail: string;
}

/** Every field of the summary as term/detail rows for the `<dl>`. */
export function detailRows(r: RequirementsSummary): DetailRow[] {
  const rows: DetailRow[] = [{ term: "Text", detail: textLimitText(r.text) }];
  if (r.text.maxHashtags !== null) rows.push({ term: "Hashtags", detail: `up to ${number(r.text.maxHashtags)}` });
  if (r.text.maxMentions !== null) rows.push({ term: "Mentions", detail: `up to ${number(r.text.maxMentions)}` });
  const { image, post } = r;
  rows.push({ term: "Images", detail: image.maxImages === 0 ? "none" : `up to ${number(image.maxImages)}` });
  if (image.maxImages > 0) {
    const conversion = conversionText(r);
    rows.push({ term: "Formats", detail: conversion ? `${list(image.formats)}. ${conversion}` : list(image.formats) });
    rows.push({ term: "Maximum file size", detail: image.maxBytesPerFile.label });
    rows.push({ term: "Width", detail: rangeText(image.width) });
    rows.push({ term: "Height", detail: rangeText(image.height) });
    rows.push({ term: "Aspect ratio", detail: rangeText(image.aspectRatio) });
    rows.push({
      term: "Alt text",
      detail: image.maxAltTextLength === null ? NO_LIMIT_DOCUMENTED : `up to ${number(image.maxAltTextLength)} characters`,
    });
  }
  const { video } = r;
  if (video.postType) {
    rows.push({ term: "Post as", detail: video.postType.description ? `${video.postType.label}. ${video.postType.description}` : video.postType.label });
  }
  rows.push({ term: "Video", detail: video.maxVideos === 0 ? "not accepted yet" : `up to ${number(video.maxVideos)} per post` });
  if (video.maxVideos > 0) {
    const NONE = "no limit Docket checks";
    const listOr = (xs: Labelled<string>[]) => (xs.length > 0 ? list(xs) : NONE);
    const rangeOr = (x: Range) => (x.min || x.max ? rangeText(x) : NONE);
    rows.push({ term: "Video with images", detail: video.withImages ? "allowed" : "not allowed" });
    rows.push({ term: "Video containers", detail: listOr(video.containers) });
    rows.push({ term: "Video codecs", detail: listOr(video.videoCodecs) });
    rows.push({ term: "Audio codecs", detail: listOr(video.audioCodecs) });
    rows.push({ term: "Silent video", detail: video.silentAllowed ? "allowed" : "not allowed" });
    rows.push({ term: "Video file size", detail: video.maxBytes ? video.maxBytes.label : NONE });
    rows.push({ term: "Video duration", detail: rangeOr(video.duration) });
    rows.push({ term: "Video width", detail: rangeOr(video.width) });
    rows.push({ term: "Video height", detail: rangeOr(video.height) });
    rows.push({ term: "Video aspect ratio", detail: rangeOr(video.aspectRatio) });
    rows.push({
      term: "Video frame rate",
      detail:
        video.minFrameRate && video.maxFrameRate
          ? `${video.minFrameRate.label} – ${video.maxFrameRate.label}`
          : video.maxFrameRate
            ? `up to ${video.maxFrameRate.label}`
            : video.minFrameRate
              ? `at least ${video.minFrameRate.label}`
              : NONE,
    });
    if (video.adapts.length > 0) rows.push({ term: "Docket will adapt", detail: video.adapts.join("; ") });
    if (video.cannot.length > 0) rows.push({ term: "Docket will refuse", detail: video.cannot.join("; ") });
    for (const note of video.notes) rows.push({ term: "Note", detail: note });
  }
  if (r.carousel) {
    rows.push({ term: "Carousel items", detail: `up to ${number(r.carousel.maxItems)}${r.carousel.mixed ? "; images and videos may be mixed" : ""}` });
    rows.push({ term: "Carousel video aspect ratio", detail: rangeText(r.carousel.videoAspectRatio) });
    for (const note of r.carousel.notes) rows.push({ term: "Note", detail: note });
  }
  rows.push({ term: "Image required", detail: post.mediaRequired ? "yes" : "no" });
  rows.push({ term: "Text-only posts", detail: post.textOnlyAllowed ? "allowed" : "not allowed" });
  return rows;
}
