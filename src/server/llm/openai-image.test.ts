import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { createFakeLlmFetch } from "../../../tests/helpers/fake-llm-http";
import { createOpenAiImageProvider, imageFailureKindOf } from "./openai-image";

const CFG = { provider: "openai" as const, model: "gpt-image-1", apiKey: "sk-test", timeoutMs: 5000 };

function b64Response(extra: object = {}) {
  return {
    created: 1,
    data: [{ b64_json: Buffer.from("fake-bytes").toString("base64") }],
    ...extra,
  };
}

describe("createOpenAiImageProvider", () => {
  test("sends the exact request body", async () => {
    const fetch = createFakeLlmFetch([{ status: 200, json: b64Response() }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    await provider.generate({ label: "image.generate", prompt: "a cat", aspect: "square" });
    const body = fetch.calls[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ model: "gpt-image-1", prompt: "a cat", n: 1, size: "1024x1024", output_format: "png" });
  });

  test.each([
    ["square", "1024x1024"],
    ["landscape", "1536x1024"],
    ["portrait", "1024x1536"],
  ] as const)("maps aspect %s to size %s", async (aspect, size) => {
    const fetch = createFakeLlmFetch([{ status: 200, json: b64Response() }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    await provider.generate({ label: "image.generate", prompt: "x", aspect });
    expect((fetch.calls[0]!.body as { size: string }).size).toBe(size);
  });

  test("an explicit size passes through after a positive-integer check only", async () => {
    const fetch = createFakeLlmFetch([{ status: 200, json: b64Response() }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    await provider.generate({ label: "image.generate", prompt: "x", aspect: "square", size: { width: 777, height: 333 } });
    expect((fetch.calls[0]!.body as { size: string }).size).toBe("777x333");
  });

  test("reads b64_json bytes on success", async () => {
    const fetch = createFakeLlmFetch([{ status: 200, json: b64Response() }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    const r = await provider.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.toString()).toBe("fake-bytes");
      expect(r.mimeType).toBe("image/png");
    }
  });

  test("empty data array is invalid_output", async () => {
    const fetch = createFakeLlmFetch([{ status: 200, json: { created: 1, data: [] } }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    const r = await provider.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_output");
  });

  test("missing b64_json is invalid_output", async () => {
    const fetch = createFakeLlmFetch([{ status: 200, json: { created: 1, data: [{}] } }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    const r = await provider.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_output");
  });

  test("usage is read when present, null when absent, never coerced to zero", async () => {
    const withUsage = createFakeLlmFetch([
      { status: 200, json: b64Response({ usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } }) },
    ]);
    const p1 = createOpenAiImageProvider(CFG, { fetch: withUsage, maxRetries: 0 });
    const r1 = await p1.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r1.usage).toEqual({ inputTokens: 3, outputTokens: 7 });

    const noUsage = createFakeLlmFetch([{ status: 200, json: b64Response() }]);
    const p2 = createOpenAiImageProvider(CFG, { fetch: noUsage, maxRetries: 0 });
    const r2 = await p2.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r2.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  test.each([
    [401, { error: { message: "bad key", type: "invalid_request_error", code: "invalid_api_key" } }, "auth"],
    [429, { error: { message: "quota", type: "insufficient_quota", code: "credit_balance_exhausted" } }, "credit_exhausted"],
    [429, { error: { message: "rate limited", code: "rate_limit_exceeded" } }, "rate_limited"],
    [400, { error: { message: "bad request" } }, "bad_request"],
    [404, { error: { message: "not found" } }, "bad_request"],
    [500, { error: { message: "server error" } }, "unavailable"],
  ] as const)("status %s classifies as %s", async (status, json, kind) => {
    const fetch = createFakeLlmFetch([{ status, json }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    const r = await provider.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe(kind);
    expect(fetch.calls).toHaveLength(1);
  });

  test("maxRetries: 0 makes exactly one HTTP call per attempt, even on a retryable status", async () => {
    const fetch = createFakeLlmFetch([{ status: 500, json: { error: { message: "server error" } } }]);
    const provider = createOpenAiImageProvider(CFG, { fetch, maxRetries: 0 });
    await provider.generate({ label: "image.generate", prompt: "x", aspect: "square" });
    expect(fetch.calls).toHaveLength(1);
  });

  test("markers parameter proves the one-line widening", () => {
    const generate = (status: number, body: object) => OpenAI.APIError.generate(status, body, undefined, new Headers());
    const err = generate(400, { error: { message: "nope", type: "image_policy_violation" } });
    expect(imageFailureKindOf(err, false)).toBe("bad_request");
    expect(
      imageFailureKindOf(err, false, { types: new Set(["image_policy_violation"]), codes: new Set() }),
    ).toBe("refused");
  });
});
