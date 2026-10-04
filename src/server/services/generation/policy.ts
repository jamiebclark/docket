// generation/policy: how a generated post is reviewed and queued (contracts/services.md § Policy).
import { z } from "zod";
import { CONFIRM_UNREVIEWED_QUEUE_MESSAGE } from "@/lib/validation/policies";
import { generationMetadataSchema } from "@/lib/validation/generation";
import { NotFoundError, PolicyNotAllowedError, ConflictError } from "../../dal/errors";
import type { ApprovalPolicy, ProjectScope, SchedulingPolicy } from "../../dal/scope";
import * as clock from "../../dal/clock";
import { prepareVariants } from "../media-variants";
import { applyDerivedStatus, gate, lockPost, queueTargetsInTx, type TargetResult } from "../posts";
import type { PlannedTime } from "../queue";

export interface PolicyDecision {
  reviewState: "needs_review" | "approved";
  queue: boolean;
  reason: string;
}

export interface ResolvedPolicies {
  approval: ApprovalPolicy;
  scheduling: SchedulingPolicy;
}

export function decidePolicy(input: {
  approval: ApprovalPolicy;
  scheduling: SchedulingPolicy;
  blocking: { providerKey: string; message: string }[];
}): PolicyDecision {
  const first = input.blocking[0];
  if (first) return { reviewState: "needs_review", queue: false, reason: `Forced to review: ${first.message}` };
  if (input.approval === "review_required") {
    return { reviewState: "needs_review", queue: false, reason: "Review required by policy" };
  }
  if (input.scheduling === "add_to_queue") {
    return { reviewState: "approved", queue: true, reason: "Approved and queued automatically" };
  }
  return { reviewState: "approved", queue: false, reason: "Approved automatically" };
}

export { CONFIRM_UNREVIEWED_QUEUE_MESSAGE };

export function resolvePolicies(
  scope: ProjectScope,
  req: { approval?: ApprovalPolicy | null; scheduling?: SchedulingPolicy | null; confirmUnreviewedQueue?: boolean },
): {
  requested: { approval: ApprovalPolicy | null; scheduling: SchedulingPolicy | null };
  resolved: ResolvedPolicies;
} {
  const approval = req.approval ?? scope.project.defaultApprovalPolicy;
  const scheduling = req.scheduling ?? scope.project.defaultSchedulingPolicy;
  if (
    approval === "auto_approve" &&
    approval !== scope.project.defaultApprovalPolicy &&
    !scope.can({ generation: ["auto_approve"] })
  ) {
    throw new PolicyNotAllowedError("Only owners and admins can auto-approve", "approval");
  }
  if (approval === "auto_approve" && scheduling === "add_to_queue" && req.confirmUnreviewedQueue !== true) {
    throw new z.ZodError([
      { code: "custom", path: ["confirmUnreviewedQueue"], message: CONFIRM_UNREVIEWED_QUEUE_MESSAGE, input: undefined },
    ]);
  }
  return {
    requested: { approval: req.approval ?? null, scheduling: req.scheduling ?? null },
    resolved: { approval, scheduling },
  };
}

/**
 * Applies the resolved policy to a freshly generated post: approves it (and optionally queues it) or leaves it
 * in review. Only `validation` failures from the gate force review; an unavailable account is reported by
 * queueing instead.
 */
export async function applyApprovalPolicy(
  scope: ProjectScope,
  postId: string,
  resolved: ResolvedPolicies,
): Promise<{ decision: PolicyDecision; queued: TargetResult<PlannedTime & { changedFromPreview: boolean }>[] }> {
  try {
    await prepareVariants(scope, postId);
  } catch {
    // Reported per target by the gate.
  }
  return scope.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    if (post.reviewState !== "needs_review") throw new ConflictError("This post was already reviewed.");
    const targets = (await tx.targets.listForPost(postId)).filter((t) => t.status === "draft");
    const blocking: { providerKey: string; message: string }[] = [];
    for (const t of targets) {
      const g = await gate(tx, t);
      if (g.ok || g.code !== "validation") continue;
      const account = await tx.accounts.get(t.socialAccountId);
      blocking.push({ providerKey: account?.providerKey ?? "", message: g.message });
    }
    const decision = decidePolicy({ ...resolved, blocking });
    let queued: TargetResult<PlannedTime & { changedFromPreview: boolean }>[] = [];
    if (decision.reviewState === "approved") {
      await tx.posts.update(postId, { reviewState: "approved", reviewedAt: await clock.now(), reviewedByUserId: null });
      if (decision.queue) {
        const fresh = await tx.posts.get(postId);
        if (!fresh) throw new NotFoundError();
        queued = await queueTargetsInTx(tx, fresh, targets);
      }
    }
    await applyDerivedStatus(tx, postId);
    const latest = await tx.posts.get(postId);
    const meta = generationMetadataSchema.safeParse(latest?.generationMetadata);
    if (meta.success && meta.data.records.length > 0) {
      const records = [...meta.data.records];
      const last = records[records.length - 1]!;
      records[records.length - 1] = {
        ...last,
        policies: {
          ...last.policies,
          decision: { reviewState: decision.reviewState, queued: decision.queue, reason: decision.reason },
        },
      };
      await tx.posts.update(postId, { generationMetadata: { v: 1, records } });
    }
    return { decision, queued };
  });
}
