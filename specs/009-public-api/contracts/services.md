# Contract: API pipeline, DAL additions, and service changes

The 007 and 008 rules carry over:

- every service takes a `ProjectScope` first;
- input is `unknown` and parsed with Zod;
- permissions are checked with `scope.can()` / `need()` on the server and again inside the transaction;
- errors are the DAL error classes.

This entry adds no business rule that lives only in the API. Each new rule sits in a service that the UI also uses, or could use (constitution IV, FR-044).

## Module layout

```text
src/app/api/v1/[[...path]]/route.ts   # GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS → handleApiRequest (only file under app/api/v1)

src/server/api/
├── handle.ts          # handleApiRequest(request, segments): the pipeline (research D7)
├── router.ts          # matchOperation(method, segments) → { op, params } | 404 | 405 (+ Allow)
├── operations/
│   ├── index.ts       # OPERATIONS: readonly ApiOperation[] (the single list the router, OpenAPI and tests use)
│   ├── accounts.ts  media.ts  posts.ts  generate.ts  slots.ts  jobs.ts  openapi.ts
├── auth.ts            # readKey(headers) → string | null | "conflict"
├── idempotency.ts     # claim / complete / release; canonical body hash (research D8–D10)
├── errors.ts          # ApiErrorCode list, apiError(), mapServiceError()
├── respond.ts         # json(), replay(), headers (X-Request-Id, Cache-Control, Retry-After)
├── pagination.ts      # encodeCursor / decodeCursor / pageQuerySchema
└── openapi.ts         # buildOpenApiDocument() (zod-openapi), memoised

src/lib/api/schemas.ts       # output Zod schemas (Account, Media, Post, Target, Job, …), .meta({ id })
src/lib/validation/api.ts    # createApiKeySchema, webhookEndpointSchema, idempotency key, upcoming query
src/server/services/views/   # pure presenters: toApiPost, toApiTarget, toApiJob, toApiJobItem, toApiMedia, toApiAccount
src/server/services/api-keys.ts
src/server/services/webhooks/{index,endpoints,emit,deliver,sign}.ts
src/server/services/media-from-url.ts
src/server/net/safe-fetch.ts
src/server/dal/{api-keys,idempotency,webhooks}.ts
src/server/scheduler/webhooks.ts
```

**Import rule (FR-044)**: files under `src/app/api/v1/**` and `src/server/api/operations/**` may import:

- `@/server/api/*` (types and helpers only);
- `@/server/services/**`;
- `@/lib/**`;
- `zod`.

They must not import `@/server/dal`, `@/server/db`, `pg` or `drizzle-orm`. `tests/lint/api-imports.test.ts` scans the import specifiers, in the same way as `import-boundaries.test.ts`. `src/server/api/handle.ts` and `idempotency.ts` are the pipeline. They may import the DAL entry points (`forApiKey`, the idempotency repo), the way server actions call `forProject`.

## ApiOperation

```ts
export interface ApiOperation<P = unknown, Q = unknown, B = unknown> {
  id: string;                                  // operationId, unique
  method: "GET" | "POST";
  path: string;                                // "/posts/{postId}/queue"
  permission: ApiKeyPermission | null;         // null only for getOpenApi
  summary: string; description?: string; tag: string;
  params?: z.ZodType<P>; query?: z.ZodType<Q>;
  body?: { kind: "json"; schema: z.ZodType<B> } | { kind: "multipart"; schema: z.ZodType<B> };
  responses: Record<number, { description: string; schema?: z.ZodType }>;
  /** Writes: true. The pipeline applies research D8 around `run`. */
  idempotent: boolean;
  /** "transaction" (default for writes): run inside the idempotent transaction. "generate": the D8 step-3 path. */
  idempotencyMode?: "transaction" | "generate";
  /** Optional slow, repeatable pre-work run before the idempotent transaction (media processing, variants). */
  prepare?: (scope: ProjectScope, input: { params: P; query: Q; body: B }) => Promise<unknown>;
  /** Calls exactly one service and maps its result. */
  run: (scope: ProjectScope, input: { params: P; query: Q; body: B; prepared: unknown; requestId: string; idempotencyRecordId: string | null }) =>
    Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
  /** For the scope test (FR-048): which path params name project resources. */
  resourceParams?: ("postId" | "targetId" | "mediaId" | "jobId" | "itemId")[];
}
```

