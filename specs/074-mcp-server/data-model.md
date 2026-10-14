# Phase 1 data model: An MCP server over the v1 API

**Feature**: `074-mcp-server` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

**No database change.** No table, no column, no enum value, no migration, no new
permission. The only persisted state a tool call touches is the idempotency record the HTTP
pipeline already writes. Everything below is a type, computed at module load from
`OPERATIONS`.

## 1. `McpDisposition` — the required new field on `ApiOperation`

`src/server/api/operations/types.ts`:

```ts
/** What a confirmation guards, and when it is demanded. */
export interface McpConfirm {
  /** Plain-language effect, e.g. "publish this post to the account's live feeds". */
  effect: string;
  /** Omitted: always required. Present: required only when it returns true for the arguments. */
  when?: (args: Record<string, unknown>) => boolean;
  /** Why `when` exists, for the documentation. Required when `when` is. */
  whenDescription?: string;
}

export type McpDisposition =
  | { expose: true; confirm?: McpConfirm }
  | { expose: false; reason: string };

export interface ApiOperation<P, Q, B> {
  // …existing fields…
  /** Required (FR-001): an operation cannot exist without an MCP decision. */
  mcp: McpDisposition;
}
```

**Validation rules**

| Rule | Enforced by |
|---|---|
| Every operation has an `mcp` field | `pnpm typecheck` (required property); the drift test re-asserts it at run time over `OPERATIONS` |
| A withheld operation's `reason` is non-empty | drift test |
| `confirm.effect` is non-empty, and `whenDescription` is present exactly when `when` is | drift test |
| `expose: true` is never set on `getOpenApi` (`permission: null`) | drift test — an unauthenticated tool cannot exist (FR-009) |
| `expose: true` is never set on a `multipart` operation | drift test — a JSON tool call cannot carry bytes |

## 2. The disposition of all 34 operations

Exposed (19). `C` marks a confirmation; `I` marks an operation that accepts
`idempotencyKey` (every exposed write; the seven reads are not idempotent operations).

| Operation | Tool | Permission | | |
|---|---|---|---|---|
| `listAccounts` | `docket_list_accounts` | `read` | | |
| `listActivity` | `docket_list_activity` | `read` | | |
| `getPost` | `docket_get_post` | `read` | | |
| `getPostTarget` | `docket_get_post_target` | `read` | | |
| `listMedia` | `docket_list_media` | `read` | | |
| `getMedia` | `docket_get_media` | `read` | | |
| `listUpcomingSlots` | `docket_list_upcoming_slots` | `read` | | |
| `createPost` | `docket_create_post` | `write_posts` | | I |
| `generatePost` | `docket_generate_post` | `generate` | C* | I |
| `queuePost` | `docket_queue_post` | `write_posts` | C | I |
| `schedulePost` | `docket_schedule_post` | `write_posts` | C | I |
| `createProject` | `docket_create_project` | `manage_setup` | C | I |
| `createVoiceProfile` | `docket_create_voice_profile` | `manage_setup` | | I |
| `updateVoiceProfile` | `docket_update_voice_profile` | `manage_setup` | | I |
| `setAccountPostingInstructions` | `docket_set_account_posting_instructions` | `manage_setup` | | I |
| `addSlot` | `docket_add_slot` | `manage_setup` | | I |
| `addWeekSlots` | `docket_add_week_slots` | `manage_setup` | | I |
| `updateSlot` | `docket_update_slot` | `manage_setup` | | I |
| `deleteSlot` | `docket_delete_slot` | `manage_setup` | C | I |

`C*` is conditional: `docket_generate_post` demands `confirm` unless `schedulingPolicy` is
explicitly `leave_as_draft`, because anything else may queue the post it generates — an
absent policy falls back to the project's default, which can be `add_to_queue` (research D9,
amended by review F2).

Withheld (15), with the reason published verbatim from the field:

| Operation | Reason |
|---|---|
| `getOpenApi` | Public and unauthenticated, and the largest response the API produces; a model is already holding the tool list it describes. |
| `uploadMedia` | Multipart upload of raw bytes, which a JSON tool call cannot carry. |
| `registerMediaFromUrl` | Would make the server fetch an arbitrary URL on a model's say-so. |
| `listJobs`, `createJob`, `getJob`, `listJobItems`, `getJobItem`, `addJobItems`, `retryFailedJobItems` | Batch generation is a bulk workflow; a model driving one conversationally would spend LLM credits in quantities nobody asked for. |
| `closeJob`, `cancelJob` | As above, and one-way. |
| `retryPostTarget`, `resolvePostTarget`, `retryFailedTargets` | The ambiguous-publish recovery path. Constitution V: a publish of unknown outcome is never retried automatically, and a model is the last thing that should decide a post did not go out. |

Counts are asserted by test, so this table and the code cannot disagree: 34 total, 19
exposed, 15 withheld, 4 unconditional confirmations, 1 conditional, 12 accepting
`idempotencyKey` (every exposed write; the seven reads are not idempotent operations).

## 3. `McpTool` — derived, never stored

```ts
export interface McpTool {
  /** `docket_` + snake_case operation id (frozen; FR-004). */
  name: string;
  /** The operation's own `summary`. */
  title: string;
  /** Generated, four required parts (§5). */
  description: string;
  /** Self-contained JSON Schema, no `$ref`/`$defs` (research D7). */
  inputSchema: Record<string, unknown>;
  /** The operation this tool is the only tool for. */
  operation: AnyApiOperation;
  /** Non-null for every tool: `getOpenApi` is withheld. */
  permission: ApiKeyPermission;
  confirm?: McpConfirm;
}
```

Relationships: exactly one tool per exposed operation and exactly one operation per tool
(FR-014, asserted both ways). Built once per process at module load (spec assumption: the
surface is computed at startup, not stored).

## 4. The argument object of one tool

| Argument group | Source | Notes |
|---|---|---|
| path parameters | `op.params` shape | always required; UUIDs |
| query fields | `op.query` shape | optional/defaulted as the operation declares; `limit`/`cursor` from `pageQuerySchema` carry over unchanged |
| body fields | `op.body.schema` shape (json only) | top-level keys only; nested objects keep their own shape |
| `confirm` | the disposition | `z.literal(true)`; only on confirmation tools |
| `idempotencyKey` | `op.idempotent` | `z.string().min(1).max(255)`, optional |

Flat, one namespace. A collision between two groups is a test failure (research D7). An
argument outside this set is refused `validation_failed` naming the field.

## 5. The four parts of a generated description

1. the operation's `summary`, and its `description` when it has one;
2. **project scoping**: that it acts only on the project the key belongs to and cannot act
   on another, naming that project;
3. **permission**: the exact `op.permission` value the key must hold;
4. **failures**: the codes this operation can answer with, from the shared
   `errorStatuses(op)`/`codesFor(status)` (research D8);

plus, on a confirmation tool, a fifth sentence naming the effect and the argument, and on
`docket_generate_post` the sentences FR-026 requires (it spends the project's LLM budget;
`auto_approve` skips review; a validation failure still forces review).

A test asserts all four parts are present in every exposed tool's description, by locating
the project name, the permission value, each derived code and — for confirmation tools —
the effect text and the word `confirm` (FR-007, SC-006).

## 6. State transitions

None. No entity in this entry has a lifecycle; the tools move posts, slots, profiles and
projects through the state machines the services already own.
