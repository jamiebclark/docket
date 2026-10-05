import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import type { EmitRepos } from "../webhooks/emit";
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

/**
 * Only an all-cancelled post returns to `draft` (FR-029). A post that still has draft targets
 * keeps its editorial state, so cancelling one target of a `needs_review` post never lets it
 * skip review (re-review F22). Then the status is re-derived.
 */
export async function resetEmptyReview(tx: EmitRepos, postId: string): Promise<void> {
  const targets = await tx.targets.listForPost(postId);
  if (targets.length > 0 && targets.every((t) => t.status === "cancelled")) {
    await tx.posts.update(postId, { reviewState: "draft" });
  }
  await applyDerivedStatus(tx, postId);
}
