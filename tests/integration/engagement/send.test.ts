import { afterAll, describe, expect, it } from "vitest";
import { writeReply } from "../../../src/server/services/engagement/draft";
import { approveReply } from "../../../src/server/services/engagement/review";
import { markReplyNotSent, markReplySent } from "../../../src/server/services/failures";
import { forProject } from "../../../src/server/dal/scope";
import { updateAccountSettings } from "../../../src/server/services/accounts";
import { runTick } from "../../../src/server/scheduler";
import { runEngagementSend } from "../../../src/server/scheduler/engagement-send";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { getEnv } from "../../../src/server/env";
import * as accounts from "../../../src/server/services/accounts";
import { fakeSession } from "../../helpers/auth";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const NO_WAIT = { engagementReadMinIntervalMs: 0 };

async function setup(settings: Record<string, unknown> = {}) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings });
  return { scope, account, ownerId: ctx.owner.id };
}

async function seedApprovedDraft(scope: Awaited<ReturnType<typeof setup>>["scope"], accountId: string, externalId = `ext-${Math.random().toString(36).slice(2)}`) {
  const { id: itemId } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    kind: "reply",
    externalId,
    text: "Great post!",
    authorDisplayName: "Ada",
    authorHandle: "ada",
    authorExternalId: "ada-1",
    authorUrl: null,
    authorIdentityStable: true,
    saidAt: new Date(),
    ingestedAt: new Date(),
    parentExternalId: null,
  });
  const written = await writeReply(scope, itemId, "Thanks!");
  if (!written.ok) throw new Error("unreachable");
  const approved = await approveReply(scope, written.draftId);
  if (!approved.ok) throw new Error("unreachable");
  return { itemId, draftId: written.draftId };
}

describe("engagement-send (FR-038–FR-045, SC-004, SC-005, SC-006)", () => {
  it("sends an approved reply and marks the item answered", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "sent" });
    const { itemId, draftId } = await seedApprovedDraft(scope, account.id);
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.ok).toBe(true);
    expect(tick.engagementSend.counts.sent).toBe(1);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft).toMatchObject({ sendState: "sent", sentText: "Thanks!" });
    const item = await scope.engagementItems.get(itemId);
    expect(item?.state).toBe("answered");
  });

  it("an ambiguous outcome is never retried and is visible as a decision to make (SC-005)", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "ambiguous" });
    const { draftId, itemId } = await seedApprovedDraft(scope, account.id);
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.counts.ambiguous).toBe(1);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft?.sendState).toBe("ambiguous");

    const again = await runTick({ config: NO_WAIT });
    expect(again.engagementSend.counts.claimed).toBe(0);

    await markReplyNotSent(scope, draftId);
    const reset = await scope.engagementDrafts.get(draftId);
    expect(reset).toMatchObject({ reviewState: "needs_review", sendState: "none" });
    const item = await scope.engagementItems.get(itemId);
    expect(item?.state).toBe("waiting");
  });

  it("markReplySent answers the item without sending again", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "ambiguous" });
    const { draftId, itemId } = await seedApprovedDraft(scope, account.id);
    await runTick({ config: NO_WAIT });
    await markReplySent(scope, draftId);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft?.sendState).toBe("sent");
    const item = await scope.engagementItems.get(itemId);
    expect(item?.state).toBe("answered");
  });

  it("a platform duplicate refusal is treated as answered", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "duplicate" });
    const { draftId, itemId } = await seedApprovedDraft(scope, account.id);
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.counts.duplicate).toBe(1);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft?.sendState).toBe("sent");
    const item = await scope.engagementItems.get(itemId);
    expect(item?.state).toBe("answered");
  });

  it("an account at its hourly allowance leaves replies waiting with reason write_allowance (SC-006)", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "sent" });
    await scope.accounts.setLimit(account.id, { count: 1, windowSeconds: 3600 });
    const { draftId } = await seedApprovedDraft(scope, account.id);
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.counts.waitingAllowance).toBe(1);
    expect(tick.engagementSend.counts.sent).toBe(0);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft).toMatchObject({ sendState: "waiting", sendWaitReason: "write_allowance" });
  });

  it("a kill between the ledger claim and the record recovers to ambiguous, never a second send (SC-004)", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "sent" });
    const { draftId, itemId } = await seedApprovedDraft(scope, account.id, "ext-crash");
    const item = (await scope.engagementItems.get(itemId))!;
    // Simulate the crash: the ledger claim was committed, but the draft never got its outcome recorded.
    await scope.engagementReplyClaims.insert({
      socialAccountId: account.id,
      itemExternalId: item.externalId,
      generation: 1,
      draftId,
      engagementItemId: itemId,
      approvedByUserId: null,
      claimedAt: new Date(),
    });
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.counts.ambiguous).toBe(1);
    expect(tick.engagementSend.counts.sent).toBe(0);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft?.sendState).toBe("ambiguous");
  });

  it("two overlapping ticks claiming one approved draft send exactly once (F2, FR-039, FR-040, SC-004)", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "sent", delayMs: 300 });
    const { draftId } = await seedApprovedDraft(scope, account.id, "ext-overlap");
    const config = schedulerConfig(getEnv(), NO_WAIT);
    const [a, b] = await Promise.all([
      runEngagementSend({ config, tickId: "tick-a", startedAt: new Date() }),
      runEngagementSend({ config, tickId: "tick-b", startedAt: new Date() }),
    ]);
    expect(a.sent + b.sent).toBe(1);
    const draft = await scope.engagementDrafts.get(draftId);
    expect(draft?.sendState).toBe("sent");
    expect(draft?.sendLeaseOwner).toBeNull();
  });

  it("a live claim stays distinguishable from a released one past generation 1 (F3): release, re-approve, send, then a second approval is refused already_answered", async () => {
    const { scope, account } = await setup({ engagementSendBehaviour: "fatal_error" });
    const { draftId: firstDraftId, itemId } = await seedApprovedDraft(scope, account.id, "ext-regen");
    const tick = await runTick({ config: NO_WAIT });
    expect(tick.engagementSend.counts.failed).toBe(1);
    const firstDraft = await scope.engagementDrafts.get(firstDraftId);
    expect(firstDraft).toMatchObject({ reviewState: "rejected", sendState: "none" });
    const released = await scope.engagementReplyClaims.latest(account.id, "ext-regen");
    expect(released?.generation).toBe(1);
    expect(released?.releasedAt).not.toBeNull();

    // Re-approving a second draft on the same item must not be refused by the released generation-1 claim.
    const second = await writeReply(scope, itemId, "Second try!");
    if (!second.ok) throw new Error("unreachable");
    const approvedSecond = await approveReply(scope, second.draftId);
    expect(approvedSecond).toMatchObject({ ok: true });

    await updateAccountSettings(scope, account.id, { engagementSendBehaviour: "sent" });
    const resend = await runTick({ config: NO_WAIT });
    expect(resend.engagementSend.counts.sent).toBe(1);
    const secondDraft = await scope.engagementDrafts.get(second.draftId);
    expect(secondDraft?.sendState).toBe("sent");
    const liveGen2 = await scope.engagementReplyClaims.latest(account.id, "ext-regen");
    expect(liveGen2?.generation).toBe(2);
    expect(liveGen2?.releasedAt).toBeNull();

    // A third draft's approval is refused: generation 2's claim is live, not released.
    const third = await writeReply(scope, itemId, "Third try!");
    if (!third.ok) throw new Error("unreachable");
    const approvedThird = await approveReply(scope, third.draftId);
    expect(approvedThird).toMatchObject({ ok: false, code: "already_answered" });
  });
});
