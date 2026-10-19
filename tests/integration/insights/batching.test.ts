import { afterAll, describe, expect, it } from "vitest";
import { createFakeTikTok } from "../../helpers/fake-tiktok";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);

const NOW = new Date("2026-06-01T00:00:00Z");
const VIDEO_QUERY = "/v2/video/query/";

describe("TikTok post-metric batching (contracts/platform-readers-082.md §4, FR-021, SC-006)", () => {
  it("25 due targets on one account produce two calls of 20 and 5, every id belonging to that one account", async () => {
    await parkAllDueTargets();
    const fake = createFakeTikTok().install();
    try {
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);
      const account = await repos.accounts.upsertConnected({
        providerKey: "tiktok",
        displayName: "Ada",
        externalAccountId: "batching-open-id",
        settings: { username: "ada" },
        credentialsEncrypted: null,
        credentialsExpiresAt: null,
        connectedByUserId: null,
        // Only the post scope is granted, so the account surface (user.info.stats) stays
        // unclaimed and the one assertable batch of calls is the post read's.
        grantedScopes: ["video.list"],
      });
      const credentials = {
        v: 1,
        accessToken: "BATCHING-ACCESS",
        refreshToken: "BATCHING-REFRESH",
        accessExpiresAt: NOW.getTime() + 86_400_000,
        refreshIssuedAt: NOW.getTime(),
        refreshExpiresAt: NOW.getTime() + 31_536_000_000,
        refreshExpiryEstimated: false,
        openId: "batching-open-id",
      };
      await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, credentials), new Date(credentials.refreshExpiresAt));

      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const id = `v${i}`;
        ids.push(id);
        const post = await repos.posts.insert({ baseText: `Hello ${i}` });
        const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
        await repos.targets.update(target!.id, { status: "published", externalId: `ext-${id}`, publicPostId: id, publishedAt: NOW });
      }

      fake.on("POST", VIDEO_QUERY, { kind: "ok", body: { data: { videos: [] }, error: { code: "ok" } } });

      await runTick(tickConfig());

      const calls = fake.callsTo("POST", VIDEO_QUERY);
      expect(calls).toHaveLength(2);
      const counts = calls.map((c) => (c.fields.filters as { video_ids: string[] }).video_ids.length).sort((a, b) => b - a);
      expect(counts).toEqual([20, 5]);
      const allIds = calls.flatMap((c) => (c.fields.filters as { video_ids: string[] }).video_ids);
      expect(new Set(allIds)).toEqual(new Set(ids));
      for (const id of allIds) expect(ids).toContain(id);
    } finally {
      fake.uninstall();
    }
  });
});
