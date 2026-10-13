# Feature Specification: Generate images into the media library, behind the existing ImageGenerator extension point

**Feature Branch**: `070-image-generation`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "src/server/llm/image-generation.ts already declares the contract — `ImageGenerationRequest { projectId, prompt, aspect?, size? }`, `ImageGenerationResult`, `ImageGenerator` — and says in its own comment that it is an extension point only, with no implementation, configuration or UI. Implement it. Add an image-capable provider alongside the text providers in src/server/llm (openai.ts, anthropic.ts, config.ts, types.ts), following the same resolution and credential pattern config.ts already uses, including the per-project credential work from 065-per-project-llm and the credit-hold behaviour in src/server/services/generation/credit.ts and src/server/db/schema/generation.ts (`llm_credit_holds`) — a billing refusal from the image provider must take the same hold path as a text refusal, not fail loudly per request. Start with OpenAI's image model since the `openai` dependency and credentials already exist, but keep the model id out of source (there is a `no-model-literal.test.ts` guarding exactly this) and make the provider swappable, because text rendering inside generated images is the weak point for sports graphics and the best provider for that will change. A generated image must land in the media library as a normal asset: write through src/server/services/media.ts into `mediaAssets` (src/server/db/schema/media.ts, `kind = 'image'`) and S3 via src/server/storage, so variants (src/server/services/media-variants.ts), fit checks (media-fit.ts) and every existing per-platform constraint in src/providers/media.ts apply unchanged; record provenance on the asset (that it was generated, with the prompt and provider/model) via a committed migration, and never store credentials in it. Requires media storage: when storage is not configured, fail with the same 'Media storage is not set up.' message src/server/llm/images.ts already uses, and hide the UI. UI: an owner/admin-visible 'Generate an image' action on the Media page (src/app/p/[projectSlug]/media/page.tsx) taking a prompt and an aspect, showing the generated asset in the library on success; follow the docket-ui skill and docs/design-system.md, announce the outcome through a LiveRegion, label every control, full keyboard use. Tests: provider mapping and error shapes, credit-hold on billing refusal, storage-not-configured, asset + variant creation, prompt/provenance persistence, project isolation, authz, and the secret-scan test. Update docs/storage.md and docs/generator.md, and log judgement calls in docs/decisions.md. This entry does NOT wire image generation into the post generator or into jobs — a post that needs an image still gets one from the library, and `evergreen-series` is what makes a series produce its own; it does NOT generate images of real people (record that as a decision: likeness and publicity rights make athlete portraits a legal problem, and the project's own voice profiles already forbid using a real child's likeness), and it does NOT add video generation."

## Context and sources

- Roadmap `.specify/roadmaps/content-engine-roadmap.json`, entry **2 of 6**, slug `image-generation`. The roadmap's goal: "Turn Docket from a tool that schedules posts someone else wrote into one that can run a brand's content backlog on its own: hold the brand's identity as data, generate its own images, keep standing and date-pegged content series producing posts without anyone re-creating a job each week, and expose project setup over the API so onboarding a brand stops being a manual pass through the UI."
- The roadmap places this second because it is "the one capability the brand genuinely cannot do by hand at volume", and because the later series entries want images to already be ordinary library assets before a series starts asking for its own.
- Entry 1 (`brand-profile-fields`, `specs/069-brand-profile-fields`) is on `main`: `projects` now carries `tagline`, `description` and `websiteUrl`, and the prompt composer renders them as a labelled `BRAND` block ahead of `VOICE`. This entry does **not** feed brand context into image prompts — see "What this entry does not do".
- Later entries own what this one leaves out: `evergreen-series` is what makes a standing series produce its own images; `setup-write-api` owns any public-API surface.
- The spec directory number (070) follows the feature branch rather than `specs/`'s own highest. Branch and spec directory are kept aligned on purpose; `docs/decisions.md` § 045 records why.

### Behaviour on `main` that this feature builds on

Read from the code, from `docs/generator.md` and from `docs/storage.md`:

