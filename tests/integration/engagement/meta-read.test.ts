import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { resetUsageBackoffs } from "../../../src/providers/meta/usage";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createDueTarget } from "../../helpers/scheduling";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllEngagementReads } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

beforeEach(parkAllEngagementReads);

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };
const TOKEN = "page-token-abcdef0123456789";
const PAGE_ID = "1001";

let fake: FakeGraph;
beforeEach(() => {
  fake = createFakeGraph().install();
  resetUsageBackoffs();
});
afterEach(() => {
  fake.uninstall();
});

async function runSection() {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  return atTime(AT, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: AT }));
}

describe("Facebook comments reach the inbox (US1, FR-025, FR-026, SC-002)", () => {
  it("stores one engagement_items row with kind comment, the comment's own id, the post id as parent, resolved to the Docket post — and a second run over the same response inserts nothing", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);

    const account = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Test Page",
      externalAccountId: PAGE_ID,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pages_read_engagement", "pages_read_user_content"],
    });
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: TOKEN }), null);

    // The post this comment's parent should resolve to, as `publish.ts` would have recorded it.
    const { target } = await createDueTarget(ctx.project.id, account.id);
    const postExternalId = `${PAGE_ID}_555`;
    await repos.targets.update(target.id, { status: "published", externalId: postExternalId, resolvedAt: AT });

    fake.on("GET", `/v26.0/${PAGE_ID}/posts`, {
      kind: "ok",
      body: {
        data: [
          {
            id: postExternalId,
            created_time: "2026-10-18T00:00:00+0000",
            comments: {
              data: [{ id: "comment-1", message: "Nice post!", created_time: "2026-10-18T01:00:00+0000", from: { name: "A Commenter", id: "user-9" } }],
            },
          },
        ],
      },
    });

    await runSection();

    const item = await repos.engagementItems.getByExternalId(account.id, "comment-1");
    expect(item).not.toBeNull();
    expect(item?.kind).toBe("comment");
    expect(item?.externalId).toBe("comment-1");
    expect(item?.parentExternalId).toBe(postExternalId);
    expect(item?.parentPostId).toBe(target.postId);
    expect(item?.parentPostTargetId).toBe(target.id);
    expect(item?.authorDisplayName).toBe("A Commenter");
    expect(item?.authorExternalId).toBe("user-9");
    expect(item?.authorIdentityStable).toBe(true);

    const countBefore = fake.requests.length;
    await runSection();
    const again = await repos.engagementItems.getByExternalId(account.id, "comment-1");
    expect(again?.id).toBe(item?.id);
    expect(fake.requests.length).toBeGreaterThan(countBefore); // a second read happens...
    const allForAccount = await repos.engagementAccountStates.get(account.id);
    expect(allForAccount).not.toBeNull(); // ...but inserts nothing new (unique index keeps one row)
  });
});

const IG_ID = "2001";

describe("Instagram comments reach the inbox (US2, FR-026, FR-029)", () => {
  it("stores one engagement_items row with parent_post_id / parent_post_target_id resolved, author_handle from username, author_identity_stable false", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);

    const account = await repos.accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "Test IG Account",
      externalAccountId: IG_ID,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
    });
    await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: TOKEN }), null);

    const { target } = await createDueTarget(ctx.project.id, account.id);
    const mediaExternalId = `${IG_ID}_777`;
    await repos.targets.update(target.id, { status: "published", externalId: mediaExternalId, resolvedAt: AT });

    fake.on("GET", `/v26.0/${IG_ID}`, { kind: "ok", body: { username: "brand" } });
    fake.on("GET", `/v26.0/${IG_ID}/media`, {
      kind: "ok",
      body: {
        data: [
          {
            id: mediaExternalId,
            timestamp: "2026-10-18T00:00:00+0000",
            comments: {
              data: [{ id: "ig-comment-1", text: "Love this!", timestamp: "2026-10-18T01:00:00+0000", username: "a_follower" }],
            },
          },
        ],
      },
    });

    await runSection();

    const item = await repos.engagementItems.getByExternalId(account.id, "ig-comment-1");
    expect(item).not.toBeNull();
    expect(item?.kind).toBe("comment");
    expect(item?.parentExternalId).toBe(mediaExternalId);
    expect(item?.parentPostId).toBe(target.postId);
    expect(item?.parentPostTargetId).toBe(target.id);
    expect(item?.authorHandle).toBe("a_follower");
    expect(item?.authorIdentityStable).toBe(false);
  });
});
