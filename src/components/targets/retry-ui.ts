import type { ExplicitTimePreview } from "@/server/services/posts";
import type { RequeuePreview } from "@/server/services/failures";
import type { RetryResult } from "@/server/services/posts";

export type RetryMode = "now" | "requeue" | "at";

export function canConfirm(mode: RetryMode, preview: RequeuePreview | "loading" | null, timePreview: ExplicitTimePreview | null): boolean {
  if (mode === "now") return true;
  if (mode === "requeue") return typeof preview === "object" && preview !== null && preview.ok;
  return timePreview !== null && !timePreview.inPast;
}

export function retryAnnouncement(result: Extract<RetryResult, { status: "scheduled" }>): string {
  if (result.mode === "now") return "Retry queued for the next tick.";
  if (result.mode === "requeue") {
    return `Retry scheduled for ${result.localTime} in the next free slot.${result.changedFromPreview ? " The previewed slot was taken, so the time changed." : ""}`;
  }
  return `Retry scheduled for ${result.localTime}.${result.warnings.map((w) => ` ${w.message}`).join("")}`;
}

export function confirmLabel(mode: RetryMode): string {
  if (mode === "now") return "Retry now";
  if (mode === "requeue") return "Retry in next free slot";
  return "Retry at this time";
}
