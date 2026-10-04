# Contract: LLM layer (`src/server/llm/`)

Server-only. Nothing under `src/server/llm/` is imported by client components. Facts about the SDKs are from `docs/research/llm-and-storage.md` §1–2 and the installed type definitions (research R2, R3).

## Types (`src/server/llm/types.ts`)

```ts
import type { z } from "zod";

export type LlmProviderName = "openai" | "anthropic";

export type LlmImage =
  | { kind: "url"; url: string; mediaType: LlmImageMediaType }           // https only
  | { kind: "bytes"; data: Buffer; mediaType: LlmImageMediaType };       // raw bytes; implementation base64-encodes
export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface LlmRequest<T> {
  /** Short, non-secret, for logs: "generate.single", "generate.series_plan", "voice.try_it" … */
  label: string;
  system: string;
  user: string;
  /** Sent before the user text (Anthropic recommendation, research §2). */
  images: readonly LlmImage[];
  /** Name sent as the format name (OpenAI `zodTextFormat(schema, name)`), `[a-z0-9_]{1,64}`. */
  schemaName: string;
  /** Wire schema: required properties only, no unions, no length/count constraints (research R4). */
  schema: z.ZodType<T>;
  /** Overrides LLM_TIMEOUT_SECONDS for this call; never longer. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage { inputTokens: number | null; outputTokens: number | null }

export type LlmFailureKind =
  | "invalid_output" | "refused" | "incomplete" | "timeout"
  | "rate_limited" | "unavailable" | "auth" | "bad_request";

export type LlmResult<T> =
  | { ok: true; value: T; rawText: string; usage: LlmUsage; latencyMs: number; provider: LlmProviderName; model: string }
  | { ok: false; kind: LlmFailureKind; message: string; rawText: string | null; usage: LlmUsage; latencyMs: number; provider: LlmProviderName; model: string };

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  /** Never throws for provider or network failures; returns `ok: false`. Throws only on programmer error (e.g. a non-https URL image). */
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
```

### Rules every implementation follows

1. Build the wire format with the SDK's Zod helper:
   - OpenAI: `zodTextFormat(schema, schemaName)` as `text.format` on `client.responses.create`;
   - Anthropic: `zodOutputFormat(schema)` as `output_config.format` on `client.messages.create`.

   Do **not** use `.parse()`: we need the raw text (research R3).
2. Read the raw text:
   - OpenAI: `response.output_text`;
   - Anthropic: the concatenated `text` blocks.

   Then run `JSON.parse` and `schema.safeParse`. Any failure is `invalid_output`, and `rawText` is kept.
3. Detect refusal and truncation before parsing (research D3):
   - OpenAI: an output content item with `type: "refusal"` → `refused`; `status === "incomplete"` → `incomplete`;
   - Anthropic: `stop_reason === "refusal"` → `refused`; `"max_tokens"` or `"model_context_window_exceeded"` → `incomplete`.
4. Map SDK error classes to kinds as in research D3. The `message` is the fixed sentence for the kind (below), never the SDK message.
5. Measure `latencyMs` with `performance.now()` around the whole SDK call, including the SDK's own retries.
6. Usage:
   - OpenAI: `usage.input_tokens` and `usage.output_tokens`;
   - Anthropic: `usage.input_tokens` and `usage.output_tokens`;
   - `null` when absent.
7. Client options: `{ apiKey, timeout: timeoutMs, maxRetries: 2, fetch? }`. Per call, pass `signal` (merged with `AbortSignal.timeout(timeoutMs)`) and the output cap: OpenAI `max_output_tokens`, Anthropic `max_tokens` = `LLM_MAX_OUTPUT_TOKENS`.
8. Image parts:
   - OpenAI: `{ type: "input_image", image_url: url | "data:<mime>;base64,<b64>", detail: "auto" }`, then `{ type: "input_text", text: user }`, in one `user` message. `system` goes in `instructions`.
   - Anthropic: `{ type: "image", source: { type: "url", url } | { type: "base64", media_type, data } }`, then `{ type: "text", text: user }`. `system` goes in `system`.
9. Log one line through `logLlmCall()` (research D6). Never log `system`, `user`, images, `rawText` or SDK error text.

### Fixed failure messages (`src/server/llm/messages.ts`)

| kind | message |
|---|---|
| `invalid_output` | "The model's answer could not be read." |
| `refused` | "The model declined to write this post." |
| `incomplete` | "The model's answer was cut off." |
| `timeout` | "The model took too long to answer." |
| `rate_limited` | "The model provider is rate limiting requests. Try again in a minute." |
| `unavailable` | "The model provider is unavailable. Try again shortly." |
| `auth` | "The model provider refused Docket's API key. Check the LLM settings." |
| `bad_request` | "The model provider rejected the request. Check LLM_MODEL." |

## Selection (`src/server/llm/index.ts`)

```ts
export function getLlmStatus(): { configured: true; provider: LlmProviderName; model: string } | { configured: false; problems: EnvIssue[] };
export function getLlm(): LlmProvider;                         // throws LlmNotConfiguredError (name "LlmNotConfiguredError" → ActionResult "conflict" with its message)
export function setLlmForTests(llm: LlmProvider | null): void; // test-only seam; no-op guard: throws unless NODE_ENV === "test"
export function createOpenAiProvider(cfg: LlmConfig, opts?: { fetch?: typeof fetch }): LlmProvider;
export function createAnthropicProvider(cfg: LlmConfig, opts?: { fetch?: typeof fetch }): LlmProvider;
```

