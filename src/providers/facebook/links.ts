const URL_PATTERN = /<?\bhttps?:\/\/[^\s<>]+/i;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** First http(s) URL in text, trailing punctuation trimmed, or null. Pure. */
export function firstUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  const url = match[0].replace(/^</, "").replace(TRAILING, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url;
}
