import OpenAI from "openai";
import { performance } from "node:perf_hooks";
import type { LlmImageConfig } from "./config";
import type { ImageAspect } from "./image-generation";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "./image-provider";
import { logLlmCall } from "./log";
import { kindOfError } from "./openai";
import type { LlmFailureKind, LlmUsage } from "./types";

/** The three sizes the installed SDK documents for the GPT image models (research § 2). */
const ASPECT_SIZE: Record<ImageAspect, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

/** Named, extensible, and empty today: the installed SDK names no refusal marker for this endpoint. */
export const OPENAI_IMAGE_REFUSAL_TYPES: ReadonlySet<string> = new Set([]);
export const OPENAI_IMAGE_REFUSAL_CODES: ReadonlySet<string> = new Set([]);

export function imageFailureKindOf(
  error: unknown,
  timedOut: boolean,
  markers: { types: ReadonlySet<string>; codes: ReadonlySet<string> } = {
    types: OPENAI_IMAGE_REFUSAL_TYPES,
    codes: OPENAI_IMAGE_REFUSAL_CODES,
  },
): LlmFailureKind {
  if (timedOut || error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError) {
    return "timeout";
  }
  if (error instanceof OpenAI.APIError) {
    if (typeof error.type === "string" && markers.types.has(error.type)) return "refused";
    if (typeof error.code === "string" && markers.codes.has(error.code)) return "refused";
  }
  return kindOfError(error, timedOut);
}

function sizeOf(aspect: ImageAspect, size?: { width: number; height: number }): string {
  if (size && Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0) {
    return `${size.width}x${size.height}`;
  }
  return ASPECT_SIZE[aspect];
}

export function createOpenAiImageProvider(
  cfg: LlmImageConfig,
  opts: { fetch?: typeof fetch; maxRetries?: number } = {},
): ImageProvider {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    timeout: cfg.timeoutMs,
    maxRetries: opts.maxRetries ?? 0,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    name: "openai",
    model: cfg.model,
    async generate(request: ImageProviderRequest): Promise<ImageProviderResult> {
      const timeout = AbortSignal.timeout(cfg.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const size = sizeOf(request.aspect, request.size);

      const done = (
        started: number,
        usage: LlmUsage,
        rest:
          | { ok: true; bytes: Buffer; mimeType: string }
          | { ok: false; kind: LlmFailureKind },
      ): ImageProviderResult => {
        const latencyMs = performance.now() - started;
        logLlmCall({
          provider: "openai",
          model: cfg.model,
          label: request.label,
          latencyMs,
          outcome: rest.ok ? "ok" : rest.kind,
          usage,
        });
        const base = { usage, latencyMs, provider: "openai" as const, model: cfg.model };
        return { ...rest, ...base };
      };

      const started = performance.now();
      let response;
      try {
        response = await client.images.generate(
          { model: cfg.model, prompt: request.prompt, n: 1, size: size as never, output_format: "png" },
          { signal },
        );
      } catch (error) {
        return done(started, { inputTokens: null, outputTokens: null }, {
          ok: false,
          kind: imageFailureKindOf(error, timeout.aborted),
        });
      }

      const usage: LlmUsage = {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) return done(started, usage, { ok: false, kind: "invalid_output" });
      return done(started, usage, { ok: true, bytes: Buffer.from(b64, "base64"), mimeType: "image/png" });
    },
  };
}
