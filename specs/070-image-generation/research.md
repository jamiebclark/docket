# Phase 0 — Outline & Research: Generate images into the media library

**Feature**: `070-image-generation` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

Every fact below cites the file (and, where it matters, the line) it was read from, or the
installed package's own type declarations. Nothing here comes from memory (constitution I).
Decisions are labelled **P1 – P24**; they are the *plan's* judgement calls and sit after the
spec's **G1 – G26** in `docs/decisions.md`.

---

## 1. What exists on `main`

| Fact | Read from |
|---|---|
| `ImageGenerationRequest` / `ImageGenerationResult` / `ImageGenerator` are declared, with no runtime export, and `image-generation.test.ts` asserts `Object.keys(mod)` is `[]` | `src/server/llm/image-generation.ts`, `src/server/llm/image-generation.test.ts` |
| `"Media storage is not set up."` is a **private** `NOT_SET_UP` constant about image *input* | `src/server/llm/images.ts:25` |
| `LlmProvider { name, model, generate<T>() }`; nine `LlmFailureKind` values exported as `LLM_FAILURE_KINDS` | `src/server/llm/types.ts` |
| One fixed sentence per kind; "SDK error text never reaches a user" | `src/server/llm/messages.ts` |
| `parseLlmConfig` reads `LLM_PROVIDER`, `LLM_MODEL`, `KEY_NAME[provider]`, `LLM_TIMEOUT_SECONDS` (10–600, default 90), `LLM_MAX_OUTPUT_TOKENS` (256–32000, default 4000); `parseLlmLimits` returns the limits alone; `llmEnvIssues` treats a wholly absent group as "generation is disabled, not an issue" | `src/server/llm/config.ts` |
| `LLM_RATE_VARIABLES` is deliberately **outside** `LLM_VARIABLES` so `llmEnvIssues` cannot demand `LLM_PROVIDER` for it | `src/server/llm/config.ts:84-89` |
| `resolveLlmForProject` returns `source`, `owner`, install-wide `limits`, the built provider and the key for redaction; `SecretDecryptionError` yields `{ ok: false, reason: "key_unreadable" }` with **no** fallback | `src/server/llm/resolve.ts` |
| `withCreditHold(llm, owner)` delegates, holds on `credit_exhausted`, clears otherwise, swallows hold-write failures | `src/server/services/generation/credit.ts` |
| `createUsageRecorder({ projectId, purpose, source })` buffers one row per call and flushes with an optional link, swallowing write failures | `src/server/llm/usage.ts` |
| `OPENAI_CREDIT_TYPES` / `OPENAI_CREDIT_CODES`, verified against a live 429 on 2026-10-12; `kindOfError(error, timedOut)` maps every SDK error class | `src/server/llm/openai.ts:26-57` |
| `logLlmCall({ provider, model, label, latencyMs, outcome, usage })` — one redacted line, fixed fields only | `src/server/llm/log.ts` |
| `prepareUpload` then `commitUpload` then `discardPreparedUpload`, composed by `uploadMedia`; keys from `mediaKeys(projectId, assetId)`, every key under `projects/<projectId>/` | `src/server/services/media.ts:198-273`, `src/server/storage/index.ts:33-46` |
| `processUpload` judges by content, refuses non-JPEG/PNG/WebP and animated, enforces `maxBytes` / `maxPixels`, strips metadata, re-encodes, makes a 480 px WebP thumbnail | `src/server/media/process.ts` |
| `media_assets` has no provenance column of any kind; `kind` CHECKed to `('image','video')`; `alt_text` defaults `''`; tags capped at 20 | `src/server/db/schema/media.ts` |
| `fitOf(asset, provider)` and `ensureVariant(scope, asset, constraints, i)` read `mimeType`, `width`, `height`, `byteSize` off the row and know nothing of origin | `src/server/services/media-fit.ts`, `src/server/services/media-variants.ts` |
| The Media page replaces the whole library with an `EmptyState` when `status.enabled` is false; `canEdit = media:["edit"]`, `canGenerate = generation:["run"]` | `src/app/p/[projectSlug]/media/page.tsx:55-95` |
| Owner/admin-only statements today; `media` holds only `["view","edit"]`, held by editors too | `src/server/auth/access.ts` |
| `runAction(slug, fn)` maps `ZodError` to field errors and service errors to an `ActionResult`; `refresh()` is what makes a new asset appear | `src/app/p/[projectSlug]/run-action.ts`, `src/app/p/[projectSlug]/media/actions.ts` |
| `LiveRegion` is kept mounted and its `message` changes | `src/components/ui/LiveRegion.tsx` |
| `docs/generator.md` ends with "A public API … and image generation" under **Out of scope** | `docs/generator.md:116` |

