import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { performance } from "node:perf_hooks";
import type { LlmConfig } from "./config";
import { logLlmCall } from "./log";
import { llmFailureMessage } from "./messages";
import type { LlmFailureKind, LlmImage, LlmProvider, LlmRequest, LlmResult, LlmUsage } from "./types";

/** An Anthropic image `source`: the https URL, or base64 bytes. A non-https URL is a programmer error. */
export function anthropicImageSource(image: LlmImage) {
  if (image.kind === "bytes") {
    return { type: "base64" as const, media_type: image.mediaType, data: image.data.toString("base64") };
  }
  if (!image.url.startsWith("https://")) throw new Error("LLM image URLs must be https");
  return { type: "url" as const, url: image.url };
}

function kindOfError(error: unknown, timedOut: boolean): LlmFailureKind {
  if (timedOut || error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIUserAbortError) {
    return "timeout";
  }
  if (error instanceof Anthropic.RateLimitError) return "rate_limited";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth";
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.UnprocessableEntityError ||
    error instanceof Anthropic.NotFoundError
  ) {
    return "bad_request";
  }
  return "unavailable"; // InternalServerError, APIConnectionError, anything else
}

export function createAnthropicProvider(
  cfg: LlmConfig,
  opts: { fetch?: typeof fetch; maxRetries?: number } = {},
): LlmProvider {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    timeout: cfg.timeoutMs,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    name: "anthropic",
    model: cfg.model,
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const content = [
        ...request.images.map((image) => ({ type: "image" as const, source: anthropicImageSource(image) })),
        { type: "text" as const, text: request.user },
      ];
      const timeoutMs = Math.min(request.timeoutMs ?? cfg.timeoutMs, cfg.timeoutMs);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const format = zodOutputFormat(request.schema as never);

      const done = (
        started: number,
        usage: LlmUsage,
        rest:
          | { ok: true; value: T; rawText: string }
          | { ok: false; kind: LlmFailureKind; rawText: string | null },
      ): LlmResult<T> => {
        const latencyMs = performance.now() - started;
        logLlmCall({
          provider: "anthropic",
          model: cfg.model,
          label: request.label,
          latencyMs,
          outcome: rest.ok ? "ok" : rest.kind,
          usage,
        });
        const base = { usage, latencyMs, provider: "anthropic" as const, model: cfg.model };
        return rest.ok ? { ...rest, ...base } : { ...rest, message: llmFailureMessage(rest.kind), ...base };
      };

      const started = performance.now();
      let response;
      try {
        response = await client.messages.create(
          {
            model: cfg.model,
            system: request.system,
            max_tokens: cfg.maxOutputTokens,
            messages: [{ role: "user", content }],
            output_config: { format },
          },
          { signal },
        );
      } catch (error) {
        return done(started, { inputTokens: null, outputTokens: null }, {
          ok: false,
          kind: kindOfError(error, timeout.aborted),
          rawText: null,
        });
      }

      const usage: LlmUsage = {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
      const text = (response.content ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (response.stop_reason === "refusal") return done(started, usage, { ok: false, kind: "refused", rawText: null });
      if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
        return done(started, usage, { ok: false, kind: "incomplete", rawText: text || null });
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return done(started, usage, { ok: false, kind: "invalid_output", rawText: text });
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) return done(started, usage, { ok: false, kind: "invalid_output", rawText: text });
      return done(started, usage, { ok: true, value: parsed.data, rawText: text });
    },
  };
}
