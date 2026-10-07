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
  rows.push({ term: "Image required", detail: post.mediaRequired ? "yes" : "no" });
  rows.push({ term: "Text-only posts", detail: post.textOnlyAllowed ? "allowed" : "not allowed" });
  return rows;
}
