# Research: Generator core (007)

Planning date: 2026-10-04. External facts come from `docs/research/llm-and-storage.md` (checked 2026-10-03) and from the **installed** packages' own types and source in `node_modules` (constitution I). Phases cannot fetch the web, so nothing here comes from memory. Each decision has the form **Decision / Rationale / Alternatives**.

Installed versions read during planning: `openai` 7.27.0, `@anthropic-ai/sdk` 0.131.0, `zod` 4.6.5, `sharp` 0.35.5, `next` 16.3.8, Node 24.16. pnpm resolves both SDKs against the app's `zod@4.6.5` (`.pnpm/openai@7.27.0_…_zod@4.6.5`, `.pnpm/@anthropic-ai+sdk@0.131.0_zod@4.6.5`).

---

## 1. Spec unknowns R1–R4: resolved or kept interim

### R1: OpenAI per-image byte limit and URL fetching (still UNVERIFIED, interim kept)

- **Decision**: one set of model-input image constraints is used for both providers. It is one constant, `LLM_IMAGE_CONSTRAINTS`, in `src/server/llm/images.ts`:
  - formats `image/jpeg`, `image/png`, `image/webp`, `image/gif`, with `image/jpeg` as the conversion target;
  - long edge at most **2,000 px**;
  - at most **5,000,000 bytes** of raw image per image;
  - at most **24,000,000 base64 bytes** for all images in one request.

  An image that needs adapting goes through the existing media variant pipeline (`planImage` → `generateVariant`, cached in `media_variants` by constraints hash), so nothing new resizes images.
- **Rationale**:
  - Anthropic's 10 MB per-image limit applies to the **base64-encoded** data (research §2). Base64 grows data by 4/3, so the raw limit is about 7.5 MB; 5 MB leaves a margin.
  - 2,000 px follows Anthropic's own guidance for requests with more than 20 images, sits well under 8,000 px, and keeps the 32 MB request limit reachable even with `POST_MEDIA_MAX = 10` images.
  - OpenAI's per-image limit is unknown, but its 512 MB request limit is far above ours.
  - Being stricter than FR-005's "at most 10 MB / 8000×8000" still satisfies it.
- **Alternatives**:
  - Per-provider limits: rejected. The OpenAI value is unknown, and one constant is easier to verify.
  - Sending originals unchanged: rejected. A 20 MB upload would fail on Anthropic.

### R2: OpenAI Responses image content part (RESOLVED from installed types)

- **Decision**: `{ type: "input_image", image_url: <https URL | "data:<mime>;base64,<data>">, detail: "auto" }` inside a `user` message's `content` array. `detail` is **required** by the type (`ResponseInputImage.detail: ImageDetail`, which is `"high" | "low" | "auto" | "original"`).
- **Source**: `node_modules/openai/resources/responses/responses.d.ts`, `interface ResponseInputImage`.
- **Alternatives**: the Files API `file_id`. Rejected: it needs an upload, adds a round trip, and leaves storage to clean up.

### R3: Anthropic Zod helper with Zod 4 (RESOLVED from installed source)

- **Decision**: use `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod` to build `output_config.format`. Call **`messages.create`**, not `messages.parse`, and parse the text block ourselves.
- **Source**:
  - `node_modules/@anthropic-ai/sdk/helpers/zod.js` imports `zod/v4` and builds the schema with `z.toJSONSchema(schema, { reused: "ref" })` passed through `transformJSONSchema`, which strips constraints the API cannot express. This works with the app's Zod 4.6.5 schemas.
  - Its `parse` **throws** `AnthropicError` on a JSON or Zod failure, and the raw text is lost.
  - The `.d.ts` says the format "can be passed directly to the `.create()` method but will not result in any automatic parsing".
