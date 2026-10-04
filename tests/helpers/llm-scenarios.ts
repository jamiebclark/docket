import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { LlmConfig } from "../../src/server/llm/config";
import type { LlmProvider, LlmRequest } from "../../src/server/llm/types";
import { createFakeLlmFetch, type FakeLlmResponse } from "./fake-llm-http";

export const SCENARIO_KEY = "sk-FAKE-scenario-key-0123456789";
const schema = z.object({ text: z.string() });

/** Provider-specific wire details; the scenario table itself is shared by every provider. */
export interface LlmWire {
  name: string;
  create(cfg: LlmConfig, fetch: typeof globalThis.fetch): LlmProvider;
  ok(text: string, usage: { input: number; output: number }): FakeLlmResponse;
  refusal(): FakeLlmResponse;
  incomplete(): FakeLlmResponse;
  /** Asserts the request body carries system, user, the image before the text and the schema format. */
  expectBody(body: unknown, expected: { system: string; user: string; imageUrl: string; schemaName: string }): void;
}

const config = (): LlmConfig => ({
  provider: "openai",
  model: "test-model",
  apiKey: SCENARIO_KEY,
  timeoutMs: 10_000,
  maxOutputTokens: 1000,
});

const request = (over: Partial<LlmRequest<{ text: string }>> = {}): LlmRequest<{ text: string }> => ({
  label: "generate.single",
  system: "SYSTEM-TEXT",
  user: "USER-TEXT",
  images: [],
  schemaName: "post_output",
  schema,
  ...over,
});

export function runLlmScenarios(wire: LlmWire): void {
  describe(`${wire.name} scenarios`, () => {
    afterEach(() => vi.restoreAllMocks());

    function setup(responses: FakeLlmResponse[], cfg: Partial<LlmConfig> = {}) {
      const fetch = createFakeLlmFetch(responses);
      return { fetch, llm: wire.create({ ...config(), ...cfg }, fetch) };
    }

    test("request body shape", async () => {
      const { llm, fetch } = setup([wire.ok('{"text":"hi"}', { input: 1, output: 1 })]);
      await llm.generate(
        request({ images: [{ kind: "url", url: "https://media.example.com/a.png", mediaType: "image/png" }] }),
      );
      expect(fetch.calls).toHaveLength(1);
      wire.expectBody(fetch.calls[0]!.body, {
        system: "SYSTEM-TEXT",
        user: "USER-TEXT",
        imageUrl: "https://media.example.com/a.png",
        schemaName: "post_output",
      });
    });

    test("valid answer returns value, usage, latency, provider, model", async () => {
      const { llm } = setup([wire.ok('{"text":"hi"}', { input: 12, output: 34 })]);
      const r = await llm.generate(request());
      expect(r).toMatchObject({
        ok: true,
        value: { text: "hi" },
        rawText: '{"text":"hi"}',
        usage: { inputTokens: 12, outputTokens: 34 },
        model: "test-model",
      });
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test("bad JSON → invalid_output with rawText", async () => {
      const { llm } = setup([wire.ok("not json", { input: 1, output: 1 })]);
      expect(await llm.generate(request())).toMatchObject({ ok: false, kind: "invalid_output", rawText: "not json" });
    });

    test("valid JSON that breaks the schema → invalid_output", async () => {
      const { llm } = setup([wire.ok('{"text":5}', { input: 1, output: 1 })]);
      expect(await llm.generate(request())).toMatchObject({ ok: false, kind: "invalid_output" });
    });

    test("refusal", async () => {
      const { llm } = setup([wire.refusal()]);
      expect(await llm.generate(request())).toMatchObject({
        ok: false,
        kind: "refused",
        message: "The model declined to write this post.",
      });
    });

    test("incomplete", async () => {
      const { llm } = setup([wire.incomplete()]);
      expect(await llm.generate(request())).toMatchObject({ ok: false, kind: "incomplete" });
    });

    test.each([
      [429, "rate_limited"],
      [500, "unavailable"],
      [401, "auth"],
      [403, "auth"],
      [400, "bad_request"],
    ])("HTTP %i → %s with the fixed message", async (status, kind) => {
      const { llm } = setup([{ status, json: { error: { message: "SDK-DETAIL-SHOULD-NOT-LEAK" } } }]);
      const r = await llm.generate(request());
      expect(r).toMatchObject({ ok: false, kind });
      expect(JSON.stringify(r)).not.toContain("SDK-DETAIL");
    });

    test("timeout → fixed message", async () => {
      const { llm } = setup([{ status: 200, delayMs: 5000 }], { timeoutMs: 30 });
      expect(await llm.generate(request({ timeoutMs: 30 }))).toMatchObject({
        ok: false,
        kind: "timeout",
        message: "The model took too long to answer.",
      });
    });

    test("the key never appears in a result or a log line", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const results = [];
      for (const response of [wire.ok('{"text":"hi"}', { input: 1, output: 1 }), { status: 401 }, { status: 500 }]) {
        const { llm } = setup([response]);
        results.push(await llm.generate(request()));
      }
      const all = JSON.stringify(results) + JSON.stringify(log.mock.calls) + JSON.stringify(err.mock.calls);
      expect(all).not.toContain(SCENARIO_KEY);
      expect(all).not.toContain("SYSTEM-TEXT");
      expect(log).toHaveBeenCalled();
    });

    test("a non-https image URL is a programmer error", async () => {
      const { llm } = setup([wire.ok('{"text":"hi"}', { input: 1, output: 1 })]);
      await expect(
        llm.generate(request({ images: [{ kind: "url", url: "http://x.test/a.png", mediaType: "image/png" }] })),
      ).rejects.toThrow();
    });
  });
}
