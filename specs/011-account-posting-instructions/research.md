# Research: Account posting instructions

**Feature**: `011-account-posting-instructions` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

Phases cannot fetch the web. Every fact below was read from the repository (code, committed migrations, `docs/research/`) or from installed packages in `node_modules`. Anything that could not be confirmed that way is marked **UNVERIFIED** and kept to one constant.

## 1. Facts

### F1: How prompts are assembled today

Source: `src/server/services/generation/prompt.ts`.

- **System message**, built by `systemFor(voice, platforms, opts)`, in this order:
  1. the role line ("You write social media posts for one brand…");
  2. `OUTPUT RULES`. For a post this includes "Write one variant for each platform listed under PLATFORM RULES, under its key.";
  3. `VOICE` (non-empty fields only);
  4. `PLATFORM GUIDANCE` (`guidanceSection`, from `voice.platformGuidance`, targeted platforms only);
  5. `PLATFORM RULES`, one block per platform, headed `<key> (<Display name>):`.
- **User message**: `INSTRUCTIONS FOR THIS REQUEST`, then `BRIEF`, `<source_material>`, `<item_data>`, `SERIES…`, `IMAGES:` and the retry sections.
  - So "one-off instructions, then inputs" already holds. The posting-instructions section only has to take the place of `PLATFORM GUIDANCE` in the system message.
- **Platform de-duplication**: `platformRulesFor(providerKeys, voice)` de-duplicates by provider key. Callers pass `distinctProviderKeys(accounts)` (`single.ts`).
- **Series plans**: the plan prompt (`buildSeriesPlanPrompt`) uses the same `systemFor`, so the plan already sees the guidance and the platform rules.
- **Snapshot test**: `prompt.test.ts.snap` holds a full-prompt snapshot. Its test voice has `platformGuidance`, so that snapshot changes by design.

### F2: Output schema and checks

Source: `src/server/services/generation/schema.ts` and `core.ts`.

- `generationOutputSchema(providerKeys, imageCount)` builds one `strictObject({ text: string })` property per key under `variants`, plus a required `imageAltTexts` array when images are attached. All properties are required, with no unions and no length constraints (007 R4).
- `checkGenerationOutput` validates each key with `validateTargetContent(scope, { providerKey: key }, …)`. It reads the key as the platform.
- `OutputProblem.providerKey` is used as the variant key. `groupByKey` stores `remainingProblems` as `{ providerKey, messages }`, with `"post"` for problems that belong to no platform.
- `problemLine` writes `<key>: <message>` into the retry prompt.

### F3: Anthropic structured-output limits

Source: `docs/research/llm-and-storage.md` §2.

- The documented limits are **24 optional parameters total and 16 parameters with union types** per request, with no length or count constraints. Nothing in `docs/research/` limits the number of *required* properties or the overall schema size.
- That is the spec's R1. It stays **UNVERIFIED** and is handled by the interim limit in D5.

### F4: OpenAI strict structured outputs

Source: `docs/research/llm-and-storage.md` §1.

- Every field must be required, with `additionalProperties: false`. Neither is affected by this feature.
- `docs/research/` records no limit on property count or nesting for OpenAI. **UNVERIFIED**.
- A request inside the group limit has at most 16 variant objects of one string each, plus one array. That is about four times today's maximum (four platforms), and it is the same shape the schema already uses.

### F5: Migrations

Sources: `node_modules/drizzle-orm/migrator.js`, `node_modules/drizzle-orm/pg-core/dialect.js`, `node_modules/drizzle-kit/bin.cjs` and `src/server/db/migrate.ts`.

- **Reading files**: `readMigrationFiles({ migrationsFolder })` reads `meta/_journal.json` and runs each entry's `<tag>.sql`, split on `--> statement-breakpoint`.
- **Applying them**: `PgDialect.migrate` applies every pending migration whose `folderMillis` is newer than the last applied one, all inside **one transaction**.
- **Running them**: `runMigrations(url, migrationsFolder = "./drizzle")` accepts a folder. A test can therefore migrate a throwaway database (`createThrowawayDb`, `tests/helpers/db.ts`) from a copy of `drizzle/` whose journal stops before the data migration, seed it, and then apply the real folder. Only the data migration runs on that second pass.
- **Custom migrations**: drizzle-kit 0.31.11 supports `drizzle-kit generate --custom --name=<name>` ("Prepare empty migration file for custom SQL"). The file is registered in the journal and snapshot, so `pnpm db:check` stays green.
- **Enum values**: `ALTER TYPE … ADD VALUE` inside the migrator's transaction is already used by committed migrations (`0007_shallow_stephen_strange.sql`, and `0006` for `membership_action`), and they apply in CI. The new enum value is not used in the same migration run.