- **Rationale**: FR-015 needs the previous output for the retry message. Parsing ourselves keeps the raw text and maps every failure to `invalid_output` the same way for both providers.
- **Same choice for OpenAI**:
  - `zodTextFormat(schema, name)` from `openai/helpers/zod` (it accepts Zod v4 per its `ZodTypeLike` type) is passed as `text.format` to **`responses.create`**.
  - We read `output_text` ourselves; `responses.parse` would hide the raw text in `output_parsed: null` on failure.
  - `OutputConfig` (`format: JSONOutputFormat`) and `ResponseStatus` (`"incomplete"`) are read from the installed `.d.ts` files.

### R4: Anthropic structured-output complexity limits (RESOLVED by design)

- **Decision**:
  - The **wire schema** sent to providers has only required properties and no unions (no `.optional()`, no `.nullable()` in the generation schema), and no length or count constraints.
  - The schema is built per request with one property per targeted platform key. The four current platforms give at most 4 objects of 1 string each, plus one optional alt-text array.
  - Zero optional parameters and zero union types stay far below 24 and 16.
- **Rationale**: research §2 lists both limits and the constraints Anthropic cannot express. Lengths are stated in the prompt and enforced after the call (§3).
- **Alternatives**: one fixed schema with every registered platform as `nullable`. Rejected: it uses union types per platform, and FR-014 says exactly one variant per *targeted* platform.

---

## 2. LLM layer design

### D1: One interface, two SDK implementations, one fake

- **Decision**: `LlmProvider.generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>` in `src/server/llm/types.ts` ([contract](./contracts/llm.md)).
  - Implementations: `src/server/llm/openai.ts` (built first) and `src/server/llm/anthropic.ts`.
  - The fake is `tests/helpers/fake-llm.ts`. It is not under `src/`, so the app can never select it.
  - `getLlm()` in `src/server/llm/index.ts` picks the implementation from `getLlmConfig()`, and tests inject the fake through the same function's override (`setLlmForTests`).
- **Rationale**: FR-001, FR-002, FR-004 and FR-019. The services take an `LlmProvider` argument (a default parameter resolved by `getLlm()`), so jobs and the API can call them later.
- **Alternatives**:
  - Vercel AI SDK: rejected because it is a new dependency (constitution VI).
  - Putting the fake inside `src/`: rejected because it could ship as a selectable provider.

### D2: Fake transport for the SDK implementations

- **Decision**:
  - Both SDK clients accept a `fetch` option (`ClientOptions.fetch?: Fetch` in `openai/client.d.ts` and `@anthropic-ai/sdk/client.d.ts`).
  - The implementations take an optional `fetch` in their factory, and tests pass a scripted fake (`tests/helpers/fake-llm-http.ts`). The fake records each request body and returns canned JSON or status codes.
  - `maxRetries` is set to 0 in transport tests so a scripted 429 is seen once.
- **Rationale**: User Story 6's independent test and SC-005: both implementations run through the same scenarios with no live call (constitution II).
- **Alternatives**: mocking the SDK modules with `vi.mock`. Rejected because it would not exercise the real request shapes.

### D3: Failure mapping

| Condition (installed SDK fact) | `LlmFailure.kind` | Retried by the core? |
|---|---|---|
| Our `JSON.parse` or Zod `safeParse` of the output fails | `invalid_output` | yes (once) |
| OpenAI output content of `type: "refusal"`; Anthropic `stop_reason: "refusal"` | `refused` | yes (once) |
| OpenAI `status: "incomplete"`; Anthropic `stop_reason: "max_tokens"` or `"model_context_window_exceeded"` | `incomplete` | yes (once) |
| `APIConnectionTimeoutError`, or our own `AbortSignal` timeout firing | `timeout` | yes (once) |
| `RateLimitError` (429) | `rate_limited` | no |
| `InternalServerError` (5xx), `APIConnectionError` | `unavailable` | no |
| `AuthenticationError` (401), `PermissionDeniedError` (403) | `auth` | no |
| `BadRequestError` (400), `UnprocessableEntityError` (422), `NotFoundError` (404) | `bad_request` | no |

- **Rationale**:
  - FR-015 and FR-016 say an "unreadable" response (malformed, refused, truncated, timed out) is retried once.
  - 429 and 5xx are already retried by the SDK (`maxRetries`, at most 2, FR-006), so a second core-level attempt would only stack delays.
  - Auth and bad-request errors are configuration errors and would fail again.
