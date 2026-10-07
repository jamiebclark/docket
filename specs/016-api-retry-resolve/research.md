# Research: Public API to retry, bulk-retry and resolve targets

**Feature**: `016-api-retry-resolve` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

There are no external platform facts in this entry. Everything below comes from the code on `main` after PR #34. Library behaviour comes from the installed packages: `zod` 4.6.5 and `zod-openapi` 6.0.2, both probed with Node in this phase. Nothing is marked `NEEDS RESEARCH` or `NEEDS CLARIFICATION`.

## Findings (what the code does today)

- **F1 — Operation table.** `src/server/api/operations/types.ts` defines `ApiOperation`:
  - fields: `id`, `method`, `path`, `permission`, `params`, `body: { kind: "json", schema }`, `responses: Record<status, { description, schema? }>`, `idempotent`, `idempotencyMode?: "transaction" | "generate"`, `prepare?`, `run`, `resourceParams?`;
  - `OPERATIONS` in `operations/index.ts` drives the router, `buildOpenApiDocument()` and `tests/integration/api/scope-enforcement.test.ts`;
  - that test has a `FIXTURES` entry per operation id and fails on a missing one.
- **F2 — Pipeline order** (`src/server/api/handle.ts`):
  1. route match;
  2. key → `forApiKey` (counts the rate limit);
  3. `429`;
  4. permission (`403 missing_permission`, `details.permission`);
  5. read the body (`415` / `invalid_json`; an empty body reads as `{}`);
  6. check the `Idempotency-Key` format;
  7. then either `execute` (no key) or `runIdempotent` (key).

  Params and body are parsed with the operation's Zod schemas, giving `400 validation_failed` with `[{ path, message }]` details. A path param ending in `Id` that is not a UUID is `404` before parsing.
- **F3 — Idempotency** (`src/server/api/idempotency.ts`):
  - the claim comes first, then `parse` and `prepare`; a 4xx from them is stored;
  - **default ("transaction") mode**: `scope.transaction(tx => tx.transaction(s => op.run(s)) … tx.idempotency.complete(...))`. A thrown error mapped below 500 is stored as the answer, and its savepoint is rolled back;
  - **`generate` mode**: `op.run(scope)` runs outside any wrapper transaction, and the answer is stored afterwards;
  - 5xx answers are never stored.
- **F4 — Nested transactions are savepoints.** `buildScope().transaction` calls `getRoot(exec).transaction`. On a transaction handle, that is Drizzle's nested transaction, which is a savepoint. A service's own `scope.transaction` inside the idempotency transaction therefore commits only when the stored answer commits. An API-key scope re-checks `apiKeys.isValid` at every level.
- **F5 — Error mapping** (`src/server/api/errors.ts` `mapServiceError`):
  - `ConflictError` → `409 conflict` with `e.message` and **no details**;
  - `NotFoundError` → `404`;
  - `ZodError` → `400 validation_failed`;
  - `ForbiddenError` → `403`;
  - anything unknown → `500 internal_error`, generic body, logged through `redact()`.
- **F6 — `ConflictError`** (`src/server/dal/errors.ts`) is `constructor(message, field?)`. Six call sites pass `field`, and none passes anything else. UI actions map it by `err.name` in `failFromError` (`src/lib/action-result.ts`) and keep its message.
- **F7 — Single retry** (`src/server/services/posts/retry.ts`):
  - `retryTarget(scope, targetId, input?)` parses `retryInputSchema` (absent input means `now`), then calls `withLockedTarget(…, { post: ["schedule"] }, retryLockedTarget)`;
  - `retryLockedTarget` throws `ConflictError` for `publishing`, for not `failed`, for a blocked account (`retryBlockedReason`, built on `retryBlockedKey`) and for a lost `failed` guard;
  - it returns `RetryResult` for the typed outcomes;
  - it writes `actorUserId: tx.membership.userId` in four `attempts.insert` calls.
- **F8 — Resolve** (`src/server/services/posts/index.ts` `resolveAmbiguous`):
  - parses `resolveSchema`, which includes the legacy `{ outcome: "failed" }` alias. `expected` is `z.iso.datetime()`, which accepts **UTC `Z` only**, while retry's `expected` accepts an offset;
  - throws `ConflictError("This post was already resolved.")` for a non-ambiguous target and for lost guards, and `ConflictError(g.message)` when the requeue gate fails;
  - writes `resolvedByUserId: tx.membership.userId` on the target and `actorUserId` on every attempt entry;
  - returns `ResolveResult`.
