/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import * as accounts from "../../../src/server/services/accounts";
import { tryVoice } from "../../../src/server/services/voice";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const variants = (v: Record<string, string>) => ({
  ok: { variants: Object.fromEntries(Object.entries(v).map(([k, text]) => [k, { text }])) },
});

async function setup() {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const versionId = profile.versionIds[0]!;
  async function account(displayName: string, instructions: string | null) {
    const a = await accounts.connectMock(env.scope, { displayName, settings: {} });
    if (instructions) await accounts.setPostingInstructions(env.scope, a.id, { instructions });
    return a;
  }
  return { env, versionId, profileId: profile.id, account };
}

describe("tryVoice with accounts", () => {
  it("writes one sample per instruction group, labelled by account, and saves nothing", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Be formal.");
    const b = await t.account("Acme B", "Be casual.");
    const snapshot = async () => ({
      posts: (await t.env.scope.posts.list({ limit: 50, offset: 0 })).total,
      failures: (await t.env.scope.generationFailures.listRecent(50)).length,
      versions: (await t.env.scope.voiceVersions.listForProfile(t.profileId)).length,
    });
    const before = await snapshot();
    const llm = createFakeLlm([variants({ mock_1: "Formal sample", mock_2: "Casual sample" })]);
    const res = await tryVoice(
      t.env.scope,
      { brief: "Say hello", accountIds: [a.id, b.id], versionId: t.versionId },
      llm,
    );
    expect(res.variants.map((v) => [v.key, v.accountNames, v.text])).toEqual([
      ["mock_1", ["Acme A"], "Formal sample"],
      ["mock_2", ["Acme B"], "Casual sample"],
    ]);
    expect(res.variants[0]!.providerName).toBe("Mock (offline)");
    expect(llm.requests[0]!.system).toContain("Be formal.");
    expect(llm.requests[0]!.system).toContain("Be casual.");
    expect(await snapshot()).toEqual(before);
  });

  it("defaults to the project's accounts and shares a sample between identical instructions", async () => {
    const t = await setup();
    await t.account("Acme A", null);
    await t.account("Acme B", null);
    const llm = createFakeLlm([variants({ mock: "Shared" })]);
    const res = await tryVoice(t.env.scope, { brief: "Say hello", versionId: t.versionId }, llm);
    expect(res.variants).toHaveLength(1);
    expect(res.variants[0]!.accountNames).toEqual(["Acme A", "Acme B"]);
  });

  it("refuses when the project has no accounts", async () => {
    const t = await setup();
    const err = await tryVoice(t.env.scope, { brief: "Hi", versionId: t.versionId }, createFakeLlm([])).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("Connect an account to try the voice.");
  });
});