- **Messages**: each kind has one fixed plain sentence, for example `timeout` → "The model took too long to answer." (Story 6 scenario 4). SDK error messages are never shown: they can echo request content.

### D4: Timeouts and retries

- **Decision**:
  - Client options: `timeout: LLM_TIMEOUT_SECONDS * 1000` (default 90 s, integer 10–600) and `maxRetries: 2`.
  - Each call also gets an `AbortSignal.timeout` with the same budget, so a hung retry cannot exceed it by much.
  - `max_tokens` (Anthropic, required) and `max_output_tokens` (OpenAI) come from `LLM_MAX_OUTPUT_TOKENS` (default 4,000, integer 256–32,000).
- **Rationale**: research §1 and §2 (SDK default 10 min and 2 retries; Anthropic requires `max_tokens`). Four variants of at most 10,000 characters fit in 4,000 tokens for typical posts. Facebook's 10,000 is the outlier, and the prompt asks for posts that are short for the platform. When the cap is reached, the result is `incomplete` and is retried once.
- **Alternatives**: no output cap on OpenAI. Rejected so both implementations behave the same.

### D5: Configuration (FR-003)

- **Decision**: the LLM settings are **not** part of `parseEnv`'s fatal checks. `getLlmConfig(source)` in `src/server/llm/config.ts` returns `{ ok: true, config } | { ok: false, problems: EnvIssue[] }`:
  - `LLM_PROVIDER` must be `openai` or `anthropic`;
  - `LLM_MODEL` must be non-empty, at most 200 characters, with no whitespace;
  - the matching key must be present;
  - `LLM_TIMEOUT_SECONDS` and `LLM_MAX_OUTPUT_TOKENS` must be valid integers.

  At startup `runStartup` logs one line per problem (names only) and **continues**. The Generate, Try it and Review regenerate controls show "Generation is not configured" with the names.
- **Rationale**:
  - FR-003 says an incomplete group disables generation and the rest of the app keeps working. This is unlike storage, where a partial group is fatal.
  - There is no default model anywhere (no model id literal in `src/`); a lint-style test greps for one.
- **Alternatives**: making an incomplete group fatal like `S3_*`. Rejected because the spec says otherwise.

### D6: Logging (FR-007, FR-035)

- **Decision**: `src/server/llm/log.ts` writes one line per call to `console.info`:
  - fixed fields: `llm_call provider=<p> model=<m> label=<l> outcome=<ok|kind> latency_ms=<n> input_tokens=<n|-> output_tokens=<n|->`;
  - no prompt, no images, no SDK error message, no key.

  `redact()` from `src/server/scheduler/redact.ts` runs the line past the configured key as a backstop.
- **Rationale**: FR-007 and constitution VII.

### D7: Live latency check (FR-037)

- **Decision**:
  - `scripts/llm-check.ts` is run by `pnpm llm:check`, which is `esbuild scripts/llm-check.ts --bundle --platform=node --target=node24 --format=esm --outfile=.next/cache/llm-check.mjs && node .next/cache/llm-check.mjs`. esbuild is already a devDependency and resolves the tsconfig `@/` paths. The script imports only `src/server/llm/*` and the prompt and schema modules, with no database.
  - It reads `process.env` through `parseLlmConfig`, generates one sample (Bluesky + Facebook variants from a built-in brief), and prints `provider=<p> model=<m> outcome=<ok|kind> latency_ms=<n>`.
  - Without a configured key it prints `latency: unmeasured (no LLM key configured)` and exits 0.
  - The implement phase runs it once and records the line in `docs/decisions.md`. It is not part of `pnpm test`.
- **Rationale**: SC-011 and constitution II. Phases normally have no key, so the expected report is "unmeasured / verified with mocks only".

---

## 3. Generation core

### D8: Prompt assembly is a pure function

