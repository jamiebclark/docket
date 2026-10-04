# Implementation Plan: Generator core (LLM layer, voice profiles, single and series generation, approval policy, review queue)

**Branch**: `007-generator-core` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-generator-core/spec.md`

## Summary

Docket gains its generator core. It is built as one service layer that today's UI calls and that generation jobs and the public API will call later (FR-019).

- **LLM layer** (`src/server/llm/`):
  - One `LlmProvider.generate()` interface ([contract](./contracts/llm.md)). It takes system and user text, image parts (by https URL or bytes), a Zod wire schema, a timeout and a label. It returns a parsed value with usage, latency, provider and model, or one of eight typed failures.
  - **OpenAI is built first**: Responses API, `zodTextFormat` as `text.format` on `responses.create`. The Anthropic implementation follows: `zodOutputFormat` as `output_config.format` on `messages.create`.
  - Both parse the raw text themselves, so the retry can quote it (research R3). Both map refusal, truncation and the SDK error classes to the same kinds.
  - The provider and model come only from `LLM_PROVIDER`, `LLM_MODEL` and the matching key. An incomplete group disables generation without stopping the app (research D5).
  - A scripted fake (`tests/helpers/fake-llm.ts`) and a fake `fetch` transport cover everything. No test calls a model.
- **Generation core** (`src/server/services/generation/`):
  - A pure prompt builder ([contract](./contracts/prompt.md)) and a per-request output schema with exactly one variant per targeted platform. The schema has no length constraints; platform limits are stated in the prompt.
  - After the call, each variant goes through the **existing** validation path (`validateTargetContent`, the one the composer and the gates use).
  - Unreadable output or blocking problems get exactly one retry that quotes the previous answer and the problems. After that, the post is saved and forced to review, or a failure is recorded with no post.
  - Every saved post carries a full generation record: prompt, provider, model, voice version, inputs, policies, usage, and per-attempt latency.
- **Modes**:
  - **Single** saves the post in review first, then applies the policy (safe direction, research D12).
  - **Series** plans N angles (nothing saved), lets the person edit them, saves the plan, then writes one post per angle in separate idempotent calls (research D11).
  - **Regenerate** appends a new record.
- **Approval policy**:
  - One pure `decidePolicy` (8-row matrix; any blocking problem → review) and one `resolvePolicies` (defaults, editor limit on `auto_approve`, required confirmation for auto + queue).
  - Queueing reuses today's `addToQueue` body, extracted unchanged into `queueTargetsInTx`, so approve plus queue is atomic and slot allocation keeps one implementation (research D15).
- **Voice profiles**: project-scoped, with immutable versions and optimistic-concurrency saves. The project default is a composite-FK pointer. Archive and restore are supported. **Try it** writes nothing.
- **Review queue**: approve, save-and-approve, reject (new `rejected` state), regenerate and bulk approve. Approval is safe under concurrency through the post row lock.
- **Image generation**: an interface only.

There is one migration (`0004`) and **no new dependency**.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`; planning checked on 24.16).

