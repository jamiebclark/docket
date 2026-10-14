import type { EnvIssue } from "../env";
import type { LlmProviderName } from "./types";

export interface LlmConfig {
  provider: LlmProviderName;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type LlmImageProviderName = "openai";

/** No `maxOutputTokens` (FR-007) — a text-only cap that must not travel to an image provider. */
export interface LlmImageConfig {
  provider: LlmImageProviderName;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

type Source = Record<string, string | undefined>;

export interface LlmLimits {
  timeoutMs: number;
  maxOutputTokens: number;
}

const KEY_NAME: Record<LlmProviderName, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

function intIn(
  source: Source,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: EnvIssue[],
): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) {
    problems.push({ name, reason: `must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return n;
}

function limitsFrom(source: Source, problems: EnvIssue[]): LlmLimits {
  const timeoutSeconds = intIn(source, "LLM_TIMEOUT_SECONDS", 10, 600, 90, problems);
  const maxOutputTokens = intIn(source, "LLM_MAX_OUTPUT_TOKENS", 256, 32_000, 4000, problems);
  return { timeoutMs: timeoutSeconds * 1000, maxOutputTokens };
}

/** The install-wide call limits, independent of whether a provider is configured (L8, FR-004). */
export function parseLlmLimits(source: Source): LlmLimits {
  return limitsFrom(source, []);
}

/** Problems carry variable names and reasons only, never values. */
export function parseLlmConfig(
  source: Source,
): { ok: true; config: LlmConfig } | { ok: false; problems: EnvIssue[] } {
  const rawProvider = source.LLM_PROVIDER?.trim();
  if (!rawProvider) {
    return { ok: false, problems: [{ name: "LLM_PROVIDER", reason: "not set; generation is disabled" }] };
  }
  if (rawProvider !== "openai" && rawProvider !== "anthropic") {
    return { ok: false, problems: [{ name: "LLM_PROVIDER", reason: "must be openai or anthropic" }] };
  }
  const provider: LlmProviderName = rawProvider;
  const problems: EnvIssue[] = [];

  const model = source.LLM_MODEL?.trim() ?? "";
  if (!model) problems.push({ name: "LLM_MODEL", reason: `required when LLM_PROVIDER=${provider}` });
  else if (model.length > 200 || /\s/.test(model)) {
    problems.push({ name: "LLM_MODEL", reason: "must be 1 to 200 characters with no spaces" });
  }

  const keyName = KEY_NAME[provider];
  const apiKey = source[keyName]?.trim() ?? "";
  if (!apiKey) problems.push({ name: keyName, reason: `required when LLM_PROVIDER=${provider}` });

  const limits = limitsFrom(source, problems);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { provider, model, apiKey, ...limits } };
}

/** Problems carry variable names and reasons only, never values. */
export function parseLlmImageConfig(
  source: Source,
): { ok: true; config: LlmImageConfig } | { ok: false; problems: EnvIssue[] } {
  const rawProvider = source.LLM_IMAGE_PROVIDER?.trim();
  if (!rawProvider) {
    return {
      ok: false,
      problems: [{ name: "LLM_IMAGE_PROVIDER", reason: "not set; image generation is disabled" }],
    };
  }
  if (rawProvider !== "openai") {
    return { ok: false, problems: [{ name: "LLM_IMAGE_PROVIDER", reason: "must be openai" }] };
  }
  const provider: LlmImageProviderName = rawProvider;
  const problems: EnvIssue[] = [];

  const model = source.LLM_IMAGE_MODEL?.trim() ?? "";
  if (!model) problems.push({ name: "LLM_IMAGE_MODEL", reason: `required when LLM_IMAGE_PROVIDER=${provider}` });
  else if (model.length > 200 || /\s/.test(model)) {
    problems.push({ name: "LLM_IMAGE_MODEL", reason: "must be 1 to 200 characters with no spaces" });
  }

  const keyName = KEY_NAME[provider];
  const apiKey = source[keyName]?.trim() ?? "";
  if (!apiKey) problems.push({ name: keyName, reason: `required when LLM_IMAGE_PROVIDER=${provider}` });

  const { timeoutMs } = limitsFrom(source, problems);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { provider, model, apiKey, timeoutMs } };
}

/** Deliberately outside `LLM_VARIABLES` (P1): `llmEnvIssues` must not demand `LLM_PROVIDER` for these. */
export const LLM_IMAGE_VARIABLES: readonly string[] = ["LLM_IMAGE_PROVIDER", "LLM_IMAGE_MODEL"];

/** The image group's strict startup wrapper. Same shape and same rule as `llmEnvIssues`. */
export function llmImageEnvIssues(source: Source): EnvIssue[] {
  const anySet = LLM_IMAGE_VARIABLES.some((n) => Boolean(source[n]?.trim()));
  if (!anySet) return [];
  if (!source.LLM_IMAGE_PROVIDER?.trim()) {
    return [{ name: "LLM_IMAGE_PROVIDER", reason: "required when any LLM_IMAGE_* variable is set" }];
  }
  const r = parseLlmImageConfig(source);
  return r.ok ? [] : r.problems;
}

export const LLM_VARIABLES: readonly string[] = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "LLM_TIMEOUT_SECONDS",
  "LLM_MAX_OUTPUT_TOKENS",
];

/**
 * Deliberately separate from `LLM_VARIABLES` (P9): an install may have no provider configured at
 * all while its projects generate on their own keys, and that install is exactly the one most
 * interested in rates — `llmEnvIssues` must not make these require `LLM_PROVIDER`.
 */
export const LLM_RATE_VARIABLES: readonly string[] = ["LLM_RATES", "LLM_RATE_CURRENCY"];

/**
 * Strict wrapper for startup (research D25). A wholly absent group is not an issue (generation is
 * disabled); setting any variable of the group without `LLM_PROVIDER`, or a malformed or
 * incomplete provider setup, is. Names and reasons only, never values.
 */
export function llmEnvIssues(source: Source): EnvIssue[] {
  const anySet = LLM_VARIABLES.some((n) => Boolean(source[n]?.trim()));
  if (!anySet) return [];
  if (!source.LLM_PROVIDER?.trim()) {
    return [{ name: "LLM_PROVIDER", reason: "required when any LLM_* or *_API_KEY variable is set" }];
  }
  const r = parseLlmConfig(source);
  return r.ok ? [] : r.problems;
}
