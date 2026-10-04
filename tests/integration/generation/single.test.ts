/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NotFoundError } from "../../../src/server/dal/errors";
import type { LlmProvider } from "../../../src/server/llm/types";
import * as accounts from "../../../src/server/services/accounts";
import * as members from "../../../src/server/services/members";
import { generateSingle } from "../../../src/server/services/generation/single";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { createVoiceProfile } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const FAKE_KEY = "sk-FAKE-secret-key-0123456789";

const ok = (variants: Record<string, string>, alts?: string[]): FakeStep => ({
  ok: {
    variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])),
    ...(alts ? { imageAltTexts: alts } : {}),
  },
});

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
  async function account(providerKey: string) {
    return accounts.saveConnectedAccount(env.scope, {
      providerKey,
      externalAccountId: `${providerKey}-${randomUUID().slice(0, 8)}`,
      displayName: `${providerKey} ${randomUUID().slice(0, 4)}`,
      settings: {},
    });
  }
  async function asset(altText = "") {
    const body = await png(800, 800);
    const key = `projects/${env.project.id}/media/${randomUUID()}/original.png`;
    await storage.put(key, body, "image/png");
    return env.scope.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width: 800,
      height: 800,
      altText,
    });
  }
  const input = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    voiceProfileId: profile.id,
    brief: "Announce the spring sale",
    targetAccountIds: [] as string[],
    ...over,
  });
  return { env, profile, account, asset, input };
}

