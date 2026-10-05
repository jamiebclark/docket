// FR-035 / constitution VII: a configured API key never reaches stored rows, logs or results.
// Pages are server components fed by the same service results, so those results stand in for the rendered HTML.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as accounts from "../../../src/server/services/accounts";
import { regeneratePost } from "../../../src/server/services/generation/regenerate";
import { getSeries, startSeries, writeSeriesPost } from "../../../src/server/services/generation/series";
import { generateSingle } from "../../../src/server/services/generation/single";
import { listReviewQueue } from "../../../src/server/services/review";
import { listVersions, listVoiceProfiles, tryVoice } from "../../../src/server/services/voice";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

const SECRET = "sk-DISTINCTIVE-fake-secret-7f3a91c2e8b4";
const saved: Record<string, string | undefined> = {};
const lines: string[] = [];

beforeAll(() => {
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    saved[name] = process.env[name];
    process.env[name] = SECRET;
  }
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setStorageForTests(undefined);
  await closeDb();
});

afterEach(() => vi.restoreAllMocks());

const ok = (text: string): FakeStep => ({ ok: { variants: { bluesky: { text } } } });

describe("no secrets", () => {
  it("never appears in rows, logs or results across every generation path", async () => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    setStorageForTests(createMemoryStorage());
    const env = await postsEnv();
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Plain." } });
    const bsky = await accounts.saveConnectedAccount(env.scope, {
      providerKey: "bluesky",
      externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
      displayName: "Bluesky",
      settings: {},
    });
    const mock = await env.account();
    const results: unknown[] = [];

    const single = await generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Sale", targetAccountIds: [bsky.id] },
      createFakeLlm([ok("Single post")]),
    );
    results.push(single);
    if (!single.ok) throw new Error("setup failed");
    results.push(await regeneratePost(env.scope, single.postId, { instruction: "Shorter" }, createFakeLlm([ok("Again")])));

    const { seriesId } = await startSeries(env.scope, {
      voiceProfileId: profile.id,
      brief: "Launch",
      targetAccountIds: [mock.id],
      count: 2,
      angles: [
        { title: "One", description: "First" },
        { title: "Two", description: "Second" },
      ],
    });
    results.push(
      await writeSeriesPost(env.scope, seriesId, 0, createFakeLlm([{ ok: { variants: { mock: { text: "S0" } } } }])),
      await writeSeriesPost(env.scope, seriesId, 1, createFakeLlm([{ fail: "unavailable" }, { fail: "unavailable" }])),
    );
    results.push(await getSeries(env.scope, seriesId));

    const version = (await listVersions(env.scope, profile.id))[0]!;
    results.push(
      await tryVoice(env.scope, { brief: "Try", versionId: version.id, accountIds: [bsky.id] }, createFakeLlm([ok("Tried")])),
    );

    const failed = await generateSingle(
      env.scope,
      { requestId: randomUUID(), voiceProfileId: profile.id, brief: "Fails", targetAccountIds: [bsky.id] },
      createFakeLlm([{ raw: "not json" }, { raw: "still not" }]),
    );
    results.push(failed);

    results.push(await listReviewQueue(env.scope, {}), await listVoiceProfiles(env.scope));
    const seriesView = await getSeries(env.scope, seriesId);
    const postIds = [single.postId, ...seriesView.posts.flatMap((p) => (p ? [p.id] : []))];
    const posts = await Promise.all(postIds.map((id) => env.scope.posts.get(id)));
    const failures = await env.scope.generationFailures.listRecent(50);
    expect(failures.length).toBeGreaterThan(0);

    const haystacks: [string, string][] = [
      ["generation_metadata", JSON.stringify(posts.map((p) => p!.generationMetadata))],
      ["generation_failures", JSON.stringify(failures)],
      ["generation_series", JSON.stringify(seriesView.series)],
      ["logs", lines.join("\n")],
      ["results", JSON.stringify(results)],
    ];
    for (const [name, text] of haystacks) {
      if (name !== "logs") expect(text.length, name).toBeGreaterThan(2);
      expect(text.includes(SECRET), `${name} contains the key`).toBe(false);
    }
  });
});
