# Data model: Account posting instructions

**Feature**: `011-account-posting-instructions` | **Research**: [research.md](./research.md)

The work uses two migrations: `0008` holds the generated DDL and `0009` is a custom data migration (research D11). No new tables are added. Every changed table is already project-owned and registered in `src/server/db/project-owned.ts`.

## Schema changes (`0008`, generated)

### `social_accounts` (`src/server/db/schema/accounts.ts`)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `posting_instructions` | `text` | yes | `NULL` | Normalised (CRLF/CR → LF, trimmed). `NULL` means no instructions. |

Check constraint `social_accounts_posting_instructions_len`: `posting_instructions IS NULL OR char_length(posting_instructions) BETWEEN 1 AND 2000`.

The type is `SocialAccountRow` / `AccountRecord` and gains `postingInstructions: string | null`. `upsertConnected` does not list the column, so a reconnect keeps it (research F6).

### `generation_jobs` (`src/server/db/schema/jobs.ts`)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `posting_instructions_snapshot` | `jsonb` | yes | `NULL` | Written once by `createJob`. `NULL` means a job created before this feature. |

The stored shape is validated with Zod, as `jobInstructionsSnapshotSchema` in `src/lib/validation/jobs.ts`:

```ts
{ v: 1, byAccount: Record<uuid, string | null> }
```

`byAccount` has exactly the job's `target_account_ids` as keys. No check constraint is added, because the shape is enforced by the single writer.

### `membership_action` enum (`src/server/db/schema/audit.ts`)

New value: `account_posting_instructions_update`.

## Data migration (`0009_copy_platform_guidance`)

This file is created with `drizzle-kit generate --custom --name=copy_platform_guidance`. Its SQL does the following, and the implementation may restate it for clarity:

```sql
UPDATE "social_accounts" AS sa
SET "posting_instructions" = g.text,
    "updated_at" = now()
FROM (
  SELECT p.id AS project_id,
         e.key AS provider_key,
         replace(replace(e.value, E'\r\n', E'\n'), E'\r', E'\n') AS text
  FROM "projects" p
  JOIN LATERAL (
    SELECT v.content
    FROM "voice_profile_versions" v
    WHERE v.project_id = p.id AND v.profile_id = p.default_voice_profile_id
    ORDER BY v.version DESC
    LIMIT 1
  ) latest ON true
  CROSS JOIN LATERAL jsonb_each_text(
    CASE WHEN jsonb_typeof(latest.content -> 'platformGuidance') = 'object'
         THEN latest.content -> 'platformGuidance' ELSE '{}'::jsonb END
  ) AS e(key, value)
  WHERE p.default_voice_profile_id IS NOT NULL
) AS g
WHERE sa.project_id = g.project_id
  AND sa.provider_key = g.provider_key
  AND sa.removed_at IS NULL
  AND sa.posting_instructions IS NULL
  AND char_length(g.text) BETWEEN 1 AND 2000;
```

Each rule below is tested in `tests/integration/migrations/copy-platform-guidance.test.ts`:

| Rule | Covered by |
|---|---|
| Only the project's **default** profile is read | Non-default profile guidance is not copied |
| Only its **highest-numbered** version is read | Older versions' guidance is not copied |
| Only accounts of the matching platform, in the same project, not removed, with `NULL` instructions change | Accounts that already have instructions, removed accounts and other projects are unchanged |
| Empty guidance is never copied | Stored guidance is already trimmed with empties dropped (`voice.ts` transform); the length guard covers corrupt rows |
| A re-run is a no-op | The test runs the file's SQL a second time and compares rows |
| No audit rows are written | The test counts `membership_audit_log` rows |

## Generation metadata (JSON in `posts.generation_metadata`)

`generationRecordSchema` (`src/lib/validation/generation.ts`) is extended in a backward-compatible way: new fields are `.nullish()`, so older records still parse.

```ts
accounts?: {
  accountId: string;
  displayName: string;      // as read when the request started
  providerKey: string;
  instructions: string | null;
  groupKey: string;          // the variant key this account received
}[] | null;

remainingProblems: {
  providerKey: string;       // platform key, or "post"
  groupKey?: string | null;  // NEW: the variant key; null/absent on older records
  messages: string[];
}[];
```

`output.variants` stays `Record<string, string>`, keyed by **group key**. For one group per platform the keys are platform keys, exactly as before (FR-009).

When `accounts` is absent, the UI shows the instructions as "Not recorded" (FR-015).

## Voice content (JSON in `voice_profile_versions.content`)

| Schema | Use | `platformGuidance` |
|---|---|---|
| `voiceContentSchema` (unchanged) | Reading any stored version (history, job pin, `takeVoice`) | Parsed; defaults to `{}` |
| `voiceContentInputSchema` (new) = `.omit({ platformGuidance: true })` | Create, save, Try it `draft` | Not accepted; stripped |

New version rows never contain `platformGuidance`. Old rows are never rewritten.

## Non-persistent entities

### `VariantGroup` (`src/lib/generation/groups.ts`)

```ts
interface GroupAccount { id: string; providerKey: string; displayName: string; postingInstructions: string | null }

interface VariantGroup {
  key: string;                 // platform key, or `${providerKey}_${n}` (n from 1) when the platform has ≥ 2 groups
  providerKey: string;
  instructions: string | null; // normalised
  accounts: GroupAccount[];    // request order
}
```

Rules (FR-005, FR-006, and the spec's "identical" decision):

1. Accounts are grouped by `providerKey` and `normaliseInstructions(postingInstructions)`. The comparison is exact and case-sensitive, and `null` equals `null`.
2. Groups are ordered by the position of their first account in the input.
3. Within a platform, if there is one group its key is `providerKey`; otherwise groups are numbered `_1`, `_2`, … in group order.
4. `groups.length > GROUP_LIMIT (16)` is refused by `assertGroupLimit` (research D5).

### Group-limit error

`ValidationIssuesError([{ code: "too_many_groups", field: "targetAccountIds", message }], message)`, where `message = groupLimitMessage(n)`. In the API this is 400 `validation_failed`. In server actions it is `{ ok: false, error: "validation", message, issues }`.

## Audit entry

| Field | Value |
|---|---|
| `action` | `account_posting_instructions_update` |
| `actorUserId` | the acting member (only people can edit; there is no API write) |
| `details` | `{ accountId, displayName, previous: string \| null, next: string \| null }` |

It is written in the same transaction as the update, only when the normalised text changed (FR-004).

## State and lifecycle

- **Account instructions** start as `NULL`. Saving sets them, and clearing (an empty field) sets `NULL`; each change is audit-logged. They are neither shown nor used once the account is removed. A reconnect keeps them, and reconnecting a removed account creates a fresh `NULL` row.
- **Job snapshot** is written once at creation and never updated. `NULL` means a pre-feature job, which uses current instructions per item.
- **Generation record `accounts`** is written once per record. Regenerate appends a new record with the current instructions.
