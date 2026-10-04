import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { performance } from "node:perf_hooks";
import type { LlmConfig } from "./config";
import { logLlmCall } from "./log";
import { llmFailureMessage } from "./messages";
import type { LlmFailureKind, LlmImage, LlmProvider, LlmRequest, LlmResult, LlmUsage } from "./types";

/** `image_url` for the Responses API: the https URL, or a data URL for bytes. A non-https URL is a programmer error. */
export function openAiImageUrl(image: LlmImage): string {
  if (image.kind === "bytes") return `data:${image.mediaType};base64,${image.data.toString("base64")}`;
  if (!image.url.startsWith("https://")) throw new Error("LLM image URLs must be https");
  return image.url;
}

function kindOfError(error: unknown, timedOut: boolean): LlmFailureKind {
  if (timedOut || error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError) {
    return "timeout";
  }
  if (error instanceof OpenAI.RateLimitError) return "rate_limited";
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) return "auth";
  if (
    error instanceof OpenAI.BadRequestError ||
    error instanceof OpenAI.UnprocessableEntityError ||
    error instanceof OpenAI.NotFoundError
  ) {
    return "bad_request";
  }
  return "unavailable"; // InternalServerError, APIConnectionError, anything else
}

interface OutputItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

function readOutput(response: { output?: unknown; output_text?: string }): { text: string; refused: boolean } {
  const items = (Array.isArray(response.output) ? response.output : []) as OutputItem[];
  let refused = false;
  let text = "";
  for (const item of items) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal") refused = true;
      else if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return { text: text || response.output_text || "", refused };
}

export function createOpenAiProvider(
  cfg: LlmConfig,
  opts: { fetch?: typeof fetch; maxRetries?: number } = {},
): LlmProvider {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    timeout: cfg.timeoutMs,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    name: "openai",
    model: cfg.model,
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const content = [
        ...request.images.map((image) => ({
          type: "input_image" as const,
          image_url: openAiImageUrl(image),
          detail: "auto" as const,
        })),
        { type: "input_text" as const, text: request.user },
      ];
      const timeoutMs = Math.min(request.timeoutMs ?? cfg.timeoutMs, cfg.timeoutMs);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const format = zodTextFormat(request.schema as never, request.schemaName);

      const done = (
        started: number,
        usage: LlmUsage,
        rest:
          | { ok: true; value: T; rawText: string }
          | { ok: false; kind: LlmFailureKind; rawText: string | null },
      ): LlmResult<T> => {
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
        return rest.ok
          ? { ...rest, ...base }
          : { ...rest, message: llmFailureMessage(rest.kind), ...base };
      };

      const started = performance.now();
      let response;
      try {
        response = await client.responses.create(
          {
            model: cfg.model,
            instructions: request.system,
            input: [{ role: "user", content }],
            text: { format },
            max_output_tokens: cfg.maxOutputTokens,
            store: false,
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
      const { text, refused } = readOutput(response);
      if (refused) return done(started, usage, { ok: false, kind: "refused", rawText: null });
      if (response.status === "incomplete") {
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
