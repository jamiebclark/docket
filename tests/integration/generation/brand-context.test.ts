/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as accounts from "../../../src/server/services/accounts";
import { createJob } from "../../../src/server/services/jobs";
import * as projectsService from "../../../src/server/services/projects";
import { planSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { generateSingle } from "../../../src/server/services/generation/single";
import { tryVoice } from "../../../src/server/services/voice";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { jobsEnv, parkAllJobs, tickConfig } from "../../helpers/jobs-env";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  setLlmForTests(null);
  await closeDb();
});

const BRAND = { tagline: "Fresh bread daily", description: "A neighbourhood bakery.", websiteUrl: "https://bakery.example" };

async function setBrand(scope: { project: { id: string; slug: string; name: string; timezone: string } }) {
  await projectsService.updateSettings(scope as any, {
    name: scope.project.name,
    slug: scope.project.slug,
    timezone: scope.project.timezone,
    defaultApprovalPolicy: "review_required",
    defaultSchedulingPolicy: "leave_as_draft",
    confirmUnreviewedQueue: false,
    ...BRAND,
  });
}

const BRAND_LINES = ["BRAND\nTagline: Fresh bread daily", "A neighbourhood bakery.", "Website: https://bakery.example"];

const ok = (variants: Record<string, string>): FakeStep => ({
  ok: { variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])) },
});

describe("brand context reaches every generation entry point", () => {
  it("a single generation carries the brand", async () => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm." } });
    const account = await env.account();
    const llm = createFakeLlm([ok({ mock: "Hello" })]);
    const res = await generateSingle(
      scope,
      { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Announce", targetAccountIds: [account.id] },
      llm,
    );
    expect(res.ok).toBe(true);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });

  it("a regenerate carries the brand", async () => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm." } });
    const account = await env.account();
    const first = await generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Announce", targetAccountIds: [account.id] },
      createFakeLlm([ok({ mock: "First" })]),
    );
    if (!first.ok) throw new Error("setup failed");
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const llm = createFakeLlm([ok({ mock: "Second" })]);
    await regeneratePost(scope, first.postId, { instruction: "Punchier" }, llm);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });

  it("voice \"Try it\" carries the brand", async () => {
    const env = await postsEnv();
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
    const account = await accounts.connectMock(scope, { displayName: "Acme", settings: {} });
    const llm = createFakeLlm([ok({ mock: "Sample" })]);
    const res = await tryVoice(scope, { brief: "Say hello", accountIds: [account.id], versionId: profile.versionIds[0] }, llm);
    expect(res.variants).toHaveLength(1);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });

  it("a batch job item carries the brand", async () => {
    setLlmForTests(null);
    await parkAllJobs();
    const e = await jobsEnv();
    await setBrand(e.scope);
    const llm = createFakeLlm([ok({ mock: "Job post" })]);
    setLlmForTests(llm);
    await e.assets(1);
    const { jobId } = await createJob(e.scope, e.input());
    for (let i = 0; i < 15; i++) {
      await runTick(tickConfig({ jobMaxItems: 2 }));
      const counts = await e.scope.jobItems.countByStatus(jobId);
      if (counts.queued + counts.running === 0) break;
    }
    expect(llm.requests.length).toBeGreaterThan(0);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });

  it("a series plan carries the brand", async () => {
    const env = await postsEnv();
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
    const account = await env.account();
    const llm = createFakeLlm([{ ok: { angles: [{ title: "A", description: "d" }, { title: "B", description: "e" }] } }]);
    const res = await planSeries(scope, { voiceProfileId: profile.id, brief: "Launch", targetAccountIds: [account.id], count: 2 }, llm);
    expect(res.ok).toBe(true);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });

  it("a series post carries the brand", async () => {
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    await setBrand(env.scope);
    const scope = await env.as(env.owner);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
    const account = await env.account();
    const seriesId = (
      await startSeries(scope, {
        voiceProfileId: profile.id,
        brief: "Launch",
        targetAccountIds: [account.id],
        count: 2,
        angles: [{ title: "A", description: "d" }, { title: "B", description: "e" }],
      })
    ).seriesId;
    const llm = createFakeLlm([ok({ mock: "Post" })]);
    await writeSeriesPost(scope, seriesId, 0, llm);
    const req = llm.requests[0]!;
    for (const line of BRAND_LINES) expect(req.system).toContain(line);
  });
});
