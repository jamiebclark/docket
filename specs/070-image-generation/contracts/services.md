# Contract — Services: the adapter, the generator, the hold and the ledger

**Feature**: `070-image-generation` | Covers **FR-008 – FR-029**, **FR-037**, G4 – G21, **P5 – P18**

---

## 1. The contract module — `src/server/llm/image-generation.ts`

Unchanged types (G4, FR-008):

```ts
export interface ImageGenerationRequest {
  projectId: string;
  prompt: string;
  aspect?: "square" | "portrait" | "landscape";
  size?: { width: number; height: number };
}
export type ImageGenerationResult = { ok: true; mediaAssetId: string } | { ok: false; message: string };
export interface ImageGenerator {
  generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;
}
```

New runtime exports — the contract's **vocabulary only** (**P16**):

```ts
export type ImageAspect = NonNullable<ImageGenerationRequest["aspect"]>;
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["square", "portrait", "landscape"];
export const DEFAULT_IMAGE_ASPECT: ImageAspect = "square";
export const IMAGE_PROMPT_MAX = 1000;  // G8: the lowest ceiling the installed SDK documents

/**
 * Appended to every prompt sent to a provider (G14, FR-014, SC-010). Docket never tries to detect
 * such a prompt itself; it tells the provider, says so in the UI and says so in docs/generator.md.
 */
export const NO_REAL_PEOPLE =
  "Do not depict any real, identifiable person. No real people, no recognisable likenesses, no public figures, no named individuals.";
```

`image-generation.test.ts` is rewritten: the module exports exactly this vocabulary, and **no
vendor value** — no `WIDTHxHEIGHT` string, no provider name, no model id, no SDK import.

## 2. The vendor-neutral provider interface — `src/server/llm/image-provider.ts`

```ts
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
```

The **one invariant that makes FR-010 and SC-007 true**: no pixel size, output format, response
field name or vendor error code appears in this type or anywhere above it. Everything above the
adapter sees a prompt, an aspect, bytes and a `LlmFailureKind`.

`LlmFailureKind` is reused **verbatim** (G13, FR-016), so the hold rule, the ledger's
`failure_kind` column and the mapping tests are shared and cannot disagree.

## 3. Image failure sentences — `src/server/llm/image-messages.ts`

A parallel fixed-sentence map, because the text sentences are wrong here (G13): "The model declined
to write this post." is not what happened.

```ts
export const IMAGE_FAILURE_MESSAGES: Record<LlmFailureKind, string> = {
  invalid_output: "The image provider's answer could not be read.",
  refused: "The image provider declined to make this image.",
  incomplete: "The image provider's answer was cut off.",
  timeout: "The image provider took too long to answer.",
  rate_limited: "The image provider is rate limiting requests. Try again in a minute.",
  unavailable: "The image provider is unavailable. Try again shortly.",
  auth: "The image provider refused Docket's API key. Check the image generation settings.",
  bad_request: "The image provider rejected the request. Check LLM_IMAGE_MODEL and the shape you asked for.",
  credit_exhausted:
    "The image provider refused: the account has no credit or quota left. Add credit to the provider account.",
};
export function imageFailureMessage(kind: LlmFailureKind): string;
```

A test asserts **both** maps are keyed by every value of `LLM_FAILURE_KINDS`, so a tenth kind
cannot leave either path with an undefined message (FR-016). `incomplete` cannot arise from the
images endpoint today and still has a sentence, because the requirement is coverage, not
reachability.

## 4. The OpenAI adapter — `src/server/llm/openai-image.ts`

```ts
export function createOpenAiImageProvider(
  cfg: LlmImageConfig,
  opts: { fetch?: typeof fetch; maxRetries?: number } = {},
): ImageProvider;
```

Everything vendor-specific lives here and nowhere else (G5, FR-010).