### F6: Accounts and reconnects

Source: `src/server/dal/accounts.ts` and `services/accounts.ts`.

- `upsertConnected` updates an existing (not removed) row in place and lists only `displayName`, `settings`, credentials, status, `lastError` and `connectedByUserId`. So **a reconnect keeps the account's posting instructions**.
- A removed account that is connected again becomes a new row with no instructions.
- `list()` and `get()` exclude removed accounts. That already keeps removed accounts out of generation, jobs (the runner uses `accounts.get`) and the Accounts screen.
- `getForUpdate(id)` takes a row lock, which `removeAccount` already uses (lock order: account → posts → targets).

### F7: Audit log

Source: `src/server/dal/audit.ts`, `src/server/db/schema/audit.ts` and `settings/members/activity-list.tsx`.

- `membership_audit_log` is append-only and has a `membership_action` enum. `recordAudit(tx, entry)` writes it inside the caller's transaction.
- The repository refuses detail keys that match `/token|url|password|secret/i`.
- The activity list maps each action to a label. `detailSubject` derives the subject for `api_key_*` and `webhook_*` from `details.name` or `details.host`.

### F8: Where the platform key stands in for "the variant"

Every place below groups targets by platform, assuming one text per platform:

- `saveGeneratedPost`: `variants[a.providerKey]`.
- `regeneratePost`: `variantFor`.
- `posts.updatePostVariants`: edits `{ providerKey, text }`.
- `review.buildItem` and `approvePost`: edits `{ providerKey, text }`.
- The result page's `VariantCard` grouping (`generate/result/[postId]/page.tsx`).
- `tryVoice`: `TryItVariant.providerKey`.
- `POST /api/v1/generate`: `problems`.

The edit inputs are reached only through server actions (`generate/actions.ts`, `review/actions.ts`). No public API operation accepts them (`src/server/api/operations/*`).

### F9: Webhooks carry the API account shape

`emitEvent` uses `toApiAccount(account)` for `account.*` events (`services/webhooks/emit.ts`). A field added to the API account appears in those webhook bodies with no further change.

### F10: Saving a voice

Source: `services/voice.ts`.

- `saveVoiceProfile` skips writing a version when `JSON.stringify(voiceContentSchema.parse(current.content)) === JSON.stringify(parsed.content)`.
- `voiceContentSchema` is used both to read stored versions and to parse input, both for create and save and for the Try it `draft`.

### F11: Jobs

Source: `services/jobs/create.ts`, `runner.ts` and `append.ts`, and `db/schema/jobs.ts`.

- `generation_jobs` pins `voice_profile_id` and `voice_profile_version_id` and stores `target_account_ids`.
- The runner reloads the job and its accounts for every item, including deferred correction retries (`pending_retry`) and manually retried items. It drops removed accounts.
- `appendItems` only adds items. They run through the same runner.
- The item error enum already has `bad_request`.

## 2. Decisions

### D1: Store instructions in one nullable, trimmed text column on `social_accounts`

- **Decision**:
  - Add `social_accounts.posting_instructions text NULL`, with `CHECK (posting_instructions IS NULL OR char_length(posting_instructions) BETWEEN 1 AND 2000)`.
  - The service normalises input before storing: CRLF and lone CR become LF, then the text is trimmed. An empty result is stored as `NULL`.
  - The 2,000 limit is applied to the normalised text with Zod `.max(2000)`, which counts UTF-16 code units, the same unit the form's counter uses.
  - The SQL check counts code points. That number is never larger than the UTF-16 count, so the database never refuses what the service accepted.
- **Rationale**:
  - FR-001 and the spec's 2,000-character decision.
  - Storing the normalised form makes FR-004's "a save that does not change the text writes nothing" a plain equality, and keeps the "identical" rule (D4) cheap.
  - It is a column, not a key inside `settings` JSON, because `settings` is the provider's own schema (`provider.settingsSchema.parse`). Mixing in a Docket field would break that ownership (constitution V).
