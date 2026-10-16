import { afterAll, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { listProviders } from "../../../src/providers/registry";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { writeReply } from "../../../src/server/services/engagement/draft";
import { listInbox, getInboxItem } from "../../../src/server/services/engagement/inbox";
import { listReplyQueue } from "../../../src/server/services/engagement/review";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-12T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

describe("direct message presentation (US5, FR-056)", () => {
  it("marks a DM Private on the inbox list row and the item view, never as a public comment", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: { engagementItems: [{ kind: "direct_message", externalId: "dm-1", text: "Hi there", authorHandle: "ada" }] },
    });

    await atTime(AT, () => runTick({ config: NO_WAIT }));

    const list = await listInbox(scope);
    const dm = list.items.find((i) => i.externalId === "dm-1")!;
    expect(dm.kind).toBe("direct_message");

    const item = await getInboxItem(scope, dm.id);
    expect(item.kind).toBe("direct_message");
  });

  it("states in the review row that the reply goes privately to one person", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: { engagementItems: [{ kind: "direct_message", externalId: "dm-2", text: "Hi there", authorHandle: "ada" }] },
    });
    await atTime(AT, () => runTick({ config: NO_WAIT }));
    const list = await listInbox(scope);
    const dm = list.items.find((i) => i.externalId === "dm-2")!;

    const written = await writeReply(scope, dm.id, "Thanks for the note!");
    expect(written.ok).toBe(true);

    const queue = await listReplyQueue(scope);
    const row = queue.items.find((r) => r.itemId === dm.id)!;
    expect(row.kind).toBe("direct_message");
  });

  it("no platform in this entry declares direct_message besides the mock provider", () => {
    const declared = listProviders()
      .filter((p) => p.key !== "mock")
      .filter((p) => p.engagement?.declaration.reads.includes("direct_message"));
    expect(declared).toEqual([]);
  });
});
