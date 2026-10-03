import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { applyDerivedStatus } from "./status";

const CLEARED = {
  slotOccurrenceAt: null,
  slotId: null,
  nextAttemptAt: null,
  stepState: null,
  inFlightStep: null,
  inFlightMayPublish: null,
  leaseOwner: null,
  leaseUntil: null,
} as const;

export function hasLiveLease(target: Pick<TargetRecord, "leaseUntil">, now: Date): boolean {
  return target.leaseUntil !== null && target.leaseUntil.getTime() >= now.getTime();
}

/** Cancels one open target and frees its occurrence. The caller holds the post lock and re-derives the status. */
export async function cancelTargetRow(tx: Pick<ProjectScope, "targets">, targetId: string): Promise<void> {
  await tx.targets.update(targetId, { status: "cancelled", ...CLEARED }, { statuses: ["draft", "scheduled", "publishing"] });
}

/** When a cancel leaves a post with no live targets, it returns to `draft` (D11); then the status is re-derived. */
export async function resetEmptyReview(tx: Pick<ProjectScope, "posts" | "targets">, postId: string): Promise<void> {
  const targets = await tx.targets.listForPost(postId);
  if (targets.every((t) => t.status === "draft" || t.status === "cancelled")) {
    await tx.posts.update(postId, { reviewState: "draft" });
  }
  await applyDerivedStatus(tx, postId);
}
