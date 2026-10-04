import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLlmFetch } from "../../../tests/helpers/fake-llm-http";
import { runLlmScenarios } from "../../../tests/helpers/llm-scenarios";
import { createAnthropicProvider } from "./anthropic";

const message = (text: string, extra: object = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...extra,
});

runLlmScenarios({
  name: "anthropic",
  create: (cfg, fetch) => createAnthropicProvider({ ...cfg, provider: "anthropic" }, { fetch, maxRetries: 0 }),
  ok: (text, usage) => ({
    status: 200,
    json: message(text, { usage: { input_tokens: usage.input, output_tokens: usage.output } }),
  }),
  refusal: () => ({ status: 200, json: message("", { content: [], stop_reason: "refusal" }) }),
  incomplete: () => ({ status: 200, json: message('{"text":"cut', { stop_reason: "max_tokens" }) }),
  expectBody(body, e) {
    const b = body as {
      system: string;
      max_tokens: number;
      output_config: { format: { type: string; schema: { required?: string[] } } };
      messages: { role: string; content: { type: string; text?: string; source?: unknown }[] }[];
    };
    expect(b.system).toBe(e.system);
    expect(b.max_tokens).toBe(1000);
    expect(b.output_config.format).toMatchObject({ type: "json_schema" });
    expect(b.output_config.format.schema.required).toEqual(["text"]);
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.role).toBe("user");
    expect(b.messages[0]!.content).toEqual([
      { type: "image", source: { type: "url", url: e.imageUrl } },
      { type: "text", text: e.user },
    ]);
  },
});

describe("anthropic stop reasons", () => {
  test("model_context_window_exceeded → incomplete", async () => {
    const fetch = createFakeLlmFetch([
      { status: 200, json: message('{"text":"cut', { stop_reason: "model_context_window_exceeded" }) },
    ]);
    const llm = createAnthropicProvider(
      { provider: "anthropic", model: "m", apiKey: "k", timeoutMs: 10_000, maxOutputTokens: 1000 },
      { fetch, maxRetries: 0 },
    );
    const r = await llm.generate({
      label: "t",
      system: "s",
      user: "u",
      images: [],
      schemaName: "post_output",
      schema: z.object({ text: z.string() }),
    });
    expect(r).toMatchObject({ ok: false, kind: "incomplete" });
  });
});
