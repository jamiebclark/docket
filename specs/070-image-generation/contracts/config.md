# Contract — Configuration: the image provider group

**Feature**: `070-image-generation` | Covers **FR-001 – FR-007**, G1 – G3, **P1 – P4**

---

## 1. The two variables

| Variable | Required | Rule |
|---|---|---|
| `LLM_IMAGE_PROVIDER` | no | When set, must be `openai`. Unset means image generation is off, and that is not a problem (FR-001). |
| `LLM_IMAGE_MODEL` | when `LLM_IMAGE_PROVIDER` is set | 1–200 characters, no whitespace. **No default, ever** (G2, FR-002). |

No third variable. The key is the provider's existing one — `OPENAI_API_KEY` — read, as it is
today, **only** in `src/server/llm/config.ts` (G3, FR-004). `key-reads.test.ts` is unchanged.

The call's timeout is the install-wide `LLM_TIMEOUT_SECONDS`, through the same `parseLlmLimits`.
`LLM_MAX_OUTPUT_TOKENS` is **not** read by the image path and is never sent to an image provider
(FR-007).

## 2. `.env.example` (FR-038)

Appended to the existing `# --- Generator (LLM) ---` group, after `LLM_MAX_OUTPUT_TOKENS` and
before the rate block. Each entry carries a description, the optional/required marker and the
default, which is what `tests/lint/env-coverage.test.ts` asserts.

```sh
# Optional. Image generation provider: openai. Leave empty to turn image generation off; everything
# else keeps working. Configured separately from LLM_PROVIDER on purpose, because the best provider
# for text inside a picture is not the best provider for writing a post. Requires media storage.
# No default. Image generation is off when unset.
# LLM_IMAGE_PROVIDER=openai

# Optional. Image model id your provider account can use; required when LLM_IMAGE_PROVIDER is set.
# No spaces, up to 200 characters. Must be one of the provider's GPT image models: Docket asks for
# an explicit output format and reads base64 bytes, which the older DALL-E models do not support.
# No default.
# LLM_IMAGE_MODEL=
```

No model id appears in either block (G2, FR-003); the second is left empty exactly as `LLM_MODEL`
is.

## 3. Parsing — `src/server/llm/config.ts`

```ts
export type LlmImageProviderName = "openai";

export interface LlmImageConfig {
  provider: LlmImageProviderName;
  model: string;
  apiKey: string;
  timeoutMs: number;   // install-wide; no maxOutputTokens (FR-007)
}

/** Problems carry variable names and reasons only, never values. */
export function parseLlmImageConfig(
  source: Source,
): { ok: true; config: LlmImageConfig } | { ok: false; problems: EnvIssue[] };

/** Deliberately outside LLM_VARIABLES (P1): llmEnvIssues must not demand LLM_PROVIDER for these. */
export const LLM_IMAGE_VARIABLES: readonly string[] = ["LLM_IMAGE_PROVIDER", "LLM_IMAGE_MODEL"];

/** The image group's strict startup wrapper. Same shape and same rule as llmEnvIssues. */
export function llmImageEnvIssues(source: Source): EnvIssue[];
```

`parseLlmImageConfig` reuses `intIn` / `limitsFrom`'s timeout and the existing `KEY_NAME` map; it
adds no second way to read a key.

### Parse table

| `LLM_IMAGE_PROVIDER` | `LLM_IMAGE_MODEL` | `OPENAI_API_KEY` | `parseLlmImageConfig` | `llmImageEnvIssues` |
|---|---|---|---|---|
| unset | unset | any | `{ ok: false, problems: [LLM_IMAGE_PROVIDER: "not set; image generation is disabled"] }` | `[]` — not a problem (FR-001, FR-005) |
| unset | set | any | same as above | `[LLM_IMAGE_PROVIDER: "required when any LLM_IMAGE_* variable is set"]` |
| `openai` | unset | set | `{ ok: false, problems: [LLM_IMAGE_MODEL: "required when LLM_IMAGE_PROVIDER=openai"] }` | the same problem |
| `openai` | `  ` (blank after trim) | set | as above | as above |
| `openai` | 201 chars, or contains whitespace | set | `[LLM_IMAGE_MODEL: "must be 1 to 200 characters with no spaces"]` | the same problem |
| `openai` | set | unset | `[OPENAI_API_KEY: "required when LLM_IMAGE_PROVIDER=openai"]` | the same problem |
| `anthropic` or anything else | any | any | `[LLM_IMAGE_PROVIDER: "must be openai"]` | the same problem |
| `openai` | set | set | `{ ok: true, config }` | `[]` |

Every reason names a variable and describes a format. **No reason ever contains a value**
(FR-005, FR-020, constitution VII) — asserted by a test that feeds distinctive values and scans
every message for them.

### Interaction with the text group

Independent in both directions (G1, FR-002):

- `LLM_PROVIDER=anthropic` with `LLM_IMAGE_PROVIDER=openai` is valid and normal — that is the case
  G1 exists for.
- An install with **no** text provider and a configured image group is valid: `llmEnvIssues`
  returns `[]` because no `LLM_VARIABLES` entry is set… unless `OPENAI_API_KEY` is, which **is** in
  `LLM_VARIABLES`. In that case `llmEnvIssues` demands `LLM_PROVIDER` — the existing rule, firing
  on an existing variable, unchanged by this entry. Stated here so nobody reads it as a regression:
  an install that sets an OpenAI key has always been required to say what it is for.

