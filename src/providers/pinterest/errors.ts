import { scrubPinterest } from "./http";

/** contracts/pinterest-publishing.md §4 (the fatal/ambiguous rows) and §6: status-only matching, no numeric `code`. */
function sentenceFor(status: number, boardName: string): string {
  if (status === 404) return `Pinterest could not find the board "${boardName}". Choose another board for this post.`;
  if (status === 403) return "Pinterest refused permission for this pin.";
  if (status === 400) return "Pinterest refused the pin.";
  if (status >= 400 && status < 500) return `Pinterest refused the pin (HTTP ${status}).`;
  return `Pinterest answered with an error (HTTP ${status}) after the pin was sent. Check the board on Pinterest before retrying.`;
}

/**
 * Builds the §4 fatal/ambiguous sentences. Matches on `status` only; a numeric `code` in the body is
 * never consulted (FR-024, U2). Any human `message` is appended as `(Pinterest: <scrubbed ≤200>)`;
 * nothing is appended when no readable message came back.
 */
export function explainPinterest(status: number, message: string | null, boardName: string, secrets: readonly string[]): string {
  const sentence = sentenceFor(status, boardName);
  if (!message) return sentence;
  const detail = scrubPinterest(message, secrets);
  return detail ? `${sentence} (Pinterest: ${detail})` : sentence;
}