## 2. The installed OpenAI SDK (`node_modules/openai`, 7.27.0)

Read from `node_modules/openai/resources/images.d.ts` and `node_modules/openai/core/error.d.ts`.

- `client.images.generate(body, options)` returns `APIPromise<ImagesResponse>` on the
  non-streaming overload.
- `ImageGenerateParamsBase` fields used here: `prompt`, `model`, `n` (1–10), `size`, `output_format`
  (`png | jpeg | webp`, "only supported for the GPT image models"). Also available and deliberately
  unused: `background`, `moderation`, `output_compression`, `partial_images`, `quality`,
  `response_format`, `stream`, `style`, `user`.
- `ImagesResponse { created, data?: Array<Image>, background?, output_format?, quality?, size?, usage? }`;
  `Image { b64_json?, revised_prompt?, url? }`. The doc comments state `b64_json` is "Returned by
  default for the GPT image models" and `url` is "Unsupported for the GPT image models";
  `response_format` "isn't supported for the GPT image models, which always return base64-encoded
  images".
- `size`: "The standard sizes `1024x1024`, `1536x1024`, and `1024x1536` are supported by the GPT
  image models"; arbitrary `WIDTHxHEIGHT` for some models, both dimensions divisible by 16, aspect
  ratio between 1:3 and 3:1, maximum `3840x2160`.
- `prompt`: "The maximum length is 32000 characters for the GPT image models, 1000 characters for
  `dall-e-2` and 4000 characters for `dall-e-3`."
- `ImagesResponse.usage` is documented "For `gpt-image-1` only" and carries `input_tokens`,
  `output_tokens`, `total_tokens` and per-kind details.
- Error classes are the same ones `kindOfError` already maps: `APIError`, `APIUserAbortError`,
  `APIConnectionError`, `APIConnectionTimeoutError`, `BadRequestError`, `AuthenticationError`,
  `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`,
  `RateLimitError`, `InternalServerError`.

### The one fact the SDK does not carry — closed, not guessed

`grep -rno 'content_policy[a-z_]*' node_modules/openai` finds `content_policy_violation` and
`image_content_policy_violation` in **one** place only: `ResponseError.code` in
`resources/responses/responses.d.ts:2414` — the Responses API's error for an *input* image Docket
sent. Nothing in `resources/images.d.ts` names an error identity for a generated image the provider
declined to make. The spec's `NEEDS RESEARCH` is therefore **closed as "no such documented value in
the installed SDK"**, and the design is built for that answer rather than around a guess (**P6**).

The spec's second `NEEDS RESEARCH` — latency and price of an image call — stays open and nothing
depends on it: the call runs in-request under the existing install-wide timeout, and the usage
ledger reports what was actually spent rather than predicting it. `docs/research/` holds no figure
and phases cannot fetch the web, so none is asserted.

---

## 3. Decisions

### Configuration

- **P1 — A third environment group, `LLM_IMAGE_VARIABLES`, outside `LLM_VARIABLES`, with its own
  `llmImageEnvIssues`.**
  *Rationale*: `llmEnvIssues` short-circuits on "any variable of the group set without
  `LLM_PROVIDER`". Folding `LLM_IMAGE_*` into that list would tell an install that generates images
  but writes its posts on per-project credentials to configure a text provider it does not want.
  068's **P9** set exactly this precedent for `LLM_RATE_VARIABLES`. The new group's own rule is
  G1's, unchanged: wholly absent is not an issue, partially set is.
  *Alternatives*: reuse `LLM_PROVIDER` (G1 rejects it — Anthropic ships no image API); one combined
  group (couples two choices the roadmap wants independent).

