import type { TargetPatch } from "../../dal/targets";

/** An explicit instant with no held occurrence: the five columns every explicit schedule sets together. */
export function explicitSchedulePatch(
  kind: "explicit" | "now",
  when: Date,
): Pick<TargetPatch, "scheduleKind" | "scheduledAt" | "nextAttemptAt" | "slotOccurrenceAt" | "slotId"> {
  return { scheduleKind: kind, scheduledAt: when, nextAttemptAt: when, slotOccurrenceAt: null, slotId: null };
}
