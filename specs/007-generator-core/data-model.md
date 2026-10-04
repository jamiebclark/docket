# Data model: Generator core (007)

One migration, `drizzle/0004_*.sql`, generated with `pnpm db:generate` from the hand-written Drizzle schema (decision 001 #9) and committed. Every new table carries `project_id` and is added to `src/server/db/project-owned.ts` (constitution III). All times are `timestamptz` in UTC.

New schema file: `src/server/db/schema/generation.ts`, exported from `schema/index.ts`. Changed files: `schema/posts.ts` and `schema/projects.ts`.

## Enum changes

| Enum | Change |
|---|---|
| `post_review_state` | add `rejected` → `draft \| needs_review \| approved \| rejected` |
| `post_status` | add `rejected` (the derived status equals the review state when no target is live) |
| `generation_mode` (new) | `single \| series_plan \| series_post \| regenerate` |
| `llm_failure_kind` (new) | `invalid_output \| refused \| incomplete \| timeout \| rate_limited \| unavailable \| auth \| bad_request` |

The existing `approval_policy` and `scheduling_policy` enums are reused.

`ALTER TYPE … ADD VALUE` runs in `0004`, and nothing in `0004` uses the new value (research D19).

## voice_profiles

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `name` | text NOT NULL | 1–80 characters (Zod) |
| `current_version` | integer NOT NULL | ≥ 1; equals the highest `voice_profile_versions.version` |
| `archived_at` | timestamptz NULL | non-null = archived |
| `created_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Constraints and indexes:

- `UNIQUE (project_id, id)`, the target of the composite FKs below.
- Partial `UNIQUE (project_id, lower(name)) WHERE archived_at IS NULL`. The message is "A profile with this name already exists".
- `CHECK (current_version >= 1)`.

## voice_profile_versions (immutable)

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `profile_id` | uuid NOT NULL | composite FK `(project_id, profile_id)` → `voice_profiles(project_id, id)` ON DELETE CASCADE |
| `version` | integer NOT NULL | ≥ 1 |
| `content` | jsonb NOT NULL | `VoiceContent`, see below; validated by `voiceContentSchema` on write and read |
| `author_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at` | timestamptz NOT NULL | |

Constraints:

- `UNIQUE (profile_id, version)`.
- `UNIQUE (project_id, id)`.
- `CHECK (version >= 1)`.

The DAL repository has `insert`, `get`, `getByNumber` and `listForProfile`, and **no update or delete** (research D22).

### VoiceContent (jsonb, `voiceContentSchema` in `src/lib/validation/voice.ts`)

```ts
{
  v: 1,
  voiceAndTone: string,          // ≤ 2,000; "" = empty
  audience: string,              // ≤ 2,000
  topicsAndPillars: string,      // ≤ 2,000
  avoid: string,                 // ≤ 2,000
  examplePosts: string[],        // ≤ 10 items, each 1–3,000
  preferredLinks: { url: string; label: string }[], // ≤ 20; url http(s) ≤ 500; label ≤ 80 ("" allowed)
  preferredHashtags: string[],   // ≤ 30; stored without "#"; /^[\p{L}\p{N}_]{1,100}$/u; de-duplicated case-insensitively
  platformGuidance: Record<string, string>, // keys = registered provider keys only; values ≤ 2,000; "" entries dropped
}
```

All strings are trimmed. A field is "empty" when it is `""` or `[]`. Empty fields are left out of the prompt (contracts/prompt.md).

## projects (changed)

| Column | Type | Rules |
|---|---|---|
| `default_voice_profile_id` | uuid NULL | composite FK `(id, default_voice_profile_id)` → `voice_profiles(project_id, id)` (NO ACTION: profiles are archived, never deleted, except by the project cascade) |

Rules (service layer, under the project lock `transaction(…, { lockProject: true })`):

- The first profile created in a project becomes its default.
- `setDefault` refuses an archived profile.
- `archive` refuses the default.

`ProjectScope.project` gains `defaultVoiceProfileId: string | null`.

## generation_series

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `brief` | text NOT NULL | 1–2,000 |
| `plan` | jsonb NOT NULL | `{ v: 1, angles: { title: string /*1–120*/; description: string /*1–300*/ }[] }`, 1–10 angles, in order |
| `request` | jsonb NOT NULL | the shared `GenerationInputs` minus the angle (voice profile version id, target account ids, media ids, instructions, source text, policies requested and resolved) |
| `planned_count` | smallint NOT NULL | the N asked for (2–10) |
| `created_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at` | timestamptz NOT NULL | |

Constraints: `UNIQUE (project_id, id)`; `CHECK (planned_count BETWEEN 2 AND 10)`.

The plan is fixed once `startSeries` saves it. Editing happens before that, in the browser. Written posts are found by `posts.series_id`.

## generation_failures

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid NOT NULL | FK `projects.id` ON DELETE CASCADE |
| `mode` | `generation_mode` NOT NULL | |
| `series_id` | uuid NULL | composite FK `(project_id, series_id)` → `generation_series(project_id, id)` ON DELETE CASCADE |
| `series_position` | smallint NULL | set together with `series_id` |
| `post_id` | uuid NULL | for `regenerate`: FK `posts.id` ON DELETE CASCADE |
| `inputs` | jsonb NOT NULL | `GenerationInputs` (below) |
| `kind` | `llm_failure_kind` NOT NULL | the final attempt's kind |
| `message` | text NOT NULL | fixed plain sentence (research D3), ≤ 300 |
| `attempts` | jsonb NOT NULL | `{ kind: LlmFailureKind \| "ok" \| "invalid_platform"; latencyMs: number }[]` (1–2 entries) |
| `provider`, `model` | text NOT NULL | |
| `requested_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL |
| `created_at` | timestamptz NOT NULL | |

Index: `(project_id, created_at DESC)`; `CHECK ((series_id IS NULL) = (series_position IS NULL))`.

There is no prompt column: the inputs are enough to rebuild the prompt. FR-016 asks for "the request", which is the inputs. Keys never appear.

## posts (changed)

| Column | Type | Rules |
|---|---|---|
| `generation_request_id` | uuid NULL | client idempotency key (research D13) |
| `scheduling_policy` | `scheduling_policy` NULL | the policy remembered for generated posts (FR-025); NULL for manual posts |
| `series_id` | uuid NULL | composite FK `(project_id, series_id)` → `generation_series(project_id, id)` (NO ACTION: series rows are deleted only by the project cascade) |
| `series_position` | smallint NULL | 0-based angle index; set together with `series_id` |
| `reviewed_by_user_id` | uuid NULL | FK `user.id` ON DELETE SET NULL; last approve or reject |
| `reviewed_at` | timestamptz NULL | |
| `rejection_reason` | text NULL | ≤ 500 |

Constraints and indexes:

- Partial `UNIQUE (project_id, generation_request_id) WHERE generation_request_id IS NOT NULL AND deleted_at IS NULL`.
- Partial `UNIQUE (series_id, series_position) WHERE series_id IS NOT NULL AND deleted_at IS NULL`. This makes a series angle idempotent (FR-023).
- `CHECK ((series_id IS NULL) = (series_position IS NULL))`.
- Index `(project_id, review_state, created_at DESC) WHERE deleted_at IS NULL` for the review queue (newest first, FR-029).

### Review-state transitions

```text
draft ──(generate, initial save)──▶ needs_review          (every generated post starts here, research D12)
needs_review ──applyApprovalPolicy: auto_approve & no blocking issue──▶ approved (+ queue if add_to_queue)
needs_review ──approve / save-and-approve (no blocking issue)──▶ approved (+ queue if remembered add_to_queue)
needs_review ──reject──▶ rejected                          (targets stay draft; never scheduled)
approved|draft ──regenerate with blocking issue──▶ needs_review
needs_review ──regenerate──▶ needs_review
rejected ──(no transition in this entry; delete stays available)
```

The guards are:

- `queueableGate` refuses `needs_review` (existing) and `rejected` (new) for queue, explicit time and publish now.
- Regenerate is refused once any target is past `draft`/`cancelled`.

### Generation metadata (`posts.generation_metadata`)

```ts
{
  v: 1,
  records: GenerationRecord[]   // oldest first; regenerate appends
}

type GenerationRecord = {
  at: string;                    // ISO time
  mode: "single" | "series_post" | "regenerate";
  provider: "openai" | "anthropic";
  model: string;
  voiceProfile: { id: string; versionId: string; version: number; name: string };
  inputs: GenerationInputs;
  prompt: { system: string; user: string; images: { mediaAssetId: string; mode: "url" | "bytes" }[] };
  policies: {
    requested: { approval: ApprovalPolicy | null; scheduling: SchedulingPolicy | null }; // null = default
    resolved: { approval: ApprovalPolicy; scheduling: SchedulingPolicy };
    decision: { reviewState: "needs_review" | "approved"; queued: boolean; reason: string } | null; // null for regenerate
  };
  attempts: { kind: "ok" | "invalid_platform" | LlmFailureKind; latencyMs: number; usage: { inputTokens: number | null; outputTokens: number | null } }[];
  retried: { reason: "invalid_output" | "invalid_platform" | "refused" | "incomplete" | "timeout"; problems: string[] } | null;
  output: { variants: Record<string, string>; imageAltTexts: string[] | null };
  remainingProblems: { providerKey: string; messages: string[] }[]; // non-empty → forced review
};

type GenerationInputs = {
  brief: string;                 // 1–2,000
  sourceText: string | null;     // ≤ 50,000
  instructions: string | null;   // ≤ 2,000 (one-off + regenerate's extra instruction appended as a separate line)
  mediaAssetIds: string[];       // ≤ POST_MEDIA_MAX (10)
  targetAccountIds: string[];    // 1–50, distinct, project accounts
  series: { id: string; position: number; angle: { title: string; description: string }; otherAngles: string[] } | null;
};
```

The existing `createSchema`/`patchSchema` accept `generationMetadata` as a record. The generation service validates the shape with `generationMetadataSchema` (`src/lib/validation/generation.ts`) before writing, and on read for display.

## post_targets (unchanged)

Each target's `override_text` holds its platform's variant (research D10). There is no new column.

## media_assets (unchanged)

A generated alt text is written to `alt_text` only when it was empty (research D9). Model-input images use cached `media_variants` rows keyed by `constraintsHash(LLM_IMAGE_CONSTRAINTS)`, which is the existing table and uniqueness rule.

## Non-persistent entities

- **Policy decision**: `{ reviewState, queue, reason }` from `decidePolicy` (contracts/services.md).
- **Series plan draft**: `{ angles: { title; description }[] }`, held in the browser between `planSeries` and `startSeries`.
- **Try it result**: `{ variants: { providerKey, text, count, limit, countingRule, issues }[], latencyMs }`, never stored.
- **Image generation request/result**: interface only (contracts/llm.md §Image generation).

## Scope registry and tests

- `project-owned.ts` gains four rows: `voice_profiles`, `voice_profile_versions`, `generation_series`, `generation_failures`. The existing query-log test (`tests/helpers/scope-check.ts`) then fails any query on them without `project_id`.
- New repositories are wired through `buildScope`: `voiceProfiles`, `voiceVersions`, `series`, `generationFailures`.
