import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { runLlmScenarios } from "../../../tests/helpers/llm-scenarios";
import { createOpenAiProvider, isCreditRefusal } from "./openai";

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
  // The live shape (verified 2026-10-12): the quota marker is `type`; `code` is the more specific reason.
  creditRefusal: (keyEcho) => ({
    status: 429,
    json: {
      error: {
        message: `You have no credits remaining. Add credits to continue using the API.${keyEcho ? ` (${keyEcho})` : ""}`,
        type: "insufficient_quota",
        code: "credit_balance_exhausted",
        param: null,
      },
    },
  }),
  nonBillingAtSameStatus: () => ({
    status: 429,
    json: { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } },
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

describe("openai isCreditRefusal", () => {
  const generate = (status: number, body: object | undefined) =>
    OpenAI.APIError.generate(status, body, undefined, new Headers());

  // The shape a live 429 actually has (verified 2026-10-12). The quota marker is the `type`; the `code` is
  // more specific. An earlier fixture set both to "insufficient_quota", which no real response does, so it
  // confirmed the assumption the code was written from instead of checking it.
  test("true for the real shape: type insufficient_quota, code credit_balance_exhausted", () => {
    const err = generate(429, {
      error: {
        message: "You have no credits remaining. Add credits to continue using the API at https://example.test/billing.",
        type: "insufficient_quota",
        code: "credit_balance_exhausted",
        param: null,
      },
    });
    expect(isCreditRefusal(err)).toBe(true);
  });

  test("true for type === insufficient_quota with no code at all", () => {
    const err = generate(429, { error: { message: "quota", type: "insufficient_quota" } });
    expect(isCreditRefusal(err)).toBe(true);
  });

  test("true for code === insufficient_quota (kept: either field is accepted)", () => {
    const err = generate(429, { error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } });
    expect(isCreditRefusal(err)).toBe(true);
  });

  test("false for a 429 with no code", () => {
    const err = generate(429, { error: { message: "rate limited" } });
    expect(isCreditRefusal(err)).toBe(false);
  });

  test("false for a 429 with code rate_limit_exceeded", () => {
    const err = generate(429, { error: { message: "rate limited", code: "rate_limit_exceeded" } });
    expect(isCreditRefusal(err)).toBe(false);
  });

  test("false for a malformed body", () => {
    expect(isCreditRefusal(generate(429, {}))).toBe(false);
  });

  test("false for a non-APIError", () => {
    expect(isCreditRefusal(new Error("boom"))).toBe(false);
  });
});