- **Alternatives**:
  - A key in `settings`: rejected, as above.
  - A separate `account_posting_instructions` table with history: rejected. Versioning is out of scope, and the audit log is the history.

### D2: One service, `setPostingInstructions`, editing under a row lock

- **Decision**: `setPostingInstructions(scope, accountId, input)` in `src/server/services/accounts.ts` ([contracts/services.md](./contracts/services.md)) works as follows:
  - it requires `account: ["manage"]` (owners and admins) outside and inside the transaction;
  - it locks the account row with `getForUpdate`, and a removed or foreign account is `NotFoundError`;
  - it compares the normalised new text with the stored text and returns `{ changed: false }` when they are equal;
  - otherwise it updates the column and writes the audit row in the same transaction.
- **Rationale**:
  - FR-003 and FR-004.
  - The row lock serialises two owners saving at once, so each audit row carries the true previous text (spec edge case "Two owners edit…").
  - It takes only the account lock, so it cannot deadlock with `removeAccount` (account → posts → targets).
- **Alternatives**:
  - Folding it into `updateAccountSettings`: rejected, because that one is the provider's settings.
  - An unlocked read followed by an UPDATE: rejected. Two concurrent saves could both record the same "previous" text.

### D3: Audit action `account_posting_instructions_update`

- **Decision**:
  - Add a new `membership_action` value.
  - The details are `{ accountId, displayName, previous, next }`, with each text either `string` or `null`. No key matches the secret pattern (F7).
  - The activity list labels it "changed the posting instructions for", and `detailSubject` shows the account's display name in quotes.
- **Rationale**: FR-004. The members activity list is the project's audit view, and owners and admins already see account changes there.
- **Alternatives**:
  - A separate account audit table: rejected. It would add a second audit path for one field.

### D4: One pure grouping module shared by server and forms

- **Decision**: add `src/lib/generation/groups.ts`. It has no server imports, so client forms can use it. It exports:
  - `normaliseInstructions(text)`: CRLF and CR become LF, then the text is trimmed; empty becomes `null`;
  - `groupTargets(accounts)`: groups by `providerKey` plus the normalised instructions (an exact, case-sensitive comparison, and `null` equals `null`). Groups are ordered by the first appearance of their accounts; accounts keep their request order inside a group;
  - `GROUP_LIMIT = 16` and `groupLimitMessage(count)`.
- **Group keys**:
  - When a platform has one group, its key is the platform key (`bluesky`).
  - When a platform has two or more groups, they are numbered by first appearance: `bluesky_1`, `bluesky_2`.
  - Provider keys match `/^[a-z0-9-]+$/` (`src/providers/registry.test.ts`), so a key with `_` can never clash with a platform key.
- **Rationale**:
  - FR-005 and FR-006, and the spec's "identical" rule.
  - One implementation (constitution IV) serves the generation services, job creation, the job runner, Try it, and the live group count in four forms (FR-013).
  - The keys are deterministic for the same inputs, so a deferred job retry rebuilds the same keys.
- **Alternatives**:
  - Keys that hash the instructions: rejected. They are unreadable in prompts and stored records.
  - Always suffixing keys: rejected, because it breaks FR-009.

### D5: Group limit of 16, enforced before any model call by one assertion

- **Decision**:
  - `assertGroupLimit(groups)` sits in `src/server/services/generation/groups.ts`. Over the limit it throws `ValidationIssuesError([{ code: "too_many_groups", field: "targetAccountIds", message }], message)`.
  - The message reads: "These accounts need {n} different versions of the post; one generation can write at most 16. Choose fewer accounts, or give accounts on the same platform the same posting instructions."
  - It is called after the accounts load and before any model call or write in each of these:
    - `generateSingle`
    - `planSeries`
    - `startSeries`
    - `writeSeriesPost`
    - `regeneratePost`
    - `tryVoice`
    - `createJob` (on the snapshot)
  - The API maps it to 400 `validation_failed` (`src/server/api/errors.ts`), and server actions map it to a `validation` result (`src/lib/action-result.ts`).
