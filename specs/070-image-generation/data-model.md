# Phase 1 — Data Model: Generate images into the media library

**Feature**: `070-image-generation` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

One migration. **No new table.** Four nullable columns on an existing table, three CHECK
constraints, and one value added to an existing enum. Nothing is dropped, renamed or backfilled.

---

## 1. `media_assets` — four provenance columns (FR-025, G17)

Added to `src/server/db/schema/media.ts`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `generated_at` | `timestamptz` | yes | When Docket received the image from the provider. UTC, like every other instant. |
| `generation_prompt` | `text` | yes | The person's prompt **as typed, trimmed**. Not the prompt sent to the provider — the fixed real-people instruction is appended by the adapter and is not part of what the person wrote (FR-025, G14). |
| `generation_provider` | `text` | yes | The image provider name as used at the time (`openai` today). |
| `generation_model` | `text` | yes | The image model id as used at the time. |

### Constraints

| Name | SQL | Why |
|---|---|---|
| `media_assets_generation_all_or_none` | `(generated_at IS NULL AND generation_prompt IS NULL AND generation_provider IS NULL AND generation_model IS NULL) OR (generated_at IS NOT NULL AND generation_prompt IS NOT NULL AND generation_provider IS NOT NULL AND generation_model IS NOT NULL)` | G17: "was this generated?" has exactly one answer, and no row can claim a prompt without a provider. |
| `media_assets_generation_prompt_shape` | `generation_prompt IS NULL OR length(generation_prompt) BETWEEN 1 AND 1000` | FR-012's bound, enforced at the last line too. A column that cannot hold more than a prompt cannot hold a provider payload. |
| `media_assets_generation_model_shape` | `generation_model IS NULL OR (length(generation_model) BETWEEN 1 AND 200 AND generation_model !~ '\s')` | Mirrors `llm_call_usage_model_shape` and `project_llm_settings_model_shape` verbatim. |
| `media_assets_generation_provider_shape` | `generation_provider IS NULL OR length(generation_provider) BETWEEN 1 AND 50` | **P12**: a *length* bound, never a value list — a value list would make a second adapter need a migration, which SC-007 forbids. |

### What is deliberately absent

- **No index.** Provenance is read with the row it is on. There is no "Generated" filter, no
  library view and no search over prompts (G20, FR-027), so an index would serve nothing.
- **No `jsonb` blob.** G17: four named text columns are the smallest surface a credential, a request
  id or a raw provider payload could be smuggled into, and the only one the secrets rule is easy to
  keep on.
- **No side table.** At most one row per asset, no history — an asset is generated once (G17). A
  table would buy a join and a second authorization surface for nothing.
- **No `generated_by_user_id`.** `created_by_user_id` already carries the actor, written by
  `actorColumns(tx)` in `commitUpload` exactly as it is for an upload.
- **No new `kind`, no new `processing_state`.** A generated asset is `kind = 'image'` and
  `processing_state = 'ready'` the moment its row is written, like any image upload (US2-5).
- **No backfill.** Every existing row keeps four nulls, which is the correct answer for an upload
  (US5-3).

### Lifecycle

| Event | Effect on provenance |
|---|---|
| Generation succeeds | The four columns are written **in the same insert as the rest of the row**, inside the caller's transaction (`commitUpload`). There is no second write and no update. |
| Upload | All four stay null. `commitUpload` receives no `generation` meta. |
| Alt text / tag edit | Untouched — `updateAlt` and the tag update name only their own columns. |
| Asset deleted | Gone with the row. Deletion is the existing `deleteMedia` path, including the live-post protections (US2-4, spec edge case). |
| Project deleted | `ON DELETE CASCADE` from `projects`, already in place. |

---

## 2. `llm_usage_purpose` — one new value (FR-019, G12)

`src/server/db/schema/generation.ts`'s `llmUsagePurpose` pgEnum gains `image.generate`, making
**eight** values. Mirrored in three hand-maintained places, each with a guard:

| Place | Change | Guard |
|---|---|---|
| `UsagePurpose` in `src/server/llm/usage.ts` | `\| "image.generate"` | TypeScript — `USAGE_PURPOSE_LABELS` is a `Record<UsagePurpose, string>` and fails to compile without the label. |
| `USAGE_PURPOSE_LABELS` in `src/lib/generation/usage-purpose.ts` | `"image.generate": "Generated image"` | as above |
| `USAGE_PURPOSES` in `src/server/llm/no-missing-usage-purpose.test.ts` | the closed list, and "seven call sites" becomes **eight** | the test itself: it fails until both the list and the one new `label:` literal exist |

