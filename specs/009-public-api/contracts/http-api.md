# Contract: HTTP API `/api/v1`

The served OpenAPI document (`GET /api/v1/openapi.json`) is the authoritative, generated form of this contract (FR-042). This file is the design it is generated from. If they disagree, the code's schemas win and this file is corrected.

## Conventions

| Topic | Rule |
|---|---|
| Base | `/api/v1`. The project comes from the key; paths carry no slug (spec decision). |
| Auth | `Authorization: Bearer dkt_…` or `X-API-Key: dkt_…`. Cookies are never read (FR-009). Both headers present with different values → 401. |
| Content | JSON in and out (`application/json; charset=utf-8`). `POST /media` takes `multipart/form-data`. Any other request content type on a body-taking route → 415 `unsupported_media_type`. |
| Body limits | JSON ≤ 8 MB (100 items × 50,000 characters fit). Multipart ≤ `MEDIA_MAX_UPLOAD_MB` + 1 MB. Over the limit → 413 `payload_too_large`. Interim constants. |
| Ids | UUIDs. A malformed id → 404 `not_found`, the same as an unknown one. |
| Times | Output: RFC 3339 UTC (`…Z`), plus `local` strings in the project time zone where the UI shows local time. Input: RFC 3339 with an offset. |
| Lists | `?limit=1..100` (default 50) and `?cursor=<opaque>`. The response is `{ "data": [...], "nextCursor": string \| null }`. |
| Headers on every response | `X-Request-Id`, `Cache-Control: no-store` (except `openapi.json`). |
| Writes | `POST`. Optional `Idempotency-Key` (1–255 printable ASCII). A replay carries `Idempotent-Replayed: true`. |
| Rate limit | Per key, per minute. 429 carries `Retry-After` (seconds). |
| CORS | None: the API is called server to server (n8n). Browsers on other origins get no CORS headers. |

## Error shape (FR-010)

```json
{ "error": { "code": "missing_permission", "message": "This key needs the write_posts permission.", "details": { "permission": "write_posts" }, "requestId": "6f1c…" } }
```

`details` is one of:

- `{ "permission": "<p>" }`;
- `[{ "path": "items.3.fields.price", "message": "…" }]`;
- `{ "items": [{ "index": 2, "mediaId": "…", "reason": "reserved" }] }`.

| Code | Status | When |
|---|---|---|
| `invalid_api_key` | 401 | missing, malformed, unknown, revoked or expired key; deleted project. `WWW-Authenticate: Bearer` |
| `missing_permission` | 403 | the key lacks the operation's permission, or `auto_approve` was requested without it |
| `not_found` | 404 | unknown path, unknown or other-project resource |
| `method_not_allowed` | 405 | known path, other method (`Allow` header) |
| `validation_failed` | 400 | body, query or params fail the schema, or a service validation |
| `invalid_json` | 400 | the body is not parseable JSON |
| `invalid_idempotency_key` | 400 | the header is present but outside 1–255 printable ASCII |
| `confirmation_required` | 400 | `auto_approve` + `add_to_queue` without `confirmUnreviewedQueue: true` |
| `job_item_limit` | 400 | the add would exceed 500 items per job |
| `url_not_allowed` | 400 | media URL: bad scheme, credentials, or a private, loopback or link-local destination (including via a redirect) |
| `url_too_many_redirects` | 400 | more than 3 redirects |
| `url_fetch_failed` | 400 | DNS, connect or a non-2xx response from the media URL |
| `url_timeout` | 400 | the media fetch exceeded 30 s |
| `idempotency_in_progress` | 409 | the same key is still running. `Retry-After` |
| `conflict` | 409 | a service conflict, with the service's message (for example "That slot was just taken.") |
| `job_closed` | 409 | adding items to a closed or cancelled job |
| `media_reserved` | 409 | an item's image is reserved by another active job item, deleted, or not in the project |
| `payload_too_large` | 413 | over the body or image size limit |
| `unsupported_media_type` | 415 | wrong request content type, or an image type the library rejects |
| `idempotency_key_reused` | 422 | the same key with a different body |
| `generation_failed` | 422 | the model's output was unusable after its retry, or it refused. `details: { kind, failureId }` |
| `rate_limited` | 429 | over the per-minute limit. `Retry-After` |
| `internal_error` | 500 | anything unexpected. The message is generic, and the request id lets you find the log line. |
| `generation_not_configured` | 503 | no LLM configured |
| `storage_not_configured` | 503 | no media storage configured |
| `generation_unavailable` | 503 | the model timed out, was rate-limited or unavailable, or rejected Docket's credentials. `Retry-After` when known |

Per-target results inside 200 responses use their own codes, the UI's `TargetFailureCode`: `no_active_slots`, `no_free_occurrence`, `validation`, `not_queueable`, `account_unavailable` and `in_past`.