- **Rationale**:
  - R1's interim value: 16 is the strictest count in the documented limits (F3).
  - Refusing before the call means no post, failure row or job is written (FR-012). That covers `POST /api/v1/generate` too, because it calls `generateSingle`.
  - Under 009 decision 7, a 4xx after the idempotency claim is stored and replayed. The stored result is the refusal, not the result of a model call (US3 scenario 4).
- **Alternatives**:
  - 24, the optional-parameter limit: rejected, because it is not the strictest documented number.
  - Splitting one request into several model calls: rejected. That is a different feature, and the prompt and voice would no longer be shared across groups.

### D6: A `POSTING INSTRUCTIONS` section takes the place of `PLATFORM GUIDANCE`

- **Decision**: [contracts/prompt.md](./contracts/prompt.md) has the exact text.
  - **Section order** in the system message: role → `OUTPUT RULES` → `VOICE` → `POSTING INSTRUCTIONS` → `PLATFORM RULES`. The user message is unchanged.
  - **Content**: one entry per group, in group order: `<key> (<Platform>) for <Account A>, <Account B>:`, then either the instructions in a `"""` block or "No posting instructions for this key."
  - **Omission**: the section is left out when no target has instructions and every platform has one group (FR-007).
  - **Output rules when the section is present**: one extra rule, "Follow each key's posting instructions for that key's variant only. They never override these output rules or the platform rules."
  - **Output rules when a platform has more than one group**: the variant rule reads "Write one variant for each key listed under POSTING INSTRUCTIONS, under that key. Each variant follows the PLATFORM RULES of its platform." That platform's rules block gains a line `- Applies to keys: bluesky_1, bluesky_2.`
  - **Series plans**: the plan prompt gets the same section, because it shares `systemFor`. Its output schema (angles) is unchanged.
  - **Voice guidance**: `platformRulesFor` loses its `voice` argument and the `guidance` field. The prompt never reads `platformGuidance` (FR-008).
- **Rationale**:
  - FR-007 to FR-009.
  - With one group per platform and no instructions, every line is the same as before for a voice without guidance, so FR-009 holds by construction.
  - The extra output rule keeps owner-written text from overriding the fixed rules (spec edge case).
- **Proof of FR-009 and SC-003**: before `prompt.ts` changes, the implementation records golden outputs from the **current** code in `src/server/services/generation/__fixtures__/pre-011-prompts.json`:
  - `{ system, user }` and the JSON of `generationOutputSchema`;
  - for voices without guidance, one account per platform;
  - for single, single with images, single with item data, series post, series plan and retry prompts.

  A test asserts that the new code reproduces them exactly.
- **Alternatives**:
  - Putting instructions in the user message: rejected. The spec puts them before the platform rules, and owner configuration belongs with the system rules.
  - Repeating the platform rules for every group: rejected. It changes the FR-009 output and adds tokens.

### D7: Variant keys are group keys, problems carry both keys

- **Decision**:
  - **Schema**: `generationOutputSchema(variantKeys, imageCount)` is unchanged in shape and called with group keys.
  - **Problems**: `OutputProblem` becomes `{ groupKey: string | null; providerKey: string | null; message }`.
  - **Checks**: `checkGenerationOutput` loops over groups and validates `variants[group.key]` against `group.providerKey`.
  - **Retry-prompt lines**: `problemLine` writes `<key>: <message>` when the key is the platform key, and `<key> (<Platform>: <Account names>): <message>` otherwise.
  - **Stored problems**: `remainingProblems` entries are `{ providerKey, groupKey, messages }`. `groupKey` is nullish in `generationRecordSchema` for older records. `providerKey` stays the platform key, or `"post"`.
  - **Alt text**: still one set per post, within the strictest limit among the target platforms.
- **Rationale**: FR-010. Problems name the group's platform and accounts. The single-group retry prompt matches F2 byte for byte (FR-009). Readers of old records keep working.
- **Alternatives**:
  - Reusing `providerKey` to hold the group key: rejected. It would make stored records ambiguous.

### D8: Posts and records follow the groups