| Concern | Behaviour | Source |
|---|---|---|
| Client | `new OpenAI({ apiKey, timeout: cfg.timeoutMs, maxRetries: opts.maxRetries ?? 0, ...fetch })` | **P5** — a paid, non-idempotent call is not retried automatically (G24) |
| Aspect → size | `square → "1024x1024"`, `landscape → "1536x1024"`, `portrait → "1024x1536"` | the three sizes the installed SDK documents for the GPT image models (research § 2) |
| Explicit size | `` `${width}x${height}` `` after a positive-integer check only; the provider is the arbiter of whether it is acceptable | **P9**, G5/G6 |
| Body | `{ model, prompt, n: 1, size, output_format: "png" }` and nothing else | **P10**, G7 |
| Reading the result | `response.data?.[0]?.b64_json`; missing, empty `data`, or an item with no bytes → `invalid_output` | research § 2; spec edge case "success with no image" |
| MIME type | `"image/png"` — the format Docket asked for. `processUpload` re-judges by content anyway | G7, G16 |
| Usage | `response.usage?.input_tokens ?? null` / `output_tokens ?? null`; never coerced to zero | FR-019 |
| Timeout | `AbortSignal.timeout(cfg.timeoutMs)`, combined with `request.signal` via `AbortSignal.any` when one is given — the same shape `createOpenAiProvider` uses | FR-007 |
| Logging | `logLlmCall({ provider, model, label, latencyMs, outcome, usage })` on every outcome | **P7** |

### Error classification

```ts
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
): LlmFailureKind;
```

Order: timeout/abort → a marker match → `refused`; otherwise **delegate to `kindOfError`**, which
`openai.ts` exports for this purpose (**P6**). So credit refusals, 401/403, 429, 400/404/422 and
everything else map identically on both paths, by sharing the function rather than copying it, and
an unrecognised 400 lands on `bad_request` (FR-011).

`markers` is a defaulted parameter so a test proves the one-line widening works with its own value,
without Docket guessing one (research § 2).

## 5. The shared hold rule — `src/server/services/generation/credit.ts`

```ts
/** The whole billing-hold decision, in one place (G10, FR-017). Never throws. */
export async function applyCreditOutcome(owner: string, kind: LlmFailureKind | null): Promise<void>;

export function withCreditHold(llm: LlmProvider, owner: string): LlmProvider;        // unchanged behaviour
export function withImageCreditHold(image: ImageProvider, owner: string): ImageProvider;  // NEW
```

`applyCreditOutcome` holds on `credit_exhausted`, clears on every other outcome, and swallows the
write failure. Both decorators delegate, return the result **unchanged**, and add nothing else.
`withCreditHold`'s existing tests keep passing untouched — that is the proof the extraction changed
no behaviour.

Not added, on purpose: **no hold check before the call** (G11, FR-018). Every in-request path on
`main` calls and lets a refusal re-hold; only the batch-job claim consults `gateCreditHolds`, and
this entry adds nothing to jobs.

## 6. The usage recorder — `src/server/llm/usage.ts`

```ts
export type UsagePurpose = /* … the seven */ | "image.generate";

export interface UsageRecorder {
  wrap(llm: LlmProvider): LlmProvider;
  wrapImage(image: ImageProvider): ImageProvider;   // NEW — same buffer, same flush, same swallow
  flush(link?: LlmUsageLink): Promise<void>;
}
```

`wrapImage` buffers exactly the same row shape from an `ImageProviderResult`: `provider`, `model`,
`ok`, `failureKind`, `inputTokens`, `outputTokens`, `latencyMs`, `calledAt`. One recorder, one
rule (**P8**).

The image path flushes with **no link** (`flush({})`): an image call belongs to no post, series or
job. A call that never reached the provider — no permission, bad prompt, no storage, no provider
configured, undecryptable key — is never wrapped and therefore never recorded (FR-019, US5-5).

## 7. The generator service — `src/server/services/media-generate.ts`

```ts
export const GENERATED_FILENAME = "Generated image.png";   // G18, FR-026

/** Whether the Media page may offer the action at all (P20). Needs media:["view"]. */
export function imageGenerationEnabled(scope: ProjectScope): boolean;

/** The declared contract, bound to a scope (P15). */
export function createImageGenerator(scope: ProjectScope): ImageGenerator;

/** What the server action calls. */
export function generateImage(
  scope: ProjectScope,
  input: unknown,
  signal?: AbortSignal,
): Promise<ImageGenerationResult>;
```

### The order of operations, which is the order of the tests