- **The contract already exists and is deliberately inert.** `src/server/llm/image-generation.ts` declares `ImageGenerationRequest { projectId, prompt, aspect?: "square" | "portrait" | "landscape", size?: { width, height } }`, `ImageGenerationResult = { ok: true; mediaAssetId: string } | { ok: false; message: string }` and `ImageGenerator { generate(request, signal?) }`. Its own test, `image-generation.test.ts`, asserts the module has **no runtime exports** — that test is the thing this entry retires.
- **`src/server/llm/images.ts` is about image *input*, not output.** It prepares already-stored media for a model call, and holds the sentence `"Media storage is not set up."` in a private `NOT_SET_UP` constant. Nothing in it generates anything.
- **Text providers follow one shape.** `LlmProvider { name, model, generate<T>(LlmRequest<T>): Promise<LlmResult<T>> }` in `types.ts`; `createOpenAiProvider` / `createAnthropicProvider` build one from an `LlmConfig`; `index.ts` picks between them, caches by config, and offers the two test seams `setLlmForTests` and `setLlmFactoryForTests`. A provider "never throws for provider or network failures; returns `ok: false`. Throws only on programmer error."
- **One failure vocabulary, one sentence each.** `LlmFailureKind` has nine values (`invalid_output`, `refused`, `incomplete`, `timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`, `credit_exhausted`) and `messages.ts` maps each to exactly one fixed sentence: "SDK error text never reaches a user."
- **Configuration is parsed in one place and keys are read in one file.** `parseLlmConfig` reads `LLM_PROVIDER`, `LLM_MODEL`, the provider's key variable, `LLM_TIMEOUT_SECONDS` (10–600, default 90) and `LLM_MAX_OUTPUT_TOKENS` (256–32000, default 4000); `LLM_MODEL` has no default "on purpose". `llmEnvIssues` treats a wholly absent group as "generation is disabled, not an issue" but any partially-set group as an issue, with names and reasons only, never values. `key-reads.test.ts` asserts `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are read **only** in `src/server/llm/config.ts`, and that `api_key_encrypted` is named only in the schema, `dal/project-llm.ts` and `llm/resolve.ts`.
- **Per-project credentials resolve in `resolve.ts`.** `resolveLlmForProject(projectId)` returns the project's own decrypted credential when `project_llm_settings.provider` is set, otherwise the install's; it reports `source: "project" | "install"`, the credit-hold `owner` (`project:<id>` or the `install` constant), install-wide `limits`, the built provider and the key for redaction only. An undecryptable key returns `{ ok: false, reason: "key_unreadable" }` and **never** falls back to the install's credential.
- **The credit hold is a wrapper, and it is forgiving.** `withCreditHold(llm, owner)` in `src/server/services/generation/credit.ts` delegates `generate`, then calls `holdCredit(owner, now)` when `result.kind === "credit_exhausted"` and `clearCreditHold(owner)` on every other outcome, swallowing hold-write failures because "a database hiccup must never turn a good generation into a failure". `holdCredit` upserts `llm_credit_holds` (`owner` primary key, `heldSince` not moved by a refresh, `lastRefusalAt`, `nextProbeAt = now + 5 min`). Only the batch-job claim gates on holds (`gateCreditHolds`); in-request paths (single, series, regenerate, "Try it", `llm:check`) just call and let a refusal re-hold.
- **OpenAI's billing refusal is identified by two extensible sets.** `OPENAI_CREDIT_TYPES` / `OPENAI_CREDIT_CODES` in `openai.ts`, verified against a live 429 on 2026-10-12; the comment records that the original research guess was wrong and that "each is a set, so another observed value is one line".
- **The usage ledger records every call that reached a provider.** `createUsageRecorder({ projectId, purpose, source })` wraps a provider, buffers one row per call (provider, model, ok, failureKind, input/output tokens, latency, calledAt) and flushes with an optional link. `purpose` is the pgEnum `llm_usage_purpose` with seven values, mirrored by the `UsagePurpose` type, the `USAGE_PURPOSE_LABELS` map and **two guard tests** in `no-missing-usage-purpose.test.ts` — one of which asserts the closed set names *exactly* the seven call sites, so an eighth purpose is a deliberate, reviewed widening. `docs/generator.md` states the ledger's promise: "calls and tokens are recorded for every call that reaches a provider, whatever its outcome".
- **Uploads already have the write-through path a generated image needs.** `prepareUpload(scope, { name, bytes })` checks `media: ["edit"]`, requires storage, refuses anything that looks like a video, runs `processUpload` (judges the file by its contents, refuses anything but JPEG/PNG/WebP, refuses animated, enforces `MEDIA_MAX_UPLOAD_MB` (default 20) and `MEDIA_MAX_MEGAPIXELS` (default 50), strips all metadata, re-encodes, makes a 480 px WebP thumbnail), then puts both objects under `mediaKeys(projectId, assetId)` — every key starts `projects/<projectId>/`. `commitUpload(tx, prepared)` writes the row inside the caller's transaction; `uploadMedia` composes the two and calls `discardPreparedUpload` if the row write throws, so no object is orphaned. `registerAsset` is a different, storage-free path used by the public API.
- **`media_assets` is wide and heavily constrained.** `kind` is CHECKed to `('image','video')` and defaults to `'image'`; `processing_state` to `('processing','ready','failed')`; `storage_key` is unique per project; `alt_text` defaults to `''`; `tags` are capped at 20; `first_used_at` is what the "Unused" filter reads. There is no provenance column of any kind.
- **Variants and fit checks are derived on demand, from the row.** `ensureVariant(scope, asset, constraints, index)` caches one compliant copy per constraint hash in `media_variants`; `fitOf(asset, provider)` asks `planImage` / `validateAgainstCapabilities` for each registered provider and returns `fits` / `converted` / `adapted` / `refused` with the planner's own sentences. Neither knows nor cares where the bytes came from — both read `mimeType`, `width`, `height` and `byteSize` off the row.
- **The Media page already has a storage-off state and role-aware actions.** `mediaStatus(scope)` reports `enabled: getStorage() !== null`; when it is false the whole library is replaced by an `EmptyState` ("Media storage is not set up, so images and videos can't be uploaded yet.") with a "Set up storage" link for owners. `canEdit = scope.can({ media: ["edit"] })` gates the upload dropzone; `canGenerate = scope.can({ generation: ["run"] })` gates the two "generate posts for these images" links. Both `media: ["edit"]` and `generation: ["run"]` are held by **editors** as well as owners and admins (`src/server/auth/access.ts`); the owner/admin-only statements today are `project: ["update"]`, `audit: ["view"]`, `account: ["manage"]`, `slot: ["manage"]`, `voice: ["manage"]`, `generation: ["auto_approve"]`, `api_key: ["manage"]`, `webhook: ["manage"]` and `llm_credential: ["manage"]`.
- **Server actions have one shape.** `runAction(slug, fn)` returns an `ActionResult`; expected refusals come back as data, never thrown; `refresh()` from `next/cache` is what makes a new asset appear in the library (`completeUploadAction` already does exactly this). `LiveRegion` is a kept-mounted `role="status"` element whose `message` changes — its own comment warns that "an element added together with its text is often not announced".
- **`docs/generator.md` currently ends by naming image generation as out of scope.** That sentence is part of this entry's documentation change.

### Facts, and what is not verified

Per constitution I, external facts come from `docs/research/*.md` or from the installed package's own types — never from memory.

