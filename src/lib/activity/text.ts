import { OUTCOME_LABEL, type ActivityOutcome } from "./outcomes";
import type { ResolveAction } from "./details";

export const MESSAGE_MAX = 500;

/** Keeps at most `max` code points, ending in "…" when cut (the column counts code points too). */
export function clipMessage(s: string, max: number = MESSAGE_MAX): string {
  const points = Array.from(s);
  if (points.length <= max) return s;
  return `${points.slice(0, max - 1).join("")}…`;
}

export type ResolvedDetails = { action: ResolveAction; requeue?: "no_free_slot" | undefined; mode?: "now" | "requeue" | undefined };

/** The sentence stored for a `target_resolved` event; one function so the stored text and any re-render agree. */
export function resolvedMessage(details: ResolvedDetails): string {
  switch (details.action) {
    case "marked_published":
      return "Marked published.";
    case "marked_not_published":
      return details.requeue === "no_free_slot" ? "Marked not published. No free posting slot to requeue." : "Marked not published.";
    case "requeued":
      return "Marked not published and requeued.";
    case "retry_now":
      return "Retry started now.";
    case "retry_requeue":
      return "Retry requeued into the next free slot.";
    case "retry_at":
      return "Retry scheduled.";
    case "bulk_retry":
      return details.mode === "requeue" ? "Retried in bulk: requeued into the next free slot." : "Retried in bulk.";
  }
}

export type ActivityActor =
  | { kind: "scheduler" }
  | { kind: "member"; name: string | null }
  | { kind: "api_key"; name: string | null };

export function activityActorLabel(actor: ActivityActor): string {
  switch (actor.kind) {
    case "scheduler":
      return "Scheduler";
    case "member":
      return actor.name ?? "Former member";
    case "api_key":
      return actor.name ? `API key ${actor.name}` : "Removed API key";
  }
}

export function outcomeLabel(o: ActivityOutcome): string {
  return OUTCOME_LABEL[o];
}
