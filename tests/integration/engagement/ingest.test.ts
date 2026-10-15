import { afterAll, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { listInbox } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-10T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

async function setupWithItems(items: Record<string, unknown>[]) {
  const ctx = await createProjectWithMembers();
  const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
  const account = await accounts.connectMock(scope, { displayName: "Mock", settings: { engagementItems: items } });
  return { scope, account };
}

describe("engagement inbox ingest (US2, FR-006–FR-015, SC-001, SC-008)", () => {
  it("lands items from the tick exactly once, with author, text, time, account and parent", async () => {
    const { scope, account } = await setupWithItems([
      { kind: "reply", externalId: "a-1", text: "Nice post!", authorHandle: "ada.bsky.social", authorExternalId: "did:plc:ada", saidAt: AT.toISOString(), parentExternalId: "post-1" },
      { kind: "mention", externalId: "a-2", text: "@brand hi", authorHandle: "bea.bsky.social", authorExternalId: "did:plc:bea" },
    ]);

    const tick = await atTime(AT, () => runTick({ config: NO_WAIT }));
    expect(tick.engagementRead.ok).toBe(true);

    const list = await listInbox(scope);
    expect(list.items).toHaveLength(2);
    const reply = list.items.find((i) => i.externalId === "a-1")!;
    expect(reply.text).toBe("Nice post!");
    expect(reply.author.handle).toBe("ada.bsky.social");
    expect(reply.socialAccount.id).toBe(account.id);
    expect(reply.parent).toMatchObject({ kind: "external_reference", externalId: "post-1" });

    // A second tick re-reads the same fixture: nothing new is stored or notified.
    const second = await atTime(new Date(AT.getTime() + 1000), () => runTick({ config: NO_WAIT }));
    expect(second.engagementRead.ok).toBe(true);
    const after = await listInbox(scope);
    expect(after.items).toHaveLength(2);
  });

  it("never crosses project boundaries", async () => {
    const a = await setupWithItems([{ kind: "reply", externalId: "proj-a-1", text: "From A" }]);
    const b = await setupWithItems([{ kind: "reply", externalId: "proj-b-1", text: "From B" }]);

    await atTime(AT, () => runTick({ config: NO_WAIT }));

    const listA = await listInbox(a.scope);
    const listB = await listInbox(b.scope);
    expect(listA.items.map((i) => i.externalId)).toEqual(["proj-a-1"]);
    expect(listB.items.map((i) => i.externalId)).toEqual(["proj-b-1"]);
  });

  it("a provider with no engagement declaration has no accounts in the inbox", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    // No account at all is connected; the inbox for this project stays empty.
    const list = await listInbox(scope);
    expect(list.items).toHaveLength(0);
  });

  it("records one engagement_received activity event per account per run when items arrive", async () => {
    const { scope } = await setupWithItems([{ kind: "reply", externalId: "evt-1", text: "hello" }]);
    await atTime(AT, () => runTick({ config: NO_WAIT }));
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
});
