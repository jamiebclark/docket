# Implementation Plan: Generate images into the media library, behind the existing ImageGenerator extension point

**Branch**: `070-image-generation` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/070-image-generation/spec.md`

Roadmap `.specify/roadmaps/content-engine-roadmap.json`, entry **2 of 6**, slug `image-generation`.

---

## Summary

`src/server/llm/image-generation.ts` has declared `ImageGenerationRequest`, `ImageGenerationResult`
and `ImageGenerator` since the generation entries landed, with a comment saying it is an extension
point and a test asserting it has no runtime exports. This entry implements it.

Three layers, each of which already has a twin in the codebase:

1. **An image provider group**, configured and resolved exactly like the text one —
   `LLM_IMAGE_PROVIDER` and `LLM_IMAGE_MODEL` parsed in `config.ts`, spending the vendor's existing
   `OPENAI_API_KEY`, resolved per project in `resolve.ts` so a project with its own matching
   credential spends its own credit and owns its own credit hold. Everything vendor-specific — the
   aspect-to-size table, the requested format, how bytes are read, how an error is classified —
   lives in **one** adapter file selected by configuration; nothing above it knows a pixel.
2. **One generator service** that turns bytes into an ordinary library asset by calling the
   **existing** `uploadMedia` path: content-sniffed type check, animated refusal, byte and
   megapixel limits, metadata stripped, re-encode, 480 px WebP thumbnail, both objects under
   `projects/<projectId>/`, the row written in the caller's transaction, objects discarded if the
   row write fails. Variants, fit checks and every per-platform constraint therefore apply with no
   generated-image branch anywhere.
3. **One action on the Media page**, owner/admin only behind a new `media: ["generate"]` statement,
   inside the branch that already disappears when storage is off.

The shared machinery is **shared, not copied**: the billing-hold decision is extracted into one
`applyCreditOutcome` that both the text wrapper and the image wrapper call (the roadmap's actual
requirement — "the same hold path as a text refusal"), and the usage recorder gains a `wrapImage`
beside its `wrap`, so one buffer and one flush rule serve both.

Provenance is **four named, nullable columns** on `media_assets` with an all-or-nothing CHECK, not
a blob and not a side table. One migration carries those columns and one new
`llm_usage_purpose` value, `image.generate`.

One new permission (code only), two new environment variables, one migration, **no new runtime
dependency, no new infrastructure, no new table, no job, no API surface**.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS, pnpm

**Primary Dependencies**: Next.js 16 (App Router, standalone output), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, `openai` **7.27.0**, `sharp`, `@aws-sdk/client-s3`,
Tailwind 4, Vitest. **No new runtime dependency** (constitution VI) — every package needed is
already in `package.json`.

**Storage**: Postgres (four nullable columns and four CHECKs on `media_assets`; one value added to
the `llm_usage_purpose` enum; one forward-only SQL migration, no new table, no backfill) plus
S3-compatible object storage through the existing `Storage` interface and `mediaKeys`.

**Testing**: Vitest — unit tests for the config parse table, the adapter's request body, size
mapping, response reading and error classification (mocked HTTP via `createFakeLlmFetch`), and the
two message maps; integration tests against a real Postgres for the asset write, provenance,
variants and fit parity, the credit hold, the usage ledger, authorization, project isolation, the
three gate states and the extended secret scan. **No test makes a live provider call**
(constitution II); every image comes from a stubbed `ImageProvider` or mocked HTTP through the
`setImageProviderForTests` / `setImageProviderFactoryForTests` seams.

**Target Platform**: Linux server — Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. No session-level Postgres features.

**Project Type**: Web application — Next.js App Router monolith plus a worker, services in
`src/server/services/`, data access in `src/server/dal/`.

**Performance Goals**: none asserted. The call runs in-request under the install-wide
`LLM_TIMEOUT_SECONDS` (10–600, default 90), like single-post generation and voice "Try it". The
spec records image latency as `NEEDS RESEARCH`; `docs/research/` has no figure, phases cannot fetch
the web, and **nothing in the design depends on one** — the ledger reports what was actually spent
rather than predicting it.

**Constraints**: no model identifier anywhere in `src/` outside comments; `OPENAI_API_KEY` readable
in exactly one file and the ciphertext column nameable in exactly three, both guards unchanged;
one image per request; prompt 1–1000 characters after trimming; a fixed real-people instruction on
**every** prompt sent; no credential, SDK error text or raw provider payload in any stored row, log
line, message or rendered screen; a generated asset indistinguishable from an uploaded one to every
downstream path; "both stored objects and the row, or neither"; no job, no queue, no retry, no
cooldown, no quota, no spend cap.

**Scale/Scope**: one image per request, owner/admin only; four columns, one enum value, one
migration; three new `src/server/llm/` files, one new service, one new client component, three
existing files extended in the UI; one new permission; two new environment variables; roughly eight
new test files plus four extended ones.

**No `NEEDS CLARIFICATION` remains.** One of the spec's two `NEEDS RESEARCH` items is **closed** by
reading the installed SDK (the content-policy marker does not exist there — see
[research.md](./research.md) § 2); the other (latency and price) remains open, is recorded, and
blocks nothing.

---

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1 design. Both evaluations below.*

| Principle | How this design satisfies it | Post-design verdict |
|---|---|---|
| **I. Verified facts over memory** (non-negotiable) | Every external fact comes from `node_modules/openai`'s own type declarations, cited by file in [research.md](./research.md) § 2 — the endpoint, the parameter list, the three standard sizes, the base64 response rule, the prompt ceilings, the `usage` caveat and the error classes. `docs/research/llm-and-storage.md` covers image **input** only and is said so. The one fact the SDK does **not** carry — the identity of a content-policy refusal on the images endpoint — is closed as "no such documented value", and the refusal sets ship **empty but named** rather than carrying a guess (**P6**). No price, no latency and no model id is asserted anywhere. | **PASS** |
| **II. Nothing is "working" unless it ran** | Every success criterion has a named runnable check in [quickstart.md](./quickstart.md), §§ 1–10. All provider behaviour is exercised with `createFakeLlmFetch` and stubbed `ImageProvider`s; the manual real-API walkthrough is listed separately and everything else is reported as **"verified with mocks only"** until someone runs it. | **PASS** |
| **III. Project isolation enforced in one place** | No new table, so no new scoped surface: the asset is written by `uploadMedia` → `commitUpload` through `scope.media`, inside `scope.transaction`, with keys from `mediaKeys(scope.project.id, assetId)`. `createImageGenerator(scope)` binds the contract to a membership scope and **refuses a request naming another project** (**P15**), so the declared `projectId` can never widen access. `tests/integration/scope-check.test.ts` already covers `media_assets`; the four new columns ride on it. Roles are checked on the server regardless of what the UI rendered. | **PASS** |
| **IV. One service layer, many callers** | One adapter interface, one generator service (`src/server/services/media-generate.ts`), one writer (`uploadMedia`), one hold rule (`applyCreditOutcome`), one recorder. The server action is a thin `runAction` wrapper; the contract's `ImageGenerator` is a second façade over the **same** service function, not a second implementation. | **PASS** |
| **V. Providers are plug-ins** | No social provider, scheduler, composer or schema change for publishing. The LLM providers are untouched — the image adapter is a sibling file, and the hold and usage decorators wrap it from outside exactly as they wrap a text provider. Adding a second image vendor is one file plus one `LLM_IMAGE_PROVIDER` value (**SC-007**, proved by the `grep` in quickstart § 10). | **PASS** |
| **VI. Boring, few dependencies** | `openai`, `sharp` and the S3 client are already in `package.json`; nothing is added. No queue, no Redis, no new infrastructure. One migration, no new table. Configuration lives in environment variables, where every other operator setting already lives. | **PASS** |
| **VII. Secrets never leak** | The key is read in `config.ts` only and decrypted in `resolve.ts` only — both existing guard tests unchanged (**P3**). Provenance is four text columns bounded at 1000 / 200 / 50 characters holding a prompt, a provider name, a model id and an instant; a credential cannot fit the schema's intent and never reaches the write, which takes its values from the resolved provider, not from any config object (**P12**, data-model § 1). Every user-facing sentence is fixed and chosen from two closed maps; no SDK error text or provider payload is ever rendered or stored. The existing scanned secret-scan run is **extended** with a generated image and the Media page for all three roles, never exempted (**P24**). | **PASS** |
| **Engineering: Neon-safe, no session-level features** | Plain inserts and selects, no advisory locks, no `LISTEN`. The migration is additive and forward-only; `ALTER TYPE … ADD VALUE` adds the value without using it in the same transaction, which is what Postgres requires and what eight existing migrations already do (**P14**). | **PASS** |
| **Engineering: `runTick()` bounded, killable, concurrent-safe** | **The tick is not touched.** No job, no queue item, nothing for the runner to claim (the spec's out-of-scope list; `evergreen-series` owns that). Two concurrent requests for the same project produce two assets with distinct ids and distinct key prefixes and cannot collide (spec edge case). | **PASS** |
| **Engineering: UTC storage, Temporal where wall time matters** | `generated_at` is `timestamptz`, always UTC, from the same clock everything else uses. No wall-time arithmetic exists in this feature, so no Temporal conversion and no DST question arises; the card shows the asset's existing `createdAt` through the shared formatter as it already does. | **PASS** |
| **Engineering: accessibility, server components, `docket-ui`** | One client component — the dialog — because it holds interactive state; the page, the card and the badge stay server components. Labelled controls, `<fieldset>`/`<legend>` for the aspect group, a three-option `ChoiceField` (never a native `<select>`), pending state on the button, a kept-mounted `LiveRegion`, focus trapped and returned by the shared `Dialog`, semantic tokens only, all four states handled. See [contracts/ui.md](./contracts/ui.md). | **PASS** |
| **Workflow: commits, quality gates, docs** | Conventional Commits with the required trailer, explicit paths only. `pnpm db:check` and `pnpm build` are in the final pass because the schema and a route changed. FR-038's five documents (`docs/generator.md`, `docs/storage.md`, `docs/security.md`, `.env.example`, `docs/decisions.md`) are tasks, not afterthoughts. | **PASS** |

**No violations. [Complexity Tracking](#complexity-tracking) is therefore empty.**

Three points worth naming so review judges them rather than discovering them:

1. **An enum value is added** (`llm_usage_purpose.image.generate`), and the
   `no-missing-usage-purpose.test.ts` guard widens from seven call sites to eight. That test exists
   precisely to make this a deliberate, reviewed widening; G12 chose to pay it.
2. **A new permission statement** (`media: ["generate"]`). Code only — roles live in
   `src/server/auth/access.ts`, not in a table — so no migration, but
   `src/server/auth/access.test.ts`'s matrix must name it for all three roles or the suite fails.
3. **Two refusal sets ship empty** (`OPENAI_IMAGE_REFUSAL_TYPES` / `_CODES`). That is the honest
   consequence of constitution I: the installed SDK names no refusal marker for this endpoint, so
   a content refusal reads as `bad_request` until one is observed. The alternative — copying
   `content_policy_violation` from the Responses API, which is about an *input* image — is exactly
   the class of guess that research A5 got wrong for credit refusals.

---

## Project Structure

### Documentation (this feature)

```text
specs/070-image-generation/
├── spec.md                 # input
├── plan.md                 # this file
├── research.md             # Phase 0 — decisions P1–P24 with the sources they came from
├── data-model.md           # Phase 1 — the four columns, the enum value, the in-memory shapes
├── contracts/
│   ├── config.md           #   the two variables, the parse table, startup, resolution, the registry
│   ├── services.md         #   the contract, the adapter, the hold, the ledger, the generator
│   └── ui.md               #   the gate, the dialog, the announcements, the card's provenance
├── quickstart.md           # Phase 1 — runnable validation, SC-001…SC-010
└── tasks.md                # Phase 2 — /speckit-tasks, NOT created here
```

### Source code (repository root)

```text
src/
├── server/
│   ├── db/schema/
│   │   ├── media.ts                      # + 4 provenance columns, 4 CHECKs (CHANGED)
│   │   └── generation.ts                 # + 'image.generate' in llmUsagePurpose (CHANGED)
│   ├── llm/
│   │   ├── image-generation.ts           # + IMAGE_ASPECTS, IMAGE_PROMPT_MAX, NO_REAL_PEOPLE (CHANGED)
│   │   ├── image-provider.ts             # NEW  ImageProvider/Request/Result, registry, test seams
│   │   ├── openai-image.ts               # NEW  the only file that knows a pixel or a response field
│   │   ├── image-messages.ts             # NEW  one fixed sentence per LlmFailureKind, image wording
│   │   ├── config.ts                     # + LlmImageConfig, parseLlmImageConfig, LLM_IMAGE_VARIABLES,
│   │   │                                 #   llmImageEnvIssues (CHANGED)
│   │   ├── openai.ts                     # + export kindOfError (CHANGED — no behaviour change)
│   │   ├── resolve.ts                    # + resolveImageLlmForProject (CHANGED — P3)
│   │   ├── usage.ts                      # + "image.generate" purpose, wrapImage (CHANGED)
│   │   └── images.ts                     # - private NOT_SET_UP, + import of the shared one (CHANGED)
│   ├── storage/index.ts                  # + MEDIA_STORAGE_NOT_SET_UP (CHANGED)
│   ├── startup/validate.ts               # + llmImageEnvIssues, + the "image generation is off" line
│   ├── auth/access.ts                    # + media:["generate"] on statements, owner, admin (CHANGED)
│   ├── dal/media.ts                      # + the 4 columns in NewMedia (CHANGED)
│   └── services/
│       ├── media-generate.ts             # NEW  imageGenerationEnabled, createImageGenerator, generateImage
│       ├── media.ts                      # + generation meta on uploadMedia/commitUpload, + view field
│       └── generation/credit.ts          # + applyCreditOutcome, withImageCreditHold (CHANGED)
├── lib/
│   ├── generation/usage-purpose.ts       # + the "Generated image" label (CHANGED)
│   └── validation/media.ts               # + generateImageSchema (CHANGED)
├── components/media/MediaCard.tsx        # + "Generated" badge and the prompt disclosure (CHANGED)
└── app/p/[projectSlug]/media/
    ├── page.tsx                          # + the gate and the trigger, in both storage-on branches
    ├── GenerateImageDialog.tsx           # NEW  the only client component this entry adds
    └── actions.ts                        # + generateImageAction (CHANGED)