- **F9 — Bulk retry** (`src/server/services/posts/retry-all.ts` `retryAllFailed(scope, { account?, mode })`):
  - each target runs in its own `withLockedTarget` transaction;
  - it returns `{ changed, message, count, mode, inScope, skipped, remaining, accounts[] }`;
  - it catches `NotFoundError`/`ConflictError` per target as `no_longer_failed`.
- **F10 — `withLockedTarget`** (`posts/locked.ts`) first reads the target by id. `targets.get` does not filter deleted posts. It then locks the post (`posts.lockForUpdate` filters `deleted_at`, so a deleted post is `NotFoundError`) and the post's targets, re-reads the target, runs the body, then runs `applyDerivedStatus`. Nothing checks which post the caller expected.
- **F11 — The API-key actor** (`src/server/dal/scope.ts` `forApiKey`):
  - `membership = { memberId: "api-key:<id>", userId: key.createdByUserId ?? "", role: "editor" }`;
  - `actor = { kind: "api_key", apiKeyId, name, permissions }`;
  - `api_keys.created_by_user_id` is `ON DELETE SET NULL`, so a deleted creator makes `userId` the empty string;
  - `actorColumns(scope)` already maps this to `{ createdByUserId: userId || null, createdByApiKeyId }` for posts, media and jobs.
- **F12 — Confirmed defect.** `publish_attempts.actor_user_id` and `post_targets.resolved_by_user_id` are `uuid` columns. Writing `""` into them raises a Postgres invalid-input error, which surfaces as a 500. Writing the creator's id credits the action to a person who did not act. Spec "Defects found while specifying" covers this.
- **F13 — Key references elsewhere.** `posts`, `media_assets` and `generation_jobs` carry `created_by_api_key_id uuid` with a composite FK `(project_id, created_by_api_key_id) → api_keys(project_id, id)`, `ON DELETE no action` (migration `0006`). Keys are revoked, never deleted, so such a reference can only dangle if the project is deleted, which cascades anyway. `scope.apiKeys.get(id)` returns revoked and expired keys too. It is the lookup that `views/load.ts` and `jobs/read.ts` use for names.
- **F14 — Attempt views.**
  - `toAttemptViews` (`src/server/services/failures.ts`) gives `actor: { kind: "member", name } | { kind: "system" }`, decided by `actorUserId` alone.
  - Two pages render it inline: `failures/page.tsx:94` and `posts/[postId]/page.tsx:197`, each with `actor.kind === "member" ? name : "System"`.
- **F15 — Webhooks.** `applyDerivedStatus` (`posts/status.ts`) calls `emitEvent` in the caller's transaction when the derived status changes. Under default idempotency mode that is inside the stored-answer transaction (F3, F4). A replay therefore emits nothing.
- **F16 — Schemas and OpenAPI.**
  - Output shapes live in `src/lib/api/schemas.ts`, using `.meta({ id })`. Request bodies are currently inline in the operation files.
  - `buildOperation` in `src/server/api/openapi.ts` renders success responses from `responses[s].schema`, and every error status through the shared `Error` schema with no examples.
  - Probe result: `zod-openapi` 6.0.2 passes an `examples` map on a media-type object straight into the document.
  - Probe result: Zod 4.6.5 nests a `discriminatedUnion("requeue", …)` inside a `discriminatedUnion("outcome", …)`. A bad `url` reports `path: ["url"]`, `{ outcome: "failed" }` reports `path: ["outcome"]`, and an extra key on a strict object reports `Unrecognized key`. All three end up as `400 validation_failed` details.
- **F17 — Existing operation patterns to reuse.** `posts.ts` has private `toIssue` and warning mapping (`{ severity: "warning", code, message }`). `jobs.ts` `retryFailedJobItems` is the naming model for `retry-failed`.
- **F18 — Migrations.** `pnpm db:generate` (`drizzle-kit generate`) writes `drizzle/NNNN_<name>.sql` and its snapshot from the schema without a database. `pnpm db:check` (`scripts/check-migrations-current.mjs`) fails if they drift. The latest is `0009_copy_platform_guidance.sql`.

## Decisions (plan-level judgement calls)

Spec decisions D1–D10 stand as written. The calls below are the plan's own. Both sets go into `docs/decisions.md` under `## 016`.

### P1 — One new operations module, tag "Recovery"
- **Decision**: add `src/server/api/operations/targets.ts` exporting `targetOperations` (`retryPostTarget`, `resolvePostTarget`, `retryFailedTargets`), spread into `OPERATIONS` after `postOperations`, with OpenAPI tag `Recovery`.
- **Rationale**: keeps `posts.ts` focused on composing and scheduling. The tag groups the three recovery calls for automation builders.
- **Alternatives**: append to `posts.ts`, which would push it past 300 lines and mix concerns. Tag them `Posts`, which hides the bulk call among the post CRUD.

