// Pure helpers for the review screen: wording and selection that the components and tests share.
import type { BulkApproveResult } from "@/server/services/review";

export const BRIEF_PREVIEW_MAX = 200;
export const REJECT_NAME_MAX = 60;
export const EXCERPT_MAX = 100;

const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);

/** The first `max` characters of `text`, with an ellipsis when something was cut. */
export function truncate(text: string, max: number): string {
  const parts = graphemes(text);
  return parts.length > max ? `${parts.slice(0, max).join("")}…` : text;
}

export function policyText(policy: "add_to_queue" | "leave_as_draft" | null): string | null {
  if (policy === "add_to_queue") return "Will be queued on approval";
  if (policy === "leave_as_draft") return "Stays a draft on approval";
  return null;
}

/** "Approved 18. Skipped 2:" — the reasons follow as a list. */
export function bulkSummary(result: Pick<BulkApproveResult, "approved" | "skipped">): string {
  const approved = `Approved ${result.approved.length}.`;
  return result.skipped.length > 0 ? `${approved} Skipped ${result.skipped.length}:` : approved;
}

/** One line per approved post that could not be scheduled everywhere, and one per skipped post. */
export function bulkDetails(result: BulkApproveResult, excerpts: ReadonlyMap<string, string>): string[] {
  const name = (id: string) => excerpts.get(id) ?? "A post";
  return [
    ...result.approved.flatMap((a) => a.unscheduled.map((u) => `${name(a.postId)}: ${u.accountName} was not scheduled. ${u.message}`)),
    ...result.skipped.map((s) => `${name(s.postId)}: ${s.reason}`),
  ];
}

/** Toggles `id` in `selected`. */
export function toggle(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** All ids selected, or none when they all already are. */
export function toggleAll(selected: readonly string[], ids: readonly string[]): string[] {
  return ids.every((id) => selected.includes(id)) ? selected.filter((s) => !ids.includes(s)) : [...new Set([...selected, ...ids])];
}
