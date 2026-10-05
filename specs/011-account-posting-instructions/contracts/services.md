# Contract: services

Every caller (UI server actions, generation jobs, the public API) goes through these functions (constitution IV). The project-scoped DAL is the only way into the data (constitution III).

## Grouping: `src/lib/generation/groups.ts` (pure, client-safe)

```ts
export const GROUP_LIMIT = 16;                   // R1 interim; the only copy of the number
export const POSTING_INSTRUCTIONS_MAX = 2000;

export function normaliseInstructions(text: string | null | undefined): string | null;
// CRLF and lone CR become LF, then the text is trimmed; "" becomes null.

export function groupTargets<A extends GroupAccount>(accounts: readonly A[]): VariantGroup<A>[];
// Deterministic. See data-model.md § VariantGroup for the rules.

export function groupLimitMessage(count: number): string;
// "These accounts need {count} different versions of the post; one generation can write at most 16.
//  Choose fewer accounts, or give accounts on the same platform the same posting instructions."

export function defaultTryItSelection<A extends GroupAccount>(accounts: readonly A[]): A[];
// The accounts in the given order, each added while groupTargets(selected).length stays <= GROUP_LIMIT.
// The only copy of Try it's default rule: tryVoice and TryItPanel both call it (research D12).
```

It imports nothing from `src/server`. The forms use it to count groups live (FR-013).

## Errors: `src/server/dal/errors.ts` and `src/lib/action-result.ts`

```ts
export class GroupLimitError extends ValidationIssuesError {
  readonly field = "targetAccountIds";
  constructor(message: string) {          // message = groupLimitMessage(n)
    super([{ code: "too_many_groups", field: "targetAccountIds", message }], message);
    this.name = "GroupLimitError";
  }
}
```

How `failFromError` (`src/lib/action-result.ts`) treats it (research D5, F12):

- **Mapping**: `ERROR_NAME_TO_CODE.GroupLimitError = "validation"`, and `KEEPS_MESSAGE_NAMES` includes `"GroupLimitError"`.
- **Field error**: in the `validation` branch, when the error has a string `field`, the result also carries `fieldErrors: { [field]: message }`.
- **Result**: `{ ok: false, error: "validation", message: groupLimitMessage(n), fieldErrors: { targetAccountIds: … }, issues }`.
- **Plain `ValidationIssuesError`**: unchanged. It keeps its generic message and has no `field`.

The API (`mapServiceError`) still reaches it through `instanceof ValidationIssuesError`, so the response is 400 `validation_failed` with `message` and `details` ([http-api.md](./http-api.md)).

## Generation: `src/server/services/generation/groups.ts`

```ts
export function assertGroupLimit(groups: readonly VariantGroup[]): void;   // throws GroupLimitError (issue code "too_many_groups")
export function groupsForAccounts(accounts: readonly AccountRecord[],
  instructionsOf?: (a: AccountRecord) => string | null): VariantGroup<AccountRecord>[];
// When instructionsOf is absent, the account's own postingInstructions are used. The job runner passes the snapshot.
export function recordAccounts(groups: readonly VariantGroup[]): NonNullable<GenerationRecord["accounts"]>;
```

## Accounts: `src/server/services/accounts.ts`

```ts
export const postingInstructionsSchema = z.object({
  instructions: z.string()
    .transform(normaliseInstructions)   // before the limit, so trailing spaces do not count
    .pipe(z.string().max(POSTING_INSTRUCTIONS_MAX, { error: "Keep posting instructions to 2,000 characters or fewer" }).nullable()),
});

export async function setPostingInstructions(
  scope: ProjectScope, accountId: string, input: unknown,
): Promise<{ changed: boolean; instructions: string | null }>;
```

Steps:

1. Validate `accountId` as a uuid; a malformed id is `NotFoundError`.
2. Parse the input. A failed parse is a `ZodError`, which reaches the field as a field error.
3. Require `account: ["manage"]`; otherwise `ForbiddenError`. Editors are refused here (FR-003).
4. Inside `scope.transaction`:
   - require `account: ["manage"]` again;
   - load with `tx.accounts.getForUpdate(id)`; a missing, removed or foreign account is `NotFoundError`;
   - if the stored text equals the new text, return `{ changed: false }` and write nothing;
   - otherwise call `tx.accounts.setPostingInstructions(id, text)`, then `recordAudit(tx, { action: "account_posting_instructions_update", actorUserId: tx.membership.userId, details: { accountId, displayName, previous, next } })`.

Lock order: only the account row (compatible with `removeAccount`).

`AccountView` (`listAccounts`) gains `postingInstructions: string | null`.

### DAL: `src/server/dal/accounts.ts`

```ts
setPostingInstructions(id: string, text: string | null): Promise<void>;
// UPDATE … WHERE project_id = $project AND id = $id AND removed_at IS NULL
```

The existing scope-check test covers it through the `mine(id)` predicate.

## Generation services (changed signatures and behaviour)

