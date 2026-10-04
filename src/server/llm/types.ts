import type { z } from "zod";

export type LlmProviderName = "openai" | "anthropic";

export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type LlmImage =
  | { kind: "url"; url: string; mediaType: LlmImageMediaType }
  | { kind: "bytes"; data: Buffer; mediaType: LlmImageMediaType };

export interface LlmRequest<T> {
  /** Short, non-secret, for logs: "generate.single", "generate.series_plan" … */
  label: string;
  system: string;
  user: string;
  /** Sent before the user text. */
  images: readonly LlmImage[];
  /** Name sent as the format name, `[a-z0-9_]{1,64}`. */
  schemaName: string;
  /** Wire schema: required properties only, no unions, no length/count constraints. */
  schema: z.ZodType<T>;
  /** Overrides LLM_TIMEOUT_SECONDS for this call; never longer. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type LlmFailureKind =
  | "invalid_output"
  | "refused"
  | "incomplete"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "auth"
  | "bad_request";

export const LLM_FAILURE_KINDS: readonly LlmFailureKind[] = [
  "invalid_output",
  "refused",
  "incomplete",
  "timeout",
  "rate_limited",
  "unavailable",
  "auth",
  "bad_request",
];

export type LlmResult<T> =
  | {
      ok: true;
      value: T;
      rawText: string;
      usage: LlmUsage;
      latencyMs: number;
      provider: LlmProviderName;
      model: string;
    }
  | {
      ok: false;
      kind: LlmFailureKind;
      message: string;
      rawText: string | null;
      usage: LlmUsage;
      latencyMs: number;
      provider: LlmProviderName;
      model: string;
    };

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  /** Never throws for provider or network failures; returns `ok: false`. Throws only on programmer error. */
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
