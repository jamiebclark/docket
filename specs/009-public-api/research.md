# Research: Public API, API keys, idempotency, webhooks and OpenAPI (009)

Phase 0 output for [plan.md](./plan.md). The spec has no blocking `NEEDS RESEARCH`. It leaves three things to planning:

- whether `@better-auth/api-key` fits (it does not; D1);
- how a key acts inside the scoped DAL (D2);
- the open-job change to 008 (D17).

Every installed-library fact below was read from the package in `node_modules` or checked by running it during planning (constitution I and II). The probes ran under Node 24.16 from `.next/cache/` and were then deleted.

## 1. Facts checked during planning

| # | Fact | How it was checked |
|---|---|---|
| F1 | `@better-auth/api-key` 1.7.7 hashes keys by default and stores `start` (the first 6 characters by default), `prefix`, `referenceId` (user or organization id), `enabled`, `expiresAt`, `permissions` (a JSON string), `rateLimitMax`, `rateLimitTimeWindow`, `requestCount`, `lastRequest` and `metadata`. Only the create response contains `key`. | `dist/types-y22rgFHR.d.mts` (`apiKeySchema`, `ApiKey`), `dist/index.mjs` create route (`return ctx.json({ ...apiKey, key, … })`). |
| F2 | The plugin **deletes** a key row when an expired key is verified (`validateApiKey` → `adapter.delete`). Every create call also runs `deleteAllExpiredApiKeys(ctx.context)`. | `dist/index.mjs`, `validateApiKey` and the create route. |
| F3 | For `references: "organization"`, create, read, update and delete call `checkOrgApiKeyPermission`. That reads the `member` row and checks `hasPermission({ permissions: { apiKey: [action] } })` against the organization plugin's access control. Docket's `statements` have no `apiKey` entry. | `dist/index.mjs`, `org-authorization` region; `src/server/auth/access.ts`. |
| F4 | The plugin's rate limit consumes atomically with guarded `incrementOne` (compare-and-swap on `requestCount` and `lastRequest`). A deny returns `details.tryAgainIn` in ms. Its window is measured from `lastRequest`, which moves on every counted request. | `dist/index.mjs`, `evaluateRateLimit` and `consumeRateLimit`. |
| F5 | `zod-openapi` 6.0.2 `createDocument({ openapi: "3.1.0", info, components: { securitySchemes }, paths })` with `requestParams: { path, query, header }` (Zod objects), `requestBody.content[mime].schema`, and per-status `responses` with `headers` (a Zod object) and `content`. Schemas with `.meta({ id })` become `#/components/schemas/<id>` refs. `x-*` keys on an operation are passed through. Supported versions are `3.0.0`–`3.2.0`. `z.file()` inside a `multipart/form-data` body renders without error. | `lib/components-CHDAxPEZ.d.mts`, plus a probe that built a two-path document and printed it. |
| F6 | Neither direct dependencies nor `node_modules/.bin` contain an OpenAPI validator. `ajv` exists only as a transitive dependency of eslint and commitlint, and it is not importable from the app. | `package.json`, `ls node_modules`, `pnpm why ajv`. |
| F7 | `http.request({ lookup })` (`@types/node/http.d.ts` `ClientRequestArgs.lookup`) is used for the connection: a probe request to `probe.invalid` with a custom `lookup` returning 127.0.0.1 got a 200 from a local server. `net.BlockList` with `addSubnet` matches IPv4 and IPv6 ranges. | Probe, `@types/node/net.d.ts`. |
| F8 | Node 24 global `fetch` with `redirect: "manual"` returns the 3xx response itself (status 302 with `location`). `AbortSignal.timeout(ms)` bounds it. `Request.formData()` parses multipart into `File` objects with `name`, `size` and type. | Probe against a local server. |
| F9 | `createHmac("sha256", key).update(…).digest("hex")` gives 64 hex characters. `timingSafeEqual` exists in `node:crypto`. | Probe. |
| F10 | Next 16.3.8 route handlers export `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS`. For `app/x/[...slug]/route.ts`, `params` is a `Promise<{ slug: string[] }>`. Without an `OPTIONS` export, Next answers OPTIONS with an `Allow` header itself. | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. |
| F11 | `src/proxy.ts` redirects every path that is not in `PUBLIC_PREFIXES` (`src/lib/auth-gate.ts`) to `/login` when there is no session cookie. `/api/v1/` is not listed today. | Source. |
| F12 | Existing services and their shapes: `posts.createDraft` (schema already allows `origin: "api"`), `validatePost`, `addToQueue`, `scheduleAt` and `getPostView`; `media.uploadMedia` (process, then storage `put`, then a DB insert in its own transaction); `listMedia` and `getMedia`; `generation.generateSingle` (needs `requestId`, dedupes on `posts_generation_request_uq`, then `applyApprovalPolicy` in a second transaction); `queue.listEmptySlots` (free occurrences only, `MAX_RANGE_DAYS` 92); `accounts.listAccounts`; `jobs.createJob`, `insertItems`, `cancelJob`, `retryFailedItems`, `getJob` and `listJobItems`. | Source under `src/server/services/`. |
| F13 | Status writers: `applyDerivedStatus` (posts) is called from about 15 sites, both services and scheduler. `refreshJobStatus` (jobs), except `cancelJob`, which writes `cancelled` itself. The account flag goes to `needs_reauth` through `accounts.recordRefresh(…, { status: "needs_reauth" })` (`scheduler/credentials.ts`, `scheduler/token-refresh.ts`) and `accounts.markCredentialsInvalid` (`scheduler/publishing.ts`). Each is a single UPDATE outside any transaction. | `grep` over `src/server`. |
| F14 | `LLM_TIMEOUT_SECONDS` is 10–600 (default 90). A single generation makes at most 2 model calls (007's correction retry). | `src/server/llm/config.ts`, 007 research. |
| F15 | `recordAudit` refuses detail keys matching `/token\|url\|password\|secret/i`. `membership_audit_log.action` is the `membership_action` enum. | `src/server/services/audit.ts`, `db/schema/audit.ts`. |

## 2. API keys

### D1: Docket-owned hashed key table, not `@better-auth/api-key`

- **Decision**: a project-owned `api_keys` table, reached through a DAL repository. The full record is in [data-model.md](./data-model.md#api_keys).
  - The secret is `dkt_` plus 43 base64url characters (32 random bytes).
  - It is stored only as `key_hash`, the SHA-256 hex of the full key, with a unique index.
  - `last4` is kept for display.
  - Verification is one indexed lookup by hash.
- **Rationale**: the spec asks planning to confirm fit against FR-001 to FR-012. The plugin fails several of them:
  - **FR-001/FR-005 (list and history)**: the plugin deletes an expired key when it is next used, and sweeps all expired keys on every create (F2). Expired keys would vanish from the list and from the record of who created them.
  - **FR-002 / constitution III**: the plugin's table has `referenceId`, not `project_id`. It is read and written through Better Auth's adapter, outside the scoped DAL and its scope test. Org-owned management also needs an `apiKey` statement in Docket's access control and runs Better Auth's own member check (F3), a second authorisation path beside the DAL.
  - **FR-006**: the plugin stores the first characters, not the last four.
  - **FR-008**: a create through `auth.api.createApiKey` cannot share a transaction with Docket's audit row.
  - **FR-011**: the plugin's window slides with every request (F4). That is workable, but it is one more behaviour to adapt.

  The table, hash and lookup together are less code than the adapter work around those gaps. The plugin stays installed and unused, which is logged. Removing it is a separate `build:` change.
- **Alternatives**:
  - **The plugin with `metadata` for last4 and revoker, and our own expiry**: rejected, because it still bypasses the DAL and still deletes rows on create.
  - **bcrypt or argon2 hashes**: rejected, because a 256-bit random secret needs no slow hash, and lookup must be by hash. This matches invitation tokens (001 D6).

### D2: A key acts through a scope with `actor.kind = "api_key"`

- **Decision**: `forApiKey(rawKey)` in `src/server/dal/api-keys.ts`:
  1. It checks the format, hashes the key, and reads the key joined to its project, as `crossProject("api: authenticate key")`. This is the only cross-project read, like `forProject`'s resolve.
  2. It refuses a revoked or expired key, or a deleted project, with `InvalidApiKeyError`.
  3. It builds the normal `ProjectScope` with:
     - `membership = { memberId: "api-key:<id>", userId: key.createdByUserId ?? "", role: "editor" }`;
     - `actor = { kind: "api_key", apiKeyId, name, permissions }`;
     - `can()` answering from the key's permissions through a fixed mapping ([contracts/services.md](./contracts/services.md#key-permissions-to-access-statements)), never from the creator's role.

  `scope.transaction` re-checks the key (not revoked, not expired) inside the transaction instead of re-resolving membership. A key revoked mid-request therefore commits nothing, and the request gets 401.

  `role: "editor"` is the least role, so every `requireRole(scope, "owner", "admin")` refuses a key. Keys cannot manage members, keys, webhooks, accounts, slots or voice profiles.
- **Rationale**:
  - Spec assumption: "planning decides how the scoped data-access layer represents a key actor without weakening the membership check for people". People still go through `resolve()` against `member` on every call and every transaction. Keys go through their own resolver.
  - Spec decision: keys stay valid when their creator leaves.
  - FR-004: the service's own `can()` checks still apply.
- **Alternatives**:
  - **Running as the creator's membership**: rejected, because it breaks when the creator leaves and grants the creator's whole role.
  - **A separate API-only DAL**: rejected by constitution III and IV.

### D3: Attribution to the key

- **Decision**: new nullable columns `created_by_api_key_id` on `posts`, `generation_jobs` and `media_assets`, plus `cancelled_by_api_key_id` on `generation_jobs`.
  - Each is a composite FK `(project_id, id)` → `api_keys`, with `ON DELETE SET NULL` on the key column. Keys are never deleted, so the rule only matters for project deletion.
  - A helper `actorColumns(tx)` returns `{ createdByUserId: userId || null, createdByApiKeyId }`. The write sites the API reaches use it: `createDraft`, `uploadMedia` / `commitUpload`, `saveGeneratedPost` (via `generateSingle`), `createJob` and `cancelJob`.
  - The job runner copies the job's `created_by_api_key_id` onto the posts it saves.
  - Posts and job views show "API key: <name>" when it is set.
- **Rationale**: spec decision "actions taken with a key are attributed to the key (its name and creator)", and Key entities "Posts and jobs made with a key record the key as creator". `created_by_user_id` keeps the creator's user id, so existing views keep a name.
- **Alternatives**: a synthetic user per key. Rejected, because it would put users into Better Auth tables that cannot log in.

### D4: Rate limit: a fixed one-minute window on the key row

- **Decision**: one conditional UPDATE per authenticated request ([contracts/services.md](./contracts/services.md#authentication-and-rate-limit)):

  ```sql
  UPDATE api_keys
  SET rate_window_start = $w,
      rate_window_count = CASE WHEN rate_window_start = $w THEN rate_window_count + 1 ELSE 1 END,
      last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < $now - interval '60 seconds' THEN $now ELSE last_used_at END
  WHERE project_id = $p AND id = $id AND revoked_at IS NULL
  RETURNING rate_window_count, rate_limit_per_minute
  ```

  Here `$w = date_trunc('minute', db now)`. A count above the limit is refused with 429 `rate_limited` and `Retry-After` = seconds to the next minute (at least 1). A refused request has no other effect. The row lock serialises concurrent requests for one key, so the count is exact across any number of web processes (FR-011, "no new infrastructure"). `last_used_at` changes at most once a minute (FR-007).
- **Rationale**: the spec says per-key requests per minute. A fixed window is the simplest exact counter. It can let up to twice the limit through across a minute boundary, which is documented. Putting the count on the key row needs no table and no cleanup.
- **Alternatives**:
  - **A sliding log table**: rejected, because it costs one row per request plus cleanup.
  - **In-memory buckets**: rejected, because they do not hold across processes.
  - **The plugin's counter**: see D1.

### D5: Key lifecycle rules

- **Create**: owner or admin only (`api_key: manage`, a new statement on owner and admin). It takes:
  - a name, 1–64 characters;
  - permissions: a non-empty subset of the five;
  - a limit of 1–1,000 (default 60);
  - an expiry of `never`, `30`, `90` or `365` days.

  It writes the audit row in the same transaction. The 25-active-key cap (active means not revoked and not expired) is checked under a project lock (`transaction(…, { lockProject: true })`), so two concurrent creates cannot both pass it.
- **Revoke**: a conditional `UPDATE … SET revoked_at, revoked_by_user_id WHERE revoked_at IS NULL`. Zero rows means "already revoked" and changes nothing. The UI says "This key was already revoked." Nothing un-revokes a key, and the DAL has no such method.
- **Expiry** is evaluated at authentication time against the DB clock. Expired keys stay in the list as "expired".
- **Creator removed**: the list joins `member` to show "no longer a member" (spec edge case).

## 3. Requests, errors and the router

### D6: One catch-all route and an operation table

- **Decision**:
  - `src/app/api/v1/[[...path]]/route.ts` exports `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. Each calls `handleApiRequest(request, segments)`.
  - `src/server/api/operations/*.ts` declare the operations: id, method, path template, permission, request schemas, response schemas, idempotent flag, and handler.
  - The router matches the path template, then the method. A path match with the wrong method returns 405 with `Allow`. No match returns 404, both in the standard error shape.
  - `HEAD` and `OPTIONS` are explicit. OPTIONS returns 204 with `Allow`. HEAD on a GET route runs the GET and returns no body (Next would otherwise answer them itself; F10).
  - The OpenAPI document is generated from the same table (D14).
- **Rationale**:
  - FR-047 ("documented operations equal the routes the router serves") and FR-048 ("driven by the list of operations, so a new endpoint cannot skip it") are simplest when routes *are* data.
  - One pipeline makes FR-044's "handlers only authenticate, check, parse, call, map" structural.
- **Alternatives**: one Next `route.ts` per path. Rejected, because the router would then be the filesystem, which the tests cannot enumerate reliably, and auth and idempotency would be repeated per file.

### D7: Pipeline order

Each request runs these steps in order; any step can end it:

1. `X-Request-Id` (a new UUID; the client's value is never trusted).
2. Route match: 404 or 405.
3. The public operation (`openapi.json`) returns here.
4. Key from `Authorization: Bearer` or `X-API-Key`. Both present and different, or neither: 401. Cookies are never read.
5. `forApiKey`: 401.
6. Rate-limit UPDATE: 429.
7. Permission: 403 `missing_permission` with `details.permission`.
8. Content type: 415. Body size: 413. JSON parse: 400 `invalid_json`. `Idempotency-Key` format: 400.
9. For writes with a key, idempotency claim (D8): replay, 422 or 409.
10. Zod parse of params, query and body: 400 `validation_failed` with `details[]`.
11. The handler calls one service.
12. Map the result or error.

Steps 1–8 store nothing (FR-017). Permission comes after the rate limit, because a refused request still counts as use of the key. Idempotency comes after permission, because a 403 must never consume or replay a key (spec edge case).

### D8: Idempotency: claim first, then run the effect and store the result in one transaction

- **Decision** ([contracts/services.md](./contracts/services.md#idempotency)): table `api_idempotency_keys`, unique on `(api_key_id, method, route, idem_key)`. Here `route` is the concrete path without the query, for example `/posts/<uuid>/queue`.
  1. **Claim**, in its own short committed statement: `INSERT … (state 'in_progress', body_hash, lock_token, hold_until = now + hold, expires_at = now + 7 d) ON CONFLICT DO NOTHING RETURNING id`. On conflict, read the row:
     - `completed` with the same hash: **replay** the stored status and body with `Idempotent-Replayed: true`;
     - a different hash, in any state: **422** `idempotency_key_reused`;
     - `in_progress` with `hold_until > now`: **409** `idempotency_in_progress` with `Retry-After` = seconds left on the hold, capped at 60;
     - `in_progress` with an expired hold, or an expired (`expires_at <= now`) row: **take over** with a conditional `UPDATE … SET lock_token = $new, hold_until = …, state = 'in_progress', body_hash = $h, response_* = NULL WHERE id = $id AND (hold_until <= now OR expires_at <= now)`. Zero rows means another request just took it, so answer 409.

     The unique index is the database guarantee (FR-016). No request ever waits on another: the claim never blocks, because the conflicting row is already committed.
  2. **Run and complete in one transaction** (FR-017), for every endpoint except `POST /generate`:
     - Slow, repeatable pre-work runs first, outside any transaction. This is the URL fetch, image processing and storage `put` for media, and `prepareVariants` for queue and schedule.
     - Then one transaction opens. The handler's service runs with a scope bound to that transaction, so the service's own `scope.transaction` calls become savepoints.
     - Inside the same transaction the wrapper runs `UPDATE api_idempotency_keys SET state='completed', response_status, response_body, completed_at WHERE id = $id AND lock_token = $token`. Zero rows means the hold was lost: throw, and everything rolls back.

     The effect and the stored result therefore commit or roll back together. A 4xx raised by the service rolls back to the savepoint and still stores the 4xx result in the outer transaction. A 5xx rolls the whole transaction back. A short follow-up statement then deletes the claim (`WHERE lock_token = $token`), so the key can be used again. A killed process leaves only an expired hold.
  3. **`POST /generate`** makes a model call, which must not run inside a held transaction (008 constraint).
     - It passes `requestId = uuid(sha256("idem:" + record.id))` to `generateSingle`. The post insert is then linked to the idempotency record by 007's existing unique index `posts_generation_request_uq`.
     - After the service returns, the result is stored with the same lock-token check.
     - If the process dies between the save and the store, the retry after the hold finds the post through `findByRequestId` and returns the same post without a model call (`existingResult`). The stored response is then written. No second post can exist, because the unique index is the guarantee.
     - Without an `Idempotency-Key`, a fresh random `requestId` is used, as the UI does.
- **Hold length**: `hold = 2 × LLM_TIMEOUT_SECONDS + 120 s`, never under 300 s. This is 300 s at the default 90 s timeout and 1,320 s at the 600 s maximum. It covers two model calls plus saving, which is longer than any write can take (FR-016).
- **Rationale**: this is the only arrangement that meets all of these at once:
  - "never waits on the first" (spec decision): the claim is committed before the work starts;
  - "backed by a database guarantee": the unique index, plus the lock-token check at completion, so a request that lost its hold to a takeover can never commit;
  - "committed together": the outer transaction;
  - no slow I/O inside a held transaction, which applies everywhere except the variant-free remainder of queue and schedule.

  The `/generate` exception relies on a guarantee that already exists and is tested (007).
- **Alternatives**:
  - **Inserting the claim inside the work transaction**: rejected, because a concurrent duplicate's INSERT would block on the uncommitted unique entry until the first finished, which breaks "never waits".
  - **Advisory locks**: forbidden (Neon pooler).
  - **Holding one transaction across the model call**: rejected (008 constraint, and it pins a pooled connection for up to 20 minutes).

### D9: What counts as "the same body"

- **Decision**:
  - For JSON, the body hash is the SHA-256 of a **canonical** serialisation: the parsed value with object keys sorted and no whitespace.
  - For multipart, it is the SHA-256 over the file's bytes plus the canonical JSON of the text fields. The raw multipart body is not hashed.
  - An empty body hashes as `{}`.
- **Rationale**: the multipart boundary is random per request, so hashing raw bytes would turn every n8n retry of an upload into a 422. That would break FR-014's purpose. The spec wrote "the raw bytes for multipart uploads"; this reading keeps the intent (same file, same fields, same hash). It is recorded in [plan.md](./plan.md#spec-notes-for-later-phases) and `docs/decisions.md`. Canonical JSON also stops a client's key order from causing a false 422.
- **Alternative**: raw bytes. Rejected for the reason above.

### D10: Which results are stored

- **Decision**: every response produced after the claim with status < 500 is stored and replayed, 4xx included: `validation_failed`, `not_found`, `job_closed`, `media_reserved`, `confirmation_required`, and the per-target results. 5xx responses are never stored, and their claim is released. Responses from steps 1–8 (D7) are never stored.
- **Rationale**: a 4xx from the endpoint is a deterministic answer to that body, and replaying it is what "the first request's result" means. Releasing on 5xx matches the spec edge case "Server error … no result is stored, so a retry with the same key runs again". The n8n doc tells users to change the key when they change the body.

### D11: Error shape and mapping

- **Decision**: one module, `src/server/api/errors.ts`, holds the code list (FR-010), `apiError(code, message, details?)`, and `mapServiceError(error)`:

  | Service error | Response |
  |---|---|
  | `ZodError` | 400 `validation_failed`, with `details[]` = `{ path, message }`. A ZodError on path `confirmUnreviewedQueue` becomes 400 `confirmation_required`. |
  | `NotFoundError` | 404 `not_found` |
  | `ForbiddenError` | 403 `missing_permission`, with `details.permission` = the operation's permission |
  | `PolicyNotAllowedError` on `approval` | 403 `missing_permission`, permission `auto_approve` |
  | `ConflictError` | 409 `conflict`, with the service's message |
  | `JobClosedError`, `MediaReservedError`, `JobItemLimitError` (new, D18) | 409 `job_closed`, 409 `media_reserved`, 400 `job_item_limit` |
  | `ValidationIssuesError` | 400 `validation_failed`, with the issues in `details` |
  | `LlmNotConfiguredError` | 503 `generation_not_configured` |
  | `StorageUnavailableError` (existing) | 503 `storage_not_configured` |
  | `generateSingle` returning `ok: false` | `invalid_output`, `refused`, `incomplete` or `bad_request` → 422 `generation_failed` (stored); `timeout`, `rate_limited`, `unavailable` or `auth` → 503 `generation_unavailable` (not stored). These are two codes added to FR-010's list. |
  | `UrlFetchError` (D13) | 400 with its code |
  | `InvalidApiKeyError` | 401 |
  | anything else | 500 `internal_error`, with a generic message. The log line gets the request id and the error name only, passed through `redact()`. |

  Messages come from the service (they are already user-facing) or from a fixed table. Nothing else is echoed. The UI's `action-result.ts` mapping is untouched.

  The error codes are kept apart from the per-target result codes the queue returns, such as `not_queueable`, `no_active_slots` and `in_past`. Those sit inside 200 responses.
- **Rationale**: FR-010 and SC-011. A test iterates the code list against the error responses the tests saw.

### D12: Pagination

- **Decision**: `limit` (1–100, default 50) and an opaque `cursor`. The cursor is base64url JSON `{ v: 1, o: <offset> }`, and the response is `{ data, nextCursor }`. `listMedia`, `listJobs` and `listJobItems` gain optional `limit` and `offset` alongside `page`; existing UI callers pass `page` and are unchanged.
- **Rationale**: the existing services are offset-paged, and project data is small (hundreds of rows). The cursor is opaque, so moving to keyset paging later changes no client.
- **Alternative**: keyset cursors now. Rejected, because each service's ordering would need a new DAL query.

## 4. Media by URL

### D13: Guarded fetch with built-in `node:http` and `node:https`

- **Decision**: `src/server/net/safe-fetch.ts`, `fetchPublicResource(url, opts)`:
  - It accepts `http:` and `https:` only, and refuses userinfo in the URL.
  - Each hop connects through `http(s).request` with a custom **`lookup`** (F7). The lookup resolves the name, refuses any address in the private, loopback or link-local block list, and hands only an allowed address to the socket. This also defeats DNS rebinding, because the checked address is the address used.
  - The block list (`net.BlockList`) covers `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and IPv4-mapped forms. A literal IP host is checked the same way.
  - Redirects are followed manually, at most 3, and each new URL is re-checked.
  - The overall limit is 30 s (`AbortSignal.timeout`).
  - It streams with a byte counter that aborts above `MEDIA_MAX_UPLOAD_MB`.
  - A `Content-Type` other than `image/*` is refused before the body is read. The bytes then go through the existing `processUpload`, which decides acceptance (FR-018 "only image types the library accepts").
  - Tests inject `opts.addressPolicy` to allow 127.0.0.1 for a local server. Production has no switch.
- **Error codes** (all 400, nothing stored):
  - `url_not_allowed` (scheme, credentials, or a private destination, including after a redirect);
  - `url_too_many_redirects`;
  - `url_fetch_failed` (DNS, connection or a non-2xx status);
  - `url_timeout`;
  - `payload_too_large` (413);
  - `unsupported_media_type` (415), from `processUpload`'s rejection.
- **Rationale**: no new dependency (constitution VI). `fetch` cannot take a custom lookup without importing `undici`, which is not a direct dependency.
- **Alternative**: resolving first and then fetching by name. Rejected, because it is open to DNS rebinding between the check and the connect.

## 5. OpenAPI

### D14: Generated from the operation table with `zod-openapi`, OpenAPI 3.1.0

- **Decision**: `buildOpenApiDocument()` maps each operation to a path item:
  - `operationId` = the operation id;
  - `requestParams.path`, `query` and `header`, where the header object includes the optional `Idempotency-Key` on writes;
  - `requestBody` from the same Zod body schema the pipeline parses with;
  - `responses` from the operation's response schemas. Every operation also gets 401, 403, 404, 429 and 500, and writes get 409 and 422. All error responses use the shared `Error` component, whose `code` enum is the FR-010 list.
  - `security: [{ bearer: [] }, { apiKeyHeader: [] }]`;
  - `x-docket-permission` set to the permission;
  - response headers `X-Request-Id`, plus `Idempotent-Replayed` on writes and `Retry-After` on 429 and 409.

  The document is built once per process and served with `Cache-Control: public, max-age=300`. Titles and descriptions are the only hand-written text (FR-042).
- **Validity test (FR-047)**: `@seriousme/openapi-schema-validator` is the intended full validator. **`NEEDS DEPENDENCY: @seriousme/openapi-schema-validator`**: it is not installed (F6), so that one assertion is marked and skipped with the reason. The structural checks run regardless:
  - `openapi` matches `^3\.1\.\d+$`;
  - every `$ref` resolves within the document;
  - `operationId`s are unique;
  - the documented `(method, path)` set equals the router's;
  - every write declares `Idempotency-Key`;
  - every operation has `security` and `x-docket-permission`;
  - every response with content references a schema;
  - `JSON.parse(JSON.stringify(doc))` round-trips.
- **Rationale**: FR-042/FR-043. 3.1 matches JSON Schema 2020-12, which is what Zod 4 emits natively.

## 6. Webhooks

### D15: Outbox tables written in the changing transaction

- **Decision**: `webhook_events` (one per occurrence) and `webhook_deliveries` (one per event per subscribed, enabled endpoint) are inserted by `emitEvent(tx, type, subject)` inside the transaction that made the change (FR-035, US5-AS2). The hook-in points:

  | Event | Where it is emitted |
  |---|---|
  | `post.published`, `post.failed` | `applyDerivedStatus`: when the newly derived status differs from the stored one and is `published`, or is `failed` / `partially_failed`. |
  | `job.finished` | `refreshJobStatus`, on a change into `completed` or `completed_with_failures`; and `cancelJob`, on a change into `cancelled`. A retried job that finishes again emits a new event (spec decision). |
  | `account.needs_reauth` | `accounts.recordRefresh` and `accounts.markCredentialsInvalid` gain a `previousStatus` in their result (a `WITH prev AS (SELECT status … FOR UPDATE)` CTE in the same UPDATE statement). Their four scheduler call sites wrap the update and `emitEvent` in one `forSchedulerProject(…).transaction`, emitting only when `previousStatus = 'active'`. |

  - `applyDerivedStatus`'s parameter type widens from `Pick<ProjectScope, "posts" | "targets">` to also include `accounts`, `media` and `webhooks`. `createSchedulingRepos` gains `webhooks`, so both full scopes and scheduler repos satisfy it.
  - The event body is built in the same transaction by the shared view presenters (`src/server/services/views/`), the same functions the API's GET handlers use (FR-036).
  - `emitEvent` first checks `webhooks.hasSubscribers(type)` with one indexed query, so a project without endpoints pays one SELECT per transition and writes nothing.
- **Rationale**: an outbox in the same transaction is the only way to satisfy "a killed process can neither lose it nor send one for a change that did not happen" without a queue (constitution VI).
- **Alternative**: emitting after commit. Rejected, because the event is lost on a crash.

### D16: Delivery section in `runTick()`

- **Decision**: `src/server/scheduler/webhooks.ts`, `runWebhookDeliveries`, the fourth independent section ([contracts/webhooks.md](./contracts/webhooks.md)).
  - **Claim**: up to `WEBHOOK_TICK_MAX_DELIVERIES` (10) due deliveries, oldest `next_attempt_at` first, with `FOR UPDATE SKIP LOCKED` across projects (`crossProject`). Each gets `status = 'delivering'`, a lease token and `lease_until = now + SCHEDULER_LEASE_SECONDS`.
  - **Send**: outside any transaction, at most 4 concurrently. Each starts only if 11 s of tick budget remain. Each attempt is `fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000) })`.
  - **Record**: in a short transaction with the lease-token check. This writes the attempt row and updates the delivery and the endpoint counters.
  - **Outcomes**:
    - 2xx is success, and it resets the endpoint's `consecutive_failures`.
    - 410 disables the endpoint (`disabled_reason = 'gone'`).
    - Anything else, including 3xx, a timeout or a connection error, retries at `1 min × 2^(n−1)`, capped at 6 h (`nextRetryAt` from `scheduler/backoff.ts`).
    - After 8 attempts the delivery is `failed`. A failed delivery increments `consecutive_failures`, and at 20 the endpoint is disabled (`disabled_reason = 'failing'`).
    - An expired lease is retried, never treated as ambiguous: a duplicate webhook is acceptable because delivery is at least once and receivers dedupe by event id.
  - **Housekeeping**: the section ends with bounded deletes (at most 500 rows each). It removes:
    - attempts and deliveries older than 30 days;
    - events with no remaining deliveries older than 30 days;
    - idempotency rows past `expires_at`.
- **Rationale**: FR-038 and FR-039, and the constitution's tick rules. The backoff gives attempts at 0, 1, 3, 7, 15, 31, 63 and 127 minutes, so a receiver that is down for an hour still gets every event (SC-008) and is never disabled for it.
- **Alternative**: a separate worker loop. Rejected, because the tick is the queue.

### D17: Signing and rotation

- **Decision**:
  - The secret is `whsec_` plus 43 base64url characters. It is stored with `encryptSecret(secret, { aad: "webhook_endpoint:<id>" })`.
  - `Docket-Signature: v1=<hex(HMAC_SHA256(secret_utf8, "<ts>.<raw body>"))>`, with `ts` = `Docket-Timestamp` (Unix seconds at send time). The timestamp is re-signed on every attempt and resend.
  - Rotation moves the current secret to `previous_secret_encrypted`, with `previous_secret_expires_at = now + 24 h`, and makes the new one current. A rotation during an overlap overwrites the previous secret, so the earlier old secret ends at once (FR-040).
  - During the overlap the header carries `v1=<new>,v1=<old>`.
  - The verification recipe (n8n Code node and plain Node) is in `docs/n8n.md`:
    1. Parse every `v1=`.
    2. Recompute.
    3. Compare with `timingSafeEqual`.
    4. Reject a `|now − ts|` over 300 s.
  - `src/server/services/webhooks/sign.ts` exports `sign()` and `verify()`. The tests use the same `verify()` against the documented recipe, run as a separate snippet extracted from the doc.

## 7. Jobs over the API

### D18: Open jobs and append: the smallest generic change to 008

- **Decision**:
  - **Columns**: `generation_jobs.open boolean NOT NULL DEFAULT false` and `closed_at timestamptz`. The check `item_count BETWEEN 1 AND 500` becomes `item_count BETWEEN 0 AND 500` plus `open OR item_count >= 1`.
  - **`deriveJobStatus(current, counts, started, open)`**: when `open` and no item is queued or running, it returns `running` if work has started, otherwise `queued`. It never returns a finished status for an open job. The claim query is unchanged: it already requires a due item (F13 and the `EXISTS` clause), so idle open jobs are never claimed.
  - **`closeJob(scope, jobId)`**: sets `open = false` and `closed_at`, then runs `refreshJobStatus`, which may move the job to `completed` and emit `job.finished`. Closing a job with zero items is refused with 409 `conflict`: "Add at least one item or cancel the job." Closing a closed job is a no-op that returns the job.
  - **`cancelJob`** also sets `open = false`.
  - **`appendItems(scope, jobId, input)`** (new, in `services/jobs/append.ts`):
    1. Parse with the API source's item schema (1–100 items).
    2. Lock the job. `JobClosedError` if it is not open, or if it is cancelled.
    3. Check the declared fields.
    4. Check `item_count + n ≤ 500`, else `JobItemLimitError`.
    5. Lock the named media (`lockForReservation`).
    6. Refuse the whole request with `MediaReservedError` (naming the item indexes) for media that is reserved, deleted or unknown.
    7. Call the existing `insertItems`.

    The partial unique index stays the backstop: a unique violation is retried once, then reported as `media_reserved`.
  - **UI**: the job page shows "Open: accepting items" and a "Close job" button (with `manage_jobs` semantics: `generation: run`).
  - **UI-created jobs**: the media and CSV sources still create closed jobs (`open` defaults false).
- **Rationale**: the spec tension. The change is three columns or checks, one derivation branch and one new service. It is logged as a generic change. Media, CSV and the runner are untouched.

### D19: The `api` item source

- **Decision**: `services/jobs/sources/api.ts` plus one registry line. Its input is:
  - `kind: "api"`;
  - `fields`: 0–50 names matching the template placeholder grammar in `src/lib/jobs/template.ts`, each unique;
  - `items`: optional at creation, 0–100 at a time, each `{ fields: Record<declared, string>, label?: ≤200, mediaId?: uuid }`.

  `prepare()` checks:
  - an unknown field is a `ValidationIssuesError` at `items.<i>.fields.<name>`;
  - each item's values total at most 50,000 characters;
  - a missing declared field renders empty.

  The default label is `Item <position + 1>`.

  `PreparedSource` gains `mediaRules: { onReserved: "skip" | "refuse"; skipUsed: boolean }`, an optional member defaulting to the 008 behaviour `{ skip, true unless includeUsed }`. The API source sets `{ refuse, false }`: an image the caller named explicitly is used even if it was used before, but never one reserved by another job. `createJob` reads it where it filters reserved and used images.

  The brief is a fixed sentence, as for the media and CSV sources.
- **Rationale**: FR-031 and 008 FR-005 ("a new source and its registration"). The `mediaRules` member is the one generic change, and it defaults to existing behaviour.

## 8. Remaining endpoint services

### D20: Small service additions the API needs, shared with the UI

| Need | Change (generic, logged) |
|---|---|
| `POST /media` with bytes and a URL | `uploadMedia` is split into `prepareUpload(scope, file)` (process and `put`; no DB) and `commitUpload(tx, prepared, { altText, tags })` (insert, alt text and tags). `uploadMedia` becomes those two calls, so its behaviour is unchanged. `registerMediaFromUrl(scope, input)` = `fetchPublicResource`, then `prepareUpload`, then `commitUpload`. |
| `GET /slots/upcoming` with free and taken occurrences | `queue.listUpcomingOccurrences(scope, { accountId?, from?, days? })`: the `listEmptySlots` logic, plus a new DAL `targets.heldOccurrences(accountId, from, to)` returning `{ at, postId, targetId }`. Default 14 days, maximum 60. `listEmptySlots` is unchanged. |
| `POST /posts` with origin `api` | `createDraft` forces `origin: "api"` and `created_by_api_key_id` when `scope.actor.kind === "api_key"`. An `origin` in the input is ignored for keys. |
| Queue or schedule pre-work outside the idempotent transaction | `posts.prepareForScheduling(scope, postId, targetIds?)` exports the existing private `prepare()`. The queue and schedule services still call it themselves (it is idempotent and cached). |
| Lists with `limit` and `offset` | D12 |
| Target view | `getPostView` already returns targets. The API's target endpoint filters it. External URL stays `null` (005 R5, 006 R10: no permalinks stored). |

### D21: Settings screens

- **Decision**: `settings/api-keys` and `settings/webhooks` pages (server components) with leaf client components for the forms, the show-once dialog (reusing `Dialog` and `CopyField`) and confirm dialogs. The sub-navigation links show only when the viewer `can({ api_key: ["manage"] })`. Detail is in [contracts/ui.md](./contracts/ui.md).

## 9. Risks

- **Fixed-window burst**: up to 2× the limit across a minute boundary. This is documented and acceptable for the owner's use.
- **Idempotency of `/generate` after a crash between save and policy**: the post exists, but its policy was not applied. 007's `existingResult` returns it with its review state, the same as the UI today, and the post is in review. This is documented.
- **Event body size**: post views for posts with many targets are a few KB. No cap is needed beyond the 50-target limit.
- **Hold length**: at a 600 s LLM timeout, a crashed `/generate` blocks its key for 22 minutes, and the 409 says when to retry. This is documented.
