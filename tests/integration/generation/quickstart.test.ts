/* eslint-disable @typescript-eslint/no-explicit-any */
// quickstart.md §2–§3 headline numbers, asserted by running the code.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { bulkApprove } from "../../../src/server/services/review";
import { saveVoiceProfile } from "../../../src/server/services/voice";
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

const ok = (text: string): FakeStep => ({ ok: { variants: { bluesky: { text } } } });

async function setup() {
  setStorageForTests(createMemoryStorage());
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
    displayName: "Bluesky",
    settings: {},
  });
  const gen = (steps: FakeStep[], over: Record<string, unknown> = {}) => {
    const llm = createFakeLlm(steps);
    const run = generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Sale", targetAccountIds: [account.id], ...over },
      llm,
    );
    return { llm, run };
  };
  return { env, profile, account, gen };
}

describe("quickstart conformance", () => {
  it("SC-004: exactly 2 model calls when the first answer breaks a platform rule and the second is valid", async () => {
    const t = await setup();
    const { llm, run } = t.gen([ok("x".repeat(301)), ok("Fits")]);
    const res = await run;
    expect(res.ok).toBe(true);
    expect(llm.requests).toHaveLength(2);
    if (res.ok) expect((await t.env.scope.posts.get(res.postId))!.baseText).toBe("Fits");
  });

  it("SC-002: every post from the policy matrix carries complete generation metadata", async () => {
    const t = await setup();
    for (const approval of ["review_required", "auto_approve"] as const) {
      for (const scheduling of ["leave_as_draft", "add_to_queue"] as const) {
        const { run } = t.gen([ok(`${approval} ${scheduling}`)], { approval, scheduling, confirmUnreviewedQueue: true });
        const res = await run;
        expect(res.ok, `${approval}/${scheduling}`).toBe(true);
        if (!res.ok) continue;
        const post = (await t.env.scope.posts.get(res.postId))!;
        const meta = post.generationMetadata as { v: number; records: any[] };
        const record = meta.records[0];
        expect(meta.v).toBe(1);
        expect(record).toMatchObject({
          mode: "single",
          provider: "openai",
          model: "fake-model",
          voiceProfile: { id: t.profile.id, version: 1 },
          inputs: { brief: "Sale" },
          policies: { requested: expect.anything(), resolved: { approval, scheduling }, decision: expect.anything() },
        });
        expect(record.attempts.length).toBeGreaterThan(0);
        expect(record.prompt).toBeDefined();
      }
    }
  });

  it("SC-006: earlier posts still name their original voice version after an edit", async () => {
    const t = await setup();
    const first = await t.gen([ok("Before the edit")]).run;
    const saved = await saveVoiceProfile(t.env.scope, t.profile.id, {
      name: t.profile.name,
      baseVersion: 1,
      content: { voiceAndTone: "Now brisk." },
    });
    expect(saved.version).toBe(2);
    const second = await t.gen([ok("After the edit")]).run;
    if (!first.ok || !second.ok) throw new Error("generation failed");
    const versionOf = async (id: string) =>
      ((await t.env.scope.posts.get(id))!.generationMetadata as any).records[0].voiceProfile.version;
    expect(await versionOf(first.postId)).toBe(1);
    expect(await versionOf(second.postId)).toBe(2);
  });

  it("SC-008: a bulk approve of 20 valid posts reports 20 approved", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await t.gen([ok(`Valid post ${i}`)], { approval: "review_required", scheduling: "leave_as_draft" }).run;
      if (!res.ok) throw new Error("generation failed");
      ids.push(res.postId);
    }
    const result = await bulkApprove(t.env.scope, { postIds: ids });
    expect(result.skipped).toEqual([]);
    expect(result.approved).toHaveLength(20);
  });
});