## Operations

`P` is the required permission (FR-004). `Idem` marks writes that accept `Idempotency-Key`. Every operation can also return 401, 403, 404, 429 and 500, and every write can also return 409 `idempotency_in_progress`, 422 and 413. Those are not repeated in the table.

| Operation id | Method and path | P | Idem | Service called | Success |
|---|---|---|---|---|---|
| `getOpenApi` | `GET /openapi.json` | none | – | `buildOpenApiDocument()` | 200 document |
| `listAccounts` | `GET /accounts` | read | – | `accounts.listAccounts` | 200 `{ data: Account[], nextCursor: null }` |
| `listMedia` | `GET /media?unused&tag&missingAlt&limit&cursor` | read | – | `media.listMedia` | 200 page of `Media` |
| `getMedia` | `GET /media/{mediaId}` | read | – | `media.getMedia` | 200 `Media` |
| `uploadMedia` | `POST /media` (multipart: `file`, `altText?`, `tags?` as a comma-separated list or repeated fields) | write_posts | ✓ | `media.prepareUpload` + `commitUpload` | 201 `Media` · 415 · 413 · 503 `storage_not_configured` |
| `registerMediaFromUrl` | `POST /media/from-url` `{ url, altText?, tags? }` | write_posts | ✓ | `media.registerMediaFromUrl` | 201 `Media` · 400 `url_*` · 413 · 415 · 503 |
| `createPost` | `POST /posts` `{ text, accountIds[1..50], overrides?: { [accountId]: text }, mediaIds?: uuid[] }` | write_posts | ✓ | `posts.createDraft` + `validatePost` | 201 `{ post: Post, validation: TargetValidation[] }` |
| `getPost` | `GET /posts/{postId}` | read | – | `posts.getPostView` + view presenter | 200 `Post` |
| `getPostTarget` | `GET /posts/{postId}/targets/{targetId}` | read | – | `posts.getPostView` | 200 `Target` (404 when the target is not on that post) |
| `queuePost` | `POST /posts/{postId}/queue` `{ targetIds?: uuid[] }` | write_posts | ✓ | `posts.addToQueue` | 200 `{ results: TargetResult[] }` |
| `schedulePost` | `POST /posts/{postId}/schedule` `{ at: RFC3339+offset, targetIds?: uuid[] }` | write_posts | ✓ | `posts.scheduleAt` | 200 `{ results: TargetResult[] }` (a past instant appears per target as `in_past`) |
| `generatePost` | `POST /generate` `{ brief, sourceText?, accountIds, mediaIds?, voiceProfileId?, instructions?, approvalPolicy?, schedulingPolicy?, confirmUnreviewedQueue? }` | generate (+ auto_approve) | ✓ | `generation.generateSingle` | 201 `{ post: Post, decision, queued: TargetResult[], problems: Issue[] }` · 200 for an existing post (same request) · 422 `generation_failed` (see below) · 503 |
| `listUpcomingSlots` | `GET /slots/upcoming?accountId&from&days` | read | – | `queue.listUpcomingOccurrences` | 200 `{ data: Occurrence[], nextCursor: null }` |
| `listJobs` | `GET /jobs?limit&cursor` | read | – | `jobs.listJobs` | 200 page of `JobSummary` |
| `createJob` | `POST /jobs` (below) | manage_jobs (+ auto_approve) | ✓ | `jobs.createJob` | 201 `Job` · 400 · 409 `media_reserved` · 503 |
| `getJob` | `GET /jobs/{jobId}` | read | – | `jobs.getJob` | 200 `Job` |
| `listJobItems` | `GET /jobs/{jobId}/items?status&limit&cursor` | read | – | `jobs.listJobItems` | 200 page of `JobItem` |
| `getJobItem` | `GET /jobs/{jobId}/items/{itemId}` | read | – | `jobs.getJobItem` (new, read.ts) | 200 `JobItem` |
| `addJobItems` | `POST /jobs/{jobId}/items` `{ items: ApiItem[1..100] }` | manage_jobs | ✓ | `jobs.appendItems` | 201 `{ added, itemCount, items: { id, position }[] }` · 409 `job_closed` / `media_reserved` · 400 `job_item_limit` |
| `closeJob` | `POST /jobs/{jobId}/close` | manage_jobs | ✓ | `jobs.closeJob` | 200 `Job` · 409 `conflict` (empty job) |
| `cancelJob` | `POST /jobs/{jobId}/cancel` | manage_jobs | ✓ | `jobs.cancelJob` | 200 `{ job: Job, cancelled: number }` |
| `retryFailedJobItems` | `POST /jobs/{jobId}/retry-failed` | manage_jobs | ✓ | `jobs.retryFailedItems` | 200 `{ job: Job, retried: number }` |

