// services/engagement/inbox: the read side of the engagement inbox (contracts/services.md §2).
import { findProvider } from "../../../providers/registry";
import type { EngagementDraftRow, EngagementItemRow } from "../../dal";
import { NotFoundError } from "../../dal/errors";
import { requirePermission, type ProjectScope } from "../../dal/scope";

export const INBOX_PAGE_SIZE = 25;

export interface InboxParent {
  /** The brand's own post, resolved by `parent_post_target_id`; no claim is made about a reference that isn't ours. */
  kind: "docket_post" | "external_reference";
  text: string | null;
  externalId: string | null;
}

export interface ReplyableVerdict {
  ok: boolean;
  reason?: string;
}

export interface InboxItemView {
  id: string;
  providerKey: string;
  socialAccount: { id: string; displayName: string };
  kind: EngagementItemRow["kind"];
  state: EngagementItemRow["state"];
  externalId: string;
  text: string;
  textTruncated: boolean;
  author: {
    displayName: string | null;
    handle: string | null;
    externalId: string | null;
    url: string | null;
    identityStable: boolean;
    reachable: boolean;
  };
  saidAt: Date;
  parent: InboxParent | null;
  newerOnSameParent: number;
  withdrawnAt: Date | null;
  editedUpstreamAt: Date | null;
  drafts: EngagementDraftRow[];
  replyable: ReplyableVerdict;
}

async function resolveParent(scope: ProjectScope, item: EngagementItemRow): Promise<InboxParent | null> {
  if (item.parentPostTargetId) {
    const content = await scope.targets.effectiveContent(item.parentPostTargetId);
    if (content) return { kind: "docket_post", text: content.text, externalId: null };
  }
  if (item.parentExternalId) return { kind: "external_reference", text: null, externalId: item.parentExternalId };
  return null;
}

async function replyableVerdict(scope: ProjectScope, item: EngagementItemRow, drafts: EngagementDraftRow[]): Promise<ReplyableVerdict> {
  if (item.withdrawnAt) return { ok: false, reason: "The original was withdrawn." };
  if (!item.authorReachable) return { ok: false, reason: "The author is no longer reachable." };
  if (item.state === "answered") return { ok: false, reason: "Already answered." };
  if (item.state === "dismissed") return { ok: false, reason: "Dismissed." };
  const account = await scope.accounts.get(item.socialAccountId);
  if (!account || account.removedAt) return { ok: false, reason: "The account is no longer connected." };
  if (account.status === "needs_reauth") return { ok: false, reason: "The account needs reconnecting." };
  const provider = findProvider(account.providerKey);
  if (!provider?.engagement?.declaration.canReply) return { ok: false, reason: "This platform cannot be replied to through Docket." };
  if (item.text.trim() === "" && drafts.length === 0) return { ok: false, reason: "The item has no text to reply to." };
  const claim = await scope.engagementReplyClaims.latest(item.socialAccountId, item.externalId);
  if (claim && claim.releaseReason === null) return { ok: false, reason: "A reply is already in progress for this item." };
  return { ok: true };
}

async function toView(scope: ProjectScope, item: EngagementItemRow): Promise<InboxItemView> {
  const [account, drafts, parent, newerOnSameParent] = await Promise.all([
    scope.accounts.get(item.socialAccountId),
    scope.engagementDrafts.listByItem(item.id),
    resolveParent(scope, item),
    item.parentExternalId ? scope.engagementItems.countNewerOnSameParent(item.parentExternalId, item.saidAt) : Promise.resolve(0),
  ]);
  return {
    id: item.id,
    providerKey: item.providerKey,
    socialAccount: { id: item.socialAccountId, displayName: account?.displayName ?? item.providerKey },
    kind: item.kind,
    state: item.state,
    externalId: item.externalId,
    text: item.text,
    textTruncated: item.textTruncated,
    author: {
      displayName: item.authorDisplayName,
      handle: item.authorHandle,
      externalId: item.authorExternalId,
      url: item.authorUrl,
      identityStable: item.authorIdentityStable,
      reachable: item.authorReachable,
    },
    saidAt: item.saidAt,
    parent,
    newerOnSameParent,
    withdrawnAt: item.withdrawnAt,
    editedUpstreamAt: item.editedUpstreamAt,
    drafts,
    replyable: await replyableVerdict(scope, item, drafts),
  };
}

export interface ListInboxInput {
  socialAccountId?: string;
  kind?: EngagementItemRow["kind"];
  state?: EngagementItemRow["state"];
  page?: number;
}

export async function listInbox(
  scope: ProjectScope,
  input: ListInboxInput = {},
): Promise<{ items: InboxItemView[]; page: number; pageSize: number; total: number }> {
  requirePermission(scope, { engagement: ["view"] });
  const page = Math.max(1, input.page ?? 1);
  const filter = { socialAccountId: input.socialAccountId, state: input.state, kind: input.kind };
  const [rows, total] = await Promise.all([
    scope.engagementItems.list({ ...filter, limit: INBOX_PAGE_SIZE, offset: (page - 1) * INBOX_PAGE_SIZE }),
    scope.engagementItems.count(filter),
  ]);
  const items = await Promise.all(rows.map((row) => toView(scope, row)));
  return { items, page, pageSize: INBOX_PAGE_SIZE, total };
}

/** `0` without the permission — never computed, so the nav badge discloses nothing (FR-037). */
export async function countInboxWaiting(scope: ProjectScope): Promise<number> {
  if (!scope.can({ engagement: ["view"] })) return 0;
  return scope.engagementItems.countWaiting();
}

export async function getInboxItem(scope: ProjectScope, id: string): Promise<InboxItemView> {
  requirePermission(scope, { engagement: ["view"] });
  const row = await scope.engagementItems.get(id);
  if (!row) throw new NotFoundError("Engagement item not found.");
  return toView(scope, row);
}

export interface EngagementAccountView {
  id: string;
  displayName: string;
  providerKey: string;
  providerDisplayName: string;
  autoDraft: boolean;
  unavailable: { reason: string; docsPath?: string } | null;
}

/** Only accounts whose provider declares `engagement`; a provider with no member is simply absent (FR-053). */
export async function listEngagementAccounts(scope: ProjectScope): Promise<EngagementAccountView[]> {
  requirePermission(scope, { engagement: ["view"] });
  const accounts = await scope.accounts.list();
  const out: EngagementAccountView[] = [];
  for (const account of accounts) {
    if (account.removedAt) continue;
    const provider = findProvider(account.providerKey);
    if (!provider?.engagement) continue;
    const state = await scope.engagementAccountStates.get(account.id);
    out.push({
      id: account.id,
      displayName: account.displayName,
      providerKey: account.providerKey,
      providerDisplayName: provider.displayName,
      autoDraft: state?.autoDraft ?? false,
      unavailable: provider.engagement.declaration.unavailable ?? null,
    });
  }
  return out;
}

export async function setAutoDraft(scope: ProjectScope, accountId: string, on: boolean): Promise<void> {
  requirePermission(scope, { account: ["manage"] });
  await scope.engagementAccountStates.ensure(accountId);
  await scope.engagementAccountStates.setAutoDraft(accountId, on);
}
