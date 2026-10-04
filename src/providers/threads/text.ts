import type { CustomCountingRule } from "../types";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const encoder = new TextEncoder();
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const TWO_REGIONAL = /^\p{Regional_Indicator}{2}$/u;
const COMBINING_KEYCAP = "⃣";

function isEmojiGrapheme(g: string): boolean {
  return PICTOGRAPHIC.test(g) || TWO_REGIONAL.test(g) || g.includes(COMBINING_KEYCAP);
}

/** Interim reading of Threads' rule (R9): an emoji counts its UTF-8 bytes, everything else its code points. */
export function countThreadsText(text: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(text)) {
    total += isEmojiGrapheme(segment) ? encoder.encode(segment).length : [...segment].length;
  }
  return total;
}

export const threadsCountingRule: CustomCountingRule = {
  kind: "custom",
  name: "threads",
  unit: "characters",
  count: countThreadsText,
};
