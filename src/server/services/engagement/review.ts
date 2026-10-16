// services/engagement/review: the review of drafted replies (contracts/services.md §4, FR-028–FR-036).
import { z } from "zod";
import { findProvider } from "../../../providers/registry";
import { countText, countingRuleName } from "../../../providers/text";
import type { EngagementDraftRow, EngagementItemRow } from "../../dal";
import { NotFoundError } from "../../dal/errors";
import { requirePermission, type ProjectScope } from "../../dal/scope";
import * as clock from "../../dal/clock";
import { REJECT_REASON_MAX } from "../review";
import { decide, serialized, type Decidable } from "../review/decide";

export const REPLY_QUEUE_PAGE_SIZE = 25;

export type ReplyDecisionRefusal =
  | "already_answered"
  | "empty_text"
  | "withdrawn"
  | "edited_upstream"
  | "not_replyable"
  | "over_limit";

export type ApproveReplyResult = { ok: true } | { ok: false; code: "already_decided" | ReplyDecisionRefusal; message: string };
export type RejectReplyResult = { ok: true } | { ok: false; code: "already_decided"; message: string };

export interface ReplyQueueRow {
  draft: EngagementDraftRow;
  itemId: string;
  itemText: string;
  kind: EngagementItemRow["kind"];
  parentText: string | null;
  author: { displayName: string | null; handle: string | null };
  account: { id: string; displayName: string };
  count: number;
  limit: number;
  countingRule: string;
}

async function toReplyQueueRow(scope: ProjectScope, draft: EngagementDraftRow): Promise<ReplyQueueRow | null> {
  const item = await scope.engagementItems.get(draft.engagementItemId);
  if (!item) return null;
  const account = await scope.accounts.get(draft.socialAccountId);
  const provider = account ? findProvider(account.providerKey) : null;
  const caps = provider?.capabilities.text ?? { maxLength: 0, countingRule: "code_points" as const };
  let parentText: string | null = null;
  if (item.parentPostTargetId) {
    const content = await scope.targets.effectiveContent(item.parentPostTargetId);
    parentText = content?.text ?? null;
  }
  return {
    draft,
    itemId: item.id,
    itemText: item.text,
    kind: item.kind,
    parentText,
    author: { displayName: item.authorDisplayName, handle: item.authorHandle },
    account: { id: draft.socialAccountId, displayName: account?.displayName ?? item.providerKey },
    count: countText(draft.text, caps.countingRule),
    limit: caps.maxLength,
    countingRule: countingRuleName(caps.countingRule),
  };
}

export async function listReplyQueue(
  scope: ProjectScope,
  page = 1,
): Promise<{ items: ReplyQueueRow[]; page: number; pageSize: number; total: number }> {
  requirePermission(scope, { engagement: ["view"] });
  const [drafts, total] = await Promise.all([
    scope.engagementDrafts.listQueue({ limit: REPLY_QUEUE_PAGE_SIZE, offset: (page - 1) * REPLY_QUEUE_PAGE_SIZE }),
    scope.engagementDrafts.countQueue(),
  ]);
  const rows = await Promise.all(drafts.map((d) => toReplyQueueRow(scope, d)));
  return { items: rows.filter((r): r is ReplyQueueRow => r !== null), page, pageSize: REPLY_QUEUE_PAGE_SIZE, total };
}

/** `0` without the permission — never computed (FR-037). */
export async function countReplyQueue(scope: ProjectScope): Promise<number> {
  if (!scope.can({ engagement: ["view"] })) return 0;
  return scope.engagementDrafts.countQueue();
}

const draftDecidable: Decidable<EngagementDraftRow> = {
  lock: (tx, id) => tx.engagementDrafts.lockForUpdate(id),
  isUndecided: (draft) => draft.reviewState === "needs_review",
  decidedMessage: (draft) => (draft.reviewState === "rejected" ? "This reply was rejected." : "This reply was already decided."),
};

/**
 * Approves a draft inside the shared `decide()` core. The project's `default_approval_policy` is
 * deliberately never read on this path (FR-029, SC-003): the reply waits for a person regardless of
 * `auto_approve`.
 */
export async function approveReply(scope: ProjectScope, draftId: string): Promise<ApproveReplyResult> {
  requirePermission(scope, { engagement: ["reply"] });
  const id = z.uuid().parse(draftId);
  return serialized(`engagement-draft:${id}`, () =>
    decide(scope, id, draftDecidable, async (tx, draft): Promise<ApproveReplyResult> => {
      if (draft.text.trim() === "") return { ok: false, code: "empty_text", message: "An empty reply cannot be approved." };
      const item = await tx.engagementItems.get(draft.engagementItemId);
      if (!item) throw new NotFoundError();
      const account = await tx.accounts.get(draft.socialAccountId);
      const provider = account ? findProvider(account.providerKey) : null;
      const caps = provider?.capabilities.text ?? { maxLength: 0, countingRule: "code_points" as const };
      if (countText(draft.text, caps.countingRule) > caps.maxLength) {
        return { ok: false, code: "over_limit", message: "This reply is over the platform's text limit." };
      }
      if (item.withdrawnAt) return { ok: false, code: "withdrawn", message: "The original was withdrawn." };
      if (item.editedUpstreamAt && !draft.acknowledgedEditAt) {
        return { ok: false, code: "edited_upstream", message: "The original changed; look at it again before approving." };
      }
      const claim = await tx.engagementReplyClaims.latest(draft.socialAccountId, item.externalId);
      if (claim && claim.releasedAt === null) {
        return { ok: false, code: "already_answered", message: "A reply is already in progress for this item." };
      }
      const now = await clock.now();
      await tx.engagementDrafts.update(draft.id, {
        reviewState: "approved",
        reviewedAt: now,
        reviewedByUserId: tx.membership.userId,
        sendState: "waiting",
      });
      await tx.engagementDrafts.discardSiblings(draft.engagementItemId, draft.id);
      return { ok: true };
    }),
  );
}

export async function rejectReply(scope: ProjectScope, draftId: string, reason?: string): Promise<RejectReplyResult> {
  requirePermission(scope, { engagement: ["reply"] });
  const id = z.uuid().parse(draftId);
  const trimmedReason = z.string().trim().max(REJECT_REASON_MAX).nullish().parse(reason ?? null);
  return decide(scope, id, draftDecidable, async (tx, draft) => {
    await tx.engagementDrafts.update(draft.id, {
      reviewState: "rejected",
      reviewedAt: await clock.now(),
      reviewedByUserId: tx.membership.userId,
      rejectionReason: trimmedReason ?? null,
    });
    return { ok: true as const };
  });
}

const dismissSchema = z.array(z.uuid()).min(1).max(100);

/** Bulk is allowed here and only here (FR-033). Records who and when, discards pending drafts. */
export async function dismissItems(scope: ProjectScope, itemIds: string[]): Promise<{ dismissed: number }> {
  requirePermission(scope, { engagement: ["reply"] });
  const ids = dismissSchema.parse(itemIds);
  const now = await clock.now();
  let dismissed = 0;
  for (const id of [...new Set(ids)]) {
    const item = await scope.engagementItems.get(id);
    if (!item || item.state !== "waiting") continue;
    await scope.engagementItems.markDismissed(id, now, scope.membership.userId);
    for (const draft of await scope.engagementDrafts.listByItem(id)) {
      if (draft.reviewState === "needs_review") await scope.engagementDrafts.update(draft.id, { reviewState: "discarded" });
    }
    dismissed++;
  }
  return { dismissed };
}