- **P2 — A partially configured image group is a startup *issue*, exactly like a partially
  configured text group — not a warning.**
  *Rationale*: G1 says "the same … rule `llmEnvIssues` already applies", and FR-005 says a partially
  configured group "MUST be" reported as a problem. `validateConfiguration` has both channels
  (`issues` exits, `warnings` log and carry on — 068 P8); rates are warnings because a price is a
  guess, but a half-set provider is an operator typo of exactly the class Docket already refuses to
  start on. One rule for both provider groups beats two.
  *Tension named*: the spec's edge case says "everything else keeps working". Resolved in
  G1/FR-005's favour — see plan.md § "Two things the spec says that the code does not allow". The
  **unconfigured** case gets a `disabled` line
  (`"image generation is off (LLM_IMAGE_PROVIDER not set)"`), and that is the state that must not
  affect anything else; it does not.

- **P3 — Image credential resolution lives inside `src/server/llm/resolve.ts`.**
  *Rationale*: `key-reads.test.ts` allows the ciphertext column to be *named* in exactly three
  files — the schema, `dal/project-llm.ts` and `resolve.ts` — and FR-004 requires that guard to stay
  green **unchanged**. Any new file that decrypts a project key would have to be added to the
  allow-list, which is the guard loosening rather than holding.
  *Alternatives*: a new `resolve-image.ts` (widens the allow-list); a shared helper returning
  plaintext (moves the secret further for no gain).

- **P4 — A project's own credential supplies the *key only*; the model is always
  `LLM_IMAGE_MODEL`.**
  *Rationale*: `project_llm_settings.model` is a *text* model chosen for the Responses API. Sending
  it to an images endpoint is a guaranteed `bad_request`. The spec's "What this entry does not do"
  rules out a per-project image provider or model, so the install's image model is the only one that
  exists. G9 decides **whose credit is spent**, not which model runs.
  *Alternatives*: refuse when the project's model is not an image model (source may not know what an
  image model id looks like — G2); add a per-project image model (explicitly out of scope).

### The adapter

- **P5 — The OpenAI image client runs with `maxRetries: 0`.**
  *Rationale*: the text client's default of 2 is safe for an idempotent structured-output call. An
  image call is paid and non-idempotent, and G24 forbids automatic retry; a transient connection
  error must become one `unavailable`, not three paid images.
  *Alternatives*: the default 2 (buys the same graphic up to three times); Docket-level retry
  (G24 forbids it).

- **P6 — The adapter reuses `kindOfError` (exported from `openai.ts`) and adds
  `OPENAI_IMAGE_REFUSAL_TYPES` / `OPENAI_IMAGE_REFUSAL_CODES`, consulted first. Both ship empty.**
  *Rationale*: FR-011 wants recognised refusal markers in named, extensible sets and an unrecognised
  refusal classified as `bad_request`. § 2 shows the installed SDK names no such marker for the
  images endpoint, so shipping a *guessed* value would be exactly the mistake research A5 made for
  credit refusals. Empty-but-named sets make the widening a one-line change and make the absence
  reviewable. The classifier takes the sets as a defaulted parameter, so a test proves the wiring
  with its own value rather than Docket inventing one.
  *Alternatives*: copy `content_policy_violation` from the Responses API (a different surface —
  an input image Docket sent); no sets at all (FR-011 requires them).

- **P7 — `ImageProviderRequest` carries a `label`, and the adapter calls `logLlmCall`.**
  *Rationale*: two reasons, both mechanical. `no-missing-usage-purpose.test.ts` finds purposes by
  scanning for `label:` literals shaped `word.word`; without one, widening the closed set to eight
  would fail its "names exactly the call sites" assertion. And an image call would otherwise be the
  only provider call in the product with no log line.
  *Alternatives*: exempt `image.generate` from the guard (weakens the guard the spec relies on);
  log separately (a second log shape for the same fact).

