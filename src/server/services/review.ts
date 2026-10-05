// review: the queue of generated posts waiting for a human decision (contracts/services.md § Review).
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { countText, countingRuleName } from "@/providers/text";
import type { ValidationIssue } from "@/providers/types";
import { generationRecordSchema } from "@/lib/validation/generation";
import * as clock from "../dal/clock";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import { REVIEW_QUEUE_PAGE_SIZE, type PostRecord } from "../dal/posts";
import type { ProjectScope, SchedulingPolicy } from "../dal/scope";
import type { TargetRecord } from "../dal/targets";
import { prepareVariants } from "./media-variants";
import { applyDerivedStatus, gate, lockPost, queueTargetsInTx, type TargetResult } from "./posts";
import { variantGroupsForPost } from "./posts/variant-groups";
import { loadTargetContent, validateTargetContent } from "./posts/validate";
import type { PlannedTime } from "./queue";

export const BULK_APPROVE_MAX = 100;
export const REJECT_REASON_MAX = 500;

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1) });
const approveSchema = z.object({
  edits: z.array(z.object({ accountIds: z.array(z.uuid()).min(1).max(50), text: z.string() })).max(50).optional(),
});
const rejectSchema = z.object({
  reason: z.string().trim().max(REJECT_REASON_MAX, { error: "The reason can be at most 500 characters" }).nullish(),
});
const bulkSchema = z.object({
  postIds: z
    .array(z.uuid())
    .min(1, { error: "Select at least one post" })
    .max(BULK_APPROVE_MAX, { error: "Select at most 100 posts" }),
});

export interface ReviewVariant {
  /** The variant key: the platform, or `<platform>_<n>` when the post has several variants for it. */
  key: string;
  providerKey: string;
  displayName: string;
  text: string;
  accountIds: string[];
  accountNames: string[];
  count: number;
  limit: number;
  countingRule: string;
  issues: ValidationIssue[];
}

export interface ReviewItem {
  postId: string;
  createdAt: Date;
  variants: ReviewVariant[];
  mediaIds: string[];
  voice: { name: string; version: number } | null;
  brief: string | null;
  schedulingPolicy: SchedulingPolicy | null;
  blocking: boolean;
}

