import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimDueEngagementReads } from "../../../src/server/dal/engagement-read-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { forProject } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { getInboxItem, listInbox } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createMockAccount, parkAllEngagementReads } from "../../helpers/scheduling";
import { createPostInReview, createProjectWithMembers } from "../../helpers/factories";
import { tickConfig } from "../../helpers/tick";

// The read claim sweeps every project and is `limit`-bounded, so accounts left active by other
// files fill the claim and squeeze this file's own account out of it. Park them first.
beforeEach(parkAllEngagementReads);

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-10T12:00:00Z");
/**
 * `engagementPruneBatch: 0` keeps housekeeping from racing the assertions.
 *
 * `runTick` runs housekeeping alongside the engagement read, and the prune pass deletes "any withdrawn
 * item regardless of age" (services/engagement/retention) — `pruneEngagementItemsBefore` matches on
 * `withdrawn_at IS NOT NULL` with no age test at all. So the same tick that stamps an item withdrawn is
 * entitled to delete it, and a test that reads the item back afterwards wins or loses a race with no
 * ordering between the two sections. That is what failed on CI for three of four consecutive pull
 * requests (#131, #135, #137) as `NotFoundError: Engagement item not found`, always on the withdrawn
 * case, always passing when the file ran alone.
 *
 * A batch of 0 is `LIMIT 0`, and the DAL returns early on an empty id list, so nothing is pruned.
 * Retention behaviour itself is covered by `engagement/retention.test.ts`, which is about the prune;
 * this file is about ingest and must not depend on whether the prune happened to run first.
 */
const NO_WAIT = { engagementReadMinIntervalMs: 0, engagementPruneBatch: 0 };

async function setupWithItems(items: Record<string, unknown>[]) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings: { engagementItems: items } });
  return { scope, account };
}