describe("generateSingle", () => {
  it("saves one post with a variant per platform, the image and full metadata", async () => {
    const t = await setup();
    const bsky = await t.account("bluesky");
    const fb = await t.account("facebook");
    const image = await t.asset();
    const llm = createFakeLlm([ok({ bluesky: "Short sale post", facebook: "A longer sale post for Facebook" }, ["A red square"])]);
    const res = await generateSingle(
      t.env.scope,
      t.input({ targetAccountIds: [bsky.id, fb.id], mediaIds: [image.id], sourceText: "Source body", instructions: "No emojis" }),
      llm,
    );
    expect(res).toMatchObject({ ok: true, existing: false, decision: { reviewState: "needs_review" } });
    if (!res.ok) return;
    const post = (await t.env.scope.posts.get(res.postId))!;
    expect(post).toMatchObject({ origin: "generated", reviewState: "needs_review", baseText: "Short sale post" });
    const targets = await t.env.scope.targets.listForPost(post.id);
    expect(Object.fromEntries(targets.map((x) => [x.socialAccountId, x.overrideText]))).toEqual({
      [bsky.id]: "Short sale post",
      [fb.id]: "A longer sale post for Facebook",
    });
    expect(await t.env.scope.posts.listMediaIds(post.id)).toEqual([image.id]);
    expect((await t.env.scope.media.get(image.id))!.altText).toBe("A red square");

    const meta = post.generationMetadata as { v: number; records: Record<string, any>[] };
    const record = meta.records[0]!;
    expect(meta.v).toBe(1);
    expect(record).toMatchObject({
      mode: "single",
      provider: "openai",
      model: "fake-model",
      voiceProfile: { id: t.profile.id, version: 1 },
      retried: null,
      inputs: { brief: "Announce the spring sale", sourceText: "Source body", instructions: "No emojis", mediaAssetIds: [image.id] },
      policies: { resolved: { approval: "review_required" }, decision: { reviewState: "needs_review" } },
    });
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({ kind: "ok", latencyMs: 5, usage: { inputTokens: 100, outputTokens: 50 } });
    expect(record.prompt.images).toHaveLength(1);

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.user).toContain("Announce the spring sale");
    expect(req.user).toContain("Source body");
    expect(req.system + req.user).toContain("No emojis");
    expect(req.system + req.user).toContain("Warm and direct.");
    expect(req.system + req.user).toMatch(/300/);
    expect(req.images).toHaveLength(1);
  });

  it("asks for one variant per platform when two accounts share it", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const b = await t.account("bluesky");
    const llm = createFakeLlm([ok({ bluesky: "Shared variant" })]);
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id, b.id] }), llm);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const targets = await t.env.scope.targets.listForPost(res.postId);
    expect(targets.map((x) => x.overrideText)).toEqual(["Shared variant", "Shared variant"]);
    expect(llm.requests).toHaveLength(1);
  });

  it("returns the same post for a repeated request id", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const llm = createFakeLlm([ok({ bluesky: "Once" })]);
    const input = t.input({ targetAccountIds: [a.id] });
    const first = await generateSingle(t.env.scope, input, llm);
    const second = await generateSingle(t.env.scope, input, llm);
    expect(first).toMatchObject({ ok: true, existing: false });
    expect(second).toMatchObject({ ok: true, existing: true });
    if (first.ok && second.ok) expect(second.postId).toBe(first.postId);
    expect(llm.requests).toHaveLength(1);
  });

  it("retries once when the first answer is over the limit", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const llm = createFakeLlm([ok({ bluesky: "x".repeat(400) }), ok({ bluesky: "Fits now" })]);
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id] }), llm);
    expect(res).toMatchObject({ ok: true, remainingProblems: [] });
    expect(llm.requests).toHaveLength(2);
    if (!res.ok) return;
    const record = ((await t.env.scope.posts.get(res.postId))!.generationMetadata as any).records[0];
    expect(record.retried).toMatchObject({ reason: "invalid_platform" });
    expect(record.attempts.map((x: { kind: string }) => x.kind)).toEqual(["invalid_platform", "ok"]);
  });

  it("saves nothing and records a failure when the model is unreadable twice", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const llm = createFakeLlm([{ raw: "nope" }, { raw: "still nope" }]);
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id] }), llm);
    expect(res).toMatchObject({ ok: false, kind: "invalid_output" });
    if (res.ok) return;
    const rows = await t.env.scope.generationFailures.listRecent(5);
    expect(rows.map((r) => r.id)).toEqual([res.failureId]);
    expect(rows[0]).toMatchObject({ mode: "single", postId: null });
    expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
    expect((await t.env.scope.posts.listMediaIds(randomUUID())).length).toBe(0);
  });

  it("saves in review with remaining problems when the answer stays invalid", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const llm = createFakeLlm([ok({ bluesky: "y".repeat(400) }), ok({ bluesky: "z".repeat(400) })]);
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id], approval: null }), llm);
    expect(res).toMatchObject({ ok: true, decision: { reviewState: "needs_review" } });
    if (!res.ok) return;
    expect(res.remainingProblems[0]!.providerKey).toBe("bluesky");
    expect((await t.env.scope.posts.get(res.postId))!.reviewState).toBe("needs_review");
  });

  it("fills only an empty alt text", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const empty = await t.asset("");
    const filled = await t.asset("Mine");
    const llm = createFakeLlm([ok({ bluesky: "Two pictures" }, ["Generated one", "Generated two"])]);
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id], mediaIds: [empty.id, filled.id] }), llm);
    expect(res.ok).toBe(true);
    expect((await t.env.scope.media.get(empty.id))!.altText).toBe("Generated one");
    expect((await t.env.scope.media.get(filled.id))!.altText).toBe("Mine");
  });

  it("records the profile version taken at the start", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const inner = createFakeLlm([ok({ bluesky: "Versioned" })]);
    const llm: LlmProvider = {
      ...inner,
      generate: async (request) => {
        const v2 = await t.env.scope.voiceVersions.insert({ profileId: t.profile.id, version: 2, content: { voiceAndTone: "Changed" } });
        await t.env.scope.voiceProfiles.setCurrentVersion(t.profile.id, v2.version);
        return inner.generate(request);
      },
    };
    const res = await generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id] }), llm);
    if (!res.ok) throw new Error("expected ok");
    const record = ((await t.env.scope.posts.get(res.postId))!.generationMetadata as any).records[0];
    expect(record.voiceProfile).toMatchObject({ id: t.profile.id, version: 1 });
  });

  it("refuses the save when the member was removed during the call", async () => {
    const t = await setup();
    const a = await t.account("bluesky");
    const editorScope = await t.env.as(t.env.editor);
    const inner = createFakeLlm([ok({ bluesky: "Too late" })]);
    const llm: LlmProvider = {
      ...inner,
      generate: async (request) => {
        await members.remove(t.env.scope, { userId: t.env.editor.id });
        return inner.generate(request);
      },
    };
    await expect(generateSingle(editorScope, t.input({ targetAccountIds: [a.id] }), llm)).rejects.toThrow();
    const rows = await t.env.scope.posts.findByRequestId(randomUUID());
    expect(rows).toBeNull();
  });

  it("treats a foreign or archived reference as not found, and refuses oversized text before any call", async () => {
    const t = await setup();
    const other = await setup();
    const a = await t.account("bluesky");
    const foreignAccount = await other.account("bluesky");
    const foreignMedia = await other.asset();
    const llm = createFakeLlm([]);
    const run = (over: Record<string, unknown>) =>
      generateSingle(t.env.scope, t.input({ targetAccountIds: [a.id], ...over }), llm);
    await expect(run({ targetAccountIds: [foreignAccount.id] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(run({ mediaIds: [foreignMedia.id] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(run({ voiceProfileId: other.profile.id })).rejects.toBeInstanceOf(NotFoundError);
    await t.env.scope.voiceProfiles.setArchived(t.profile.id, new Date());
    await expect(run({})).rejects.toBeInstanceOf(NotFoundError);
    await t.env.scope.voiceProfiles.setArchived(t.profile.id, null);
    await expect(run({ brief: "b".repeat(2001) })).rejects.toThrow();
    await expect(run({ instructions: "i".repeat(2001) })).rejects.toThrow();
    await expect(run({ sourceText: "s".repeat(50_001) })).rejects.toThrow();
    expect(llm.requests).toHaveLength(0);
  });
});
