import type { TextCountingRule } from "./types";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function countGraphemes(text: string): number {
  return [...segmenter.segment(text)].length;
}

export function countCodePoints(text: string): number {
  return [...text].length;
}

export function countUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function countText(text: string, rule: TextCountingRule): number {
  if (typeof rule === "object") return rule.count(text);
  switch (rule) {
    case "graphemes":
      return countGraphemes(text);
    case "code_points":
      return countCodePoints(text);
    case "utf8_bytes":
      return countUtf8Bytes(text);
  }
}

export function countingRuleName(rule: TextCountingRule): string {
  return typeof rule === "object" ? rule.name : rule;
}

export function countingUnit(rule: TextCountingRule): string {
  if (typeof rule === "object") return rule.unit;
  return rule === "graphemes" ? "graphemes" : rule === "code_points" ? "characters" : "bytes";
}

const MASKED = [
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
];
const HASHTAG = /(?<![^\s\p{P}\p{S}])#([\p{L}\p{N}_]+)/gu;
const MENTION = /(?<![^\s\p{P}\p{S}])@([\p{L}\p{N}._]+)/gu;

function unmasked(text: string): string {
  return MASKED.reduce((t, re) => t.replace(re, " "), text);
}

/** Hashtags per occurrence, repeats included (FR-012). URLs and emails are ignored. Pure and total. */
export function countHashtags(text: string): number {
  return [...unmasked(text).matchAll(HASHTAG)].filter((m) => /[^\p{N}]/u.test(m[1] ?? "")).length;
}

/** @mentions per occurrence, repeats included (FR-012). URLs and emails are ignored. Pure and total. */
export function countMentions(text: string): number {
  return [...unmasked(text).matchAll(MENTION)].filter((m) => /[\p{L}\p{N}_]/u.test(m[1] ?? "")).length;
}