describe("engagement inbox ingest (US2, FR-006–FR-015, SC-001, SC-008)", () => {
  it("lands items from the tick exactly once, with author, text, time, account and parent", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: {
        engagementItems: [
          { kind: "reply", externalId: "a-1", text: "Nice post!", authorHandle: "ada.bsky.social", authorExternalId: "did:plc:ada", saidAt: AT.toISOString(), parentExternalId: "post-1" },
          { kind: "mention", externalId: "a-2", text: "@brand hi", authorHandle: "bea.bsky.social", authorExternalId: "did:plc:bea" },
        ],
      },
    });
    const { targets } = await createPostInReview(ctx.project.id, { accountIds: [account.id], baseText: "Our own post" });
    await forSchedulerProject(ctx.project.id).targets.update(targets[0]!.id, { status: "published", externalId: "post-1", publishedAt: AT });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);

    const list = await listInbox(scope);
    expect(list.items).toHaveLength(2);
    const reply = list.items.find((i) => i.externalId === "a-1")!;
    expect(reply.text).toBe("Nice post!");
    expect(reply.author.handle).toBe("ada.bsky.social");
    expect(reply.socialAccount.id).toBe(account.id);
    expect(reply.parent).toMatchObject({ kind: "docket_post", text: "Our own post" });

    // A second tick re-reads the same fixture: nothing new is stored or notified.
    const second = await atTime(new Date(AT.getTime() + 1000), () => runTick(tickConfig(NO_WAIT)));
    expect(second.engagementRead.ok).toBe(true);
    const after = await listInbox(scope);
    expect(after.items).toHaveLength(2);
  });

  it("never crosses project boundaries", async () => {
    const a = await setupWithItems([{ kind: "reply", externalId: "proj-a-1", text: "From A" }]);
    const b = await setupWithItems([{ kind: "reply", externalId: "proj-b-1", text: "From B" }]);

    await atTime(AT, () => runTick(tickConfig(NO_WAIT)));

    const listA = await listInbox(a.scope);
    const listB = await listInbox(b.scope);
    expect(listA.items.map((i) => i.externalId)).toEqual(["proj-a-1"]);
    expect(listB.items.map((i) => i.externalId)).toEqual(["proj-b-1"]);
  });

  it("a provider with no engagement declaration has no accounts in the inbox", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    // tiktok declares no `engagement` member; connecting one must not surface it in the inbox.
    await createMockAccount(ctx.project.id, {}, { providerKey: "tiktok" });
    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);
    const list = await listInbox(scope);
    expect(list.items).toHaveLength(0);
  });

  it("records one engagement_received activity event per account per run when items arrive", async () => {
    const { scope } = await setupWithItems([{ kind: "reply", externalId: "evt-1", text: "hello" }]);
    await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    const feed = await scope.activity.list({
      windows: [{ projectId: scope.project.id, from: null, to: null }],
      outcomes: null,
      platform: null,
      accountId: null,
      cursor: null,
      direction: "older",
      limit: 10,
    });
    const event = feed.find((e) => e.kind === "engagement_received");
    expect(event).toBeDefined();
  });

  it("stamps edited_upstream_at when the provider reports the item was edited on a later read (US2 AS8)", async () => {
    const { scope, account } = await setupWithItems([{ kind: "reply", externalId: "up-1", text: "Nice post!", saidAt: AT.toISOString() }]);
    await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    const firstList = await listInbox(scope);
    const itemId = firstList.items.find((i) => i.externalId === "up-1")!.id;
    let item = await getInboxItem(scope, itemId);
    expect(item.editedUpstreamAt).toBeNull();

    await accounts.updateAccountSettings(scope, account.id, {
      engagementItems: [{ kind: "reply", externalId: "up-1", text: "Nice post!", saidAt: AT.toISOString(), upstream: "edited" }],
    });
    const second = await atTime(new Date(AT.getTime() + 1000), () => runTick(tickConfig(NO_WAIT)));
    expect(second.engagementRead.ok).toBe(true);
    item = await getInboxItem(scope, itemId);
    expect(item.editedUpstreamAt).not.toBeNull();
  });

  it("stamps withdrawn_at when the provider reports the item was withdrawn on a later read (US2 AS8)", async () => {
    const { scope, account } = await setupWithItems([{ kind: "reply", externalId: "wd-1", text: "Nice post!", saidAt: AT.toISOString() }]);
    await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    const firstList = await listInbox(scope);
    const itemId = firstList.items.find((i) => i.externalId === "wd-1")!.id;
    let item = await getInboxItem(scope, itemId);
    expect(item.withdrawnAt).toBeNull();

    await accounts.updateAccountSettings(scope, account.id, {
      engagementItems: [{ kind: "reply", externalId: "wd-1", text: "Nice post!", saidAt: AT.toISOString(), upstream: "withdrawn" }],
    });
    const second = await atTime(new Date(AT.getTime() + 1000), () => runTick(tickConfig(NO_WAIT)));
    expect(second.engagementRead.ok).toBe(true);
    item = await getInboxItem(scope, itemId);
    expect(item.withdrawnAt).not.toBeNull();
  });

  it("flags the account via credentials_invalid, once renewal has failed too, and leaves the cursor unmoved", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    // `refresh: "fail"` is the point: the reader only gives up on an account once the renewal the
    // publish path would do has also refused. The mock refreshes successfully by default.
    // `simulateCredentialExpiryHours` is what makes connectMock store credentials at all — without
    // it there is nothing to renew, and this would pass for the wrong reason.
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      simulateCredentialExpiryHours: 1,
      settings: { engagementReadBehaviour: "credentials_invalid", refresh: "fail" },
    });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);
    const list = await listInbox(scope);
    expect(list.items).toHaveLength(0);
    const state = await scope.engagementAccountStates.get(account.id);
    expect(state?.cursor).toBeNull();
    const view = (await accounts.listAccounts(scope)).find((a) => a.id === account.id);
    expect(view?.status).toBe("needs_reauth");
  });

  // The reader polls far more often than posts publish, so before this it reached a session
  // rejection first and flagged an account the publish path would have healed silently — which
  // undid a Bluesky reconnect within the hour, four times in one day (2026-10-17).
  it("renews instead of flagging when the provider can still open a session", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      simulateCredentialExpiryHours: 1,
      settings: { engagementReadBehaviour: "credentials_invalid", refresh: "succeed" },
    });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);
    const view = (await accounts.listAccounts(scope)).find((a) => a.id === account.id);
    expect(view?.status, "a renewable account must stay active, not wait on a human").toBe("active");
    // The read still stopped: nothing is ingested and the cursor stays put for the retry.
    expect((await listInbox(scope)).items).toHaveLength(0);
    expect((await scope.engagementAccountStates.get(account.id))?.cursor).toBeNull();
  });

  it("commits items inserted on an earlier page and notifies once, even when a later page in the same run stops the read (review F25)", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: {
        engagementItems: [
          { kind: "reply", externalId: "stop-1", text: "first", saidAt: AT.toISOString() },
          { kind: "reply", externalId: "stop-2", text: "second", saidAt: new Date(AT.getTime() + 1000).toISOString() },
          { kind: "reply", externalId: "stop-3", text: "third", saidAt: new Date(AT.getTime() + 2000).toISOString() },
        ],
        engagementReadBehaviour: "rate_limited",
        engagementReadFailAfterPages: 1,
      },
    });
    const account = (await accounts.listAccounts(scope))[0]!;
    // The account state row is only created lazily on the first claim, so claim (and release) once
    // before forcing a stable "older" direction across both pages this run — otherwise the second
    // provider call reuses the unrelated "newest" cursor, restarting the page count at zero.
    await claimDueEngagementReads({ now: AT, limit: 10, leaseMs: 1000, minIntervalMs: 0, providers: [{ providerKey: "mock", readScopes: [] }] });
    await forSchedulerProject(ctx.project.id).engagementAccountStates.update(account.id, { backfilling: true, readLeaseUntil: null, readLeaseOwner: null });

    const tick = await atTime(AT, () => runTick(tickConfig({ ...NO_WAIT, engagementReadPageSize: 2, engagementReadPagesPerRun: 3 })));
    expect(tick.engagementRead.ok).toBe(true);
    expect(tick.engagementRead.counts.itemsInserted).toBe(2);

    const list = await listInbox(scope);
    expect(list.items.map((i) => i.externalId).sort()).toEqual(["stop-1", "stop-2"]);

    const feed = await scope.activity.list({
      windows: [{ projectId: scope.project.id, from: null, to: null }],
      outcomes: null,
      platform: null,
      accountId: null,
      cursor: null,
      direction: "older",
      limit: 10,
    });
    expect(feed.filter((e) => e.kind === "engagement_received")).toHaveLength(1);
  });

  it("catches up a 500-item backlog over successive ticks with nothing skipped or duplicated", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      kind: "reply" as const,
      externalId: `bulk-${i}`,
      text: `item ${i}`,
      saidAt: new Date(AT.getTime() + i * 1000).toISOString(),
    }));
    const { scope } = await setupWithItems(items);

    let soFar = await listInbox(scope);
    for (let tick = 0; tick < 10 && soFar.total < 500; tick++) {
      const result = await atTime(new Date(AT.getTime() + tick * 10_000), () => runTick(tickConfig(NO_WAIT)));
      expect(result.engagementRead.ok).toBe(true);
      soFar = await listInbox(scope);
    }
    // The account's own externalId space is 500 wide, so the project's own total can never exceed
    // it even if some other account was claimed in the same (cross-project) scheduler tick.
    expect(soFar.total).toBe(500);
  });

  it("a tick finds the read lease already held by another and moves on", async () => {
    const { scope, account } = await setupWithItems([{ kind: "reply", externalId: "lease-1", text: "hi" }]);
    const held = await claimDueEngagementReads({ now: AT, limit: 10, leaseMs: 60_000, minIntervalMs: 0, providers: [{ providerKey: "mock", readScopes: [] }] });
    expect(held.map((c) => c.account.id)).toContain(account.id);

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);
    expect(tick.engagementRead.counts.claimed).toBe(0);
    const list = await listInbox(scope);
    expect(list.items).toHaveLength(0);
  });

  it("resumes from the last committed cursor after a tick is killed mid-read", async () => {
    const { scope, account } = await setupWithItems([{ kind: "reply", externalId: "kill-1", text: "hi", saidAt: AT.toISOString() }]);
    // Simulate a kill: claim the lease but never commit or release it.
    const killed = await claimDueEngagementReads({ now: AT, limit: 10, leaseMs: 1000, minIntervalMs: 0, providers: [{ providerKey: "mock", readScopes: [] }] });
    expect(killed.map((c) => c.account.id)).toContain(account.id);

    // Once the dangling lease has expired, the next tick reclaims the account and reads normally,
    // with no re-notification of anything the killed run never committed.
    const after = new Date(AT.getTime() + 1500);
    const tick = await atTime(after, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);
    const list = await listInbox(scope);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.externalId).toBe("kill-1");
  });

  it("a rejected cursor restarts from the newest page, stamps gap_at, and the re-read overlap stores nothing new", async () => {
    const { scope, account } = await setupWithItems([
      { kind: "reply", externalId: "gap-1", text: "first", saidAt: AT.toISOString() },
      { kind: "reply", externalId: "gap-2", text: "second", saidAt: new Date(AT.getTime() + 1000).toISOString() },
    ]);
    await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect((await listInbox(scope)).items).toHaveLength(2);

    await accounts.updateAccountSettings(scope, account.id, { engagementReadBehaviour: "cursor_lost" });
    const lostAt = new Date(AT.getTime() + 60_000);
    const lost = await atTime(lostAt, () => runTick(tickConfig(NO_WAIT)));
    expect(lost.engagementRead.ok).toBe(true);
    const state = await scope.engagementAccountStates.get(account.id);
    expect(state?.gapAt).not.toBeNull();
    expect(state?.cursor).toBeNull();
    expect(state?.backfilling).toBe(false);

    // Back to normal, with one genuinely new item alongside the two already stored.
    await accounts.updateAccountSettings(scope, account.id, {
      engagementReadBehaviour: "page",
      engagementItems: [
        { kind: "reply", externalId: "gap-1", text: "first", saidAt: AT.toISOString() },
        { kind: "reply", externalId: "gap-2", text: "second", saidAt: new Date(AT.getTime() + 1000).toISOString() },
        { kind: "reply", externalId: "gap-3", text: "third", saidAt: new Date(AT.getTime() + 2000).toISOString() },
      ],
    });
    const restartAt = new Date(lostAt.getTime() + 60_000);
    const restart = await atTime(restartAt, () => runTick(tickConfig(NO_WAIT)));
    expect(restart.engagementRead.ok).toBe(true);
    // Scoped to this project: the overlap (gap-1, gap-2) stores nothing new, only gap-3 lands.
    const after = await listInbox(scope);
    expect(after.items.map((i) => i.externalId).sort()).toEqual(["gap-1", "gap-2", "gap-3"]);
  });
});