drizzle/
└── <n>_generated_image_provenance.sql    # NEW  pnpm db:generate, committed

tests/
├── integration/media/
│   ├── generate.test.ts                  # NEW  US1 — the happy path, the refusals, nothing orphaned
│   ├── generated-is-ordinary.test.ts     # NEW  US2 / SC-002 — fit parity, variants, filters, delete
│   ├── generated-provenance.test.ts      # NEW  US5 / SC-004 — the four columns, the CHECK, isolation
│   └── generate-gates.test.tsx           # NEW  US4 / SC-006 / SC-008 — three states × page and action
├── integration/llm/
│   ├── image-hold.test.ts                # NEW  US3 / SC-003 — hold, refresh, clear, swallow, owners
│   ├── image-usage.test.ts               # NEW  SC-009 — recorded when reached, never when not
│   └── image-prompt.test.ts              # NEW  SC-010 — the instruction, asserted directly
├── integration/security/secret-scan.test.ts   # EXTENDED — a generated image + Media page × 3 roles
├── lint/env-coverage.test.ts             # EXTENDED — LLM_IMAGE_VARIABLES in CONFIGURABLE
└── (unit) src/server/llm/openai-image.test.ts, image-messages.test.ts,
        config.test.ts (EXTENDED), image-generation.test.ts (REWRITTEN),
        no-missing-usage-purpose.test.ts (EXTENDED), auth/access.test.ts (EXTENDED)

