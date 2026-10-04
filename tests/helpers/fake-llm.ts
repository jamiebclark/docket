import { llmFailureMessage } from "@/server/llm/messages";
import type { LlmFailureKind, LlmImage, LlmProvider, LlmProviderName, LlmRequest, LlmResult } from "@/server/llm/types";

export type FakeStep =
  | { ok: unknown } // value returned as-is (rawText = JSON.stringify), still passed through schema.safeParse
  | { raw: string } // raw text, parsed like a real provider
  | { fail: LlmFailureKind };

export interface FakeRequest {
  label: string;
  system: string;
  user: string;
  images: LlmImage[];
  schemaName: string;
}

export type FakeLlm = LlmProvider & { requests: FakeRequest[]; remaining(): number };

export function createFakeLlm(
  steps: FakeStep[],
  opts: { provider?: LlmProviderName; model?: string; latencyMs?: number } = {},
): FakeLlm {
  const queue = [...steps];
  const requests: FakeRequest[] = [];
  const provider = opts.provider ?? "openai";
  const model = opts.model ?? "fake-model";
  const latencyMs = opts.latencyMs ?? 5;
  const usage = { inputTokens: 100, outputTokens: 50 };
  const base = { usage, latencyMs, provider, model };

  return {
    name: provider,
    model,
    requests,
    remaining: () => queue.length,
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push({
        label: request.label,
        system: request.system,
        user: request.user,
        images: [...request.images],
        schemaName: request.schemaName,
      });
      const step = queue.shift();
      if (!step) throw new Error(`Fake LLM ran out of scripted steps (request ${requests.length}, ${request.label})`);
      if ("fail" in step) {
        return { ok: false, kind: step.fail, message: llmFailureMessage(step.fail), rawText: null, ...base };
      }
      const rawText = "raw" in step ? step.raw : JSON.stringify(step.ok);
      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        return { ok: false, kind: "invalid_output", message: llmFailureMessage("invalid_output"), rawText, ...base };
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, kind: "invalid_output", message: llmFailureMessage("invalid_output"), rawText, ...base };
      }
      return { ok: true, value: parsed.data, rawText, ...base };
    },
  };
}
