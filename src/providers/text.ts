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
  switch (rule) {
    case "graphemes":
      return countGraphemes(text);
    case "code_points":
      return countCodePoints(text);
    case "utf8_bytes":
      return countUtf8Bytes(text);
  }
}
