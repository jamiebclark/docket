import type { EnvIssue } from "../env";
import type { LlmProviderName } from "./types";

export interface LlmConfig {
  provider: LlmProviderName;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

type Source = Record<string, string | undefined>;

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

  const timeoutSeconds = intIn(source, "LLM_TIMEOUT_SECONDS", 10, 600, 90, problems);
  const maxOutputTokens = intIn(source, "LLM_MAX_OUTPUT_TOKENS", 256, 32_000, 4000, problems);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { provider, model, apiKey, timeoutMs: timeoutSeconds * 1000, maxOutputTokens } };
}
