import { expect } from "vitest";
import { runLlmScenarios } from "../../../tests/helpers/llm-scenarios";
import { createOpenAiProvider } from "./openai";

const message = (text: string, extra: object = {}) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "test-model",
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  ...extra,
});

runLlmScenarios({
  name: "openai",
  create: (cfg, fetch) => createOpenAiProvider({ ...cfg, provider: "openai" }, { fetch, maxRetries: 0 }),
  ok: (text, usage) => ({
    status: 200,
    json: message(text, { usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output } }),
  }),
  refusal: () => ({
    status: 200,
    json: {
      ...message(""),
      output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }],
    },
  }),
  incomplete: () => ({
    status: 200,
    json: { ...message('{"text":"cut'), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
  }),
  expectBody(body, e) {
    const b = body as {
      instructions: string;
      max_output_tokens: number;
      text: { format: { type: string; name: string; strict: boolean; schema: { required?: string[] } } };
      input: { role: string; content: { type: string; text?: string; image_url?: string; detail?: string }[] }[];
    };
    expect(b.instructions).toBe(e.system);
    expect(b.max_output_tokens).toBe(1000);
    expect(b.text.format).toMatchObject({ type: "json_schema", name: e.schemaName, strict: true });
    expect(b.text.format.schema.required).toEqual(["text"]);
    expect(b.input).toHaveLength(1);
    expect(b.input[0]!.role).toBe("user");
    expect(b.input[0]!.content).toEqual([
      { type: "input_image", image_url: e.imageUrl, detail: "auto" },
      { type: "input_text", text: e.user },
    ]);
  },
});
