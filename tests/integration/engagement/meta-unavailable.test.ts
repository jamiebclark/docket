import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { facebookEngagement } from "../../../src/providers/facebook/engagement";
import type { EngagementDeclaration } from "../../../src/providers/types";
import { forProject } from "../../../src/server/dal/scope";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { resetUsageBackoffs } from "../../../src/providers/meta/usage";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { listEngagementAccounts } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createDueTarget, parkAllEngagementReads } from "../../helpers/scheduling";
import { createProjectWithMembers } from "../../helpers/factories";
import { tickConfig } from "../../helpers/tick";

beforeEach(parkAllEngagementReads);

afterAll(closeDb);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };
const TOKEN = "page-token-abcdef0123456789";
const PAGE_ID = "1001";
const IG_ID = "2001";

let fake: FakeGraph;
beforeEach(() => {
  fake = createFakeGraph().install();
  resetUsageBackoffs();
});
afterEach(() => {
  fake.uninstall();
});

const originalFacebookDeclaration: EngagementDeclaration = facebookEngagement.declaration;
afterEach(() => {
  facebookEngagement.declaration = originalFacebookDeclaration;
});

async function runSection() {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  return atTime(AT, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: AT }));
}

describe("a declared-but-unavailable Meta surface (US6 scenarios 1-2, FR-006, FR-039)", () => {
  it("claims and calls neither Graph nor read() for the unavailable surface, while the other surface still reads to completion in the same run", async () => {
    facebookEngagement.declaration = {
      ...originalFacebookDeclaration,
      readScopes: undefined,
      missingReadScopes: undefined,
      unavailable: { reason: "Facebook comment reading is paused for this install.", docsPath: "meta-setup#engagement" },
    };

    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);

    const fbAccount = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Test Page",
      externalAccountId: PAGE_ID,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pages_read_engagement", "pages_read_user_content"],
    });
    await repos.accounts.setCredentials(fbAccount.id, encryptCredentials(fbAccount.id, { pageToken: TOKEN }), null);
    const { target: fbTarget } = await createDueTarget(ctx.project.id, fbAccount.id);
    const fbPostId = `${PAGE_ID}_555`;
    await repos.targets.update(fbTarget.id, { status: "published", externalId: fbPostId, resolvedAt: AT });
    fake.on("GET", `/v26.0/${PAGE_ID}/posts`, {
      kind: "ok",
      body: { data: [{ id: fbPostId, created_time: "2026-10-18T00:00:00+0000", comments: { data: [{ id: "fb-comment-1", message: "Nice!", created_time: "2026-10-18T01:00:00+0000", from: { name: "Fan", id: "user-1" } }] } }] },
    });

    const igAccount = await repos.accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "Test IG Account",
      externalAccountId: IG_ID,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
    });
    await repos.accounts.setCredentials(igAccount.id, encryptCredentials(igAccount.id, { pageToken: TOKEN }), null);
    const { target: igTarget } = await createDueTarget(ctx.project.id, igAccount.id);
    const igMediaId = `${IG_ID}_777`;
    await repos.targets.update(igTarget.id, { status: "published", externalId: igMediaId, resolvedAt: AT });
    fake.on("GET", `/v26.0/${IG_ID}`, { kind: "ok", body: { username: "brand" } });
    fake.on("GET", `/v26.0/${IG_ID}/media`, {
      kind: "ok",
      body: { data: [{ id: igMediaId, timestamp: "2026-10-18T00:00:00+0000", comments: { data: [{ id: "ig-comment-1", text: "Love this!", timestamp: "2026-10-18T01:00:00+0000", username: "a_follower" }] } }] },
    });

    const counts = await runSection();

    expect(fake.requests.some((r) => r.path === `/v26.0/${PAGE_ID}/posts`)).toBe(false);
    expect(await repos.engagementItems.getByExternalId(fbAccount.id, "fb-comment-1")).toBeNull();
    expect(await repos.engagementAccountStates.get(fbAccount.id)).toBeNull();
    expect(counts.claimed).toBe(1);

    expect(await repos.engagementItems.getByExternalId(igAccount.id, "ig-comment-1")).not.toBeNull();

    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const accountViews = await listEngagementAccounts(scope);
    const fbView = accountViews.find((v) => v.id === fbAccount.id);
    expect(fbView?.unavailable).toEqual({
      reason: "Facebook comment reading is paused for this install.",
      docsPath: "meta-setup#engagement",
    });
    const igView = accountViews.find((v) => v.id === igAccount.id);
    expect(igView?.unavailable).toBeNull();
  });
});