| Function | Change |
|---|---|
| `runGenerationStep` / `runGeneration` (`core.ts`) | `CoreRequest.providerKeys` is replaced by `groups: VariantGroup[]`. The schema is built from `groups.map(g => g.key)`. The prompt gets `platforms = platformRulesFor(distinct providerKeys)` plus `groups`. Output is checked per group (research D7). |
| `platformRulesFor(providerKeys)` (`prompt.ts`) | Takes no `voice` argument and returns no `guidance` field. |
| `checkGenerationOutput` (`schema.ts`) | Takes `groups` instead of `providerKeys`. Problems are `{ groupKey, providerKey, message }`. |
| `problemLine` | `<key>: <msg>` when `key === providerKey`, otherwise `<key> (<Platform>: <names>): <msg>`. |
| `generateSingle` | After `loadAccounts`: `groups = groupsForAccounts(accounts)`, then `assertGroupLimit(groups)`, all before `runGeneration`. The record gets `accounts`. `saveGeneratedPost` gets `groups`. |
| `planSeries`, `startSeries`, `writeSeriesPost` | Same grouping and limit. `startSeries` refuses before saving the series. Each series post reads current instructions when it starts. The plan prompt includes the section. |
| `regeneratePost` | Groups are built from the live targets' accounts with **current** instructions, and the limit is checked. Each draft target gets `variants[groupOf(account).key]`. |
| `saveGeneratedPost` (`save.ts`) | New arg `groups`. A target's `overrideText` is its group's variant, and `baseText` is the first account's group variant. |
| `buildRecord` (`single.ts`) | New arg `groups`, written to `record.accounts`. |
| `distinctProviderKeys` | Kept for `assertMediaFits` only. |

## Voice: `src/server/services/voice.ts`

- `createSchema` and `saveSchema` use `voiceContentInputSchema`. The save no-op check compares `voiceContentInputSchema.parse(current.content)` with the input (research D10).
- `VersionView.content` stays `VoiceContent` (stored-read), so the history can show old guidance.
- `tryVoiceSchema` becomes:

```ts
z.object({
  brief: …,                                   // unchanged
  accountIds: z.array(z.uuid()).min(1, { error: "Choose at least one account" }).max(TARGET_ACCOUNTS_MAX)
    .refine(unique, { error: "Each account can be chosen once" }).optional(),
  draft: voiceContentInputSchema.optional(),
  versionId: z.uuid().optional(),
})
```

- `tryVoice` resolves the accounts:
  - with `accountIds`: `loadAccounts`, where an unknown id is `NotFoundError`;
  - otherwise `defaultTryItSelection(project accounts in list order)`;
  - with no accounts at all: `ConflictError("Connect an account to try the voice.")`.

  It then groups them, applies `assertGroupLimit` and runs `runGeneration`. It writes nothing.
- `TryItVariant` becomes `{ key, providerKey, providerName, accountNames: string[], text, count, limit, countingRule, issues }`, with one entry per group in group order.
- `TRY_IT_PLATFORMS_MAX` is removed.

## Jobs: `src/server/services/jobs/*`

- **`createJob`**: after `loadAccounts`, `snapshot = { v: 1, byAccount: Object.fromEntries(accounts.map(a => [a.id, a.postingInstructions])) }`, then `assertGroupLimit(groupsForAccounts(accounts, a => snapshot.byAccount[a.id] ?? null))`, all before the source is prepared or written. The snapshot is inserted with the job (`tx.jobs.insert({ …, postingInstructionsSnapshot })`). This covers UI, CSV and API jobs, because they share this function.
- **`appendItems`**: unchanged. Appended items run under the job's snapshot.
- **`processClaimedItem`** (`runner.ts`):
  - parse `job.postingInstructionsSnapshot` with `jobInstructionsSnapshotSchema.nullable()`;
  - `instructionsOf = snapshot ? (a) => snapshot.byAccount[a.id] ?? null : (a) => a.postingInstructions`;
  - `groups = groupsForAccounts(accounts, instructionsOf)`;
  - if `groups.length > GROUP_LIMIT`, call `fail("bad_request", groupLimitMessage(n))` and make no model call;
  - pass `groups` to `runGenerationStep`, `buildRecord` and `saveGeneratedPost`.
- **`getJob`** (`read.ts`): each target gains `instructions: string | null | "not_recorded"`, where `"not_recorded"` means the snapshot is `NULL`.

## Posts and review

- **`variantGroupsForPost(scope, post, targets)`** (new, `src/server/services/posts/variant-groups.ts`):
  - it returns `{ key, providerKey, providerName, accountIds, accountNames, instructions: string | null | "not_recorded" }[]` for the live targets;
  - keys come from the latest record's `accounts[].groupKey`, falling back to `providerKey`;
  - the order is the order of first target appearance.

  The result page (`generate/result/[postId]/page.tsx`) and `review.buildItem` use it, so the grouping is never re-implemented.
- **`variantEditsSchema`** (`posts`) and **`approveSchema.edits`** (`review`) become `z.array(z.object({ accountIds: z.array(z.uuid()).min(1).max(50), text: z.string() })).max(50)`. The text is applied to the draft targets of the listed accounts only. The problems returned by `updatePostVariants` become `{ accountIds, targetId, issues }`.
- **`ReviewVariant`** gains `key`, and its issues are computed for the group's first target.

## API views

- `toApiAccount` adds `postingInstructions: a.postingInstructions` (see [http-api.md](./http-api.md)).
- `POST /api/v1/generate` `problems[].message` uses the D7 label (`<key>: …` or `<key> (<Platform>: <names>): …`).