- **Decision**:
  - **Saving**: `saveGeneratedPost` takes `groups: VariantGroup[]` beside `variants`. Each target's `override_text` is its group's variant, and `base_text` is the first account's group variant. Single, series and job items all go through it.
  - **Regenerate**: `regeneratePost` builds groups from the live targets' accounts and their current instructions, and maps each draft target to its group's variant.
  - **Generation record**: it gains `accounts: { accountId, displayName, providerKey, instructions, groupKey }[]`, nullish for older records, which the UI shows as "Not recorded". `buildRecord` fills it from the groups, using the display names read at request start.
- **Rationale**: FR-010, FR-015 and FR-019. Accounts are not versioned, so the record is the only lasting trace of what was used (SC-005).
- **Alternatives**: storing only the instructions per group: rejected. FR-015 asks for each account.

### D9: Jobs snapshot instructions in a new nullable column

- **Decision**:
  - **Column**: `generation_jobs.posting_instructions_snapshot jsonb NULL`, with the shape `{ v: 1, byAccount: { "<accountId>": string | null } }`. Its Zod schema is in `src/lib/validation/jobs.ts`.
  - **Creation**: `createJob` reads the accounts (already loaded), builds the snapshot, runs `assertGroupLimit` on it, and inserts it with the job.
  - **Runner**: when the snapshot exists, an account's instructions come from it; otherwise they are the account's current instructions (FR-018, for pre-feature jobs). The runner then builds groups, and drops removed accounts as today.
  - **Who uses the snapshot**: deferred retries, manual retries and items appended over the API all re-read the job, so they all use it (FR-016).
  - **Over-limit pre-feature jobs**: such a job could exceed the limit at run time because current instructions changed. The item then fails with `bad_request` and the group-limit message, with no model call. This is unlikely; it needs more than 16 distinct groups.
  - **Job page**: `getJob` adds `instructions: string | null | "not_recorded"` to each target for a read-only display.
- **Rationale**:
  - This mirrors how the voice version is pinned (008), and the spec asks for the decision to be logged.
  - A typed column, rather than `source_meta`, keeps source data separate, and `NULL` marks pre-feature jobs.
- **Alternatives**:
  - Re-reading current instructions on every item: rejected by the spec, because a batch's style would change halfway through.
  - A per-account snapshot table: rejected. The snapshot is written once and read whole.

### D10: The voice stops carrying platform guidance; history still shows it

