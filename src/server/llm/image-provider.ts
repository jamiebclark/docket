import { parseLlmImageConfig, type LlmImageConfig, type LlmImageProviderName } from "./config";
import type { ImageAspect } from "./image-generation";
import { createOpenAiImageProvider } from "./openai-image";
import type { LlmFailureKind, LlmUsage } from "./types";

/**
 * What the abstract layer hands an adapter and gets back (G5, FR-010). No pixel size, output
 * format, response field name or vendor error code appears in this type or anywhere above it — a
 * second adapter is a new file plus one value in `LLM_IMAGE_PROVIDER` (SC-007).
 */
export interface ImageProviderRequest {
  /** Short, non-secret, for logs and the usage guard (P7). Always "image.generate" today. */
  label: string;
  /** The person's prompt with NO_REAL_PEOPLE already appended. The adapter appends nothing. */
  prompt: string;
  aspect: ImageAspect;
  size?: { width: number; height: number };
  signal?: AbortSignal;
}

type Base = { usage: LlmUsage; latencyMs: number; provider: LlmImageProviderName; model: string };

export type ImageProviderResult =
  | ({ ok: true; bytes: Buffer; mimeType: string } & Base)
  | ({ ok: false; kind: LlmFailureKind } & Base);

export interface ImageProvider {
  readonly name: LlmImageProviderName;
  readonly model: string;
  /** Never throws for provider or network failures; returns ok: false. Throws only on programmer error. */
  generate(request: ImageProviderRequest): Promise<ImageProviderResult>;
}

export class ImageNotConfiguredError extends Error {
  constructor(missingOrMessage: readonly string[] | string) {
    super(
      typeof missingOrMessage === "string"
        ? missingOrMessage
        : `Image generation is not configured. Set: ${missingOrMessage.join(", ")}.`,
    );
    this.name = "ImageNotConfiguredError";
  }
}

let override: ImageProvider | null = null;
let factoryOverride: ((config: LlmImageConfig) => ImageProvider) | null = null;
let cached: { key: string; provider: ImageProvider } | null = null;

function buildProvider(config: LlmImageConfig): ImageProvider {
  if (factoryOverride) return factoryOverride(config);
  return createOpenAiImageProvider(config);
}

/** The active `setImageProviderForTests` override, if any. Resolution checks this before a project's own credential. */
export function currentImageProviderTestOverride(): ImageProvider | null {
  return override;
}

/** Builds a provider from an arbitrary config (e.g. a project's decrypted credential), honouring `setImageProviderFactoryForTests`. */
export function createImageProviderForConfig(config: LlmImageConfig): ImageProvider {
  return buildProvider(config);
}

export function getImageStatus():
  | { configured: true; provider: LlmImageProviderName; model: string }
  | { configured: false; problems: { name: string; reason: string }[] } {
  if (override) return { configured: true, provider: override.name, model: override.model };
  const r = parseLlmImageConfig(process.env);
  return r.ok
    ? { configured: true, provider: r.config.provider, model: r.config.model }
    : { configured: false, problems: r.problems };
}

/** The configured provider; throws `ImageNotConfiguredError` naming only the missing settings. */
export function getImageProvider(): ImageProvider {
  if (override) return override;
  const r = parseLlmImageConfig(process.env);
  if (!r.ok) {
    const names = r.problems.map((p) => p.name);
    throw new ImageNotConfiguredError(
      names.length === 1 && names[0] === "LLM_IMAGE_PROVIDER"
        ? ["LLM_IMAGE_PROVIDER", "LLM_IMAGE_MODEL", "OPENAI_API_KEY"]
        : names,
    );
  }
  const key = JSON.stringify(r.config);
  if (cached?.key === key) return cached.provider;
  const provider = buildProvider(r.config);
  cached = { key, provider };
  return provider;
}

/** Test-only seam: replaces (or with `null` clears) the provider. */
export function setImageProviderForTests(p: ImageProvider | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setImageProviderForTests is only available in tests");
  override = p;
}

/** Test-only seam: build a provider from a config, so a test can stub per key. Consulted only when `setImageProviderForTests`'s override is unset. */
export function setImageProviderFactoryForTests(fn: ((config: LlmImageConfig) => ImageProvider) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setImageProviderFactoryForTests is only available in tests");
  factoryOverride = fn;
  cached = null;
}
