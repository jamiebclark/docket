import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { posts } from "../../../src/server/db/schema";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { groupsForAccounts } from "../../../src/server/services/generation/groups";
import { saveGeneratedPost } from "../../../src/server/services/generation/save";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
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
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `bluesky-${randomUUID().slice(0, 8)}`,
    displayName: "Bluesky account",
    settings: {},
  });
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Announce the spring sale",
    targetAccountIds: [account.id],
    ...over,
  });
  return { env, profile, account, input };
}

describe("external id claim atomicity", () => {
  it("leaves neither post nor claim when the save throws after the post insert", async () => {
    const t = await setup();
    const account = (await t.env.scope.accounts.get(t.account.id))!;
    const countPosts = async () =>
      Number((await testDb().select({ n: sql`count(*)` }).from(posts).where(eq(posts.projectId, t.env.project.id)))[0]!.n);
    const before = await countPosts();

    await expect(
      t.env.scope.transaction(async (tx) => {
        const broken = { ...tx, externalClaims: { ...tx.externalClaims, insert: async () => { throw new Error("boom"); } } };
        return saveGeneratedPost(broken, {
          accounts: [account],
          groups: groupsForAccounts([account]),
          variants: { [account.providerKey]: "Will not survive" },
          assets: [],
          imageAltTexts: null,
          record: {
            at: new Date().toISOString(),
            mode: "single",
            provider: "openai",
            model: "fake-model",
            voiceProfile: { id: t.profile.id, versionId: randomUUID(), version: 1, name: "Voice" },
            inputs: { brief: "x", sourceText: null, instructions: null, series: null, mediaAssetIds: [], targetAccountIds: [account.id] },
            prompt: { system: "", user: "", images: [] },
            policies: { requested: {}, resolved: { approval: "review_required", scheduling: "leave_as_draft" }, decision: null },
            attempts: [],
            retried: null,
            output: { variants: { [account.providerKey]: "Will not survive" } },
            remainingProblems: [],
            accounts: [],
          } as unknown as Parameters<typeof saveGeneratedPost>[1]["record"],
          schedulingPolicy: "leave_as_draft",
          createdByUserId: tx.membership.userId,
          link: { generationRequestId: randomUUID() },
          external: { sourceKey: "weird-glens", externalId: "glen-atomic" },
        });
      }),
    ).rejects.toThrow("boom");

    expect(await countPosts()).toBe(before);
    expect(await t.env.scope.externalClaims.find("weird-glens", "glen-atomic")).toBeNull();
  });

  it("leaves the id unclaimed after a model failure, so the next tagged call generates normally", async () => {
    const t = await setup();
    const llm = createFakeLlm([{ raw: "nope" }, { raw: "still nope" }]);
    const failed = await generateSingle(t.env.scope, t.input({ externalId: "glen-retry" }), llm);
    expect(failed).toMatchObject({ ok: false, kind: "invalid_output" });
    expect(await t.env.scope.externalClaims.find("default", "glen-retry")).toBeNull();

    const llm2 = createFakeLlm([ok("Now it works")]);
    const second = await generateSingle(t.env.scope, t.input({ externalId: "glen-retry" }), llm2);
    expect(second).toMatchObject({ ok: true, existing: false });
    const claim = await t.env.scope.externalClaims.find("default", "glen-retry");
    expect(claim).not.toBeNull();
  });
});