## 4. Startup — `src/server/startup/validate.ts`

```ts
const issues = [
  ...(parsed.ok ? [] : parsed.issues),
  ...providerEnvIssues(source),
  ...llmEnvIssues(source),
  ...llmImageEnvIssues(source),          // NEW
];
```

and, beside the existing generation line:

```ts
if (!source.LLM_IMAGE_PROVIDER?.trim() && llmImageEnvIssues(source).length === 0) {
  disabled.push("image generation is off (LLM_IMAGE_PROVIDER not set)");
}
```

**Issues, not warnings** (**P2**): a half-configured image group stops startup with the name and
the reason, exactly as a half-configured text group does. The `warnings` channel stays reserved for
rate configuration, where the value is a guess rather than a typo.

`tests/lint/env-coverage.test.ts` gains `LLM_IMAGE_VARIABLES` in its `CONFIGURABLE` list —
extended, never exempted (**P24**).

## 5. Resolution — `src/server/llm/resolve.ts`

```ts
export type ResolvedImageLlm =
  | {
      ok: true;
      source: "project" | "install";
      provider: LlmImageProviderName;
      model: string;        // ALWAYS the install's LLM_IMAGE_MODEL (P4)
      owner: string;        // the credit-hold key for the credential actually used
      timeoutMs: number;    // install-wide
      image: ImageProvider; // holds the key; never serialised, logged or returned outside the server
    }
  | { ok: false; reason: "not_configured"; problems: EnvIssue[] }
  | { ok: false; reason: "key_unreadable" };

export async function resolveImageLlmForProject(projectId: string): Promise<ResolvedImageLlm>;
```

Order of decisions, which is also the order of the tests:

1. **Test override.** `currentImageProviderTestOverride()` — if set, return it as
   `source: "install"`, `owner: INSTALL_CREDENTIAL_OWNER`. Mirrors `resolveLlmForProject`'s first
   branch exactly, so the factory seam (not the provider seam) is what a per-credential test uses.
2. **Install image config.** `parseLlmImageConfig(process.env)`. Not ok → `not_configured` with the
   problems. This is the gate: with no image group configured there is no image provider at all,
   whatever a project has stored (FR-001, US4-3).
3. **The project's stored credential.** `projectLlmRepoFor(projectId).read()`. If
   `row.provider === config.provider`:
   - decrypt; `SecretDecryptionError` → `{ ok: false, reason: "key_unreadable" }`, **no fallback**
     (FR-006, US3-6);
   - build the adapter from `{ provider: config.provider, model: config.model, apiKey: <project's>,
     timeoutMs }` — the project's key, the install's model (**P4**);
   - `source: "project"`, `owner: projectCredentialOwner(projectId)`.
4. **Otherwise the install's.** `source: "install"`, `owner: INSTALL_CREDENTIAL_OWNER`, key from
   the parsed config. This covers both "no stored credential" and "a stored credential for a
   different vendor" — G9's reasoning: a project that chose Anthropic for its text has expressed no
   preference about images.

`resolveImageLlmForProject` is the **only** function that reads a project's encrypted key on the
image path, and it lives in the one file already allowed to name that column (**P3**).

### Missing-settings sentence

```ts
export function missingLlmImageSettings(problems: readonly { name: string }[]): string[];
```

Mirrors `missingLlmSettings`: a lone `LLM_IMAGE_PROVIDER` problem expands to
`["LLM_IMAGE_PROVIDER", "LLM_IMAGE_MODEL", "OPENAI_API_KEY"]`, so an owner is told everything to
set at once. The caller renders
`Image generation is not configured. Set: LLM_IMAGE_PROVIDER, LLM_IMAGE_MODEL, OPENAI_API_KEY.` —
names only, never values (FR-005, US4-3).

## 6. The provider registry — `src/server/llm/image-provider.ts`

Mirrors `src/server/llm/index.ts` one for one, so there is one idiom, not two:

```ts
export function createImageProviderForConfig(config: LlmImageConfig): ImageProvider;
export function getImageProvider(): ImageProvider;            // throws ImageNotConfiguredError
export function getImageStatus():
  | { configured: true; provider: LlmImageProviderName; model: string }
  | { configured: false; problems: EnvIssue[] };
export function currentImageProviderTestOverride(): ImageProvider | null;
export function setImageProviderForTests(p: ImageProvider | null): void;        // test-only
export function setImageProviderFactoryForTests(                                 // test-only
  fn: ((config: LlmImageConfig) => ImageProvider) | null,
): void;
```

Both seams throw outside `NODE_ENV === "test"`, as the text ones do. The built provider is cached
by `JSON.stringify(config)` exactly as `getLlm()` caches.

## 7. What configuration does **not** gain

- No `LLM_IMAGE_API_KEY` (G3) — a second key to rotate for the same vendor account.
- No per-project image provider or model (spec's out-of-scope list; **P4**).
- No image size, aspect, format or quality variable — those are the adapter's (G5) and the person's
  (the aspect control).
- No change to `LLM_RATES` or `LLM_RATE_CURRENCY` (G12). An image model with no configured rate
  shows calls and tokens with no money figure, which the Usage screen already handles.
- No cap, quota or cooldown variable (G25).