**`generation_failed`** is an addition to the code list. `generateSingle` can return `{ ok: false, failureId, kind, message }` when the model output is unusable after its retry, or the model refused. The API answers 422 `generation_failed` with `details: { kind, failureId }`. Because this is < 500, it is stored and replayed. `docs/n8n.md` says to use a new idempotency key to try again. A temporary or configuration failure, `kind ∈ timeout | unavailable | rate_limited | auth`, is 503 `generation_unavailable` instead, also added. A 503 is not stored, so the same key can retry it (research D10). The kinds `invalid_output`, `refused`, `incomplete` and `bad_request` give the 422. Both codes join the documented list.

### `POST /jobs` body

```json
{
  "source": {
    "kind": "api",
    "fields": ["product", "price"],
    "items": [{ "fields": { "product": "Blue mug", "price": "12" }, "label": "Blue mug", "mediaId": "…" }],
    "open": true
  },
  "template": "Write about {{product}} at £{{price}}.",
  "accountIds": ["…"],
  "voiceProfileId": "…",
  "approvalPolicy": "review_required",
  "schedulingPolicy": "leave_as_draft",
  "confirmUnreviewedQueue": false
}
```

- `source.kind: "media"` takes the 008 media selection (`{ mode: "pick" | "filter" | "unused", … , includeUsed? }`) with the same schema as the UI. `csv` → 400 `validation_failed` ("CSV jobs are created in the app").
- **Placeholders**: the grammar is `src/lib/jobs/template.ts` `PLACEHOLDER`, which is `{{ field }}` with optional spaces, field names matched case-insensitively and up to 64 characters. The API reuses it unchanged.
- **Closed jobs** (`open` absent or false) need at least one item. **Open jobs** may have none at first.

### Shapes (output; Zod schemas in `src/lib/api/schemas.ts`, registered as components)

- **`Account`**: `{ id, provider, displayName, status: "active"|"needs_reauth", lastError, capabilities: { textLimit, countingRule, media: { required, maxImages, mimeTypes }, postTypes } }`. No credentials, settings or tokens.
- **`Media`**: `{ id, url, thumbnailUrl, mimeType, width, height, byteSize, altText, tags[], used: boolean, reservedByJobId: uuid|null, createdAt }`.
- **`Post`**:

  ```ts
  {
    id, status, reviewState, origin, text,
    media: { id, url, altText }[],
    generation: { brief, voiceProfileId, decision } | null,
    createdBy: { type: "user" | "api_key", name },
    createdAt, updatedAt,
    targets: Target[],
  }
  ```

- **`Target`**:

  ```ts
  {
    id, accountId, accountName, provider, status,
    scheduleKind: "slot" | "explicit" | "now" | null,
    scheduledAt, scheduledAtLocal,
    externalId, externalUrl /* always null today */,
    attemptCount, lastError,
    overrideText: string | null,
  }
  ```

  No tokens and no attempt payloads (FR-024).
- **`TargetValidation`**: `{ targetId, accountId, ok, issues: { severity, code, message, field? }[] }`.
- **`TargetResult`**: `{ targetId, accountId, ok: true, scheduledAt, scheduledAtLocal, warnings?: Warning[] }` or `{ targetId, accountId, ok: false, code, message, issues? }`.
- **`Occurrence`**: `{ accountId, slotId, scheduledAt, scheduledAtLocal, free: boolean, postId: uuid|null, targetId: uuid|null }`.
- **`JobSummary`** and **`Job`**:

  ```ts
  {
    id, status, open: boolean, sourceKind, sourceSummary, itemCount,
    counts: { queued, running, done, failed, cancelled },
    approvalPolicy, schedulingPolicy,
    createdBy: { type, name },
    createdAt, startedAt, finishedAt, cancelledAt,
  }
  ```

  `Job` adds `fields[]`, `template`, `accountIds[]` and `voiceProfileId`.
- **`JobItem`**: `{ id, position, label, status, attempts, mediaId, post: { id, reviewState } | null, error: { kind, message } | null, finishedAt }`.

`createdBy.name` for a key is the key's name. For a user, it is their display name, or "Former member".

## Headers and status semantics for idempotency (research D8–D10)

| Situation | Response |
|---|---|
| New key, endpoint ran, status < 500 | the endpoint's response. The result is stored. |
| Same key, method, route and body, completed | the stored status and body, plus `Idempotent-Replayed: true` |
| Same key, different body | 422 `idempotency_key_reused` |
| Same key, still running | 409 `idempotency_in_progress`, `Retry-After: n` |
| Same key, first run died, hold expired | runs again (takeover) |
| Endpoint 5xx | the 5xx. Nothing is stored, and the key is reusable. |
| Refused before the endpoint (401, 403, 413, 415, 429, `invalid_json`, `invalid_idempotency_key`) | nothing is stored |
| `Idempotency-Key` on a GET | ignored |