| # | Step | On failure |
|---|---|---|
| 1 | `requirePermission(scope, { media: ["generate"] })` | **throws** `ForbiddenError` (**P17**, FR-031, US4-4/5) |
| 2 | `request.projectId !== scope.project.id` (contract path only) | **throws** `ForbiddenError` (US4-6, FR-037) |
| 3 | `generateImageSchema.parse(input)` — prompt trimmed, 1–1000; aspect one of three; size positive integers | **throws** `ZodError` → `runAction` renders a field error. **No provider call, no asset** (FR-012, US1-4) |
| 4 | `if (!getStorage()) return { ok: false, message: MEDIA_STORAGE_NOT_SET_UP }` | returned, before any provider call (FR-029, US4-2) |
| 5 | `resolveImageLlmForProject(scope.project.id)` | `not_configured` → `Image generation is not configured. Set: …` (names only). `key_unreadable` → the existing `LLM_KEY_UNREADABLE` sentence (FR-006, US3-6, US4-3) |
| 6 | `recorder = createUsageRecorder({ projectId, purpose: "image.generate", source })`; `provider = recorder.wrapImage(withImageCreditHold(resolved.image, resolved.owner))` | — |
| 7 | `provider.generate({ label: "image.generate", prompt: `${trimmed}\n\n${NO_REAL_PEOPLE}`, aspect, size, signal })`, then `recorder.flush({})` in a `finally` | `{ ok: false, message: imageFailureMessage(kind) }`. Nothing written (FR-009, US1-5) |
| 8 | `uploadMedia(scope, { file: { name: GENERATED_FILENAME, bytes }, generation: { prompt: trimmed, provider, model, at } })` | an upload rejection is returned as `{ ok: false, message: rejection.message }` — the **library's own sentence** (FR-022, US1-6) |
| 9 | `{ ok: true, mediaAssetId: asset.id }` | — |

Notes that are requirements, not commentary:

- **The stored prompt is the person's, trimmed — not the prompt sent.** The guardrail is appended
  for the provider and is never part of provenance (FR-025).
- **The signal reaches step 7 only.** Never storage, never the database (**P18**), so the spec's
  "either both stored objects and the row exist, or neither" holds by construction.
- **Alt text starts empty and no tag is written** (G19, G20, FR-026, FR-027): `uploadMedia` is
  called with no `altText` and no `tags`, so the column default `''` and `'{}'` apply.
- **`recorder.flush` is in a `finally`**, so a thrown write still records the call that was spent.

## 8. The media service changes — `src/server/services/media.ts`

```ts
export interface GenerationProvenance {
  prompt: string; provider: string; model: string; at: Date;
}

export async function uploadMedia(
  scope: ProjectScope,
  input: { file: { name: string; bytes: Buffer }; generation?: GenerationProvenance },
): Promise<UploadResult>;

export async function commitUpload(
  tx: ProjectScope,
  prepared: PreparedUpload,
  meta: { altText?: string; tags?: string[]; generation?: GenerationProvenance } = {},
): Promise<MediaView>;
```

`commitUpload` spreads the four columns into the **same insert** as everything else — one row, one
write, inside the caller's transaction (data-model § 1). `uploadMedia`'s existing
`discardPreparedUpload` on a thrown row write is untouched and now covers the generated case too
(FR-023). `prepareUpload` is entirely unchanged, so every library rule applies to the generated
bytes by the same code (FR-022).

`toView` gains:

```ts
generated: row.generatedAt
  ? { prompt: row.generationPrompt!, provider: row.generationProvider!, model: row.generationModel!, at: row.generatedAt }
  : null,
```

`MediaView.generated` is the only new field any screen reads (FR-035). `registerAsset` — the public
API's storage-free path — is **not** extended: the API does not generate images
(`setup-write-api` owns the API surface).

## 9. The shared storage sentence — `src/server/storage/index.ts`

```ts
/** The one sentence for "there is nowhere to put this" (G26, FR-029). */
export const MEDIA_STORAGE_NOT_SET_UP = "Media storage is not set up.";
```

`src/server/llm/images.ts` deletes its private `NOT_SET_UP` and imports this (**P13**). A test
asserts the image-input path and the image-generation path return the **identical string**.

## 10. Authorization — `src/server/auth/access.ts`

```ts
media: ["view", "edit", "generate"],   // statements
```

`generate` is added to `owner` and `admin` only; `editor` keeps `["view", "edit"]` (G22, FR-031).
`src/server/auth/access.test.ts`'s matrix is built from `statements` by construction and fails
until it names the new action for all three roles (**P19**). No migration: roles live in code.

## 11. What the service layer does **not** gain

- No job, queue, scheduler or tick work (G24; the spec's out-of-scope list).
- No retry, cooldown, quota, lease or spend cap (G24, G25).
- No brand context, voice profile, post text or platform rule in an image prompt (G15, FR-015).
- No prompt inspection, name detection or local content refusal (G14, FR-014).
- No image editing, variation, upscale, inpaint or regenerate-in-place.
- No change to `runGeneration`, the job runner, the composer, any social provider, or either
  failure-kind `pgEnum`.