docs/
├── generator.md            # + "Generating images"; - image generation from "Out of scope"
├── storage.md              # + image generation requires storage and obeys the same limits
├── security.md             # + one row for the provenance columns and the generate action
├── decisions.md            # + "## 060 — Generated images in the media library" with G1–G26, P1–P24
└── .env.example            # + LLM_IMAGE_PROVIDER, LLM_IMAGE_MODEL in the Generator group
```

**Structure Decision**: the existing single-app layout, unchanged. The adapter and its registry sit
in `src/server/llm/` beside `openai.ts`, `resolve.ts` and `usage.ts`, which is where non-DAL LLM
code already lives; the generator is a service because it writes a project-owned row
(constitution IV); the interface is one dialog on the page the roadmap named, with no new route.

---

## Plan decisions

Recorded in `docs/decisions.md` as **P1–P24** under a new `## 060 — Generated images in the media
library` heading, after the spec's **G1–G26**. Full rationale and the source each came from are in
[research.md](./research.md) § 3.

| # | Decision |
|---|---|
| **P1** | A third environment group, `LLM_IMAGE_VARIABLES`, **outside** `LLM_VARIABLES`, with its own `llmImageEnvIssues` — otherwise `llmEnvIssues` would demand `LLM_PROVIDER` from an install that only wants images (068 **P9**'s precedent). |
| **P2** | A partially configured image group is a startup **issue**, not a warning — G1 says "the same rule", and a half-set provider is a typo, not a guess. |
| **P3** | Image resolution lives **inside `resolve.ts`**: `key-reads.test.ts` allows the ciphertext column in exactly three files, and FR-004 requires that guard to stay green unchanged. |
| **P4** | A project's own credential supplies the **key only**; the model is always `LLM_IMAGE_MODEL`. A project's stored *text* model sent to an images endpoint is a guaranteed `bad_request`. |
| **P5** | The image client runs with **`maxRetries: 0`**. A paid, non-idempotent call must not be retried by the SDK (G24). |
| **P6** | The adapter reuses the exported `kindOfError` and adds `OPENAI_IMAGE_REFUSAL_TYPES` / `_CODES`, **empty today** because the installed SDK names no refusal marker for this endpoint; the classifier takes the sets as a parameter so a test proves the one-line widening. |
| **P7** | `ImageProviderRequest` carries a `label` and the adapter calls `logLlmCall` — without it the usage-purpose guard cannot see `image.generate`, and the image call would be the only provider call with no log line. |
| **P8** | The hold decision is extracted once as `applyCreditOutcome(owner, kind)`; `withCreditHold` and `withImageCreditHold` are thin wrappers. `UsageRecorder` gains `wrapImage`, sharing one buffer and one flush. |
| **P9** | The adapter's aspect table is the only place pixels exist; an explicit `size` is passed through after a positive-integer check only, because the provider is the arbiter (G2/G6). |
| **P10** | `n: 1`, `output_format: "png"`, and nothing else — no `moderation`, `quality`, `background`, `stream`, `response_format`, `user` or token cap. |
| **P11** | The bytes go through **`uploadMedia`**, extended with an optional `generation` meta: it is the only composition that already gets FR-023's discard-on-failure right. |
| **P12** | `generation_provider` gets a **length** CHECK, never a value list — a value list would make a second adapter need a migration, which SC-007 forbids. |
| **P13** | `MEDIA_STORAGE_NOT_SET_UP` moves to `src/server/storage/index.ts`; `images.ts` imports it. One constant, two callers, one test that they are identical. |
| **P14** | One migration file for both changes; the enum value is added but not used in the same transaction, as eight existing migrations already do. |
| **P15** | `createImageGenerator(scope)` binds the declared contract to a scope and refuses a request naming another project — the declared signature is kept, and constitution III is satisfied. |
| **P16** | `image-generation.ts` gains the contract's **vocabulary** only (`IMAGE_ASPECTS`, `IMAGE_PROMPT_MAX`, `NO_REAL_PEOPLE`), never the implementation; its test is rewritten to "vocabulary and no vendor value". |
| **P17** | Authorization **throws** `ForbiddenError`; every other refusal is returned. The contract's `message` is for refusals a person can act on. |
| **P18** | No `AbortSignal` is passed from the action, and a signal a caller does supply reaches the **provider call only** — never storage or the database, so "both or neither" holds by construction. |
| **P19** | `media: ["generate"]` on `statements`, owner and admin; the access matrix test is exhaustive by construction and fails until it is named for all three roles. |
| **P20** | The page's gate is a new `imageGenerationEnabled(scope)` read, not a widened `MediaStatus` — the Jobs page and the Overview service read `mediaStatus` and have no interest in image configuration. |
| **P21** | The trigger renders in **both** storage-on branches of the Media page; the empty-library branch is exactly the state a first generated image should be able to leave. |
| **P22** | Provenance renders as a `Badge` plus a native `<details>` disclosure — keyboard-operable with no JavaScript, and a 1000-character prompt need not fit a tile. |
| **P23** | The aspect control is a three-option `ChoiceField`, which renders a `SegmentedControl`, per the `docket-ui` rule against a native `<select>` for one-of-many. |
| **P24** | The secret scan and the env-coverage probe are **extended, never exempted**; `docs/security.md` gains one row (068 **P17**'s precedent). |

### Two things the spec says that the code does not allow, resolved

Named here so the next phase does not rediscover them, and so review judges the resolution rather
than the surprise.

1. **"Startup reports the missing name and reason … and everything else keeps working" versus
   G1/FR-005's "the same rule `llmEnvIssues` already applies".** A half-set text group is a fatal
   startup issue today; a half-set image group cannot be both that and non-fatal. Resolved in
   **G1/FR-005's** favour (**P2**): a partially configured image group stops startup with the name
   and the reason, exactly as text does, because it is the same class of operator typo and one rule
   beats two. The sentence's real subject — the **unconfigured** case — is honoured exactly:
   `disabled.push("image generation is off (LLM_IMAGE_PROVIDER not set)")`, and nothing else in
   Docket changes (FR-001).

2. **"`image-generation.test.ts` … is the thing this entry retires" versus constitution IV.** The
   generator writes a project-owned row, so it is a service, not an LLM-layer module; putting the
   implementation in `src/server/llm/image-generation.ts` would drag the media service into the LLM
   layer. Resolved by **P16**: the module keeps the contract and gains the contract's *vocabulary*,
   which genuinely belongs with it (the UI needs the aspect list; the prompt bound is part of the
   request's shape; the real-people instruction is part of every request). The test is **rewritten**
   rather than deleted — from "no runtime exports" to "exports the vocabulary and no vendor value" —
   so the module is still guarded against becoming a place where a pixel size or a model id can
   hide.

### One claim in the roadmap that is not true of this repository

The roadmap states that "the project's own voice profiles already forbid using a real child's
likeness". The spec checked and found nothing in `src/` or `docs/` that does. That rule lives in an
individual project's voice-profile *content* — operator-entered data a different install would not
have. This entry therefore adds it **in code** for the first time, as `NO_REAL_PEOPLE`, appended by
the adapter layer to every prompt and asserted directly by **SC-010** (G14).

---

## Phase 0 — Outline & Research

**Output**: [research.md](./research.md) — complete.

Twenty-four decisions (**P1–P24**), each with a *Decision / Rationale / Alternatives considered*
and the file it was read from: what exists on `main` and where each seam is; the installed SDK's
own declarations for `images.generate`, its parameters, its response shape, its size and prompt
limits, its `usage` caveat and its error classes; how the configuration group must sit beside the
existing two without disturbing either; which guard tests constrain where code may live; how the
hold and the ledger are shared rather than copied; and what the interface may and may not show.
§ 2 closes the spec's content-policy `NEEDS RESEARCH` as "no such documented value in the installed
SDK" and § 4 lists what Docket deliberately still does not know.

## Phase 1 — Design & Contracts

**Outputs**: [data-model.md](./data-model.md), [contracts/config.md](./contracts/config.md),
[contracts/services.md](./contracts/services.md), [contracts/ui.md](./contracts/ui.md),
[quickstart.md](./quickstart.md) — complete.

- **data-model.md** — the four provenance columns with their four CHECKs and what is deliberately
  absent; the provenance lifecycle event by event; the enum value and its three mirrored places
  with the guard on each; the in-memory shapes (`ImageProviderRequest/Result`, `LlmImageConfig`,
  `ResolvedImageLlm`, `MediaView.generated`) with the invariants that make the success criteria
  true; the relationship to everything that already exists; and the migration, with "no backfill"
  stated.
- **contracts/config.md** — the two variables with their `.env.example` blocks, a row-by-row parse
  table including every rejection and the "never a value" rule, the startup wiring, the resolution
  order with its three invariants, and the registry's signatures. Ends with what configuration
  deliberately does not gain.
- **contracts/services.md** — the contract module's new vocabulary; the vendor-neutral provider
  interface and the one invariant that makes SC-007 true; the image sentence map; the OpenAI
  adapter concern by concern with the source for each; the shared hold rule; the recorder's new
  method; the generator's nine ordered steps with what each failure returns; the media-service
  changes; the shared storage sentence; the permission. Ends with what the service layer does not
  gain.
- **contracts/ui.md** — where the action lives, the gate's four states, the trigger, the dialog's
  controls, the five interface states and their announcements, the server action's shape,
  provenance on the card, an accessibility checklist, and what the interface does not gain.
- **quickstart.md** — ten runnable checks mapping **SC-001 – SC-010** to commands and expected
  assertions, plus a real-app walkthrough and a "done when" list.

## Phase 2 — Tasks

**Not produced by this command.** `/speckit-tasks` generates `tasks.md` from these artifacts.

Suggested ordering, following the spec's own priorities:

1. Schema + migration + `NewMedia` + `pnpm db:check` (nothing else can land without the columns).
2. Configuration, resolution and the registry (contracts/config.md) with its unit tests.
3. The adapter and the two message maps (contracts/services.md §§ 2–4) with mocked-HTTP tests.
4. The shared hold extraction and the recorder's `wrapImage` — **before** the generator, so the
   generator is written against the shared code rather than being refactored into it.
5. The generator service plus the `uploadMedia` / `commitUpload` / `toView` extension — **US1 and
   US2 (both P1) land here**, and with them SC-001 and SC-002.
6. The permission, the page gate, the dialog and the action — **US4**, and the rest of US1.
7. Provenance on the card and the usage purpose end to end — **US5**.
8. The hold tests — **US3** — which need nothing new, only the wiring from step 4.
9. The secret-scan extension, the env-coverage extension and FR-038's five documents.

US1 and US2 must land first and stand together: a generated image that needs special handling
downstream is a liability rather than a feature, so the parity assertions in quickstart § 2 are
part of the first slice, not a follow-up.

---

## Complexity Tracking

No constitution violations, so this section is empty by design.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | | |

---

## What this plan does not do

Carried from the spec's own out-of-scope list; each item has a named owner or a stated reason.

- **No wiring into the post generator.** A post that needs an image still gets one from the
  library, chosen by a person. Prompt composition is untouched (G15).
- **No wiring into jobs.** No queue, no batch, no scheduler work, nothing for the tick to claim —
  `evergreen-series` is the entry that makes a standing series produce its own images.
- **No images of real people.** A fixed instruction on every call, a sentence in the UI, a line in
  the docs — and deliberately **no** detection or local refusal (G14).
- **No video generation**, no image editing, variation, upscaling, inpainting or regeneration in
  place. One prompt, one image, one asset.
- **No brand context in an image prompt.** Entry 1's tagline, description and website are text to
  say, not a thing to draw (G15).
- **No per-project image provider or model**, no "Generated" library filter, no automatic tag, and
  no image-generation surface on the public API — `setup-write-api` owns the API.
- **No cap, quota, cooldown or spend gate**, and no change to `LLM_RATES`. Docket reports what was
  spent and does not predict or limit it (G25).
- **No change** to the credit-hold mechanics, the per-project credential storage or check, the
  usage ledger's shape, either failure-kind `pgEnum`, `logLlmCall`'s fields, or any social provider.