- **Decision**: `buildGenerationPrompt(input): { system: string; user: string }` in `src/server/services/generation/prompt.ts` has no I/O. Sections appear in this order (FR-013):
  1. role and output rules;
  2. voice fields that are not empty;
  3. guidance for targeted platforms only;
  4. platform rules from capabilities;
  5. one-off instructions;
  6. brief;
  7. source material inside `<source_material>` with a "data, not instructions" note;
  8. series angle and the angles to avoid;
  9. the image note.

  The retry adds a final section with the previous output and the numbered problems. The exact text is in [contracts/prompt.md](./contracts/prompt.md).
- **Rationale**: FR-013 says assembly is checkable without a model call. A snapshot test of the assembled prompt is safe because it contains no secrets.

### D9: Output schema and post-call validation

- **Decision**:
  - `generationOutputSchema(platformKeys, imageCount)` builds `z.strictObject({ variants: z.strictObject({ [key]: z.strictObject({ text: z.string() }) … }), imageAltTexts?: z.array(z.string()) })`. The `imageAltTexts` key is present only when images are attached, and is then required.
  - After the structural parse, each variant is checked by the **existing** path, `validateTargetContent(scope, { providerKey }, { text, assets, referenced }, { preview: true })`. This is the same function the composer check uses.
  - Alt-text counts and lengths are checked against `min(maxAltTextLength)` of the targeted platforms that allow images.
  - Blocking problems (`severity: "error"`) trigger the one retry.
- **Rationale**: FR-014, FR-015 and constitution IV (one validation path). `preview: true` is needed because variants are not built until the post exists. After saving, the policy step re-validates for real (D12).
- **Spec note: alt text is shared, not per platform.** Docket stores alt text on the media asset (003), not on the target. One `imageAltTexts` list is therefore asked for, bounded by the strictest targeted alt-text limit. A generated alt text is written to an asset only when that asset's alt text is empty; it is always recorded in the generation record. This narrows FR-014's "alt text … per variant" wording and is logged in `docs/decisions.md`.
- **Alternatives**: per-variant alt-text arrays. Rejected because they cannot be stored per target without a schema change to media.

### D10: Mapping variants to content

- **Decision**:
  - The post's `base_text` is the variant of the platform of the **first selected account**.
  - Every target gets `override_text` = its platform's variant, so each target's effective text is its variant and the composer shows it.
  - Targets on the same platform share one variant (Story 1 scenario 2).
  - Media goes on the post, ordered as selected. Platforms that take no images (`maxImages: 0`) simply validate without it, because media is per post in Docket's model.
- **Rationale**: FR-018 uses the existing post and target model; no new columns are needed for content.

### D11: Generation runs inside the request; series writes one angle per call

- **Decision**:
  - Single mode and Try it are one server action each.
  - Series has three steps:
    1. `planSeries` is one action that returns angles and saves nothing;
    2. `startSeries` saves a `generation_series` row with the edited plan;
    3. the client then calls `writeSeriesPost(seriesId, position)` once per angle, in order, showing progress.
  - A unique index on `(series_id, series_position)` among live posts makes each angle idempotent. A retried or duplicate call returns the existing post instead of creating one.
- **Rationale**:
  - FR-023 and Story 5 scenario 5 (no duplicates on retry).
  - "Generation runs inside the person's request" (Assumptions).
  - Ten angles × (up to 2 calls × 90 s) in one request would be too long, and one failure would hide the progress already made.
- **Alternatives**: background processing. Rejected because that is generation-jobs scope.

### D12: Save first in review, then apply policy (safe direction)

- **Decision**: a successful generation saves the post in one transaction with origin `generated`, `review_state = 'needs_review'`, `scheduling_policy` and the first generation record. The policy is then applied in three steps:
  1. `prepareVariants(scope, postId)` runs outside any transaction (the existing rule that slow image work holds no row locks);
  2. in one transaction, `applyApprovalPolicy` locks the post, runs the real `gate()` validation for each live target and calls `decidePolicy(...)`;
  3. if the result is approve: `review_state = 'approved'` and, for `add_to_queue`, `queueTargetsInTx(tx, post, targets)` (§4 D15).
