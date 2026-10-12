# Data model: Per-project LLM

**Feature**: `specs/065-per-project-llm` | Phase 1 | Migration **`0024`**

One new table, one new audit action value, one additive housekeeping sweep. **No change** to
`llm_credit_holds`' columns, to either failure-kind pgEnum, to `generation_jobs`,
`generation_job_items`, `generation_failures` or to any existing column anywhere.

## 1. `project_llm_settings` (new, project-owned)

`src/server/db/schema/generation.ts`, beside `llmCreditHolds`. Registered in `projectOwnedTables` with
`scopeColumn: "project_id"` (`src/server/db/project-owned.ts`), so the scope harness fails any statement
that touches it without a project pin (constitution III).

| Column | Type | Null | Meaning |
|---|---|---|---|
| `project_id` | `uuid` | no | **PK**, `FK → projects.id ON DELETE CASCADE`. At most one row per project (K5). |
| `provider` | `text` | yes | `openai` or `anthropic` by CHECK (L3). Null means this project has no credential. |
| `model` | `text` | yes | The project's model id, 1–200 characters, no whitespace (L17). |
| `api_key_encrypted` | `text` | yes | `encryptSecret(key, { aad: "project_llm_credential:<project_id>" })` (L4). The only column that ever holds key material, in any form (FR-009, FR-010). |
| `updated_at` | `timestamptz` | no | `default now()`. When the credential was last set, changed or removed. |
| `updated_by_user_id` | `uuid` | yes | `FK → user.id ON DELETE SET NULL`. Who did it; null once that person's account is gone ("Former member" on the screen). |
| `last_check_at` | `timestamptz` | yes | When a check last made a live call. Drives the cooldown (FR-021). |
| `check_lease_until` | `timestamptz` | yes | While in the future, a check is in flight. Drives "at most one at a time" (FR-021). |

### Constraints

```text
PRIMARY KEY (project_id)
project_llm_settings_provider       CHECK (provider IS NULL OR provider IN ('openai','anthropic'))
project_llm_settings_credential     CHECK ((provider IS NULL AND model IS NULL AND api_key_encrypted IS NULL)
                                        OR (provider IS NOT NULL AND model IS NOT NULL AND api_key_encrypted IS NOT NULL))
project_llm_settings_model_shape    CHECK (model IS NULL OR (length(model) BETWEEN 1 AND 200 AND model !~ '\s'))
project_llm_settings_key_nonempty   CHECK (api_key_encrypted IS NULL OR length(api_key_encrypted) > 0)
```

No index beyond the primary key: every read is by `project_id`, except the runner's once-per-tick
`EXISTS (SELECT 1 FROM project_llm_settings WHERE provider IS NOT NULL)` (L27), which is a sequential scan
over a table with at most one row per project.

### Invariants

1. **Atomic or absent.** The `_credential` CHECK is K1 as a database fact: there is no way to persist a
   model without a key, or a key without a provider, whatever a caller does (L2).
2. **The row is not the credential.** A row may exist with all three credential columns null — a project
   that has run a check, or whose override was removed. `hasCredential = provider IS NOT NULL`.
3. **Nothing recognisable about the key is stored** besides the ciphertext: no hash, prefix, last-four,
   length or fingerprint column exists (K6, FR-009).
4. **The ciphertext is bound to its project.** Moved into another project's row it fails to decrypt, and
   decryption failure never falls back to the install credential (FR-008, FR-012, K9).
5. **Nothing is destroyed on a read.** A `SecretDecryptionError` leaves the row exactly as it was
   (FR-012).
6. **Removal destroys the key and keeps the history.** `provider`, `model` and `api_key_encrypted` go to
   null; `updated_at` / `updated_by_user_id` record who removed it; the check bookkeeping is untouched
   (FR-017, L2).
7. **Deleting a project removes the row** by cascade (FR-029).

### State transitions

```text
                 save (provider+model+key)
   (no row) ───────────────────────────────────▶ credential set ──┐
      │                                            ▲   │         │ save (model only, key blank)
      │ check (install default)                    │   │         └─ credential set (same key)
      ▼                                            │   │
  row, no credential ──────────────────────────────┘   │ remove (confirmed)
      ▲                                                │
      └────────────────────────────────────────────────┘
```

Every arrow out of or into *credential set* writes one `llm_credential_update` audit row and clears the
project's credit hold in the same transaction (L18, L25). The `check` arrow writes neither: a check is not
a change.

## 2. Credential owner (derived, not stored)

`src/server/dal/credential-owners.ts`.

```text
ownerFor(project) = project.provider IS NOT NULL ? `project:${project.id}` : "install"
INSTALL_CREDENTIAL_OWNER = "install"      (unchanged)
```

- `llm_credit_holds.owner` keeps its `text` primary key and its three timestamps. **No column changes.**
  Existing `"install"` rows keep their exact meaning, so there is no data step (L9).
- A project's owner does **not** change when its key is replaced for the same provider; the hold is
  cleared explicitly on every save instead (K16, L25), which is both simpler and the behaviour FR-027
  asks for.
- `project:<uuid>` is 44 characters, well inside `text`, and satisfies the existing
  `length(owner) > 0` check.
- Because `owner` is a shared text key it cannot carry a foreign key. Orphan `project:<uuid>` rows are
  removed by `pruneOrphanCreditHolds()` in housekeeping, one bounded batch per tick (L28, FR-029).