`prepare` exists only to keep slow I/O out of the held transaction. It may call services, such as `media.prepareUpload`, `media.fetchForUpload` or `posts.prepareForScheduling`. It never commits a business effect: storage objects and cached variants only.

## Authentication and rate limit

```ts
// dal/api-keys.ts
export const API_KEY_PREFIX = "dkt_";
export function generateApiKey(): { key: string; keyHash: string; last4: string };   // 32 random bytes, base64url
export function hashApiKey(key: string): string;                                     // sha256 hex
export function isWellFormedApiKey(v: unknown): v is string;                         // /^dkt_[A-Za-z0-9_-]{43}$/

/** Authenticates and counts one request. Throws InvalidApiKeyError (→401). Returns the scope and the window state. */
export async function forApiKey(rawKey: string): Promise<{ scope: ProjectScope; rate: { count: number; limit: number; resetAt: Date } }>;
```

1. Check `isWellFormedApiKey`, else throw `InvalidApiKeyError`.
2. Under `crossProject("api: authenticate key")`, select the key by `key_hash` joined to `projects` (with the `projectColumns`). Missing, revoked, expired, or no project → throw `InvalidApiKeyError`.
3. Run the research D4 UPDATE (pinned to `project_id`). Zero rows means it was revoked concurrently → throw `InvalidApiKeyError`.
4. `buildScope(db, { project, membership: { memberId: "api-key:" + id, userId: createdByUserId ?? "", role: "editor" } }, { kind: "api_key", apiKeyId, name, permissions })`.

The pipeline compares `rate.count > rate.limit` → 429, with `Retry-After = ceil((resetAt − now)/1000)`.

### Scope changes (`dal/scope.ts`)

- `ProjectScope` gains `readonly actor: { kind: "member" } | { kind: "job_runner" } | { kind: "api_key"; apiKeyId: string; name: string; permissions: readonly ApiKeyPermission[] }`.
- `can()` answers by actor:
  - member: unchanged (the role);
  - job_runner: unchanged (editor);
  - api_key: the mapping below.