### P2 — Request and response schemas are shared, strict and carry examples
- **Decision**: `src/lib/api/schemas.ts` gains `RetryTargetRequestSchema`, `RetryTargetResultSchema`, `ResolveTargetRequestSchema`, `ResolveTargetResultSchema`, `RetryFailedTargetsRequestSchema` and `RetryFailedTargetsResultSchema`, each with `.meta({ id, … })`.
  - Request objects are `z.strictObject`.
  - Resolve is `discriminatedUnion("outcome", [published, discriminatedUnion("requeue", [true, false])])`, as probed in F16.
  - Instants use `atSchema` (RFC 3339 with offset), and `url` uses `externalUrlSchema`.
- **Rationale**: FR-006, FR-009 and FR-014 refuse anything else, and FR-027 wants them in the document. Strict objects give `Unrecognized key` details instead of silently dropping, for example, a `targetIds` list on the bulk call.
- **Alternatives**: reuse the service schemas (`retryInputSchema`, `resolveSchema`). They are not strict, they accept the legacy `failed` alias, and they live in server code that the shared schema module must not import.

### P3 — Post/target pairing is checked inside `withLockedTarget`
- **Decision**: `withLockedTarget(scope, targetId, permission, fn, opts?: { postId?: string })`. After the first read, it throws `NotFoundError` when `opts.postId` is set and differs from `first.postId`. `retryTarget(scope, targetId, input?, opts?)` and `resolveAmbiguous(scope, targetId, input, opts?)` pass `opts` through. All existing callers omit it, so their behaviour is unchanged.
- **Rationale**: the check runs before any lock-dependent write, in the same transaction. A target's `post_id` never changes, so no race can make it stale. A deleted post is still caught by `lockPost` (F10). It keeps the operation a one-call adapter (FR-002) and gives the same `404` as an unknown id (FR-013).
- **Alternatives**: a pre-read in the operation (`scope.targets.get`). `tests/lint/api-imports.test.ts` forbids it (`SCOPE_REPO` matches `scope.targets.` in operations), and it would add a second read path. Or `loadApiPost` first, which builds the whole post just to compare an id.

### P4 — Machine-readable refusal reasons on `ConflictError`
- **Decision**: `ConflictError`'s second argument becomes `string | { field?: string; reason?: string }`. A string still means `field`, so all six existing call sites are untouched. The error gains `readonly reason?: string`.
  - `retryLockedTarget` sets `publishing`, `not_failed` (including the guard-lost `lost()`) and the blocked key from `retryBlockedKey`.
  - `resolveAmbiguous` sets `already_resolved` (including its `lost()`) and `cannot_publish` (gate refusal).
  - `mapServiceError` adds `details: { reason }` when `e.reason` is set.
- **Rationale**: this implements D4/FR-011 with no change to any sentence, write or UI path. `failFromError` ignores the new property, and bulk retry still catches `ConflictError`.
- **Alternatives**: a `RefusalError` subclass, which works too but splits one concept over two classes. Parsing sentences in the API layer is brittle, and D4 forbids it.

### P5 — One attribution helper: `actorRefs`
- **Decision**: `src/server/dal/scope.ts` gains `actorRefs(scope): { userId: string | null; apiKeyId: string | null }`. `userId` is `membership.userId || null`, so it is never `""`. `apiKeyId` is `actor.apiKeyId` for an `api_key` actor, otherwise null.
  - `actorColumns` is rewritten on top of it, with identical output.
  - Two thin mappers sit next to it: `attemptActor(scope)` → `{ actorUserId, actorApiKeyId }` and `resolverColumns(scope)` → `{ resolvedByUserId, resolvedByApiKeyId }`.
  - They replace every `tx.membership.userId` in `retry.ts` (4 inserts) and `resolveAmbiguous` (the `common` patch and 5 inserts).
- **Rationale**: this is FR-021's "one shared helper", and it fixes F12. Member scopes produce exactly today's values (FR-022). The engine never calls these paths.
- **Alternatives**: resolve the creator's membership on every write, which is an extra query, and D7 says the key is what is shown anyway. Write the key only and never the creator, which breaks the existing "created by" convention (D7).
- **Creator "exists"**: `api_keys.created_by_user_id` is `ON DELETE SET NULL` (F11). A non-empty `userId` is therefore a real user row, and the FK accepts it whether or not that user is still a member (US6-2).

