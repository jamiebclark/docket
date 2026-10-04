import { llmFailureMessage } from "@/server/llm/messages";
import type { LlmFailureKind, LlmImage, LlmProvider, LlmProviderName, LlmRequest, LlmResult } from "@/server/llm/types";

/** `delayMs` makes the step take that long; it fails as `timeout` if `timeoutMs` elapses first, or `aborted`-style `timeout` if `signal` fires. */
export type FakeStep = (
  | { ok: unknown } // value returned as-is (rawText = JSON.stringify), still passed through schema.safeParse
  | { raw: string } // raw text, parsed like a real provider
  | { fail: LlmFailureKind }
) & { delayMs?: number };

export interface FakeRequest {
  label: string;
  system: string;
  user: string;
  images: LlmImage[];
  schemaName: string;
  timeoutMs: number | undefined;
}

export type FakeLlm = LlmProvider & { requests: FakeRequest[]; remaining(): number };

/** Resolves "done" after `ms`, or "timeout" / "aborted" if the deadline or signal comes first. */
function wait(ms: number, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<"done" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("aborted");
    const finish = (r: "done" | "timeout" | "aborted") => {
      clearTimeout(t1);
      if (t2) clearTimeout(t2);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish("aborted");
    const t1 = setTimeout(() => finish("done"), ms);
    const t2 = timeoutMs !== undefined && timeoutMs < ms ? setTimeout(() => finish("timeout"), timeoutMs) : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
        timeoutMs: request.timeoutMs,
      });
      const step = queue.shift();
      if (!step) throw new Error(`Fake LLM ran out of scripted steps (request ${requests.length}, ${request.label})`);
      if (step.delayMs && step.delayMs > 0) {
        const outcome = await wait(step.delayMs, request.timeoutMs, request.signal);
        if (outcome !== "done") {
          return { ok: false, kind: "timeout", message: llmFailureMessage("timeout"), rawText: null, ...base };
        }
      }
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