- **P8 — The billing-hold rule and the usage-buffer rule are each extracted once, not copied.**
  `applyCreditOutcome(owner, kind)` holds the whole decision ("`credit_exhausted` holds, everything
  else clears, a write failure is swallowed"); `withCreditHold` and a new `withImageCreditHold` are
  thin wrappers over it. `UsageRecorder` gains `wrapImage(image)` beside `wrap(llm)`, sharing one
  buffer and one `flush`.
  *Rationale*: G10 requires exactly this, and FR-017's "through the same code as a text refusal" is
  only provable if there is one function.
  *Alternatives*: a copy per path (two places for the probe interval, the swallow rule and
  `heldSince` semantics to drift).

- **P9 — The adapter's aspect table is the only place pixels exist, and an explicit `size` is
  passed through after a positive-integer check only.**
  `square → 1024x1024`, `landscape → 1536x1024`, `portrait → 1024x1536` (§ 2). Whether a model
  accepts an arbitrary resolution is a fact about the model, which source may not know (G2/G6), so
  the provider's own refusal is the arbiter, surfaced as `bad_request`. The UI offers only the three
  aspects; `size` exists because the declared contract declares it.

- **P10 — `n: 1`, `output_format: "png"`, and nothing else sent.**
  No `moderation` (Docket has no reason to ask a vendor to filter less), no `quality`, no
  `background`, no `stream`, no `response_format` (§ 2: unsupported for the GPT image models), no
  `user` (an identifier sent to a vendor for no benefit here), no `max_output_tokens` (FR-007 — the
  images endpoint has no such parameter and the text cap must not travel).

### The asset

- **P11 — The generated bytes go through `uploadMedia`, extended with an optional `generation`
  meta.**
  *Rationale*: G16 requires the existing path. `uploadMedia` is the only composition that already
  gets FR-023 right (`discardPreparedUpload` when the row write throws). Extending it keeps one
  writer; calling `prepareUpload`/`commitUpload` directly from the generator would copy the discard
  rule into a second place.
  *Alternatives*: a dedicated `writeGeneratedAsset` (a second writer, a second chance to orphan an
  object).

- **P12 — `media_assets.generation_provider` gets a *length* CHECK, never a value list.**
  *Rationale*: `CHECK (generation_provider IN ('openai'))` would make a second adapter need a
  migration, and SC-007 says replacing the provider changes only the adapter and the two
  configuration values. A 1–50 character bound is all the database needs to assert.
  *Alternatives*: an enum (worse — a `pgEnum` plus an `ALTER TYPE` per adapter).

- **P13 — The storage sentence moves to `src/server/storage/index.ts` as
  `MEDIA_STORAGE_NOT_SET_UP`; `images.ts` imports it in place of its private constant.**
  *Rationale*: G26 and FR-029 require one shared source, and storage is the subject of the sentence.
  A test asserts both paths return the identical string, so the roadmap's "the same message" stays
  true as either path changes.
  *Alternatives*: a new `src/lib/media/messages.ts` (file sprawl for one string); re-export from
  `images.ts` (makes the image-*input* module the owner of a storage fact).

- **P14 — One migration file for both schema changes.**
  The four provenance columns with their CHECKs, and
  `ALTER TYPE "public"."llm_usage_purpose" ADD VALUE 'image.generate'`. The repository already has
  eight migrations that add an enum value this way (`drizzle/0025_overrated_yellowjacket.sql`,
  `drizzle/0027_faulty_miracleman.sql`); the new value is added but **not used** in the same
  transaction, which is what Postgres requires. `pnpm db:check` compares the committed SQL against
  the schema snapshot.

### The contract, the service and the permission

- **P15 — `createImageGenerator(scope)` binds the declared contract to a scope, and `generate`
  refuses a request naming another project.**
  *Rationale*: the contract takes `projectId`, but constitution III forbids writing project-owned
  data without a scope. Binding at construction keeps the declared signature exactly as G4 requires
  and turns US4-6 into a real server-side refusal rather than a UI assumption.
  *Alternatives*: change the contract to take a scope (G4 forbids redesigning it); resolve a scope
  from `projectId` inside (a service that grants itself membership).

- **P16 — `src/server/llm/image-generation.ts` keeps the contract and gains only its *vocabulary* —
  `IMAGE_ASPECTS`, `IMAGE_PROMPT_MAX`, `NO_REAL_PEOPLE` — never the implementation.**
  *Rationale*: the generator writes a project-owned row, so by constitution IV it is a service.
  The vocabulary genuinely belongs with the contract: the UI needs the aspect list, the prompt bound
  is part of the request's shape, and the real-people instruction is a documented part of every
  request. `image-generation.test.ts` is rewritten from "no runtime exports" to "exports the
  vocabulary and no vendor value" — no size string, no provider name, no model id.
  *Alternatives*: implement in `src/server/llm/` (drags the media service into the LLM layer);
  leave the module types-only (the spec says this test is what the entry retires).

- **P17 — Authorization *throws* (`ForbiddenError`); every other refusal is returned.**
  *Rationale*: `runAction` already maps `ForbiddenError` to an `ActionResult`, and every other
  service in the product throws for permission. The contract's `message` channel is for refusals a
  person can act on ("no credit", "storage is not set up"), not for "you may not do this".

- **P18 — No `AbortSignal` is passed from the Media action, and a signal a caller does supply
  reaches the provider call only.**
  *Rationale*: the spec's abandoned-request edge case requires "either both stored objects and the
  row exist, or neither". Keeping the signal away from storage and the database makes that true by
  construction; the provider's own timeout (install-wide `LLM_TIMEOUT_SECONDS`) is what bounds the
  call.

- **P19 — `media: ["generate"]` is added to `statements` and to the owner and admin roles only.**
  G22's new statement. `src/server/auth/access.test.ts` builds its matrix from `statements` by
  construction, so it fails until the matrix names the new action for all three roles — which is
  exactly the review this costs.

### The interface

- **P20 — The page's gate asks a new service read `imageGenerationEnabled(scope)`, not a widened
  `MediaStatus`.**
  *Rationale*: `mediaStatus` is also read by the Jobs page and `services/overview.ts`, neither of
  which has any interest in image configuration, and `MediaStatus` is the library's own shape (it
  carries the dropzone's limits). Whether an image provider is configured is an LLM fact.

- **P21 — The "Generate an image" control renders in *both* `status.enabled` branches of the Media
  page.**
  *Rationale*: the empty-library branch is exactly the state a first generated image should be able
  to leave. Rendering only in the populated branch would mean a project with storage, a provider and
  no uploads can never start.

- **P22 — Provenance renders as a `Badge` plus a native `<details>` disclosure on the card.**
  *Rationale*: FR-035 wants the wording readable, and a prompt may be 1000 characters — it cannot
  live in a tile's caption. `<details>` is keyboard-operable with no JavaScript and works inside the
  server-rendered card, which `MediaCard` is. No new library view and no filter (G20, FR-027).

- **P23 — The aspect control is a three-option `ChoiceField`, which renders a `SegmentedControl`.**
  The `docket-ui` skill: "One-of-many choices never use a native `<select>`: 2–6 short options are a
  `SegmentedControl`." Three short options, labelled `<fieldset>`/`<legend>`.

### Tests and documentation

- **P24 — The secret scan and the env-coverage probe are *extended*, never exempted.**
  The existing scanned run in `tests/integration/security/secret-scan.test.ts` gains one generated
  image through a fake provider plus the Media page rendered for owner, admin and editor;
  `tests/integration/no-plaintext.test.ts` already dumps every table, so the four new columns are
  covered the moment a generated row exists; `tests/lint/env-coverage.test.ts`'s `CONFIGURABLE` list
  gains `LLM_IMAGE_VARIABLES`, and `.env.example` gains both variables with description, marker and
  default. `docs/security.md` gains one row (068 **P17** precedent).

---

## 4. What Docket deliberately does not know after this entry

- **What a content-policy refusal from the images endpoint looks like.** § 2. Until one is observed,
  it reads as `bad_request`. Adding it is one line in a named set (**P6**).
- **What an image call costs or how long it takes.** No figure exists in `docs/research/`, none is
  asserted, and nothing in the design depends on one. `LLM_RATES` is untouched: an image model with
  no configured rate shows calls and tokens without a money figure, which the Usage screen already
  handles.
- **Whether a prompt asks for a real person.** By design (G14): the fixed instruction is sent, the
  UI says so, and no detection is attempted.
- **Whether a configured model is an image model.** Source may not branch on a model id (G2), so an
  operator who configures a text model gets the provider's own rejection as `bad_request`.

No `NEEDS CLARIFICATION` remains. One `NEEDS RESEARCH` from the spec is closed above; the other
(latency and price) remains open, is recorded here, and blocks nothing.
