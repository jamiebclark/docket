// scheduler/engagement-send: sending an approved reply (contracts/services.md §5, FR-038–FR-045).
import { findProvider } from "../../providers/registry";
import { countText } from "../../providers/text";
import type { EngagementItemKind, EngagementSendResult } from "../../providers/types";
import { claimDueEngagementSends, type ClaimedEngagementDraft } from "../dal/engagement-claims";
import * as clock from "../dal/clock";
import { forSchedulerProject, writesStartedSince } from "../dal/scheduler";
import { writeHeartbeat } from "../dal/heartbeats";
import { decryptCredentials } from "../services/accounts";
import { engagementConfig, type SchedulerConfig } from "./config";
import { mayAttemptReply, stricterBudget, windowStart } from "./engagement-budget";
import { markInvalidEmitting } from "./credentials";
import { redact, secretValues } from "./redact";

export interface EngagementSendCounts {
  claimed: number;
  sent: number;
  duplicate: number;
  ambiguous: number;
  failed: number;
  credentialsInvalid: number;
  waitingAllowance: number;
  waitingGate: number;
  alreadyAnswered: number;
}

export const emptyEngagementSendCounts = (): EngagementSendCounts => ({
  claimed: 0,
  sent: 0,
  duplicate: 0,
  ambiguous: 0,
  failed: 0,
  credentialsInvalid: 0,
  waitingAllowance: 0,
  waitingGate: 0,
  alreadyAnswered: 0,
});

const CLAIM_BATCH = 50;

/**
 * Claim → reserve check → gate → ledger claim → provider `send()` → record outcome
 * (contracts/services.md §5). Runs after publishing has resolved for the tick (FR-042).
 */
