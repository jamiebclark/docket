/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ValidationIssuesError } from "../../../src/server/dal/errors";
import { setLlmForTests } from "../../../src/server/llm";
import * as accounts from "../../../src/server/services/accounts";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { planSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { generateSingle } from "../../../src/server/services/generation/single";
import { tryVoice } from "../../../src/server/services/voice";
import { createJob } from "../../../src/server/services/jobs";
import { api, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);
afterEach(() => setLlmForTests(null));

const ok = { ok: { variants: { mock: { text: "A post" } } } };

/** `n` mock accounts, each with its own posting instructions unless `same` (then they all share one set). */
async function setup(n: number, same = false) {
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
  const list = [];
  for (let i = 0; i < n; i++) {
    const a = await accounts.connectMock(env.scope, { displayName: `Acct ${i}`, settings: {} });
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: same ? "Same rules." : `Rules ${i}` });
    list.push(a);
  }
  const ids = list.map((a) => a.id);
  const llm = createFakeLlm([ok, ok, ok]);
  return { env, profile, list, ids, llm };
}

async function refusal(p: Promise<unknown>) {
  const e = (await p.then(() => null, (err: unknown) => err)) as ValidationIssuesError | null;
  expect(e).toBeInstanceOf(ValidationIssuesError);
  expect(e!.message).toContain("17");
  expect(e!.message).toContain("16");
  expect(e!.issues).toMatchObject([{ code: "too_many_groups", field: "targetAccountIds" }]);
}

describe("group limit (17 groups refused before any model call)", () => {
  it("single", async () => {
    const t = await setup(17);
    const requestId = randomUUID();
    await refusal(
      generateSingle(t.env.scope, { requestId, voiceProfileId: t.profile.id, brief: "B", targetAccountIds: t.ids }, t.llm),
    );
    expect(t.llm.requests).toHaveLength(0);
    expect(await t.env.scope.posts.findByRequestId(requestId)).toBeFalsy();
    expect(await t.env.scope.generationFailures.listRecent(50)).toEqual([]);
  });

  it("Try it", async () => {
    const t = await setup(17);
    await refusal(tryVoice(t.env.scope, { brief: "B", accountIds: t.ids, draft: { voiceAndTone: "Plain." } }, t.llm));
    expect(t.llm.requests).toHaveLength(0);
    expect(await t.env.scope.generationFailures.listRecent(50)).toEqual([]);
  });

  it("series plan, start and post", async () => {
    const t = await setup(17);
    const input = { voiceProfileId: t.profile.id, brief: "B", targetAccountIds: t.ids, count: 2 };
    await refusal(planSeries(t.env.scope, input, t.llm));
    await refusal(startSeries(t.env.scope, { ...input, angles: [{ title: "A", description: "a" }] }));
    expect(t.llm.requests).toHaveLength(0);

    // A series saved while the accounts shared instructions is refused at write time once they differ.
    const s = await setup(17, true);
    const { seriesId } = await startSeries(s.env.scope, {
      voiceProfileId: s.profile.id,
      brief: "B",
      targetAccountIds: s.ids,
      count: 2,
      angles: [{ title: "A", description: "a" }],
    });
    for (const [i, a] of s.list.entries()) await accounts.setPostingInstructions(s.env.scope, a.id, { instructions: `New ${i}` });
    await refusal(writeSeriesPost(s.env.scope, seriesId, 0, s.llm));
    expect(s.llm.requests).toHaveLength(0);
    expect(await s.env.scope.posts.findBySeriesPosition(seriesId, 0)).toBeFalsy();
  });

  it("regenerate, when instructions have since diverged", async () => {
    const t = await setup(17, true);
    const first = await generateSingle(
      t.env.scope,
      { requestId: randomUUID(), voiceProfileId: t.profile.id, brief: "B", targetAccountIds: t.ids },
      t.llm,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const calls = t.llm.requests.length;
    for (const [i, a] of t.list.entries()) await accounts.setPostingInstructions(t.env.scope, a.id, { instructions: `New ${i}` });
    await refusal(regeneratePost(t.env.scope, first.postId, {}, t.llm));
    expect(t.llm.requests).toHaveLength(calls);
  });

  it("job creation", async () => {
    const t = await setup(17);
    setLlmForTests(t.llm);
    await refusal(
      createJob(t.env.scope, {
        source: { kind: "api", fields: ["x"], open: true },
        template: "Say {{x}}.",
        targetAccountIds: t.ids,
        voiceProfileId: t.profile.id,
        confirmUnreviewedQueue: false,
      }),
    );
    expect(t.llm.requests).toHaveLength(0);
  });

  it("exactly 16 groups proceed", async () => {
    const t = await setup(16);
    const variants = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`mock_${i + 1}`, { text: `T${i}` }]));
    const llm = createFakeLlm([{ ok: { variants } }]);
    const res = await generateSingle(
      t.env.scope,
      { requestId: randomUUID(), voiceProfileId: t.profile.id, brief: "B", targetAccountIds: t.ids },
      llm,
    );
    expect(res.ok).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("POST /generate and POST /jobs answer 400 validation_failed with too_many_groups", async () => {
    const t = await setup(17);
    setLlmForTests(t.llm);
    const key = (await createKey(t.env.scope, ["read", "generate", "manage_jobs"], { rateLimitPerMinute: 1000 })).secret;
    const gen = await api("POST", "/generate", {
      key,
      body: { brief: "B", accountIds: t.ids, voiceProfileId: t.profile.id },
    });
    expect(gen.status).toBe(400);
    expect(gen.json.error.code).toBe("validation_failed");
    expect(JSON.stringify(gen.json)).toContain("too_many_groups");
    expect((await t.env.scope.posts.list({ limit: 10, offset: 0 })).total).toBe(0);
    expect(await t.env.scope.generationFailures.listRecent(50)).toEqual([]);
    const job = await api("POST", "/jobs", {
      key,
      body: {
        source: { kind: "api", fields: ["x"], open: true },
        template: "Say {{x}}.",
        accountIds: t.ids,
        voiceProfileId: t.profile.id,
      },
    });
    expect(job.status).toBe(400);
    expect(JSON.stringify(job.json)).toContain("too_many_groups");
    expect(t.llm.requests).toHaveLength(0);
  });
});