`LlmNotConfiguredError`'s message is "Generation is not configured. Set: LLM_PROVIDER, LLM_MODEL, OPENAI_API_KEY." It names the missing settings and never their values. `failFromError` adds it to `ERROR_NAME_TO_CODE` as `conflict`, which keeps the message.

## Configuration (`src/server/llm/config.ts`, documented in `.env.example`)

| Variable | Rule | Default |
|---|---|---|
| `LLM_PROVIDER` | `openai` \| `anthropic` | none: unset means generation is disabled |
| `LLM_MODEL` | 1–200 characters, no whitespace | **none** (no model literal anywhere in `src/`) |
| `OPENAI_API_KEY` | required when the provider is `openai`; secret | — |
| `ANTHROPIC_API_KEY` | required when the provider is `anthropic`; secret | — |
| `LLM_TIMEOUT_SECONDS` | integer 10–600 | 90 |
| `LLM_MAX_OUTPUT_TOKENS` | integer 256–32,000 | 4000 |

```ts
export interface LlmConfig { provider: LlmProviderName; model: string; apiKey: string; timeoutMs: number; maxOutputTokens: number }
export function parseLlmConfig(source: Record<string, string | undefined>): { ok: true; config: LlmConfig } | { ok: false; problems: EnvIssue[] };
```

- Problems carry names and reasons only: "required when LLM_PROVIDER=openai", "must be openai or anthropic", "must be an integer from 10 to 600".
- When nothing is set, there is exactly one problem: `LLM_PROVIDER: not set; generation is disabled`.
- `runStartup` logs `Docket: generation disabled (<NAME>: <reason>; …)` and continues (research D5). It never calls `exit`.
- A key set for the provider that is *not* selected is ignored and not reported.

## Fake (`tests/helpers/fake-llm.ts`)

```ts
export type FakeStep<T = unknown> =
  | { ok: unknown }                       // value returned as-is (rawText = JSON.stringify), still passed through schema.safeParse
  | { raw: string }                       // raw text, parsed like a real provider (invalid JSON → invalid_output)
  | { fail: LlmFailureKind };
export function createFakeLlm(steps: FakeStep[], opts?: { provider?: LlmProviderName; model?: string; latencyMs?: number }): LlmProvider & {
  requests: { label: string; system: string; user: string; images: LlmImage[]; schemaName: string }[];
  remaining(): number;                    // tests assert 0 (SC-004: exactly two calls)
};
```

- Running out of scripted steps throws, so the test fails loudly.
- The fake runs the same `safeParse` the real implementations run, so a scripted value that breaks the structure produces `invalid_output`.

## Fake transport (`tests/helpers/fake-llm-http.ts`)

`createFakeLlmFetch(responses: { status: number; json?: unknown; delayMs?: number }[])` returns a `fetch` that records `{ url, body }`, replays the responses in order, and honours `signal` (an abort rejects with `AbortError`). It is used by `src/server/llm/openai.test.ts` and `anthropic.test.ts` with `maxRetries` overridden to 0.

## Model-input images (`src/server/llm/images.ts`)

```ts
export const LLM_IMAGE_CONSTRAINTS: MediaConstraints; // jpeg/png/webp/gif → jpeg; long edge ≤ 2000 px; ≤ 5,000,000 bytes (research R1)
export const LLM_REQUEST_IMAGE_BUDGET_BASE64 = 24_000_000;
export async function imagesForModel(scope: ProjectScope, assets: readonly MediaRow[]): Promise<
  { ok: true; images: LlmImage[]; record: { mediaAssetId: string; mode: "url" | "bytes" }[] } |
  { ok: false; message: string }          // "Image 2 (photo.png) could not be prepared for the model." — names the image, no keys or URLs
>;
```

1. Plan each asset with `planImage(asset, LLM_IMAGE_CONSTRAINTS)`:
   - `original` uses the asset as is;
   - `derive` gets or builds the cached variant through the new `ensureVariant(scope, asset, constraints)`, which `media-variants.ts` exports and which reuses `buildVariant`;
   - `refuse` returns `ok: false`.
2. Choose the mode. Use **URL** when the storage config has `previewUrls === "public"` and the public URL is `https:` with a host that is not `localhost`, `*.localhost`, an IP literal or `*.local`. Otherwise use **bytes** via `storage.get(key)`.
3. In bytes mode, if the total base64 size is over the budget, return `ok: false` ("These images are too large to send to the model together.") before any call.
4. When storage is not configured but media is attached, return `ok: false` ("Media storage is not set up."), using the existing message.

## Image generation extension point (`src/server/llm/image-generation.ts`, interface only, FR-020)

```ts
export interface ImageGenerationRequest { projectId: string; prompt: string; aspect?: "square" | "portrait" | "landscape"; size?: { width: number; height: number } }
export type ImageGenerationResult = { ok: true; mediaAssetId: string } | { ok: false; message: string };
export interface ImageGenerator { generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> }
```

There is no implementation, no configuration and no UI. A type-only test asserts that the module exports no runtime values except types.
