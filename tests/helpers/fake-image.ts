import type { LlmImageProviderName } from "../../src/server/llm/config";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "../../src/server/llm/image-provider";
import type { LlmFailureKind } from "../../src/server/llm/types";

export type FakeImageStep = { bytes: Buffer; mimeType?: string } | { fail: LlmFailureKind };

export type FakeImageProvider = ImageProvider & { requests: ImageProviderRequest[] };

/** A scripted `ImageProvider`, mirroring `createFakeLlm` for the image contract. */
export function createFakeImageProvider(
  steps: FakeImageStep[],
  opts: { provider?: LlmImageProviderName; model?: string; latencyMs?: number } = {},
): FakeImageProvider {
  const queue = [...steps];
  const requests: ImageProviderRequest[] = [];
  const provider = opts.provider ?? "openai";
  const model = opts.model ?? "fake-image-model";
  const latencyMs = opts.latencyMs ?? 5;
  const base = { usage: { inputTokens: null, outputTokens: null }, latencyMs, provider, model };

  return {
    name: provider,
    model,
    requests,
    async generate(request: ImageProviderRequest): Promise<ImageProviderResult> {
      requests.push(request);
      const step = queue.shift();
      if (!step) throw new Error(`Fake image provider ran out of scripted steps (request ${requests.length}, ${request.label})`);
      if ("fail" in step) return { ok: false, kind: step.fail, ...base };
      return { ok: true, bytes: step.bytes, mimeType: step.mimeType ?? "image/png", ...base };
    },
  };
}