- **`docs/research/llm-and-storage.md` covers image *input* only.** It has nothing on image generation: no endpoint, no parameter list, no error taxonomy, no pricing. The facts below therefore come from the installed SDK's own type declarations (`node_modules/openai`, version **7.27.0**), which the constitution accepts as a source.
- **The generation call.** `client.images.generate(body, options)` returns an `ImagesResponse`. Non-streaming body fields include `prompt`, `model`, `n` (1–10), `size`, `output_format` (`png` | `jpeg` | `webp`), `quality`, `background`, `moderation` (`low` | `auto`), `output_compression`, `response_format`, `stream`, `style` and `user`.
- **The response.** `ImagesResponse { created, data?: Array<{ b64_json?, url?, revised_prompt? }>, background?, output_format?, quality?, size?, usage? }`. The SDK's own doc comments state that `b64_json` is "returned by default for the GPT image models", that `url` is "unsupported for the GPT image models", and that `output_format` and `response_format` are each supported only for one model family.
- **Sizes.** "The standard sizes `1024x1024`, `1536x1024`, and `1024x1536` are supported by the GPT image models." Arbitrary `WIDTHxHEIGHT` strings are supported by some newer models, with width and height "both divisible by 16", an aspect ratio "between 1:3 and 3:1", and a maximum of `3840x2160`; `dall-e-2` and `dall-e-3` take their own disjoint lists.
- **Prompt length.** "The maximum length is 32000 characters for the GPT image models, 1000 characters for `dall-e-2` and 4000 characters for `dall-e-3`."
- **Token usage.** `ImagesResponse.usage` is documented as "for `gpt-image-1` only" and carries `input_tokens`, `output_tokens`, `total_tokens` and per-kind breakdowns. So an image call *may* report token counts and may not — which is exactly the case the usage ledger already handles by storing null rather than zero.
- **Error classes are the same ones the text path already maps.** `openai/core/error.d.ts` declares `APIError`, `APIUserAbortError`, `APIConnectionError`, `APIConnectionTimeoutError`, `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429) and `InternalServerError`. `kindOfError` in `openai.ts` already maps all of them.
- **NEEDS RESEARCH — the exact error identity of a content-policy refusal on the images endpoint.** The SDK's types do not name one. (The responses-API types list `image_content_policy_violation` among *input*-image error codes, which is a different thing: an input image Docket rejected, not a generated image the provider declined to make.) The design therefore maps an unrecognised 400 to `bad_request` and keeps the recognised-refusal markers in a named, extensible set beside `OPENAI_CREDIT_CODES`, so adding an observed value is one line — the same shape, and the same reasoning, that the credit-refusal sets already use after research A5 turned out to be wrong.
- **NEEDS RESEARCH — latency and price of an image call.** Not measured, not published in `docs/research/`. Nothing in this entry depends on a number: the call runs in-request under the existing install-wide timeout, and the usage ledger reports what was actually spent rather than predicting it.
- **The roadmap's claim about voice profiles is not true of this repository.** It says "the project's own voice profiles already forbid using a real child's likeness". Nothing in `src/` or `docs/` contains such a rule — a search for "likeness", "real child" and "identifiable" finds nothing relevant. That rule lives in an individual project's voice-profile *content*, which is operator-entered data, not code. This entry therefore adds the rule in code for the first time (G14), rather than relying on data that a different install would not have.
- No new runtime dependency and no new infrastructure (constitution VI): `openai`, `sharp` and the S3 client are already in `package.json`.
- Nothing in this entry makes a live provider call in a test (constitution II). Provider mapping is asserted with mocked HTTP; everything reported as working is reported as "verified with mocks only" unless a human runs it.
## Decisions made while specifying

Judgement calls, for planning to record in `docs/decisions.md` as **G1–G26**.

### Configuration and the shape of a provider

- **G1 — The image provider is configured separately from the text provider: `LLM_IMAGE_PROVIDER` and `LLM_IMAGE_MODEL`.** Reusing `LLM_PROVIDER` would mean an install that writes its posts with Anthropic cannot generate an image at all, because Anthropic ships no image-generation API. It would also tie the two choices together exactly where the roadmap wants them independent: "text rendering inside generated images is the weak point for sports graphics and the best provider for that will change". Two variables, parsed by the same helpers in `config.ts`, with the same "a wholly absent group is not an issue, a partially-set group is" rule `llmEnvIssues` already applies.
- **G2 — `LLM_IMAGE_MODEL` is required when `LLM_IMAGE_PROVIDER` is set, has no default, and no model id ever appears in source.** This is `LLM_MODEL`'s existing rule ("There is no default on purpose") and it is what `no-model-literal.test.ts` enforces across all of `src/`. An operator picking the image model is also the only honest answer while image models change monthly and differ in what they charge per image.
- **G3 — The image call spends the provider's existing key variable (`OPENAI_API_KEY`), read only in `src/server/llm/config.ts`.** No `LLM_IMAGE_API_KEY`: a second key for the same vendor account would be a second thing to rotate and a second place for `key-reads.test.ts` to have to allow. The key-read guard test keeps its single-file assertion unchanged.
- **G4 — Image generation keeps its own interface (`ImageGenerator`) rather than widening `LlmProvider`.** The two share nothing but the failure vocabulary: no schema, no system prompt, no images-in, no token budget, no structured output. Widening `LlmProvider` would put `prompt`/`aspect` fields on every text call and an unused `schema` on every image call, and would drag `zodTextFormat` into a code path that has no JSON to parse. The contract in `image-generation.ts` is kept as declared — `projectId`, `prompt`, optional `aspect`, optional `size`; `{ ok: true; mediaAssetId }` or `{ ok: false; message }` — because the roadmap's instruction is to implement it, not to redesign it.
- **G5 — The adapter owns the entire provider vocabulary; nothing above it knows a pixel size, an output format or an error code.** The abstract layer hands the adapter a prompt, an `aspect` and an optional `size`, and gets back bytes plus a `LlmFailureKind`. Inside the OpenAI adapter, and only there: `square` → `1024x1024`, `landscape` → `1536x1024`, `portrait` → `1024x1536` (the three sizes the installed SDK documents as supported by the GPT image models); an explicit `size` is formatted as `WIDTHxHEIGHT` and passed through, because whether a given model accepts arbitrary resolutions is a fact about that model, which source is forbidden to know (G2) — so the provider's own refusal is the right arbiter, reported as `bad_request`. This is what makes the provider swappable in the sense the roadmap means: a second adapter is a new file plus one value in `LLM_IMAGE_PROVIDER`, with no change to the media library, the hold behaviour, the UI or the contract.
- **G6 — The OpenAI adapter targets the GPT image model family: it asks for an explicit `output_format` and reads `b64_json`.** The installed SDK's own doc comments say `b64_json` is returned by default for the GPT image models, that `url` is "unsupported for the GPT image models", and that `output_format` is "only supported for the GPT image models". A `dall-e-*` model configured into `LLM_IMAGE_MODEL` would therefore be refused by the provider and surface as `bad_request` with the fixed sentence. That is the right trade: supporting both response shapes in one adapter means branching on the model id, which G2 forbids; a DALL·E adapter, if anyone ever wants one, is a separate file selected by a separate `LLM_IMAGE_PROVIDER` value.
- **G7 — PNG, one image, provider-default moderation, no streaming.** PNG because rendered text — the entry's stated weak point — is exactly what lossy compression damages, and because the library re-encodes and strips metadata anyway (`processUpload`) and derives per-platform JPEG copies on demand (`ensureVariant`), so nothing downstream is forced to carry the PNG. `n = 1` because the contract returns one `mediaAssetId` and because a person choosing between four images is a different, bigger feature. Moderation is left at the provider's default rather than set to `low`: Docket has no reason to ask a vendor to filter *less*. No streaming: there is no partial-image UI, and a streamed response would need a second code path for the same bytes.
- **G8 — The prompt is 1 to 1000 characters after trimming.** 1000 is the lowest ceiling the installed SDK documents across the model families it supports, so the cap holds whatever an operator configures and the limit can be stated in the UI as a fact rather than a guess. It is also a generous paragraph: this is a description of a graphic, not an article. Over-length is a field error before any call is made — refusing locally costs nothing and spends nothing.

### Credential, credit hold and usage

- **G9 — An image call spends the project's own credential when the project's stored provider *is* the configured image provider, and the install's otherwise.** The install-wide path cannot be the only one: `config.ts`'s own comment records that an install may have "no provider configured at all while its projects generate on their own keys", and for exactly that install an install-only rule would mean no image generation despite a perfectly good key being on file. Conversely, a project whose stored provider is a *different* vendor has expressed no preference about images, so it uses the install's image credential — which is not the silent fallback 065 forbids: that rule protects a project that chose to spend its own key for a capability from having the install pay for *that same capability*, and the project has chosen nothing here. The credit-hold `owner` is whichever owner the text path would compute for the credential actually used, so one refusal pauses both paths for that account — which is the truth about an account with no credit. An undecryptable project key refuses with the existing fixed sentence and never falls back, exactly as text does.
- **G10 — The billing-refusal rule lives in one function, shared with `withCreditHold`, not copied.** The decision "`credit_exhausted` holds, everything else clears, a hold-write failure is swallowed" is extracted so both the text wrapper and the image path call the same code. A copy would be two places for the probe interval, the swallow rule and the `heldSince` semantics to drift, and the roadmap's requirement is precisely that an image refusal "takes the same hold path as a text refusal".
- **G11 — The image path does not check for an existing hold before calling.** Every in-request path on `main` behaves this way: single, series, regenerate, "Try it" and `pnpm llm:check` all call and let a refusal re-hold, and only the batch-job claim consults `gateCreditHolds`. Pre-refusing would make a person wait out a five-minute probe window for a credential that may already have been topped up, and would answer a question the provider answers authoritatively in one round trip.
- **G12 — Image calls are recorded in the usage ledger, under a new purpose `image.generate`.** `docs/generator.md` already promises that "calls and tokens are recorded for every call that reaches a provider, whatever its outcome", and an image call is both the most expensive call in the product and the easiest to repeat. Leaving it out would make the Usage screen quietly wrong in the one place it matters most. The cost is bounded and visible: one value added to the `llm_usage_purpose` enum (a migration), one label in `USAGE_PURPOSE_LABELS`, and the "exactly the seven call sites" guard test widened to eight — which that test exists to force someone to do deliberately. Token counts are written when the provider reports them and null when it does not (the SDK documents `usage` as present for one model only), never coerced to zero, which is the ledger's existing rule. No `LLM_RATES` change: an image model with no configured rate simply shows calls and tokens without a money figure, which the screen already handles.
- **G13 — The failure *kinds* are reused verbatim; only the sentences differ.** The image path returns the same `LlmFailureKind` values, so the credit-hold rule, the ledger's `failure_kind` column and the mapping tests are shared and cannot disagree. A parallel fixed-sentence map supplies the image wording, because the text sentences are wrong here ("The model declined to write this post." is not what happened). A test asserts both maps cover every kind, so adding a tenth kind cannot leave the image path with an undefined message.

### What goes into the prompt

- **G14 — No images of real people, enforced by a fixed instruction, not by guesswork.** Likeness and publicity rights make a generated athlete portrait a legal problem rather than a quality problem, and the brands this product serves include youth sport, where depicting an identifiable child is worse than a lawsuit. So: a fixed, documented sentence forbidding any real, identifiable person is appended to every image prompt by the adapter layer, the prompt field says so in the UI, and `docs/generator.md` states it. What is deliberately *not* attempted is any name detection or heuristic refusal — a filter that rejects "a lion mascot called Jordan" while passing "the famous number 23 from Chicago" would be both annoying and useless, and a refusal Docket cannot explain is worse than an instruction the provider is good at following. The roadmap's claim that voice profiles already carry this rule does not hold for this repository (see "Facts"), which is why it is added in code here.
- **G15 — The prompt is the person's words plus the guardrail, and nothing else.** No brand context from entry 1, no voice profile, no post text, no platform rules. An image prompt is not a post prompt: the brand's tagline is a sentence to *say*, not a thing to *draw*, and silently injecting it would make every generated graphic subtly about the company name. When `evergreen-series` wants an image that matches a post, it will compose that prompt itself and pass it through this same contract.

### The asset, and its provenance

- **G16 — The generated bytes go through the existing upload path, not a new writer.** `prepareUpload` → `commitUpload` already does everything the roadmap asks for: content-sniffed type check, animated refusal, byte and megapixel limits, metadata stripping, re-encode, 480 px WebP thumbnail, both objects under `projects/<projectId>/media/<assetId>/`, row written in the caller's transaction, objects discarded if the row write fails. A generated image that exceeds `MEDIA_MAX_UPLOAD_MB` or `MEDIA_MAX_MEGAPIXELS` is refused with the library's own existing sentence — the roadmap's "every existing constraint applies unchanged" is only true if the same code enforces them.
- **G17 — Provenance is four named, nullable columns on `media_assets`, all-or-nothing.** `generated_at`, `generation_prompt`, `generation_provider`, `generation_model`, with a CHECK that they are either all null or all set, so "was this generated?" has exactly one answer and no row can claim a prompt without a provider. Not a `jsonb` blob: a blob is an open invitation to put a key, a request id or a whole provider payload in it, and the constitution's secrets rule is much easier to keep when the only places a value can go are four named text columns. Not a side table: there is at most one row per asset and no history — an asset is generated once — so a table buys a join and a second authorization surface for nothing. Reverse by moving the four columns into a project-owned table if provenance ever needs versions.
- **G18 — `original_filename` gets a fixed, human-readable name, not the prompt and not null.** The library, the composer's picker, the alt-text warning and the selection checkbox all label an asset by its filename and fall back to the bare word "image"; a generated asset with no name would read as an unlabelled tile in every one of them. The prompt is not a filename (it can be 1000 characters and is shown in full elsewhere), so the name is a short fixed form that reads as what it is.
- **G19 — Alt text starts empty and is never derived from the prompt.** A prompt is an instruction to a model — "flat vector, dramatic lighting, no text, 3:2" — and pasting it into `alt_text` would produce exactly the kind of alt text that makes a screen reader worse while satisfying the "missing alt text" check. Empty is honest: the existing "Missing alt text" filter and the composer's warning then do their job and ask a person to describe the picture.
- **G20 — No automatic tag.** Tags are the person's own filing system, capped at 20 per asset and surfaced as filter tabs; writing one on every generated image would push an operator's own tags off the tab strip and mean a tag that cannot be removed without losing provenance. Provenance has its own columns (G17) and its own marker on the card (FR-027).
- **G21 — A generated asset is otherwise completely ordinary.** It is listed, searched, filtered, selected, edited, attached, reserved by a job, variant-derived, fit-checked and deleted by exactly the code that handles an uploaded one, and deleting it takes its provenance with it by row cascade. There is no "generated" library view, no separate lifecycle and no restriction on where it may be attached.

### Authorization, interaction and the storage requirement

- **G22 — A new owner/admin statement, `media: ["generate"]`.** The roadmap asks for an "owner/admin-visible" action, and neither existing candidate is owner/admin: editors hold `media: ["edit"]` (they upload) and `generation: ["run"]` (they generate posts). Reusing either would hand editors the ability to spend the project's image budget, which is the thing the roadmap's wording is guarding. `llm_credential: ["manage"]` is owner/admin but means "may change the stored key", which is a different question. A new statement value is code-only — roles live in `src/server/auth/access.ts`, not in a table — so this costs no migration.
- **G23 — Absent, not disabled, for anyone who may not use it.** 065 set this precedent for the Model page ("An editor does not see this sub-nav item at all, and the URL 404s for them (absent, not disabled)"), and the same reasoning applies: showing a dead control teaches a person to ask for a permission they cannot be given. The server refuses regardless of what the UI showed.
- **G24 — In-request, single attempt, no job and no automatic retry.** The roadmap is explicit that this entry does not touch jobs. The call runs under the install-wide `LLM_TIMEOUT_SECONDS` like every other in-request generation, and a failure returns its sentence with the typed prompt still in the field, so the person decides whether to spend again. An automatic retry on a paid, non-idempotent call is how an install discovers it has bought the same graphic three times.
- **G25 — No cooldown, no quota and no per-project lease.** The button is disabled while a request is in flight, which is enough to stop a double-click; two deliberate requests make two images, because that is what a creative tool should do and because every attempt is visible in the Usage figures (G12). The project's own check cooldown exists to stop an *unauthenticated-ish* loop of live calls from a page anyone with the link could hammer; this action is owner/admin-only and produces an asset each time, so the honest control is visibility, not a gate.
- **G26 — The storage-not-configured sentence comes from one shared constant.** `images.ts` holds `"Media storage is not set up."` privately today; it is exported from one place and used by both, so the roadmap's "fail with the same message" stays true as either path changes. The UI already hides everything when storage is off — `mediaStatus().enabled` replaces the whole library with an empty state — so "hide the UI" needs no new condition, only that the new action sits inside that branch and that the server refuses with the same sentence when called anyway.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An owner generates an image into the library (Priority: P1)

An owner on the project's Media page chooses "Generate an image", types a description of the graphic they want, picks square, portrait or landscape, and submits. The page tells them it is working, then the finished image appears in the library alongside everything they have uploaded, and the outcome is announced to a screen reader.

**Why this priority**: This is the entry's whole user-visible value, and nothing else in it has a subject without it. On its own it turns "find or commission a graphic, download it, upload it" into one action inside the product.

**Independent Test**: Sign in as an owner on an install with storage and an image provider configured, generate an image with a mocked provider returning known bytes, and see the asset in the library on the same page, with a thumbnail, with the right dimensions for the chosen aspect, and with the outcome announced.

**Acceptance Scenarios**:

1. **Given** storage and an image provider are configured, **When** an owner submits a prompt with the landscape aspect, **Then** one image asset is created for that project, its stored bytes and thumbnail are in that project's own storage prefix, its dimensions match the landscape aspect, and it is visible in the library without a manual reload.
2. **Given** a generation is in flight, **When** the owner waits, **Then** the control reports that it is working, the submit control cannot be submitted again, and the keyboard focus is never moved out from under them.
3. **Given** a generation succeeds, **When** it finishes, **Then** the outcome is announced through a live region, and the new asset is the one the announcement refers to.
4. **Given** an empty or whitespace-only prompt, or one longer than 1000 characters, **When** the owner submits, **Then** the field reports the problem, no provider call is made, and no asset is created.
5. **Given** the provider answers with an error of any kind, **When** it does, **Then** the library is unchanged, no asset and no storage object is left behind, the person sees one fixed sentence for that kind of failure, and the prompt they typed is still in the field.
6. **Given** the provider's bytes exceed the install's upload size or megapixel limit, **When** they arrive, **Then** the request is refused with the library's own existing limit sentence and nothing is written.

---

### User Story 2 - A generated image is an ordinary asset (Priority: P1)

Someone who did not generate the image uses it exactly as they would a photo they uploaded: they see which platforms it fits, attach it to a post, let the per-platform copy be derived for them, search for it, see it in "Unused", and delete it.

**Why this priority**: The roadmap's actual requirement is not "call an image API" but "a generated image must land in the media library as a normal asset", and a generated image that needs special handling anywhere downstream would be a liability rather than a feature. It is independently testable from the generation UI by creating an asset through the service and exercising the existing media paths against it.

**Independent Test**: Generate an asset with a mocked provider, then assert against it: the platform fit information for every registered provider, a derived variant for a provider whose constraints need one, attachment to a post, the "Unused" filter, search by filename, and deletion.

**Acceptance Scenarios**:

1. **Given** a generated image, **When** the library shows it, **Then** it carries the same per-platform fit information an uploaded image of those dimensions would, including a platform's existing refusal reason when the chosen aspect falls outside what that platform accepts.
2. **Given** a generated image attached to a post for a platform whose constraints need a different format or size, **When** the post is prepared, **Then** a variant is derived and cached by the existing variant code, with no generated-image special case.
3. **Given** a generated image, **When** it is unused, **Then** it appears in the "Unused" filter and is eligible for the existing "generate posts for unused images" flow exactly like an uploaded one.
4. **Given** a generated image, **When** an editor edits its alt text or tags, deletes it, or attaches it, **Then** all of those work exactly as for an uploaded asset, and deleting it removes its provenance with the row.
5. **Given** a generated image, **When** anything reads it, **Then** its `kind` is `image`, it is `ready` with no processing state of its own, and it is never treated as a video.

---

### User Story 3 - A billing refusal pauses, it does not fail loudly (Priority: P2)

The provider account runs out of credit. The owner who asks for an image is told plainly that the account has no credit left, the credential is marked as paused in the same place a text refusal would have marked it, and when credit is added the next request simply works — nobody restarts anything or clears any state by hand.

**Why this priority**: The roadmap calls this out specifically ("not fail loudly per request"), and it is the behaviour that decides whether a drained account is a five-minute annoyance or a day of confusing failures. It rides on machinery that already exists, so it is a smaller slice than the two above.

**Independent Test**: With a mocked provider raising the provider's own quota error, assert the hold row for the resolved credential owner, the fixed sentence returned to the caller, and that a subsequent success clears the hold.

**Acceptance Scenarios**:

1. **Given** an image request whose provider refuses for billing reasons, **When** it is refused, **Then** a hold is recorded for the credential owner that the text path would use for that same project, and the caller gets the fixed credit-exhausted sentence.
2. **Given** a credential already held from an earlier text refusal, **When** an image request is made, **Then** it is attempted rather than pre-refused, and a second refusal refreshes the hold without moving the time it has been held since.
3. **Given** a credential on hold, **When** an image request succeeds, **Then** the hold is cleared.
4. **Given** the hold cannot be written because the database refuses, **When** the request otherwise succeeded, **Then** the request still succeeds and the asset still exists.
5. **Given** a project with its own provider credential matching the configured image provider, **When** it generates, **Then** the call spends that project's credential and any hold is recorded against that project's owner, not the install's.
6. **Given** a project whose own stored key can no longer be decrypted, **When** it generates, **Then** the request is refused with the existing fixed sentence and no call is made with the install's credential.

---

### User Story 4 - Nothing is offered that cannot work (Priority: P2)

An install without media storage, an install with no image provider configured, and an editor on a fully configured install all see a product that is honest about what it can do: no dead control, and a single fixed sentence if the action is called anyway.

**Why this priority**: The roadmap makes the storage requirement explicit, and a paid action that appears to be available but cannot work is worse than one that is absent. Independently testable without generating anything.

**Independent Test**: Load the Media page in each of the three states and assert what is rendered; separately call the action in each state and assert the refusal and that nothing was written.

**Acceptance Scenarios**:

1. **Given** media storage is not configured, **When** anyone opens the Media page, **Then** the generate action is not offered, and the existing storage empty state is what they see.
2. **Given** media storage is not configured, **When** the action is called anyway, **Then** it is refused with exactly "Media storage is not set up.", no provider call is made and nothing is written.
3. **Given** storage is configured but no image provider is, **When** an owner opens the Media page, **Then** the generate action is not offered; **and when** it is called anyway, **Then** it is refused with a sentence naming only the settings that are missing, never a value.
4. **Given** a signed-in editor on a fully configured install, **When** they open the Media page, **Then** no generate action appears anywhere on it.
5. **Given** a signed-in editor, **When** the generate action is called for their project anyway, **Then** it is refused server-side, no provider call is made and no asset is created.
6. **Given** an owner of one project, **When** the action is called naming a different project, **Then** it is refused and no asset is created in either project.

---

### User Story 5 - Anyone can see what was generated, and what it cost (Priority: P3)

Looking at the library later, a member can tell which images were generated and from what wording; an owner looking at the project's Usage sees the image calls among its other model calls.

**Why this priority**: Provenance is what makes a generated image reviewable — "why does this graphic say that?" has an answer — and the roadmap requires it on the asset. It is the smallest slice because the capability works without anybody reading it.

**Independent Test**: Generate an asset, then read it back: the card marks it as generated, the stored prompt, provider and model are exactly what was used, and the project's usage figures include one image call.

**Acceptance Scenarios**:

1. **Given** a generated image, **When** a member views the library, **Then** the asset is marked as generated and the prompt that produced it is readable.
2. **Given** a generated image, **When** its row is read, **Then** it holds the prompt exactly as the person typed it (trimmed), the provider name and the model id as used at the time, and the time it was generated — and nothing resembling a credential.
3. **Given** an uploaded image, **When** its row is read, **Then** all four provenance columns are null and nothing marks it as generated.
4. **Given** any image call that reached the provider, **When** the project's usage is read, **Then** that call is counted with its provider, model, outcome and credential source, with token counts when the provider reported them and no counts at all when it did not.
5. **Given** an image call that never reached the provider (no storage, no provider configured, refused prompt, no permission), **When** usage is read, **Then** no call is recorded for it.
6. **Given** a generated image in project A, **When** anyone in project B reads the library, searches, or reads provenance, **Then** project A's asset and prompt are not visible by any path.

### Edge Cases

- **The provider returns success with no image.** An empty `data` array, or an item with no bytes, is a failed call with the "could not be read" sentence — not an empty asset.
- **The provider returns bytes that are not an image**, or are an animated image. The library's existing content-sniffing refuses them with its own sentence, and nothing is written.
- **The returned image is enormous.** Refused by the install's existing upload byte and megapixel limits (G16), with the library's own message.
- **Two requests at once for the same project.** Both run and both produce an asset; neither interferes with the other's storage keys (each asset gets its own id) or its provenance.
- **The request is abandoned** — the person navigates away or the connection drops — after the provider has been paid. The work already in flight is not cancelled by their leaving: the asset may still be created, and the call is still recorded in usage because it was still spent. What must not happen is a half-made asset: either both stored objects and the row exist, or neither does.
- **The provider call times out.** The install-wide timeout applies, the person gets the timeout sentence, and the hold is cleared rather than set (a timeout is not a billing refusal).
- **A project's own credential is for a vendor with no image generation.** The install's image credential is used (G9), and the project's Usage shows that call as the install's spend.
- **An operator sets `LLM_IMAGE_PROVIDER` but not `LLM_IMAGE_MODEL`**, or vice versa. Startup reports the missing name and reason, never a value, and image generation stays off while everything else keeps working.
- **An operator configures a model the provider will not accept**, or a size it will not make. The provider's refusal becomes the `bad_request` sentence; nothing is written; the attempt is recorded in usage.
- **An aspect whose result no platform accepts.** The asset is still created — it is a library asset, not a post — and the existing fit information says which platforms would refuse it, before anyone attaches it.
- **A prompt that the provider declines on content grounds.** The person gets the image-specific refusal sentence; nothing is written; no part of the provider's own explanation is shown.
- **A prompt that asks for a real person.** The fixed guardrail tells the provider not to, the UI says not to, and whatever the provider then does is its answer — Docket does not attempt to detect the attempt (G14).
- **Media storage goes away between the page render and the submit.** The action refuses with the shared storage sentence; nothing is written.
- **A generated asset is deleted while a post holds it.** Exactly the existing media deletion rules apply, including the per-target protections for live posts — provenance adds no new deletion case.
## Requirements *(mandatory)*

### Functional Requirements

#### Configuration and resolution

- **FR-001**: Image generation MUST be off until an operator configures it, and its absence MUST NOT affect anything else: an install with no image provider keeps every existing capability, and startup reports the state without failing.
- **FR-002**: The image provider and image model MUST be configured independently of the text provider and text model, with the model required whenever the provider is set and no default model anywhere (G1, G2).
- **FR-003**: No model identifier MUST appear anywhere in the source, outside comments — the existing guard over all of `src/` MUST stay green (G2).
- **FR-004**: The provider's API key MUST continue to be readable in exactly one file, and no new credential variable MUST be introduced for the same vendor account (G3). The existing single-file key-read guard MUST stay green.
- **FR-005**: Configuration problems MUST be reported as a setting name and a reason, never a value; a wholly unconfigured image group MUST NOT be reported as a problem, and a partially configured one MUST be (G1).
- **FR-006**: An image request for a project MUST spend that project's own stored credential when the project's stored provider is the configured image provider, and the install's credential otherwise; a project whose stored key cannot be decrypted MUST be refused with the existing fixed sentence and MUST NOT be served from the install's credential (G9).
- **FR-007**: The install-wide call timeout MUST apply to an image call; the text-only output-token limit MUST NOT be sent to an image provider (G24).

#### Generating

- **FR-008**: The declared image-generation contract MUST be implemented as declared — a request naming a project, a prompt and an optional aspect or explicit size; a result that is either a created media asset's identifier or a message (G4).
- **FR-009**: The implementation MUST NOT throw for a provider, network, timeout or refusal condition; every such outcome MUST be returned as a failure result carrying one fixed sentence (G13).
- **FR-010**: Everything vendor-specific — the aspect-to-size mapping, the requested output format, how bytes are read out of a response, and how an error is classified — MUST live inside one swappable provider adapter, selected by configuration. Adding a second provider MUST require no change to the media library, the credit-hold behaviour, the usage ledger, the user interface or the contract (G5, G10).
- **FR-011**: An unrecognised provider refusal MUST classify as a generic rejected-request failure, and the markers for recognised refusal kinds MUST live in named, extensible sets so that adding an observed value is a one-line change (G5; NEEDS RESEARCH on the content-policy marker).
- **FR-012**: A prompt MUST be 1 to 1000 characters after trimming; outside that range it MUST be refused before any provider call is made (G8).
- **FR-013**: Exactly one image MUST be produced per request (G7).
- **FR-014**: A fixed, documented instruction forbidding any real, identifiable person MUST be added to every image prompt sent to a provider. Docket MUST NOT attempt to detect or refuse such prompts itself (G14).
- **FR-015**: Nothing beyond the person's prompt and that fixed instruction MUST be sent as the image prompt — no brand fields, no voice profile, no post text, no platform rules (G15).
- **FR-016**: Image failures MUST reuse the existing failure vocabulary so that the hold rule and the usage ledger are shared, and MUST have their own fixed sentence per failure kind; every kind MUST have a sentence (G13).
- **FR-017**: A billing refusal from the image provider MUST set or refresh the credit hold for the credential owner actually used, through the same code as a text refusal; any other outcome MUST clear it; a failure to write the hold MUST NOT turn a successful generation into a failure (G10).
- **FR-018**: An image request MUST NOT be pre-refused because the credential is already held; it MUST be attempted like every other in-request generation path (G11).
- **FR-019**: Every image call that reached the provider MUST be recorded in the project's usage ledger under its own purpose, with provider, model, outcome and credential source, and with token counts only when the provider reported them — never coerced to zero. A call that never reached the provider MUST NOT be recorded (G12).
- **FR-020**: No credential, no provider SDK error text and no raw provider payload MUST reach a stored row, a log line, an error message or a rendered screen (constitution VII).

#### The asset

- **FR-021**: A generated image MUST be written through the existing media service into the project's media assets with kind `image`, and its bytes and thumbnail MUST be stored through the existing storage interface under that project's own key prefix (G16).
- **FR-022**: The generated bytes MUST be subject to every existing library rule — type judged by content, animated images refused, byte and megapixel limits, metadata stripped, re-encoded, thumbnail derived — and a refusal MUST be reported with the library's existing sentence for that rule (G16).
- **FR-023**: If the asset row cannot be written, the stored objects MUST be removed; no orphaned object and no partial asset MUST remain (G16).
- **FR-024**: Per-platform variants, fit checks and every per-platform constraint MUST apply to a generated asset through the existing code, with no generated-image special case anywhere in them (G21).
- **FR-025**: Provenance MUST be recorded on the asset itself through a committed migration: that it was generated, when, the prompt as the person typed it (trimmed), the provider and the model as used at the time. The columns MUST be all-set-or-all-null, and MUST NOT be capable of holding a credential (G17). `pnpm db:check` MUST be green with the committed SQL.
- **FR-026**: A generated asset MUST have a human-readable name for every screen that labels an asset by name, and MUST start with empty alt text that is never derived from the prompt (G18, G19).
- **FR-027**: No tag MUST be written automatically, and no new library view or filter MUST be added for generated assets (G20).
- **FR-028**: A generated asset MUST be listable, searchable, filterable, selectable, editable, attachable, reservable by a job and deletable by exactly the existing paths, and deleting it MUST remove its provenance with it (G21).

#### Requires media storage

- **FR-029**: When media storage is not configured, an image-generation request MUST be refused with exactly the sentence "Media storage is not set up.", shared from one place with the existing use of it, before any provider call is made (G26).
- **FR-030**: When media storage is not configured, the generate action MUST NOT be offered anywhere in the interface (G26).

#### Interface

- **FR-031**: An owner or admin MUST be able to start an image generation from the project's Media page by giving a prompt and choosing an aspect; a member without that permission MUST NOT see the action at all, and the server MUST refuse the request regardless of what any interface showed (G22, G23).
- **FR-032**: Every control MUST be labelled, reachable and operable by keyboard with visible focus, and MUST follow the project's design system and UI conventions (constitution: accessibility).
- **FR-033**: While a generation is in flight the interface MUST say so and MUST prevent a second submission of the same request; the outcome — success or the failure sentence — MUST be announced through a live region (G24, G25).
- **FR-034**: On success the new asset MUST appear in the library without the person reloading the page; on failure the library MUST be unchanged and the typed prompt MUST still be there to retry or edit (G24).
- **FR-035**: Whether an asset was generated, and the wording that produced it, MUST be visible to a member who can view the library (FR-025, G17).
- **FR-036**: The prompt field MUST state the real-people rule and the prompt length limit (G8, G14).

#### Isolation and docs

- **FR-037**: Every read and write in this feature MUST go through the scoped data-access layer; a generated asset, its storage objects and its provenance MUST be invisible and unreachable from any other project by any path (constitution III).
- **FR-038**: `docs/storage.md` and `docs/generator.md` MUST be updated for what this adds — the new settings, the storage requirement, the real-people rule, how a billing refusal behaves for images, and the removal of image generation from the "out of scope" list. `.env.example` MUST document the new settings, and every judgement call above MUST be appended to `docs/decisions.md`.

### Key Entities

- **Image generation request**: a project, a prompt, and either an aspect (square, portrait or landscape; square when unstated) or an explicit size. Not stored — it exists for the duration of one call. Its prompt survives as the asset's provenance.
- **Image provider adapter**: the one place a vendor's size vocabulary, output format, response shape and error identities live. Selected by configuration; interchangeable; holds no model identifier of its own.
- **Media asset (extended)**: the existing project-owned asset, now able to say that it was generated, when, from what prompt, by which provider and model. Everything else about it — kind, dimensions, bytes, thumbnail, alt text, tags, usage, variants, fit — is unchanged.
- **Credit hold (reused)**: the existing per-credential pause. An image billing refusal writes the same row, for the same owner, as a text one; one hold covers both.
- **Usage record (extended)**: the existing per-call ledger row, now able to describe an image call as its own purpose.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can go from the Media page to a usable image in the library in a single action, with no file to download, convert or upload, and with no step that leaves the product.
- **SC-002**: 100% of generated images carry the same per-platform fit information, derived copies and publishing constraints as an uploaded image of the same dimensions and format — no screen, derived copy or publishing decision differs because an image was generated rather than uploaded.
- **SC-003**: When the provider account has no credit, no image request fails in a way that needs a human to clear state: the credential is marked paused, every request answers immediately with the same honest sentence, and the first request after credit is added succeeds with nothing else done.
- **SC-004**: For any asset in the library, a member can determine whether it was generated and, if so, the exact wording that produced it and which provider and model made it.
- **SC-005**: No credential, provider error text or raw provider payload appears in any stored row, log line, error message or rendered screen, asserted by the same kind of secret-scan test the generation paths already have.
- **SC-006**: An install with no media storage never offers the action and always answers with the same single sentence; an install with no image provider configured never offers it and names only the settings it is missing.
- **SC-007**: Replacing the image provider changes only the provider-specific adapter and the two configuration values, with zero changes to the media library, the user interface, the credit-hold behaviour, the usage ledger or the declared contract.
- **SC-008**: An editor cannot cause an image to be generated by any route, including a hand-built request; and no request can create an asset in a project other than the one named by the caller's own scope.
- **SC-009**: Every image call that reached a provider appears in the project's usage figures with its outcome, and no call that never reached a provider appears there.
- **SC-010**: Every image prompt sent to a provider carries the real-people instruction, asserted directly rather than inferred.

## Assumptions

- The install has media storage configured for anything in this entry to be usable at all; that is a stated requirement, not a gap.
- Image generation is expected to take seconds to tens of seconds, and runs inside the request like the existing single-post generation and voice "Try it". No measurement exists yet (NEEDS RESEARCH), and nothing in the design depends on one; if real latency turns out to exceed what a request can hold, moving it to a job is a later entry's work, not a change to this contract.
- The operator chooses the image model and knows what it charges. Docket reports what was spent (FR-019) and does not cap it.
- An operator who configures an image model outside the family the first adapter targets gets a provider rejection rather than a Docket-side validation error; this is accepted (G6) because source may not branch on a model identifier.
- "Square", "portrait" and "landscape" mean the three standard sizes the configured provider documents for its image models; the names are Docket's, the pixels are the adapter's (G5).
- Only an owner or admin generates images. Editors keep uploading and attaching, unchanged.
- The existing media library limits (default 20 MB, 50 megapixels) are generous relative to a single generated graphic; an install that has lowered them will see generated images refused by the same rule as uploads, which is the intended behaviour.
- A generated asset is immutable as a file: there is no regenerate-in-place, no edit-this-image and no variation-of-this-image in this entry.

## Dependencies

- **065-per-project-llm** (`project_llm_settings`, `resolveLlmForProject`, credential owners) — the credential resolution and the hold owner this entry reuses.
- **043/045-llm-credit-hold** (`llm_credit_holds`, `withCreditHold`) — the hold path a billing refusal must take.
- **068-llm-cost-visibility** (`llm_usage`, `UsagePurpose`, the Usage screen) — the ledger an image call is recorded in.
- The media library and storage entries — the upload processing path, the storage interface, variants, fit checks and the Media page this entry writes into and hangs an action off.
- The `openai` package already in `package.json` (version 7.27.0 at the time of writing), `sharp`, and an S3-compatible bucket. No new dependency and no new infrastructure.

## What this entry does not do

- **It does not wire image generation into the post generator.** A post that needs an image still gets one from the library, chosen by a person. The generator's prompt composition is untouched.
- **It does not wire image generation into jobs.** No queue, no batch, no scheduler work, and nothing for the tick to claim. `evergreen-series` is the entry that makes a standing series produce its own images.
- **It does not generate images of real people.** A fixed instruction says so on every call, the interface says so, and the documentation says so; what it deliberately does not do is try to detect such a prompt (G14).
- **It does not add video generation.**
- **It does not add image editing, variations, upscaling, inpainting or regeneration in place.** One prompt, one image, one asset.
- **It does not feed the brand's tagline, description or website into image prompts.** Entry 1's brand context is text to say, not a thing to draw (G15).
- **It does not add a per-project image provider or model**, a "Generated" library filter, an automatic tag, or an image-generation surface on the public API (`setup-write-api` owns the API).
- **It does not add any cap, quota or cooldown on spend**, and it does not change `LLM_RATES`.
