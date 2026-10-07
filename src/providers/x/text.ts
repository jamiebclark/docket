import type { CustomCountingRule } from "../types";
import { X_TLDS } from "./tlds";

/** Every link counts this many characters, whatever its length (twitter-text v3). */
const URL_WEIGHT = 23;
const EMOJI_WEIGHT = 2;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Built from a string: the `v` flag is newer than the compile target.
const EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

const SCHEME_URL = /https?:\/\/\S+/giu;
// The first lookahead caps the hostname at 253 characters (the DNS maximum), so no start position can backtrack across more.
const SCHEMELESS_URL = new RegExp(
  `(?<![\\p{L}\\p{N}@./_])(?=[a-z0-9.-]{1,253}(?![a-z0-9.-]))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${[...X_TLDS].sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}\\p{N}-])(?::\\d+)?(?:[/?#]\\S*)?`,
  "giu",
);
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Sentence punctuation and an unmatched closing bracket do not belong to the link. */
function trimUrl(url: string): string {
  // One pass to count brackets in the kept prefix, then adjust as characters are dropped.
  const counts = new Map<string, number>();
  for (const ch of url) if (ch in CLOSERS || Object.values(CLOSERS).includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (TRAILING.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener) {
      const closes = counts.get(ch)!;
      if ((counts.get(opener) ?? 0) <= closes - 1) {
        counts.set(ch, closes - 1);
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

interface Span {
  start: number;
  end: number;
}

/** Non-overlapping link spans, in order. */
function urlSpans(text: string): Span[] {
  const found: Span[] = [];
  for (const re of [SCHEME_URL, SCHEMELESS_URL]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const trimmed = trimUrl(m[0]);
      if (trimmed) found.push({ start: m.index, end: m.index + trimmed.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: Span[] = [];
  for (const s of found) {
    const last = spans[spans.length - 1];
    if (!last || s.start >= last.end) spans.push(s);
  }
  return spans;
}

/** twitter-text's weight ranges: 1 for these, 2 for everything else. */
function codePointWeight(cp: number): number {
  return cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
}

function countPlain(text: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI.test(segment)) {
      total += EMOJI_WEIGHT;
      continue;
    }
    for (const ch of segment) total += codePointWeight(ch.codePointAt(0)!);
  }
  return total;
}

/** Pure, total, linear (research D6). */
export function countXText(text: string): number {
  if (typeof text !== "string") return 0;
  try {
    const t = text.normalize("NFC");
    let total = 0;
    let at = 0;
    for (const span of urlSpans(t)) {
      total += countPlain(t.slice(at, span.start)) + URL_WEIGHT;
      at = span.end;
    }
    return total + countPlain(t.slice(at));
  } catch {
    // An over-estimate never lets a too-long post through.
    let total = 0;
    for (const _ of String(text)) total += 2;
    return total;
  }
}

/** True when the text holds a link or an emoji, the two things X may count differently from us (D8). */
export function hasLinkOrEmoji(text: string): boolean {
  try {
    const t = text.normalize("NFC");
    if (urlSpans(t).length > 0) return true;
    for (const { segment } of segmenter.segment(t)) if (EMOJI.test(segment)) return true;
    return false;
  } catch {
    return true;
  }
}

export const xCountingRule: CustomCountingRule = {
  kind: "custom",
  name: "x-weighted",
  unit: "characters",
  count: countXText,
};
