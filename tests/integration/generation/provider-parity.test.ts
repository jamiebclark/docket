/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createAnthropicProvider } from "../../../src/server/llm/anthropic";
import type { LlmConfig } from "../../../src/server/llm/config";
import { setLlmForTests } from "../../../src/server/llm";
import { createOpenAiProvider } from "../../../src/server/llm/openai";
import type { LlmProvider } from "../../../src/server/llm/types";
import * as accounts from "../../../src/server/services/accounts";
import { generateSingle } from "../../../src/server/services/generation/single";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createVoiceProfile } from "../../helpers/factories";
import { createFakeLlmFetch, type FakeLlmResponse } from "../../helpers/fake-llm-http";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterEach(() => setLlmForTests(null));
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const ANSWER = JSON.stringify({ variants: { bluesky: { text: "Spring sale is on" } }, imageAltTexts: ["A red square"] });
const usage = { input: 111, output: 22 };

const openAiOk = (text: string): FakeLlmResponse => ({
  status: 200,
  json: {
    id: "r",
    object: "response",
    created_at: 1,
    model: "m",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
    ],
    usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: 133 },
  },
});
const anthropicOk = (text: string): FakeLlmResponse => ({
  status: 200,
  json: {
    id: "m",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  },
});

const cases = [
  {
    name: "openai" as const,
    ok: openAiOk,
    make: (cfg: LlmConfig, fetch: typeof globalThis.fetch): LlmProvider =>
      createOpenAiProvider(cfg, { fetch, maxRetries: 0 }),
    text: (b: any) => JSON.stringify(b.input) + b.instructions,
    hasImage: (b: any) => JSON.stringify(b.input).includes('"input_image"'),
  },
  {
    name: "anthropic" as const,
    ok: anthropicOk,
    make: (cfg: LlmConfig, fetch: typeof globalThis.fetch): LlmProvider =>
      createAnthropicProvider(cfg, { fetch, maxRetries: 0 }),
    text: (b: any) => JSON.stringify(b.messages) + b.system,
    hasImage: (b: any) => JSON.stringify(b.messages).includes('"type":"image"'),
  },
];

describe.each(cases)("provider parity: $name", (c) => {
  async function setup(responses: FakeLlmResponse[], timeoutMs = 10_000) {
    const storage = createMemoryStorage();
    setStorageForTests(storage);
    const env = await postsEnv();
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
    const account = await accounts.saveConnectedAccount(env.scope, {
      providerKey: "bluesky",
      externalAccountId: `bsky-${randomUUID().slice(0, 8)}`,
      displayName: "Parity",
      settings: {},
    });
    const body = await png(800, 800);
    const key = `projects/${env.project.id}/media/${randomUUID()}/original.png`;
    await storage.put(key, body, "image/png");
    const media = await env.scope.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width: 800,
      height: 800,
      altText: "",
    });
    const fetch = createFakeLlmFetch(responses);
    const llm = c.make(
      { provider: c.name, model: "parity-model", apiKey: "sk-FAKE-parity", timeoutMs, maxOutputTokens: 1000 },
      fetch,
    );
    setLlmForTests(llm);
    const input = {
      requestId: randomUUID(),
      voiceProfileId: profile.id,
      brief: "Announce the spring sale",
      instructions: "No emojis please",
      targetAccountIds: [account.id],
      mediaIds: [media.id],
    };
    return { env, fetch, input };
  }

  it("generates through the configured provider with its own wire form", async () => {
    const t = await setup([c.ok(ANSWER)]);
    const res = await generateSingle(t.env.scope, t.input);
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    const record = ((await t.env.scope.posts.get(res.postId))!.generationMetadata as any).records[0];
    expect(record).toMatchObject({ provider: c.name, model: "parity-model" });
    expect(record.attempts[0]).toMatchObject({ kind: "ok", usage: { inputTokens: 111, outputTokens: 22 } });
    expect(record.attempts[0].latencyMs).toBeGreaterThanOrEqual(0);

    const wire = t.fetch.calls[0]!.body;
    const sent = c.text(wire);
    expect(sent).toContain("Warm and direct.");
    expect(sent).toContain("No emojis please");
    expect(sent).toContain("Announce the spring sale");
    expect(sent).toMatch(/300/);
    expect(c.hasImage(wire)).toBe(true);
  });

  it("a timeout stores the failure with the fixed message", async () => {
    const t = await setup([{ status: 200, delayMs: 5000 }, { status: 200, delayMs: 5000 }], 30);
    const res = await generateSingle(t.env.scope, t.input);
    expect(res).toMatchObject({ ok: false, kind: "timeout", message: "The model took too long to answer." });
    if (res.ok) return;
    const rows = await t.env.scope.generationFailures.listRecent(5);
    expect(rows.map((r) => r.id)).toEqual([res.failureId]);
  });
});