## 3. Resolved credential (in memory only, never stored)

`src/server/llm/resolve.ts`. The only shape any caller receives (spec, Key Entities).

```text
ResolvedLlm =
  | { ok: true;  source: "project" | "install";
      provider: LlmProviderName; model: string;
      owner: string;                      // the hold key (L11)
      limits: { timeoutMs: number; maxOutputTokens: number };   // install-wide, always (K2, FR-004)
      llm: LlmProvider }                  // holds the key; never serialised, never logged
  | { ok: false; reason: "not_configured"; problems: EnvIssue[] }   // names and reasons only
  | { ok: false; reason: "key_unreadable" }
```

- `limits` comes from `parseLlmLimits(process.env)` whichever branch wins, so a project can never change
  them (FR-004, K2, L8).
- `problems` are `EnvIssue` (`{ name, reason }`) — the existing shape, carrying variable names and reasons
  and never values.
- `key_unreadable` carries no detail at all: there is nothing safe to say beyond the fixed sentence
  (FR-012).
- The value is never placed in an action result, a page prop, a log line, a cache key or a snapshot. Pages
  and services read `source`, `provider`, `model` and `ok` off it and discard the rest.

## 4. Audit

`membership_action` gains one value, `llm_credential_update` (L18, K12, FR-018).

| Field | Value |
|---|---|
| `action` | `llm_credential_update` |
| `actor_user_id` | the owner or admin who acted |
| `subject_user_id` / `subject_email` | null — the subject is the project, not a person |
| `details` | `{ fromProvider, fromModel, toProvider, toModel, keyChanged }` |

`fromProvider` / `fromModel` are null for a first save; `toProvider` / `toModel` are null for a removal.
`keyChanged` is a boolean. No key, no ciphertext, no prefix, no length. `assertAuditDetailsSafe` stays in
force as the only write path and none of these names matches its `/token|url|password|secret/i` guard.

## 5. Check bookkeeping

Two columns on the same row, claimed and released by the service (L22, FR-021).

```text
claim(projectId, now):                     -- one statement; zero rows means refused
  INSERT INTO project_llm_settings (project_id, last_check_at, check_lease_until)
  VALUES ($projectId, NULL, $now + LLM_CHECK_LEASE_MS)
  ON CONFLICT (project_id) DO UPDATE SET check_lease_until = $now + LLM_CHECK_LEASE_MS
  WHERE (project_llm_settings.check_lease_until IS NULL OR project_llm_settings.check_lease_until <= $now)
    AND (project_llm_settings.last_check_at    IS NULL OR project_llm_settings.last_check_at    <= $now - LLM_CHECK_COOLDOWN_MS)
  RETURNING project_id

release(projectId, now):
  UPDATE project_llm_settings SET last_check_at = $now, check_lease_until = NULL WHERE project_id = $projectId
```

- `LLM_CHECK_COOLDOWN_MS = 30_000`, `LLM_CHECK_LEASE_MS = 60_000` — documented constants, no environment
  variable (L23).
- Two concurrent claims serialise on the row lock; the loser re-evaluates the `WHERE` after the winner
  commits and returns no row. Exactly one live call happens (AS 2.4).
- A crash between claim and release leaves the lease to expire, so a check is never wedged. The lease is
  longer than the longest call the check can make (its timeout is capped at 30 s, L23).
- A refused claim makes **no** live call and writes nothing.
- The claim may create the row for a project with no credential, which is invariant 2's reason for
  existing.

## 6. Migration `0024` — exactly what it does

```sql
ALTER TYPE "public"."membership_action" ADD VALUE 'llm_credential_update';--> statement-breakpoint
CREATE TABLE "project_llm_settings" ( … as §1 … );--> statement-breakpoint
ALTER TABLE "project_llm_settings" ADD CONSTRAINT … FOREIGN KEY ("project_id") … ON DELETE cascade …;
ALTER TABLE "project_llm_settings" ADD CONSTRAINT … FOREIGN KEY ("updated_by_user_id") … ON DELETE set null …;
```

Pure additive DDL: one enum value and one table. **No `UPDATE`, no `ALTER` of an existing table's
columns, no data step.** Therefore it is safe on a live install with existing rows, needs no operator
step, turns no project's override on, cannot touch a hold row, a job, an item or a stored failure, and
`pnpm db:check` passes with the committed SQL matching the schema. An install that only ever used
environment variables sees exactly the behaviour it saw before (SC-001).

`ALTER TYPE … ADD VALUE` is the same statement `0023` already ships for `credit_exhausted`; the new value
is only *added* here, never used in the same migration, so there is no in-transaction use of an uncommitted
enum label.

## 7. What is deliberately not modelled

- **Tokens, cost, spend or price** — entry 3 (`llm-cost-visibility`). No `usage` column, no rate table, no
  per-call row. `LlmUsage` stays logged and unpersisted.
- **A per-user credential**, and **per-project timeouts or output-token limits** (K2) — no column exists
  to hold either.
- **A new `LlmFailureKind`** and any change to `llm_failure_kind` / `generation_job_item_error` (L29).
- **A credential history table.** `membership_audit_log` is the history (FR-018); it records provider and
  model before and after, and never a key.
- **Any fingerprint of a key** — no hash, prefix, last-four or length, anywhere (K6).
