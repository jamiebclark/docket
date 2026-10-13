# Data model: LLM cost visibility

**Feature**: `068-llm-cost-visibility` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

One new table, one new enum, one new index pair, one migration. No change to any existing table, to
either failure-kind `pgEnum`, to `LlmFailureKind`, or to `logLlmCall`'s shape.

---

## 1. `llm_call_usage` — the ledger

Project-owned, insert-only, one row per model call that reached the provider and returned
(**M1**, **M2**, **FR-001**, **FR-007**). Added to `src/server/db/schema/generation.ts` beside
`projectLlmSettings`; registered in `src/server/db/project-owned.ts` as
`{ table: "llm_call_usage", scopeColumn: "project_id" }`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` PK | no | `default gen_random_uuid()`, as every other table here |
| `project_id` | `uuid` | no | `references projects.id on delete cascade` (**M19**: rows live as long as their project) |
| `purpose` | `llm_usage_purpose` | no | the call site, see §2 |
| `provider` | `text` | no | `openai` or `anthropic`, as the call reported it |
| `model` | `text` | no | the **literal string used**, never a reference (**M4**) |
| `credential_source` | `text` | no | `project` or `install`, from `ResolvedLlm.source` (**M4**) |
| `ok` | `boolean` | no | the **provider's** outcome, not Docket's acceptance of it (**P7**) |
| `failure_kind` | `llm_failure_kind` | yes | null exactly when `ok` (**P6**) |
| `input_tokens` | `integer` | yes | as reported; **null is never 0** (**M3**) |
| `output_tokens` | `integer` | yes | as reported; **null is never 0** (**M3**) |
| `latency_ms` | `integer` | no | rounded, as the log line already rounds it |
| `called_at` | `timestamptz` | no | when **this** call happened — not when the row was written (**M17**, deferred retries) |
| `post_id` | `uuid` | yes | `references posts.id on delete cascade` |
| `series_id` | `uuid` | yes | composite FK with `project_id`, cascade |
| `series_position` | `smallint` | yes | |
| `generation_job_id` | `uuid` | yes | composite FK with `project_id`, cascade (**P16**) |
| `generation_job_item_id` | `uuid` | yes | composite FK with `project_id`, cascade |

**What is deliberately absent** (**M7**, **FR-004**): no prompt, no system text, no model output, no
`rawText`, no provider error text or message, no API key, and no fragment, hash, prefix, length or
fingerprint of one. No `user_id` either — records name the generation, not the person who asked
(spec, "out of scope": per-user attribution). No rate, currency or money amount (**M10**,
**FR-013**).

### Constraints

```
CHECK (llm_call_usage_outcome)        ok = (failure_kind IS NULL)
CHECK (llm_call_usage_series_pair)    (series_id IS NULL) = (series_position IS NULL)
CHECK (llm_call_usage_tokens_nonneg)  (input_tokens IS NULL OR input_tokens >= 0)
                                  AND (output_tokens IS NULL OR output_tokens >= 0)
CHECK (llm_call_usage_latency_nonneg) latency_ms >= 0
CHECK (llm_call_usage_provider)       provider IN ('openai','anthropic')
CHECK (llm_call_usage_source)         credential_source IN ('project','install')
CHECK (llm_call_usage_model_shape)    length(model) BETWEEN 1 AND 200 AND model !~ '\s'
CHECK (llm_call_usage_job_pair)       generation_job_item_id IS NULL OR generation_job_id IS NOT NULL
```

`provider`, `credential_source` and `model` follow `project_llm_settings`'s existing CHECK style
rather than new enums: `provider` and `source` already have string CHECKs there, and a `model`
`pgEnum` would need a migration per model id — the opposite of **M4**.

The series and job foreign keys use the `foreignKey({ columns: [projectId, …] })` composite form
already used by `generation_failures` and `voice_profile_versions`, so a row can never name another
project's series or job.

### Indexes

```
llm_call_usage_project_called_idx   (project_id, called_at DESC)      -- every period query (P15)
llm_call_usage_project_job_idx      (project_id, generation_job_id)   -- the job page (FR-028)
                                    WHERE generation_job_id IS NOT NULL