- `transaction()` inside a key scope re-reads the key: `SELECT … WHERE project_id AND id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, its own statement. A miss throws `InvalidApiKeyError`. Members still re-resolve membership, and the job runner keeps its fixed membership.
- `actorColumns(scope)` (exported helper): `{ createdByUserId: membership.userId || null, createdByApiKeyId: actor.kind === "api_key" ? actor.apiKeyId : null }`.
- New error class `InvalidApiKeyError` (`dal/errors.ts`).

### Key permissions to access statements

| Key permission | Grants (`can()` true for) |
|---|---|
| `read` | `project:view`, `member:view`, `account:view`, `slot:view`, `media:view`, `post:view`, `voice:view` |
| `write_posts` | `media:edit`, `post:edit`, `post:schedule` |
| `generate` | `generation:run`, `post:edit` |
| `manage_jobs` | `generation:run`, `post:edit` |
| `auto_approve` | `generation:auto_approve` |

A key never grants:

- `project:update`;
- any `member` right other than view;
- `invitation:*` and `audit:*`;
- `account:manage`, `slot:manage` and `voice:manage`;
- `post:delete`;
- `api_key:*` and `webhook:*`.

The pipeline's operation check (FR-004) runs first. This mapping is the backstop the services enforce.

## Idempotency

```ts
// dal/idempotency.ts (scoped by project_id; one repo on ProjectScope: `idempotency`)
claim(input: { apiKeyId; method; route; idemKey; bodyHash; holdMs }): Promise<
  | { kind: "claimed"; recordId: string; token: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in_progress"; retryAfterSeconds: number }>;
complete(recordId: string, token: string, status: number, body: unknown): Promise<boolean>; // conditional on token
release(recordId: string, token: string): Promise<void>;                                   // delete WHERE token
purgeExpired(limit: number): Promise<number>;                                               // crossProject housekeeping
```

`claim` follows research D8 step 1. The INSERT … ON CONFLICT DO NOTHING runs as its own statement outside any transaction. The read of the existing row and the takeover's conditional UPDATE are single statements too.

Pipeline, for a write with a key:

```text
hash = canonicalHash(body)             // D9
c = claim(...)
replay/mismatch/in_progress → respond (nothing stored)
prepared = op.prepare?.(scope, input)  // outside any transaction; a throw → release + error response
if mode = "transaction":
  scope.transaction(tx =>
    try   r = await tx.transaction(inner => op.run(inner, input))   // savepoint: a 4xx rolls back only this
    catch e (mapped to < 500) → r = mapServiceError(e)
    if !(await tx.idempotency.complete(id, token, r.status, r.body)) throw HoldLost   // → 500, all rolled back
    return r)
  on 5xx or throw → release(id, token)
if mode = "generate":
  r = await op.run(scope, { ..., idempotencyRecordId: id })   // derives requestId from the record id
  r.status < 500 ? complete(id, token, …) : release(id, token)
```

`Idempotent-Replayed: true` is set only on replays. The stored body is replayed byte for byte as JSON, and the stored `requestId` inside an error body stays the original's. `X-Request-Id` is the new request's.

The hold is `max(300 s, 2 × LLM_TIMEOUT_SECONDS + 120 s)`, computed once from env (`apiIdempotencyHoldMs()` in `src/server/api/idempotency.ts`).

## API keys service (`services/api-keys.ts`)

| Function | Rules |
|---|---|
| `listApiKeys(scope)` | `requirePermission(scope, { api_key: ["manage"] })`. Returns `ApiKeyView[]`: `{ id, name, display: "dkt_…" + last4, permissions, rateLimitPerMinute, expiresAt, createdAt, lastUsedAt, status: "active" \| "expired" \| "revoked", createdBy: { name, isMember }, revokedAt, revokedBy }`. No hash ever leaves the DAL: the repo's select excludes `key_hash`. |
| `createApiKey(scope, input)` | `createApiKeySchema`. In `transaction(…, { lockProject: true })`: count active keys (≥ 25 → `ConflictError("A project can have at most 25 active keys. Revoke one first.")`), insert, and `recordAudit({ action: "api_key_create", details: { apiKeyId, name, permissions, rateLimitPerMinute, expiresAt } })`. Returns `{ key: ApiKeyView, secret: string }`, the **only** place the plaintext appears. |
| `revokeApiKey(scope, id)` | Conditional UPDATE. If it changed a row, write the audit row (`api_key_revoke`, `{ apiKeyId, name, permissions }`) in the same transaction and return `{ revoked: true }`. If not, `{ revoked: false, message: "This key was already revoked." }`. An unknown id → `NotFoundError`. |

New access statement: `api_key: ["manage"]` and `webhook: ["manage"]`, on owner and admin only (`src/server/auth/access.ts`). `tests/integration/actions-authz.test.ts` gains rows for every new server action × role.

## Webhooks service (`services/webhooks/`)

| Function | Rules |
|---|---|
| `listEndpoints(scope)` | `webhook:manage`. Returns each endpoint with its events, enabled flag, disabled reason, last delivery `{ status, at, statusCode }`, and `secretRotating: boolean` (an overlap is active). No secret. |
| `createEndpoint(scope, input)` | `webhookEndpointSchema`. Under the project lock: cap 10, generate `whsec_…`, encrypt with AAD, insert, audit `webhook_create` `{ endpointId, description, events, host }`. Returns `{ endpoint, secret }`, shown once. `httpWarning: true` when the scheme is `http`. |
| `updateEndpoint(scope, id, input)` | URL, description, events. Audit `webhook_update`. Never returns the secret. |
| `setEndpointEnabled(scope, id, enabled)` | Enable clears `disabled_reason` and `consecutive_failures`, and does **not** requeue old failures. Disable (manual) marks that endpoint's `pending` deliveries `failed` with `endpoint_disabled`. Audited. |
| `deleteEndpoint(scope, id)` | Hard delete, cascading to deliveries and attempts. Audit `webhook_delete`. |
| `rotateSecret(scope, id)` | `previous = current`, `previous_expires_at = now + 24 h`, `current = new`. Audit `webhook_rotate_secret`. Returns `{ secret }`, shown once. |
| `listDeliveries(scope, endpointId, page)` | Newest first, with attempts (time, status code or error kind, duration, excerpt). |
| `resendDelivery(scope, deliveryId)` | Insert a new `pending` delivery for the same event and endpoint, `resend_of = deliveryId`. The endpoint must be enabled, otherwise `ConflictError`. |
| `sendTestEvent(scope, endpointId)` | Insert a `ping` event (`data: { endpointId }`) and one delivery to that endpoint only. |
| `emitEvent(tx, type, subject)` | See [webhooks.md](./webhooks.md#emission). |

Audit details never use the keys `url`, `secret` or `token` (F15). The endpoint's host goes in `host`.

## Media

```ts
export async function prepareUpload(scope, file: { name: string; bytes: Buffer }): Promise<PreparedUpload | UploadRejection>; // process + storage put; no DB
export async function commitUpload(tx: ProjectScope, prepared: PreparedUpload, meta?: { altText?: string; tags?: string[] }): Promise<MediaView>;
export async function uploadMedia(scope, input): Promise<UploadResult>;   // = prepareUpload + scope.transaction(commitUpload); unchanged behaviour
export async function fetchForUpload(scope, input: { url: string }): Promise<{ name: string; bytes: Buffer }>; // safe-fetch; throws UrlFetchError
export async function registerMediaFromUrl(scope, input): Promise<MediaView>; // fetchForUpload + prepareUpload + commitUpload (UI-callable)
```

- `commitUpload` writes `actorColumns(tx)`.
- If the idempotent transaction rolls back after `prepareUpload`, the storage objects are deleted in a `finally` (best effort, as `uploadMedia` does today), and an orphan is logged.
- The API operation for `POST /media` maps an `UploadRejection` to 415 or 413 with the rejection's message.

## Posts and queue

| Function | Change |
|---|---|
| `createDraft` | When `scope.actor.kind === "api_key"`: `origin = "api"` and `created_by_api_key_id`. Otherwise unchanged. |
| `prepareForScheduling(scope, postId, targetIds?)` | Exported wrapper of the existing private `prepare()`. |
| `listUpcomingOccurrences(scope, { accountId?, from?, days = 14 })` | `slot:view`. Max 60 days. Free and taken occurrences, each `{ accountId, slotId, at, local, free, postId, targetId }`, sorted by time then account. Uses `targets.heldOccurrences`. |
| `getPostView` | Unchanged. The API presenter adds origin, generation summary, creator and target extras from `posts.get` and `targets.listForPost`, the same reads. |

## Jobs

| Function | Change |
|---|---|
| `createJob` | Accepts `source.kind: "api"` (research D19). Writes `open`, `actorColumns`. Uses `prepared.mediaRules` for reserved and used images. Refused reserved images throw `MediaReservedError({ items })` → 409. |
| `appendItems(scope, jobId, input)` | New. Research D18. Returns `{ added, itemCount, items: { id, position }[] }`. |
| `closeJob(scope, jobId)` | New. Research D18. Also a server action on the job page. |
| `cancelJob` | Also sets `open = false`, writes `cancelled_by_api_key_id`, and emits `job.finished`. |
| `getJobItem(scope, jobId, itemId)` | New, read.ts. One item in the `JobItemView` shape; 404 if it is not on that job. |
| `deriveJobStatus(current, counts, started, open)` | The open branch (research D18). `status.test.ts` gains open-job cases, and the existing cases pass `open: false`. |
| `refreshJobStatus` | Emits `job.finished` on a change into a finished state. |
| runner | `saveGeneratedPost` receives `createdByApiKeyId: job.createdByApiKeyId`. |

New errors (`dal/errors.ts`), each with an explicit `name`: `JobClosedError`, `MediaReservedError` (with `items: { index, mediaId, reason: "reserved" | "deleted" | "unknown" }[]`), `JobItemLimitError`, `InvalidApiKeyError`, and `UrlFetchError` (with `code`). Missing storage already throws `StorageUnavailableError` (`src/server/storage/errors.ts`), and the API maps it to 503 `storage_not_configured`. `src/lib/action-result.ts` maps the job errors for the UI.

## Generation

`generateSingle` is unchanged, apart from attribution: `saveGeneratedPost` receives `createdByApiKeyId` from `actorColumns(tx)`. The API operation:

1. builds the service input from the body (`accountIds` → `targetAccountIds`, `approvalPolicy` → `approval`, and so on);
2. sets `requestId = uuidFromHash("idem:" + recordId)`, or a random uuid without a key;
3. maps the result:
   - `ok: true, existing: false` → 201;
   - `existing: true` → 200;
   - `ok: false` → 422 or 503 by kind ([http-api.md](./http-api.md#operations)).