export async function runEngagementSend(opts: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<EngagementSendCounts> {
  const cfg = engagementConfig(opts.config);
  const counts = emptyEngagementSendCounts();
  const now = await clock.now();
  const claimed = await claimDueEngagementSends({ now, limit: CLAIM_BATCH, leaseMs: opts.config.leaseMs });
  counts.claimed = claimed.length;
  const sentThisRun = new Map<string, number>();
  for (const claim of claimed) {
    await processClaim(claim, { config: opts.config, cfg, counts, sentThisRun });
  }
  await writeHeartbeat("engagement_send", await clock.now(), { ...counts });
  return counts;
}

async function processClaim(
  claim: ClaimedEngagementDraft,
  ctx: { config: SchedulerConfig; cfg: ReturnType<typeof engagementConfig>; counts: EngagementSendCounts; sentThisRun: Map<string, number> },
): Promise<void> {
  const { draft, token } = claim;
  const { counts } = ctx;
  const repos = forSchedulerProject(draft.projectId);

  const back = (patch: { sendState: "waiting" | "ambiguous" | "failed"; sendWaitReason?: string | null; lastError?: string | null; sendNotBefore?: Date | null }) =>
    repos.engagementDrafts.update(
      draft.id,
      { ...patch, sendLeaseUntil: null, sendLeaseOwner: null, sendWaitReason: patch.sendWaitReason ?? null, lastError: patch.lastError ?? null },
      token,
    );

  const account = await repos.accounts.get(draft.socialAccountId);
  const provider = account ? findProvider(account.providerKey) : null;
  if (!account || account.removedAt || account.status !== "active" || !provider?.engagement?.declaration.canReply) {
    counts.waitingGate++;
    await back({ sendState: "waiting", lastError: "The account is not available to reply right now." });
    return;
  }
  const item = await repos.engagementItems.get(draft.engagementItemId);
  if (!item || item.withdrawnAt) {
    counts.waitingGate++;
    await back({ sendState: "waiting", lastError: "The original was withdrawn." });
    return;
  }
  if (item.editedUpstreamAt && !draft.acknowledgedEditAt) {
    counts.waitingGate++;
    await back({ sendState: "waiting", lastError: "The original changed; it needs another look before sending." });
    return;
  }
  const caps = provider.capabilities.text;
  if (countText(draft.text, caps.countingRule) > caps.maxLength) {
    counts.waitingGate++;
    await back({ sendState: "waiting", lastError: "This reply is over the platform's text limit." });
    return;
  }

  const engagement = provider.engagement!;
  const now = await clock.now();
  if (engagement.declaration.writeBudget) {
    const accountLimit =
      account.publishLimitCount !== null && account.publishLimitWindowSeconds !== null
        ? { count: account.publishLimitCount, windowSeconds: account.publishLimitWindowSeconds }
        : null;
    const budget = stricterBudget(engagement.declaration.writeBudget, accountLimit);
    const since = windowStart(now, budget);
    const writesInWindow =
      (await writesStartedSince(draft.projectId, account.id, since)).length + (await repos.engagementReplyClaims.countInWindow(account.id, since));
    const verdict = mayAttemptReply({
      budget,
      writesInWindow,
      writeReserve: ctx.cfg.writeReserve,
      sentThisRun: ctx.sentThisRun.get(account.id) ?? 0,
      sendsPerTick: ctx.cfg.sendsPerTick,
    });
    if (!verdict.ok) {
      counts.waitingAllowance++;
      await back({ sendState: "waiting", sendWaitReason: verdict.reason });
      return;
    }
  }

  const latest = await repos.engagementReplyClaims.latest(account.id, item.externalId);
  if (latest && latest.releasedAt === null) {
    if (latest.draftId === draft.id) {
      // A crash between the ledger claim and the record: never a second send (FR-039, SC-004).
      counts.ambiguous++;
      await repos.transaction(async (tx) => {
        await tx.engagementDrafts.update(draft.id, { sendState: "ambiguous", lastError: "Interrupted before the result was recorded." }, token);
        await tx.activity.insert({
          kind: "engagement_ambiguous",
          occurredAt: now,
          socialAccountId: account.id,
          providerKey: account.providerKey,
          message: "A reply's outcome could not be confirmed",
          details: { reason: "timeout" },
        });
      });
      await repos.engagementDrafts.update(draft.id, { sendLeaseUntil: null, sendLeaseOwner: null }, token);
      return;
    }
    counts.alreadyAnswered++;
    await back({ sendState: "waiting", lastError: "Another reply already answered this item." });
    return;
  }
  const generation = latest ? latest.generation + 1 : 1;
  try {
    await repos.engagementReplyClaims.insert({
      socialAccountId: account.id,
      itemExternalId: item.externalId,
      generation,
      draftId: draft.id,
      engagementItemId: item.id,
      approvedByUserId: draft.reviewedByUserId,
      claimedAt: now,
    });
  } catch {
    counts.alreadyAnswered++;
    await back({ sendState: "waiting", lastError: "Another reply already answered this item." });
    return;
  }

  let ciphertext: string | null;
  let credentials: unknown;
  let secrets: string[] = [];
  let settings: unknown;
  try {
    ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    credentials = decryptCredentials(account.id, ciphertext);
    secrets = secretValues(credentials);
    settings = provider.settingsSchema.parse(account.settings ?? {});
  } catch {
    counts.failed++;
    await back({ sendState: "failed", lastError: "Stored credentials or settings are unreadable." });
    return;
  }

  const signal = AbortSignal.timeout(ctx.config.providerTimeoutMs);
  const result = await engagement.send({
    account: { id: account.id, externalId: account.externalAccountId, settings, credentials },
    item: { kind: item.kind, externalId: item.externalId, parentExternalId: item.parentExternalId, data: item.providerData },
    text: draft.text,
    now,
    signal,
  });

  await recordOutcome(result, { account, provider: account.providerKey, draft, item, repos, counts, secrets, now, sentThisRun: ctx.sentThisRun, token, generation });
}

async function recordOutcome(
  result: EngagementSendResult,
  input: {
    account: { id: string; providerKey: string };
    provider: string;
    draft: ClaimedEngagementDraft["draft"];
    item: { id: string; kind: EngagementItemKind; externalId: string };
    repos: ReturnType<typeof forSchedulerProject>;
    counts: EngagementSendCounts;
    secrets: readonly string[];
    now: Date;
    sentThisRun: Map<string, number>;
    token: string;
    generation: number;
  },
): Promise<void> {
  const { account, draft, item, repos, counts, secrets, now, sentThisRun, token, generation } = input;
  const release = (patch: Record<string, unknown>) => repos.engagementDrafts.update(draft.id, { ...patch, sendLeaseUntil: null, sendLeaseOwner: null }, token);

  switch (result.kind) {
    case "sent":
    case "duplicate": {
      counts[result.kind === "sent" ? "sent" : "duplicate"]++;
      sentThisRun.set(account.id, (sentThisRun.get(account.id) ?? 0) + 1);
      await repos.transaction(async (tx) => {
        await tx.engagementDrafts.update(
          draft.id,
          {
            sendState: "sent",
            sentText: draft.text,
            sentAt: now,
            externalReplyId: result.kind === "sent" ? result.externalId : result.externalId ?? "",
            externalReplyUrl: result.kind === "sent" ? (result.url ?? null) : null,
            sendLeaseUntil: null,
            sendLeaseOwner: null,
          },
          token,
        );
        await tx.engagementItems.markAnswered(item.id, now);
        await tx.activity.insert({
          kind: "engagement_replied",
          occurredAt: now,
          socialAccountId: account.id,
          providerKey: account.providerKey,
          message: "A reply was sent",
          details: { url: result.kind === "sent" ? (result.url ?? null) : null, itemKind: item.kind },
        });
      });
      return;
    }
    case "ambiguous": {
      counts.ambiguous++;
      await repos.transaction(async (tx) => {
        await tx.engagementDrafts.update(draft.id, { sendState: "ambiguous", lastError: redact(result.error, secrets) }, token);
        await tx.activity.insert({
          kind: "engagement_ambiguous",
          occurredAt: now,
          socialAccountId: account.id,
          providerKey: account.providerKey,
          message: "A reply's outcome could not be confirmed",
          details: { reason: "unreadable_response" },
        });
      });
      await release({});
      return;
    }
    case "fatal_error": {
      counts.failed++;
      await repos.engagementReplyClaims.release(account.id, item.externalId, generation, "definite_failure", null, now);
      // A definite failure never retries on its own; leaving it `approved` would permanently block
      // the item behind `engagement_drafts_one_live_answer_uq` (review F9). Rejecting it frees the
      // item for a fresh draft while keeping the failure's reason on the record.
      await release({
        reviewState: "rejected",
        rejectionReason: redact(result.error, secrets).slice(0, 500),
        sendState: "none",
        lastError: redact(result.error, secrets),
      });
      if (result.flagAccount) {
        const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
        await markInvalidEmitting(repos, account.id, { expectedCiphertext: ciphertext, reason: redact(result.error, secrets) }).catch(() => undefined);
      }
      return;
    }
    case "credentials_invalid": {
      counts.credentialsInvalid++;
      const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
      await markInvalidEmitting(repos, account.id, { expectedCiphertext: ciphertext, reason: redact(result.error, secrets) }).catch(() => undefined);
      await repos.engagementReplyClaims.release(account.id, item.externalId, generation, "definite_failure", null, now);
      await release({ sendState: "waiting", lastError: redact(result.error, secrets) });
      return;
    }
    case "retryable_error": {
      counts.failed++;
      await repos.engagementReplyClaims.release(account.id, item.externalId, generation, "definite_failure", null, now);
      await release({ sendState: "waiting", sendNotBefore: result.retryAt ?? null, lastError: redact(result.error, secrets) });
      return;
    }
  }
}