```

No unique index: a project can legitimately make two identical calls in the same millisecond
(two job items in one tick), and inventing an idempotency key would turn a swallowed duplicate into
an over-count — the one direction **M6** rules out.

### Lifecycle

- **Insert** only, from `createLlmUsageRepo().record(rows)`. The repo exposes no `update` and no
  `delete`, like `voiceProfileVersions`' repo (**FR-007**).
- **Removed** only by cascade: the project, or the post / series / job the row points at. Deleting
  a post soft-deletes it (`posts.deletedAt`), so the row survives and keeps counting — the tokens
  were spent (spec edge case "a deleted post").
- Never written inside a caller's transaction (**M6**, **FR-005**).

---

## 2. `llm_usage_purpose` — the new enum

```
pgEnum("llm_usage_purpose", [
  "generate.single", "generate.series_plan", "generate.series_post",
  "generate.regenerate", "generate.job_item", "voice.try", "llm.check",
])
```

Exactly the seven labelled call sites, and that is the complete list (spec § "Behaviour on `main`").
A closed set makes **SC-002** ("100% of calls that reach the provider produce a usage record, proven
once for each path") a checkable claim and lets the per-purpose breakdown (**FR-014**) group without
a lookup table. The enum values are the `label` strings verbatim so a log line and a ledger row read
the same, but the purpose is **passed explicitly, not derived from the label** (**P5**).

Human labels for the screens live in one map in `src/lib/generation/usage-purpose.ts` —
"Single post", "Series plan", "Series post", "Regenerate", "Batch job item", "Voice try it",
"Credential check" — next to the existing `src/lib/generation/llm-source.ts`.

---

## 3. `ModelRate` — install configuration, not a table

Parsed from the environment at startup; never stored, never per project, empty by default
(**M8**–**M11**, **FR-009**, **FR-013**). Lives in `src/server/llm/rates.ts`.

```ts
/** One operator-entered price. Prices are integer micro-units per million tokens (P12). */
interface ModelRate {
  provider: LlmProviderName;
  /** Matched against a usage row's `model` by exact, case-sensitive equality (FR-010). */
  model: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

interface LlmRates {
  /** Empty when nothing is configured, or when the configuration was rejected (FR-011). */
  entries: readonly ModelRate[];
  /** Three upper-case ASCII letters, displayed verbatim, never converted (M9, P11). */
  currency: string | null;
  /** Non-fatal, names and reasons only — never a value (P8). */
  problems: readonly EnvIssue[];
}
```

**Rules**
- Keyed by `(provider, model)`. A model id differing in case or by a trailing suffix does **not**
  match, and rates never match by provider alone (**FR-010**, **US3 scenario 4**, spec edge case).
- `0` is a legal rate and means zero (**M11**, **FR-012**); it is a different state from absent.
- Rejected **as a whole** on any problem — duplicate `(provider, model)`, a negative or non-numeric
  price, more than 6 decimal places, a missing or malformed currency, an unparseable entry, an
  unknown provider — and the install then behaves as if nothing were configured (**FR-011**, spec
  edge case "a half-applied rate table is worse than none").
- `entries` non-empty with `currency === null` is impossible by construction.

---

## 4. `UsageReport` — derived, never stored

Computed per request by `src/server/services/usage.ts` from a period window and the rates
configured *at that moment* (**M10**, **FR-013**, **FR-025**). Shapes in
[contracts/services.md](./contracts/services.md); the money fields are present only when
`rates.entries` is non-empty (**M14**, **FR-023**).

Aggregates, all over `project_id` and the half-open window `[from, to)`:

| Figure | Definition |
|---|---|
| `calls` | row count — **every** row, including those with null tokens (**M3**, **FR-017**) |
| `inputTokens` / `outputTokens` | `SUM` over rows where that column is non-null |
| `callsWithoutCounts` | rows where **both** token columns are null (**FR-017**) |
| `callsThatProducedNothing` / their tokens | rows where `ok = false` (**FR-018**, **P7**) |
| `bySource` | counts split `project` / `install`, in total and per model row (**FR-015**) |
| `byModel` | grouped by `(provider, model)`, each with the figures above and its rate state |
| `byPurpose` | grouped by `purpose`, calls and tokens (**FR-014**) |
| `priced` / `unpriced` | `byModel` partitioned by whether a rate matched (**FR-021**, **FR-022**) |

**Invariants the service guarantees, each with a test behind it**
1. `calls === sum(byModel[].calls) === sum(byPurpose[].calls)` — no row is lost or counted twice
   (**SC-001**).
2. A row with a null token column contributes to `calls` and to nothing else — null is never
   coerced (**M3**, **SC-006**).
3. `estimate` exists only for models in `priced`; `unpriced` models contribute nothing to any total
   and are named in it, with their call and token counts (**M13**, **FR-021**, **FR-022**,
   **SC-004**).
4. No money field exists at all when no rate is configured — absent, not zero, not an empty string
   (**M14**, **FR-023**, **SC-003**).
5. Every money field is carried by the fixed upper-bound sentence, which is a single exported
   constant so a test can assert it is never rendered apart from a figure (**M12**, **FR-020**,
   **SC-005**).

---

## 5. Relationship to what already exists

| Existing thing | Relationship |
|---|---|
| `attempts` blob on `posts.generation_metadata` | **Unchanged, and still the source for FR-029.** It already carries `usage` per attempt (`src/lib/validation/generation.ts:96`), is already loaded with the post, and covers posts generated before this entry ships. The post generation detail reads the blob, not the ledger (**P18** in plan.md) — so **FR-029** needs no migration, no backfill and no ledger query. |
| `generation_failures.attempts` | Unchanged. The ledger does not replace it. |
| `project_llm_settings` | Read only, through resolution, exactly as today. The ledger stores `credential_source`, never a key. |
| `llm_credit_holds` | Untouched. A held owner makes no call, so it writes no row (**M5**, **FR-006**). |
| `generation_mode`, `llm_failure_kind`, `generation_job_item_error` pgEnums | Unchanged (spec assumption). |

## 6. Migration

One SQL migration in `drizzle/`, generated with `pnpm db:generate` so `pnpm db:check` stays green:
`CREATE TYPE llm_usage_purpose`, `CREATE TABLE llm_call_usage` with its checks and foreign keys,
and the two indexes. Forward-only, additive, and safe on a live install: no existing table is
touched, so an install that migrates and never visits the Usage screen is byte-for-byte unchanged in
behaviour (**FR-030**, **SC-012**).

**No backfill.** Nothing before this entry ships has a row, and the `attempts` blobs are not mined
to invent one (spec assumption: a partial history that looks complete is worse than an empty one).