**Primary Dependencies**: all already installed (decision #19). **Nothing new.**

- `openai` 7.27.0: `responses.create`, `zodTextFormat` from `openai/helpers/zod`, the `ClientOptions.fetch`/`timeout`/`maxRetries` options and the error classes, all read from the installed `.d.ts` files.
- `@anthropic-ai/sdk` 0.131.0: `messages.create`, `output_config.format`, `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` (it imports `zod/v4`, which resolves to the app's 4.6.5), `stop_reason` values and the error classes.
- `zod` 4.6.5 for every boundary. `z.toJSONSchema` is used in the schema tests.
- `sharp`, through the existing variant pipeline, for model-input images.
- Next.js 16.3.8 Server Actions and server components, as in 003. Read `node_modules/next/dist/docs/01-app/` before writing UI (AGENTS.md).
- `esbuild` (an existing devDependency) bundles the `pnpm llm:check` script.

**Storage**: PostgreSQL 17 via Drizzle, with one migration (`0004`). See [data-model.md](./data-model.md).

- **New tables**: `voice_profiles`, `voice_profile_versions`, `generation_series`, `generation_failures`.
- **New columns**:
  - on `posts`: `generation_request_id`, `scheduling_policy`, `series_id`, `series_position`, `reviewed_by_user_id`, `reviewed_at`, `rejection_reason`;
  - on `projects`: `default_voice_profile_id`.
- **Enum values**: `rejected` on `post_review_state` and `post_status`.
- **New enums**: `generation_mode`, `llm_failure_kind`.
- Model-input images reuse `media_variants`, keyed by `LLM_IMAGE_CONSTRAINTS`'s hash.

**Testing**: Vitest against real Postgres (the existing harness with per-worker DB clones).

- New `tests/helpers/fake-llm.ts` and `tests/helpers/fake-llm-http.ts`.
- Unit tests sit beside the code (`src/server/llm/*.test.ts`, `src/server/services/generation/*.test.ts`). Integration tests go in `tests/integration/{generation,review,voice}/`.
- `actions-authz.test.ts` gains rows. The scope registry gains four tables.
- **No live LLM calls** (FR-004, FR-036).

**Target Platform**: the existing `node:24-slim` image (`web`). The `worker` bundle must not import the LLM layer or the generation services; `tests/lint/worker-bundle.test.ts` guards this.

**Project Type**: the single Next.js app (`src/app`, `src/components`, `src/server`, `src/providers`, `src/lib`).

**Performance Goals**:

- SC-001: under 2 minutes from Generate to a saved post, excluding model time. Plain forms and one action.
- SC-004: **at most 2 model calls** per post or plan.
- Each call is bounded by `LLM_TIMEOUT_SECONDS` (default 90) and the SDK's ≤ 2 transport retries.
- A series runs one action per angle, so no request holds more than one post's generation.
- The live latency is measured by `pnpm llm:check` when a key exists, otherwise it is reported as unmeasured (FR-037).

**Constraints**:

- No model id literal in `src/` (a test greps for one).
- Keys never reach prompts, metadata, logs, errors, the browser or snapshots (FR-035).
- No provider call happens inside a held DB transaction: model calls and variant building run before the save transaction (the 003 rule).
- No session-level Postgres features.
- Input caps: brief 2,000, instructions 2,000, source text 50,000 characters.
- Series N is 2–10; bulk approve takes 1–100 posts; the review page shows 50.

**Scale/Scope**:

- Personal and team use: a handful of projects, tens of profiles, hundreds of posts in review at most.
- Four platforms today, so a generation schema has at most 4 variant keys.
- Out of scope: generation jobs, batch mode, item sources, media "used" tracking, the public API and image generation itself.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-research | Post-design | How the design complies |
|---|---|---|---|
| I. Verified facts over memory | PASS | PASS | SDK shapes come from `docs/research/llm-and-storage.md` and the installed `.d.ts` and `.js` files (research R2, R3, D3). R1 stays UNVERIFIED, with one constant and mocked tests. No model ids are used. |
| II. Nothing "working" unless it ran | PASS | PASS | Fake LLM and fake transport; `pnpm llm:check` measures real latency or reports "unmeasured / verified with mocks only" (D7). |
| III. Isolation in one place | PASS | PASS | Four new project-owned tables are registered in `project-owned.ts` and reached only through the new repositories in `buildScope`. Composite FKs keep the default profile and series in the same project. Roles are checked through `scope.can` in services, with new `voice` and `generation` statements. |
| IV. One service layer, many callers | PASS | PASS | One `runGeneration`, one `decidePolicy` and `applyApprovalPolicy`, one `validateTargetContent`, and one slot allocation (`queueTargetsInTx` is today's code, extracted). The UI calls services only. |
| V. Providers are plug-ins | PASS | PASS | Platform rules come from `capabilities` and `validate()` through the registry. No provider folder changes, and a new provider is picked up by the prompt automatically. |
| VI. Boring, few dependencies | PASS | PASS | No new runtime dependency and no new infrastructure. The SDKs, sharp and zod are pre-installed. |
| VII. Secrets never leak | PASS | PASS | Keys are read only in `llm/config.ts`. Log lines have fixed fields plus `redact()`. SDK error text is never surfaced. `no-secrets` tests scan metadata, failure rows, logs and action results for a fake key. |
| Engineering: no provider call in a held transaction | PASS | PASS | Model calls, `imagesForModel` and `prepareVariants` all run before `scope.transaction`. |
| Engineering: UI via the `docket-ui` skill | PASS | PASS | [contracts/ui.md](./contracts/ui.md): labelled fields, four states per view, text plus colour statuses, project time zone, keyboard-only flows. |
| Workflow: tests per the quality bar | PASS | PASS | FR-036's list maps to quickstart §1–§4. Membership-role rows are added to `actions-authz`. |

**Result**: no violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-generator-core/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R4 resolutions, decisions D1–D27
├── data-model.md        # Phase 1: tables, columns, enums, metadata shape, transitions
├── quickstart.md        # Phase 1: runnable validation guide
├── contracts/
│   ├── llm.md           # LlmProvider, config, fake, images, image-generation interface
│   ├── prompt.md        # prompt sections and order, output schemas, post-call checks
│   ├── services.md      # policy, generation, series, regenerate, review, voice, permissions
│   └── ui.md            # routes, states, forms, server actions
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/server/llm/
├── types.ts                 # LlmProvider, LlmRequest, LlmResult, LlmImage, failure kinds
├── config.ts (+ .test.ts)   # parseLlmConfig: never fatal, names only
├── messages.ts              # fixed plain sentence per failure kind
├── log.ts                   # one redacted line per call
├── openai.ts (+ .test.ts)   # Responses API implementation (first)
├── anthropic.ts (+ .test.ts)# Messages API implementation
├── images.ts (+ .test.ts)   # LLM_IMAGE_CONSTRAINTS, imagesForModel (url vs bytes, budget)
├── image-generation.ts      # interface only (FR-020)
└── index.ts                 # getLlm, getLlmStatus, setLlmForTests, LlmNotConfiguredError

src/server/services/generation/
├── prompt.ts (+ .test.ts)   # buildGenerationPrompt, buildSeriesPlanPrompt, platformRulesFor
├── schema.ts (+ .test.ts)   # generationOutputSchema, seriesPlanSchema, checkGenerationOutput, checkSeriesPlan
├── core.ts (+ .test.ts)     # runGeneration: ≤ 2 calls, retry rule
├── policy.ts (+ .test.ts)   # decidePolicy, resolvePolicies, applyApprovalPolicy
├── single.ts                # generateSingle
├── series.ts                # planSeries, startSeries, writeSeriesPost, getSeries
├── regenerate.ts            # regeneratePost
├── failures.ts              # record + listRecentFailures
└── index.ts
src/server/services/review.ts      # listReviewQueue, approvePost, rejectPost, bulkApprove
src/server/services/voice.ts       # profile CRUD-by-version, default, archive/restore, tryVoice
src/server/services/posts/index.ts # + queueTargetsInTx (extracted), rejected gate, new create fields
src/server/services/posts/validate.ts   # account param narrowed to Pick<…, "providerKey">
src/server/services/posts/list.ts       # + "rejected" filter
src/server/services/media-variants.ts   # + ensureVariant(scope, asset, constraints) (reuses buildVariant)
src/server/services/projects.ts         # + confirmUnreviewedQueue rule

src/server/dal/voice.ts, dal/series.ts, dal/generation-failures.ts   # new repos
src/server/dal/scope.ts                 # wire repos; project.defaultVoiceProfileId
src/server/dal/posts.ts                 # new columns, review-queue query, findByRequestId, findBySeriesPosition
src/server/dal/errors.ts                # + PolicyNotAllowedError
src/server/db/schema/generation.ts      # new tables and enums
src/server/db/schema/{posts,projects,index}.ts
src/server/db/project-owned.ts          # + 4 tables
src/server/auth/access.ts               # + voice, generation statements
src/server/startup/index.ts             # log "generation disabled (…)", never exit
src/lib/validation/{voice,generation}.ts
src/lib/action-result.ts                # + LlmNotConfiguredError, PolicyNotAllowedError mapping
drizzle/0004_*.sql (+ meta)

src/app/p/[projectSlug]/generate/{page,loading,actions}.tsx|ts, GenerateForm.tsx, PolicyPicker.tsx, SeriesPlanEditor.tsx
src/app/p/[projectSlug]/generate/result/[postId]/{page,loading}.tsx, VariantEditor.tsx, RegenerateDialog.tsx
src/app/p/[projectSlug]/generate/series/[seriesId]/{page,loading}.tsx, SeriesWriter.tsx
src/app/p/[projectSlug]/review/{page,loading,actions}.tsx|ts, ReviewList.tsx, RejectDialog.tsx
src/app/p/[projectSlug]/voice/{page,loading,actions}.tsx|ts, new/page.tsx, [profileId]/{page,loading}.tsx, [profileId]/history/page.tsx, VoiceEditor.tsx, TryItPanel.tsx
src/app/p/[projectSlug]/[section]/page.tsx     # placeholders: jobs only
src/app/p/[projectSlug]/settings/{settings-form.tsx,actions.ts}   # auto+queue confirmation
src/app/p/[projectSlug]/posts/page.tsx         # Rejected tab
src/components/ui/StatusBadge.tsx              # rejected
src/components/shell/LeftNav.tsx               # review count (passed from layout)

scripts/llm-check.ts                           # pnpm llm:check (FR-037)
tests/helpers/{fake-llm,fake-llm-http}.ts, tests/helpers/factories.ts (+ voice/profile/post-in-review factories)
tests/integration/{generation,review,voice}/*.test.ts, tests/integration/actions-authz.test.ts (rows)
.env.example (LLM section), README (Generator section), docs/generator.md (new), docs/decisions.md (007 entries)
```

**Structure Decision**: the existing single Next.js app layout. The LLM layer is new under `src/server/llm/`; generation logic lives under `src/server/services/generation/` (constitution IV); data access uses new repositories in `src/server/dal/` (constitution III). UI routes replace the `generate`, `review` and `voice` placeholders.

## Generic changes to existing code

Each is small and is recorded in `docs/decisions.md` with how to reverse it.

1. **`queueTargetsInTx`** (research D15): `addToQueue`'s body after `lockPost` is moved into an exported function. `addToQueue` calls it, so behaviour is unchanged and existing tests must pass untouched.
2. **`validateTargetContent` parameter narrowing** (research D24): `account: AccountRecord` becomes `Pick<AccountRecord, "providerKey">`. This is type-only.
3. **`ensureVariant`** (contracts/llm.md, images): this exports a get-or-build for any `MediaConstraints` by reusing `buildVariant`. Provider variants are unchanged.
4. **The `rejected` review state**: one enum value; `queueableGate` refuses it; a Posts filter tab.
5. **Access statements** `voice` and `generation`.
6. **Startup**: LLM problems are logged, never fatal.
7. **`failFromError`** keeps the messages of `LlmNotConfiguredError` and `PolicyNotAllowedError`.

## Spec notes for later phases

- **FR-014 alt text** (research D9): alt text is asked for once per image, under the strictest targeted limit, not per platform variant, because Docket stores alt text on the media asset. A generated alt text fills only an empty asset alt text; all of them are kept in the generation record. This is logged in `docs/decisions.md`.
- **FR-005 limits** (research R1): the model-input constraints are stricter than the spec's ceilings (2,000 px, 5 MB raw, 24 MB base64 per request). This is within "at most" and stays UNVERIFIED for OpenAI.
- **FR-016 "the request"**: a failure row stores the inputs, not the assembled prompt. The prompt can be rebuilt from the inputs plus the recorded profile version.
- **Regenerate under edit**: regenerate replaces the content even if someone edited the post meanwhile. It is an explicit action, and the earlier record is kept.
- **Delivery order** for `/speckit-tasks`:
  1. LLM types, config, fake and OpenAI;
  2. the Anthropic implementation;
  3. migration and DAL;
  4. prompt, schema and core;
  5. policy and `queueTargetsInTx`;
  6. single mode, then its UI (P1);
  7. voice profiles, then their UI and Try it (P1);
  8. review service and UI (P1);
  9. overrides and settings confirmation (P2);
  10. series (P2);
  11. docs, `llm:check` and final gates.

## Complexity Tracking

No constitution violations, so there is nothing to justify.
