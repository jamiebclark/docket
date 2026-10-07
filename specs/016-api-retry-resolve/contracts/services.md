# Contract: internal changes (services, DAL, pipeline, views)

Every change is additive. UI callers pass no new arguments and see identical behaviour (FR-003). Rationale for each item is in [research.md](../research.md) (P-numbers).

## 1. `ConflictError` reason (P4) — `src/server/dal/errors.ts`

```ts
export class ConflictError extends Error {
  readonly field?: string;
  readonly reason?: string;
  constructor(message: string, opts?: string | { field?: string; reason?: string });
}
```

- A string `opts` means `field`, as today.
- Set reasons only at the throw sites listed in [data-model.md](../data-model.md) §5. `retryLockedTarget` gets the blocked reason from `retryBlockedKey` (the sentence still comes from `retryBlockedReason`).
- `mapServiceError` (`src/server/api/errors.ts`) becomes `apiError("conflict", e.message, e.reason ? { reason: e.reason } : undefined)`.

## 2. Pairing (P3) — `src/server/services/posts/locked.ts`, `retry.ts`, `index.ts`

```ts
withLockedTarget(scope, targetId, permission, fn, opts?: { postId?: string })
retryTarget(scope, targetId, input?, opts?: { postId?: string })
resolveAmbiguous(scope, targetId, input, opts?: { postId?: string })
```

After `const first = await tx.targets.get(id)`, a missing `first` or `opts?.postId && first.postId !== opts.postId` throws `NotFoundError`. This happens before `lockPost`, before `fn`, and before any write. Bulk retry and the UI actions do not pass `opts`.

## 3. Attribution (P5) — `src/server/dal/scope.ts`, `dal/attempts.ts`

```ts
export function actorRefs(scope: Pick<ProjectScope, "actor" | "membership">): { userId: string | null; apiKeyId: string | null };
export function actorColumns(scope): { createdByUserId; createdByApiKeyId };       // built on actorRefs; values unchanged
export function attemptActor(scope): { actorUserId: string | null; actorApiKeyId: string | null };
export function resolverColumns(scope): { resolvedByUserId: string | null; resolvedByApiKeyId: string | null };
```

`AttemptEntry.actorApiKeyId?: string | null` is written by `insert`.

Write sites:

- `posts/retry.ts`: each of the 4 `attempts.insert` calls spreads `...attemptActor(tx)` in place of `actorUserId: tx.membership.userId`.
- `resolveAmbiguous`:
  - `const common = { ...resolverColumns(tx), resolvedAt: now }`;
  - each of its 5 inserts spreads `...attemptActor(tx)`;
  - the local `actor` variable is removed.

## 4. Attempt views (P7) — `src/server/services/failures.ts`, `src/lib/failures/attempt-actor.ts`

```ts
// failures.ts
actor: { kind: "api_key"; name: string | null } | { kind: "member"; name: string } | { kind: "system" };
toAttemptViews(scope, rows)  // + distinct actorApiKeyId → scope.apiKeys.get(id) → name (null when not found)

// attempt-actor.ts (pure, no server imports)
export type AttemptActor = …same union…;
export function attemptActorLabel(actor: AttemptActor): string;
```

- `failures.ts` imports the `AttemptActor` type from the lib module, so the type has one source.
- `src/app/p/[projectSlug]/failures/page.tsx:94` and `src/app/p/[projectSlug]/posts/[postId]/page.tsx:197` render `attemptActorLabel(…)`.

## 5. Idempotency mode (P8) — `operations/types.ts`, `api/idempotency.ts`

- The type becomes `idempotencyMode?: "transaction" | "generate" | "self_commit"`.
- The `runIdempotent` branch becomes `if (op.idempotencyMode === "generate" || op.idempotencyMode === "self_commit")`. The branch body is unchanged.
- Update the doc comment.

## 6. Bulk message (P15) — `src/lib/failures/retry-all-text.ts`

```ts
export function retryAllMessage(r, opts?: { continueWith?: "press" | "call" }): string;
```

`"press"` is the default and gives the current output exactly. `"call"` replaces only the final sentence, with "Call again with a new Idempotency-Key to continue."

## 7. Operations (P1, P2, P9, P10, P11)

- **`src/server/api/operations/issues.ts`** (new): `toIssue` (moved from `posts.ts`) and `toWarning(w) → { severity: "warning", code, message }`. `posts.ts` imports them.
- **`src/server/api/operations/targets.ts`** (new): `targetOperations` holds three `defineOperation` entries. Each `run` does exactly one service call and a pure mapping:
  - `retryPostTarget` calls `retryTarget(scope, params.targetId, body, { postId: params.postId })` and maps it to `RetryTargetResult`.
  - `resolvePostTarget` calls `resolveAmbiguous(scope, params.targetId, normalised(body), { postId: params.postId })` and maps it to `ResolveTargetResult`.
  - `retryFailedTargets` calls `retryAllFailed(scope, { ...(body.accountId ? { account: body.accountId } : {}), mode: body.mode })` and maps `count → retried`, rebuilding `message` with `continueWith: "call"`. It uses `idempotencyMode: "self_commit"`.
  - None uses `prepare`: there is no image work, because the gate runs on stored variants as in the UI retry.
- **`src/server/api/operations/index.ts`**: spread `targetOperations` after `postOperations`.
- **`src/lib/api/schemas.ts`**: adds the six schemas (P2). Each request and result schema has `.meta({ id })`: `RetryTargetRequest`, `RetryTargetResult`, `ResolveTargetRequest`, `ResolveTargetResult`, `RetryFailedTargetsRequest`, `RetryFailedTargetsResult`. Also exports `ApiRetryTargetResult` etc. via `z.infer` for the mapping functions' return types.
- **`ApiOperation`** gains `body.examples?` and `responses[s].examples?: Record<string, { summary: string; value: unknown }>`. `buildOperation` (`src/server/api/openapi.ts`) copies them onto `content["application/json"].examples`, for success and error statuses alike. Operations without them render exactly as today.

## 8. Not changed

- `retryLockedTarget`'s and `retryAllFailed`'s logic.
- `allocateNextFree`, `gate` and `applyDerivedStatus`.
- The scheduler, the providers and the webhook emitter.
- `KEY_GRANTS` and the `api_key_permission` enum (D2).
- The `"Deleted key"` wording in `views/load.ts` and `jobs/read.ts`.
