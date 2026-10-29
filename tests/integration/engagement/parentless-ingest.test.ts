import { afterAll, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { forProject } from "../../../src/server/dal/scope";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createPostInReview, createProjectWithMembers } from "../../helpers/factories";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { tickConfig } from "../../helpers/tick";
import { parkAllEngagementReads } from "../../helpers/scheduling";

afterAll(closeDb);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0, engagementPruneBatch: 0 };

describe("parentless items are never attributed to a brand post (US2, FR-017, FR-021, FR-022, FR-024)", () => {
  it("a parentless mention, a resolved reply and an unresolved reply all land correctly in the same page", async () => {
    await parkAllEngagementReads();
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);

    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: {
        engagementItems: [
          { kind: "mention", externalId: "mention-1", text: "no parent here", authorHandle: "ada.bsky.social", authorExternalId: "did:plc:ada", saidAt: AT.toISOString() },
          { kind: "reply", externalId: "reply-resolved", text: "nice post", authorHandle: "bea.bsky.social", authorExternalId: "did:plc:bea", saidAt: AT.toISOString(), parentExternalId: "post-1" },
          { kind: "reply", externalId: "reply-unresolved", text: "to someone else", authorHandle: "cai.bsky.social", authorExternalId: "did:plc:cai", saidAt: AT.toISOString(), parentExternalId: "post-not-ours" },
        ],
      },
    });
    const { targets } = await createPostInReview(ctx.project.id, { accountIds: [account.id], baseText: "Our own post" });
    await forSchedulerProject(ctx.project.id).targets.update(targets[0]!.id, { status: "published", externalId: "post-1", publishedAt: AT });

    const tick = await atTime(AT, () => runTick(tickConfig(NO_WAIT)));
    expect(tick.engagementRead.ok).toBe(true);

    const mention = await scope.engagementItems.getByExternalId(account.id, "mention-1");
    expect(mention?.parentExternalId).toBeNull();
    expect(mention?.parentPostId ?? null).toBeNull();
    expect(mention?.parentPostTargetId).toBeNull();

    const resolved = await scope.engagementItems.getByExternalId(account.id, "reply-resolved");
    expect(resolved?.parentExternalId).toBe("post-1");
    expect(resolved?.parentPostTargetId).toBe(targets[0]!.id);

    const unresolved = await scope.engagementItems.getByExternalId(account.id, "reply-unresolved");
    expect(unresolved?.parentExternalId).toBe("post-not-ours");
    expect(unresolved?.parentPostTargetId).toBeNull();

    // the parentless mention disturbs neither resolved row
    expect(resolved?.parentPostTargetId).toBe(targets[0]!.id);
    expect(unresolved?.parentPostTargetId).toBeNull();
  });
});
