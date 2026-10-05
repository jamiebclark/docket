import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as accounts from "../../../src/server/services/accounts";
import { planSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { generateSingle } from "../../../src/server/services/generation/single";
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
  async function account(displayName: string, instructions: string | null) {
    const a = await accounts.connectMock(env.scope, { displayName, settings: {} });
    if (instructions) await accounts.setPostingInstructions(env.scope, a.id, { instructions });
    return a;
  }
  const input = (ids: string[]) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Posting instructions",
    targetAccountIds: ids,
  });
  const targetsOf = async (postId: string) => {
    const rows = await env.scope.targets.listForPost(postId);
    return new Map(rows.map((t) => [t.socialAccountId, t.overrideText]));
  };
  const recordOf = async (postId: string) =>
    ((await env.scope.posts.get(postId))!.generationMetadata as { records: { accounts?: unknown }[] }).records[0]!;
  return { env, account, input, targetsOf, recordOf };
}

describe("generation with posting instructions", () => {
  it("(a) identical instructions give one variant that both targets share", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Hashtags last.");
    const b = await t.account("Acme B", "  Hashtags last.\r\n");
    const llm = createFakeLlm([variants({ mock: "Shared text" })]);
    const res = await generateSingle(t.env.scope, t.input([a.id, b.id]), llm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const targets = await t.targetsOf(res.postId);
    expect(targets.get(a.id)).toBe("Shared text");
    expect(targets.get(b.id)).toBe("Shared text");
    expect(llm.requests[0]!.system).toContain("mock (Mock (offline)) for Acme A, Acme B:");
  });

  it("(b) different instructions give one variant per group, each target its own text", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Be formal.");
    const b = await t.account("Acme B", "Be casual.");
    const llm = createFakeLlm([variants({ mock_1: "Formal text", mock_2: "Casual text" })]);
    const res = await generateSingle(t.env.scope, t.input([a.id, b.id]), llm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const targets = await t.targetsOf(res.postId);
    expect(targets.get(a.id)).toBe("Formal text");
    expect(targets.get(b.id)).toBe("Casual text");
    const { system } = llm.requests[0]!;
    expect(system).toContain("mock_1 (Mock (offline)) for Acme A:");
    expect(system).toContain("mock_2 (Mock (offline)) for Acme B:");
    const post = await t.env.scope.posts.get(res.postId);
    expect(post!.baseText).toBe("Formal text");
  });

  it("(c) one account per platform without instructions keeps the old keys and prompt", async () => {
    const t = await setup();
    const a = await t.account("Acme A", null);
    const llm = createFakeLlm([variants({ mock: "Plain text" })]);
    const res = await generateSingle(t.env.scope, t.input([a.id]), llm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(llm.requests[0]!.system).not.toContain("POSTING INSTRUCTIONS");
    expect((await t.targetsOf(res.postId)).get(a.id)).toBe("Plain text");
  });

  it("records the instructions each account received, and a later edit leaves the record unchanged", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Be formal.");
    const b = await t.account("Acme B", null);
    const res = await generateSingle(t.env.scope, t.input([a.id, b.id]), createFakeLlm([variants({ mock_1: "One", mock_2: "Two" })]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await accounts.setPostingInstructions(t.env.scope, a.id, { instructions: "Changed." });
    const record = await t.recordOf(res.postId);
    expect(record.accounts).toEqual([
      { accountId: a.id, displayName: "Acme A", providerKey: "mock", instructions: "Be formal.", groupKey: "mock_1" },
      { accountId: b.id, displayName: "Acme B", providerKey: "mock", instructions: null, groupKey: "mock_2" },
    ]);
  });

  it("names the group in the retry and asks for the same keys", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Be formal.");
    const b = await t.account("Acme News", "Be casual.");
    const llm = createFakeLlm([
      variants({ mock_1: "Fine", mock_2: "a".repeat(600) }),
      variants({ mock_1: "Fine", mock_2: "Short now" }),
    ]);
    const res = await generateSingle(t.env.scope, t.input([a.id, b.id]), llm);
    expect(res.ok).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user).toContain("mock_2 (Mock (offline): Acme News):");
    expect(llm.requests[1]!.system).toContain("mock_1");
    expect(llm.requests[1]!.system).toContain("mock_2");
  });

  it("series: the plan and every series post prompt carry the section, and each post records the snapshot", async () => {
    const t = await setup();
    const a = await t.account("Acme A", "Hashtags last.");
    const angles = [
      { title: "Angle 1", description: "About thing 1" },
      { title: "Angle 2", description: "About thing 2" },
    ];
    const base = { voiceProfileId: t.input([]).voiceProfileId, brief: "Launch week", targetAccountIds: [a.id], count: 2 };
    const planLlm = createFakeLlm([{ ok: { angles } }]);
    await planSeries(t.env.scope, base, planLlm);
    expect(planLlm.requests[0]!.system).toContain("Hashtags last.");
    expect(planLlm.requests[0]!.system).toContain("for Acme A");

    const { seriesId } = await startSeries(t.env.scope, { ...base, angles });
    const llm = createFakeLlm([variants({ mock: "p0" }), variants({ mock: "p1" })]);
    for (let i = 0; i < 2; i++) {
      const res = await writeSeriesPost(t.env.scope, seriesId, i, llm);
      expect(res).toMatchObject({ ok: true });
    }
    for (const req of llm.requests) {
      expect(req.system).toContain("Hashtags last.");
      expect(req.system).toContain("for Acme A");
    }
    for (let i = 0; i < 2; i++) {
      const post = (await t.env.scope.posts.findBySeriesPosition(seriesId, i))!;
      const record = (post.generationMetadata as { records: { accounts?: unknown }[] }).records[0]!;
      expect(record.accounts).toEqual([
        expect.objectContaining({ accountId: a.id, displayName: "Acme A", instructions: "Hashtags last." }),
      ]);
    }
  });
});