### P6 — Migration: two nullable columns with project-composite FKs
- **Decision**: add `publish_attempts.actor_api_key_id uuid NULL` and `post_targets.resolved_by_api_key_id uuid NULL`. Each gets a composite FK `(project_id, col) → api_keys(project_id, id)`, `ON DELETE no action`, named `publish_attempts_api_key_fk` and `post_targets_resolver_api_key_fk`, mirroring `posts_api_key_fk`.
  - The migration is generated with `pnpm db:generate --name api_key_attribution` and becomes `drizzle/0010_api_key_attribution.sql` plus a snapshot.
  - No index, no backfill, no new enum value.
- **Rationale**: the composite FK makes cross-project attribution impossible at the database level (constitution III). Existing rows stay null, and no API retry or resolve existed before this entry. Lookups go target → attempts, never key → attempts, so no index is needed.
- **Alternatives**: a single `actor` JSON column, which loses the FK. A plain FK to `api_keys(id)`, which loses the project pin.

### P7 — Attempt views show the key, which wins over the user column
- **Decision**: `AttemptEntryView.actor` gains `{ kind: "api_key"; name: string | null }`. `toAttemptViews` picks `api_key` whenever `actorApiKeyId` is set, then `member` when `actorUserId` is set, else `system`. Key names come from `scope.apiKeys.get(id)` for each distinct id, the same lookup as `jobs/read.ts` `keyNames`. A missing key gives `name: null`.
  - A new pure `src/lib/failures/attempt-actor.ts` exports `attemptActorLabel(actor)`. It returns `"API key {name}"`, `"Removed API key"`, the member name, or `"System"`.
  - Both pages call it in place of their inline ternaries.
- **Rationale**: this is FR-023 and SC-004. The current name is kept through revocation and expiry because `get` returns revoked keys (F13). `last4` and the hash are never read into the view (FR-026).
- **Alternatives**: a JOIN in `attempts.listForTargets`, which widens an append-only repository's row type for one view. Keep `"Former member"` semantics for keys, which the spec rejects.
- **"Removed API key" is unreachable in practice**, because the FK forbids deleting a referenced key. It is unit-tested by passing `toAttemptViews` a stub scope whose `apiKeys.get` returns null.

### P8 — Idempotency: default mode for single ops, a "self_commit" mode for bulk
- **Decision**:
  - `retryPostTarget` and `resolvePostTarget` use the default mode. Their service transaction nests as a savepoint inside the stored-answer transaction (F3, F4). The state change, attempt entries, webhook event rows and the stored answer commit together. A thrown 409 rolls back its savepoint and is stored.
  - `retryFailedTargets` uses a new `idempotencyMode: "self_commit"`, which `runIdempotent` treats exactly like `generate`: run outside the wrapper transaction, then store the answer.
  - The type's comment is updated to say "the operation commits its own effects".
- **Rationale**: this is D8 and FR-014. One wrapper transaction would hold up to 100 posts' locks (spec, "Defects found"). A separate mode name says why the bulk call is safe (015 D7: re-running is harmless) without implying the post/request-id link that `generate` relies on.
- **Alternatives**: reuse `"generate"` verbatim, which is misleading at the call site. Rename `generate` to `self_commit`, which is unrelated churn in `generate.ts` and its tests.
- **Lock duration note**: in default mode, the single-target post lock is held until the stored answer is written. That adds one `UPDATE` on `api_idempotency` after the service returns, which is negligible.

### P9 — Input adaptation in the operation, services unchanged
- **Decision**: the operation passes `{ mode, expected?, at? }` straight to `retryTarget`. Before calling `resolveAmbiguous`, it normalises resolve `expected` with `new Date(expected).toISOString()`, because the service accepts `Z` only (F8). The public contract accepts an offset for `expected` in both operations. Bulk maps `accountId` to the service's `account`.
- **Rationale**: one documented instant format across the API (RFC 3339 with offset, as `schedulePost`). `changedFromPreview` compares instants, so normalising cannot change any outcome. The service is not widened (FR-003).
- **Alternatives**: widen `resolveSchema` to accept offsets. That is harmless, but a change to the service that nothing in the UI needs.