- **Rationale**: SC-003. A crash between save and policy leaves the post in review, never approved or queued. Real validation (with built variants) is the same check the scheduling gates make, so policy and gate cannot disagree.

### D13: Double submit and the request id

- **Decision**:
  - The Generate form sends a client-made UUID, `requestId`. The `posts.generation_request_id` column has a partial unique index on `(project_id, generation_request_id)`.
  - Before calling the model, the service looks up an existing post for that id and returns it.
  - A concurrent duplicate that loses the insert race catches the unique violation and returns the winner.
  - The button is also disabled while pending (FR-033).
- **Rationale**: the "Double submit" edge case. A wasted model call in a true race is accepted; a duplicate post is not.

### D14: Generation records and failures

- **Decision**:
  - `posts.generation_metadata` holds `{ v: 1, records: GenerationRecord[] }` (shape in [data-model.md](./data-model.md#generation-metadata-postsgeneration_metadata)). Regenerate appends a record.
  - A request that saves no post writes one `generation_failures` row (project-owned) with mode, inputs, kind, message, per-attempt latency and who asked.
  - Try it writes nothing (SC-007).
- **Rationale**: FR-016, FR-017 and SC-002.
- **What is stored**: the full prompt is stored (FR-017). It holds only project content: brief, source text, voice and capabilities; never keys.
- **Images**: they appear in the prompt record as `{ mediaAssetId, mode: "url" | "bytes" }`, never as data.

---

## 4. Policies, review and existing services

### D15: `addToQueue` gains an in-transaction core (one implementation)

- **Decision**:
  - The body of `addToQueue` after `lockPost` is extracted unchanged into `queueTargetsInTx(tx, post, targets, opts)` in `src/server/services/posts/index.ts`.
  - `addToQueue` becomes a thin wrapper: prepare variants, open a transaction, lock the post, call it.
  - The approval service calls the same function inside its own transaction, after setting `review_state = 'approved'` and re-reading the post.
- **Rationale**:
  - Constitution IV: slot allocation keeps exactly one implementation.
  - `scope.transaction` always opens a new top-level transaction (see `getRoot` in `dal/scope.ts`), so calling `addToQueue` from inside another transaction would not be atomic.
  - FR-031: approve plus queue at most once, under the post row lock.
- **Alternatives**: approve in one transaction, then call `addToQueue`. Rejected because a crash between them leaves "approved, never queued" with no retry path.

### D16: The approval policy decision is pure

- **Decision**: `decidePolicy({ approval, scheduling, blocking })` in `src/server/services/generation/policy.ts` returns `{ reviewState, queue, reason }`. The full rule table is in [contracts/services.md](./contracts/services.md#decidepolicy). `resolvePolicies(scope, overrides)` applies the defaults, the role limits and the confirmation rule, and throws before any model call.
- **Rationale**: FR-024 to FR-027. One function serves single mode, series, regenerate and review approval. It is tested as an 8-row matrix (SC-003).

### D17: Role limits

- **Decision**:
  - New access statements are `voice: ["view", "manage"]` and `generation: ["run", "auto_approve"]`.
  - Owner and admin get all of them; editor gets `voice: ["view"]` and `generation: ["run"]`.
  - An approval override of `auto_approve` needs `generation: ["auto_approve"]`.
  - A project default of `auto_approve` applies to everyone (Story 4 scenario 6).
  - The scheduling policy needs only `post: ["schedule"]`, which every role has.
- **Rationale**: FR-011 and FR-026. Checks go through `scope.can` on the server. `tests/integration/actions-authz.test.ts` gains rows for each new action × role.

### D18: Confirmation of auto-approve plus queue

- **Decision**:
  - Every generation request, and the project settings update, carries `confirmUnreviewedQueue: boolean`.
  - When the *effective* combination is `auto_approve` + `add_to_queue`, the server refuses unless it is `true`, with the message "Confirm that posts will be approved and queued without review."
  - The UI shows the combination as the radio option "Approve and queue automatically — no review", with an explanation and a required checkbox.
- **Rationale**: FR-027 and Story 4 scenarios 8 and 9. Later callers (jobs, API) pass the same flag.

### D19: The `rejected` state

- **Decision**:
  - The migration adds the value `rejected` to both `post_review_state` and `post_status` (Postgres `ALTER TYPE … ADD VALUE`). `derivePostStatus` already returns the review state when no target is live, so a rejected post's status is `rejected`.
  - `queueableGate` refuses `rejected` with "This post was rejected." Explicit schedule and publish-now use the same gate.
  - The Posts list gains Needs review and Rejected filter tabs; `listSchema` accepts `rejected`.
  - Reject keeps content and metadata and records `reviewed_by_user_id`, `reviewed_at` and `rejection_reason` (≤ 500 characters).
- **Rationale**: FR-032.
- **Migration safety**: an enum value added by `ALTER TYPE … ADD VALUE` cannot be used in the same transaction. Drizzle runs each migration file in its own transaction, so nothing in `0004` uses `rejected`. Defaults and constraints stay unchanged.

### D20: Concurrent approval

- **Decision**:
  - Approve locks the post (`lockForUpdate`) and re-reads `review_state`.
  - If it is no longer `needs_review`, it returns `{ ok: false, code: "already_reviewed", message: "This post was already approved." }`, or the matching message for rejected.
  - Queueing happens under the same lock (D15).
  - Bulk approve processes posts one at a time, each in its own transaction, in the order given, and returns `{ approved: […], skipped: [{ postId, reason }] }`.
- **Rationale**: FR-030, FR-031 and SC-008. A 20× parallel approval test reuses the race pattern from the 003 queue tests.

### D21: Regenerate

- **Decision**: `regeneratePost(scope, postId, { instruction? })` works as follows.
  1. It refuses if any target is past `draft` or `cancelled` ("Unschedule this post before regenerating").
  2. It reads the inputs stored in the post's last generation record and the profile's **current** version.
  3. It calls the core and replaces `base_text` and the overrides under the post lock. If the post was edited meanwhile, the newer state is overwritten; the lock is held only for the write.
  4. It appends a record and never approves or queues.
  5. If the real validation now fails, it sets `needs_review`.
- **Rationale**: FR-022 and Story 3 scenario 5.

---

## 5. Voice profiles

### D22: Versioning and optimistic concurrency

- **Decision**:
  - `voice_profiles` holds `current_version`; `voice_profile_versions` holds immutable rows with unique `(profile_id, version)`.
  - Save takes `baseVersion`. Under `SELECT … FOR UPDATE` on the profile row, a `current_version` that differs from `baseVersion` throws `ConflictError("This profile changed since you opened it")`; otherwise the new version is `current + 1`.
  - The DAL repository exposes no update or delete for version rows. A test asserts that the repository object has no such methods, and a trigger-free check compares the rows' content before and after an edit.
- **Rationale**: FR-009 and SC-006.
- **Alternatives**: a Postgres trigger that blocks `UPDATE` on versions. Rejected as extra machinery: the DAL is the only writer (constitution III), and the test covers it.

### D23: The default profile

- **Decision**:
  - `projects.default_voice_profile_id` is a nullable column with a composite foreign key `(id, default_voice_profile_id)` → `voice_profiles(project_id, id)`, so the default always belongs to the same project.
  - Archiving the default is refused ("Make another profile the default first").
  - Creating the first profile in a project makes it the default automatically.
- **Rationale**: FR-010. The brief's data model lists "default voice profile" on projects.

### D24: Try it

- **Decision**:
  - `tryVoice(scope, input)` takes either `{ draft: VoiceContent }` (needs `voice: ["manage"]`) or `{ versionId }` (needs `voice: ["view"]`), plus a brief (≤ 2,000 characters) and 1–4 platform keys.
  - It defaults to the providers of the project's connected accounts, and to `bluesky` when there are none.
  - It runs the same core with `persist: false` and validates each variant through `validateTargetContent` with `{ providerKey }`, with no media.
  - It has no writes and no failure row (SC-007).
- **Rationale**: FR-012. Platform rules come from the registry, so Try it works before any account is connected.
- **Small generic change**: `validateTargetContent`'s `account` parameter narrows to `Pick<AccountRecord, "providerKey">`. Only that field is read; no behaviour changes.

### D25: Voice content limits

- **Decision**: the Zod limits are:
  - name: 1–80 characters, unique per project among non-archived profiles;
  - voice and tone, audience, topics and pillars, avoid: ≤ 2,000 characters each;
  - example posts: ≤ 10, each ≤ 3,000 characters;
  - preferred links: ≤ 20, each an `https?` URL ≤ 500 characters with a label ≤ 80 characters;
  - hashtags: ≤ 30, each `^#?[\p{L}\p{N}_]{1,100}$`u, stored without `#`;
  - per-platform guidance: a record keyed by registered provider key, each ≤ 2,000 characters; unknown keys are refused.
- **Rationale**: inputs need bounds at every boundary (constitution: Zod everywhere). These limits keep the worst-case prompt well inside model context windows.

---

## 6. UI (docket-ui skill)

### D26: Routes replace the placeholders

- **Decision**:
  - New static segments: `generate/` (with `?mode=single|series`), `generate/result/[postId]`, `generate/series/[seriesId]`, `review/`, `voice/`, `voice/new`, `voice/[profileId]`, `voice/[profileId]/history` (full table in [contracts/ui.md](./contracts/ui.md)).
  - Static segments take precedence over the dynamic `[section]` placeholder, which keeps only `jobs`. The `generate`, `review` and `voice` entries are removed from `PLACEHOLDERS`.
  - Each route has `loading.tsx` and uses the existing `error.tsx`.
  - Client components are leaf-level: `GenerateForm`, `VariantEditor`, `SeriesPlanEditor`, `SeriesWriter`, `VoiceEditor`, `TryItPanel`, `ReviewList`.
- **Rationale**: FR-033 and the skill. Next 16 App Router conventions were read in `node_modules/next/dist/docs/01-app/` during 003 and are unchanged here.

### D27: Variant counts reuse the compose check

- **Decision**:
  - Live per-variant counts and problems on the result and review screens call the existing `compose/check` route with `{ baseText, targets: [{ accountId, overrideText }], mediaIds, postId }`, so counts use each provider's own counting rule (skill: "never re-implement the counting").
  - "Save" calls `updatePost` with every target of that platform; "Save and approve" calls `approvePost(postId, { edits })`, which saves and approves in one transaction (§4 D20).
- **Rationale**: one validation path (constitution IV).

---

## 7. Dependencies and infrastructure

- **No new runtime dependency.** `openai`, `@anthropic-ai/sdk`, `zod`, `sharp` and `@js-temporal/polyfill` are already installed (decision #19).
- **No new infrastructure.**
- **One migration**, `0004`:
  - adds the `rejected` enum values;
  - creates the four tables `voice_profiles`, `voice_profile_versions`, `generation_series` and `generation_failures`;
  - adds the posts columns `generation_request_id`, `scheduling_policy`, `series_id`, `series_position`, `reviewed_by_user_id`, `reviewed_at` and `rejection_reason`;
  - adds `projects.default_voice_profile_id`.

## 8. Still unverified after planning

| Id | Item | Treatment |
|---|---|---|
| R1 | OpenAI per-image byte limit and URL-fetch rules | Interim constraints (§1), one constant, mocked tests |
| U1 | Whether OpenAI and Anthropic can fetch our public media URLs (redirects, content-type, R2 rate limits) | URL mode is used only when storage is `public` and the base URL is `https` with a non-local host; otherwise bytes. Owner live check |
| U2 | Real latency of the configured model | `pnpm llm:check` (D7); "unmeasured" without a key |
| U3 | Whether 4,000 output tokens is enough for 4 long variants on every model | `LLM_MAX_OUTPUT_TOKENS` is configurable; `incomplete` is retried once, then recorded |