- **Decision**:
  - **Two schemas** in `src/lib/validation/voice.ts`:
    - `voiceContentSchema` stays the **stored-read** schema, with `platformGuidance` still parsed so old versions keep it;
    - the new `voiceContentInputSchema = voiceContentSchema.omit({ platformGuidance: true })` is used by `createVoiceProfile`, `saveVoiceProfile` and the Try it `draft`. A `platformGuidance` key in input is stripped (Zod's default for unknown keys), so it is never stored (FR-024).
  - **Prompt type**: the prompt takes `VoicePromptContent = Omit<VoiceContent, "platformGuidance">`.
  - **No-op check**: the save no-op check compares `voiceContentInputSchema.parse(current.content)` with the input, so an unchanged save after the upgrade does not create a spurious version (F10).
  - **Editor**: the voice editor loses the platform-guidance fieldset.
  - **History**: the history view shows non-empty old guidance read-only, under "Platform guidance (no longer used)", with a note and a link to Accounts (FR-025).
- **Rationale**: FR-024 and FR-025. Existing version rows are never rewritten, because the table is immutable.
- **Alternatives**:
  - Refusing input that carries `platformGuidance`: rejected. An editor tab opened before the upgrade would fail to save, for no benefit.
  - Rewriting old versions: rejected, because versions are immutable (007).

### D11: Migration in two files: generated DDL, then custom SQL that copies guidance

- **Decision**:
  - **`0008_<generated>`**: generated by `pnpm db:generate`. It adds the column and its check, the jobs snapshot column, and the audit enum value.
  - **`0009_copy_platform_guidance`**: created with `drizzle-kit generate --custom --name=copy_platform_guidance`. It holds one idempotent `UPDATE` ([data-model.md § Migration](./data-model.md#migration-0009_copy_platform_guidance)). For each project with a default voice profile, it takes that profile's **highest-numbered** version and, for each non-empty `platformGuidance` entry, sets `posting_instructions` on every not-removed account of that platform in that project whose instructions are `NULL`. Line endings are normalised and `updated_at` is set.
  - **Guards**:
    - `jsonb_typeof(... ) = 'object'`;
    - `char_length` between 1 and 2,000. This always holds, because the guidance was validated at the same limit; it stops a corrupt row from aborting the whole migration.
  - **No audit rows** (spec decision).
- **Rationale**:
  - FR-023, and US4 scenarios 1 to 5.
  - Splitting the work in two lets a test stop after `0008`, seed real rows (including accounts that already have instructions), then apply `0009` (F5).
  - Only the `NULL`s it has not filled are touched again, so a re-run changes nothing.
  - The highest-numbered version equals `current_version`, because `saveVoiceProfile` always advances it.
- **Alternatives**:
  - A TypeScript startup script: rejected. It would run outside the migration transaction, and it would need its own "already ran" marker.
  - Copying from every profile: rejected by the spec.

### D12: Try it chooses accounts

- **Decision**:
  - **Input**: `tryVoiceSchema` replaces `providerKeys` with `accountIds` (optional, 1 to 50, unique). The only caller is `TryItPanel`.
  - **Defaults**: when `accountIds` is absent, the project's accounts (`accounts.list()`, not removed) are taken in list order. Accounts are added while the groups stay within the limit.
  - **No accounts**: `ConflictError("Connect an account to try the voice.")`. The panel shows an empty state that links to Accounts instead.
  - **Result**: one sample per group, `{ key, providerKey, providerName, accountNames, text, count, limit, countingRule, issues }`.
  - **What is used**: the accounts' saved instructions (spec assumption). Nothing is written.
- **Rationale**: FR-020, and the spec decision "Try it chooses accounts".
- **Alternatives**:
  - Keeping platforms and adding an optional account list: rejected. A platform choice has no instructions to try.

### D13: Group display and edits are keyed by accounts

- **Decision**:
  - **One grouping for display**: `variantGroupsForPost(scope, post, targets)` lives in `src/server/services/posts/variant-groups.ts`. It groups a post's live targets by the latest generation record's `accounts[].groupKey`. Targets the record does not name, and older records, fall back to the platform key. The result page and `review.buildItem` both use it.
  - **Edits**: in `updatePostVariants` and `approvePost` the edits become `{ accountIds: uuid[] (1..50), text }`. The text is applied to those accounts' draft targets only, through the same `updatePost` and gate paths. The server actions and `VariantEditor` and `ReviewList` change to match.
  - **API**: the `problems` in `POST /api/v1/generate` use the D7 label.
- **Rationale**: FR-011. Edits keyed by platform cannot address two groups on one platform. Keying by account ids needs no knowledge of group keys on the client.
- **Alternatives**:
  - Keying edits by group key: rejected. The server would have to re-derive groups from a record that a later regenerate may have replaced.

### D14: Public API exposes the field read-only

- **Decision**:
  - `AccountSchema` gains `postingInstructions: z.string().nullable()` with a description, and `toApiAccount` maps it. The OpenAPI document picks it up from the route schema.
  - `account.*` webhook bodies include it (F9). `docs/n8n.md` needs no change, because it does not list account fields.
  - No write endpoint is added. The request shapes of `/generate` and `/jobs` are unchanged.
- **Rationale**: FR-021 and FR-022.

### D15: Accounts screen form

- **Decision**: [contracts/ui.md](./contracts/ui.md) has the full description.
  - Each account section gets a "Posting instructions" block placed directly before "Posting slots".
  - **Owners and admins** get the client component `PostingInstructionsForm`. It has:
    - a labelled textarea, with help text giving examples;
    - a live `n / 2,000` count, which turns to an error past the limit;
    - an error message next to the field;
    - one right-aligned Save button, which shows a pending state;
    - a polite live region that confirms the save.
  - **Editors** see the text read-only, or "No posting instructions."
- **Rationale**: FR-002, and the `docket-ui` form rules.

## 3. Open items carried forward

| Item | Status | Where it is handled |
|---|---|---|
| R1: Anthropic limit on required properties or schema size | **UNVERIFIED** | `GROUP_LIMIT = 16`, one constant; logged in `docs/decisions.md`; covered by limit tests |
| OpenAI property-count limits | **UNVERIFIED** | Same constant; the schema shape is unchanged from 007 |
| Model compliance with instructions | Out of scope (spec) | Best-effort; no deterministic checks |
