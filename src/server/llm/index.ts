import { parseLlmConfig, type LlmConfig } from "./config";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiProvider } from "./openai";
import type { EnvIssue } from "../env";
import type { LlmProvider, LlmProviderName } from "./types";

export { createAnthropicProvider, createOpenAiProvider };
export type { LlmConfig };

export class LlmNotConfiguredError extends Error {
  constructor(missingOrMessage: readonly string[] | string) {
    super(
      typeof missingOrMessage === "string"
        ? missingOrMessage
        : `Generation is not configured. Set: ${missingOrMessage.join(", ")}.`,
    );
    this.name = "LlmNotConfiguredError";
  }
}

let override: LlmProvider | null = null;
let factoryOverride: ((config: LlmConfig) => LlmProvider) | null = null;
let cached: { key: string; provider: LlmProvider } | null = null;

function buildProvider(config: LlmConfig): LlmProvider {
  if (factoryOverride) return factoryOverride(config);
  return config.provider === "openai" ? createOpenAiProvider(config) : createAnthropicProvider(config);
}

/** The active `setLlmForTests` override, if any (L13). Resolution checks this before a project's own credential. */
export function currentLlmTestOverride(): LlmProvider | null {
  return override;
}

/** Builds a provider from an arbitrary config (e.g. a project's decrypted credential), honouring `setLlmFactoryForTests`. */
export function createLlmProviderForConfig(config: LlmConfig): LlmProvider {
  return buildProvider(config);
}

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
  const provider = buildProvider(r.config);
  cached = { key, provider };
  return provider;
}

/** Test-only seam: replaces (or with `null` clears) the provider. */
export function setLlmForTests(llm: LlmProvider | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setLlmForTests is only available in tests");
  override = llm;
}

/** Test-only seam: build a provider from a config, so a test can stub per key (L13). Consulted only when `setLlmForTests`'s override is unset. */
export function setLlmFactoryForTests(fn: ((config: LlmConfig) => LlmProvider) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setLlmFactoryForTests is only available in tests");
  factoryOverride = fn;
  cached = null;
}