function need(scope: Pick<ProjectScope, "can">, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

const liveTargets = (all: TargetRecord[]) => all.filter((t) => t.status !== "cancelled");

async function buildItem(scope: ProjectScope, post: PostRecord): Promise<ReviewItem> {
  const targets = liveTargets(await scope.targets.listForPost(post.id));
  const byId = new Map(targets.map((t) => [t.id, t]));
  const variants: ReviewVariant[] = [];
  for (const group of await variantGroupsForPost(scope, post, targets)) {
    const first = byId.get(group.targetIds[0]!)!;
    const account = await scope.accounts.get(first.socialAccountId);
    if (!account) continue;
    const provider = findProvider(group.providerKey);
    const content = await loadTargetContent(scope, first);
    const issues = content ? ((await validateTargetContent(scope, account, content, { preview: true })) ?? []) : [];
    const rule = provider?.capabilities.text.countingRule ?? null;
    const text = content?.text ?? first.overrideText ?? post.baseText;
    variants.push({
      key: group.key,
      providerKey: group.providerKey,
      displayName: group.providerName,
      text,
      accountIds: group.accountIds,
      accountNames: group.accountNames,
      count: rule ? countText(text, rule) : text.length,
      limit: provider?.capabilities.text.maxLength ?? 0,
      countingRule: rule ? countingRuleName(rule) : "characters",
      issues,
    });
  }
  const meta = post.generationMetadata as { records?: unknown[] } | null;
  const parsed = generationRecordSchema.safeParse(meta?.records?.at(-1));
  const record = parsed.success ? parsed.data : null;
  return {
    postId: post.id,
    createdAt: post.createdAt,
    variants,
    mediaIds: await scope.posts.listMediaIds(post.id),
    voice: record ? { name: record.voiceProfile.name, version: record.voiceProfile.version } : null,
    brief: record?.inputs.brief ?? null,
    schedulingPolicy: post.schedulingPolicy ?? null,
    blocking: variants.some((v) => v.issues.some((i) => i.severity === "error")),
  };
}

export async function listReviewQueue(
  scope: ProjectScope,
  input: unknown,
): Promise<{ items: ReviewItem[]; total: number; page: number; pageSize: typeof REVIEW_QUEUE_PAGE_SIZE }> {
  const { page } = pageSchema.parse(input ?? {});
  need(scope, { post: ["view"] });
  const { rows, total } = await scope.posts.listReviewQueue(page);
  const items: ReviewItem[] = [];
  for (const row of rows) items.push(await buildItem(scope, row));
  return { items, total, page, pageSize: REVIEW_QUEUE_PAGE_SIZE };
}

/** How many posts wait for review (the navigation badge). */
export async function countReviewQueue(scope: ProjectScope): Promise<number> {
  if (!scope.can({ post: ["view"] })) return 0;
  return (await scope.posts.listReviewQueue(1)).total;
}

export type ApproveResult =
  | { ok: true; queued: TargetResult<PlannedTime & { changedFromPreview: boolean }>[] }
  | { ok: false; code: "already_reviewed" | "validation"; message: string; issues?: Record<string, ValidationIssue[]> };

const alreadyReviewed = (post: PostRecord): { ok: false; code: "already_reviewed"; message: string } => ({
  ok: false,
  code: "already_reviewed",
  message: post.reviewState === "rejected" ? "This post was rejected." : "This post was already approved.",
});

/**
 * Same-process decisions on one post wait their turn here instead of each parking a pooled connection on the
 * row lock: the winner still needs the pool (`clock.now`) inside its transaction, so a burst of duplicate
 * clicks could otherwise exhaust it. The row lock stays the arbiter across processes.
 */
const decisions = new Map<string, Promise<unknown>>();
async function serialized<T>(postId: string, run: () => Promise<T>): Promise<T> {
  const previous = decisions.get(postId) ?? Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.catch(() => undefined);
  decisions.set(postId, tail);
  try {
    return await current;
  } finally {
    if (decisions.get(postId) === tail) decisions.delete(postId);
  }
}

export async function approvePost(scope: ProjectScope, postId: string, input?: unknown): Promise<ApproveResult> {
  const id = z.uuid().parse(postId);
  const { edits } = approveSchema.parse(input ?? {});
  need(scope, { post: ["edit", "schedule"] });
  return serialized(id, () => approveSerialized(scope, id, edits));
}

async function approveSerialized(
  scope: ProjectScope,
  id: string,
  edits: z.infer<typeof approveSchema>["edits"],
): Promise<ApproveResult> {
  const current = await scope.posts.get(id);
  if (!current) throw new NotFoundError();
  if (current.reviewState !== "needs_review") return alreadyReviewed(current);
  try {
    await prepareVariants(scope, id);
  } catch {
    // Reported per target by the gate.
  }
  return scope.transaction(async (tx): Promise<ApproveResult> => {
    need(tx, { post: ["edit", "schedule"] });
    const post = await lockPost(tx, id);
    if (post.reviewState !== "needs_review") return alreadyReviewed(post);

    const targets = await tx.targets.listForPost(id);
    const draft = targets.filter((t) => t.status === "draft");
    if (edits && edits.length > 0) {
      const byAccount = new Map<string, string>();
      for (const e of edits) for (const accountId of e.accountIds) byAccount.set(accountId, e.text);
      for (const t of draft) {
        const text = byAccount.get(t.socialAccountId);
        if (text !== undefined) await tx.targets.update(t.id, { overrideText: text });
      }
    }

    const fresh = await tx.targets.listForPost(id);
    const issues: Record<string, ValidationIssue[]> = {};
    let first: string | null = null;
    const keyOf = new Map<string, string>();
    for (const group of await variantGroupsForPost(tx, post, liveTargets(fresh))) {
      for (const accountId of group.accountIds) keyOf.set(accountId, group.key);
    }
    for (const t of fresh.filter((x) => x.status === "draft")) {
      const g = await gate(tx, t);
      if (g.ok || g.code !== "validation") continue;
      const account = await tx.accounts.get(t.socialAccountId);
      const key = keyOf.get(t.socialAccountId) ?? account?.providerKey ?? "";
      issues[key] = g.issues ?? [];
      first ??= g.message;
    }
    if (first !== null) {
      await applyDerivedStatus(tx, id);
      return { ok: false, code: "validation", message: first, issues };
    }

    await tx.posts.update(id, { reviewState: "approved", reviewedAt: await clock.now(), reviewedByUserId: tx.membership.userId });
    let queued: Extract<ApproveResult, { ok: true }>["queued"] = [];
    if (post.schedulingPolicy === "add_to_queue") {
      const approved = await tx.posts.get(id);
      if (!approved) throw new NotFoundError();
      queued = await queueTargetsInTx(tx, approved, fresh.filter((t) => t.status === "draft"));
    }
    await applyDerivedStatus(tx, id);
    return { ok: true, queued };
  });
}

export async function rejectPost(
  scope: ProjectScope,
  postId: string,
  input?: unknown,
): Promise<{ ok: true } | { ok: false; code: "already_reviewed"; message: string }> {
  const id = z.uuid().parse(postId);
  const { reason } = rejectSchema.parse(input ?? {});
  need(scope, { post: ["edit"] });
  return scope.transaction(async (tx) => {
    need(tx, { post: ["edit"] });
    const post = await lockPost(tx, id);
    if (post.reviewState !== "needs_review") return alreadyReviewed(post);
    await tx.posts.update(id, {
      reviewState: "rejected",
      rejectionReason: reason?.trim() ? reason.trim() : null,
      reviewedAt: await clock.now(),
      reviewedByUserId: tx.membership.userId,
    });
    await applyDerivedStatus(tx, id);
    return { ok: true as const };
  });
}

export interface BulkApproveResult {
  approved: { postId: string; queued: number; unscheduled: { accountName: string; message: string }[] }[];
  skipped: { postId: string; reason: string }[];
}

export async function bulkApprove(scope: ProjectScope, input: unknown): Promise<BulkApproveResult> {
  const { postIds } = bulkSchema.parse(input);
  need(scope, { post: ["edit", "schedule"] });
  const names = new Map((await scope.accounts.list()).map((a) => [a.id, a.displayName]));
  const out: BulkApproveResult = { approved: [], skipped: [] };
  for (const postId of [...new Set(postIds)]) {
    try {
      const r = await approvePost(scope, postId);
      if (!r.ok) {
        out.skipped.push({ postId, reason: r.message });
        continue;
      }
      out.approved.push({
        postId,
        queued: r.queued.filter((q) => q.ok).length,
        unscheduled: r.queued.flatMap((q) =>
          q.ok ? [] : [{ accountName: names.get(q.accountId) ?? "An account", message: q.message }],
        ),
      });
    } catch (error) {
      if (error instanceof NotFoundError) out.skipped.push({ postId, reason: "Not found" });
      else throw error;
    }
  }
  return out;
}