### P10 — Response mapping
- **Decision**:
  - **Retry**: `{ postId, targetId, status: "scheduled", mode, scheduledAt, scheduledAtLocal, slotId, changedFromPreview, warnings[] }`, or `{ postId, targetId, status: "failed", reason, message, issues? }`.
  - **Resolve**: `{ postId, targetId, status: "published" }`, or `{ …, status: "scheduled", scheduledAt, scheduledAtLocal, slotId, changedFromPreview }`, or `{ …, status: "failed", reason, message }`.
  - **Bulk**: `{ mode, retried, inScope, skipped, remaining, accounts[{ accountId, name, retried, skipped, remaining }], message }`. The service's `count` becomes `retried`, and `changed` is dropped.
  - Warnings and issues use the `IssueSchema` shape through a small shared `src/server/api/operations/issues.ts` (`toIssue`, `toWarning`). `posts.ts` imports it too.
- **Rationale**: this is D6, FR-007, FR-008, FR-010 and FR-015. `scheduledAtLocal` matches the name `TargetResult` already uses.
- **Alternatives**: embed the post, which D6 rejects because a replay would return a stale snapshot.

### P11 — OpenAPI examples on requests and on every documented status of the three operations
- **Decision**: `ApiOperation` gains `body.examples?` and `responses[s].examples?`, both `Record<name, { summary, value }>`. `buildOperation` copies them onto the media-type object, for error statuses too, while keeping the shared `Error` schema.
  - The three operations list `200`, `400`, `401`, `403`, `404`, `409`, `422` and `429` with examples. That covers every retry mode and every resolve outcome, both no-free-slot outcomes, a 409 for each reason class and the idempotency errors.
  - The `409` description lists every `details.reason`.
  - `openapi.test.ts` asserts, for these three ids only, that the request and each listed status carry at least one example.
- **Rationale**: this is FR-027 and SC-007. Restricting the assertion to these three ids avoids retrofitting examples onto 009's operations, which is out of scope.
- **Alternatives**: `.meta({ example })` on the schemas, which gives one example per schema and cannot show the alternatives.

### P12 — Tests are organised per operation under `tests/integration/api/endpoints/`
- **Decision**:
  - add `retry-target.test.ts`, `resolve-target.test.ts`, `retry-failed-targets.test.ts`, `recovery-idempotency.test.ts` and `recovery-attribution.test.ts`;
  - extend `scope-enforcement.test.ts` (three fixtures; bulk has no `resourceParams`), `openapi.test.ts`, `security/secret-scan.test.ts` and `failures/attempts.test.ts` (actor views);
  - add a unit test for `attempt-actor.ts`.
- Parity (SC-005) runs the same action through the service with a member scope and through the API, then compares the target row and attempt entries (minus the id, timestamps and attribution) and the webhook event types.
- **Rationale**: this is FR-030, and it uses the existing helpers (`tests/helpers/api.ts` `world`, `createKey`, `api`).

### P13 — No new locking or concurrency surface
- **Decision**: the operations add no lock. Single ops take the existing post → targets lock order inside a savepoint. Bulk keeps 015's per-target transactions (P8). The idempotency claim is its own short statement before any lock. No new race tests are needed beyond one: two concurrent single retries with different keys give one `200` and one `409 not_failed`. That confirms the API path adds no double effect.
- **Rationale**: 012 and 015 already settled the concurrency, and the edge-case list in the spec says so.

### P15 — The bulk cap message says "call again", using the same wording function
- **Decision**: `retryAllMessage(r, opts?: { continueWith?: "press" | "call" })` in `src/lib/failures/retry-all-text.ts`. The default `"press"` keeps "Press Retry all failed again to continue." `"call"` gives "Call again with a new Idempotency-Key to continue." The operation recomputes `message` from the service result with `"call"`. Every other sentence is shared.
- **Rationale**: this is D9 and FR-017, which want the API message to say that calling again continues. Telling the caller about the key prevents the commonest mistake, a same-key replay. The UI's message is byte-for-byte unchanged (FR-003), as the existing `retry-all-text.test.ts` cases confirm.
- **Alternatives**: return the press wording as-is, which is wrong for an API caller. Build the sentence in the operation, which would be a second copy of the wording (constitution IV).

### P14 — Documentation
- **Decision**:
  - `docs/n8n.md` gains `## 7. Recover failed posts`, with the D9/US7 recipe: verify the signature, `GET /posts/{postId}`, retry each `failed` target, use `Idempotency-Key = "retry-{event.id}-{targetId}"`, keep a per-target retry limit in n8n static data, never retry `ambiguous`, branch on 409 reasons, and continue the bulk `remaining` with a new key. Its errors table gains the `409 conflict` reasons.
  - `docs/failures.md` gets a short "Through the API" section.
  - `docs/decisions.md` gets `## 016 — Public API retry and resolve (2026-10-07)`, written in this phase.
  - `README.md` gets one clause in its API sentence, if it lists operations.
- **Rationale**: this is FR-028 and FR-029.