`llm_call_usage` itself is **unchanged** — no new column. An image call fills the same row:
`provider`, `model`, `credential_source`, `ok`, `failure_kind`, `input_tokens`, `output_tokens`,
`latency_ms`, `called_at`, with every link column null (an image call belongs to no post, series or
job — FR-019 and the spec's "does not wire image generation into jobs").

`llm_call_usage_provider` CHECKs `provider IN ('openai','anthropic')`. The only image provider value
this entry can produce is `openai`, so the constraint holds untouched; a future adapter for a third
vendor widens it in its own migration, which is that entry's cost, not this one's.

Token counts follow the ledger's existing rule exactly: written when `ImagesResponse.usage` is
present, **null** when it is not, never coerced to zero (FR-019; the SDK documents `usage` as
present for one model family only).

---

## 3. Entities that exist only in memory

These are shapes, not tables. Full signatures are in [contracts/services.md](./contracts/services.md).

### `ImageGenerationRequest` / `ImageGenerationResult` (unchanged, `src/server/llm/image-generation.ts`)

Declared on `main` and kept exactly as declared (G4, FR-008):
`{ projectId, prompt, aspect?: "square" | "portrait" | "landscape", size?: { width, height } }`
and `{ ok: true; mediaAssetId } | { ok: false; message }`.

Not stored. Its prompt survives as the asset's provenance; nothing else about it does.

### `ImageProviderRequest` / `ImageProviderResult` (new, vendor-neutral)

What the abstract layer hands an adapter and gets back (G5, FR-010): a label, a prompt **already
carrying the real-people instruction**, an aspect, an optional size, an optional signal; and either
bytes with a MIME type, or a `LlmFailureKind` — plus `usage`, `latencyMs`, `provider` and `model`
in both cases, which is what the ledger needs.

Invariant: **no pixel size, output format, response field or vendor error code appears in this
type or above it.** A second adapter is a new file plus one value in `LLM_IMAGE_PROVIDER` (SC-007).

### `LlmImageConfig` (new, `src/server/llm/config.ts`)

`{ provider: LlmImageProviderName; model: string; apiKey: string; timeoutMs: number }`.

Note what it does **not** carry: `maxOutputTokens` (FR-007 — a text-only cap that must not travel
to an image provider). `timeoutMs` is the install-wide one, from the same `parseLlmLimits` the text
path uses.

### `ResolvedImageLlm` (new, `src/server/llm/resolve.ts`)

Mirrors `ResolvedLlm`: `{ ok: true; source: "project" | "install"; provider; model; owner; timeoutMs; image }`
or `{ ok: false; reason: "not_configured"; problems }` or `{ ok: false; reason: "key_unreadable" }`.

Three invariants, each a success criterion:

1. `model` is **always** the install's `LLM_IMAGE_MODEL` (**P4**); only the key varies by source.
2. `owner` is `projectCredentialOwner(projectId)` when `source === "project"` and
   `INSTALL_CREDENTIAL_OWNER` otherwise — the same owner the text path would compute for the
   credential actually used (G9, FR-017, US3-5).
3. `key_unreadable` **never** falls back to the install's credential (FR-006, US3-6).

### `MediaView.generated` (new field on an existing view)

`{ prompt: string; provider: string; model: string; at: Date } | null`, mapped from the row by
`toView`. Null for every uploaded asset. This is the only new thing any screen reads (FR-035).

---

## 4. Relationship to what already exists

```text
projects ──┬── media_assets ──┬── media_variants        (derived on demand, unchanged)
           │   + 4 provenance │
           │     columns      └── post_media            (attachment, unchanged)
           │
           └── llm_call_usage  (one row per image call that reached the provider;
                                purpose = 'image.generate', all link columns null)

llm_credit_holds  (system-wide, owner = "install" | "project:<id>")
      ▲
      └── written by the SAME applyCreditOutcome() a text refusal uses (G10, FR-017)
```

A generated asset is reachable by exactly the paths an uploaded one is: `scope.media.list`,
`scope.media.get`, the selection queries, the variant cache, the fit checks, the composer's picker,
the job reservation and `deleteMedia`. None of them changes, and none of them learns a new branch
(FR-024, FR-028, SC-002).

---

## 5. Migration

One file, generated by `pnpm db:generate` and committed (FR-025):

```sql
ALTER TYPE "public"."llm_usage_purpose" ADD VALUE 'image.generate';--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_provider" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_model" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_all_or_none" CHECK (...);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_prompt_shape" CHECK (...);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_model_shape" CHECK (...);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_provider_shape" CHECK (...);
```

(Illustrative — the committed file is whatever `drizzle-kit generate` emits for the schema change
above, and `pnpm db:check` is what proves the two agree. **P14** records that the enum value is
added but not used in the same transaction, which is what Postgres requires, and that eight
existing migrations already use `ALTER TYPE … ADD VALUE` this way.)

Forward-only. Additive. Safe on a table with rows: every new column is nullable and every CHECK is
satisfied by four nulls, so no existing row is rewritten beyond the catalogue change.
