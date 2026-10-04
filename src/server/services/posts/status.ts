import type { PostRecord } from "../../dal/posts";
import { emitEvent, type EmitRepos } from "../webhooks/emit";
import type { TargetStatus as PostTargetStatus } from "../../dal/targets";

type PostStatus = PostRecord["status"];

type ReviewState = "draft" | "needs_review" | "approved" | "rejected";

/** FR-029. Live targets exclude `draft` and `cancelled`; `ambiguous` counts as not published. */
export function derivePostStatus(reviewState: ReviewState, statuses: readonly PostTargetStatus[]): PostStatus {
  const live = statuses.filter((s) => s !== "draft" && s !== "cancelled");
  if (live.length === 0) return reviewState;
  if (live.includes("publishing")) return "publishing";
  if (live.includes("scheduled")) return "scheduled";
  if (live.every((s) => s === "published")) return "published";
  if (!live.includes("published")) return "failed";
  return "partially_failed";
}

type Repos = EmitRepos;

/**
 * Locks the post (its own statement), re-reads its targets and writes `posts.status`.
 * Call inside the transaction that changed a target. Returns the new status, or `null` for a deleted post.
 */
export async function applyDerivedStatus(tx: Repos, postId: string): Promise<PostStatus | null> {
  const post = await tx.posts.lockForUpdate(postId);
  if (!post) return null;
  const targets = await tx.targets.listForPost(postId);
  const status = derivePostStatus(post.reviewState, targets.map((t) => t.status));
  if (status !== post.status) {
    await tx.posts.setStatus(postId, status);
    if (status === "published") await emitEvent(tx, "post.published", { postId });
    else if (status === "failed" || status === "partially_failed") await emitEvent(tx, "post.failed", { postId });
  }
  return status;
}
