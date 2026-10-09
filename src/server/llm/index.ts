import { parseLlmConfig, type LlmConfig } from "./config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { EnvIssue } from "../env";
import type { LlmProvider, LlmProviderName } from "./types";

export { createAnthropicProvider, createOpenAiProvider };
export type { LlmConfig };

export class LlmNotConfiguredError extends Error {
  constructor(missing: readonly string[]) {
    super(`Generation is not configured. Set: ${missing.join(", ")}.`);
    this.name = "LlmNotConfiguredError";
  }
}

let override: LlmProvider | null = null;
let cached: { key: string; provider: LlmProvider } | null = null;

export function getLlmStatus():
  | { configured: true; provider: LlmProviderName; model: string }
  | { configured: false; problems: EnvIssue[] } {
  if (override) return { configured: true, provider: override.name, model: override.model };
  const r = parseLlmConfig(process.env);
  return r.ok
    ? { configured: true, provider: r.config.provider, model: r.config.model }
    : { configured: false, problems: r.problems };
}

/** Every setting the owner must set, all at once: a lone LLM_PROVIDER problem expands to provider, model and key. */
export function missingLlmSettings(problems: readonly { name: string }[]): string[] {
  const names = problems.map((p) => p.name);
  return names.length === 1 && names[0] === "LLM_PROVIDER" ? ["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY"] : names;
}

/** The configured provider; throws `LlmNotConfiguredError` naming only the missing settings. */
export function getLlm(): LlmProvider {
  if (override) return override;
  const r = parseLlmConfig(process.env);
  if (!r.ok) {
    throw new LlmNotConfiguredError(missingLlmSettings(r.problems));
  }
  const key = JSON.stringify(r.config);
  if (cached?.key === key) return cached.provider;
  const provider = r.config.provider === "openai" ? createOpenAiProvider(r.config) : createAnthropicProvider(r.config);
  cached = { key, provider };
  return provider;
}

/** Test-only seam: replaces (or with `null` clears) the provider. */
export function setLlmForTests(llm: LlmProvider | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setLlmForTests is only available in tests");
  override = llm;
}
