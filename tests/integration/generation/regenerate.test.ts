/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ConflictError } from "../../../src/server/dal/errors";
import * as accounts from "../../../src/server/services/accounts";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { generateSingle } from "../../../src/server/services/generation/single";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const ok = (bluesky: string): FakeStep => ({ ok: { variants: { bluesky: { text: bluesky } } } });

async function setup() {
  setStorageForTests(createMemoryStorage());
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Version one" } });
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
    displayName: "Bluesky",
    settings: {},
  });
  const first = await generateSingle(
    env.scope,
    { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Sale", targetAccountIds: [account.id] },
    createFakeLlm([ok("First draft")]),
  );
  if (!first.ok) throw new Error("setup failed");
  const records = async () =>
    ((await env.scope.posts.get(first.postId))!.generationMetadata as { records: any[] }).records;
  return { env, profile, account, postId: first.postId, records };
}

describe("regeneratePost", () => {
  it("replaces the content, appends a record and keeps the first", async () => {
    const t = await setup();
    const v2 = await t.env.scope.voiceVersions.insert({ profileId: t.profile.id, version: 2, content: { voiceAndTone: "Version two" } });
    await t.env.scope.voiceProfiles.setCurrentVersion(t.profile.id, v2.version);
    const llm = createFakeLlm([ok("Second draft")]);
    const res = await regeneratePost(t.env.scope, t.postId, { instruction: "Make it punchier" }, llm);
    expect(res).toMatchObject({ ok: true, existing: false });
    const post = (await t.env.scope.posts.get(t.postId))!;
    expect(post.baseText).toBe("Second draft");
    expect((await t.env.scope.targets.listForPost(t.postId))[0]!.overrideText).toBe("Second draft");
    expect(post.reviewState).toBe("needs_review");
    const records = await t.records();
    expect(records).toHaveLength(2);
    expect(records[0].output.variants.bluesky).toBe("First draft");
    expect(records[1]).toMatchObject({ mode: "regenerate", voiceProfile: { version: 2 } });
    expect(records[1].inputs.instructions).toBe("Make it punchier");
    expect(llm.requests[0]!.system + llm.requests[0]!.user).toContain("Version two");
  });

  it("keeps the earlier instructions as a separate line", async () => {
    const t = await setup();
    const llm = createFakeLlm([ok("Again"), ok("Again two")]);
    await regeneratePost(t.env.scope, t.postId, { instruction: "One" }, llm);
    await regeneratePost(t.env.scope, t.postId, { instruction: "Two" }, llm);
    expect((await t.records())[2].inputs.instructions).toBe("One\nTwo");
  });

  it("never approves; new content on an approved post goes back to review under review_required (F1)", async () => {
    const t = await setup();
    await t.env.scope.posts.update(t.postId, { reviewState: "approved" });
    const valid = await regeneratePost(t.env.scope, t.postId, {}, createFakeLlm([ok("Fine and short")]));
    expect(valid).toMatchObject({ ok: true, decision: { reviewState: "needs_review", reason: "Review required by policy" } });
    expect((await t.env.scope.posts.get(t.postId))!.reviewState).toBe("needs_review");
    const bad = createFakeLlm([ok("x".repeat(400)), ok("y".repeat(400))]);
    const res = await regeneratePost(t.env.scope, t.postId, {}, bad);
    expect(res).toMatchObject({ ok: true, decision: { reviewState: "needs_review" } });
    expect((await t.env.scope.posts.get(t.postId))!.reviewState).toBe("needs_review");
    const targets = await t.env.scope.targets.listForPost(t.postId);
    expect(targets.every((x) => x.status === "draft")).toBe(true);
  });

  it("is refused while a target is scheduled", async () => {
    const t = await setup();
    const [target] = await t.env.scope.targets.listForPost(t.postId);
    await t.env.scope.targets.update(target!.id, { status: "scheduled", scheduledAt: new Date(Date.now() + 3_600_000), scheduleKind: "explicit", nextAttemptAt: new Date(Date.now() + 3_600_000) });
    const llm = createFakeLlm([]);
    await expect(regeneratePost(t.env.scope, t.postId, {}, llm)).rejects.toThrow("Unschedule this post before regenerating.");
    expect(llm.requests).toHaveLength(0);
  });

  it("is refused for a post without a generation record", async () => {
    const t = await setup();
    const manual = await t.env.scope.posts.insert({ baseText: "By hand" });
    await t.env.scope.targets.insertMany([{ postId: manual.id, socialAccountId: t.account.id }]);
    await expect(regeneratePost(t.env.scope, manual.id, {}, createFakeLlm([]))).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes a failure row with the post id and leaves the post unchanged", async () => {
    const t = await setup();
    const res = await regeneratePost(t.env.scope, t.postId, {}, createFakeLlm([{ fail: "auth" }]));
    expect(res).toMatchObject({ ok: false, kind: "auth" });
    const rows = await t.env.scope.generationFailures.listRecent(5);
    expect(rows[0]).toMatchObject({ mode: "regenerate", postId: t.postId });
    expect((await t.env.scope.posts.get(t.postId))!.baseText).toBe("First draft");
    expect(await t.records()).toHaveLength(1);
  });
});
