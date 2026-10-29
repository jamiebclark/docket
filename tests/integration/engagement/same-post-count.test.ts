import { afterAll, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { forProject } from "../../../src/server/dal/scope";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createPostInReview, createProjectWithMembers } from "../../helpers/factories";
import { getInboxItem } from "../../../src/server/services/engagement/inbox";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { tickConfig } from "../../helpers/tick";
import { parkAllEngagementReads } from "../../helpers/scheduling";

afterAll(closeDb);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0, engagementPruneBatch: 0 };

describe("newerOnSameParent never counts across parentless items (US2, FR-019)", () => {
  it("three parentless mentions each report zero, regardless of order", async () => {
    await parkAllEngagementReads();
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: {
        engagementItems: [
          { kind: "mention", externalId: "m-oldest", text: "first", authorHandle: "a.bsky.social", authorExternalId: "did:plc:a", saidAt: new Date(AT.getTime()).toISOString() },
          { kind: "mention", externalId: "m-middle", text: "second", authorHandle: "b.bsky.social", authorExternalId: "did:plc:b", saidAt: new Date(AT.getTime() + 1000).toISOString() },
          { kind: "mention", externalId: "m-newest", text: "third", authorHandle: "c.bsky.social", authorExternalId: "did:plc:c", saidAt: new Date(AT.getTime() + 2000).toISOString() },
        ],
      },
    });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);

    const oldest = await scope.engagementItems.getByExternalId(account.id, "m-oldest");
    const view = await getInboxItem(scope, oldest!.id);
    expect(view.newerOnSameParent).toBe(0);
  });

  it("the older of two replies on the same parent counts the newer one", async () => {
    await parkAllEngagementReads();
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: {
        engagementItems: [
          { kind: "reply", externalId: "r-older", text: "first reply", authorHandle: "a.bsky.social", authorExternalId: "did:plc:a", saidAt: new Date(AT.getTime()).toISOString(), parentExternalId: "post-1" },
          { kind: "reply", externalId: "r-newer", text: "second reply", authorHandle: "b.bsky.social", authorExternalId: "did:plc:b", saidAt: new Date(AT.getTime() + 1000).toISOString(), parentExternalId: "post-1" },
        ],
      },
    });
    const { targets } = await createPostInReview(ctx.project.id, { accountIds: [account.id], baseText: "Our own post" });
    await forSchedulerProject(ctx.project.id).targets.update(targets[0]!.id, { status: "published", externalId: "post-1", publishedAt: AT });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);

    const older = await scope.engagementItems.getByExternalId(account.id, "r-older");
    const view = await getInboxItem(scope, older!.id);
    expect(view.newerOnSameParent).toBe(1);
  });
});
